/**
 * PaperExchange — USDT-M perpetual futures paper engine.
 *
 * One-way position mode (LONG/SHORT per symbol), leverage, isolated-style
 * margin accounting, taker/maker fees, funding settlement, mark-price based
 * liquidation, and full SQLite persistence. All fills happen at the live
 * WS price (book ticker mid), which is more realistic than REST polling.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { PaperOrder, PaperPosition, PositionSide, Side } from './types.js';

export interface AccountState {
  balance: number;            // wallet balance (USDT)
  available: number;          // balance - used margin
  equity: number;             // balance + unrealized PnL
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

export class PaperExchange {
  private db: Database.Database;

  constructor(dbPath = config.paper.dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        balance REAL NOT NULL,
        day_start_equity REAL NOT NULL,
        realized_pnl_today REAL NOT NULL DEFAULT 0,
        day_start_ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        symbol TEXT PRIMARY KEY,
        side TEXT NOT NULL,
        qty REAL NOT NULL,
        entry_price REAL NOT NULL,
        leverage REAL NOT NULL,
        margin REAL NOT NULL,
        opened_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        position_side TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'MARKET',
        qty REAL NOT NULL,
        price REAL NOT NULL,
        notional REAL NOT NULL,
        fee REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        reduce_only INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS funding_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        amount REAL NOT NULL,
        rate REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS equity_curve (
        ts INTEGER PRIMARY KEY,
        equity REAL NOT NULL
      );
    `);
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
      symbol: r.symbol,
      side: r.side as PositionSide,
      qty: r.qty,
      entryPrice: r.entry_price,
      leverage: r.leverage,
      margin: r.margin,
      unrealizedPnl: 0,
      liquidationPrice: null,
      openedAt: r.opened_at,
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

  /** Mark positions with live prices, returning enriched positions. */
  markPositions(markPrices: Record<string, number>): (PaperPosition & { unrealizedPnl: number; liquidationPrice: number | null })[] {
    return this.getPositions().map((p) => {
      const mark = markPrices[p.symbol] ?? p.entryPrice;
      const dir = p.side === 'LONG' ? 1 : -1;
      const unrealizedPnl = (mark - p.entryPrice) * p.qty * dir;
      const mmr = config.paper.maintenanceMarginRate / 100;
      const liqDistance = p.entryPrice * (mmr - 1 / p.leverage) * -dir;
      const liquidationPrice = p.side === 'LONG'
        ? p.entryPrice * (1 - (1 / p.leverage) + mmr)
        : p.entryPrice * (1 + (1 / p.leverage) - mmr);
      return { ...p, unrealizedPnl, liquidationPrice: Number.isFinite(liquidationPrice) ? liquidationPrice : null };
    });
  }

  getAccount(markPrices: Record<string, number> = {}): AccountState {
    const r = this.db.prepare('SELECT * FROM account WHERE id = 1').get() as any;
    const positions = this.markPositions(markPrices);
    const unrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const marginUsed = positions.reduce((s, p) => s + p.margin, 0);
    return {
      balance: r.balance,
      available: Math.max(0, r.balance - marginUsed),
      equity: r.balance + unrealized,
      marginUsed,
      dayStartEquity: r.day_start_equity,
      realizedPnlToday: r.realized_pnl_today,
      dayStartTs: r.day_start_ts,
    };
  }

  /**
   * Place a MARKET order. `price` is the live fill price (WS book-ticker mid
   * or ask/bid depending on side). `reason` is the agent's stated rationale,
   * persisted with the order for auditability.
   */
  placeMarketOrder(
    symbol: string,
    side: Side,
    qty: number,
    price: number,
    opts: { leverage?: number; reason?: string } = {}
  ): FillResult {
    if (!(qty > 0) || !Number.isFinite(qty)) throw new Error('qty must be positive');
    if (!(price > 0) || !Number.isFinite(price)) throw new Error('invalid fill price');

    const leverage = Math.max(1, Math.min(opts.leverage ?? 1, config.paper.maxLeverage));
    const notional = qty * price;
    const feeRate = config.paper.takerFeeBps / 10_000;
    const fee = notional * feeRate;
    const reason = (opts.reason ?? 'agent').slice(0, 500);
    const existing = this.getPosition(symbol);
    const id = `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const reduceOnly = !!existing && (
      (existing.side === 'LONG' && side === 'SELL') || (existing.side === 'SHORT' && side === 'BUY')
    );

    let realizedPnl = 0;
    const tx = this.db.transaction(() => {
      const acc = this.getAccount();
      if (reduceOnly) {
        // Closing (fully or partially).
        const closeQty = Math.min(qty, existing.qty);
        const dir = existing.side === 'LONG' ? 1 : -1;
        realizedPnl = (price - existing.entryPrice) * closeQty * dir - fee;
        const releasedMargin = existing.margin * (closeQty / existing.qty);
        const remainingQty = existing.qty - closeQty;

        if (remainingQty <= 1e-12) {
          this.db.prepare('DELETE FROM positions WHERE symbol = ?').run(symbol);
        } else {
          this.db.prepare('UPDATE positions SET qty = ?, margin = ? WHERE symbol = ?')
            .run(remainingQty, existing.margin - releasedMargin, symbol);
        }
        this.db.prepare(
          'UPDATE account SET balance = balance + ?, realized_pnl_today = realized_pnl_today + ? WHERE id = 1'
        ).run(realizedPnl, realizedPnl);
      } else if (existing && existing.side === (side === 'BUY' ? 'LONG' : 'SHORT')) {
        // Increasing an existing position.
        const requiredMargin = notional / leverage;
        if (requiredMargin + fee > acc.available) {
          throw new Error(`insufficient available margin: need ${(requiredMargin + fee).toFixed(2)}, have ${acc.available.toFixed(2)}`);
        }
        const newQty = existing.qty + qty;
        const newEntry = (existing.entryPrice * existing.qty + price * qty) / newQty;
        const newMargin = existing.margin + requiredMargin;
        const newLeverage = newQty * newEntry / newMargin;
        this.db.prepare('UPDATE positions SET qty = ?, entry_price = ?, leverage = ?, margin = ? WHERE symbol = ?')
          .run(newQty, newEntry, newLeverage, newMargin, symbol);
        this.db.prepare('UPDATE account SET balance = balance - ? WHERE id = 1').run(fee);
      } else {
        // New position.
        const requiredMargin = notional / leverage;
        if (requiredMargin + fee > acc.available) {
          throw new Error(`insufficient available margin: need ${(requiredMargin + fee).toFixed(2)}, have ${acc.available.toFixed(2)}`);
        }
        this.db.prepare(
          'INSERT INTO positions (symbol, side, qty, entry_price, leverage, margin, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(symbol, side === 'BUY' ? 'LONG' : 'SHORT', qty, price, leverage, requiredMargin, Date.now());
        this.db.prepare('UPDATE account SET balance = balance - ? WHERE id = 1').run(fee);
      }

      this.db.prepare(
        `INSERT INTO orders (id, symbol, side, position_side, type, qty, price, notional, fee, realized_pnl, reduce_only, status, reason, timestamp)
         VALUES (?, ?, ?, ?, 'MARKET', ?, ?, ?, ?, ?, ?, 'FILLED', ?, ?)`
      ).run(id, symbol, side, side === 'BUY' ? 'LONG' : 'SHORT', qty, price, notional, fee, realizedPnl, reduceOnly ? 1 : 0, reason, Date.now());
    });
    tx();
    this.rollDayIfNeeded();

    const positions = this.markPositions(this.snapshotPrices());
    return {
      id, symbol, side,
      positionSide: side === 'BUY' ? 'LONG' : 'SHORT',
      type: 'MARKET', qty, price, notional, fee, realizedPnl, reduceOnly,
      status: 'FILLED', timestamp: Date.now(), reason,
      position: positions.find((p) => p.symbol === symbol) ?? null,
      ...this.getAccount(this.snapshotPrices()),
    };
  }

  /** Funding settlement: pay/receive rate × notional per 8h per position. */
  settleFunding(symbol: string, rate: number, markPrice: number): number {
    const p = this.getPosition(symbol);
    if (!p || rate === 0) return 0;
    // LONG pays positive funding, SHORT receives it.
    const amount = -rate * p.qty * markPrice * (p.side === 'LONG' ? 1 : -1);
    this.db.prepare('UPDATE account SET balance = balance + ? WHERE id = 1').run(amount);
    this.db.prepare('INSERT INTO funding_payments (symbol, amount, rate, timestamp) VALUES (?, ?, ?, ?)')
      .run(symbol, amount, rate, Date.now());
    return amount;
  }

  /** Check liquidation: if mark crosses the est. liq price, close at that price. */
  checkLiquidations(markPrices: Record<string, number>): { symbol: string; realizedPnl: number }[] {
    const out: { symbol: string; realizedPnl: number }[] = [];
    for (const p of this.markPositions(markPrices)) {
      if (p.liquidationPrice === null) continue;
      const hit = p.side === 'LONG' ? markPrices[p.symbol] <= p.liquidationPrice : markPrices[p.symbol] >= p.liquidationPrice;
      if (hit && markPrices[p.symbol] !== undefined) {
        const liqPrice = p.liquidationPrice;
        const res = this.placeMarketOrder(p.symbol, p.side === 'LONG' ? 'SELL' : 'BUY', p.qty, liqPrice, {
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

  /** Live-price snapshot injected by the runner (WS) for internal calls. */
  private priceProvider: (() => Record<string, number>) | null = null;
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
