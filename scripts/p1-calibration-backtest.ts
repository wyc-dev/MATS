/**
 * v2.0.870-P1 backtest: Ground-truth calibration 治本成效驗證。
 *
 * 目的:證明「信心反校準」係 40 單低質入場嘅根因,並量化校準後嘅改善。
 *
 * 方法(邏輯實驗):
 *  1. 讀 40 單 realTrades,抽取 entry-time conviction(entryThesis OLR P(win)
 *     做 proxy——consensus confidence 已被舊 save path 蒸發)。
 *  2. 分桶(5-bin)計「conviction → 實際 WR」。
 *  3. 用 LLMConvictionCalibrator 做 5-bin shrinkage,睇校準後 conviction。
 *  4. Counterfactual:gate threshold 50% 下,校準後邊啲單會被 block,
 *     最終 PnL 由 -45% 變幾多。
 *
 * 執行:npx tsx scripts/p1-calibration-backtest.ts
 */
import fs from 'node:fs';
import { LLMConvictionCalibrator } from '../src/analysis/llm-conviction-calibrator.ts';

interface Trade {
  symbol: string;
  side: string;
  pnlPct: number;
  entryThesis?: string;
  exitThesis?: string;
  closeReason?: string;
}

function extractConviction(t: Trade): number | null {
  // 優先 entryThesis OLR P(win)(entry-time 訊號)
  const o = (t.entryThesis ?? '').match(/P\(win\)=(\d+)%|P=(\d+)%/);
  if (o) return parseInt(o[1] ?? o[2]!) / 100;
  // fallback exitThesis Avg conf(close-time consensus)
  const c = (t.exitThesis ?? '').match(/Avg conf[^:]*:\s*(\d+)/i);
  if (c) return parseInt(c[1]) / 100;
  return null;
}

function main(): void {
  const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
  const trades: Trade[] = (d.realTrades ?? [])
    .sort((a: { openedAt: number }, b: { openedAt: number }) => (a.openedAt ?? 0) - (b.openedAt ?? 0))
    .slice(-40);

  const withConv = trades.filter(t => extractConviction(t) !== null);
  console.log(`=== 40 單中 ${withConv.length} 單有 conviction 數據 ===\n`);

  // 1. 分桶:conviction → 實際 WR
  const buckets = new Map<number, { n: number; win: number; sum: number }>();
  for (const t of withConv) {
    const conv = extractConviction(t)!;
    const b = Math.floor(conv * 10) / 10;
    const e = buckets.get(b) ?? { n: 0, win: 0, sum: 0 };
    e.n++;
    if (t.pnlPct > 0) e.win++;
    e.sum += t.pnlPct * 100;
    buckets.set(b, e);
  }
  console.log('── conviction 分桶 vs 實際 WR ──');
  console.log('conviction   n   實際WR    avgPnlPct');
  for (const [b, e] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${b.toFixed(1)}      ${String(e.n).padStart(2)}   ${(e.win / e.n * 100).toFixed(0).padStart(3)}%   ${e.sum / e.n >= 0 ? '+' : ''}${(e.sum / e.n).toFixed(2)}%`);
  }

  // 2. 校準器 shrinkage
  const calib = new LLMConvictionCalibrator('/tmp/p1-backtest-calib.json');
  for (const t of withConv) {
    const conv = extractConviction(t)!;
    calib.recordDecision(t.side === 'sell' ? 'sell' : 'buy', conv, t.pnlPct > 0 ? 'win' : 'loss');
  }
  console.log('\n── 校準後(5-bin shrinkage)──');
  console.log('conviction   校準後   實際WR   判定');
  for (const [b, e] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const cal = calib.getCalibratedConviction('buy', b);
    const verdict = cal < 0.5 ? 'BLOCK(<50%)' : 'PASS';
    console.log(`  ${b.toFixed(1)}      ${cal.toFixed(2)}    ${(e.win / e.n * 100).toFixed(0).padStart(3)}%   ${verdict}`);
  }

  // 3. Counterfactual:threshold 50% 下,校準後 block 邊啲單
  const THRESHOLD = 0.5;
  let keptSum = 0, keptN = 0, keptWin = 0, blockedSum = 0, blockedN = 0;
  for (const t of withConv) {
    const conv = extractConviction(t)!;
    const cal = calib.getCalibratedConviction(t.side === 'sell' ? 'sell' : 'buy', conv);
    if (cal < THRESHOLD) {
      blockedN++;
      blockedSum += t.pnlPct * 100;
    } else {
      keptN++;
      keptSum += t.pnlPct * 100;
      if (t.pnlPct > 0) keptWin++;
    }
  }
  console.log('\n── Counterfactual(gate threshold 50%)──');
  console.log(`blocked: ${blockedN} 單(累計 ${blockedSum >= 0 ? '+' : ''}${blockedSum.toFixed(1)}% margin)`);
  console.log(`kept:    ${keptN} 單(WR ${(keptWin / keptN * 100).toFixed(0)}%,累計 ${keptSum >= 0 ? '+' : ''}${keptSum.toFixed(1)}% margin)`);
  console.log(`\n實際 40 單:累計 -45.45% margin,WR 30%`);
  console.log(`校準後(只入校準信心 ≥50% 嘅單):累計 ${keptSum >= 0 ? '+' : ''}${keptSum.toFixed(1)}% margin,WR ${(keptWin / keptN * 100).toFixed(0)}%`);

  // 4. 校準報告(ECE)
  const report = calib.getCalibrationReport();
  console.log(`\n── 校準報告 ──`);
  console.log(`ECE = ${report.ece}(越低越老實;>0.3 = 嚴重過度自信)`);
  console.log(`totalTrades = ${report.totalTrades}`);
}

main();
