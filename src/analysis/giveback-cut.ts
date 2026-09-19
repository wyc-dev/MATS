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

export const GIVEBACK_CUT_MFE_CAP = 10.0; // margin-basis 浮盈上限(~1000% margin)——超過 = 污染
/** v2.0.918(PLAN_giveback-cut-deepening, Master Lord 批 P1-verify): 回吐深度比例——
 *  pnl ≤ −givebackRatio×mfe 先觸發(唔係任何負就斬)。
 *  驗證(89 單 counterfactual): 原條件誤斬 SP500 −0.03%(回吐僅 4%, 大浮盈回調);
 *  新條件(0.5)只斬真走蝕 47 單(回吐>50%, Σ −200.4% 保留 82%), 俾 10 單大浮盈淺回吐(3-41%)空間。
 *  default 0.5 = 回吐超過浮盈一半先斬; 0 = 任何負即斬(舊行為, 向後兼容回退)。 */
export const GIVEBACK_CUT_RATIO_DEFAULT = 0.5;

export function shouldGivebackCut(
  mfePct: number | null | undefined,
  unrealizedPnlPct: number | null | undefined,
  mfeMin: number = GIVEBACK_CUT_MFE_MIN_DEFAULT,
  givebackRatio: number = GIVEBACK_CUT_RATIO_DEFAULT,
): boolean {
  // sanitize: garbage/NaN/non-finite → no cut (conservative — never cut on poisoned data)
  if (typeof mfePct !== 'number' || !Number.isFinite(mfePct)) return false;
  if (typeof unrealizedPnlPct !== 'number' || !Number.isFinite(unrealizedPnlPct)) return false;
  // v2.0.916-P9-attack9: 1e308 maxValueReached 持久化污染 → mfePct 爆大 → 誤觸發 cut 正常倉。
  // 合理 margin 浮盈 < 1000%;超過 = 污染 → 唔觸發(保守閉, 唔可能係真浮盈)。
  if (mfePct > GIVEBACK_CUT_MFE_CAP) return false;
  const safeMin = Number.isFinite(mfeMin) && mfeMin > 0 ? Math.min(Math.max(mfeMin, 0.0001), 0.05) : GIVEBACK_CUT_MFE_MIN_DEFAULT;
  const safeRatio = Number.isFinite(givebackRatio) ? Math.min(Math.max(givebackRatio, 0), 1) : GIVEBACK_CUT_RATIO_DEFAULT;
  // MFE reached material level + retraced PAST givebackRatio×MFE into underwater → giveback overflow.
  // (回吐到浮盈一半以下先斬——俾短暫回調空間, 唔斬返彈喺谷底)
  return mfePct >= safeMin && unrealizedPnlPct <= -safeRatio * mfePct;
}
