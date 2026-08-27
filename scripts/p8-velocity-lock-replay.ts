/**
 * P8-profit 重放實驗:速度自適應鎖利——candle path 前向模擬（無 look-ahead）
 *
 * 主神紅線（2026-08-25 裁決）:「>19% 大 winner 會唔會賺少」——零大 winner 誤鎖。
 *
 * METHODOLOGY（保守、無 look-ahead）:
 *   - per-symbol 一次過攞全程 15m candles（xyz REST 主源 + HL fallback），
 *     slice 到每單 openedAt→closedAt 窗口
 *   - 前向逐支 15m 燭:runningPeak（margin-basis 有利浮動）
 *     規則 V:peak ≥ trigger%（前 90min 內）且 close 由 peak 回吐 ≥ giveback% → 該燭 close 鎖利
 *   - 對照組:實際 pnlPct
 *   - 參數掃描:trigger ∈ {8,10,12,15}%，giveback ∈ {40,50,60}%
 *   - 誤鎖審計:被鎖喺入面「最終 MFE ≥15%（margin）」嘅贏單 = 大 winner 誤鎖
 *
 * ⚠️ Read-only。冇 candle 嘅單 skip。
 * Usage: npx tsx scripts/p8-velocity-lock-replay.ts
 */
import fs from 'node:fs';

interface RT { symbol?: string; side?: string; entryPrice?: number; leverage?: number; pnlPct?: number; openedAt?: number; closedAt?: number; closeReason?: string }
interface Candle { t: number; h: number; l: number; c: number }

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const trades: RT[] = (state.realTrades ?? [])
  .filter((t: RT) => t.closedAt && t.entryPrice && t.leverage && t.symbol)
  .sort((a: RT, b: RT) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
console.log(`樣本: ${trades.length} 喺\n`);

async function fetchCandles15m(coin: string, startMs: number, endMs: number): Promise<Candle[]> {
  const { MarketAgent } = await import('../src/market-agent/index.ts');
  const xyzName = coin.includes(':') ? coin : `xyz:${coin}`;
  for (const [name, req] of [
    ['xyz', { coin: xyzName, interval: '15m', startTime: startMs, endTime: endMs }],
    ['hl', { coin: coin.includes(':') ? coin.replace('xyz:', '') : coin.toUpperCase(), interval: '15m', startTime: startMs, endTime: endMs }],
  ] as [string, any][]) {
    try {
      const d = await (await import('../src/market-agent/index.ts')).MarketAgent.hlFetch({ type: 'candleSnapshot', req }) as Candle[] | null;
      if (Array.isArray(d) && d.length > 0) return d;
    } catch { /* next */ }
    void name;
  }
  return [];
}

// per-symbol 全程 candles（一次過,避免 266 次 fetch）
const symbols = [...new Set(trades.map((t: RT) => t.symbol!))];
const candleCache = new Map<string, Candle[]>();
const minOpen = Math.min(...trades.map((t: RT) => t.openedAt ?? 0)) - 3_600_000;
const maxClose = Math.max(...trades.map((t: RT) => t.closedAt ?? 0)) + 60_000;
console.log(`抓 candles: ${symbols.length} symbols × 15m (${new Date(minOpen).toISOString().slice(0, 10)} → ${new Date(maxClose).toISOString().slice(0, 10)})...`);
for (const sym of symbols) {
  const candles = await fetchCandles15m(sym, minOpen, maxClose);
  candleCache.set(sym, candles ?? []);
  console.log(`   ${sym}: ${candles?.length ?? 0} 支`);
}

function sliceCandles(sym: string, opened: number, closed: number): Candle[] {
  return (candleCache.get(sym) ?? []).filter((c) => c.t >= opened - 900_000 && c.t <= closed + 60_000);
}

// 前向模擬:回傳鎖利後 margin-basis pnl%（冇觸發 → 原 pnl）
function simulate(t: RT, candles: Candle[], triggerPct: number, givebackPct: number): { pnl: number; locked: boolean; peak: number; lockedAtMin: number } | null {
  const entry = t.entryPrice!, lev = t.leverage!, side = t.side === 'sell' ? -1 : 1;
  const opened = t.openedAt!, closed = t.closedAt!;
  let peak = 0;
  for (const c of candles) {
    if (c.t < opened || c.t > closed + 3_600_000) continue;
    // 燭內極值 → margin-basis 浮動
    const hi = ((side === 1 ? c.h : c.l) - entry) / entry * 100 * lev * side;
    const closeEx = (c.c - entry) / entry * 100 * lev * side;
    if (hi > peak) peak = hi;
    const ageMin = (c.t - opened) / 60_000;
    if (peak >= triggerPct && ageMin <= 90 && closeEx < peak * (1 - givebackPct / 100) && closeEx > 0) {
      return { pnl: closeEx, locked: true, peak, lockedAtMin: ageMin };
    }
    if (c.t >= closed) break;
  }
  return { pnl: (t.pnlPct ?? 0) * 100, locked: false, peak, lockedAtMin: -1 };
}

// ── 參數掃描 ──
const baseline = trades.reduce((a: number, t: RT) => a + (t.pnlPct ?? 0) * 100, 0);
console.log(`\n基線: ${baseline.toFixed(1)}pp\n`);
console.log('trigger% | giveback% | 鎖利單 | 大winner誤鎖 | 模擬PnL | Δ');
let best: { trig: number; gb: number; delta: number } | null = null;
for (const trig of [8, 10, 12, 15]) {
  for (const gb of [40, 50, 60]) {
    let sim = 0, locked = 0, bigWinnerCut = 0;
    for (const t of trades) {
      const candles = sliceCandles(t.symbol!, t.openedAt!, t.closedAt!);
      if (!candles.length) { sim += (t.pnlPct ?? 0) * 100; continue; }
      const r = simulate(t, candles, trig, gb);
      if (!r) { sim += (t.pnlPct ?? 0) * 100; continue; }
      // 大 winner 誤鎖審計:實際贏 ≥15pp 但被鎖到少過一半
      if ((t.pnlPct ?? 0) * 100 >= 15 && r.pnl < (t.pnlPct ?? 0) * 100 * 0.5) { /* 誤鎖 */ }
      if (r.locked) {
        locked++;
        const actual = (t.pnlPct ?? 0) * 100;
        if (actual >= 15 && r.pnl < actual * 0.5) { /* count below */ }
      }
      sim += r.pnl;
    }
    // 大 winner 誤鎖:單獨計
    let cut = 0;
    for (const t of trades) {
      const actual = (t.pnlPct ?? 0) * 100;
      if (actual < 15) continue;
      const candles = sliceCandles(t.symbol!, t.openedAt!, t.closedAt!);
      if (!candles.length) continue;
      const r = simulate(t, candles, trig, gb);
      if (r?.locked && r.pnl < actual * 0.5) cut++;
    }
    const delta = sim - baseline;
    console.log(`${String(trig).padStart(6)}% | ${String(gb).padStart(8)}% | ${String(locked).padStart(9)} | ${String(cut).padStart(11)} | ${sim.toFixed(1).padStart(7)}pp | ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`);
    if (cut === 0 && (!best || delta > best.delta)) best = { trig, gb, delta };
  }
}
console.log(`\n最優零誤鎖配置: trigger=${best?.trig}% giveback=${best?.gb}% → Δ${best ? (best.delta >= 0 ? '+' : '') + best.delta.toFixed(1) : '?'}pp`);