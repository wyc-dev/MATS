/**
 * tmp-roll-sim.ts — 驗證主神構想: cycle 仍有同向 edge 時, roll SL/TP 取代 lock-close→追高重開
 *
 * 方法（zero look-ahead）:
 *  - 對每 cluster（同 symbol × 同日連續同向 exit_price_lock）:
 *    - ACTUAL = cluster 內各單 pnl 總和（全倉輪轉）
 *    - ROLL   = 第一單 entry 開始持倉, 期間嘅同向 re-entry 視為「新鮮信號」(系統當時真係想開)
 *               → 唔 close, 只 roll SL（breakeven → 50% trail）; 止蝕由 5m candle 路徑判定
 *               → 喺「反向信號」(反向 real trade 開倉) 或 candle 窗尾離場
 *  - 比較 margin pnl, 並量度「ROLL 有冇被止蝕掃走」(risk 面)
 */
import * as fs from 'fs';

const pf = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const trades = (pf.realTrades || []).slice().sort((a, b) => (a.openedAt || 0) - (b.openedAt || 0));
const fmtT = (ts: number) => new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Hong_Kong', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const START = Date.parse('2026-08-31T00:00:00+08:00');
const LEV = 10;

async function getCandles(coin: string, startTs: number, endTs: number) {
  const raw = coin.includes(':') ? coin : `xyz:${coin}`;
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin: raw, interval: '5m', startTime: startTs, endTime: endTs } }),
    });
    const j = await r.json();
    return Array.isArray(j) && j.length ? j.sort((a: any, b: any) => a.t - b.t) : null;
  } catch { return null; }
}

// 1) cluster 定義: 同 symbol, 連續同向 exit_price_lock, 中間 gap < 6h
const locks = trades.filter(t => t.closeReason === 'exit_price_lock' && t.openedAt >= START && (t.pnlPct ?? 0) !== 0);
const done = new Set<string>();
const clusters: any[] = [];
for (const t of locks) {
  if (done.has(t.symbol + '|' + t.side)) continue;
  const sameDir = trades.filter(x =>
    x.symbol === t.symbol && x.side === t.side &&
    x.openedAt >= START - 6 * 3600_000 && x.closedAt && (x.closeReason === 'exit_price_lock') && (x.pnlPct !== 0));
  done.add(t.symbol + '|' + t.side);
  clusters.push({ symbol: t.symbol, side: t.side, members: sameDir });
}

function simulateRoll(entry: number, side: 'buy' | 'sell', candles: any[], openTs: number, endTs: number, oppOpenTs: number | null) {
  const dir = side === 'buy' ? 1 : -1;
  let sl = entry * (1 - dir * 0.015);            // 初始 SL 1.5% price
  let peak = entry; let breakevenArmed = false; let trailPct = 0;
  const startIdx = candles.findIndex(c => c.t >= openTs - 300_000);
  if (startIdx < 0) return { stop: false, stopPx: 0, finalPx: entry, pnlPct: 0, reason: 'no-candle' };
  const endIdx = endTs ? candles.findIndex(c => c.t >= endTs) : candles.length;
  const lastIdx = (endIdx > startIdx ? endIdx : candles.length) - 1;
  let exitPx: number | null = null; let exitReason = 'end';
  for (let i = startIdx; i <= lastIdx; i++) {
    const c = candles[i];
    if (c.t > (oppOpenTs ?? Infinity)) { // 反向信號離場
      exitPx = c.o; exitReason = 'opposite-signal'; break;
    }
    const hi = c.h, lo = c.l, clo = c.c;
    const mfe = (dir * (hi - entry)) / entry;
    peak = dir > 0 ? Math.max(peak, hi) : Math.min(peak, lo);
    // breakeven arm: MFE ≥ 0.5%
    if (!breakevenArmed && mfe >= 0.005) { sl = entry; breakevenArmed = true; }
    // trail: MFE ≥ 1% 後鎖 50%
    const peakMfe = dir > 0 ? (peak - entry) / entry : (entry - peak) / entry;
    if (peakMfe >= 0.01) sl = entry + dir * 0.5 * peakMfe * entry;
    if (breakevenArmed) sl = dir > 0 ? Math.max(sl, entry) : Math.min(sl, entry);
    if (dir > 0 && lo <= sl) { exitPx = sl; exitReason = 'sl-hit'; break; }
    if (dir < 0 && hi >= sl) { exitPx = sl; exitReason = 'sl-hit'; break; }
    exitPx = clo;
  }
  const pnlPct = ((exitPx! - entry) / entry) * dir * LEV * 100;
  return { stop: exitReason === 'sl-hit', stopPx: exitPx, finalPx: exitPx, pnlPct, reason: exitReason };
}

(async () => {
  const results = [];
  for (const cl of clusters) {
    const members = cl.members.filter(m => m.closedAt && m.pnlPct !== 0);
    if (!members.length) continue;
    const first = members[0];
    const last = members[members.length - 1];
    const actual = members.reduce((s, m) => s + (m.pnlPct ?? 0), 0) * 100;
    // 之後有冇反向信號（任何 closeReason 嘅反向 re-entry）
    const opp = trades.find(x => x.symbol === cl.symbol && x.side !== cl.side && x.openedAt > first.openedAt);
    const oppOpenTs = opp ? opp.openedAt : null;
    const candleStart = first.openedAt - 3600_000;
    const candleEnd = Math.max(Date.now(), last.closedAt!) + 12 * 3600_000;
    const candles = await getCandles(cl.symbol, candleStart, candleEnd);
    if (!candles) { console.log(`${cl.symbol} ${cl.side}: 無 candle，skip`); continue; }
    const roll = simulateRoll(first.entryPrice, cl.side, candles, first.openedAt, candleEnd, oppOpenTs);
    const delta = roll.pnlPct - actual;
    results.push({ symbol: cl.symbol, side: cl.side, n: members.length,
      actual, roll: roll.pnlPct, delta,
      rollExit: roll.reason, rollStopPx: roll.stop ? roll.stopPx : null,
      members: members.map(m => `${fmtT(m.openedAt)}→${fmtT(m.closedAt)} ${(m.pnlPct * 100).toFixed(1)}%`) });
  }
  console.log('=== ACTUAL(lock-churn 實現 margin%) vs ROLL(同一方向持倉+roll SL margin%) ===');
  for (const r of results) {
    console.log(`\n${r.symbol} ${r.side} (${r.n}單)`);
    r.members.forEach(m => console.log(`    ${m}`));
    console.log(`    ACTUAL=${r.actual.toFixed(1)}%  ROLL=${r.roll.toFixed(1)}%  Δ=${r.delta.toFixed(1)}pp  離場=${r.rollExit}${r.rollStopPx ? ` @${r.rollStopPx}` : ''}`);
  }
  const win = results.filter(r => r.delta > 0);
  const lose = results.filter(r => r.delta <= 0);
  console.log(`\n總計: ${results.length} clusters | ROLL 勝 ${win.length} | 輸/平 ${lose.length} | 累計 Δ ${results.reduce((s, r) => s + r.delta, 0).toFixed(1)}pp`);
})();
