/**
 * ═══ v2.0.870-P22-G: MAE/MFE Historical Healer ═══
 *
 * 背景(實證):舊歷史 realTrades 嘅 min/maxValueReached 混合咗兩種量度單位
 * (部分紀錄唔同格式),經歷 v2.0.868 sanitize-reset(margin-basis)後嘅
 * in-memory 值同磁碟值唔一致——PAEL / MAE-pattern / MFE-lock 嘅歷史回測
 * 全部建立喺唔可靠嘅 excursion 數據上。
 *
 * Healing = 用 HL candleSnapshot(權威價格史)喺 [openedAt, closedAt] 窗口
 * 逐筆重算真實 excursion,以 **margin-basis equity value**(canonical:v2.0.143
 * 初始化語義,`margin + unrealizedPnl`)寫返。每筆標記 `maeMfeHealed: true`
 * 防止重複;攞唔到蠟燭 → 標記 `unavailable`,唔再 retry(唔會無限迴圈)。
 *
 * 設計紀律:
 * - Pure-function core(computeValueExtremes)可獨立測試;
 * - Batch-based(預設每 batch 最多 8 筆),唔阻塞 cycle;
 * - 全部 async、try/catch per-trade(一單失敗唔拖低成批);
 * - 標記持久化,restart 唔會重做;
 * - Env: MAE_MFE_HEAL_ENABLED 預設 true(主神可即刻 disable);MAE_MFE_HEAL_BATCH 預設 8。
 */

/** 入參最細粒度——唔 import TradeRecord type(decouple) */
export interface HealableTradeLike {
  id?: string | number;
  symbol?: string;
  side?: string;
  entryPrice?: number;
  quantity?: number;
  investment?: number;
  leverage?: number;
  openedAt?: number;
  closedAt?: number;
  minValueReached?: number;
  maxValueReached?: number;
  status?: string;
  maeMfeHealed?: boolean;
  maeMfeHealError?: string;
}

/** candle bar shape(HL candleSnapshot) */
export interface CandleLike { t?: number; h?: number | string; l?: number | string; c?: number | string }

export interface HealConfig {
  enabled: boolean;
  batchSize: number;
}

const DEFAULT_BATCH = 8;

export function getHealConfig(): HealConfig {
  const env = (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>;
  const raw = Number(env['MAE_MFE_HEAL_BATCH']);
  return {
    enabled: (env['MAE_MFE_HEAL_ENABLED'] ?? 'true') !== 'false',
    batchSize: Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.floor(raw)) : DEFAULT_BATCH,
  };
}

/**
 * 揀合適 candle interval 同窗口 —— 持倉越長,interval 越大(HL 每 request 返回
 * 最多 ~5000 支)。保證 window 涵蓋成個持仓期。
 *  短持倉(<4h):5m(288 支)
 *  中(4h-48h):15m(192 支內 48h 剛好)
 *  長(48h+):1h(夠到 5000h≈208 日)
 */
export function pickInterval(holdMs: number): '5m' | '15m' | '1h' {
  if (!Number.isFinite(holdMs) || holdMs <= 0) return '5m';
  if (holdMs < 4 * 3_600_000) return '5m';
  if (holdMs < 48 * 3_600_000) return '15m';
  return '1h';
}

/**
 * 判斷呢單需唔需要 heal:
 * - 已有 maeMfeHealed 標記 → 唔郁(idempotent)
 * - 缺 entry/qty/investment/leverage/window → 唔可以精算 → skip(唔標記,留畀下次)
 * - 仲喺 open(status 唔係 closed / 冇 closedAt)→ skip
 */
export function maeMfeNeedsHeal(t: HealableTradeLike): boolean {
  if (t.maeMfeHealed === true) return false;
  if (!Number.isFinite(t.entryPrice ?? NaN) || (t.entryPrice as number) <= 0) return false;
  if (!Number.isFinite(t.quantity ?? NaN) || (t.quantity as number) <= 0) return false;
  if (!Number.isFinite(t.investment ?? NaN) || (t.investment as number) <= 0) return false;
  if (!Number.isFinite(t.leverage ?? NaN) || (t.leverage as number) <= 0) return false;
  // P22-attack fix: side 必須係標準 buy/sell —— 'LONG'/'SHORT'/垃圾會被當 buy 方向性錯寫
  if (t.side !== 'buy' && t.side !== 'sell') return false;
  if (!Number.isFinite(t.openedAt ?? NaN) || !Number.isFinite(t.closedAt ?? NaN)) return false;
  if ((t.closedAt as number) <= (t.openedAt as number)) return false;
  return true;
}

/**
 * ★核心純函數:由 candle 極端價算 margin-basis equity excursion。
 * margin = investment / leverage。
 * side-aware:buy → price 跌得越深 value 越低;sell → price 升得越高 value 越低。
 *   value = margin + qty × (px − entry) × sideSign
 * sideSign:buy=+1,sell=−1。
 * 用 candle 嘅 high/low 而非 close —— 捕捉 wick。若 candles 為空 → null。
 */
export function computeValueExtremes(
  candles: CandleLike[],
  o: { margin: number; entry: number; qty: number; side: 'buy' | 'sell' },
): { min: number; max: number } | null {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let minPx = o.entry, maxPx = o.entry;
  for (const c of candles) {
    const h = Number(c.h);
    const l = Number(c.l);
    if (Number.isFinite(h) && h > 0) { if (h > maxPx) maxPx = h; }
    if (Number.isFinite(l) && l > 0) { if (l < minPx) minPx = l; }
  }
  if (maxPx < minPx) return null; // 毒 candle 數據
  // side-aware adverse/favorable 分離:buy 最差 = 低價;sell 最差 = 高價
  const adversePx = o.side === 'sell' ? maxPx : minPx;
  const favorablePx = o.side === 'sell' ? minPx : maxPx;
  const sign = o.side === 'sell' ? -1 : 1;
  return { min: o.margin + o.qty * (adversePx - o.entry) * sign, max: o.margin + o.qty * (favorablePx - o.entry) * sign };
}

/**
 * 異步 heal 一批 trades。
 * @param trades      全量 Closed realTrades(會被 in-place 修改 min/max + 標記)
 * @param fetchCandles (symbol, interval, startMs, endMs) → CandleLike[](已 chronological)
 * @param batchSize   今次最多處理幾多筆
 * @returns           處理結果統計(觀測用)
 */
export async function healMaeMfeBatch(
  trades: HealableTradeLike[],
  fetchCandles: (sym: string, interval: string, startMs: number, endMs: number) => Promise<CandleLike[]>,
  batchSize: number,
): Promise<{ healed: number; skipped: number; failed: number; processed: number }> {
  let healed = 0, failed = 0, processed = 0;
  const candidates = trades.filter(maeMfeNeedsHeal).slice(0, batchSize);
  for (const t of candidates) {
    processed++;
    const sym = t.symbol as string;
    try {
      const holdMs = (t.closedAt as number) - (t.openedAt as number);
      const interval = pickInterval(holdMs);
      // 窗口前後留 buffer:open 前一支 candle(捕捉開倉價滑價) → close 後 0
      const candles = await fetchCandles(sym, interval, (t.openedAt as number) - 5 * 60_000, t.closedAt as number);
      const margin = (t.investment as number) / (t.leverage as number);
      const side = t.side === 'sell' ? 'sell' : 'buy';
      const ex = computeValueExtremes(candles, { margin, entry: t.entryPrice as number, qty: t.quantity as number, side });
      if (!ex) {
        failed++;
        t.maeMfeHealed = true; // 資料不可得 → 標記唔再試(唔 spam API)
        t.maeMfeHealError = 'no-candle-data';
        continue;
      }
      t.minValueReached = Math.max(0, ex.min);
      t.maxValueReached = Math.max(0, ex.max);
      t.maeMfeHealed = true;
      healed++;
    } catch (err) {
      failed++;
      t.maeMfeHealed = true; // fail 一次唔再 retry(下次 candle 可得情況極少)
      t.maeMfeHealError = err instanceof Error ? err.message.slice(0, 120) : 'unknown';
    }
  }
  return { healed, skipped: 0, failed, processed };
}
