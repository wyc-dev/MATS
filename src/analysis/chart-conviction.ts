// ─── Chart-Aware Conviction Multiplier (v2.0.863) ──────────────────────
//
// 真駁通:將「LLM 世界模型(讀圖)」接到 conviction gate——唔再係淨注入。
//
// 原則(Google Tech Lead + 主神哲學):
//   · LLM 仍然主導方向——有 catalyst(新聞/事件)可以逆圖表(×1.0,唔罰)
//   · 但「無理由逆圖表」會被 code 校準(×0.75)——K 線唔再係「建議」
//   · 數據不可靠(qualityScore < 0.7)→ 一律降(×0.85)
//   · 冷啟動(冇 K 線)/ Range / 一致 → 唔調整(×1.0)
//
// 純函數、零 I/O、可單元測試。malformed input → 1.0(唔 crash、唔誤罰)。

export type ChartTrend = 'up' | 'down' | 'sideways' | null;

export interface ChartConvictionInput {
  /** LLM 決策方向 */
  action: 'buy' | 'sell';
  /** K 線趨勢(null = 冷啟動/無數據) */
  klineTrend: ChartTrend;
  /** thesis catalyst 分類(新聞/事件有理由 override) */
  catalystLevel: 'strong' | 'weak' | 'none';
  /** 數據可靠性 0-1(1 = 可靠) */
  qualityScore: number;
}

export const CHART_CONVICTION_CONFIG = {
  /** 反向 + 無 catalyst → 校準乘數 */
  reverseNoCatalyst: 0.75,
  /** 數據不可靠 threshold(< 0.7 → 降權) */
  qualityThreshold: 0.7,
  /** 數據不可靠乘數 */
  qualityPenalty: 0.85,
} as const;

export function computeChartConvictionMultiplier(input: ChartConvictionInput | undefined | null): number {
  // 防禦:malformed input → 1.0(唔罰)
  if (!input || typeof input !== 'object') return 1.0;
  if (input.action !== 'buy' && input.action !== 'sell') return 1.0;

  let m = 1.0;

  // 1. K-LINE 一致性校準(只有明確 up/down 先校準;Range/冷啟動唔罰)
  const trend = input.klineTrend;
  if (trend === 'up' || trend === 'down') {
    const consistent = (input.action === 'buy' && trend === 'up')
      || (input.action === 'sell' && trend === 'down');
    if (!consistent) {
      // 反向:K 線話 up 但 LLM 出 sell(或相反)
      //   有 catalyst → LLM 有世界模型理由,唔罰
      //   冇 catalyst → 逆圖表但冇理由 → 校準
      if (input.catalystLevel === 'none' || input.catalystLevel === 'weak') {
        m *= CHART_CONVICTION_CONFIG.reverseNoCatalyst;
      }
    }
  }

  // 2. DATA QUALITY 校準(數據不可靠一律降)
  const quality = Number.isFinite(input.qualityScore) ? input.qualityScore : 1;
  if (quality < CHART_CONVICTION_CONFIG.qualityThreshold) {
    m *= CHART_CONVICTION_CONFIG.qualityPenalty;
  }

  return m;
}
