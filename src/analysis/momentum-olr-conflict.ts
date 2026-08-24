// ─── Momentum-OLR Conflict Gate (v2.0.870-sell-decay-attack G1) ────────
//
// 主神指令 2026-08-24: 以量化金融分析師思路（概率/分布）提升盈利，避免單向問題，
// 保持趨勢敏感。
//
// 問題: DRAM 案例——OLR BUY P(win)=63% 但 24h 動量 -7.3%。OLR 係「TP-before-SL」
// 條件概率模型，train 喺歷史分布上;當即時 24h 大勢（價格變化分布嘅近期位置）同
// OLR 方向嚴重對沖時，OLR edge 嘅可保真度下降——大勢分布對短期 mean-reversion
// 有決定性約束（趨勢市入面嘅反勢買單長期 WR 低）。
//
// 設計: soft gate——純函數，將 OLR edge 按「24h 動量與方向相反程度」打折。
//   |mom24h| < 1.5%        → ×1.00（噪音,唔懲罰）
//   |mom24h| ∈ [1.5, 4)%   → 普通 OLR ×0.80 / 強 OLR(≥60%) ×0.90
//   |mom24h| ≥ 4%          → 普通 OLR ×0.60 / 強 OLR(≥60%) ×0.75
//   順勢（動量與方向一致）→ ×1.0（方向 gate 已 cover,唔重複加碼）
//
// 呢個係「分佈」層面嘅約束: OLR 條件概率係 E[win | features]，但「當下」嘅
// 價格分佈位置（24h 動量）係先驗——兩者矛盾時 Bayes 收縮向近期動量。

/** 純函數：momentum-OLR 衝突乘數。mom24h 單位 %（正 = 向上）。
 *  side: 'buy' | 'sell'。回傳 conviction multiplier ∈ (0, 1]。 */
export function momentumOlrConflictMultiplier(
  side: 'buy' | 'sell',
  mom24hPct: number | null,
  olrPWin: number | null,
): number {
  // 冇動量數據 / 冇 OLR → 唔懲罰（保守唔誤傷）
  if (mom24hPct === null || !Number.isFinite(mom24hPct)) return 1.0;
  if (olrPWin === null || !Number.isFinite(olrPWin)) return 1.0;
  // 順勢或中性 → 唔懲罰
  const bullish = mom24hPct > 0;
  if ((side === 'buy' && bullish) || (side === 'sell' && !bullish)) return 1.0;
  const mag = Math.abs(mom24hPct);
  if (mag < 1.5) return 1.0; // 噪音範圍
  // 強 OLR（≥68%——真係好強先豁免；DRAM 63% 唔算,照懲罰）→ 懲罰減輕
  const strongOlr = olrPWin >= 0.68;
  if (mag >= 4.0) return strongOlr ? 0.75 : 0.60; // 強烈衝突
  return strongOlr ? 0.90 : 0.80;                  // 中等衝突
}
