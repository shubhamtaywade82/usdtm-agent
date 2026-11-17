/**
 * Smoke test — verifies the full stack without requiring Ollama.
 */
import assert from 'node:assert';
import { config } from './config.js';
import { MarketDataHub } from './market-data-hub.js';
import { PaperExchange } from './paper-exchange.js';
import { RiskManager } from './risk.js';
import { createTools, toOllamaTools } from './tools.js';
import { snapshot as indicatorSnapshot } from './indicators.js';

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✅ ${name}`); };
const fail = (name: string, err: any) => { console.error(`  ❌ ${name}: ${err?.message ?? err}`); process.exit(1); };

function testIndicators() {
  console.log('— Indicators');
  const rising = Array.from({ length: 60 }, (_, i) => ({ high: 100 + i + 1, low: 100 + i - 1, close: 100 + i, volume: 100 }));
  const snapUp = indicatorSnapshot('15m', rising);
  assert.ok(snapUp && snapUp.trend === 'UP');
  assert.ok(snapUp.rsi14 !== null && snapUp.rsi14 > 70);
  ok('rising series → UP trend, high RSI');

  const falling = Array.from({ length: 60 }, (_, i) => ({ high: 200 - i + 1, low: 200 - i - 1, close: 200 - i, volume: 100 }));
  const snapDown = indicatorSnapshot('15m', falling);
  assert.ok(snapDown && snapDown.trend === 'DOWN');
  assert.ok(snapDown.rsi14 !== null && snapDown.rsi14 < 30);
  ok('falling series → DOWN trend, low RSI');

  assert.strictEqual(indicatorSnapshot('15m', rising.slice(0, 30)), null);
  ok('insufficient data → null');
}

function testRiskCaps(risk: RiskManager, marks: Record<string, number>) {
  const c = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.005, price: 65000, leverage: 10, reason: 't' }, marks);
  assert.strictEqual(c.approved, false);
  ok('leverage cap enforced');

  const d = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 1, price: 65000, leverage: 1, reason: 't' }, marks);
  assert.strictEqual(d.approved, false);
  ok('position notional cap enforced');

  const e = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.15, price: 65000, leverage: 1, reason: 't' }, marks);
  assert.strictEqual(e.approved, false);
  ok('insufficient margin rejected');

  const f = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.03, price: 65000, leverage: 2, stopDistancePct: 15, reason: 't' }, marks);
  assert.strictEqual(f.approved, false);
  ok('per-trade risk cap enforced');
}

async function testRisk() {
  console.log('— RiskManager');
  const px = new PaperExchange({ accountId: 'usdtm-agent-risk' });
  await px.init();
  await px.resetAccount(10000);
  const risk = new RiskManager(px);
  try {
    const marks = { BTCUSDT: 65000 };
    const a = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.005, price: 65000, leverage: 2, stopDistancePct: 1, reason: 't' }, marks);
    assert.ok(a.approved, JSON.stringify(a.checks));
    ok('normal order approved');

    const b = risk.checkOrder({ symbol: 'DOGEUSDT', side: 'BUY', qty: 100, price: 0.1, leverage: 1, reason: 't' }, marks);
    assert.strictEqual(b.approved, false);
    ok('out-of-universe rejected');

    testRiskCaps(risk, marks);

    for (let i = 0; i < 3; i++) risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, price: 65000, leverage: 1, reason: 't' }, marks);
    const doom = risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, price: 65000, leverage: 1, reason: 't' }, marks);
    assert.strictEqual(doom.approved, false);
    ok('doom-loop detection');

    risk.setHalt(true, 'manual test halt');
    assert.strictEqual(risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.002, price: 65000, leverage: 1, reason: 't' }, marks).approved, false);
    risk.setHalt(false, '', true);
    assert.ok(risk.checkOrder({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.002, price: 65000, leverage: 1, reason: 't' }, marks).approved);
    ok('manual halt + ack resume');
    await px.close();
  } catch (err) {
    fail('risk manager', err);
  }
}

async function testPaperRoundTrip(px: PaperExchange) {
  const acc0 = px.getAccount({ BTCUSDT: 65000 });
  assert.strictEqual(acc0.equity, config.paper.initialBalance);
  ok('initial account');

  const fill1 = await px.placeMarketOrder('BTCUSDT', 'BUY', 0.01, 65000, { leverage: 2, reason: 'smoke: open long' });
  assert.strictEqual(fill1.status, 'FILLED');
  assert.ok(fill1.position && fill1.position.side === 'LONG');
  const acc1 = px.getAccount({ BTCUSDT: 65000 });
  assert.ok(Math.abs(acc1.marginUsed - 0.01 * 65000 / 2) < 1e-6);
  assert.ok(acc1.equity < config.paper.initialBalance);
  ok('open long with leverage + fee');

  const acc2 = px.getAccount({ BTCUSDT: 66000 });
  assert.ok(Math.abs(acc2.equity - (acc1.equity + 0.01 * 1000)) < 1e-6);
  ok('mark-to-market');

  await px.placeMarketOrder('BTCUSDT', 'BUY', 0.01, 64000, { leverage: 2, reason: 'smoke: add' });
  const pos = px.getPosition('BTCUSDT')!;
  assert.ok(Math.abs(pos.qty - 0.02) < 1e-9);
  ok('average in (position increase)');

  const r1 = await px.placeMarketOrder('BTCUSDT', 'SELL', 0.01, 65000, { reason: 'smoke: partial close' });
  assert.ok(r1.reduceOnly && r1.realizedPnl > 0);
  ok('partial close with realized PnL');

  const r2 = await px.placeMarketOrder('BTCUSDT', 'SELL', 0.01, 65500, { reason: 'smoke: full close' });
  assert.strictEqual(px.getPosition('BTCUSDT'), null);
  assert.ok(r2.realizedPnl > 0);
  ok('full close');
}

async function testPaperLifecycle(px: PaperExchange) {
  await px.placeMarketOrder('ETHUSDT', 'SELL', 0.2, 3000, { leverage: 2, reason: 'smoke: open short' });
  const r3 = await px.placeMarketOrder('ETHUSDT', 'BUY', 0.2, 2900, { reason: 'smoke: close short' });
  assert.ok(r3.realizedPnl > 0);
  ok('short round trip');

  await px.placeMarketOrder('BTCUSDT', 'BUY', 0.01, 65000, { leverage: 2, reason: 'smoke: reopen' });
  const before = px.getAccount().balance;
  const amt = await px.settleFunding('BTCUSDT', 0.0001, 65000);
  assert.ok(amt < 0 && px.getAccount().balance < before);
  ok('funding settlement');

  const liqPos = px.markPositions({});
  assert.ok(liqPos[0].liquidationPrice !== null);
  const liqs = await px.checkLiquidations({ BTCUSDT: liqPos[0].liquidationPrice! * 0.5 });
  assert.strictEqual(liqs.length, 1);
  assert.strictEqual(px.getPosition('BTCUSDT'), null);
  ok('liquidation engine');

  await px.placeMarketOrder('SOLUSDT', 'BUY', 1, 100, { leverage: 1, reason: 'smoke: persist' });
  await px.close();
  const px2 = new PaperExchange({ accountId: 'usdtm-agent-smoke' });
  await px2.init();
  assert.ok(px2.getPosition('SOLUSDT') !== null);
  ok('paper_exchange persistence across client restart');
  await px2.close();
}

async function testPaperExchange() {
  console.log('— PaperExchange');
  const px = new PaperExchange({ accountId: 'usdtm-agent-smoke' });
  await px.init();
  await px.resetAccount(10000);
  try {
    await testPaperRoundTrip(px);
    await testPaperLifecycle(px);
  } catch (err) {
    fail('paper exchange', err);
  }
}

async function testHubLive() {
  console.log('— MarketDataHub (live WS)');
  const hub = new MarketDataHub();
  try {
    await hub.start(['BTCUSDT']);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (hub.getPrice('BTCUSDT') !== null && hub.getBookTicker('BTCUSDT') !== null && hub.getMarkPrice('BTCUSDT') !== null) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(hub.getPrice('BTCUSDT')! > 0);
    ok('aggTrade price flows');
    assert.ok(hub.getBookTicker('BTCUSDT')!.ask > 0);
    ok('bookTicker flows');
    assert.ok(hub.getMarkPrice('BTCUSDT')!.indexPrice > 0);
    ok('markPrice/funding flows');

    const top = hub.getOrderBookTop('BTCUSDT', 5);
    assert.ok(top && top.bids.length > 0 && top.asks.length > 0);
    ok(`L2 order book synced (mid=${top.midPrice?.toFixed(2)}, spread=${top.spreadBps?.toFixed(2)}bps)`);
    assert.strictEqual(hub.isHealthy(), true);
    ok('hub healthy');
    await hub.stop();
    ok('clean shutdown');
  } catch (err) {
    try { await hub.stop(); } catch {}
    fail('hub live', err);
  }
}

async function testTools() {
  console.log('— Tools (with live hub where possible)');
  const hub = new MarketDataHub();
  const px = new PaperExchange({ accountId: 'usdtm-agent-tools' });
  await px.init();
  await px.resetAccount(10000);
  const risk = new RiskManager(px);
  const markPrices = () => ({ BTCUSDT: hub.getPrice('BTCUSDT') ?? 65000 });
  const tools = createTools({ hub, paper: px, risk, markPrices, setPlanNote: () => {} });

  try {
    await hub.start(['BTCUSDT']);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && hub.getPrice('BTCUSDT') === null) await new Promise((r) => setTimeout(r, 200));

    const p = await tools.get_live_price.execute({ symbol: 'BTCUSDT' });
    assert.ok((p as any).price > 0);
    ok('get_live_price');

    const ov = await tools.get_market_overview.execute({});
    assert.ok((ov as any).symbols.length >= 1);
    ok('get_market_overview (REST-independent)');

    const port = await tools.get_portfolio.execute({});
    assert.ok((port as any).equity > 0);
    ok('get_portfolio');

    const ob = await tools.get_order_book.execute({ symbol: 'BTCUSDT', levels: 3 });
    assert.ok((ob as any).bids.length > 0);
    ok('get_order_book');

    const mp = await tools.get_mark_price_funding.execute({ symbol: 'BTCUSDT' });
    assert.ok((mp as any).markPrice > 0);
    ok('get_mark_price_funding');

    const ord = await tools.place_market_order.execute({ symbol: 'BTCUSDT', side: 'BUY', qty: 0.001, leverage: 1, reason: 'smoke test order' });
    assert.ok((ord as any).ok);
    ok('place_market_order (risk-gated)');

    const close = await tools.close_position.execute({ symbol: 'BTCUSDT', reason: 'smoke test close' });
    assert.ok((close as any).ok);
    ok('close_position');

    const defs = toOllamaTools(tools);
    const place = defs.find((d) => d.function.name === 'place_market_order')!;
    const params = place.function.parameters as any;
    assert.strictEqual(params.type, 'object');
    assert.ok(params.properties.symbol && params.properties.side && params.properties.qty);
    ok('zod → JSON Schema for Ollama tools API');

    await hub.stop();
    await px.close();
  } catch (err) {
    try { await hub.stop(); } catch {}
    fail('tools', err);
  }
}

async function main() {
  console.log('Smoke test — agentic USDT-M paper trader\n');
  testIndicators();
  await testRisk();
  await testPaperExchange();
  await testHubLive();
  await testTools();
  console.log(`\nALL ${passed} CHECKS PASSED ✅`);
  process.exit(0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
