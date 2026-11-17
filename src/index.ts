/**
 * Entry point — event-driven autonomous runner.
 *
 * Wake-ups:
 *   1. klineClosed (5m/15m by config)  → full agent cycle
 *   2. large liquidation               → full agent cycle (quick reaction)
 *   3. every CYCLE_MINUTES (safety net)→ full agent cycle
 * Plus background maintenance: funding settlement, liquidation checks,
 * equity recording, daily roll.
 *
 * A cooldown between cycles prevents event storms from stacking LLM calls.
 */
import { config } from './config.js';
import { MarketDataHub } from './market-data-hub.js';
import { PaperExchange } from './paper-exchange.js';
import { RiskManager } from './risk.js';
import { Agent, type CycleTrigger } from './agent.js';
import type { Kline, Liquidation } from './types.js';

function log(emoji: string, msg: string): void {
  console.log(`${new Date().toISOString()} ${emoji} ${msg}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const oneShot = args.includes('--once');

  const hub = new MarketDataHub();
  const paper = new PaperExchange();
  await paper.init();
  const risk = new RiskManager(paper);

  const markPrices = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of config.symbols) {
      const mp = hub.getMarkPrice(s);
      const px = hub.getPrice(s);
      const bt = hub.getBookTicker(s);
      const v = mp?.markPrice ?? px ?? (bt ? (bt.bid + bt.ask) / 2 : null);
      if (v !== null) out[s] = v;
    }
    return out;
  };
  paper.setPriceProvider(markPrices);

  const agent = new Agent({ hub, paper, risk, markPrices, setPlanNote: () => {} });

  hub.on('info', (m: string) => log('🛰', m));
  hub.on('warn', (m: string) => log('⚠️', m));

  log('🚀', `Agentic USDT-M paper trader starting — model=${config.ollama.model} universe=${config.symbols.join(',')}`);
  log('💰', `Paper account: equity ${paper.getAccount(markPrices()).equity.toFixed(2)} USDT`);

  await hub.start(config.symbols);

  // ---------------- cycle scheduling with cooldown ----------------
  let cycleRunning = false;
  let lastCycleEnd = 0;
  let pendingTrigger: CycleTrigger | null = null;
  let cyclesRun = 0;

  const runCycle = async (trigger: CycleTrigger): Promise<void> => {
    if (cycleRunning) {
      pendingTrigger = trigger; // coalesce: run the latest trigger after the current cycle
      return;
    }
    const since = (Date.now() - lastCycleEnd) / 1000;
    if (since < config.triggers.cooldownSeconds) {
      pendingTrigger = trigger;
      const waitMs = (config.triggers.cooldownSeconds - since) * 1000;
      setTimeout(() => flushPending(), waitMs + 250);
      return;
    }
    cycleRunning = true;
    cyclesRun++;
    log('🧠', `cycle #${cyclesRun} — ${trigger.kind}: ${trigger.detail}`);
    try {
      const res = await agent.runCycle(trigger);
      log('📝', `cycle done (${res.stoppedReason}): steps=${res.steps} tools=${res.toolCalls} orders=${res.ordersPlaced}`);
      log('📝', `summary: ${res.summary.replace(/\n/g, ' ').slice(0, 500)}`);
      paper.recordEquity(markPrices());
    } catch (err: any) {
      log('❌', `cycle error: ${err.message}`);
    } finally {
      cycleRunning = false;
      lastCycleEnd = Date.now();
      flushPending(); // run any trigger coalesced while this cycle was busy
    }
  };

  const flushPending = (): void => {
    if (pendingTrigger && !cycleRunning) {
      const t = pendingTrigger;
      pendingTrigger = null;
      void runCycle(t);
    }
  };

  // ---------------- event wiring ----------------
  hub.on('klineClosed', (k: Kline) => {
    if (config.triggers.klineIntervals.includes(k.interval)) {
      void runCycle({
        kind: 'KLINE_CLOSE',
        detail: `${k.symbol} ${k.interval} candle closed: O=${k.open} H=${k.high} L=${k.low} C=${k.close} V=${k.volume.toFixed(1)}`,
      });
    }
  });

  hub.on('liquidation', (l: Liquidation) => {
    if (l.notionalUsd >= config.triggers.liquidationNotionalUsd) {
      void runCycle({
        kind: 'LIQUIDATION',
        detail: `large liquidation: ${l.side} ${l.qty} ${l.symbol} @ ${l.price} ($${(l.notionalUsd / 1000).toFixed(0)}k)`,
      });
    }
  });

  // ---------------- background maintenance ----------------
  let lastFundingSettleDay = '';
  const maintenance = setInterval(async () => {
    try {
      const marks = markPrices();
      // Liquidation engine.
      const liqs = await paper.checkLiquidations(marks);
      for (const l of liqs) log('💥', `PAPER LIQUIDATION on ${l.symbol}, realizedPnl=${l.realizedPnl.toFixed(2)}`);
      // Funding settlement every 8h at :00/:08/:16 (approximation of Binance's schedule).
      const now = new Date();
      const fundingHour = now.getUTCHours() % 8 === 0 && now.getUTCMinutes() < 5;
      const dayKey = `${now.toISOString().slice(0, 10)}T${now.getUTCHours()}`;
      if (fundingHour && lastFundingSettleDay !== dayKey) {
        lastFundingSettleDay = dayKey;
        for (const s of config.symbols) {
          const mp = hub.getMarkPrice(s);
          if (mp && paper.getPosition(s)) {
            const amount = await paper.settleFunding(s, mp.fundingRate, mp.markPrice);
            log('🪙', `funding settled ${s}: ${amount.toFixed(4)} USDT (rate ${(mp.fundingRate * 100).toFixed(4)}%)`);
          }
        }
      }
      paper.recordEquity(marks);
    } catch (err: any) {
      log('⚠️', `maintenance error: ${err.message}`);
    }
  }, 15_000);
  maintenance.unref();

  const safetyNet = setInterval(() => {
    void runCycle({ kind: 'SCHEDULE', detail: 'scheduled safety-net cycle' });
  }, config.triggers.cycleMinutes * 60_000);

  // ---------------- graceful shutdown ----------------
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('🛑', `${sig} received — shutting down`);
    clearInterval(maintenance);
    clearInterval(safetyNet);
    const marks = markPrices();
    const acc = paper.getAccount(marks);
    log('💰', `final equity: ${acc.equity.toFixed(2)} USDT (day PnL ${(acc.equity - acc.dayStartEquity).toFixed(2)})`);
    await hub.stop();
    await paper.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (oneShot) {
    await runCycle({ kind: 'STARTUP', detail: 'one-shot cycle (--once)' });
    await new Promise((r) => setTimeout(r, 2000));
    await shutdown('--once');
    return;
  }

  // Initial cycle shortly after data starts flowing.
  setTimeout(() => void runCycle({ kind: 'STARTUP', detail: 'initial cycle after startup' }), 8_000);

  log('✅', `running — cycles on ${config.triggers.klineIntervals.join('/')} closes, liquidations ≥ $${config.triggers.liquidationNotionalUsd}, safety net every ${config.triggers.cycleMinutes}min, cooldown ${config.triggers.cooldownSeconds}s`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
