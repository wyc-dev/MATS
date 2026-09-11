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

/**
 * v2.0.875-P9-bet-double（2026-09-11, 主神「蝕錢後注碼 ×2」構想 → V3 邏輯實驗 296 筆三關全過）:
 * 同 symbol 同方向上一筆 close 蝕 → 下一筆同向倍注 ×2(cap 0.20)。
 * 實證: V3 子集 EV +1.25%/筆 vs 全樣本 +0.74%; 8/8 symbol 乾淨; holdout +25.5pp;
 * 實盤可達(含 cooldown 攔截 + watchdog 中和) +140.7pp/30日 in-sample。
 * 純函數契約: 任何 garbage 輸入 → false(保守唔倍注) / 唔 crash。
 */
export interface PrevTradeRef {
  side?: unknown;     // 'buy' | 'sell' 白名單
  pnlPct?: unknown;   // 必須 finite number
}

/** V3 倍注決策——「最近一筆同 symbol 同 side trade 蝕」先准倍注。
 *  倍率 mult clamp [1,2]（garbage → 1.0 = 唔倍注）;
 *  cap clamp (0,0.5]（garbage → 0.20）——最終 size 唔可以超過 cap（同 winner-boost cap 0.20 對稱）。
 *  連蝕（streak≥2）由 reentry-cooldown 6h block 接管——呢度唔處理（caller 已 check shouldBlockChaseCooldown）。 */
export function shouldBetDouble(
  side: unknown,
  prev: PrevTradeRef | null | undefined,
  mult: unknown = 2.0,
  cap: unknown = 0.20,
): boolean {
  try {
    // side 白名單——garbage side 唔可以觸發
    if (side !== 'buy' && side !== 'sell') return false;
    if (!prev || typeof prev !== 'object') return false;
    // own-property + try/catch——Proxy/defineProperty getter bomb 唔可以 crash
    const has = (o: unknown, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
    if (!has(prev, 'side') || !has(prev, 'pnlPct')) return false;
    const rawSide = (prev as Record<string, unknown>)['side'];
    const pSide = typeof rawSide === 'string' ? rawSide.toLowerCase() : '';
    if (pSide !== 'buy' && pSide !== 'sell') return false;
    if (pSide !== side) return false;               // 只倍注同方向（贏單後反手唔算）
    const pnl = (prev as Record<string, unknown>)['pnlPct'];
    if (typeof pnl !== 'number' || !Number.isFinite(pnl)) return false; // garbage pnl → 保守
    if (pnl >= 0) return false;                      // 必須蝕——贏/平手 → 恢復 1×
    const m = typeof mult === 'number' && Number.isFinite(mult) ? Math.min(Math.max(mult, 1.0), 2.0) : 1.0;
    const c = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && cap <= 0.5 ? cap : 0.20;
    return m > 1.0 && c > 0;
  } catch { return false; } // getter bomb / 任何 throw → 保守唔倍注
}

/** 倍注後 size: 原 size ×mult, cap; 但**唔可以縮低過原 size**（floor 高過 cap 時倍注唔生效, 唔會誤縮）。
 *  resultSize garbage/≤0 → 原樣返回（唔可以無中生有——0 負 size 唔郁）。 */
export function applyBetDoubleSize(resultSize: unknown, mult: unknown = 2.0, cap: unknown = 0.20): number {
  if (typeof resultSize !== 'number' || !Number.isFinite(resultSize) || resultSize <= 0) {
    return typeof resultSize === 'number' && Number.isFinite(resultSize) ? resultSize : 0.10;
  }
  const m = typeof mult === 'number' && Number.isFinite(mult) ? Math.min(Math.max(mult, 1.0), 2.0) : 1.0;
  const c = typeof cap === 'number' && Number.isFinite(cap) && cap > 0 && cap <= 0.5 ? cap : 0.20;
  const boosted = Math.min(resultSize * m, c);
  return Math.max(boosted, resultSize); // 只放大唔收縮
}
