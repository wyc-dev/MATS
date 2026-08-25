// ─── Re-entry Cooldown — v2.0.870-reentry-cooldown（主神 2026-08-25）───
// DRAM 案例: PAEL 鎖利 3.0% → close 後 thesis 未失效 → 下 cycle 又開（追高
// 56.12→56.44）→ SL 掃走 -7.3%——「鎖完又追」loop。trend-aware 五版實驗
// 證明「唔鎖」冇用（鎖嗰陣 trend 已轉弱）——真 root 係 re-entry。
// 規則: exit_price_lock / profit_lock close 後 1 小時內唔准開同一方向。
// 純函數零依賴——可測。毒值保守（唔 block）。

export interface ReentryCooldownState {
  side: 'buy' | 'sell';
  untilTs: number;
}

/** 記錄/檢查 cooldown——close 後 call setReentryCooldown。 */
export function buildCooldownEntry(side: 'buy' | 'sell', nowTs: number, cooldownMs: number): ReentryCooldownState | null {
  if (side !== 'buy' && side !== 'sell') return null;
  if (!Number.isFinite(nowTs) || nowTs <= 0) return null;
  const cd = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 3600_000; // default 1h
  return { side, untilTs: nowTs + cd };
}

/** cooldown 內 + 同方向 → block。垃圾值 → false（保守唔 block）。 */
export function shouldBlockReentry(
  entry: ReentryCooldownState | null | undefined,
  action: 'buy' | 'sell',
  nowTs: number,
): boolean {
  if (!entry || typeof entry !== 'object') return false;
  if (action !== 'buy' && action !== 'sell') return false;
  if (entry.side !== action) return false; // 只 block 同方向（sell 可以開）
  if (!Number.isFinite(entry.untilTs) || !Number.isFinite(nowTs)) return false;
  return nowTs < entry.untilTs;
}
