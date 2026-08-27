/**
 * v2.0.870 live 監控（compact 版）——1 行輸出，供定時 loop append 到 log。
 *
 * 輸出格式: WR=70% PnL=+10.99% SELL=0 bins=10 ECE=0.209 blocked=1
 */
import fs from 'node:fs';
import { EVFilter } from '../src/analysis/ev-filter.ts';
import { LLMConvictionCalibrator } from '../src/analysis/llm-conviction-calibrator.ts';

function main(): void {
  const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
  const trades = (d.realTrades ?? []).sort((a: { openedAt: number }, b: { openedAt: number }) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
  const last20 = trades.slice(-20);
  const wins = last20.filter(t => (t.pnlPct || 0) > 0).length;
  const sum = last20.reduce((a, t) => a + (t.pnlPct || 0) * 100, 0);
  const sellCount = last20.filter(t => t.side === 'sell').length;

  const f = new EVFilter('data/evolution/ev-filter.json');
  f.load();
  const evState = JSON.parse(fs.readFileSync('data/evolution/ev-filter.json', 'utf-8'));
  let blocked = 0;
  for (const [k] of Object.entries(evState.samples || {})) {
    const [sym, side] = k.split('|');
    if (f.shouldBlockNegativeEV(sym, side as 'buy' | 'sell').blocked) blocked++;
  }

  const c = new LLMConvictionCalibrator('data/evolution/llm-conviction-calibration.json');
  c.load();
  const report = c.getCalibrationReport();

  const wr = (wins / last20.length * 100).toFixed(0);
  const pnl = (sum >= 0 ? '+' : '') + sum.toFixed(2);
  const ece = report.ece !== null ? report.ece.toFixed(3) : 'null';
  console.log(`WR=${wr}% PnL=${pnl}% SELL=${sellCount} bins=${c.getStats().bins} ECE=${ece} blocked=${blocked}`);
}

main();
