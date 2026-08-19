/**
 * v2.0.870-P43: Regime-aware SL 寬度(組件 1)
 *
 * 背景(主神 SKHX 案例):SL 0.8% 太貼,趨勢中途嘅正常回抽就打爆 SL →
 * 重複進出 whipsaw(方向啱但蝕錢)。反事實回測(1986 筆實際交易):
 * trending 情況闊 SL 到 2% → 91% 贏單保留、58% 輸單防住。
 *
 * 紀律:
 * - 只闊 SL,TP 唔郁(驗證證明改 TP 破壞贏單 86% vs 91%)
 * - trending_bear/bull → 2%;其他(mean_reverting/low_vol/unknown)→ 0.8%
 * - 純函數,無副作用;NaN/unknown 安全
 */

export const TRENDING_SL_PCT = 0.02;
export const DEFAULT_SL_PCT = 0.008;

export function regimeSLWidth(regime: string | undefined | null): number {
  if (regime === 'trending_bear' || regime === 'trending_bull') return TRENDING_SL_PCT;
  return DEFAULT_SL_PCT;
}

/** 判斷 regime 係咪 trending(供 SL 闊化決策用) */
export function isTrendingRegime(regime: string | undefined | null): boolean {
  return regime === 'trending_bear' || regime === 'trending_bull';
}
