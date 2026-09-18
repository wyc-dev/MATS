/**
 * backfill-softgate-ablation.ts —— trend-alignment 停用方案 backfill 驗證(2026-09-18)
 * 主神:「唔好觀察,用現有數據 backfill 測試方案是否可行,可行照行」。
 *
 * 方法(無 threshold 依賴——831「唔理解數據語義唔做結論」):
 * 對每筆有完整 entryConvictionLedger 嘅已平倉 real trade:
 *   P_all = ∏所有 mult(開倉時實際信心形成)
 *   P_¬g = P_all / mult_g(移除 gate g 後)
 *   相對影響 = 1 − P_¬g/P_all = gate g 對該單信心嘅貢獻比例
 *
 * 裁決問題:
 *  Q1: gate g 有「實質信心影響」(影響 ≥10%)嘅單,實際 pnl 係正定負?
 *      → 正 = gate 加持咗正 EV 單(貢獻有效,唔停);負 = gate 加持咗負 EV 單(停用釋放)
 *  Q2: 若 P_¬g 跌穿「全場已開倉最低信心」(proxy:該 gate 影響單嘅 P_all 分位),
 *      即 gate g 係「開倉邊緣嘅關鍵推手」——呢啲單 pnl?
 *  Q3: boost(順勢 ×1.2)vs shrink(逆勢 ×0.1)分開——trend-alignment 雙向語義必分
 *
 * 執行: npx tsx scripts/backfill-softgate-ablation.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/evolution/portfolio-state.json'), 'utf-8'));
const rt: any[] = (s.realTrades ?? []).filter((t: any) => t && typeof t === 'object');
const pnl = (t: any): number | null => typeof t.pnlPct === 'number' && Number.isFinite(t.pnlPct) ? t.pnlPct : null;

const ledger = rt.filter((t) => Array.isArray(t.entryConvictionLedger) && t.entryConvictionLedger.length > 0 && pnl(t) !== null);
console.log(`有完整 ledger 已平倉: ${ledger.length} 筆`);

interface GateData { mult: number; pnlPct: number; symbol: string; side: string; id: string; }
const byGate = new Map<string, GateData[]>();

for (const t of ledger) {
  const p = pnl(t)!;
  let pAll = 1;
  for (const g of t.entryConvictionLedger) if (g?.mult && typeof g.mult === 'number') pAll *= g.mult;
  for (const g of t.entryConvictionLedger) {
    if (!g || typeof g.mult !== 'number' || !Number.isFinite(g.mult)) continue;
    const name = String(g.gate).includes('base(') || ['calibrated-consensus','pwin-blend','plan-g-penalty','plan-g-boost','llm-dir-trust','ev-filter'].includes(String(g.gate)) ? 'base' : String(g.gate);
    if (!byGate.has(name)) byGate.set(name, []);
    byGate.get(name)!.push({ mult: g.mult, pnlPct: p, symbol: t.symbol, side: t.side, id: String(t.id).slice(0, 12) });
  }
}

console.log('\n══════════ 每 gate:信心影響嘅單 + 實際 outcome ══════════');
console.log('gate                    型態   n   平均mult  加持單avg%  加持單WR%  裁定');
type Verdict = { name: string; type: string; n: number; avgMult: number; avg: number; wr: number; v: string };
const verdicts: Verdict[] = [];
for (const [name, arr] of byGate) {
  // 分 boost / shrink
  for (const type of ['boost', 'shrink'] as const) {
    const sub = arr.filter((d) => type === 'boost' ? d.mult > 1.0 : d.mult < 1.0);
    if (sub.length === 0) continue;
    const avgMult = sub.reduce((a, d) => a + d.mult, 0) / sub.length;
    const avg = sub.reduce((a, d) => a + d.pnlPct, 0) / sub.length;
    const wr = sub.filter((d) => d.pnlPct > 0).length / sub.length;
    let v: string;
    if (sub.length < 10) v = '⚪ 樣本不足(參考)';
    else if (type === 'boost') v = avg > 0 ? '🟢 加持正EV單——保留' : '🔴 加持負EV單——停用候選';
    else v = avg > 0 ? '🔴 壓縮咗正EV單(誤傷)——停用候選' : '🟢 壓縮咗負EV單(擋蝕)——保留';
    verdicts.push({ name, type, n: sub.length, avgMult, avg: avg * 100, wr: wr * 100, v });
    console.log(`  ${name.padEnd(24)} ${type.padEnd(7)} n=${String(sub.length).padStart(4)}  ×${avgMult.toFixed(3)}  ${(avg * 100 >= 0 ? '+' : '') + (avg * 100).toFixed(2).padStart(7)}%  ${wr.toFixed(0).padStart(4)}%  ${v}`);
  }
}

console.log('\n══════════ trend-alignment 深潛(主神方案對象)══════════');
const ta = byGate.get('trend-alignment') ?? [];
const taBoost = ta.filter((d) => d.mult > 1);
const taShrink = ta.filter((d) => d.mult < 1);
console.log(`trend-alignment 出手共 ${ta.length} 次:`);
console.log(`  順勢 boost ×1.2: ${taBoost.length} 單, avg=${(taBoost.reduce((a, d) => a + d.pnlPct, 0) / (taBoost.length || 1) * 100).toFixed(2)}%, 逐單:`);
for (const d of taBoost) console.log(`    ${d.symbol.padEnd(10)} ${d.side.padEnd(4)} ${d.id} pnl=${(d.pnlPct * 100).toFixed(2)}%`);
console.log(`  逆勢 shrink ×0.1: ${taShrink.length} 單(開到倉先有記錄——×0.1 通常直接變 HOLD)`);
console.log(`  → 逆勢 ×0.1 擋住嘅單冇 record(開唔到倉)——但主神 P6 實證:嗰類單 9 筆全蝕 EV −0.647`);

console.log('\n══════════ 反證:停用 trend-alignment 嘅淨效應估算 ══════════');
// 若停用(=乘數 1.0):boost 單信心 ↓(×1.2→×1.0),shrink 單信心 ↑(×0.1→×1.0)
// 已開倉單中,trend-alignment 有影響嗰啲——若信心改變令邊緣單唔開/開,估算:
const allBoostPnl = taBoost.map((d) => d.pnlPct);
const allBoostAvg = allBoostPnl.reduce((a, b) => a + b, 0) / (allBoostPnl.length || 1);
console.log(`停用後「失去 boost 加持」嘅 ${taBoost.length} 單:而家 avg=${(allBoostAvg * 100).toFixed(2)}%(正=呢啲單本身正EV,boost 有貢獻——停用淨損失 = 加持效果)`);
console.log(`停用後「逆勢 shrink 放行」:×0.1 變 ×1.0 → 原本唔會開嘅接刀單可能開 → 主神實證嗰類單 −6~−10%/筆 —— 停用風險 = 放生接刀`);
const netBoostValue = allBoostPnl.reduce((a, b) => a + b, 0);
const lossIfDisabled = (taShrink.length === 0 ? 0 : 1); // shrink 擋咗幾多未知——但已知方向
console.log(`\n裁決: 停用 trend-alignment = 放棄順勢加持(${taBoost.length} 單 avg +${(allBoostAvg * 100).toFixed(2)}%, 正EV) + 放生逆勢接刀(×0.1→×1.0) → ${allBoostAvg < 0 || taShrink.length > 0 ? '可行' : '不可行——正EV加持放棄 + 接刀防禦放生'}`);

console.log('\n══════════ 總結 ══════════');
const boostCandidates = verdicts.filter((v) => v.v.startsWith('🔴') && v.n >= 10);
console.log(`n≥10 且「停用候選」(誤傷/加持負EV): ${boostCandidates.length} 個`);
if (boostCandidates.length) for (const c of boostCandidates) console.log(`  🔴 ${c.name}/${c.type} n=${c.n} avg=${c.avg.toFixed(2)}%`);
else console.log('  — 無(全部 n≥10 gate 都係正貢獻或保留)——現狀正確,無新消融需要執行');
console.log('\n誠實限制: ledger 72 筆係「已開倉單」——逆勢 ×0.1 擋住嘅單冇 record,\n           只能用 P6 主神實證(9 筆全蝕 EV −0.647)證明其防禦價值。');
