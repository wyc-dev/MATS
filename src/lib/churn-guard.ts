// ─── Churn Guard — v2.0.876-FIX-H3（2026-09-13, 主神「HACP/exploration 落單流程荒謬」）──
//
// 問題實錘（09-12 BNB）: 26 小時內 13 筆 BUY, close→reopen 間隔 0.0-0.4h,
//   全部 conf=0.4-0.6（冇高信心）——「鎖雞碎 → 幾分鐘再開 → 再鎖」loop。
//   即使 reentry-cooldown 修好（FIX-H1, close 統一 set）, 60min 後仍可再開——
//   「6h 內同方向 N 注」先係 churn 嘅根治量度（同 FIX-H1 互補, 唔重疊）。
//
// 規則（soft——唔 hard block 新方向/高信心）:
//   ① 6h 窗內同方向 ≥3 注 → block（churn 上限）
//   ② conf<0.5 ∧ 6h 窗內同方向 ≥2 注 → block（低信心重複）
//   ③ 其餘 → 放行（新方向 / 高信心 / 首次）
//
// 純函數零依賴——毒值保守（唔 block 現有行為）。

export interface ChurnGuardInput {
  /** 當前建議方向 */
  side: 'buy' | 'sell';
  /** 當前信心 [0,1] */
  confidence: number;
  /** 近 6h 同方向開倉數（含正在評估呢注之前嘅） */
  sameSideCount6h: number;
  /** 近 6h 異方向開倉數（對沖信號——唔計入 churn） */
  oppSideCount6h?: number;
}

export interface ChurnGuardResult {
  blocked: boolean;
  reason: string | null;
}

/** 6h 窗內同方向最大允許注數（超過 → churn block） */
export const CHURN_MAX_SAME_SIDE = 3;
/** 低信心門檻——低於此值且同方向已 2 注 → block */
export const CHURN_LOW_CONF_THRESHOLD = 0.5;
/** 低信心時同方向允許注數上限 */
export const CHURN_LOW_CONF_MAX = 2;

export function shouldBlockChurn(i: ChurnGuardInput): ChurnGuardResult {
  if (!i || typeof i !== 'object') return { blocked: false, reason: null };
  if (i.side !== 'buy' && i.side !== 'sell') return { blocked: false, reason: null };
  const conf = typeof i.confidence === 'number' && Number.isFinite(i.confidence) ? i.confidence : 1; // 毒 → 1（唔 block）
  const same = typeof i.sameSideCount6h === 'number' && Number.isFinite(i.sameSideCount6h) ? i.sameSideCount6h : 0;
  // ① churn 上限: 6h 內同方向 ≥3 注 → block
  if (same >= CHURN_MAX_SAME_SIDE) {
    return { blocked: true, reason: `churn-guard: ${i.side} 6h 內已開 ${same} 注（≥${CHURN_MAX_SAME_SIDE}）——斬斷「鎖雞碎→再追」loop` };
  }
  // ② 低信心重複: conf<0.5 ∧ 6h 內同方向 ≥2 注 → block
  if (conf < CHURN_LOW_CONF_THRESHOLD && same >= CHURN_LOW_CONF_MAX) {
    return { blocked: true, reason: `churn-guard: ${i.side} conf=${(conf * 100).toFixed(0)}%（<${(CHURN_LOW_CONF_THRESHOLD * 100).toFixed(0)}%）且 6h 內已開 ${same} 注 —— 低信心重複追` };
  }
  return { blocked: false, reason: null };
}
