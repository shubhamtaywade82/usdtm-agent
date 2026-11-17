/**
 * RiskManager — the hard risk layer. The LLM proposes; this layer disposes.
 * Every order passes through `checkOrder` and can be rejected regardless of
 * what the agent wants. Circuit breakers trip a trading halt that requires
 * explicit human ack (CLI flag) to clear.
 */
import { config } from './config.js';
import type { PaperExchange } from './paper-exchange.js';
import type { PositionSide, Side } from './types.js';

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  leverage?: number;
  stopDistancePct?: number | null;
  reason?: string;
}

export interface RiskCheckResult {
  approved: boolean;
  reason: string;
  /** Adjusted qty if the original was only marginally too big. */
  adjustedQty?: number;
  checks: { name: string; pass: boolean; detail: string }[];
}

interface DoomEntry { key: string; at: number; }

export class RiskManager {
  private halted = false;
  private haltReason = '';
  private haltSince = 0;
  private recentOrders: DoomEntry[] = [];
  private ordersLastMinute: { at: number }[] = [];

  constructor(private paper: PaperExchange) {}

  /** Trading halted? (daily loss limit, doom-loop, manual halt) */
  isHalted(): { halted: boolean; reason: string; since: number } {
    this.refreshDailyLoss();
    return { halted: this.halted, reason: this.haltReason, since: this.haltSince };
  }

  /** Manual halt / resume (resume requires ack=true — a deliberate act). */
  setHalt(on: boolean, reason: string, ack = false): void {
    if (on) {
      this.halted = true;
      this.haltReason = reason;
      this.haltSince = Date.now();
    } else if (ack) {
      this.halted = false;
      this.haltReason = '';
    }
  }

  private refreshDailyLoss(): void {
    const acc = this.paper.getAccount();
    const dayPnl = acc.equity - acc.dayStartEquity;
    const limitPct = config.paper.dailyLossLimitPct / 100;
    if (!this.halted && acc.dayStartEquity > 0 && dayPnl / acc.dayStartEquity <= -limitPct) {
      this.halted = true;
      this.haltReason = `daily loss limit hit: ${((dayPnl / acc.dayStartEquity) * 100).toFixed(2)}% <= -${config.paper.dailyLossLimitPct}%`;
      this.haltSince = Date.now();
    }
  }

  /** Doom-loop detection: same (symbol, side, qty) repeatedly within 10 min. */
  private checkDoomLoop(req: OrderRequest): boolean {
    const key = `${req.symbol}:${req.side}:${req.qty.toFixed(8)}:${req.leverage ?? 1}`;
    const now = Date.now();
    this.recentOrders = this.recentOrders.filter((e) => now - e.at < 10 * 60_000);
    const identical = this.recentOrders.filter((e) => e.key === key).length;
    this.recentOrders.push({ key, at: now });
    return identical >= 3; // 4th identical order within 10 minutes
  }

  private rateLimitOrders(): boolean {
    const now = Date.now();
    this.ordersLastMinute = this.ordersLastMinute.filter((o) => now - o.at < 60_000);
    this.ordersLastMinute.push({ at: now });
    return this.ordersLastMinute.length > 20;
  }

  checkOrder(req: OrderRequest, markPrices: Record<string, number>): RiskCheckResult {
    const checks: { name: string; pass: boolean; detail: string }[] = [];
    const fail = (reason: string): RiskCheckResult => ({ approved: false, reason, checks });
    const pass = (): RiskCheckResult => ({ approved: true, reason: 'approved', checks });

    const acc = this.paper.getAccount(markPrices);
    const positions = this.paper.markPositions(markPrices);
    const notional = req.qty * req.price;

    // 1. Trading halt
    this.refreshDailyLoss();
    const c1 = !this.halted;
    checks.push({ name: 'trading_halt', pass: c1, detail: this.halted ? this.haltReason : 'ok' });

    // 2. Symbol in universe
    const c2 = config.symbols.includes(req.symbol);
    checks.push({ name: 'symbol_universe', pass: c2, detail: c2 ? 'ok' : `${req.symbol} not in configured universe` });

    // 3. Quantity / price sanity
    const c3 = req.qty > 0 && req.price > 0 && Number.isFinite(req.qty) && Number.isFinite(req.price);
    checks.push({ name: 'sanity', pass: c3, detail: c3 ? 'ok' : 'qty/price not positive finite' });

    // 4. Leverage cap
    const lev = Math.min(req.leverage ?? 1, config.paper.maxLeverage);
    const c4 = (req.leverage ?? 1) <= config.paper.maxLeverage;
    checks.push({ name: 'leverage_cap', pass: c4, detail: `requested ${req.leverage ?? 1}x, cap ${config.paper.maxLeverage}x` });

    // 5. Per-position notional cap (% of equity)
    const sameSym = positions.find((p) => p.symbol === req.symbol);
    const increasingExisting = !!sameSym && sameSym.side === (req.side === 'BUY' ? 'LONG' : 'SHORT');
    const projectedNotional = increasingExisting ? sameSym.qty * markPrices[sameSym.symbol] + notional : notional;
    const posCap = acc.equity * (config.paper.maxPositionNotionalPct / 100);
    const c5 = projectedNotional <= posCap;
    checks.push({ name: 'position_notional_cap', pass: c5, detail: `projected $${projectedNotional.toFixed(0)} vs cap $${posCap.toFixed(0)}` });

    // 6. Portfolio notional cap
    const totalProjected = positions.reduce((s, p) => s + (markPrices[p.symbol] ?? p.entryPrice) * p.qty, 0) + (increasingExisting ? notional : 0);
    const portCap = acc.equity * (config.paper.maxPortfolioNotionalPct / 100);
    const c6 = totalProjected <= portCap;
    checks.push({ name: 'portfolio_notional_cap', pass: c6, detail: `projected $${totalProjected.toFixed(0)} vs cap $${portCap.toFixed(0)}` });

    // 7. Margin availability (incl. fee)
    const fee = notional * (config.paper.takerFeeBps / 10_000);
    const required = notional / lev + fee;
    const c7 = required <= acc.available;
    checks.push({ name: 'margin_available', pass: c7, detail: `need $${required.toFixed(2)}, available $${acc.available.toFixed(2)}` });

    // 8. Per-trade risk cap (if stop distance given)
    let c8 = true;
    let c8detail = 'no stop distance given (opening without stop — allowed but discouraged)';
    const isReduce = !!sameSym && sameSym.side !== (req.side === 'BUY' ? 'LONG' : 'SHORT');
    if (!isReduce && req.stopDistancePct != null && req.stopDistancePct > 0) {
      const riskUsd = notional * (req.stopDistancePct / 100);
      const riskCap = acc.equity * (config.paper.maxRiskPerTradePct / 100);
      c8 = riskUsd <= riskCap * 1.05; // 5% tolerance
      c8detail = `risk $${riskUsd.toFixed(2)} vs cap $${riskCap.toFixed(2)}`;
    }
    checks.push({ name: 'per_trade_risk_cap', pass: c8, detail: c8detail });

    // 9. Doom-loop
    const c9 = !this.checkDoomLoop(req);
    checks.push({ name: 'doom_loop', pass: c9, detail: c9 ? 'ok' : 'identical order repeated ≥3× in 10min' });

    // 10. Order rate limit
    const c10 = !this.rateLimitOrders();
    checks.push({ name: 'order_rate_limit', pass: c10, detail: c10 ? 'ok' : '>20 orders/min' });

    const allPass = checks.every((c) => c.pass);
    if (!allPass) {
      const failed = checks.filter((c) => !c.pass).map((c) => `${c.name}(${c.detail})`).join('; ');
      return fail(`RISK REJECTED: ${failed}`);
    }
    return pass();
  }

  /** Suggest a maximum qty for an opening order given current equity and caps. */
  maxQtyFor(symbol: string, price: number, leverage: number, markPrices: Record<string, number>): number {
    const acc = this.paper.getAccount(markPrices);
    const posCap = acc.equity * (config.paper.maxPositionNotionalPct / 100);
    const marginCap = acc.available / (1 / Math.min(leverage, config.paper.maxLeverage) + config.paper.takerFeeBps / 10_000);
    return Math.max(0, Math.min(posCap, marginCap)) / price;
  }
}
