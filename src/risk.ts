/**
 * RiskManager — the hard risk layer. Proposes guardrails and order rejections
 * before execution on PaperExchange.
 */
import { Decimal } from 'decimal.js';
import { config } from './config.js';
import type { PaperExchange } from './paper-exchange.js';
import type { PaperPosition, Side } from './types.js';

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
  adjustedQty?: number;
  checks: { name: string; pass: boolean; detail: string }[];
}

interface DoomEntry { key: string; at: number; }

// Oversized opposite-side orders would flip the position, so they get full entry checks.
// Tolerance covers the model seeing qty rounded to 4 decimals in get_portfolio.
const QTY_ROUNDING_TOLERANCE = 1e-4;
const isReducing = (req: OrderRequest, sameSym?: PaperPosition): boolean =>
  !!sameSym && sameSym.side !== (req.side === 'BUY' ? 'LONG' : 'SHORT') && req.qty <= sameSym.qty + QTY_ROUNDING_TOLERANCE;

export class RiskManager {
  private halted = false;
  private haltReason = '';
  private haltSince = 0;
  private recentOrders: DoomEntry[] = [];
  private ordersLastMinute: { at: number }[] = [];

  constructor(private paper: PaperExchange) {}

  isHalted(): { halted: boolean; reason: string; since: number } {
    this.refreshDailyLoss();
    return { halted: this.halted, reason: this.haltReason, since: this.haltSince };
  }

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
    const dayPnl = new Decimal(acc.equity).minus(acc.dayStartEquity).toNumber();
    const limitPct = config.paper.dailyLossLimitPct / 100;
    if (!this.halted && acc.dayStartEquity > 0 && dayPnl / acc.dayStartEquity <= -limitPct) {
      this.halted = true;
      this.haltReason = `daily loss limit hit: ${((dayPnl / acc.dayStartEquity) * 100).toFixed(2)}% <= -${config.paper.dailyLossLimitPct}%`;
      this.haltSince = Date.now();
    }
  }

  private checkDoomLoop(req: OrderRequest): boolean {
    const key = `${req.symbol}:${req.side}:${req.qty.toFixed(8)}:${req.leverage ?? 1}`;
    const now = Date.now();
    this.recentOrders = this.recentOrders.filter((e) => now - e.at < 10 * 60_000);
    const identical = this.recentOrders.filter((e) => e.key === key).length;
    this.recentOrders.push({ key, at: now });
    return identical >= 3;
  }

  private rateLimitOrders(): boolean {
    const now = Date.now();
    this.ordersLastMinute = this.ordersLastMinute.filter((o) => now - o.at < 60_000);
    this.ordersLastMinute.push({ at: now });
    return this.ordersLastMinute.length > 20;
  }

  private checkBasicSanity(req: OrderRequest, checks: RiskCheckResult['checks']): void {
    this.refreshDailyLoss();
    checks.push({ name: 'trading_halt', pass: !this.halted, detail: this.halted ? this.haltReason : 'ok' });
    const inUniverse = config.symbols.includes(req.symbol);
    checks.push({ name: 'symbol_universe', pass: inUniverse, detail: inUniverse ? 'ok' : `${req.symbol} not in configured universe` });
    const finite = req.qty > 0 && req.price > 0 && Number.isFinite(req.qty) && Number.isFinite(req.price);
    checks.push({ name: 'sanity', pass: finite, detail: finite ? 'ok' : 'qty/price not positive finite' });
    const levPass = (req.leverage ?? 1) <= config.paper.maxLeverage;
    checks.push({ name: 'leverage_cap', pass: levPass, detail: `requested ${req.leverage ?? 1}x, cap ${config.paper.maxLeverage}x` });
  }

  private checkNotionalCaps(
    ctx: { req: OrderRequest; notional: number; acc: { equity: number }; positions: PaperPosition[]; markPrices: Record<string, number> },
    checks: RiskCheckResult['checks']
  ): void {
    const { req, notional, acc, positions, markPrices } = ctx;
    const sameSym = positions.find((p) => p.symbol === req.symbol);
    const increasingExisting = !!sameSym && sameSym.side === (req.side === 'BUY' ? 'LONG' : 'SHORT');
    const projectedNotional = increasingExisting ? sameSym.qty * (markPrices[sameSym.symbol] ?? sameSym.entryPrice) + notional : notional;
    const posCap = acc.equity * (config.paper.maxPositionNotionalPct / 100);
    checks.push({ name: 'position_notional_cap', pass: projectedNotional <= posCap, detail: `projected $${projectedNotional.toFixed(0)} vs cap $${posCap.toFixed(0)}` });

    const totalProjected = positions.reduce((s, p) => s + (markPrices[p.symbol] ?? p.entryPrice) * p.qty, 0) + notional;
    const portCap = acc.equity * (config.paper.maxPortfolioNotionalPct / 100);
    checks.push({ name: 'portfolio_notional_cap', pass: totalProjected <= portCap, detail: `projected $${totalProjected.toFixed(0)} vs cap $${portCap.toFixed(0)}` });
  }

  private checkMarginAndRisk(
    ctx: { req: OrderRequest; notional: number; acc: { equity: number; available: number }; sameSym?: PaperPosition },
    checks: RiskCheckResult['checks']
  ): void {
    const { req, notional, acc, sameSym } = ctx;
    const isReduce = isReducing(req, sameSym);
    const lev = Math.min(req.leverage ?? 1, config.paper.maxLeverage);
    const fee = notional * (config.paper.takerFeeBps / 10_000);
    const required = notional / lev + fee;
    if (!isReduce) {
      checks.push({ name: 'margin_available', pass: required <= acc.available, detail: `need $${required.toFixed(2)}, available $${acc.available.toFixed(2)}` });
    }

    let riskPass = true;
    let riskDetail = 'no stop distance given (opening without stop — allowed but discouraged)';
    if (!isReduce && req.stopDistancePct != null && req.stopDistancePct > 0) {
      const riskUsd = notional * (req.stopDistancePct / 100);
      const riskCap = acc.equity * (config.paper.maxRiskPerTradePct / 100);
      riskPass = riskUsd <= riskCap * 1.05;
      riskDetail = `risk $${riskUsd.toFixed(2)} vs cap $${riskCap.toFixed(2)}`;
    }
    checks.push({ name: 'per_trade_risk_cap', pass: riskPass, detail: riskDetail });
    const noDoom = !this.checkDoomLoop(req);
    checks.push({ name: 'doom_loop', pass: noDoom, detail: noDoom ? 'ok' : 'identical order repeated ≥3× in 10min' });
    const notRateLimited = !this.rateLimitOrders();
    checks.push({ name: 'order_rate_limit', pass: notRateLimited, detail: notRateLimited ? 'ok' : '>20 orders/min' });
  }

  checkOrder(req: OrderRequest, markPrices: Record<string, number>): RiskCheckResult {
    const checks: RiskCheckResult['checks'] = [];
    const acc = this.paper.getAccount(markPrices);
    const positions = this.paper.markPositions(markPrices);
    const notional = req.qty * req.price;
    const sameSym = positions.find((p) => p.symbol === req.symbol);

    this.checkBasicSanity(req, checks);
    // Reducing exposure must stay possible even when the account is over its caps.
    if (!isReducing(req, sameSym)) this.checkNotionalCaps({ req, notional, acc, positions, markPrices }, checks);
    this.checkMarginAndRisk({ req, notional, acc, sameSym }, checks);

    const allPass = checks.every((c) => c.pass);
    if (!allPass) {
      const failed = checks.filter((c) => !c.pass).map((c) => `${c.name}(${c.detail})`).join('; ');
      return { approved: false, reason: `RISK REJECTED: ${failed}`, checks };
    }
    return { approved: true, reason: 'approved', checks };
  }
}
