/**
 * verify-softgate-confirmation.ts —— v2(修正: boost/shrink 分離)
 * 831 §27 承諾兌現:2-4 週後確認停用成效。純離線 read-only。
 *
 * 方法論修正:mult>1 = boost(出手組 avg 正 = 有效加持盈利單);
 *             mult<1 = shrink(出手組 avg 正 = 誤傷 shrink 咗盈利單 / 負 = 有效擋蝕單)。
 * 唔可以混埋計——四個-window×1.1 係 boost,唔係 shrink。
 *
 * 執行: npx tsx scripts/verify-softgate-confirmation.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/evolution/portfolio-state.json'), 'utf-8'));
const rt: any[] = (s.realTrades ?? []).filter((t: any) => t && typeof t === 'object');
const DISABLED = new Set(['success-pattern', 'reversal-point', 'convexity', 'mae-pattern', 'cal-trust', 'causal', 'chart-aware', 'eq-ev']);
const CUTOFF_MS = new Date('2026-09-09T12:00:00Z').getTime();
const pnl = (t: any): number | null => typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct) ? t.pnlPct : null;

// v2.0.893-P9-base-split: 新格式六組件名(連乘 = 舊 base);舊格式一條 base(consensus×...) 打包。
// scripts 要同時認兩種,否則 2-4 週後 V2 重跑會 miss 新數據。
const BASE_COMPONENT_KEYS = ['calibrated-consensus', 'pwin-blend', 'plan-g-penalty', 'plan-g-boost', 'llm-dir-trust', 'ev-filter'];

/** 單筆 trade 嘅 base 組合連乘(v2.0.893 後 = 六組件連乘 / 舊 = base(...) 打包值)
 *  v2.0.896-P9-attack3 硬化(C1-2/C4):
 *   ① 重複組件(持久化污染 double-count)→ 只取首個(唯一 key)
 *   ② 乘積 Infinity/天文值 → null(研究數字唔可以毒化連乘下游) */
function baseProduct(ledger: any[]): number | null {
  const seen = new Set<string>();
  const comps: number[] = [];
  let legacy: number | null = null;
  for (const g of ledger) {
    if (!g || typeof g !== 'object' || typeof g.mult !== 'number' || !Number.isFinite(g.mult)) continue;
    const name = String(g.gate);
    if (name.includes('base(')) { legacy = g.mult; continue; }
    if (BASE_COMPONENT_KEYS.includes(name)) {
      if (seen.has(name)) continue; // 重複 → 用首個
      seen.add(name);
      comps.push(g.mult);
    }
  }
  if (comps.length === 0) return legacy; // 舊格式
  const product = comps.reduce((a, b) => a * b, 1);
  return Number.isFinite(product) && product < 1e9 ? product : null;
}

const ledger = rt.filter((t) => Array.isArray(t.entryConvictionLedger) && t.entryConvictionLedger.length > 0 && pnl(t) !== null);
const ledAll = ledger.map((t) => pnl(t) as number);
const avgLed = ledAll.reduce((a, b) => a + b, 0) / (ledAll.length || 1);
console.log(`ledger 乾淨樣本: ${ledger.length} 筆 avg=${(avgLed * 100).toFixed(3)}%`);

interface Dir { n: number; pnls: number[]; }
const gstats = new Map<string, { boost: Dir; shrink: Dir }>();
for (const t of ledger) {
  const p = pnl(t)!;
  for (const g of t.entryConvictionLedger) {
    if (!g || typeof g !== 'object' || typeof g.mult !== 'number' || !Number.isFinite(g.mult)) continue;
    let name = String(g.gate);
    if (name.includes('base(') || BASE_COMPONENT_KEYS.includes(name)) name = 'base';
    if (!gstats.has(name)) gstats.set(name, { boost: { n: 0, pnls: [] }, shrink: { n: 0, pnls: [] } });
    const st = gstats.get(name)!;
    const dir = g.mult > 1 ? st.boost : st.shrink;
    dir.n++; dir.pnls.push(p);
  }
}

const fmt = (d: { n: number; pnls: number[] }) => {
  if (!d.n) return null;
  const avg = d.pnls.reduce((a, b) => a + b, 0) / d.n;
  const wr = d.pnls.filter((x) => x > 0).length / d.n;
  return { n: d.n, avg: avg * 100, wr: wr * 100 };
};

console.log('\n════ A. per-gate 出手命中(boost/shrink 分離)═══');
console.log('gate                     型態  n    avg%   WR%   vs全場 裁決');
const verdicts: string[] = [];
for (const [name, st] of [...gstats.entries()].sort((a, b) => (b[1].boost.n + b[1].shrink.n) - (a[1].boost.n + a[1].shrink.n))) {
  const b = fmt(st.boost); const sh = fmt(st.shrink);
  for (const [kind, d] of [['boost', b], ['shrink', sh]] as const) {
    if (!d) continue;
    const delta = d.avg - avgLed * 100;
    // 語義: boost 出手 avg 正 = 有效(加持對單); shrink 出手 avg 正 = 誤傷(shrink 咗對單)
    let v: string;
    if (d.n < 15) v = '⚪ 樣本不足';
    else if (kind === 'boost') v = d.avg > avgLed * 100 ? '🟢 boost 有效' : '🟡 boost 無效';
    else v = d.avg > avgLed * 100 * 1.3 && d.avg > 0 ? '🔴 shrink 誤傷(盈利單被縮)' : d.avg < 0 ? '🟢 shrink 有效(擋蝕單)' : Math.abs(delta) < 0.1 ? '🟠 shrink 無效' : '🟡 待判';
    const disabled = DISABLED.has(name);
    console.log(`  ${name.padEnd(24)} ${kind.padEnd(6)} n=${String(d.n).padStart(4)} ${(d.avg >= 0 ? '+' : '') + d.avg.toFixed(2).padStart(7)}% ${d.wr.toFixed(0).padStart(4)}% ${(delta >= 0 ? '+' : '') + delta.toFixed(2).padStart(6)}pp  ${v}${disabled ? ' [已停用]' : ''}`);
    if (v.startsWith('🔴') || v.startsWith('🟠')) verdicts.push(`${name}/${kind}: ${v}`);
  }
}

console.log('\n════ B. 停用成效確認(09-09 前 vs 後)═══');
const withTs = rt.filter((t) => typeof t.openedAt === 'number' && pnl(t) !== null);
const before = withTs.filter((t) => t.openedAt < CUTOFF_MS);
const after = withTs.filter((t) => t.openedAt >= CUTOFF_MS);
const stat = (g: any[]) => {
  if (!g.length) return null;
  const ps = g.map((t) => pnl(t) as number);
  return { n: g.length, avg: (ps.reduce((a, b) => a + b, 0) / g.length) * 100, wr: (ps.filter((x) => x > 0).length / ps.length) * 100 };
};
const sb = stat(before), sa = stat(after);
console.log(`09-09 前(8 gate 活躍): n=${sb!.n} avg=${sb!.avg.toFixed(3)}% WR=${sb!.wr.toFixed(1)}%`);
console.log(`09-09 後(gate 停用):   n=${sa!.n} avg=${sa!.avg.toFixed(3)}% WR=${sa!.wr.toFixed(1)}%`);
console.log(`Δ avg=${(sa!.avg - sb!.avg).toFixed(3)}pp  ΔWR=${(sa!.wr - sb!.wr).toFixed(1)}pp`);

// 分層:side × 時間(控制 buy/sell 結構移動)
console.log('\n分層(side × 前後):');
for (const side of ['buy', 'sell']) {
  const b = before.filter((t) => String(t.side) === side);
  const a = after.filter((t) => String(t.side) === side);
  const stb = stat(b), sta = stat(a);
  if (stb && sta) console.log(`  ${side.padEnd(5)} 前 n=${String(stb.n).padStart(4)} avg=${(stb.avg >= 0 ? '+' : '') + stb.avg.toFixed(3)}% WR=${stb.wr.toFixed(0)}% | 後 n=${String(sta.n).padStart(4)} avg=${(sta.avg >= 0 ? '+' : '') + sta.avg.toFixed(3)}% WR=${sta.wr.toFixed(0)}%`);
}
// 分層 symbol × 前後
console.log('分層(symbol × 前後, n≥5 each):');
const syms = [...new Set(withTs.map((t) => String(t.symbol)))];
for (const sym of syms) {
  const b = before.filter((t) => String(t.symbol) === sym);
  const a = after.filter((t) => String(t.symbol) === sym);
  const stb = stat(b), sta = stat(a);
  if (stb && sta && stb.n >= 5 && sta.n >= 5) {
    console.log(`  ${String(sym).padEnd(14)} 前 n=${String(stb.n).padStart(4)} avg=${(stb.avg >= 0 ? '+' : '') + stb.avg.toFixed(2)}% WR=${stb.wr.toFixed(0)}% | 後 n=${String(sta.n).padStart(4)} avg=${(sta.avg >= 0 ? '+' : '') + sta.avg.toFixed(2)}% WR=${sta.wr.toFixed(0)}%`);
  }
}

console.log('\n════ C. base 收縮深度 + 同現率 ═══');
const baseMults = ledger.map((t) => baseProduct(t.entryConvictionLedger)).filter((x: any): x is number => x !== null && Number.isFinite(x));
if (baseMults.length) {
  const avg = baseMults.reduce((a: number, b: number) => a + b, 0) / baseMults.length;
  console.log(`base(consensus×pwin×blend×penalty×boost×dirTrust×ev): n=${baseMults.length} avg=${avg.toFixed(3)} min=${Math.min(...baseMults).toFixed(3)} max=${Math.max(...baseMults).toFixed(3)}`);
  console.log(`  → consensus 100% 喺 base 之後平均只剩 ${(avg * 100).toFixed(0)}%——過度收縮量度`);
}
// 同現率(剩 low 高同現 pair)
const tradeGates = new Map<string, Set<string>>();
for (const t of ledger) {
  const set = new Set<string>();
  for (const g of t.entryConvictionLedger) if (g?.gate) set.add(g.gate.includes('base(') || BASE_COMPONENT_KEYS.includes(String(g.gate)) ? 'base' : String(g.gate));
  tradeGates.set(String(t.id), set);
}
const gateNames = [...gstats.keys()];
console.log('兩兩同現 Jaccard(>50%):');
for (let i = 0; i < gateNames.length; i++) {
  for (let j = i + 1; j < gateNames.length; j++) {
    const g1 = gateNames[i]!, g2 = gateNames[j]!;
    let both = 0, one = 0;
    for (const set of tradeGates.values()) {
      const h1 = set.has(g1), h2 = set.has(g2);
      if (h1 || h2) { one++; if (h1 && h2) both++; }
    }
    if (one >= 10) {
      const jac = both / one;
      if (jac >= 0.5) console.log(`  ${g1.padEnd(20)} × ${g2.padEnd(20)} J=(${(jac * 100).toFixed(0)}% ${both}/${one})`);
    }
  }
}

console.log('\n════ D. 誠實限制 ═══');
console.log(' - ledger 72 筆,per-gate n=1-72——n<15 只作參考,唔裁決');
console.log(' - 前後比較受 regime 混雜(symbol/side 分層已做)——WR 提升顯著但 avg 微降,需解釋');
console.log(' - 純 read-only 確認階段,任何 gate 改動等主神批 + env 回滾');
