/** Shared domain types — USDT-M only. */

export type Side = 'BUY' | 'SELL';
export type PositionSide = 'LONG' | 'SHORT';

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
}

export interface Kline {
  symbol: string;
  interval: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  takerBuyBaseVolume: number;
  closed: boolean;
}

export interface BookTicker {
  symbol: string;
  bid: number;
  bidQty: number;
  ask: number;
  askQty: number;
  time: number;
}

export interface MarkPrice {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  nextFundingTime: number;
  time: number;
}

export interface Liquidation {
  symbol: string;
  side: Side;
  price: number;
  qty: number;
  notionalUsd: number;
  time: number;
}

export interface OpenInterestInfo {
  symbol: string;
  openInterest: number;
  time: number;
}

export interface FundingRateInfo {
  symbol: string;
  fundingRate: number;
  fundingTime: number;
}

export interface LongShortRatio {
  symbol: string;
  longShortRatio: number;
  longAccount: number;
  shortAccount: number;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  qty: number;
}

export interface OrderBookTop {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPrice: number | null;
  spreadBps: number | null;
}

export interface PaperPosition {
  symbol: string;
  side: PositionSide;
  qty: number;
  entryPrice: number;
  leverage: number;
  margin: number;
  unrealizedPnl: number;
  liquidationPrice: number | null;
  openedAt: number;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: Side;
  positionSide: PositionSide;
  type: 'MARKET';
  qty: number;
  price: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  reduceOnly: boolean;
  status: 'FILLED';
  timestamp: number;
  reason: string;
}

export interface AgentDecision {
  action: 'OPEN' | 'CLOSE' | 'HOLD' | 'ADJUST';
  symbol: string | null;
  side: Side | null;
  qty: number | null;
  reason: string;
}
