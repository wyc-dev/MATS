/**
 * v2.0.870-P2 backtest: Symbol×side EV 硬閘治本成效驗證。
 *
 * 目的:證明「反選擇」(最蝕 symbol 交易最多)係 40 單低質入場嘅根因,
 * 並量化 EV 硬閘封殺負 EV 方向後嘅改善。
 *
 * 方法(邏輯實驗——backfill 種子 + walk-forward,零 look-ahead):
 *  1. 用 EXP records(2441 筆)做 backfill 種子——模擬 production EV Filter
 *     嘅冷啟動狀態(同 backfillFromExpRecords 一致)。
 *  2. 讀 40 單 realTrades,按時間排序。
 *  3. 逐單模擬:用「backfill + 之前已平倉」嘅樣本計 EV,判斷 EV 硬閘會唔會 block。
 *  4. block → 跳過;唔 block → 入場(累計 PnL)。
 *  5. 每單平倉後餵入 EV Filter(供下一單判斷)。
 *
 * 執行:npx tsx scripts/p2-ev-gate-backtest.ts
 */
import fs from 'node:fs';
import { EVFilter } from '../src/analysis/ev-filter.ts';

interface Trade {
  symbol: string;
  side: string;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
}

function main(): void {
  const d = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
  const trades: Trade[] = (d.realTrades ?? [])
    .sort((a: { openedAt: number }, b: { openedAt: number }) => (a.openedAt ?? 0) - (b.openedAt ?? 0))
    .slice(-40);

  const f = new EVFilter('/tmp/p2-backtest-ev.json');

  // 1. Backfill 種子(EXP records——模擬 production 冷啟動狀態)
  const expLines = fs.readFileSync('data/exp/trades.jsonl', 'utf-8').trim().split('\n');
  let seedFed = 0;
  for (const l of expLines) {
    try {
      const r = JSON.parse(l);
      if (!r.symbol || r.pnlPct === undefined) continue;
      const sym = String(r.symbol).toLowerCase();
      const side = r.side === 'sell' ? 'sell' : 'buy';
      const pnlPct = Number(r.pnlPct);
      if (!Number.isFinite(pnlPct)) continue;
      const ts = Number(r.ts);
      f.recordTrade(sym, side, pnlPct, Number.isFinite(ts) && ts > 0 ? ts : Date.now());
      seedFed++;
    } catch { /* skip */ }
  }
  console.log(`Backfill 種子: ${seedFed} 筆 EXP records\n`);

  let actualSum = 0, actualN = 0, actualWin = 0;
  let keptSum = 0, keptN = 0, keptWin = 0, blockedSum = 0, blockedN = 0;
  const blockedBySymbol: Record<string, number> = {};

  for (const t of trades) {
    const side = t.side === 'sell' ? 'sell' : 'buy';
    const sym = t.symbol.toLowerCase();
    actualSum += t.pnlPct * 100;
    actualN++;
    if (t.pnlPct > 0) actualWin++;

    // EV 硬閘判斷(用 backfill + 之前已平倉嘅樣本——walk-forward 零 look-ahead)
    const gate = f.shouldBlockNegativeEV(sym, side);
    if (gate.blocked) {
      blockedN++;
      blockedSum += t.pnlPct * 100;
      blockedBySymbol[sym] = (blockedBySymbol[sym] ?? 0) + 1;
    } else {
      keptN++;
      keptSum += t.pnlPct * 100;
      if (t.pnlPct > 0) keptWin++;
    }

    // 平倉後餵入 EV Filter(供下一單判斷)
    f.recordTrade(sym, side, t.pnlPct, t.closedAt || t.openedAt);
  }

  console.log('=== 40 單 walk-forward EV 硬閘 counterfactual(backfill 種子) ===\n');
  console.log(`實際:      ${actualN} 單,WR ${(actualWin / actualN * 100).toFixed(0)}%,累計 ${actualSum >= 0 ? '+' : ''}${actualSum.toFixed(1)}% margin`);
  console.log(`EV 硬閘後: block ${blockedN} 單(${blockedSum >= 0 ? '+' : ''}${blockedSum.toFixed(1)}% margin),keep ${keptN} 單(WR ${(keptWin / keptN * 100).toFixed(0)}%,${keptSum >= 0 ? '+' : ''}${keptSum.toFixed(1)}% margin)`);
  console.log(`\n改善: ${(keptSum - actualSum) >= 0 ? '+' : ''}${(keptSum - actualSum).toFixed(1)}% margin(避開咗 ${blockedSum >= 0 ? '+' : ''}${blockedSum.toFixed(1)}% 嘅蝕單)`);

  console.log('\n── 被 block 嘅 symbol(反選擇鐵證)──');
  for (const [sym, n] of Object.entries(blockedBySymbol).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sym}: ${n} 單被 block`);
  }

  // 最終 EV Filter 狀態
  console.log('\n── 最終 EV Filter 狀態(負 EV 方向)──');
  for (const sym of ['bnb', 'xyz:SILVER', 'xyz:SKHX', 'xyz:DRAM', 'btc', 'xyz:MU']) {
    const buy = f.getEVStats(sym, 'buy');
    if (buy.n >= 10) {
      console.log(`  ${sym}|buy: n=${buy.n} EV=${(buy.ev * 100).toFixed(2)}% → ${f.shouldBlockNegativeEV(sym, 'buy').blocked ? 'BLOCK' : 'PASS'}`);
    } else {
      console.log(`  ${sym}|buy: n=${buy.n} (冷啟動,唔 block)`);
    }
  }
}

main();
