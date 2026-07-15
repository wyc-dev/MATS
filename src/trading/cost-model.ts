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

// ─── HL Official Fee Schedule (Perpetuals) ───
// Source: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
// Standard tier (no volume discount):
const HL_TAKER_FEE_RATE = 0.0004;  // 0.04%
/** Funding rate is quoted per 8h settlement period */
const FUNDING_SETTLEMENT_HOURS = 8;

// ─── Public Functions ───

/** Calculate taker fee in USD for a given notional */
export function calculateTakerFee(notionalUsd: number): number {
  return Math.abs(notionalUsd) * HL_TAKER_FEE_RATE;
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
  if (fundingRate === 0 || hoursHeld <= 0) return 0;
  const hourlyRate = fundingRate / FUNDING_SETTLEMENT_HOURS;
  return positionNotionalUsd * hourlyRate * hoursHeld;
}

/** Get a human-readable summary of current fee rates */
export function getFeeSummary(): string {
  return [
    '=== Fee Model (Hyperliquid Perps) ===',
    `Taker Fee: ${(HL_TAKER_FEE_RATE * 100).toFixed(3)}%`,
    `Funding Settlement: Every ${FUNDING_SETTLEMENT_HOURS}h`,
    '==================================',
  ].join('\n');
}

export { HL_TAKER_FEE_RATE, FUNDING_SETTLEMENT_HOURS };