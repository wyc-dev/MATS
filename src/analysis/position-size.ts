/**
 * v2.0.875-shrink-attack（2026-09-10, 主神「不擇手段攻擊」）:
 * POSITION_SIZE_FIXED floor + sell-cold-shrink 順勢豁免 —— 純函數 + 全面 sanitize。
 * 之前 inline 版本: userFloor 直接取自 marketAgent config **冇 sanitize** —— config 被
 * 持久化污染(負數/0/NaN/1e308/'banana'/object)會令 floor 產生負注碼 / 爆炸 margin。
 * 純函數契約: 任何 garbage 輸入 → 保守 default / 唔 crash。
 */

/** POSITION_SIZE_FIXED floor —— 用戶設定 = ground truth, shrinks 唔可縮低過佢。
 *  sanitize: userFloor 必須有限數喺 (0, 1]（0.1 = 10%）; garbage → 0.10 default。
 *  @returns resultSize >= floor ? resultSize : floor; garbage resultSize → floor 兜底。 */
export function applyPositionSizeFloor(resultSize: unknown, userFloor: unknown): number {
  // userFloor sanitize: 只接受有限數 0 < x <= 1（positionSizePct 語義 0..1）
  const rawFloor =
    typeof userFloor === 'number' && Number.isFinite(userFloor) ? userFloor : 0.10;
  const floor = Math.min(Math.max(rawFloor, 0), 1); // clamp [0,1] —— 負數→0(冇兜底), >1→1
  // resultSize sanitize: 唔係有限數 → 直接用 floor(兜底安全)
  if (typeof resultSize !== 'number' || !Number.isFinite(resultSize)) return floor;
  return resultSize >= floor ? resultSize : floor;
}

/** 順勢 SELL = 4h 動量 < 0（跌勢）。-0 / NaN / Infinity / 非 number / garbage → false(保守: 唔豁免)。 */
export function isTrendFollowingSell(m4hPct: unknown): boolean {
  if (typeof m4hPct !== 'number' || !Number.isFinite(m4hPct)) return false;
  return m4hPct < 0; // -0 < 0 === false —— -0 唔豁免(保守)
}
