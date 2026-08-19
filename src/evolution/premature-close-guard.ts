/**
 * v2.0.870-P71(P3): 短持倉懲罰安全版 — premature-close-guard
 *
 * 主神問:「上一筆 <15min 且 LOSS → 下次 entry ×0.3,會唔會永遠開唔到倉?」
 * 答:naive 版會。SKHX:buy/sell 整體賺錢(+3.5)但最後一筆短蝕會永久鎖。
 *
 * 安全版 4 防線:
 *   1. 連續 2 筆短蝕先觸發(單一噪音唔鎖);
 *   2. 24h 衰減自動失效(市場變咗要放手);
 *   3. S/R 邊界入場豁免(短蝕多數係 mid-range 噪聲;邊界 trade 有結構支撐);
 *   4. 軟乘數 ×0.3(閣下 gate threshold 有 [45%,55%] cap,唔係真 hard block)。
 *
 * 回測驗證(P70):剔走 <15min trades PnL +467%。
 */

export interface PrematureCloseGuardTrade {
  holdMin: number;
  outcome: string;
  ts: number;
}

/** 連續 N 筆 <15min LOSS 先觸發 */
const REQUIRED_CONSECUTIVE = 2;
/** 懲罰 24h 後自動失效(市場變咗要放手) */
const DECAY_MS = 24 * 3600 * 1000;
/** <15min 視為短持倉 */
const SHORT_HOLD_MIN = 15;
/** 懲罰力度 */
const PENALTY = 0.3;

/**
 * 計算短持倉懲罰乘數。
 * @param recentTrades 同一 symbol:side 嘅最近 trades(ts 降序或升序都可,內部會 sort)
 * @param now 而家時間戳(ms)
 * @param isBoundaryEntry 今次係咪 S/R 邊界入場(逃生門)
 */
export function computePrematureClosePenalty(
  recentTrades: PrematureCloseGuardTrade[],
  now: number,
  isBoundaryEntry: boolean,
): number {
  try {
    // 逃生門:S/R 邊界入場豁免(短蝕多數係 mid-range 噪聲)
    if (isBoundaryEntry) return 1.0;
    if (!Array.isArray(recentTrades) || recentTrades.length < REQUIRED_CONSECUTIVE) return 1.0;
    if (!Number.isFinite(now)) return 1.0;

    // sort 降序(最新先)
    const sorted = [...recentTrades].sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0));

    // 連續短蝕 count(由最新數返後)
    let consecutive = 0;
    let latestTs = 0;
    for (const t of sorted) {
      if (!t || typeof t !== 'object') break;
      const hold = t.holdMin;
      const ts = t.ts;
      if (!Number.isFinite(hold) || !Number.isFinite(ts)) break;
      const isShortLoss = hold < SHORT_HOLD_MIN && t.outcome === 'LOSS';
      if (!isShortLoss) break;
      consecutive++;
      if (consecutive === 1) latestTs = ts;
    }
    if (consecutive < REQUIRED_CONSECUTIVE) return 1.0;

    // 24h 衰減:最後一次短蝕超過 24h → 失效
    if (now - latestTs > DECAY_MS) return 1.0;

    return PENALTY;
  } catch {
    return 1.0; // 任何異常 → 中性(唔准 crash 交易循環)
  }
}
