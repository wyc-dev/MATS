// ─── Position Utilities ───
// Shared helpers extracted from portfolio.ts + trading-manager.ts to eliminate
// duplication: SL/TP computation, PnL recompute, MAE/MFE tracking, and
// cumulative margin sizing.

import type { Position } from '../types/index.ts';
import { config } from '../config/index.ts';

/**
 * v2.0.854-ATTACK: Sanitize a leverage value before using it as a divisor.
 * `leverage = 0` or `NaN` would turn `notional / leverage` into `Infinity` /
 * `NaN`, corrupting balance, margin, and pnlPct. Hyperliquid supports 1–50x.
 * The safe floor is 1 (no leverage) — never 0 (an invalid order that must not
 * be silently accepted as "free money").
 */
export function safeLeverage(leverage: number | undefined | null): number {
  if (typeof leverage !== 'number' || !Number.isFinite(leverage)) return 1;
  // Clamp to Hyperliquid's supported [1, 50] range. Reject <= 0 (invalid order)
  // and > 50 (unrealistic / unsupported) → fall back to 1 (conservative).
  if (leverage < 1 || leverage > 50) return 1;
  return leverage;
}

/**
 * v2.0.854-ATTACK2: Sanitize a price before using it in any arithmetic.
 * NaN/Infinity/0/negative prices corrupt balance, PnL, MAE/MFE, and every
 * learning system. A corrupt price must degrade to 0 (no position value) so
 * the portfolio stays finite — never NaN/Infinity which permanently poisons
 * every downstream calculation.
 */
export function safePrice(price: number | undefined | null): number {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return 0;
  return price;
}

/**
 * v2.0.854-ATTACK2: Sanitize a quantity before using it in any arithmetic.
 * NaN/Infinity/0/negative quantities corrupt notional, margin, PnL. A corrupt
 * quantity must degrade to 0 so the position has zero value — never NaN.
 */
export function safeQuantity(qty: number | undefined | null): number {
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) return 0;
  return qty;
}

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
  // v2.0.854-ATTACK: safeLeverage guards leverage=0/NaN (Infinity margin).
  const margin = (pos.averageEntryPrice * pos.quantity) / safeLeverage(pos.leverage);
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
  // v2.0.854-ATTACK: safeLeverage guards leverage=0/NaN (Infinity margin).
  const margin = (pos.averageEntryPrice * pos.quantity) / safeLeverage(pos.leverage);
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
/**
 * Scale down a new position's quantity to fit within the remaining margin budget.
 * Returns the scaled quantity, or 0 if no budget remains.
 */
