// ─── Close-Reason Utils — v2.0.876-ENTRY-ATTACK（2026-09-13）──
// A1 修復（紅先測試 entry-guard-attack）: cooldown 觸發條件統一判定——
// 原嚟 closeTrade 入面硬編碼 closeReason === 'exit_price_lock' || 'profit_lock',
// 容易喺其他入口（SL/consensus/反轉）誤觸發 or 漏觸發。
// 抽純函數單一 source of truth: 只有「鎖利類」close（exit_price_lock/profit_lock）
// 先觸發 re-entry cooldown——止血（SL/consensus 蝕）唔會 block re-entry（反手空間）。

/** 白名單: 鎖利類 closeReason（觸發 re-entry cooldown——防「鎖完即追」） */
const LOCK_PROFIT_REASONS = new Set(['exit_price_lock', 'profit_lock']);

/**
 * 判定 closeReason 係咪「鎖利類」（應觸發 re-entry cooldown）。
 * 毒輸入 → false（保守——唔可以無故 block re-entry）。
 * 嚴格全等（唔 trim）——垃圾 whitespace 唔可以冒充。
 */
export function isLockProfitCloseReason(reason: unknown): boolean {
  return typeof reason === 'string' && LOCK_PROFIT_REASONS.has(reason);
}
