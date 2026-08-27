/**
 * P9 審計:exploration trade 流水線——謹慎及詳盡驗證絕對盈利成效。
 *
 * 分類:thesis 標記 "exploration trade (" = exploration;其餘按 OLR/大小近似。
 * 反事實:P8 新閘（5m 方向 + OLR<0.35）對 exploration 單嘅影響。
 */
import fs from 'node:fs';

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const T: any[] = (state.realTrades ?? []).filter((t: any) => t.closedAt).sort((a, b) => a.closedAt - b.closedAt);

const pct = (t: any) => (t.pnlPct ?? 0) * 100;
const st = (a: any[]) => {
  const p = a.map(pct);
  const wins = p.filter(x => x > 0), losses = p.filter(x => x <= 0);
  const mean = (x: number[]) => x.length ? +(x.reduce((s, v) => s + v, 0) / x.length).toFixed(2) : 0;
  return {
    n: a.length, sum: +p.reduce((s, v) => s + v, 0).toFixed(1),
    wr: +(wins.length / Math.max(1, p.length) * 100).toFixed(0),
    avgWin: mean(wins), avgLoss: mean(losses),
    p95: p.length ? +[...p].sort((x, y) => x - y)[Math.floor(p.length * 0.95)].toFixed(1) : 0,
  };
};

const EXP = T.filter((t: any) => (t.entryThesis ?? '').includes('exploration trade ('));
const NON = T.filter((t: any) => !(t.entryThesis ?? '').includes('exploration trade ('));

console.log('═══ 1. Exploration vs Consensus 全史 ═══');
console.log('Exploration:', JSON.stringify(st(EXP)));
console.log('其他路徑    :', JSON.stringify(st(NON)));
const expLast20 = st(EXP.slice(-20));
console.log('Exploration 最近20單:', JSON.stringify(expLast20));

console.log('\n═══ 2. Exploration PnL 分佈（尾部結構）═══');
const expP = EXP.map(pct).sort((a, b) => a - b);
console.log(`   min=${expP[0]?.toFixed(1)} p25=${expP[Math.floor(EXP.length * 0.25)]?.toFixed(1)} med=${expP[Math.floor(EXP.length / 2)]?.toFixed(1)} p75=${expP[Math.floor(EXP.length * 0.75)]?.toFixed(1)} max=${expP[EXP.length - 1]?.toFixed(1)}`);
const bigW = EXP.filter((t: any) => pct(t) >= 10);
const bigL = EXP.filter((t: any) => pct(t) <= -5);
console.log(`   ≥10pp 贏單: ${bigW.length} 喺（合計 ${bigW.reduce((s, t) => s + pct(t), 0).toFixed(1)}pp）`);
console.log(`   ≤−5pp 蝕單: ${bigL.length} 喺（合計 ${bigL.reduce((s, t) => s + pct(t), 0).toFixed(1)}pp）`);
console.log('   大贏:', bigW.slice(-5).map((t: any) => `${t.symbol} +${pct(t).toFixed(1)}`).join(', '));
console.log('   大蝕:', bigL.slice(-5).map((t: any) => `${t.symbol} ${pct(t).toFixed(1)}`).join(', '));

console.log('\n═══ 3. 方向/符號分佈（BUY bias 檢查）═══');
const byDir: Record<string, any[]> = {};
for (const t of EXP) { const k = t.side === 'buy' ? 'buy' : 'sell'; (byDir[k] ??= []).push(t); }
for (const [k, a] of Object.entries(byDir)) console.log(`   ${k}: ${JSON.stringify(st(a))}`);
const bySym: Record<string, any[]> = {};
for (const t of EXP) (byDir[`sym:${t.symbol}`] ??= []).push(t);
const symRows = Object.entries(byDir).map(([k, a]) => ({ k, ...st(a) })).filter(r => r.n >= 3).sort((x, y) => y.sum - x.sum);
for (const r of symRows.slice(0, 6)) console.log(`   ${r.k.padEnd(14)} n=${String(r.n).padStart(3)} sum=${String(r.sum).padStart(7)}pp WR=${r.wr}%`);

console.log('\n═══ 4. P8 新閘反事實（exploration 單）═══');
// 4a: OLR 閘——exploration 喺嘅 entryOlrPWin
const withOlr = EXP.filter((t: any) => typeof t.entryOlrPWin === 'number' && t.entryOlrPWin > 0);
if (withOlr.length) {
  const blocked = withOlr.filter((t: any) => t.entryOlrPWin < 0.35);
  const passed = withOlr.filter((t: any) => t.entryOlrPWin >= 0.35);
  console.log(`有 OLR 記錄: ${withOlr.length}/${EXP.length}`);
  console.log(`  OLR<0.35 會被擋: ${blocked.length} 喺, PnL ${blocked.reduce((s, t) => s + pct(t), 0).toFixed(1)}pp, WR ${st(blocked).wr}%`);
  console.log(`  OLR≥0.35 放行: ${passed.length} 喺, PnL ${passed.reduce((s, t) => s + pct(t), 0).toFixed(1)}pp, WR ${st(passed).wr}%`);
} else console.log('（exploration 喺冇 OLR 記錄）');

// 4b: 5m 斜率代理——用 entryMarketFeatures.momentumShort(15m)
const m5 = EXP.filter((t: any) => typeof t.entryMarketFeatures?.momentumShort === 'number');
const blocked5 = m5.filter((t: any) => (t.side === 'buy' && t.entryMarketFeatures.momentumShort < -0.0005) || (t.side === 'sell' && t.entryMarketFeatures.momentumShort > 0.0005));
console.log(`\n5m/15m 逆勢代理: ${m5.length} 喺有 momentumShort; 逆勢 ${blocked5.length} 喺, 其 PnL ${blocked5.reduce((s, t) => s + pct(t), 0).toFixed(1)}pp`);

console.log('\n═══ 5. Exploration 學習數據產出（成本效益第二維）═══');
const expByMonth: Record<string, number> = {};
for (const t of EXP) { const m = new Date(t.openedAt).toISOString().slice(0, 7); expByMonth[m] = (expByMonth[m] ?? 0) + 1; }
console.log('   按月:', JSON.stringify(expByMonth));
console.log(`   purpose: EXP cluster 學習 + OLR sell 樣本回流 + shadow 校準——PnL 係學費唔係工資`);