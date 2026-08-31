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

// ─── 連蝕 cooldown — v2.0.873-P9-reentry-cooldown（主神 2026-08-31）───
// DRAM 案例: 2 小時 5 次 SELL（W L L W L W——23:32 蝕→00:07 蝕→01:12 蝕）——
// 「見底反彈」結構斷裂, 系統連環追跌。47/48/49 實驗（311 單, 零 look-ahead）:
//   48 證「14d 成效 lean」Δ−40.4%（平均統計捕捉唔到結構斷裂——轉捩點前樣本全係舊 regime）;
//   47/49 證「N=2 連蝕 → 6h block」Δ+123.8% 三關全過（被抑制 avg −2.48% / 兩半 +73.5/+42.3
//   / T=3~12h 全正非孤立 peak / 誤傷 15:50 = 8:1）。
// 核心定理: 結構斷裂（regime switch）嘅可靠偵測器係「連蝕事件」而唔係「平均統計」。
// 同上面「鎖利 cooldown」（exit_price_lock 後 1h）互補: 嗰個防「鎖完又追」（贏單）;
// 呢個防「連蝕追」（蝕單）——兩個唔同訊號。
// 純函數零依賴——可測。毒值保守（唔 block 唔假造連蝕）。

export interface CooldownStreakState {
  /** 當前該方向連續蝕次數（贏/換方向 → 0） */
  streak: number;
  /** 下個可再開倉時間戳（0 = 未觸發） */
  cooldownUntil: number;
}

export function emptyCooldownStreakState(): CooldownStreakState {
  return { streak: 0, cooldownUntil: 0 };
}

/** close 後更新連蝕狀態——純函數。
 *  pnl ≤ 0（蝕）→ streak+1; streak ≥ n → cooldownUntil = closedAt + hours*3600_000
 *  pnl > 0（贏）→ streak = 0（連蝕斷）
 *  ATTACK-HARDENING: pnl 垃圾（NaN/Infinity/非 number）→ 唔更新; closedAt 垃圾
 *  （NaN/<=0/未來>5min）→ 唔更新（時鐘攻擊——1e308 唔可以令 cooldown 凍結）;
 *  n/hours 垃圾或超出 band → 預設（n∈[1,5]/hours∈[1,72]）。 */
export function updateCooldownOnClose(
  state: CooldownStreakState,
  pnl: number,
  closedAt: number,
  opts: { n?: number; hours?: number } = {},
): CooldownStreakState {
  const s: CooldownStreakState = state && typeof state === 'object'
    ? { streak: Number.isFinite(state.streak) && state.streak >= 0 ? state.streak : 0, cooldownUntil: Number.isFinite(state.cooldownUntil) && state.cooldownUntil > 0 ? state.cooldownUntil : 0 }
    : { streak: 0, cooldownUntil: 0 };
  if (typeof pnl !== 'number' || !Number.isFinite(pnl)) return s;
  const now = Date.now();
  if (typeof closedAt !== 'number' || !Number.isFinite(closedAt) || closedAt <= 0 || closedAt > now + 5 * 60_000) return s;
  if (pnl > 0) return { ...s, streak: 0 };
  const n = clampInt(opts.n, 2, 1, 5);
  const hours = clampNum(opts.hours, 6, 1, 72);
  const streak = s.streak + 1;
  if (streak >= n) return { streak, cooldownUntil: closedAt + hours * 3_600_000 };
  return { ...s, streak };
}

/** 開倉前 check（連蝕 cooldown）——純函數。
 *  ATTACK-HARDENING: now 垃圾 → 唔 block; cooldownUntil 未來垃圾（>now+30d）→ 唔 block。 */
export function shouldBlockChaseCooldown(state: CooldownStreakState | null | undefined, now: number): { blocked: boolean; reason: string } {
  if (!state || typeof state !== 'object') return { blocked: false, reason: '無連蝕 cooldown 狀態' };
  const n = typeof now === 'number' && Number.isFinite(now) && now > 0 ? now : Date.now();
  const cu = state.cooldownUntil;
  if (typeof cu !== 'number' || !Number.isFinite(cu) || cu <= 0) return { blocked: false, reason: '冇連蝕 cooldown 生效' };
  if (cu > n + 30 * 24 * 3_600_000) return { blocked: false, reason: 'cooldown 時間戳異常（未來>30d）——唔 block' };
  if (cu > n) {
    const mins = Math.ceil((cu - n) / 60_000);
    return { blocked: true, reason: `同向連蝕 cooldown 剩 ${mins} 分鐘（結構斷裂偵測——避免連環追跌/追升）` };
  }
  return { blocked: false, reason: '連蝕 cooldown 已過期' };
}

function clampInt(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const f = Math.floor(v);
  return f >= min && f <= max ? f : fallback;
}
function clampNum(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return v >= min && v <= max ? v : fallback;
}
