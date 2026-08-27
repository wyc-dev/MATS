/**
 * P8 分佈偵測 v2:修正 MFE/MAE 單位（margin-basis %）+ 小時效應 + 深度 counterfactual。
 */
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const T = (d.realTrades ?? []).filter((x: any) => x.closedAt).sort((a: any, b: any) => a.closedAt - b.closedAt);
const pct = (x: any) => (x?.pnlPct ?? 0) * 100;
const stats = (a: number[]) => {
  if (!a.length) return { n: 0, mean: 0, sum: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { n: a.length, mean: +mean.toFixed(2), sum: +a.reduce((x, y) => x + y, 0).toFixed(1) };
};
const wr = (a: number[]) => (a.filter(x => x > 0).length / Math.max(1, a.length) * 100).toFixed(0);

// ── 4v2. MFE 回吐（margin-basis: max = MFE%, min = MAE%）──
console.log('4v2. 贏單 MFE 回吐（max=MFE% margin-basis）:');
const givebacks = T.filter((t: any) => pct(t) > 0 && typeof t.maxValueReached === 'number' && Number.isFinite(t.maxValueReached) && t.maxValueReached < 90)
  .map((t: any) => ({ sym: t.symbol, realized: pct(t), mfe: t.maxValueReached, gb: t.maxValueReached - pct(t), reason: t.closeReason, heldMin: (t.closedAt - t.openedAt) / 60000 }));
const legit = givebacks.filter(g => g.gb > 0.5);
console.log(`   贏單中回吐 >0.5pp: ${legit.length} 喂,合計 ${legit.reduce((a, g) => a + g.gb, 0).toFixed(1)}pp`);
for (const g of [...legit].sort((a, b) => b.gb - a.gb).slice(0, 10)) {
  console.log(`     ${g.sym.padEnd(12)} ${g.reason.padEnd(16)} MFE ${g.mfe.toFixed(1)}% → 實收 ${g.realized.toFixed(1)}% (畀返 ${g.gb.toFixed(1)}pp, 持倉 ${g.heldMin.toFixed(0)}min)`);
}

// ── 10v2. 小時效應（修正 bug）──
console.log('\n10v2. 開倉小時（UTC）EV（n≥4）:');
const byHour: Record<number, number[]> = {};
for (const t of T) { const h = new Date(t.openedAt).getUTCHours(); (byHour[h] ??= []).push(pct(t)); }
const hourRows = Object.entries(byHour).map(([h, a]) => ({ h: +h, n: a.length, mean: stats(a).mean, wr: wr(a) })).filter(r => r.n >= 4).sort((x, y) => y.mean - x.mean);
for (const r of [...hourRows.slice(0, 4), ...hourRows.slice(-4)]) console.log(`   ${String(r.h).padStart(2)}:00 UTC  n=${String(r.n).padStart(3)}  EV=${String(r.mean).padStart(6)}%  WR=${r.wr}%`);

// ── 11. sl_tp 深挖——58 喺 SL 漏水嘅結構 ──
console.log('\n11. sl_tp 58 喺（sum -312pp 最大漏水點）:');
const sl = T.filter((t: any) => t.closeReason === 'sl_tp');
const slBySym: Record<string, number[]> = {};
for (const t of sl) (slBySym[t.symbol] ??= []).push(pct(t));
for (const [k, a] of Object.entries(slBySym).sort((x, y) => y[1].length - x[1].length)) console.log(`   ${k.padEnd(16)} n=${String(a.length).padStart(3)}  sum=${stats(a).sum}%  avg=${stats(a).mean}%`);
// SL 喺 MAE 分析——SL 幾闊先啱
const slMae = sl.filter((t: any) => typeof t.minValueReached === 'number' && t.minValueReached > 0 && t.minValueReached < 90).map((t: any) => t.minValueReached);
slMae.sort((a, b) => a - b);
console.log(`   SL 喺 MAE 分佈: p25=${slMae[Math.floor(slMae.length*0.25)]?.toFixed(2)}%  median=${slMae[Math.floor(slMae.length/2)]?.toFixed(2)}%  p75=${slMae[Math.floor(slMae.length*0.75)]?.toFixed(2)}%  p95=${slMae[Math.floor(slMae.length*0.95)]?.toFixed(2)}%`);

// ── 12. reversal_point 12 喺全蝕——MAE 有幾深先出場 ──
console.log('\n12. reversal_point 12 喺（WR 0%——出場訊號太遲？）:');
for (const t of T.filter((x: any) => x.closeReason === 'reversal_point')) {
  console.log(`   ${t.symbol.padEnd(14)} ${t.side} pnl=${pct(t).toFixed(2)}%  MAE=${t.minValueReached ?? '?'}%  MFE=${t.maxValueReached ?? '?'}%  持倉${((t.closedAt - t.openedAt) / 60000).toFixed(0)}min`);
}

// ── 13. <15m 快蝕單結構（33 喂 sum -36.9pp）──
console.log('\n13. <15m 快出場單（EV -1.12%, WR 27%）:');
const fast = T.filter((t: any) => (t.closedAt - t.openedAt) < 15 * 60000);
const fastByReason: Record<string, number[]> = {};
for (const t of fast) (fastByReason[t.closeReason || '?'] ??= []).push(pct(t));
for (const [r, a] of Object.entries(fastByReason)) console.log(`   ${r.padEnd(16)} n=${String(a.length).padStart(3)}  sum=${stats(a).sum}%  WR=${wr(a)}%`);

// ── 14. 最近 50 喂退化根因（-38.6pp）──
console.log('\n14. 最近 50 喂退化分解:');
const R = T.slice(-50);
const rBySym: Record<string, number[]> = {};
for (const t of R) (rBySym[t.symbol] ??= []).push(pct(t));
for (const [k, a] of Object.entries(rBySym).sort((x, y) => stats(x[1]).sum - stats(y[1]).sum)) console.log(`   ${k.padEnd(16)} n=${String(a.length).padStart(3)}  sum=${String(stats(a).sum).padStart(7)}%  WR=${wr(a)}%`);
const rByDate: Record<string, number[]> = {};
for (const t of R) { const day = new Date(t.closedAt).toISOString().slice(0, 10); (rByDate[day] ??= []).push(pct(t)); }
console.log('   按日期:');
for (const [day, a] of Object.entries(rByDate)) console.log(`   ${day}  n=${String(a.length).padStart(3)}  sum=${String(stats(a).sum).padStart(7)}%`);

// ── 15. btc|buy 最好 EV +4.42%——trade 幾多同幾時 ──
console.log('\n15. btc|buy 25 喺分佈（EV +4.42% 最強 edge）:');
const btcBuys = T.filter((t: any) => t.symbol === 'btc' && t.side === 'buy');
const btcDays = btcBuys.map((t: any) => new Date(t.openedAt).toISOString().slice(0, 10));
console.log(`   日期範圍: ${btcDays[0]} → ${btcDays[btcDays.length - 1]};最近一喺: ${btcDays[btcDays.length - 1]}`);
console.log(`   closeReason:`, JSON.stringify(btcBuys.reduce((acc: any, t: any) => { acc[t.closeReason] = (acc[t.closeReason] ?? 0) + 1; return acc; }, {})));

// ── 16. OLR 0.1-0.2 bucket 喂——60+65 喺低 OLR 入場,有幾多蝕 ──
console.log('\n16. OLR P(win)<0.2 嘅 125 喺（低概率入場）:');
const lowOlr = T.filter((t: any) => typeof t.entryOlrPWin === 'number' && t.entryOlrPWin < 0.2);
console.log(`   n=${lowOlr.length}  sum=${stats(lowOlr.map(pct)).sum}%  WR=${wr(lowOlr.map(pct))}%`);
// 如果 OLR<0.2 全部唔開倉嘅 counterfactual
console.log(`   → counterfactual: 剷走呢 ${lowOlr.length} 喂 = 總 PnL 由 155.1 → ${(155.1 - stats(lowOlr.map(pct)).sum).toFixed(1)}pp`);
const postP1 = T.filter((t: any) => t.closedAt > Date.parse('2026-08-26T12:00:00Z'));
console.log(`\n   P1 之後（P1 backfill 有 entryOlrPWin）嘅 trade: ${postP1.length} 喂`);
const lowOlrRecent = postP1.filter((t: any) => typeof t.entryOlrPWin === 'number' && t.entryOlrPWin < 0.2);
console.log(`   其中 OLR<0.2: ${lowOlr.length} 喺全部、最近期 ${lowOlr.filter((t: any) => t.closedAt > Date.parse('2026-08-26T12:00:00Z')).length} 喺——P2 EV gate 之後低 OLR 入場有冇收斂？`);