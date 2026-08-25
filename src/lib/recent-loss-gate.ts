// ─── Recent Loss Cooldown — v2.0.870-recent-loss-gate（主神 2026-08-25）─
// DRAM 案例: 24h 內 5 單 BUY 全蝕（-16.4%）系統照開第 6 單——「real 連蝕」
// 冇冷卻。shadow-gate 睇 shadow stats, 唔直接反映 real 近期表現。
// 規則: per-symbol 最近 N（5）單 real 全部蝕且合計 pnlPct ≤ -X（-5%）→
//       block 新開倉（24h 冷卻——由 caller 用 cooldown map 管時效）。
// 純函數——零依賴可測。毒值保守（唔 block）。

export interface RecentLossTrade {
  symbol: string;
  pnlPct: number;   // margin-basis 百分比（負=蝕）
}

export interface RecentLossGateOpts {
  /** 睇最近幾單 */
  lookback: number;
  /** 全部蝕先 block（唔係合計——連續全蝕先係死沖） */
  requireAllLoss: boolean;
  /** 合計虧損下限（margin %）——太細唔 block（打和唔算） */
  minTotalLossPct: number;
  /** 最少樣本（太少唔 block） */
  minTrades: number;
}

const DEFAULTS: RecentLossGateOpts = { lookback: 5, requireAllLoss: true, minTotalLossPct: -3, minTrades: 3 };

/** 判定「該 symbol 最近 N 單全蝕且合計夠蝕」→ 應該 block。
 *  輸入: 該 symbol 嘅 real trades（升序閉倉時間）。垃圾 pnlPct → 當「唔蝕」
 *  （唔可以因為垃圾值 block）。 */
export function shouldBlockFromRecentLoss(
  trades: Array<RecentLossTrade> | null | undefined,
  opts?: Partial<RecentLossGateOpts>,
): boolean {
  if (!Array.isArray(trades) || trades.length === 0) return false;
  const o = { ...DEFAULTS, ...(opts ?? {}) };
  const n = Number.isFinite(o.lookback) && o.lookback > 0 ? Math.floor(o.lookback) : 5;
  const minT = Number.isFinite(o.minTrades) && o.minTrades > 0 ? Math.floor(o.minTrades) : 3;
  const recent = trades.slice(-n);
  if (recent.length < minT) return false;
  let sum = 0;
  for (const t of recent) {
    const p = t?.pnlPct;
    if (typeof p !== 'number' || !Number.isFinite(p)) return false; // 垃圾 pnl → 唔 block（保守）
    if (p > 0) return false; // requireAllLoss: 有贏單 → 唔 block
    sum += p;
  }
  const floor = Number.isFinite(o.minTotalLossPct) ? o.minTotalLossPct : -3;
  return sum <= floor;
}

/** cooldown 截止檢查——冷卻中先 block（caller 管理 map）。
 *  垃圾值 → false（保守唔 block——唔可以因垃圾 cooldown 阻正常交易）。 */
export function isInCooldown(sinceTs: number, nowTs: number, cooldownMs: number): boolean {
  if (!Number.isFinite(sinceTs) || !Number.isFinite(nowTs)) return false;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return false;
  return nowTs - sinceTs < cooldownMs;
}
