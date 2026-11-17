/**
 * MarketDataHub — all live USDT-M market data over the SDK's WebSocket
 * connections (auto-routed /market vs /public), plus cached public REST
 * fallbacks for history endpoints.
 *
 * Design: WS-first. Prices, book tickers, mark price/funding, klines,
 * liquidations and the L2 order book all arrive over WebSocket; REST is only
 * touched for historical series (klines, OI history, funding history,
 * long/short ratios) with short-lived caching to stay far under rate limits.
 */
import { EventEmitter } from 'node:events';
import { BinanceClient } from '@nemesis-oss/binance-sdk';
import { config } from './config.js';
import type {
  BookTicker, Kline, Liquidation, MarkPrice, Ticker24h,
} from './types.js';

interface Cached<T> { value: T; at: number; }

/** Order-book object returned by `client.subscribeFuturesOrderBook`. */
interface FuturesOrderBook {
  isSynced: boolean;
  bids: { price: string; quantity: string }[];
  asks: { price: string; quantity: string }[];
  bestBid(): { price: string; quantity: string } | null;
  bestAsk(): { price: string; quantity: string } | null;
  midPrice(): string | null;
  metrics(): Record<string, unknown>;
}

export class MarketDataHub extends EventEmitter {
  /** WS-first: REST is fallback-only, so keep its timeout short and retries minimal. */
  private client = new BinanceClient({
    timeoutMs: config.marketData.restTimeoutMs,
    maxRetries: 1,
  });
  /** /market route: aggTrade, klines, markPrice, ticker, forceOrder. */
  private marketWs = this.client.futures.ws;
  /** /public route: bookTicker, depth. */
  private publicWs = this.client.futures.wsPublic;
  private priceProvider = () => ({});
  private prices = new Map<string, number>();
  private bookTickers = new Map<string, BookTicker>();
  private markPrices = new Map<string, MarkPrice>();
  private tickers = new Map<string, Ticker24h>();
  private klines = new Map<string, Kline[]>();
  private liquidations: Liquidation[] = [];
  private restCache = new Map<string, Cached<unknown>>();
  private lastMessageAt = 0;
  private started = false;
  private l2Books = new Map<string, FuturesOrderBook>();
  private bookEngine!: ReturnType<BinanceClient['createFuturesOrderBookEngine']>;

  /** REST depth snapshot with mainnet → testnet failover (plain fetch, fast-fail). */
  private async fetchDepthSnapshot(symbol: string): Promise<{ lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }> {
    const bases = [config.marketData.restBase, config.marketData.testnetRestBase];
    let lastErr: unknown;
    for (const base of bases) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.marketData.restTimeoutMs);
      try {
        const r = await fetch(`${base}/fapi/v1/depth?symbol=${symbol}&limit=1000`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json() as { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] };
        return { lastUpdateId: j.lastUpdateId, bids: j.bids, asks: j.asks };
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('depth snapshot failed');
  }

  async start(symbols: string[] = config.symbols): Promise<void> {
    if (this.started) return;
    this.started = true;

    // (streamName, parsedPayload) — the facade emits raw JSON parsed per stream.
    this.marketWs.on('message', (stream: string, p: Record<string, any>) => this.onPayload(stream, p));
    this.marketWs.on('error', (err: Error) => this.emit('warn', `market ws: ${err.message}`));
    this.publicWs.on('message', (stream: string, p: Record<string, any>) => this.onPayload(stream, p));
    this.publicWs.on('error', (err: Error) => this.emit('warn', `public ws: ${err.message}`));

    const marketStreams: string[] = [];
    const publicStreams: string[] = [];
    for (const s of symbols) {
      const lower = s.toLowerCase();
      marketStreams.push(
        `${lower}@aggTrade`,
        `${lower}@kline_1m`,
        `${lower}@kline_5m`,
        `${lower}@kline_15m`,
        `${lower}@markPrice@1s`,
        `${lower}@ticker`,
        `${lower}@forceOrder`,
      );
      publicStreams.push(`${lower}@bookTicker`);
    }
    await this.marketWs.subscribe(marketStreams);
    await this.publicWs.subscribe(publicStreams);

    // L2 order books via the SDK's managed engine (snapshot + diff sync).
    // We own fetchSnapshot: primary = mainnet fapi, failover = testnet (same
    // endpoint shape). Diff streams stay on the live mainnet WS either way.
    // (The options type only exposes tuning knobs, so cast to inject the hook.)
    this.bookEngine = this.client.createFuturesOrderBookEngine({
      fetchSnapshot: async (sym: string) => this.fetchDepthSnapshot(sym),
    } as never);
    for (const s of symbols) {
      try {
        const book = (await this.bookEngine.subscribe(s)) as unknown as FuturesOrderBook;
        this.l2Books.set(s, book);
      } catch (err: any) {
        this.emit('warn', `book ${s}: ${err.message}`);
      }
    }
    const bookDeadline = Date.now() + 90_000;
    await new Promise<void>((resolve) => {
      const check = () => {
        const populated = [...this.l2Books.values()].some((b) => b.bids.length > 0 && b.asks.length > 0);
        if (populated || Date.now() > bookDeadline) return resolve();
        setTimeout(check, 1000);
      };
      check();
    });
    this.emit('info', `MarketDataHub live: ${marketStreams.length + publicStreams.length} streams, ${this.l2Books.size} L2 books (${symbols.join(',')})`);
  }

  private onPayload(stream: string, p: Record<string, any>): void {
    this.lastMessageAt = Date.now();
    // bookTicker frames on the /public route have no event type — detect by channel.
    const channel = stream.split('@')[1] ?? '';
    const eventType = p.e ?? (channel === 'bookTicker' ? 'bookTicker' : undefined);
    switch (eventType) {
      case 'aggTrade': {
        this.prices.set(p.s, Number(p.p));
        this.emit('trade', { symbol: p.s, price: Number(p.p), qty: Number(p.q), time: p.T });
        break;
      }
      case 'bookTicker': {
        // /public route bookTicker frames carry no `e` field — match by stream name.
        const bt: BookTicker = {
          symbol: p.s,
          bid: Number(p.b), bidQty: Number(p.B),
          ask: Number(p.a), askQty: Number(p.A),
          time: Date.now(),
        };
        this.bookTickers.set(bt.symbol, bt);
        this.emit('bookTicker', bt);
        break;
      }
      case 'markPriceUpdate': {
        const mp: MarkPrice = {
          symbol: p.s,
          markPrice: Number(p.p),
          indexPrice: Number(p.i),
          fundingRate: Number(p.r),
          nextFundingTime: Number(p.T),
          time: p.E,
        };
        this.markPrices.set(mp.symbol, mp);
        this.emit('markPrice', mp);
        break;
      }
      case '24hrTicker': {
        const t: Ticker24h = {
          symbol: p.s,
          lastPrice: Number(p.c),
          priceChangePercent: Number(p.P),
          highPrice: Number(p.h),
          lowPrice: Number(p.l),
          volume: Number(p.v),
          quoteVolume: Number(p.q),
        };
        this.tickers.set(t.symbol, t);
        this.emit('ticker', t);
        break;
      }
      case 'kline': {
        const k = p.k;
        const kline: Kline = {
          symbol: k.s,
          interval: k.i,
          openTime: k.t,
          open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
          volume: Number(k.v),
          quoteVolume: Number(k.q),
          trades: k.n,
          takerBuyBaseVolume: Number(k.V),
          closed: k.x,
        };
        const key = `${k.s}:${k.i}`;
        const arr = this.klines.get(key) ?? [];
        if (arr.length === 0 || arr[arr.length - 1].openTime < kline.openTime) arr.push(kline);
        else arr[arr.length - 1] = kline;
        while (arr.length > 500) arr.shift();
        this.klines.set(key, arr);
        this.emit('kline', kline);
        if (kline.closed) this.emit('klineClosed', kline);
        break;
      }
      case 'forceOrder': {
        const o = p.o;
        const price = Number(o.ap) || Number(o.p);
        const qty = Number(o.q);
        const liq: Liquidation = {
          symbol: o.s,
          side: o.S,
          price,
          qty,
          notionalUsd: price * qty,
          time: o.T,
        };
        this.liquidations.unshift(liq);
        if (this.liquidations.length > 100) this.liquidations.pop();
        this.emit('liquidation', liq);
        break;
      }
      default:
        break;
    }
  }

  // ---- live getters (WS-backed, no I/O) ----
  getPrice(symbol: string): number | null {
    return this.prices.get(symbol) ?? null;
  }
  getBookTicker(symbol: string): BookTicker | null {
    return this.bookTickers.get(symbol) ?? null;
  }
  getMarkPrice(symbol: string): MarkPrice | null {
    return this.markPrices.get(symbol) ?? null;
  }
  getTicker24h(symbol: string): Ticker24h | null {
    return this.tickers.get(symbol) ?? null;
  }
  getCachedKlines(symbol: string, interval: string): Kline[] {
    return this.klines.get(`${symbol}:${interval}`) ?? [];
  }
  getRecentLiquidations(limit = 10): Liquidation[] {
    return this.liquidations.slice(0, limit);
  }
  isHealthy(): boolean {
    return this.started && Date.now() - this.lastMessageAt < config.triggers.staleMs;
  }

  /** Order-book top levels from the SDK-managed local book. */
  getOrderBookTop(symbol: string, levels = 5) {
    const book = this.l2Books.get(symbol);
    if (!book || book.bids.length === 0 || book.asks.length === 0) return null;
    const bids = book.bids.slice(0, levels).map((l) => ({ price: Number(l.price), qty: Number(l.quantity) }));
    const asks = book.asks.slice(0, levels).map((l) => ({ price: Number(l.price), qty: Number(l.quantity) }));
    const mid = bids.length > 0 && asks.length > 0 ? (bids[0].price + asks[0].price) / 2 : null;
    const spreadBps = mid && bids[0] ? ((asks[0].price - bids[0].price) / mid) * 10_000 : null;
    return { symbol, bids, asks, midPrice: mid, spreadBps, synced: book.isSynced };
  }

  // ---- cached REST fallbacks (public, no keys) ----
  /**
   * Cache + HARD timeout wrapper. WS is the primary feed; REST is fallback —
   * a slow or rate-limited REST call must never stall an agent cycle. On
   * timeout/failure we return the stale cache if present, else throw quickly.
   */
  private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.restCache.get(key) as Cached<T> | undefined;
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    try {
      const value = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`REST timeout after ${config.marketData.restTimeoutMs}ms`)), config.marketData.restTimeoutMs)),
      ]);
      this.restCache.set(key, { value, at: Date.now() });
      return value;
    } catch (err) {
      if (hit) return hit.value; // stale is better than nothing
      throw err;
    }
  }

  /** Like cached(), but resolves to `fallback` instead of throwing when REST is unavailable. */
  private async cachedOr<T>(key: string, ttlMs: number, fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.cached(key, ttlMs, fn);
    } catch {
      return fallback;
    }
  }

  async getKlines(symbol: string, interval: string, limit = 100): Promise<Kline[]> {
    // Prefer the live WS cache once it has enough closed candles.
    const live = this.getCachedKlines(symbol, interval).filter((k) => k.closed);
    if (live.length >= Math.min(limit, 30)) return live.slice(-limit);
    // REST fallback, hard-bounded; on failure return whatever WS has so far
    // (even partial) rather than stalling the caller.
    try {
      const raw = await this.cached(`klines:${symbol}:${interval}:${limit}`, config.marketData.restCacheMs,
        () => this.client.futures.market.klines(symbol, interval as any, { limit }));
      return raw.map((k: any) => ({
        symbol,
        interval: String(interval),
        openTime: k.openTime,
        open: k.open, high: k.high, low: k.low, close: k.close,
        volume: k.volume,
        quoteVolume: k.quoteAssetVolume,
        trades: k.trades,
        takerBuyBaseVolume: k.takerBuyBaseVolume,
        closed: true,
      }));
    } catch {
      const partial = this.getCachedKlines(symbol, interval);
      if (partial.length > 0) return partial.slice(-limit);
      throw new Error(`klines unavailable for ${symbol} ${interval} (WS warming up, REST unreachable)`);
    }
  }

  async getOpenInterest(symbol: string) {
    return this.cachedOr(`oi:${symbol}`, config.marketData.restCacheMs,
      { symbol, openInterest: NaN, time: 0 },
      () => this.client.futures.data.openInterest(symbol));
  }

  async getOpenInterestHist(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`oih:${symbol}:${period}:${limit}`, config.marketData.restCacheMs,
      [] as unknown[],
      () => this.client.futures.data.openInterestHist(symbol, period, limit));
  }

  async getFundingRateHistory(symbol: string, limit = 10) {
    return this.cachedOr(`fr:${symbol}:${limit}`, config.marketData.restCacheMs,
      [] as unknown[],
      () => this.client.futures.data.fundingRateHistory(symbol, { limit }));
  }

  async getGlobalLongShortRatio(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`lsr:${symbol}:${period}:${limit}`, config.marketData.restCacheMs,
      [] as unknown[],
      () => this.client.futures.data.globalLongShortAccountRatio(symbol, period, limit));
  }

  async getTopTraderLongShortRatio(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`tlsr:${symbol}:${period}:${limit}`, config.marketData.restCacheMs,
      [] as unknown[],
      () => this.client.futures.data.topLongShortAccountRatio(symbol, period, limit));
  }

  async getTakerLongShortRatio(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`tlsr-taker:${symbol}:${period}:${limit}`, config.marketData.restCacheMs,
      [] as unknown[],
      () => this.client.futures.data.takerLongShortRatio(symbol, period, limit));
  }

  /** Fresh 24h ticker via REST (used when WS ticker has not arrived yet). */
  async getTicker24hrFresh(symbol: string): Promise<Ticker24h> {
    const t = await this.cached(`t24:${symbol}`, config.marketData.restCacheMs,
      () => this.client.futures.market.ticker24hr(symbol));
    return {
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      priceChangePercent: t.priceChangePercent,
      highPrice: t.highPrice,
      lowPrice: t.lowPrice,
      volume: t.volume,
      quoteVolume: t.quoteVolume,
    };
  }

  /** Symbol rules (tick size, step size, min notional) for order validation. */
  async getSymbolRules(symbol: string) {
    return this.cached(`rules:${symbol}`, 3600_000,
      () => this.client.futures.market.instrumentDetails(symbol));
  }

  /** Expose the raw facade for advanced uses (unused by default). */
  get facade(): BinanceClient {
    return this.client;
  }

  async stop(): Promise<void> {
    try {
      this.client.futures.ws.close();
      this.client.futures.wsPublic.close();
    } catch { /* already closed */ }
    this.started = false;
  }
}
