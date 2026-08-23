/**
 * buy-bias-diagnosis.ts — Phase 1: 根因定量驗證
 *
 * 驗證目標:
 *  1.1 FP 幻覺: parse 每筆 trade entryThesis 的 First-Passage P(win)/edge → 分桶 vs 實際 win rate
 *  1.2 Sell 壓制: buy/sell 分佈、claimed edge、regime 分佈
 *  1.3 BNB SL 校準: SL 觸發位置、蝕幅分佈
 *
 * 用法: npx tsx scripts/buy-bias-diagnosis.ts
 */
import * as fs from 'node:fs';

const statePath = process.argv[2] ?? 'data/evolution/portfolio-state.json';
const p = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const trades = p.realTrades ?? [];

interface Parsed {
  fpLongPct?: number;   // First-Passage LONG P(win) %
  fpShortPct?: number;  // First-Passage SHORT P(win) %
  fpLongEdge?: number;  // LONG edge pp
  fpShortEdge?: number; // SHORT edge pp
  olrPWin?: number;     // OLR P(win) %
  regime?: string;
  backfillOnly?: boolean;
}

function parseThesis(th: string): Parsed {
  const out: Parsed = {};
  let m = th.match(/[Ff]irst[- ]?[Pp]assage[^)]{0,40}LONG\s*P=(\d{1,3})%/);
  if (m) out.fpLongPct = Number(m[1]);
  m = th.match(/[Ff]irst[- ]?[Pp]assage[^)]{0,40}SHORT\s*P=(\d{1,3})%/);
  if (m) out.fpShortPct = Number(m[1]);
  const longEdge = th.match(/LONG[^)]{0,60}?edge\s+([+-]\d+)pp/);
  const shortEdge = th.match(/SHORT[^)]{0,60}?edge\s+([+-]\d+)pp/);
  if (longEdge) out.fpLongEdge = Number(longEdge[1]);
  if (shortEdge) out.fpShortEdge = Number(shortEdge[1]);
  const olrBuy = th.match(/OLR BUY P\(win\)=(\d{1,3})%/);
  const olrSell = th.match(/OLR SELL P\(win\)=(\d{1,3})%/);
  if (olrBuy) out.olrPWin = Number(olrBuy[1]);
  if (olrSell) out.olrPWin = Number(olrSell[1]);
  if (/TRENDING_BULL|trending_bull/i.test(th)) out.regime = 'trending_bull';
  else if (/TRENDING_BEAR|trending_bear/i.test(th)) out.regime = 'trending_bear';
  else if (/mean[-_ ]?revert/i.test(th)) out.regime = 'mean_reverting';
  else if (/high_volatility|HIGH VOL/i.test(th)) out.regime = 'high_volatility';
  else if (/low_volatility|LOW VOL/i.test(th)) out.regime = 'low_volatility';
  else out.regime = 'unknown';
  if (/backfill/i.test(th)) out.backfillOnly = true;
  return out;
}

interface Row { t: any; pa: Parsed; win: boolean; pnl: number; }

const rows: Row[] = trades.map((t: any) => ({
  t,
  pa: parseThesis(String(t.entryThesis ?? '')),
  win: Number(t.pnl) > 0,
  pnl: Number(t.pnl),
}));

function bucketStats(rowsIn: Row[], label: string, get: (r: Row) => number | undefined, buckets: Array<[string, (n: number) => boolean]>): void {
  console.log(`\n=== ${label} ===`);
  for (const [name, pred] of buckets) {
    const sel = rowsIn.filter(r => { const v = get(r); return v !== undefined && pred(v); });
    if (sel.length === 0) { console.log(`  ${name}: n=0`); continue; }
    const wr = sel.filter(r => r.win).length / sel.length * 100;
    const avgPnl = sel.reduce((s, r) => s + r.pnl, 0) / sel.length * 100;
    console.log(`  ${name}: n=${sel.length} WR=${wr.toFixed(1)}% avgPnl$${avgPnl.toFixed(2)}`);
  }
}

console.log('================ 1.1 FP 幻覺驗證 ================');
const fpBuckets: Array<[string, (n: number) => boolean]> = [
  ['FP LONG P >= 95%', n => n >= 95],
  ['FP LONG P 80-94%', n => n >= 80 && n < 95],
  ['FP LONG P 60-79%', n => n >= 60 && n < 80],
  ['FP LONG P < 60%', n => n < 60],
];
bucketStats(rows, 'FP LONG claimed P vs 實際 WR (all trades)', r => r.pa.fpLongPct, fpBuckets);
bucketStats(rows.filter(r => r.t.side === 'buy'), 'FP LONG claimed P vs BUY trades', r => r.pa.fpLongPct, fpBuckets);
bucketStats(rows.filter(r => r.t.side === 'sell'), 'FP SHORT claimed P vs SELL trades', r => r.pa.fpShortPct, [
  ['FP SHORT P >= 90%', n => n >= 90],
  ['FP SHORT P 60-89%', n => n >= 60 && n < 90],
  ['FP SHORT P < 60%', n => n < 60],
]);

console.log('\n=== OLR P(win) claimed vs outcome (BUY) ===');
bucketStats(rows.filter(r => r.t.side === 'buy'), 'OLR P(win) on BUY trades', r => r.pa.olrPWin, [
  ['OLR >= 50%', n => n >= 50],
  ['OLR 40-49%', n => n >= 40 && n < 50],
  ['OLR < 40%', n => n < 40],
  ['OLR unknown', n => n === undefined],
]);

console.log('\n================ 1.2 Sell 壓制 ================');
const sells = rows.filter(r => r.t.side === 'sell');
const buys = rows.filter(r => r.t.side === 'buy');
console.log(`BUY n=${buys.length} WR=${((buys.filter(r => r.win).length / Math.max(1, buys.length)) * 100).toFixed(1)}% avgPnl$${(buys.reduce((s, r) => s + r.pnl, 0) / Math.max(1, buys.length)).toFixed(3)}`);
console.log(`SELL n=${sells.length} WR=${((sells.filter(r => r.win).length / Math.max(1, sells.length)) * 100).toFixed(1)}% avgPnl$${(sells.reduce((s, r) => s + r.pnl, 0) / Math.max(1, sells.length)).toFixed(3)}`);
console.log('SELL trades 的 FP/OLR claimed data:');
for (const r of sells.slice(-12)) {
  console.log(`  ${new Date(r.t.closedAt).toISOString().slice(0, 10)} ${r.t.symbol} win=${r.win} FP_S=${r.pa.fpShortPct ?? '?'}% FP_L=${r.pa.fpLongPct ?? '?'}% regime=${r.pa.regime}`);
}

console.log('\n=== regime x side ===');
const regimeBy: Record<string, Record<string, { n: number; win: number }>> = {};
for (const r of rows) {
  const rg = r.pa.regime ?? 'unknown';
  regimeBy[rg] = regimeBy[rg] ?? {};
  regimeBy[rg][r.t.side] = regimeBy[rg][r.t.side] ?? { n: 0, win: 0 };
  regimeBy[rg][r.t.side].n++;
  if (r.win) regimeBy[rg][r.t.side].win++;
}
for (const [rg, sides] of Object.entries(regimeBy)) {
  const parts = Object.entries(sides).map(([side, s]) => `${side}${s.n}(${((s.win / s.n) * 100).toFixed(0)}%)`);
  console.log(`  ${rg}: ${parts.join('  ')}`);
}

console.log('\n================ 1.3 BNB SL 校準 ================');
const bnb = rows.filter(r => r.t.symbol === 'bnb');
for (const r of bnb.slice(-12)) {
  console.log(`  ${new Date(r.t.closedAt).toISOString().slice(0, 16)} ${r.t.side} entry=${r.t.entryPrice} exit=${r.t.exitPrice} pnl$${(r.pnl * 100).toFixed(2)}% reason=${r.t.closeReason}`);
}
const slHits = bnb.filter(r => r.t.closeReason === 'sl_tp');
console.log(`BNB sl_tp count: ${slHits.length}`);
if (slHits.length > 0) {
  const pnlPcts = slHits.map(r => r.pnl);
  const avg = pnlPcts.reduce((s, v) => s + v, 0) / pnlPcts.length;
  const entryAvg = slHits.reduce((s, r) => s + Number(r.t.entryPrice), 0) / slHits.length;
  const exitAvg = slHits.reduce((s, r) => s + Number(r.t.exitPrice), 0) / slHits.length;
  console.log(`  avg pnl$${avg.toFixed(3)} (entry ${entryAvg.toFixed(1)} → exit ${exitAvg.toFixed(1)})`);
  console.log(`  price-basis SL ≈ ${(((exitAvg - entryAvg) / entryAvg) * 100).toFixed(2)}%`);
}
console.log('\n=== 最後 35 筆 claimed FP LONG P 分佈 ===');
const last35 = rows.slice(-35);
const ge90 = last35.filter(r => r.pa.fpLongPct !== undefined && r.pa.fpLongPct >= 90).length;
const ge99 = last35.filter(r => r.pa.fpLongPct !== undefined && r.pa.fpLongPct >= 99).length;
console.log(`  FP LONG >=90%: ${ge90}/35, >=99%: ${ge99}/35`);
