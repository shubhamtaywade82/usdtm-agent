/**
 * Tools — LLM interface to USDT-M public data and the risk-gated paper exchange.
 */
import { z } from 'zod';
import { config } from './config.js';
import { snapshot as indicatorSnapshot } from './indicators.js';
import type { MarketDataHub } from './market-data-hub.js';
import type { PaperExchange } from './paper-exchange.js';
import type { RiskManager } from './risk.js';

export { toOllamaTools } from './schema-converter.js';

export interface ToolContext {
  hub: MarketDataHub;
  paper: PaperExchange;
  risk: RiskManager;
  markPrices: () => Record<string, number>;
  setPlanNote: (note: string) => void;
}

export interface ToolDef {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: any) => Promise<unknown>;
}

const round = (n: number, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

function buildPriceTools(hub: MarketDataHub): Record<string, ToolDef> {
  return {
    get_live_price: {
      description: 'Current live price of a USDT-M perpetual from WebSocket (real-time).',
      parameters: z.object({ symbol: z.string().describe('Symbol, e.g. BTCUSDT') }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const bt = hub.getBookTicker(s);
        const px = hub.getPrice(s);
        if (px === null && !bt) return { error: `no live data yet for ${s}` };
        return { symbol: s, price: round(px ?? (bt!.bid + bt!.ask) / 2, 2), bid: bt ? round(bt.bid, 2) : null, ask: bt ? round(bt.ask, 2) : null };
      },
    },
    get_24h_ticker: {
      description: '24h statistics (change %, high, low, volume) for a symbol.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const t = hub.getTicker24h(s) ?? await hub.getTicker24hrFresh(s);
        return { symbol: s, lastPrice: round(t.lastPrice, 2), changePct: round(t.priceChangePercent, 2), high24h: round(t.highPrice, 2), low24h: round(t.lowPrice, 2), volume: round(t.volume, 0), quoteVolumeUsd: round(t.quoteVolume, 0) };
      },
    },
    get_klines: {
      description: 'Recent closed candles (OHLCV) for a symbol and interval.',
      parameters: z.object({ symbol: z.string(), interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']), limit: z.number().int().min(10).max(100).default(50) }),
      execute: async ({ symbol, interval, limit }) => (await hub.getKlines(String(symbol).toUpperCase(), interval, Number(limit))).slice(-Math.min(Number(limit), 100)).map((k) => ({ t: k.openTime, o: round(k.open, 2), h: round(k.high, 2), l: round(k.low, 2), c: round(k.close, 2), v: round(k.volume, 1) })),
    },
    get_indicators: {
      description: 'Computed technical indicators (EMA, RSI, ATR, MACD, Bollinger, VWAP, trend).',
      parameters: z.object({ symbol: z.string(), interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('15m') }),
      execute: async ({ symbol, interval }) => {
        const s = String(symbol).toUpperCase();
        const snap = indicatorSnapshot(String(interval), await hub.getKlines(s, interval, 120));
        if (!snap) return { error: 'not enough candles yet' };
        return {
          interval: snap.interval, lastClose: round(snap.lastClose, 2), ema9: snap.ema9 && round(snap.ema9, 2), ema21: snap.ema21 && round(snap.ema21, 2), ema50: snap.ema50 && round(snap.ema50, 2),
          rsi14: snap.rsi14 && round(snap.rsi14, 1), atrPct: snap.atrPct && round(snap.atrPct, 2),
          macd: snap.macd ? { macd: round(snap.macd.macd, 2), signal: round(snap.macd.signal, 2), hist: round(snap.macd.histogram, 2) } : null,
          bollinger: snap.bollinger ? { upper: round(snap.bollinger.upper, 2), mid: round(snap.bollinger.middle, 2), lower: round(snap.bollinger.lower, 2), bandwidthPct: round(snap.bollinger.bandwidthPct, 2) } : null,
          vwap: snap.vwap && round(snap.vwap, 2), trend: snap.trend, momentum: snap.momentum,
        };
      },
    },
  };
}

function buildOrderBookTools(hub: MarketDataHub): Record<string, ToolDef> {
  return {
    get_order_book: {
      description: 'Top levels of the live L2 order book (best bids/asks), mid price and spread.',
      parameters: z.object({ symbol: z.string(), levels: z.number().int().min(1).max(20).default(5) }),
      execute: async ({ symbol, levels }) => {
        const s = String(symbol).toUpperCase();
        const top = hub.getOrderBookTop(s, Math.min(Number(levels), 20));
        if (!top) return { error: `order book for ${s} not synced yet` };
        return {
          symbol: s, bids: top.bids.map((l: { price: number; qty: number }) => [round(l.price, 2), round(l.qty, 3)]),
          asks: top.asks.map((l: { price: number; qty: number }) => [round(l.price, 2), round(l.qty, 3)]),
          midPrice: top.midPrice && round(top.midPrice, 2), spreadBps: top.spreadBps && round(top.spreadBps, 2), synced: (top as { synced?: boolean }).synced ?? null,
        };
      },
    },
    get_mark_price_funding: {
      description: 'Mark price, index price, funding rate and next funding time for a symbol.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const mp = hub.getMarkPrice(s);
        if (!mp) return { error: `no mark price yet for ${s}` };
        return { symbol: s, markPrice: round(mp.markPrice, 2), indexPrice: round(mp.indexPrice, 2), fundingRatePct: round(mp.fundingRate * 100, 4), nextFundingTime: new Date(mp.nextFundingTime).toISOString(), fundingEtaMin: round((mp.nextFundingTime - Date.now()) / 60_000, 0) };
      },
    },
  };
}

function buildSentimentTools(hub: MarketDataHub): Record<string, ToolDef> {
  return {
    get_funding_history: {
      description: 'Recent funding rate history for a symbol.',
      parameters: z.object({ symbol: z.string(), limit: z.number().int().min(1).max(50).default(10) }),
      execute: async ({ symbol, limit }) => (await hub.getFundingRateHistory(String(symbol).toUpperCase(), Math.min(Number(limit), 50))).map((f: any) => ({ time: new Date(f.fundingTime).toISOString(), ratePct: round(f.fundingRate * 100, 4) })),
    },
    get_open_interest: {
      description: 'Current open interest and recent history for a symbol.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const [oi, hist] = await Promise.all([hub.getOpenInterest(s), hub.getOpenInterestHist(s, '5m', 24)]);
        return { symbol: s, currentOI: round(oi.openInterest, 0), history: (hist as any[]).slice(-12).map((h) => ({ t: h.timestamp, oi: round(h.sumOpenInterest, 0), oiUsd: round(h.sumOpenInterestValue, 0) })) };
      },
    },
    get_long_short_ratio: {
      description: 'Crowd positioning: global and top-trader long/short ratios.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const [g, top, taker] = await Promise.all([hub.getGlobalLongShortRatio(s, '5m', 12), hub.getTopTraderLongShortRatio(s, '5m', 12), hub.getTakerLongShortRatio(s, '5m', 12)]);
        const last = (a: any[]) => (a.length ? a[a.length - 1] : null);
        return {
          symbol: s,
          global: last(g as any[]) ? { ratio: round(last(g as any[]).longShortRatio, 2), longPct: round(last(g as any[]).longAccount * 100, 1) } : null,
          topTraders: last(top as any[]) ? { ratio: round(last(top as any[]).longShortRatio, 2), longPct: round(last(top as any[]).longAccount * 100, 1) } : null,
          takerBuySell: last(taker as any[]) ? { ratio: round(last(taker as any[]).buySellRatio, 2) } : null,
        };
      },
    },
    get_recent_liquidations: {
      description: 'Recent forced liquidations across the watched symbols.',
      parameters: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
      execute: async ({ limit }) => hub.getRecentLiquidations(Math.min(Number(limit), 50)).map((l) => ({ symbol: l.symbol, side: l.side, price: round(l.price, 2), notionalUsd: round(l.notionalUsd, 0), time: new Date(l.time).toISOString() })),
    },
  };
}

function buildOverviewTool(hub: MarketDataHub): Record<string, ToolDef> {
  return {
    get_market_overview: {
      description: 'One-shot overview of all watched symbols: price, 24h change, funding, trend.',
      parameters: z.object({}),
      execute: async () => {
        const out = [];
        for (const s of config.symbols) {
          const px = hub.getPrice(s) ?? hub.getBookTicker(s);
          const t = hub.getTicker24h(s);
          const mp = hub.getMarkPrice(s);
          let trend: string | null = null;
          try {
            const ks = await hub.getKlines(s, '15m', 60);
            const snap = indicatorSnapshot('15m', ks);
            trend = snap ? `${snap.trend}/${snap.momentum}` : null;
          } catch (err: unknown) {
            trend = null;
          }
          out.push({
            symbol: s, price: px ? round(typeof px === 'number' ? px : (px.bid + px.ask) / 2, 2) : null,
            change24hPct: t ? round(t.priceChangePercent, 2) : null, fundingRatePct: mp ? round(mp.fundingRate * 100, 4) : null, trend15m: trend,
          });
        }
        return { symbols: out, hubHealthy: hub.isHealthy() };
      },
    },
  };
}

function buildAccountTools(ctx: ToolContext): Record<string, ToolDef> {
  const { hub, paper, risk } = ctx;
  return {
    get_portfolio: {
      description: 'Paper account state: wallet balance, equity, available margin, open positions.',
      parameters: z.object({}),
      execute: async () => {
        const marks = ctx.markPrices();
        await paper.sync(marks);
        const acc = paper.getAccount(marks);
        const positions = paper.markPositions(marks);
        return {
          balance: round(acc.balance, 2), equity: round(acc.equity, 2), availableMargin: round(acc.available, 2), marginUsed: round(acc.marginUsed, 2),
          dayPnl: round(acc.equity - acc.dayStartEquity, 2),
          positions: positions.map((p) => ({
            symbol: p.symbol, side: p.side, qty: round(p.qty, 4), entryPrice: round(p.entryPrice, 2),
            markPrice: marks[p.symbol] ? round(marks[p.symbol]!, 2) : null, leverage: round(p.leverage, 2), unrealizedPnl: round(p.unrealizedPnl, 2), liquidationPrice: p.liquidationPrice ? round(p.liquidationPrice, 2) : null,
          })),
          riskHalt: risk.isHalted().halted ? risk.isHalted().reason : null,
        };
      },
    },
    get_recent_orders: {
      description: 'Recent paper orders with reasons.',
      parameters: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
      execute: async ({ limit }) => paper.getRecentOrders(Math.min(Number(limit), 50)).map((o) => ({
        time: new Date(o.timestamp).toISOString(), symbol: o.symbol, side: o.side, qty: round(o.qty, 4), price: round(o.price, 2), notional: round(o.notional, 0), fee: round(o.fee, 3), realizedPnl: round(o.realizedPnl, 2), reason: o.reason.slice(0, 120),
      })),
    },
    get_symbol_rules: {
      description: 'Exchange rules for a symbol: tick size, step size, min qty, min notional.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        try {
          const rules = await hub.getSymbolRules(s);
          const f = (rules.filters ?? []) as any[];
          return { symbol: s, status: rules.status, stepSize: f.find((x) => x.filterType === 'LOT_SIZE')?.stepSize ?? null, minQty: f.find((x) => x.filterType === 'LOT_SIZE')?.minQty ?? null, marketMinQty: f.find((x) => x.filterType === 'MARKET_LOT_SIZE')?.minQty ?? null, minNotional: f.find((x) => x.filterType === 'MIN_NOTIONAL')?.notional ?? null };
        } catch (err: unknown) {
          return { error: `rules unavailable: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    },
  };
}

async function executePlaceOrder(args: any, ctx: ToolContext): Promise<unknown> {
  const { hub, paper, risk, markPrices } = ctx;
  const symbol = String(args.symbol).toUpperCase();
  const side = String(args.side).toUpperCase() as 'BUY' | 'SELL';
  const qty = Number(args.qty);
  const leverage = Math.max(1, Math.min(Number(args.leverage ?? 1), config.paper.maxLeverage));
  const stopDistancePct = args.stop_distance_pct != null ? Number(args.stop_distance_pct) : null;
  const reason = String(args.reason ?? 'agent');
  const clientOrderId = args.client_order_id ? String(args.client_order_id) : undefined;

  const marks = markPrices();
  const bt = hub.getBookTicker(symbol);
  const px = hub.getPrice(symbol) ?? (bt ? (bt.bid + bt.ask) / 2 : null);
  if (px === null) return { error: `no live price for ${symbol}` };

  const check = risk.checkOrder({ symbol, side, qty, price: px, leverage, stopDistancePct, reason }, marks);
  if (!check.approved) return { error: check.reason, checks: check.checks };

  try {
    const res = await paper.placeMarketOrder(symbol, side, qty, px, { leverage, reason, clientOrderId });
    return {
      ok: true, orderId: res.id, symbol, side, qty, fillPrice: round(res.price, 2), notional: round(res.notional, 2), fee: round(res.fee, 3), realizedPnl: round(res.realizedPnl, 2), reduceOnly: res.reduceOnly,
      position: res.position ? { side: res.position.side, qty: round(res.position.qty, 4), entryPrice: round(res.position.entryPrice, 2), leverage: round(res.position.leverage, 2) } : null,
      equityAfter: round(res.equity, 2), availableAfter: round(res.available, 2),
    };
  } catch (err: unknown) {
    return { error: `exchange rejected: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function buildTradingTools(ctx: ToolContext): Record<string, ToolDef> {
  return {
    set_plan: {
      description: 'State your trading plan BEFORE placing orders.',
      parameters: z.object({ plan: z.string().min(10) }),
      execute: async ({ plan }) => {
        ctx.setPlanNote(String(plan).slice(0, 500));
        return { ok: true, note: 'plan recorded; you may now place orders consistent with it' };
      },
    },
    place_market_order: {
      description: 'Place a MARKET order on the PAPER exchange (risk-gated, idempotent with client_order_id).',
      parameters: z.object({
        symbol: z.string(), side: z.enum(['BUY', 'SELL']), qty: z.number().positive(),
        leverage: z.number().int().min(1).max(config.paper.maxLeverage).default(1),
        stop_distance_pct: z.number().positive().max(50).nullable().default(null),
        reason: z.string().min(5),
        client_order_id: z.string().optional().describe('Unique client order ID for idempotency'),
      }),
      execute: (args) => executePlaceOrder(args, ctx),
    },
    close_position: {
      description: 'Fully close an open position at market.',
      parameters: z.object({ symbol: z.string(), reason: z.string().min(5) }),
      execute: async ({ symbol, reason }) => {
        const s = String(symbol).toUpperCase();
        const p = ctx.paper.getPosition(s);
        if (!p) return { error: `no open position in ${s}` };
        const marks = ctx.markPrices();
        const px = marks[s];
        if (px === undefined) return { error: `no mark price for ${s}; refusing to close at an unknown price` };
        const res = await ctx.paper.placeMarketOrder(s, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, px, { reason: `CLOSE: ${String(reason).slice(0, 400)}` });
        return { ok: true, symbol: s, closedSide: p.side, qty: round(p.qty, 4), exitPrice: round(res.price, 2), realizedPnl: round(res.realizedPnl, 2), fee: round(res.fee, 3), equityAfter: round(res.equity, 2) };
      },
    },
  };
}

export function createTools(ctx: ToolContext): Record<string, ToolDef> {
  return {
    ...buildPriceTools(ctx.hub),
    ...buildOrderBookTools(ctx.hub),
    ...buildSentimentTools(ctx.hub),
    ...buildOverviewTool(ctx.hub),
    ...buildAccountTools(ctx),
    ...buildTradingTools(ctx),
  };
}
