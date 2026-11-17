/**
 * PaperExchange — HTTP adapter for the centralized Rails paper_exchange service (port 3100).
 * Handles single-writer leasing, heartbeat renewals, order execution, and account sync.
 */
import { Decimal } from 'decimal.js';
import { config } from './config.js';
import type { PaperOrder, PaperPosition, Side } from './types.js';

export interface AccountState {
  balance: number; available: number; equity: number; marginUsed: number;
  dayStartEquity: number; realizedPnlToday: number; dayStartTs: number;
}

export interface FillResult extends PaperOrder {
  position: PaperPosition | null; equity: number; available: number;
}

export interface OrderOptions {
  leverage?: number; reason?: string; clientOrderId?: string; reduceOnly?: boolean;
}

export interface PaperExchangeOptions {
  baseUrl?: string; apiKey?: string; accountId?: string; holderId?: string;
}

export class PaperExchange {
  private baseUrl: string;
  private apiKey: string;
  private accountId: string;
  private holderId: string;
  private fence: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private priceProvider: (() => Record<string, number>) | null = null;
  private accountState: AccountState;
  private positions = new Map<string, PaperPosition>();
  private recentOrders: PaperOrder[] = [];
  private equityCurve: { ts: number; equity: number }[] = [];

  constructor(opts: PaperExchangeOptions = {}) {
    this.baseUrl = opts.baseUrl ?? config.paper.baseUrl;
    this.apiKey = opts.apiKey ?? config.paper.apiKey;
    this.accountId = opts.accountId ?? config.paper.accountId;
    this.holderId = opts.holderId ?? config.paper.holderId;
    const init = config.paper.initialBalance;
    this.accountState = { balance: init, available: init, equity: init, marginUsed: 0, dayStartEquity: init, realizedPnlToday: 0, dayStartTs: Date.now() };
  }

  private async request<T>(method: string, path: string, body?: unknown, isRetry = false): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Account-Id': this.accountId };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    if (this.fence !== null) {
      headers['X-Lease-Holder'] = this.holderId;
      headers['X-Lease-Fence'] = String(this.fence);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      // Auto-recover from lost/superseded lease on mutating requests.
      if (res.status === 409 && text.includes('lease_lost') && !isRetry && path !== '/account/lease') {
        this.fence = null;
        await this.acquireLease();
        return this.request<T>(method, path, body, true);
      }
      throw new Error(`HTTP ${res.status} ${method} ${path}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async acquireLease(ttlSeconds = config.paper.leaseTtlSeconds): Promise<number> {
    try {
      const data = await this.request<{ fence: number }>('POST', '/account/lease', {
        holder_id: this.holderId, holder_label: this.accountId, ttl_seconds: ttlSeconds,
      });
      this.fence = data.fence;
      this.startHeartbeatTimer();
      return data.fence;
    } catch (err: any) {
      if (String(err?.message).includes('lease_held')) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.acquireLease(ttlSeconds);
      }
      throw err;
    }
  }

  async heartbeatLease(ttlSeconds = config.paper.leaseTtlSeconds): Promise<void> {
    if (this.fence === null) {
      await this.acquireLease(ttlSeconds);
      return;
    }
    try {
      const data = await this.request<{ fence: number }>('PUT', '/account/lease', { ttl_seconds: ttlSeconds });
      if (data?.fence !== undefined) this.fence = data.fence;
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (msg.includes('lease_lost') || msg.includes('lease_required')) {
        this.fence = null;
        await this.acquireLease(ttlSeconds);
      }
    }
  }

  async releaseLease(): Promise<void> {
    this.stopHeartbeatTimer();
    if (this.fence === null) return;
    try { await this.request('DELETE', '/account/lease'); } catch {}
    this.fence = null;
  }

  private startHeartbeatTimer(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => { void this.heartbeatLease().catch(() => {}); }, 15_000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeatTimer(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async ensureLease(): Promise<void> { if (this.fence === null) await this.acquireLease(); }

  async init(): Promise<void> {
    await this.ensureLease();
    await this.sync();
    // Server exposes no day-start equity, so the breaker re-anchors at each startup.
    this.accountState.dayStartEquity = this.accountState.equity;
  }

  private rollDayIfNeeded(currentEquity: number, now = new Date()): void {
    const today = now.toISOString().slice(0, 10);
    const dayStart = new Date(this.accountState.dayStartTs).toISOString().slice(0, 10);
    if (today !== dayStart) {
      this.accountState.dayStartEquity = currentEquity;
      this.accountState.dayStartTs = Date.now();
      this.accountState.realizedPnlToday = 0;
    }
  }

  private updateCachedAccount(acc: any): void {
    const available = Number(acc.wallet?.available ?? acc.available_balance ?? acc.margin ?? 0);
    const marginUsed = Number(acc.locked_margin ?? acc.wallet?.locked ?? 0);
    const balance = new Decimal(available).plus(marginUsed).toNumber();
    const equity = Number(acc.equity ?? acc.current_equity ?? balance);
    this.rollDayIfNeeded(equity);
    this.accountState = { ...this.accountState, balance, available, equity, marginUsed, realizedPnlToday: Number(acc.realized_pnl ?? 0) };
  }

  private updateCachedPositions(posList: any[]): void {
    this.positions.clear();
    const list = Array.isArray(posList) ? posList : (posList as any)?.positions ?? [];
    for (const p of list) {
      const qty = Number(p.quantity ?? p.net_quantity ?? 0);
      if (qty <= 0) continue;
      const rawSide = String(p.side ?? 'long').toUpperCase();
      this.positions.set(p.symbol, {
        symbol: p.symbol, side: rawSide === 'BUY' || rawSide === 'LONG' ? 'LONG' : 'SHORT',
        qty, entryPrice: Number(p.entry_price ?? p.average_price ?? 0), leverage: Number(p.leverage ?? 1),
        margin: Number(p.margin_used ?? p.initial_margin ?? 0), unrealizedPnl: Number(p.unrealized_pnl ?? 0),
        liquidationPrice: p.liquidation_price ? Number(p.liquidation_price) : null,
        openedAt: p.opened_at ? new Date(p.opened_at).getTime() : Date.now(),
      });
    }
  }

  async sync(markPrices?: Record<string, number>): Promise<void> {
    try {
      const [acc, posList] = await Promise.all([
        this.request<any>('GET', '/account'),
        this.request<any[]>('GET', '/positions'),
      ]);
      this.updateCachedAccount(acc);
      this.updateCachedPositions(posList);
      if (markPrices) this.markPositions(markPrices);
    } catch (err: any) {
      if (String(err?.message).includes('Account not found')) {
        await this.resetAccount(config.paper.initialBalance);
        return;
      }
      throw err;
    }
  }

  getPositions(): PaperPosition[] { return Array.from(this.positions.values()); }

  getPosition(symbol: string): PaperPosition | null { return this.positions.get(symbol) ?? null; }

  markPositions(markPrices: Record<string, number>): (PaperPosition & { unrealizedPnl: number; liquidationPrice: number | null })[] {
    const mmr = config.paper.maintenanceMarginRate / 100;
    return this.getPositions().map((p) => {
      const mark = markPrices[p.symbol] ?? p.entryPrice;
      const unrealizedPnl = new Decimal(mark).minus(p.entryPrice).times(p.qty).times(p.side === 'LONG' ? 1 : -1).toNumber();
      const fallbackLiq = p.side === 'LONG' ? p.entryPrice * (1 - (1 / p.leverage) + mmr) : p.entryPrice * (1 + (1 / p.leverage) - mmr);
      return { ...p, unrealizedPnl, liquidationPrice: p.liquidationPrice ?? (Number.isFinite(fallbackLiq) ? fallbackLiq : null) };
    });
  }

  getAccount(markPrices: Record<string, number> = {}): AccountState {
    const marks = Object.keys(markPrices).length > 0 ? markPrices : this.snapshotPrices();
    const marked = this.markPositions(marks);
    const unrealized = marked.reduce((s, p) => new Decimal(s).plus(p.unrealizedPnl).toNumber(), 0);
    const equity = new Decimal(this.accountState.balance).plus(unrealized).toNumber();
    return { ...this.accountState, equity };
  }

  async placeMarketOrder(symbol: string, side: Side, qty: number, price: number, opts: OrderOptions = {}): Promise<FillResult> {
    if (!(qty > 0) || !Number.isFinite(qty)) throw new Error('qty must be positive');
    if (!(price > 0) || !Number.isFinite(price)) throw new Error('invalid fill price');
    await this.ensureLease();

    const leverage = Math.max(1, Math.min(opts.leverage ?? 1, config.paper.maxLeverage));
    const existing = this.getPosition(symbol);
    const isReduce = opts.reduceOnly ?? (!!existing && ((existing.side === 'LONG' && side === 'SELL') || (existing.side === 'SHORT' && side === 'BUY')));
    const clientOrderId = opts.clientOrderId ?? `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const orderRes = await this.request<any>('POST', '/orders', {
      symbol, side, quantity: qty, type: 'market', leverage,
      execution_price: price, client_order_id: clientOrderId, reduce_only: isReduce,
    });
    await this.sync();

    const notional = new Decimal(qty).times(price).toNumber();
    const fee = new Decimal(notional).times(config.paper.takerFeeBps).dividedBy(10_000).toNumber();
    const closeQty = isReduce && existing ? Math.min(qty, existing.qty) : 0;
    const dir = existing?.side === 'LONG' ? 1 : -1;
    const estimatedPnl = isReduce && existing
      ? new Decimal(price).minus(existing.entryPrice).times(closeQty).times(dir).minus(fee).toNumber()
      : 0;
    const fill: FillResult = {
      id: String(orderRes.id ?? clientOrderId), symbol, side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT',
      type: 'MARKET', qty, price, notional, fee, realizedPnl: Number(orderRes.realized_pnl ?? estimatedPnl),
      reduceOnly: isReduce, status: 'FILLED', timestamp: Date.now(), reason: (opts.reason ?? 'agent').slice(0, 500),
      position: this.getPosition(symbol), equity: this.accountState.equity, available: this.accountState.available,
    };
    this.recentOrders.unshift(fill);
    if (this.recentOrders.length > 100) this.recentOrders.pop();
    return fill;
  }

  async pushMarkPrices(prices: Record<string, number>): Promise<void> {
    if (Object.keys(prices).length === 0) return;
    await this.ensureLease();
    await this.request('POST', '/mark-prices', { prices });
    await this.sync(prices);
  }

  async settleFunding(symbol: string, rate: number, markPrice: number): Promise<number> {
    const pos = this.getPosition(symbol);
    if (!pos || rate === 0) return 0;
    await this.ensureLease();
    await this.request('POST', '/funding_events?sync=true', {
      symbol, funding_rate: rate, mark_price: markPrice, funding_time: new Date().toISOString(),
    });
    await this.sync();
    const dir = pos.side === 'LONG' ? 1 : -1;
    return new Decimal(-rate).times(pos.qty).times(markPrice).times(dir).toNumber();
  }

  async checkLiquidations(markPrices: Record<string, number>): Promise<{ symbol: string; realizedPnl: number }[]> {
    const out: { symbol: string; realizedPnl: number }[] = [];
    for (const p of this.markPositions(markPrices)) {
      const mark = markPrices[p.symbol];
      if (p.liquidationPrice === null || mark === undefined) continue;
      const hit = p.side === 'LONG' ? mark <= p.liquidationPrice : mark >= p.liquidationPrice;
      if (hit) {
        const res = await this.placeMarketOrder(p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, p.liquidationPrice, { reason: 'LIQUIDATION', reduceOnly: true });
        out.push({ symbol: p.symbol, realizedPnl: res.realizedPnl });
      }
    }
    await this.pushMarkPrices(markPrices);
    return out;
  }

  async resetAccount(margin = config.paper.initialBalance): Promise<void> {
    await this.ensureLease();
    await this.request('POST', '/account/reset', { margin });
    this.positions.clear();
    this.recentOrders = [];
    this.equityCurve = [];
    await this.sync();
  }

  getRecentOrders(limit = 20): PaperOrder[] { return this.recentOrders.slice(0, limit); }

  getEquityCurve(limit = 500): { ts: number; equity: number }[] { return this.equityCurve.slice(-limit); }

  recordEquity(markPrices: Record<string, number>): void {
    const { equity } = this.getAccount(markPrices);
    this.equityCurve.push({ ts: Date.now(), equity });
  }

  setPriceProvider(fn: () => Record<string, number>): void { this.priceProvider = fn; }

  private snapshotPrices(): Record<string, number> { return this.priceProvider ? this.priceProvider() : {}; }

  async close(): Promise<void> { await this.releaseLease(); }
}
