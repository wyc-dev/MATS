/**
 * p9-multiplier-ablation.ts — 乘數鏈消融診斷（PLAN_multiplier-ablation.md, 2026-09-05）
 * 用 component-attribution live records (cycleId>0) 做:
 *   Step1: tradeId group → trade 層乘數向量 + pnl
 *   Step2: per-gate 出手命中（出手組 avg pnl/WR vs 全場——分辨力）
 *   Step3: gate 兩兩同現（Jaccard）+ 累積 shrink 深度 vs pnl
 *   Step4: 敏感性（mult<0.95 出手定義）+ 誠實限制
 * 紀律: 零 look-ahead（attribution 係開倉時記錄 + 平倉後 pnl——事後分析用）
 */
import * as fs from 'node:fs';

interface Rec { componentId?: string; tradeId?: string; symbol?: string; side?: string; cycleId?: number; signal?: number; pnlPct?: number; }
const d = JSON.parse(fs.readFileSync('data/evolution/component-attribution.json', 'utf-8'));
const R = (d.records ?? []) as Rec[];
const live = R.filter((r) => typeof r.cycleId === 'number' && r.cycleId > 0);
const gate = live.filter((r) => String(r.componentId ?? '').startsWith('gate:') && r.tradeId);
console.log(`records: ${R.length} | live: ${live.length} | gate×live: ${gate.length}`);

// ── Step 1: tradeId group ──
const byTrade = new Map<string, Map<string, number>>();
const tradePnl = new Map<string, number>();
for (const r of gate) {
  if (!byTrade.has(r.tradeId!)) byTrade.set(r.tradeId!, new Map());
  byTrade.get(r.tradeId!)!.set(String(r.componentId), Number(r.signal) ?? 1);
  tradePnl.set(r.tradeId!, r.pnlPct ?? 0);
}
const multi = [...byTrade.entries()].filter(([, m]) => m.size >= 2);
console.log(`trade 層: ${byTrade.size} trades | ≥2 gate records: ${multi.length} (${(multi.length / Math.max(1, byTrade.size) * 100).toFixed(0)}%)`);

// 全場 avg（per-trade）
const allPnl = [...byTrade.keys()].map((tid) => tradePnl.get(tid)!);
const avgAll = allPnl.reduce((a, b) => a + b, 0) / allPnl.length * 100;
const wrAll = allPnl.filter((p) => p > 0).length / allPnl.length * 100;

// ── Step 2: per-gate 出手命中 ──
const gateTotals = new Map<string, { n: number; act: number }>();
for (const r of gate) { const g = gateTotals.get(String(r.componentId)); if (g) { g.n++; if (r.signal !== 1) g.act++; } else gateTotals.set(String(r.componentId), { n: 1, act: r.signal !== 1 ? 1 : 0 }); }

console.log(`\n=== Step 2: Per-gate 出手命中（出手組 avg pnl vs 全場 ${avgAll.toFixed(2)}%）===\n`);
console.log(`gate`.padEnd(50), `n  act%  actAvg  actWR  vsAll  ε`);
const rows: Array<{ k: string; n: number; actPnl: number[]; actWin: number }> = [];
for (const [k, v] of gateTotals) {
  if (v.n < 5) continue;
  const actRecs = gate.filter((r) => String(r.componentId) === k && r.signal !== 1 && tradePnl.has(r.tradeId!));
  const pnls = actRecs.map((r) => tradePnl.get(r.tradeId!)! * 100);
  if (!pnls.length) continue;
  const actAvg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const actWr = pnls.filter((p) => p > 0).length / pnls.length * 100;
  const short = k.length > 48 ? k.slice(0, 47) + '…' : k;
  const verdict = actAvg < avgAll * 0.7 ? '✅ 有效' : actAvg > avgAll * 1.2 ? '🔴 誤傷?' : '⚠️ 近全場';
  console.log(short.padEnd(50), String(v.n).padStart(2), String(Math.round(v.act / v.n * 100)).padStart(4) + '%', actAvg.toFixed(2).padStart(7) + '%', actWr.toFixed(0).padStart(5) + '%', (actAvg - avgAll).toFixed(2).padStart(6), verdict);
  rows.push({ k, n: v.n, actPnl: pnls, actWin: pnls.filter((p) => p > 0).length });
}

// ── Step 3: 兩兩同現（multi-gate trades）──
console.log(`\n=== Step 3: Gate 兩兩同現（Jaccard, 限 ≥2 gate 出手率 50%+ 嘅 gate）===\n`);
const topGates = [...gateTotals.entries()].filter(([, v]) => v.n >= 5 && v.act / v.n >= 0.5).map(([k]) => k);
const pairOut: Array<[string, string, number]> = [];
for (let i = 0; i < topGates.length; i++) {
  for (let j = i + 1; j < topGates.length; j++) {
    let both = 0, either = 0;
    for (const [, m] of multi) {
      const a = m.get(topGates[i]) !== undefined && m.get(topGates[i]) !== 1;
      const b = m.get(topGates[j]) !== undefined && m.get(topGates[j]) !== 1;
      if (a || b) either++;
      if (a && b) both++;
    }
    if (either >= 5) pairOut.push([topGates[i].slice(0, 22), topGates[j].slice(0, 22), both / either]);
  }
}
pairOut.sort((a, b) => b[2] - a[2]).slice(0, 10).forEach(([a, b, j]) => {
  console.log(`  ${a.padEnd(24)} × ${b.padEnd(24)} Jaccard=${(j * 100).toFixed(0)}%${j > 0.7 ? ' 🔁 重複懲罰候選' : ''}`);
});
if (!pairOut.length) console.log('  （冇 ≥5 同現 trade 的 gate pair）');

// 累積 shrink 深度（multi-gate trades）
console.log(`\n=== Step 3b: 累積 shrink 深度 vs pnl（multi-gate trades）===`);
const depth: Array<{ cum: number; pnl: number }> = [];
for (const [tid, m] of multi) {
  let cum = 1;
  for (const mult of m.values()) if (mult !== 1) cum *= mult;
  depth.push({ cum, pnl: tradePnl.get(tid)! * 100 });
}
for (const [name, lo, hi] of [['重收縮 <0.5', 0, 0.5], ['中 0.5-0.8', 0.5, 0.8], ['輕 >0.8', 0.8, Infinity]]) {
  const g = depth.filter((x) => x.cum >= lo && x.cum < hi);
  if (!g.length) continue;
  const a = g.reduce((s, x) => s + x.pnl, 0) / g.length;
  const w = g.filter((x) => x.pnl > 0).length / g.length * 100;
  console.log(`  ${name.padEnd(14)} n=${String(g.length).padStart(3)} avg=${a.toFixed(2)}% WR=${w.toFixed(0)}% vs 全場 ${avgAll.toFixed(2)}%`);
}

// ── Step 4: 敏感性（mult<0.95 定義）──
const actStrict = rows.filter((r) => r.n >= 15).map((r) => ({ k: r.k.slice(0, 44), n: r.n, avg: (r.actPnl.reduce((a, b) => a + b, 0) / r.actPnl.length).toFixed(2) }));
console.log(`\n=== Step 4: n≥15 gate 裁決候選 ===`);
if (!actStrict.length) console.log('  （冇 gate n≥15——全部樣本不足, 唔做單 gate 裁決）');
actStrict.forEach((x) => console.log(`  ${x.k.padEnd(46)} n=${String(x.n).padStart(2)} 出手組 avg=${x.avg}%`));

console.log(`\n（誠實限制: attribution live records 時間窗 ~1006 records; per-gate n 細; GOT entry-gate 未分開——本診斷係結構性 proxy, 唔係完整決策重播）`);
