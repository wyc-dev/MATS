// ─── Data Quality Evaluator (Phase 2) — v2.0.863 ───────────────────────
//
// 純函數:數據可靠性標記——偵測 funding/volume/spread/staleness 異常。
// 目的:俾 Meta-Agent 判斷「呢個訊號可唔可信」——統計計算異常(σ),
//       LLM 用世界模型決定「點用」。
//
// 設計原則:
//   - 純函數、零 I/O、可單元測試
//   - 輸入防禦:NaN/Infinity/負數 → safe fallback
//   - 異常偵測用 rolling σ(唔係硬編碼 threshold)——市場自適應
//   - qualityScore 0-1:全部正常 = 1,任一異常降權

export interface DataQualityInput {
  /** 當前 funding rate(8h 期) */
  fundingRate: number;
  /** funding 歷史 mean / std(rolling 30d)——caller 提供 */
  fundingMean: number;
  fundingStd: number;
  /** 當前成交量(近 3 根 avg) */
  volume: number;
  volumeMean: number;
  volumeStd: number;
  /** 當前 spread(bps→fraction,例如 0.001 = 0.1%) */
  spreadPct: number;
  /** 最後更新距今 ms */
  lastUpdateMs: number;
}

export interface DataQualityFlags {
  fundingAnomaly: boolean;
  volumeAnomaly: boolean;
  spreadWide: boolean;
  dataStale: boolean;
  /** 0-1:可靠度(1 = 全部正常) */
  qualityScore: number;
  /** 人類可讀警告(注入用,正常 → 空) */
  warnings: string[];
}

// ── Config(production-calibrated)───────────────────────────────────────

const FUNDING_SIGMA = 2.0;       // funding > 2σ → 異常
const VOLUME_SIGMA = 3.0;        // volume > 3σ → 異常
const SPREAD_WIDE_PCT = 0.001;   // spread > 0.1% → 寬(細流動性)
const STALE_MS = 120_000;        // 2 分鐘冇更新 → stale

// ── Main ───────────────────────────────────────────────────────────────

export function evaluateDataQuality(input: DataQualityInput | undefined | null): DataQualityFlags {
  // 防禦:malformed input → 中性(視為可靠,唔會誤 flag)
  if (!input || typeof input !== 'object') {
    return { fundingAnomaly: false, volumeAnomaly: false, spreadWide: false, dataStale: false, qualityScore: 1, warnings: [] };
  }

  const warnings: string[] = [];

  // Funding 異常(|funding − mean| > 2σ)
  let fundingAnomaly = false;
  if (Number.isFinite(input.fundingRate) && Number.isFinite(input.fundingMean) && Number.isFinite(input.fundingStd)) {
    const z = input.fundingStd > 1e-12
      ? Math.abs(input.fundingRate - input.fundingMean) / input.fundingStd
      : 0;
    if (z > FUNDING_SIGMA) {
      fundingAnomaly = true;
      warnings.push(`⚠️ Funding 異常: ${(input.fundingRate * 100).toFixed(3)}%/8h (${z.toFixed(1)}σ)`);
    }
  }

  // Volume 異常(> 3σ)
  let volumeAnomaly = false;
  if (Number.isFinite(input.volume) && Number.isFinite(input.volumeMean) && Number.isFinite(input.volumeStd)) {
    if (input.volumeStd > 1e-12 && input.volume > input.volumeMean + VOLUME_SIGMA * input.volumeStd) {
      volumeAnomaly = true;
      warnings.push(`⚠️ 成交量異常: ${input.volumeMean > 0 ? (input.volume / input.volumeMean).toFixed(1) : '?'}× 平均 (>${VOLUME_SIGMA}σ)`);
    }
  }

  // Spread 寬
  let spreadWide = false;
  if (Number.isFinite(input.spreadPct) && input.spreadPct > 0) {
    if (input.spreadPct > SPREAD_WIDE_PCT) {
      spreadWide = true;
      warnings.push(`⚠️ Spread 寬: ${(input.spreadPct * 100).toFixed(2)}% — 執行可能滑點`);
    }
  }

  // 數據 stale
  let dataStale = false;
  if (Number.isFinite(input.lastUpdateMs)) {
    if (input.lastUpdateMs > STALE_MS) {
      dataStale = true;
      warnings.push(`⚠️ 數據過時: ${Math.round(input.lastUpdateMs / 1000)}s 前更新`);
    }
  }

  // qualityScore:每個異常 × 0.85(正常 = 1)
  let score = 1;
  if (fundingAnomaly) score *= 0.85;
  if (volumeAnomaly) score *= 0.85;
  if (spreadWide) score *= 0.85;
  if (dataStale) score *= 0.85;
  const qualityScore = Math.max(0, Math.min(1, score));

  return { fundingAnomaly, volumeAnomaly, spreadWide, dataStale, qualityScore, warnings };
}
