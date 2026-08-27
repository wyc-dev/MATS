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
  /** v2.0.872-P8-heal-v2: 瞬時失敗重試計數——達上限先 terminal（防永久污染 + 防 API spam） */
  maeMfeHealAttempts?: number;
  /** v2.0.872-P8-heal-v3: 實現 PnL（margin 分數）——exit 權益不變式清理用 */
  pnlPct?: number;
}

/** candle bar shape(HL candleSnapshot) */
export interface CandleLike { t?: number; h?: number | string; l?: number | string; c?: number | string }

export interface HealConfig {
  enabled: boolean;
  batchSize: number;
}

const DEFAULT_BATCH = 8;

/** v2.0.872-P8-heal-v2: 瞬時失敗重試上限——超過先 terminal 放棄 */
export const DEFAULT_HEAL_MAX_ATTEMPTS = 5;
/** v2.0.872-P8-heal-v2: batch 內每個 candle fetch 之間嘅節流（防 burst 打爆 API） */
export const HEAL_FETCH_DELAY_MS = 300;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

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
  // v2.0.872-P8-heal-v2: 重試上限——attempts 耗盡嘅單由 batch loop 標記 terminal，
  // 呢度唔再納入候選（防永不收斂 API spam）。
  const attempts = typeof t.maeMfeHealAttempts === 'number' && Number.isFinite(t.maeMfeHealAttempts) ? t.maeMfeHealAttempts : 0;
  if (attempts >= DEFAULT_HEAL_MAX_ATTEMPTS) return false;
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
 * margin = investment（v2.0.872-P8-heal-unit-fix:investment 本身就係 margin，
 * 唔好再除槓桿——DRAM 7.33×10x=73.3 notional 實證；舊 `investment/leverage`
 * 令 healed 值細槓桿倍 → 下游 MAE% 膨脹 ×槓桿）。
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
  // v2.0.872-P8-heal-attack: candle 層 sanity——價格超出 entry [5%, 2000%] 嘅
  // wick（1e308 毒值）剔除該燭，唔好拒絕成單；全垃圾 → 無效燭 → null。
  // 10× 價格移動喺一個持倉窗口入面物理上唔可能（清算都只係 -100%）。
  const lo = o.entry * 0.05, hi = o.entry * 20;
  let kept = 0;
  for (const c of candles) {
    const h = Number(c.h);
    const l = Number(c.l);
    if (Number.isFinite(h) && h > 0 && h >= lo && h <= hi) { if (h > maxPx) maxPx = h; ++kept; }
    if (Number.isFinite(l) && l > 0 && l >= lo && l <= hi) { if (l < minPx) minPx = l; }
  }
  if (kept === 0 || maxPx < minPx) return null; // 全垃圾/毒 candle 數據
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
): Promise<{ healed: number; skipped: number; failed: number; processed: number; retried: number }> {
  let healed = 0, failed = 0, processed = 0, retried = 0;
  const candidates = trades.filter(maeMfeNeedsHeal).slice(0, batchSize);
  for (let ci = 0; ci < candidates.length; ci++) {
    const t = candidates[ci]!;
    // v2.0.872-P8-heal-v2: batch 內節流——除咗最後一個，每個 fetch 之間隔 300ms，
    // 防止 8 連發 burst 打爆 HL/xyz rate limit（追落後 284 喺時尤其重要）。
    if (ci > 0 && HEAL_FETCH_DELAY_MS > 0) await sleep(HEAL_FETCH_DELAY_MS);
    processed++;
    const sym = t.symbol as string;
    const attempts = typeof t.maeMfeHealAttempts === 'number' && Number.isFinite(t.maeMfeHealAttempts) ? t.maeMfeHealAttempts : 0;
    try {
      const holdMs = (t.closedAt as number) - (t.openedAt as number);
      const primary = pickInterval(holdMs);
      // v2.0.872-P8-heal-v3（live 驗證捉到）: 5m candles 有 retention 限制——
      // 7 月舊短持倉 5m 數據已過期（0 支），但 15m/1h 數據存在。coarse candle
      // 嘅 h/l 極值完全涵蓋 fine candle（wick 包含性）→ min/max 等價 →
      // fallback 鏈 5m→15m→1h 嚴格正確，唔會損失準確性。
      const intervals: string[] = primary === '5m' ? ['5m', '15m', '1h']
        : primary === '15m' ? ['15m', '1h'] : ['1h'];
      let candles: CandleLike[] = [];
      for (const iv of intervals) {
        // 窗口前後留 buffer:open 前一支 candle(捕捉開倉價滑價) → close 後 0
        candles = await fetchCandles(sym, iv, (t.openedAt as number) - 5 * 60_000, t.closedAt as number);
        if (candles.length > 0) break;
        if (iv !== intervals[intervals.length - 1]) await sleep(HEAL_FETCH_DELAY_MS);
      }
      // v2.0.872-P8-heal-unit-fix（重放驗證捉到嘅單位 bug）: investment 本身就係
      // margin（DRAM:7.33×10x = notional 73.3 ✓;trackMAEMFE:margin=entry×qty/lev=investment ✓）。
      // 舊代碼 `investment/leverage` 將 margin 再除槓桿 → healed min/max 細 5.66 倍
      // （SKHX 實證:應 27.4/28.5,heal 出 4.80/5.93 → 下游 MAE% 膨脹 ×槓桿 = 災難性污染）。
      const margin = t.investment as number;
      const side = t.side === 'sell' ? 'sell' : 'buy';
      const ex = computeValueExtremes(candles, { margin, entry: t.entryPrice as number, qty: t.quantity as number, side });
      // v2.0.872-P8-heal-attack: 非有限值防線（candle 層 sanity 已喺 computeValueExtremes
      // 內過濾 1e308 wick——超出 entry [5%,2000%] 嘅燭被剔除）。
      if (ex && (!Number.isFinite(ex.min) || !Number.isFinite(ex.max))) {
        failed++;
        t.maeMfeHealAttempts = attempts + 1;
        if (t.maeMfeHealAttempts >= DEFAULT_HEAL_MAX_ATTEMPTS) {
          t.maeMfeHealed = true;
          t.maeMfeHealError = 'insane-extremes';
        } else {
          t.maeMfeHealError = 'insane-extremes';
          retried++;
        }
        continue;
      }
      if (!ex) {
        // v2.0.872-P8-heal-v2: 空數據唔再一次過永久放棄——attempts++，
        // 達到上限先 terminal（防 API hiccup 被誤判成「冇數據」永久污染）。
        failed++;
        t.maeMfeHealAttempts = attempts + 1;
        if (t.maeMfeHealAttempts >= DEFAULT_HEAL_MAX_ATTEMPTS) {
          // v2.0.872-P8-heal-v3: terminal 放棄前清理毒值——舊單位垃圾
          // （min=−0.55 負權益 / 凍結 min=max=investment）唔可以落下游 PAEL。
          // 不變式:exit 權益 = investment×(1+pnl%) 必須落 [min,max] 區間，
          // 違反 → 重置為中性 [investment, investment]（「無數據」而非毒）。
          const inv = t.investment as number;
          const exitEq = inv * (1 + ((typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct)) ? t.pnlPct : 0));
          const bad = !Number.isFinite(t.minValueReached) || !Number.isFinite(t.maxValueReached)
            || (t.minValueReached as number) < 0
            || (exitEq as number) < (t.minValueReached as number) - 1e-6
            || (exitEq as number) > (t.maxValueReached as number) + 1e-6;
          if (bad) { t.minValueReached = inv; t.maxValueReached = inv; }
          t.maeMfeHealed = true;
          t.maeMfeHealError = 'no-candle-data';
        } else {
          retried++;
        }
        continue;
      }
      t.minValueReached = Math.max(0, ex.min);
      t.maxValueReached = Math.max(0, ex.max);
      t.maeMfeHealed = true;
      t.maeMfeHealError = undefined;
      healed++;
    } catch (err) {
      // v2.0.872-P8-heal-v2: throw（網絡瞬時失敗）→ 唔好一次過永久放棄——
      // attempts++ 留畀下個 batch 重試；達上限先 terminal。
      failed++;
      t.maeMfeHealAttempts = attempts + 1;
      if (t.maeMfeHealAttempts >= DEFAULT_HEAL_MAX_ATTEMPTS) {
        t.maeMfeHealed = true;
        t.maeMfeHealError = 'fetch-error';
      } else {
        t.maeMfeHealError = err instanceof Error ? err.message.slice(0, 120) : 'unknown';
        retried++;
      }
      continue;
    }
  }
  return { healed, skipped: 0, failed, processed, retried };
}
