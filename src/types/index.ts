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
  | 'market_agent';

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
  closeReason?: 'sl_tp' | 'consensus' | 'manual' | 'reconciliation' | 'exchange_closed';
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