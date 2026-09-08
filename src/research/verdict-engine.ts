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

  // 1) 樣本門檻(唔夠 → INSUFFICIENT,唔好判 PASS/FAIL——避免小樣本誤判)
  if (t.minSample != null && candidate.sample < t.minSample) {
    return { id, verdict: 'INSUFFICIENT', reason: `n=${candidate.sample} < minSample=${t.minSample}` };
  }

  // 2) 提升比例
  if (t.improveRatio != null) {
    const denom = baseline.metric > 0 ? baseline.metric : Math.abs(baseline.metric) + 1e-9;
    const ratio = candidate.metric / denom;
    if (candidate.metric <= baseline.metric * t.improveRatio) {
      return { id, verdict: 'FAIL', reason: `candidate ${candidate.metric.toFixed(2)} ≤ baseline×${t.improveRatio} (${(baseline.metric * t.improveRatio).toFixed(2)})` };
    }
  }

  // 3) 尾部條件(如果提供)
  if (t.tailDeteriorateRatio != null && baseline.tail != null && candidate.tail != null) {
    if (candidate.tail < baseline.tail * t.tailDeteriorateRatio) {
      return { id, verdict: 'FAIL', reason: `tail ${candidate.tail.toFixed(2)} 劣於 baseline×${t.tailDeteriorateRatio} (${(baseline.tail * t.tailDeteriorateRatio).toFixed(2)})` };
    }
  }

  // 4) 相關性門檻(預測力實驗用)
  if (t.minCorrelation != null && candidate.correlation != null && candidate.correlation < t.minCorrelation) {
    return { id, verdict: 'FAIL', reason: `ρ=${candidate.correlation.toFixed(3)} < ${t.minCorrelation}` };
  }

  return { id, verdict: 'PASS', reason: '所有 pre-registered 門檻通過' };
}

/** 標準化報告行(自動寫入研究報告——主神睇 verdict 即知) */
export function formatVerdicts(results: VerdictResult[]): string {
  const lines = results.map((r) => `[${r.verdict}] ${r.id}: ${r.reason}`);
  const pass = results.filter((r) => r.verdict === 'PASS').length;
  return ['════ 實驗 Verdict 報告 ════', ...lines, `── ${pass}/${results.length} PASS ──`].join('\n');
}
