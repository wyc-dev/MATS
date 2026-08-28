/**
 * P9-lock-pipeline-rescue-analysis:鎖利管道單位錯配修復——保守可達分析
 *
 * 主神 2026-08-28 指令:「驗證現時是否能夠把先前的 269 個 trade 都盡可能做到盈利;
 * 增加盈利頻率;先驗證絕對成效,之後先 fix with top tier production grade logic」
 *
 * METHODOLOGY（保守）:
 *   - 數據源: portfolio-state.json realTrades（269 喺）——minValueReached/maxValueReached
 *     係 margin-basis（investment 就係 margin——P8-heal-unit-fix 已確認）,
 *     MAE/MFE 已由 healer 補正
 *   - margin-basis MFE（side-aware: BUY=max 有利 / SELL=min 有利）
 *   - 方案模擬: 當 margin MFE ≥ θ 且最終蝕 → 「鎖利點」= max(lockMin, MFE×(1-giveback))
 *     ——保守: 唔用 MFE 全值（實時唔知 peak, 回吐一半先鎖, 同 P8 確認式一致）
 *   - 大 winner 誤鎖審計: MFE ≥ 15% 嘅單鎖利點必須 ≥ 0.5×MFE 先算合格
 *     （保留回吐空間——P8-profit 紅線「零大 winner 誤鎖」）
 *   - 新 PnL = basePnl + Σ(鎖利點 − 原pnl)（只限救返嘅蝕單; 贏單唔郁）
 *
 * ⚠️ Read-only。Usage: npx tsx scripts/p9-lock-pipeline-rescue-analysis.ts
 */
import fs from 'node:fs';

interface RT {
  symbol?: string; side?: string; investment?: number; pnlPct?: number; closeReason?: string;
  minValueReached?: number; maxValueReached?: number;
}

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf-8'));
const trades: RT[] = (state.realTrades ?? []).filter((t: RT) => t.pnlPct !== undefined);
console.log(`樣本: ${trades.length} 喺\n`);

function marginMfe(t: RT): number {
  const inv = t.investment ?? 0;
  if (inv <= 0) return 0;
  const side = t.side;
  if (side === 'buy') return ((t.maxValueReached ?? 0) - inv) / inv * 100;
  if (side === 'sell') return ((t.minValueReached ?? 0) - inv) / inv * 100;
  return 0;
}

const wins = trades.filter(t => (t.pnlPct ?? 0) > 0);
const baseWr = wins.length / trades.length * 100;
const basePnl = trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0);
console.log(`=== 對照組（現狀）===`);
console.log(`WR: ${baseWr.toFixed(1)}% (${wins.length}/${trades.length}) | 總 PnL: ${basePnl.toFixed(2)}%\n`);

const BIG_WINNER_MFE = 15;

function simulate(
  label: string,
  lockThresholds: number[],
  giveback: number,
  applyTo: (t: RT) => boolean,
  lockMin = 0.3,
) {
  console.log(`=== ${label} ===`);
  for (const theta of lockThresholds) {
    let rescued = 0, bigWinnerBlocked = 0, deltaPnl = 0, lockedTotal = 0;
    for (const t of trades) {
      if (!applyTo(t)) continue;
      const pnl = t.pnlPct ?? 0;
      if (pnl >= 0) continue;                    // 只救蝕單
      const mfe = marginMfe(t);
      if (mfe < theta) continue;                 // 未到門檻
      const lockPoint = Math.max(lockMin, mfe * (1 - giveback));
      if (mfe >= BIG_WINNER_MFE && lockPoint < 0.5 * mfe) { bigWinnerBlocked++; continue; }
      rescued++;
      lockedTotal += lockPoint;
      deltaPnl += lockPoint - pnl;               // 改善量（原本蝕 pnl, 而家鎖 lockPoint）
    }
    const newPnl = basePnl + deltaPnl;
    const newWr = (wins.length + rescued) / trades.length * 100;
    console.log(
      `  θ=${theta.toFixed(1)}% 回吐${(giveback * 100)}% → 救返 ${rescued} 單 | ` +
      `WR ${newWr.toFixed(1)}% (${wins.length + rescued}/${trades.length}) | ` +
      `PnL ${basePnl.toFixed(2)}% → ${newPnl.toFixed(2)}% (Δ${deltaPnl.toFixed(2)}%) | ` +
      `鎖利總和 ${lockedTotal.toFixed(2)}% | 大winner保護 ${bigWinnerBlocked}`,
    );
  }
  console.log('');
}

// A: 所有浮盈蝕單（統一 margin-basis 鎖利管道）
simulate('方案 A: 鎖利管道 margin-basis 校準（救所有浮盈蝕單）', [0.3, 0.5, 0.8, 1.0], 0.5, () => true);
// B: sl_tp 前提早鎖
simulate('方案 B: sl_tp 前浮盈提早鎖', [0.3, 0.5, 0.8], 0.5, (t) => t.closeReason === 'sl_tp');
// C: consensus close defer 門檻降低
simulate('方案 C: consensus close 浮盈門檻降低', [0.3, 0.5, 0.8], 0.5, (t) => t.closeReason === 'consensus');
// A+B+C 組合: 全蝕單 + 最低門檻
simulate('方案 A+B+C 組合: 全蝕單 θ=0.5%', [0.5], 0.5, () => true);

// ── 大 winner 誤鎖審計 ──
console.log(`=== 大 winner 誤鎖審計（MFE ≥ ${BIG_WINNER_MFE}% margin）===`);
const bigWinners = trades.filter(t => marginMfe(t) >= BIG_WINNER_MFE);
console.log(`大 winner 單數: ${bigWinners.length} 個\n`);
for (const t of bigWinners) {
  const mfe = marginMfe(t);
  const pnl = t.pnlPct ?? 0;
  const lock = Math.max(0.3, mfe * 0.5);
  console.log(
    `  ${t.symbol} ${t.side} close=${t.closeReason} MFE=${mfe.toFixed(1)}% 實際pnl=${pnl.toFixed(2)}% ` +
    `${pnl < 0 ? `→ 方案鎖利點 ${lock.toFixed(1)}% (0.5×MFE——保留 50% 回吐, 救返)` : '(原本已贏——唔會郁)'}`,
  );
}
