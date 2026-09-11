/**
 * P15-sell-recovery-verify（2026-09-11, 主神「每3分鐘一個cycle, 應該幾個鐘就可以再驗證」）:
 * v2.0.875-P9-qrl-pool-monopoly 修復後 —— sell 樣本回流驗證。
 *
 * ⚠️ PRE-REGISTERED 門檻（修復前鎖定, 唔可以跑完先改）:
 *   [P15-V1] sell shadow 樣本速率: n_sell ≥ 0.2 × n_buy（修復前 3/200 = 0.015）——
 *            shadow 層 2392 筆/日, 幾個鐘即幾百筆, 唔使 2 週
 *   [P15-V2] qrl 佔比回落: qrl 樣本 < 40%（修復前 99.5%）
 *   [P15-V3] open positions 平衡: sell open ≥ 1（修復前 0/60）
 *   [P15-V4] sell lean 出現: 至少 1 個 symbol 嘅 sell WR/EV 有實質樣本（n≥10）
 *
 * ⚠️ Read-only。Usage: npx tsx scripts/p15-sell-recovery-verify.ts
 */
import fs from 'node:fs';

const shadowState = JSON.parse(fs.readFileSync('data/evolution/shadow-state.json', 'utf-8'));
const pos = shadowState.positions ?? [];
const rr = shadowState.recentResults ?? [];

const open = pos.filter((p: any) => p.status === 'open');
const openType: Record<string, number> = {};
const openSide = { buy: 0, sell: 0 };
for (const p of open) {
  openType[p.shadowType] = (openType[p.shadowType] ?? 0) + 1;
  if (p.side === 'buy') openSide.buy++;
  else if (p.side === 'sell') openSide.sell++;
}

// recentResults: 側/type 分佈 + sell vs buy edge
const byType: Record<string, number> = {};
const bySide = { buy: 0, sell: 0 };
const sells: { pnl: number; win: boolean }[] = [];
const buys: { pnl: number; win: boolean }[] = [];
for (const r of rr) {
  byType[r.shadowType] = (byType[r.shadowType] ?? 0) + 1;
  if (r.side === 'sell') { bySide.sell++; sells.push({ pnl: r.pnlPct ?? 0, win: r.outcome === 'win' }); }
  else if (r.side === 'buy') { bySide.buy++; buys.push({ pnl: r.pnlPct ?? 0, win: r.outcome === 'win' }); }
}
const avg = (a: { pnl: number }[]) => (a.length ? a.reduce((s, x) => s + x.pnl, 0) / a.length : 0);
const wins = (a: { win: boolean }[]) => (a.length ? a.filter(x => x.win).length / a.length : 0);

const ratio = bySide.buy > 0 ? bySide.sell / bySide.buy : (bySide.sell > 0 ? Infinity : 0);
const qrlShare = rr.length ? (byType.qrl ?? 0) / rr.length : 0;

console.log('═══ P15 sell-recovery 驗證（v2.0.875-P9-qrl-pool-monopoly 修復後）═══\n');
console.log(`[open] total=${open.length}  byType=${JSON.stringify(openType)}  bySide=${JSON.stringify(openSide)}`);
console.log(`[recentResults] n=${rr.length}  qrl佔比=${(qrlShare * 100).toFixed(1)}%  sell:buy=${bySide.sell}:${bySide.buy} (ratio=${ratio.toFixed(3)})`);
console.log(`[sell edge] n=${sells.length} avg=${(avg(sells) * 100).toFixed(2)}% WR=${Math.round(wins(sells) * 100)}%`);
console.log(`[buy edge]  n=${buys.length} avg=${(avg(buys) * 100).toFixed(2)}% WR=${Math.round(wins(buys) * 100)}%`);
console.log('');

const v1 = ratio >= 0.2;
const v2 = qrlShare < 0.4;
const v3 = openSide.sell >= 1;
const v4 = sells.length >= 10;
console.log(`[P15-V1] sell:buy ≥ 0.2        → ${ratio.toFixed(3)}  ${v1 ? '✅ PASS' : '⏳ 收集中'}`);
console.log(`[P15-V2] qrl 佔比 < 40%         → ${(qrlShare * 100).toFixed(1)}%  ${v2 ? '✅ PASS' : '⏳'}`);
console.log(`[P15-V3] open sell ≥ 1          → ${openSide.sell}  ${v3 ? '✅ PASS' : '⏳'}`);
console.log(`[P15-V4] sell resolve 樣本 ≥ 10 → ${sells.length}  ${v4 ? '✅ PASS' : '⏳ 收集中'}`);

const allPass = v1 && v2 && v3 && v4;
console.log(`\n${allPass ? '🎉 P15 全 PASS —— sell 樣本已回流, 可檢視 sell lean/edge 並向主神報告' : '⏳ 未達標 —— 按 §4 驗證節點繼續收集（shadow 層幾小時應達標）'}`);
if (sells.length >= 10) {
  console.log(`   sell edge 判定: ${avg(sells) > 0 ? '✅ sell 樣本正 EV（食跌勢嘅證據）' : '⚠️ sell 樣本負 EV（回流咗但冇 edge——需再查方向 lean）'}`);
}
