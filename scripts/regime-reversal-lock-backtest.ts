// ─── Regime-Reversal Lock Backtest (v2.0.869-P14) ──────────────────────
//
// 驗證主神嘅諗法:「regime 反轉鎖利」——盈利倉喺 regime 反轉時鎖利,避免「贏變蝕」。
//
// 由於歷史 trade 冇 closeRegime(P14 先開始捕獲),本回測用 MFE 回吐做 proxy:
//   - MFE% 高(贏咗)但 pnlPct 負(反蝕)= 「反轉」trade(regime 反轉嘅價格表現)
//   - 模擬:喺 MFE 峰值嘅 70% 位置鎖利,比較模擬盈利 vs 實際盈利
//
// 用法:npx tsx scripts/regime-reversal-lock-backtest.ts

import * as fs from 'node:fs';

const statePath = 'data/evolution/portfolio-state.json';

interface Trade {
  symbol?: string;
  side?: string;
  investment?: number;
  maxValueReached?: number;
  minValueReached?: number;
  pnlPct?: number;
  pnl?: number;
  closeReason?: string;
}

function main(): void {
  if (!fs.existsSync(statePath)) {
    console.error(`State file not found: ${statePath}`);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { realTrades?: Trade[] };
  const trades = state.realTrades ?? [];
  console.log(`=== Regime-Reversal Lock Backtest (MFE proxy) ===`);
  console.log(`realTrades 總數: ${trades.length}`);
  console.log('');

  // 計算每個 trade 嘅 MFE%(最大順向幅度)
  const withMfe = trades
    .map(t => {
      const investment = t.investment ?? 0;
      const maxValue = t.maxValueReached ?? 0;
      const mfePct = investment > 0 ? (maxValue - investment) / investment : 0;
      return { ...t, mfePct };
    })
    .filter(t => t.investment && t.investment > 0);

  // 分類:「反轉」trade = MFE% 高(贏咗)但 pnlPct 負(反蝕)
  const MFE_THRESHOLD = 0.01; // MFE ≥ 1%(贏咗至少 1%)
  const reversed = withMfe.filter(t => t.mfePct >= MFE_THRESHOLD && (t.pnlPct ?? 0) < 0);
  const persisted = withMfe.filter(t => t.mfePct >= MFE_THRESHOLD && (t.pnlPct ?? 0) >= 0);

  console.log(`有 MFE ≥ 1% 嘅 trade: ${reversed.length + persisted.length}`);
  console.log(`  「反轉」trade(MFE≥1% 但蝕): ${reversed.length}`);
  console.log(`  「持續」trade(MFE≥1% 且賺): ${persisted.length}`);
  console.log('');

  if (reversed.length === 0) {
    console.log('⚠️ 冇「反轉」trade——數據唔夠做回測。');
    return;
  }

  // 模擬:喺 MFE 峰值嘅 70% 位置鎖利
  const LOCK_RATIO = 0.7; // 鎖 70% 嘅 MFE
  let totalActualPnl = 0;
  let totalSimulatedPnl = 0;
  let improvedCount = 0;
  let worsenedCount = 0;

  for (const t of reversed) {
    const actualPnlPct = t.pnlPct ?? 0;
    const simulatedPnlPct = t.mfePct * LOCK_RATIO; // 鎖 70% MFE
    totalActualPnl += actualPnlPct;
    totalSimulatedPnl += simulatedPnlPct;
    if (simulatedPnlPct > actualPnlPct) improvedCount++;
    else worsenedCount++;
  }

  console.log('=== 模擬結果(鎖 70% MFE) ===');
  console.log(`「反轉」trade 數: ${reversed.length}`);
  console.log(`實際總 pnlPct: ${(totalActualPnl * 100).toFixed(2)}%`);
  console.log(`模擬總 pnlPct: ${(totalSimulatedPnl * 100).toFixed(2)}%`);
  console.log(`改善 trade: ${improvedCount}/${reversed.length} (${(improvedCount / reversed.length * 100).toFixed(0)}%)`);
  console.log(`惡化 trade: ${worsenedCount}/${reversed.length}`);
  console.log('');

  // 按 closeReason 分組(睇邊啲 close 原因最常「反轉」)
  const byReason = new Map<string, number>();
  for (const t of reversed) {
    const reason = t.closeReason ?? 'unknown';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  console.log('「反轉」trade 按 closeReason 分組:');
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${reason}: ${count}`);
  }
  console.log('');

  // 結論
  const improvement = totalSimulatedPnl - totalActualPnl;
  console.log('=== 結論 ===');
  if (improvement > 0 && improvedCount / reversed.length > 0.7) {
    console.log(`✅ 鎖利有盈利提升:總 pnlPct 改善 ${(improvement * 100).toFixed(2)}%,${improvedCount}/${reversed.length} trade 改善`);
    console.log('→ 建議:實施「regime 反轉鎖利」gate(獨立 gate,唔改 thesis invalidation)');
  } else {
    console.log('❌ 鎖利冇顯著盈利提升');
    console.log('→ 建議:唔做(避免過度擬合)');
  }
}

main();
