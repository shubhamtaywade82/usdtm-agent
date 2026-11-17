/**
 * Central configuration. Everything overridable via environment / .env
 * (see .env.example). The system is USDT-M-only and public-data-only:
 * no Binance API keys are used anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = '.env'): void {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] === undefined) process.env[key] = raw;
  }
}
loadDotEnv();

function envStr(key: string, dflt: string): string {
  const v = process.env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : dflt;
}
function envNum(key: string, dflt: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : dflt;
}
function envList(key: string, dflt: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return dflt;
  return v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}
function envBool(key: string, dflt: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return dflt;
  return v.trim() === 'true' || v.trim() === '1';
}

export const config = {
  ollama: {
    host: envStr('OLLAMA_HOST', 'http://127.0.0.1:11434'),
    model: envStr('OLLAMA_MODEL', 'openbmb/minicpm5-2b'),
    maxSteps: envNum('AGENT_MAX_STEPS', 12),
    numCtx: envNum('AGENT_NUM_CTX', 8192),
    temperature: envNum('AGENT_TEMPERATURE', 0.2),
    requestTimeoutMs: envNum('AGENT_REQUEST_TIMEOUT_MS', 120_000),
    numPredict: envNum('AGENT_NUM_PREDICT', 2048),
    think: envBool('AGENT_THINK', false),
  },
  symbols: envList('SYMBOLS', ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']),
  paper: {
    baseUrl: envStr('PAPER_EXCHANGE_URL', 'http://127.0.0.1:3100/api/v1'),
    apiKey: envStr('PAPER_EXCHANGE_API_KEY', 'b9a74aa1e560e92842e308e40391044968709d39c03e97c40d0b39f4eb8f7242'),
    accountId: envStr('PAPER_EXCHANGE_ACCOUNT_ID', 'usdtm-agent'),
    holderId: envStr('PAPER_EXCHANGE_HOLDER_ID', 'usdtm-agent-runner'),
    initialBalance: envNum('INITIAL_BALANCE', 10_000),
    leaseTtlSeconds: envNum('PAPER_LEASE_TTL_SECONDS', 120),
    /** Hard leverage cap — orders that would exceed it are rejected. */
    maxLeverage: envNum('MAX_LEVERAGE', 3),
    /** Max notional per symbol as % of equity. */
    maxPositionNotionalPct: envNum('MAX_POSITION_NOTIONAL_PCT', 25),
    /** Max total notional across symbols as % of equity. */
    maxPortfolioNotionalPct: envNum('MAX_PORTFOLIO_NOTIONAL_PCT', 80),
    /** Max loss per trade (entry→stop distance × qty) as % of equity. */
    maxRiskPerTradePct: envNum('MAX_RISK_PER_TRADE_PCT', 1.5),
    /** Daily realized+unrealized loss that trips the circuit breaker. */
    dailyLossLimitPct: envNum('DAILY_LOSS_LIMIT_PCT', 5),
    makerFeeBps: envNum('MAKER_FEE_BPS', 2),
    takerFeeBps: envNum('TAKER_FEE_BPS', 5),
    /** Maintenance-margin rate used by the liquidation engine (rough approximation). */
    maintenanceMarginRate: envNum('MAINTENANCE_MARGIN_RATE', 0.5),
  },
  triggers: {
    /** Kline intervals that wake the full agent cycle. */
    klineIntervals: envList('KLINE_TRIGGER_INTERVALS', ['5m', '15m']),
    /** Liquidation notional (USD) that wakes the quick-reaction cycle. */
    liquidationNotionalUsd: envNum('LIQUIDATION_NOTIONAL_USD', 500_000),
    /** Safety-net full cycle cadence. */
    cycleMinutes: envNum('CYCLE_MINUTES', 15),
    /** Min seconds between agent cycles (event coalescing). */
    cooldownSeconds: envNum('COOLDOWN_SECONDS', 45),
    /** Consider WS stale after this many ms without any message. */
    staleMs: envNum('WS_STALE_MS', 60_000),
  },
  marketData: {
    /** How long a REST kline/OI/funding response may serve as a fallback (ms). */
    restCacheMs: envNum('REST_CACHE_MS', 30_000),
    /** Per-REST-request timeout. WS is the primary feed; REST is fallback only. */
    restTimeoutMs: envNum('REST_TIMEOUT_MS', 8_000),
    /** Binance fapi REST base. */
    restBase: envStr('REST_BASE', 'https://fapi.binance.com'),
  },
} as const;

export type Config = typeof config;
