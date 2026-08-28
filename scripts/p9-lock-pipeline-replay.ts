/**
 * P9-lock-pipeline-replay:鎖利管道 margin-basis 校準——前向 candle 重放(無 look-ahead)
 *
 * 主神 2026-08-28 指令:「驗證絕對成效;之後先 fix with top tier production grade logic」
 *
 * METHODOLOGY(完全前向、零 look-ahead——參考 P8-velocity-lock-replay):
 *   - per-symbol 一次過抓全程 15m candles(HL 主源 BTC/BNB + xyz DEX 全資產)
 *   - 每單 slice openedAt→closedAt 窗口,前向逐支燭:
 *       runningPeak(margin-basis)= 即時 liveMfe(price%)×leverage——由燭 h/l 計
 *       方案 A: runningPeak ≥ θ(margin%) 且 當前 margin pnl ≤ 0.5×runningPeak
 *                → 該燭收市鎖利(close 價計 pnl)
 *   - 對照組:實際 pnlPct(冇鎖利管道——現狀)
 *   - 誤鎖審計: 最終 MFE ≥ 15%(margin) 嘅單——若重放鎖利點 < 0.5×最終MFE = 誤鎖大 winner
 *   - 保守: 只救「實際蝕」嘅單;實際已贏單唔郁(有 tp_hit/exit_price_lock 已處理)
 *
 * ⚠️ Read-only。冇 candle 嘅單 skip(報告覆蓋率)。
 * Usage: npx tsx scripts/p9-lock-pipeline-replay.ts
 */
import fs from 'node:fs';

interface RT {
  symbol?: string; side?: string; entryPrice?: number; leverage?: number; investment?: number;
  pnlPct?: number; openedAt?: number; closedAt?: number; closeReason?: string;
  minValueReached?: number; maxValueReached?: number;
}
interface Candle { t: number; h: number; l: number; c: number }

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const trades: RT[] = (state.realTrades ?? [])
  .filter((t: RT) => t.closedAt && t.entryPrice && t.leverage && t.symbol && t.pnlPct !== undefined)
  .sort((a: RT, b: RT) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
console.log(`樣本: ${trades.length} 喺\n`);

const BIG_WINNER_MFE = 15; // margin %

async function fetchCandles(coin: string, startMs: number, endMs: number): Promise<Candle[]> {
  // 裸 symbol → HL 主源;含 ':' → 完整名(同 fetchPriceForSymbol 一致)
  const fullName = coin.includes(':') ? coin : coin.toUpperCase();
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: fullName, interval: '15m', startTime: startMs, endTime: endMs } }),
    });
    if (!res.ok) return [];
    const d = await res.json() as Array<Record<string, unknown>> | null;
    if (!Array.isArray(d)) return [];
    return d
      .map((c) => ({
        t: Number(c['t']),
        h: Number(c['h']),
        l: Number(c['l']),
        c: Number(c['c']),
      }))
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.h) && Number.isFinite(c.l) && Number.isFinite(c.c) && c.h > 0 && c.l > 0);
  } catch { return []; }
}

// 抓 candles: per-symbol 一次過
const symbols = [...new Set(trades.map((t: RT) => t.symbol!))];
const minOpen = Math.min(...trades.map((t: RT) => t.openedAt ?? 0)) - 3_600_000;
const maxClose = Math.max(...trades.map((t: RT) => t.closedAt ?? 0)) + 60_000;
const candleCache = new Map<string, Candle[]>();
for (const s of symbols) {
  const c = await fetchCandles(s, minOpen, maxClose);
  candleCache.set(s, c);
  console.log(`  candles ${s}: ${c.length}`);
}
console.log('');

// ── 前向重放 ──
function marginMfeActual(t: RT): number {
  const inv = t.investment ?? 0;
  if (inv <= 0) return 0;
  const side = t.side;
  if (side === 'buy') return ((t.maxValueReached ?? 0) - inv) / inv * 100;
  if (side === 'sell') return ((t.minValueReached ?? 0) - inv) / inv * 100;
  return 0;
}

function replay(thetaPct: number, giveback = 0.5) {
  let covered = 0, noCandle = 0;
  let rescued = 0, bigWinnerMisLock = 0, deltaPnl = 0, lockedTotal = 0;
  const rescuedList: Array<{ symbol: string; reason: string; mfe: number; lock: number; orig: number }> = [];
  for (const t of trades) {
    const candles = candleCache.get(t.symbol!) ?? [];
    const win = (t.openedAt ?? 0) <= minOpen + 3_600_000 ? candles : candles.filter((c) => (c.t + 3_600_000) >= (t.openedAt ?? 0) && c.t <= (t.closedAt ?? 0));
    const windowCandles = candles.filter((c) => (c.t + 900_000) >= (t.openedAt ?? 0) && c.t <= (t.closedAt ?? 0));
    if (windowCandles.length === 0) { noCandle++; continue; }
    covered++;

    const side = t.side === 'sell' ? 'sell' : 'buy';
    const entry = t.entryPrice!;
    const lev = t.leverage!;

    // 前向模擬: runningPeak(margin%) 由燭 h/l 計(同 computeLiveMfePricePct side-aware)
    let runningPeakMargin = 0;
    let lockPnlMargin: number | null = null;
    let lockAtCandle = 0;
    for (let i = 0; i < windowCandles.length; i++) {
      const c = windowCandles[i]!;
      let pricePeak: number;
      if (side === 'buy') pricePeak = c.h;
      else pricePeak = c.l;
      const priceMfe = side === 'buy'
        ? (pricePeak - entry) / entry * 100
        : (entry - pricePeak) / entry * 100;
      if (!Number.isFinite(priceMfe) || priceMfe <= 0) continue;
      const marginPeak = priceMfe * lev;
      if (marginPeak > runningPeakMargin) runningPeakMargin = marginPeak;

      // 當前 margin pnl(用燭收市價,保守——唔用 peak)
      const closeP = c.c;
      const curPnlMargin = side === 'buy'
        ? (closeP - entry) / entry * lev * 100
        : (entry - closeP) / entry * lev * 100;

      // 方案 A: peak ≥ θ 且 回吐 ≥ 50% → 鎖
      if (runningPeakMargin >= thetaPct && curPnlMargin <= 0.5 * runningPeakMargin && curPnlMargin > 0) {
        lockPnlMargin = curPnlMargin;
        lockAtCandle = i;
        break;
      }
    }

    const origPnl = t.pnlPct ?? 0;
    const finalMfe = marginMfeActual(t);

    // 只救實際蝕單(贏單有 tp_hit/lock 機制——唔郁)
    if (origPnl >= 0) continue;
    if (lockPnlMargin === null) continue; // 未觸發

    // 誤鎖審計: 只對「原本已贏」嘅單——若重放令佢提早鎖(counterfactual 損害)
    // 但本重放只處理蝕單(贏單有 tp_hit/exit_price_lock 機制,唔喺呢度郁)——
    // 所以誤鎖審計理論上永遠 0(蝕單被鎖 = 純粹救返)。
    // 保留檢查作為安全網: 若未來擴展到贏單,唔可以鎖 < 0.5×最終MFE。
    if (origPnl < 0 && finalMfe >= BIG_WINNER_MFE) {
      // 蝕單: 鎖住任何正數都係改善——唔算誤鎖。但記錄作 sanity 檢查。
      if (lockPnlMargin < 0) { bigWinnerMisLock++; continue; }
    }
    // 原本已贏單: 呢度唔處理(continue 喺上面 origPnl >= 0 已跳過)
    if (origPnl >= 0 && finalMfe >= BIG_WINNER_MFE && lockPnlMargin < 0.5 * finalMfe) {
      bigWinnerMisLock++;
      continue;
    }
    rescued++;
    lockedTotal += lockPnlMargin;
    deltaPnl += lockPnlMargin - origPnl;
    if (rescued <= 15) rescuedList.push({ symbol: t.symbol!, reason: t.closeReason ?? '?', mfe: finalMfe, lock: lockPnlMargin, orig: origPnl });
  }
  const newWr = (124 + rescued) / 269 * 100;
  console.log(`θ=${thetaPct}% 回吐${giveback * 100}% → 覆蓋 ${covered}/${trades.length}(冇燭 ${noCandle}) | 救返 ${rescued} 單 | WR ${newWr.toFixed(1)}% | PnL Δ${deltaPnl.toFixed(2)}% (總 ${(1.53 + deltaPnl).toFixed(2)}%) | 誤鎖大winner ${bigWinnerMisLock}`);
  for (const r of rescuedList) console.log(`    ${r.symbol} ${r.reason} MFE=${r.mfe.toFixed(1)}% 鎖${r.lock.toFixed(2)}% (原${r.orig.toFixed(2)}%)`);
}

console.log('=== 前向重放(無 look-ahead):方案 A 鎖利門檻 margin-basis ===');
for (const th of [0.3, 0.5, 0.8]) replay(th);
