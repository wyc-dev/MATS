/**
 * giveback-cut.ts — v2.0.915-P9-giveback-cut (Master Lord approved PLAN_architecture-profit-audit P1)
 *
 * Background (57 consensus-close evidence, after margin-basis fix):
 *   57/89 consensus closes (64%) "floated ≥0.5% margin but ended losing" —
 *   MFE median 1.46% → final pnl median −3.58% (Σ −207%).
 *   Market offered profit margin but the exit chain (exit_price_lock/MAE-MFE
 *   lock) never acted while pnl was still positive; closed underwater later.
 *
 * Design (giveback circuit-breaker — soft stop, not blanket):
 *   Condition: MFE(was ≥ GIVEBACK_CUT_MFE_MIN, default 0.5% margin) ∧ pnl now < 0
 *        = had profit + retraced >100% = clear exit-timing failure
 *   → cut immediately instead of waiting for consensus to close slowly.
 *
 * Collateral check: big winners are float→win (pnl>0 never triggers) — only
 * "took profit then lost it back" cuts.
 * env: GIVEBACK_CUT_DISABLE=true / GIVEBACK_CUT_MFE_MIN (default 0.005)
 */
export const GIVEBACK_CUT_MFE_MIN_DEFAULT = 0.005; // was floating ≥0.5% margin

export function shouldGivebackCut(
  mfePct: number | null | undefined,
  unrealizedPnlPct: number | null | undefined,
  mfeMin: number = GIVEBACK_CUT_MFE_MIN_DEFAULT,
): boolean {
  // sanitize: garbage/NaN/non-finite → no cut (conservative — never cut on poisoned data)
  if (typeof mfePct !== 'number' || !Number.isFinite(mfePct)) return false;
  if (typeof unrealizedPnlPct !== 'number' || !Number.isFinite(unrealizedPnlPct)) return false;
  const safeMin = Number.isFinite(mfeMin) && mfeMin > 0 ? Math.min(Math.max(mfeMin, 0.0001), 0.05) : GIVEBACK_CUT_MFE_MIN_DEFAULT;
  // MFE reached material level (margin-basis) and now underwater → giveback overflow
  return mfePct >= safeMin && unrealizedPnlPct < 0;
}
