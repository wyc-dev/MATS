/**
 * trade-frequency-leak.ts —— PLAN_trade-frequency-leak（2026-09-18, 主神批）
 *
 * 背景（數據實證, realTrades 304 單）:
 *   「同 symbol 前 60min 已開過單」= 重複追單 = 蝕錢模式:
 *     MED density（第2/3單）:  WR 38% / avg −1.68% / payoff 0.43
 *     LOW  density（第一單）:  WR 58% / avg +0.92% / payoff 1.13
 *   精修規則「density≥1 ∧ 前1h有蝕單」: 12 單 Σ −27.47%（全負）, 零誤傷
 *   （所有 >3% 大贏單都係 prev_losing=False——唔會被誤閂, bnb +5.25% 前單 +0.2% 安全）
 *
 * 設計（soft——唔 hard block）:
 *   開倉時, 同 symbol 前 windowMs 內已開倉 ≥1 單 且 嗰啲單有蝕（≤0）
 *   → confidence × DENSITY_MULT（default 0.75）——折讓後唔夠 threshold 自然唔開,
 *     大 winner 照可入（soft gate 精神, 831「soft 優先 block 最後」）。
 *
 * env（可回滾）:
 *   TRADE_FREQ_LEAK_DISABLE=true   完全關閉
 *   TRADE_FREQ_LEAK_MULT=0.75      折讓強度（clamp [0.5, 1.0]）
 *   TRADE_FREQ_LEAK_WINDOW_MS=3600000（1h）
 */
export const TRADE_FREQ_LEAK_WINDOW_DEFAULT = 3_600_000; // 1h
export const TRADE_FREQ_LEAK_MULT_DEFAULT = 0.75;

export interface LeakTrade {
  openedAt?: unknown;
  pnlPct?: unknown;
  symbol?: unknown;
}

export interface FrequencyLeakVerdict {
  multiplier: number;
  leak: boolean;
  priorLosing: boolean;
  reason: string | null;
}

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 純函數——判斷「同 symbol 前 windowMs 內重複開倉 且 前一單蝕」折讓。
 * 零 look-ahead（只用已 close 單）; 全部 sanitize——垃圾/缺失 → 中性（唔干擾）。
 */
export function frequencyLeakMultiplier(
  closed: readonly LeakTrade[] | LeakTrade[] | null | undefined,
  symbol: string,
  now: number,
  windowMs: number = TRADE_FREQ_LEAK_WINDOW_DEFAULT,
  mult: number = TRADE_FREQ_LEAK_MULT_DEFAULT,
): FrequencyLeakVerdict {
  const safeMult = Number.isFinite(mult) ? Math.min(1, Math.max(0.5, mult)) : TRADE_FREQ_LEAK_MULT_DEFAULT;
  const safeWindow = Number.isFinite(windowMs) && windowMs > 0 ? Math.min(windowMs, 86_400_000) : TRADE_FREQ_LEAK_WINDOW_DEFAULT; // clamp ≤24h
  if (!Array.isArray(closed)) return { multiplier: 1, leak: false, priorLosing: false, reason: null };
  if (typeof symbol !== 'string' || symbol.length === 0) return { multiplier: 1, leak: false, priorLosing: false, reason: null };
  const symNorm = symbol.toLowerCase();
  let priorLosing = false;
  let anyPrior = false;
  for (const t of closed) {
    if (!t || typeof t !== 'object') continue
    // v2.0.906-P9-attack7(A1): closed 元素可係 Proxy getter-bomb（持久化/API 污染）→
    // 讀 field 時 throw 會 kill 成個 gate——逐元素 try/catch, 毒元素 skip（唔 crash, 唔影響其餘）。
    let tSym: unknown, tOpened: unknown, tPnl: unknown
    try {
      tSym = (t as any).symbol
      tOpened = (t as any).openedAt
      tPnl = (t as any).pnlPct
    } catch { continue } // getter-trap → skip 該元素
    if (typeof tSym !== 'string') continue
    if (tSym.toLowerCase() !== symNorm) continue
    const opened = finiteNum(tOpened)
    if (opened === null) continue
    const ago = now - opened
    if (ago > 0 && ago <= safeWindow) {
      anyPrior = true
      const p = finiteNum(tPnl)
      if (p !== null && p <= 0) { priorLosing = true; break }
    }
  }
  if (anyPrior && priorLosing) {
    return { multiplier: safeMult, leak: true, priorLosing: true, reason: 'repeat-open within window & prior losing' };
  }
  return { multiplier: 1, leak: anyPrior, priorLosing, reason: null };
}
