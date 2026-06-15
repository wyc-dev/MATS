// ─── MATS UI Types ───

export interface SystemSnapshot {
  cycles: number;
  balance: number;
  equity: number;
  totalPnl: number;
  totalPnlPct: number;
  drawdownPct: number;
  positions: number;
  wsConnected: boolean;
  tradeCount: number;
  winCount: number;
  lossCount: number;
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
  confidence: number;
  reasoning: string;
  votes: Vote[];
  roundsUsed: number;
  deadlockResolved: boolean;
  metaAgentOverridden: boolean;
  timestamp: number;
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
  balance: number;
  initialBalance: number;
  totalEquity: number;
  totalPnl: number;
  totalPnlPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  peakEquity: number;
  dailyPnl: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  positions: Record<string, Position>;
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
  portfolio: Portfolio | null;
  marketState: MarketState | null;
  agentModels?: { available: ModelDefinition[]; assignments: AgentModelConfig[] };
  cycleProgress?: CycleProgress | null;
  hacpThreshold?: number;
  evolution?: EvolutionData;
  backtest?: BacktestData | null;
  backtestProgress?: BacktestProgress | null;
  tradeHistory?: Array<{
    cycleNumber: number;
    decision: { action: string; positionSizePct: number; stopLossPct?: number; takeProfitPct?: number };
    entryPrice: number;
    exitPrice?: number;
    regime: string;
    type: string;
    timestamp: number;
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
    status: 'open' | 'closed';
  }>;
  marketAgent?: {
    config: MarketAgentConfig;
    topPairs: TopVolumePair[];
  };
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

export const AGENT_META: Record<string, { name: string; color: string; short: string; hex: string }> = {
  fractal_momentum_sentinel: {
    name: 'Fractal Momentum Sentinel',
    color: '#7c8a9e',
    hex: '124, 138, 158',
    short: 'Fractal',
  },
  onchain_whisperer: {
    name: 'On-Chain Whisperer',
    color: '#8a9bb0',
    hex: '138, 155, 176',
    short: 'OnChain',
  },
  regime_risk_guardian: {
    name: 'Regime Risk Guardian',
    color: '#9aabb8',
    hex: '154, 171, 184',
    short: 'Regime',
  },
  independent_risk_auditor: {
    name: 'Independent Risk Auditor',
    color: '#6b7a8e',
    hex: '107, 122, 142',
    short: 'Auditor',
  },
  meta_agent: {
    name: 'Meta-Agent',
    color: '#5b8def',
    hex: '91, 141, 239',
    short: 'Meta',
  },
  news_reporter: {
    name: 'News Reporter',
    color: '#fbbf24',
    hex: '251, 191, 36',
    short: 'News',
  },
  skeptics: {
    name: 'Skeptics',
    color: '#e879f9',
    hex: '232, 121, 249',
    short: 'Skeptics',
  },
  market_agent: {
    name: 'Market Select Agent',
    color: '#34d399',
    hex: '52, 211, 153',
    short: 'Market',
  },
};

export const AGENT_ROLES = [
  'market_agent',
  'fractal_momentum_sentinel',
  'onchain_whisperer',
  'regime_risk_guardian',
  'independent_risk_auditor',
  'news_reporter',
  'skeptics',
  'meta_agent',
] as const;

export interface EvolutionData {
  generation: number;
  bestFitness: number;
  fitnessBreakdown?: {
    score: number;
    capitalPreservation: number;
    returnGeneration: number;
    adaptability: number;
    consistency: number;
    riskManagement: number;
    decisionQuality: number;
  };
  memoryShortTerm: number;
  memoryLongTerm: number;
  tradeHistory: {
    totalEntries: number;
    countedTrades?: number;
    realTrades: number;
    simulatedTrades: number;
    winRate: number;
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    totalReturn: number;
    maxDrawdown: number;
    profitFactor: number;
    expectancy: number;
    avgWin: number;
    avgLoss: number;
  };
  strategies: Array<{
    id: string;
    generation: number;
    fitness: number;
    status: string;
    momentumWindow: number;
    riskAversion: number;
    signalThreshold: number;
    volatilityThreshold: number;
    confirmationRequired?: number;
    positionSizingModel?: string;
  }>;
}
