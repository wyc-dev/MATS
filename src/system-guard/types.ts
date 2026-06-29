// ─── System Guard Types ───
// GuardResult: 每個 guard 的獨立輸出
// GuardReport: SystemGuard.check() 的匯總結果

export type GuardSeverity = 'info' | 'warn' | 'error' | 'critical';
export type GuardAction = 'block_cycle' | 'block_new_position' | 'reduce_size' | 'reduce_leverage' | 'warn_only';

export interface GuardResult {
  allowed: boolean;
  severity: GuardSeverity;
  reason: string;
  guardName: string;
  action: GuardAction;
}

export interface GuardReport {
  blocked: boolean;
  results: GuardResult[];
  contextLines: string[];
}

export interface GuardParams {
  activeSymbol: string;
  marketPrice: number;
  /** v2.0.42: CURRENT drawdown from peak equity (decreases on recovery).
   *  Used by guardDrawdown to decide if trading should be blocked.
   *  maxDrawdownPct (below) is the historical high-water mark for reporting. */
  currentDrawdownPct: number;
  /** Historical max drawdown (high-water mark, only increases). For reporting only. */
  maxDrawdownPct: number;
  /** Daily PnL in quote currency */
  dailyPnl: number;
  /** Portfolio balance */
  balance: number;
  /** HL WS last book timestamp (ms epoch) */
  lastBookTimestamp: number;
  /** Market Agent last successful REST fetch (ms epoch) */
  lastFetchTime: number;
  /** Agent session win rates: agentId → winRate (0-1) */
  agentWinRates: Record<string, number>;
  /** Order book depth for active symbol: { bids: [price, size][], asks: [price, size][] } */
  orderBookDepth: { price: number; size: number }[];
  /** Proposed position size in USD (for liquidity check) */
  proposedPositionUsd: number;
  /** Proposed leverage */
  proposedLeverage: number;
}