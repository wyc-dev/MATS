// ─── Reconcile Fill Resolver — v2.0.876-FIX-RC（2026-09-13, 主神「reconciliation close 錯價」）──
// 背景: reconcilePositions() 原用 pos.currentPrice（本地估價）close——HL 倉位消失
//   （SL/TP 觸發 = 有實際成交）但唔用 fill 實價 → 「一度 +6.5% 被 close 成 −16.9%」,
//   24 筆 giveback Σ194pp 實錘。
//
// 純函數: 喺 closing fills 中揾「真正 belong 呢個倉位」嘅 close fill，
//   回傳 HL 實際成交價 + 已結算 realizedPnl。毒值保守（唔 crash、唔胡亂 confirmed）。
//   冇 match / 毒輸入 → { confirmed: false }（唔 close——防幻影，同 v2.0.868 一致）。

export interface ClosingFill {
  symbol: string;
  side: string;
  timestamp: number;
  price: number;
  closedPnl: number;
}

export interface ReconcileFillInput {
  symbol: string;
  side: 'buy' | 'sell' | string;
  openedAt: number;
}

export interface ReconcileFillResult {
  confirmed: boolean;
  price?: number;
  realizedPnl?: number;
}

export function resolveReconcileFill(
  fills: ClosingFill[] | null | undefined,
  pos: ReconcileFillInput | null | undefined,
): ReconcileFillResult {
  if (!Array.isArray(fills) || fills.length === 0) return { confirmed: false };
  if (!pos || typeof pos !== 'object') return { confirmed: false };
  const locSym = String(pos.symbol ?? '').toLowerCase();
  const locSide = String(pos.side ?? '').toLowerCase();
  if (!locSym || !locSide) return { confirmed: false };
  const openTs = typeof pos.openedAt === 'number' && Number.isFinite(pos.openedAt) ? pos.openedAt : 0;
  // BUY 倉要 SELL fill 先係 close（side 大小寫 insensitive）
  const expectedCloseSide = locSide === 'sell' ? 'buy' : 'sell';
  for (const f of fills) {
    if (!f || typeof f !== 'object') continue;
    if (String(f.symbol ?? '').toLowerCase() !== locSym) continue;
    if (String(f.side ?? '').toLowerCase() !== expectedCloseSide) continue;
    const fts = Number(f.timestamp ?? 0);
    if (!Number.isFinite(fts) || fts < openTs) continue; // 唔 belong 呢個倉位（上一倉 fill）→ skip
    const price = Number(f.price ?? NaN);
    const pnl = Number(f.closedPnl ?? NaN);
    return {
      confirmed: true,
      price: Number.isFinite(price) && price > 0 ? price : undefined,
      realizedPnl: Number.isFinite(pnl) ? pnl : undefined,
    };
  }
  return { confirmed: false };
}
