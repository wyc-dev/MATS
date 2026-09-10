/**
 * v2.0.875-E3-EDGE-EXPLORE（2026-09-11, 主神「exploration trade 冇做到本分」+ 邏輯實驗驗證）:
 * E3+ Edge 定義: 近 3 日該 asset 同方向成交 ≥2 筆 且 net pnl > 0, 且 4h 動量支持
 * （跌勢 m4h<0 → buy(買dip) / 升勢 m4h>0 → sell(賣rip)）。
 * 實驗: realTrades 289 筆零 look-ahead — E3+ 命中 52 筆 avg +2.42% vs baseline +0.84%
 * （Δ+1.58pp）、兩半正（前 +4.10% / 後 +0.74%）、6/7 symbol 正。
 * 純函數: garbage 輸入 → null / false（唔 crash 唔亂開）。
 */

export interface E3TradeRef {
  closedAt?: unknown;
  side?: unknown;
  pnlPct?: unknown;
}

/** 近 3 日窗（ms） */
export const E3_WINDOW_MS = 3 * 24 * 3600 * 1000;

/**
 * 對某 asset 嘅近 3 日成交, 判斷 E3+ edge 方向。
 * @param recent 該 asset 最近成交（要含 closedAt/side/pnlPct, 由 caller 過濾「開倉前已知」）
 * @param m4hPct 開倉時 4h 動量 %（fraction→ 傳 % 數值 e.g. -1.3 = 跌 1.3%）; null/垃圾 → 冇 m4 支持 → null
 * @returns 'buy' | 'sell' | null（冇 E3+ edge）
 */
export function findE3PlusSide(recent: E3TradeRef[], m4hPct: unknown): 'buy' | 'sell' | null {
  if (!Array.isArray(recent)) return null;
  let buyN = 0, buyNet = 0, sellN = 0, sellNet = 0;
  for (const t of recent) {
    if (typeof t !== 'object' || t === null) continue;
    const side = typeof t.side === 'string' ? t.side.toLowerCase() : '';
    const pnl = typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct) ? t.pnlPct : 0;
    if (side === 'buy') { buyN++; buyNet += pnl; }
    else if (side === 'sell') { sellN++; sellNet += pnl; }
  }
  // 4h 動量支持: m4h<0 → 跌勢 買dip; m4h>0 → 升勢 賣rip。garbage/null/-0 → 唔支持
  const m4 = typeof m4hPct === 'number' && Number.isFinite(m4hPct) ? m4hPct : null;
  if (m4 === null || m4 === 0) return null;
  // E3: 同方向 ≥2 筆 且 net>0 + m4 支持
  if (m4 < 0 && buyN >= 2 && buyNet > 0) return 'buy';
  if (m4 > 0 && sellN >= 2 && sellNet > 0) return 'sell';
  return null;
}

/** Cooldown: 同 asset 最近 E3 開倉後 windowMs 內唔再開（防 churn）。垃圾 ts → false(唔開)。 */
export function shouldCooldown(lastOpenTs: unknown, now: number, windowMs: number = 12 * 3600 * 1000): boolean {
  if (typeof now !== 'number' || !Number.isFinite(now)) return true; // 保守: 異常 now → cooldown
  // undefined/null/0 = 未開過 → 唔 cooldown(可以開); 其他 garbage(string/NaN/Infinity)→ 保守 cooldown(唔亂開)
  if (lastOpenTs === undefined || lastOpenTs === null) return false;
  if (typeof lastOpenTs !== 'number' || !Number.isFinite(lastOpenTs)) return true;
  const ts = lastOpenTs as number;
  if (ts <= 0) return false;
  return now - ts < windowMs;
}

/** E3 開倉 thesis 生成（簡潔, 俾 exploration trade 用）。 */
export function buildE3Thesis(sym: string, side: 'buy' | 'sell', netPct: number, nTrades: number): string {
  const s = String(sym ?? '').split(':').pop() ?? String(sym ?? '');
  return `[E3-edge-explore] ${s} 近3日 ${String(side).toUpperCase()} ${nTrades} 筆 net ${netPct >= 0 ? '+' : ''}${netPct.toFixed(1)}% — exploration 試水(細倉), gates 已過`;
}
