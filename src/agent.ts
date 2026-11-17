/**
 * Agent — ReAct tool-calling loop over Ollama with bounded execution and memory.
 */
import { Ollama, type Message } from 'ollama';
import { config } from './config.js';
import { createTools, toOllamaTools, type ToolContext } from './tools.js';

export interface CycleTrigger {
  kind: 'SCHEDULE' | 'KLINE_CLOSE' | 'LIQUIDATION' | 'STARTUP';
  detail: string;
}

export interface CycleResult {
  summary: string;
  steps: number;
  toolCalls: number;
  ordersPlaced: number;
  stoppedReason: 'final_answer' | 'max_steps' | 'doom_loop' | 'error';
}

interface ToolCallEntry { name: string; argsKey: string; at: number; }

const SYSTEM_PROMPT = `You are a disciplined autonomous crypto trading agent running a USDT-M perpetual futures PAPER account.

You interact with the world ONLY through tools. You receive live market data from Binance USDT-M futures (WebSocket): prices, order book, mark price, funding, open interest, long/short ratios, liquidations.

HARD RULES (the risk layer enforces these even if you violate them):
- Max ${'$'}{MAX_LEV}x leverage. Max ${'$'}{MAX_POS}% of equity notional per symbol, ${'$'}{MAX_PORT}% portfolio-wide.
- Max ${'$'}{RISK}% of equity risked per trade (entry→stop distance × qty).
- Daily loss limit ${'$'}{DAILY}% trips a trading halt.
- Trading HALT means: do not place orders; explain the halt and what you would do.

PROCESS for each cycle:
1. Call get_market_overview first, then get_portfolio.
2. Investigate anything interesting with the data tools (indicators, order book, funding, OI, ratios, liquidations).
3. Decide: open / close / adjust / hold. Doing nothing is a valid and often correct decision.
4. Before ANY order, call set_plan with thesis + entry + stop distance % + size rationale.
5. Place orders with place_market_order (or close_position). Size orders so the stop distance × qty stays within the risk cap.
6. End the cycle with a final message: what you did (or why you held), key levels you are watching, and your risk state. This summary is stored as memory for future cycles.

STYLE: be decisive but conservative. React to the event that triggered the cycle. Prefer reacting to closed candles over noise. Never chase price. Cut losses at your stated stop. Do not repeat an order the risk layer just rejected — read the rejection reason and adapt.`;

export class Agent {
  private ollama: Ollama;
  private tools: Record<string, ReturnType<typeof createTools>[string]>;
  private toolDefs: ReturnType<typeof toOllamaTools>;
  private orderCountThisCycle = 0;
  private planNote = '';
  private memory: string[] = [];
  private static readonly MEMORY_DEPTH = 5;

  constructor(private ctx: ToolContext) {
    this.ollama = new Ollama({ host: config.ollama.host });
    const tc: ToolContext = {
      ...ctx,
      setPlanNote: (note: string) => { this.planNote = note; },
    };
    this.tools = createTools(tc);
    this.toolDefs = toOllamaTools(this.tools);
  }

  addMemory(summary: string): void {
    this.memory.push(summary.replace(/\s+/g, ' ').slice(0, 600));
    while (this.memory.length > Agent.MEMORY_DEPTH) this.memory.shift();
  }

  private systemPrompt(): string {
    return SYSTEM_PROMPT
      .replace('${MAX_LEV}', String(config.paper.maxLeverage))
      .replace('${MAX_POS}', String(config.paper.maxPositionNotionalPct))
      .replace('${MAX_PORT}', String(config.paper.maxPortfolioNotionalPct))
      .replace('${RISK}', String(config.paper.maxRiskPerTradePct))
      .replace('${DAILY}', String(config.paper.dailyLossLimitPct));
  }

  private buildInitialMessages(trigger: CycleTrigger): Message[] {
    const halt = this.ctx.risk.isHalted();
    const memoryBlock = this.memory.length
      ? `\n\nMEMORY (your recent cycle summaries, oldest first):\n${this.memory.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
      : '';
    return [
      { role: 'system', content: this.systemPrompt() + memoryBlock },
      {
        role: 'user',
        content: `Trigger: ${trigger.kind} — ${trigger.detail}\nCurrent UTC time: ${new Date().toISOString()}\nRisk state: ${halt.halted ? `TRADING HALTED (${halt.reason})` : 'normal'}\nUniverse: ${config.symbols.join(', ')}\n\nRun one full decision cycle now.`,
      },
    ];
  }

  private isDoomLoop(calls: any[], history: ToolCallEntry[]): boolean {
    const now = Date.now();
    for (const c of calls) {
      const name = c.function?.name ?? '?';
      const argsKey = typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {});
      history.push({ name, argsKey, at: now });
    }
    const window = history.filter((t) => now - t.at < 5 * 60_000);
    const countIdentical = (t: ToolCallEntry) => window.filter((o) => o.name === t.name && o.argsKey === t.argsKey).length;
    return window.some((t) => countIdentical(t) >= 4);
  }

  private async executeTool(call: any): Promise<{ name: string; content: string }> {
    const name = call.function?.name ?? '';
    let args: Record<string, unknown> = {};
    if (typeof call.function?.arguments === 'string') {
      try { args = JSON.parse(call.function.arguments); } catch { args = { unparsed: call.function.arguments }; }
    } else {
      args = call.function?.arguments ?? {};
    }
    if (name === 'place_market_order' || name === 'close_position') this.orderCountThisCycle++;

    let result: unknown;
    try {
      const tool = this.tools[name];
      result = tool ? await tool.execute(args) : { error: `unknown tool: ${name}` };
    } catch (err: unknown) {
      result = { error: err instanceof Error ? err.message : String(err) };
    }
    let content: string;
    try { content = JSON.stringify(result); } catch { content = JSON.stringify({ error: 'unserializable result' }); }
    return { name, content: content.length > 4000 ? content.slice(0, 4000) + '…(truncated)' : content };
  }

  async runCycle(trigger: CycleTrigger): Promise<CycleResult> {
    this.orderCountThisCycle = 0;
    this.planNote = '';
    const messages = this.buildInitialMessages(trigger);
    const toolHistory: ToolCallEntry[] = [];
    let toolCallCount = 0;

    for (let step = 0; step < config.ollama.maxSteps; step++) {
      let response: any;
      try {
        response = await this.callOllama(messages);
      } catch (err: unknown) {
        return { summary: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`, steps: step, toolCalls: toolCallCount, ordersPlaced: this.orderCountThisCycle, stoppedReason: 'error' };
      }
      const msg = response.message;
      if (!msg) return { summary: 'LLM returned no message', steps: step, toolCalls: toolCallCount, ordersPlaced: this.orderCountThisCycle, stoppedReason: 'error' };
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        const summary = (msg.content ?? '').trim() || '(no final message)';
        this.addMemory(`[${trigger.kind}] ${summary}`);
        return { summary, steps: step + 1, toolCalls: toolCallCount, ordersPlaced: this.orderCountThisCycle, stoppedReason: 'final_answer' };
      }
      if (this.isDoomLoop(calls, toolHistory)) {
        const summary = 'Doom-loop detected: the same tool call repeated 4+ times. Forced stop.';
        this.addMemory(`[${trigger.kind}] ${summary}`);
        return { summary, steps: step + 1, toolCalls: toolCallCount, ordersPlaced: this.orderCountThisCycle, stoppedReason: 'doom_loop' };
      }
      for (const call of calls) {
        toolCallCount++;
        const { name, content } = await this.executeTool(call);
        messages.push({ role: 'tool', name, content } as unknown as Message);
      }
    }
    const summary = 'Max steps reached without a final answer.';
    this.addMemory(`[${trigger.kind}] ${summary}`);
    return { summary, steps: config.ollama.maxSteps, toolCalls: toolCallCount, ordersPlaced: this.orderCountThisCycle, stoppedReason: 'max_steps' };
  }

  private callOllama(messages: Message[]): Promise<any> {
    return Promise.race([
      this.ollama.chat({
        model: config.ollama.model,
        messages,
        tools: this.toolDefs,
        stream: false,
        options: { temperature: config.ollama.temperature, num_ctx: config.ollama.numCtx },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Ollama request timeout after ${config.ollama.requestTimeoutMs}ms`)), config.ollama.requestTimeoutMs),
      ),
    ]);
  }
}
