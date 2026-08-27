/**
 * v2.0.870 live 監控——觀察 P1-P6 合併成效。
 *
 * 追蹤指標:
 *  1. WR / PnL（最近 20 單）——應由 40%/-12% 改善到 ≥50%/正
 *  2. SELL 樣本回流（P3 強制 SELL）——應由 0 增加
 *  3. Calibrator bins（P1 校準）——應由空增加
 *  4. EV 硬閘 block 數（P2 選擇性）——應反映負 EV 方向
 *  5. ECE（P4 校準感知）——應由 0.396 下降
 *
 * 執行:npx tsx scripts/live-monitor.ts
 */
import fs from 'node:fs';
import { EVFilter } from '../src/analysis/ev-filter.ts';
import { LLMConvictionCalibrator } from '../src/analysis/llm-conviction-calibrator.ts';

function main(): void {
  const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
  const trades = (d.realTrades ?? []).sort((a: { openedAt: number }, b: { openedAt: number }) => (a.openedAt ?? 0) - (b.openedAt ?? 0));

  // 1. WR / PnL（最近 20 單）
  const last20 = trades.slice(-20);
  const wins = last20.filter(t => (t.pnlPct || 0) > 0).length;
  const sum = last20.reduce((a, t) => a + (t.pnlPct || 0) * 100, 0);
  const sellCount = last20.filter(t => t.side === 'sell').length;
  console.log('=== 最近 20 單 ===');
  console.log(`WR: ${(wins / last20.length * 100).toFixed(0)}%  PnL: ${sum >= 0 ? '+' : ''}${sum.toFixed(2)}% margin  SELL: ${sellCount} 單`);

  // 2. 最近 5 單明細
  console.log('\n=== 最近 5 單 ===');
  for (const t of last20.slice(-5)) {
    const dt = new Date(t.openedAt).toISOString().slice(5, 16).replace('T', ' ');
    console.log(`  ${dt} ${(t.symbol || '').padEnd(10)} ${(t.side || '').padEnd(4)} pnl=${((t.pnlPct || 0) * 100).toFixed(2).padStart(7)}% reason=${t.closeReason}`);
  }

  // 3. EV 硬閘 block 數
  const f = new EVFilter('data/evolution/ev-filter.json');
  f.load();
  const evState = JSON.parse(fs.readFileSync('data/evolution/ev-filter.json', 'utf-8'));
  let blocked = 0, blockedList: string[] = [];
  for (const [k] of Object.entries(evState.samples || {})) {
    const [sym, side] = k.split('|');
    if (f.shouldBlockNegativeEV(sym, side as 'buy' | 'sell').blocked) { blocked++; blockedList.push(k); }
  }
  console.log(`\n=== EV 硬閘 ===`);
  console.log(`blocked: ${blocked} 個 (${blockedList.join(', ') || 'none'})`);

  // 4. Calibrator bins + ECE
  const c = new LLMConvictionCalibrator('data/evolution/llm-conviction-calibration.json');
  c.load();
  const report = c.getCalibrationReport();
  console.log(`\n=== Calibrator ===`);
  console.log(`bins: ${c.getStats().bins} 個  ECE: ${report.ece ?? 'null(冷啟動)'}  totalTrades: ${report.totalTrades}`);
}

main();
