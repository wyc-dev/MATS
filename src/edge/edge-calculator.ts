// ─── Edge Calculator (Task 1A) ────────────────────────────────────────
//
// v2.0.833: Computes a per-asset, per-cycle EdgeReport that answers
// "does this (symbol × regime) combination have a genuine, non-luck,
// non-beta statistical edge?" The report is written into the analysis
// matrix so the client can show a confidence badge and the backend can
// downgrade / skip low-edge signals.
//
// Edge is conditional — it depends on market regime. The same signal has
// different edge in trending vs chaotic vs mean-reverting markets, so the
// five components are weighted per-regime (see edge-config).
//
// The five components are independent evidence streams:
//   directionalEdge — shadow-trade WR (pure directional alpha, no LLM, no friction)
//   learnedEdge     — OLR P(win) calibrated by Execution Tracker
//   comboEdge       — (symbol × side × regime) Wilson-95% lower bound
//   pathEdge        — First-Passage P(TP before SL) from σ + drift
//   realizedEdge    — rolling WR × Sharpe of actually-closed trades
//
// No single component can dominate: each contributes at most ~35% in its
// best regime, and the recommendation needs edgeScore ≥ 0.55 with
// confidence ≠ low. This is the "lie detector" — it stops the system from
// trading where no edge exists.

import { safeNum, wilsonScore } from '../evolution/evolution-utils.ts';
import { edgeConfig } from './edge-config.ts';
import type { EdgeReport } from '../types/index.ts';

/** F1(2026-08-30): 死權重重新分配總開關——env EDGE_REALLOC=false 回滾。
 *  默認 true(實驗 A/B/C 全過——PLAN_F1-deadweight-realloc.md)。 */
const F1_REALLOC_ENABLED = (process.env['EDGE_REALLOC'] ?? 'true') !== 'false';

/** Inputs the Edge Calculator needs. All are already available in the
 *  decision cycle — this module does NOT make any new LLM / network calls. */
export interface EdgeCalcInput {
  symbol: string;
  side: 'buy' | 'sell';
  regime: string;
  /** Shadow-trade win rate for this symbol/side in the current regime.
   *  Pure directional proxy — no LLM bias, no execution friction. */
  shadowWinRate: number;   // [0,1]
  shadowSamples: number;
  /** OLR P(win) for this symbol/side. Already calibrated by the Execution
   *  Tracker before being passed here (caller's responsibility).
   *  ⚠️ v2.0.873-P9-edt-fix: DEPRECATED——OLR 已證偽(ρ=+0.02), edge 計算
   *  不再消費; 保留字段向後兼容 caller(唔再影響 edgeScore/confidence)。 */
  olrPWin: number;          // [0,1]
  olrSamples: number;
  /** (symbol × side × regime) Wilson-95% lower bound from ComboWinRateTracker. */
  comboWilsonLB: number;    // [0,1]
  comboSamples: number;
  /** First-Passage P(TP before SL) from σ + drift + SL/TP distances.
   *  ⚠️ v2.0.873-P9-edt-fix: DEPRECATED——First-Passage 已證偽(claimed≥95%
   *  實際 39.1%), edge 計算不再消費; 保留字段向後兼容。 */
  firstPassageP: number;    // [0,1]
  /** Rolling realised win rate + Sharpe over the last N closed trades. */
  realizedWinRate: number;  // [0,1]
  realizedSamples: number;
  realizedSharpe: number;
  /** Stability metrics (from StabilityMonitor). */
  perturbation: number;
  crossTime: number;
  /** Execution friction snapshot (from ExecutionTracker). */
  avgSlippageBps: number;
  avgFundingPctPerHour: number;
  execSamples: number;
}

/** Resolve the weight vector for a regime. Falls back to 'unknown' for any
 *  regime not explicitly configured.
 *
 *  SECURITY: uses Object.hasOwn to defend against prototype-pollution vectors.
 *  A regime named '__proto__' or 'constructor' would, with a plain `weights[key]`
 *  lookup, return Object.prototype (a truthy object) and bypass the `??` fallback
 *  → destructuring a non-tuple → `TypeError: w is not iterable` → crash the cycle.
 *  Object.hasOwn() returns false for inherited keys, so the fallback fires. */
function weightsFor(regime: string): [number, number, number, number, number] {
  // P9-edt-fix-attack D1(2026-08-30): regime 非 string(null/undefined/NaN/垃圾)
  // → `regime.toLowerCase()` 會 TypeError crash 成個 cycle。防禦: 非 string → 空 key
  // → fallback unknown weights。已證偽源零依賴, 呢度純粹防 caller 垃圾。
  const key = typeof regime === 'string' ? regime.toLowerCase() : '';
  const w = Object.hasOwn(edgeConfig.weights, key)
    ? edgeConfig.weights[key]
    : undefined;
  return w ?? edgeConfig.weights['unknown']!;
}

/** Confidence label from per-component sample counts. Every component must
 *  clear the floor — a single well-sampled component does not rescue four
 *  unsampled ones (that would be false confidence). */
function confidenceFromSamples(
  shadow: number, combo: number, realized: number,
): 'high' | 'medium' | 'low' {
  // v2.0.873-P9-edt-fix: olr 樣本唔再做 confidence 源——OLR 已證偽,
  // 樣本多只係「噪音測得準」, 唔係「edge 存在」。已證偽源唔提供信心。
  const all = [shadow, combo, realized];
  const min = Math.min(...all);
  if (min >= edgeConfig.confHighSamples) return 'high';
  if (min >= edgeConfig.confMediumSamples) return 'medium';
  return 'low';
}

/** Clamp + confidence-adjust a raw edge score. Low confidence pulls the
 *  score toward 0.5 (neutral) so a fragile, small-sample "high" score
 *  cannot masquerade as a real edge. */
function applyConfidence(raw: number, confidence: 'high' | 'medium' | 'low'): number {
  const clamped = Math.max(0, Math.min(1, raw));
  if (confidence === 'high') return clamped;
  if (confidence === 'medium') return clamped * 0.8;
  // low: pull toward 0.5 by half the distance
  return 0.5 + (clamped - 0.5) * 0.5;
}

/**
 * Compute the EdgeReport for one (symbol, side, regime) combination.
 * Pure function — no side effects, no I/O, milliseconds.
 */
export function computeEdgeReport(input: EdgeCalcInput): EdgeReport {
  const w = weightsFor(input.regime);
  // F1(2026-08-30): 死權重重新分配——learned/path 已證偽中性化, 佢哋嘅權重
  // 份額係死地板(稀釋有效源)。V2 重新分配俾有效源。env EDGE_REALLOC=false 回滾。
  const effW = F1_REALLOC_ENABLED ? reallocateWeights(w) : w;
  const [wDir, wLearn, wCombo, wPath, wReal] = effW;

  // ── Components (each [0,1]) ──────────────────────────────────────────
  const directionalEdge = clamp01(input.shadowWinRate);
  // v2.0.873-P9-edt-fix（主神 2026-08-30）: learnedEdge 唔再食 OLR——
  // OLR 已證偽（ρ=+0.02 零預測力, P9-olr-audit）。edge_report 唔係 report-only:
  // recommendation='skip' 會 HARD HOLD matrix action（analysis-matrix.ts:66）。
  // 已證偽源透過 edgeScore 影響決策 = 違反「已證偽源唔可以喺 signal 層做主訊號」不變式。
  // 修正: 中性 0.5（數學驗證: 只加常數 floor 0.15-0.20, 低於 skip 0.45——
  // 唔誤觸發; 強有效源照常 trade; 靠 OLR 撐起嘅假 edge 排出 trade 區）。
  const learnedEdge = 0.5;
  const comboEdge = clamp01(input.comboWilsonLB);
  // v2.0.873-P9-edt-fix: pathEdge 同——First-Passage 已證偽
  // （claimed≥95% 實際 39.1%, P9-buy-bias）+ FP gate 已停用（P9-deadweight）。
  // 中性 0.5——同上理由, 已證偽源唔可以做 edge 分量。
  const pathEdge = 0.5;
  // realised edge = blend of WR and a tanh-squashed Sharpe so a high-WR /
  // negative-Sharpe (lumpy wins) does not score as well as a smooth winner.
  const sharpeSignal = 0.5 + 0.5 * Math.tanh(safeNum(input.realizedSharpe, 0) / 2);
  const realizedEdge = clamp01(0.7 * input.realizedWinRate + 0.3 * sharpeSignal);

  // ── Weighted blend ──────────────────────────────────────────────────
  const rawScore =
    wDir * directionalEdge +
    wLearn * learnedEdge +
    wCombo * comboEdge +
    wPath * pathEdge +
    wReal * realizedEdge;

  // ── Confidence ──────────────────────────────────────────────────────
  const confidence = confidenceFromSamples(
    input.shadowSamples, input.comboSamples, input.realizedSamples,
  );
  const edgeScore = applyConfidence(rawScore, confidence);

  // ── Stability factor ────────────────────────────────────────────────
  const stabilityFactor = computeStabilityFactor(input.perturbation, input.crossTime);

  // ── Recommendation (stability- AND confidence-adjusted) ────────────
  const recommendation = recommendFromScore(edgeScore, stabilityFactor, confidence);

  return {
    edgeScore: round4(edgeScore),
    components: {
      directionalEdge: round4(directionalEdge),
      learnedEdge: round4(learnedEdge),
      comboEdge: round4(comboEdge),
      pathEdge: round4(pathEdge),
      realizedEdge: round4(realizedEdge),
    },
    confidence,
    recommendation,
    stability: {
      perturbation: round4(input.perturbation),
      crossTime: round4(input.crossTime),
      factor: round4(stabilityFactor),
    },
    executionGap: {
      avgSlippageBps: round2(input.avgSlippageBps),
      avgFundingPctPerHour: round4(input.avgFundingPctPerHour),
      samples: input.execSamples,
    },
    regime: input.regime,
    computedAt: Date.now(),
  };
}

/** Map edgeScore + stabilityFactor + confidence → recommendation.
 *  Stability can downgrade (trade → caution → skip) but never upgrade.
 *  Low confidence caps the recommendation at 'caution' — a zero-sample
 *  system can never be told to trade, no matter how high the raw score is.
 *  This closes the false-confidence vector where applyConfidence('low')
 *  pulls 1.0 → 0.75, which still clears the 0.55 trade threshold. */
function recommendFromScore(
  edgeScore: number,
  stabilityFactor: number,
  confidence: 'high' | 'medium' | 'low',
): 'trade' | 'caution' | 'skip' {
  // Effective score after stability drag. A fragile signal cannot trade
  // even if its raw score is high.
  const effective = edgeScore * stabilityFactor;
  if (effective < edgeConfig.skipThreshold) return 'skip';
  // Low confidence can NEVER recommend 'trade'. A system with no samples
  // has no evidence of edge — at best it can be 'caution'.
  if (confidence === 'low') return effective >= edgeConfig.cautionThreshold ? 'caution' : 'skip';
  if (effective >= edgeConfig.tradeThreshold) return 'trade';
  return 'caution';
}

/** Stability → conviction multiplier. Stable = 1.0; mid = 0.85; below mid
 *  scales linearly down to 0.5 (never zero — we don't hard-block here). */
function computeStabilityFactor(perturbation: number, crossTime: number): number {
  // v2.0.835 security: guard against NaN/Infinity — without this, NaN
  // propagates through Math.min/max → worst=NaN → factor=NaN → edgeScore=NaN
  // → recommendation comparison with NaN always false → trade PASSES.
  const safePert = Number.isFinite(perturbation) ? perturbation : 1;
  const safeCross = Number.isFinite(crossTime) ? crossTime : 1;
  const worst = Math.min(
    Math.max(0, Math.min(1, safePert)),
    Math.max(0, Math.min(1, safeCross)),
  );
  if (worst >= edgeConfig.stabilityStable) return 1.0;
  if (worst >= edgeConfig.stabilityMid) return edgeConfig.stabilityFactorMid;
  return Math.max(0.5, worst);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, safeNum(x, 0.5)));
}

/**
 * F1(2026-08-30, PLAN_F1-deadweight-realloc.md): 死權重重新分配。
 *
 * 背景: P9-edt-fix 已將 learned(OLR)/path(FP) 中性化 0.5——但 config 權重
 * 仍然保留佢哋嘅份額(trending 30% / mean-rev 40%), 永遠貢獻 `0.5×w` 常數
 * = 死權重, 稀釋有效源(shadow/combo/realized)敏感度。
 *
 * 方案 V2(按原比例放大——實驗 A/B/C 全過):
 *  - freed = w[learn] + w[path] 按有效源原比例分配
 *  - 唔改變有效源之間相對權重(保守——唔猜邊個有效源更可信)
 *  - learned/path 權重 = 0(已證偽源零權重——不變式)
 *
 * 實驗驗證(scripts/edge-realloc-experiment/11-realloc.ts):
 *  - 真實數據 22 cells: 無 trade→skip 誤傷, 只有 caution→skip(正確收緊弱訊號)
 *  - 蒙地卡羅 10000 點: 動態範圍 ×1.501(更 sharp——強弱分離更明顯)
 *  - threshold 中心性: 中性 0.5→0.500, 全1→1.000, 全0→0.000(死 floor 消除)
 */
export function reallocateWeights(w: [number, number, number, number, number]): [number, number, number, number, number] {
  // 防禦: 垃圾 config(非有限/負數)→ 全部 fallback 均勻有效源
  if (!w.every((x) => Number.isFinite(x) && x >= 0)) return [1 / 3, 0, 1 / 3, 0, 1 / 3];
  const freed = w[1] + w[3];
  const liveSum = w[0] + w[2] + w[4];
  // 已冇死權重(learned/path 已 0)→ no-op
  if (freed <= 0) return [...w] as [number, number, number, number, number];
  // 冇有效源(config 全死權重)→ realized 為最後可信源(chaotic 哲學: 歷史唯一可信)
  if (liveSum <= 0) return [0, 0, 0, 0, 1];
  // 按原比例放大——權重守恒(和 = 1)
  const scale = (liveSum + freed) / liveSum;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return [
    round(w[0] * scale), 0,
    round(w[2] * scale), 0,
    round(w[4] * scale),
  ] as [number, number, number, number, number];
}
function round4(x: number): number { return Math.round(x * 10_000) / 10_000; }
function round2(x: number): number { return Math.round(x * 100) / 100; }

/** Build a minimal cold-start edge report for symbols with no usable data.
 *
 *  CRITICAL (user requirement): a brand-new system with ZERO trades must NOT
 *  be blocked — otherwise it can never accumulate the samples needed to
 *  measure edge. The report returns a NEUTRAL edgeScore (0.5) with 'caution'
 *  recommendation: the signal enters the matrix but with downweighted
 *  conviction. This lets the system bootstrap data while staying conservative.
 *
 *  Contrast: 'skip' is reserved for a system that HAS samples and found NO
 *  edge (edgeScore < 0.45). Cold-start (no samples) is ignorance, not
 *  evidence of no-edge — so 'caution', never 'skip'. */
export function skipEdgeReport(regime: string): EdgeReport {
  return {
    edgeScore: 0.5,
    components: {
      directionalEdge: 0.5, learnedEdge: 0.5, comboEdge: 0.5, pathEdge: 0.5, realizedEdge: 0.5,
    },
    confidence: 'low',
    recommendation: 'caution',
    stability: { perturbation: 1, crossTime: 1, factor: 1 },
    executionGap: { avgSlippageBps: 0, avgFundingPctPerHour: 0, samples: 0 },
    regime,
    computedAt: Date.now(),
  };
}

/** Convenience: compute realised WR + Sharpe from a list of closed-trade PnL
 *  percentages. Used by the orchestrator to feed `realizedWinRate` +
 *  `realizedSharpe` without each caller reimplementing the math. */
export function realizedStats(pnlPcts: number[]): { winRate: number; sharpe: number; samples: number } {
  if (pnlPcts.length === 0) return { winRate: 0.5, sharpe: 0, samples: 0 };
  const wins = pnlPcts.filter((p) => p > 0).length;
  const winRate = wins / pnlPcts.length;
  const mean = pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length;
  const variance = pnlPcts.reduce((a, b) => a + (b - mean) ** 2, 0) / pnlPcts.length;
  const std = Math.sqrt(Math.max(0, variance));
  // Sharpe per-trade; annualisation is the caller's concern (×√periods/yr).
  const sharpe = std > 1e-9 ? mean / std : 0;
  return { winRate, sharpe, samples: pnlPcts.length };
}