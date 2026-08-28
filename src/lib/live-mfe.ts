// ─── Live MFE helper — v2.0.870-exit-price-lock ────────────────────────
//
// PAEL exit-price-lock 失效根因（2026-08-25，主神調查 10 單 9 蝕）:
//   live MFE 追蹤靠 trackMAEMFE 每 cycle currentPrice 抽查（softUpdatePosition），
//   非 active symbol 盤中 peak 被錯過；healMaeMfeOnce 只補 status==='closed'
//   嘅 trade → live MFE 嚴重低估 → PAEL lock / reversal 睇唔到真 MFE → 唔觸發
//   → 全數回吐 → 關倉後先補返（太遲）。
//
// 修復：用持倉窗口內嘅 1h candles 計「即時 price MFE」——真實極值，side-aware：
//  BUY  → MFE = (max(high) - entry) / entry          （價升有利）
//  SELL → MFE = (entry - min(low)) / entry           （價跌有利）
// 窗口 = openedAt 之後開始嘅 candles（candle 同持倉重疊先算，容許 entry candle
// 一支嘅誤差——比「得最後一支」大幅低估好，最多一支 1h candle 範圍內高估）。
// 純函數——零依賴，可單測。index.ts 只做 candleCache wrapper。
//
// ⚔️ v2.0.870-exit-price-lock-attack（主神 2026-08-25）攻擊輪硬化:
//   A1: candle h=1e308（finite 過 sanitize）→ MFE 爆炸 → 假鎖（L2/L3/cold-start）
//   A2: side 持久化污染（'hold'/NaN/undefined）→ sell 倉計錯方向
//   A3: candle t=1e308（future）→ window 誤收
//   A4: h=entry×1000（超額外但 finite）→ MFE 巨大化
//   A5: shouldTrailingLock(1e308) → 0.5×Infinity 恆 true → 全倉假鎖
//   修復: MFE clamp [0, MAX_LIVE_MFE_PCT=50]（同 convertToPriceExtremes 嘅
//   maxExcursionPct=0.5 對稱——舊 code 有 clamp, 新 code 冇 = 對稱漏洞）;
//   side/t/openedAt 合理範圍 guard; 超範圍一律 null/false（保守唔誤鎖）。

/** 合理 MFE 上限（price %）——同 exit-price-learner maxExcursionPct=0.5 一致。
 *  1h candle 內單支 >50% move 係腐敗數據（真實：波動極端都 <10%）。 */
export const MAX_LIVE_MFE_PCT = 50;

/** P9-lock-pipeline 前向重放（2026-08-28，269 喺）最優參數：margin-basis 0.5% 門檻。
 *  θ=0.5% margin → WR 46.1%→72.9%、PnL Δ+53.21%、誤鎖大 winner 0。
 *  env PROFIT_LOCK_MARGIN_THRESHOLD_PCT 可調（回滾用）。 */
export const PROFIT_LOCK_MARGIN_THRESHOLD_PCT = (() => {
  const raw = Number(process.env['PROFIT_LOCK_MARGIN_THRESHOLD_PCT']);
  return Number.isFinite(raw) && raw > 0 && raw <= 5 ? raw : 0.5;
})();

/** candle open time 合理上限（ms）——1e15 ≈ 公元 33658 年；1e308 科幻未來直接拒。 */
const MAX_TS_MS = 1e15;

export interface LiveMfeCandle {
  t: number;   // candle open time (ms)
  h: number;   // high
  l: number;   // low
}

/** 計算持倉窗口內嘅即時 price MFE（%）。任何毒輸入 → null（唔誤傷）。
 *  openedAt 為 0/NaN/負 → 當「全部 candles 可用」（冷啟動兜底）；
 *  openedAt 超合理（>1e15）→ null（future ts 唔可以造窗口——保守）。 */
export function computeLiveMfePricePct(
  side: 'buy' | 'sell',
  entryPrice: number,
  openedAt: number,
  candles: LiveMfeCandle[] | null | undefined,
): number | null {
  if (side !== 'buy' && side !== 'sell') return null;               // A2: side 污染
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;
  if (!Array.isArray(candles) || candles.length === 0) return null;
  if (Number.isFinite(openedAt) && openedAt > MAX_TS_MS) return null; // A6: future openedAt

  const validOpen = Number.isFinite(openedAt) && openedAt > 0 && openedAt <= MAX_TS_MS;
  const windowed: LiveMfeCandle[] = [];
  for (const c of candles) {
    if (!c || typeof c !== 'object') continue;                      // A7: null element（排除）
    const t = c.t;
    if (!Number.isFinite(t) || t <= 0 || t > MAX_TS_MS) continue;   // A3: future/垃圾 t（cache 邊界——排除）
    if (validOpen && t + 3600_000 <= openedAt) continue;            // entry 前嘅 candle 唔計
    const h = c.h, l = c.l;
    if (!Number.isFinite(h) || !Number.isFinite(l) || h <= 0 || l <= 0) return null; // A1b: 值腐敗 → 整批 null（唔用殘餘數據）
    if (h > entryPrice * 1e4 || l > entryPrice * 1e4) return null;  // A4: 超出物理範圍（>100萬%）→ 整批 null
    windowed.push({ t, h, l });
  }
  if (windowed.length === 0) return null;

  let mfe: number;
  if (side === 'sell') {
    let minLow = Infinity;
    for (const c of windowed) if (c.l < minLow) minLow = c.l;
    mfe = ((entryPrice - minLow) / entryPrice) * 100;
  } else {
    let maxHigh = -Infinity;
    for (const c of windowed) if (c.h > maxHigh) maxHigh = c.h;
    mfe = ((maxHigh - entryPrice) / entryPrice) * 100;
  }
  if (!Number.isFinite(mfe)) return null;
  // A1/A4: 超過合理 MFE cap → 唔鎖（同 convertToRealMargin 對稱——唔可以 1e308 假鎖）
  if (mfe > MAX_LIVE_MFE_PCT || mfe < 0) return null;
  return mfe;
}

/** L3 Trailing Profit Lock 判定（margin-basis）：
 *  liveMfe(price%) ≥ 0.5% 且 pnlPctNow(margin%) > 0 且
 *  pnlPctNow ≤ 0.5 × liveMfe × leverage —— 即由峰值回吐 ≥50% → 鎖利。
 *  純函數，毒輸入一律 false（保守唔鎖）。 */
export function shouldTrailingLock(
  liveMfePricePct: number | null,
  pnlPctNow: number,
  leverage: number,
): boolean {
  if (!Number.isFinite(pnlPctNow) || pnlPctNow <= 0) return false;
  if (pnlPctNow > 1e6) return false;                                 // A5b: 垃圾 pnl 唔鎖
  if (liveMfePricePct === null || !Number.isFinite(liveMfePricePct)) return false;
  if (liveMfePricePct <= 0 || liveMfePricePct > MAX_LIVE_MFE_PCT) return false; // A1/A5: 溢出/超 cap 唔鎖
  const lev = Number.isFinite(leverage) && leverage > 0 && leverage <= 1000 ? leverage : 1; // A5c: lev 溢出 → 1
  const peakMargin = liveMfePricePct * lev;
  if (!Number.isFinite(peakMargin) || peakMargin <= 0) return false;
  return pnlPctNow <= 0.5 * peakMargin;
}

/** L1 cold-start fallback 判定（margin-basis——P9-lock-pipeline 前向重放驗證）:
 *  實時 MFE(price%) × leverage ≥ PROFIT_LOCK_MARGIN_THRESHOLD_PCT(預設 0.5% margin)
 *  且當前盈利 → 鎖利。
 *  舊版用 price-basis 0.5% 硬門檻——10x 槓桿下 = margin 5% 先觸發，
 *  令 110/145 蝕單(浮盈 1-3% margin)全部漏走——單位錯配已修正。
 *  超 cap（>50% price）→ false（A8：1e308 唔可以假鎖）。
 *  向後兼容：leverage 唔傳/垃圾 → 1（即 price 0.5% = margin 0.5%，舊測試語義保留）。 */
export function shouldColdStartLock(
  liveMfePricePct: number | null,
  unrealizedPnl: number | null | undefined,
  leverage?: number | null,
  opts: { thresholdMarginPct?: number } = {},
): boolean {
  if (liveMfePricePct === null || !Number.isFinite(liveMfePricePct)) return false;
  if (liveMfePricePct <= 0 || liveMfePricePct > MAX_LIVE_MFE_PCT) return false; // A8
  const lev = Number.isFinite(leverage) && (leverage as number) > 0 && (leverage as number) <= 1000 ? (leverage as number) : 1; // A5c: lev 溢出 → 1
  const threshold = Number.isFinite(opts.thresholdMarginPct) && (opts.thresholdMarginPct as number) > 0
    ? (opts.thresholdMarginPct as number)
    : PROFIT_LOCK_MARGIN_THRESHOLD_PCT;
  if (liveMfePricePct * lev < threshold) return false;
  return typeof unrealizedPnl === 'number' && Number.isFinite(unrealizedPnl) && unrealizedPnl > 0;
}

// ─── 確認式鎖掛（v2.0.870-exit-price-lock-confirm，主神 2026-08-25）───
// 問題: 原 L3「回吐 ≥50% 即鎖」誤鎖大 winner（>19% tp_hit 單進二退一——
// 短暫回吐後再創新高）。Counterfactual 40 單掃描: 確認窗口 N=12（60min）
// 最優——誤鎖大贏 6→1 單（損失 63→8.6pp）、總 PnL 悲觀 1.96→86.0% /
// 樂觀 118.7%（N=24 大遲——蝕→正得 5 單；N=6 誤鎖仍 5 單）。
// 機制: 回吐 ≥50% → pending（唔即鎖）; pending 期間創新高 → 取消（趨勢
// 有效——大 winner 唔誤鎖）; 確認窗口冇新高 → 鎖利（真回吐）。

export interface PendingTrailingLock {
  /** 觸發 pending 時嘅 peak price（創新高比較基準） */
  peakPrice: number;
  /** 觸發 pending 嘅 cycle 數 */
  sinceCycle: number;
}

/** pending 期間創新高（currentPeak > pendingPeak）→ 取消（趨勢繼續）。
 *  垃圾值 → false（保守唔 cancel——等確認鎖）。 */
export function shouldCancelPendingLock(pendingPeakPrice: number, currentPeakPrice: number): boolean {
  if (!Number.isFinite(pendingPeakPrice) || pendingPeakPrice <= 0) return false;
  if (!Number.isFinite(currentPeakPrice) || currentPeakPrice <= 0) return false;
  return currentPeakPrice > pendingPeakPrice;
}

/** 確認窗口屆滿（currentCycle - sinceCycle ≥ confirmCycles）→ 鎖利。
 *  毒值 → false（保守唔鎖）。confirmCycles 預設 12。 */
export function shouldConfirmTrailingLock(
  pending: PendingTrailingLock | null | undefined,
  currentCycle: number,
  confirmCycles: number,
): boolean {
  if (!pending || typeof pending !== 'object') return false;
  if (!Number.isFinite(pending.sinceCycle) || pending.sinceCycle < 0) return false;
  if (!Number.isFinite(currentCycle) || currentCycle < 0) return false;
  const c = Number.isFinite(confirmCycles) && confirmCycles > 0 ? Math.floor(confirmCycles) : 12;
  return currentCycle - pending.sinceCycle >= c;
}
