/** P1 消融重播——六誤傷候選 gate 真偽裁決(2026-09-09)
 *
 * 背景: 主神「Shadow trade 已經一段時間,應該可以驗證 P1 了吧?」
 *   P1 pending 原卡「1006 舊筆 convLedger 污染 → 等乾淨樣本 2-4 週」。
 *   發現捷徑: attribution records 嘅 `contribution` 係 **hit-miss 語義**
 *   (收緊 → trade 蝕 = 啱正 / trade 賺 = 誤傷負)——**唔依賴 convLedger 修正**,
 *   唔受「1006 污染」影響 → 375 gate records 即刻可裁決(n=33-56/gate,超 P5 門檻 3 倍)。
 *
 * 誤傷率定義: contribution < 0 比例 =「該 gate 出手(收緊)後 trade 最終盈利」
 *   = 收緊咗本應賺嘅倉(誤傷)。出手組 avgPnL > 全場 avg = 同上。
 *
 * 對照(有效 gate): trend-alignment(23%)/shape(15%)/four-window(15%)。
 *
 * 誠實界線: hit-miss 係方向性裁決——嚴格 per-gate mult=1 決策重播仍等
 *   entryConvictionLedger 樣本(21 筆)。本 script 輸出可重跑、入 CHANGELOG。
 */
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('data/evolution/component-attribution.json', 'utf-8'));
const R: any[] = d.records ?? [];

// 全場 trade 統計(attribution 覆蓋)
const trades = new Map<string, number>();
for (const r of R) {
  if (!r || typeof r !== 'object' || !r.tradeId) continue;
  if (!Number.isFinite(r.pnlPct)) continue;
  trades.set(r.tradeId, (r.pnlPct ?? 0) * 100);
}
const allPnl = [...trades.values()];
const avgAll = allPnl.length ? allPnl.reduce((s, x) => s + x, 0) / allPnl.length : 0;
const wrAll = allPnl.length ? (allPnl.filter(x => x > 0).length / allPnl.length) * 100 : 0;

// SIX 誤傷候選(831 §27): mae-pattern / convexity / success-pattern / causal / reversal-point / eq-ev
const SIX = ['mae-pattern', 'convexity', 'success-pattern', 'causal', 'reversal-point', 'eq-ev'];

// per-gate hit-miss 統計
const byG: Record<string, { n: number; neg: number; pos: number; zero: number; pnl: number[] }> = {};
for (const r of R) {
  if (!r || typeof r !== 'object') continue;
  const c = String(r.componentId ?? '');
  if (!c.startsWith('gate:')) continue;
  (byG[c] ??= { n: 0, neg: 0, pos: 0, zero: 0, pnl: [] });
  const g = byG[c]!;
  g.n++;
  const cont = r.contribution ?? 0;
  if (cont < -1e-9) g.neg++;
  else if (cont > 1e-9) g.pos++;
  else g.zero++;
  if (Number.isFinite(r.pnlPct)) g.pnl.push((r.pnlPct ?? 0) * 100);
}

const short = (cid: string) => cid.replace('gate:', '').replace(/\(.*\)/, '');

console.log('══════════════════════════════════════════════════════════════');
console.log('P1 消融重播(attribution hit-miss)——六誤傷候選 + 對照');
console.log('全場: n=' + allPnl.length + ' avg=' + avgAll.toFixed(2) + '% WR=' + wrAll.toFixed(0) + '%');
console.log('誤傷率 = contribution<0 比例(收緊後 trade 賺 = 誤傷本應賺嘅倉)');
console.log('══════════════════════════════════════════════════════════════');
console.log('gate                      n    誤傷率 出手組avg  vs全場  verdict');
interface Row { cid: string; n: number; miss: number; avg: number; isSix: boolean }
const rows: Row[] = [];
for (const [cid, v] of Object.entries(byG)) {
  const miss = v.n ? (v.neg / v.n) * 100 : 0;
  const avg = v.pnl.length ? v.pnl.reduce((s, x) => s + x, 0) / v.pnl.length : 0;
  rows.push({ cid: short(cid), n: v.n, miss, avg, isSix: SIX.some(s => cid.includes(s)) });
}
rows.sort((a, b) => b.miss - a.miss);
for (const r of rows) {
  const verdict = r.n >= 5
    ? (r.miss > 60 ? '🔴 誤傷'
      : r.miss > 45 ? '🟠 誤傷嫌疑'
      : r.miss > 25 ? '⚪ 中性'
      : '🟢 有效')
    : '⚪ 細樣本';
  const delta = (r.avg - avgAll);
  console.log('  ' + (r.isSix ? '★ ' : '  ') + r.cid.padEnd(24) + ' n=' + String(r.n).padStart(4)
    + '  ' + r.miss.toFixed(0).padStart(3) + '%  ' + (r.avg >= 0 ? '+' : '') + r.avg.toFixed(2) + '%'
    + '  ' + (delta >= 0 ? '+' : '') + delta.toFixed(2) + 'pp  ' + verdict);
}
console.log('★ = 831 §27 六誤傷候選');
console.log();

// 重複懲罰 Jaccard(同一 trade 兩 gate 同時出手 = 同一資訊罰兩次)
const tradeGates = new Map<string, Set<string>>();
for (const r of R) {
  if (!r || typeof r !== 'object' || !r.tradeId) continue;
  if ((r.contribution ?? 0) === 0) continue;
  const sid = short(String(r.componentId ?? ''));
  if (!tradeGates.has(r.tradeId)) tradeGates.set(r.tradeId, new Set());
  tradeGates.get(r.tradeId)!.add(sid);
}
const tids = [...tradeGates.keys()];
const jaccard = (g1: string, g2: string) => {
  const both = tids.filter(t => tradeGates.get(t)!.has(g1) && tradeGates.get(t)!.has(g2)).length;
  const one = tids.filter(t => tradeGates.get(t)!.has(g1) || tradeGates.get(t)!.has(g2)).length;
  return { both, j: one ? both / one : 0 };
};
console.log('重複懲罰 Jaccard(兩 gate 同時出手 / 任一出手)');
const pairs: Array<[string, string]> = [
  ['base', 'convexity'], ['base', 'success-pattern'], ['success-pattern', 'reversal-point'],
  ['convexity', 'success-pattern'], ['cal-trust', 'reversal-point'], ['mae-pattern', 'convexity'],
];
for (const [g1, g2] of pairs) {
  const r = jaccard(g1, g2);
  console.log(`  ${g1.padEnd(18)} × ${g2.padEnd(18)} Jaccard=${(r.j * 100).toFixed(0)}% (${r.both} trades 同時出手)`);
}
const avgGates = tids.reduce((s, t) => s + tradeGates.get(t)!.size, 0) / (tids.length || 1);
console.log(`  平均每 trade 同時出手 gate 數: ${avgGates.toFixed(1)}`);
console.log();

// 總結裁决
const sixRows = rows.filter(r => r.isSix && r.n >= 5);
const misgated = sixRows.filter(r => r.miss > 45);
const clean = rows.filter(r => !r.isSix && r.n >= 5 && r.miss <= 25);
console.log('════ 裁决輸出 ════');
console.log(`六候選樣本充足(n≥5): ${sixRows.length},其中誤傷>45%: ${misgated.length} 個`);
console.log(`  誤傷>60%: ${sixRows.filter(r => r.miss > 60).map(r => r.cid).join(', ') || '—'}`);
console.log(`  誤傷45-60%: ${sixRows.filter(r => r.miss > 45 && r.miss <= 60).map(r => r.cid).join(', ') || '—'}`);
console.log(`對照有效 gate(<25%誤傷): ${clean.map(r => r.cid).join(', ') || '—'}`);
console.log('誠實界線: hit-miss 方向性裁決——嚴格決策重播(per-gate mult=1 + threshold)');
console.log('          等 entryConvictionLedger 樣本(21 筆/09-09)——減法落地需此確認 + 主神批。');
