/**
 * Agent-loop integration test with a MOCK Ollama server.
 * Verifies the full ReAct path: system prompt → tool_calls dispatch →
 * tool results → final answer → memory. Run: npx tsx src/agent-mock.ts
 */
import http from 'node:http';
import { config } from './config.js';
import { MarketDataHub } from './market-data-hub.js';
import { PaperExchange } from './paper-exchange.js';
import { RiskManager } from './risk.js';
import { Agent } from './agent.js';

// ---- mock Ollama: chat completions with scripted tool calls ----
const script: any[] = [
  // Step 1: model calls tools.
  {
    tool_calls: [
      { function: { name: 'get_market_overview', arguments: '{}' } },
      { function: { name: 'get_portfolio', arguments: '{}' } },
    ],
  },
  // Step 2: model states a plan.
  {
    tool_calls: [
      { function: { name: 'set_plan', arguments: JSON.stringify({ plan: 'Test plan: BTC momentum is UP per overview; enter small long with 1.5% stop, 1x leverage, 0.001 BTC.' }) } },
    ],
  },
  // Step 3: model places an order.
  {
    tool_calls: [
      { function: { name: 'place_market_order', arguments: JSON.stringify({
        symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, leverage: 1,
        stop_distance_pct: 1.5, reason: 'test order from mock agent',
      }) } },
    ],
  },
  // Step 4: final answer.
  { content: 'Opened a small 0.001 BTC long on BTCUSDT at 1x with a 1.5% stop after confirming UP trend in the overview. Equity risk is minimal. Watching 15m EMA21 as invalidation.' },
];

const seenRequests: any[] = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seenRequests.push({ url: req.url, body: JSON.parse(body || '{}') });
    const step = script[seenRequests.length - 1];
    const out = step
      ? { message: { role: 'assistant', content: step.content ?? '', tool_calls: step.tool_calls } }
      : { message: { role: 'assistant', content: 'done' } };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

async function main() {
  console.log('mock: starting server');
  await new Promise<void>((r) => server.listen(11499, r));
  process.env.OLLAMA_HOST = 'http://127.0.0.1:11499';
  // Re-import config-dependent modules with the env set? config is read at import;
  // simpler: override the agent's host directly after construction.

  const hub = new MarketDataHub();
  const paper = new PaperExchange({ accountId: 'usdtm-agent-mock' });
  await paper.init();
  await paper.resetAccount(10000);
  const risk = new RiskManager(paper);
  const markPrices = () => {
    const out: Record<string, number> = {};
    for (const s of config.symbols) {
      const v = hub.getPrice(s) ?? hub.getBookTicker(s);
      if (typeof v === 'number') out[s] = v;
      else if (v) out[s] = (v.bid + v.ask) / 2;
    }
    return out;
  };
  paper.setPriceProvider(markPrices);

  await hub.start(['BTCUSDT']);
  console.log('mock: hub started, waiting for price');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && hub.getPrice('BTCUSDT') === null) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (hub.getPrice('BTCUSDT') === null) throw new Error('no live BTC price — cannot test order fill');

  // Point the agent's Ollama at the mock BEFORE constructing the Agent
  // (the Ollama client captures config.ollama.host at construction time).
  (config.ollama as any).host = 'http://127.0.0.1:11499';
  console.log('mock: constructing agent');

  const agentModule = await import('./agent.js');
  const agent = new agentModule.Agent({ hub, paper, risk, markPrices, setPlanNote: () => {} });
  console.log('mock: running cycle');

  const result = await agent.runCycle({ kind: 'STARTUP', detail: 'mock test cycle' });
  console.log('— Agent cycle result —');
  console.log('stoppedReason:', result.stoppedReason);
  console.log('steps:', result.steps, '| toolCalls:', result.toolCalls, '| ordersPlaced:', result.ordersPlaced);
  console.log('summary:', result.summary.slice(0, 160));

  const positions = paper.getPositions();
  console.log('— Positions after cycle —');
  console.log(JSON.stringify(positions, null, 1).slice(0, 300));
  const orders = paper.getRecentOrders(5);
  console.log('— Orders —');
  for (const o of orders) console.log(`  ${o.side} ${o.qty} ${o.symbol} @ ${o.price} fee=${o.fee} reason="${o.reason.slice(0, 50)}"`);

  // Assertions.
  const assert = (cond: boolean, msg: string) => {
    if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1); }
    console.log('  ✅', msg);
  };
  assert(seenRequests.length >= 4, `mock served ${seenRequests.length} requests`);
  assert(result.stoppedReason === 'final_answer', 'final answer reached');
  assert(result.toolCalls === 4, `4 tool calls dispatched (got ${result.toolCalls})`);
  assert(result.ordersPlaced === 1, '1 order placed');
  assert(positions.length === 1 && positions[0].symbol === 'BTCUSDT' && positions[0].side === 'LONG', 'long position opened');
  assert(orders.length === 1 && orders[0].status === 'FILLED', 'order FILLED');
  const firstBody = seenRequests[0].body;
  assert(!!firstBody.tools && firstBody.tools.length >= 10, `tools sent to model (${firstBody.tools?.length})`);
  const sys = firstBody.messages?.[0]?.content ?? '';
  assert(sys.includes('USDT-M') && sys.includes('HARD RULES'), 'system prompt injected');
  const lastBody = seenRequests[seenRequests.length - 1].body;
  const toolMsgs = (lastBody.messages ?? []).filter((m: any) => m.role === 'tool');
  assert(toolMsgs.length === 4, `4 tool results fed back (got ${toolMsgs.length})`);

  console.log('\nAGENT MOCK TEST PASSED ✅');
  server.close();
  await hub.stop();
  await paper.close();
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
