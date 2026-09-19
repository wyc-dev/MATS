/**
 * rating.ts —— v2.0.919-P9-hacp-adversarial（主神批 PLAN_hacp-adversarial）
 *
 * 組件 2: 5-tier rating + Conflict≠Hold 紀律。
 * 背景(驗證實錘): MATS 決策 95.1% HOLD(17,675/18,580)——agents 有意向亦被 majority hold
 * 淹沒(296 個真 gap case + 156 個有 edge 理據)。TradingAgents「Conflict alone is NOT
 * a reason to Hold」紀律治呢個死局。
 *
 * 設計(單一 source of truth):
 *   5-tier: Buy / Overweight / Hold / Underweight / Sell
 *   → 3-tier 映射(動作層不變——現有 122 個 gate 3-tier 檢查點零 touched)
 *   → size 細粒度: Overweight/Underweight = 0.6×
 *   + ConflictNotHold clause 可注入 agent prompt(誘導 commit, 唔 hard override)
 *
 * 統計層零 touched; env HACP_5TIER=false 回滾。全英文。
 */
import { z } from 'zod';

export type Rating5 = 'Buy' | 'Overweight' | 'Hold' | 'Underweight' | 'Sell';
export type Action3 = 'buy' | 'sell' | 'hold';

export const RATING5_VALUES = ['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell'] as const;
export const Rating5Schema = z.enum(RATING5_VALUES);

export interface RatingMapping {
  action: Action3;
  sizeMult: number; // 0 < sizeMult <= 1
}

const MAP: Record<Rating5, RatingMapping> = {
  Buy: { action: 'buy', sizeMult: 1.0 },
  Overweight: { action: 'buy', sizeMult: 0.6 },
  Hold: { action: 'hold', sizeMult: 1.0 },
  Underweight: { action: 'sell', sizeMult: 0.6 },
  Sell: { action: 'sell', sizeMult: 1.0 },
};

/**
 * 5-tier → 3-tier(動作層不變, 只係額外撮合層)。
 * sanitize: 垃圾/未知/非 string → 保守 hold(唔 crash, 唔誤導)。
 */
export function mapRatingToAction(rating: unknown): RatingMapping {
  if (typeof rating === 'string' && rating in MAP) return MAP[rating as Rating5];
  return MAP.Hold;
}

/** 由 action + rating 得最終 size 乘數(現有 sizePct × sizeMult)——0 < mult ≤ 1 */
export function ratingSizeMultiplier(rating: unknown, fallback: number = 1.0): number {
  const m = mapRatingToAction(rating).sizeMult;
  return Number.isFinite(fallback) && fallback > 0 ? Math.min(1, Math.max(0.01, fallback * m)) : m;
}

/** Conflict≠Hold 紀律 clause——注入 agent prompt(誘導 commit, 唔 hard override) */
export function buildConflictNotHoldClause(): string {
  return (
    'The debate always contains conflicting arguments; deciding which side is ' +
    'stronger is the job, so conflict alone is not a reason to HOLD. ' +
    'Commit to the side with the stronger case, sized by how decisively it wins. ' +
    'Choose HOLD only when the evidence is still balanced after that weighing, ' +
    'or too thin to support a call; do not manufacture a direction to appear decisive.'
  );
}
