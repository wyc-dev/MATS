// ─── Regime Win-Rate Matrix + Transition Matrix (v2.0.869-P14) ─────────
//
// 主神洞察:隔 12-24 小時嘅 trade,開倉 regime 同平倉 regime 可以完全唔同。
// 呢個模組學兩個完整 7×7 矩陣:
//   1. 轉移矩陣 P(closeRegime | entryRegime)——「開倉 regime → 平倉 regime」
//      嘅動態(regime 點樣喺 12-24h 內演變)
//   2. win rate 矩陣 P(win | entryRegime × closeRegime)——每個 (開倉,平倉)
//      組合嘅 win rate
// 開倉時用邊際 win rate(對 closeRegime 加權平均),但學習係用兩個完整矩陣
// 捕捉「開倉 A → 平倉 B」嘅精細互動。
//
// 純函數模組:無 I/O、無狀態、決定性、可單元測試。回測 script 用佢驗證
// 兩個 7×7 矩陣係咪比邊際 win rate 更好嘅預測器(階段 3)。

export interface RegimeWinRateCell {
  entryRegime: string;
  closeRegime: string;
  n: number;
  wins: number;
  /** P(win | entryRegime × closeRegime)——條件 win rate */
  winRate: number;
  /** P(closeRegime | entryRegime)——轉移機率(呢個 entry regime 有幾多機率轉去呢個 close regime) */
  transitionProb: number;
}

export interface RegimeWinRateRow {
  entryRegime: string;
  n: number;
  /** 邊際 win rate(對 closeRegime 加權平均)——開倉時用 */
  marginalWinRate: number;
  /** 7×7 條件矩陣嘅 cells(按 n 降序)——含 winRate + transitionProb */
  cells: RegimeWinRateCell[];
  /** 條件 win rate 嘅 spread(max - min)——衡量「平倉 regime 有幾影響 win rate」 */
  winRateSpread: number;
}

export interface RegimeWinRateInput {
  regime?: string;       // 開倉 regime
  closeRegime?: string;  // 平倉 regime
  pnlPct?: number;       // 盈虧 %
}

/**
 * 計算兩個完整 7×7 矩陣:
 *   1. 轉移矩陣 P(closeRegime | entryRegime)
 *   2. win rate 矩陣 P(win | entryRegime × closeRegime)
 * 攻擊硬化:regime/closeRegime 缺失 → skip;pnlPct NaN → 當 0。
 */
export function computeRegimeWinRateMatrix(trades: RegimeWinRateInput[]): RegimeWinRateRow[] {
  // 按 (entryRegime × closeRegime) 分組
  const byCell = new Map<string, { entryRegime: string; closeRegime: string; n: number; wins: number }>();
  for (const t of trades) {
    if (!t.regime || !t.closeRegime) continue;
    const win = Number.isFinite(t.pnlPct) ? (t.pnlPct as number) > 0 : false;
    const key = `${t.regime}|${t.closeRegime}`;
    const cell = byCell.get(key) ?? { entryRegime: t.regime, closeRegime: t.closeRegime, n: 0, wins: 0 };
    cell.n += 1;
    if (win) cell.wins += 1;
    byCell.set(key, cell);
  }

  // 按 entryRegime 分組
  const byEntry = new Map<string, Array<{ entryRegime: string; closeRegime: string; n: number; wins: number }>>();
  for (const cell of byCell.values()) {
    const arr = byEntry.get(cell.entryRegime) ?? [];
    arr.push(cell);
    byEntry.set(cell.entryRegime, arr);
  }

  const rows: RegimeWinRateRow[] = [];
  for (const [entryRegime, cellsRaw] of byEntry) {
    const n = cellsRaw.reduce((a, c) => a + c.n, 0);
    const wins = cellsRaw.reduce((a, c) => a + c.wins, 0);
    const marginalWinRate = n > 0 ? wins / n : 0;
    // 每個 cell 計算 winRate + transitionProb(轉移機率 = n / totalN)
    const cells: RegimeWinRateCell[] = cellsRaw.map(c => ({
      ...c,
      winRate: c.n > 0 ? c.wins / c.n : 0,
      transitionProb: n > 0 ? c.n / n : 0,
    })).sort((a, b) => b.n - a.n);
    const winRates = cells.map(c => c.winRate);
    const winRateSpread = winRates.length > 0 ? Math.max(...winRates) - Math.min(...winRates) : 0;
    rows.push({
      entryRegime,
      n,
      marginalWinRate,
      cells,
      winRateSpread,
    });
  }
  // 按 n 降序(樣本多嘅 regime 排前)
  return rows.sort((a, b) => b.n - a.n);
}
