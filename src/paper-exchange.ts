/**
 * PaperExchange — USDT-M perpetual futures paper engine with Decimal precision,
 * SQLite persistence, and idempotent order execution.
 */
import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { PaperOrder, PaperPosition, PositionSide, Side } from './types.js';

export interface AccountState {
  balance: number;
  available: number;
  equity: number;
  marginUsed: number;
  dayStartEquity: number;
  realizedPnlToday: number;
  dayStartTs: number;
}

export interface FillResult extends PaperOrder {
  position: PaperPosition | null;
  equity: number;
  available: number;
}

export interface OrderOptions {
  leverage?: number;
  reason?: string;
  clientOrderId?: string;
}

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK (id = 1), balance REAL NOT NULL, day_start_equity REAL NOT NULL, realized_pnl_today REAL NOT NULL DEFAULT 0, day_start_ts INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS positions (symbol TEXT PRIMARY KEY, side TEXT NOT NULL, qty REAL NOT NULL, entry_price REAL NOT NULL, leverage REAL NOT NULL, margin REAL NOT NULL, opened_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, position_side TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'MARKET', qty REAL NOT NULL, price REAL NOT NULL, notional REAL NOT NULL, fee REAL NOT NULL, realized_pnl REAL NOT NULL, reduce_only INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, timestamp INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS funding_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, amount REAL NOT NULL, rate REAL NOT NULL, timestamp INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS equity_curve (ts INTEGER PRIMARY KEY, equity REAL NOT NULL);
`;

export class PaperExchange {
  private db: Database.Database;
  private priceProvider: (() => Record<string, number>) | null = null;

  constructor(dbPath = config.paper.dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_DDL);
    const row = this.db.prepare('SELECT balance FROM account WHERE id = 1').get() as { balance: number } | undefined;
    if (!row) {
      this.db.prepare(
        'INSERT INTO account (id, balance, day_start_equity, realized_pnl_today, day_start_ts) VALUES (1, ?, ?, 0, ?)'
      ).run(config.paper.initialBalance, config.paper.initialBalance, Date.now());
    }
  }

  private rollDayIfNeeded(now = new Date()): void {
    const acc = this.getAccount();
    const today = now.toISOString().slice(0, 10);
    const accDay = new Date(acc.dayStartTs).toISOString().slice(0, 10);
    if (today !== accDay) {
      this.db.prepare(
        'UPDATE account SET day_start_equity = ?, realized_pnl_today = 0, day_start_ts = ? WHERE id = 1'
      ).run(acc.equity, Date.now());
    }
  }

  getPositions(): PaperPosition[] {
    return (this.db.prepare('SELECT * FROM positions').all() as any[]).map((r) => ({
      symbol: r.symbol, side: r.side as PositionSide, qty: r.qty, entryPrice: r.entry_price,
      leverage: r.leverage, margin: r.margin, unrealizedPnl: 0, liquidationPrice: null, openedAt: r.opened_at,
    }));
  }

  getPosition(symbol: string): PaperPosition | null {
    const r = this.db.prepare('SELECT * FROM positions WHERE symbol = ?').get(symbol) as any;
    if (!r) return null;
    return {
      symbol: r.symbol, side: r.side, qty: r.qty, entryPrice: r.entry_price,
      leverage: r.leverage, margin: r.margin, unrealizedPnl: 0, liquidationPrice: null, openedAt: r.opened_at,
    };
  }

  markPositions(markPrices: Record<string, number>): (PaperPosition & { unrealizedPnl: number; liquidationPrice: number | null })[] {
    return this.getPositions().map((p) => {
      const mark = markPrices[p.symbol] ?? p.entryPrice;
      const dir = p.side === 'LONG' ? 1 : -1;
      const unrealizedPnl = new Decimal(mark).minus(p.entryPrice).times(p.qty).times(dir).toNumber();
      const mmr = config.paper.maintenanceMarginRate / 100;
      const liqPrice = p.side === 'LONG'
        ? p.entryPrice * (1 - (1 / p.leverage) + mmr)
        : p.entryPrice * (1 + (1 / p.leverage) - mmr);
      return { ...p, unrealizedPnl, liquidationPrice: Number.isFinite(liqPrice) ? liqPrice : null };
    });
  }

  getAccount(markPrices: Record<string, number> = {}): AccountState {
    const r = this.db.prepare('SELECT * FROM account WHERE id = 1').get() as any;
    const positions = this.markPositions(markPrices);
    const unrealized = positions.reduce((s, p) => new Decimal(s).plus(p.unrealizedPnl).toNumber(), 0);
    const marginUsed = positions.reduce((s, p) => new Decimal(s).plus(p.margin).toNumber(), 0);
    return {
      balance: r.balance,
      available: Math.max(0, new Decimal(r.balance).minus(marginUsed).toNumber()),
      equity: new Decimal(r.balance).plus(unrealized).toNumber(),
      marginUsed,
      dayStartEquity: r.day_start_equity,
      realizedPnlToday: r.realized_pnl_today,
      dayStartTs: r.day_start_ts,
    };
  }

  private executeReduce(symbol: string, existing: PaperPosition, qty: Decimal, price: Decimal, fee: Decimal): Decimal {
    const closeQty = Decimal.min(qty, existing.qty);
    const dir = existing.side === 'LONG' ? 1 : -1;
    const realizedPnl = price.minus(existing.entryPrice).times(closeQty).times(dir).minus(fee);
    const releasedMargin = new Decimal(existing.margin).times(closeQty.dividedBy(existing.qty));
    const remainingQty = new Decimal(existing.qty).minus(closeQty);

    if (remainingQty.lessThanOrEqualTo(1e-12)) {
      this.db.prepare('DELETE FROM positions WHERE symbol = ?').run(symbol);
    } else {
      this.db.prepare('UPDATE positions SET qty = ?, margin = ? WHERE symbol = ?')
        .run(remainingQty.toNumber(), new Decimal(existing.margin).minus(releasedMargin).toNumber(), symbol);
    }
    this.db.prepare(
      'UPDATE account SET balance = balance + ?, realized_pnl_today = realized_pnl_today + ? WHERE id = 1'
    ).run(realizedPnl.toNumber(), realizedPnl.toNumber());
    return realizedPnl;
  }

  private executeIncrease(symbol: string, existing: PaperPosition, qty: Decimal, price: Decimal, leverage: number, fee: Decimal, available: number): void {
    const notional = qty.times(price);
    const requiredMargin = notional.dividedBy(leverage);
    if (requiredMargin.plus(fee).toNumber() > available) {
      throw new Error(`insufficient available margin: need ${requiredMargin.plus(fee).toFixed(2)}, have ${available.toFixed(2)}`);
    }
    const newQty = new Decimal(existing.qty).plus(qty);
    const newEntry = new Decimal(existing.entryPrice).times(existing.qty).plus(notional).dividedBy(newQty);
    const newMargin = new Decimal(existing.margin).plus(requiredMargin);
    const newLeverage = newQty.times(newEntry).dividedBy(newMargin);
    this.db.prepare('UPDATE positions SET qty = ?, entry_price = ?, leverage = ?, margin = ? WHERE symbol = ?')
      .run(newQty.toNumber(), newEntry.toNumber(), newLeverage.toNumber(), newMargin.toNumber(), symbol);
    this.db.prepare('UPDATE account SET balance = balance - ? WHERE id = 1').run(fee.toNumber());
  }

  private executeOpen(symbol: string, side: Side, qty: Decimal, price: Decimal, leverage: number, fee: Decimal, available: number): void {
    const notional = qty.times(price);
    const requiredMargin = notional.dividedBy(leverage);
    if (requiredMargin.plus(fee).toNumber() > available) {
      throw new Error(`insufficient available margin: need ${requiredMargin.plus(fee).toFixed(2)}, have ${available.toFixed(2)}`);
    }
    this.db.prepare(
      'INSERT INTO positions (symbol, side, qty, entry_price, leverage, margin, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(symbol, side === 'BUY' ? 'LONG' : 'SHORT', qty.toNumber(), price.toNumber(), leverage, requiredMargin.toNumber(), Date.now());
    this.db.prepare('UPDATE account SET balance = balance - ? WHERE id = 1').run(fee.toNumber());
  }

  private getExistingOrderFill(orderId: string): FillResult | null {
    const r = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as any;
    if (!r) return null;
    const marks = this.snapshotPrices();
    const positions = this.markPositions(marks);
    const acc = this.getAccount(marks);
    return {
      id: r.id, symbol: r.symbol, side: r.side, positionSide: r.position_side,
      type: r.type, qty: r.qty, price: r.price, notional: r.notional, fee: r.fee,
      realizedPnl: r.realized_pnl, reduceOnly: !!r.reduce_only, status: r.status,
      timestamp: r.timestamp, reason: r.reason,
      position: positions.find((p) => p.symbol === r.symbol) ?? null,
      ...acc,
    };
  }

  private recordOrder(order: PaperOrder): void {
    this.db.prepare(
      `INSERT INTO orders (id, symbol, side, position_side, type, qty, price, notional, fee, realized_pnl, reduce_only, status, reason, timestamp)
       VALUES (?, ?, ?, ?, 'MARKET', ?, ?, ?, ?, ?, ?, 'FILLED', ?, ?)`
    ).run(order.id, order.symbol, order.side, order.positionSide, order.qty, order.price, order.notional, order.fee, order.realizedPnl, order.reduceOnly ? 1 : 0, order.reason, order.timestamp);
  }

  placeMarketOrder(symbol: string, side: Side, qty: number, price: number, opts: OrderOptions = {}): FillResult {
    if (!(qty > 0) || !Number.isFinite(qty)) throw new Error('qty must be positive');
    if (!(price > 0) || !Number.isFinite(price)) throw new Error('invalid fill price');

    const id = opts.clientOrderId ?? `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const existingOrder = this.getExistingOrderFill(id);
    if (existingOrder) return existingOrder;

    const leverage = Math.max(1, Math.min(opts.leverage ?? 1, config.paper.maxLeverage));
    const dQty = new Decimal(qty);
    const dPrice = new Decimal(price);
    const dNotional = dQty.times(dPrice);
    const dFee = dNotional.times(new Decimal(config.paper.takerFeeBps).dividedBy(10_000));
    const existing = this.getPosition(symbol);
    const reduceOnly = !!existing && ((existing.side === 'LONG' && side === 'SELL') || (existing.side === 'SHORT' && side === 'BUY'));

    let realizedPnl = new Decimal(0);
    this.db.transaction(() => {
      const acc = this.getAccount();
      if (reduceOnly && existing) {
        realizedPnl = this.executeReduce(symbol, existing, dQty, dPrice, dFee);
      } else if (existing && existing.side === (side === 'BUY' ? 'LONG' : 'SHORT')) {
        this.executeIncrease(symbol, existing, dQty, dPrice, leverage, dFee, acc.available);
      } else {
        this.executeOpen(symbol, side, dQty, dPrice, leverage, dFee, acc.available);
      }
      this.recordOrder({
        id, symbol, side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT', type: 'MARKET',
        qty: dQty.toNumber(), price: dPrice.toNumber(), notional: dNotional.toNumber(),
        fee: dFee.toNumber(), realizedPnl: realizedPnl.toNumber(), reduceOnly,
        status: 'FILLED', timestamp: Date.now(), reason: (opts.reason ?? 'agent').slice(0, 500),
      });
    })();
    this.rollDayIfNeeded();
    return this.getExistingOrderFill(id)!;
  }

  settleFunding(symbol: string, rate: number, markPrice: number): number {
    const p = this.getPosition(symbol);
    if (!p || rate === 0) return 0;
    const dir = p.side === 'LONG' ? 1 : -1;
    const amount = new Decimal(-rate).times(p.qty).times(markPrice).times(dir).toNumber();
    this.db.prepare('UPDATE account SET balance = balance + ? WHERE id = 1').run(amount);
    this.db.prepare('INSERT INTO funding_payments (symbol, amount, rate, timestamp) VALUES (?, ?, ?, ?)').run(symbol, amount, rate, Date.now());
    return amount;
  }

  checkLiquidations(markPrices: Record<string, number>): { symbol: string; realizedPnl: number }[] {
    const out: { symbol: string; realizedPnl: number }[] = [];
    for (const p of this.markPositions(markPrices)) {
      const mark = markPrices[p.symbol];
      if (p.liquidationPrice === null || mark === undefined) continue;
      const hit = p.side === 'LONG' ? mark <= p.liquidationPrice : mark >= p.liquidationPrice;
      if (hit) {
        const res = this.placeMarketOrder(p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, p.liquidationPrice, {
          reason: 'LIQUIDATION (mark crossed estimated liquidation price)',
        });
        out.push({ symbol: p.symbol, realizedPnl: res.realizedPnl });
      }
    }
    return out;
  }

  recordEquity(markPrices: Record<string, number>): void {
    const { equity } = this.getAccount(markPrices);
    this.db.prepare('INSERT OR REPLACE INTO equity_curve (ts, equity) VALUES (?, ?)').run(Date.now(), equity);
  }

  getRecentOrders(limit = 20): PaperOrder[] {
    return (this.db.prepare('SELECT * FROM orders ORDER BY timestamp DESC LIMIT ?').all(limit) as any[]).map((r) => ({
      id: r.id, symbol: r.symbol, side: r.side, positionSide: r.position_side, type: r.type,
      qty: r.qty, price: r.price, notional: r.notional, fee: r.fee, realizedPnl: r.realized_pnl,
      reduceOnly: !!r.reduce_only, status: r.status, reason: r.reason, timestamp: r.timestamp,
    }));
  }

  getEquityCurve(limit = 500): { ts: number; equity: number }[] {
    return this.db.prepare('SELECT ts, equity FROM equity_curve ORDER BY ts DESC LIMIT ?').all(limit).reverse() as any;
  }

  setPriceProvider(fn: () => Record<string, number>): void {
    this.priceProvider = fn;
  }

  private snapshotPrices(): Record<string, number> {
    return this.priceProvider ? this.priceProvider() : {};
  }

  close(): void {
    this.db.close();
  }
}
