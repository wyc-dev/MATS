// ─── 實驗 1: SL margin-basis 收窄 sweep ─────────────────────────────
// PLAN_DRAM-loss-defense §2 實驗 1
// 假設: SL floor 改 margin-basis（price 距離 = X%/lev）會削減尾部損失,
//       同時唔誤傷贏單。
// 方法: 347 單全樣本重放——用 minValueReached（margin-basis equity 最差點）
//       判斷 MAE 有冇穿越候選 SL。穿越 → 損失鎖定 X%; 冇穿越 → 損失照原。
//       零 look-ahead（全部用開倉己知 SL 距離 + 已發生 MAE）。
// 三關: ①全局 Δ ②兩半（時間序）③敏感性。

import fs from 'node:fs';

interface Trade {
  symbol: string; side: string; entryPrice: number; exitPrice: number;
  pnlPct: number; closeReason: string; openedAt: number;
  investment?: number; minValueReached?: number; leverage?: number;
}

const state = JSON.parse(fs.readFileSync('data/evolution/portfolio-state.json', 'utf8'));
const trades: Trade[] = (state.realTrades ?? state.closedRealTrades ?? []);

function maeMarginPct(t: Trade): number {
  // minValueReached 係 margin-basis equity 最差點（margin + unrealized PnL）
  const inv = t.investment;
  const min = t.minValueReached;
  if (!inv || inv <= 0 || min === undefined || min === null || !Number.isFinite(min)) return NaN;
  return (min - inv) / inv; // negative = adverse
}

function simulate(t: Trade, xMarginPct: number): number {
  const lev = t.leverage && t.leverage > 0 ? t.leverage : 1;
  const slPriceDistPct = xMarginPct / lev; // margin% → price%
  const maes = maeMarginPct(t);
  if (!Number.isFinite(maes)) return t.pnlPct; // no data → unchanged
  // entry 已知, 用 price dist 判斷穿越（margin MAE 已含槓桿, 直接比較）
  if (maes <= -(xMarginPct / 100)) {
    // 穿越 SL → 止蝕損失 = -X% margin (slippage 實測 ≈0)
    return -xMarginPct / 100;
  }
  return t.pnlPct;
}

function runSweep(xList: number[], label: string): void {
  console.log(`\n=== ${label} ===`);
  console.log('X% margin | ΔPnL(pp) | tail>8%%(單) | tail>10%%(單) | 誤傷贏單 | winners誤傷%% | 均值%');
  const base = trades.reduce((s, t) => s + (Number.isFinite(t.pnlPct) ? t.pnlPct : 0), 0);
  const baseTail8 = trades.filter(t => (t.pnlPct ?? 0) <= -0.08).length;
  const baseTail10 = trades.filter(t => (t.pnlPct ?? 0) <= -0.10).length;
  console.log(`(基線)      | —        | ${baseTail8}         | ${baseTail10}          | —      | —        | ${(base / trades.length * 100).toFixed(2)} (Σ ${(base * 100).toFixed(1)}pp)`);
  for (const X of xList) {
    let delta = 0; let tail8 = 0; let tail10 = 0; let hurtWin = 0; let winTotal = 0; let hurtSum = 0;
    for (const t of trades) {
      const orig = Number.isFinite(t.pnlPct) ? t.pnlPct : 0;
      const sim = simulate(t, X);
      delta += (sim - orig);
      if (sim <= -0.08) tail8++;
      if (sim <= -0.10) tail10++;
      if (orig > 0) {
        winTotal++;
        if (sim < orig) { hurtWin++; hurtSum += (orig - sim); }
      }
    }
    console.log(`${X}% | ${(delta * 100).toFixed(1)} | ${tail8} | ${tail10} | ${hurtWin}/${winTotal} | ${(hurtWin / winTotal * 100).toFixed(1)}% | ${((base + delta) / trades.length * 100).toFixed(2)}`);
  }
}

// ① 全局 sweep
runSweep([3, 4, 5, 6, 7, 8, 10], '① 全局 sweep');

// 三關②: 兩半（按 openedAt 時間序）
const sortedTrades = [...trades].sort((a, b) => a.openedAt - b.openedAt);
const halfN = Math.floor(sortedTrades.length / 2);
// 暫時替換 global trades 做半份 sweep（用閉包注入）
function runHalf(halves: Trade[], label: string): void {
  const orig = trades; // noop placeholder
  void orig;
  const halfArr = halves;
  console.log(`\n=== ${label} (n=${halfArr.length}) ===`);
  const base = halfArr.reduce((s, t) => s + (Number.isFinite(t.pnlPct) ? t.pnlPct : 0), 0);
  console.log(`(基線) avg=${(base / halfArr.length * 100).toFixed(2)}% Σ=${(base * 100).toFixed(1)}pp`);
  for (const X of [3, 5, 6, 7]) {
    let delta = 0; let tail8 = 0; let hurtWin = 0; let winTotal = 0;
    for (const t of halfArr) {
      const origP = Number.isFinite(t.pnlPct) ? t.pnlPct : 0;
      const sim = simulate(t, X);
      delta += (sim - origP);
      if (sim <= -0.08) tail8++;
      if (origP > 0) { winTotal++; if (sim < origP) hurtWin++; }
    }
    console.log(`${X}% | Δ${(delta * 100).toFixed(1)}pp | tail>8%:${tail8} | 誤傷贏單:${hurtWin}/${winTotal}`);
  }
}
runHalf(sortedTrades.slice(0, halfN), '②a 期1（前半 n=' + halfN + '）');
runHalf(sortedTrades.slice(halfN), '②b 期2（後半 n=' + (sortedTrades.length - halfN) + '）');

// 三關③: 敏感性（X 附近 ±1% 應該連續）
runSweep([4.5, 5, 5.5, 6, 6.5], '③ 敏感性 5-6% 帶');
