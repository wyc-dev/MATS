/**
 * P8 counterfactual 實驗室:對 4 個候選提案做歷史重放量化。
 * 全部只讀,純計算。
 */
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const T = (d.realTrades ?? []).filter((x: any) => x.closedAt).sort((a: any, b: any) => a.closedAt - b.closedAt);
const pct = (x: any) => (x?.pnlPct ?? 0) * 100;
const held = (t: any) => (t.closedAt - t.openedAt) / 60000;
const baseline = T.reduce((a: number, t: any) => a + pct(t), 0);
console.log(`基線: ${T.length} 喺, 總 PnL ${baseline.toFixed(1)}pp\n`);

// ═══ 實驗 A: <15m 生存確認（半倉試探,15min 後浮盈先補足）═══
// 模擬:<15m 內出場嘅單只食一半 pnlPct;撐過 15min 嘅單全額。
console.log('═══ 實驗 A: <15m 半倉生存確認 ═══');
{
  let sim = 0, affected = 0;
  for (const t of T) {
    if (held(t) < 15) { sim += pct(t) / 2; affected++; }
    else sim += pct(t);
  }
  console.log(`   受影響 ${affected} 喂;PnL ${baseline.toFixed(1)} → ${sim.toFixed(1)}pp (Δ${(sim - baseline >= 0 ? '+' : '')}${(sim - baseline).toFixed(1)}pp)`);
}

// ═══ 實驗 B: 速度自適應鎖利（MFE ≥X% 且持倉 <Nmin → 即鎖 50% MFE）═══
console.log('\n═══ 實驗 B: 高速 MFE 立即鎖 50%（替代 60min 確認期）═══');
for (const [mfeMin, lockRatio] of [[8, 0.5], [10, 0.5], [12, 0.5], [15, 0.6]] as [number, number][]) {
  let sim = 0, locked = 0;
  for (const t of T) {
    const r = pct(t);
    const mfe = typeof t.maxValueReached === 'number' && Number.isFinite(t.maxValueReached) && t.maxValueReached < 90 ? t.maxValueReached : null;
    // 呢個實驗只 apply 贏單（mfe > 0 且實收 < 50% MFE——即係鎖得遲）
    if (r > 0 && mfe != null && mfe >= mfeMin && r < mfe * lockRatio && held(t) <= 90) {
      sim += mfe * lockRatio; locked++;
    } else sim += r;
  }
  console.log(`   MFE≥${mfeMin}% 鎖 ${lockRatio * 100}%: 鎖 ${locked} 喂;PnL ${baseline.toFixed(1)} → ${sim.toFixed(1)}pp (Δ${(sim - baseline >= 0 ? '+' : '')}${(sim - baseline).toFixed(1)}pp)`);
}

// ═══ 實驗 C: anti-martingale——連蝕 ≥3 後半倉 ═══
console.log('\n═══ 實驗 C: 連蝕 ≥3 後半倉（直到下一單贏）═══');
{
  let sim = 0, streak = 0, shrunk = 0;
  for (const t of T) {
    const p = pct(t);
    if (streak >= 3) { sim += p / 2; shrunk++; if (p > 0) streak = 0; else streak++; }
    else { sim += p; if (p > 0) streak = 0; else streak++; }
  }
  console.log(`   縮倉交易影響 PnL ${baseline.toFixed(1)} → ${sim.toFixed(1)}pp (Δ${(sim - baseline >= 0 ? '+' : '')}${(sim - baseline).toFixed(1)}pp)`);
}

// ═══ 實驗 D: reconciliation 剔出學習樣本（標籤噪聲清除——唔影響 PnL,影響學習質量）═══
console.log('\n═══ 實驗 D: reconciliation 標籤噪聲量化 ═══');
{
  const recon = T.filter((t: any) => t.closeReason === 'reconciliation');
  const decision = T.filter((t: any) => t.closeReason !== 'reconciliation');
  const wrOf = (a: any[]) => (a.filter((t) => pct(t) > 0).length / Math.max(1, a.length) * 100).toFixed(0);
  console.log(`   reconciliation: ${recon.length} 喂 WR=${wrOf(recon)}% avg=${(recon.reduce((a, t) => a + pct(t), 0) / recon.length).toFixed(2)}%`);
  console.log(`   決策出場:       ${decision.length} 喂 WR=${wrOf(decision)}% avg=${(decision.reduce((a, t) => a + pct(t), 0) / decision.length).toFixed(2)}%`);
  console.log(`   → ${recon.length}/${T.length} (${(recon.length / T.length * 100).toFixed(0)}%) 嘅「學習樣本」標籤係系統推斷而非決策——success-pattern/digester/EV filter 全部食緊呢啲噪聲標籤`);
}

// ═══ 實驗 E: 組合拳 A+C ═══
console.log('\n═══ 實驗 E: 組合（A 半倉快出 + C 連蝕半倉）═══');
{
  let sim = 0, streak = 0;
  for (const t of T) {
    let size = 1;
    if (streak >= 3) size *= 0.5;
    if (held(t) < 15) size *= 0.5;
    sim += pct(t) * size;
    if (pct(t) > 0) streak = 0; else streak++;
  }
  console.log(`   PnL ${baseline.toFixed(1)} → ${sim.toFixed(1)}pp (Δ${(sim - baseline >= 0 ? '+' : '')}${(sim - baseline).toFixed(1)}pp)`);
}

// ═══ 實驗 F: 檢查 EV filter/calibrator 而家食唔食 reconciliation ═══
console.log('\n═══ 實驗 F: reconciliation 有冇污染學習組件（code 檢查線索）═══');
{
  const evState = JSON.parse(fs.readFileSync('data/evolution/ev-filter.json', 'utf-8'));
  const samples = evState.samples ?? {};
  let reconPnl = 0, total = 0;
  // 用 symbol|side 聚合顯示 top
  const rows = Object.entries(samples).map(([k, v]: [string, any]) => ({ k, n: (v ?? []).length, ev: v.reduce((a: number, s: any) => a + (s.pnlPct ?? 0), 0) })).sort((a, b) => a.ev - b.ev).slice(0, 6);
  for (const r of rows) console.log(`   EVFilter ${r.k.padEnd(20)} n=${String(r.n).padStart(3)} sumEV=${(r.ev * 100).toFixed(1)}%`);
  console.log(`   （recon 佔歷史 41%——EV 統計入面嘅 reconciliation 樣本會攤薄真實決策訊號）`);
}