// ─── Side-Balance Monitor (v2.0.870-sell-decay-attack G2) ──────────────
//
// 主神指令 2026-08-24: 「避免再次出現單向問題」——系統性防禦。
//
// 問題: 近 90 單 100% BUY 零 SELL——單向失衡 4 日冇人察覺（除咗主神手動睇）。
//
// 設計: 純函數，監測最近 N 個 real trades 嘅 side 比例。當單側佔 ≥ threshold
// （預設 90%）且另一側喺窗口內 0 嘗試 → 判定 extreme 失衡 → caller 觸發警告
// （observability + 提示 sell 播種狀態）。唔自動強制開另一側（單邊牛市賣真係
// 難——強制 = 逆勢接刀），但係失衡要 LOUD——唔可以再靜靜地 4 日冇人知。

export interface SideBalanceSnapshot {
  /** 分析窗口 trade 數 */
  windowN: number;
  buyCount: number;
  sellCount: number;
  /** buy 佔比 (0-1) */
  buyShare: number;
  /** 'extreme_buy' | 'extreme_sell' | 'balanced' */
  state: 'extreme_buy' | 'extreme_sell' | 'balanced';
}

/** 純函數：分析最近 trades 嘅側邊平衡。trades 係最近 windowN 個已關倉 trade
 *  （任何排序，count 唔依賴順序）。threshold: 單側佔比 ≥ threshold 且另一側
 *  0 → extreme（預設 0.90）。窗口太少（<5）→ balanced（樣本不足唔報警）。 */
export function analyzeSideBalance(
  trades: Array<{ side: 'buy' | 'sell' }>,
  windowN = 20,
  threshold = 0.90,
): SideBalanceSnapshot {
  const n = trades.length;
  if (n < 5) return { windowN: n, buyCount: 0, sellCount: 0, buyShare: 0.5, state: 'balanced' };
  const buyCount = trades.filter(t => t.side === 'buy').length;
  const sellCount = n - buyCount;
  const buyShare = buyCount / n;
  const majorityShare = Math.max(buyShare, 1 - buyShare);
  const minorityCount = Math.min(buyCount, sellCount);
  if (majorityShare >= threshold && minorityCount === 0) {
    return {
      windowN: n,
      buyCount,
      sellCount,
      buyShare,
      state: buyShare > 0.5 ? 'extreme_buy' : 'extreme_sell',
    };
  }
  return { windowN: n, buyCount, sellCount, buyShare, state: 'balanced' };
}
