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

/** v2.0.870-P3: 硬性 SELL 探索——extreme_buy 失衡時,range(均值回歸)市場
 *  近阻力位 → 強制 SELL(分布層對沖)。
 *
 *  量化金融設計(避免「強制 = 逆勢接刀」嘅 G2 原限制):
 *    - 只喺 extreme_buy(最近 20 單 ≥90% BUY 且 0 SELL)時觸發——斬斷 100% BUY 死循環
 *    - 只喺 range 市場(mean_reverting / low_volatility)——均值回歸有 edge,
 *      唔係 trending_bull(追漲市場逆勢 sell = 送死)
 *    - 只喺近阻力位(positionInRange > 0.65)——均值回歸話「阻力位回落」,
 *      唔係喺 support 位追跌
 *
 *  呢個係分布層對沖(補 sell 樣本回 OLR),唔係 signal 層強制——只適用於
 *  有均值回歸 edge 嘅 range 市場,trending_bull 照樣 BUY。垃圾輸入保守(唔觸發)。 */
export function shouldForceSellOnImbalance(
  sideBalance: SideBalanceSnapshot | null | undefined,
  regime: string | null | undefined,
  positionInRange: number,
): boolean {
  if (!sideBalance || sideBalance.state !== 'extreme_buy') return false;
  const isRange = regime === 'mean_reverting' || regime === 'low_volatility';
  if (!isRange) return false;
  if (typeof positionInRange !== 'number' || !Number.isFinite(positionInRange)) return false;
  return positionInRange > 0.65;
}
