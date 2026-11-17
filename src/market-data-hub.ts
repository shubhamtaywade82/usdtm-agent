/**
 * MarketDataHub — WS-first USDT-M live streaming with cached REST fallbacks.
 */
import { EventEmitter } from 'node:events';
import { BinanceClient } from '@nemesis-oss/binance-sdk';
import { config } from './config.js';
import type { BookTicker, Kline, Liquidation, MarkPrice, Ticker24h } from './types.js';

interface Cached<T> { value: T; at: number; }

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
  private client = new BinanceClient({ timeoutMs: config.marketData.restTimeoutMs, maxRetries: 1 });
  private marketWs = this.client.futures.ws;
  private publicWs = this.client.futures.wsPublic;
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

  // Mainnet only: a testnet snapshot would seed a mainnet stream with the wrong book.
  private async fetchDepthSnapshot(symbol: string): Promise<{ lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.marketData.restTimeoutMs);
    try {
      const r = await fetch(`${config.marketData.restBase}/fapi/v1/depth?symbol=${symbol}&limit=1000`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`depth snapshot HTTP ${r.status}`);
      const j = await r.json() as { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] };
      return { lastUpdateId: j.lastUpdateId, bids: j.bids, asks: j.asks };
    } finally {
      clearTimeout(timer);
    }
  }

  private setupWsListeners(): void {
    this.marketWs.on('message', (stream: string, p: Record<string, any>) => this.onPayload(stream, p));
    this.marketWs.on('error', (err: Error) => this.emit('warn', `market ws: ${err.message}`));
    this.publicWs.on('message', (stream: string, p: Record<string, any>) => this.onPayload(stream, p));
    this.publicWs.on('error', (err: Error) => this.emit('warn', `public ws: ${err.message}`));
  }

  private async initL2Books(symbols: string[]): Promise<void> {
    this.bookEngine = this.client.createFuturesOrderBookEngine({
      fetchSnapshot: (sym: string) => this.fetchDepthSnapshot(sym),
    } as any);
    for (const s of symbols) {
      try {
        const book = (await this.bookEngine.subscribe(s)) as unknown as FuturesOrderBook;
        this.l2Books.set(s, book);
      } catch (err: unknown) {
        this.emit('warn', `book ${s}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const deadline = Date.now() + 90_000;
    await new Promise<void>((resolve) => {
      const check = () => {
        const populated = [...this.l2Books.values()].some((b) => b.bids.length > 0 && b.asks.length > 0);
        if (populated || Date.now() > deadline) return resolve();
        setTimeout(check, 1000);
      };
      check();
    });
  }

  async start(symbols: string[] = config.symbols): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.setupWsListeners();
    const market = symbols.map((s) => s.toLowerCase());
    await this.marketWs.subscribe(market.flatMap((s) => [
      `${s}@aggTrade`, `${s}@kline_1m`, `${s}@kline_5m`, `${s}@kline_15m`,
      `${s}@markPrice@1s`, `${s}@ticker`, `${s}@forceOrder`,
    ]));
    await this.publicWs.subscribe(market.map((s) => `${s}@bookTicker`));
    await this.initL2Books(symbols);
    this.emit('info', `MarketDataHub live: ${symbols.length * 8} streams, ${this.l2Books.size} L2 books (${symbols.join(',')})`);
  }

  private handleKlinePayload(k: any): void {
    const kline: Kline = {
      symbol: k.s, interval: k.i, openTime: k.t,
      open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c),
      volume: Number(k.v), quoteVolume: Number(k.q), trades: k.n,
      takerBuyBaseVolume: Number(k.V), closed: k.x,
    };
    const key = `${k.s}:${k.i}`;
    const arr = this.klines.get(key) ?? [];
    if (arr.length === 0 || arr[arr.length - 1].openTime < kline.openTime) arr.push(kline);
    else arr[arr.length - 1] = kline;
    while (arr.length > 500) arr.shift();
    this.klines.set(key, arr);
    this.emit('kline', kline);
    if (kline.closed) this.emit('klineClosed', kline);
  }

  private handleForceOrderPayload(o: any): void {
    const price = Number(o.ap) || Number(o.p);
    const qty = Number(o.q);
    const liq: Liquidation = { symbol: o.s, side: o.S, price, qty, notionalUsd: price * qty, time: o.T };
    this.liquidations.unshift(liq);
    if (this.liquidations.length > 100) this.liquidations.pop();
    this.emit('liquidation', liq);
  }

  private handleStreamMessage(p: Record<string, any>, eventType: string): void {
    if (eventType === 'aggTrade') {
      this.prices.set(p.s, Number(p.p));
      this.emit('trade', { symbol: p.s, price: Number(p.p), qty: Number(p.q), time: p.T });
    } else if (eventType === 'bookTicker') {
      const bt: BookTicker = { symbol: p.s, bid: Number(p.b), bidQty: Number(p.B), ask: Number(p.a), askQty: Number(p.A), time: Date.now() };
      this.bookTickers.set(bt.symbol, bt);
      this.emit('bookTicker', bt);
    } else if (eventType === 'markPriceUpdate') {
      const mp: MarkPrice = { symbol: p.s, markPrice: Number(p.p), indexPrice: Number(p.i), fundingRate: Number(p.r), nextFundingTime: Number(p.T), time: p.E };
      this.markPrices.set(mp.symbol, mp);
      this.emit('markPrice', mp);
    } else if (eventType === '24hrTicker') {
      const t: Ticker24h = { symbol: p.s, lastPrice: Number(p.c), priceChangePercent: Number(p.P), highPrice: Number(p.h), lowPrice: Number(p.l), volume: Number(p.v), quoteVolume: Number(p.q) };
      this.tickers.set(t.symbol, t);
      this.emit('ticker', t);
    } else if (eventType === 'kline') {
      this.handleKlinePayload(p.k);
    } else if (eventType === 'forceOrder') {
      this.handleForceOrderPayload(p.o);
    }
  }

  private onPayload(stream: string, p: Record<string, any>): void {
    this.lastMessageAt = Date.now();
    const channel = stream.split('@')[1] ?? '';
    const eventType = p.e ?? (channel === 'bookTicker' ? 'bookTicker' : undefined);
    if (eventType) this.handleStreamMessage(p, eventType);
  }

  getPrice(symbol: string): number | null { return this.prices.get(symbol) ?? null; }
  getBookTicker(symbol: string): BookTicker | null { return this.bookTickers.get(symbol) ?? null; }
  getMarkPrice(symbol: string): MarkPrice | null { return this.markPrices.get(symbol) ?? null; }
  getTicker24h(symbol: string): Ticker24h | null { return this.tickers.get(symbol) ?? null; }
  getCachedKlines(symbol: string, interval: string): Kline[] { return this.klines.get(`${symbol}:${interval}`) ?? []; }
  getRecentLiquidations(limit = 10): Liquidation[] { return this.liquidations.slice(0, limit); }
  isHealthy(): boolean { return this.started && Date.now() - this.lastMessageAt < config.triggers.staleMs; }

  getOrderBookTop(symbol: string, levels = 5) {
    const book = this.l2Books.get(symbol);
    if (!book || book.bids.length === 0 || book.asks.length === 0) return null;
    const bids = book.bids.slice(0, levels).map((l) => ({ price: Number(l.price), qty: Number(l.quantity) }));
    const asks = book.asks.slice(0, levels).map((l) => ({ price: Number(l.price), qty: Number(l.quantity) }));
    const mid = bids.length > 0 && asks.length > 0 ? (bids[0].price + asks[0].price) / 2 : null;
    const spreadBps = mid && bids[0] ? ((asks[0].price - bids[0].price) / mid) * 10_000 : null;
    return { symbol, bids, asks, midPrice: mid, spreadBps, synced: book.isSynced };
  }

  private async cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.restCache.get(key) as Cached<T> | undefined;
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    try {
      const value = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`REST timeout after ${config.marketData.restTimeoutMs}ms`)), config.marketData.restTimeoutMs)),
      ]);
      this.restCache.set(key, { value, at: Date.now() });
      return value;
    } catch (err) {
      if (hit) return hit.value;
      throw err;
    }
  }

  private async cachedOr<T>(key: string, ttlMs: number, fallback: T, fn: () => Promise<T>): Promise<T> {
    try { return await this.cached(key, ttlMs, fn); } catch { return fallback; }
  }

  async getKlines(symbol: string, interval: string, limit = 100): Promise<Kline[]> {
    const live = this.getCachedKlines(symbol, interval).filter((k) => k.closed);
    if (live.length >= limit) return live.slice(-limit);
    try {
      const raw = await this.cached(`klines:${symbol}:${interval}:${limit}`, config.marketData.restCacheMs, () => this.client.futures.market.klines(symbol, interval as any, { limit }));
      return raw.map((k: any) => ({
        symbol, interval: String(interval), openTime: k.openTime,
        open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume,
        quoteVolume: k.quoteAssetVolume, trades: k.trades, takerBuyBaseVolume: k.takerBuyBaseVolume, closed: true,
      }));
    } catch {
      const partial = this.getCachedKlines(symbol, interval);
      if (partial.length > 0) return partial.slice(-limit);
      throw new Error(`klines unavailable for ${symbol} ${interval} (WS warming up, REST unreachable)`);
    }
  }

  getOpenInterest(symbol: string) {
    return this.cachedOr(`oi:${symbol}`, config.marketData.restCacheMs, { symbol, openInterest: NaN, time: 0 }, () => this.client.futures.data.openInterest(symbol));
  }
  getOpenInterestHist(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`oih:${symbol}:${period}:${limit}`, config.marketData.restCacheMs, [] as unknown[], () => this.client.futures.data.openInterestHist(symbol, period, limit));
  }
  getFundingRateHistory(symbol: string, limit = 10) {
    return this.cachedOr(`fr:${symbol}:${limit}`, config.marketData.restCacheMs, [] as unknown[], () => this.client.futures.data.fundingRateHistory(symbol, { limit }));
  }
  getGlobalLongShortRatio(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`lsr:${symbol}:${period}:${limit}`, config.marketData.restCacheMs, [] as unknown[], () => this.client.futures.data.globalLongShortAccountRatio(symbol, period, limit));
  }
  getTopTraderLongShortRatio(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`tlsr:${symbol}:${period}:${limit}`, config.marketData.restCacheMs, [] as unknown[], () => this.client.futures.data.topLongShortAccountRatio(symbol, period, limit));
  }
  getTakerLongShortRatio(symbol: string, period = '5m', limit = 30) {
    return this.cachedOr(`tlsr-taker:${symbol}:${period}:${limit}`, config.marketData.restCacheMs, [] as unknown[], () => this.client.futures.data.takerLongShortRatio(symbol, period, limit));
  }
  getTicker24hrFresh(symbol: string): Promise<Ticker24h> {
    return this.cached(`t24:${symbol}`, config.marketData.restCacheMs, async () => {
      const t = await this.client.futures.market.ticker24hr(symbol);
      return { symbol: t.symbol, lastPrice: t.lastPrice, priceChangePercent: t.priceChangePercent, highPrice: t.highPrice, lowPrice: t.lowPrice, volume: t.volume, quoteVolume: t.quoteVolume };
    });
  }
  getSymbolRules(symbol: string) {
    return this.cached(`rules:${symbol}`, 3600_000, () => this.client.futures.market.instrumentDetails(symbol));
  }

  async stop(): Promise<void> {
    try {
      this.client.futures.ws.close();
      this.client.futures.wsPublic.close();
    } catch (err: unknown) {
      this.emit('warn', `error stopping sockets: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.started = false;
  }
}
