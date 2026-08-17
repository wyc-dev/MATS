// ─── Regime Win-Rate Matrix Backtest (v2.0.869-P14) ─────────────────────
//
// 階段 3:驗證 7×7 win rate 矩陣 P(win | entryRegime × closeRegime) 係咪
// 比邊際 win rate P(win | entryRegime) 更好嘅預測器。
//
// 判斷標準:每個 entry regime 嘅 winRateSpread(條件 win rate 嘅 max-min)。
// 如果 spread 大(平倉 regime 顯著影響 win rate),代表 7×7 矩陣有預測價值。
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
  console.log(`=== Regime Win-Rate Matrix Backtest ===`);
  console.log(`realTrades 總數: ${realTrades.length}`);
  console.log(`有 regime + closeRegime 嘅 trade: ${withBoth.length}`);
  console.log('');

  if (withBoth.length === 0) {
    console.log('⚠️ 冇 trade 同時有 regime + closeRegime——需要先跑幾個 cycle 累積數據。');
    return;
  }

  const rows = computeRegimeWinRateMatrix(withBoth);
  console.log('=== 每個 entry regime 嘅 7×7 條件 win rate 矩陣 ===');
  for (const row of rows) {
    console.log('');
    console.log(`【${row.entryRegime}】 n=${row.n} 邊際 win rate=${(row.marginalWinRate * 100).toFixed(0)}% spread=${(row.winRateSpread * 100).toFixed(0)}pp`);
    for (const cell of row.cells) {
      console.log(`   → ${cell.closeRegime}: ${cell.wins}/${cell.n} = ${(cell.winRate * 100).toFixed(0)}%`);
    }
  }

  console.log('');
  console.log('=== 結論 ===');
  // 判斷:有冇 entry regime 嘅 winRateSpread 顯著(>20pp)且樣本夠(n>=10)
  const significant = rows.filter(r => r.winRateSpread > 0.20 && r.n >= 10);
  if (significant.length > 0) {
    console.log(`✅ 7×7 矩陣有預測價值——${significant.length} 個 entry regime 嘅 winRateSpread 顯著:`);
    for (const r of significant) {
      console.log(`   ${r.entryRegime}: spread ${(r.winRateSpread * 100).toFixed(0)}pp (n=${r.n})——平倉 regime 顯著影響 win rate`);
    }
    console.log('→ 建議:實施階段 4(7×7 win rate 矩陣注入 conviction gate)');
  } else {
    console.log('❌ 7×7 矩陣冇顯著預測價值(winRateSpread 全部 <20pp 或樣本 <10)');
    console.log('→ 建議:唔做階段 4(避免過度擬合)');
  }
}

main();
