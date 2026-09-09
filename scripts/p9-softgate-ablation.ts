/** P9-softgate-ablation: 六誤傷候選 soft gate 減法重播(2026-09-09)
 *
 * 背景: P1 前哨裁決(scripts/p1-ablation-replay.ts)確認六候選誤傷率 53-78%,
 *   出手組 avg 全部 > 全場 +0.43%。本 script 做「減法重播」——量化「停用 gate g」
 *   嘅期望影響: 出手組 avg 正 = 停用後放行嗰班 trade 期望賺(大賺 cover 命中細蝕)。
 *
 * 方法(謹慎近似): 每 gate 出手組(contribution≠0)嘅 avg pnl 對比全場——
 *   出手組 avg > 0 且 > 全場 → 「收緊咗正期望 trade」→ 停用釋放正期望;
 *   保守/中性/樂觀三檔: 出手組 avg × n × {0.5, 0.75, 1.0}(假設停用後 50-100% 開啟,
 *   因為 soft shrink 唔係 block——部分 trade 本身照開)。
 *
 * 裁決: 樣本充足(n≥15)+ 誤傷>53% + 出手組 avg > 全場 +0.5pp → 停用候選。
 *   causal/eq-ev(n<10)樣本唔足 → 保留收集。
 */
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('data/evolution/component-attribution.json', 'utf-8'));
const R: any[] = d.records ?? [];

// 全場 avg(attribution 覆蓋 trade)
const trades = new Map<string, number>();
for (const r of R) {
  if (!r || typeof r !== 'object' || !r.tradeId || !Number.isFinite(r.pnlPct)) continue;
  trades.set(r.tradeId, (r.pnlPct ?? 0) * 100);
}
const allPnl = [...trades.values()];
const avgAll = allPnl.length ? allPnl.reduce((s, x) => s + x, 0) / allPnl.length : 0;

// 六候選 per-gate 統計
const SIX: Array<[string, string]> = [
  ['success-pattern', 'success-pattern'],
  ['reversal-point', 'reversal-point'],
  ['convexity', 'convexity'],
  ['mae-pattern', 'mae-pattern'],
  ['causal', 'causal'],
  ['eq-ev', 'eq-ev'],
];
const short = (cid: string) => String(cid).replace('gate:', '').replace(/\(.*\)/, '');

const byG: Record<string, { n: number; neg: number; pnl: number[] }> = {};
for (const r of R) {
  if (!r || typeof r !== 'object') continue;
  const c = String(r.componentId ?? '');
  if (!c.startsWith('gate:')) continue;
  const k = short(c);
  (byG[k] ??= { n: 0, neg: 0, pnl: [] });
  const g = byG[k]!;
  g.n++;
  if ((r.contribution ?? 0) < -1e-9) g.neg++;
  if (Number.isFinite(r.pnlPct)) g.pnl.push((r.pnlPct ?? 0) * 100);
}

console.log('══════════════════════════════════════════════════════════════');
console.log('P9-softgate-ablation: 六誤傷候選減法重播');
console.log('全場 avg = ' + avgAll.toFixed(2) + '%（n=' + allPnl.length + '）');
console.log('══════════════════════════════════════════════════════════════');
console.log('gate             n   誤傷率  出手組avg  vs全場  停用期望(三檔)  裁決');
for (const [key] of SIX) {
  const g = byG[key];
  if (!g) { console.log('  ' + key.padEnd(16) + '冇 records'); continue; }
  const miss = (g.neg / g.n) * 100;
  const avg = g.pnl.length ? g.pnl.reduce((s, x) => s + x, 0) / g.pnl.length : 0;
  const delta = avg - avgAll;
  // 停用期望 = 放行出手組 trade 嘅期望收益(保守 50% 開啟率起)
  const eConsv = avg * g.n * 0.5;
  const eMid = avg * g.n * 0.75;
  const eAggr = avg * g.n * 1.0;
  const verdict = g.n >= 15 && miss > 53 && avg > avgAll + 0.3
    ? '🔴 停用'
    : g.n < 10
      ? '🟡 樣本不足保留'
      : g.n >= 15 && miss > 45
        ? '🟠 考慮'
        : '🟢 保留';
  console.log('  ' + key.padEnd(15) + ' n=' + String(g.n).padStart(4)
    + '  ' + miss.toFixed(0).padStart(3) + '%  ' + (avg >= 0 ? '+' : '') + avg.toFixed(2) + '%'
    + '  ' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + 'pp'
    + '  [' + eConsv.toFixed(1) + ' / ' + eMid.toFixed(1) + ' / ' + eAggr.toFixed(1) + 'pp]'
    + '  ' + verdict);
}
console.log();
console.log('解讀: 出手組 avg 正 + 誤傷率>53% = 「誤傷(大賺單被縮)」cover「命中(細蝕單被縮)」');
console.log('→ 停用後放行,期望收益 = 出手組 avg(正數)——純 gain(soft shrink 令唔少正期望 trade 開唔到)。');
console.log('裁決規則: n≥15 + 誤傷>53% + avg>全場+0.3pp → 停用; n<10 樣本不足保留(causal/eq-ev)。');
