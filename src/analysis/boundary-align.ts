// ─── 開倉時序對齊（5m candle boundary）— v2.0.873-P9-boundary-align ──────
//
// 主神指令 2026-08-31: DRAM 連蝕研究——「驗證絕對成效, 之後先 fix」
//
// 問題 (PLAN_DRAM-exhaustion.md §4 T2, scripts/27-offset-counterfactual.ts):
//   開倉執行嗰刻喺 5m candle 入面嘅位置影響成效:
//     支尾 4-5min: avg −1.10% WR 35% 中位 −1.61% (n=68)
//     支中 3-4min: avg +1.72% WR 62%
//     支頭 0-1min: avg +0.10% (n=58)
//   分方向: BUY 支尾 −0.82% / SELL 支尾 −2.20% (兩邊都成立)
//   時序兩半: 期1 −1.70% / 期2 −0.60% (兩半都負) | 剔 outlier −1.42% (更負)
//   敏感性: ≥3.5 (+48.7%) / ≥4.0 (+75.0%) / ≥4.5 (+48.8%) —— 唔係孤立 peak
//   counterfactual: 支尾 skip Δ+75.0% / size½ Δ+37.5%
//
// 解釋 (831.md §7.2 實驗 C): 支尾急落單 → 開新支反轉; 支中落單 = 等支穩定。
//   支尾 = 距離支 close ≤1min —— 已 close candle 方向判斷已經過時 (決策用嘅
//   5m direction 喺 cycle 開始計, 執行喺支尾時個市場已經行咗成支)。
//
// 修復: 支尾 (offset ≥ tailMin) → defer 至下個 5m boundary 開頭 (≤60s)。
//   「支頭落單」= 全新支開始 —— 時間上最接近「支 close 確認」後落單。
//   純時序調整——零 look-ahead (offset 喺執行嗰刻已知)、零離場干預、唔郁 SL/TP。
//
// env: ENTRY_BOUNDARY_ALIGN=false 回滾 / ENTRY_BOUNDARY_TAIL_MIN=4 可調 (clamp [1,4])

export interface BoundaryAlignResult {
  /** 係咪需要延遲 */
  defer: boolean;
  /** 延遲毫秒 —— 至下個 5m boundary (≤ intervalMs - tailMin*60s) */
  delayMs: number;
  /** 支內位置 (分鐘, 0-5) */
  offsetMin: number;
}

/**
 * 支尾偵測——純函數, 零 I/O。
 *
 * now % intervalMs = 距支開始嘅毫秒。offsetMin ≥ tailMin → 支尾 → defer。
 * delayMs = intervalMs - offset (到下一支開頭)。
 *
 * ATTACK-HARDENING (v2.0.873-P9-boundary-align-attack):
 *   - nowMs 垃圾 (NaN/Infinity/負/0/Symbol/BigInt/object)——Number(Symbol) 會 throw →
 *     先 typeof 檢查——垃圾一律唔 defer (唔可以令執行卡死)
 *   - tailMin 垃圾 → 預設 4; clamp [1, 4] (唔可以令延遲爆炸 >60s 或閾值無效)
 *   - intervalMs 垃圾 → 預設 300_000 (5min)
 */
export function shouldDeferToBoundary(
  nowMs: number,
  opts: { tailMin?: number; intervalMs?: number } = {},
): BoundaryAlignResult {
  const now = safeNum(nowMs);
  if (now === null || now <= 0) return { defer: false, delayMs: 0, offsetMin: 0 };
  const iv = safeNum(opts.intervalMs);
  const intervalMs = iv !== null && iv >= 60_000 ? iv : 300_000;
  const tm = safeNum(opts.tailMin);
  const tailMin = tm !== null ? Math.max(1, Math.min(4, tm)) : 4;
  const offset = now % intervalMs;
  const offsetMin = offset / 60_000;
  if (offsetMin >= tailMin) {
    return { defer: true, delayMs: intervalMs - offset, offsetMin };
  }
  return { defer: false, delayMs: 0, offsetMin };
}

/** safe number 解析——Symbol/BigInt/object/array/non-finite → null（Number() 對 Symbol 會 throw）。 */
function safeNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
