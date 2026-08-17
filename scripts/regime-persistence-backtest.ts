// ─── Regime Win-Rate Matrix + Transition Matrix Backtest (v2.0.869-P14) ──
//
// 階段 3:驗證兩個 7×7 矩陣(轉移矩陣 P(closeRegime | entryRegime) + win rate
// 矩陣 P(win | entryRegime × closeRegime))係咪比邊際 win rate 更好嘅預測器。
//
// 判斷標準:
//   1. winRateSpread(條件 win rate 嘅 max-min)> 20pp 且 n≥10 → win rate 矩陣有價值
//   2. 轉移矩陣集中(某個 close regime 嘅 transitionProb 高)→ 開倉 regime 可預測平倉 regime
//
// 用法:npx tsx scripts/regime-persistence-backtest.ts

import { computeRegimeWinRateMatrix } from '../src/analysis/regime-persistence.ts';
import * as fs from 'node:fs';

const statePath = 'data/evolution/portfolio-state.json';

function main(): void {
  if (!fs.existsSync(statePath)) {
    console.error(`State file not found: ${statePath}`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
    realTrades?: Array<{ regime?: string; closeRegime?: string; pnlPct?: number; symbol?: string; side?: string }>;
  };
  const realTrades = state.realTrades ?? [];
  const withBoth = realTrades.filter(t => t.regime && t.closeRegime);
  console.log(`=== Regime Win-Rate Matrix + Transition Matrix Backtest ===`);
  console.log(`realTrades 總數: ${realTrades.length}`);
  console.log(`有 regime + closeRegime 嘅 trade: ${withBoth.length}`);
  console.log('');

  if (withBoth.length === 0) {
    console.log('⚠️ 冇 trade 同時有 regime + closeRegime——需要先跑幾個 cycle 累積數據。');
    return;
  }

  const rows = computeRegimeWinRateMatrix(withBoth);
  console.log('=== 每個 entry regime 嘅 7×7 矩陣(轉移機率 + 條件 win rate) ===');
  for (const row of rows) {
    console.log('');
    console.log(`【${row.entryRegime}】 n=${row.n} 邊際 win rate=${(row.marginalWinRate * 100).toFixed(0)}% spread=${(row.winRateSpread * 100).toFixed(0)}pp`);
    for (const cell of row.cells) {
      console.log(`   → ${cell.closeRegime}: ${cell.wins}/${cell.n} = ${(cell.winRate * 100).toFixed(0)}% (轉移機率 ${(cell.transitionProb * 100).toFixed(0)}%)`);
    }
  }

  console.log('');
  console.log('=== 結論 ===');
  // 判斷 1:win rate 矩陣有冇價值(winRateSpread 顯著)
  const winRateSignificant = rows.filter(r => r.winRateSpread > 0.20 && r.n >= 10);
  // 判斷 2:轉移矩陣有冇價值(某個 close regime 嘅 transitionProb 高——可預測)
  const transitionConcentrated = rows.filter(r =>
    r.n >= 10 && r.cells.length > 0 && r.cells[0]!.transitionProb > 0.5,
  );

  if (winRateSignificant.length > 0) {
    console.log(`✅ win rate 矩陣有預測價值——${winRateSignificant.length} 個 entry regime 嘅 winRateSpread 顯著:`);
    for (const r of winRateSignificant) {
      console.log(`   ${r.entryRegime}: spread ${(r.winRateSpread * 100).toFixed(0)}pp (n=${r.n})——平倉 regime 顯著影響 win rate`);
    }
  } else {
    console.log('❌ win rate 矩陣冇顯著預測價值(winRateSpread 全部 <20pp 或樣本 <10)');
  }

  if (transitionConcentrated.length > 0) {
    console.log(`✅ 轉移矩陣有預測價值——${transitionConcentrated.length} 個 entry regime 嘅轉移集中:`);
    for (const r of transitionConcentrated) {
      const top = r.cells[0]!;
      console.log(`   ${r.entryRegime}: ${(top.transitionProb * 100).toFixed(0)}% 轉去 ${top.closeRegime}——開倉 regime 可預測平倉 regime`);
    }
  } else {
    console.log('❌ 轉移矩陣冇顯著預測價值(冇 close regime 嘅 transitionProb > 50%)');
  }

  if (winRateSignificant.length > 0 || transitionConcentrated.length > 0) {
    console.log('→ 建議:實施階段 4(兩個 7×7 矩陣注入 conviction gate)');
  } else {
    console.log('→ 建議:唔做階段 4(避免過度擬合)');
  }
}

main();
