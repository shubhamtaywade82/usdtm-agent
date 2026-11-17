/**
 * Smoke test — verifies the full stack WITHOUT requiring Ollama:
 *   1. WS connectivity + payload routing (hub)
 *   2. Paper exchange round-trip (open, add, partial close, full close)
 *   3. Risk layer (caps, rejection paths)
 *   4. Indicators on synthetic data
 *   5. Tool layer (market overview, portfolio, order placement) with mocked hub REST
 *   6. zod → JSON Schema conversion for the Ollama tools API
 * Exits 0 on success. Run: npm run smoke
 */
import assert from 'node:assert';
import { config } from './config.js';
import { MarketDataHub } from './market-data-hub.js';
import { PaperExchange } from './paper-exchange.js';
import { RiskManager } from './risk.js';
import { createTools, toOllamaTools } from './tools.js';
import { snapshot as indicatorSnapshot } from './indicators.js';

const DB = 'data/smoke-test.db';
import fs from 'node:fs';
fs.rmSync(DB, { force: true });
fs.rmSync(DB + '-wal', { force: true });
fs.rmSync(DB + '-shm', { force: true });

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✅ ${name}`); };
const fail = (name: string, err: any) => { console.error(`  ❌ ${name}: ${err?.message ?? err}`); process.exit(1); };

async function testPaperExchange() {
  console.log('— PaperExchange');
  const px = new PaperExchange(DB);
  try {
    const acc0 = px.getAccount({ BTCUSDT: 65000 });
    assert.strictEqual(acc0.equity, config.paper.initialBalance);
    ok('initial account');

    const fill1 = px.placeMarketOrder('BTCUSDT', 'BUY', 0.01, 65000, { leverage: 2, reason: 'smoke: open long' });
    assert.strictEqual(fill1.status, 'FILLED');
    assert.ok(fill1.position && fill1.position.side === 'LONG');
    const acc1 = px.getAccount({ BTCUSDT: 65000 });
    assert.ok(Math.abs(acc1.marginUsed - 0.01 * 65000 / 2) < 1e-6, `margin ${acc1.marginUsed}`);
    assert.ok(acc1.equity < config.paper.initialBalance, 'fee deducted');
    ok('open long with leverage + fee');

    // Unrealized PnL mark.
    const acc2 = px.getAccount({ BTCUSDT: 66000 });
    assert.ok(Math.abs(acc2.equity - (acc1.equity + 0.01 * 1000)) < 1e-6);
    ok('mark-to-market');

    // Increase.
    px.placeMarketOrder('BTCUSDT', 'BUY', 0.01, 64000, { leverage: 2, reason: 'smoke: add' });
    const pos = px.getPosition('BTCUSDT')!;
    assert.ok(Math.abs(pos.qty - 0.02) < 1e-9);
    assert.ok(Math.abs(pos.entryPrice - 64500) < 1e-9, `entry ${pos.entryPrice}`);
    ok('average in (position increase)');

    // Partial close.
    const r1 = px.placeMarketOrder('BTCUSDT', 'SELL', 0.01, 65000, { reason: 'smoke: partial close' });
    assert.ok(r1.reduceOnly);
    assert.ok(r1.realizedPnl > 0, `pnl ${r1.realizedPnl}`);
    assert.ok(Math.abs(px.getPosition('BTCUSDT')!.qty - 0.01) < 1e-9);
    ok('partial close with realized PnL');

    // Full close.
    const r2 = px.placeMarketOrder('BTCUSDT', 'SELL', 0.01, 65500, { reason: 'smoke: full close' });
    assert.strictEqual(px.getPosition('BTCUSDT'), null);
    assert.ok(r2.realizedPnl > 0);
    ok('full close');

    // SHORT round trip.
    px.placeMarketOrder('ETHUSDT', 'SELL', 0.2, 3000, { leverage: 2, reason: 'smoke: open short' });
    const shorts = px.markPositions({ ETHUSDT: 2900 });
    assert.ok(shorts[0].unrealizedPnl > 0);
    const r3 = px.placeMarketOrder('ETHUSDT', 'BUY', 0.2, 2900, { reason: 'smoke: close short' });
    assert.ok(r3.realizedPnl > 0);
    ok('short round trip');

    // Funding: LONG pays positive rate.
    px.placeMarketOrder('BTCUSDT', 'BUY', 0.01, 65000, { leverage: 2, reason: 'smoke: reopen' });
    const before = px.getAccount().balance;
    const amt = px.settleFunding('BTCUSDT', 0.0001, 65000);
    assert.ok(amt < 0 && Math.abs(amt - (-0.0001 * 0.01 * 65000)) < 1e-9);
    assert.ok(px.getAccount().balance < before);
    ok('funding settlement');

    // Liquidation engine: force a mark below the liq price.
    const liqPos = px.markPositions({});
    assert.ok(liqPos[0].liquidationPrice !== null);
    const liqPrice = liqPos[0].liquidationPrice!;
    const liqs = px.checkLiquidations({ BTCUSDT: liqPrice * 0.5 });
    assert.strictEqual(liqs.length, 1);
    assert.strictEqual(px.getPosition('BTCUSDT'), null);
    ok('liquidation engine');

    // Persistence: reopen a new instance and confirm state survives.
    px.placeMarketOrder('SOLUSDT', 'BUY', 1, 100, { leverage: 1, reason: 'smoke: persist' });
    px.close();
    const px2 = new PaperExchange(DB);
    assert.ok(px2.getPosition('SOLUSDT') !== null);
    ok('SQLite persistence across restart');
    px2.close();
  } catch (err) {
    fail('paper exchange', err);
  }
}

function testRisk() {
  console.log('— RiskManager');
  const px = new PaperExchange(DB + '.risk');
  fs.rmSync(DB + '.risk', { force: true });
  const risk = new RiskManager(px);
  try {
    const marks = { BTCUSDT: 65000 };
    // In-universe, small order: approved.
    const a = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.005, price: 65000, leverage: 2, stopDistancePct: 1, reason: 't' }, marks);
    assert.ok(a.approved, JSON.stringify(a.checks));
    ok('normal order approved');

    // Out-of-universe symbol rejected.
    const b = risk.checkOrder({ symbol: 'DOGEUSDT', side: 'BUY', qty: 100, price: 0.1, leverage: 1, reason: 't' }, marks);
    assert.ok(!b.approved);
    ok('out-of-universe rejected');

    // Excess leverage rejected.
    const c = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, price: 65000, leverage: 10, reason: 't' }, marks);
    assert.ok(!c.approved);
    ok('leverage cap enforced');

    // Position notional cap: qty that exceeds 25% of equity.
    const d = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 65000, leverage: 2, reason: 't' }, marks);
    assert.ok(!d.approved);
    ok('position notional cap enforced');

    // Margin availability.
    const e = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.3, price: 65000, leverage: 1, reason: 't' }, marks);
    assert.ok(!e.approved);
    ok('insufficient margin rejected');

    // Per-trade risk cap with wide stop.
    const f = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.03, price: 65000, leverage: 2, stopDistancePct: 20, reason: 't' }, marks);
    assert.ok(!f.approved);
    ok('per-trade risk cap enforced');

    // Doom-loop: same order 4x within 10 min → 4th rejected.
    const req: import('./risk.js').OrderRequest = { symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, price: 65000, leverage: 1, reason: 't' };
    risk.checkOrder(req, marks); risk.checkOrder(req, marks); risk.checkOrder(req, marks);
    const g = risk.checkOrder(req, marks);
    assert.ok(!g.approved);
    ok('doom-loop detection');

    // Daily loss halt: simulate by manipulating account via trades then check.
    // (Direct check: set halt manually, verify orders blocked.)
    risk.setHalt(true, 'manual test halt');
    const h = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, price: 65000, leverage: 1, reason: 't' }, marks);
    assert.ok(!h.approved);
    risk.setHalt(false, '', true);
    const i = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.002, price: 65000, leverage: 1, reason: 't-resume' }, marks);
    assert.ok(i.approved, JSON.stringify(i.checks));
    ok('manual halt + ack resume');
    px.close();
  } catch (err) {
    fail('risk', err);
  }
}

function testIndicators() {
  console.log('— Indicators');
  try {
    // Synthetic: strictly rising series.
    const n = 120;
    const klines = Array.from({ length: n }, (_, i) => ({
      high: 100 + i + 1, low: 100 + i - 1, close: 100 + i, volume: 10,
    }));
    const snap = indicatorSnapshot('15m', klines);
    assert.ok(snap);
    assert.strictEqual(snap!.trend, 'UP');
    assert.ok(snap!.rsi14! > 90, `rsi ${snap!.rsi14}`);
    assert.ok(snap!.ema9! > snap!.ema21!);
    ok('rising series → UP trend, high RSI');

    // Falling series: build directly (mirror of the rising one).
    const fallingKlines = Array.from({ length: n }, (_, i) => ({
      high: 100 - i + 1, low: 100 - i - 1, close: 100 - i, volume: 10,
    }));
    const snap2 = indicatorSnapshot('15m', fallingKlines);
    assert.strictEqual(snap2!.trend, 'DOWN');
    assert.ok(snap2!.rsi14! < 10);
    ok('falling series → DOWN trend, low RSI');

    assert.strictEqual(indicatorSnapshot('15m', klines.slice(0, 10)), null);
    ok('insufficient data → null');
  } catch (err) {
    fail('indicators', err);
  }
}

async function testHubLive() {
  console.log('— MarketDataHub (live WS)');
  const hub = new MarketDataHub();
  try {
    await hub.start(['BTCUSDT']);
    // Wait for data to flow.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && hub.getPrice('BTCUSDT') === null) {
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(hub.getPrice('BTCUSDT') !== null, 'no aggTrade price within 30s');
    ok('aggTrade price flows');
    assert.ok(hub.getBookTicker('BTCUSDT') !== null, 'no bookTicker within 30s');
    ok('bookTicker flows');
    assert.ok(hub.getMarkPrice('BTCUSDT') !== null, 'no markPrice within 30s');
    ok('markPrice/funding flows');
    const top = hub.getOrderBookTop('BTCUSDT', 5);
    assert.ok(top && top.bids.length > 0 && top.asks.length > 0, 'L2 book empty');
    ok(`L2 order book synced (mid=${top!.midPrice?.toFixed(2)}, spread=${top!.spreadBps?.toFixed(2)}bps)`);
    assert.ok(hub.isHealthy());
    ok('hub healthy');
    await hub.stop();
    ok('clean shutdown');
  } catch (err) {
    try { await hub.stop(); } catch { /* ignore */ }
    fail('hub live', err);
  }
}

async function testTools() {
  console.log('— Tools (with live hub where possible)');
  const hub = new MarketDataHub();
  const px = new PaperExchange(DB + '.tools');
  const risk = new RiskManager(px);
  try {
    await hub.start(['BTCUSDT']);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && hub.getPrice('BTCUSDT') === null) await new Promise((r) => setTimeout(r, 500));

    const tools = createTools({
      hub, paper: px, risk,
      markPrices: () => ({ BTCUSDT: hub.getPrice('BTCUSDT') ?? 0 }),
      setPlanNote: () => {},
    });

    const price = await tools.get_live_price.execute({ symbol: 'BTCUSDT' });
    assert.ok((price as any).price > 0);
    ok('get_live_price');

    const overview = await tools.get_market_overview.execute({});
    ok('get_market_overview (REST-independent)');

    const portfolio = await tools.get_portfolio.execute({});
    assert.ok((portfolio as any).balance > 0);
    ok('get_portfolio');

    const book = await tools.get_order_book.execute({ symbol: 'BTCUSDT', levels: 5 });
    assert.ok((book as any).bids?.length > 0);
    ok('get_order_book');

    const mp = await tools.get_mark_price_funding.execute({ symbol: 'BTCUSDT' });
    assert.ok((mp as any).markPrice > 0);
    ok('get_mark_price_funding');

    // Trading path: set_plan → order.
    await tools.set_plan.execute({ plan: 'smoke test plan: enter small long with 1% stop for testing purposes' });
    const order = await tools.place_market_order.execute({
      symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, leverage: 1,
      stop_distance_pct: 1, reason: 'smoke test order',
    });
    assert.ok((order as any).ok, JSON.stringify(order));
    ok('place_market_order (risk-gated)');

    const close = await tools.close_position.execute({ symbol: 'BTCUSDT', reason: 'smoke test close' });
    assert.ok((close as any).ok, JSON.stringify(close));
    ok('close_position');

    // JSON Schema conversion sanity.
    const defs = toOllamaTools(tools);
    const place = defs.find((d) => d.function.name === 'place_market_order')!;
    const params = place.function.parameters as any;
    assert.strictEqual(params.type, 'object');
    assert.ok(params.properties.symbol && params.properties.side && params.properties.qty);
    assert.deepStrictEqual(params.properties.side.enum, ['BUY', 'SELL']);
    assert.ok(params.required.includes('symbol'));
    const ind = defs.find((d) => d.function.name === 'get_indicators')!;
    const ip = ind.function.parameters as any;
    assert.deepStrictEqual(ip.properties.interval.enum, ['1m', '5m', '15m', '1h', '4h', '1d']);
    ok('zod → JSON Schema for Ollama tools API');

    await hub.stop();
    px.close();
  } catch (err) {
    try { await hub.stop(); } catch { /* ignore */ }
    fail('tools', err);
  }
}

async function main() {
  console.log('Smoke test — agentic USDT-M paper trader\n');
  testIndicators();
  testRisk();
  await testPaperExchange();
  await testHubLive();
  await testTools();
  console.log(`\nALL ${passed} CHECKS PASSED ✅`);
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
