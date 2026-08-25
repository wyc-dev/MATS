// ─── Exploration Direction — v2.0.870-exploration-dual（主神 2026-08-25）─
// 問題: exploration priority 鏈——OLR sell 毒化 + trending_bull→BUY 規則——
// sell 側永遠輸 → 近 50 單 100% BUY → sell 樣本餓死（死循環）。
// 修復: 「sell 結構性訊號」最高優先級——E1 實證 persistent_bear（續跌型）
// 持續跌勢（mom24<0 且 mom4<0）sell 4h edge WR 55-68%——覆蓋 OLR sell 毒化。
// 純函數零依賴——可測。毒值保守（唔觸發）。

export type Persistence = 'persistent_bear' | 'range' | 'neutral';

export interface SellSignalInput {
  persistence: Persistence | string | null | undefined;
  mom24hPct: number | null | undefined;
  mom4hPct: number | null | undefined;
}

/** sell 結構性訊號: persistent_bear（續跌型）+ mom24<0 + mom4<0（持續跌勢
 *  雙確認——E1 驗證 sell edge WR 55-68%）。垃圾值 → false（唔觸發）。 */
export function shouldExploreSell(input: SellSignalInput): boolean {
  const p = input?.persistence;
  if (p !== 'persistent_bear') return false;
  const m24 = input?.mom24hPct;
  const m4 = input?.mom4hPct;
  if (typeof m24 !== 'number' || !Number.isFinite(m24) || m24 >= 0) return false;
  if (typeof m4 !== 'number' || !Number.isFinite(m4) || m4 >= 0) return false;
  return true;
}

/** BUY 結構性訊號（反向——防死貓彈）: persistent_bear + mom24<0 → 唔好探索 buy
 *  （續跌型跌市買 = 追跌——E1 WR 55% 續跌）。用喺 exploration buy 抑制。 */
export function shouldSuppressExploreBuy(input: SellSignalInput): boolean {
  const p = input?.persistence;
  if (p !== 'persistent_bear') return false;
  const m24 = input?.mom24hPct;
  if (typeof m24 !== 'number' || !Number.isFinite(m24) || m24 >= 0) return false;
  return true;
}

/** 探索雙向最終裁決（NO ENTRY 支援）:
 *  sellSignal 成立 → SELL（覆蓋 OLR 毒化）;
 *  buySuppress 成立 → 唔選 BUY（續跌型跌市）;
 *  兩邊都冇 → 保持候選（交 priority 鏈其餘訊號）。 */
export function resolveExplorationDirection(
  input: SellSignalInput,
  candidate: 'buy' | 'sell' | null,
): 'buy' | 'sell' | null {
  // sell 結構性訊號最高優先——覆蓋 candidate
  if (shouldExploreSell(input)) return 'sell';
  // 續跌型跌市——buy candidate 被抑制
  if (candidate === 'buy' && shouldSuppressExploreBuy(input)) return null;
  return candidate;
}
