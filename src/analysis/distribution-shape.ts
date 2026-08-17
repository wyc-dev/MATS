// ─── Distribution Shape Gate + Convexity/Asymmetry Detector (v2.0.869-P8) ───
//
// 量化金融分析師核心:唔單止睇 EV(期望值點估計),仲要睇:
//   1. 分布形狀(偏度/峰度)——偵測「肥尾蝕錢」(高 win rate 但偶發大蝕)
//   2. 統計顯著性(Wilson LB)——點 EV 可能 >0 但唔顯著(樣本少/噪聲大)
//
// 純函數模組:無 I/O、無狀態、決定性、可單元測試。EVFilter 持有樣本,
// 呢度只做數學。

export interface DistributionShape {
  skewness: number;
  excessKurtosis: number;
  n: number;
}

export interface ConservativeEV {
  conservativeEV: number;
  wilsonLB: number;
  pWin: number;
  avgWin: number;
  avgLoss: number;
  n: number;
}

/** 偏度/峰度最少樣本(小樣本偏度/峰度估計噪聲極大——唔可靠) */
export const MIN_SHAPE_SAMPLES = 30;
/** 凸性偵測最少樣本(同 EV Filter MIN_SAMPLES 一致) */
export const MIN_CONVEXITY_SAMPLES = 20;
/** Wilson 95% 置信區間 z 值 */
export const WILSON_Z = 1.96;

/**
 * 樣本偏度(adjusted Fisher-Pearson)——分布不對稱性。
 *   skew < 0 = 左尾重(偶發大蝕);skew > 0 = 右尾重(偶發大賺)。
 * 攻擊硬化:std=0(全樣本相同)→ 0;n<3 → 0;NaN/Infinity → 0。
 */
export function computeSkewness(samples: number[]): number {
  const n = samples.length;
  if (n < 3) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return 0;
  const sumCubed = samples.reduce((a, b) => a + ((b - mean) / std) ** 3, 0);
  const g1 = (n / ((n - 1) * (n - 2))) * sumCubed;
  return Number.isFinite(g1) ? g1 : 0;
}

/**
 * 樣本超額峰度(excess kurtosis)——尾重程度。
 *   excess > 0 = 肥尾(極端值多);excess ≈ 0 = 近似常態。
 * 攻擊硬化:std=0 → 0;n<4 → 0;NaN/Infinity → 0。
 */
export function computeExcessKurtosis(samples: number[]): number {
  const n = samples.length;
  if (n < 4) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return 0;
  const sumFourth = samples.reduce((a, b) => a + ((b - mean) / std) ** 4, 0);
  const g2 =
    (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * sumFourth -
    (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return Number.isFinite(g2) ? g2 : 0;
}

/** 計算完整分布形狀(偏度 + 峰度) */
export function computeDistributionShape(samples: number[]): DistributionShape {
  return {
    skewness: computeSkewness(samples),
    excessKurtosis: computeExcessKurtosis(samples),
    n: samples.length,
  };
}

/**
 * Wilson 置信區間下界(win rate 嘅 95% CI 下界)。
 * 攻擊硬化:pWin clamp [0,1];n<=0 → 0;NaN → 0。
 */
export function computeWilsonLB(pWin: number, n: number, z: number = WILSON_Z): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const p = Number.isFinite(pWin) ? Math.max(0, Math.min(1, pWin)) : 0;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const lower = center - margin;
  return Number.isFinite(lower) ? Math.max(0, lower) : 0;
}

/**
 * 保守 EV(用 Wilson LB win rate 取代點估計 win rate)。
 * 核心:點 EV 可能 >0,但 Wilson LB 顯示唔顯著 → conservativeEV < 0 → 降權。
 */
export function computeConservativeEV(samples: number[]): ConservativeEV {
  const wins = samples.filter((p) => p > 0);
  const losses = samples.filter((p) => p <= 0);
  const n = samples.length;
  if (n === 0) return { conservativeEV: 0, wilsonLB: 0, pWin: 0, avgWin: 0, avgLoss: 0, n: 0 };
  const pWin = wins.length / n;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + Math.abs(b), 0) / losses.length : 0;
  const wilsonLB = computeWilsonLB(pWin, n);
  const conservativeEV = wilsonLB * avgWin - (1 - wilsonLB) * avgLoss;
  return { conservativeEV, wilsonLB, pWin, avgWin, avgLoss, n };
}

/**
 * 分布形狀 → gate 乘數(判斷層——唔 hard block)。
 *   肥尾蝕錢(skew < -0.5 且 excess kurtosis > 1)→ ×0.75(偶發大蝕 trap)
 *   負偏(skew < -0.5)→ ×0.85(左尾重)
 *   正偏(skew > 0.5)→ ×1.05(贏大輸細——輕 boost)
 *   其他 → ×1.0
 */
export function shapeToMultiplier(shape: DistributionShape): number {
  const { skewness, excessKurtosis, n } = shape;
  if (n < MIN_SHAPE_SAMPLES) return 1.0;
  if (!Number.isFinite(skewness) || !Number.isFinite(excessKurtosis)) return 1.0;
  if (skewness < -0.5 && excessKurtosis > 1) return 0.75;
  if (skewness < -0.5) return 0.85;
  if (skewness > 0.5) return 1.05;
  return 1.0;
}

/**
 * 保守 EV → gate 乘數(判斷層——唔 hard block)。
 *   conservativeEV > 0 → boost ×[1.0, 1.15](統計顯著正 EV)
 *   conservativeEV < 0 → 降權 ×[0.8, 1.0](點 EV 可能 >0 但唔顯著)
 */
export function convexityToMultiplier(conservativeEV: number, n: number): number {
  if (!Number.isFinite(conservativeEV) || n < MIN_CONVEXITY_SAMPLES) return 1.0;
  if (conservativeEV >= 0) {
    // conservativeEV 係小數(0.01 = 1%)——boost 用 ×15:1% → +0.15(cap)
    const boost = Math.min(0.15, conservativeEV * 15);
    return 1.0 + boost;
  }
  // conservativeEV 係小數(-0.01 = -1%)——降權用 ×20:-1% → 0.8(floor)
  const mult = 1.0 + conservativeEV * 20;
  return Math.max(0.8, Math.min(1.0, mult));
}
