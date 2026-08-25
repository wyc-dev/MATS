// ─── Momentum Directional Bias (v2.0.870-momentum-direction F1) ────────
//
// 主神指令 2026-08-25: 「嗰啲時刻其實應該要 Sell,唔止係唔應該 Buy」
//
// 問題: 系統喺跌市只識「唔開 BUY」（而且連呢個都做唔到——multi-symbol path 冇 gate）。
// 真正需要: 24h/4h 動量強向下時,系統應該傾向 SELL(順勢),而極端反勢 BUY 要 hard block。
//
// 數據支持 (trades.jsonl): BUY trending_bear n=36 WR 11% EV -163%; SNDK 24h -8.3%
// 開 BUY 嘅單照樣輸。順勢 BUY (bull +86% / low_vol +78%) 唔應該受影響。
//
// 設計: 純函數——「24h(或 fallback 4h)動量 vs 方向」完整鏡像:
//   順勢 (buy+mom>0 / sell+mom<0): |mom|∈[1.5,4)% → ×1.05 | ≥4% → ×1.15 (cap)
//   逆勢 (buy+mom<0 / sell+mom>0):
//     ∈[1.5,4)% → ×0.85
//     ≥4%      → ×0.70
//     ≥6%      → ×0.45 (強烈反勢——confidence 近乎清零)
//     ≥8%      → 0 (HARD BLOCK——24h 大勢極端反方向,呢類單唔應該存在)
//   mom null/NaN/不足 → 1.0 (唔影響——數據缺失唔誤傷)
//
// 呢個係「方向層」嘅 gate, 同 G1 (OLR-aware 逆勢打折) 並列獨立。

/** 純函數: 動量方向偏置乘數。momPct 單位 % (正 = 向上)。side: 'buy' | 'sell'。
 *  回傳 multiplier ∈ [0, 1.15]。0 = hard block。 */
export function momentumDirectionalBias(
  side: 'buy' | 'sell',
  momPct: number | null,
): number {
  if (momPct === null || !Number.isFinite(momPct)) return 1.0;
  const mag = Math.abs(momPct);
  if (mag < 1.5) return 1.0; // 噪音範圍——唔影響
  const bullish = momPct > 0;
  const aligned = (side === 'buy' && bullish) || (side === 'sell' && !bullish);
  if (aligned) {
    // 順勢——輕微 boost (cap 1.15, 唔可以無限升——唔想過度自信)
    return mag >= 4.0 ? 1.15 : 1.05;
  }
  // 逆勢——逐級懲罰, 極端 hard block
  if (mag >= 8.0) return 0;          // HARD BLOCK
  if (mag >= 6.0) return 0.45;       // 強烈反勢
  if (mag >= 4.0) return 0.70;
  return 0.85;
}
