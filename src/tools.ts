/**
 * Tools — the LLM's only interface to the market and the paper exchange.
 * Every public USDT-M data source is exposed; trading goes through the
 * RiskManager before reaching the PaperExchange.
 *
 * Tool results are compact (top-N, rounded) so a small model with 8k context
 * can actually reason about them.
 */
import { z } from 'zod';
import { config } from './config.js';
import { snapshot as indicatorSnapshot } from './indicators.js';
import type { MarketDataHub } from './market-data-hub.js';
import type { PaperExchange } from './paper-exchange.js';
import type { RiskManager } from './risk.js';

export interface ToolContext {
  hub: MarketDataHub;
  paper: PaperExchange;
  risk: RiskManager;
  /** Snapshot of live WS prices for mark-to-market. */
  markPrices: () => Record<string, number>;
  /** Stated plan for the current cycle (used to validate orders against). */
  setPlanNote: (note: string) => void;
}

export interface ToolDef {
  description: string;
  parameters: z.ZodTypeAny;
  execute: (args: any) => Promise<unknown>;
}

const round = (n: number, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

export function createTools(ctx: ToolContext): Record<string, ToolDef> {
  const { hub, paper, risk } = ctx;

  const markPrices = () => ctx.markPrices();

  return {
    // ---------------- market data (read) ----------------

    get_live_price: {
      description: 'Current live price of a USDT-M perpetual from WebSocket (real-time). Use this, not old kline closes, for current price.',
      parameters: z.object({
        symbol: z.string().describe('Symbol, e.g. BTCUSDT'),
      }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const bt = hub.getBookTicker(s);
        const px = hub.getPrice(s);
        if (px === null && !bt) return { error: `no live data yet for ${s}` };
        return {
          symbol: s,
          price: round(px ?? (bt!.bid + bt!.ask) / 2, 2),
          bid: bt ? round(bt.bid, 2) : null,
          ask: bt ? round(bt.ask, 2) : null,
        };
      },
    },

    get_24h_ticker: {
      description: '24h statistics (change %, high, low, volume) for a symbol.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const t = hub.getTicker24h(s) ?? await hub.getTicker24hrFresh(s);
        return {
          symbol: s, lastPrice: round(t.lastPrice, 2),
          changePct: round(t.priceChangePercent, 2),
          high24h: round(t.highPrice, 2), low24h: round(t.lowPrice, 2),
          volume: round(t.volume, 0), quoteVolumeUsd: round(t.quoteVolume, 0),
        };
      },
    },

    get_klines: {
      description: 'Recent closed candles (OHLCV) for a symbol and interval. Returns the most recent N candles, oldest first.',
      parameters: z.object({
        symbol: z.string(),
        interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).describe('Candle interval'),
        limit: z.number().int().min(10).max(100).default(50),
      }),
      execute: async ({ symbol, interval, limit }) => {
        const s = String(symbol).toUpperCase();
        const ks = await hub.getKlines(s, interval, Number(limit));
        return ks.slice(-Math.min(Number(limit), 100)).map((k) => ({
          t: k.openTime, o: round(k.open, 2), h: round(k.high, 2),
          l: round(k.low, 2), c: round(k.close, 2), v: round(k.volume, 1),
        }));
      },
    },

    get_indicators: {
      description: 'Computed technical indicators (EMA, RSI, ATR, MACD, Bollinger, VWAP, trend classification) for a symbol/interval. Cheaper than raw klines.',
      parameters: z.object({
        symbol: z.string(),
        interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('15m'),
      }),
      execute: async ({ symbol, interval }) => {
        const s = String(symbol).toUpperCase();
        const ks = await hub.getKlines(s, interval, 120);
        const snap = indicatorSnapshot(String(interval), ks);
        if (!snap) return { error: 'not enough candles yet' };
        return {
          interval: snap.interval, lastClose: round(snap.lastClose, 2),
          ema9: snap.ema9 && round(snap.ema9, 2), ema21: snap.ema21 && round(snap.ema21, 2),
          ema50: snap.ema50 && round(snap.ema50, 2),
          rsi14: snap.rsi14 && round(snap.rsi14, 1),
          atrPct: snap.atrPct && round(snap.atrPct, 2),
          macd: snap.macd ? { macd: round(snap.macd.macd, 2), signal: round(snap.macd.signal, 2), hist: round(snap.macd.histogram, 2) } : null,
          bollinger: snap.bollinger
            ? { upper: round(snap.bollinger.upper, 2), mid: round(snap.bollinger.middle, 2), lower: round(snap.bollinger.lower, 2), bandwidthPct: round(snap.bollinger.bandwidthPct, 2) }
            : null,
          vwap: snap.vwap && round(snap.vwap, 2),
          trend: snap.trend, momentum: snap.momentum,
        };
      },
    },

    get_order_book: {
      description: 'Top levels of the live L2 order book (best bids/asks with quantities), mid price and spread.',
      parameters: z.object({
        symbol: z.string(),
        levels: z.number().int().min(1).max(20).default(5),
      }),
      execute: async ({ symbol, levels }) => {
        const s = String(symbol).toUpperCase();
        const top = hub.getOrderBookTop(s, Math.min(Number(levels), 20));
        if (!top) return { error: `order book for ${s} not synced yet` };
        return {
          symbol: s,
          bids: top.bids.map((l: { price: number; qty: number }) => [round(l.price, 2), round(l.qty, 3)]),
          asks: top.asks.map((l: { price: number; qty: number }) => [round(l.price, 2), round(l.qty, 3)]),
          midPrice: top.midPrice && round(top.midPrice, 2),
          spreadBps: top.spreadBps && round(top.spreadBps, 2),
          synced: (top as { synced?: boolean }).synced ?? null,
        };
      },
    },

    get_mark_price_funding: {
      description: 'Mark price, index price, current funding rate and next funding time for a symbol.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const mp = hub.getMarkPrice(s);
        if (!mp) return { error: `no mark price yet for ${s}` };
        return {
          symbol: s, markPrice: round(mp.markPrice, 2), indexPrice: round(mp.indexPrice, 2),
          fundingRatePct: round(mp.fundingRate * 100, 4),
          nextFundingTime: new Date(mp.nextFundingTime).toISOString(),
          fundingEtaMin: round((mp.nextFundingTime - Date.now()) / 60_000, 0),
        };
      },
    },

    get_funding_history: {
      description: 'Recent funding rate history for a symbol (sentiment / carry signal).',
      parameters: z.object({ symbol: z.string(), limit: z.number().int().min(1).max(50).default(10) }),
      execute: async ({ symbol, limit }) => {
        const s = String(symbol).toUpperCase();
        const fr = await hub.getFundingRateHistory(s, Math.min(Number(limit), 50));
        return fr.map((f: any) => ({
          time: new Date(f.fundingTime).toISOString(), ratePct: round(f.fundingRate * 100, 4),
        }));
      },
    },

    get_open_interest: {
      description: 'Current open interest and its recent history for a symbol (positioning build-up / unwind).',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const [oi, hist] = await Promise.all([
          hub.getOpenInterest(s),
          hub.getOpenInterestHist(s, '5m', 24),
        ]);
        return {
          symbol: s,
          currentOI: round(oi.openInterest, 0),
          history: (hist as any[]).slice(-12).map((h) => ({
            t: h.timestamp, oi: round(h.sumOpenInterest, 0), oiUsd: round(h.sumOpenInterestValue, 0),
          })),
        };
      },
    },

    get_long_short_ratio: {
      description: 'Crowd positioning: global + top-trader long/short account ratios and taker buy/sell ratio.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        const [g, top, taker] = await Promise.all([
          hub.getGlobalLongShortRatio(s, '5m', 12),
          hub.getTopTraderLongShortRatio(s, '5m', 12),
          hub.getTakerLongShortRatio(s, '5m', 12),
        ]);
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
      description: 'Recent forced liquidations across the watched symbols (cascades = volatility signal).',
      parameters: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
      execute: async ({ limit }) => {
        const liqs = hub.getRecentLiquidations(Math.min(Number(limit), 50));
        return liqs.map((l) => ({
          symbol: l.symbol, side: l.side, price: round(l.price, 2),
          notionalUsd: round(l.notionalUsd, 0), time: new Date(l.time).toISOString(),
        }));
      },
    },

    get_market_overview: {
      description: 'One-shot overview of all watched symbols: price, 24h change, funding, trend. Start here each cycle.',
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
          } catch { /* REST unavailable — skip trend */ }
          out.push({
            symbol: s,
            price: px ? round(typeof px === 'number' ? px : (px.bid + px.ask) / 2, 2) : null,
            change24hPct: t ? round(t.priceChangePercent, 2) : null,
            fundingRatePct: mp ? round(mp.fundingRate * 100, 4) : null,
            trend15m: trend,
          });
        }
        return { symbols: out, hubHealthy: hub.isHealthy() };
      },
    },

    // ---------------- paper account (read) ----------------

    get_portfolio: {
      description: 'Paper account state: wallet balance, equity, available margin, open positions with unrealized PnL and estimated liquidation prices.',
      parameters: z.object({}),
      execute: async () => {
        const marks = markPrices();
        const acc = paper.getAccount(marks);
        const positions = paper.markPositions(marks);
        return {
          balance: round(acc.balance, 2),
          equity: round(acc.equity, 2),
          availableMargin: round(acc.available, 2),
          marginUsed: round(acc.marginUsed, 2),
          dayPnl: round(acc.equity - acc.dayStartEquity, 2),
          positions: positions.map((p) => ({
            symbol: p.symbol, side: p.side, qty: round(p.qty, 4),
            entryPrice: round(p.entryPrice, 2),
            markPrice: marks[p.symbol] ? round(marks[p.symbol]!, 2) : null,
            leverage: round(p.leverage, 2),
            unrealizedPnl: round(p.unrealizedPnl, 2),
            liquidationPrice: p.liquidationPrice ? round(p.liquidationPrice, 2) : null,
          })),
          riskHalt: risk.isHalted().halted ? risk.isHalted().reason : null,
        };
      },
    },

    get_recent_orders: {
      description: 'Recent paper orders (history) with the reason each was placed.',
      parameters: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
      execute: async ({ limit }) => {
        return paper.getRecentOrders(Math.min(Number(limit), 50)).map((o) => ({
          time: new Date(o.timestamp).toISOString(), symbol: o.symbol, side: o.side,
          qty: round(o.qty, 4), price: round(o.price, 2), notional: round(o.notional, 0),
          fee: round(o.fee, 3), realizedPnl: round(o.realizedPnl, 2),
          reason: o.reason.slice(0, 120),
        }));
      },
    },

    // ---------------- trading (write, risk-gated) ----------------

    set_plan: {
      description: 'State your trading plan BEFORE placing orders: thesis, entry, stop distance %, target, position size. Required before place_market_order.',
      parameters: z.object({
        plan: z.string().min(10).describe('The plan in one or two sentences, including stop-loss distance in %'),
      }),
      execute: async ({ plan }) => {
        ctx.setPlanNote(String(plan).slice(0, 500));
        return { ok: true, note: 'plan recorded; you may now place orders consistent with it' };
      },
    },

    place_market_order: {
      description: 'Place a MARKET order on the PAPER exchange (risk-gated). State a plan first. For opening: specify leverage and stop_distance_pct.',
      parameters: z.object({
        symbol: z.string(),
        side: z.enum(['BUY', 'SELL']).describe('BUY = open/increase LONG, SELL = open/increase SHORT or close LONG'),
        qty: z.number().positive().describe('Quantity in base asset (e.g. BTC)'),
        leverage: z.number().int().min(1).max(config.paper.maxLeverage).default(1),
        stop_distance_pct: z.number().positive().max(50).nullable().default(null)
          .describe('Planned stop-loss distance from entry in % — used for the risk check'),
        reason: z.string().min(5).describe('One-sentence rationale, stored with the order'),
      }),
      execute: async (args) => {
        const symbol = String(args.symbol).toUpperCase();
        const side = String(args.side).toUpperCase() as 'BUY' | 'SELL';
        const qty = Number(args.qty);
        const leverage = Math.max(1, Math.min(Number(args.leverage ?? 1), config.paper.maxLeverage));
        const stopDistancePct = args.stop_distance_pct != null ? Number(args.stop_distance_pct) : null;
        const reason = String(args.reason ?? 'agent');

        const marks = markPrices();
        const bt = hub.getBookTicker(symbol);
        const px = hub.getPrice(symbol) ?? (bt ? (bt.bid + bt.ask) / 2 : null);
        if (px === null) return { error: `no live price for ${symbol}` };

        const check = risk.checkOrder(
          { symbol, side, qty, price: px, leverage, stopDistancePct, reason },
          marks,
        );
        if (!check.approved) return { error: check.reason, checks: check.checks };

        try {
          const res = paper.placeMarketOrder(symbol, side, qty, px, { leverage, reason });
          return {
            ok: true, orderId: res.id, symbol, side, qty, fillPrice: round(res.price, 2),
            notional: round(res.notional, 2), fee: round(res.fee, 3),
            realizedPnl: round(res.realizedPnl, 2), reduceOnly: res.reduceOnly,
            position: res.position ? {
              side: res.position.side, qty: round(res.position.qty, 4),
              entryPrice: round(res.position.entryPrice, 2), leverage: round(res.position.leverage, 2),
            } : null,
            equityAfter: round(res.equity, 2), availableAfter: round(res.available, 2),
          };
        } catch (err: any) {
          return { error: `exchange rejected: ${err.message}` };
        }
      },
    },

    close_position: {
      description: 'Fully close an open position at market with a reason.',
      parameters: z.object({
        symbol: z.string(),
        reason: z.string().min(5),
      }),
      execute: async ({ symbol, reason }) => {
        const s = String(symbol).toUpperCase();
        const p = paper.getPosition(s);
        if (!p) return { error: `no open position in ${s}` };
        const marks = markPrices();
        const px = marks[s] ?? p.entryPrice;
        const res = paper.placeMarketOrder(s, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, px, {
          reason: `CLOSE: ${String(reason).slice(0, 400)}`,
        });
        return {
          ok: true, symbol: s, closedSide: p.side, qty: round(p.qty, 4),
          exitPrice: round(res.price, 2), realizedPnl: round(res.realizedPnl, 2),
          fee: round(res.fee, 3), equityAfter: round(res.equity, 2),
        };
      },
    },

    get_symbol_rules: {
      description: 'Exchange rules for a symbol: tick size, step size, min qty, min notional. Use before sizing an order.',
      parameters: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const s = String(symbol).toUpperCase();
        try {
          const rules = await hub.getSymbolRules(s);
          const f = (rules.filters ?? []) as any[];
          const lot = f.find((x) => x.filterType === 'LOT_SIZE');
          const mlot = f.find((x) => x.filterType === 'MARKET_LOT_SIZE');
          const minNotional = f.find((x) => x.filterType === 'MIN_NOTIONAL');
          return {
            symbol: s, status: rules.status,
            stepSize: lot?.stepSize ?? null, minQty: lot?.minQty ?? null,
            marketMinQty: mlot?.minQty ?? null,
            minNotional: minNotional?.notional ?? null,
          };
        } catch (err: any) {
          return { error: `rules unavailable: ${err.message}` };
        }
      },
    },
  };
}

/** Convert zod schemas to JSON Schema for the Ollama tools API. */
export function toOllamaTools(tools: Record<string, ToolDef>) {
  return Object.entries(tools).map(([name, t]) => ({
    type: 'function' as const,
    function: {
      name,
      description: t.description,
      parameters: zodToJsonSchema(t.parameters),
    },
  }));
}

/**
 * Minimal zod → JSON Schema (covers the subset used in this project).
 * Handles both zod 3 (`_def.typeName`) and zod 4 (`node.type` + `node.def`)
 * node layouts.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const node = schema as any;
  // zod 4: node.type ('object' | 'string' | …) + node.def; zod 3: node._def.typeName.
  const kind: string = node.type ?? node._def?.typeName?.replace(/^Zod/, '').toLowerCase() ?? '';
  const def: any = node.def ?? node._def ?? {};

  const inner = () => (def.innerType ?? def.type) as z.ZodTypeAny | undefined;

  switch (kind) {
    case 'object': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape as Record<string, z.ZodTypeAny>)) {
        properties[k] = zodToJsonSchema(v);
        const vNode = v as any;
        const vKind = vNode.type ?? vNode._def?.typeName?.replace(/^Zod/, '').toLowerCase() ?? '';
        const hasDefault = (vNode.def ?? vNode._def ?? {}).defaultValue !== undefined;
        const isOptional = vKind === 'optional' || hasDefault;
        if (!isOptional) required.push(k);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    case 'optional':
    case 'default': {
      const it = inner();
      return it ? zodToJsonSchema(it) : { type: 'string' };
    }
    case 'nullable': {
      const it = inner();
      return { anyOf: [it ? zodToJsonSchema(it) : { type: 'string' }, { type: 'null' }] };
    }
    case 'enum':
    case 'nativeenum': {
      // zod 4 stores entries; zod 3 stores values.
      const entries = def.entries ?? def.values;
      return { type: 'string', enum: Object.values(entries ?? {}) };
    }
    case 'literal':
      return { type: typeof def.value, enum: [def.value] };
    case 'string': {
      const out: any = { type: 'string' };
      for (const c of def.checks ?? []) {
        const cKind = c.type ?? c.kind;
        if (cKind === 'min') out.minLength = c.value ?? c.def?.value;
        if (cKind === 'max') out.maxLength = c.value ?? c.def?.value;
      }
      return out;
    }
    case 'number': {
      const out: any = { type: 'number' };
      for (const c of def.checks ?? []) {
        const cKind = c.type ?? c.kind;
        const val = c.value ?? c.def?.value;
        if (cKind === 'min') out.minimum = val;
        if (cKind === 'max') out.maximum = val;
        if (cKind === 'int') out.type = 'integer';
      }
      return out;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'array': {
      const it = inner();
      return { type: 'array', items: it ? zodToJsonSchema(it) : {} };
    }
    case 'union': {
      const opts = def.options as z.ZodTypeAny[] | undefined;
      return { anyOf: (opts ?? []).map((o) => zodToJsonSchema(o)) };
    }
    default:
      return { type: 'string' };
  }
}
