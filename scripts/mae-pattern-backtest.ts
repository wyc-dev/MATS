/**
 * v2.0.869(主神 SKHX MAE=0 調查):MAE 模式回測——驗證「MAE 模式有冇預測力」
 *
 * Google Tech Lead:「先驗證後實施」——任何 gate 前——先證明「MAE 模式」同
 * 「重開後結果」有統計關聯——先實施到 real trade。
 *
 * 頂尖量化金融分析師:
 *  - 唔係淨係 win rate——要睇 EV(期望值)+ 偏度(avgLoss/avgWin)
 *  - 統計顯著性:Wilson lower bound(樣本少時保守)
 *  - 條件概率:P(win | MAE 模式)——唔係平均
 *
 * 用法: npx tsx scripts/mae-pattern-backtest.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface EntrySample {
  maePct: number;
  mfePct: number;
  pnlPct: number;
  closedAt: number;
  dataMissing?: boolean;
}

interface ProfileState {
  profile: Record<string, EntrySample[]>;
}

/** Wilson lower bound(95% 置信——z=1.645) */
function wilsonLB(wins: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = wins / n;
  return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n);
}

function medianSorted(arr: number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  return n % 2 ? arr[Math.floor(n / 2)]! : (arr[n / 2 - 1]! + arr[n / 2]!) / 2;
}

function classify(maePct: number, mfePct: number): 'good' | 'neutral' | 'bad' | 'missing' {
  if (maePct === 0 && mfePct === 0) return 'missing';
  const ratio = Math.abs(maePct) / Math.max(mfePct, 0.01);
  if (ratio > 1.5) return 'bad';
  if (ratio <= 0.5) return 'good';
  return 'neutral';
}

function main(): void {
  const path = resolve('data/evolution/entry-quality.json');
  if (!existsSync(path)) {
    console.log('❌ 冇 entry-quality 數據——先跑系統收集樣本');
    return;
  }
  const state = JSON.parse(readFileSync(path, 'utf-8')) as ProfileState;
  const profile = state.profile ?? {};
  const allSamples: Array<{ key: string; sample: EntrySample; pattern: string }> = [];
  for (const [key, samples] of Object.entries(profile)) {
    for (const s of samples) {
      allSamples.push({ key, sample: s, pattern: classify(s.maePct, s.mfePct) });
    }
  }

  console.log('══════════════════════════════════════════════════════');
  console.log('MAE 模式回測報告(v2.0.869)');
  console.log('══════════════════════════════════════════════════════');
  console.log(`總樣本: ${allSamples.length}(profile keys: ${Object.keys(profile).length})`);
  console.log('');

  // 分組統計
  const groups: Record<string, Array<{ pnl: number; mae: number; mfe: number }>> = {
    good: [], neutral: [], bad: [], missing: [],
  };
  for (const { sample, pattern } of allSamples) {
    groups[pattern]!.push({ pnl: sample.pnlPct, mae: sample.maePct, mfe: sample.mfePct });
  }

  const labels: Record<string, string> = {
    good: '好入場(ratio ≤ 0.5——順向多)',
    neutral: '中性(0.5 < ratio ≤ 1.5)',
    bad: '差入場(ratio > 1.5——逆向多)',
    missing: '數據缺失(MAE=0 且 MFE=0)',
  };

  console.log('┌────────────┬──────┬────────┬────────┬────────┬────────┬─────────┬─────────┐');
  console.log('│ 模式        │  n   │ win率  │ Wilson │ avgWin │ avgLoss│  EV     │ 偏度    │');
  console.log('├────────────┼──────┼────────┼────────┼────────┼────────┼─────────┼─────────┤');
  for (const g of ['good', 'neutral', 'bad', 'missing'] as const) {
    const arr = groups[g]!;
    if (arr.length === 0) {
      console.log(`│ ${labels[g].padEnd(10)} │ ${'0'.padStart(4)} │ ${'-'.padStart(6)} │ ${'-'.padStart(6)} │ ${'-'.padStart(6)} │ ${'-'.padStart(6)} │ ${'-'.padStart(7)} │ ${'-'.padStart(7)} │`);
      continue;
    }
    const wins = arr.filter(x => x.pnl > 0).length;
    const winRate = wins / arr.length;
    const wlb = wilsonLB(wins, arr.length);
    const winPnl = arr.filter(x => x.pnl > 0).map(x => x.pnl);
    const lossPnl = arr.filter(x => x.pnl <= 0).map(x => x.pnl);
    const avgWin = winPnl.length > 0 ? medianSorted(winPnl) : 0;
    const avgLoss = lossPnl.length > 0 ? medianSorted(lossPnl) : 0;
    const ev = winRate * avgWin + (1 - winRate) * avgLoss;
    const skew = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
    console.log(`│ ${labels[g].padEnd(10)} │ ${String(arr.length).padStart(4)} │ ${(winRate * 100).toFixed(0).padStart(4)}% │ ${(wlb * 100).toFixed(0).padStart(4)}% │ ${avgWin.toFixed(2).padStart(6)} │ ${avgLoss.toFixed(2).padStart(6)} │ ${ev.toFixed(2).padStart(7)} │ ${skew.toFixed(2).padStart(7)} │`);
  }
  console.log('└────────────┴──────┴────────┴────────┴────────┴────────┴─────────┴─────────┘');
  console.log('');

  // 驗證結論
  const bad = groups.bad!;
  const good = groups.good!;
  const badWins = bad.filter(x => x.pnl > 0).length;
  const goodWins = good.filter(x => x.pnl > 0).length;
  const badWR = bad.length > 0 ? badWins / bad.length : 0;
  const goodWR = good.length > 0 ? goodWins / good.length : 0;

  console.log('══════════════════════════════════════════════════════');
  console.log('驗證結論(Google Tech Lead——先驗證後實施)');
  console.log('══════════════════════════════════════════════════════');
  if (bad.length < 30 || good.length < 30) {
    console.log(`⚠️ 樣本不足(差入場 n=${bad.length} / 好入場 n=${good.length})——需要 ≥30 先統計可靠`);
    console.log('   → 繼續收集樣本——MAE 模式 gate 暫唔實施(中性)');
  } else if (badWR < goodWR - 0.05) {
    console.log(`✅ 差入場 win rate ${(badWR * 100).toFixed(0)}% < 好入場 ${(goodWR * 100).toFixed(0)}%(差異 > 5pp)——MAE 模式有預測力`);
    console.log('   → 可以實施 MAE 模式 gate(重開抑制)');
  } else {
    console.log(`❌ 差入場 win rate ${(badWR * 100).toFixed(0)}% vs 好入場 ${(goodWR * 100).toFixed(0)}%——差異 < 5pp——MAE 模式冇預測力`);
    console.log('   → 唔實施(誠實——慳功夫)');
  }
  console.log('');

  // 每 symbol×side 明細
  console.log('每 symbol×side 明細(per symbol×side——空間隔離):');
  for (const [key, samples] of Object.entries(profile)) {
    const valid = samples.filter(s => !s.dataMissing);
    if (valid.length === 0) continue;
    const wins = valid.filter(s => s.pnlPct > 0).length;
    const wr = wins / valid.length;
    const patterns = valid.map(s => classify(s.maePct, s.mfePct));
    const badCount = patterns.filter(p => p === 'bad').length;
    console.log(`  ${key.padEnd(20)} n=${String(valid.length).padStart(3)} win率=${(wr * 100).toFixed(0).padStart(3)}% 差入場=${badCount}/${valid.length}`);
  }
}

main();
