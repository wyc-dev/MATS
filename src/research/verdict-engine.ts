// research/verdict-engine.ts — automated experiment verdict (Upgrade B).
//
// 初衷 (OpenAI research-acceleration → Analyze 自動化): 每個 challenger/counterfactual
// 唔應該靠人肉讀報告——標準化輸出 → 自動按 PRE-REGISTERED 閾值判 PASS/FAIL/INSUFFICIENT
// → 寫入統一報告。人只審 Verdict(OpenAI: people judge results, not run them)。
//
// 用法:
//   const v = evaluateExperiment({
//     id, metric, baseline, candidate, thresholds: { improveRatio: 1.15, minSample: 15 }
//   });
//   // → PASS / FAIL / INSUFFICIENT + reason
//
// pre-registered = 閾值喺實驗前定死(唔准跑完先填)——對應 ODP/831「先證後改」。

export type Verdict = 'PASS' | 'FAIL' | 'INSUFFICIENT';

export interface ExperimentThresholds {
  /** candidate 要 ≥ baseline × improveRatio 先 PASS */
  improveRatio?: number;
  /** 最細樣本(唔夠 → INSUFFICIENT) */
  minSample?: number;
  /** 尾部條件: candidate 嘅 worst/tail 唔可以差過 baseline 嘅此倍數 */
  tailDeteriorateRatio?: number;
  /** 統計閾值例如 ρ(有就填,冇就跳過) */
  minCorrelation?: number;
}

export interface ExperimentInput {
  id: string;
  baseline: { metric: number; sample: number; tail?: number };
  candidate: { metric: number; sample: number; tail?: number; correlation?: number };
  thresholds: ExperimentThresholds;
}

export interface VerdictResult {
  id: string;
  verdict: Verdict;
  reason: string;
}

/** 純函數: pre-registered verdict(單一 source of truth,可測) */
export function evaluateExperiment(input: ExperimentInput): VerdictResult {
  const { id, baseline, candidate, thresholds } = input;
  const t = thresholds;

  // ATTACK-round(紅先 5/11): garbage 輸入唔可以扮 PASS——metric NaN/Infinity、
  // sample NaN、baseline=0、冇任何閾值,全部 INSUFFICIENT(「唔可以判」唔係「PASS」)。
  const finite = (v: number | undefined): boolean => typeof v === 'number' && Number.isFinite(v);
  const validMetric = finite(baseline.metric) && finite(candidate.metric) && Math.abs(baseline.metric) > 1e-12;
  const validSample = finite(candidate.sample) && candidate.sample >= 0;
  if (!validMetric || !validSample) {
    return { id, verdict: 'INSUFFICIENT', reason: '輸入不可信(garbage metric/sample/baseline=0)——唔可以判 verdict' };
  }
  const hasThreshold = Object.keys(thresholds ?? {}).length > 0;
  if (!hasThreshold) {
    return { id, verdict: 'INSUFFICIENT', reason: '冇任何 pre-registered 閾值——唔可以判' };
  }
  // ATTACK-round 4: 閾值本身可以被 garbage(improveRatio=NaN/0/Infinity、minSample=NaN、
  // correlation=負)→ 比較全 skip → 誤判 PASS。所有數值閾值要 finite + 合理域。
  const numOk = (v: number | undefined, lo: number, hi?: number): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v > lo && (hi === undefined || v <= hi);
  const thresholdsOk =
    (t.improveRatio == null || numOk(t.improveRatio, 0)) &&
    (t.minSample == null || numOk(t.minSample, 0)) &&
    (t.minCorrelation == null || numOk(t.minCorrelation, -1, 1)) &&
    (t.tailDeteriorateRatio == null || numOk(t.tailDeteriorateRatio, 0));
  if (!thresholdsOk) {
    return { id, verdict: 'INSUFFICIENT', reason: 'pre-registered 閾值不可信(garbage)——唔可以判' };
  }

  // 1) 樣本門檻(唔夠 → INSUFFICIENT,唔好判 PASS/FAIL——避免小樣本誤判)
  if (t.minSample != null && candidate.sample < t.minSample) {
    return { id, verdict: 'INSUFFICIENT', reason: `n=${candidate.sample} < minSample=${t.minSample}` };
  }

  // 2) 提升比例
  if (t.improveRatio != null) {
    const denom = baseline.metric;
    const ratio = candidate.metric / denom;
    if (candidate.metric <= baseline.metric * t.improveRatio) {
      return { id, verdict: 'FAIL', reason: `candidate ${candidate.metric.toFixed(2)} ≤ baseline×${t.improveRatio} (${(baseline.metric * t.improveRatio).toFixed(2)})` };
    }
  }

  // 3) 尾部條件(如果提供)——garbage tail 唔可以當「通過」
  const bTail: number | undefined = baseline.tail;
  const cTail: number | undefined = candidate.tail;
  if (t.tailDeteriorateRatio != null && (bTail != null || cTail != null)) {
    if (typeof bTail !== 'number' || !Number.isFinite(bTail) || typeof cTail !== 'number' || !Number.isFinite(cTail)) {
      return { id, verdict: 'INSUFFICIENT', reason: 'tail 輸入不可信(garbage)——唔可以判' };
    }
    if (cTail < bTail * t.tailDeteriorateRatio) {
      return { id, verdict: 'FAIL', reason: `tail ${cTail.toFixed(2)} 劣於 baseline×${t.tailDeteriorateRatio} (${(bTail * t.tailDeteriorateRatio).toFixed(2)})` };
    }
  }

  // 4) 相關性門檻(預測力實驗用)
  if (t.minCorrelation != null && candidate.correlation != null) {
    if (!finite(candidate.correlation)) return { id, verdict: 'INSUFFICIENT', reason: 'ρ 輸入不可信(garbage)' };
    if (candidate.correlation < t.minCorrelation) {
      return { id, verdict: 'FAIL', reason: `ρ=${candidate.correlation.toFixed(3)} < ${t.minCorrelation}` };
    }
  }

  return { id, verdict: 'PASS', reason: '所有 pre-registered 門檻通過' };
}

/** 標準化報告行(自動寫入研究報告——主神睇 verdict 即知) */
export function formatVerdicts(results: VerdictResult[]): string {
  const lines = results.map((r) => `[${r.verdict}] ${r.id}: ${r.reason}`);
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  return ['════ 實驗 Verdict 報告 ════', ...lines, `── ${pass}/${results.length} PASS ──`].join('\n');
}
