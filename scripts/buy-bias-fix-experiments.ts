/**
 * buy-bias-fix-experiments.ts — Phase 2: 候選修復邏輯實驗（counterfactual 重播）
 *
 * Experiment A — FP P(win) cap 校準: claimed P >= 85% → cap 85% 後, claimed vs 實際 WR 一致度
 * Experiment B — edge vs 50% 對稱化: OLR P(win) < 50% 仍被開 BUY 嘅比例（修復目標）
 * Experiment C — sl_tp cooldown 重播: 不同觸發 × cooldown 組合下 (avoidedLoss, missedWin, net)
 * Experiment D — SL floor: BNB SL price-basis 分佈 + 曾經浮盈比例
 *
 * 用法: npx tsx scripts/buy-bias-fix-experiments.ts
 */
import * as fs from 'node:fs';

const statePath = process.argv[2] ?? 'data/evolution/portfolio-state.json';
const p = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const trades = (p.realTrades ?? []) as any[];
const sorted = [...trades].sort((a, b) => Number(a.openedAt) - Number(b.openedAt));

function thesisP(t: any, side: 'buy' | 'sell'): number | undefined {
  const th = String(t.entryThesis ?? '');
  const m = th.match(
    side === 'buy'
      ? /[Ff]irst[- ]?[Pp]assage[^)]{0,40}LONG\s*P=(\d{1,3})%/
      : /[Ff]irst[- ]?[Pp]assage[^)]{0,40}SHORT\s*P=(\d{1,3})%/,
  );
  return m ? Number(m[1]) : undefined;
}

console.log('================ Experiment A: FP P(win) 聲稱 vs 實際 ================');
const fpRows = sorted
  .map(t => {
    const side = String(t.side) as 'buy' | 'sell';
    const claimedP = thesisP(t, side);
    return claimedP === undefined ? null : { claimedP, win: Number(t.pnl) > 0 };
  })
  .filter((r): r is { claimedP: number; win: boolean } => r !== null);

const base: Record<string, { n: number; w: number }> = {};
for (const r of fpRows) {
  const k = r.claimedP >= 95 ? '>=95' : r.claimedP >= 85 ? '85-94' : r.claimedP >= 70 ? '70-84' : '<70';
  base[k] ??= { n: 0, w: 0 };
  base[k].n++;
  if (r.win) base[k].w++;
}
console.log('FP 聲稱 P 分桶 → 實際 WR (baseline, claimed 係 95-100%):');
for (const [k, g] of Object.entries(base)) {
  console.log(`  claimed ${k}: n=${g.n} 實際WR=${((g.w / g.n) * 100).toFixed(1)}%`);
}
let maeBase = 0;
for (const r of fpRows) maeBase += Math.abs(r.claimedP - (r.win ? 100 : 0));
console.log(`\n聲稱 P vs outcome 平均絕對誤差: ${(maeBase / fpRows.length).toFixed(0)}pp (100 = 完全無預測力嘅 worst-case 二分誤差)`);
console.log(`  理想 fix 後: 聲稱 P 應 ≈ 實際 WR。現時 claimed>=95 但實際 46.7% → 過度自信 +48pp`);

console.log('\n================ Experiment B: edge vs 50% 對齊（sell side 真實空間）================');
// 用「OLR BUY P(win)=NN%」parse。若 P<50% 而仍開 BUY → 呢啲係「breakeven 包裝」製造嘅低勝算 BUY
let buyTotal = 0, buySub50 = 0;
for (const t of sorted) {
  if (t.side !== 'buy') continue;
  const m = String(t.entryThesis ?? '').match(/OLR BUY P\(win\)=(\d{1,3})%/);
  if (!m) continue;
  buyTotal++;
  if (Number(m[1]) < 50) buySub50++;
}
console.log(`BUY trades 中 OLR P(win) < 50% 仍被執行: ${buySub50}/${buyTotal} 筆`);
console.log(`→ 現用 breakeven(29%)做參照, 令 P=40% 都顯示「edge +11pp」; 改用 vs50% 會顯示負 edge → LLM 唔會再盲目 BUY`);

console.log('\n================ Experiment C: sl_tp cooldown 重播 ================');
const variants: Array<{ trigger: 'single' | 'streak2' | 'streak3'; hours: number }> = [];
for (const trigger of ['single', 'streak2', 'streak3'] as const) {
  for (const hours of [2, 4, 6, 12, 24]) variants.push({ trigger, hours });
}
console.log('trigger          hours   blocked  avoidedLoss   missedWin     net$');
for (const v of variants) {
  const cooldowns = new Map<string, number>(); // key → until(ms)
  const streak = new Map<string, number>();
  let blocked = 0, avoidedLoss = 0, missedWin = 0;
  for (const t of sorted) {
    const key = `${String(t.symbol).toLowerCase()}:${t.side}`;
    const opened = Number(t.openedAt);
    const until = cooldowns.get(key) ?? 0;
    if (opened < until) {
      blocked++;
      const pnl = Number(t.pnl);
      if (pnl < 0) avoidedLoss += pnl; else missedWin += pnl;
      continue;
    }
    if (t.closeReason === 'sl_tp') {
      streak.set(key, (streak.get(key) ?? 0) + 1);
      const n = streak.get(key) ?? 0;
      const shouldArm = v.trigger === 'single' || (v.trigger === 'streak2' && n >= 2) || (v.trigger === 'streak3' && n >= 3);
      if (shouldArm) cooldowns.set(key, opened + v.hours * 3_600_000);
    } else {
      streak.set(key, 0);
    }
  }
  console.log(`trigger=${v.trigger.padEnd(8)} ${String(v.hours).padEnd(9)} ${String(blocked).padEnd(8)} $${(-avoidedLoss).toFixed(2).padStart(9)}  $${missedWin.toFixed(2).padStart(8)}  $${(avoidedLoss + missedWin).toFixed(2).padStart(8)}`);
}

console.log('\n================ Experiment D: BNB SL 分佈 ================');
const bnbSl = sorted.filter(t => t.symbol === 'bnb' && t.closeReason === 'sl_tp');
if (bnbSl.length) {
  const pb = bnbSl.map(t => ((Number(t.exitPrice) - Number(t.entryPrice)) / Number(t.entryPrice)) * 100).sort((a, b) => a - b);
  const median = pb[Math.floor(pb.length / 2)] ?? 0;
  const p90 = pb[Math.min(pb.length - 1, Math.floor(pb.length * 0.9))] ?? 0;
  console.log(`BNB sl_tp price-basis: n=${pb.length} median=${median.toFixed(2)}% p90=${p90.toFixed(2)}% min=${pb[0]?.toFixed(2)}% max=${pb[pb.length - 1]?.toFixed(2)}%`);
  const wider = pb.filter(v => v > -1.5).length;
  console.log(`  → SL floor = 1.5% price (15% margin @10x): ${wider}/${pb.length} 筆會被放寬（唔會喺 0.84% 被掃）`);
  let everProfitable = 0;
  for (const t of bnbSl) {
    const inv = Number(t.investment);
    const max = Number(t.maxValueReached);
    if (inv > 0 && max > inv) everProfitable++;
  }
  console.log(`  其中曾浮盈 (maxValueReached>investment): ${everProfitable}/${bnbSl.length} — 無 price path, recovery 與否留 live 驗證`);
}
