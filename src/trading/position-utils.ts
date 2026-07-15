// ─── Position Utilities ───
// Shared helpers extracted from portfolio.ts + trading-manager.ts to eliminate
// duplication: SL/TP computation, PnL recompute, MAE/MFE tracking, and
// cumulative margin sizing.

import type { Position } from '../types/index.ts';
import { config } from '../config/index.ts';

/**
 * Compute SL/TP from entry price + side + percentages.
 * LONG: SL = entry × (1 - slPct), TP = entry × (1 + tpPct)
 * SHORT: SL = entry × (1 + slPct), TP = entry × (1 - tpPct)
 *
 * Uses config.risk defaults when slPct/tpPct are not provided.
 * Replaces 5 duplicated sites that used either config.risk.* or hardcoded 0.02/0.05.
 */
export function computeSLTP(
  entry: number,
  side: 'buy' | 'sell',
  slPct?: number,
  tpPct?: number,
): { sl: number; tp: number } {
  const sl = slPct ?? config.risk.stopLossPct;
  const tp = tpPct ?? config.risk.takeProfitPct;
  return side === 'buy'
    ? { sl: entry * (1 - sl), tp: entry * (1 + tp) }
    : { sl: entry * (1 + sl), tp: entry * (1 - tp) };
}

/**
 * Recompute unrealized PnL + PnL% for a position at a given price.
 * PnL = priceDelta × quantity (NOT × leverage). PnL% = PnL / margin.
 * Updates pos.unrealizedPnl + pos.unrealizedPnlPct in-place.
 */
export function recomputePnL(pos: Position, currentPrice: number): void {
  const entryFee = pos.entryFee ?? 0;
  const margin = (pos.averageEntryPrice * pos.quantity) / (pos.leverage ?? 1);
  if (pos.side === 'buy') {
    pos.unrealizedPnl = (currentPrice - pos.averageEntryPrice) * pos.quantity - entryFee;
    pos.unrealizedPnlPct = margin > 0 ? pos.unrealizedPnl / margin : 0;
  } else {
    pos.unrealizedPnl = (pos.averageEntryPrice - currentPrice) * pos.quantity - entryFee;
    pos.unrealizedPnlPct = margin > 0 ? pos.unrealizedPnl / margin : 0;
  }
}

/**
 * Track MAE (min) and MFE (max) of position VALUE over the position's lifetime.
 * Position value = margin + unrealized PnL.
 * Updates pos.minValueReached + pos.maxValueReached in-place.
 */
export function trackMAEMFE(pos: Position): void {
  const margin = (pos.averageEntryPrice * pos.quantity) / (pos.leverage ?? 1);
  const posValue = margin + pos.unrealizedPnl;
  if (pos.minValueReached === undefined || posValue < pos.minValueReached) {
    pos.minValueReached = posValue;
  }
  if (pos.maxValueReached === undefined || posValue > pos.maxValueReached) {
    pos.maxValueReached = posValue;
  }
}

/**
 * Compute the margin (capital at risk) for a position.
 * margin = notional / leverage = (entryPrice × quantity) / leverage
 */
export function computeMargin(pos: Position): number {
  return (pos.averageEntryPrice * pos.quantity) / (pos.leverage ?? 1);
}

/**
 * Scale down a new position's quantity to fit within the remaining margin budget.
 * Returns the scaled quantity, or 0 if no budget remains.
 */
export function scaleQuantityToMargin(
  existingMargin: number,
  maxMargin: number,
  leverage: number,
  price: number,
): number {
  const allowedNewMargin = Math.max(0, maxMargin - existingMargin);
  return (allowedNewMargin * leverage) / price;
}