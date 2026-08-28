/** P9-attrib 檢定:per-gate 乘數 vs 實際交易結果 Spearman——「逆 edge 閘」LOUD。 */
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('data/evolution/component-attribution.json', 'utf-8'));
const R: any[] = d.records ?? [];
// 按 componentId 分組（gate:* 為閘乘數歸因）
const byGate: Record<string, Array<{ mult: number; pnl: number }>> = {};
for (const r of R) {
  const c = String(r.componentId ?? '');
  if (!c.startsWith('gate:')) continue;
  (byGate[c] ??= []).push({ mult: Number(r.signal), pnl: (r.pnlPct ?? 0) * 100 });
}
function spearman(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 5) return NaN;
  const rx = x.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ry = y.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const a1 = new Array(n), b1 = new Array(n);
  rx.forEach((o, j) => (a1[o.i] = j + 1));
  ry.forEach((o, j) => (b1[o.i] = j + 1));
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (a1[i] - b1[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
console.log('=== Per-gate 乘數有效性檢定 ===');
console.log('gate                          n    sum(pp)  avg     WR    ρ(mult,pnl)');
for (const [k, arr] of Object.entries(byGate)) {
  if (arr.length < 5) { console.log(`   ${k.padEnd(30)} n=${arr.length}（樣本不足）`); continue; }
  const rho = spearman(arr.map(a => a.mult), arr.map(a => a.pnl));
  const sum = arr.reduce((s, a) => s + a.pnl, 0);
  const flag = Math.abs(rho) < 0.1 ? ' ⚠️ NOISE-FLAG' : '';
  console.log(`   ${k.padEnd(30)} n=${String(arr.length).padStart(3)} sum=${(sum >= 0 ? '+' : '') + sum.toFixed(1).padStart(7)}pp ρ=${rho.toFixed(3)}${flag}`);
}
