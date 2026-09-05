/** P9-attrib 檢定:per-gate 乘數 vs 實際交易結果 Spearman——「逆 edge 閘」LOUD。 */
import fs from 'node:fs';
import { avgRankSpearman } from '../src/analysis/rank-correlation.ts';
const d = JSON.parse(fs.readFileSync('data/evolution/component-attribution.json', 'utf-8'));
const R: any[] = d.records ?? [];
// 按 componentId 分組（gate:* 為閘乘數歸因）
const byGate: Record<string, Array<{ mult: number; pnl: number }>> = {};
for (const r of R) {
  // V3 硬化（attack-round6）: persisted records 污染可能含 null/garbage element
  if (!r || typeof r !== 'object') continue;
  const c = String(r.componentId ?? '');
  if (!c.startsWith('gate:')) continue;
  (byGate[c] ??= []).push({ mult: Number(r.signal), pnl: (r.pnlPct ?? 0) * 100 });
}
console.log('=== Per-gate 乘數有效性檢定 ===');
console.log('gate                          n    sum(pp)  avg     WR    ρ(mult,pnl)');
for (const [k, arr] of Object.entries(byGate)) {
  if (arr.length < 5) { console.log(`   ${k.padEnd(30)} n=${arr.length}（樣本不足）`); continue; }
  const rho = avgRankSpearman(arr.map(a => a.mult), arr.map(a => a.pnl));
  const sum = arr.reduce((s, a) => s + a.pnl, 0);
  const flag = rho === null ? ' ⚠️ 零變異（常數/不足）' : Math.abs(rho) < 0.1 ? ' ⚠️ NOISE-FLAG' : '';
  console.log(`   ${k.padEnd(30)} n=${String(arr.length).padStart(3)} sum=${(sum >= 0 ? '+' : '') + sum.toFixed(1).padStart(7)}pp ρ=${rho === null ? 'undefined'.padEnd(7) : rho.toFixed(3)}${flag}`);
}
