// ─── MATS UI Types ───

export interface SystemSnapshot {
  cycles: number;
  /** Null in real-trade mode before first exchange balance fetch — UI shows '--'. */
  balance: number | null;
  /** Null in real-trade mode before first exchange balance fetch — UI shows '--'. */
  equity: number | null;
  /** Null in real-trade mode (v2.0.17) — UI shows '--'. */
  totalPnl: number | null;
  totalPnlPct: number | null;
  drawdownPct: number | null;
  positions: number;
  wsConnected: boolean;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  /** v2.0.42: Win rate from the most recent 20 trades (not all-time). */
  recent20WinRate: number;
  /** v2.0.42: Number of trades used for recent20WinRate (may be < 20 if fewer trades exist). */
  recent20Count: number;
  currentPrice: number;
  regime: string;
  trend: string;
  volatility: number;
  cycleInProgress: boolean;
  lastCycleDuration: number;
}

export interface AgentThought {
  agentId: string;
  agentRole: string;
  thought: string;
  confidence: number;
  timestamp: number;
  metadata?: {
    latency?: number;
    model?: string;
    decision?: TradingDecision;
    error?: string;
    fallback?: boolean;
  };
}

export interface AgentStatus {
  agentId: string;
  role: string;
  lastThoughtTimestamp: number;
  decisionsGenerated: number;
  averageConfidence: number;
  state: 'idle' | 'thinking' | 'debating' | 'voting' | 'error';
}

export interface TradingDecision {
  action: 'buy' | 'sell' | 'hold';
  symbol: string;
  positionSizePct: number;
  entryPrice?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  rationale: string;
  urgency: 'immediate' | 'soon' | 'patient';
}

export interface ConsensusResult {
  decision: TradingDecision;
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
  action: string;
  confidence: number;
  hasPosition: boolean;
  closePosition: boolean;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
  positionSizePct: number;
  leverage: number;
  rationale: string;
}

export interface Vote {
  agentId: string;
  agentRole: string;
  weight: number;
  decision: TradingDecision;
  confidence: number;
}

export interface DebateRound {
  roundNumber: number;
  phase: 'argument' | 'attack' | 'synthesis';
  statements: DebateStatement[];
  timestamp: number;
}

export interface DebateStatement {
  agentId: string;
  agentRole: string;
  content: string;
  targetAgentId?: string;
  confidence: number;
  type: 'argument' | 'attack' | 'reinforcement' | 'synthesis';
}

export interface Portfolio {
  /** Null in real-trade mode before first exchange balance fetch — UI shows '--'. */
  balance: number | null;
  initialBalance: number;
  /** Null in real-trade mode before first exchange balance fetch — UI shows '--'. */
  totalEquity: number | null;
  /** Null in real-trade mode (v2.0.17) — UI shows '--'. */
  totalPnl: number | null;
  totalPnlPct: number | null;
  maxDrawdown: number | null;
  maxDrawdownPct: number | null;
  peakEquity: number;
  dailyPnl: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  /** v2.0.42: Win rate from the most recent 20 trades. */
  recent20WinRate: number;
  /** v2.0.42: Number of trades used for recent20WinRate. */
  recent20Count: number;
  positions: Record<string, Position>;
  /** v2.0.140: EXP digest summary (experience digestion text). */
  expDigest?: string;
}

export interface Position {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  leverage: number;
  exchange?: string;
  openedAt: number;
  /** v2.0.134: Meta-Agent's entry thesis (frozen at open). */
  entryThesis?: string;
  /** v2.0.134: Live per-cycle hold reason. */
  holdReason?: string;
}

export interface MarketState {
  symbol: string;
  currentPrice: number;
  priceChange24h: number;
  volume24h: number;
  volatility: number;
  trend: string;
  regime: string;
  orderBookImbalance: number;
}

export interface MarketAgentConfig {
  tradeMode: 'paper' | 'real';
  exchange: 'binance' | 'hyperliquid';
  hyperliquidAssetType?: 'crypto_perps' | 'tradfi' | 'indices' | 'stocks' | 'commodities' | 'fx';
  selectedSymbol: string;
  positionSizePct: number;
  maxPortionPct: number;
  leverage: number;
  cyclePeriodMinutes?: number;
  updatedAt: number;
}

export interface TopVolumePair {
  symbol: string;
  volume24h: number;
  volume5m?: number;
  price: number;
  priceChangePercent: number;
  exchange: string;
}

export interface APIData {
  status: SystemSnapshot;
  agentThoughts: AgentThought[];
  agentStatuses: AgentStatus[];
  consensus: ConsensusResult | null;
  debateRounds: DebateRound[];
  newsHeadlines?: Array<{ symbol: string; headlines: Array<{ title: string; publisher: string; url?: string; pubDate: number | null }> }>;
  tradingMarkets?: string[];
  portfolio: Portfolio | null;
  marketState: MarketState | null;
  agentModels?: { available: ModelDefinition[]; assignments: AgentModelConfig[] };
  cycleProgress?: CycleProgress | null;
  hacpThreshold?: number;
  evolution?: EvolutionData;
  /** v2.0.140: EM Cycle Digestion — MiniLM insight retrieval + self-adjustment */
  emState?: EMState;
  /** v2.0.141: RIL Reason Intelligence Layer stats */
  rilState?: RILState;
  /** GMM EM clustering model summary (per-symbol) — DEPRECATED, use olrState */
  emClusterState?: {
    symbols: Array<{
      symbol: string;
      clusterCount: number;
      totalSamples: number;
      bic: number;
      clusters: Array<{ index: number; winRate: number; sampleCount: number; weight: number }>;
    }>;
  };
  /** OLR (Online Logistic Regression) + Shadow Trade + First-Passage state */
  olrState?: {
    symbols: Array<{
      symbol: string;
      longSamples: number;
      shortSamples: number;
      longPWin: number;
      shortPWin: number;
      longConfidence: 'high' | 'medium' | 'low';
      shortConfidence: 'high' | 'medium' | 'low';
      longSource?: { shadow: number; paper: number; real: number; backfill: number };
      shortSource?: { shadow: number; paper: number; real: number; backfill: number };
      featureWeights?: Array<{ name: string; longWeight: number; shortWeight: number }>;
    }>;
    pending: Array<{
      symbol: string;
      pending: number;
      needed: number;
      pct: number;
    }>;
    firstPassage?: {
      longPWin: number;
      shortPWin: number;
      drift: number;
      volatility: number;
      slDistance: number;
      tpDistance: number;
      slDistanceShort: number;
      tpDistanceShort: number;
      breakevenPLong: number;
      breakevenPShort: number;
      confidence: 'high' | 'low';
    };
    shadowStats?: Array<{
      symbol: string;
      totalOpened: number;
      openCount: number;
      longWins: number;
      longLosses: number;
      shortWins: number;
      shortLosses: number;
      longWinRate: number;
      shortWinRate: number;
      avgHoldCycles: number;
      avgMfePct: number;
      avgMaePct: number;
    }>;
    shadowOpen?: Array<{
      symbol: string;
      side: 'buy' | 'sell';
      entryPrice: number;
      stopLossPrice: number;
      takeProfitPrice: number;
      openCycle: number;
    }>;
  };
  backtest?: BacktestData | null;
  backtestProgress?: BacktestProgress | null;
  tradeHistory?: Array<{
    cycleNumber: number;
    decision: { action: string; symbol?: string; positionSizePct: number; stopLossPct?: number; takeProfitPct?: number };
    entryPrice: number;
    exitPrice?: number;
    regime: string;
    type: string;
    timestamp: number;
    openedAt?: number;
  }>;
  /** Trade records with leverage (both open and closed) */
  tradeRecords?: Array<{
    id: string;
    symbol: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    leverage: number;
    investment: number;
    pnl: number;
    pnlPct: number;
    openedAt: number;
    closedAt: number;
    /** 'hl-fill' = a real Hyperliquid fill synced from the exchange (v2.0.19) */
    status: 'open' | 'closed' | 'hl-fill';
    /** v2.0.30: How the position was closed — 'manual' = user-initiated */
    closeReason?: 'sl_tp' | 'consensus' | 'manual' | 'reconciliation' | 'exchange_closed';
  }>;
  marketAgent?: {
    config: MarketAgentConfig;
    topPairs: TopVolumePair[];
    pairsReady?: boolean;
  };
  systemPaused?: boolean;
  /** v2.0.128: Decision audit log */
  decisionAudit?: Array<{
    cycle: number;
    symbol: string;
    action: 'buy' | 'sell';
    confidence: number;
    thesis: string;
    gates: Array<{ gate: string; passed: boolean; reason: string }>;
    executed: boolean;
    timestamp: number;
  }>;
  /** v2.0.140: EXP action log — what EXP decided per symbol this cycle */
  expActions?: Array<{
    symbol: string;
    side: 'buy' | 'sell';
    verdict: string;
    reason: string;
    cycle: number;
    ts: number;
  }>;
  /** v2.0.65: Options Data Layer context for Stocks/Indices */
  optionsData?: {
    symbol: string;
    ivRank: number;
    ivPercentile: number;
    impliedVolatility: number;
    impliedMovePct: number;
    putCallRatio: number;
    putCallOIRatio: number;
    gammaRegime: string;
    highOIStrike: number | null;
    maxPain: number | null;
    skew: number;
    eventRisk: string;
    daysToExpiration: number;
    available: boolean;
    playbook?: {
      playbook: string;
      structure: string;
      targetPOP: number;
      rationale: string;
      vetoNewPositions: boolean;
    };
  } | Array<{
    symbol: string;
    ivRank: number;
    ivPercentile: number;
    impliedVolatility: number;
    impliedMovePct: number;
    putCallRatio: number;
    putCallOIRatio: number;
    gammaRegime: string;
    highOIStrike: number | null;
    maxPain: number | null;
    skew: number;
    eventRisk: string;
    daysToExpiration: number;
    available: boolean;
    playbook?: {
      playbook: string;
      structure: string;
      targetPOP: number;
      rationale: string;
      vetoNewPositions: boolean;
    };
  }>;
}

export interface BacktestData {
  symbol: string;
  years: number;
  interval: string;
  candlesProcessed: number;
  tradesSimulated: number;
  buySignals: number;
  sellSignals: number;
  holdSignals: number;
  regimeDistribution: Record<string, number>;
  durationMs: number;
  errors: number;
  equityCurve: Array<{ date: string; equity: number }>;
  finalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  totalTrades: number;
}

export interface BacktestProgress {
  phase: 'fetching' | 'processing' | 'evolving' | 'complete' | 'error' | 'paused';
  progressPct: number;
  message: string;
  candlesProcessed: number;
  totalCandles: number;
}

export interface CycleProgress {
  phase: 'thinking' | 'debating' | 'voting' | 'auditing' | 'complete';
  round?: number;
  totalRounds?: number;
  agentProgress: AgentProgress[];
  startTime: number;
}

export interface AgentProgress {
  agentRole: string;
  status: 'waiting' | 'thinking' | 'done' | 'error';
  thought?: string;
  confidence?: number;
  decision?: TradingDecision;
  latencyMs?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ModelDefinition {
  id: string;
  label: string;
  provider: 'nim' | 'ollama';
  category: 'fast' | 'default' | 'strong';
}

export interface AgentModelConfig {
  role: string;
  model: string;
  label: string;
}

export const AGENT_META: Record<string, { name: string; color: string; short: string; hex: string; description: string }> = {
  fractal_momentum_sentinel: {
    name: 'Fractal Momentum Sentinel',
    color: '#7c8a9e',
    hex: '124, 138, 158',
    short: 'Fractal',
    description: 'Detects multi-timeframe momentum patterns and fractal breakouts. Provides directional bias based on price structure and Planck-Chaos regime classification.',
  },
  onchain_whisperer: {
    name: 'On-Chain Whisperer',
    color: '#8a9bb0',
    hex: '138, 155, 176',
    short: 'OnChain',
    description: 'Analyses on-chain metrics (mempool, exchange flows, funding rates) for crypto and macro flow data (ETF flows, DXY, COT) for TradFi. Gauges institutional positioning and market sentiment.',
  },
  rbc_sentiment_analyst: {
    name: 'OLR & Sentiment Analyst',
    color: '#9aabb8',
    hex: '154, 171, 184',
    short: 'Regime',
    description: 'Online Logistic Regression learns P(win) per symbol and side from shadow + paper + real trade outcomes. Fused with First-Passage path-risk and Fear & Greed sentiment to classify market edge.',
  },
  independent_risk_auditor: {
    name: 'Independent Risk Auditor',
    color: '#6b7a8e',
    hex: '107, 122, 142',
    short: 'Auditor',
    description: 'Advisory-only risk reviewer. Suggests TP/SL/size adjustments and detects choppy markets. Cannot veto trades — the thesis system is the sole gatekeeper for new positions.',
  },
  meta_agent: {
    name: 'Meta-Agent',
    color: '#5b8def',
    hex: '91, 141, 239',
    short: 'Meta',
    description: 'Arbitrates all sub-agent signals to produce the final trading decision. Generates entryThesis (1h + 1d rationale) for BUY/SELL, holdReason for HOLD. Weight 0.00 — thesis system controls, not voting.',
  },
  news_reporter: {
    name: 'News Reporter',
    color: '#fbbf24',
    hex: '251, 191, 36',
    short: 'News',
    description: 'Shadow Strategist news motive analyzer. Evaluates whether news is engineered for distribution (bullish news = bearish trap) or accumulation (FUD = bullish opportunity).',
  },
  skeptics: {
    name: 'Skeptics',
    color: '#e879f9',
    hex: '232, 121, 249',
    short: 'Skeptics',
    description: 'Absolute gatekeeper with veto power over new positions. Validates entryThesis for strength, data consistency, manipulation risk, and fact distortion. When in doubt, REJECT.',
  },
  market_agent: {
    name: 'Trading Setup',
    color: '#34d399',
    hex: '52, 211, 153',
    short: 'Market',
    description: 'Scans top-volume pairs across Hyperliquid, selects the trading market, and manages exchange config (trade mode, leverage, position size, max portion). Click a pair above to manually override.',
  },
  terminal_agent: {
    name: 'Terminal Agent',
    color: '#a78bfa',
    hex: '167, 139, 250',
    short: 'Terminal',
    description: 'User trading preference input terminal. Accepts natural language instructions and integrates them into Root Command Prompt for the trading system.',
  },
};

export const AGENT_ROLES = [
  'market_agent',
  'terminal_agent',
  'fractal_momentum_sentinel',
  'onchain_whisperer',
  'rbc_sentiment_analyst',
  'independent_risk_auditor',
  'news_reporter',
  'skeptics',
  'meta_agent',
] as const;

// v2.0.139: Trimmed — aggregate trade-history stats, fitness breakdown, memory
// counts, and strategy list were pure display with no functional consumer.
// OLR/shadow-trade state lives in the top-level olrState field.
export interface EvolutionData {
  generation: number;
}

/** v2.0.140: EM Cycle Digestion — MiniLM insight retrieval + self-adjustment */
export interface EMInsightStats {
  totalVectors: number;
  accuracy: number;
  accuracyChecks: number;
  winCount: number;
  lossCount: number;
  untaggedCount: number;
}

export interface EMState {
  summaryCount: number;
  convergenceAccuracy: number;
  convergenceChecks: number;
  latestInsight: string | null;
  latestSignal: string | null;
  insightStats?: EMInsightStats;
}

/** v2.0.141: RIL Reason Intelligence Layer state for UI display. */
export interface RILState {
  patternCount: number;
  tradeCount: number;
  isBuilt: boolean;
}
