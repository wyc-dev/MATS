// ─── Breakeven Protection — v2.0.876-BREAKEVEN（2026-09-13, 主神批准 PLAN_breakeven）──
//
// 問題實錘（143 筆 giveback, Σ1114.8pp）: 系統平均「一度浮盈 +3.4% margin 最後倒蝕 −4.4%」。
//   Top: bnb 一度 +19.8% → 倒蝕 −8.2%（27.98pp 蒸發）。
//
// 策略（量化金融師風險反轉矩陣——同 trend-defer/PROFIT-RUN 分工）:
//   ┌ 浮盈 ≥ 門檻 ∧ trend 對齊    → 唔 breakeven（交給 PROFIT-RUN 等大魚——回吐追蹤）
//   ├ 浮盈 ≥ 門檻 ∧ 震盪/反向     → breakeven: SL 移至入場價（保本, 防倒蝕）
//   └ 浮盈 < 門檻                 → 不動（未賺未保護）
//
// 核心: breakeven = 保本（防「一度浮盈 → 倒蝕」), 鎖利 = PROFIT-RUN 職責。
//   兩者互補: breakeven 斬 giveback（今日 194pp+）, PROFIT-RUN 食 trend 大魚。
//
// 純函數零依賴。毒值保守（唔亂郁 SL——HL 原生 SL 同步, 錯嘅 SL 會造成 real loss）。

export interface BreakevenInput {
  side: 'buy' | 'sell';
  /** 當前浮盈（margin %, 0.02 = +2%）——用 fresh price 重算, 唔用 stale */
  profitMarginPct: number;
  /** 該倉位曾達嘅 peak 浮盈（margin %）——maxValueReached 記錄 */
  peakMarginPct: number;
  /** 4h/1d regime 是否 trending（trend 對齊 → 唔 breakeven, 交 PROFIT-RUN） */
  isTrendAligned: boolean;
  /** 目前 SL（需要郁先有嘢做） */
  currentStopLoss: number | null | undefined;
  /** 入場價 */
  entryPrice: number;
}

export interface BreakevenResult {
  /** 要唔要郁 SL（true = 有明顯改善——由「蝕位/遠」移到入場） */
  shouldMove: boolean;
  /** 新 SL（= entry——保本） */
  newStopLoss: number | null;
  reason: string;
}

/** 觸發門檻: 浮盈 ≥ 1% margin 先 breakeven（太早 = 微利噪音, 掃完又升） */
export const BREAKEVEN_PROFIT_GATE = 0.01;
/** 需確認 peak ≥ 1.5× 門檻——「曾浮盈」要實質, 唔係瞬閃 */
export const BREAKEVEN_PEAK_GATE = 0.015;

export function shouldApplyBreakeven(i: BreakevenInput): BreakevenResult {
  if (!i || typeof i !== 'object') return { shouldMove: false, newStopLoss: null, reason: 'invalid input' };
  if (i.side !== 'buy' && i.side !== 'sell') return { shouldMove: false, newStopLoss: null, reason: 'invalid side' };
  const profit = typeof i.profitMarginPct === 'number' && Number.isFinite(i.profitMarginPct) ? i.profitMarginPct : 0;
  const peak = typeof i.peakMarginPct === 'number' && Number.isFinite(i.peakMarginPct) ? i.peakMarginPct : 0;
  const entry = typeof i.entryPrice === 'number' && Number.isFinite(i.entryPrice) && i.entryPrice > 0 ? i.entryPrice : null;
  if (entry === null) return { shouldMove: false, newStopLoss: null, reason: 'invalid entry' };
  // 門檻: 而家浮盈 ≥1% ∧ 曾浮盈 ≥1.5%
  if (profit < BREAKEVEN_PROFIT_GATE || peak < BREAKEVEN_PEAK_GATE) {
    return { shouldMove: false, newStopLoss: null, reason: `profit=${(profit * 100).toFixed(1)}% peak=${(peak * 100).toFixed(1)}% below gates` };
  }
  // trend 對齊 → 唔 breakeven（交 PROFIT-RUN）
  if (i.isTrendAligned === true) {
    return { shouldMove: false, newStopLoss: null, reason: 'trend-aligned — profit-run manages, no breakeven (avoids cutting recovery trades)' };
  }
  // 已保本（SL 已 ≥ entry 方向）→ 唔需要動
  const sl = typeof i.currentStopLoss === 'number' && Number.isFinite(i.currentStopLoss) ? i.currentStopLoss : null;
  // 毒值/未知現有 SL → 唔郁（唔知而家 SL 幾多, 唔可以盲 overwrite——HL 同步錯位會 real loss）
  if (i.currentStopLoss !== null && i.currentStopLoss !== undefined) {
    const slRaw = i.currentStopLoss;
    if (typeof slRaw !== 'number' || !Number.isFinite(slRaw) || slRaw <= 0) {
      return { shouldMove: false, newStopLoss: null, reason: 'invalid current SL — cannot blind-overwrite' };
    }
  }
  if (i.side === 'buy' && sl !== null && sl >= entry) {
    return { shouldMove: false, newStopLoss: null, reason: 'SL already at/above entry (protected)' };
  }
  if (i.side === 'sell' && sl !== null && sl <= entry) {
    return { shouldMove: false, newStopLoss: null, reason: 'SL already at/below entry (protected)' };
  }
  const newSL = i.side === 'buy' ? entry : entry;
  return { shouldMove: true, newStopLoss: newSL, reason: `breakeven: profit ${(profit * 100).toFixed(1)}% (peak ${(peak * 100).toFixed(1)}%) — SL to entry (保本)` };
}
