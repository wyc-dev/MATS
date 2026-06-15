// ─── Cost Model ───
// Models Hyperliquid taker/maker fees + funding rate cost for paper trading.
// Ensures paper PnL reflects REAL costs — no fake profits.
//
// Data sources:
//   - Taker fee: 0.04% (HL official, hardcoded)
//   - Maker fee: 0.02% (HL official, hardcoded)
//   - Funding rate: HL WS activeAssetCtx → HLMarkPrice.fundingRate
//
// Funding settles every 8 hours on HL perps.
// Fees are deducted at trade execution time.
// Funding cost is accumulated per cycle for open positions.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'cost-model' });

// ─── HL Official Fee Schedule (Perpetuals) ───
// Source: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
// Standard tier (no volume discount):
const HL_TAKER_FEE_RATE = 0.0004;  // 0.04%
const HL_MAKER_FEE_RATE = 0.0002;  // 0.02%
/** Funding rate is quoted per 8h settlement period */
const FUNDING_SETTLEMENT_HOURS = 8;

// ─── Public Functions ───

/** Calculate taker fee in USD for a given notional */
export function calculateTakerFee(notionalUsd: number): number {
  try {
    return Math.abs(notionalUsd) * HL_TAKER_FEE_RATE;
  } catch (err) {
    log.error(`[calculateTakerFee] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Calculate maker fee in USD for a given notional */
export function calculateMakerFee(notionalUsd: number): number {
  try {
    return Math.abs(notionalUsd) * HL_MAKER_FEE_RATE;
  } catch (err) {
    log.error(`[calculateMakerFee] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Calculate funding cost for holding a position over a period.
 *  @param positionNotionalUsd — position value in USD (positive = long)
 *  @param fundingRate — from WS HLMarkPrice.fundingRate (e.g. 0.0001 = 0.01% per 8h)
 *  @param hoursHeld — number of hours the position has been held since last settlement
 *  @returns cost in USD (positive = paying, negative = receiving)
 *
 *  Long pays funding when fundingRate > 0 (bullish sentiment).
 *  Short pays when fundingRate < 0.
 */
export function calculateFundingCost(
  positionNotionalUsd: number,
  fundingRate: number,
  hoursHeld: number,
): number {
  try {
    if (fundingRate === 0 || hoursHeld <= 0) return 0;
    // fundingRate is per 8h settlement. Convert to hourly rate.
    const hourlyRate = fundingRate / FUNDING_SETTLEMENT_HOURS;
    // Long position (+) pays funding (+) when rate > 0
    // Short position (-) pays funding (+) when rate < 0 (simplified: abs)
    // Net: positionNotional * hourlyRate * hoursHeld
    // Sign: positive fundingRate × long position = positive cost (you pay)
    return positionNotionalUsd * hourlyRate * hoursHeld;
  } catch (err) {
    log.error(`[calculateFundingCost] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/** Get a human-readable summary of current fee rates */
export function getFeeSummary(): string {
  try {
    return [
      '=== Fee Model (Hyperliquid Perps) ===',
      `Taker Fee: ${(HL_TAKER_FEE_RATE * 100).toFixed(3)}%`,
      `Maker Fee: ${(HL_MAKER_FEE_RATE * 100).toFixed(3)}%`,
      `Funding Settlement: Every ${FUNDING_SETTLEMENT_HOURS}h`,
      '==================================',
    ].join('\n');
  } catch {
    return 'Fee model unavailable';
  }
}

export { HL_TAKER_FEE_RATE, HL_MAKER_FEE_RATE, FUNDING_SETTLEMENT_HOURS };