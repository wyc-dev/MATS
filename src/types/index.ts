// ─── AMACRF Core Types ───
// All domain types for the Adaptive Multi-Agent Chaotic Regime Framework

export type UUID = string;

// ─── Market Data ───

export interface Ticker {
  symbol: string;
  price: number;
  volume: number;
  quoteVolume: number;
  priceChange: number;
  priceChangePercent: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

export interface Kline {
  symbol: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  takerBuyBaseVolume: number;
  takerBuyQuoteVolume: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface MarketState {
  symbol: string;
  currentPrice: number;
  priceChange24h: number;
  volume24h: number;
  volatility: number;
  trend: Trend;
  regime: MarketRegime;
  orderBookImbalance: number;
  lastUpdated: number;
  primarySymbol: string;
}

export type Trend = 'bullish' | 'bearish' | 'sideways' | 'volatile';

export type MarketRegime =
  | 'trending_bull'
  | 'trending_bear'
  | 'high_volatility'
  | 'low_volatility'
  | 'mean_reverting'
  | 'breakout'
  | 'accumulation'
  | 'distribution'
  | 'chaotic'
  | 'unknown';

// ─── Agent Types ───

export type AgentRole =
  | 'fractal_momentum_sentinel'
  | 'onchain_whisperer'
  | 'rbc_sentiment_analyst'
  | 'independent_risk_auditor'
  | 'meta_agent'
  | 'news_reporter'
  | 'skeptics'
  | 'market_agent'
  | 'terminal_agent'
  | 'options_data_layer';

export interface AgentIdentity {
  id: UUID;
  role: AgentRole;
  name: string;
  temperature: number; // 0.0 (cold, conservative) to 1.0 (hot, aggressive)
  weight: number; // voting weight in consensus
  modelPreference: 'fast' | 'default' | 'strong';
}

export interface AgentThought {
  agentId: UUID;
  agentRole: AgentRole;
  thought: string;
  confidence: number; // 0.0 to 1.0
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ─── HACP Cognition Protocol ───

export interface HACPConfig {
  parallelThinkingTimeoutMs: number;
  maxDebateRounds: number;
  consensusThreshold: number;
  totalTimeoutMs: number;
}

export interface DebateRound {
  roundNumber: number;
  phase: 'argument' | 'attack' | 'synthesis';
  statements: DebateStatement[];
  timestamp: number;
}

export interface DebateStatement {
  agentId: UUID;
  agentRole: AgentRole;
  content: string;
  targetAgentId?: UUID; // for attack phase
  confidence: number;
  type: 'argument' | 'attack' | 'reinforcement' | 'synthesis';
}

export interface ConsensusResult {
  /** Primary decision (market ticker) — kept for backward compat */
  decision: TradingDecision;
  /** Per-symbol consensus decisions (market ticker + all open positions) */
  perSymbolConsensus: PerSymbolConsensus[];
  confidence: number;
  reasoning: string;
  votes: Vote[];
  roundsUsed: number;
  deadlockResolved: boolean;
  metaAgentOverridden: boolean;
  timestamp: number;
}

export interface PerSymbolConsensus {
  symbol: string;
  action: 'buy' | 'sell' | 'hold' | 'close';
  confidence: number;
  /** Whether this symbol has an open position */
  hasPosition: boolean;
  /** Suggested stop-loss adjustment (undefined = no change) */
  suggestedStopLoss?: number;
  /** Suggested take-profit adjustment (undefined = no change) */
  suggestedTakeProfit?: number;
  /** Should we close the position NOW? */
  closePosition: boolean;
  /** Position size for new trades (0 = no new trade) */
  positionSizePct: number;
  /** Leverage for new trades */
  leverage: number;
  rationale: string;
  /** v2.0.80: Meta-Agent's entry thesis for new positions (from marketTicker
   *  decision). Propagated to Position.entryThesis when the position opens.
   *  Format: "[1h: <reason>] [1d: <reason>]" */
  entryThesis?: string;
  /** v2.0.81: Meta-Agent's explanation for why it chose HOLD. Explains what
   *  data conflicts, ambiguous states, or manipulation risks prevented
   *  a confident directional decision. Displayed in the UI. */
  holdReason?: string;
}

export interface Vote {
  agentId: UUID;
  agentRole: AgentRole;
  weight: number;
  decision: TradingDecision;
  confidence: number;
}

export interface TradingDecision {
  action: 'buy' | 'sell' | 'hold';
  symbol: string;
  positionSizePct: number; // 0.0 to 1.0
  entryPrice?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  /** v2.0.33: Nearest support/resistance levels from S/R engine.
   * Used by executeDecision to place SL/TP at actual S/R levels instead
   * of fixed percentages. SL goes just beyond the nearest support (for long)
   * or resistance (for short), TP goes at the next S/R level. */
  srSupport?: number | null;
  srResistance?: number | null;
  leverage?: number; // 1-10x, meta-agent sets based on risk/confidence
  rationale: string;
  urgency: 'immediate' | 'soon' | 'patient';
  /** v2.0.28: LLM-identified chart pattern tag (e.g. "ascending_triangle_breakout",
   *  "double_bottom_reversal", "momentum_continuation"). Used by PatternTagTracker
   *  to track which patterns have highest win rates per direction. */
  patternTag?: string;
  /** v2.0.80: Meta-Agent's entry thesis for new positions. Propagated to
   *  Position.entryThesis when the position opens. Re-validated by Skeptics
   *  each cycle. Format: "[1h: <reason>] [1d: <reason>]" */
  entryThesis?: string;
}

// ─── Order & Position ───

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop_loss' | 'take_profit';
export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected' | 'expired';

export interface Order {
  id: UUID;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price: number;
  status: OrderStatus;
  filledQuantity: number;
  filledPrice: number;
  createdAt: number;
  updatedAt: number;
  agentId: UUID; // which agent generated this order
  decisionId?: UUID; // link to consensus result
  metadata?: Record<string, unknown>;
}

export interface Position {
  id: UUID;
  symbol: string;
  side: OrderSide;
  quantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  leverage: number;
  openedAt: number;
  updatedAt: number;
  agentId: UUID;
  exchange?: string;
  /** v2.0.19: entry taker fee already paid (notional-based). Included in
   *  unrealizedPnl so the UI shows the real cost from the moment the
   *  position opens, not $0.00. */
  entryFee?: number;
  /** v2.0.79: Meta-Agent's single condensed rationale for why this position
   *  will reach TP within 1h (short-term) and 1d (medium-term). Required for
   *  all HACP-opened positions. Skeptics validates this each cycle; if
   *  invalidated, the position is force-closed.
   *
   *  Format: "[1h: <short-term reason>] [1d: <medium-term reason>]"
   *  Example: "[1h: RSI oversold + S/R bounce at $64K] [1d: Fed dovish pivot
   *  Friday + BTC ETF inflows accelerating]" */
  entryThesis?: string;
  /** v2.0.134: Live per-cycle hold reason (updated each cycle, not re-validated). */
  holdReason?: string;
  /** v2.0.143: Minimum position VALUE reached during the trade's lifetime.
   *  Position value = margin + unrealized PnL. Tracks the worst dip
   *  (MAE — Maximum Adverse Excursion) in dollar terms.
   *  e.g. if margin=$10 and worst unrealized PnL=-$0.55, minValueReached=$9.45.
   *  Used by the Trade Incident Panel to show how far the trade went against us. */
  minValueReached?: number;
  /** v2.0.143: Maximum position VALUE reached during the trade's lifetime.
   *  Position value = margin + unrealized PnL. Tracks the best peak
   *  (MFE — Maximum Favorable Excursion) in dollar terms.
   *  e.g. if margin=$10 and best unrealized PnL=+$0.60, maxValueReached=$10.60.
   *  Used by the Trade Incident Panel to show how far the trade went in our favor. */
  maxValueReached?: number;
  /** v2.0.143: Original stop-loss price set at position open. Used in exitThesis
   *  to compare against the final SL at close time — detects whether the SL
   *  was narrowed (tightened) or widened during the trade's lifetime. */
  originalStopLossPrice?: number;
  /** v2.0.143: Original take-profit price set at position open. Used in exitThesis
   *  to compare against the final TP at close time — detects whether the TP
   *  was narrowed (tightened) or widened during the trade's lifetime. */
  originalTakeProfitPrice?: number;
  /** v2.0.143: Exit thesis — the rationale for closing the position.
   *  Set by setExitThesis() BEFORE closePosition() is called, so the close
   *  trade record can capture it. Transient: not persisted on positions
   *  (only on the closed TradeRecord). */
  exitThesis?: string;
}

// ─── Multi-Symbol Decision (v1.9.2 — each agent evaluates ALL pairs) ───

export interface PositionContext {
  id: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  leverage: number;
  exchange: string;
  /** v2.0.80: Entry thesis stored when the position was opened. Skeptics
   *  re-validates this each cycle to determine if the position should
   *  be force-closed. */
  entryThesis?: string;
  /** v2.0.104: true if this is a trading market without an open position
   *  (quantity = 0). Agents can output BUY/SELL to open a new position.
   *  false or undefined = real open position. */
  isTradingMarket?: boolean;
}

export interface PerSymbolDecision {
  /** The trading symbol this decision applies to */
  symbol: string;
  /** Action for this symbol: buy/sell/hold */
  action: TradingDecision['action'];
  /** Position size as fraction of portfolio (only for new trades, 0 = no new trade) */
  positionSizePct: number;
  /** Leverage for this symbol */
  leverage: number;
  /** If this symbol has an open position: should we close it NOW? */
  closePosition: boolean;
  /** If we should close, the urgency */
  closeUrgency?: 'immediate' | 'soon' | 'patient';
  /** New stop-loss price suggestion (undefined = no change) */
  suggestedStopLoss?: number;
  /** New take-profit price suggestion (undefined = no change) */
  suggestedTakeProfit?: number;
  /** Rationale for this symbol's decision */
  rationale: string;
  /** v2.0.28: LLM-identified chart pattern tag for this symbol's decision */
  patternTag?: string;
  /** v2.0.79: Per-symbol confidence (0.0-1.0) — LLM's confidence for THIS symbol specifically */
  confidence?: number;
  /** v2.0.80: Meta-Agent's single condensed entry thesis for new positions.
   *  Required when action is 'buy' or 'sell'. Explains why price will reach
   *  TP within 1h (short-term) and 1d (medium-term). Skeptics validates this
   *  before the position is opened, and re-validates each cycle.
   *  Format: "[1h: <reason>] [1d: <reason>]" */
  entryThesis?: string;
  /** v2.0.81: Meta-Agent's explanation for why it chose HOLD for this
   *  symbol. Required when action is 'hold'. Explains what data conflicts,
   *  ambiguous states, or missing information prevented a confident
   *  directional decision. Displayed in the UI under each symbol's HOLD tag.
   *  Example: "Fractal says bullish but On-Chain shows outflows — contradictory signals" */
  holdReason?: string;
}

export interface MultiSymbolDecision {
  /** Decision for the actively selected market ticker (e.g. xyz:CL) */
  marketTicker: PerSymbolDecision;
  /** Decision for each open position (e.g. BTCUSDT, ETHUSDT, xyz:GOLD) */
  positions: PerSymbolDecision[];
}

export interface PositionAdjustment {
  positionId: UUID;
  symbol: string;
  /** New stop-loss price (undefined = no change) */
  newStopLoss?: number;
  /** New take-profit price (undefined = no change) */
  newTakeProfit?: number;
  /** Reason for adjustment */
  rationale: string;
  /** Confidence in this adjustment */
  confidence: number;
}

// ─── Agent Outcome Tracking (v1.9.3) ───

export interface AgentOutcomeRecord {
  id: UUID;
  cycleNumber: number;
  agentRole: AgentRole;
  symbol: string;
  /** The action this agent recommended for this symbol */
  recommendedAction: 'buy' | 'sell' | 'hold' | 'close';
  /** The agent's confidence in this recommendation */
  confidence: number;
  /** Whether this was a position recommendation (false = market ticker) */
  isPositionRecommendation: boolean;
  /** What actually happened — set when position closes or next cycle */
  outcome?: 'win' | 'loss' | 'pending';
  /** Actual PnL % of the outcome */
  pnlPct?: number;
  /** Market regime at decision time */
  regime: MarketRegime;
  /** Timestamp */
  timestamp: number;
}

/** Per-agent performance summary for a given symbol/regime */
export interface AgentPerformanceSnapshot {
  agentRole: AgentRole;
  symbol: string;
  regime: MarketRegime;
  totalDecisions: number;
  wins: number;
  losses: number;
  winRate: number;
  avgConfidence: number;
  /** How often the agent was overridden by Skeptics */
  skepticismRate: number;
}

export interface RealTradingConfig {
  /** Exchange API endpoint */
  exchangeUrl: string;
  /** API key identifier */
  apiKey: string;
  /** Maximum position size as fraction of portfolio */
  maxPositionSizePct: number;
  /** Maximum leverage */
  maxLeverage: number;
  /** Order type preference */
  preferredOrderType: 'market' | 'limit';
}

export interface RealTradingEngine {
  readonly name: string;
  /** Check if the exchange connection is active */
  isConnected(): Promise<boolean>;
  /** Place a real order on the exchange */
  placeOrder(order: Order): Promise<{ success: boolean; orderId?: string; error?: string }>;
  /** Cancel an existing order */
  cancelOrder(orderId: string): Promise<boolean>;
  /** Get current positions from exchange */
  getPositions(): Promise<Position[]>;
  /** Get account balance */
  getBalance(): Promise<ExchangeAccountInfo>;
  /** Adjust stop-loss/take-profit on an existing position */
  adjustPosition(positionId: string, sl?: number, tp?: number): Promise<boolean>;
  /** Close all positions for a symbol */
  closePosition(symbol: string): Promise<boolean>;
}

export interface Portfolio {
  balance: number;
  initialBalance: number;
  totalEquity: number; // balance + unrealized pnl
  positions: Map<string, Position>;
  totalPnl: number;
  totalPnlPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** v2.0.42: Current drawdown from peak equity (not high-water mark).
   *  Unlike maxDrawdownPct which only increases, this decreases when equity
   *  recovers. Used by canTrade() + SystemGuard to decide if trading should
   *  be blocked. maxDrawdownPct is kept for historical reporting.
   *
   *  ⚠️ MAINTENANCE NOTE: If you change drawdown calculation, update
   *  recalculateEquity() in portfolio.ts where both are computed. */
  currentDrawdownPct: number;
  peakEquity: number;
  dailyPnl: number;
  dailyLossLimit: number;
  /** v2.0.23: date string (YYYY-MM-DD) when dailyPnl was last reset.
   *  Used to auto-reset dailyPnl at the start of each new calendar day. */
  dailyPnlResetDate?: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  lastUpdated: number;
}

export interface TradeRecord {
  id: UUID;
  symbol: string;
  side: OrderSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  investment: number;  // margin used = entryPrice * quantity
  pnl: number;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
  agentId: UUID;
  decisionId?: UUID;
  /** 'open' = position opened; 'closed' = position closed */
  status: 'open' | 'closed';
  /** v2.0.30: How the position was closed — lets agents know if it was system or manual */
  closeReason?: 'sl_tp' | 'consensus' | 'manual' | 'reconciliation' | 'exchange_closed' | 'thesis_invalidation';
  /** v2.0.138: Frozen entryThesis captured from the position at close time,
   *  fed to the EXP thesis-experience memory so Skeptics can match rationale
   *  combinations against historical win/loss outcomes. Source: pos.entryThesis
   *  (which is set-if-absent per v2.0.137, so this is the ORIGINAL open thesis). */
  entryThesis?: string;
  /** v2.0.143: The rationale for closing the position — captured from the
   *  Meta-Agent/Skeptics close decision or the closeReason context. Empty
   *  for SL/TP auto-triggered closes (no agent rationale involved). */
  exitThesis?: string;
  /** v2.0.143: LLM-generated post-trade review analysing how more profit
   *  could have been made or less loss incurred. Generated asynchronously
   *  after the position closes. May be empty if the LLM call fails. */
  postReview?: string;
  /** v2.0.143: Minimum unrealized PnL reached during the trade's lifetime (MAE).
   *  Captured from the position's minValueReached at close time. */
  minValueReached?: number;
  /** v2.0.143: Maximum unrealized PnL reached during the trade's lifetime (MFE).
   *  Captured from the position's maxValueReached at close time. */
  maxValueReached?: number;
}

// ─── EXP: Thesis Experience Vector Memory (v2.0.138) ───
// See /Users/y.c./Downloads/EXP_core_plan.md for the full blueprint.
// Each closed trade becomes one ThesisExperienceRecord stored in data/exp/trades.jsonl.

/** A single rationale extracted (by LLM) from an entryThesis, plus its embedding vector. */
export interface RationaleItem {
  point: string;
  category: RationaleCategory;
}

export type RationaleCategory =
  | 'technical' | 'fundamental' | 'news' | 'macro' | 'flow' | 'sentiment' | 'pattern' | 'other';

export type AssetCategory = 'crypto' | 'commodity' | 'equity' | 'forex' | 'other';

export type TradeOutcome = 'WIN' | 'LOSS';

export type DecisionOrigin = 'meta-agent' | 'skeptics-reverse';

/** v2.0.143: How the position was closed — used by RIL CloseReasonAggregator
 *  to group trades by exit type and compute per-type win rates. */
export type ExitType = 'sl_tp' | 'consensus' | 'manual' | 'thesis_invalidation' | 'reconciliation' | 'exchange_closed';

/** One closed trade = one record in the EXP memory (data/exp/trades.jsonl). */
export interface ThesisExperienceRecord {
  id: string;
  ts: number;                    // close timestamp
  symbol: string;
  side: 'buy' | 'sell';
  source: 'paper' | 'real';
  decisionOrigin: DecisionOrigin;
  outcome: TradeOutcome;
  pnl: number;
  pnlPct: number;
  entry: number;
  exit: number;
  leverage: number;
  holdMin: number;
  regime: string;
  assetCategory: AssetCategory;
  entryThesis: string;           // frozen original
  rationales: string[];          // extracted rationale points
  rationaleCats: RationaleCategory[];
  rationaleVectors: number[][];  // one vector per rationale (embedDim-dim); [] if embed failed
  /** v2.0.143: How the position was closed. Used by RIL CloseReasonAggregator
   *  to group trades by exit type (SL/TP, consensus, manual, thesis invalidation)
   *  and compute per-type win rates + avg PnL. */
  exitType?: ExitType;
  /** v2.0.178: Market conditions at trade open time — the actual numerical state
   *  (volatility, OB imbalance, funding rate, S/R distance, etc.) that produced
   *  this outcome. Enables condition-based similarity matching, not just text-based. */
  marketFeatures?: Record<string, number>;
  /** v2.0.178: OLR P(win) prediction at entry time. */
  olrPWinAtEntry?: number;
  /** v2.0.178: Shadow win rate at entry time. */
  shadowWinRateAtEntry?: number;
}

/** Verdict returned by checkThesisHistory() (Skeptics Phase 1.8a). */
export type ExpVerdict =
  | 'PASS_OPEN_DIRECTLY'   // no history / ambiguous / delta-no-history — valid, skip 1.8b
  | 'FAST_APPROVE'         // history skews WIN
  | 'APPROVE_WITH_NOTE'    // losing combo + delta positive (same-cat or cross-cat+extra)
  | 'REVERSE_DIRECTION'    // delta negative + further risk factors → flip BUY↔SELL
  | 'REJECT'               // losing combo, no delta / cross-cat no extra / neg no risk / reverse restricted
  | 'EXP_DISABLED'         // exp.enabled=false → fall back to 1.8b
  | 'EXP_ERRORED';         // technical failure (repair failed) → fall back to 1.8b

export interface ExpCheckResult {
  verdict: ExpVerdict;
  pWin?: number;
  reason?: string;
  matchedLossId?: string;
  extraRationale?: string;
  reversedSide?: 'buy' | 'sell';
  reversedThesis?: string;
  riskFactors?: string[];
  /** Diagnostics when verdict = EXP_ERRORED */
  errorType?: string;
  error?: string;
  /** v2.0.143: Candidate rationale vectors extracted from the thesis.
   *  Used by HACP to feed SimilarTradeRetriever without re-embedding. */
  candidateVectors?: number[][];
}

/** Fallback incident record (data/exp/incidents.jsonl) — §8.6 self-healing audit trail. */
export interface ExpFallbackIncident {
  ts: number;
  errorType: string;
  reason: string;
  repairResult: 'fixed' | 'degraded' | 'failed';
  resolvedBy: 'retry' | 'reload' | 'rebuild' | 'heuristic' | 'none';
  retried1_8a: boolean;
  finalVerdict: ExpVerdict;
}

// ─── v2.0.140: A2A Experience Digestion (三層經驗消化) ───
// Master Lord doctrine: EXP.md 經 A2A prompt 重點處理 → 濃縮精簡向量 →
// 判斷數據分類 → 更準確嘅經驗消化物。每筆 closed trade 由 LLM 消化成一條
// 結構化 lesson statement（A2A 格式），embed 成 lesson vector；相似 lessons
// 聚類成 ExperienceClass（centroid + 勝率/PnL）。新 thesis 經同樣消化 →
// classification vs class centroids → 更準確嘅 verdict。

/** A2A-structured lesson statement distilled from one closed trade (or a candidate thesis). */
export interface LessonStatement {
  /** A2A OBS — the market conditions that were observed (regime, S/R, news, timing). */
  obs: string;
  /** A2A ASSESS — the directional conviction that was taken (or proposed). */
  assess: { direction: 'buy' | 'sell'; conviction: number };
  /** Outcome for historical trades; undefined for candidates. */
  outcome?: TradeOutcome;
  /** Root cause: WHY this trade won/lost (the actual lesson). */
  rootCause?: string;
  /** v2.0.140: Exit quality classification — was the SL/TP premature? */
  exitType?: 'premature_sl' | 'premature_tp' | 'correct_sl' | 'correct_tp' | 'thesis_invalidated';
  /** One condensed sentence capturing the entire lesson. */
  lesson: string;
  /** Dominant rationale categories driving this lesson. */
  categories: RationaleCategory[];
  /** Market regime at the time. */
  regime?: string;
  /** Hold time in minutes (historical only). */
  holdMin?: number;
}

/** A cluster of similar lesson vectors — an "experience class" with aggregate stats. */
export interface ExperienceClass {
  id: string;
  /** L2-normalised centroid of member lesson vectors (embedDim-dim). */
  centroid: number[];
  /** Representative lesson statement (most-central member). */
  lesson: string;
  count: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  /** Distinct symbols seen in this class. */
  symbols: string[];
  /** Distinct sides (buy/sell) — reveals direction bias. */
  sides: Array<'buy' | 'sell'>;
  /** v2.0.176: Per-direction win/loss counts — prevents direction-mixing in winRate. */
  buyWins: number;
  buyLosses: number;
  sellWins: number;
  sellLosses: number;
  /** Distinct regimes. */
  regimes: string[];
  avgHoldMin: number;
  /** Record ids belonging to this class. */
  memberIds: string[];
  /** Dominant direction ('buy' / 'sell' / 'mixed' when both appear). */
  directionBias: 'buy' | 'sell' | 'mixed';
  /** Timestamp of last member added (for recency). */
  ts: number;
}

/** Result of classifying a candidate thesis against experience classes. */
export interface DigestClassification {
  bestClass: ExperienceClass | null;
  similarity: number;
  /** winRate of bestClass (0 if no class). */
  classWinRate: number;
  /** Does the candidate direction align with the class directionBias? */
  directionAligned: boolean;
}

/** Digest runtime config (overridable for tests). */
export interface DigestConfig {
  enabled: boolean;
  /** Cosine threshold for assigning a candidate to an existing class. */
  classifyThreshold: number;
  /** Cosine threshold for merging two lessons into the same class on rebuild. */
  clusterThreshold: number;
  /** Minimum class size to be trustworthy (below = treat as sparse, defer). */
  minClassSize: number;
  /** winRate above which a matched class → FAST_APPROVE. */
  classWinThreshold: number;
  /** winRate below which a matched class → REJECT (unless delta). */
  classLossThreshold: number;
  /** Max lesson statements to keep in the digest cache. */
  maxDigestCache: number;
}

// ─── RIL (Reason Intelligence Layer) — v2.0.141 ───

/** A cluster of semantically similar entry rationale texts, with aggregate performance stats. */
export interface ReasonPatternCluster {
  id: string;
  /** Human-readable name (nearest-to-centroid rationale text). */
  name: string;
  /** L2-normalised centroid of member rationale vectors (embedDim-dim). */
  centroid: number[];
  count: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  avgHoldMin: number;
  /** Distinct symbols seen in this cluster. */
  symbols: string[];
  /** Distinct sides (buy/sell). */
  sides: Array<'buy' | 'sell'>;
  /** v2.0.176: Per-direction win/loss counts — prevents direction-mixing in winRate. */
  buyWins: number;
  buyLosses: number;
  sellWins: number;
  sellLosses: number;
  memberIds: string[];
  /** Exit type breakdown within this pattern. */
  exitTypeBreakdown: Record<string, { wins: number; losses: number; pnl: number }>;
  /** Timestamp of last member added. */
  ts: number;
}

/** Aggregated stats for one close reason type. */
export interface CloseReasonStat {
  exitType: string;
  decisionOrigin: string;
  count: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  avgHoldMin: number;
  avgPnlPerTrade: number;
}

/** A similar trade result from retrieval. */
export interface SimilarTradeResult {
  trade: ThesisExperienceRecord;
  similarity: number;
}

/** RIL runtime config. */
export interface RILConfig {
  enabled: boolean;
  /** Cosine threshold for greedy clustering of rationale texts. */
  clusterThreshold: number;
  /** Minimum trades per cluster for display. */
  minClusterSize: number;
  /** Max patterns to show in the entry pattern map. */
  maxPatternsDisplay: number;
  /** Number of similar trades to retrieve per proposal. */
  similarTradeCount: number;
  /** Enable LLM subtle differences analysis (1 call per cycle). */
  subtleDiffEnabled: boolean;
  /** Rebuild clusters from tradeHistory on startup. */
  rebuildOnStartup: boolean;
  /** Max clusters to keep (prune smallest when over limit). */
  maxClusters: number;
}

// ─── Risk ───

export interface RiskLimits {
  maxPositionSizePct: number;
  maxDrawdownPct: number;
  dailyLossLimitPct: number;
  maxLeverage: number;
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  maxCorrelatedExposure: number;
  minRiskRewardRatio: number;
}

export interface RiskAssessment {
  allowed: boolean;
  vetoed: boolean;
  score: number; // 0 (catastrophic) to 1 (perfectly safe)
  concerns: RiskConcern[];
  adjustedPositionSize?: number;
  adjustedStopLoss?: number;
  auditorNotes?: string;
}

export interface RiskConcern {
  type: RiskConcernType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  mitigation?: string;
}

export type RiskConcernType =
  | 'position_size_too_large'
  | 'drawdown_exceeded'
  | 'daily_loss_exceeded'
  | 'correlation_risk'
  | 'volatility_risk'
  | 'liquidity_risk'
  | 'regime_risk'
  | 'timing_risk'
  | 'model_uncertainty';

// ─── Evolution ───

export interface MemoryEntry {
  id: UUID;
  type: 'experience' | 'strategy' | 'regime' | 'error';
  timestamp: number;
  marketState: Partial<MarketState>;
  decision: TradingDecision;
  outcome?: TradeRecord;
  lessons: string[];
  tags: string[];
  importance: number; // 0.0 to 1.0
  accessCount: number;
  lastAccessed: number;
}

export interface EvolutionaryStrategy {
  id: UUID;
  generation: number;
  parentId?: UUID;
  fitness: number;
  /** Full fitness breakdown (v2.0.15) — used to guide directional mutation.
   *  When absent (legacy/loaded state), mutate() falls back to random noise. */
  fitnessBreakdown?: SurvivalFitness;
  parameters: StrategyParameters;
  performance: StrategyPerformance;
  status: 'active' | 'retired' | 'mutating' | 'evaluating';
  createdAt: number;
  lineage: UUID[]; // ancestor chain
}

export interface StrategyParameters {
  momentumWindow: number;
  volatilityThreshold: number;
  regimeWeights: Record<MarketRegime, number>;
  positionSizingModel: 'kelly' | 'fixed_fraction' | 'volatility_adjusted' | 'adaptive';
  riskAversion: number; // 0 to 1
  signalThreshold: number;
  confirmationRequired: number; // number of agents that must agree
  /**
   * v2.0.62: Options-specific parameters for Stocks/Indices evolution.
   * Undefined for crypto_perps — only set when asset type is stocks/indices/tradfi.
   * These parameters guide the evolution system's mutation of options-aware strategies.
   */
  optionsParams?: OptionsStrategyParameters;
}

/**
 * v2.0.62: Options-specific strategy parameters for Stocks/Indices trading.
 * These evolve alongside the base StrategyParameters when trading equities.
 * The evolution system mutates these based on options-specific fitness dimensions.
 */
export interface OptionsStrategyParameters {
  /** Minimum IV Rank to enter a premium-selling trade (0-100). Higher = stricter. */
  minIVRankForPremiumSell: number;
  /** Maximum IV Rank to enter a directional debit trade (0-100). Higher = more permissive. */
  maxIVRankForDebit: number;
  /** Gamma regime preference: 'positive' = prefer stabilizing regimes, 'any' = no preference. */
  gammaRegimePreference: 'positive' | 'negative' | 'any';
  /** Maximum implied move (% of price) to accept before vetoing (too volatile = too risky). */
  maxImpliedMovePct: number;
  /** Put/Call OI ratio threshold for bearish sentiment confirmation (>1 = bearish). */
  putCallOIThreshold: number;
  /** Event risk tolerance: 'none' = veto on any event, 'opex' = allow OPEX, 'all' = allow all. */
  eventRiskTolerance: 'none' | 'opex' | 'all';
  /** Target Probability of Profit for strategy selection (0-1). */
  targetPOP: number;
}

export interface StrategyPerformance {
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  winRate: number;
  profitFactor: number;
  maxDrawdown: number;
  totalReturn: number;
  trades: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
}

export interface SurvivalFitness {
  score: number; // 0 to 1
  capitalPreservation: number;
  returnGeneration: number;
  adaptability: number;
  consistency: number;
  riskManagement: number;
  decisionQuality: number;
  /**
   * v2.0.62: Options-specific fitness dimension for Stocks/Indices.
   * Measures how well the strategy uses options data (IV Rank, Gamma, P/C ratio)
   * to make profitable decisions. Undefined for crypto strategies.
   * Scale: 0 (ignoring options data) to 1 (excellent options-aware decisions).
   */
  optionsAlpha?: number;
}

// ─── Observability ───

export interface SystemHealth {
  uptime: number;
  websocketConnected: boolean;
  lastTickTimestamp: number;
  activePositions: number;
  balance: number;
  equity: number;
  drawdownPct: number;
  agentStatuses: AgentStatus[];
  errorCount: number;
  lastError?: string;
}

export interface AgentStatus {
  agentId: UUID;
  role: AgentRole;
  lastThoughtTimestamp: number;
  decisionsGenerated: number;
  averageConfidence: number;
  state: 'idle' | 'thinking' | 'debating' | 'voting' | 'error';
}

export interface LogContext {
  agent?: AgentRole;
  phase?: string;
  symbol?: string;
  decisionId?: UUID;
  round?: number;
  [key: string]: unknown;
}

// ─── A2A (Agent-to-Agent) Communication Protocol ───

export type A2AMessageType = 'OBS' | 'ASSESS' | 'PROP' | 'CONCERN' | 'Q' | 'AGR' | 'DIS' | 'CONSENSUS';

export interface A2ASignal {
  type: A2AMessageType;
  keyword: string; // e.g., 'HMM_TRANSITION', 'EARNING_VOL', 'MOMENTUM', 'REGIME'
  content: string; // Compact representation
  metrics?: Record<string, number | string>; // Critical numerical data
  confidence?: number;
  severity?: 'low' | 'medium' | 'high' | 'critical'; // For CONCERN messages
  urgency?: 'immediate' | 'soon' | 'patient'; // For PROP messages
}

export interface A2ADebateContext {
  roundNumber: number;
  phase: 'argument' | 'attack' | 'synthesis';
  previousSignals: A2ASignal[];
  targetThoughtId?: UUID;
  marketContext: string;
  portfolioContext: string;
}

export type A2AKeywordGroup = 
  | 'regime' // trending_bull, trending_bear, ranging, chaotic, etc.
  | 'momentum' // MOMENTUM, EXHAUSTION, FRACTAL, DECAY
  | 'volatility' // ARCH_VOL, EARNING_VOL, VOL_SPIKE, FORECAST
  | 'risk' // POSITION, LEVERAGE, CORRELATION, VETO_THRESHOLD
  | 'flow' // ORDERBOOK, VOLUME, WHALE, IMBALANCE
  | 'hmm' // HMM_STATE, HMM_TRANSITION, PERSISTENCE, PROBABILITY
  | 'sentiment'; // bullish, bearish, uncertain, neutral

// ─── Cycle Progress (real-time) ───

// ─── Market Agent / Exchange Config ───

export type TradeMode = 'paper' | 'real';
export type ExchangeType = 'binance' | 'hyperliquid';
export type HyperliquidAssetType = 'crypto_perps' | 'tradfi' | 'indices' | 'stocks' | 'commodities' | 'fx';

export interface MarketAgentConfig {
  /** Paper trading vs real exchange trading */
  tradeMode: TradeMode;
  /** Which exchange to trade on */
  exchange: ExchangeType;
  /** Hyperliquid perp category filter */
  hyperliquidAssetType?: HyperliquidAssetType;
  /** The actively selected trading symbol */
  selectedSymbol: string;
  /** Position size as fraction of equity (0.01 = 1%, 0.50 = 50%) */
  positionSizePct: number;
  /** v2.0.XX: Max portion of balance usable for ALL positions combined (0.10-0.50 = 10%-50%).
   *  Replaces the hardcoded 20% cap in paper-engine.ts. */
  maxPortionPct: number;
  /** Leverage multiplier (1-10) */
  leverage: number;
  /** v2.0.122: Per-symbol direction restriction. Key = normalized symbol,
   *  value = allowed direction ('buy' | 'sell'). If a symbol is in this map,
   *  only the specified direction is allowed for new entries; the opposite
   *  direction is blocked at execution time. Existing positions can still
   *  be closed. Example: { "xyz:silver": "sell" } means SILVER can only be
   *  shorted, never bought. */
  directionRestrictions?: Record<string, 'buy' | 'sell'>;
  /** v2.0.124: Trading markets list (from UI pills). Persisted so the system
   *  resumes with the correct markets on restart instead of falling back to
   *  auto-select with only the selectedSymbol. Max 3 symbols. */
  tradingMarkets?: string[];
  /** Cycle period in minutes (1-10). Controls the decision cycle interval. */
  cyclePeriodMinutes?: number;
  /** Timestamp of last config change */
  updatedAt: number;
}

export interface TopVolumePair {
  symbol: string;
  volume24h: number;       // USDT notional volume (24h)
  volume5m?: number;       // Raw contract volume (last 5 min)
  price: number;
  priceChangePercent: number;
  exchange: ExchangeType;
}

export interface ExchangeAccountInfo {
  free: number;
  locked: number;
  total: number;
  unrealizedPnl: number;
  marginUsed: number;
}

export interface ExchangePosition {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;           // position size in contracts
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export interface CycleProgress {
  phase: 'thinking' | 'debating' | 'voting' | 'auditing' | 'complete';
  round?: number;
  totalRounds?: number;
  agentProgress: AgentProgress[];
  startTime: number;
}

export interface AgentProgress {
  agentRole: AgentRole;
  status: 'waiting' | 'thinking' | 'done' | 'error';
  thought?: string;
  confidence?: number;
  decision?: TradingDecision;
  latencyMs?: number;
  startedAt?: number;
  completedAt?: number;
}

// ─── Sigmoid·GA Sentiment Engine Types ───

export interface SentimentSignal {
  /** Whale presence score (0-1) */
  whaleScore: number;
  /** Institutional flow pressure (0-1) */
  institutionalPressure: number;
  /** Microstructure tension (0-1) */
  microstructureTension: number;
  /** Momentum bias (-1 to +1, negative=bearish, positive=bullish) */
  momentumBias: number;
  /** Fear/Greed echo (-1 to +1) */
  fearGreedEcho: number;
}

export interface SentimentAggregate {
  /** Raw signals from each sigmoid channel */
  signals: SentimentSignal;
  /** Combined overall sentiment (-1 to +1) */
  overallSentiment: number;
  /** Model conviction in the aggregate (0-1) */
  conviction: number;
  /** Raw pre-sigmoid inputs for auditability */
  rawInputs: {
    orderBookImbalance: number;
    volumeAcceleration: number;
    fundingRateDelta: number;
    fundingRateAccel: number;
    spreadPressure: number;
    priceAcceleration: number;
    largeTradeCount: number;
    fearGreedIndex: number;
    volatilityRegime: number;
  };
}

/** A single sigmoid parameter set for one signal channel */
export interface SigmoidParams {
  k: number;    // steepness (0.1-10.0)
  x0: number;   // midpoint offset (-2.0 to +2.0)
  weight: number; // channel weight (0.0-1.0)
}

/** A GA chromosome = all sigmoid params for all channels + combination strategy */
export interface GAChromosome {
  id: string;
  generation: number;
  fitness: number;
  // Per-channel sigmoid params
  whale: SigmoidParams;
  institutional: SigmoidParams;
  microstructure: SigmoidParams;
  momentum: SigmoidParams;
  fearGreed: SigmoidParams;
  // Combination strategy
  linearWeight: number;      // weight for linear combination
  productWeight: number;     // weight for product combination
  convictionThreshold: number; // min sigmax for high conviction
  // Metadata
  parentIds: string[];
  createdAt: number;
}

export interface GAPopulation {
  generation: number;
  chromosomes: GAChromosome[];
  bestFitness: number;
  bestChromosome: GAChromosome | null;
}

// ─── E-Step: CycleSummary (EM Latent State) ───

export interface PrimarySignal {
  name: string;
  value: number;
  direction: 'bullish' | 'bearish' | 'neutral';
}

export interface CycleDelta {
  exists: boolean;
  metric: string;
  from: number | null;
  to: number | null;
  significance: 'high' | 'medium' | 'low' | 'none';
}

export interface LatentStateConfidence {
  regimeConfidence: number;
  trendConfidence: number;
  dataQuality: number;
  anomalyDetected: boolean;
}

export interface CycleConvergence {
  agentAgreement: number;
  skepticsApproved: boolean;
  metaOverride: boolean;
}

export interface CycleSummary {
  cycleNumber: number;
  timestamp: number;
  /** The distilled key insight from Meta-Agent (1 sentence) */
  keyInsight: string;
  /** The single most important signal this cycle */
  primarySignal: PrimarySignal;
  /** What meaningfully changed since last cycle */
  delta: CycleDelta;
  /** Confidence in latent state estimation */
  latentState: LatentStateConfidence;
  /** Convergence check results */
  convergence: CycleConvergence;
}

export interface EMState {
  summaries: CycleSummary[];
  /** Running convergence accuracy (how often keyInsight matched reality) */
  convergenceAccuracy: number;
  /** Total convergence checks performed */
  convergenceChecks: number;
}