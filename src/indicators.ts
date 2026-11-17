/** Deterministic technical indicators computed from klines. */

export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const out: number[] = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

export function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const trs: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out: number[] = [prev];
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out.push(prev);
  }
  return out;
}

export function vwap(klines: { high: number; low: number; close: number; volume: number }[]): number {
  let pv = 0, vol = 0;
  for (const k of klines) {
    const tp = (k.high + k.low + k.close) / 3;
    pv += tp * k.volume;
    vol += k.volume;
  }
  return vol > 0 ? pv / vol : 0;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  // Align tails.
  const offset = es.length - ef.length;
  const line: number[] = [];
  for (let i = 0; i < ef.length; i++) {
    const s = es[i + offset];
    if (s !== undefined) line.push(ef[i] - s);
  }
  if (line.length < signal) return null;
  const sig = ema(line, signal);
  const hist = line[line.length - 1] - sig[sig.length - 1];
  return {
    macd: line[line.length - 1],
    signal: sig[sig.length - 1],
    histogram: hist,
  };
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return null;
  const win = closes.slice(-period);
  const mean = win.reduce((a, b) => a + b, 0) / period;
  const variance = win.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    upper: mean + mult * sd,
    middle: mean,
    lower: mean - mult * sd,
    bandwidthPct: mean > 0 ? ((2 * mult * sd) / mean) * 100 : 0,
  };
}

export interface IndicatorSnapshot {
  interval: string;
  lastClose: number;
  ema9: number | null;
  ema21: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  atrPct: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  bollinger: { upper: number; middle: number; lower: number; bandwidthPct: number } | null;
  vwap: number | null;
  trend: 'UP' | 'DOWN' | 'FLAT';
  momentum: 'STRONG_UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG_DOWN';
}

export function snapshot(interval: string, klines: {
  high: number; low: number; close: number; volume: number;
}[]): IndicatorSnapshot | null {
  if (klines.length < 50) return null;
  const closes = klines.map((k) => k.close);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const lastClose = closes[closes.length - 1];
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const r14 = rsi(closes, 14);
  const a14 = atr(highs, lows, closes, 14);
  const ema9 = e9.length ? e9[e9.length - 1] : null;
  const ema21 = e21.length ? e21[e21.length - 1] : null;
  const ema50 = e50.length ? e50[e50.length - 1] : null;
  const rsi14 = r14.length ? r14[r14.length - 1] : null;
  const atr14 = a14.length ? a14[a14.length - 1] : null;

  let trend: IndicatorSnapshot['trend'] = 'FLAT';
  if (ema9 !== null && ema21 !== null) {
    if (ema9 > ema21 * 1.0005) trend = 'UP';
    else if (ema9 < ema21 * 0.9995) trend = 'DOWN';
  }
  let momentum: IndicatorSnapshot['momentum'] = 'NEUTRAL';
  if (rsi14 !== null) {
    if (rsi14 >= 65) momentum = 'STRONG_UP';
    else if (rsi14 >= 55) momentum = 'UP';
    else if (rsi14 <= 35) momentum = 'STRONG_DOWN';
    else if (rsi14 <= 45) momentum = 'DOWN';
  }
  return {
    interval,
    lastClose,
    ema9, ema21, ema50, rsi14,
    atr14,
    atrPct: atr14 !== null && lastClose > 0 ? (atr14 / lastClose) * 100 : null,
    macd: macd(closes),
    bollinger: bollinger(closes),
    vwap: vwap(klines.slice(-30)),
    trend, momentum,
  };
}
