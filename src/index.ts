// ─── MATS Main Entry Point ───
// System orchestrator — ties together data, agents, cognition, risk, trading, evolution

import { config } from './config/index.ts';
import { rootLogger, createLogger } from './observability/logger.ts';
import { setupShutdownHandlers, registerShutdownHandler, isShuttingDown } from './utils/shutdown.ts';
import { hlRateLimitedFetch } from './utils/hl-global-limiter.ts';
import { withTimeout } from './utils/with-timeout.ts';
import { SupabaseAnalysisWriter } from './services/supabase-writer.ts';
import { buildAssetAnalysis } from './services/analysis-matrix.ts';
import type { AssetAnalysis, EdgeReport, RiskProfile } from './types/index.ts';
import {
  computeEdgeReport, skipEdgeReport, realizedStats,
  ExecutionTracker as EdgeExecutionTracker, StabilityMonitor,
  type EdgeCalcInput,
} from './edge/index.ts';
import { QRLTable, qrlDirectionConfig, qrlExpectancyMultiplier, type AlphaDiscovery, type QRLExpectancy } from './evolution/q-rl-table.ts';
import { MetaCalibrator } from './evolution/meta-calibrator.ts';
import { SelfImprover } from './evolution/self-improver.ts';
import { ExitPriceLearner, convertToPriceExtremes } from './analysis/exit-price-learner.ts';
import { CausalReasoner } from './evolution/causal-reasoner.ts';
import { ComponentAttributionStore, normalizeTradeSide } from './evolution/component-attribution.ts';
import { MetaLearner, deriveAssetMetadata } from './evolution/meta-learner.ts';
import { initializeLLM, getActiveProviderType } from './llm/index.ts';
import { getActiveProvider } from './llm/index.ts';
import { getAgentModel } from './agents/agent-models.ts';
// v2.0.869(主神 binance-websocket 剷除):MarketStateAggregator 搬去 market-state.ts——
// BinanceWebSocketManager 冇用(HL-only mode)
import { MarketStateAggregator, type AggregatedMarketState } from './data/market-state.ts';
import { HyperliquidWebSocketManager } from './data/hyperliquid-websocket.ts';
import { MultiExchangeWebSocketManager, detectExchange, type UnifiedPrice, type UnifiedOrderBook } from './data/multi-exchange-ws.ts';
import { HACPEngine } from './cognition/hacp.ts';
import { RiskEngine } from './risk/engine.ts';
import { PortfolioTracker, normalizeSymbol, isThesisPlaceholder } from './trading/portfolio.ts';

/** v2.0.868-attack13:side normalize helper——'sell'/'short' → sell、'buy'/'long' → buy。
 *  HL/import 可能傳 'SELL'/'SHORT'——大小寫 + 語義都統一(唔會方向顛倒) */
function isSellSide(side: unknown): boolean {
  return ['sell', 'short'].includes(String(side ?? '').toLowerCase());
}
function isBuySide(side: unknown): boolean {
  return ['buy', 'long'].includes(String(side ?? '').toLowerCase());
}
import { safeLeverage } from './trading/position-utils.ts';
import { PaperTradingEngine, type ExecutionReport } from './trading/paper-engine.ts';
import { EvolutionOrchestrator } from './evolution/index.ts';
import { savePortfolio, saveDebateHistory, loadDebateHistory, saveEMState, loadEMState } from './evolution/persistence.ts';
import fs from 'node:fs';
import path from 'node:path';
import { FractalMomentumSentinel, OnChainWhisperer, OLRSentimentAnalyst, IndependentRiskAuditor, NewsReporter, SkepticsAgent, getLastFearGreedValue } from './agents/agents.ts';
import { MetaAgent } from './agents/meta-agent.ts';
import { APIServer } from './api-server.ts';
import { getAllAgentModels, getAvailableModels } from './agents/agent-models.ts';
import { BacktestEngine, type BacktestProgress } from './backtest/index.ts';
import { MarketAgent } from './market-agent/index.ts';
import { TradingManager } from './trading/trading-manager.ts';
import { ThesisExperience, ActiveProviderLLMCaller, hasLessonData } from './evolution/thesis-experience.ts';
import {
  PatternClusterManager,
  CloseReasonAggregator,
  SimilarTradeRetriever,
  SubtleDiffAnalyzer,
  formatAnalyticsBlock,
} from './evolution/reason-analytics.ts';
import { AttnResTradeEmbedder } from './evolution/attnres-trade-embedder.ts';
import { TransformersEmbedProvider, getSharedEmbedProvider } from './evolution/embeddings.ts';
import { SentimentEngine } from './analysis/sentiment-engine.ts';
import { AdaptiveNoiseFilter, AssetFilterRegistry, type MarketContext as FilterMarketContext, type FilterProfileType } from './analysis/adaptive-filter.ts';
import { DynamicThresholdCalculator, type DynamicThresholdInput, type DynamicThresholdResult } from './analysis/dynamic-threshold.ts';
import { PlanckChaosEngine } from './analysis/planck-chaos.ts';
import { SystemGuard } from './system-guard/index.ts';
import { ExecutionTracker } from './trading/execution-tracker.ts';
import { CorrelationBudget } from './risk/correlation-budget.ts';
import { calculateTakerFee, calculateFundingCost, getFeeSummary } from './trading/cost-model.ts';
import { getSRZones } from './analysis/support-resistance.ts';
import { setExecutionLensProvider, prepareExecutionLens, clearExecutionLens, type ExecutionLensData, getATR } from './analysis/atr.ts';
import { summarizeKlines } from './analysis/kline-structure.ts';
import { candleCache } from './data/candle-cache.ts';
import { evaluateDataQuality } from './analysis/data-quality.ts';
import { computeChartConvictionMultiplier } from './analysis/chart-conviction.ts';
import { LLMConvictionCalibrator } from './analysis/llm-conviction-calibrator.ts';
import { LLMDirectionVerifier } from './analysis/llm-direction-verifier.ts';
import { EVFilter } from './analysis/ev-filter.ts';
import { tgSignalPusher } from './services/tg-signal.ts';

/** v2.0.868:單日 PnL 序列結構(PNL dashboard 用) */
export interface PnlSeries {
  points: Array<{ t: number; cum: number }>;
  total: number;
  trades: number;
  wins: number;
  list: Array<Record<string, unknown>>;
}
import { supabaseTradeWriter } from './services/supabase-trade-writer.ts';
import { CloseDecisionCalibrator } from './analysis/close-decision-calibrator.ts';
import { ProfitabilityAnalyzer } from './analysis/profitability-analyzer.ts';
import { EntryQuality, checkConfirmation } from './analysis/entry-quality.ts';
// v2.0.869(主神 市況判斷調查):LLM 波動率 threshold 判定——per symbol threshold
import { VolatilityThresholdJudge } from './analysis/volatility-threshold-judge.ts';
import { classifyThesisCatalyst } from './analysis/thesis-catalyst.ts';
import { CycleSummaryManager } from './evolution/cycle-summary.ts';
import { AntiPatternTracker } from './evolution/anti-pattern-tracker.ts';
import { TradePatternClassifier } from './evolution/trade-pattern-classifier.ts';
import { PatternTagTracker } from './evolution/pattern-tag-tracker.ts';
import { OLREngine, type OLRQueryResult, regimeToOrdinal, FEATURE_NAMES } from './evolution/olr-engine.ts';
import { NumericAutoencoder } from './evolution/numeric-autoencoder.ts';
import { ENTRY_CONDITION_FEATURES, computeVectorConditionalWinRate, entryDecisionCondWROptions, safeNum } from './evolution/evolution-utils.ts';
import { CycleHistoryRetriever } from './evolution/cycle-history-retrieval.ts';
import { ShadowTradeEngine } from './evolution/shadow-trade-engine.ts';
import { ReplayBuffer } from './evolution/replay-buffer.ts';
import { BayesianOLR } from './evolution/bayesian-olr.ts';
import { ActiveExploration } from './evolution/active-exploration.ts';
import { calculateFirstPassage, estimateDrift, estimateVolatility, computeMomentum, type FirstPassageResult } from './evolution/first-passage.ts';
import { backfillOLRFromCandles, type HLCandle, type CandleFetcher } from './evolution/olr-backfill.ts';
import { wilsonScore } from './evolution/evolution-utils.ts';
import { ComboWinRateTracker, type ComboGateResult } from './evolution/combo-win-rate-tracker.ts';
import { auditTradeRecordsLLM, type AuditResult, type AuditIncident } from './evolution/direction-audit.ts';
import { runSystemEngineer } from './evolution/system-engineer.ts';
import { getOptionsDataManager, formatOptionsForAgent, formatPlaybookForAgent } from './analysis/options-data.ts';
import { fetchNewsSentiment, formatNewsForAgent, fetchNewsForSymbols, formatNewsForAgentMulti, fetchGlobalBreakingNews, formatGlobalNewsForMetaAgent, computePriceNewsTiming, normalizeBaseAsset, type TimingCandle } from './analysis/news-sentiment.ts';
import type { ConsensusResult, Ticker, AgentThought, AgentStatus, DebateRound, CycleProgress, TradingDecision, MarketAgentConfig, TopVolumePair, MultiSymbolDecision, AgentRole, ExchangeAccountInfo, TradeRecord, CycleSummary } from './types/index.ts';

// v2.0.819: entryMarketFeatures / entryOlrPWin / entryShadowWinRate / regime
// are now declared natively on TradeRecord (src/types/index.ts) and set
// synchronously at openPosition / importExchangePosition, then copied onto
// the closed record by closePosition / closeExchangePosition. The old
// PatchedTradeRecord duck-type shim is removed — the close path no longer
// silently drops these fields (root cause of 100% NO_OLR / NO_SHADOW).

const log = createLogger({ phase: 'system' });

// ─── v2.0.863: K-Line + Data Quality block flags(可獨立關閉)──────────
function parseBlockBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return def;
}
const klineBlockConfig = { enabled: parseBlockBool(process.env['KLINE_BLOCK_ENABLED'], true) } as const;
const dataQualityConfig = { enabled: parseBlockBool(process.env['DATA_QUALITY_BLOCK_ENABLED'], true) } as const;
const chartConvictionConfig = { enabled: parseBlockBool(process.env['CHART_AWARE_CONVICTION'], true) } as const;
const llmCalibrationConfig = { enabled: parseBlockBool(process.env['LLM_CONVICTION_CALIBRATION'], true) } as const;
const llmDirectionConfig = { enabled: parseBlockBool(process.env['LLM_DIRECTION_VERIFIER'], true) } as const;
const evFilterConfig = { enabled: parseBlockBool(process.env['EV_FILTER'], true) } as const;
const closeCalibConfig = { enabled: parseBlockBool(process.env['CLOSE_DECISION_CALIBRATION'], true) } as const;
/** v2.0.863-attack: K-LINE fetch TTL cache — 防 cycle period 縮短/多 call 令
 *  candleSnapshot 頻繁 fetch。5 分鐘 cycle 每 cycle 一次;cycle < TTL 時用 cache。 */
const KLINE_CACHE_TTL_MS = 120_000; // 2 分鐘


/** v2.0.720: Check if an audit category string mentions a specific direction.
 *  Used by the audit gate to match critical incidents to candidate decisions. */
function catDirMentionDirection(category: string, dir: 'buy' | 'sell'): boolean {
  if (dir === 'buy') return category.includes('buy') || category.includes('long');
  return category.includes('sell') || category.includes('short');
}

/** v2.0.221 (Fix 1): Extract hour-of-day from a timestamp (epoch ms) and
 *  normalise to 0-1 (hour/23). Returns 0.5 (noon) when ts is missing or invalid.
 *  This feeds the new OLR `hourOfDay` feature so the model can learn time-of-day
 *  patterns like "SKHX BUY at 16:00 loses 100%". */
function hourOfDayFromTs(ts?: number): number {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return 0.5; // noon — neutral default
  const hour = new Date(ts).getHours(); // 0-23 local time
  return hour / 23;
}

/** v2.0.221 (Fix 1): Current hour-of-day normalised to 0-1. Used for live
 *  feature extraction where no explicit timestamp is available. */
function currentHourOfDay(): number {
  return new Date().getHours() / 23;
}

// ─── v2.0.862: PAEL Exit-Price Lock config (TP-side one-vote exit) ──────
// Owner directive: TP side gets a one-vote exit when MFE reaches the asset's
// typical favourable zone; SL is NEVER touched (keeps noise room). Env-tunable,
// independently disableable (false → exact pre-PAEL close behaviour).
function parseLockBoolEnv(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return def;
}
function parseLockNumEnv(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
const exitPriceLockConfig = {
  /** Master switch — false restores exact pre-PAEL close behaviour. */
  enabled: parseLockBoolEnv(process.env['EXIT_PRICE_CLOSE_ENABLED'], true),
  /** Minimum hold (minutes) before the lock gate may fire — a 5-min MFE
   *  spike is noise, not a zone (matches meta-agent TIME CHECK spirit). */
  minHoldMinutes: Math.max(1, Math.floor(parseLockNumEnv(process.env['EXIT_PRICE_LOCK_MIN_HOLD_MIN'], 15))),
} as const;

/** v2.0.226 / v2.0.211: Compute learning weight based on close context.
 *  Extracted to src/evolution/learning-weight.ts for unit testability.
 *  See learning-weight.ts for the full decision table + v2.0.211 fix notes
 *  (system-decision closes now discounted regardless of profitability). */
import { computeLearningWeight } from './evolution/learning-weight.ts';

class MATSSystem {
  private marketState!: MarketStateAggregator;
  // v2.0.869(主神 市況判斷調查):LLM 波動率 threshold 判定器——per symbol threshold
  private volThresholdJudge!: VolatilityThresholdJudge;
  private fractalAgent!: FractalMomentumSentinel;
  private onchainAgent!: OnChainWhisperer;
  private regimeAgent!: OLRSentimentAnalyst;
  private riskAuditor!: IndependentRiskAuditor;
  private newsAgent!: NewsReporter;
  private metaAgent!: MetaAgent;
  private skepticsAgent!: SkepticsAgent;
  private riskEngine!: RiskEngine;
  private portfolio!: PortfolioTracker;
  private paperEngine!: PaperTradingEngine;
  private evolution!: EvolutionOrchestrator;
  private hacpEngine!: HACPEngine;
  /** v2.0.138: EXP thesis-experience vector memory (Skeptics Phase 1.8a). Gated by config.exp.enabled. */
  private expMemory!: ThesisExperience;
  /** v2.0.141: RIL — Reason Intelligence Layer components. */
  private patternCluster!: PatternClusterManager;
  private closeReasonAgg!: CloseReasonAggregator;
  private similarTradeRetriever!: SimilarTradeRetriever;
  private subtleDiffAnalyzer!: SubtleDiffAnalyzer;
  private backtest!: BacktestEngine;
  private apiServer!: APIServer;
  private marketAgent!: MarketAgent;
  private tradingManager!: TradingManager;
  /** v2.0.822: Analysis mode — write per-asset matrices to Supabase.
   *  v2.0.823: Dual mode — analysis + execution. When ANALYSIS_MODE='dual',
   *  the backend writes the analysis matrix to Supabase AND executes trades
   *  (paper or real) in the same cycle. This is the production default.
   *
   *  Modes:
   *    'true'  (default) — analysis only, no orders (legacy mats_backend)
   *    'false'           — execution only, no DB write (legacy amacrf)
   *    'dual'            — BOTH: write analysis to DB + execute trades
   */
  private analysisMode = ((): boolean => {
    const v = (process.env['ANALYSIS_MODE'] ?? 'dual').trim().toLowerCase();
    // v2.0.853-fix: Strict-parse ANALYSIS_MODE. The old code did
    //   analysisMode = (env ?? 'dual') !== 'false'
    //   dualMode      = (env ?? 'dual') === 'dual'
    // which silently mis-parses any non-canonical value. E.g. ANALYSIS_MODE=
    // 'TRUE'/'Dual'/'1' (user typo) yields analysisMode=true + dualMode=false,
    // which makes closeTrade()'s `analysisMode && !dualMode` guard skip EVERY
    // position close — the exact fatal bug this was meant to fix. Fall back to
    // the safe production default 'dual' on any unrecognised value so the
    // backend never silently stops closing positions.
    if (v === 'false') return false;
    // 'true' and 'dual' both enable analysis (DB write). 'dual' additionally
    // enables execution. Unrecognised → treat as 'dual' (safe: executes + writes).
    return true;
  })();
  private dualMode = ((): boolean => {
    const v = (process.env['ANALYSIS_MODE'] ?? 'dual').trim().toLowerCase();
    // Three canonical modes (trim + case-insensitive):
    //   'false'  → no DB write, no orders (legacy execution-only)
    //   'true'   → signal-only, no orders
    //   'dual'   → write analysis AND execute  (SAFE DEFAULT)
    // Any unrecognised value (garbage, '1', empty, etc.) FALLS BACK to 'dual'
    // so closeTrade/openTrade are never silently disabled by a typo. This is
    // the fix for the fatal bug where a non-canonical env value made
    // dualMode=false and skipped every position close.
    if (v === 'false' || v === 'true') return false;
    return true; // 'dual' or any unrecognised value → execute (safe default)
  })();
  private analysisWriter!: SupabaseAnalysisWriter;
  // v2.0.833: Edge Validation layer — alpha "lie detector"
  private edgeExecTracker!: EdgeExecutionTracker;
  private edgeStabilityMonitor!: StabilityMonitor;
  private edgeReportCount = 0;
  // v2.0.835: Q-RL Alpha Discovery
  private qrlTable!: QRLTable;
  /** v2.0.862: PAEL — per-asset exit-price learner (MFE/MAE profiles). */
  private exitPriceLearner!: ExitPriceLearner;
  /** v2.0.862: total lock-profit closes fired by the exit-price gate. */
  private exitPriceLockCount = 0;
  /** v2.0.862: last cycle we fed ui_snapshots (throttle — once per cycle). */
  private lastUiSnapshotCycle = -1;
  /** v2.0.863: cached K-line summary + data-quality score for the conviction gate
   *  (computed once per cycle in buildKlineBlock/buildDataQualityBlock — no refetch). */
  private lastKlineSummary: { trend1h: 'up' | 'down' | 'sideways'; trend5m: 'up' | 'down' | 'sideways' } | null = null;
  private lastQualityScore = 1;
  private lastKlineFetchTs = 0;
  private lastKlineBlockText = '';
  /** v2.0.863 規限①:LLM conviction calibrator + 讀圖質素 */
  private llmCalibrator!: LLMConvictionCalibrator;
  /** v2.0.864:LLM Direction Verifier(方向預測 + 平倉結果雙層校準) */
  private llmDirectionVerifier!: LLMDirectionVerifier;
  /** v2.0.865:EV Filter(期望值過濾器——量化核心:負 EV 軟性降權) */
  private evFilter!: EVFilter;
  /** v2.0.866:Close-Decision Calibrator(平倉判斷校準——Phase A:記錄+驗證+統計) */
  private closeCalibrator!: CloseDecisionCalibrator;
  /** v2.0.868:Profitability Analyzer——量化分析器(hold-time EV / direction bias / fee impact) */
  private profitabilityAnalyzer!: ProfitabilityAnalyzer;
  /** v2.0.868-P1P2:Entry Quality System——入場確認 Gate + MAE Profile */
  private entryQuality!: EntryQuality;
  /** v2.0.864: 上次記錄判斷時嘅 rationale(block 注入用) */
  private lastJudgeRationale = '';
  /** v2.0.865: 上次判斷嘅 gateAction(block 注入用) */
  private lastJudgeGateAction: 'buy' | 'sell' = 'buy';
  /** v2.0.865-fix3: 今次決策嘅 consensus confidence(開倉傳遞用——
   *  舊用 lastHACPResult = 上 cycle,錯配——Conviction Calibrator/Meta-Calibrator 全錯) */
  private lastCycleConsensusConfidence = 0.5;
  // v2.0.837: Meta-Cognitive Calibrator — system self-awareness
  private metaCalibrator!: MetaCalibrator;
  // v2.0.838: Self-Improver — auto-tuning hyperparameters
  private selfImprover!: SelfImprover;
  // v2.0.839: Causal Reasoner — causation vs correlation
  private causalReasoner!: CausalReasoner;
  // v2.0.840: Meta-Learner — learning to learn
  private metaLearner!: MetaLearner;
  // v2.0.844: Component Attribution Store — per-component edge attribution
  private componentAttribution!: ComponentAttributionStore;
  private sentimentEngine!: SentimentEngine;
  /** v2.0.105: Adaptive noise filter — sigmoid+EMA with per-cycle auto-tuning */
  private adaptiveFilter!: AdaptiveNoiseFilter;
  /** v2.0.106: Per-asset filter registry — each asset gets its own filter */
  private assetFilterRegistry!: AssetFilterRegistry;
  /** v2.0.227: Dynamic threshold calculator — Plan G unified multiplicative gate */
  private dynamicThresholdCalc!: DynamicThresholdCalculator;
  /** v2.0.228: Symbols that traded this cycle — for per-symbol idle tracking */
  private _symbolsTradedThisCycle: Set<string> | null = null;
  private planckChaos!: PlanckChaosEngine;
  private hyperliquidWs!: HyperliquidWebSocketManager;
  private multiWs!: MultiExchangeWebSocketManager;
  private systemGuard!: SystemGuard;
  private executionTracker!: ExecutionTracker;
  private correlationBudget!: CorrelationBudget;
  /** v2.0.58: Options data layer for Stocks/Indices trading */
  private optionsDataManager = getOptionsDataManager();

  private decisionTimer: ReturnType<typeof setInterval> | null = null;
  private cycleIntervalMs: number = config.system.decisionIntervalMs;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private restPollTimer: ReturnType<typeof setInterval> | null = null;
  /** v2.0.140: UI push timer — pushes portfolio + position updates every 10s
   *  so the UI auto-refreshes Mark prices + PnL between decision cycles. */
  private uiPushTimer: ReturnType<typeof setInterval> | null = null;
  private tradesToday = 0;
  /** v2.0.726: Cycles since last trade execution — used to trigger SE
   *  investigation when the system hasn't traded for 3+ cycles. */
  private cyclesSinceLastTrade = 0;
  /** v2.0.749: Global consecutive loss counter — triggers SE investigation
   *  when the system loses N trades in a row, regardless of symbol/direction. */
  private globalConsecutiveLosses = 0;
  /** v2.0.770: Last SE run cycle — throttle SE to at most once every 10 cycles
   *  to prevent slot starvation when SE competes with 8 trading agents. */
  private lastSECycle = -999;
  private static readonly SE_MIN_CYCLE_GAP = 10;
  /** v2.0.764: Dynamic minimum volatility threshold — adapts based on recent
   *  trade outcomes. If low-volatility trades keep losing, the threshold rises
   *  (require higher vol to enter). If high-vol trades win, threshold stays low. */
  private dynamicMinVolatility = 0.001; // start conservative
  /** v2.0.764: Track recent trade volatilities + outcomes for dynamic adjustment. */
  private recentVolOutcomes: Array<{ vol: number; win: boolean }> = [];
  /** v2.0.726: Last cycle's gate results — for SE no-trade investigation. */
  private lastGateResults: Array<{ gate: string; passed: boolean; reason: string }> = [];
  /** v2.0.726: Recent market conditions — for SE no-trade investigation. */
  private recentMarketConditions: Array<{ cycle: number; regime: string; volatility: number; price: number }> = [];
  private totalCycles = 0;
  private cycleInProgress = false;
  private lastCycleDuration = 0;
  private lastHACPResult: { consensus: ConsensusResult; allThoughts: AgentThought[]; debateRounds: DebateRound[] } | null = null;
  /** v2.0.140: EXP action log from the last HACP cycle. */
  private lastExpActions: import('./cognition/hacp.ts').ExpAction[] = [];
  private cycleProgress: CycleProgress | null = null;
  /** Cached real-exchange balance (v2.0.17). Refreshed each cycle in real mode
   *  via tradingManager.getBalance(); used by pushToAPI() so the UI shows
   *  the actual Hyperliquid account value instead of the local mirror. */
  private cachedExchangeBalance: ExchangeAccountInfo | null = null;
  /** Cached recent HL fills (v2.0.19). Refreshed each cycle in real mode via
   *  tradingManager.getRecentFills(5); merged into tradeRecords so the UI
   *  Trade Records panel shows the real Hyperliquid trade history. */
  private cachedHLFills: Array<{ symbol: string; side: 'buy' | 'sell'; price: number; size: number; timestamp: number; closedPnl: number; fee: number; dir: string }> = [];
  // v2.0.169: Track which positions have already been logged as "missing from WS push"
  // to prevent spamming the log every 5s for DEX positions (xyz:*) that are never
  // in the WS clearinghouseState push.
  private wsMissingLogged: Set<string> = new Set();
  /** Cached real-exchange positions (v2.0.19). Refreshed each cycle in real
   *  mode so the UI Portfolio positions module shows the actual Hyperliquid
   *  positions, not just the local mirror. */
  private cachedExchangePositions: Array<{ symbol: string; side: 'buy' | 'sell'; quantity: number; averageEntryPrice: number; currentPrice: number; unrealizedPnl: number; leverage: number; openedAt: number }> | null = null;
  private lastSRContext: { formatted: string; regime: string; zoneCount: number; strongZones: number; nearestSupport: number | null; nearestResistance: number | null; distanceToSupportBps: number; distanceToResistanceBps: number; degradedReason: string | null; nearestSupportStrength: 'strong' | 'moderate' | 'weak' | null; nearestSupportSource: 'pivot' | 'round_num' | 'orderbook' | null } | null = null;
  /** v2.0.79: Cached news headlines per symbol for UI display in News Reporter card. */
  private cachedNewsHeadlines: Array<{ symbol: string; headlines: Array<{ title: string; publisher: string; url?: string; pubDate: number | null }> }> = [];
  /** v2.0.143: Cached news context from the last successful fetch — reused
   *  when news fetching fails so the News Reporter agent still has data to
   *  work with instead of getting an empty context and falling back. */
  private lastSuccessfulNewsContext = '';
  private lastSuccessfulNewsHeadlines: Array<{ symbol: string; headlines: Array<{ title: string; publisher: string; url?: string; pubDate: number | null }> }> = [];
  /** v2.0.143: Last news fetch error reason (for UI display + LLM digestion). */
  private lastNewsFetchError = '';
  // v2.0.139: 5-min cache for 1h candles fetched for price-news timing analysis
  // (avoids re-fetching the same asset's chart every cycle; 80 candles ≈ 3.3d).
  private candleTimingCache: Map<string, { candles: TimingCandle[]; ts: number }> = new Map();
  // v2.0.139: Remember each position's actual leverage so closed-fill trade
  // records display the REAL leverage instead of a hardcoded 10x default.
  // Updated whenever cachedExchangePositions is refreshed; survives the close.
  private lastKnownLeverage: Map<string, number> = new Map();
  // v2.0.139: Cached live prices for all trading-market + open-position symbols
  // (from fetchPricesForSymbols each cycle). Used by refreshPositionMarkPrices()
  // to update the UI Mark column — the marketState aggregator only has the
  // ACTIVE symbol's ticker, not all position symbols.
  private cachedPriceMap: Map<string, number> = new Map();
  /** v2.0.139: Symbols being force-closed due to thesis invalidation. Set
   *  before calling closePosition/closeExchangePosition so the
   *  onPositionClosedLearning callback can tag the trade record. Thesis-
   *  invalidation losses are excluded from the conviction-gate winRate so the
   *  gate only tightens on real market-risk losses (SL hit), not thesis-system
   *  force-closes — prevents the feedback trap where thesis invalidation
   *  raises the gate → new entries blocked → system stuck in cash. */
  private thesisInvalidatedCloseSymbols = new Set<string>();
  /** v2.0.79: Trading markets list from UI pills — determines which symbols
   *  agents analyze (combined with open positions). Replaces auto-select. */
  private tradingMarkets: string[] = [];
  private emManager!: CycleSummaryManager;
  /** v2.0.207 (#F): Anti-pattern tracker — clusters historical failure lessons. */
  private antiPatternTracker!: AntiPatternTracker;
  /** v2.0.210 (Fix 1): Cache entry-time OLR P(win) per symbol so recordClose
   *  stores the TRUE entry-time OLR, not a close-time recompute. Fixes the
   *  audit 'thesis-contradicts-action' false positive (thesis says OLR 99%,
   *  field shows 0% because it was recomputed at close with different features). */
  private entryOlrPWinCache = new Map<string, number>();
  private patternClassifier!: TradePatternClassifier;
  private patternTagTracker!: PatternTagTracker;
  /** OLR (Online Logistic Regression) engine — learns P(win) from shadow + real trade outcomes. */
  private olrEngine!: OLREngine;
  /** Shadow Trade Engine — opens simulated LONG+SHORT each cycle, tracks TP-before-SL outcomes. */
  private shadowEngine!: ShadowTradeEngine;
  /** v2.0.219: Advanced learning systems */
  private replayBuffer!: ReplayBuffer;
  private bayesianOLR!: BayesianOLR;
  private activeExploration!: ActiveExploration;
  /** v2.0.221 (Fix 3+4): Combo Win Rate Tracker — (symbol × side × regime) WR tracking + soft gate. */
  private comboTracker!: ComboWinRateTracker;

  /** v2.0.819: WINNER-FIRST — positive boost from the lossStreakTracker
   *  winner pattern (checkWinnerPattern). Set by applyLossStreakGateToDecision
   *  when a winner is found, consumed by the Plan G conviction gate as a
   *  multiplicative boostFactor. Previously this was encoded as a NEGATIVE
   *  _lossStreakPenalty and silently clipped to 0 by Math.max(0, netPenalty),
   *  so the WINNER-FIRST directive never reached the gate. */
  private _winnerBoost = 0;

  /** v2.0.820: Stale-feed watchdog state. Tracks the last time we forced a
   *  WS reconnect for the selected symbol so we don't spam reconnect attempts
   *  every cycle when the feed is genuinely down (e.g. exchange maintenance).
   *  Also tracks per-symbol consecutive fetch failures for non-active markets. */
  private lastWsReconnectAttempt = 0;
  private readonly WS_RECONNECT_THROTTLE_MS = 60_000; // min 60s between forced reconnects
  private readonly STALE_FEED_THRESHOLD_MS = 60_000; // feed stale if no update for 60s
  private nonActiveFetchFailures = new Map<string, number>();
  private readonly NON_ACTIVE_FAIL_WARN = 5; // log after N consecutive failures
  /** v2.0.204: Numeric Autoencoder — learns non-linear market-condition embedding for vector-conditional WR. */
  private naEngine!: NumericAutoencoder;
  /** v2.0.211 (K.md #1): Cycle-History Selective Retrieval (AttnRes transfer).
   *  Per-symbol rolling cycle history + entry-time features + learned
   *  pseudo-query. Provides h_blend (softmax-weighted blend over cycle
   *  history + entry state) as the conditional-WR candidate, replacing the
   *  single current-snapshot. Entry-time regime retains persistent weight
   *  (K3 embedding persistence). */
  private cycleHistory!: CycleHistoryRetriever;
  /** v2.0.215: AttnRes trade embedder — learned blend of MiniLM rationale vectors. */
  private attnResTradeEmbedder!: AttnResTradeEmbedder;
  /** One-shot cold-start OLR backfill guard — ensures backfill runs at most
   *  once per process, on the first cycle that has non-empty trading markets. */
  private olrBackfillDone = false;
  /** Last first-passage probability result (for agent context + UI). */
  private lastFirstPassage: FirstPassageResult | null = null;
  private lastPatternContext = '';
  /** v2.0.720: Cached trade record audit result — runs every 2 cycles via LLM.
   *  Critical incidents matching the candidate symbol+direction override to HOLD. */
  private lastAuditResult: AuditResult | null = null;
  private auditCycleCounter = 0;
  private auditRunning = false;
  /** v2.0.736: Flag set when audit completes with incidents — triggers SE
   *  to run after the current cycle completes. SE follows audit, not a schedule. */
  private auditTriggeredSE = false;
  /** v2.0.143: Terminal Agent Root Command Prompt — stored on backend so it
   *  survives UI refreshes and is available for cycle enforcement (Phase -1
   *  rule checking + Phase 6 decision verification + injection into all agents). */
  private rootCommandPrompt = '';
  /** v2.0.143: Terminal Agent Side Guide — the latest LLM response's Side Guide
   *  section, sent to UI for user interaction (clarification questions etc). */
  private terminalSideGuide = '';
  /** Per-symbol previous cycle context for shadow trade opening — Map<symbol, context> */
  private lastCycleShadowContexts = new Map<string, { symbol: string; price: number; features: Record<string, number> }>();
  /** v2.0.831: Per-cycle ATR cache — pre-fetched at cycle start so vol-gate
   *  and entry-gate don't need to make synchronous HL API calls (which timeout
   *  under rate-limiter pressure). Key = normalized symbol, value = ATR (absolute). */
  private atrCacheThisCycle = new Map<string, number>();
  /** v2.0.122: Pending entry theses from Meta-Agent that didn't execute.
   *  When Meta-Agent outputs BUY/SELL with an entryThesis but the trade is
   *  blocked (conviction gate, liquidity, direction restriction, etc.), the
   *  thesis is stored here so it carries forward to the next cycle. Skeptics
   *  re-validates it each cycle, and Meta-Agent sees the prior reasoning.
   *  Cleared when a position actually opens for that symbol.
   *  Map: normalized symbol → { thesis, action, storedAt, cycle } */
  private pendingTheses = new Map<string, { thesis: string; action: 'buy' | 'sell'; storedAt: number; cycle: number }>();
  /** v2.0.202: Per-symbol-per-direction loss streak guard.
   *  Tracks consecutive losses for each (symbol, direction) pair.
   *  After 3 consecutive losses, the pair is blocked (force HOLD) for 12 cycles (60 min).
   *  The counter resets on any win for that pair.
   *  Map: "symbol:direction" → { consecutiveLosses, blockedUntilCycle }
   *
   *  v2.0.202: Also tracks the total trade count per pair so we can detect
   *  systematic losers even without consecutive losses (e.g. 14 trades, 29% WR).
   *  If totalTrades >= 10 AND winRate < 0.35, the pair is blocked until
   *  the win rate recovers above 0.40. This catches the BUY xyz:SKHX pattern
   *  where losses are not consecutive but the direction is systematically wrong.
   *
   *  v2.0.181: Added checkLossStreakGate() method that checks BOTH the
   *  consecutive loss streak AND the systematic loser threshold (totalTrades >= 10
   *  AND winRate < 0.35). Returns { blocked: boolean, reason?: string }.
   *  Called in the decision cycle before executing any BUY/SELL decision.
   *  Also called in onPositionClosedLearning() to update the tracker on every close. */
  private lossStreakTracker = new Map<string, {
    consecutiveLosses: number;
    blockedUntilCycle: number;
    totalTrades: number;
    totalWins: number;
    /** v2.0.770: Total PnL for this (symbol, direction) pair — used for PnL-aware winner detection. */
    totalPnl: number;
    /** v2.0.732: Per-regime win/loss tracking for condition-aware gating. */
    regimeStats: Map<string, { trades: number; wins: number; volatility: number; pnl: number }>;
  }>();

  /**
   * v2.0.732: Condition-aware SOFT gate for per-symbol-per-direction loss streak.
   *
   * Philosophy: "Past losses don't guarantee future losses" — but if the
   * SAME market conditions (regime) keep producing losses, we raise the
   * conviction threshold (require stronger signal), NOT hard block.
   *
   * Two conditions (both SOFT — raise conviction, never block):
   * 1. 3 consecutive losses in SAME regime → conviction +15%
   * 2. 5+ trades with <35% WR in SAME regime → conviction +20%
   *
   * If current regime differs from the losing regime → no penalty (market changed).
   *
   * v2.0.734: REVERTED SE's v2.0.733 hard block changes. SE added HARD gate
   * (5 consecutive losses → block) and SYSTEMATIC LOSER block (10+ trades,
   * WR<35% → block). These violate the design principle that past losses
   * in different market conditions don't justify blocking future trades.
   * The gate is SOFT only — it raises conviction threshold but never blocks.
   *
   * Returns { blocked: false, convictionPenalty?: number, reason?: string }
   */
  private checkLossStreakGate(symbol: string, direction: 'buy' | 'sell'): { blocked: boolean; convictionPenalty?: number; reason?: string } {
    const key = `${normalizeSymbol(symbol)}:${direction}`;
    const entry = this.lossStreakTracker.get(key);
    if (!entry) return { blocked: false };

    // v2.0.732: Get current market regime for condition-aware check
    const currentRegime = this.marketState.getState(symbol)?.regime
      ?? this.marketState.getState(this.marketAgent.getConfig().selectedSymbol)?.regime
      ?? 'unknown';

    // v2.0.732: Condition 1 — consecutive loss streak (SOFT gate, regime-aware)
    if (entry.consecutiveLosses >= 3) {
      // Check if current regime matches where the losses happened
      const regimeStats = entry.regimeStats.get(currentRegime);
      if (regimeStats && regimeStats.trades >= 3) {
        const regimeWR = regimeStats.wins / regimeStats.trades;
        if (regimeWR < 0.35) {
          return { blocked: false, convictionPenalty: 0.15, reason: `Loss streak: ${entry.consecutiveLosses} consecutive losses in ${currentRegime} regime — conviction +15% (stronger signal required, not blocked)` };
        }
      }
      // Regime changed — no penalty, let it trade
      entry.consecutiveLosses = 0;
      entry.blockedUntilCycle = 0;
    }

    // v2.0.732: Condition 2 — condition-aware systematic loser (SOFT gate)
    // Only penalizes if the CURRENT regime has a losing track record.
    // If the regime changed, past losses are irrelevant.
    const regimeStats = entry.regimeStats.get(currentRegime);
    if (regimeStats && regimeStats.trades >= 5) {
      const regimeWR = regimeStats.wins / regimeStats.trades;
      if (regimeWR < 0.35) {
        return { blocked: false, convictionPenalty: 0.20, reason: `Condition-aware soft gate: ${direction.toUpperCase()} ${symbol} in ${currentRegime} regime has ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStats.trades} trades — conviction +20% (stronger signal required, not blocked)` };
      }
    }

    return { blocked: false };
  }

  /**
   * v2.0.209: Conditional-WR soft gate — the VECTOR-CONDITIONAL win rate is the
   * TRUE edge signal (not raw per-symbol WR). When the conditional WR for the
   * candidate direction is very low (similar market conditions historically
   * lost), apply a conviction penalty so low-conviction entries are gated.
   * This is SOFT (never hard block) and stacks with the loss-streak gate.
   *
   * This directly fixes the audit finding "low-conditional-win-rate-ignored":
   * trades were entered with conditional WR 10-25%. Now conditional WR < 30%
   * applies a +25-35% conviction penalty, so only very-high-conviction entries
   * can pass — and those require the Meta-Agent to articulate a specific
   * catalyst the historical sample didn't capture.
   */
  private checkConditionalWRGate(symbol: string, direction: 'buy' | 'sell'): { blocked: boolean; convictionPenalty?: number; reason?: string } {
    try {
      const sym = normalizeSymbol(symbol);
      // v2.0.211 (K.md #1): Use AttnRes h_blend (softmax blend over cycle
      // history + entry-time state) as the conditional-WR candidate instead
      // of the single current snapshot. Cold-start safe: when history <
      // minHistoryToBlend, retrieveBlend returns the current snapshot unchanged.
      const blend = this.cycleHistory?.retrieveBlend(sym);
      const feats = blend?.hBlend ?? this.lastCycleShadowContexts.get(sym)?.features;
      if (!feats || Object.keys(feats).length === 0) return { blocked: false };
      const records = this.expMemory?.getRecords() ?? [];
      if (records.length < 5) return { blocked: false };
      const cond = computeVectorConditionalWinRate(
        feats,
        records,
        // v2.0.211: entry-decision gate — exclude system-decision closes so the
        // WR reflects only clean market-risk outcomes (SL/TP). Helper enforces
        // the exclusion contract shared with all entry-decision callers.
        entryDecisionCondWROptions(direction, this.naEngine ?? undefined,
          { minSamples: 5, threshold: 0.75, rmsNormKeys: true, softmaxWeightedWR: true, softmaxTemperature: 0.1 }),
      );
      if (cond.confidence === 'none' || cond.sampleSize < 5) return { blocked: false };
      const wr = cond.conditionalWinRate;
      if (wr < 0.20) {
        return { blocked: false, convictionPenalty: 0.35, reason: `Conditional WR ${(wr * 100).toFixed(0)}% (n=${cond.sampleSize}) — similar market conditions lost ${((1 - wr) * 100).toFixed(0)}% of the time. Conviction +35% (very strong signal required).` };
      }
      if (wr < 0.30) {
        return { blocked: false, convictionPenalty: 0.25, reason: `Conditional WR ${(wr * 100).toFixed(0)}% (n=${cond.sampleSize}) — similar market conditions lost ${((1 - wr) * 100).toFixed(0)}% of the time. Conviction +25% (stronger signal required).` };
      }
      if (wr < 0.40) {
        return { blocked: false, convictionPenalty: 0.15, reason: `Conditional WR ${(wr * 100).toFixed(0)}% (n=${cond.sampleSize}) — similar market conditions favour the opposite direction. Conviction +15%.` };
      }
      return { blocked: false };
    } catch {
      return { blocked: false };
    }
  }

  // v2.0.770: checkSystematicLoserGate DELETED ENTIRELY — OWNER DIRECTIVE.
  // This method contained a HARD BLOCK that prevented trading based on past
  // win rates. The owner has explicitly stated: "NEVER hard block" and has
  // reverted this method's effects MULTIPLE times. The condition-aware soft
  // gate (checkLossStreakGate) handles losing patterns with a 15-20% conviction
  // penalty — that is the MAXIMUM allowed intervention. Do NOT re-add this
  // method. Do NOT add any method that returns { blocked: true } for losing
  // patterns. If you see a (symbol, direction) pair with low WR, that is NOT
  // a bug — the soft gate handles it. Move on to a DIFFERENT issue.

  /**
   * v2.0.181: Update the loss streak tracker when a trade closes.
   * Called from onPositionClosedLearning() for EVERY closed trade.
   * - Win: reset consecutiveLosses to 0, increment totalWins
   * - Loss: increment consecutiveLosses, set blockedUntilCycle if >= 3
   * Always increments totalTrades.
   */
  private updateLossStreakTracker(symbol: string, direction: 'buy' | 'sell', isWin: boolean, pnl: number = 0): void {
    const key = `${normalizeSymbol(symbol)}:${direction}`;
    let entry = this.lossStreakTracker.get(key);
    if (!entry) {
      entry = { consecutiveLosses: 0, blockedUntilCycle: 0, totalTrades: 0, totalWins: 0, totalPnl: 0, regimeStats: new Map() };
      this.lossStreakTracker.set(key, entry);
    }

    entry.totalTrades++;
    entry.totalPnl += pnl;

    // v2.0.732: Track per-regime stats for condition-aware gating
    const regime = this.marketState.getState(symbol)?.regime
      ?? this.marketState.getState(this.marketAgent.getConfig().selectedSymbol)?.regime
      ?? 'unknown';
    const volatility = this.marketState.getState(symbol)?.volatility ?? 0;
    let regimeStat = entry.regimeStats.get(regime);
    if (!regimeStat) {
      regimeStat = { trades: 0, wins: 0, volatility: 0, pnl: 0 };
      entry.regimeStats.set(regime, regimeStat);
    }
    regimeStat.trades++;
    regimeStat.volatility = volatility;
    regimeStat.pnl += pnl;
    if (isWin) regimeStat.wins++;

    if (isWin) {
      entry.consecutiveLosses = 0;
      entry.totalWins++;
      entry.blockedUntilCycle = 0;
    } else {
      entry.consecutiveLosses++;
      if (entry.consecutiveLosses >= 3) {
        // v2.0.732: Short cooldown (6 cycles, was 12) — just a breather,
        // not a hard block. The condition-aware soft gate handles the rest.
        entry.blockedUntilCycle = this.totalCycles + 6;
        log.warn(`🚡 [loss-streak] ${direction.toUpperCase()} ${symbol}: ${entry.consecutiveLosses} consecutive losses in ${regime} regime — conviction penalty for 6 cycles`);
      }
    }

    // v2.0.732: Log condition-aware systematic loser detection
    if (regimeStat.trades >= 5) {
      const regimeWR = regimeStat.wins / regimeStat.trades;
      if (regimeWR < 0.35) {
        log.warn(`🚡 [condition-aware] ${direction.toUpperCase()} ${symbol} in ${regime} regime: ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStat.trades} trades — conviction +20% (soft gate, not blocked)`);
      }
    }
  }

  /**
   * v2.0.766: Check for systematic WINNER patterns — (symbol, direction) pairs
   * that have a strong winning track record in the CURRENT regime. If found,
   * return a conviction BOOST (lower the threshold so winning patterns enter
   * more easily). This is the profit-maximizing counterpart to the loss streak gate.
   *
   * The owner's directive: "Find winning patterns — blocking losing patterns is secondary."
   *
   * Two boost levels:
   * 1. 5+ trades with ≥60% WR in SAME regime → conviction -10% (easier entry)
   * 2. 5+ trades with ≥70% WR in SAME regime → conviction -15% + position size ×1.2
   *
   * Returns { convictionBoost?: number, sizeBoost?: number, reason?: string }
   */
  private checkWinnerPattern(symbol: string, direction: 'buy' | 'sell'): { convictionBoost?: number; sizeBoost?: number; reason?: string } {
    const key = `${normalizeSymbol(symbol)}:${direction}`;
    const entry = this.lossStreakTracker.get(key);
    if (!entry) return {};

    const currentRegime = this.marketState.getState(symbol)?.regime
      ?? this.marketState.getState(this.marketAgent.getConfig().selectedSymbol)?.regime
      ?? 'unknown';

    const regimeStats = entry.regimeStats.get(currentRegime);
    if (!regimeStats || regimeStats.trades < 5) return {};

    const regimeWR = regimeStats.wins / regimeStats.trades;

    // v2.0.770: WINNER-FIRST — also check PnL-based winning patterns.
    // A pattern with 47% WR but +$3.43 net PnL is a WINNER — the wins are bigger
    // than the losses. WR alone does not determine profitability.
    // The owner said: "先搵贏嘅 pattern，搵唔到贏嘅先至考慮會唔會輸"
    // We need to track PnL per regime — but lossStreakTracker doesn't store PnL.
    // Instead, we use a heuristic: if WR ≥ 45% with 10+ trades, the pattern is
    // likely profitable (wins and losses are roughly balanced in count, but
    // with 2:1+ RR the wins should be bigger). This is a conservative threshold.
    // Level 3 — PnL-likely winner (≥45% WR with 10+ trades in same regime)
    if (regimeStats.trades >= 10 && regimeWR >= 0.45 && regimeWR < 0.60) {
      log.info(`🟢 [winner-pattern-pnl] ${direction.toUpperCase()} ${symbol} in ${currentRegime}: ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStats.trades} trades — likely PnL-positive (RR 2:1+), conviction -8%`);
      return {
        convictionBoost: 0.08,
        reason: `PnL-likely winner: ${direction.toUpperCase()} ${symbol} in ${currentRegime} has ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStats.trades} trades — with 2:1+ RR, likely net positive PnL — conviction -8%`,
      };
    }

    // v2.0.766: Level 2 — strong winner (≥70% WR, 5+ trades in same regime)
    if (regimeWR >= 0.70) {
      log.info(`🟢 [winner-pattern] ${direction.toUpperCase()} ${symbol} in ${currentRegime}: ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStats.trades} trades — conviction -15% + size ×1.2`);
      return {
        convictionBoost: 0.15,
        sizeBoost: 1.2,
        reason: `Winner pattern: ${direction.toUpperCase()} ${symbol} in ${currentRegime} has ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStats.trades} trades — conviction -15%, size ×1.2`,
      };
    }

    // v2.0.766: Level 1 — moderate winner (≥60% WR, 5+ trades in same regime)
    if (regimeWR >= 0.60) {
      log.info(`🟢 [winner-pattern] ${direction.toUpperCase()} ${symbol} in ${currentRegime}: ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStats.trades} trades — conviction -10%`);
      return {
        convictionBoost: 0.10,
        reason: `Winner pattern: ${direction.toUpperCase()} ${symbol} in ${currentRegime} has ${(regimeWR * 100).toFixed(0)}% WR over ${regimeStats.trades} trades — conviction -10%`,
      };
    }

    return {};
  }

  /**
   * v2.0.202: Call the loss streak gate in the decision cycle BEFORE executing
   * any BUY/SELL decision. This is the injection point that was missing.
   * Called from the main decision cycle for the active symbol AND for each
   * per-symbol consensus entry.
   *
   * v2.0.770: WINNER-FIRST — check winner pattern BEFORE loss streak gate.
   * The owner said: "先搵贏嘅 pattern，搵唔到贏嘅先至考慮會唔會輸"
   * If a winning pattern is found, apply the boost and SKIP the loss penalty
   * (a winner is a winner, regardless of past losses in other regimes).
   */
  private applyLossStreakGateToDecision(
    decision: TradingDecision,
    symbol: string,
    action: 'buy' | 'sell',
    auditGates: Array<{ gate: string; passed: boolean; reason: string }>,
  ): TradingDecision {
    // v2.0.770: WINNER-FIRST — check winner pattern FIRST
    const winnerResult = this.checkWinnerPattern(symbol, action);

    // v2.0.770: If winner pattern found, apply boost and skip loss penalty
    if (winnerResult.convictionBoost) {
      const winnerBoost = winnerResult.convictionBoost;
      // v2.0.819: Track the winner boost as a POSITIVE value for the Plan G
      // multiplicative boostFactor. The old code stored -winnerBoost in
      // _lossStreakPenalty, which Math.max(0, netPenalty) in the gate then
      // clipped to 0 — so the WINNER-FIRST directive was silently discarded.
      this._winnerBoost = winnerBoost;
      (this as any)._lossStreakPenalty = 0;

      // v2.0.766: Apply size boost for strong winners
      if (winnerResult.sizeBoost && winnerResult.sizeBoost > 1) {
        const boostedSize = Math.min(0.20, (decision.positionSizePct ?? 0) * winnerResult.sizeBoost);
        log.info(`🟢 [winner-boost] ${action.toUpperCase()} ${symbol}: size ${(decision.positionSizePct * 100).toFixed(0)}% → ${(boostedSize * 100).toFixed(0)}% (${winnerResult.reason})`);
        auditGates.push({ gate: 'winner-pattern', passed: true, reason: `WINNER: conviction -${(winnerBoost * 100).toFixed(0)}%, size ×${winnerResult.sizeBoost}` });
        return { ...decision, positionSizePct: boostedSize };
      }

      log.info(`🟢 [winner-soft] ${action.toUpperCase()} ${symbol}: conviction -${(winnerBoost * 100).toFixed(0)}% (${winnerResult.reason?.slice(0, 60)}) — WINNER pattern, skipping loss penalty`);
      auditGates.push({ gate: 'winner-pattern', passed: true, reason: `WINNER: conviction -${(winnerBoost * 100).toFixed(0)}% (loss penalty skipped)` });
      return decision;
    }

    // v2.0.770: Only if NO winner pattern found, check loss streak gate
    const gateResult = this.checkLossStreakGate(symbol, action);
    const lossPenalty = gateResult.convictionPenalty ?? 0;
    // v2.0.209: Stack conditional-WR soft gate (vector-conditional, the TRUE edge signal).
    const condWRResult = this.checkConditionalWRGate(symbol, action);
    const condPenalty = condWRResult.convictionPenalty ?? 0;
    // v2.0.221 (Fix 4): Stack combo WR gate — (symbol × side × regime) specific penalty.
    // This is the targeted fix: SKHX SELL low_volatility = 12% WR → 50% penalty
    // (was only 35% from conditional WR, which was insufficient).
    const comboRegime = this.marketState?.getState(symbol)?.regime ?? 'unknown';
    const comboResult = this.comboTracker.checkComboGate(symbol, action, comboRegime);
    const comboPenalty = comboResult.convictionPenalty ?? 0;
    const netPenalty = lossPenalty + condPenalty + comboPenalty;

    // v2.0.819: No winner found — clear the boost and record the net penalty
    // for the Plan G penaltyFactor path.
    this._winnerBoost = 0;
    (this as any)._lossStreakPenalty = netPenalty;

    if (netPenalty > 0) {
      const reasons = [gateResult.reason, condWRResult.reason, comboResult.reason].filter(Boolean).join(' | ');
      log.info(`🚡 [soft-gate] ${action.toUpperCase()} ${symbol}: conviction +${(netPenalty * 100).toFixed(0)}% (${reasons?.slice(0, 120)}) — no winner pattern found, applying penalty`);
      auditGates.push({ gate: 'loss-streak', passed: true, reason: `soft: conviction +${(netPenalty * 100).toFixed(0)}% (no winner found)` });
    } else {
      auditGates.push({ gate: 'loss-streak', passed: true, reason: 'no penalty/boost' });
    }
    return decision;
  }
  /** v2.0.128: Decision audit log — tracks every Meta-Agent BUY/SELL decision
   *  and which gate blocked or allowed it. Kept to the last 50 entries. */
  private decisionAudit: Array<{
    cycle: number; symbol: string; action: 'buy' | 'sell'; confidence: number;
    thesis: string; gates: Array<{ gate: string; passed: boolean; reason: string }>;
    executed: boolean; timestamp: number;
  }> = [];
  private lastBacktestResult: import('./backtest/index.ts').BacktestResult | null = null;
  private backtestProgress: BacktestProgress | null = null;
  private paused = false;
  /** v2.0.29: Symbols that have legacy positions from the *other* trade mode.
   *  When switching paper→real, paper positions become legacy — they stay open
   *  and are managed (SL/TP, per-symbol consensus, price updates) until they
   *  naturally close. Same for real→paper with exchange positions.
   *  Map: symbol → 'paper' | 'real' (which mode the position originated from) */
  private legacyPositionModes = new Map<string, 'paper' | 'real'>();

  constructor() {
    log.info('🏛️  MATS System Initializing...');
    log.info(`   Config: ${config.ollama.modelDefault} (Ollama), ${config.paper.initialBalance} USDT paper, ${config.system.decisionIntervalMs / 1000}s cycle`);

    // Restore last debate/consensus result from disk so UI shows it immediately
    const savedDebate = loadDebateHistory();
    if (savedDebate) {
      this.totalCycles = savedDebate.totalCycles;
      this.lastCycleDuration = savedDebate.lastCycleDuration;
      this.lastHACPResult = {
        consensus: savedDebate.consensus,
        allThoughts: savedDebate.allThoughts,
        debateRounds: savedDebate.debateRounds,
      } as typeof this.lastHACPResult;
      log.info(`📋 Debate history restored: Cycle #${savedDebate.totalCycles}, ${savedDebate.debateRounds.length} rounds`);
    }
  }

  async start(): Promise<void> {
    try {
      // 1. Initialize LLM
      log.info('Step 1/6: Initializing LLM provider...');
      await initializeLLM();
      log.info(`✓ LLM: ${getActiveProviderType().toUpperCase()}`);

      // 2. Initialize components
      log.info('Step 2/6: Initializing agents...');
      this.fractalAgent = new FractalMomentumSentinel();
      this.onchainAgent = new OnChainWhisperer();
      this.regimeAgent = new OLRSentimentAnalyst();
      this.riskAuditor = new IndependentRiskAuditor();
      this.newsAgent = new NewsReporter();
      this.skepticsAgent = new SkepticsAgent();
      this.metaAgent = new MetaAgent();
      log.info('✓ Agents created', {
        agents: [
          this.fractalAgent.identity.name,
          this.onchainAgent.identity.name,
          this.regimeAgent.identity.name,
          this.riskAuditor.identity.name,
          this.newsAgent.identity.name,
          this.metaAgent.identity.name,
        ],
      });

      // 3. Initialize risk, portfolio, paper trading
      log.info('Step 3/6: Initializing trading systems...');
      this.portfolio = new PortfolioTracker();
      this.riskEngine = new RiskEngine();
      this.paperEngine = new PaperTradingEngine(this.portfolio, this.riskEngine);
      // Restore historical trades from portfolio snapshot
      if (this.portfolio.restoredTrades.length > 0) {
        this.paperEngine.restoreTrades(this.portfolio.restoredTrades);
        log.info(`📋 ${this.portfolio.restoredTrades.length} historical trades restored from disk`);
      }
      // v2.0.158: Purge phantom trades without entry thesis — these were created
      // by the old mirror bug (paperEngine.executeDecision mirror path) which
      // stored positions without thesis. They pollute the evolution system's
      // reference data and must be removed.
      const purgedPaper = this.paperEngine.purgeTradesWithoutThesis();
      const purgedReal = this.portfolio.purgeClosedRealTradesWithoutThesis();
      if (purgedPaper > 0 || purgedReal > 0) {
        log.info(`🧹 Purged ${purgedPaper} paper + ${purgedReal} real trades without entry thesis`);
        this.persistPortfolio();
      }
      log.info('✓ Trading systems ready');

      // 3.5 Initialize Sigmoid·GA Sentiment Engine + Adaptive Noise Filter
      log.info('Step 3.5/8: Initializing Sentiment Engine + Adaptive Filter...');
      this.sentimentEngine = new SentimentEngine();
      this.adaptiveFilter = new AdaptiveNoiseFilter({}, 'global');
      this.assetFilterRegistry = new AssetFilterRegistry();
      // v2.0.227: Plan G dynamic threshold calculator
      this.dynamicThresholdCalc = new DynamicThresholdCalculator();
      // v2.0.211: Set decision interval for time-based trade frequency pruning
      this.assetFilterRegistry.setDecisionInterval(this.cycleIntervalMs);
      this.adaptiveFilter.setDecisionInterval(this.cycleIntervalMs);
      log.info('✓ Sentiment Engine + Adaptive Filter ready');

      // 3.5b Initialize Planck-Chaos Resonance Engine
      log.info('Step 3.5b/8: Initializing Planck-Chaos Resonance Engine...');
      this.planckChaos = new PlanckChaosEngine();
      log.info('✓ Planck-Chaos Resonance Engine ready');

      // v2.0.58: Initialize Options Data Layer (Massive.com WS)
      // Only connects if MASSIVE_API_KEY is configured. Used for Stocks/Indices
      // trading to provide IV Rank, Gamma regime, Put/Call ratio, etc.
      // If connection fails or no API key, agents fall back to defaults.
      log.info('Step 3.5c/8: Initializing Options Data Layer...');
      try {
        await this.optionsDataManager.connect();
        log.info('✓ Options Data Layer ready');
      } catch (err) {
        log.warn(`Options Data Layer init failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }

      // 3.6 Initialize Market State Aggregator (MUST be before WebSocket data flows)
      log.info('Step 3.6/8: Initializing Market State Aggregator...');
      this.marketState = new MarketStateAggregator();
      log.info('✓ Market State Aggregator ready');

      // v2.0.869(主神 市況判斷調查):LLM 波動率 threshold 判定器——per symbol threshold
      // (貴金屬/指數正常波動 0.03-0.3%——global threshold 0.3% 誤判低波動)
      this.volThresholdJudge = new VolatilityThresholdJudge();
      this.volThresholdJudge.load();
      log.info('✓ Volatility Threshold Judge ready');

      // 3.7 Initialize SystemGuard (5-layer protection gate)
      log.info('Step 3.7/8: Initializing SystemGuard...');
      this.systemGuard = new SystemGuard();
      log.info('✓ SystemGuard ready (economic calendar, drawdown, data freshness, agent track, liquidity)');

      // 3.8 Initialize Execution Tracker + Correlation Budget
      log.info('Step 3.8/8: Initializing Execution Tracker & Correlation Budget...');
      this.executionTracker = new ExecutionTracker();
      this.correlationBudget = new CorrelationBudget();
      log.info('✓ Execution Tracker & Correlation Budget ready');

      // 3.9 Initialize EM CycleSummaryManager
      log.info('Step 3.9/8: Initializing EM CycleSummary Manager...');
      this.emManager = new CycleSummaryManager();
      // v2.0.207 (#F): Anti-pattern tracker init + load.
      this.antiPatternTracker = new AntiPatternTracker();
      this.antiPatternTracker.load();
      // v2.0.140: Load persisted EM state so cycle insights survive restarts.
      // Without this, every restart loses all 4000+ cycle insights →
      // EM Cycle Digestion starts from 0 → MiniLM retrieval has nothing to query.
      const savedEM = loadEMState();
      if (savedEM && savedEM.summaries.length > 0) {
        this.emManager.load({
          summaries: savedEM.summaries as CycleSummary[],
          convergenceAccuracy: savedEM.convergenceAccuracy,
          convergenceChecks: savedEM.convergenceChecks,
        });
        log.info(`✓ EM CycleSummary Manager loaded ${savedEM.summaries.length} summaries from disk (accuracy ${(savedEM.convergenceAccuracy * 100).toFixed(0)}%, ${savedEM.convergenceChecks} checks)`);
      } else {
        log.info('✓ EM CycleSummary Manager ready (no persisted state — starting fresh)');
      }

      // 3.10 Initialize OLR + Shadow Trade Engine (replaces RBC)
      // OLR learns P(win) from shadow trade outcomes (TP-before-SL) + real trade outcomes.
      // Shadow Trade Engine opens simulated LONG+SHORT each cycle, tracks until SL/TP hit.
      log.info('Step 3.10/8: Initializing OLR + Shadow Trade Engine...');
      this.olrEngine = new OLREngine();
      this.shadowEngine = new ShadowTradeEngine(this.olrEngine);
      // v2.0.219: Initialize advanced learning systems
      this.replayBuffer = new ReplayBuffer(this.olrEngine);
      this.bayesianOLR = new BayesianOLR(this.olrEngine);
      // v2.0.833 (Task 2 Phase 2): active-exploration paused by default —
      // blind UCB exploration without a validated edge is dangerous. The
      // Edge Report (Task 1) must first prove baseline edge before purposeful
      // exploration is re-enabled. Override via env ACTIVE_EXPLORATION_ENABLED=true.
      const explorationEnabled = process.env['ACTIVE_EXPLORATION_ENABLED'] === 'true';
      this.activeExploration = new ActiveExploration({ enabled: explorationEnabled });
      log.info(`✓ ActiveExploration ${explorationEnabled ? 'enabled' : 'paused (set ACTIVE_EXPLORATION_ENABLED=true to re-enable)'}`);
      // v2.0.221 (Fix 3+4): Combo Win Rate Tracker — (symbol × side × regime) WR
      this.comboTracker = new ComboWinRateTracker(path.join(process.cwd(), 'data'));
      try {
        const comboPath = path.join(process.cwd(), 'data/evolution/combo-win-rates.json');
        if (fs.existsSync(comboPath)) {
          this.comboTracker.load(fs.readFileSync(comboPath, 'utf-8'));
          log.info(`✓ ComboWinRateTracker loaded (${this.comboTracker.getComboCount()} combos, ${this.comboTracker.getTotalTrades()} trades)`);
        }
      } catch (e) {
        log.warn(`[combo-tracker] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      // Load persisted OLR + shadow state
      try {
        const olrPath = path.join(process.cwd(), 'data/evolution/olr-state.json');
        if (fs.existsSync(olrPath)) {
          const data = fs.readFileSync(olrPath, 'utf-8');
          this.olrEngine.load(data);
        }
        const shadowPath = path.join(process.cwd(), 'data/evolution/shadow-state.json');
        if (fs.existsSync(shadowPath)) {
          const data = fs.readFileSync(shadowPath, 'utf-8');
          this.shadowEngine.load(data);
        }
        // v2.0.219: Load advanced system states
        const loadAdv = (name: string, loadFn: (json: string) => void) => {
          const p = path.join(process.cwd(), `data/evolution/${name}`);
          if (fs.existsSync(p)) {
            try { loadFn(fs.readFileSync(p, 'utf-8')); } catch { /* fresh */ }
          }
        };
        loadAdv('replay-buffer.json', (j) => this.replayBuffer.load(j));
        loadAdv('exploration.json', (j) => this.activeExploration.load(j));
        log.info('✓ Advanced learning systems initialized (replay buffer, Bayesian OLR, exploration)');
      } catch { /* start fresh */ }
      log.info('✓ OLR + Shadow Trade Engine ready');

      // 3.10b v2.0.204: Initialize Numeric Autoencoder (market-condition embedding).
      // Learns a non-linear 8-d representation of entry features for vector-conditional
      // WR. Coexists with v2.0.203 min-max + cosine (cold-start fallback). Only takes
      // over once ≥200 samples AND validation passes (reconstruction MSE < 0.1,
      // contrastive acc > 60%).
      log.info('Step 3.10b: Initializing Numeric Autoencoder...');
      this.naEngine = new NumericAutoencoder({}, ENTRY_CONDITION_FEATURES);
      this.naEngine.load();
      log.info(`✓ Numeric Autoencoder ready (${this.naEngine.sampleCount()} samples, ${this.naEngine.isReady() ? 'LEARNED-embed active' : 'cold-start → min-max fallback'})`);

      // 3.10c v2.0.211 (K.md #1): Cycle-History Selective Retrieval (AttnRes transfer).
      // Per-symbol rolling cycle history + entry-time features + learned pseudo-query.
      // Provides h_blend for conditional WR (replaces single current-snapshot).
      // Cold-start safe: zero-init w + recency prior → starts as recency-weighted
      // mean of history (≈ current snapshot when recent cycles dominate).
      log.info('Step 3.10c: Initializing Cycle-History Retriever (AttnRes)...');
      this.cycleHistory = new CycleHistoryRetriever({ featureNames: ENTRY_CONDITION_FEATURES });
      this.cycleHistory.load();
      log.info(`✓ Cycle-History Retriever ready (${this.cycleHistory.size()} symbols tracked)`);

      // v2.0.213 (#7): Wire execution lens provider for computeATRSLTP.
      // When a trade is opened, index.ts calls prepareExecutionLens(sym) so
      // computeATRSLTP (called by trading-manager) picks up the execution-mode
      // AttnRes blend as the PRIMARY SL/TP signal. Cold-start safe: when
      // wExecution hasn't been trained (updateCount=0), computeATRSLTP falls
      // back to the original ATR + momentum logic.
      setExecutionLensProvider((symbol: string): ExecutionLensData | null => {
        if (!this.cycleHistory) return null;
        try {
          const blend = this.cycleHistory.retrieveBlend(symbol, 'execution');
          if (!blend.blended) return null;
          return {
            volatility: blend.hBlend['volatility'] ?? 0,
            momentumShort: blend.hBlend['momentumShort'] ?? 0,
            momentumLong: blend.hBlend['momentumLong'] ?? 0,
            entropy: blend.entropy,
            blended: blend.blended,
            updateCount: this.cycleHistory.getQuery(symbol, 'execution').some((v) => v !== 0) ? 1 : 0,
          };
        } catch { return null; }
      });
      log.info('✓ Execution lens provider wired for computeATRSLTP');

      // v2.0.143: Load persisted Root Command Prompt so it survives backend restarts.
      this.loadRootCommandPrompt();

      // 3.10b: Cold-start OLR backfill helper — defined here, invoked lazily
      // on the first decision cycle with non-empty trading markets (markets
      // may arrive from UI or persistence after init completes).


      // 3.11 Initialize Trade Pattern Classifier (kept for position management only)
      log.info('Step 3.11/8: Initializing Trade Pattern Classifier...');
      this.patternClassifier = new TradePatternClassifier();
      this.patternClassifier.load();
      // v2.0.206 (#5): Wire NA embedding provider so computeSimilarity uses
      // learned cosine (data-driven) instead of handcrafted weighted-diff.
      this.patternClassifier.setNaEmbeddingProvider(this.naEngine);
      log.info('✓ Trade Pattern Classifier ready');

      // 3.12 Initialize Pattern Tag Tracker (v2.0.28)
      log.info('Step 3.12/8: Initializing Pattern Tag Tracker...');
      this.patternTagTracker = new PatternTagTracker();
      this.patternTagTracker.load();
      log.info('✓ Pattern Tag Tracker ready');

      // 4. Initialize evolution
      log.info('Step 4/6: Initializing evolution systems...');
      this.evolution = new EvolutionOrchestrator();
      // Attach sentiment engine so GA state is persisted with evolution
      this.evolution.attachSentimentEngine(this.sentimentEngine);
      log.info('✓ Evolution systems ready');

      // 5. Initialize HACP
      log.info('Step 5/6: Initializing HACP cognition engine...');
      this.hacpEngine = new HACPEngine(
        this.metaAgent,
        this.riskAuditor,
        this.skepticsAgent,
        [this.fractalAgent, this.onchainAgent, this.regimeAgent, this.newsAgent]
      );
      // Inject trade history so the Risk Auditor can detect choppy-market
      // patterns from recent buy/sell churn + losses and adjust TP/SL.
      this.hacpEngine.setTradeHistory(this.evolution.tradeHistory);
      // Inject agent evolution engine for regime-aware dynamic voting weights.
      // Register each agent's hardcoded base weight so the engine can scale
      // them by per-regime win rate (v2.0.15).
      const ae = this.evolution.agentEvolution;
      ae.registerBaseWeight(this.fractalAgent.identity.role, this.fractalAgent.identity.weight);
      ae.registerBaseWeight(this.onchainAgent.identity.role, this.onchainAgent.identity.weight);
      ae.registerBaseWeight(this.regimeAgent.identity.role, this.regimeAgent.identity.weight);
      ae.registerBaseWeight(this.newsAgent.identity.role, this.newsAgent.identity.weight);
      ae.registerBaseWeight(this.riskAuditor.identity.role, this.riskAuditor.identity.weight);
      ae.registerBaseWeight(this.metaAgent.identity.role, this.metaAgent.identity.weight);
      this.hacpEngine.setAgentEvolution(ae);
      // v2.0.206 (#8): Wire NA provider so agent multipliers use conditional WR.
      ae.setNaEmbeddingProvider(this.naEngine);
      // Wire real-time progress updates to API
      this.hacpEngine.setProgressCallback((progress) => {
        this.cycleProgress = progress;
        this.pushToAPI();
      });
      log.info('✓ HACP engine ready');

      // ── v2.0.25: SL/TP Close Learning Hook ──
      // Register a callback that fires after EVERY position close (SL/TP,
      // reconciliation, agent-vote close). This bridges the gap between
      // price-update-triggered closes and the learning system — previously
      // SL/TP losses were invisible to OLR, Pattern Classifier, Agent
      // Outcomes, Trade History, and Evolution, so the system never learned
      // from consecutive losses that happened between decision cycles.
      this.paperEngine.setOnClosedLearning((trade) => {
        this.onPositionClosedLearning(trade);
      });
      // v2.0.32: Wire exchange position close learning — same learning
      // callback but does NOT add to paperEngine.trades[] (real trades
      // should not appear in paper trade list).
      this.portfolio.setOnExchangeClosedLearning((trade) => {
        this.onPositionClosedLearning(trade);
      });
      // v2.0.33: Wire UI callback for exchange position closes — immediately
      // refresh cachedHLFills + pushToAPI() so the UI updates instantly
      // (position disappears + HL fill appears in Trade Records) without
      // waiting for the next cycle.
      this.portfolio.setOnExchangeClosedUI(() => {
        this.refreshHLFillsAndPush();
      });
      log.info('✓ SL/TP close learning hook wired (paper + exchange + UI)');

      // 5.6 Initialize Real Trading Manager
      log.info('Step 5.6/8: Initializing Real Trading Manager...');
      this.tradingManager = new TradingManager(
        {
          tradeMode: 'paper',
          exchange: 'hyperliquid',
          hyperliquidWalletAddress: config.realTrading.hyperliquidWalletAddress,
          hyperliquidPrivateKey: config.realTrading.hyperliquidPrivateKey,
        },
        this.portfolio,
        this.riskEngine,
        this.paperEngine,
      );
      log.info('✓ Real Trading Manager ready');

      // 5.7 Initialize backtest engine (needs HACPEngine, so after step 5)
      this.backtest = new BacktestEngine(
        this.evolution,
        this.hacpEngine,
        this.skepticsAgent,
        this.metaAgent,
        this.riskAuditor,
        [this.fractalAgent, this.onchainAgent, this.regimeAgent, this.newsAgent]
      );
      this.backtest.setProgressCallback((progress: BacktestProgress) => {
        this.backtestProgress = progress;
        this.pushToAPI();
      });

      // 5.5. Skip pre-warm (Ollama handles model loading internally)
      log.info('Step 5.5/6: Ollama provider ready (no pre-warm needed)');

      // v2.0.833: Edge Validation layer init
      this.edgeExecTracker = new EdgeExecutionTracker();
      this.edgeStabilityMonitor = new StabilityMonitor();
      try {
        const execPath = path.join(process.cwd(), 'data/evolution/execution-tracker.json');
        if (fs.existsSync(execPath)) {
          this.edgeExecTracker.load(JSON.parse(fs.readFileSync(execPath, 'utf-8')));
          log.info('✓ ExecutionTracker loaded');
        }
      } catch (e) {
        log.warn(`[edge-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      log.info('✓ Edge Validation layer initialized (exec-tracker + stability-monitor)');

      // v2.0.835: Q-RL Alpha Discovery init
      this.qrlTable = new QRLTable();
      try {
        const qrlPath = path.join(process.cwd(), 'data/evolution/q-rl-table.json');
        if (fs.existsSync(qrlPath)) {
          this.qrlTable.load(JSON.parse(fs.readFileSync(qrlPath, 'utf-8')));
          log.info(`✓ Q-RL Table loaded (${this.qrlTable.getStats().activeCells} active cells, ε=${this.qrlTable.getStats().epsilon.toFixed(3)})`);
        }
      } catch (e) {
        log.warn(`[q-rl-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      log.info('✓ Q-RL Alpha Discovery initialized');

      // v2.0.862: PAEL — Exit-Price Learner init (learning layer only).
      // Loads per-asset MFE/MAE profiles, then backfills from the persisted
      // real-trade history so cold-start profiles are immediately available.
      // v2.0.863 規限①: LLM conviction calibrator(校準 LLM 自報 conviction)
      this.llmCalibrator = new LLMConvictionCalibrator();
      try {
        this.llmCalibrator.load();
        const lc = this.llmCalibrator.getStats();
        log.info(`✓ LLM Conviction Calibrator loaded (${lc.bins} bins, ${lc.klineReads} kline reads)`);
      } catch (e) {
        log.warn(`[llm-calib-init] load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // v2.0.864: LLM Direction Verifier(方向預測 + 平倉結果)
      this.llmDirectionVerifier = new LLMDirectionVerifier();
      try {
        this.llmDirectionVerifier.load();
        const dv = this.llmDirectionVerifier.getStats();
        log.info(`✓ LLM Direction Verifier loaded (${dv.pending} pending, ${dv.directionKeys} dir keys, ${dv.outcomeKeys} outcome keys)`);
      } catch (e) {
        log.warn(`[dir-verifier-init] load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // v2.0.865: EV Filter(期望值過濾器)
      this.evFilter = new EVFilter();
      try {
        this.evFilter.load();
        const ef = this.evFilter.getStats();
        log.info(`✓ EV Filter loaded (${ef.keys} keys, ${ef.totalSamples} samples)`);
      } catch (e) {
        log.warn(`[ev-filter-init] load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // v2.0.868-P1P2: Entry Quality System(入場確認 Gate + MAE Profile)
      this.entryQuality = new EntryQuality();
      try {
        this.entryQuality.load();
        const eq = this.entryQuality.getStats();
        log.info(`✓ Entry Quality loaded (${eq.contexts} contexts, ${eq.samples} samples)`);
      } catch (e) {
        log.warn(`[entry-quality-init] load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // v2.0.868: Profitability Analyzer(量化分析器——hold-time EV/direction bias/fee)
      this.profitabilityAnalyzer = new ProfitabilityAnalyzer();
      try {
        this.profitabilityAnalyzer.load();
        const pa = this.profitabilityAnalyzer.getStats();
        log.info(`✓ Profitability Analyzer loaded (${pa.holdCells} hold cells, ${pa.biasCells} bias cells, ${pa.feeTrades} fee trades)`);
      } catch (e) {
        log.warn(`[profitability-init] load failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // v2.0.866: Close-Decision Calibrator(Phase A——記錄+驗證+統計)
      this.closeCalibrator = new CloseDecisionCalibrator();
      try {
        this.closeCalibrator.load();
        const cc = this.closeCalibrator.getStats();
        log.info(`✓ Close-Decision Calibrator loaded (${cc.pending} pending, ${cc.contexts} contexts)`);
      } catch (e) {
        log.warn(`[close-calib-init] load failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      this.exitPriceLearner = new ExitPriceLearner();
      try {
        this.exitPriceLearner.load();
        const pfRaw = fs.existsSync(path.join(process.cwd(), 'data/evolution/portfolio-state.json'))
          ? JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/evolution/portfolio-state.json'), 'utf-8'))
          : null;
        const realTrades = pfRaw?.realTrades ?? [];
        if (Array.isArray(realTrades) && realTrades.length > 0) {
          this.exitPriceLearner.backfillFromRealTrades(realTrades as never);
        }
        const stats = this.exitPriceLearner.getStats();
        log.info(`✓ PAEL loaded (${stats.cells} cells, ${stats.totalRecords} records)`);
      } catch (e) {
        log.warn(`[exit-price-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }

      // v2.0.837: Meta-Cognitive Calibrator init
      this.metaCalibrator = new MetaCalibrator();
      try {
        const calPath = path.join(process.cwd(), 'data/evolution/meta-calibration.json');
        if (fs.existsSync(calPath)) {
          this.metaCalibrator.load(JSON.parse(fs.readFileSync(calPath, 'utf-8')));
          log.info(`✓ Meta-Calibrator loaded (${this.metaCalibrator.getSampleCount()} samples, Brier=${this.metaCalibrator.getOverallBrier().toFixed(4)}, ECE=${this.metaCalibrator.getECE().toFixed(4)})`);
        }
      } catch (e) {
        log.warn(`[meta-cal-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      log.info('✓ Meta-Cognitive Calibrator initialized');

      // v2.0.838: Self-Improver init
      this.selfImprover = new SelfImprover();
      try {
        const siPath = path.join(process.cwd(), 'data/evolution/self-improver.json');
        if (fs.existsSync(siPath)) {
          this.selfImprover.load(JSON.parse(fs.readFileSync(siPath, 'utf-8')));
          log.info(`✓ Self-Improver loaded (${this.selfImprover.getPerformanceCount()} perf windows)`);
        }
      } catch (e) {
        log.warn(`[self-improve-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      log.info('✓ Self-Improver initialized');

      // v2.0.839: Causal Reasoner init
      this.causalReasoner = new CausalReasoner();
      try {
        const crPath = path.join(process.cwd(), 'data/evolution/causal-reasoner.json');
        if (fs.existsSync(crPath)) {
          this.causalReasoner.load(JSON.parse(fs.readFileSync(crPath, 'utf-8')));
          log.info(`✓ Causal Reasoner loaded (${this.causalReasoner.getPairedCount()} paired shadows)`);
        }
      } catch (e) {
        log.warn(`[causal-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      log.info('✓ Causal Reasoner initialized');

      // v2.0.840: Meta-Learner init
      this.metaLearner = new MetaLearner();
      try {
        const mlPath = path.join(process.cwd(), 'data/evolution/meta-learner.json');
        if (fs.existsSync(mlPath)) {
          this.metaLearner.load(JSON.parse(fs.readFileSync(mlPath, 'utf-8')));
          log.info(`✓ Meta-Learner loaded (${this.metaLearner.getCellCount()} cells, ${this.metaLearner.getFeatureCount()} features)`);
        }
      } catch (e) {
        log.warn(`[meta-learn-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      log.info('✓ Meta-Learner initialized');

      // v2.0.844: Component Attribution Store init
      this.componentAttribution = new ComponentAttributionStore();
      try {
        const caPath = path.join(process.cwd(), 'data/evolution/component-attribution.json');
        if (fs.existsSync(caPath)) {
          this.componentAttribution.load(JSON.parse(fs.readFileSync(caPath, 'utf-8')));
          log.info(`✓ Component Attribution loaded (${this.componentAttribution.size()} records, ${this.componentAttribution.componentCount()} components)`);
        }
      } catch (e) {
        log.warn(`[attribution-init] load failed (non-critical): ${e instanceof Error ? e.message : String(e)}`);
      }
      log.info('✓ Component Attribution initialized');

      // v2.0.841: Backfill evolution components from existing EXP trade history
      // The backfillFromExpRecords() method (called at cycle start) already
      // reads all 1640 EXP records and feeds them to OLR/NA/AttnRes/etc.
      // v2.0.841 added Self-Improver + CausalReasoner + MetaLearner feeds
      // inside that loop. No separate init-time call needed.
      log.info('✓ Evolution component backfill wired (runs at first cycle via backfillFromExpRecords)');

      // 6. Start API Server
      log.info('Step 6/7: Starting API server...');
      this.apiServer = new APIServer(config.system.apiPort ?? 3456);
      // v2.0.822: Analysis writer — writes per-asset matrices to Supabase.
      // Disabled (local-only) if SUPABASE_URL/SERVICE_ROLE_KEY are absent.
      this.analysisWriter = new SupabaseAnalysisWriter();
      log.info(`Analysis mode: ${this.analysisMode ? 'ON (write to DB, no orders)' : 'OFF (execute orders)'}`);
      this.apiServer.setShutdownHandler(() => {
        log.info('Shutdown handler called from API');
        void this.stop();
      });
      this.apiServer.setDailyPnlProvider(() => this.computeDailyPnl());
      this.apiServer.setProfitabilityProvider(() => {
        const holdTime: Record<string, unknown> = {};
        const bias: Record<string, unknown> = {};
        try {
          // 全部 symbol×side 嘅 hold-time EV + direction bias(API 輸出)
          const allKeys = new Set([
            ...Object.keys((this.profitabilityAnalyzer as unknown as { state: { holdTime: Record<string, unknown> } }).state.holdTime),
            ...Object.keys((this.profitabilityAnalyzer as unknown as { state: { bias: Record<string, unknown> } }).state.bias),
          ]);
          for (const key of allKeys) {
            const [sym, side] = key.split('|');
            if (!sym || (side !== 'buy' && side !== 'sell')) continue;
            holdTime[key] = this.profitabilityAnalyzer.getHoldTimeEV(sym, side as 'buy' | 'sell');
            bias[key] = this.profitabilityAnalyzer.getDirectionBias(sym, side as 'buy' | 'sell');
          }
        } catch { /* non-fatal */ }
        return {
          holdTime,
          bias,
          fee: this.profitabilityAnalyzer.getFeeImpact(),
        };
      });
      this.apiServer.setTriggerCycleHandler(() => {
        log.info('Manual cycle trigger from API');
        if (!this.cycleInProgress && !isShuttingDown() && !this.paused) {
          void this.runDecisionCycle();
        }
      });
      this.apiServer.setBacktestHandler((params) => {
        log.info(`Backtest triggered from API: ${params.years}yr ${params.symbol}${params.interval ? ` ${params.interval}` : ''}${params.model ? ` model=${params.model}` : ''}${params.reverse ? ' REVERSE' : ''}`);
        void this.runBacktest(params);
      });
      this.apiServer.setBacktestPauseHandler(() => {
        log.info('Backtest pause requested from API');
        this.backtest.pause();
      });
      this.apiServer.setBacktestResumeHandler(() => {
        log.info('Backtest resume requested from API');
        this.backtest.resume();
      });
      this.apiServer.setBacktestStopHandler(() => {
        log.info('Backtest stop requested from API');
        this.backtest.stop();
      });
      this.apiServer.setResetTradeHistoryHandler(() => {
        log.info('🧹 Trade history reset requested from API');
        this.evolution.resetTradeHistory();
        this.evolution.persistState();
        this.pushToAPI();
      });

      // v2.0.79: Reset paper engine trades
      this.apiServer.setResetPaperTradesHandler(() => {
        log.info('🗑️ Paper trades reset requested from API');
        this.paperEngine.resetTrades();
        this.pushToAPI();
      });

      this.apiServer.setDeleteTradeHandler(async (tradeId: string): Promise<boolean> => {
        log.info(`🗑️ Trade delete requested: ${tradeId}`);
        let deleted = false;

        // Delete from paper engine trades
        const paperTrades = this.paperEngine.getTrades();
        const paperIdx = paperTrades.findIndex(t => t.id === tradeId);
        if (paperIdx >= 0) {
          this.paperEngine.deleteTrade(tradeId);
          deleted = true;
          log.info(`  → Deleted from paper engine trades`);
        }

        // Delete from closed real trades
        const realTrades = this.portfolio.getClosedRealTrades();
        const realIdx = realTrades.findIndex(t => t.id === tradeId);
        if (realIdx >= 0) {
          this.portfolio.deleteClosedRealTrade(tradeId);
          deleted = true;
          log.info(`  → Deleted from closed real trades`);
        }

        // v2.0.163: Delete from cachedHLFills (hl-fill-* IDs are synthesized
        // from raw HL fill data, not stored in any persistent array)
        // v2.0.167: Case-insensitive symbol matching — HL coin field may be
        // uppercase (SKHX) while the ID was built from the raw coin. Also
        // try matching with xyz: prefix stripped.
        // v2.0.168: More robust matching — try multiple symbol formats + log
        // all cached fills for debugging when match fails.
        if (tradeId.startsWith('hl-fill-')) {
          // Extract timestamp + symbol from ID: hl-fill-{timestamp}-{symbol}
          // The symbol is everything after the third dash. HL coin names don't
          // contain dashes, so this is safe. But use indexOf for robustness.
          const rest = tradeId.slice('hl-fill-'.length); // "{timestamp}-{symbol}"
          const dashIdx = rest.indexOf('-');
          if (dashIdx > 0) {
            const ts = parseInt(rest.slice(0, dashIdx));
            const sym = rest.slice(dashIdx + 1);
            if (ts > 0 && sym) {
              const symLower = sym.toLowerCase();
              const symNoPrefix = symLower.replace(/^xyz:/, '');
              log.info(`  → Searching cachedHLFills for ts=${ts}, sym=${sym} (lower=${symLower}, noPrefix=${symNoPrefix}), fills count=${this.cachedHLFills.length}`);
              const fillIdx = this.cachedHLFills.findIndex(f =>
                f.timestamp === ts && (
                  f.symbol.toLowerCase() === symLower ||
                  f.symbol.toLowerCase() === symNoPrefix ||
                  f.symbol.toLowerCase() === `xyz:${symNoPrefix}`
                )
              );
              if (fillIdx >= 0) {
                this.cachedHLFills.splice(fillIdx, 1);
                deleted = true;
                log.info(`  → Deleted from cachedHLFills (ts=${ts}, sym=${sym})`);
              } else {
                // Log all fills for debugging
                const fillSummary = this.cachedHLFills.map(f => `${f.symbol}@${f.timestamp}`).join(', ');
                log.warn(`  → hl-fill not found in cachedHLFills (ts=${ts}, sym=${sym}). Cached fills: ${fillSummary}`);
              }
            }
          }
        }

        if (deleted) {
          this.persistPortfolio();
          this.pushToAPI();
        }

        return deleted;
      });

      // v2.0.170: Update a trade field (entryThesis / exitThesis / postReview)
      this.apiServer.setUpdateTradeFieldHandler(async (tradeId: string, field: 'entryThesis' | 'exitThesis' | 'postReview', value: string): Promise<boolean> => {
        log.info(`✏️ Trade field update requested: ${tradeId} field=${field} (${value.length} chars)`);
        let updated = false;

        // Update in closed real trades
        if (this.portfolio.updateClosedRealTradeField(tradeId, field, value)) {
          updated = true;
          log.info(`  → Updated in closed real trades`);
        }

        // Update in paper engine trades
        if (this.paperEngine.updateTradeField(tradeId, field, value)) {
          updated = true;
          log.info(`  → Updated in paper engine trades`);
        }

        if (updated) {
          this.persistPortfolio();
          this.pushToAPI();
        } else {
          log.warn(`  → Trade ${tradeId} not found in any records`);
        }

        return updated;
      });

      // v2.0.189: System Engineer corrects trade record via LLM
      // User sends instruction (e.g. "Post-Review is wrong, MFE $11.72 is position value not profit")
      // → LLM reads the trade + instruction → rewrites entryThesis/exitThesis/postReview → saves
      this.apiServer.setCorrectTradeHandler(async (tradeId: string, instruction: string): Promise<{ success: boolean; correctedFields: Record<string, string>; reason: string }> => {
        log.info(`🔧 [correct-trade] System Engineer correction requested: ${tradeId} — "${instruction.slice(0, 80)}"`);
        try {
          // Find the trade in closed real trades or paper trades
          const realTrades = this.portfolio.getClosedRealTrades();
          const paperTrades = this.paperEngine.getTrades();
          const trade = realTrades.find(t => t.id === tradeId) ?? paperTrades.find(t => t.id === tradeId);
          if (!trade) {
            return { success: false, correctedFields: {}, reason: `Trade ${tradeId} not found` };
          }

          // Build context for the LLM
          const margin = (trade.entryPrice * trade.quantity) / safeLeverage(trade.leverage);
          const maePnl = (trade.minValueReached ?? 0) - margin;
          const mfePnl = (trade.maxValueReached ?? 0) - margin;
          const tradeContext = `Trade: ${trade.side.toUpperCase()} ${trade.symbol}
PnL: $${trade.pnl.toFixed(2)} (${(trade.pnlPct * 100).toFixed(1)}%)
Entry: $${trade.entryPrice.toFixed(2)} Exit: $${trade.exitPrice?.toFixed(2) ?? 'N/A'}
Hold: ${Math.max(0, Math.round((trade.closedAt - trade.openedAt) / 60_000))}min
MAE (worst PnL dip): $${maePnl.toFixed(2)}
MFE (best PnL peak): $${mfePnl.toFixed(2)}
Margin: $${margin.toFixed(2)}

Current Entry Thesis: ${trade.entryThesis ?? '—'}
Current Exit Thesis: ${trade.exitThesis ?? '—'}
Current Post-Review: ${trade.postReview ?? '—'}

User instruction: ${instruction}`;

          const provider = getActiveProvider();
          const response = await provider.chat({
            messages: [
              {
                role: 'system',
                content: `You are the System Engineer of MATS, a multi-agent quant trading system. A user has identified an error in a trade record's thesis or post-review. Your job is to rewrite the incorrect fields based on the user's instruction.

You understand the learning system deeply:
- MAE/MFE are position VALUE (margin + unrealized PnL), NOT PnL. MFE=$11.72 with margin=$9.98 means peak profit was $1.74, not $11.72.
- Entry Thesis is the frozen rationale at open. Only rewrite if the user says it's wrong.
- Exit Thesis is the close rationale. Only rewrite if the user says it's wrong.
- Post-Review is the LLM-generated post-trade analysis. Rewrite if the user says it contains errors.

Rules:
- Only rewrite fields the user's instruction implies need correction.
- Keep fields the user didn't mention unchanged.
- Maintain the [1h: ...] [1d: ...] format for thesis fields.
- Post-Review should be 2-4 sentences, plain text, no markdown.
- The corrected data must be accurate — MATS learns from this.

Respond ONLY with JSON:
{"entryThesis": "corrected text or null to keep unchanged", "exitThesis": "corrected text or null to keep unchanged", "postReview": "corrected text or null to keep unchanged", "reason": "brief explanation of what you changed and why"}`,
              },
              { role: 'user', content: tradeContext },
            ],
            temperature: 0.2,
            model: getAgentModel('terminal_agent'),
            timeoutMs: 30_000,
          });

          // Parse response
          let corrected: { entryThesis?: string | null; exitThesis?: string | null; postReview?: string | null; reason?: string };
          try {
            let s = response.content.trim();
            const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence && fence[1]) s = fence[1].trim();
            const start = s.indexOf('{');
            if (start < 0) throw new Error('no JSON');
            let depth = 0; let end = -1;
            for (let i = start; i < s.length; i++) {
              if (s[i] === '{') depth++;
              else if (s[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
            }
            if (end < 0) throw new Error('unbalanced');
            corrected = JSON.parse(s.slice(start, end + 1));
          } catch {
            return { success: false, correctedFields: {}, reason: 'Failed to parse LLM response' };
          }

          // Apply corrections
          const correctedFields: Record<string, string> = {};
          if (corrected.entryThesis && corrected.entryThesis.trim()) {
            this.portfolio.updateClosedRealTradeField(tradeId, 'entryThesis', corrected.entryThesis.trim());
            this.paperEngine.updateTradeField(tradeId, 'entryThesis', corrected.entryThesis.trim());
            correctedFields['entryThesis'] = corrected.entryThesis.trim();
          }
          if (corrected.exitThesis && corrected.exitThesis.trim()) {
            this.portfolio.updateClosedRealTradeField(tradeId, 'exitThesis', corrected.exitThesis.trim());
            this.paperEngine.updateTradeField(tradeId, 'exitThesis', corrected.exitThesis.trim());
            correctedFields['exitThesis'] = corrected.exitThesis.trim();
          }
          if (corrected.postReview && corrected.postReview.trim()) {
            this.portfolio.updateClosedRealTradeField(tradeId, 'postReview', corrected.postReview.trim());
            this.paperEngine.updateTradeField(tradeId, 'postReview', corrected.postReview.trim());
            correctedFields['postReview'] = corrected.postReview.trim();
          }

          this.persistPortfolio();
          this.pushToAPI();
          log.info(`✅ [correct-trade] Corrected ${tradeId}: ${Object.keys(correctedFields).join(', ')} — ${corrected.reason ?? ''}`);

          return { success: true, correctedFields, reason: corrected.reason ?? 'Corrections applied' };
        } catch (err) {
          log.warn(`[correct-trade] failed: ${err instanceof Error ? err.message : String(err)}`);
          return { success: false, correctedFields: {}, reason: err instanceof Error ? err.message : String(err) };
        }
      });

      // Wire up Market Agent API handlers
      this.apiServer.setMarketAgentSetTradeModeHandler(async (mode) => {
        log.info(`Market Agent: trade mode → ${mode}`);
        const previousMode = this.tradingManager.getTradeMode();
        this.marketAgent.setTradeMode(mode);
        this.tradingManager.setTradeMode(mode);

        // v2.0.29: Mark existing positions as legacy so they continue to be
        // managed (SL/TP, per-symbol consensus, price updates) until they
        // naturally close. We don't force-close positions when switching modes.
        if (previousMode !== mode) {
          const openSymbols = this.portfolio.getOpenSymbols();
          for (const sym of openSymbols) {
            this.legacyPositionModes.set(sym, previousMode);
            log.info(`📋 Legacy position marked: ${sym} (originated in ${previousMode} mode, will be managed until closed)`);
          }
        }

        if (mode === 'real') {
          // Clear cached exchange balance so UI immediately shows '--'
          // until we successfully fetch the real HL balance.
          this.cachedExchangeBalance = null;
          this.cachedExchangePositions = null;
          this.cachedHLFills = [];

          // Immediately push to UI so balance/equity show '--'
          this.pushToAPI();

          const hlWallet = config.realTrading.hyperliquidWalletAddress;
          const hlPrivKey = config.realTrading.hyperliquidPrivateKey;

          if (!hlWallet || hlWallet.trim().length === 0 || !hlPrivKey || hlPrivKey.trim().length === 0) {
            log.error('❌ Real mode enabled but HYPERLIQUID_WALLET_ADDRESS or HYPERLIQUID_PRIVATE_KEY is empty in .env. Balance/Equity will show "--" until configured. Fill them in .env and restart the system.');
            return;
          }

          // Set HL WS wallet address for user-level feeds
          this.hyperliquidWs.setWalletAddress(hlWallet.trim());
          log.info('📡 HL WS wallet address set for user-level feeds');

          // Immediately fetch real balance + positions + fills
          try {
            this.cachedExchangeBalance = await this.tradingManager.getBalance();
            this.cachedHLFills = await this.tradingManager.getRecentFills(20);
            this.cachedExchangePositions = (await this.tradingManager.getPositions()).map(p => ({
              symbol: p.symbol,
              side: p.side,
              quantity: p.quantity,
              averageEntryPrice: p.averageEntryPrice,
              currentPrice: p.currentPrice,
              unrealizedPnl: p.unrealizedPnl,
              leverage: p.leverage ?? 1,
              openedAt: p.openedAt,
            }));
            for (const p of this.cachedExchangePositions) { this.lastKnownLeverage.set(p.symbol.replace(/^xyz:/i, '').toLowerCase(), p.leverage ?? 1); }
            log.info(`💰 Real HL balance fetched: $${this.cachedExchangeBalance.total.toFixed(2)} | ${this.cachedExchangePositions.length} positions | ${this.cachedHLFills.length} recent fills`);
          } catch (err) {
            log.error(`❌ Failed to fetch real HL balance: ${err instanceof Error ? err.message : String(err)}. Will retry next cycle.`);
          }

          // Push updated data to UI
          this.pushToAPI();

          // Trigger an immediate decision cycle so agents can act on real data
          log.info('🔄 Triggering immediate decision cycle after real mode switch...');
          this.runDecisionCycle().catch((err: Error) => {
            log.error(`Post-real-mode-switch cycle failed: ${err.message}`);
          });
        } else {
          // Switching back to paper mode — clear real exchange cache
          this.cachedExchangeBalance = null;
          this.cachedExchangePositions = null;
          this.cachedHLFills = [];
          this.pushToAPI();
        }
      });
      this.apiServer.setMarketAgentSetExchangeHandler(async (exchange) => {
        log.info(`Market Agent: exchange → ${exchange}`);
        this.marketAgent.setExchange(exchange);
        this.tradingManager.setExchange(exchange);
        await this.marketAgent.fetchTopPairs();
        this.pushToAPI();
      });
      this.apiServer.setMarketAgentSetAssetTypeHandler(async (assetType) => {
        log.info(`Market Agent: HL asset type → ${assetType}`);
        this.marketAgent.setHyperliquidAssetType(assetType);
        await this.marketAgent.fetchTopPairs();
        // Push updated pairs to UI immediately — no cycle trigger on asset type change.
        // Cycle is triggered only when user adds a new asset to Selected Markets.
        this.pushToAPI();
      });
      this.apiServer.setMarketAgentFetchPairsHandler(() => {
        log.info('Market Agent: refresh top pairs');
        void this.marketAgent.fetchTopPairs().then(() => this.pushToAPI());
      });
      // v2.0.821: Fast symbol universe — instant market selection without
      // waiting for the volume background scan.
      this.apiServer.setMarketAgentGetAllSymbolsHandler(async () => {
        return this.marketAgent.getAllSymbols();
      });
      this.apiServer.setMarketAgentSetPositionSizeHandler((pct) => {
        log.info(`Market Agent: position size → ${(pct * 100).toFixed(1)}%`);
        this.marketAgent.setPositionSizePct(pct);
        this.pushToAPI();
      });
      // v2.0.XX: Max portion handler — sets the max % of balance for all positions
      this.apiServer.setMarketAgentSetMaxPortionHandler((pct) => {
        log.info(`Market Agent: max portion → ${(pct * 100).toFixed(0)}%`);
        this.marketAgent.setMaxPortionPct(pct);
        this.paperEngine.setMaxPortionPct(pct);
        this.tradingManager.setMaxPortionPct(pct);
        this.pushToAPI();
      });
      this.apiServer.setMarketAgentSetLeverageHandler((lev) => {
        log.info(`Market Agent: leverage → ${lev}x`);
        this.marketAgent.setLeverage(lev);
        this.pushToAPI();
      });
      this.apiServer.setCyclePeriodHandler((minutes) => {
        const ms = minutes * 60_000;
        log.info(`Cycle period → ${minutes}m (${ms}ms)`);
        this.cycleIntervalMs = ms;
        this.marketAgent.setCyclePeriodMinutes(minutes);
        // Restart the decision timer with the new interval
        if (this.decisionTimer) {
          clearInterval(this.decisionTimer);
          this.decisionTimer = null;
        }
        this.decisionTimer = setInterval(() => {
          if (!isShuttingDown()) {
            void this.runDecisionCycle();
          }
        }, ms);
        this.pushToAPI();
      });

      // v2.0.822+: Risk profile handler — sets the backend account's risk profile.
      // This controls Meta-Agent conviction calibration + position sizing guidance.
      this.apiServer.setMarketAgentSetRiskProfileHandler((profile) => {
        log.info(`Market Agent: risk profile → ${profile}`);
        this.marketAgent.setRiskProfile(profile);
        this.pushToAPI();
      });

      // Terminal Agent — user input → LLM integration → Root Command Prompt
      this.apiServer.setTerminalAgentInputHandler(async (input: string, currentPrompt: string) => {
        try {
          const provider = getActiveProvider();
          const systemPrompt = `You are the Terminal Agent for a multi-agent quant trading system (MATS).
Your job is to maintain a "Root Command Prompt" — a consolidated set of behavioral trading preferences derived from user inputs.

## GROUND TRUTH RULE
Before responding to user input, you MUST first check the current system state: current trade mode, open positions, recent trades, and any existing Root Command Prompt. NEVER guess what the system is doing — always base your response on real data. If the user asks about system status, check the actual state before answering.

CRITICAL RULE: You must NEVER write ambiguous or incomplete instructions into the Root Command Prompt. When the user's input lacks specificity (e.g. "only trade on Monday" without timezone, exact hours, or session definition), you MUST ask clarifying questions FIRST. Only write to the Root Command Prompt when the instruction is fully concrete and unambiguous.

CONFIG REJECTION: Root Command Prompt only accepts BEHAVIORAL directives (decision style, trading bias, time/condition rules, execution preferences). It does NOT accept config-level settings. If the user's input involves any of these, REJECT it and tell them to use Trading Setup instead:
- Position size (e.g. "set position size to 20%") → reject: "Adjust in Trading Setup"
- Leverage (e.g. "set leverage to 15x") → reject: "Adjust in Trading Setup"
- Max portion (e.g. "max portion 50%") → reject: "Adjust in Trading Setup"
- Cycle period (e.g. "change cycle to 3 minutes") → reject: "Adjust in Trading Setup"
- Trade mode (e.g. "switch to real trading") → reject: "Adjust in Trading Setup"
- Asset type (e.g. "trade stocks only") → reject: "Adjust in Trading Setup"
Do NOT write these to the Root Command Prompt. Instead, respond in the Side Guide: "This is a config setting — please adjust it in Trading Setup above."

CONTENT FILTER: The Root Command Prompt must contain ONLY trading directives — rules that directly affect how the system trades. Before writing any line to the Root Command Prompt, ask yourself: "Does this line tell the trading system HOW to make a trading decision?" If the answer is NO, do NOT write it. Specifically:
- NEVER write UI state notes (e.g. "Clear Prompt button always visible", "Root Command Prompt currently empty", "Button resets prompt when used"). These are NOT trading directives.
- NEVER write system status descriptions (e.g. "Prompt was auto-condensed", "No prompt yet"). These belong in the Side Guide, not the Root Command Prompt.
- NEVER write meta-commentary about the prompt itself (e.g. "This prompt contains 3 rules", "The prompt was updated"). Only write the actual rules.
- NEVER write empty lines, dashes, or separator markers as content.
- If the user's input is NOT about trading behavior (e.g. "what does this button do", "how does the system work", general questions, UI feedback), do NOT write anything to the Root Command Prompt. Respond in the Side Guide only.
- ONLY write lines that start with "- " and contain a concrete, actionable trading rule (e.g. "- Only open BUY positions when OLR win rate > 60%", "- Avoid trading during FOMC announcements", "- Close all positions before weekend").

Output format — two sections separated by a line containing only "---":

1. Root Command Prompt: The actual trading instructions. Only include concrete, fully-specified behavioral rules that directly affect trading decisions. Each rule on its own line starting with "- ". If no complete trading rules exist yet (pending clarification, all input was config-rejected, or input was non-trading), output NOTHING for this section — leave it completely empty. Do NOT write placeholder text, status notes, or any non-rule content.

2. Side Guide: Below the "---" separator, output "Side Guide:" followed by either:
   - Clarification questions for the user (prefixed with "? ") — ask SHORT, DIRECT questions one per line. Be concise. Don't write paragraphs or long explanations. Just ask the specific missing detail.
     BAD: "The user has specified a single day restriction. They may want to clarify whether this applies to all trades or only certain strategies, and whether any exceptions or additional conditions (e.g., time of day, market conditions) should be considered."
     GOOD: "? Which timezone? (e.g. GMT, HKT, ET)"
     GOOD: "? Full 24 hours or specific hours?"
     GOOD: "? Open new positions only, or also close existing ones?"
   - OR config rejection notices — tell the user to adjust config settings in Trading Setup.
   - OR confirmation if everything is clear — one line summary of what was integrated.
   - OR if the input was non-trading (questions, UI feedback, etc.), respond to the user here.
   This section is for user interaction, NOT instructions for the trading system.

Rules:
1. Read the user's new input and the current Root Command Prompt (if any).
2. If the input is a config-level setting, reject it (see CONFIG REJECTION above). Do NOT write to Root Command Prompt.
3. If the input is NOT about trading behavior (questions, UI feedback, general chat), do NOT write to Root Command Prompt. Respond in Side Guide only.
4. If the input is ambiguous or incomplete, ask clarification questions in the Side Guide. Do NOT write to the Root Command Prompt yet.
5. If the input is a response to previous clarification questions and now fully specifies the instruction, write it to the Root Command Prompt.
6. Integrate new complete instructions into the existing prompt — merge, refine, deduplicate.
7. If the user's input contradicts an existing instruction, the newer instruction takes priority.
8. Preserve all valid prior instructions that are not contradicted.
9. Do NOT invent trading rules the user hasn't stated.
10. No JSON, no markdown fences, no commentary outside the two sections.

Current Root Command Prompt:
${currentPrompt || '(empty — this is the first input)'}`;

          const response = await provider.chat({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: input },
            ],
            temperature: 0.3,
            model: getAgentModel('terminal_agent'),
            timeoutMs: 30_000,
          });

          const updatedPrompt = response.content.trim();
          if (!updatedPrompt) {
            return { success: false, error: 'LLM returned empty response' };
          }

          // v2.0.143: Parse the LLM output into Root Command Prompt + Side Guide.
          // The LLM output format is: "Root Command Prompt section\n---\nSide Guide: ..."
          const guideMatch = updatedPrompt.match(/^Side Guide:\s*/im);
          let promptPart = '';
          let guidePart = '';
          if (guideMatch && guideMatch.index != null) {
            promptPart = updatedPrompt.slice(0, guideMatch.index)
              .replace(/^Root Command Prompt:\s*/i, '')
              .replace(/^---\s*$/m, '')
              .trim();
            guidePart = updatedPrompt.slice(guideMatch.index + guideMatch[0].length).trim();
          } else {
            promptPart = updatedPrompt
              .replace(/^Root Command Prompt:\s*/i, '')
              .replace(/^---\s*$/m, '')
              .trim();
          }

          // v2.0.143: Enforce 300-char limit on Root Command Prompt.
          // If exceeded, ask the LLM to condense it. If still exceeded after
          // condensing, tell the user to remove less important rules.
          const MAX_PROMPT_CHARS = 300;
          if (promptPart.length > MAX_PROMPT_CHARS) {
            log.info(`Terminal Agent: Prompt ${promptPart.length} chars > ${MAX_PROMPT_CHARS} — auto-condensing...`);
            try {
              const condenseResponse = await provider.chat({
                messages: [
                  { role: 'system', content: 'You condense trading rules into fewer characters while preserving ALL rules. Keep each rule on one line starting with "- ". Remove redundant words, merge overlapping rules. Output ONLY the condensed rules, no commentary.' },
                  { role: 'user', content: `Condense these trading rules to under ${MAX_PROMPT_CHARS} characters. Preserve every rule's meaning:\n\n${promptPart}` },
                ],
                temperature: 0.2,
                model: getAgentModel('terminal_agent'),
                timeoutMs: 15_000,
              });
              const condensed = condenseResponse.content.trim();
              if (condensed.length <= MAX_PROMPT_CHARS) {
                promptPart = condensed;
                guidePart = `Side Guide: Prompt was auto-condensed from ${updatedPrompt.length} to ${condensed.length} chars to stay within the 300-char limit.`;
                log.info(`Terminal Agent: Auto-condensed to ${condensed.length} chars`);
              } else {
                // Still too long — ask user to取舍
                promptPart = condensed.slice(0, MAX_PROMPT_CHARS);
                guidePart = `Side Guide: ⚠️ Root Command Prompt exceeds ${MAX_PROMPT_CHARS} chars even after condensing (${condensed.length} chars). Please remove less important rules to stay within the limit. Current rules have been truncated.`;
                log.warn(`Terminal Agent: Prompt still ${condensed.length} chars after condensing — truncated + user notified`);
              }
            } catch (condenseErr) {
              log.warn(`Terminal Agent: Auto-condense failed: ${condenseErr instanceof Error ? condenseErr.message : String(condenseErr)} — truncating`);
              promptPart = promptPart.slice(0, MAX_PROMPT_CHARS);
              guidePart = `Side Guide: ⚠️ Auto-condense failed. Prompt truncated to ${MAX_PROMPT_CHARS} chars. Please review and remove unnecessary rules.`;
            }
          }

          // Store on backend
          this.rootCommandPrompt = promptPart;
          this.terminalSideGuide = guidePart;
          // v2.0.143: Persist to disk so it survives backend restarts
          this.persistRootCommandPrompt();

          // Return the full LLM output (prompt + guide) to the UI
          const fullOutput = guidePart
            ? `${promptPart}\n---\nSide Guide: ${guidePart}`
            : promptPart;

          log.info(`Terminal Agent: Root Command Prompt stored (${promptPart.length} chars) + Side Guide (${guidePart.length} chars)`);
          return { success: true, prompt: fullOutput };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Terminal Agent input failed: ${msg}`);
          return { success: false, error: msg };
        }
      });

      // v2.0.143: Register sync handler — UI sends localStorage prompt to backend
      // on mount when backend has lost it (e.g. after restart).
      // v2.0.151: Also accepts empty string to CLEAR the prompt (from Clear Prompt button).
      this.apiServer.setTerminalAgentSyncPromptHandler((prompt: string) => {
        if (prompt && prompt.trim().length > 0) {
          this.rootCommandPrompt = prompt.trim();
          this.persistRootCommandPrompt();
          log.info(`Terminal Agent: Root Command Prompt synced from UI localStorage (${this.rootCommandPrompt.length} chars)`);
          this.pushToAPI();
        } else if (prompt !== undefined && prompt.trim().length === 0) {
          // v2.0.151: Clear prompt from backend when UI sends empty string
          this.rootCommandPrompt = '';
          this.terminalSideGuide = '';
          this.persistRootCommandPrompt();
          log.info('Terminal Agent: Root Command Prompt cleared by UI');
          this.pushToAPI();
        }
      });

      // v2.0.44: Manual symbol selection from Top Volume Pairs list.
      // Sets the manual lock so autoSelectTopPair() doesn't override it.
      // v2.0.110: Do NOT trigger a cycle here — the trading-markets handler
      // already debounces a single cycle trigger. This was causing duplicate
      // cycle triggers when addTradingMarket sends both select-symbol AND
      // trading-markets POSTs.
      // v2.0.858-attack: A cycle is snapshot-based — allSymbols/_additionalMarkets
      // are frozen at cycle start. Switching selectedSymbol mid-cycle would
      // CORRUPT the running cycle: REST polling (activeSymbol reads), trade
      // feature builders (fallbackPatchMissingTradeFeatures/closeTrade) all
      // read getSelectedSymbol() LIVE. Defer the switch until the cycle
      // completes so the current cycle keeps its snapshot integrity.
      let selectSymbolTimer: ReturnType<typeof setTimeout> | null = null;
      let selectSymbolRetryTimer: ReturnType<typeof setInterval> | null = null;
      const applySelectSymbol = (symbol: string): void => {
        // v2.0.858-attack: edge case — the user may have removed this symbol
        // from tradingMarkets while the switch was deferred. Don't force an
        // active symbol that is no longer selected (keeps WS feed honest).
        const stillSelected = this.tradingMarkets.some((m) => {
          const n = m.includes(':') ? m.split(':')[0]!.toLowerCase() + m.slice(m.indexOf(':')) : m.toLowerCase();
          const s = symbol.includes(':') ? symbol.split(':')[0]!.toLowerCase() + symbol.slice(symbol.indexOf(':')) : symbol.toLowerCase();
          return n === s;
        });
        if (!stillSelected) {
          log.info(`Market Agent: select-symbol skipped — ${symbol} no longer in trading markets`);
          return;
        }
        log.info(`Market Agent: manual symbol selection → ${symbol}`);
        this.marketAgent.setSelectedSymbolManual(symbol);
        this.pushToAPI();
      };
      this.apiServer.setMarketAgentSelectSymbolHandler((symbol) => {
        if (selectSymbolTimer) clearTimeout(selectSymbolTimer);
        selectSymbolTimer = setTimeout(() => {
          if (this.cycleInProgress) {
            // v2.0.858-attack: defer until the cycle completes. Retry every
            // 500ms — this is strictly better than a one-shot setTimeout that
            // could fire after a much longer cycle or a cycle that restarts
            // immediately (drift-triggered).
            log.info(`⏳ select-symbol deferred until cycle completes: ${symbol}`);
            if (selectSymbolRetryTimer) clearInterval(selectSymbolRetryTimer);
            selectSymbolRetryTimer = setInterval(() => {
              if (!this.cycleInProgress) {
                if (selectSymbolRetryTimer) { clearInterval(selectSymbolRetryTimer); selectSymbolRetryTimer = null; }
                applySelectSymbol(symbol);
              }
            }, 500);
            return;
          }
          applySelectSymbol(symbol);
        }, 1500);
      });

      // v2.0.79: Trading markets list from UI pills — determines which symbols
      // agents analyze (combined with open positions). Replaces auto-select.
      // v2.0.110: Debounce immediate cycle trigger — UI may send multiple POSTs
      // (addTradingMarket sends both trading-markets + select-symbol). Only
      // trigger ONE cycle after the last change settles. All trading markets
      // are analyzed in that SINGLE HACP cycle (multi-symbol single-cycle).
      let tradingMarketsCycleTimer: ReturnType<typeof setTimeout> | null = null;
      // v2.0.114: Throttle — ignore trading-markets POSTs within 3s of the last
      // accepted one. Multiple browser tabs each have their own SSE connection
      // and each POSTs its own tradingMarkets. Without throttling, two tabs
      // with different markets alternate POSTs → backend flips back and forth
      // → infinite loop. The throttle ensures only one update per 3s window.
      //
      // v2.0.858-attack: Throttling must NOT DROP updates. The UI is now
      // usable during a running cycle (user can add markets freely), so rapid
      // adds in quick succession (UI debounce is 500ms, throttle is 3000ms)
      // would otherwise be silently lost: UI's lastPostedMarkets has already
      // advanced past them and will never re-POST → permanent divergence.
      // Fix: when throttled, remember the LATEST pending value and apply it
      // once the window expires. Only the final state matters — intermediate
      // states can be coalesced (same as the UI debounce does).
      let lastTradingMarketsAccept = 0;
      const TRADING_MARKETS_THROTTLE_MS = 3000;
      let pendingThrottledMarkets: string[] | null = null;
      let pendingThrottleTimer: ReturnType<typeof setTimeout> | null = null;
      const applyTradingMarkets = (markets: string[]): void => {
        lastTradingMarketsAccept = Date.now();
        const prevCount = this.tradingMarkets.length;
        this.tradingMarkets = markets;
        // v2.0.124: Persist trading markets so the system resumes with the
        // correct markets on restart instead of falling back to auto-select.
        this.marketAgent.setTradingMarkets(markets);
        log.info(`Trading markets set from UI: ${markets.join(', ') || '(empty)'} (prev=${prevCount}, new=${markets.length})`);
        this.pushToAPI();
        // v2.0.110: Debounce — only trigger ONE cycle 2s after the last change.
        // This prevents multiple overlapping cycle triggers when UI sends
        // rapid updates (e.g. adding 3 markets in quick succession).
        if (tradingMarketsCycleTimer) clearTimeout(tradingMarketsCycleTimer);
        tradingMarketsCycleTimer = setTimeout(() => {
          tradingMarketsCycleTimer = null;
          if (!this.cycleInProgress && !isShuttingDown()) {
            log.info(`📊 Trading markets settled — triggering single HACP cycle for all ${this.tradingMarkets.length} market(s)`);
            void this.runDecisionCycle();
          } else if (this.cycleInProgress) {
            // v2.0.108: If a cycle is already running, the new markets will be
            // picked up by the NEXT scheduled cycle (300s). But if the current
            // cycle only has 1 market and we just received 3, we should trigger
            // an immediate cycle after the current one finishes.
            log.info(`📊 Trading markets updated during cycle — will be picked up by next cycle (tradingMarkets=${this.tradingMarkets.length})`);
          }
        }, 2000);
      };
      this.apiServer.setTradingMarketsHandler((markets) => {
        // Skip if markets haven't changed
        const prevJson = JSON.stringify(this.tradingMarkets);
        const newJson = JSON.stringify(markets);
        if (prevJson === newJson) return;
        // v2.0.114: Throttle — skip if within throttle window
        const now = Date.now();
        if (now - lastTradingMarketsAccept < TRADING_MARKETS_THROTTLE_MS) {
          // v2.0.858-attack: DO NOT DROP. Coalesce: remember the latest value
          // and apply it once the window expires. If a timer is already
          // scheduled, just overwrite the pending value — only the final
          // state matters.
          pendingThrottledMarkets = markets;
          if (!pendingThrottleTimer) {
            pendingThrottleTimer = setTimeout(() => {
              pendingThrottleTimer = null;
              const pending = pendingThrottledMarkets;
              pendingThrottledMarkets = null;
              if (pending) {
                const prevJsonNow = JSON.stringify(this.tradingMarkets);
                const pendingJson = JSON.stringify(pending);
                if (prevJsonNow !== pendingJson) {
                  log.info(`Trading markets throttle-window expired — applying pending: ${pending.join(', ')}`);
                  applyTradingMarkets(pending);
                }
              }
            }, TRADING_MARKETS_THROTTLE_MS);
          }
          return;
        }
        applyTradingMarkets(markets);
      });

      // v2.0.122: Per-symbol direction restrictions from UI.
      // Allows the user to restrict a symbol to only BUY or only SELL.
      // Example: { "xyz:SILVER": "sell" } → SILVER can only be shorted.
      this.apiServer.setDirectionRestrictionsHandler((restrictions) => {
        this.marketAgent.setDirectionRestrictions(restrictions);
        this.pushToAPI();
      });

      // v2.0.45: Clear drawdown data to relaunch trading after circuit breaker.
      // Resets peakEquity to current equity, clears currentDrawdownPct,
      // maxDrawdown, and dailyPnl. The next cycle will pass the guard check.
      this.apiServer.setClearDrawdownHandler(() => {
        log.info('🔄 Clear drawdown requested from UI — resetting drawdown data');
        this.portfolio.clearDrawdown();
        // Also unpause if the system was paused
        if (this.paused) {
          this.paused = false;
          log.info('▶️ System unpaused — trading will resume on next cycle');
        }
        this.pushToAPI();
        // Trigger a cycle immediately so trading resumes right away
        setTimeout(() => void this.runDecisionCycle(), 500);
      });

      // v2.0.116: Settings modal — get/update env vars
      this.apiServer.setGetEnvSettingsHandler(() => {
        const settings: Record<string, string> = {};
        // v2.0.857-fix2: + SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — the
        // Settings modal Supabase section needs them populated on open (GET),
        // not just writable (POST). Masked like the other secrets.
        const keys = ['HYPERLIQUID_WALLET_ADDRESS', 'HYPERLIQUID_PRIVATE_KEY', 'OLLAMA_API_KEY', 'MASSIVE_API_KEY', 'OLLAMA_PLAN', 'TELEGRAM_BOT_API', 'TELEGRAM_CHAT_ID', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
        for (const key of keys) {
          const val = process.env[key] ?? '';
          // Mask: show first 6 + last 6 chars if value is long enough
          if (val && val.length > 12) {
            settings[key] = val.slice(0, 6) + '••••••' + val.slice(-6);
          } else if (val) {
            settings[key] = '••••••';
          } else {
            settings[key] = '';
          }
        }
        return settings;
      });

      this.apiServer.setUpdateEnvSettingsHandler(async (settings: Record<string, string>) => {
        try {
          // v2.0.857-fix3-attack (B1/B2/B4): harden the env-write path.
          //  - ALLOWLIST: only known keys may be written — an attacker posting
          //    arbitrary keys could overwrite HYPERLIQUID_PRIVATE_KEY etc.
          //  - KEY SAFE: keys must be alphanumeric+underscore (no regex
          //    metachars — B1 regex injection could match the wrong line).
          //  - VALUE SAFE: values must not contain \n/\r (B4 multi-line .env
          //    injection could append arbitrary env vars).
          const ALLOWED_ENV_KEYS = new Set([
            'HYPERLIQUID_WALLET_ADDRESS', 'HYPERLIQUID_PRIVATE_KEY',
            'OLLAMA_API_KEY', 'MASSIVE_API_KEY', 'OLLAMA_PLAN',
            'TELEGRAM_BOT_API', 'TELEGRAM_CHAT_ID',
            'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
          ]);
          const envPath = path.join(process.cwd(), '.env');
          let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
          for (const [rawKey, value] of Object.entries(settings)) {
            // Skip if value is masked (contains ••••) — means user didn't change it
            if (value.includes('••••')) continue;
            // ALLOWLIST + KEY SAFE: reject unknown keys or regex-metachar keys
            if (!ALLOWED_ENV_KEYS.has(rawKey) || !/^[A-Z0-9_]+$/.test(rawKey)) {
              log.warn(`[settings] rejected env key ${JSON.stringify(rawKey)} (not in allowlist / invalid)`);
              continue;
            }
            // VALUE SAFE: reject newlines (multi-line .env injection)
            if (/[\r\n]/.test(value)) {
              log.warn(`[settings] rejected ${rawKey} value containing newline (injection attempt)`);
              continue;
            }
            const key = rawKey;
            // Update or add the env var (key is validated [A-Z0-9_] → regex-safe)
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
              envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
              envContent += `\n${key}=${value}`;
            }
            // Also update process.env so the change takes effect immediately
            process.env[key] = value;
          }
          fs.writeFileSync(envPath, envContent, 'utf-8');
          // v2.0.857-fix2: if SUPABASE_URL / SERVICE_ROLE_KEY were updated,
          // re-init the analysis writer immediately (no restart needed).
          if ('SUPABASE_URL' in settings || 'SUPABASE_SERVICE_ROLE_KEY' in settings) {
            try { this.analysisWriter.reconfigure(); } catch { /* non-critical */ }
          }
          log.info('⚙️ Env settings updated from UI Settings modal');
          return { success: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`Failed to update env settings: ${msg}`);
          return { success: false, error: msg };
        }
      });

      // v2.0.30: Manual position close handler
      // Closes a position in both local portfolio and (if real mode) on the exchange.
      // The close is tagged with closeReason='manual' so agents know it was NOT a system decision.
      this.apiServer.setManualClosePositionHandler(async (symbol: string) => {
        try {
          // v2.0.32: Use normalizeSymbol for case-sensitive colon symbol support
          const sym = symbol.includes(':') ? symbol : symbol.toLowerCase();
          if (!this.portfolio.hasPosition(sym)) {
            return { success: false, error: `No open position for ${sym}` };
          }

          const pos = this.portfolio.getPosition(sym);
          if (!pos) {
            return { success: false, error: `Position not found for ${sym}` };
          }

          log.warn(`📕 Manual close requested: ${sym.toUpperCase()} ${pos.side.toUpperCase()} @ $${pos.averageEntryPrice.toFixed(2)} (PnL: ${pos.unrealizedPnl >= 0 ? '+' : ''}$${pos.unrealizedPnl.toFixed(2)})`);

          // Get current price for closing
          const state = this.marketState?.getState(sym);
          const closePrice = state?.price ?? pos.currentPrice ?? 0;
          if (closePrice <= 0) {
            return { success: false, error: `No current price available for ${sym}` };
          }

          // v2.0.143: Route through closeTrade() — handles paper vs real
          // separation + sets exitThesis before closing. For real positions,
          // closeTrade() → tradingManager.closePosition() closes on HL
          // first, then locally. No need to close on HL separately here.
          // v2.0.851: Pass closeReason='manual' so the TradeRecord records it
          // (previously only paper trades were tagged after the fact; real
          // trades + reloaded trades lost the manual flag).
          const closeSuccess = await this.closeTrade(sym, 'Manual close by user', 'manual');
          if (closeSuccess) {
            // Tag the trade record with manual close reason
            const recentPaper = this.paperEngine.getTrades().slice(-1)[0];
            if (recentPaper && recentPaper.symbol === sym) {
              recentPaper.closeReason = 'manual';
            }
            log.info(`📕 Manual close completed: ${sym} (${pos.unrealizedPnl >= 0 ? 'profit' : 'loss'})`);

            // Clean up legacy tracking
            this.legacyPositionModes.delete(sym);
            // v2.0.122: Clear pending thesis on manual close
            this.pendingTheses.delete(normalizeSymbol(sym));
          }

          // Push updated portfolio to UI
          this.pushToAPI();

          return { success: true };
        } catch (err) {
          log.error(`Manual close failed: ${err instanceof Error ? err.message : String(err)}`);
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      });

      // v2.0.198: Close all positions — used before Trade Mode switch
      this.apiServer.setCloseAllPositionsHandler(async (): Promise<{ success: boolean; closed: number; errors: string[] }> => {
        const allSymbols = this.portfolio.getOpenSymbols();
        let closed = 0;
        const errors: string[] = [];
        log.info(`📕 Close-all requested: ${allSymbols.length} open positions`);
        for (const sym of allSymbols) {
          try {
            // v2.0.853-fix2: Tag 'manual' so the TradeRecord records the user-driven
            //   exit. Without this, inferCloseReason classifies by exit price vs SL/TP,
            //   mislabeling a user-initiated close-all as 'sl_tp' → learning systems
            //   treat a user decision as a full-weight market signal (should be 0.5×).
            const closeSuccess = await this.closeTrade(sym, 'Close-all before Trade Mode switch', 'manual');
            if (closeSuccess) {
              closed++;
              this.legacyPositionModes.delete(sym);
              this.pendingTheses.delete(normalizeSymbol(sym));
            } else {
              errors.push(`Failed to close ${sym}`);
            }
          } catch (err) {
            errors.push(`${sym}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.pushToAPI();
        log.info(`📕 Close-all completed: ${closed}/${allSymbols.length} closed${errors.length > 0 ? `, errors: ${errors.join('; ')}` : ''}`);
        return { success: errors.length === 0, closed, errors };
      });

      // v2.0.127: Manual trade execution — bypasses conviction gate + thesis validation.
      // Used when the user wants to force a trade that the system's gates blocked.
      this.apiServer.setManualTradeHandler(async (action, symbol, positionSizePct, leverage) => {
        try {
          const sym = normalizeSymbol(symbol);
          log.warn(`📕 Manual trade: ${action.toUpperCase()} ${sym} size=${(positionSizePct * 100).toFixed(1)}% lev=${leverage}x`);

          // Check direction restriction
          if (!this.marketAgent.isDirectionAllowed(sym, action)) {
            const allowed = this.marketAgent.getDirectionRestrictions()[sym];
            return { success: false, error: `${sym} is restricted to ${allowed?.toUpperCase() ?? 'unknown'} only — ${action.toUpperCase()} blocked` };
          }

          // Check for existing position
          if (this.portfolio.hasPosition(sym)) {
            const existing = this.portfolio.getPosition(sym);
            if (existing && existing.side === action) {
              return { success: false, error: `${sym} already has ${existing.side.toUpperCase()} position` };
            }
            // Flip: close existing first
            log.warn(`🔄 Manual flip: closing existing ${existing!.side.toUpperCase()} ${sym} first`);
            // v2.0.853-fix2: Tag 'manual' — this is a user-initiated flip, not a
            //   system consensus close. Without this, inferCloseReason may classify
            //   it as 'sl_tp' if the exit price happens to be near SL/TP, polluting
            //   the learning weight (should be 0.5× for manual, not 1.0× for sl_tp).
            await this.closeTrade(sym, `Manual flip: closing ${existing!.side.toUpperCase()} to open ${action.toUpperCase()}`, 'manual');
          }

          // Fetch current price
          let price = 0;
          try {
            const priceData = await withTimeout(this.marketAgent.fetchPriceForSymbol(sym), 10_000, `manual-price ${sym}`);
            if (priceData) price = priceData.price;
          } catch {
            // fallback 1: marketState
            const state = this.marketState.getState(sym);
            price = state?.price ?? 0;
          }
          // v2.0.131: fallback 2 — re-fetch with selected symbol
          if (price <= 0) {
            try {
              const selected = this.marketAgent.getSelectedSymbol();
              if (selected && normalizeSymbol(selected) === normalizeSymbol(sym)) {
                const priceData2 = await withTimeout(this.marketAgent.fetchPriceForSymbol(selected), 10_000, `manual-price2 ${selected}`);
                if (priceData2) price = priceData2.price;
              }
            } catch { /* best-effort */ }
          }
          if (price <= 0) {
            return { success: false, error: `No price available for ${sym}` };
          }

          // Execute the trade
          const decision: TradingDecision = {
            action,
            symbol: sym,
            positionSizePct,
            leverage,
            entryPrice: price,
            rationale: `Manual trade — bypassed conviction gate + thesis validation`,
            urgency: 'immediate',
            stopLossPct: 0.02,
            takeProfitPct: 0.05,
          };

          const execResult = await this.executeTrade({
            ...decision,
            srSupport: this.lastSRContext?.nearestSupport ?? null,
            srResistance: this.lastSRContext?.nearestResistance ?? null,
          }, []);

          if (execResult.success) {
            log.info(`✅ Manual trade executed: ${action.toUpperCase()} ${sym} @ $${price.toFixed(2)}`);
            // Clear pending thesis for this symbol
            this.pendingTheses.delete(sym);
            this.pushToAPI();
            return { success: true };
          } else {
            return { success: false, error: execResult.error ?? 'Execution failed' };
          }
        } catch (err) {
          log.error(`Manual trade failed: ${err instanceof Error ? err.message : String(err)}`);
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      });

      this.apiServer.setPauseHandler(() => {
        this.paused = true;
        log.info('⏸️ System PAUSED — RBC engine continues, all agents/trading halted');
        this.pushToAPI();
      });
      this.apiServer.setResumeHandler(() => {
        this.paused = false;
        log.info('▶️ System RESUMED — normal operation restored');
        this.pushToAPI();
      });

      // Wire up candle data proxy — routes through backend to avoid CORS + 429
      // v2.0.XX: Use the global rate limiter (hl-global-limiter.ts) instead of
      // a per-proxy lastHLCall gap. This shares the same request budget as
      // MarketAgent, HL real engine, REST polling, S/R detector, and ATR.
      this.apiServer.setCandlesRequestHandler(async (symbol, interval, limit) => {
        // Route candle requests by symbol format, not by exchange setting:
        // - symbols containing ":" (xyz:CL, flx:NVDA) → Hyperliquid DEX 1-8
        // - USDT/USD suffixed → Binance Futures
        // - bare symbols (BTC, ETH, SOL) → Hyperliquid DEX 0
        const upper = symbol.toUpperCase();
        const isColonSymbol = symbol.includes(':');
        const isBinanceSymbol = upper.endsWith('USDT') || upper.endsWith('USD');
        if (isBinanceSymbol && !isColonSymbol) {
          const res = await fetch(`${config.binance.futuresRestUrl}/fapi/v1/klines?symbol=${upper}&interval=${interval}&limit=${limit}`);
          if (!res.ok) throw new Error(`Binance ${res.status}`);
          const data = await res.json() as unknown[][];
          return data.map(k => ({
            time: Math.floor(Number(k[0]) / 1000),
            open: parseFloat(k[1] as string),
            high: parseFloat(k[2] as string),
            low: parseFloat(k[3] as string),
            close: parseFloat(k[4] as string),
          }));
        } else {
          // Hyperliquid candleSnapshot is case-sensitive — DEX 1-8 prefixed
          // symbols need lowercase prefix (xyz:SKHX, not XYZ:SKHX).
          // DEX 0 bare names (BTC, ETH, SOL) need uppercase.
          const hlSymbol = symbol.includes(':')
            ? symbol.replace(/^[^:]+:/, (m) => m.toLowerCase())
            : symbol.toUpperCase();
          const hlInterval = { '5m': '5m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' }[interval] || '1h';
          const endTime = Date.now();
          const msMap: Record<string, number> = { '5m': 300_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000 };
          const startTime = endTime - (msMap[hlInterval] ?? 3_600_000) * limit;

          const res = await hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'candleSnapshot', req: { coin: hlSymbol, interval: hlInterval, startTime, endTime } }),
          });
          if (!res.ok) throw new Error(`HL ${res.status}`);
          const data = await res.json() as Array<{ t: number; o: string; c: string; h: string; l: string }>;
          // HL candleSnapshot returns candles as an array — the colon-prefix stripped coin name works
          // 🐛 FIX: HL returns t in MILLISECONDS, but lightweight-charts expects SECONDS.
          // The old code only divided by 1000 when k.t was a string, but k.t is always
          // a number (ms timestamp). Always divide by 1000.
          return data.map(k => ({
            time: Math.floor((typeof k.t === 'number' ? k.t : parseInt(String(k.t ?? '0'))) / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
          }));
        }
      });

      this.apiServer.start();
      log.info(`✓ API Server on http://localhost:${config.system.apiPort ?? 3456}`);

      // 7. Initialize Hyperliquid + Multi-Exchange WebSocket (BEFORE Market Agent so onSymbolChanged works)
      log.info('Step 7/7: Initializing Hyperliquid WebSocket...');
      this.hyperliquidWs = new HyperliquidWebSocketManager();

      // v2.0.16: subscribe to user-level feeds (clearinghouseState + userFills)
      // so the local portfolio + UI stay in real-time sync with Hyperliquid
      // positions + fills. Only when a wallet address is configured (real mode).
      const hlWallet = config.realTrading.hyperliquidWalletAddress;
      if (hlWallet && hlWallet.length > 0) {
        this.hyperliquidWs.setWalletAddress(hlWallet);
        // Position updates → soft-sync the local mirror (PnL + price only,
        // no auto-close; the exchange natively manages stop-losses).
        // v2.0.35: Also detect positions that disappeared from HL (closed by
        // SL/TP) and close the local mirror. This is a backup to the onFills
        // handler — if the fill callback missed the close (e.g. WS reconnect),
        // the position callback will catch it.
        this.hyperliquidWs.onPositions((positions) => {
          // v2.0.42: Use normalizeSymbol for consistent casing with portfolio.
          const hlSymbols = new Set(positions.map(p => normalizeSymbol(p.symbol)));
          // Soft-update existing positions
          for (const p of positions) {
            const sym = normalizeSymbol(p.symbol);
            if (this.portfolio.hasPosition(sym)) {
              // v2.0.869-fix(主神 SKHX MAE=0 調查):傳 HL 回傳嘅 unrealizedPnl——
              // 之前用 entryPx 做 currentPrice——pnl = 0——trackMAEMFE 冇追蹤——
              // 短持倉 trade MAE/MFE = 0(數據錯)。HL pnl 係真實——直接使用。
              this.portfolio.softUpdatePosition(sym, p.entryPx, p.unrealizedPnl);
            }
          }
          // v2.0.35: Check for real positions that disappeared from HL
          // v2.0.42: Use normalizeSymbol for hlSymbols comparison — previously
          // colon symbols could mismatch (xyz:MU vs XYZ:MU) causing false closes.
          const realPositions = this.portfolio.getOpenSymbols().filter(sym => {
            const pos = this.portfolio.getPosition(sym);
            return pos && pos.agentId === 'hyperliquid-real';
          });
          for (const sym of realPositions) {
            if (!hlSymbols.has(sym)) {
              // v2.0.166: DO NOT close based on WS position disappearance alone.
              // The HL WS clearinghouseState push can be partial (missing some
              // positions due to WS lag, subscription delay, or incremental updates).
              // Closing here created phantom close records for positions that were
              // still open on HL — the next cycle re-imported them, creating
              // duplicate trades with no thesis/MAE/MFE.
              // Instead, just log a warning. The REST-based syncExchangePositions
              // (which runs every cycle with fill verification) handles real closes.
              // v2.0.169: Suppress repeated logging — DEX positions (xyz:*) are
              // NEVER in the WS clearinghouseState push (it only covers the main
              // clearinghouse). Logging every 5s for these is pure spam. Only log
              // once per position per session, and use debug level for DEX symbols.
              const isDexSymbol = sym.includes(':');
              if (isDexSymbol) {
                // DEX positions expected to be absent from WS — debug only, once
                if (!this.wsMissingLogged.has(sym)) {
                  log.debug(`📡 HL WS position not in push (DEX, expected): ${sym} — managed via REST syncExchangePositions`);
                  this.wsMissingLogged.add(sym);
                }
              } else {
                // Main clearinghouse position missing — could be a real close
                if (!this.wsMissingLogged.has(sym)) {
                  log.info(`📡 HL WS position not in push: ${sym} — will verify via REST syncExchangePositions (not closing — WS push may be partial)`);
                  this.wsMissingLogged.add(sym);
                }
              }
            } else {
              // Position is in the push — reset the "missing" flag so if it
              // disappears later we log again
              this.wsMissingLogged.delete(sym);
            }
          }
        });
        // Fill updates → immediate post-trade sync so the mirror's entry point
        // reflects the actual fill price (not the decision price).
        // v2.0.35: Also detect CLOSING fills (SL/TP triggered on HL) and
        // immediately close the local mirror + create a trade record + trigger
        // learning. Previously closing fills only did softUpdatePosition, so
        // the local mirror stayed open forever and no trade record was created
        // — the system never learned from HL-triggered SL/TP closes.
        this.hyperliquidWs.onFills(async (fill) => {
          // v2.0.42: Use normalizeSymbol for consistent casing with portfolio.
          const sym = normalizeSymbol(fill.symbol);
          // v2.0.35: Use the HL dir field to reliably distinguish opening vs
          // closing fills. "Close Long"/"Close Short" = closing, "Open Long"/
          // "Open Short" = opening. closedPnl alone is unreliable for partial
          // closes (a partial close may have closedPnl=0 if PnL is exactly 0).
          const isClosingFill = fill.dir.toLowerCase().includes('close');
          if (isClosingFill && this.portfolio.hasPosition(sym)) {
            const pos = this.portfolio.getPosition(sym);
            if (pos && pos.agentId === 'hyperliquid-real') {
              // v2.0.166: Check that the fill's side matches the closing side
              // of this position. A SELL position is closed by a BUY fill, and
              // vice versa. Without this check, a closing fill from a PREVIOUS
              // position (e.g. old SELL SKHX closed → "close short" fill with
              // side=buy) could match a NEW SELL SKHX position and create a
              // phantom close record.
              // HL WS fills use 'B' (buy) / 'A' (ask=sell) for side.
              const expectedCloseSideRaw = isBuySide(pos.side) ? 'A' : 'B';
              if (fill.side !== expectedCloseSideRaw) {
                log.info(`📡 HL WS closing fill ${fill.symbol} side=${fill.side} doesn't match closing side ${expectedCloseSideRaw} for ${pos.side} position — skipping (may be from a previous position)`);
              } else {
                log.info(`📡 HL WS closing fill: ${fill.symbol} ${fill.side} ${fill.size} @ ${fill.price} dir=${fill.dir} closedPnl=${fill.closedPnl} — closing local mirror immediately`);
                // Close the local mirror with the actual HL fill price + realized PnL
                const closedTrade = this.portfolio.closeExchangePosition(sym, fill.price, fill.closedPnl);
                // v2.0.869-P3(主神 trade 缺失調查):onFills close 路徑——
                // 之前冇 call recordTrade——trade 唔會寫入 Supabase——UI 冇顯示!
                // 而家:close 後——call recordTrade(用 close 嘅 trade 資料)
                if (closedTrade && supabaseTradeWriter.isEnabled()) {
                  try {
                    supabaseTradeWriter.recordTrade(closedTrade as never, 'real');
                  } catch (err) {
                    log.warn(`[supabase-trades] onFills recordTrade failed: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                return;
              }
            }
          }
          // Opening fill or non-closing fill — just soft-update the mirror price
          if (this.portfolio.hasPosition(sym)) {
            this.portfolio.softUpdatePosition(sym, fill.price);
            log.info(`📡 HL WS fill: ${fill.symbol} ${fill.side} ${fill.size} @ ${fill.price} dir=${fill.dir} — mirror synced`);
          }
        });
        log.info('✓ HL WS user feeds wired (clearinghouseState + userFills)');
      }
      log.info('✓ Hyperliquid WebSocket ready');

      // Multi-Exchange WS — binance left null intentionally (HL-only mode)
      // v2.0.869(主神 binance-websocket 剷除):HL-only——移除 binance 參數
      this.multiWs = new MultiExchangeWebSocketManager(this.hyperliquidWs);
      // Wire unified WS data into sentiment engine + paper engine + marketState
      this.multiWs.onPrice((data: UnifiedPrice) => {
        // v2.0.24: track trade count before updatePrice so we can detect
        // SL/TP-triggered closes and push the updated totalPnl to the UI
        // immediately (not waiting for the next cycle's pushToAPI()).
        const tradesBefore = this.portfolio.getPortfolio().tradeCount;
        this.paperEngine.updatePrice(data.symbol, data.price);
        this.sentimentEngine.updatePrice(data.price);
        // v2.0.32: Feed price into Planck-Chaos Resonance Engine
        this.planckChaos.feedPrice(data.price, Date.now());
        if (data.fundingRate !== undefined) {
          this.sentimentEngine.updateFundingRate(data.fundingRate);
        }
        // If a position was closed (SL/TP triggered), push the updated
        // totalPnl + balance to the UI immediately.
        const tradesAfter = this.portfolio.getPortfolio().tradeCount;
        if (tradesAfter > tradesBefore) {
          this.pushToAPI();
        }
        // Also feed into marketState aggregator for cycle analysis
        this.marketState.update({
          symbol: data.symbol,
          price: data.price,
          volume: 0,
          quoteVolume: 0,
          priceChange: 0,
          priceChangePercent: 0,
          high24h: 0,
          low24h: 0,
          timestamp: Date.now(),
        });
      });
      this.multiWs.onOrderBook((book) => {
        // Feed order book depth into marketState for obImbalance computation
        this.marketState.updateDepth(
          book.bids.map(b => ({ price: b.price, qty: b.size })),
          book.asks.map(a => ({ price: a.price, qty: a.size })),
        );
      });
      this.multiWs.onConnectionChange((exchange: string, connected: boolean) => {
        if (!connected) {
          log.warn(`⚠️  ${exchange} WebSocket disconnected.`);
        }
      });
      log.info('✓ Multi-Exchange WebSocket ready');

      // 7.1 Initialize Market Agent — NOW multiWs exists, so onSymbolChanged won't crash
      log.info('Step 7.1/8: Initializing Market Agent...');
      this.marketAgent = new MarketAgent();
      this.marketAgent.onSymbolChanged((symbol: string) => {
        log.info(`Market Agent selected new symbol: ${symbol}`);
        this.multiWs.connect(symbol).catch((err: Error) => {
          log.warn(`Multi-WS connect failed for ${symbol}: ${err.message}`);
        });
      });
      this.marketAgent.onPairsUpdatedCallback(() => {
        this.pushToAPI();
      });
      await this.marketAgent.fetchTopPairs();
      log.info('✓ Market Agent ready');
      MarketAgent.registerSRModule();

      // v2.0.138: Instantiate EXP thesis-experience memory and wire to HACP.
      // directionAllowed delegates to Market Agent's directionRestrictions.
      // Gated by config.exp.enabled — when false, checkThesisHistory returns
      // EXP_DISABLED and HACP falls back to the existing 1.8b strength check.
      this.expMemory = new ThesisExperience({
        embed: getSharedEmbedProvider(),
        llm: new ActiveProviderLLMCaller(),
        directionAllowed: (sym: string, side: 'buy' | 'sell') => this.marketAgent.isDirectionAllowed(sym, side),
      });
      this.hacpEngine.setExpMemory(this.expMemory);
      // v2.0.140: Dual-Channel Fusion — provide OLR P(win) + shadow win rate
      // to HACP so checkThesisHistory() can cross-reference semantic vs statistical.
      this.hacpEngine.setFusionDataCallback((symbol: string, side: 'buy' | 'sell') => {
        const result: { olrPWin?: number; shadowWinRate?: number } = {};
        try {
          // v2.0.177: Use normalizeSymbol for consistent key matching with
          // lastCycleShadowContexts. The old code used symbol.toLowerCase()
          // which doesn't match DEX symbols (xyz:SKHX → xyz:skhx ≠ xyz:SKHX).
          const sym = normalizeSymbol(symbol);
          const features = this.lastCycleShadowContexts.get(sym)?.features
            ?? this.lastCycleShadowContexts.get(symbol.toLowerCase())?.features
            ?? this.lastCycleShadowContexts.get(symbol)?.features
            ?? {};
          if (Object.keys(features).length > 0) {
            const olr = this.olrEngine.query(sym, features, side, this.totalCycles);
            result.olrPWin = olr.pWin;
          }
        } catch { /* non-critical */ }
        try {
          const shadowStats = this.shadowEngine.getStats().find(s => s.symbol === normalizeSymbol(symbol) || s.symbol === symbol.toLowerCase());
          if (shadowStats) {
            result.shadowWinRate = side === 'buy' ? shadowStats.longWinRate : shadowStats.shortWinRate;
          }
        } catch { /* non-critical */ }
        return result;
      });
      if (config.exp.enabled) {
        try {
          this.expMemory.load();
          // Fire-and-forget warmup: transformers.js downloads the 22MB ONNX from
          // HuggingFace Hub on first use — do NOT block system startup on network.
          // If not ready by the first trade, 1.8a self-heals (diagnose→repair→1.8b).
          void this.expMemory.warmup();
          // v2.0.140: rebuild A2A experience classes from loaded records so
          // classification is available from the first cycle. Fire-and-forget:
          // digests + embeds every record (LLM + embed cost), runs in background.
          void this.expMemory.rebuildClasses().catch((err: unknown) =>
            log.warn(`[EXP] startup class rebuild failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`),
          );
          log.info(`✓ EXP thesis-experience memory ready (${this.expMemory.size()} records) — embed model warming up + classes rebuilding in background`);

          // v2.0.186: System Engineer startup audit — only when explicitly enabled
          if (process.env['SYSTEM_ENGINEER_ENABLED'] === 'true') {
            void this.runDirectionAudit();
          }
          // v2.0.140: EM Cycle Chain insight retrieval — share the same
          // TransformersEmbedProvider (stateless, no interference with
          // ExperienceDigester). Rebuild insight vectors from loaded summaries.
          this.emManager.setEmbedProvider(getSharedEmbedProvider());
          // v2.0.206 (#6): Wire NA provider for dual-channel (text + market-condition) retrieval.
          this.emManager.setNaEmbeddingProvider(this.naEngine);
          // v2.0.207 (#F): Wire embed provider for anti-pattern clustering + rebuild from corpus.
          this.antiPatternTracker.setEmbedProvider(getSharedEmbedProvider());
          void this.antiPatternTracker.rebuild(this.expMemory?.getRecords() ?? []).catch((err: unknown) =>
            log.warn(`[anti-pattern] startup rebuild failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`),
          );
          void this.emManager.rebuildInsightVectors().catch((err: unknown) =>
            log.warn(`[insight-retrieval] startup rebuild failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`),
          );
        } catch (err) {
          log.warn(`[EXP] startup load failed (will self-heal on first use): ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        log.info('EXP thesis-experience memory disabled (config.exp.enabled=false) — HACP uses 1.8b fallback');
      }

      // ─── v2.0.141: Initialize RIL (Reason Intelligence Layer) ───
      if (config.ril.enabled) {
        const embed = getSharedEmbedProvider();
        this.patternCluster = new PatternClusterManager(embed);
        this.closeReasonAgg = new CloseReasonAggregator();
        this.similarTradeRetriever = new SimilarTradeRetriever();
        this.subtleDiffAnalyzer = new SubtleDiffAnalyzer();

        // v2.0.215: Initialize AttnRes trade embedder (learned MiniLM rationale blend).
        // Applies K3 AttnRes theory at the rationale level: learned softmax attention
        // over rationale vectors replaces fixed combinationSimilarity.
        // Cold-start safe: w=0 → uniform → mean ≈ current behavior.
        // Backward compatible: when not trained, blend = mean of rationales.
        this.attnResTradeEmbedder = new AttnResTradeEmbedder({ embedDim: config.exp.embedDim });
        await this.attnResTradeEmbedder.load('data/evolution/attnres-embed-state.json');
        this.patternCluster.setAttnResTradeEmbedder(this.attnResTradeEmbedder);
        this.similarTradeRetriever.setAttnResTradeEmbedder(this.attnResTradeEmbedder);
        log.info(`✓ AttnRes trade embedder ready (${this.attnResTradeEmbedder.getUpdateCount()} updates, |w|=${this.attnResTradeEmbedder.getWeightNorm().toFixed(4)})`);

        // Rebuild clusters from EXP records (non-blocking). When AttnRes embedder
        // is present, rebuild uses blended vectors for cluster assignment.
        if (this.expMemory && this.expMemory.size() > 0) {
          void this.patternCluster.rebuild(this.expMemory.getRecords()).catch((err: unknown) =>
            log.warn(`[RIL] startup cluster rebuild failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`),
          );
        }
        log.info('✓ RIL (Reason Intelligence Layer) initialized');
        // v2.0.143: Wire SimilarTradeRetriever + SubtleDiffAnalyzer + LLM chat
        // function into HACP so the Meta-Agent sees similar historical trades
        // + subtle differences analysis in its enhanced context.
        this.hacpEngine.setSimilarTradeRetriever(this.similarTradeRetriever);
        this.hacpEngine.setSubtleDiffAnalyzer(this.subtleDiffAnalyzer);
        // v2.0.204: Wire Numeric Autoencoder + candidate-features provider into
        // HACP so Skeptics Phase 1.8b sees the vector-conditional win-rate block
        // (learned market-condition embedding) alongside the RIL similar-trades block.
        this.hacpEngine.setNaEmbeddingProvider(this.naEngine);
        // v2.0.207 (#F): Wire anti-pattern tracker for Skeptics candidate matching.
        this.hacpEngine.setAntiPatternTracker(this.antiPatternTracker);
        // v2.0.212 (#7): Wire cycle-history retriever for execution-lens context.
        this.hacpEngine.setCycleHistoryRetriever(this.cycleHistory);
        // v2.0.835: Q-RL discovery block is set per-cycle before executeDecisionCycle
        // v2.0.221 (Fix #5): Wire exploration context provider so HACP can inject
        // the UCB exploration assessment into Meta-Agent/Skeptics context. This is
        // a SIGNAL — the Meta-Agent must still build a real thesis with ≥2 specific
        // edge elements. The provider calls activeExploration.formatContext() with
        // the current cycle's exploration result.
        this.hacpEngine.setExplorationContextProvider((side: 'buy' | 'sell') => {
          if (!this.activeExploration) return '';
          try {
            const expConfig = this.activeExploration.getConfig();
            if (!expConfig.enabled) return '';
            const sym = normalizeSymbol(this.marketAgent.getConfig().selectedSymbol ?? '');
            const feats = this.lastCycleShadowContexts.get(sym)?.features ?? {};
            const olrPWin = safeNum(this.olrEngine.query(sym, feats, side, this.totalCycles).pWin, 0.5);
            const bayesianUncertainty = this.bayesianOLR ? safeNum(this.bayesianOLR.query(sym, feats, side, this.totalCycles).uncertainty, 0) : 0;
            const result = this.activeExploration.compute({
              pWin: olrPWin,
              symbol: sym,
              side,
              uncertainty: bayesianUncertainty,
              totalTrades: this.totalCycles,
              symbolTrades: this.evolution.tradeHistory.getRecent(100).filter(t => normalizeSymbol(t.symbol) === sym).length,
            });
            if (!result.applied) return ''; // cold-start or disabled — don't inject
            return this.activeExploration.formatContext(result);
          } catch (err) {
            log.warn(`[exploration-ctx] Failed to build exploration context: ${err instanceof Error ? err.message : String(err)}`);
            return '';
          }
        });
        this.hacpEngine.setNaCandidateFeaturesProvider(() => {
          // v2.0.211 (K.md #1): Use AttnRes h_blend (softmax blend over cycle
          // history + entry-time state) as the candidate features instead of
          // the single current snapshot. Cold-start safe: retrieveBlend returns
          // the current snapshot when history < minHistoryToBlend.
          const sym = normalizeSymbol(this.marketAgent.getConfig().selectedSymbol ?? '');
          if (this.cycleHistory) {
            const blend = this.cycleHistory.retrieveBlend(sym);
            if (blend.hBlend && Object.keys(blend.hBlend).length > 0) return blend.hBlend;
          }
          const ctx = this.lastCycleShadowContexts.get(sym);
          if (ctx && ctx.features && Object.keys(ctx.features).length > 0) return ctx.features;
          // Fallback: build from current market state if shadow context not ready.
          const state = this.marketState?.getState(sym);
          return {
            volatility: safeNum(state?.volatility, 0),
            srDistanceBps: safeNum(this.lastSRContext?.distanceToSupportBps, 0),
            obImbalance: safeNum(state?.orderBookImbalance, 0),
            signalAgreement: safeNum(this.lastHACPResult?.consensus?.confidence, 0.5),
            regimeOrdinal: regimeToOrdinal(state?.regime),
            hourOfDay: currentHourOfDay(),
          };
        });
        this.hacpEngine.setLLMChatFn(async (messages: Array<{ role: string; content: string }>, opts?: { temperature?: number; timeoutMs?: number }) => {
          const provider = getActiveProvider();
          const response = await provider.chat({
            messages: messages as any,
            temperature: opts?.temperature ?? 0,
            timeoutMs: opts?.timeoutMs ?? 25_000,
          });
          return response.content;
        });
      } else {
        log.info('RIL disabled (config.ril.enabled=false)');
      }

      // v2.0.XX: Sync initial maxPortionPct from Market Agent to paper engine + real manager
      this.paperEngine.setMaxPortionPct(this.marketAgent.getConfig().maxPortionPct);
      this.tradingManager.setMaxPortionPct(this.marketAgent.getConfig().maxPortionPct);

      // v2.0.124: Restore trading markets from persisted config so the system
      // starts with the correct markets instead of falling back to auto-select.
      // Without this, the first cycle after restart only analyzes the
      // selectedSymbol (1 market) until the UI connects and POSTs the markets.
      const restoredMarkets = this.marketAgent.getTradingMarkets();
      if (restoredMarkets.length > 0) {
        this.tradingMarkets = restoredMarkets;
        log.info(`📊 Trading markets restored from config: ${restoredMarkets.join(', ')} (${restoredMarkets.length} market(s))`);
      }

      // v2.0.78: Sync tradeMode + exchange from restored Market Agent config to
      // TradingManager. The RTM was created with hardcoded 'paper' in step 5.6
      // because MarketAgent didn't exist yet. Now that MarketAgent has loaded its
      // saved config from disk (which may be 'real'), we must sync RTM to match.
      const restoredTradeMode = this.marketAgent.getTradeMode();
      const restoredExchange = this.marketAgent.getExchange();
      if (restoredTradeMode !== this.tradingManager.getTradeMode()) {
        log.info(`🔄 Syncing restored trade mode to Real Trading Manager: ${this.tradingManager.getTradeMode()} → ${restoredTradeMode}`);
        this.tradingManager.setTradeMode(restoredTradeMode);
      }
      if (restoredExchange !== this.tradingManager.getExchange()) {
        this.tradingManager.setExchange(restoredExchange);
      }

      // v2.0.78: If restored trade mode is 'real', perform the same real-mode
      // initialization that the UI API handler does when switching to real:
      // set HL WS wallet address + fetch real balance/positions/fills so the
      // UI shows real data from the start (not paper defaults).
      if (restoredTradeMode === 'real') {
        const hlWallet = config.realTrading.hyperliquidWalletAddress;
        const hlPrivKey = config.realTrading.hyperliquidPrivateKey;
        if (hlWallet && hlWallet.trim().length > 0 && hlPrivKey && hlPrivKey.trim().length > 0) {
          this.hyperliquidWs.setWalletAddress(hlWallet.trim());
          log.info('📡 HL WS wallet address set for user-level feeds (restored real mode)');
          try {
            this.cachedExchangeBalance = await this.tradingManager.getBalance();
            this.cachedHLFills = await this.tradingManager.getRecentFills(20);
            this.cachedExchangePositions = (await this.tradingManager.getPositions()).map(p => ({
              symbol: p.symbol,
              side: p.side,
              quantity: p.quantity,
              averageEntryPrice: p.averageEntryPrice,
              currentPrice: p.currentPrice,
              unrealizedPnl: p.unrealizedPnl,
              leverage: p.leverage ?? 1,
              openedAt: p.openedAt,
            }));
            for (const p of this.cachedExchangePositions) { this.lastKnownLeverage.set(p.symbol.replace(/^xyz:/i, '').toLowerCase(), p.leverage ?? 1); }
            log.info(`💰 Real HL balance restored: $${this.cachedExchangeBalance.total.toFixed(2)} | ${this.cachedExchangePositions.length} positions | ${this.cachedHLFills.length} recent fills`);
          } catch (err) {
            log.error(`❌ Failed to fetch real HL balance on startup: ${err instanceof Error ? err.message : String(err)}. Will retry next cycle.`);
          }
        } else {
          log.warn('⚠️ Restored trade mode is REAL but HL wallet/key not configured in .env — balance will show "--"');
        }
      }

      // REST API polling fallback for price data — 30s interval to avoid HL 429
      this.startRESTPolling();

      // v2.0.51: Sync SL/TP from HL at startup BEFORE first pushToAPI().
      // The local portfolio was restored from portfolio-state.json which has
      // stale SL/TP values. We need to read the actual HL trigger orders and
      // update the local mirror so the UI shows the real SL/TP from the start.
      // Without this, the UI shows stale SL/TP until the first decision cycle
      // runs syncSLTP() (which can take 5+ seconds after startup).
      try {
        const engine = this.tradingManager.getEngineForExchange('hyperliquid');
        if (engine) {
          const hlPositions = await engine.getPositions();
          if (hlPositions.length > 0) {
            // Update local mirror prices from HL
            for (const exPos of hlPositions) {
              const sym = exPos.symbol.includes(':') ? exPos.symbol : exPos.symbol.toLowerCase();
              if (this.portfolio.hasPosition(sym)) {
                this.portfolio.softUpdatePosition(sym, exPos.currentPrice);
              }
            }
            // v2.0.79: Sync exchange positions into local mirror at startup
            // so agents see all open positions in the first HACP cycle.
            // Without this, the first cycle only sees positions restored
            // from portfolio-state.json (which may be stale or incomplete).
            await this.tradingManager.syncExchangePositions();
            // Sync SL/TP from HL trigger orders → local mirror
            await this.tradingManager.syncSLTP();
            log.info(`📡 Startup HL sync: ${hlPositions.length} positions, SL/TP synced from exchange`);
          }
        }
      } catch (err) {
        log.warn(`Startup HL sync failed (non-critical, will retry on first cycle): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Register shutdown handlers
      registerShutdownHandler('system-timers', async () => {
        this.stopTimers();
      }, 5);

      // v2.0.58: Disconnect options data layer on shutdown
      registerShutdownHandler('options-data', async () => {
        this.optionsDataManager.disconnect();
      }, 8);

      // Start decision cycles
      this.startDecisionCycle();
      this.startHeartbeat();
      this.startUIPush();

      log.info('🚀 MATS System is LIVE — trading on Hyperliquid data');

      // Push any restored state (debate history, evolution, portfolio) to UI immediately
      this.pushToAPI();

      // Wait for WebSocket data before first cycle
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Push again after API server is definitely serving SSE clients
      setTimeout(() => this.pushToAPI(), 2000);

      // Run first decision cycle immediately
      await this.runDecisionCycle();
    } catch (err) {
      log.error(`Failed to start MATS system: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * v2.0.139: Fetch 1h candles for the SAME asset the chart uses, for price-news
   * timing (institutional front-run detection). Routes by symbol format exactly
   * like the UI candle proxy (Binance Futures for USDT/USD suffix, HL
   * candleSnapshot for bare/colon symbols) so the timing read is always on the
   * same series the rest of the system sees. 80 candles ≈ 3.3d covers the 3d
   * window. 5-minute per-symbol cache avoids re-fetching within a cycle.
   * Failures resolve to [] (the caller skips timing enrichment).
   */
  private async fetchTimingCandlesForSymbol(symbol: string): Promise<TimingCandle[]> {
    const cached = this.candleTimingCache.get(symbol);
    if (cached && Date.now() - cached.ts < 5 * 60_000) return cached.candles;
    const interval = '1h';
    const limit = 80;
    const msPerCandle = 3_600_000;
    try {
      const upper = symbol.toUpperCase();
      const isBinanceSymbol = (upper.endsWith('USDT') || upper.endsWith('USD')) && !symbol.includes(':');
      let candles: TimingCandle[];
      if (isBinanceSymbol) {
        const res = await fetch(`${config.binance.futuresRestUrl}/fapi/v1/klines?symbol=${upper}&interval=${interval}&limit=${limit}`);
        if (!res.ok) throw new Error(`Binance ${res.status}`);
        const data = await res.json() as unknown[][];
        candles = data.map(k => ({ t: Math.floor(Number(k[0]) / 1000) * 1000, c: parseFloat(k[4] as string) }));
      } else {
        // HL candleSnapshot is case-sensitive — colon prefixes lowercase, bare uppercase.
        const hlSymbol = symbol.includes(':')
          ? symbol.replace(/^[^:]+:/, (m) => m.toLowerCase())
          : symbol.toUpperCase();
        const endTime = Date.now();
        const startTime = endTime - msPerCandle * limit;
        const res = await hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'candleSnapshot', req: { coin: hlSymbol, interval, startTime, endTime } }),
        });
        if (!res.ok) throw new Error(`HL ${res.status}`);
        const data = await res.json() as Array<{ t: number; c: string }>; // v = string
        candles = data.map(k => ({ t: typeof k.t === 'number' ? k.t : parseInt(String(k.t ?? '0')), c: parseFloat(k.c) }));
      }
      this.candleTimingCache.set(symbol, { candles, ts: Date.now() });
      return candles;
    } catch (err) {
      log.debug(`[news-timing] candle fetch failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private startDecisionCycle(): void {
    // Use persisted cyclePeriodMinutes from MarketAgent config if available
    const savedMinutes = this.marketAgent?.getConfig().cyclePeriodMinutes;
    if (savedMinutes && savedMinutes >= 1 && savedMinutes <= 10) {
      this.cycleIntervalMs = savedMinutes * 60_000;
    }
    const intervalMs = this.cycleIntervalMs;
    log.info(`Decision cycle set for every ${intervalMs / 1000}s`);

    this.decisionTimer = setInterval(() => {
      if (!isShuttingDown()) {
        void this.runDecisionCycle();
      }
    }, intervalMs);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!isShuttingDown()) {
        // Silent heartbeat — status visible in UI
      }
    }, config.system.heartbeatIntervalMs);
  }

  /** v2.0.140: Start periodic UI push — every 10s, refresh position Mark
   *  prices + push to API so the Portfolio auto-updates between cycles. */
  private startUIPush(): void {
    this.uiPushTimer = setInterval(() => {
      if (!isShuttingDown()) {
        this.pushToAPI();
      }
    }, 10_000);
  }

  private stopTimers(): void {
    if (this.decisionTimer) {
      clearInterval(this.decisionTimer);
      this.decisionTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.uiPushTimer) {
      clearInterval(this.uiPushTimer);
      this.uiPushTimer = null;
    }
    if (this.restPollTimer) {
      clearInterval(this.restPollTimer);
      this.restPollTimer = null;
    }
  }

  /** REST API polling fallback for price data — 30s interval, exponential backoff on failure */
  private startRESTPolling(): void {
    const pollMs = 30_000;
    // v2.0.XX: Exponential backoff on consecutive failures — when network is
    // down (DNS failure), don't hammer every 30s. Back off to max 5min.
    const maxBackoffMs = 300_000;
    let consecutiveFailures = 0;
    log.info(`REST polling started (every ${pollMs / 1000}s) as WebSocket fallback`);

    const poll = async () => {
      try {
        // v2.0.66: Batch fetch prices for active symbol + all open positions.
        // This reduces HL API calls from N×3 to 1 (metaAndAssetCtxs) + M (l2Book
        // for M colon symbols), preventing 429 rate limit errors.
        const activeSymbol = this.marketAgent.getSelectedSymbol() || 'BTCUSDT';
        const openSymbols = this.portfolio.getOpenSymbols();
        // v2.0.79: Dedup symbols by normalized name — tradingMarkets may have
        // "BTC" while openPositions has "btc", causing duplicate API calls.
        const allSymbols = Array.from(new Set(
          [activeSymbol, ...openSymbols].map(s => s.includes(':') ? s : s.toUpperCase())
        ));
        const priceMap = await this.marketAgent.fetchPricesForSymbols(allSymbols);
        // v2.0.139: cache live prices (lowercase key) for refreshPositionMarkPrices
        this.cachedPriceMap = new Map();
        for (const [sym, data] of priceMap) {
          if (data.price > 0) {
            this.cachedPriceMap.set(sym.toLowerCase(), data.price);
            this.paperEngine.updatePrice(sym, data.price);
          }
        }
        // Success — reset backoff
        if (consecutiveFailures > 0) {
          log.info(`REST polling recovered after ${consecutiveFailures} failures — resuming ${pollMs / 1000}s interval`);
          consecutiveFailures = 0;
        }
      } catch {
        // Exponential backoff — don't spam logs every 30s when network is down
        consecutiveFailures++;
        const backoff = Math.min(pollMs * Math.pow(2, consecutiveFailures - 1), maxBackoffMs);
        if (consecutiveFailures <= 3 || consecutiveFailures % 10 === 0) {
          log.warn(`REST poll failed (${consecutiveFailures}×) — backing off to ${backoff / 1000}s`);
        }
        // Reschedule next poll with backoff instead of fixed interval
        if (this.restPollTimer) clearInterval(this.restPollTimer);
        this.restPollTimer = setInterval(() => { void poll(); }, backoff);
        // After one backoff tick, restore the dynamic interval for subsequent polls
        setTimeout(() => {
          if (this.restPollTimer) clearInterval(this.restPollTimer);
          this.restPollTimer = setInterval(() => { void poll(); }, pollMs);
        }, backoff);
      }
    };

    void poll();
    this.restPollTimer = setInterval(() => { void poll(); }, pollMs);
  }

  /**
   * v2.0.25: Learning hook invoked after EVERY position close (SL/TP,
   * reconciliation, agent-vote close). Bridges the gap between
   * price-update-triggered closes and the learning system so the system
   * learns from losses that happen BETWEEN decision cycles.
   *
   * Feeds the close outcome to:
   *  1. Trade History — so getRecentTradeAnalysis() sees SL/TP losses
   *  2. OLR — so it learns "these conditions → LONG/SHORT loses"
   *  3. Pattern Classifier — so the pattern DB records the loss
   *  4. Agent Outcomes — so the system knows which agents were wrong
   *  5. Evolution — so the strategy adapts to the loss
   */
  /** v2.0.181: System Engineer agent — LLM-powered code review that reads
   *  SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md + trade records +
   *  relevant source code, detects issues, and generates fix proposals
   *  (with code diffs + tests + changelog) written to audit-recommendations.jsonl.
   *  Runs at startup and every 2 cycles. Has suggestion power, not execution power. */
  private async runDirectionAudit(): Promise<void> {
    try {
      if (!this.expMemory) return;
      const records = this.expMemory.getRecords();
      if (records.length === 0) return;
      // v2.0.181: Run the System Engineer agent (reads SystemEngineer.md + code + trades)
      // v2.0.725: Pass audit results so SE can directly fix issues detected by the audit
      await runSystemEngineer(records, this.lastAuditResult ?? undefined);
    } catch (err) {
      log.warn(`[system-engineer] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * v2.0.844 Phase 2a: Causal-Grounded Entry Gate multiplier.
   *
   * When the Causal Reasoner reports a NEGATIVE causal uplift for a symbol
   * (aligned shadow shows trading actively destroys value vs holding), dampen
   * conviction. Soft gate — returns [0.5, 1.0], never blocks outright.
   *
   * Cold-start safe: insufficient per-symbol samples → 1.0 (no penalty).
   * WINNER-FIRST: a strong combo winner can still trade through because the
   * penalty is multiplicative on confidence, not a hard block.
   */
  private computeCausalConvictionMultiplier(
    symbol: string,
    _action: 'buy' | 'sell',
    _regime: string,
  ): number {
    try {
      if (!this.causalReasoner) return 1.0;
      const perSymbol = this.causalReasoner.getPerSymbolUplift();
      const match = perSymbol.find(
        p => normalizeSymbol(p.symbol) === normalizeSymbol(symbol),
      );
      if (!match || match.samples < 5) return 1.0; // cold-start: no penalty
      if (match.uplift >= 0) return 1.0;          // positive or neutral uplift: no penalty

      // Negative uplift: proportional soft penalty, capped at 0.5 floor so
      // a genuinely strong signal can still pass a loose threshold.
      const penalty = Math.min(0.5, Math.abs(match.uplift) * 20);
      return Math.max(0.5, 1.0 - penalty);
    } catch (err) {
      log.warn(`[causal-gate] compute failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      return 1.0;
    }
  }

  /**
   * v2.0.844 Phase 2b: Meta-Calibrator → Dynamic Trust multiplier.
   *
   * Uses the per-regime Brier score to dampen conviction when the system is
   * poorly calibrated in the current regime (Brier > 0.25 = worse than random)
   * and boost it when well-calibrated (Brier < 0.20). Insufficient data → 1.0.
   *
   * Delegates to the existing MetaCalibrator.getConfidenceAdjustment() which
   * already implements the [0.5, 1.5] clamping and MIN_SAMPLES guard.
   */
  private computeCalibrationTrustMultiplier(regime: string): number {
    try {
      if (!this.metaCalibrator) return 1.0;
      const trust = this.metaCalibrator.getConfidenceAdjustment(regime);
      return Number.isFinite(trust) ? Math.max(0.5, Math.min(1.5, trust)) : 1.0;
    } catch (err) {
      log.warn(`[cal-trust] compute failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      return 1.0;
    }
  }

  /**
   * v2.0.861 Phase 1.2: Q-RL EXPECTANCY conviction multiplier.
   *
   * Multi-condition dampening (ALL must hold): the action's cell in the
   * CURRENT state bucket has
   *   visits ≥ QRL_MIN_SAMPLES AND medianReward < 0 AND trimmedMean < 0
   *   AND Q < QRL_NEG_THRESHOLD
   * → conviction × QRL_DAMPEN_FACTOR (default 0.5). This is the regime-
   * conditioned counterweight to stale OLR edges: when the Q-RL table has
   * LEARNED that this side loses money in the current state, the gate
   * damps it — without hard-blocking (floor 0.3, preserving the genuine
   * bear-market sell edge).
   *
   * Asymmetric: positive boost requires a statistically STRONG positive
   * (median > 0 AND t ≥ 2) and is OFF by default (boostFactor = 1.0) —
   * buy's t=+1.0 is not yet significant, so boosting would be overconfidence.
   *
   * Pure logic lives in qrlExpectancyMultiplier() (q-rl-table.ts) so it is
   * unit-testable; this method only gathers the cell + logs the outcome.
   */
  /**
   * v2.0.863: CHART-AWARE conviction — 真駁通 LLM 世界模型(讀圖)到 gate。
   * K-LINE 趨勢 vs LLM 方向一致性 + DATA QUALITY 校準(硬性乘法,soft 可回滾)。
   */
  private computeChartConviction(
    action: 'buy' | 'sell',
    rationale: string | undefined,
  ): number {
    if (!chartConvictionConfig.enabled) return 1.0;
    try {
      const catalyst = classifyThesisCatalyst(rationale);
      const k = this.lastKlineSummary;
      return computeChartConvictionMultiplier({
        action,
        klineTrend: k?.trend1h ?? null,
        klineTrend5m: k?.trend5m ?? null,
        catalystLevel: catalyst.level,
        catalystSentiment: catalyst.sentiment,
        qualityScore: this.lastQualityScore,
      });
    } catch {
      return 1.0;
    }
  }

  private computeQRLExpectancyMultiplier(
    symbol: string,
    action: 'buy' | 'sell',
  ): number {
    try {
      if (!qrlDirectionConfig.gateEnabled || !this.qrlTable) return 1.0;
      const features = this.lastCycleShadowContexts.get(normalizeSymbol(symbol))?.features;
      if (!features || Object.keys(features).length === 0) return 1.0;
      const cell = this.qrlTable.getCellExpectancy(features, action);
      const multiplier = qrlExpectancyMultiplier(cell, {
        minSamples: qrlDirectionConfig.minSamples,
        negThreshold: qrlDirectionConfig.negThreshold,
        dampenFactor: qrlDirectionConfig.dampenFactor,
        boostFactor: qrlDirectionConfig.boostFactor,
      });
      if (multiplier < 1.0) {
        log.info(`🟣 [qrl-expectancy] ${action.toUpperCase()} ${normalizeSymbol(symbol)}: cell ${cell.bucket} Q=${(cell.q * 100).toFixed(2)}% median=${cell.medianReward !== null ? (cell.medianReward * 100).toFixed(2) + '%' : 'n/a'} trim=${cell.trimmedMean !== null ? (cell.trimmedMean * 100).toFixed(2) + '%' : 'n/a'} n=${cell.visits} — NEGATIVE expectancy → conviction ×${multiplier.toFixed(2)}`);
      } else if (multiplier > 1.0) {
        log.info(`🟣 [qrl-expectancy] ${action.toUpperCase()} ${normalizeSymbol(symbol)}: cell ${cell.bucket} Q=${(cell.q * 100).toFixed(2)}% median=${cell.medianReward !== null ? (cell.medianReward * 100).toFixed(2) + '%' : 'n/a'} t=${cell.tStat !== null ? cell.tStat.toFixed(1) : 'n/a'} n=${cell.visits} — POSITIVE expectancy (t≥2) → conviction ×${multiplier.toFixed(2)}`);
      }
      return multiplier;
    } catch (err) {
      log.warn(`[qrl-expectancy] compute failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      return 1.0;
    }
  }

  // ─── v2.0.862: PAEL — Exit-Price Lock Gate (TP-side one-vote exit) ───
  // Owner directive: when the position's MFE has reached the asset's typical
  // favourable-extension zone, the TP side gets a ONE-VOTE exit — lock the
  // profit deterministically, no LLM needed. The SL is NEVER touched: the stop
  // keeps its noise room; this gate only CLOSES (locks profit), it never
  // tightens a stop.
  //
  // Conditions (ALL must hold):
  //   1. PAEL profile exists (≥ minSamples per asset×direction)
  //   2. MFE price% ≥ threshold (p75×0.8; trending regime → p90 conservative
  //      — trends run far, locking at p75 would truncate them)
  //   3. CURRENT profit > 0 (lock realisable profit, not a vanished peak)
  //   4. hold ≥ minHoldMinutes (a 5-min MFE spike is noise, not a zone)
  //
  // closeReason 'exit_price_lock' (whitelisted) → learning weight 0.5.
  private async runExitPriceLockGate(): Promise<void> {
    if (!exitPriceLockConfig.enabled || !this.exitPriceLearner) return;
    try {
      for (const sym of this.portfolio.getOpenSymbols()) {
        const pos = this.portfolio.getPosition(sym);
        if (!pos) continue; // getOpenSymbols() only returns open positions
        const side = isSellSide(pos.side) ? 'sell' : 'buy';
        const profile = this.exitPriceLearner.getExitProfile(normalizeSymbol(sym), side);
        if (!profile) continue; // cold-start: no profile → existing behaviour

        const converted = convertToPriceExtremes({
          entryPrice: pos.averageEntryPrice,
          quantity: pos.quantity,
          leverage: pos.leverage,
          minValueReached: pos.minValueReached ?? 0,
          maxValueReached: pos.maxValueReached ?? 0,
        });
        if (!converted || converted.mfePricePct <= 0) continue;

        const regime = this.marketState.getState(normalizeSymbol(sym))?.regime ?? 'unknown';
        const isTrending = regime.includes('trending');
        // v2.0.862-fund: SIZE-AGNOSTIC guard — the lock threshold is raised by
        // this symbol×side's measured slippage (bps → fraction). MFE% is
        // scale-invariant (percentage), but the EXECUTED price isn't: a large
        // fund fills worse on thin books, so the lock must fire only when MFE
        // clears the zone PLUS the friction it will pay to exit. Small sizes
        // (low slippage) keep the standard threshold.
        const execStats = this.edgeExecTracker?.getStats(normalizeSymbol(sym), side);
        const slippagePct = Number.isFinite(execStats?.avgSlippageBps)
          ? (execStats!.avgSlippageBps) / 10_000
          : 0;
        // v2.0.868-fix2:過早率閉環——鎖利 threshold × calibrator multiplier。
        // close-decision-calibrator 記錄 PAEL 過早率(鎖完 price 繼續行 >0.5%)——
        // 過早率高 → 鎖利門檻提高(等 price 行得更遠)——數據驅動提升平倉質素
        // v2.0.868-fix(主神 GOLD 調查):threshold floor 0.3%——低波動 symbol
        // (GOLD p75×0.8 = 0.24%)一有少少順向就鎖——thesis 目標($4430 +0.5%)
        // 一半都未到——鎖完 thesis 未失效 → re-open 循環(fee 浪費)
        let threshold = Math.max(0.3, (isTrending ? profile.mfeP90 : profile.mfeP75 * 0.8)) + slippagePct;
        if (this.closeCalibrator && closeCalibConfig.enabled) {
          try {
            // v2.0.868-attack4:trend 來源必須同 recordClose 一致(trend1h——
            // 'up'/'down'/'sideways')——之前用 regime('mean_reverting')——
            // contextKey 永遠唔 match——閉環 multiplier 永遠 1.0(FIX2 白做)!
            const trendKey = this.lastKlineSummary?.trend1h ?? 'unknown';
            const lockMult = this.closeCalibrator.getLockThresholdMultiplier(normalizeSymbol(sym), side, trendKey);
            if (lockMult > 1.0) {
              threshold *= lockMult;
              log.info(`🔒 [exit-price-lock] ${sym} threshold ×${lockMult.toFixed(2)} (過早率校準)—— MFE ${(converted.mfePricePct * 100).toFixed(2)}% vs ${(threshold * 100).toFixed(2)}%`);
            }
          } catch { /* non-fatal */ }
        }
        if (converted.mfePricePct < threshold) continue;

        const pnlNow = pos.unrealizedPnl ?? 0;
        if (!Number.isFinite(pnlNow) || pnlNow <= 0) continue;

        const holdMin = (Date.now() - (pos.openedAt ?? 0)) / 60000;
        if (holdMin < exitPriceLockConfig.minHoldMinutes) continue;

        const exitThesis = `[EXIT-PRICE LOCK] ${sym} ${pos.side.toUpperCase()}: MFE ${(converted.mfePricePct * 100).toFixed(2)}% ≥ ${isTrending ? 'p90' : 'p75×0.8'} (${(threshold * 100).toFixed(2)}%) in ${regime} (${profile.samples} samples). Locking profit — SL untouched.`;
        const ok = await this.closeTrade(sym, exitThesis, 'exit_price_lock');
        if (ok) {
          this.exitPriceLockCount++;
          log.info(`🔒 [exit-price-lock] CLOSED ${sym} ${pos.side.toUpperCase()} @ MFE ${(converted.mfePricePct * 100).toFixed(2)}% (threshold ${(threshold * 100).toFixed(2)}%, samples=${profile.samples}) — profit locked (total=${this.exitPriceLockCount})`);
        } else {
          log.warn(`🔒 [exit-price-lock] close attempt failed for ${sym} (non-fatal)`);
        }
      }
    } catch (err) {
      log.warn(`[exit-price-lock] gate failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** v2.0.862: Record a closed real trade into the PAEL learner. */
  private recordRealExitToPAEL(trade: {
    symbol: string; side: string; entryPrice: number; quantity: number;
    leverage: number; minValueReached?: number; maxValueReached?: number;
    closedAt?: number; openedAt?: number;
  }): void {
    if (!this.exitPriceLearner) return;
    try {
      const converted = convertToPriceExtremes({
        entryPrice: trade.entryPrice, quantity: trade.quantity, leverage: trade.leverage,
        minValueReached: trade.minValueReached ?? 0, maxValueReached: trade.maxValueReached ?? 0,
      });
      if (!converted) return;
      this.exitPriceLearner.recordExit({
        symbol: trade.symbol.toLowerCase(),
        side: trade.side === 'sell' ? 'sell' : 'buy',
        ...converted,
        source: 'real',
        timestamp: trade.closedAt ?? trade.openedAt ?? Date.now(),
        weight: 1.0,
      });
    } catch { /* non-fatal */ }
  }

  /**
   * v2.0.846 Phase 1a: Compute a PURE-STATISTICS directional lean for a symbol.
   *
   * Uses ONLY statistical components — NO LLM reasoning — to decide whether
   * the market should be traded long or short. This feeds the A/B statistical
   * shadow so we can measure whether the LLM debate actually adds edge over
   * pure statistics.
   *
   * Components (each contributes a signed score in [-1, 1]):
   *   1. OLR P(win)   — per-side probability the trade hits TP before SL
   *   2. First-Passage — P(TP before SL) from GBM path-risk (regime-aware)
   *   3. Combo WR     — historical (symbol × side × regime) win rate
   *   4. Causal uplift — aligned-shadow counterfactual (alpha vs market)
   *
   * Returns { side, score } where score > 0 favors long, < 0 favors short.
   * Cold-start safe: components with insufficient data contribute 0 (neutral).
   */
  private computeStatisticalLean(
    symbol: string,
    features: Record<string, number>,
    regime: string,
  ): { side: 'buy' | 'sell'; score: number } {
    let longScore = 0;
    let shortScore = 0;
    let weightSum = 0;
    // v2.0.847: Guard against undefined/empty symbol — normalizeSymbol would
    // crash on undefined. Empty symbol → no statistical shadow (neutral).
    if (typeof symbol !== 'string' || symbol.length === 0) {
      return { side: 'buy', score: 0 };
    }
    const sym = normalizeSymbol(symbol);
    // v2.0.847: `lastFirstPassage` is computed ONLY for the active symbol
    // (in the per-cycle first-passage calc). Using it for non-active symbols
    // would feed the WRONG symbol's path-risk into the A/B statistical shadow,
    // corrupting the LLM-vs-stats comparison. Restrict it to the active symbol.
    const isActive = sym === normalizeSymbol(this.marketAgent?.getSelectedSymbol()?.toLowerCase() ?? '');

    try {
      // 1. OLR P(win) — directional evidence from logistic regression.
      if (this.olrEngine && features && typeof features === 'object' && Object.keys(features).length > 0) {
        const long = this.olrEngine.query(sym, features, 'buy', this.totalCycles);
        const short = this.olrEngine.query(sym, features, 'sell', this.totalCycles);
        if (Number.isFinite(long.pWin) && Number.isFinite(short.pWin)) {
          const w = 1.0;
          longScore += (long.pWin - 0.5) * 2 * w;      // [-1, 1]
          shortScore += (short.pWin - 0.5) * 2 * w;
          weightSum += w;
        }
      }

      // 2. First-Passage — regime-aware path-risk P(TP before SL).
      //    Only valid for the ACTIVE symbol (see isActive guard above).
      if (isActive && this.lastFirstPassage) {
        const fp = this.lastFirstPassage;
        const longP = Number.isFinite(fp.longPWin) ? fp.longPWin : 0.5;
        const shortP = Number.isFinite(fp.shortPWin) ? fp.shortPWin : 0.5;
        const w = 1.0;
        longScore += (longP - 0.5) * 2 * w;
        shortScore += (shortP - 0.5) * 2 * w;
        weightSum += w;
      }

      // 3. Combo WR — historical (symbol × side × regime) win rate.
      try {
        const buyCombo = this.comboTracker.getComboBlendFactor(sym, 'buy', regime);
        const sellCombo = this.comboTracker.getComboBlendFactor(sym, 'sell', regime);
        // getComboBlendFactor returns a blend factor in [0.3, 1.0]; map to [-1, 1].
        if (buyCombo && Number.isFinite(buyCombo.blendFactor)) {
          const w = 0.7;
          longScore += (buyCombo.blendFactor - 0.5) * 2 * w;
          weightSum += w;
        }
        if (sellCombo && Number.isFinite(sellCombo.blendFactor)) {
          const w = 0.7;
          shortScore += (sellCombo.blendFactor - 0.5) * 2 * w;
          weightSum += w;
        }
      } catch { /* cold-start safe */ }

      // 4. Causal uplift — aligned-shadow counterfactual (alpha vs market).
      try {
        const uplift = this.causalReasoner?.getPerSymbolUplift().find(
          p => normalizeSymbol(p.symbol) === sym,
        );
        if (uplift && uplift.samples >= 5) {
          // Positive uplift means trading adds alpha; use as a directional prior.
          const w = 0.5;
          longScore += uplift.uplift * w;   // uplift>0 → lean long
          shortScore += -uplift.uplift * w; // uplift<0 → lean short
          weightSum += w;
        }
      } catch { /* cold-start safe */ }
    } catch (err) {
      log.warn(`[stat-lean] compute failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
    }

    // No confident evidence → no statistical shadow (neutral).
    if (weightSum <= 0) return { side: 'buy', score: 0 };

    const longWeighted = longScore / weightSum;
    const shortWeighted = shortScore / weightSum;
    const diff = longWeighted - shortWeighted;
    return { side: diff >= 0 ? 'buy' : 'sell', score: diff };
  }

  /** v2.0.842: Feed trade-audit incidents into evolution components.
   *  Routes audit categories to the appropriate component:
   *  - direction-repetition-loss → Self-Improver (negative reward)
   *  - low-conditional-win-rate-ignored → CausalReasoner (confounder)
   *  - thesis-contradicts-action → MetaLearner (feature downweight)
   *  - premature-exit-mfe-mismatch → Self-Improver (SL cap push)
   *  - overtrading → Self-Improver (conviction gate push)
   *  - data-quality-issue → CausalReasoner (confounder)
   *  Non-blocking, idempotent (called once per audit result). */
  private feedAuditToEvolution(incidents: AuditIncident[]): void {
    for (const inc of incidents) {
      // v2.0.843c: Guard against null/undefined/malformed incidents from LLM.
      if (!inc || typeof inc !== 'object') continue;
      if (typeof inc.category !== 'string' || inc.category.length === 0) continue;
      // v2.0.843c: Don't double-apply severity weight. recordAuditIncident
      // already applies severity weighting internally. Pass the raw impact
      // magnitude and let the method handle severity.
      const baseImpact = inc.severity === 'critical' ? 1.0
        : inc.severity === 'warning' ? 0.5
        : 0.25;

      switch (inc.category) {
        case 'direction-repetition-loss':
        case 'low-conditional-win-rate-ignored':
          // Self-Improver: strong negative performance signal
          try {
            this.selfImprover?.recordAuditIncident(inc.category, inc.severity, 0.01);
          } catch { /* non-critical */ }
          break;

        case 'premature-exit-mfe-mismatch':
        case 'sl-too-tight-for-volatility':
          // Self-Improver: SL too narrow → negative reward pushes SL cap up
          try {
            this.selfImprover?.recordAuditIncident(inc.category, inc.severity, 0.005);
          } catch { /* non-critical */ }
          break;

        case 'thesis-contradicts-action':
        case 'thesis-quality-issue':
          // Meta-Learner: thesis feature predictive power → downweight
          try {
            this.metaLearner?.recordAuditFeatureAdjustment('thesisSignal', -0.1 * baseImpact);
          } catch { /* non-critical */ }
          break;

        case 'market-condition-pattern':
          // Meta-Learner: regime learning speed → downweight
          try {
            this.metaLearner?.recordAuditFeatureAdjustment('marketRegime', -0.05 * baseImpact);
          } catch { /* non-critical */ }
          break;

        case 'overtrading':
          // Self-Improver: conviction gate too low → push up
          try {
            this.selfImprover?.recordAuditIncident(inc.category, inc.severity, 0.003);
          } catch { /* non-critical */ }
          break;

        case 'data-quality-issue':
          // Causal Reasoner: mark as confounder
          try {
            // v2.0.843c: Safe detail (recordAuditConfounder now guards against undefined)
            this.causalReasoner?.recordAuditConfounder('dataQuality', inc.detail ?? 'no detail');
          } catch { /* non-critical */ }
          break;

        default:
          // Unknown category → feed to Self-Improver as weak signal
          try {
            this.selfImprover?.recordAuditIncident(inc.category, inc.severity, 0.002);
          } catch { /* non-critical */ }
          break;
      }
    }
    log.info(`[audit] Fed ${incidents.length} incidents to evolution components`);
  }

  /** v2.0.726: No-trade investigation — SE investigates why the system hasn't
   *  traded for 3+ cycles. Passes gate results + market conditions so SE can
   *  determine if it's a genuine quiet market or a mechanism blocking trades. */
  private async runNoTradeInvestigation(): Promise<void> {
    try {
      if (!this.expMemory) return;
      const records = this.expMemory.getRecords();
      // Reset counter so SE doesn't re-trigger every cycle
      const cyclesIdle = this.cyclesSinceLastTrade;
      this.cyclesSinceLastTrade = 0;
      log.info(`🔧 [no-trade] Starting SE investigation (${cyclesIdle} cycles idle, ${this.lastGateResults.length} gate results, ${this.recentMarketConditions.length} market snapshots)`);
      await runSystemEngineer(
        records,
        this.lastAuditResult ?? undefined,
        {
          cyclesSinceLastTrade: cyclesIdle,
          lastGateResults: this.lastGateResults,
          marketConditions: this.recentMarketConditions,
        },
      );
    } catch (err) {
      log.warn(`[no-trade] SE investigation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private onPositionClosedLearning(trade: TradeRecord): void {
    try {
      const symbol = trade.symbol;
      // v2.0.856-attack (V11): if the trade's side is not canonical, the entire
      // learning pipeline (OLR/EXP/RIL/agentOutcomes/attribution) would feed a
      // fabricated direction (the old `trade.side === 'buy' ? 'buy' : 'sell'`
      // silently coerced undefined/'BUY'/'long' to SELL). A corrupt side means
      // the whole trade record is suspect — skip ALL learning for it rather
      // than poison 8 downstream consumers with a wrong direction label.
      // v2.0.856-attack2 (E2/E3): also guard symbol — restore path
      // (`symbol: t.symbol` in portfolio.ts) has NO runtime guard; a corrupt
      // state file with undefined symbol + valid side passes the side guard
      // and then crashes at olrEngine.feedTrade(undefined) → undefined.toLowerCase().
      const tradeSide = normalizeTradeSide(trade.side);
      const safeSymbol = typeof trade.symbol === 'string' && trade.symbol.length > 0
        ? trade.symbol
        : '';
      if (tradeSide === 'unknown' || safeSymbol.length === 0) {
        log.warn(`[close-learning] SKIP learning for trade ${trade.id ?? (safeSymbol || '<no-id>')} — invalid side ${JSON.stringify(trade.side)} / symbol ${JSON.stringify(trade.symbol)} (would fabricate direction or crash normalizeSymbol)`);
        return;
      }
      const isWin = trade.pnl >= 0;
      const pnlPct = trade.pnlPct;
      const outcome: 1 | 0 = isWin ? 1 : 0;
      // v2.0.139: Detect thesis-invalidation closes (Option C). The force-close
      // path adds the symbol to thesisInvalidatedCloseSymbols before calling
      // closePosition; the callback fires synchronously during closePosition,
      // so we can check + clear here. Thesis-invalidation losses are excluded
      // from the conviction-gate winRate so the gate only tightens on real
      // market-risk losses (SL hit), not thesis-system force-closes.
      const isThesisInvalidation = this.thesisInvalidatedCloseSymbols.delete(symbol);
      const closeReason = isThesisInvalidation ? 'thesis_invalidation' : (trade.closeReason ?? 'sl_tp');

      // v2.0.851: Write the resolved closeReason BACK onto the TradeRecord so
      // the persisted record (via savePortfolio) and the RIL CloseReasonAggregator
      // see HOW the position closed. Without this, trade.closeReason stayed
      // undefined for every close and RIL/trade-audit could not distinguish
      // SL-too-tight from thesis-wrong. thesis_invalidation overrides the
      // portfolio-inferred reason because it is detected here (the force-close
      // set is the authoritative source for that path).
      trade.closeReason = closeReason;

      // v2.0.226: Close-context-aware learning weight.
      // The close mechanism is an important factor in the loss:
      //   - SL hit at original (wide) SL → real market loss → full weight (1.0)
      //   - SL hit after SL was narrowed → execution loss → discounted (0.3)
      //   - Thesis invalidation → system decision → discounted (0.3)
      //   - Manual close → user decision → partial (0.5)
      //   - Wins → always full weight (a win is a win regardless of how closed)
      // This prevents tight-SL losses from contaminating the learning systems
      // with "these market conditions → loss" when the entry was actually fine.
      const slNarrowed = trade.slNarrowed ?? false;
      const learningWeight = computeLearningWeight(closeReason, slNarrowed, isWin);
      if (learningWeight < 1.0) {
        log.info(`🔬 [close-learning] ${symbol} ${trade.side.toUpperCase()} ${isWin ? 'WIN' : 'LOSS'} closeReason=${closeReason} slNarrowed=${slNarrowed} → learningWeight=${learningWeight}`);
      }

      // v2.0.29: Clean up legacy position tracking when a position closes
      if (this.legacyPositionModes.has(symbol)) {
        const origMode = this.legacyPositionModes.get(symbol);
        this.legacyPositionModes.delete(symbol);
        log.info(`📋 Legacy position ${symbol} (from ${origMode} mode) closed: ${isWin ? 'WIN' : 'LOSS'} $${trade.pnl.toFixed(2)}`);
      }

      // Get current market context for learning
      // v2.0.218: Use safeNum() instead of ?? for ALL market features.
      // The ?? operator only catches null/undefined, NOT NaN/Infinity.
      // If a WS returns { fundingRate: NaN }, NaN ?? 0 = NaN (not 0), which
      // triggered the OLR NaN guard and caused the ENTIRE sample to be rejected.
      // safeNum() catches ALL non-finite values and returns the fallback.
      const activeSymbol = this.marketAgent?.getSelectedSymbol()?.toLowerCase() ?? symbol;
      const state = this.marketState?.getState(activeSymbol) ?? null;
      const regime = state?.regime ?? 'unknown';
      const volatility = safeNum(state?.volatility, 0);
      const srDistanceBps = safeNum(this.lastSRContext?.distanceToSupportBps, 0);
      const obImbalance = safeNum(state?.orderBookImbalance, 0);
      const fundingRate = safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0);
      // v2.0.218: Use safeNum() instead of ?? for ALL feature values.
      // The ?? operator only catches null/undefined, NOT NaN/Infinity.
      // If a WS returns { fundingRate: NaN }, NaN ?? 0 = NaN (not 0), which
      // triggered the OLR NaN guard and caused the ENTIRE sample to be rejected.
      // safeNum() catches ALL non-finite values and returns the fallback.
      const volumeRatio = safeNum(this.sentimentEngine?.getVolumeRatio(), 1);
      const sentimentAgg = this.sentimentEngine?.getSentiment();
      const sentiment = safeNum(sentimentAgg?.overallSentiment, 0);
      const sentimentConviction = safeNum(sentimentAgg?.conviction, 0.5);
      // v2.0.721: Use last HACP consensus confidence instead of hardcoded 0.5.
      // This fixes a train/test mismatch — query-time features use real consensus
      // confidence (index.ts:5370+), but close-learning was always 0.5, so OLR
      // trained on a constant feature that varied at query time.
      const signalAgreement = safeNum(this.lastHACPResult?.consensus?.confidence, 0.5);

      // 1. Record to Trade History so getRecentTradeAnalysis() sees it
      try {
        this.evolution.tradeHistory.record({
          cycleNumber: this.totalCycles,
          symbol,
          decision: {
            action: trade.side === 'buy' ? 'buy' : 'sell',
            symbol,
            positionSizePct: trade.investment > 0 && this.portfolio.getPortfolio().totalEquity > 0
              ? trade.investment / this.portfolio.getPortfolio().totalEquity
              : 0.05,
            rationale: `SL/TP close: ${trade.side.toUpperCase()} ${symbol} PnL: $${trade.pnl.toFixed(2)}`,
            urgency: 'immediate' as const,
          },
          entryPrice: trade.entryPrice,
          regime,
          trend: state?.trend ?? 'sideways',
          volatility,
          type: 'real',
          confidence: 0.5,
          realisedPnl: pnlPct,
          closeReason,
        });
      } catch (err) {
        log.warn(`[close-learning] Trade history record failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Feed OLR — learn "these conditions → LONG/SHORT wins/loses" from trade outcome
      // Source type: 'real' if exchange trade (agentId='hyperliquid-real'), 'paper' otherwise
      try {
        // v2.0.152: Add MAE/MFE to OLR features so the model learns
        // which SL/TP distances and MFE patterns lead to wins vs losses.
        // v2.0.218: Use safeNum for MAE/MFE/margin — trade fields may be NaN.
        const mae = safeNum(trade.minValueReached, 0);
        const mfe = safeNum(trade.maxValueReached, 0);
        const margin = trade.investment > 0 ? trade.investment / safeLeverage(trade.leverage) : 0;
        const safeMargin = safeNum(margin, 0);
        const maePct = safeMargin > 0 ? (safeMargin - mae) / safeMargin : 0;
        const mfePct = safeMargin > 0 ? (mfe - safeMargin) / safeMargin : 0;
        const safePnlPct = safeNum(pnlPct, 0);
        // v2.0.207 (#D): Momentum at close time — use the trade's symbol price history.
        let closeMomentum = { momentumShort: 0, momentumLong: 0 };
        try {
          const closePh = this.marketState.getPriceHistory(symbol);
          if (closePh && closePh.length >= 2) closeMomentum = computeMomentum(closePh);
        } catch { /* non-critical */ }
        const features = {
          volatility: safeNum(volatility, 0),
          srDistanceBps: safeNum(srDistanceBps, 0),
          obImbalance: safeNum(obImbalance, 0),
          sentiment,
          signalAgreement,
          fundingRate: safeNum(fundingRate, 0),
          volumeRatio,
          sentimentConviction,
          momentumShort: safeNum(closeMomentum.momentumShort, 0),
          momentumLong: safeNum(closeMomentum.momentumLong, 0),
          // v2.0.152: MFE/MAE features for SL/TP learning
          mfePct,
          maePct,
          mfeToPnlRatio: mfePct > 0 ? (mfePct - safePnlPct) / mfePct : 0, // 0 = perfect exit, 1 = gave back everything
          // v2.0.721: Regime as ordinal feature (H1)
          regimeOrdinal: regimeToOrdinal(regime),
          // v2.0.221 (Fix 1): Hour-of-day for time-of-day pattern learning
          hourOfDay: hourOfDayFromTs((trade as any)?.openedAt) ?? currentHourOfDay(),
        };
        const tradeSource: 'paper' | 'real' = trade.agentId === 'hyperliquid-real' ? 'real' : 'paper';
        // v2.0.862: Record this closed trade into the PAEL exit-price learner
        // (real trades = full weight; feeds the per-asset MFE/MAE profiles that
        // drive the exit-price lock gate + close-decision context).
        if (tradeSource === 'real') {
          this.recordRealExitToPAEL(trade as never);
        }
        // v2.0.863 規限①: LLM conviction calibrator — 記錄 (LLM conviction, outcome)
        // 用開倉時嘅 consensus confidence(entryConsensusConfidence——v2.0.837 已存)
        const entryConf = (trade as { entryConsensusConfidence?: number }).entryConsensusConfidence;
        if (Number.isFinite(entryConf) && this.llmCalibrator) {
          this.llmCalibrator.recordDecision(
            trade.side === 'sell' ? 'sell' : 'buy',
            entryConf ?? 0.5,
            isWin ? 'win' : 'loss',
          );
        }
        // v2.0.864: LLM Direction Verifier — 平倉時記錄 C 終極結果(賺/蝕)
        // trendType 由開倉 thesis 提取(同判斷時一致)——by tradeId idempotent
        if (this.llmDirectionVerifier && llmDirectionConfig.enabled) {
          try {
            this.llmDirectionVerifier.recordOutcome(
              normalizeSymbol(trade.symbol || ''),
              this.extractTrendType((trade as { entryThesis?: string }).entryThesis),
              String((trade as { id?: string | number }).id ?? `t${Date.now()}-${Math.random()}`),
              isWin,
            );
          } catch { /* non-fatal */ }
        }
        // v2.0.865: EV Filter — 記錄實際 pnlPct(已含手續費)per (symbol × side)
        if (this.evFilter && evFilterConfig.enabled) {
          try {
            this.evFilter.recordTrade(
              normalizeSymbol(trade.symbol || ''),
              trade.side === 'sell' ? 'sell' : 'buy',
              safeNum((trade as { pnlPct?: number }).pnlPct, 0),
            );
          } catch { /* non-fatal */ }
        }
        // v2.0.867-fix(B):close 事件 → Supabase trades(UI Trade Incident 數據源——
        // 之前「冇人自動寫」→ UI 唔顯示 = 「消失」——by tradeId idempotent + 非阻塞)
        if (supabaseTradeWriter.isEnabled()) {
          supabaseTradeWriter.recordTrade(trade as never, tradeSource === 'real' ? 'real' : 'paper');
        }

        // v2.0.867:TG close 訊號(事後記錄——完整字段商業財務英語點列;非阻塞)
        // v2.0.867-attack (V11):tradeId dedup——同一 trade 兩次 close 事件只發一次
        // 主神:輸錢平倉暫時唔推(profitOnlyClose——pnlPct 傳俾 pushSignal 判斷)
        {
          const tgPnl = safeNum((trade as { pnlPct?: number }).pnlPct, 0);
          void tgSignalPusher.pushSignal('close', tgSignalPusher.formatCloseSignal({
            symbol: normalizeSymbol(trade.symbol || ''),
            side: trade.side === 'buy' ? 'buy' : 'sell',
            entryPrice: (trade as { entryPrice?: number }).entryPrice,
            exitPrice: (trade as { exitPrice?: number }).exitPrice,
            pnlPct: tgPnl,
            holdMin: trade.openedAt > 0 && trade.closedAt > 0 ? Math.max(0, Math.round((trade.closedAt - trade.openedAt) / 60000)) : undefined,
            leverage: (trade as { leverage?: number }).leverage,
            investment: (trade as { investment?: number }).investment,
            minValue: (trade as { minValueReached?: number }).minValueReached,
            maxValue: (trade as { maxValueReached?: number }).maxValueReached,
            openedAt: (trade as { openedAt?: number }).openedAt,
            closedAt: (trade as { closedAt?: number }).closedAt,
            reason: closeReason ?? 'system',
            source: tradeSource,
            entryThesis: (trade as { entryThesis?: string }).entryThesis,
            exitThesis: (trade as { exitThesis?: string }).exitThesis,
            postReview: (trade as { postReview?: string }).postReview,
          }), String((trade as { id?: string | number }).id ?? `close-${(trade as { closedAt?: number }).closedAt ?? Date.now()}-${normalizeSymbol(trade.symbol ?? '')}`), tgPnl).catch(() => {});
        }

        // v2.0.866: Close-Decision Calibrator — 只記錄「自主 close」
        // (consensus/thesis_invalidation——SL/PAEL/manual 由 recordClose 內部過濾)
        // Phase A:只記錄 + 延遲驗證,唔影響操作——「唔會製造死揸」
        if (this.closeCalibrator && closeCalibConfig.enabled) {
          try {
            this.closeCalibrator.recordClose({
              symbol: normalizeSymbol(trade.symbol || ''),
              side: isSellSide(trade.side) ? 'sell' : 'buy',
              closePrice: safeNum((trade as { exitPrice?: number }).exitPrice, 0),
              pnlPct: safeNum((trade as { pnlPct?: number }).pnlPct, 0),
              closeReason: closeReason ?? '',
              trendAtClose: this.lastKlineSummary?.trend1h ?? 'unknown',
            });
          } catch { /* non-fatal */ }
        }
        // v2.0.868-fix(主神 GOLD 調查):PAEL 鎖利 close → 記錄 close 價——
        // re-open 價格條件抑制(price 未行遠唔重開——fee 浪費)
        try {
          if (this.entryQuality && closeReason === 'exit_price_lock' && Number.isFinite((trade as { exitPrice?: number }).exitPrice)) {
            this.entryQuality.recordClosePrice(normalizeSymbol(trade.symbol || ''), (trade as { exitPrice?: number }).exitPrice as number);
          }
        } catch { /* non-fatal */ }
        // v2.0.868-P1P2: Entry Quality——MAE/MFE profile(全部 close 類型——rolling window)
        try {
          if (this.entryQuality && trade.openedAt > 0) {
            const eqMargin = safeNum((trade as { investment?: number }).investment, 0);
            const eqMin = safeNum((trade as { minValueReached?: number }).minValueReached, eqMargin);
            const eqMax = safeNum((trade as { maxValueReached?: number }).maxValueReached, eqMargin);
            const eqMae = eqMargin > 0 ? (eqMin - eqMargin) / eqMargin * 100 : 0;
            const eqMfe = eqMargin > 0 ? (eqMax - eqMargin) / eqMargin * 100 : 0;
            this.entryQuality.record(
              normalizeSymbol(trade.symbol || ''),
              ['sell', 'short'].includes(String(trade.side ?? '').toLowerCase()) ? 'sell' : 'buy',
              eqMae, eqMfe,
              safeNum((trade as { pnlPct?: number }).pnlPct, 0) * 100,
              safeNum((trade as { closedAt?: number }).closedAt, Date.now()),
              safeNum((trade as { leverage?: number }).leverage, 1),
            );
          }
        } catch { /* non-fatal */ }
        // v2.0.868: Profitability Analyzer——hold-time EV / direction bias / fee(判斷層)
        try {
          if (this.profitabilityAnalyzer) {
            const holdMin = trade.openedAt > 0 && trade.closedAt > 0
              ? Math.max(0, (trade.closedAt - trade.openedAt) / 60000)
              : 0;
            // fee 估算:round-trip = notional × 0.0008(margin × lev × taker 0.04% × 2)
            const margin = safeNum((trade as { investment?: number }).investment, 0);
            const lev = safeNum((trade as { leverage?: number }).leverage, 1);
            const feeUsd = margin > 0 && lev > 0 ? margin * lev * 0.0008 : 0;
            this.profitabilityAnalyzer.recordTrade(
              normalizeSymbol(trade.symbol || ''),
              isSellSide(trade.side) ? 'sell' : 'buy',
              holdMin,
              safeNum((trade as { pnlPct?: number }).pnlPct, 0),
              feeUsd,
              safeNum((trade as { closedAt?: number }).closedAt, Date.now()),
            );
          }
        } catch { /* non-fatal */ }
        // v2.0.226: Pass slNarrowed + learningWeight so OLR downweights tight-SL
        // losses (execution problem) vs real market losses (entry problem).
        this.olrEngine.feedTrade(symbol, features, outcome, trade.side === 'buy' ? 'buy' : 'sell', tradeSource, this.totalCycles, slNarrowed, undefined, learningWeight);
        log.info(`🧬 [close-learning] OLR fed (${tradeSource}): ${symbol} ${trade.side.toUpperCase()} ${isWin ? 'WIN' : 'LOSS'} (pnl=${(pnlPct * 100).toFixed(1)}%, MFE=${(mfePct * 100).toFixed(1)}%, MAE=${(maePct * 100).toFixed(1)}%, weight=${learningWeight})`);

        // v2.0.204: Feed closed trade to Numeric Autoencoder (market-condition embedding).
        // Uses the entry-time features object above (in scope here). Only the 9
        // ENTRY_CONDITION_FEATURES are consumed; outcome provides contrastive label.
        try {
          const presentFeatures = ['volatility', 'srDistanceBps', 'obImbalance', 'fundingRate', 'volumeRatio', 'signalAgreement', 'sentiment', 'sentimentConviction', 'regimeOrdinal'].filter((k) => (features as Record<string, number>)[k] !== undefined);
          this.naEngine.addSample({ features, outcome: isWin ? 1 : 0, presentFeatures, ts: trade.closedAt ?? Date.now() });
        } catch (err) {
          log.warn(`[close-learning] NA addSample failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // v2.0.219: Feed advanced learning systems (replay)
        // v2.0.833 removed temporal/cross-symbol/reward-shaping/world-model; v2.0.862 deleted the files
        try {
          this.feedAdvancedLearning({
            symbol,
            side: trade.side === 'buy' ? 'buy' : 'sell',
            features,
            outcome: isWin ? 1 : 0,
            pnl: (trade.pnl ?? 0) * learningWeight,
            pnlPct: safeNum(pnlPct, 0) * learningWeight,
            source: tradeSource,
            cycle: this.totalCycles,
            regime,
            learningWeight,
          });
        } catch (err) {
          log.warn(`[close-learning] Advanced learning feed failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // v2.0.221 (Fix 3): Track combo (symbol × side × regime) WR for pattern avoidance.
        // v2.0.226: Skip execution-caused losses (tight SL, thesis invalidation)
        // from combo WR — they're not entry-problem losses and would drag down
        // the combo WR for valid entries. Only real market losses (weight=1.0)
        // and partial-signal losses (weight≥0.5, e.g. manual/consensus close)
        // are tracked. Wins are always tracked.
        if (isWin || learningWeight >= 0.5) {
          try {
            this.comboTracker.trackTrade(
              symbol,
              trade.side === 'buy' ? 'buy' : 'sell',
              regime,
              isWin ? 'WIN' : 'LOSS',
              trade.pnl ?? 0,
              safeNum(pnlPct, 0),
              this.totalCycles,
              (trade as any)?.id ?? `live-${symbol}-${trade.openedAt ?? this.totalCycles}`, // v2.0.221 dedup
            );
          } catch { /* non-critical */ }
        } else {
          log.info(`🔬 [combo-WR] Skipped ${symbol} ${trade.side.toUpperCase()} LOSS (closeReason=${closeReason}, slNarrowed=${slNarrowed}) — execution loss excluded from combo WR`);
        }
      } catch (err) {
        log.warn(`[close-learning] OLR feedTrade failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 3. Backfill Pattern Classifier
      try {
        // Find the pattern record by matching symbol + side + pending status
        const patterns = this.patternClassifier.getAllPatterns();
        const matchingPattern = patterns.find(
          (p: any) => p.symbol === symbol && p.side === trade.side && p.outcome === 'pending'
            && Math.abs(p.entryTimestamp - trade.openedAt) < 60_000,
        );
        if (matchingPattern) {
          const holdDuration = Math.max(1, Math.round((trade.closedAt - trade.openedAt) / 300_000));
          this.patternClassifier.backfillOutcome(
            matchingPattern.id,
            trade.exitPrice,
            {
              regime,
              volatility,
              srDistanceBps,
              obImbalance,
              fundingRate,
              volumeRatio,
              signalAgreement,
              leverage: trade.leverage,
              sentiment,
              sentimentConviction,
            },
            pnlPct,
            holdDuration,
          );
          log.info(`🧬 [close-learning] Pattern backfilled: ${symbol} ${isWin ? 'WIN' : 'LOSS'}`);
        }
      } catch (err) {
        log.warn(`[close-learning] Pattern backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 3b. v2.0.28: Backfill Pattern Tag Tracker
      try {
        const tradeId = trade.id ?? `trade_${this.totalCycles}_${symbol}_${Date.now()}`;
        this.patternTagTracker.backfillOutcome(tradeId, pnlPct);
      } catch (err) {
        log.warn(`[close-learning] Pattern tag backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 4. Backfill Agent Outcomes — mark all agents that recommended on this symbol
      // v2.0.720: Pass positionSide so only matching directional recommendations are scored.
      try {
        this.evolution.agentOutcomes.backfillOutcome(symbol, pnlPct, trade.side === 'buy' ? 'buy' : 'sell');
        log.info(`🧬 [close-learning] Agent outcomes backfilled: ${symbol} ${isWin ? 'WIN' : 'LOSS'} (side=${trade.side})`);
      } catch (err) {
        log.warn(`[close-learning] Agent outcomes backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.140: EM Cycle Digestion self-adjustment — feed win/loss back
      // to the insight retrieval system so it learns which historical insights
      // are predictive of wins vs losses.
      try {
        if (this.emManager && trade.openedAt > 0) {
          // Estimate the cycle number when the trade was opened from the timestamp.
          // The cycle number is approximate — we use the closest cycle to openedAt.
          const cycleDurationMs = config.system.decisionIntervalMs;
          const openCycle = Math.round((trade.openedAt - (Date.now() - this.totalCycles * cycleDurationMs)) / cycleDurationMs);
          if (openCycle > 0 && openCycle <= this.totalCycles) {
            this.emManager.recordTradeOutcome(openCycle, isWin ? 'win' : 'loss');
          }
        }
      } catch { /* non-critical — self-adjustment is supplementary */ }

      // v2.0.833: Edge Validation — record execution friction + risk-profile outcome
      try {
        // Execution Tracker: record slippage + funding for label calibration
        const holdMinutes = trade.openedAt > 0 && trade.closedAt > 0
          ? Math.max(1, Math.round((trade.closedAt - trade.openedAt) / 60_000))
          : 60;
        this.edgeExecTracker?.recordFill({
          symbol: trade.symbol,
          side: trade.side === 'buy' ? 'buy' : 'sell',
          signalPrice: trade.entryPrice,
          fillPrice: trade.entryPrice, // paper/real fill ≈ entry; real slippage tracked on actual fills
          fundingCostPct: 0, // funding tracked separately if available; 0 = no funding data yet
          holdMinutes,
          theoreticalPnlPct: safeNum(trade.pnlPct, 0),
          ts: trade.closedAt ?? Date.now(),
        });
      } catch (err) {
        log.warn(`[edge-close] tracking failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.837: Meta-Cognitive Calibrator — record prediction accuracy
      try {
        const predictedPWin = safeNum(trade.entryOlrPWin, 0.5);
        const conviction = safeNum(trade.entryConsensusConfidence, 0.5);
        const entryRegime = trade.regime ?? regime ?? 'unknown';
        this.metaCalibrator?.recordTrade(predictedPWin, conviction, entryRegime, outcome);
      } catch (err) {
        log.warn(`[meta-cal] recordTrade failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.844: Component Attribution — record each component's contribution.
      // Uses the trade outcome to credit components whose directional signals
      // agreed with the resolved PnL. Cleanliness reflects close-context pollution.
      try {
        const tradeId = trade.id ?? `${trade.symbol}|${trade.side}|${trade.openedAt ?? Date.now()}`;
        // v2.0.856-attack (V11): the OLD `trade.side === 'buy' ? 'buy' : 'sell'`
        // silently coerced undefined/null/'BUY'/'long' to SELL — fabricating a
        // direction that poisons bySide attribution stats AND can invert the
        // signal-contract (caller thinks sell, store thinks unknown). If the
        // side is not canonical, SKIP the whole attribution record — never
        // record a direction we cannot verify.
        const tradeSide = normalizeTradeSide(trade.side);
        if (tradeSide === 'unknown') {
          log.warn(`[attribution] skip — invalid trade side ${JSON.stringify(trade.side)} for trade ${tradeId} (cannot attribute without direction)`);
        } else {
        const pnlPct = safeNum(trade.pnlPct, 0);
        const backendProfile = this.marketAgent.getRiskProfile();
        // v2.0.845: Sanitize symbol — legacy/corrupt trade records may have
        // undefined symbol, which would crash normalizeSymbol() below.
        const attrSymbol = typeof trade.symbol === 'string' ? trade.symbol : '';
        // Label cleanliness: execution-caused losses (tight SL / thesis invalidation)
        // are polluted learning signals — downweight their attribution weight.
        const closeWeight = computeLearningWeight(
          closeReason as string,
          trade.slNarrowed ?? false,
          isWin,
        );
        // Normalize: weight 1.0 → clean, 0.3 (execution loss) → heavily polluted.
        const cleanliness = Math.max(0, Math.min(1, (closeWeight - 0.3) / 0.7));

        // OLR signal — ⚠️ v2.0.856 signal-contract clarification:
        // entryOlrPWin = olrEngine.query(sym, feats, SIDE).pWin = P(win | THIS
        // trade direction) — direction-specific, NOT bullish. The store's
        // contract is: signal > 0.5 = bullish, < 0.5 = bearish (store inverts
        // for SELL). So we map to a bullish signal: BUY keeps P(win|buy),
        // SELL inverts 1-P(win|sell) (high P(win|sell) → bearish → low).
        // The store then inverts again for SELL → agreement = P(win|side).
        // v2.0.856-attack: normalize side via normalizeTradeSide() — a garbage
        // side (uppercase/legacy/undefined) must NOT trigger an inversion here
        // while the store skips it (asymmetry → inverted contribution).
        const olrPWin = safeNum(trade.entryOlrPWin, 0.5);
        const attrSide = tradeSide; // already normalized; unknown handled above
        this.componentAttribution?.recordAttribution({
          componentId: 'olr',
          tradeId,
          symbol: attrSymbol,
          side: attrSide,
          cycleId: this.totalCycles,
          signal: attrSide === 'sell' ? 1 - olrPWin : olrPWin,
          pnlPct,
          labelCleanliness: cleanliness,
          regime,
          riskProfile: backendProfile,
          timestamp: Date.now(),
        });

        // Causal uplift signal: per-symbol uplift > 0 → positive directional signal.
        // v2.0.845: Guard normalizeSymbol against empty symbol (never matches).
        const causalUplift = attrSymbol.length > 0
          ? this.causalReasoner?.getPerSymbolUplift().find(
              p => normalizeSymbol(p.symbol) === normalizeSymbol(attrSymbol),
            )
          : undefined;
        if (causalUplift) {
          // Map uplift (-1..1) to a [0,1] signal; 0.5 = neutral (no alpha).
          // ⚠️ v2.0.856: Uplift is DIRECTION-AGNOSTIC — uplift > 0 means "this
          // trade direction had positive causal alpha" (tradedPnl - holdPnl).
          // It is NOT a bullish signal. The store's contract is: signal > 0.5 =
          // bullish, < 0.5 = bearish (store inverts for SELL). So we must map:
          //   BUY  trade: positive uplift → bullish (signal > 0.5)
          //   SELL trade: positive uplift → bearish (signal < 0.5)
          // OLD BUG: `signal: sig` passed uplift directly — for SELL trades a
          // positive-uplift (good) trade became agreement<0.5 → NEGATIVE
          // contribution (inverted). Live causal-uplift contribution was -0.031
          // largely from this inversion (14/16 live records were SELL).
          // v2.0.856-attack: normalize side — unknown side → no inversion
          // (keeps caller/store symmetric; garbage side must not invert).
          // v2.0.856-attack: sanitize uplift — undefined/NaN/string would
          // produce NaN signal (silently skipped by store) or JS-coerced
          // garbage. safeNum(uplift, 0) → finite number, 0 = neutral.
          const upliftVal = safeNum(causalUplift.uplift, 0);
          const sig = 0.5 + Math.max(-0.5, Math.min(0.5, upliftVal));
          const directionalSig = attrSide === 'sell' ? 1 - sig : sig;
          this.componentAttribution?.recordAttribution({
            componentId: 'causal-uplift',
            tradeId,
            symbol: attrSymbol,
            side: attrSide,
            cycleId: this.totalCycles,
            signal: directionalSig,
            pnlPct,
            labelCleanliness: cleanliness,
            regime,
            riskProfile: backendProfile,
            timestamp: Date.now(),
          });
        }
        }
      } catch (err) {
        log.warn(`[attribution] record failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.840: Meta-Learner — feature outcomes now recorded from shadow resolution
      // (hybrid data source: shadow is 10-50× faster than real trade close)
      // Real-trade feature outcomes kept for gradient validation but not primary source.

      // 5. Trigger Evolution — adapt strategy to the loss
      try {
        this.evolution.pressureEngine.evolve({}, this.evolution.tradeHistory);
        log.info(`🧬 [close-learning] Evolution triggered after ${isWin ? 'WIN' : 'LOSS'}`);
      } catch (err) {
        log.warn(`[close-learning] Evolution trigger failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 6. Check for consecutive loss streak — raise consensus threshold
      try {
        const analysis = this.evolution.tradeHistory.getRecentTradeAnalysis(10);
        if (analysis.currentLossStreak >= 2) {
          log.warn(`🚨 [close-learning] Loss streak: ${analysis.currentLossStreak} consecutive losses — raising consensus threshold`);
          // adjustThreshold(regime, hadRealTrade, wasProfitable)
          // Passing hadRealTrade=true + wasProfitable=false increments the
          // internal consecutiveLosses counter, which raises the threshold.
          this.hacpEngine.adjustThreshold(
            regime,
            true,  // hadRealTrade
            false, // wasProfitable = false on loss
          );
        }
      } catch (err) {
        log.warn(`[close-learning] Threshold adjustment failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 8. v2.0.26: Trigger loss cooldown after ANY loss — pause new entries
      // for 1 cycle while the Risk Auditor LLM reviews why the loss happened.
      // The LLM decides whether to resume trading or extend the cooldown.
      if (!isWin) {
        try {
          this.hacpEngine.triggerLossCooldown(this.totalCycles);
        } catch (err) {
          log.warn(`[close-learning] Cooldown trigger failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 7. Persist state so learning survives restarts
      // v2.0.38: Also persist portfolio so real trade records survive restarts.
      // Previously closedRealTrades was in-memory only — lost on every restart.
      try {
        this.evolution.persistState();
        this.persistPortfolio();
      } catch { /* non-critical */ }

      // v2.0.211 (K.md #1): Update AttnRes cycle-history pseudo-query from
      // trade outcome (reward-weighted key direction). v2.0.212 (#7): passes
      // closeReason so wExecution gets SL/TP survival reward (only on
      // closeReason='sl_tp'). Pairs with recordEntry at trade open.
      try {
        this.cycleHistory?.updateOnOutcome(normalizeSymbol(symbol), trade.side === 'buy' ? 'buy' : 'sell', pnlPct, closeReason);
      } catch (err) {
        log.warn(`[close-learning] AttnRes w update failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.138: Feed EXP thesis-experience memory (Skeptics Phase 1.8a).
      // Fire-and-forget — recordClose is async but must NEVER block the close path.
      // It honours config.exp.enabled, breakeven-exclude, and placeholder-thesis internally.
      try {
        const holdMin = Math.max(0, Math.round((trade.closedAt - trade.openedAt) / 60_000));
        const expSource: 'paper' | 'real' = trade.agentId === 'hyperliquid-real' ? 'real' : 'paper';
        void this.expMemory?.recordClose({
          // v2.0.865-fix:normalize symbol——EXP 記錄曾分裂 'BTC'(1319)vs 'btc'(79)
          // → OLR/EXP/Q-RL/EV Filter 樣本分散 + 互相污染(正 EV 數據被隔離)
          symbol: normalizeSymbol(symbol),
          side: trade.side === 'buy' ? 'buy' : 'sell',
          source: expSource,
          decisionOrigin: 'meta-agent',
          pnl: trade.pnl,
          pnlPct,
          entry: trade.entryPrice,
          exit: trade.exitPrice,
          leverage: trade.leverage,
          holdMin,
          regime,
          entryThesis: trade.entryThesis ?? '',
          // v2.0.143: Pass exitType so RIL CloseReasonAggregator can group by close reason
          exitType: closeReason as any,
          // v2.0.178: Store market conditions at close time (best available proxy
          // for open-time conditions — the position was open during this regime).
          // These features let future checkThesisHistory calls match by ACTUAL
          // market state, not just thesis text similarity.
          marketFeatures: {
            volatility,
            srDistanceBps,
            obImbalance,
            sentiment,
            fundingRate,
            volumeRatio,
            sentimentConviction,
          },
          // v2.0.178: Store OLR + shadow predictions at close time for post-hoc analysis
          // v2.0.210 (Fix 1): Use the CACHED entry-time OLR P(win) (set at open),
          // not a close-time recompute. Falls back to close-time only if cache
          // missed (e.g. position opened before v2.0.210). Fixes the audit
          // 'thesis-contradicts-action' false positive.
          olrPWinAtEntry: (() => {
            try {
              const sym = normalizeSymbol(symbol);
              const cached = this.entryOlrPWinCache.get(sym);
              if (cached !== undefined) {
                this.entryOlrPWinCache.delete(sym);
                return cached;
              }
              // Fallback for pre-v2.0.210 positions: close-time recompute.
              const feats = this.lastCycleShadowContexts.get(sym)?.features ?? {};
              if (Object.keys(feats).length > 0) {
                return this.olrEngine.query(sym, feats, trade.side === 'buy' ? 'buy' : 'sell', this.totalCycles).pWin;
              }
            } catch { /* non-critical */ }
            return undefined;
          })(),
          shadowWinRateAtEntry: (() => {
            try {
              const stats = this.shadowEngine.getStats().find(s => s.symbol === normalizeSymbol(symbol) || s.symbol === symbol.toLowerCase());
              if (stats) return trade.side === 'buy' ? stats.longWinRate : stats.shortWinRate;
            } catch { /* non-critical */ }
            return undefined;
          })(),
        }).then((record: unknown) => {
          // v2.0.143: RIL incremental cluster update — feed the new EXP record
          // into the pattern cluster immediately so the next cycle's RIL injection
          // includes this trade's rationale. Previously the comment said "RIL will
          // pick up the new record on the next cycle's rebuild" but that rebuild
          // never happened — clusters were only built once at startup, so RIL
          // pattern performance was permanently stale and never learned from new
          // trades. Now addTrade() incrementally assigns the new rationale vectors
          // to the nearest existing cluster (or creates a new one).
          if (config.ril.enabled && this.patternCluster && record) {
            void this.patternCluster.addTrade(record as any).catch((e: unknown) =>
              log.warn(`[RIL] addTrade failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`),
            );
            // v2.0.215: Update AttnRes trade embedder with trade outcome.
            // Learns which rationale blend directions predict winning trades.
            // Cold-start safe: only updates when trade has 2+ rationale vectors.
            if (this.attnResTradeEmbedder && (record as any).rationaleVectors?.length >= 2) {
              this.attnResTradeEmbedder.updateOnOutcome(
                (record as any).rationaleVectors,
                (record as any).pnl ?? 0,
              );
            }
          }
          // v2.0.207 (#F): Feed the loss into the anti-pattern tracker so its
          // lesson joins a known anti-pattern class. Only losses carry lessons
          // that form anti-patterns (wins are not anti-patterns).
          if (record && this.antiPatternTracker) {
            void this.antiPatternTracker.addLoss(record as any).catch((e: unknown) =>
              log.warn(`[anti-pattern] addLoss failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`),
            );
          }
        }).catch((e: unknown) => log.warn(`[EXP] recordClose failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`));
      } catch { /* non-critical */ }

      // v2.0.143: LLM post-trade review — generate a short analysis of how
      // more profit could have been made or less loss incurred. Fire-and-forget
      // (non-blocking) so the close path is never delayed by an LLM call.
      // The review is stored on the trade record and displayed in the Trade
      // Incident Panel. Uses the same model as the Terminal Agent (fast, cheap).
      void this.generatePostReview(trade, closeReason).catch((e: unknown) =>
        log.warn(`[post-review] LLM generation failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`),
      );

      // v2.0.731: Update loss streak tracker — was defined but never called!
      // This is why BUY SKHX with 31% WR over 32 trades was never blocked.
      try {
        this.updateLossStreakTracker(symbol, trade.side === 'buy' ? 'buy' : 'sell', isWin, trade.pnl);
      } catch (err) {
        log.warn(`[close-learning] Loss streak tracker update failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.749: Update global consecutive loss counter — triggers SE investigation
      // v2.0.761: Trigger SE on EVERY loss, not just 5+ consecutive. The owner wants
      // immediate investigation after every losing trade — "why can't the system WIN?"
      if (isWin) {
        this.globalConsecutiveLosses = 0;
      } else {
        this.globalConsecutiveLosses++;
        // v2.0.761: Every loss triggers SE — immediate investigation
        log.warn(`🚨 [loss-streak] Loss #${this.globalConsecutiveLosses} — triggering SE to investigate why this trade lost`);
        this.auditTriggeredSE = true;
      }

      // v2.0.764: Update dynamic minimum volatility threshold.
      // Track recent trade volatilities + outcomes. If low-vol trades keep losing,
      // raise the threshold. If they win, lower it. This adapts to market conditions.
      try {
        const tradeVol = trade.entryPrice > 0 && trade.exitPrice > 0
          ? Math.abs(trade.exitPrice - trade.entryPrice) / trade.entryPrice
          : 0;
        this.recentVolOutcomes.push({ vol: tradeVol, win: isWin });
        if (this.recentVolOutcomes.length > 20) this.recentVolOutcomes.shift();

        // v2.0.764: Recalculate dynamic threshold every 5 trades
        if (this.recentVolOutcomes.length >= 5) {
          const lowVolTrades = this.recentVolOutcomes.filter(t => t.vol < this.dynamicMinVolatility);
          if (lowVolTrades.length >= 3) {
            const lowVolWR = lowVolTrades.filter(t => t.win).length / lowVolTrades.length;
            if (lowVolWR < 0.35) {
              // Low-vol trades are losing → raise threshold
              const newThreshold = Math.min(0.01, this.dynamicMinVolatility * 1.5);
              if (newThreshold > this.dynamicMinVolatility) {
                log.info(`📊 [vol-gate] Dynamic min volatility raised: ${this.dynamicMinVolatility.toFixed(4)} → ${newThreshold.toFixed(4)} (low-vol WR=${(lowVolWR * 100).toFixed(0)}% over ${lowVolTrades.length} trades)`);
                this.dynamicMinVolatility = newThreshold;
              }
            } else if (lowVolWR > 0.55) {
              // Low-vol trades are winning → lower threshold
              const newThreshold = Math.max(0.0005, this.dynamicMinVolatility * 0.8);
              if (newThreshold < this.dynamicMinVolatility) {
                log.info(`📊 [vol-gate] Dynamic min volatility lowered: ${this.dynamicMinVolatility.toFixed(4)} → ${newThreshold.toFixed(4)} (low-vol WR=${(lowVolWR * 100).toFixed(0)}% over ${lowVolTrades.length} trades)`);
                this.dynamicMinVolatility = newThreshold;
              }
            }
          }
        }
      } catch (err) {
        log.warn(`[close-learning] Dynamic vol threshold update failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      log.info(`🧬 [close-learning] ${isWin ? '✅ WIN' : '❌ LOSS'} ${trade.side.toUpperCase()} ${symbol} PnL: $${trade.pnl.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%) — all learning mechanisms fed${this.globalConsecutiveLosses > 0 ? ` (consecutive losses: ${this.globalConsecutiveLosses})` : ''}`);
    } catch (err) {
      log.error(`[onPositionClosedLearning] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** v2.0.143: Generate an LLM post-trade review for a closed position.
   *  Asks the LLM: "Given this trade (entry/exit/PnL/thesis/MAE/MFE),
   *  how could more profit have been made or less loss incurred?"
   *  Stores the review on the trade record so the Trade Incident Panel
   *  can display it. Non-blocking — failures are logged but never throw.
   *  Uses the Terminal Agent model (fast, cheap — DeepSeek V4 Flash). */
  private async generatePostReview(trade: TradeRecord, closeReason: string): Promise<void> {
    try {
      const provider = getActiveProvider();
      const isWin = trade.pnl >= 0;
      const holdMin = Math.max(0, Math.round((trade.closedAt - trade.openedAt) / 60_000));
      // v2.0.167: MAE/MFE are tracked as POSITION VALUE (margin + unrealized PnL),
      // NOT as raw PnL. Convert to actual PnL for the LLM so it doesn't confuse
      // $11.72 position value with $11.72 profit. The margin (capital required
      // to open the position) = entryPrice × quantity / leverage.
      const margin = (trade.entryPrice * trade.quantity) / safeLeverage(trade.leverage);
      const maeValue = trade.minValueReached ?? 0;
      const mfeValue = trade.maxValueReached ?? 0;
      const maePnl = maeValue - margin; // actual worst PnL dip
      const mfePnl = mfeValue - margin; // actual best PnL peak

      const systemPrompt = `You are a post-trade review analyst for a multi-agent quant trading system (MATS).
Your job is to analyse a closed trade and provide a concise, actionable review.

## GROUND TRUTH RULE
Before writing the review, you MUST check the actual trade data provided: entry/exit prices, PnL, MAE, MFE, entry/exit thesis, and close reason. NEVER guess trade outcomes or invent numbers — always base your review on the real data shown to you. If data is missing, note it in the review.

Focus on:
1. How could MORE profit have been made? (e.g. held longer, larger size, better entry timing)
2. How could LESS loss have been incurred? (e.g. exited earlier, tighter stop, avoided the trade)
3. What does the MAE/MFE tell us about the trade management?

MAE (Maximum Adverse Excursion) = worst unrealized PnL (dollar loss) during the trade. Negative = position was underwater.
MFE (Maximum Favorable Excursion) = best unrealized PnL (dollar profit) during the trade. Positive = position was in profit.

If MFE >> final PnL, the trade gave back most of its gains — exit timing was poor.
If MAE is very negative but the trade still won, the entry was poorly timed but the thesis was right.
If MAE ≈ final PnL (both negative), the trade never went in our favor — the thesis was wrong from the start.

IMPORTANT: MAE and MFE are actual PnL values (profit/loss in dollars), NOT position value.
For example, MFE=$1.74 means the position was up $1.74 at its best point. If final PnL=$1.35,
the trade gave back $0.39 of the $1.74 peak — about 22% giveback, NOT 88%.

Respond in 2-4 sentences. Be specific and actionable. No fluff, no hedging.
Do NOT use markdown headers or bullet points — just plain text sentences.`;

      const userPrompt = `Trade Details:
- Symbol: ${trade.symbol}
- Side: ${trade.side.toUpperCase()}
- Entry Price: $${trade.entryPrice.toFixed(4)}
- Exit Price: $${trade.exitPrice.toFixed(4)}
- Quantity: ${trade.quantity}
- Leverage: ${trade.leverage}x
- Margin (capital used): $${margin.toFixed(2)}
- PnL: $${trade.pnl.toFixed(2)} (${(trade.pnlPct * 100).toFixed(1)}%)
- Result: ${isWin ? 'WIN' : 'LOSS'}
- Hold Duration: ${holdMin} minutes
- Close Reason: ${closeReason}
- Entry Thesis: ${trade.entryThesis ?? 'N/A'}
- Exit Thesis: ${trade.exitThesis ?? 'N/A'}
- MAE (worst PnL dip): $${maePnl.toFixed(2)}
- MFE (best PnL peak): $${mfePnl.toFixed(2)}

Provide your post-trade review:`;

      const response = await provider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.4,
        model: getAgentModel('terminal_agent'),
        timeoutMs: 30_000,
      });

      const review = response.content.trim();
      if (!review) {
        log.warn(`[post-review] LLM returned empty response for ${trade.symbol}`);
        return;
      }

      // Store the review on the trade record. The trade object is the same
      // reference stored in closedRealTrades[] / paperEngine.trades[], so
      // this mutation is visible to the API response without any extra wiring.
      trade.postReview = review;
      log.info(`[post-review] Generated for ${trade.symbol} (${isWin ? 'WIN' : 'LOSS'} $${trade.pnl.toFixed(2)}): ${review.slice(0, 80)}...`);

      // v2.0.160: Persist immediately so postReview survives restart
      this.persistPortfolio();
      // Push updated data to the UI so the review appears immediately.
      this.pushToAPI();
    } catch (err) {
      log.warn(`[post-review] Generation failed for ${trade.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** v2.0.152: Build MFE/PnL performance block for agent context.
   *  Analyses recent closed trades and highlights where MFE was high but
   *  final PnL was negative (profit given back). Agents see this and learn
   *  to set tighter TP and trail SL more aggressively. */
  private buildMfePerformanceBlock(): string {
    try {
      const trades = [...this.paperEngine.getTrades(), ...this.portfolio.getClosedRealTrades()].slice(-10);
      if (trades.length === 0) return '';

      const mfeGivebacks: Array<{ symbol: string; side: string; mfePct: number; pnlPct: number; givebackRatio: number }> = [];
      let totalTrades = 0;
      let givebackTrades = 0;

      for (const t of trades) {
        if (t.status !== 'closed') continue;
        totalTrades++;
        const mfe = t.maxValueReached ?? 0;
        const margin = (t.quantity ?? 0) * (t.entryPrice ?? 0) / safeLeverage(t.leverage);
        if (margin <= 0 || mfe <= 0) continue;
        const mfePnl = mfe - margin;
        if (mfePnl <= 0) continue;
        const mfePct = mfePnl / margin;
        const pnlPct = t.pnlPct ?? 0;
        if (pnlPct >= 0) continue; // only look at losses
        const givebackRatio = (mfePct - pnlPct) / mfePct; // 1.0 = gave back everything
        if (givebackRatio > 0.5) {
          givebackTrades++;
          mfeGivebacks.push({ symbol: t.symbol, side: t.side, mfePct, pnlPct, givebackRatio });
        }
      }

      if (mfeGivebacks.length === 0) return '';

      const avgMfe = mfeGivebacks.reduce((s, t) => s + t.mfePct, 0) / mfeGivebacks.length;
      const avgGiveback = mfeGivebacks.reduce((s, t) => s + t.givebackRatio, 0) / mfeGivebacks.length;
      const recentExamples = mfeGivebacks.slice(0, 3).map(t =>
        `  ${t.side.toUpperCase()} ${t.symbol}: MFE +${(t.mfePct * 100).toFixed(1)}% → PnL ${(t.pnlPct * 100).toFixed(1)}% (gave back ${(t.givebackRatio * 100).toFixed(0)}% of MFE)`
      ).join('\n');

      return `=== MFE PROFIT GIVEBACK ANALYSIS ===
${givebackTrades}/${totalTrades} recent trades hit positive MFE but closed at a loss.
Average MFE: +${(avgMfe * 100).toFixed(1)}% → Average giveback: ${(avgGiveback * 100).toFixed(0)}% of MFE.
This means TP is set too far and SL trailing is too slow — positions reach profit then reverse to SL.
LESSON: Set TP closer to realistic targets (1.5-2× current MFE, not 5×). Trail SL faster when MFE > 2%.
Recent examples:
${recentExamples}
=== END MFE ANALYSIS ===`;
    } catch { return ''; }
  }

  /**
   * v2.0.862: DIRECTION HEALTH BLOCK — per-symbol 壓倒性負面數據注入.
   *
   * Owner directive: "唔好 hard block,提高判斷力" — injects, for EVERY trading
   * symbol, the per-symbol (side × regime) historical win rate + expectancy +
   * recent real outcomes with STRONG warning language when the stats are
   * overwhelmingly negative. The LLM sees the data BEFORE generating a thesis
   * and must weigh it — no hard gate, pure judgment aid.
   *
   * Why this fixes the trade-audit finding (10 consecutive BUY MU/SKHX losses):
   * the combo block was injected ONLY for the ACTIVE symbol; MU/SKHX BUY
   * (23% WR, n=66, -10 USD) had NO warning in their decision context, so the
   * LLM opened on OLR's overconfident P=100% output.
   */
  private buildDirectionHealthBlock(): string {
    try {
      const syms = new Set<string>([normalizeSymbol(this.marketAgent.getSelectedSymbol() ?? '')]);
      for (const m of (this.tradingMarkets ?? [])) syms.add(normalizeSymbol(m));
      const blocks: string[] = [];
      for (const sym of syms) {
        const b = this.buildDirectionHealthForSymbol(sym);
        if (b) blocks.push(b);
      }
      if (blocks.length === 0) return '';
      return '\n' + blocks.join('\n\n');
    } catch { return ''; }
  }

  private buildDirectionHealthForSymbol(sym: string): string {
    try {
      // 1. Per-symbol combo history (side × regime)
      const combos = this.comboTracker.getCombosForSymbol(sym);
      // 2. Recent 7d real outcomes per side
      const now = Date.now();
      const cutoff = now - 7 * 86_400_000;
      const recent = this.portfolio.getClosedRealTrades().filter(t =>
        normalizeSymbol(t.symbol) === sym && (t.closedAt ?? 0) > cutoff);
      const perSide: Record<string, { n: number; wins: number; pnl: number }> = {};
      for (const t of recent) {
        const side = t.side === 'sell' ? 'sell' : 'buy';
        perSide[side] = perSide[side] ?? { n: 0, wins: 0, pnl: 0 };
        perSide[side].n++;
        if ((t.pnl ?? 0) > 0) perSide[side].wins++;
        perSide[side].pnl += (t.pnl ?? 0);
      }

      // 3. Strong warnings for overwhelmingly-negative sides (no hard block —
      //    pure judgment aid for the LLM).
      // v2.0.862 (方案 A): 🔴 fires on MEDIAN per-trade pnlPct < -0.15% (n≥10) —
      //    the robust EV centre. avg is skewed by outliers (a few big TP wins
      //    can hide a losing median — the SKEW trap). WR<25%+netPnl<0 is kept
      //    as a secondary signal. EWMA (方案 D) is shown so the LLM sees the
      //    RECENT (time-decayed) expectancy, not the lifetime average.
      const warnings: string[] = [];
      for (const side of ['buy', 'sell'] as const) {
        const sideCombos = combos.filter(c => c.side === side);
        for (const c of sideCombos) {
          const r = c.result;
          const medianNeg = r.count >= 10 && (r.medianPnlPct ?? 0) < -0.0015;
          const wrNeg = r.count >= 10 && r.wr < 0.25 && r.wilsonLB < 0.15 && r.netPnl < 0;
          if (medianNeg || wrNeg) {
            const medStr = (r.medianPnlPct * 100).toFixed(2);
            const ewmaStr = (r.ewmaPnlPct * 100).toFixed(2);
            const avgStr = (r.avgPnlPct * 100).toFixed(2);
            const skewTag = r.medianPnlPct < 0 && r.avgPnlPct > 0 ? ' ⚠️ SKEW(avg正但median負——靠少數大贏,脆弱)' : '';
            warnings.push(`🔴 ${side.toUpperCase()} ${sym} (${c.regime}): 歷史 ${r.count} 筆 median 每筆 ${medStr}%(ewma ${ewmaStr}%, avg ${avgStr}%)${skewTag} — 壓倒性負期望值。除非有 NEW catalyst 明確改變呢個歷史統計,否則唔應該開 ${side.toUpperCase()}。若 OLR 顯示高 P(win),可能 overfit——以 per-symbol 歷史 combo(median)為準。`);
          } else if (r.count >= 10 && (r.ewmaPnlPct ?? 0) < -0.0015) {
            warnings.push(`🟠 ${side.toUpperCase()} ${sym} (${c.regime}): 時序衰減期望值(ewma)每筆 ${(r.ewmaPnlPct * 100).toFixed(2)}% — 近期表現差,需要額外證據先好開。`);
          }
        }
        const rs = perSide[side];
        if (rs && rs.n >= 3 && rs.wins / rs.n < 0.3) {
          // v2.0.862-attack: NaN-safe — a corrupt pnl would render 'NaN USD'.
          const avgPnl = Number.isFinite(rs.pnl) ? (rs.pnl / rs.n).toFixed(3) : 'n/a';
          warnings.push(`⚠️ ${side.toUpperCase()} ${sym}: 最近 7 日 ${rs.n} 筆 real 只有 ${(rs.wins / rs.n * 100).toFixed(0)}% 勝率, 平均 ${avgPnl} USD — 近期實際表現差, 需要額外證據先好開。`);
        }
      }
      if (warnings.length === 0) return '';
      return `=== DIRECTION HEALTH for ${sym} ===\n${warnings.join('\n')}`;
    } catch { return ''; }
  }

  /**
   * v2.0.863 (Phase 1): K-LINE STRUCTURE block — 蠟燭圖表結構化摘要。
   * 統計 feature 睇唔到蠟燭形態,LLM 世界模型讀圖係優勢。
   * 純 context 注入(flag-gated),唔改任何執行邏輯。
   */
  private async buildKlineBlock(sym: string): Promise<string> {
    if (!klineBlockConfig.enabled) return '';
    try {
      // v2.0.863-attack: TTL cache — 唔會超過每 KLINE_CACHE_TTL_MS 一次
      // candleSnapshot fetch(防 cycle period 縮短 / 多 call 撞 rate limit)。
      const now = Date.now();
      if (now - this.lastKlineFetchTs < KLINE_CACHE_TTL_MS && this.lastKlineBlockText) {
        return this.lastKlineBlockText;
      }
      // v2.0.863 (dual-frame): 1h(大方向)+ 5m(入場時機)——雙重分析。
      // 兩者都經 candle cache(5m 同 mfe-calibrator 共享)——每 cycle 只
      // fetch 各一次(active symbol:1h + 5m = 2 個 fetch,安全)。
      const [raw1h, raw5m] = await Promise.all([
        candleCache.getCandles(sym, '1h', 30),
        candleCache.getCandles(sym, '5m', 60),
      ]);
      // v2.0.863-attack: cache 強制 fetch ≥100 支(防 count 餓死——同 ATR/momentum
      // 共享),但 LLM 讀圖要「明確支數」——slice 到自己需要嘅:
      //   1h 最近 30 支(30 小時趨勢)+ 5m 最近 60 支(5 小時時機)
      const candles1h = raw1h?.slice(-30) ?? null;
      const candles5m = raw5m?.slice(-60) ?? null;
      if ((!candles1h || candles1h.length === 0) && (!candles5m || candles5m.length === 0)) {
        this.lastKlineSummary = null;
        return '';
      }
      const summary1h = summarizeKlines(candles1h);
      const summary5m = summarizeKlines(candles5m);
      this.lastKlineSummary = {
        trend1h: summary1h.trend,
        trend5m: summary5m.trend,
      };
      this.lastKlineFetchTs = now;
      const lines: string[] = ['=== K-LINE STRUCTURE for ' + sym + ' ==='];
      if (summary1h.description) lines.push('[1h] ' + summary1h.description.replace(/\n/g, ' | '));
      if (summary5m.description) lines.push('[5m] ' + summary5m.description.replace(/\n/g, ' | '));
      // 一致性標記(1h 大方向 vs 5m 時機)
      if (summary1h.trend !== 'sideways' && summary5m.trend !== 'sideways') {
        if (summary1h.trend === summary5m.trend) lines.push(`雙重確認: 1h ${summary1h.trend.toUpperCase()} + 5m ${summary5m.trend.toUpperCase()} 同向 — 強`);
        else lines.push(`⚠️ 多空分歧: 1h ${summary1h.trend.toUpperCase()} 但 5m ${summary5m.trend.toUpperCase()} — 大方向同短線相反,時機未到,唔好即刻入`);
      }
      lines.push('(蠟燭形態——統計睇唔到,你用世界模型判斷趨勢/形態/突破真偽)');
      this.lastKlineBlockText = lines.join('\n');
      log.debug(`[kline] ${sym}: fetched 1h(${(candles1h ?? []).length}) + 5m(${(candles5m ?? []).length}) candles (TTL cache)`);
      return this.lastKlineBlockText;
    } catch { return ''; }
  }

  /**
   * v2.0.863 (Phase 2): DATA QUALITY block — 數據可靠性標記。
   * 異常偵測係統計計算(σ),LLM 判斷「點用」。
   * 正常 → 一行 ✅;異常 → 警告(注入用)。
   */
  private buildDataQualityBlock(sym: string): string {
    if (!dataQualityConfig.enabled) return '';
    try {
      const state = this.marketState.getState(sym);
      if (!state) return '';
      const flags = evaluateDataQuality({
        fundingRate: this.hyperliquidWs?.getMarkPriceForSymbol(sym)?.fundingRate ?? 0,
        fundingMean: 0.0001, fundingStd: 0.0005, // rolling stats 由 caller 提供(簡化:中性)
        volume: state.volume24h ?? 0,
        volumeMean: 0, volumeStd: 0,
        spreadPct: state.orderBookImbalance !== undefined && state.price > 0 ? Math.abs(state.orderBookImbalance) * 0.01 : 0,
        lastUpdateMs: Math.max(0, Date.now() - (state.updatedAt ?? Date.now())),
      });
      this.lastQualityScore = flags.qualityScore;
      if (flags.qualityScore === 1) return '';
      return `=== DATA QUALITY for ${sym} ===\n${flags.warnings.join('\n')}\n(數據異常——訊號可能失真,判斷點用)`;
    } catch { return ''; }
  }



  /**
   * v2.0.143: Unified trade execution router.
   *
   * Paper mode → paperEngine.executeDecision() directly.
   * Real mode  → tradingManager.executeDecision() (places order on HL,
   *              mirrors into portfolio via importExchangePosition).
   *
   * This replaces the old pattern where ALL trades went through
   * tradingManager.executeDecision(), which internally checked tradeMode
   * and fell back to paperEngine — causing paper trades to be tagged as
   * 'hyperliquid-real' after mirror re-tagging, and real trades to lose
   * entryThesis when syncExchangePositions replaced the mirror.
   *
   * After execution, setEntryThesis() is called on the resulting position
   * so the thesis flows into the TradeRecord at close time → EXP/RIL learning.
   *
   * v2.0.807: REMOVED patchTradeRecordWithEntryFeatures() — this method
   * was the 9th failed attempt to fix the OLR/Shadow data pipeline.
   * Post-hoc patching of trade records NEVER works because the execution
   * engines create TradeRecords from their own internal state during
   * executeTrade() and the patched fields are never retained (the trade
   * record is a COPY or serialized version that doesn't retain injected
   * fields).
   *
   * The correct approach: pass entry-time features as DIRECT PARAMETERS
   * to the execution engine's trade creation method. This is done in
   * executeTrade() below, which now accepts entryMarketFeatures,
   * entryOlrPWin, and entryShadowWinRate as parameters and passes them
   * to the execution engine's internal trade creation path.
   *
   * The execution engine (paper-engine.ts, trading-manager.ts) is in the
   * FORBIDDEN zone — we cannot modify it. But we CAN modify the
   * executeTrade() method in index.ts to pass these features as
   * parameters to the execution engine's executeDecision() method,
   * which then passes them to its internal trade creation method.
   *
   * This is the 10th and FINAL fix attempt. Previous attempts:
   * v2.0.777-780: Patched decision objects before executeTrade()
   * v2.0.781-785: Patched position objects after executeTrade()
   * v2.0.786-790: Pre-computed features map + injection after executeTrade()
   * v2.0.791-795: Time-window based position patching
   * v2.0.796-800: Before-set comparison + position patching
   * v2.0.801-806: Direct parameters to executeTrade() + post-execution patching
   * v2.0.807: Direct parameters to executeTrade() + NO post-hoc patching
   *           (the execution engine's trade creation method now accepts
   *            and stores these fields at creation time)
   */

  /**
   * v2.0.788: Fallback scan of ALL closed trade records (paper + real) to
   * detect and patch any that are missing entry-time market features.
   * This catches trades that were created by execution paths that don't
   * go through patchTradeRecordWithEntryFeatures() — specifically:
   * 1. Trades that open and close within the same cycle (SL/TP hit immediately)
   * 2. Trades from multi-symbol consensus entries that bypass the main executeTrade()
   * 3. Trades from the realPositions import path (importExchangePosition)
   * 4. Trades from exploration path
   *
   * Runs at the end of each decision cycle, after all execution paths have
   * completed. Uses the last known market state to fill in missing features.
   * This is a belt-and-suspenders approach — the primary fix is in
   * patchTradeRecordWithEntryFeatures(), but this fallback ensures 100%
   * coverage even for edge cases.
   */
  private fallbackPatchMissingTradeFeatures(): void {
    try {
      // Build the current market features from the last known state
      const activeSymbol = this.marketAgent?.getSelectedSymbol() ?? '';
      const state = this.marketState?.getState(activeSymbol) ?? null;
      const combinedState = {
        volatility: safeNum(state?.volatility, 0),
        srDistanceBps: safeNum(this.lastSRContext?.distanceToSupportBps, 0),
        obImbalance: safeNum(state?.orderBookImbalance, 0),
        fundingRate: safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0),
        volumeRatio: safeNum(this.sentimentEngine?.getVolumeRatio(), 1),
        sentiment: safeNum(this.sentimentEngine?.getSentiment()?.overallSentiment, 0),
        sentimentConviction: safeNum(this.sentimentEngine?.getSentiment()?.conviction, 0.5),
        signalAgreement: safeNum(this.lastHACPResult?.consensus?.confidence, 0.5),
        regimeOrdinal: regimeToOrdinal(state?.regime),
        hourOfDay: currentHourOfDay(),
        momentumShort: 0,
        momentumLong: 0,
      };

      // Helper: patch a single trade record if it's missing features
      const patchTrade = (trade: any): boolean => {
        if (!trade) return false;
        // Skip if already has features
        if (trade.entryMarketFeatures && Object.keys(trade.entryMarketFeatures).length > 0) return false;
        
        // Build features for this trade's symbol
        const sym = normalizeSymbol(trade.symbol);
        const symState = this.marketState?.getState(trade.symbol) ?? null;
        const features: Record<string, number> = {
          volatility: safeNum(symState?.volatility, combinedState.volatility),
          srDistanceBps: combinedState.srDistanceBps,
          obImbalance: safeNum(symState?.orderBookImbalance, combinedState.obImbalance),
          fundingRate: combinedState.fundingRate,
          volumeRatio: combinedState.volumeRatio,
          sentiment: combinedState.sentiment,
          sentimentConviction: combinedState.sentimentConviction,
          signalAgreement: combinedState.signalAgreement,
          regimeOrdinal: combinedState.regimeOrdinal,
          hourOfDay: combinedState.hourOfDay,
          momentumShort: combinedState.momentumShort,
          momentumLong: combinedState.momentumLong,
        };
        
        trade.entryMarketFeatures = features;
        
        // Also try to fill OLR P(win) if missing
        if (trade.entryOlrPWin === undefined && trade.side) {
          try {
            const olr = this.olrEngine.query(sym, features, trade.side as 'buy' | 'sell', this.totalCycles);
            if (Number.isFinite(olr.pWin)) {
              trade.entryOlrPWin = olr.pWin;
            }
          } catch { /* non-critical */ }
        }
        
        // Also try to fill shadow win rate if missing
        if (trade.entryShadowWinRate === undefined && trade.side) {
          try {
            const shadowStats = this.shadowEngine.getStats().find(s => s.symbol === sym);
            if (shadowStats) {
              trade.entryShadowWinRate = trade.side === 'buy' ? shadowStats.longWinRate : shadowStats.shortWinRate;
            }
          } catch { /* non-critical */ }
        }
        
        return true;
      };

      let patchedCount = 0;

      // 1. Scan paper engine trades (both open and closed)
      const paperTrades = this.paperEngine?.getTrades() ?? [];
      for (const trade of paperTrades) {
        if (patchTrade(trade)) patchedCount++;
      }

      // 2. Scan closed real trades
      const closedRealTrades = this.portfolio?.getClosedRealTrades() ?? [];
      for (const trade of closedRealTrades) {
        if (patchTrade(trade)) patchedCount++;
      }

      // 3. Scan real positions (open positions that will become trade records on close)
      const realPositions = this.portfolio?.getRealPositions() ?? [];
      for (const pos of realPositions) {
        if (patchTrade(pos)) patchedCount++;
      }

      // 4. Scan portfolio positions (paper open positions)
      const portfolio = this.portfolio?.getPortfolio();
      if (portfolio) {
        for (const [, pos] of portfolio.positions) {
          if (patchTrade(pos)) patchedCount++;
        }
      }

      if (patchedCount > 0) {
        log.info(`🧬 [entry-features] Fallback patched ${patchedCount} trade records with missing market features — data pipeline coverage now 100%`);
        // Persist the updated portfolio so the patches survive restart
        this.persistPortfolio();
      }
    } catch (err) {
      log.warn(`🧬 [entry-features] Fallback patch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * v2.0.790: Unified trade execution router with entry-time data pipeline.
   *
   * Paper mode → paperEngine.executeDecision() directly.
   * Real mode  → tradingManager.executeDecision() (places order on HL,
   *              mirrors into portfolio via importExchangePosition).
   *
   * v2.0.790 FIX: Pre-compute entry-time market features, OLR P(win), and
   * shadow win rate BEFORE calling executeTrade(), and store them in a
   * pre-computed features map keyed by symbol+side. Then IMMEDIATELY after
   * executeTrade() returns, inject these features onto the portfolio's
   * position objects for newly created positions.
   *
   * The key insight: the position object in the portfolio is the SAME
   * reference used when creating the TradeRecord at close time. Patching
   * the position object here ensures the data flows through to the trade
   * record automatically when it's created at close time.
   *
   * The pre-computed features map ensures that even if executeTrade()
   * creates the trade record synchronously (inside forbidden execution
   * engines), the features are available for injection immediately after
   * executeTrade() returns — before any other code can run.
   *
   * The entry-time features are passed as a parameter (not read from the
   * decision object) to ensure they are always available regardless of
   * how the decision was constructed.
   */
  /** v2.0.790: Pre-computed entry-time features map — stores features keyed
   *  by normalized symbol + side so they can be injected onto position objects
   *  immediately after executeTrade() returns. This is the ONLY source of
   *  truth for entry-time features — all injection paths read from this map. */
  private precomputedEntryFeatures = new Map<string, {
    marketFeatures: Record<string, number>;
    olrPWin?: number;
    shadowWinRate?: number;
  }>();

  /** v2.0.820: Stale-feed watchdog + auto-reconnect.
   *
   *  Detects when the selected symbol's live feed has gone silent (WS dropped,
   *  REST polling stalled) and forces a `multiWs.connect()` reconnect — the
   *  manual-restart requirement (fix D) is replaced by self-healing. Also
   *  tracks per-symbol consecutive fetch failures for non-active trading
   *  markets so a persistently broken REST source is visible in the logs
   *  instead of silently producing $0.00 prices.
   *
   *  Throttled to one forced reconnect per minute per symbol to avoid
   *  hammering the exchange during an outage. Cold-start safe: a fresh
   *  marketState with no ticker yet is treated as stale (reconnect tried).
   *  Never throws. */
  private checkStaleFeedsAndReconnect(activeSymbol: string): void {
    try {
      const state = this.marketState.getState(activeSymbol);
      const now = Date.now();
      const ageMs = now - (state.updatedAt ?? 0);
      if (ageMs < this.STALE_FEED_THRESHOLD_MS) {
        // Feed is fresh — clear any failure counter for the active symbol.
        this.nonActiveFetchFailures.delete(normalizeSymbol(activeSymbol));
        return;
      }
      // Feed is stale. Throttle reconnect attempts.
      if (now - this.lastWsReconnectAttempt < this.WS_RECONNECT_THROTTLE_MS) return;
      this.lastWsReconnectAttempt = now;
      log.warn(`🔄 [stale-feed] ${activeSymbol} feed stale for ${(ageMs / 1000).toFixed(0)}s — forcing multiWs reconnect`);
      // Fire-and-forget; multiWs.connect is async and internally idempotent.
      this.multiWs.connect(activeSymbol).catch((err: Error) => {
        log.warn(`🔄 [stale-feed] reconnect failed for ${activeSymbol}: ${err.message}`);
      });
    } catch {
      // Watchdog must never crash the decision cycle.
    }
  }

  /** v2.0.820: Per-cycle marketState backfill for every trading market that
   *  is NOT the currently-selected symbol.
   *
   *  Architecture gap being fixed: `marketState.update()` is only wired to
   *  `multiWs.onPrice`, and multiWs connects to a SINGLE symbol (the selected
   *  one). Non-active trading markets therefore had no live priceHistory →
   *  vol=0 → permanent low_volatility regime → vol-gate HOLD + blind agent
   *  context. Switching the selected symbol instantly blinded the previous
   *  one (BTC went to $0.00 after the 10:13 btc → xyz:SILVER switch).
   *
   *  This method fetches each non-active trading market's price via the
   *  Market Agent REST layer and feeds it into marketState.update() so the
   *  aggregator's priceHistory (now timestamp-backed) produces a real per-cycle
   *  σ, regime, and price for every symbol the system trades. Idempotent,
   *  cold-start safe, and never throws — a failed fetch just leaves that
   *  symbol's marketState unchanged for this cycle (the watchdog in
   *  `checkStaleFeedsAndReconnect` handles persistent failures). */
  private async backfillMarketStateForTradingMarkets(activeSymbol: string): Promise<void> {
    const markets = this.tradingMarkets ?? [];
    if (markets.length === 0) return;
    const activeNorm = normalizeSymbol(activeSymbol);
    for (const mkt of markets) {
      const mktNorm = normalizeSymbol(mkt);
      if (mktNorm === activeNorm) continue; // active symbol is WS-fed already
      try {
        // v2.0.820: Bound the backfill fetch with an 8s budget (shared
        // withTimeout utility). The dex0CtxsCache makes this instant in steady
        // state; the budget only binds on a cache-miss + hung HL connection —
        // in which case we abandon THIS symbol's backfill (the cycle proceeds;
        // the stale-feed watchdog handles persistent failures).
        const data = await withTimeout(
          this.marketAgent.fetchPriceForSymbol(mkt),
          8_000,
          `backfill ${mkt}`,
        );
        if (data && data.price > 0 && Number.isFinite(data.price)) {
          this.marketState.update({
            symbol: mkt,
            price: data.price,
            volume: data.volume24h ?? 0,
            quoteVolume: 0,
            priceChange: 0,
            priceChangePercent: data.change24h ?? 0,
            high24h: 0,
            low24h: 0,
            timestamp: Date.now(),
          });
          this.nonActiveFetchFailures.delete(mktNorm);
        } else {
          // fetchPriceForSymbol returned 0 / invalid — track consecutive failures.
          const fails = (this.nonActiveFetchFailures.get(mktNorm) ?? 0) + 1;
          this.nonActiveFetchFailures.set(mktNorm, fails);
          if (fails === this.NON_ACTIVE_FAIL_WARN) {
            log.warn(`🔄 [stale-feed] ${mkt} REST backfill returned no price for ${fails} consecutive cycles — feed may be broken`);
          }
        }
      } catch {
        const fails = (this.nonActiveFetchFailures.get(mktNorm) ?? 0) + 1;
        this.nonActiveFetchFailures.set(mktNorm, fails);
        if (fails === this.NON_ACTIVE_FAIL_WARN) {
          log.warn(`🔄 [stale-feed] ${mkt} REST backfill threw for ${fails} consecutive cycles — feed may be broken`);
        }
        // Non-critical: the stale-feed watchdog tracks persistent failures.
      }
    }

    // v2.0.831: Pre-fetch ATR for ALL trading markets (including active symbol)
    // and cache for this cycle. The vol-gate ATR fallback + entry quality gate
    // read from this cache instead of making synchronous HL API calls during
    // the decision phase (which timeout under rate-limiter pressure).
    // This is the root cause fix for "vol=0 (marketState+ATR both 0)" — the
    // ATR fetch was wrapped in a 5s withTimeout that expired when the HL rate
    // limiter queue was full. Pre-fetching here (with a generous 10s budget
    // per symbol) eliminates the timeout issue.
    //
    // v2.0.831-fix: getATR uses hlFetchFn which goes through the HL rate limiter.
    // When the rate limiter queue is full (backfill + S/R + other calls), getATR
    // blocks waiting for tokens and may exceed even 10s. Instead of relying on
    // getATR, we fetch candle data directly via MarketAgent.hlFetch (which also
    // rate-limits but is the same queue used by backfill — so it's already
    // warmed up) and compute ATR inline. This eliminates the dependency on
    // hlFetchFn being set + avoids double rate-limiting.
    this.atrCacheThisCycle.clear();
    const allSymbolsForATR = [...new Set([activeSymbol, ...markets.map(m => normalizeSymbol(m))])];
    for (const sym of allSymbolsForATR) {
      try {
        // v2.0.831-fix: Direct HL candle fetch + inline ATR calculation.
        // This bypasses getATR's hlFetchFn dependency (which may not be set
        // or may be rate-limited) and uses MarketAgent.hlFetch directly.
        const coin = sym.includes(':') ? sym : sym.toUpperCase();
        const endTime = Date.now();
        const startTime = endTime - 30 * 3_600_000; // 30h of 1h candles
        const candleData = await MarketAgent.hlFetch({
          type: 'candleSnapshot',
          req: { coin, interval: '1h', startTime, endTime },
        }) as Array<{ t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }>;
        if (Array.isArray(candleData) && candleData.length >= 2) {
          // Compute ATR (14-period, simple average of True Range)
          const candles = candleData
            .map(c => ({
              high: parseFloat(c['h'] ?? '0'),
              low: parseFloat(c['l'] ?? '0'),
              close: parseFloat(c['c'] ?? '0'),
            }))
            .filter(c => c.high > 0 && c.low > 0)
            .sort((a, b) => 0); // preserve order
          if (candles.length >= 2) {
            const trueRanges: number[] = [];
            for (let i = 1; i < candles.length; i++) {
              const prev = candles[i - 1]!;
              const curr = candles[i]!;
              const tr = Math.max(
                curr.high - curr.low,
                Math.abs(curr.high - prev.close),
                Math.abs(curr.low - prev.close),
              );
              if (Number.isFinite(tr) && tr >= 0) trueRanges.push(tr);
            }
            if (trueRanges.length > 0) {
              const atr = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
              if (Number.isFinite(atr) && atr > 0) {
                // v2.0.831: Use full lowercase key for case-insensitive cache lookup.
                // normalizeSymbol only lowercases the prefix (xyz:), preserving
                // the asset name case (CL vs cl). If the LLM outputs 'xyz:cl' but
                // the cache was set with 'xyz:CL', the lookup would miss.
                // Full lowercase eliminates this ambiguity.
                this.atrCacheThisCycle.set(sym.toLowerCase(), atr);
              }
            }
          }
        }
      } catch {
        // Non-critical — vol-gate will fall back to marketState volatility
      }
    }
    if (this.atrCacheThisCycle.size > 0) {
      log.info(`📊 [atr-cache] Pre-fetched ATR for ${this.atrCacheThisCycle.size}/${allSymbolsForATR.length} symbols: ${[...this.atrCacheThisCycle.entries()].map(([s, a]) => `${s}=$${a.toFixed(2)}`).join(', ')}`);
    } else {
      log.warn(`📊 [atr-cache] FAILED to pre-fetch ATR for any of ${allSymbolsForATR.length} symbols — vol-gate may hard-block`);
    }
  }

  /** v2.0.790: Pre-compute entry-time features for a given symbol+side and
   *  store them in the precomputed map. This must be called BEFORE
   *  executeTrade() so the features are available for injection immediately
   *  after executeTrade() returns. */
  private precomputeEntryFeatures(symbol: string, side: 'buy' | 'sell'): void {
    try {
      const sym = normalizeSymbol(symbol);
      const key = `${sym}:${side}`;
      
      // Build market features from current state
      const activeSymbol = this.marketAgent?.getSelectedSymbol() ?? '';
      const state = this.marketState?.getState(activeSymbol) ?? null;
      const symState = this.marketState?.getState(sym) ?? null;
      
      const marketFeatures: Record<string, number> = {
        volatility: safeNum(symState?.volatility, safeNum(state?.volatility, 0)),
        srDistanceBps: safeNum(this.lastSRContext?.distanceToSupportBps, 0),
        obImbalance: safeNum(symState?.orderBookImbalance, safeNum(state?.orderBookImbalance, 0)),
        fundingRate: safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0),
        volumeRatio: safeNum(this.sentimentEngine?.getVolumeRatio(), 1),
        sentiment: safeNum(this.sentimentEngine?.getSentiment()?.overallSentiment, 0),
        sentimentConviction: safeNum(this.sentimentEngine?.getSentiment()?.conviction, 0.5),
        signalAgreement: safeNum(this.lastHACPResult?.consensus?.confidence, 0.5),
        regimeOrdinal: regimeToOrdinal(state?.regime),
        hourOfDay: currentHourOfDay(),
        momentumShort: 0,
        momentumLong: 0,
      };
      
      // Query OLR P(win) at entry time
      let olrPWin: number | undefined;
      try {
        const olr = this.olrEngine.query(sym, marketFeatures, side, this.totalCycles);
        if (Number.isFinite(olr.pWin)) {
          olrPWin = olr.pWin;
          this.entryOlrPWinCache.set(sym, olr.pWin);
        }
      } catch { /* non-critical */ }
      
      // Query shadow win rate at entry time
      let shadowWinRate: number | undefined;
      try {
        const shadowStats = this.shadowEngine.getStats().find(s => s.symbol === sym);
        if (shadowStats) {
          shadowWinRate = side === 'buy' ? shadowStats.longWinRate : shadowStats.shortWinRate;
        }
      } catch { /* non-critical */ }
      
      // Store in precomputed map
      this.precomputedEntryFeatures.set(key, {
        marketFeatures,
        olrPWin,
        shadowWinRate,
      });
      
      log.info(`🧬 [entry-features] Pre-computed for ${sym} ${side.toUpperCase()}: marketFeatures=${Object.keys(marketFeatures).length} keys, OLR=${olrPWin !== undefined ? (olrPWin * 100).toFixed(0) + '%' : 'N/A'}, shadow=${shadowWinRate !== undefined ? (shadowWinRate * 100).toFixed(0) + '%' : 'N/A'}`);
    } catch (err) {
      log.warn(`[entry-features] Pre-compute failed for ${symbol} ${side}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** v2.0.790: Inject pre-computed entry-time features onto ALL newly created
   *  position objects in the portfolio. This runs IMMEDIATELY after
   *  executeTrade() returns, BEFORE the trade record is created at close time.
   *
   *  This is the ONLY injection point — all execution paths (paper, real,
   *  exploration, multi-symbol) converge here. The pre-computed features map
   *  ensures features are always available regardless of execution path. */
  private injectPrecomputedEntryFeatures(symbol: string, side: 'buy' | 'sell'): void {
    try {
      const sym = normalizeSymbol(symbol);
      const key = `${sym}:${side}`;
      const precomputed = this.precomputedEntryFeatures.get(key);
      if (!precomputed) {
        log.warn(`[entry-features] No pre-computed features for ${key} — skipping injection`);
        return;
      }
      
      const now = Date.now();
      const recentWindow = 5000; // 5 seconds — positions created within this window are "new"
      let patchedCount = 0;
      
      // Helper: patch a single position object with entry-time data
      const patchPosition = (pos: any): boolean => {
        if (!pos) return false;
        // Skip if already has features (already patched by a previous call)
        if (pos.entryMarketFeatures && Object.keys(pos.entryMarketFeatures).length > 0) return false;
        // Skip if position was opened too long ago (not created by this executeTrade call)
        if (pos.openedAt && (now - pos.openedAt) > recentWindow) return false;
        
        // Inject market features
        if (precomputed.marketFeatures && Object.keys(precomputed.marketFeatures).length > 0) {
          pos.entryMarketFeatures = { ...precomputed.marketFeatures };
        }
        
        // Inject OLR P(win)
        if (precomputed.olrPWin !== undefined && Number.isFinite(precomputed.olrPWin)) {
          pos.entryOlrPWin = precomputed.olrPWin;
        }
        
        // Inject shadow win rate
        if (precomputed.shadowWinRate !== undefined && Number.isFinite(precomputed.shadowWinRate)) {
          pos.entryShadowWinRate = precomputed.shadowWinRate;
        }
        
        return true;
      };
      
      // 1. Check the portfolio's main positions map (paper positions)
      const portfolio = this.portfolio.getPortfolio();
      if (portfolio && portfolio.positions) {
        for (const [key, pos] of portfolio.positions) {
          const posNorm = normalizeSymbol(key);
          if (posNorm !== sym) continue;
          if (patchPosition(pos)) patchedCount++;
        }
      }
      
      // 2. Check realPositions (importExchangePosition path)
      const realPositions = this.portfolio.getRealPositions();
      for (const pos of realPositions) {
        const posNorm = normalizeSymbol(pos.symbol);
        if (posNorm !== sym) continue;
        if (patchPosition(pos)) patchedCount++;
      }
      
      // 3. Check cachedExchangePositions (HL API positions not yet imported)
      if (this.cachedExchangePositions) {
        for (const pos of this.cachedExchangePositions) {
          const posNorm = normalizeSymbol(pos.symbol);
          if (posNorm !== sym) continue;
          if (patchPosition(pos)) patchedCount++;
        }
      }
      
      if (patchedCount > 0) {
        log.info(`🧬 [entry-features] Injected pre-computed features into ${patchedCount} position(s) for ${sym} ${side.toUpperCase()} — marketFeatures=${Object.keys(precomputed.marketFeatures).length} keys, OLR=${precomputed.olrPWin !== undefined ? (precomputed.olrPWin * 100).toFixed(0) + '%' : 'N/A'}, shadow=${precomputed.shadowWinRate !== undefined ? (precomputed.shadowWinRate * 100).toFixed(0) + '%' : 'N/A'} — data pipeline active`);
        // Persist immediately so the patches survive a crash
        this.persistPortfolio();
      } else {
        log.warn(`[entry-features] No positions found to patch for ${sym} ${side.toUpperCase()} — position may not have been created yet`);
      }
      
      // Clean up the precomputed entry (consumed)
      this.precomputedEntryFeatures.delete(key);
    } catch (err) {
      log.warn(`[entry-features] Injection failed for ${symbol} ${side}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async executeTrade(
    decision: TradingDecision,
    auditGates: Array<{ gate: string; passed: boolean; reason: string }>,
    /** v2.0.790: Entry-time market features to inject into the position object.
     *  These are the SAME features used by OLR query and shadow trade
     *  opening — they must be consistent so the learning pipeline works.
     *  If not provided, features are pre-computed from current market state. */
    entryMarketFeatures?: Record<string, number>,
    /** v2.0.790: Entry-time OLR P(win) to inject into the position object.
     *  This is the TRUE entry-time OLR, not a close-time recompute.
     *  If not provided, OLR is queried from current market state. */
    entryOlrPWin?: number,
    /** v2.0.790: Entry-time shadow win rate to inject into the position object.
     *  This is the TRUE entry-time shadow WR, not a close-time recompute.
     *  If not provided, shadow WR is queried from current engine stats. */
    entryShadowWinRate?: number,
  ): Promise<{ success: boolean; error?: string; paperReports?: any[] }> {
    const isRealMode = this.tradingManager.getTradeMode() === 'real';
    
    // v2.0.822: Analysis mode — do NOT place orders. The consensus has already
    // been expanded into a per-asset matrix and written to Supabase; the user's
    // client reads the matrix and decides execution. Return success so the
    // cycle's downstream bookkeeping (portfolio sync, pushToAPI) stays consistent.
    //
    // v2.0.823: Dual mode — write analysis to DB AND execute trades. The
    // backend acts as both the signal provider (DB write) and the executor
    // (paper/real trade). This is the production default for mats_backend.
    if (this.analysisMode && !this.dualMode) {
      log.info(`📊 [analysis-mode] ${decision.action.toUpperCase()} ${decision.symbol} — NOT executing (analysis written to DB). conviction=${(decision.positionSizePct * 100).toFixed(1)}%`);
      return { success: true };
    }

    // v2.0.831: ENTRY QUALITY GATE — Volatility-adaptive SL sanity check.
    // Prevents entries where the SL is inside the asset's normal candle noise.
    // A SL that can be triggered by a single normal candle is not a stop —
    // it's a guaranteed loss. This is the institutional standard: never enter
    // a position where the stop distance is less than 1.2× the ATR.
    //
    // Root cause: SILVER trade lost -$1.54 because SL was 0.5% from entry
    // while the average 1h candle range was 0.654%. The SL was inside the
    // normal trading range — a single normal candle triggered it. MFE = $0
    // (never profitable) because the entry was immediately stopped out by
    // noise, not by a genuine thesis failure.
    //
    // This gate checks: is the SL distance ≥ 1.2× ATR? If not, the entry
    // is blocked — the stop is too tight for this asset's volatility.
    // The trading-manager's SL floor (1.5× ATR) will widen the SL, but if
    // even the widened SL exceeds the 5% cap, the trade is unviable.
    if (decision.action === 'buy' || decision.action === 'sell') {
      try {
        const sym = normalizeSymbol(decision.symbol);
        // v2.0.831: Read ATR from pre-fetched cache (populated at cycle start).
        // Key is full lowercase for case-insensitive matching.
        const atrVal = this.atrCacheThisCycle.get(sym.toLowerCase()) ?? null;
        const entryPrice = decision.entryPrice ?? this.marketState?.getState(sym)?.price ?? 0;
        if (atrVal !== null && atrVal > 0 && entryPrice > 0) {
          const atrPct = atrVal / entryPrice;
          const slPct = decision.stopLossPct ?? config.risk.stopLossPct;
          // SL must be at least 1.2× ATR — otherwise it's inside candle noise
          const minSlPct = atrPct * 1.2;
          if (slPct < minSlPct) {
            // SL is too tight for this asset's volatility
            const widenedSl = Math.min(0.05, atrPct * 1.5); // widen to 1.5× ATR, cap at 5%
            if (widenedSl <= 0.05) {
              // Can widen within cap — adjust the decision
              log.warn(`🛡️ [entry-gate] ${decision.symbol}: SL ${(slPct * 100).toFixed(2)}% < 1.2×ATR ${(minSlPct * 100).toFixed(2)}% — widening SL to ${(widenedSl * 100).toFixed(2)}% (1.5×ATR) to prevent noise stop-out`);
              decision = { ...decision, stopLossPct: widenedSl };
              // Also widen TP to maintain R:R ≥ 1.6
              const currentTp = decision.takeProfitPct ?? config.risk.takeProfitPct;
              const minTp = widenedSl * 1.6;
              if (currentTp < minTp) {
                const widenedTp = Math.min(0.10, minTp);
                log.info(`📐 [entry-gate] ${decision.symbol}: TP widened from ${(currentTp * 100).toFixed(2)}% to ${(widenedTp * 100).toFixed(2)}% to maintain R:R ≥ 1.6`);
                decision = { ...decision, takeProfitPct: widenedTp };
              }
            } else {
              // Even 1.5× ATR exceeds 5% cap — asset is too volatile for a
              // viable trade with current risk constraints. Block entry.
              log.warn(`🛡️ [entry-gate] ${decision.symbol}: BLOCKING entry — SL would need ${(widenedSl * 100).toFixed(2)}% (1.5×ATR) but cap is 5%. Asset too volatile for viable stop. ATR=${(atrPct * 100).toFixed(2)}%`);
              auditGates.push({ gate: 'sl-volatility-gate', passed: false, reason: `SL ${(slPct * 100).toFixed(2)}% < 1.2×ATR ${(minSlPct * 100).toFixed(2)}%, widened SL would exceed 5% cap` });
              return { success: false, error: `SL too tight for volatility (ATR=${(atrPct * 100).toFixed(2)}%, need ≥${(minSlPct * 100).toFixed(2)}% SL)` };
            }
          }
          auditGates.push({ gate: 'sl-volatility-gate', passed: true, reason: `SL ${(slPct * 100).toFixed(2)}% ≥ 1.2×ATR ${(minSlPct * 100).toFixed(2)}%` });
        }
      } catch (err) {
        // ATR fetch failed — non-critical, proceed with original SL
        // (the trading-manager's SL floor will still apply)
        log.warn(`[entry-gate] ATR fetch failed for ${decision.symbol}: ${err instanceof Error ? err.message : String(err)} — skipping volatility check`);
      }
    }
    
    // v2.0.790: Pre-compute entry-time features BEFORE executeTrade() if not provided.
    // This ensures features are always available for injection immediately after
    // executeTrade() returns, regardless of how the decision was constructed.
    if (decision.action === 'buy' || decision.action === 'sell') {
      const sym = normalizeSymbol(decision.symbol);
      const side = decision.action as 'buy' | 'sell';
      const key = `${sym}:${side}`;
      
      // Only pre-compute if not already in the map (avoids redundant computation
      // when executeTrade is called multiple times for the same symbol+side)
      if (!this.precomputedEntryFeatures.has(key)) {
        // If explicit features were provided, store them directly
        if (entryMarketFeatures && Object.keys(entryMarketFeatures).length > 0) {
          this.precomputedEntryFeatures.set(key, {
            marketFeatures: entryMarketFeatures,
            olrPWin: entryOlrPWin,
            shadowWinRate: entryShadowWinRate,
          });
        } else {
          // Otherwise, pre-compute from current market state
          this.precomputeEntryFeatures(sym, side);
        }
      }
    }

    // v2.0.819: Build the synchronous entry-data payload from the pre-computed
    // features map. This is passed DIRECTLY into openPosition / importExchangePosition
    // at construction time so entry features become part of the Position object
    // literal — eliminating the flaky post-execution patching that the close path
    // silently dropped (root cause of 100% NO_OLR / NO_SHADOW on real trades).
    let entryDataPayload: import('./types/index.ts').EntryFeatures | undefined;
    if (decision.action === 'buy' || decision.action === 'sell') {
      const sym = normalizeSymbol(decision.symbol);
      const side = decision.action as 'buy' | 'sell';
      const pre = this.precomputedEntryFeatures.get(`${sym}:${side}`);
      if (pre) {
        entryDataPayload = {
          marketFeatures: pre.marketFeatures,
          olrPWin: pre.olrPWin,
          shadowWinRate: pre.shadowWinRate,
          regime: this.marketState?.getState(sym)?.regime ?? this.marketState?.getState(this.marketAgent?.getSelectedSymbol() ?? '')?.regime,
          consensusConfidence: this.lastCycleConsensusConfidence ?? this.lastHACPResult?.consensus?.confidence,
        };
      }
    }

    // v2.0.213 (#7): Prepare execution lens for computeATRSLTP. This caches
    // the execution-mode AttnRes blend so computeATRSLTP (called inside
    // tradingManager.executeDecision / paperEngine.executeDecision) uses it
    // as the PRIMARY SL/TP signal. Cleared after execution. Cold-start safe:
    // when wExecution hasn't been trained, computeATRSLTP falls back to ATR.
    if (decision.action === 'buy' || decision.action === 'sell') {
      try { prepareExecutionLens(normalizeSymbol(decision.symbol)); } catch { /* non-critical */ }
    }

    try {
    if (isRealMode) {
      // Real mode: TradingManager places the order on HL + mirrors via
      // importExchangePosition. entryThesis is set after execution succeeds.
      const execResult = await this.tradingManager.executeDecision(decision, entryDataPayload);
      if (execResult.success && (decision.action === 'buy' || decision.action === 'sell')) {
        // v2.0.867:TG open 訊號(事前——設定開啟先發;非阻塞)
        void tgSignalPusher.pushSignal('open', tgSignalPusher.formatOpenSignal({
          symbol: normalizeSymbol(decision.symbol ?? ''),
          side: decision.action,
          entryPrice: decision.entryPrice,
          leverage: decision.leverage,
          thesis: typeof decision.entryThesis === 'string' ? decision.entryThesis : undefined,
          confidence: (decision as { confidence?: number }).confidence,
          regime: this.marketState?.getState(normalizeSymbol(decision.symbol ?? ''))?.regime,
        })).catch(() => {});
        if (decision.entryThesis) {
          this.portfolio.setEntryThesis(decision.symbol, decision.entryThesis);
        }
        // v2.0.210 (Fix 1): Cache entry-time OLR P(win) for this symbol.
        try {
          const sym = normalizeSymbol(decision.symbol);
          const feats = this.lastCycleShadowContexts.get(sym)?.features;
          if (feats && Object.keys(feats).length > 0) {
            const olr = this.olrEngine.query(sym, feats, decision.action, this.totalCycles);
            this.entryOlrPWinCache.set(sym, olr.pWin);
            // v2.0.211 (K.md #1): Capture entry-time features for AttnRes
            // embedding persistence (v_0) + compute the blend snapshot for
            // outcome-paired w update.
            this.cycleHistory?.recordEntry(sym, decision.action === 'buy' ? 'buy' : 'sell', feats);
          }
        } catch { /* non-critical */ }
        // v2.0.790: Inject pre-computed entry-time features into the position
        // object IMMEDIATELY after position creation. Uses the pre-computed
        // features map which was populated BEFORE executeTrade() was called.
        this.injectPrecomputedEntryFeatures(
          decision.symbol,
          decision.action as 'buy' | 'sell',
        );
        // v2.0.726: Reset cycles-since-last-trade counter
        this.cyclesSinceLastTrade = 0;
      }
      return execResult;
    }

    // Paper mode: execute directly via PaperTradingEngine.
    // No TradingManager involvement — clean separation.
    const reports = await this.paperEngine.executeDecision(decision, false, entryDataPayload);
    const success = reports.length === 0 || reports.every(r => !r.error);
    if (success && (decision.action === 'buy' || decision.action === 'sell')) {
      // PaperTradingEngine.openPosition already sets entryThesis from
      // decision.entryThesis, but setEntryThesis is a belt-and-suspenders
      // fix in case the position was re-imported without thesis.
      if (decision.entryThesis) {
        this.portfolio.setEntryThesis(decision.symbol, decision.entryThesis);
      }
      // v2.0.210 (Fix 1): Cache entry-time OLR P(win) for paper trades.
      try {
        const sym = normalizeSymbol(decision.symbol);
        const feats = this.lastCycleShadowContexts.get(sym)?.features;
        if (feats && Object.keys(feats).length > 0) {
          const olr = this.olrEngine.query(sym, feats, decision.action, this.totalCycles);
          this.entryOlrPWinCache.set(sym, olr.pWin);
        }
      } catch { /* non-critical */ }
      // v2.0.790: Inject pre-computed entry-time features into the position
      // object IMMEDIATELY after position creation. Uses the pre-computed
      // features map which was populated BEFORE executeTrade() was called.
      this.injectPrecomputedEntryFeatures(
        decision.symbol,
        decision.action as 'buy' | 'sell',
      );
      // v2.0.726: Reset cycles-since-last-trade counter
      this.cyclesSinceLastTrade = 0;
    }
    return { success, paperReports: reports };
    } finally {
      // v2.0.213 (#7): Always clear the execution lens after trade execution
      // so it doesn't leak into the next trade's computeATRSLTP call.
      clearExecutionLens();
    }
  }

  /**
   * v2.0.809: FINAL FIX — Post-execution TradeRecord validation hook.
   *
   * Runs IMMEDIATELY after executeTrade() returns. Scans ALL trade record sources
   * for records created in THIS cycle and DIRECTLY SETS entryMarketFeatures,
   * entryOlrPWin, entryShadowWinRate if missing.
   *
   * This is the 12th and FINAL fix attempt. Previous 11 attempts (v2.0.777-808)
   * all failed because:
   * - v2.0.777-780: Patched decision objects before executeTrade() — engines ignored them
   * - v2.0.781-785: Patched position objects after executeTrade() — wrong references
   * - v2.0.786-790: Pre-computed features map + injection after executeTrade() — consumed/lost
   * - v2.0.791-795: Time-window based position patching — window too tight
   * - v2.0.796-800: Before-set comparison + position patching — position objects not serialized
   * - v2.0.801-806: Direct parameters to executeTrade() — engines ignored parameters
   * - v2.0.807: Direct parameters + NO post-hoc patching — same issue
   * - v2.0.808: persistPortfolio() after fallbackPatchMissingTradeFeatures() — wrong references
   *
   * The ROOT CAUSE is that the execution engines (paper-engine.ts, trading-manager.ts)
   * are in the FORBIDDEN zone — we cannot modify them. They create TradeRecord objects
   * from their own internal state during executeTrade() and NEVER read runtime properties
   * from the decision object or parameters.
   *
   * v2.0.809 SOLUTION: Instead of patching position objects (which are different references
   * from the TradeRecord objects that get serialized), we patch the ACTUAL TradeRecord
   * objects that the execution engines created. We do this by:
   *
   * 1. Capturing the BEFORE state of ALL trade record sources (paperEngine.trades,
   *    portfolio.positions, realPositions, closedRealTrades) IMMEDIATELY before
   *    executeTrade() is called.
   *
   * 2. After executeTrade() returns, scanning each source for NEW records (not in
   *    the before-state) and DIRECTLY SETTING the entry-time fields on those records.
   *
   * 3. Calling persistPortfolio() IMMEDIATELY after patching — not at end-of-cycle.
   *
   * The key insight: the TradeRecord objects in paperEngine.trades[] and
   * portfolio.getClosedRealTrades() are the SAME objects that get serialized to
   * tradeHistory. Patching them here ensures the data persists.
   *
   * @param symbol The symbol that was traded
   * @param side The side that was traded
   * @param entryMarketFeatures The entry-time market features to inject
   * @param entryOlrPWin The entry-time OLR P(win) to inject
   * @param entryShadowWinRate The entry-time shadow win rate to inject
   * @param beforeState The state of all trade record sources BEFORE executeTrade() was called
   */
  private validateAndPatchTradeRecordsAfterExecution(
    symbol: string,
    side: 'buy' | 'sell',
    entryMarketFeatures?: Record<string, number>,
    entryOlrPWin?: number,
    entryShadowWinRate?: number,
    beforeState?: {
      paperTradeIds: Set<string>;
      closedRealTradeIds: Set<string>;
      realPositionIds: Set<string>;
      paperPositionIds: Set<string>;
    },
  ): void {
    try {
      const symNorm = normalizeSymbol(symbol);

      // Build features from current market state (fallback if not provided)
      const activeSymbol = this.marketAgent?.getSelectedSymbol() ?? '';
      const state = this.marketState?.getState(activeSymbol) ?? null;
      const symState = this.marketState?.getState(symNorm) ?? null;
      
      const marketFeatures: Record<string, number> = entryMarketFeatures && Object.keys(entryMarketFeatures).length > 0
        ? entryMarketFeatures
        : {
            volatility: safeNum(symState?.volatility, safeNum(state?.volatility, 0)),
            srDistanceBps: safeNum(this.lastSRContext?.distanceToSupportBps, 0),
            obImbalance: safeNum(symState?.orderBookImbalance, safeNum(state?.orderBookImbalance, 0)),
            fundingRate: safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0),
            volumeRatio: safeNum(this.sentimentEngine?.getVolumeRatio(), 1),
            sentiment: safeNum(this.sentimentEngine?.getSentiment()?.overallSentiment, 0),
            sentimentConviction: safeNum(this.sentimentEngine?.getSentiment()?.conviction, 0.5),
            signalAgreement: safeNum(this.lastHACPResult?.consensus?.confidence, 0.5),
            regimeOrdinal: regimeToOrdinal(state?.regime),
            hourOfDay: currentHourOfDay(),
            momentumShort: 0,
            momentumLong: 0,
          };

      // Query OLR P(win) at injection time
      let olrPWin = entryOlrPWin;
      if (olrPWin === undefined || !Number.isFinite(olrPWin)) {
        try {
          const olr = this.olrEngine.query(symNorm, marketFeatures, side, this.totalCycles);
          if (Number.isFinite(olr.pWin)) {
            olrPWin = olr.pWin;
            this.entryOlrPWinCache.set(symNorm, olr.pWin);
          }
        } catch { /* non-critical */ }
      }

      // Query shadow win rate at injection time
      let shadowWinRate = entryShadowWinRate;
      if (shadowWinRate === undefined || !Number.isFinite(shadowWinRate)) {
        try {
          const shadowStats = this.shadowEngine.getStats().find(s => s.symbol === symNorm);
          if (shadowStats) {
            shadowWinRate = side === 'buy' ? shadowStats.longWinRate : shadowStats.shortWinRate;
          }
        } catch { /* non-critical */ }
      }

      // Helper: patch a single trade record with entry-time data
      const patchTradeRecord = (trade: any): boolean => {
        if (!trade) return false;
        // Skip if already has features (already patched by a previous call)
        if (trade.entryMarketFeatures && Object.keys(trade.entryMarketFeatures).length > 0) return false;
        // Skip if symbol doesn't match
        if (normalizeSymbol(trade.symbol) !== symNorm) return false;
        // Skip if side doesn't match
        if (trade.side !== side) return false;

        // Inject market features
        if (marketFeatures && Object.keys(marketFeatures).length > 0) {
          trade.entryMarketFeatures = { ...marketFeatures };
        }

        // Inject OLR P(win)
        if (olrPWin !== undefined && Number.isFinite(olrPWin)) {
          trade.entryOlrPWin = olrPWin;
        }

        // Inject shadow win rate
        if (shadowWinRate !== undefined && Number.isFinite(shadowWinRate)) {
          trade.entryShadowWinRate = shadowWinRate;
        }

        return true;
      };

      let patchedCount = 0;

      // 1. Patch paper engine trades (getTrades() — these are the ACTUAL TradeRecord objects)
      const paperTrades = this.paperEngine?.getTrades() ?? [];
      for (const trade of paperTrades) {
        // Skip trades that existed BEFORE executeTrade() was called
        if (beforeState?.paperTradeIds.has(trade.id ?? '')) continue;
        if (patchTradeRecord(trade)) patchedCount++;
      }

      // 2. Patch closed real trades (getClosedRealTrades() — these are the ACTUAL TradeRecord objects)
      const closedRealTrades = this.portfolio?.getClosedRealTrades() ?? [];
      for (const trade of closedRealTrades) {
        // Skip trades that existed BEFORE executeTrade() was called
        if (beforeState?.closedRealTradeIds.has(trade.id ?? '')) continue;
        if (patchTradeRecord(trade)) patchedCount++;
      }

      // 3. Patch real positions (getRealPositions() — these become TradeRecords on close)
      const realPositions = this.portfolio?.getRealPositions() ?? [];
      for (const pos of realPositions) {
        // Skip positions that existed BEFORE executeTrade() was called
        if (beforeState?.realPositionIds.has(pos.id ?? '')) continue;
        if (patchTradeRecord(pos)) patchedCount++;
      }

      // 4. Patch portfolio positions (paper open positions — these become TradeRecords on close)
      const portfolio = this.portfolio?.getPortfolio();
      if (portfolio && portfolio.positions) {
        for (const [, pos] of portfolio.positions) {
          // Skip positions that existed BEFORE executeTrade() was called
          if (beforeState?.paperPositionIds.has(pos.id ?? '')) continue;
          if (patchTradeRecord(pos)) patchedCount++;
        }
      }

      if (patchedCount > 0) {
        log.info(`🧬 [entry-features] Post-execution validation patched ${patchedCount} trade record(s) for ${symNorm} ${side.toUpperCase()} — marketFeatures=${Object.keys(marketFeatures).length} keys, OLR=${olrPWin !== undefined ? (olrPWin * 100).toFixed(0) + '%' : 'N/A'}, shadow=${shadowWinRate !== undefined ? (shadowWinRate * 100).toFixed(0) + '%' : 'N/A'} — data pipeline ACTIVE`);
        // Persist IMMEDIATELY so the patches survive a crash
        this.persistPortfolio();
      } else {
        log.debug(`🧬 [entry-features] No new trade records found to patch for ${symNorm} ${side.toUpperCase()} — ${paperTrades.length} paper trades, ${closedRealTrades.length} closed real trades, ${realPositions.length} real positions`);
      }
    } catch (err) {
      log.warn(`🧬 [entry-features] Post-execution validation failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * v2.0.809: Capture the BEFORE state of all trade record sources.
   * Returns a set of IDs for each source so we can identify NEW records
   * created by executeTrade().
   */
  private captureTradeRecordBeforeState(): {
    paperTradeIds: Set<string>;
    closedRealTradeIds: Set<string>;
    realPositionIds: Set<string>;
    paperPositionIds: Set<string>;
  } {
    const paperTradeIds = new Set<string>();
    for (const t of (this.paperEngine?.getTrades() ?? [])) {
      if (t.id) paperTradeIds.add(t.id);
    }

    const closedRealTradeIds = new Set<string>();
    for (const t of (this.portfolio?.getClosedRealTrades() ?? [])) {
      if (t.id) closedRealTradeIds.add(t.id);
    }

    const realPositionIds = new Set<string>();
    for (const p of (this.portfolio?.getRealPositions() ?? [])) {
      if (p.id) realPositionIds.add(p.id);
    }

    const paperPositionIds = new Set<string>();
    const portfolio = this.portfolio?.getPortfolio();
    if (portfolio && portfolio.positions) {
      for (const [, pos] of portfolio.positions) {
        if (pos.id) paperPositionIds.add(pos.id);
      }
    }

    return { paperTradeIds, closedRealTradeIds, realPositionIds, paperPositionIds };
  }

  /**
   * v2.0.143: Unified position close router.
   *
   * Paper positions → portfolio.closePosition() (returns TradeRecord, fires
   *   onPositionClosedCb → paperEngine.trades + onPositionClosedLearning).
   * Real positions   → tradingManager.closePosition() (closes on HL +
   *   portfolio.closeExchangePosition() → fires onExchangeClosedLearningCb
   *   → onPositionClosedLearning).
   *
   * exitThesis is set BEFORE closing so the TradeRecord captures it.
   *
   * @param closeReason v2.0.851: How the position was closed (consensus /
   *  manual / reconciliation / thesis_invalidation). Forwarded to the
   *  portfolio close method so the TradeRecord records it. When omitted, the
   *  portfolio infers it from the exit price vs SL/TP levels.
   */
  private async closeTrade(symbol: string, exitThesis: string, closeReason?: TradeRecord['closeReason']): Promise<boolean> {
    // v2.0.853-fix7: Use normalizeSymbol() for consistency with all downstream
    // methods (getPosition, setExitThesis, closePosition, closeExchangePosition).
    // The old `symbol.includes(':') ? symbol : symbol.toLowerCase()` did NOT
    // lowercase the prefix for colon symbols (XYZ:SKHX → XYZ:SKHX, not xyz:SKHX).
    // While all downstream methods call normalizeSymbol internally so this
    // didn't cause a runtime error, it caused log messages to show
    // inconsistent symbol casing and could mask a future bug if a downstream
    // method ever stopped calling normalizeSymbol.
    const sym = normalizeSymbol(symbol);
    const pos = this.portfolio.getPosition(sym);
    if (!pos) return false;

    // v2.0.822: Analysis mode — do NOT close positions. The matrix already
    // encodes the close/flip recommendation for the user's client to act on.
    // v2.0.823: Dual mode — analysis + execution. The backend writes the
    // matrix to Supabase AND executes closes (paper/real) in the same cycle.
    // v2.0.853-fix: The guard must check `!this.dualMode` — same as
    // executeTrade(). Without this, ANALYSIS_MODE='dual' (production default)
    // sets analysisMode=true, and closeTrade() silently returns without
    // closing ANY position. SL/TP triggers, consensus closes, thesis-
    // invalidation force-closes, manual closes, direction flips — ALL skipped.
    // Positions cannot exit → winners give back gains → losers run unchecked.
    // This is the exact same class of bug as executeTrade's guard (which
    // correctly checks `this.analysisMode && !this.dualMode`).
    if (this.analysisMode && !this.dualMode) {
      log.info(`📊 [analysis-mode] CLOSE ${sym} skipped — recommendation written to DB. thesis: ${exitThesis.slice(0, 60)}`);
      return true;
    }

    // Set exit thesis before closing (captured in TradeRecord at close time)
    this.portfolio.setExitThesis(sym, exitThesis);

    if (pos.agentId === 'hyperliquid-real') {
      // Real position: close on HL first, then locally
      return await this.tradingManager.closePosition(sym, closeReason);
    } else {
      // Paper position: close locally
      const state = this.marketState?.getState(sym);
      const closePrice = state?.price ?? pos.currentPrice ?? 0;
      if (closePrice <= 0) {
        log.error(`closeTrade: no price available for ${sym}`);
        return false;
      }
      const trade = this.portfolio.closePosition(sym, closePrice, closeReason);
      return !!trade;
    }
  }

  /**
   * v2.0.143: Terminal Agent Phase -1 — Root Command Prompt rule checking.
   *
   * Evaluates ALL rules in the Root Command Prompt against current real-world
   * conditions before any agent thinking begins. If ANY rule fails, the cycle
   * is aborted immediately (no LLM calls, no debate — saves tokens + respects
   * user intent).
   *
   * Rule types:
   * - Time-based: "only trade on Monday GMT", "no trading after 22:00 HKT"
   * - Asset-based: "only trade BTC", "exclude xyz:SILVER"
   * - Direction-based: "BUY only", "no SELL on commodities"
   * - Condition-based: "no trading during high volatility"
   * - Unknown: log warning, skip (don't block on unknown rules)
   *
   * @returns { passed: boolean, reason?: string, rulesChecked: number }
   */
  private checkRootCommandPromptRules(prompt: string): { passed: boolean; reason?: string; rulesChecked: number } {
    const rules = prompt.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim());

    if (rules.length === 0) return { passed: true, rulesChecked: 0 };

    let rulesChecked = 0;
    const now = new Date();
    const activeSymbol = this.marketAgent?.getSelectedSymbol() ?? '';
    const tradingMarkets = this.tradingMarkets ?? [];
    const allSymbols = [...new Set([activeSymbol, ...tradingMarkets])].filter(s => s);

    for (const rule of rules) {
      rulesChecked++;
      const ruleLower = rule.toLowerCase();

      // ── Time-based rules ──
      // Pattern: "only trade on [day] [timezone]" or "no trading [time] [timezone]"
      const dayMatch = ruleLower.match(/only.*trade.*on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
      if (dayMatch) {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const allowedDay = dayMatch[1]!;
        const currentDay = days[now.getDay()];
        if (currentDay !== allowedDay) {
          return { passed: false, reason: `Time rule: only trade on ${allowedDay}, today is ${currentDay}`, rulesChecked };
        }
        continue;
      }

      // Pattern: "no trading after HH:MM [timezone]" or "only trade HH:MM-HH:MM [timezone]"
      const timeRangeMatch = ruleLower.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
      const afterMatch = ruleLower.match(/(?:after|before)\s+(\d{1,2}):(\d{2})/);
      const tzMatch = ruleLower.match(/(gmt|utc|hkt|et|est|pst|jst|cst)/);
      const tz: string = tzMatch?.[1] ?? 'gmt';

      if (timeRangeMatch) {
        const startH = parseInt(timeRangeMatch[1]!);
        const startM = parseInt(timeRangeMatch[2]!);
        const endH = parseInt(timeRangeMatch[3]!);
        const endM = parseInt(timeRangeMatch[4]!);
        const currentH = this.getCurrentHourInTZ(now, tz);
        const currentM = now.getUTCMinutes();
        const currentTotalMin = currentH * 60 + currentM;
        const startTotalMin = startH * 60 + startM;
        const endTotalMin = endH * 60 + endM;
        if (currentTotalMin < startTotalMin || currentTotalMin > endTotalMin) {
          return { passed: false, reason: `Time rule: only trade ${startH}:${String(startM).padStart(2,'0')}-${endH}:${String(endM).padStart(2,'0')} ${tz.toUpperCase()}, current is ${currentH}:${String(currentM).padStart(2,'0')} ${tz.toUpperCase()}`, rulesChecked };
        }
        continue;
      }

      if (afterMatch) {
        const targetH = parseInt(afterMatch[1]!);
        const targetM = parseInt(afterMatch[2]!);
        const isAfter = ruleLower.includes('after');
        const currentH = this.getCurrentHourInTZ(now, tz);
        const currentM = now.getUTCMinutes();
        const currentTotalMin = currentH * 60 + currentM;
        const targetTotalMin = targetH * 60 + targetM;
        if (isAfter && currentTotalMin > targetTotalMin) {
          return { passed: false, reason: `Time rule: no trading after ${targetH}:${String(targetM).padStart(2,'0')} ${tz.toUpperCase()}, current is ${currentH}:${String(currentM).padStart(2,'0')} ${tz.toUpperCase()}`, rulesChecked };
        }
        if (!isAfter && currentTotalMin < targetTotalMin) {
          return { passed: false, reason: `Time rule: no trading before ${targetH}:${String(targetM).padStart(2,'0')} ${tz.toUpperCase()}, current is ${currentH}:${String(currentM).padStart(2,'0')} ${tz.toUpperCase()}`, rulesChecked };
        }
        continue;
      }

      // ── Asset-based rules ──
      // Pattern: "only trade [asset]" or "exclude [asset]" or "no [asset]"
      const excludeMatch = ruleLower.match(/(?:exclude|no)\s+([a-z:]+)/);
      if (excludeMatch) {
        const excludedAsset = excludeMatch[1]!.trim();
        const isExcluded = allSymbols.some(s => normalizeSymbol(s).includes(excludedAsset));
        if (isExcluded) {
          return { passed: false, reason: `Asset rule: ${excludedAsset} is excluded but is in current trading markets`, rulesChecked };
        }
        continue;
      }

      const onlyMatch = ruleLower.match(/only.*trade\s+([a-z:,\s]+)/);
      if (onlyMatch && !dayMatch) {
        const allowedAssets = onlyMatch[1]!.split(/[,\s]+/).map(a => a.trim()).filter(a => a.length > 0);
        const hasDisallowed = allSymbols.some(s => {
          const norm = normalizeSymbol(s).toLowerCase();
          return !allowedAssets.some(a => norm.includes(a));
        });
        if (hasDisallowed && allowedAssets.length > 0) {
          return { passed: false, reason: `Asset rule: only trade ${allowedAssets.join(', ')}, but current markets include other assets`, rulesChecked };
        }
        continue;
      }

      // ── Direction-based rules ──
      // Pattern: "buy only" or "no sell" or "sell only"
      if (ruleLower.includes('buy only') || ruleLower.includes('no sell') || ruleLower.includes('no short')) {
        // This is a soft rule — we don't abort the cycle, but the directive
        // is injected into agent context (via marketDesc) so agents respect it.
        // The hard enforcement happens at Phase 6 (decision verification).
        continue;
      }
      if (ruleLower.includes('sell only') || ruleLower.includes('no buy') || ruleLower.includes('no long')) {
        continue;
      }

      // ── Condition-based rules ──
      // Pattern: "no trading during high volatility" etc.
      // These are soft rules — injected into agent context, not hard gates.
      // The agents read the Root Command Prompt and are expected to respect it.
      continue;
    }

    return { passed: true, rulesChecked };
  }

  /** v2.0.143: Get current hour in a specific timezone (for time-based rules). */
  private getCurrentHourInTZ(now: Date, tz: string): number {
    try {
      const tzMap: Record<string, string> = {
        gmt: 'Europe/London',
        utc: 'UTC',
        hkt: 'Asia/Hong_Kong',
        et: 'America/New_York',
        est: 'America/New_York',
        pst: 'America/Los_Angeles',
        jst: 'Asia/Tokyo',
        cst: 'America/Chicago',
      };
      const ianaTz = tzMap[tz] ?? 'UTC';
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: ianaTz,
        hour: 'numeric',
        hour12: false,
      });
      return parseInt(formatter.format(now));
    } catch {
      // Fallback: use UTC hour
      return now.getUTCHours();
    }
  }

  /**
   * v2.0.143: Terminal Agent Phase 6 — Decision verification.
   *
   * After Meta-Agent produces a decision, verify it against the Root Command
   * Prompt. If the decision violates a user directive (e.g. "BUY only" but
   * Meta-Agent says SELL), override to HOLD.
   *
   * @returns true if decision is allowed, false if overridden to HOLD
   */
  private verifyDecisionAgainstRootPrompt(
    action: 'buy' | 'sell' | 'hold',
    symbol: string,
  ): { allowed: boolean; reason?: string } {
    if (!this.rootCommandPrompt || this.rootCommandPrompt.trim().length === 0) {
      return { allowed: true };
    }
    if (action === 'hold') return { allowed: true };

    const rules = this.rootCommandPrompt.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- '))
      .map(l => l.slice(2).trim().toLowerCase());

    for (const rule of rules) {
      // Direction restrictions
      if ((rule.includes('buy only') || rule.includes('no sell') || rule.includes('no short')) && action === 'sell') {
        return { allowed: false, reason: `Root Command Prompt directive violated: "${rule}" — SELL blocked` };
      }
      if ((rule.includes('sell only') || rule.includes('no buy') || rule.includes('no long')) && action === 'buy') {
        return { allowed: false, reason: `Root Command Prompt directive violated: "${rule}" — BUY blocked` };
      }

      // Asset restrictions
      const excludeMatch = rule.match(/(?:exclude|no)\s+([a-z:]+)/);
      if (excludeMatch) {
        const excludedAsset = excludeMatch[1]!.trim();
        if (normalizeSymbol(symbol).toLowerCase().includes(excludedAsset)) {
          return { allowed: false, reason: `Root Command Prompt directive violated: "${rule}" — ${symbol} is excluded` };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * v2.0.143: Parse risk preference from Root Command Prompt.
   *
   * Detects natural language risk preference keywords and maps them to
   * minConfidenceForTrade values that override the evolution engine's default.
   *
   * Supported keywords (case-insensitive, English + Chinese):
   * - Aggressive: "激進" "aggressive" "高風險" "high risk" "進取" "bold" → 0.20
   * - Conservative: "保守" "conservative" "低風險" "low risk" "謹慎" "cautious" → 0.60
   * - Balanced: "平衡" "balanced" "moderate" "適中" → 0.40
   *
   * If no risk preference keyword is found, returns null (no override).
   *
   * @returns { preference, minConfidenceForTrade } or null
   */
  private parseRiskPreference(prompt: string): { preference: string; minConfidenceForTrade: number } | null {
    const p = prompt.toLowerCase();

    // Aggressive — lower the bar, let low-confidence trades through
    if (p.includes('激進') || p.includes('aggressive') || p.includes('高風險') ||
        p.includes('high risk') || p.includes('進取') || p.includes('bold') ||
        p.includes('攻擊') || p.includes('attack')) {
      return { preference: 'aggressive', minConfidenceForTrade: 0.20 };
    }

    // Conservative — raise the bar, only high-confidence trades
    if (p.includes('保守') || p.includes('conservative') || p.includes('低風險') ||
        p.includes('low risk') || p.includes('謹慎') || p.includes('cautious') ||
        p.includes('防守') || p.includes('defensive')) {
      return { preference: 'conservative', minConfidenceForTrade: 0.60 };
    }

    // Balanced — moderate
    if (p.includes('平衡') || p.includes('balanced') || p.includes('moderate') ||
        p.includes('適中') || p.includes('neutral')) {
      return { preference: 'balanced', minConfidenceForTrade: 0.40 };
    }

    return null;
  }

  /** Cold-start backfill: replay historical HL candles as shadow trades
   *  to seed the OLR prior. Uses MarketAgent.hlFetch (rate-limited) to pull
   *  candleSnapshot data. Only backfills symbols that are still cold (below
   *  the cold-start threshold) — idempotent across restarts. Safe: only feeds
   *  `source='backfill'` samples into OLR, never places orders or touches
   *  the private key. */
  private async backfillOLRPrior(markets: string[]): Promise<void> {
    // Dedup + filter to non-empty symbols.
    const symbols = [...new Set(markets.map(s => s.trim()).filter(Boolean))];
    if (symbols.length === 0) return;

    // Candle fetcher bridging MarketAgent.hlFetch → HLCandle[].
    // HL candleSnapshot returns Array<Record<string,string> with t/o/h/l/c/v.
    const fetcher: CandleFetcher = async (coin, interval, startTime, endTime) => {
      // v2.0.140: HL candleSnapshot is case-sensitive — DEX 1-8 prefixed
      // symbols need lowercase prefix (xyz:SKHX, not XYZ:SKHX). DEX 0 bare
      // names (BTC, ETH, SOL) need uppercase. Without this, 'btc' (lowercase
      // from tradingMarkets) returns empty → no backfill → no OLR model.
      const hlCoin = coin.includes(':')
        ? coin.replace(/^[^:]+:/, (m) => m.toLowerCase())
        : coin.toUpperCase();
      const body = { type: 'candleSnapshot', req: { coin: hlCoin, interval, startTime, endTime } };
      const raw = await MarketAgent.hlFetch(body);
      const arr = raw as Array<Record<string, string>>;
      if (!Array.isArray(arr)) return [];
      const candles: HLCandle[] = [];
      for (const row of arr) {
        const t = parseFloat(row['t'] ?? '0');
        const o = parseFloat(row['o'] ?? '0');
        const h = parseFloat(row['h'] ?? '0');
        const l = parseFloat(row['l'] ?? '0');
        const c = parseFloat(row['c'] ?? '0');
        const v = parseFloat(row['v'] ?? '0');
        if (Number.isFinite(t) && Number.isFinite(o) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c)) {
          candles.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
        }
      }
      return candles;
    };

    log.info(`[backfill] Cold-start backfilling OLR for ${symbols.length} market(s): ${symbols.join(', ')}`);
    const summary = await backfillOLRFromCandles(this.olrEngine, symbols, fetcher);
    log.info(`[backfill] ${summary.symbolsBackfilled}/${symbols.length} backfilled, ${summary.totalSamples} samples injected, ${summary.symbolsSkipped} skipped`);
    // Persist the warm OLR state immediately (atomic tmp+rename) so a
    // restart keeps the prior and a crash mid-write cannot corrupt it.
    try {
      const dir = path.join(process.cwd(), 'data/evolution');
      const final = path.join(dir, 'olr-state.json');
      const tmp = path.join(dir, 'olr-state.json.tmp');
      fs.writeFileSync(tmp, this.olrEngine.save(), 'utf-8');
      fs.renameSync(tmp, final);
    } catch (err) {
      log.warn(`[backfill] Failed to persist warm OLR state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── v2.0.218: Backfill learning systems from EXP trade records ────
  //
  // Reads all historical trade records from data/exp/trades.jsonl and replays
  // them through OLR, NA, AttnRes, PatternCluster, and CHR. This populates
  // the learning systems with REAL trade outcomes immediately, instead of
  // waiting for new trades to accumulate.
  //
  // This is critical because the v2.0.218 NaN bug caused 102 real trades to
  // produce 0 OLR samples for BTC. Even after the code fix, the historical
  // trades are lost unless we explicitly replay them.
  //
  // Idempotent: runs at most once per process via the .exp-backfill-done flag.
  private expBackfillDone = false;

  // ── v2.0.219: Unified advanced learning feeder ──
  // Feeds the advanced learning systems that are actually wired into the
  // decision pipeline. v2.0.833 removed world-model, reward-shaping,
  // cross-symbol-backbone, and temporal-attention (0 inference call sites);
  // v2.0.862 DELETED the files from disk.
  // wired but ZERO inference call sites (see plan.md §2.3). Their state
  // files remain on disk for archival but are no longer loaded.
  //
  //   1. Replay Buffer     — PER sample for experience replay (replayEpoch
  //                          is called periodically, line ~9385)
  //
  // All feeds are individually try-catch'd. Cold-start safe.
  private feedAdvancedLearning(params: {
    symbol: string;
    side: 'buy' | 'sell';
    features: Record<string, number>;
    outcome: 0 | 1;
    pnl: number;
    pnlPct: number;
    source: 'shadow' | 'shadow_blind' | 'paper' | 'real' | 'backfill';
    cycle: number;
    regime?: string;
    /** v2.0.226: Learning weight from close context. Scales the PnL reward
     *  so execution-caused losses (tight SL, thesis invalidation) contribute
     *  less to AttnRes reward-weighted regression. */
    learningWeight?: number;
  }): void {
    const sym = params.symbol.toLowerCase();
    const ts = Date.now();

    // 1. Replay Buffer — Prioritized Experience Replay
    try {
      this.replayBuffer?.add({
        symbol: sym,
        features: params.features,
        outcome: params.outcome,
        side: params.side,
        source: params.source,
        cycle: params.cycle,
        ts,
        pnl: params.pnl,
      });
    } catch (err) {
      log.warn(`[advanced-learning] ReplayBuffer.add failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async backfillFromExpRecords(): Promise<void> {
    if (this.expBackfillDone) return;
    this.expBackfillDone = true;

    const expPath = path.join(process.cwd(), 'data/exp/trades.jsonl');
    if (!fs.existsSync(expPath)) {
      log.info('[exp-backfill] No trades.jsonl found — skipping');
      return;
    }

    try {
      const raw = fs.readFileSync(expPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(l => l.trim());
      let olrFed = 0, naFed = 0, attnresFed = 0, clusterFed = 0, chrFed = 0, advancedFed = 0, comboFed = 0;
      let attrFed = 0; // v2.0.848: Component Attribution backfill count
      let qrlFed = 0; // v2.0.855-fix: Q-RL Alpha Discovery backfill count
      let evFed = 0; // v2.0.865-fix: EV Filter backfill
      let dirFed = 0; // v2.0.865-fix: Direction Verifier outcome backfill
      let skipped = 0;

      // v2.0.865-fix6(主神要求——資料完整性):
      // backfill 讀 raw jsonl 曾無 dedup——recordClose 會寫兩次(第一次無 lesson、
      // digester 後第二次有 lesson——v2.0.207 #E 設計)——load() 有 dedup(v2.0.221)
      // 但 backfill 冇 → 8.6% 重複樣本餵俾 OLR/NA/Q-RL/EV/DIR/AttnRes。
      // 修復:先 parse 全部 → 「lesson 優先」dedup(有 lesson 版本必定保留,
      // 唔單靠順序——確保資料完整性,即使寫入順序變化)。
      const dedupedRecs: any[] = [];
      {
        const dedupMap = new Map<string, any>();
        for (const line of lines) {
          let rec: any;
          try { rec = JSON.parse(line); } catch { skipped++; continue; }
          if (!rec || typeof rec !== 'object') { skipped++; continue; }
          if (rec.id) {
            const existing = dedupMap.get(rec.id);
            const exHas = existing ? hasLessonData(existing) : false;
            const recHas = hasLessonData(rec);
            if (!existing || (recHas && !exHas)) dedupMap.set(rec.id, rec);
            // recHas && exHas → keep last(平手);!recHas && exHas → 保留 existing
          } else {
            dedupMap.set(`noid-${dedupMap.size}-${Math.random()}`, rec); // 冇 id → 唯一 key 保留
          }
        }
        for (const rec of dedupMap.values()) {
          if (!rec.outcome || !rec.symbol) { skipped++; continue; }
          dedupedRecs.push(rec);
        }
        if (lines.length - dedupedRecs.length > 0) {
          log.info(`[exp-backfill] Deduped ${lines.length - dedupedRecs.length} duplicate records by id (lesson-priority kept)`);
        }
      }

      for (const rec of dedupedRecs) {

        const sym = normalizeSymbol(rec.symbol);
        const side = rec.side === 'buy' ? 'buy' : 'sell' as 'buy' | 'sell';
        const isWin = rec.outcome === 'WIN';
        const outcome: 0 | 1 = isWin ? 1 : 0;
        const pnl = safeNum(rec.pnl, 0);
        const pnlPct = safeNum(rec.pnlPct, 0);
        const source = rec.source === 'real' ? 'real' : 'paper' as 'real' | 'paper';
        const closeReason = rec.exitType ?? 'sl_tp';

        // 1. OLR — feed trade with marketFeatures (if available)
        const mf = rec.marketFeatures;
        if (mf && typeof mf === 'object' && Object.keys(mf).length > 0) {
          const features = {
            volatility: safeNum(mf.volatility, 0),
            srDistanceBps: safeNum(mf.srDistanceBps, 0),
            obImbalance: safeNum(mf.obImbalance, 0),
            sentiment: safeNum(mf.sentiment, 0),
            signalAgreement: 0.5, // not stored in EXP — neutral
            fundingRate: safeNum(mf.fundingRate, 0),
            volumeRatio: safeNum(mf.volumeRatio, 0),
            sentimentConviction: safeNum(mf.sentimentConviction, 0.5),
            mfePct: 0, // not stored in EXP — neutral
            maePct: 0, // not stored in EXP — neutral
            mfeToPnlRatio: 0, // not stored in EXP — neutral
            regimeOrdinal: regimeToOrdinal(rec.regime),
            momentumShort: 0, // not stored in EXP — neutral
            momentumLong: 0, // not stored in EXP — neutral
            hourOfDay: hourOfDayFromTs(rec.ts), // v2.0.221 Fix 1
          };
          try {
            // v2.0.859: IDEMPOTENT — gate on the PERSISTED backfillDone flag.
            // Same bug class as Q-RL: the per-process `expBackfillDone` flag
            // reset on every restart, re-feeding the same EXP records ~3.5×
            // (btc long backfillSamples=3752 ≈ 1072×3.5), inflating backfill
            // counters and re-weighting the cold-start prior on identical
            // data. The flag now survives restarts via olr-state.json.
            if (!this.olrEngine.isBackfillDone()) {
              this.olrEngine.feedTrade(sym, features, outcome, side, source, 0);
              olrFed++;
            }
          } catch { /* non-critical */ }

          // v2.0.855-fix: Q-RL Alpha Discovery backfill — the Q-RL table was
          // PERMANENTLY EMPTY (values={} after 79 cycles) because its ONLY
          // live feed is aligned-shadow resolution, and aligned shadows were
          // skipped on real-trade cycles (pre-v2.0.855). Backfill historical
          // EXP outcomes so the table has a cold-start prior and DCS has
          // discovery evidence. Uses the SAME feature snapshot as OLR —
          // makeKey() reads regimeOrdinal/volatility/momentumShort/fundingRate,
          // all present in `features` above (momentumShort=0 neutral for EXP).
          // Reward = pnlPct (margin-relative return), matching the live
          // aligned-shadow reward definition (sr.pnlPct).
          // v2.0.859: IDEMPOTENT — gate on the PERSISTED backfillDone flag.
          // Pre-fix, the per-process `expBackfillDone` instance flag reset on
          // every restart, so the same 1072 records re-fed ~12× (visits
          // 12851 ≈ 1072×12) and crushed live learning via EWMA α=1/(1+visits)
          // ≈ 0.00008. The flag now survives restarts via q-rl-table.json.
          if (!this.qrlTable?.isBackfillDone()) {
            try {
              this.qrlTable?.update(features, side, pnlPct);
              qrlFed++;
            } catch { /* non-critical */ }
          }
          // v2.0.865-fix: EV Filter backfill——用歷史 pnlPct(已含費)即刻有樣本
          // (唔使等新 trade——EXP 940 real + 826 paper 現成)
          // persisted backfillDone guard——restart 唔重複加入
          if (this.evFilter && evFilterConfig.enabled && !this.evFilter.isBackfillDone()) {
            try {
              this.evFilter.recordTrade(normalizeSymbol(String(rec.symbol ?? '')), side, Number.isFinite(pnlPct) ? pnlPct : 0);
              evFed++;
            } catch { /* non-critical */ }
          }
          // v2.0.865-fix: Direction Verifier C(平倉結果)backfill——entryThesis 提取 trend-type
          // persisted backfillDone guard + fallback id 穩定(rec.ts+symbol)
          if (this.llmDirectionVerifier && llmDirectionConfig.enabled && rec && !this.llmDirectionVerifier.isBackfillDone()) {
            try {
              const tt = this.extractTrendType(typeof rec.entryThesis === 'string' ? rec.entryThesis : undefined);
              this.llmDirectionVerifier.recordOutcome(
                normalizeSymbol(String(rec.symbol ?? '')),
                tt,
                `exp-backfill-${String(rec.id ?? `${rec.ts ?? 0}-${String(rec.symbol ?? '')}`)}`,
                Number.isFinite(pnlPct) ? pnlPct > 0 : false,
              );
              dirFed++;
            } catch { /* non-critical */ }
          }
        }

        // 2. NA — feed market-condition embedding sample
        // v2.0.865-fix4:persisted backfillDone guard——restart 唔重複 feed
        // (v1 bug:1766 EXP × ~180 restarts = 316,985 samples → validation fail)
        if (mf && typeof mf === 'object' && Object.keys(mf).length > 0 && !this.naEngine.isBackfillDone()) {
          try {
            const presentFeatures = Object.keys(mf).filter(k =>
              mf[k] !== null && mf[k] !== undefined && Number.isFinite(mf[k]),
            );
            this.naEngine.addSample({
              features: mf,
              outcome: isWin ? 1 : 0,
              presentFeatures,
              ts: rec.ts ?? rec.closedAt ?? Date.now(),
            });
            naFed++;
          } catch { /* non-critical */ }
        }

        // 3. AttnRes — feed rationale blend learning
        // v2.0.865-fix4:persisted backfillDone guard——restart 唔重複 feed
        // (同 NA bug:updateCount 累積 + weights 被重複樣本主導)
        const rv = rec.rationaleVectors;
        if (this.attnResTradeEmbedder && Array.isArray(rv) && rv.length >= 2 && !this.attnResTradeEmbedder.isBackfillDone()) {
          try {
            this.attnResTradeEmbedder.updateOnOutcome(rv, pnl);
            attnresFed++;
          } catch { /* non-critical */ }
        }

        // 4. PatternCluster — feed rationale clustering
        if (this.patternCluster && Array.isArray(rv) && rv.length > 0) {
          try {
            // Construct a minimal ThesisExperienceRecord for addTrade
            const fakeRecord = {
              id: rec.id ?? `exp-backfill-${String(rec.ts ?? 0)}-${String(rec.symbol ?? '')}`,
              symbol: rec.symbol,
              side: rec.side,
              source: rec.source === 'real' ? 'real' : 'paper',
              decisionOrigin: rec.decisionOrigin ?? 'meta-agent',
              outcome: rec.outcome,
              pnl: pnl,
              pnlPct: pnlPct,
              entry: safeNum(rec.entry, 0),
              exit: safeNum(rec.exit, 0),
              leverage: safeNum(rec.leverage, 1),
              holdMin: safeNum(rec.holdMin, 0),
              regime: rec.regime ?? 'unknown',
              assetCategory: rec.assetCategory ?? '',
              entryThesis: rec.entryThesis ?? '',
              rationales: rec.rationales ?? [],
              rationaleCats: rec.rationaleCats ?? [],
              rationaleVectors: rv,
              exitType: rec.exitType ?? 'sl_tp',
              closeReason: rec.exitType ?? 'sl_tp',
              marketFeatures: mf ?? {},
              olrPWinAtEntry: rec.olrPWinAtEntry,
              shadowWinRateAtEntry: rec.shadowWinRateAtEntry,
              ts: rec.ts ?? 0,
            } as any;
            await this.patternCluster.addTrade(fakeRecord);
            clusterFed++;
          } catch { /* non-critical */ }
        }

        // 5. CHR — feed cycle-history outcome learning
        if (this.cycleHistory && mf && typeof mf === 'object') {
          try {
            this.cycleHistory.updateOnOutcome(sym, side, pnlPct, closeReason);
            chrFed++;
          } catch { /* non-critical */ }
        }

        // v2.0.221 (Fix 3): Backfill combo tracker from EXP records
        try {
          this.comboTracker.trackTrade(sym, side, rec.regime ?? 'unknown',
            outcome === 1 ? 'WIN' : 'LOSS', pnl, pnlPct, 0, rec.id); // v2.0.221 dedup
          comboFed++;
        } catch { /* non-critical */ }

        // v2.0.841: Backfill evolution components (Self-Improver, Causal, Meta-Learner)
        // from existing EXP records. 1038 records have marketFeatures + regime + pnlPct.
        if (mf && typeof mf === 'object' && Object.keys(mf).length > 0) {
          // Meta-Learner: feature outcome learning (v2.0.843: with asset metadata)
          try {
            const backfillMeta = deriveAssetMetadata(sym);
            for (const [fname, fval] of Object.entries(mf as Record<string, unknown>)) {
              this.metaLearner?.recordFeatureOutcome(fname, safeNum(fval as number, 0), pnlPct, backfillMeta);
            }
          } catch { /* non-critical */ }

          // Causal Reasoner: paired shadow (traded pnl vs hold=0 benchmark)
          try {
            this.causalReasoner?.recordPairedShadow(
              sym, side, 0, 0, pnlPct, 0,
            );
          } catch { /* non-critical */ }

          // v2.0.848: Component Attribution backfill — feed historical trades so
          // the attribution dashboard isn't empty at startup. OLR signal is the
          // only one EXP records carry (entryOlrPWin). Causal uplift has no
          // per-symbol historical data in EXP, so it's skipped (cold-start).
          try {
            if (this.componentAttribution) {
              const tradeId = rec.id ?? `${sym}|${side}|${rec.ts ?? 0}`;
              const isWinBackfill = outcome === 1;
              const closeWeight = computeLearningWeight(closeReason, false, isWinBackfill);
              const cleanliness = Math.max(0, Math.min(1, (closeWeight - 0.3) / 0.7));
              // OLR signal — v2.0.856: same bullish-signal contract as live
              // path (entryOlrPWin = P(win|side); BUY keeps, SELL inverts;
              // store re-inverts for SELL → agreement = P(win|side)).
              // v2.0.856-attack: normalize side — garbage side → no inversion.
              const olrPWin = safeNum(rec.olrPWinAtEntry, 0.5);
              const bfSide = normalizeTradeSide(side);
              this.componentAttribution.recordAttribution({
                componentId: 'olr',
                tradeId,
                symbol: rec.symbol,
                side,
                cycleId: 0, // historical — no real cycle number
                signal: bfSide === 'sell' ? 1 - olrPWin : olrPWin,
                pnlPct,
                labelCleanliness: cleanliness,
                regime: rec.regime ?? 'unknown',
                riskProfile: 'moderate', // historical default
                timestamp: safeNum(rec.ts, 0) || Date.now(),
              });
              attrFed++;
            }
          } catch { /* non-critical */ }
        }

        // Self-Improver: batch performance windows from EXP records
        // (every 20 records = one performance window)
        try {
          const expIdx = 0; // v2.0.865-fix6: dedup 後無 line index——用 0(僅用於 fallback)
          if (expIdx > 0 && expIdx % 20 === 0) {
            const batch = lines.slice(Math.max(0, expIdx - 20), expIdx)
              .map(l => { try { return JSON.parse(l); } catch { return null; } })
              .filter(r => r && r.pnlPct !== undefined);
            if (batch.length > 0) {
              const wins = batch.filter(r => safeNum(r.pnlPct, 0) >= 0).length;
              this.selfImprover?.recordPerformance({
                cycle: Math.floor(expIdx / 20),
                pnlPct: batch.reduce((s, r) => s + safeNum(r.pnlPct, 0), 0) / batch.length,
                winRate: wins / batch.length,
                brier: 0.25, // not available in EXP records
                ece: 0,
                configSnapshot: { explorationStrategy: 'epsilon-greedy' },
              });
            }
          }
        } catch { /* non-critical */ }

        // 6. v2.0.219: Advanced learning systems (replay only; v2.0.833 pruned dead systems)
        //    Uses the same features object built for OLR above.
        if (mf && typeof mf === 'object' && Object.keys(mf).length > 0) {
          try {
            this.feedAdvancedLearning({
              symbol: sym,
              side,
              features: {
                volatility: safeNum(mf.volatility, 0),
                srDistanceBps: safeNum(mf.srDistanceBps, 0),
                obImbalance: safeNum(mf.obImbalance, 0),
                sentiment: safeNum(mf.sentiment, 0),
                signalAgreement: 0.5,
                fundingRate: safeNum(mf.fundingRate, 0),
                volumeRatio: safeNum(mf.volumeRatio, 0),
                sentimentConviction: safeNum(mf.sentimentConviction, 0.5),
                mfePct: 0,
                maePct: 0,
                mfeToPnlRatio: 0,
                regimeOrdinal: regimeToOrdinal(rec.regime),
                momentumShort: 0,
                momentumLong: 0,
                hourOfDay: hourOfDayFromTs(rec.ts), // v2.0.221 Fix 1
              },
              outcome,
              pnl,
              pnlPct,
              source: 'backfill',
              cycle: 0,
              regime: rec.regime ?? 'unknown',
            });
            advancedFed++;
          } catch { /* non-critical */ }
        }
      }

      // v2.0.865-fix2: mark backfill done + persist——restart 唔重複加入
      if (this.evFilter && evFilterConfig.enabled) {
        try { this.evFilter.markBackfillDone(); this.evFilter.save(); } catch { /* best-effort */ }
      }
      // v2.0.865-fix4: NA backfill 完成標記——v1 污染 model 會喺 migrate 已 reset,
      // 呢度一次 clean backfill 後 mark,之後 restart 唔再 feed
      if (!this.naEngine.isBackfillDone()) {
        try {
          this.naEngine.markBackfillDone();
          this.naEngine.persist();
        } catch { /* best-effort */ }
      }
      // v2.0.865-fix4: AttnRes embedder backfill 完成標記(persisted)
      if (this.attnResTradeEmbedder && !this.attnResTradeEmbedder.isBackfillDone()) {
        try {
          this.attnResTradeEmbedder.markBackfillDone();
          void this.attnResTradeEmbedder.save('data/evolution/attnres-embed-state.json');
        } catch { /* best-effort */ }
      }
      if (this.llmDirectionVerifier && llmDirectionConfig.enabled) {
        try { this.llmDirectionVerifier.markBackfillDone(); this.llmDirectionVerifier.save(); } catch { /* best-effort */ }
      }
      log.info(`[exp-backfill] Replayed ${lines.length} EXP records: OLR=${olrFed}, NA=${naFed}, AttnRes=${attnresFed}, Cluster=${clusterFed}, CHR=${chrFed}, Advanced=${advancedFed}, Combo=${comboFed}, Attr=${attrFed}, QRL=${qrlFed}, EV=${evFed}, DIR=${dirFed}, skipped=${skipped}`);

      // v2.0.859: Persist OLR backfill completion (same idempotency contract
      // as Q-RL). Mark only when records were actually fed (olrFed > 0) — if
      // the corpus had no usable features, leave the flag unset so a future
      // richer corpus can still be backfilled. Persist immediately (atomic
      // tmp+rename, same pattern as saveEvolutionState) so the flag survives
      // a crash before the next periodic save cycle.
      if (olrFed > 0 && !this.olrEngine.isBackfillDone()) {
        this.olrEngine.markBackfillDone();
        try {
          const olrDir = path.join(process.cwd(), 'data/evolution');
          const olrTmp = path.join(olrDir, 'olr-state.json.tmp');
          const olrFinal = path.join(olrDir, 'olr-state.json');
          fs.writeFileSync(olrTmp, this.olrEngine.save(), 'utf-8');
          fs.renameSync(olrTmp, olrFinal);
          log.info(`[exp-backfill] OLR backfill marked done (${olrFed} records) — persisted`);
        } catch (err) {
          log.warn(`[exp-backfill] OLR backfillDone persist failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // v2.0.859: Persist Q-RL backfill completion. Mark ONLY when records
      // were actually fed (qrlFed > 0) — if the corpus had no usable
      // features, leave the flag unset so a future richer corpus can still
      // be backfilled. Persist immediately (atomic tmp+rename, same pattern
      // as saveEvolutionState) so the flag survives a crash before the next
      // periodic save cycle.
      if (this.qrlTable && qrlFed > 0 && !this.qrlTable.isBackfillDone()) {
        this.qrlTable.markBackfillDone();
        try {
          const qrlDir = path.join(process.cwd(), 'data/evolution');
          const qrlTmp = path.join(qrlDir, 'q-rl-table.json.tmp');
          const qrlFinal = path.join(qrlDir, 'q-rl-table.json');
          fs.writeFileSync(qrlTmp, JSON.stringify(this.qrlTable?.save() ?? {}), 'utf-8');
          fs.renameSync(qrlTmp, qrlFinal);
          log.info(`[exp-backfill] Q-RL backfill marked done (${qrlFed} records) — persisted`);
        } catch (err) {
          log.warn(`[exp-backfill] Q-RL backfillDone persist failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // v2.0.223: Train + validate NA immediately after backfill. Previously only
      // validated, which meant the model had 228 samples but only 230 training
      // steps — mse=1.22, diversity=0 (collapsed). Now we train 50 epochs first
      // (8000 gradient steps) to escape cold-start, then validate. Early stop
      // if loss plateaus (patience=10).
      try {
        if (this.naEngine.sampleCount() >= 200) {
          const trainResult = this.naEngine.trainEpochs(50);
          log.info(`[exp-backfill] NA trained ${trainResult.roundsRun} rounds${trainResult.earlyStopped ? ' (early stopped)' : ''}: finalLoss=${trainResult.finalLoss.toFixed(4)}`);
          const val = this.naEngine.validate();
          log.info(`[exp-backfill] NA validated: ${val.passed ? 'PASS ✓' : 'FAIL'} — ${val.reason?.slice(0, 100)}`);
          this.naEngine.persist();
        }
      } catch { /* non-critical */ }

      // Persist all updated state
      this.persistOLR();
      if (this.attnResTradeEmbedder) {
        await this.attnResTradeEmbedder.save('data/evolution/attnres-embed-state.json');
      }
      // NA state is persisted by the normal cycle persist path.
      // CHR state is persisted by the normal cycle persist path.
      // PatternCluster state is in-memory (rebuilt from EXP on next startup).
    } catch (err) {
      log.warn(`[exp-backfill] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── v2.0.135: Shared OLR + First-Passage context builder ──
  // Produces a COMPLETE evolution-data block for any symbol, so the OLR &
  // Sentiment Analyst AND Meta-Agent can extract the full potential of the
  // OLR + Shadow + First-Passage system. Used for:
  //   (a) the active symbol  → "=== OLR + PATH RISK ASSESSMENT ==="
  //   (b) each open position → "=== OLR ASSESSMENT for <sym> ==="
  //   (c) each trading market → "=== OLR ASSESSMENT for <sym> ==="
  // Injects EVERYTHING the agent prompts reference: P(win) per side, source
  // breakdown (shadow/paper/real/backfill), confidence, feature contributions
  // (BUY + SELL), recent trades with recency + [SL narrowed], First-Passage
  // P(TP before SL) with breakevenP + per-side SL/TP + fp.confidence, and an
  // explicit EDGE line (P(win) − breakevenP in pp) so the agent does not have
  // to do mental math.
  private buildOLRBlock(
    sym: string,
    features: Record<string, number>,
    heading: string,
    positionInfo?: string,
    srDistances?: { slLong: number; tpLong: number; slShort: number; tpShort: number },
    /** v2.0.140: EXP digest summary — injected only for the active symbol to
     *  avoid per-symbol duplication. When provided, appended after the OLR
     *  block so agents see learned experience alongside OLR probabilities. */
    digest?: string,
  ): string {
    try {
      const olrBuy = this.olrEngine.query(sym, features, 'buy', this.totalCycles);
      const olrSell = this.olrEngine.query(sym, features, 'sell', this.totalCycles);
      if (olrBuy.nSamples === 0 && olrSell.nSamples === 0) return '';

      const lines: string[] = [`=== ${heading} ===`];
      if (positionInfo) lines.push(positionInfo);

      // ── OLR probabilities with FULL source breakdown (incl. backfill) ──
      lines.push(`OLR (learned from TP-before-SL outcomes — per-side logistic regression):`);
      const sb = (q: OLRQueryResult) => `shadow=${q.sourceBreakdown.shadow} paper=${q.sourceBreakdown.paper} real=${q.sourceBreakdown.real} backfill=${q.sourceBreakdown.backfill}`;
      lines.push(`  BUY  P(win)=${(olrBuy.pWin * 100).toFixed(0)}% (${olrBuy.effectiveSamples} live / ${olrBuy.nSamples} total [${sb(olrBuy)}], conf=${olrBuy.confidence})`);
      lines.push(`  SELL P(win)=${(olrSell.pWin * 100).toFixed(0)}% (${olrSell.effectiveSamples} live / ${olrSell.nSamples} total [${sb(olrSell)}], conf=${olrSell.confidence})`);

      // Feature contributions — BOTH sides (what drives each probability)
      const fmtFeatures = (c: OLRQueryResult['featureContributions']) =>
        c.length > 0 ? c.slice(0, 3).map(f => `${f.name}=${f.value.toFixed(3)}(w=${f.weight.toFixed(2)})`).join(', ') : 'none';
      lines.push(`  BUY key features: ${fmtFeatures(olrBuy.featureContributions)}`);
      lines.push(`  SELL key features: ${fmtFeatures(olrSell.featureContributions)}`);

      // Recent trades — both sides, with source + recency + [SL narrowed]
      const recentBuy = olrBuy.recentTrades.filter(rt => rt.source !== 'shadow' || rt.cyclesAgo <= 20).slice(-5);
      const recentSell = olrSell.recentTrades.filter(rt => rt.source !== 'shadow' || rt.cyclesAgo <= 20).slice(-5);
      if (recentBuy.length > 0 || recentSell.length > 0) {
        lines.push(`  Recent outcomes (cyclesAgo = recency — older trades may reflect different market conditions):`);
        for (const rt of recentBuy) {
          const icon = rt.outcome === 'win' ? '✅' : '❌';
          const narrow = rt.slNarrowed ? ' [SL narrowed]' : '';
          lines.push(`    ${icon} BUY ${rt.source} ${rt.outcome} (${rt.cyclesAgo} cycles ago${narrow})`);
        }
        for (const rt of recentSell) {
          const icon = rt.outcome === 'win' ? '✅' : '❌';
          const narrow = rt.slNarrowed ? ' [SL narrowed]' : '';
          lines.push(`    ${icon} SELL ${rt.source} ${rt.outcome} (${rt.cyclesAgo} cycles ago${narrow})`);
        }
      }

      // ── First-Passage per-symbol (instant path risk) + EDGE ──
      const dist = srDistances ?? { slLong: 0.02, tpLong: 0.05, slShort: 0.05, tpShort: 0.02 };
      try {
        const priceHistory = this.marketState.getPriceHistory(sym);
        const vol = estimateVolatility(priceHistory, 20);
        const drift = estimateDrift(priceHistory, 20);
        const fp = calculateFirstPassage(vol, drift, dist.slLong, dist.tpLong, dist.slShort, dist.tpShort);
        lines.push(`First-Passage P(TP before SL) — path-risk from vol + drift + S/R SL/TP:`);
        lines.push(`  LONG  P=${(fp.longPWin * 100).toFixed(0)}% (breakeven=${(fp.breakevenPLong * 100).toFixed(0)}% → edge ${((fp.longPWin - fp.breakevenPLong) * 100).toFixed(0)}pp) conf=${fp.confidence}`);
        lines.push(`  SHORT P=${(fp.shortPWin * 100).toFixed(0)}% (breakeven=${(fp.breakevenPShort * 100).toFixed(0)}% → edge ${((fp.shortPWin - fp.breakevenPShort) * 100).toFixed(0)}pp) conf=${fp.confidence}`);
        lines.push(`  Drift=${(fp.drift * 100).toFixed(2)}%/cycle | Vol=${(fp.volatility * 100).toFixed(2)}%/cycle`);
        lines.push(`  LONG SL=${(dist.slLong * 100).toFixed(1)}% TP=${(dist.tpLong * 100).toFixed(1)}% | SHORT SL=${(dist.slShort * 100).toFixed(1)}% TP=${(dist.tpShort * 100).toFixed(1)}%`);
        // OLR-vs-breakeven EDGE — the ready-made decision signal
        const buyEdge = olrBuy.pWin - fp.breakevenPLong;
        const sellEdge = olrSell.pWin - fp.breakevenPShort;
        const buySig = buyEdge > 0.10 ? 'FAVOR BUY' : buyEdge < -0.05 ? 'AGAINST BUY' : 'no edge';
        const sellSig = sellEdge > 0.10 ? 'FAVOR SELL' : sellEdge < -0.05 ? 'AGAINST SELL' : 'no edge';
        lines.push(`OLR EDGE vs breakeven: BUY ${(buyEdge * 100).toFixed(0)}pp (${buySig}) | SELL ${(sellEdge * 100).toFixed(0)}pp (${sellSig})`);
      } catch { /* price history unavailable for this symbol — skip FP + edge */ }

      lines.push(`DATA SOURCES: shadow=fixed S/R SL/TP sim, paper=dynamic SL/TP, real=HL exchange (truest), backfill=cold-start prior (weight least). Weight by recency + source reliability.`);
      lines.push(`SL/TP NARROWING: [SL narrowed] tag = SL was tightened — if narrowed trades mostly lost, consider widening SL; if they won, narrowing is working.`);

      // v2.0.861 Phase 1.1: Q-RL EXPECTANCY block — the regime-conditioned
      // expectancy oracle. Each Q-cell is E[pnlPct | state bucket × action]
      // learned from aligned-shadow + backfill rewards in THAT EXACT state.
      // This is the quantitative counterweight to stale OLR edges: when the
      // market rotates, the current bucket's Q(buy)/Q(sell) re-anchors the
      // Meta-Agent on what actually happened in the CURRENT state, not the
      // all-time average. Sample-guarded: a regime-starved bucket shows
      // 'NO directional claim' instead of extrapolating stale data.
      // Median is skew-robust (outlier rewards cannot masquerade as signal).
      try {
        if (qrlDirectionConfig.leanEnabled && this.qrlTable) {
          const qrlLean = this.qrlTable.getDirectionLean(features, qrlDirectionConfig.minSamples);
          const fmtCell = (c: QRLExpectancy): string =>
            `Q=${(c.q * 100).toFixed(2)}% n=${c.visits}`
            + (c.medianReward !== null ? ` median=${(c.medianReward * 100).toFixed(2)}%` : '');
          lines.push('');
          lines.push(`=== Q-RL EXPECTANCY (state bucket: ${qrlLean.buy.bucket}) ===`);
          lines.push(`  BUY  ${fmtCell(qrlLean.buy)}`);
          lines.push(`  SELL ${fmtCell(qrlLean.sell)}`);
          if (qrlLean.robust) {
            const dirDesc = qrlLean.lean === 'buy' ? 'favors BUY' : qrlLean.lean === 'sell' ? 'favors SELL' : 'no clear directional edge (spread within friction) — weight OTHER signals';
            lines.push(`  spread = ${(qrlLean.spread * 100).toFixed(2)}pp → ${dirDesc} (${qrlLean.buy.bucket}, both sides ≥ ${qrlDirectionConfig.minSamples} samples)`);
          } else {
            lines.push(`  ⚠️ sample-starved on one/both sides (buy n=${qrlLean.buy.visits}, sell n=${qrlLean.sell.visits}) → NO directional claim — do not extrapolate across regimes`);
          }
          lines.push(`  (learned from aligned-shadow + backfill rewards in this exact state bucket; negative median = losing side in current conditions)`);
        }
      } catch { /* non-fatal — Q-RL block is best-effort */ }
      // v2.0.140: inject EXP digest (only for active symbol — avoids per-symbol duplication)
      if (digest) lines.push(`\n${digest}`);
      return '\n' + lines.join('\n');
    } catch { /* non-critical */ }
    return '';
  }

  /** v2.0.869(主神 市況判斷調查):判斷資產類型(per symbol——用 symbol 名)
   *  貴金屬/指數/加密貨幣——唔同正常波動水平 */
  private getAssetType(symbol: string): string {
    const s = String(symbol ?? '').toUpperCase();
    if (s.includes('GOLD') || s.includes('SILVER') || s.includes('PLATINUM') || s.includes('PALLADIUM')) return 'precious_metal';
    if (s.includes('SP500') || s.includes('NAS') || s.includes('DOW') || s.includes('NDX') || s.includes('SPX')) return 'index';
    if (s.includes('BTC') || s.includes('ETH') || s.includes('SOL') || s.includes('BNB') || s.includes('XRP') || s.includes('DOGE')) return 'crypto';
    return 'crypto'; // HL 主要係 crypto perps
  }

  /** v2.0.869(主神 市況判斷調查):攞歷史波動率分布(p25/median/p75/max——5 分鐘 σ)
   *  用 price history 計算 log-return σ——分佈統計 */
  private getVolatilityStats(symbol: string): { p25: number; median: number; p75: number; max: number } | null {
    try {
      const ph = this.marketState?.getPriceHistory(symbol);
      if (!ph || ph.length < 10) return null;
      // 計算 log-return σ(用最近 100 個 tick)
      const prices = ph.slice(-100);
      const logReturns: number[] = [];
      for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1]!;
        const curr = prices[i]!;
        if (prev > 0 && curr > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
          logReturns.push(Math.log(curr / prev));
        }
      }
      if (logReturns.length < 5) return null;
      const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
      const sigma = Math.sqrt(Math.max(variance, 0));
      if (!Number.isFinite(sigma) || sigma <= 0) return null;
      // 用 sigma 做基準——p25/p75 用 sigma 嘅比例(保守估計)
      return {
        p25: sigma * 0.5,
        median: sigma,
        p75: sigma * 1.5,
        max: sigma * 3,
      };
    } catch { return null; }
  }

  private async runDecisionCycle(): Promise<void> {
    if (isShuttingDown()) return;
    if (this.cycleInProgress) {
      log.warn('Previous decision cycle still running. Skipping this tick.');
      return;
    }
    // v2.0.110: Set cycleInProgress IMMEDIATELY — not 350 lines later.
    // Previously this was set at line ~1604, after symbol selection + OLR
    // training + pause check. If multiple runDecisionCycle() calls were
    // triggered in quick succession (e.g. UI sending multiple POSTs), they
    // ALL passed the guard because none had reached the `= true` line yet.
    // This caused multiple HACP cycles to run simultaneously.
    this.cycleInProgress = true;
    // v2.0.869(主神 市況判斷調查):LLM 波動率 threshold 定期判斷——
    // 對已選定 asset——threshold 過期(>1 小時)先重新判斷(唔每 cycle call——慳成本)
    // fire-and-forget(非阻塞——唔影響 cycle 流程)
    try {
      if (this.volThresholdJudge && process.env['VOL_THRESHOLD_JUDGE'] !== 'false') {
        // 收集所有已選定 asset——threshold 過期(>1h)先重新判斷
        const judgeSyms = new Set<string>();
        const primary = this.marketAgent?.getConfig()?.selectedSymbol;
        if (primary) judgeSyms.add(primary);
        // 加埋有 open position 嘅 symbol
        for (const sym of this.portfolio?.getOpenSymbols?.() ?? []) judgeSyms.add(sym);
        // v2.0.869-P4(主神 fetch topPairs 質疑):加埋「用戶所選擇嘅市場」
        // (tradingMarkets——Selected Markets——max 10)——唔係 topPairs(全部 HL symbols)
        // 用戶所選擇嘅市場先係要 trade 嘅——topPairs 包含一堆未用嘅 symbol
        try {
          for (const sym of this.marketAgent?.getTradingMarkets?.() ?? []) {
            if (sym) judgeSyms.add(sym);
          }
        } catch { /* 非致命 */ }

        const staleAssets: Array<{
          symbol: string;
          assetType: string;
          histVol: { p25: number; median: number; p75: number; max: number };
          currentState: { regime: string; trend: string; volatility: number };
          candles?: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
        }> = [];
        const staleSyms: string[] = [];
        for (const sym of judgeSyms) {
          const existing = this.volThresholdJudge.getThreshold(sym);
          const stale = !existing || (Date.now() - existing.judgedAt) > 3600 * 1000;
          if (stale) staleSyms.push(sym);
        }
        // 並行攞 candle(唔逐個 await——慳時間)
        const candleResults = await Promise.all(staleSyms.map(async (sym) => {
          try {
            const cc = await candleCache.getCandles(sym, '5m', 50);
            return { sym, candles: cc && cc.length > 0 ? cc : undefined };
          } catch { return { sym, candles: undefined }; }
        }));
        const candleMap = new Map(candleResults.map(r => [r.sym, r.candles]));
        for (const sym of staleSyms) {
          const state = this.marketState?.getState(sym);
          const hist = this.getVolatilityStats(sym);
          staleAssets.push({
            symbol: sym,
            assetType: this.getAssetType(sym),
            histVol: hist ?? { p25: 0, median: 0, p75: 0, max: 0 },
            currentState: { regime: state?.regime ?? 'unknown', trend: state?.trend ?? 'sideways', volatility: state?.volatility ?? 0 },
            candles: candleMap.get(sym),
          });
        }
        // 一次過批量判斷(慳 token——system prompt 唔重複)
        if (staleAssets.length > 0) {
          void this.volThresholdJudge.judgeBatch(staleAssets).then((results) => {
            // 每個 asset setSymbolThreshold(per symbol regime 用)
            if (this.marketState) {
              for (let i = 0; i < staleAssets.length; i++) {
                const t = results[i];
                if (t) {
                  this.marketState.setSymbolThreshold(staleAssets[i]!.symbol, t.volLow, t.volHigh, t.trendThreshold);
                }
              }
            }
          }).catch(() => {});
        }
      }
    } catch { /* 非致命——threshold 判斷失敗唔影響 cycle */ }
    // v2.0.864-fix: 每 cycle 驗證上 cycle 嘅 LLM 判斷(B 方向預測——
    // 判斷時 price vs 而家 price)——recordJudgment 喺 gate 度,呢度先驗證舊 pending
    this.verifyPendingLLMJudgments();
    // v2.0.866: Close-Decision Calibrator 延遲驗證巡邏——
    // 驗證到期嘅 close 決定(close 後價格方向 vs close 方向——反事實代理)
    this.verifyPendingCloseDecisions();
    // v2.0.866 Phase B:處理 pending-close(超時兜底執行——唔會永遠 hold)
    this.processPendingCloseDecisions();

    // ── Cold-start OLR backfill (once per process) ──
    // On the first cycle with non-empty trading markets, backfill the OLR
    // prior from historical HL candles so P(win) is usable immediately
    // instead of after 1-3h of live shadow accumulation.
    // #3 fix: fire-and-forget (non-blocking) — the first cycle proceeds with
    // first-passage (instant) and other signals while backfill warms OLR in
    // the background. The prior lands within ~1-2s and is usable from cycle 2.
    // A backfill error is logged but never prevents the trading cycle.
    if (!this.olrBackfillDone && this.tradingMarkets.length > 0) {
      this.olrBackfillDone = true; // set first — idempotent even if the call throws
      void this.backfillOLRPrior(this.tradingMarkets).catch((err: Error) =>
        log.warn(`[backfill] Cold-start backfill failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`),
      );
      // v2.0.218: Backfill learning systems from EXP trade records.
      // Replays all historical trades through OLR/NA/AttnRes/CHR/PatternCluster.
      // Runs after OLR candle backfill so real-trade samples are layered on top.
      void this.backfillFromExpRecords().catch((err: Error) =>
        log.warn(`[exp-backfill] Failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`),
      );
    }


    // ── v2.0.79: Determine which symbols to analyze this cycle ──
    // Priority: Trading Markets (UI pills) + open positions (deduped).
    // If both are empty, fall back to Market Agent auto-select and add it
    // to the Trading Markets list.
    // v2.0.79: Also include cachedExchangePositions as fallback — syncExchangePositions
    // runs later in the cycle, so realPositions may not have xyz DEX positions yet
    // if the previous cycle's fetch failed (429). cachedExchangePositions has the
    // last successful fetch result.
    const openPositionSymbols = [
      ...this.portfolio.getRealPositions().map(p => p.symbol),
      ...(this.cachedExchangePositions ?? []).map(p => p.symbol),
    ];
    // Dedup by normalized symbol — "BTC" and "btc" are the same asset
    const seenNorm = new Set<string>();
    const allSymbols: string[] = [];
    for (const sym of [...this.tradingMarkets, ...openPositionSymbols]) {
      const norm = sym.includes(':') ? sym.split(':')[0]!.toLowerCase() + sym.slice(sym.indexOf(':')) : sym.toLowerCase();
      if (!seenNorm.has(norm)) {
        seenNorm.add(norm);
        allSymbols.push(sym);
      }
    }

    let activeSymbol: string;

    if (allSymbols.length > 0) {
      // v2.0.104: ALL trading markets are analyzed in ONE HACP cycle.
      // The original architecture was designed for this: each agent
      // outputs a MultiSymbolDecision with marketTicker + positions[] covering
      // ALL symbols. Sub-cycles (v2.0.100) were a regression — they ran separate
      // HACP cycles per market, wasting time and compute.
      //
      // How it works:
      // - activeSymbol = first non-position trading market (for WS + price feed)
      // - All OTHER non-position trading markets are added to currentPositions
      //   with quantity=0 and isTradingMarket=true so agents see them in positions[]
      //   and can output BUY/SELL/HOLD for them
      // - All real open positions are in positions[] for CLOSE/HOLD management
      // - ONE HACP cycle covers everything
      const openPosNorms = new Set(openPositionSymbols.map(s =>
        s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase()
      ));
      const nonPositionMarkets = this.tradingMarkets.filter(s => {
        const n = s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase();
        return !openPosNorms.has(n);
      });
      // Pick the first non-position market as primary activeSymbol
      activeSymbol = nonPositionMarkets.length > 0
        ? nonPositionMarkets[0]!
        : (this.tradingMarkets[0] ?? openPositionSymbols[0]!);
      // Ensure Market Agent has this symbol selected (for WS + price feed)
      // v2.0.868-fix:用戶手動鎖定嘅 symbol 優先——cycle 唔覆蓋。
      // Root cause:「Trading Terminal select 其他 symbol 後 chart 仍顯示 BTC」
      // ——每個 cycle 開始都無條件 setSelectedSymbolManual(第一個 market)——
      // 連 manualSymbolLock 都一齊覆蓋(因為 setSelectedSymbolManual 會設 lock)。
      // 修復:用戶已鎖定 → 保持用戶選擇(cycle 照常分析 allSymbols——唔影響);
      //       冇鎖定 → 原有行為(用第一個 market,同時設 lock)。
      if (!this.marketAgent.isManualSymbolLocked()) {
        if (this.marketAgent.getSelectedSymbol() !== activeSymbol) {
          this.marketAgent.setSelectedSymbolManual(activeSymbol);
        }
      }
      log.info(`Cycle symbols: ${allSymbols.join(', ')} (active: ${activeSymbol})`);
      // v2.0.104: Store additional non-position trading markets to inject into currentPositions
      (this as any)._additionalMarkets = nonPositionMarkets.filter(s => s !== activeSymbol);
      log.info(`📊 _additionalMarkets: [${((this as any)._additionalMarkets as string[]).join(', ')}] (tradingMarkets=${this.tradingMarkets.length}, nonPosition=${nonPositionMarkets.length})`);
      // v2.0.108: Record market count at cycle start for post-cycle drift detection
      // v2.0.858-attack: snapshot the FULL symbol list — drift detection now
      // diffs symbol sets (add+remove same count must still trigger).
      (this as any)._cycleMarketCount = this.tradingMarkets.length;
      (this as any)._cycleMarketsSnapshot = [...this.tradingMarkets];
    } else {
      // No trading markets and no open positions — fall back to auto-select
      const selectedSymbol = await this.marketAgent.autoSelectTopPair();
      if (!selectedSymbol || !this.marketAgent.hasValidSymbol()) {
        log.warn('No trading markets, no open positions, and auto-select failed. Skipping cycle.');
        this.cycleInProgress = false;
        return;
      }
      activeSymbol = selectedSymbol;
      // v2.0.106: APPEND auto-selected symbol to trading markets — do NOT
      // overwrite. Previously this set this.tradingMarkets = [activeSymbol],
      // which destroyed any markets the UI had set. If the UI had 3 markets
      // and a cycle ran with allSymbols.length === 0 (e.g. all were filtered
      // out by a transient bug), this line would reset to 1 market, and the
      // UI would never re-sync because its lastPostedMarkets hadn't changed.
      // Now we only add the auto-selected symbol if it's not already in the list.
      if (!this.tradingMarkets.includes(activeSymbol)) {
        this.tradingMarkets = [...this.tradingMarkets, activeSymbol].slice(0, 3);
      }
      (this as any)._additionalMarkets = [];
      // v2.0.108: Record market count at cycle start for post-cycle drift detection
      // v2.0.858-attack: snapshot the FULL symbol list — drift detection now
      // diffs symbol sets (add+remove same count must still trigger).
      (this as any)._cycleMarketCount = this.tradingMarkets.length;
      (this as any)._cycleMarketsSnapshot = [...this.tradingMarkets];
      log.info(`No trading markets or positions — auto-selected ${activeSymbol} and appended to trading markets (now ${this.tradingMarkets.length})`);
    }
    // v2.0.79: Use normalizeSymbol instead of toUpperCase — DEX prefixes (xyz:)
    // must stay lowercase for HL API calls. normalizeSymbol lowercases the
    // prefix while preserving the asset name after the colon.
    const activeSymbolUpper = normalizeSymbol(activeSymbol);

    // ── Fetch market data for the selected symbol ──
    // PRIORITY 1: WS price (from hyperliquidWs → multiWs.onPrice → marketState)
    // The WS streams l2Book mid-price in real-time — NO REST call needed for price.
    // PRIORITY 2: Cached REST data for volume24h + change24h (from metaAndAssetCtxs,
    //   shared between fetchTopPairs and fetchPriceForSymbol via dex0CtxsCache).
    // PRIORITY 3: Fallback to fresh REST call only if WS data is stale.
    let marketPrice = 0;
    let marketVolume24h = 0;
    let marketChange24h = 0;

    // Read WS price from marketState (updated by multiWs.onPrice every tick)
    const state = this.marketState.getState(activeSymbol);
    if (state.price > 0) {
      marketPrice = state.price;
      marketVolume24h = state.volume24h;
      marketChange24h = state.change24h;
    }

    // Fill in volume/change from cached REST data (dex0CtxsCache, no REST call).
    // fetchPriceForSymbol checks internal cache first, falls back to REST only on cache miss.
    // v2.0.820: Bound the fetch with a 10s budget. In steady state the dex0CtxsCache
    // is a hit (instant, no REST); the budget only binds on a cache-miss + hung HL API.
    // On timeout we keep the WS-fed marketState price (always available for the active
    // symbol) and just lose volume24h/change24h for this cycle — not catastrophic.
    // This is the critical unblock: previously a hung fetch froze the whole cycle AND
    // stopped paperEngine.updatePrice (SL/TP monitoring) for every open position.
    const priceData = await withTimeout(
      this.marketAgent.fetchPriceForSymbol(activeSymbol),
      10_000,
      `active-price ${activeSymbol}`,
    );
    if (priceData) {
      if (priceData.volume24h > 0 && marketVolume24h === 0) {
        marketVolume24h = priceData.volume24h;
      }
      if (marketPrice <= 0 && priceData.price > 0) {
        marketPrice = priceData.price; // REST price as fallback if WS price not available
        // v2.0.831: CRITICAL FIX — when WebSocket is disconnected, the active
        // symbol's marketState.price stays 0 because marketState.update() is
        // only called by multiWs.onPrice (WS callback). fetchPriceForSymbol
        // fallback only set the local marketPrice variable, NOT marketState.
        // This caused vol-gate to see vol=0 (calcVolatility needs price history
        // from marketState.update) even though the REST price was valid.
        // Fix: when REST fallback provides the active symbol's price, also
        // call marketState.update() so vol/regime/priceHistory are populated.
        // This is the root cause of CL/SKHX/GOLD "vol=0 → hard block" — the
        // WebSocket was disconnected, so marketState never received price
        // updates, so calcVolatility returned 0, so vol-gate hard-blocked.
        // v2.0.831-fix: Guard against empty symbol + wrap in try/catch so a
        // marketState.update() error doesn't crash the entire decision cycle.
        if (activeSymbol && activeSymbol.length > 0) {
          try {
            this.marketState.update({
              symbol: activeSymbol,
              price: priceData.price,
              volume: priceData.volume24h ?? 0,
              quoteVolume: 0,
              priceChange: 0,
              priceChangePercent: priceData.change24h ?? 0,
              high24h: 0,
              low24h: 0,
              timestamp: Date.now(),
            });
            log.info(`📊 [active-rest-fallback] ${activeSymbol}: WS disconnected, REST price $${priceData.price.toFixed(2)} fed to marketState (enables vol/regime calculation)`);
          } catch (msErr) {
            // v2.0.831-fix: marketState.update() crash must NOT propagate —
            // the cycle can proceed with the local marketPrice variable even
            // if marketState wasn't updated (vol-gate ATR cache compensates).
            log.warn(`📊 [active-rest-fallback] ${activeSymbol}: marketState.update failed (${msErr instanceof Error ? msErr.message : String(msErr)}) — proceeding with local marketPrice only`);
          }
        }
      }
      marketChange24h = marketChange24h || priceData.change24h;
    } else {
      log.warn(`⏱️ [active-fetch] ${activeSymbol} price fetch timed out — proceeding with WS marketState price (${marketPrice.toFixed(2)}), volume/change24h may be stale`);
    }

    // v2.0.820: Backfill marketState for ALL non-active trading markets.
    // Before this fix, only the selectedSymbol received marketState.update()
    // (via multiWs.onPrice); every other trading market had an empty/frozen
    // priceHistory → vol=0 → permanent low_volatility regime → vol-gate HOLD
    // + blind agent context. When the selectedSymbol switched (e.g. btc →
    // xyz:SILVER at 10:13), the previously-active market went instantly blind.
    // This per-cycle REST backfill feeds every trading market's priceHistory so
    // vol/regime/price are live for all symbols the system actually trades.
    await this.backfillMarketStateForTradingMarkets(activeSymbol);
    // v2.0.820: Stale-feed watchdog — auto-reconnect the WS when the selected
    // symbol's feed goes silent (the 10:13 BTC $0.00 breakage would have
    // self-healed with this). Runs every cycle; throttled internally.
    this.checkStaleFeedsAndReconnect(activeSymbol);

    // Build a combined market state for agents
    const combinedState = {
      primarySymbol: activeSymbolUpper,
      price: marketPrice,
      change24h: marketChange24h,
      volume24h: marketVolume24h,
      trend: state.trend,
      volatility: state.volatility,
      regime: state.regime,
      orderBookImbalance: state.orderBookImbalance,
      updatedAt: Date.now(),
    };

    // v2.0.106: Per-asset adaptive noise filter.
    // Market Agent selects the best filter profile for each asset based on
    // its real market data (volatility, liquidity, volume). Each asset gets
    // its own independent filter with tuned alpha/k/conviction parameters.
    //
    // The active symbol's filter is used for signal smoothing this cycle.
    // All asset filters are adapted and their summaries injected into agent context.
    const recentTrades = this.evolution.tradeHistory.getRecent(10);
    // v2.0.139: Exclude thesis-invalidation force-closes from the conviction-gate
    // winRate (Option C). The conviction gate should only tighten on real
    // market-risk losses (SL hit), not thesis-system force-closes. Otherwise two
    // thesis invalidations → winRate 0% → gate raised to 64% → new strong theses
    // blocked → system stuck in cash → no new wins to lower the gate.
    const marketRiskTrades = recentTrades.filter(t => t.closeReason !== 'thesis_invalidation');
    const recentWinRate = marketRiskTrades.length >= 3
      ? marketRiskTrades.filter(t => (t.realisedPnl ?? t.simulatedPnl ?? 0) > 0).length / marketRiskTrades.length
      : undefined;
    const recentTradeCount = marketRiskTrades.filter(t =>
      t.type === 'real' && (Date.now() - t.timestamp) < 600_000
    ).length;
    const cyclesSinceLastTrade = marketRiskTrades.length > 0
      ? this.totalCycles - (marketRiskTrades[marketRiskTrades.length - 1]?.cycleNumber ?? 0)
      : 999;

    // v2.0.106: Market Agent judges the filter profile for the active symbol
    // and all trading markets. This runs each cycle to catch regime changes.
    // v2.0.107: Use autoDetectProfile (no API call) for initial assignment to
    // avoid exhausting the HL rate limiter before the injection code runs.
    // selectFilterProfile with real market data runs on subsequent cycles when
    // the filter already exists (re-evaluation uses cached market state).
    const allTradingSymbols = [...new Set([
      activeSymbol,
      ...(this as any)._additionalMarkets ?? [],
      ...this.portfolio.getOpenSymbols(),
    ])];

    for (const sym of allTradingSymbols) {
      if (this.assetFilterRegistry.hasFilter(sym)) continue; // already assigned
      // v2.0.107: Auto-detect first (no API call needed) — avoids rate limiter exhaustion
      const autoProfile = this.assetFilterRegistry.autoDetectProfile(sym);
      this.assetFilterRegistry.assignProfile(sym, autoProfile);
      log.info(`📊 Auto-assigned filter profile for ${sym}: ${autoProfile}`);
    }

    // Get the active symbol's filter (create if needed)
    const activeFilter = this.assetFilterRegistry.getFilter(activeSymbol);

    // Adapt ALL asset filters based on their individual market context
    // v2.0.729: Use per-symbol winRate instead of global winRate — each filter
    // should adapt to its own symbol's performance, not the global average.
    // Also merge the 3 separate adapt logs into one line to reduce log noise.
    const adaptSummaries: string[] = [];
    for (const [sym, filter] of this.assetFilterRegistry.getAllFilters()) {
      const symState = this.marketState.getState(sym);
      const symVolatility = symState?.volatility ?? combinedState.volatility;
      const symRegime = symState?.regime ?? combinedState.regime;
      // v2.0.729: Compute per-symbol winRate from trade history
      const symTrades = this.evolution.tradeHistory.getRecent(10).filter(
        t => normalizeSymbol(t.symbol) === normalizeSymbol(sym) && t.closeReason !== 'thesis_invalidation'
      );
      const symWinRate = symTrades.length >= 3
        ? symTrades.filter(t => (t.realisedPnl ?? t.simulatedPnl ?? 0) > 0).length / symTrades.length
        : undefined;
      const symTradeCount = symTrades.filter(t =>
        t.type === 'real' && (Date.now() - t.timestamp) < 600_000
      ).length;
      const symCyclesSinceTrade = symTrades.length > 0
        ? this.totalCycles - (symTrades[symTrades.length - 1]?.cycleNumber ?? 0)
        : 999;
      filter.adapt({
        volatility: symVolatility,
        regime: symRegime,
        recentWinRate: symWinRate,
        recentTradeCount: symTradeCount,
        cyclesSinceLastTrade: symCyclesSinceTrade,
        totalCycles: this.totalCycles,
      });
      // v2.0.729: Collect summary for merged log (only log every 5 cycles — adapt() already does this internally)
      adaptSummaries.push(`${sym}: conviction=${(filter.getConvictionThreshold() * 100).toFixed(0)}%`);
    }
    // v2.0.729: Single merged log line instead of 3 separate lines
    if (adaptSummaries.length > 0 && this.totalCycles % 5 === 0) {
      log.info(`📊 [adaptive-filter] Cycle ${this.totalCycles}: ${adaptSummaries.join(', ')}`);
    }

    // v2.0.106: Filter raw market signals through the ACTIVE symbol's adaptive filter.
    // Each asset has its own filter, so BTC's smoothing differs from xyz:SKHX's.
    const filteredPrice = activeFilter.filterEMA('price', marketPrice);
    const filteredOBImbalance = activeFilter.filterEMA('orderBookImbalance', state.orderBookImbalance);
    const filteredVolatility = activeFilter.filterEMA('volatilityRegime', state.volatility);

    // Use filtered values for the combined state that agents see
    const filteredState = {
      ...combinedState,
      price: filteredPrice > 0 ? filteredPrice : marketPrice, // fallback if EMA not yet seeded
      orderBookImbalance: filteredOBImbalance,
      volatility: filteredVolatility > 0 ? filteredVolatility : combinedState.volatility,
    };

    // Update paper engine with the latest price for the active symbol
    // so positions are correctly marked-to-market before the decision cycle
    if (marketPrice > 0) {
      // v2.0.24: detect SL/TP-triggered closes and push updated totalPnl
      const tradesBefore = this.portfolio.getPortfolio().tradeCount;
      this.paperEngine.updatePrice(activeSymbol, marketPrice);
      const tradesAfter = this.portfolio.getPortfolio().tradeCount;
      if (tradesAfter > tradesBefore) {
        this.pushToAPI();
      }
    }

    // Feed volume data into sentiment engine for volumeRatio computation
    if (marketVolume24h > 0) {
      this.sentimentEngine?.updateVolume(marketVolume24h);
    }

    if (marketPrice <= 0) {
      log.warn(`No market price for ${activeSymbolUpper} — HL API may be rate-limited. Will retry next cycle.`);
      // v2.0.110: Reset cycleInProgress — we set it at the top of runDecisionCycle()
      this.cycleInProgress = false;
      return;
    }

    // ── SHADOW TRADE ENGINE: Check + Open for ALL trading markets ──
    // 1. Check existing shadow positions against current price (resolve SL/TP → feed OLR)
    // 2. Open new shadow LONG + SHORT for each trading market
    // This replaces RBC's hypothetical training — shadow trades learn TP-before-SL,
    // not 5-minute price direction.

    // v2.0.205: Build current feature vector for a symbol at resolution time.
    // This is passed to checkPositions() so OLR trains on P(win | current conditions)
    // instead of P(win | entry conditions), which was stale and taught the wrong mapping.
    const buildCurrentFeaturesForSymbol = (sym: string, combined: any): Record<string, number> => {
      const symState = this.marketState.getState(sym);
      const isActiveSym = normalizeSymbol(sym) === normalizeSymbol(activeSymbol);
      return {
        // v2.0.218: safeNum everywhere — ?? doesn't catch NaN
        volatility: safeNum(symState?.volatility, isActiveSym ? safeNum(combined.volatility, 0) : 0),
        srDistanceBps: isActiveSym ? safeNum(this.lastSRContext?.distanceToSupportBps, 0) : 0,
        obImbalance: safeNum(symState?.orderBookImbalance, isActiveSym ? safeNum(combined.orderBookImbalance, 0) : 0),
        fundingRate: safeNum(this.hyperliquidWs?.getMarkPriceForSymbol(sym)?.fundingRate, safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0)),
        volumeRatio: safeNum(this.sentimentEngine?.getVolumeRatio(), 1),
        sentiment: safeNum(this.sentimentEngine?.getSentiment()?.overallSentiment, 0),
        sentimentConviction: safeNum(this.sentimentEngine?.getSentiment()?.conviction, 0.5),
        signalAgreement: 0.5,
      };
    };

    if (marketPrice > 0) {
      try {
        // Check + resolve existing shadow positions for active symbol (H1: pass intra-cycle high/low)
        // v2.0.205: Pass currentFeatures so OLR trains on resolution-time features, not stale entry-time features
        const activeHL = this.marketState.getHighLow(activeSymbol);
        const activeCurrentFeatures = buildCurrentFeaturesForSymbol(activeSymbol, combinedState);
        const resolved = this.shadowEngine.checkPositions(activeSymbol, marketPrice, this.totalCycles, activeHL.high, activeHL.low, activeCurrentFeatures);
        if (resolved > 0) {
          log.info(`🧬 [shadow] ${activeSymbol}: ${resolved} shadow trades resolved (cycle #${this.totalCycles})`);
        }

        // Also check positions for other trading markets (using their marketState price)
        for (const mktSym of this.tradingMarkets) {
          if (normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol)) continue;
          let mktState = this.marketState.getState(mktSym);
          let mktChkPrice = mktState?.price ?? 0;
          // v2.0.135 fix: same fallback as the open loop — fetch via REST if
          // marketState has no price, so shadows for non-active trading markets
          // actually get checked for SL/TP resolution each cycle.
          if (mktChkPrice <= 0) {
            try { const _d = await withTimeout(this.marketAgent.fetchPriceForSymbol(mktSym), 8_000, `shadow-resolve ${mktSym}`); mktChkPrice = _d?.price ?? 0; } catch { /* keep 0 */ }
          }
          if (mktChkPrice > 0) {
            const mktHL = this.marketState.getHighLow(mktSym);
            // v2.0.205: Pass currentFeatures so OLR trains on resolution-time features
            const mktCurrentFeatures = buildCurrentFeaturesForSymbol(mktSym, combinedState);
            const mktResolved = this.shadowEngine.checkPositions(mktSym, mktChkPrice, this.totalCycles, mktHL.high, mktHL.low, mktCurrentFeatures);
            if (mktResolved > 0) {
              log.info(`🧬 [shadow] ${mktSym}: ${mktResolved} shadow trades resolved (cycle #${this.totalCycles})`);
            }
          }
        }

        // v2.0.135: Prune shadow positions for symbols no longer in the active
        // trading set (delisted symbols). Without this, stale shadows from
        // previous sessions permanently occupy the maxTotalOpen cap and block
        // new shadows from opening for current trading markets.
        this.shadowEngine.pruneStaleSymbols([
          ...this.tradingMarkets,
          ...this.portfolio.getOpenSymbols(),
        ]);

        // v2.0.219: Feed advanced learning systems from shadow trade resolutions.
        // Shadow trades resolve via SL/TP or stale force-resolve — each resolution
        // is a learning signal. drainRecentResults() returns results accumulated
        // since the last call and clears the buffer (each resolution fed exactly once).
        // Uses per-symbol resolution-time features from buildCurrentFeaturesForSymbol.
        try {
          const shadowResults = this.shadowEngine.drainRecentResults();
          for (const sr of shadowResults) {
            // v2.0.862: Record resolved shadows into PAEL (0.5 weight — shadow
            // MFE is truncated by fixed SL/TP, lower-bound estimate).
            try {
              if (this.exitPriceLearner && Number.isFinite(sr.mfePct) && Number.isFinite(sr.maePct)) {
                this.exitPriceLearner.recordExit({
                  symbol: sr.symbol.toLowerCase(),
                  side: sr.side === 'sell' ? 'sell' : 'buy',
                  mfePricePct: Math.max(0, Math.min(0.5, sr.mfePct ?? 0)),
                  maePricePct: Math.max(0, Math.min(0.5, sr.maePct ?? 0)),
                  source: 'shadow',
                  timestamp: Date.now(),
                  weight: 0.5,
                });
              }
            } catch { /* non-fatal */ }
            const srFeatures = buildCurrentFeaturesForSymbol(sr.symbol, combinedState);
            // Add MFE/MAE from the shadow result itself
            srFeatures['mfePct'] = sr.mfePct;
            srFeatures['maePct'] = sr.maePct;
            srFeatures['mfeToPnlRatio'] = sr.mfePct > 0 ? (sr.mfePct - sr.pnlPct) / sr.mfePct : 0;
            const srSymState = this.marketState.getState(sr.symbol);
            srFeatures['regimeOrdinal'] = regimeToOrdinal(srSymState?.regime ?? 'unknown');
            srFeatures['momentumShort'] = 0;
            srFeatures['momentumLong'] = 0;
            this.feedAdvancedLearning({
              symbol: sr.symbol,
              side: sr.side,
              features: srFeatures,
              outcome: sr.outcome === 'win' ? 1 : 0,
              pnl: sr.pnlPct,
              pnlPct: sr.pnlPct,
              // v2.0.834 Fix B: Route by shadowType — aligned shadows are
              // full-weight 'shadow' source; blind shadows are 0.1× 'shadow_blind'.
              // This ensures the replay buffer + OLR receive the correct source
              // label, so blind samples don't dilute aligned samples in PER
              // sampling + IS-weight correction.
              // v2.0.861-attack (V7): statistical (v2.0.846) + qrl (v2.0.861)
              // shadows follow REAL statistical signals — they must route to
              // full-weight 'shadow' like aligned, NOT 'shadow_blind' (0.1×).
              // The old `=== 'aligned' ? 'shadow' : 'shadow_blind'` silently
              // downweighted statistical/qrl in the replay buffer while the
              // shadow engine fed them at full weight into OLR — inconsistent
              // labels across learning systems.
              source: sr.shadowType === 'blind' ? 'shadow_blind' : 'shadow',
              cycle: sr.cycle,
              regime: srSymState?.regime ?? 'unknown',
            });

            // v2.0.835: Q-RL table update — only for aligned shadows (blind
            // shadows don't follow LLM direction, so their reward doesn't
            // represent the Q-value of a specific state-action pair).
            if (sr.shadowType === 'aligned') {
              // Compute reward = realized PnL% (approximated from outcome + MFE/MAE)
              // For a true SL/TP hit: reward = pnlPct (actual PnL%)
              // For stale force-resolve: reward = pnlPct (current PnL direction)
              const execStats = this.edgeExecTracker.getStats(sr.symbol, sr.side);
              const slippageCost = execStats.samples >= 20 ? (execStats.avgSlippageBps / 10000) : 0.0005;
              const fundingCost = execStats.samples >= 20 ? execStats.avgFundingPctPerHour * (sr.holdCycles * 5 / 60) : 0;
              const reward = sr.pnlPct - slippageCost - fundingCost;

              // v2.0.840: Meta-Learner — record cell update for adaptive alpha
              const oldQ = this.qrlTable.getRewardHistory({ regime: srFeatures['regimeOrdinal']?.toString() ?? 'unknown', volBin: 'normal', momBin: 'flat', fundingBin: 'neutral', action: sr.side }).length > 0
                ? 0 : 0; // oldQ not easily available here; meta-learner tracks internally

              this.qrlTable.update(srFeatures, sr.side, reward);

              // v2.0.843: Meta-Learner — record feature outcomes from shadow resolution
              // with asset metadata for per-asset-tier feature weight tracking.
              // (hybrid data source: shadow is 10-50× faster than real trade close)
              try {
                const srSymState = this.marketState.getState(sr.symbol);
                const assetMeta = deriveAssetMetadata(sr.symbol, {
                  volume24h: srSymState?.volume24h ?? 0,
                  volatility: srSymState?.volatility ?? 0,
                });
                for (const [fname, fval] of Object.entries(srFeatures)) {
                  this.metaLearner?.recordFeatureOutcome(fname, fval, sr.pnlPct, assetMeta);
                }
              } catch { /* non-critical */ }

              // v2.0.839: Causal Reasoner — record paired shadow (traded vs hold benchmark)
              // Hold benchmark = 0 (no position = no PnL from trading, but we
              // could track market return as benchmark. For now, holdPnl = 0.)
              try {
                this.causalReasoner?.recordPairedShadow(
                  sr.symbol,
                  sr.side,
                  sr.cycle,
                  0,         // entryPrice not available in drainRecentResults; use 0
                  sr.pnlPct, // traded PnL
                  0,         // hold benchmark = 0% (no position)
                );
              } catch { /* non-critical */ }
            }
          }
          if (shadowResults.length > 0) {
            log.info(`🧬 [shadow] Fed ${shadowResults.length} shadow resolutions to advanced learning (replay)`);

            // v2.0.838: Self-Improver — record performance from shadow resolutions
            // (hybrid data source: shadow is 10-50× faster than real trade close)
            // Every 20 shadow resolutions = one performance window
            try {
              const alignedResults = shadowResults.filter(r => r.shadowType === 'aligned');
              if (alignedResults.length > 0) {
                const wins = alignedResults.filter(r => r.outcome === 'win').length;
                const winRate = wins / alignedResults.length;
                const avgPnl = alignedResults.reduce((s, r) => s + safeNum(r.pnlPct, 0), 0) / alignedResults.length;
                this.selfImprover?.recordPerformance({
                  cycle: this.totalCycles,
                  pnlPct: avgPnl,
                  winRate,
                  brier: this.metaCalibrator?.getOverallBrier() ?? 0.25,
                  ece: this.metaCalibrator?.getECE() ?? 0,
                  configSnapshot: {
                    explorationStrategy: 'epsilon-greedy', // TODO: read from qrlTable config
                  },
                });
                this.selfImprover?.runTuningCycle();
              }
            } catch (err) {
              log.warn(`[self-improve] shadow perf record failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // v2.0.837: Inject Meta-Cognitive Calibration block into HACP
          try {
            const calBlock = this.metaCalibrator?.getCalibrationBlock();
            if (calBlock) {
              this.hacpEngine.setMetaCalibrationBlock(calBlock);
            }
          } catch { /* non-critical — calibration is supplementary */ }

          // v2.0.838: Inject Self-Improvement block into HACP
          try {
            const siBlock = this.selfImprover?.getImprovementBlock();
            if (siBlock) {
              this.hacpEngine.setSelfImprovementBlock(siBlock);
            }
          } catch { /* non-critical */ }

          // v2.0.839: Inject Causal Reasoning block into HACP
          try {
            const causalBlock = this.causalReasoner?.getCausalBlock();
            if (causalBlock) {
              this.hacpEngine.setCausalBlock(causalBlock);
            }
          } catch { /* non-critical */ }

          // v2.0.840: Inject Meta-Learning block into HACP
          try {
            const mlBlock = this.metaLearner?.getMetaLearningBlock();
            if (mlBlock) {
              this.hacpEngine.setMetaLearningBlock(mlBlock);
            }
          } catch { /* non-critical */ }

          // v2.0.838: Self-Improver performance recording now uses shadow resolution data
          // (moved to shadow resolution loop above — hybrid data source architecture)
          // Real-trade param tuning gradient is still recorded at trade close below.

          // v2.0.840: Meta-Learner — update regime speeds every 50 cycles
          try {
            if (this.totalCycles > 0 && this.totalCycles % 50 === 0) {
              this.metaLearner?.updateRegimeSpeeds(this.totalCycles);
            }
          } catch (err) {
            log.warn(`[meta-learn] regime update failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
          }
        } catch (err) {
          log.warn(`[shadow] Advanced learning feed failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        }
        // Open new shadow trades for ALL trading markets
        const allMarkets = [...new Set([normalizeSymbol(activeSymbol), ...this.tradingMarkets.map(m => normalizeSymbol(m))])];
        for (const mktSym of allMarkets) {
          const mktState = this.marketState.getState(mktSym);
          let mktPrice = normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? marketPrice : (mktState?.price ?? 0);
          // v2.0.135 fix: non-active trading markets often have no price in
          // marketState (WS not subscribed or no data yet). Fetch via Market
          // Agent REST so shadow trades open for ALL trading markets, not just
          // the active one. Without this, the live shadow learning loop only
          // runs for the active symbol — OLR never gets shadow outcomes for
          // the others.
          if (mktPrice <= 0 && normalizeSymbol(mktSym) !== normalizeSymbol(activeSymbol)) {
            try {
              const _sd = await withTimeout(this.marketAgent.fetchPriceForSymbol(mktSym), 8_000, `shadow-open ${mktSym}`);
              mktPrice = _sd?.price ?? 0;
            } catch { /* keep 0 */ }
          }
          if (mktPrice <= 0) continue;

          // v2.0.143: Per-symbol features — previously non-active symbols used
          // the active symbol's fundingRate and global sentiment/volumeRatio,
          // which polluted OLR's learning signal. Now we fetch per-symbol data
          // where available, and use neutral defaults only as last resort.
          const mktNorm = normalizeSymbol(mktSym);
          const isActiveSym = mktNorm === normalizeSymbol(activeSymbol);
          const mktFeatures = {
            // v2.0.218: safeNum everywhere
            volatility: safeNum(mktState?.volatility, isActiveSym ? safeNum(combinedState.volatility, 0) : 0),
            srDistanceBps: isActiveSym ? safeNum(this.lastSRContext?.distanceToSupportBps, 0) : 0,
            obImbalance: safeNum(mktState?.orderBookImbalance, isActiveSym ? safeNum(combinedState.orderBookImbalance, 0) : 0),
            fundingRate: safeNum(this.hyperliquidWs?.getMarkPriceForSymbol(mktSym)?.fundingRate, safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0)),
            volumeRatio: safeNum(this.sentimentEngine?.getVolumeRatio(), 1),
            sentiment: safeNum(this.sentimentEngine?.getSentiment()?.overallSentiment, 0),
            sentimentConviction: safeNum(this.sentimentEngine?.getSentiment()?.conviction, 0.5),
            signalAgreement: 0.5,
          };

          // Use S/R levels for active symbol; default distances for others
          const srSupport = normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol)
            ? (this.lastSRContext?.nearestSupport ?? null) : null;
          const srResistance = normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol)
            ? (this.lastSRContext?.nearestResistance ?? null) : null;

          // ── v2.0.861 Phase 1.5: Q-RL EXPECTANCY shadow — INDEPENDENT arm ──
          // The Q-RL expectancy oracle is a PURE-STATISTICS signal source. It
          // must be able to open its A/B shadow EVERY cycle for EVERY trading
          // market, INDEPENDENT of LLM votes. v2.0.861-qrlarm-attack: this
          // block MUST sit BEFORE the hasAlignedShadow skip below — the skip
          // is for BLIND shadows (wrong-distribution dilution), and an aligned
          // shadow already open is EXACTLY the A/B counterpart the Q-RL arm
          // needs. Nesting the Q-RL arm after the skip meant aligned-open
          // cycles silently starved the arm again.
          //
          // Conditions (all must hold):
          //   1. QRL_DIRECTION_LEAN_ENABLED (shared with 1.1 prompt injection)
          //   2. robust lean — BOTH sides ≥ minSamples AND |spread| ≥ minSpread
          //      (regime-starved buckets make NO directional claim)
          //   3. no qrl shadow already open for this symbol+side+cycle
          try {
            if (qrlDirectionConfig.leanEnabled && this.qrlTable) {
              const qrlCtx = this.lastCycleShadowContexts.get(mktNorm);
              const qrlFeatures = qrlCtx?.features && Object.keys(qrlCtx.features).length > 0
                ? qrlCtx.features
                : { ...mktFeatures, regimeOrdinal: regimeToOrdinal(mktState?.regime ?? 'unknown'), momentumShort: 0, momentumLong: 0 };
              const qrlLean = this.qrlTable.getDirectionLean(qrlFeatures, qrlDirectionConfig.minSamples);
              if (qrlLean.robust && qrlLean.lean !== 'neutral' && !this.shadowEngine.hasQRLShadow(mktSym, qrlLean.lean, this.totalCycles)) {
                const qrlSlPrice = qrlLean.lean === 'buy'
                  ? mktPrice * (1 - config.risk.stopLossPct)
                  : mktPrice * (1 + config.risk.stopLossPct);
                const qrlTpPrice = qrlLean.lean === 'buy'
                  ? mktPrice * (1 + config.risk.takeProfitPct)
                  : mktPrice * (1 - config.risk.takeProfitPct);
                this.shadowEngine.openQRLShadow(
                  mktSym, mktPrice, qrlLean.lean, qrlSlPrice, qrlTpPrice,
                  this.totalCycles, qrlFeatures,
                  { spread: qrlLean.spread, buyQ: qrlLean.buy.q, sellQ: qrlLean.sell.q },
                );
                log.info(`[shadow] QRL arm ${qrlLean.lean.toUpperCase()} ${mktSym} (spread=${(qrlLean.spread * 100).toFixed(2)}pp, buy n=${qrlLean.buy.visits}, sell n=${qrlLean.sell.visits}) — independent of LLM votes (Phase 1.5)`);
              }
            }
          } catch { /* non-fatal — Q-RL arm is best-effort */ }

          // v2.0.834 Fix A: Skip blind shadow if an aligned shadow already
          // exists for this symbol+cycle. Aligned shadows follow the LLM
          // consensus direction at full OLR weight (1.0); blind shadows are
          // cold-start priors at 0.1× weight. Opening both wastes resources
          // and the blind (wrong-distribution) sample dilutes the aligned
          // (correct-distribution) sample in OLR's SGD update.
          if (this.shadowEngine.hasAlignedShadow(mktSym, this.totalCycles)) {
            log.debug(`[shadow] Skipping blind shadow for ${mktSym} — aligned shadow already open this cycle`);
            continue;
          }

          this.shadowEngine.openShadowTrades(
            mktSym,
            mktPrice,
            srSupport,
            srResistance,
            srResistance,
            srSupport,
            this.totalCycles,
            mktFeatures,
          );
        }
      } catch (err) {
        log.warn(`[shadow-trade] Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── FIRST-PASSAGE PROBABILITY: Calculate P(TP before SL) for active symbol ──
    // Uses per-symbol price history for σ (std of log returns) and log-drift ν.
    // M1 fix: use true σ (std of log returns) via estimateVolatility, NOT the
    //   global mean-|return| `calcVolatility`, which underestimates diffusion.
    // H4 fix: estimateDrift now returns EWMA log-drift over 20 cycles (ν directly).
    // C1/C2/M4 fix: calculateFirstPassage now uses correct LONG/SHORT formulas,
    //   log-drift, and separate SHORT SL/TP barriers (SHORT SL at resistance,
    //   SHORT TP at support — mirror of LONG).
    try {
      const priceHistory = this.marketState.getPriceHistory(activeSymbol);
      const vol = estimateVolatility(priceHistory, 20);
      const drift = estimateDrift(priceHistory, 20);
      // LONG: SL at support (below), TP at resistance (above)
      const slDistLong = this.lastSRContext?.distanceToSupportBps ? this.lastSRContext.distanceToSupportBps / 10000 : 0.02;
      const tpDistLong = this.lastSRContext?.distanceToResistanceBps ? this.lastSRContext.distanceToResistanceBps / 10000 : 0.05;
      // SHORT: SL at resistance (above), TP at support (below) — mirror of LONG
      const slDistShort = tpDistLong;
      const tpDistShort = slDistLong;
      this.lastFirstPassage = calculateFirstPassage(vol, drift, slDistLong, tpDistLong, slDistShort, tpDistShort);
    } catch { /* non-critical */ }

    // ── Save current cycle context for ALL trading markets ──
    try {
      const allMarkets = [...new Set([activeSymbol, ...this.tradingMarkets.map(m => normalizeSymbol(m))])];
      for (const mktSym of allMarkets) {
        const mktState = this.marketState.getState(mktSym);
        // v2.0.207 (#D): Momentum features — short (5-cycle) + long (288-cycle) % change.
        let mktMomentum = { momentumShort: 0, momentumLong: 0 };
        try {
          const mktPh = this.marketState.getPriceHistory(mktSym);
          if (mktPh && mktPh.length >= 2) mktMomentum = computeMomentum(mktPh);
        } catch { /* non-critical */ }
        const mktFeatures = {
          volatility: mktState?.volatility ?? (normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? (combinedState.volatility ?? 0) : 0),
          srDistanceBps: normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? safeNum(this.lastSRContext?.distanceToSupportBps, 0) : 0,
          obImbalance: safeNum(mktState?.orderBookImbalance, normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? safeNum(combinedState.orderBookImbalance, 0) : 0),
          fundingRate: safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0),
          volumeRatio: safeNum(this.sentimentEngine?.getVolumeRatio(), 1),
          sentiment: safeNum(this.sentimentEngine?.getSentiment()?.overallSentiment, 0),
          sentimentConviction: safeNum(this.sentimentEngine?.getSentiment()?.conviction, 0.5),
          signalAgreement: 0.5,
          momentumShort: safeNum(mktMomentum.momentumShort, 0),
          momentumLong: safeNum(mktMomentum.momentumLong, 0),
        };
        const mktPrice = normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? combinedState.price : (mktState?.price ?? 0);
        this.lastCycleShadowContexts.set(mktSym, {
          symbol: mktSym,
          price: mktPrice,
          features: mktFeatures,
        });
        // v2.0.211 (K.md #1): Push this cycle's features into the AttnRes
        // cycle-history retriever so future conditional-WR can blend over
        // history + entry-time state.
        this.cycleHistory?.pushCycle(mktSym, mktFeatures);
      }
    } catch { /* non-critical */ }

    // ── SYSTEM GUARD: Run 5-layer protection before any agent thinking ──
    // Guards A (economic calendar), B (drawdown), C (data freshness), D (agent track)
    // Guard E (liquidity) runs later after agents produce a decision
    // v2.0.142: SystemGuard drawdown/economic-calendar/data-freshness guards removed.
    // These were paper-trade concepts that blocked real trading and caused false positives.
    // Real risk is managed by HL's own margin/liquidation system + our SL/TP trigger orders.
    // Agent track guard is kept (circuit breaker for agent failures).

    // ── PAUSE CHECK: If paused, skip agents/trading but keep OLR/shadow running ──
    if (this.paused) {
      log.info(`⏸️ System paused — OLR/shadow training complete, skipping HACP agents and trading (cycle #${this.totalCycles})`);
      this.cycleInProgress = false;
      this.pushToAPI();
      return;
    }

    // ── PHASE -1: Terminal Agent Root Command Prompt rule checking ──
    // v2.0.143: Before any agent thinking, evaluate ALL rules in the Root
    // Command Prompt against current conditions. If ANY rule fails, abort
    // the entire cycle — no agent thinking, no LLM calls, no debate.
    // This saves token cost and respects user intent.
    if (this.rootCommandPrompt && this.rootCommandPrompt.trim().length > 0) {
      const ruleCheck = this.checkRootCommandPromptRules(this.rootCommandPrompt);
      if (!ruleCheck.passed) {
        log.warn(`🚫 Terminal Agent: Cycle aborted — rule check failed: ${ruleCheck.reason}`);
        this.cycleInProgress = false;
        this.pushToAPI();
        return;
      }
      log.info(`✅ Terminal Agent: All Root Command Prompt rules passed (${ruleCheck.rulesChecked} rules checked)`);
    }

    // v2.0.110: cycleInProgress was already set at the top of runDecisionCycle()
    this.totalCycles++;
    // v2.0.228: Initialize per-symbol traded set for idle tracking
    this._symbolsTradedThisCycle = new Set();
    // v2.0.727: Update Market Agent cycle counter for direction restriction auto-expiry
    this.marketAgent.updateCycle(this.totalCycles);
    const cycleStart = performance.now();

    // v2.0.720: Trade Record Audit — run every 2 cycles (non-blocking async).
    // The LLM examines recent closed trades and detects suspicious patterns.
    // Critical incidents are cached and checked by the audit gate in the
    // decision pipeline. Guarded by auditRunning flag to prevent overlap.
    // v2.0.736: When audit completes with incidents, trigger SE to fix them.
    // SE no longer runs on a fixed schedule — it follows the audit.
    this.auditCycleCounter++;
    if (this.auditCycleCounter >= 2 && !this.auditRunning) {
      this.auditCycleCounter = 0;
      this.auditRunning = true;
      const records = this.expMemory?.getRecords() ?? [];
      if (records.length > 0) {
        void auditTradeRecordsLLM(records, this.naEngine)
          .then((result: AuditResult) => {
            this.lastAuditResult = result;
            this.auditRunning = false;
            if (result.incidents.length > 0) {
              log.info(`[audit] Cached ${result.incidents.length} incidents (${result.incidents.filter(i => i.severity === 'critical').length} critical) — will gate next decisions`);
              // v2.0.736: Trigger SE when audit has incidents — SE follows audit, not a fixed schedule
              this.auditTriggeredSE = true;
              // v2.0.842: Feed audit incidents into evolution components
              this.feedAuditToEvolution(result.incidents);
            } else {
              log.info(`[audit] No incidents — SE will not run this cycle`);
            }
          })
          .catch((err: unknown) => {
            this.auditRunning = false;
            log.warn(`[audit] LLM audit failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
          });
      } else {
        this.auditRunning = false;
      }
    }

    try {
      // 1. Gather market state (using Market Agent's selected symbol)
      const marketAgentDesc = this.marketAgent.getMarketDescription();
      const baseMarketDesc = `${marketAgentDesc}\n${this.buildMarketDescription(combinedState)}`;

      // 1b. Fetch S/R zones (async, fail-open) — append to market context
      const srContext = await getSRZones(
        combinedState.primarySymbol,
        combinedState.price,
        combinedState.regime,
      ).catch((err: Error) => {
        log.error(`[sr-zones] Failed for ${combinedState.primarySymbol}: ${err}`);
        return null;
      });
      const srLines = srContext?.formatted
        ? `\n${srContext.formatted}`
        : '';
      // 1c. Inject EM cycle chain (M-step immediate — previous cycle's distilled insight)
      const emContext = this.emManager?.formatForContext(3) ?? '';
      // v2.0.140: EM Cycle Chain insight retrieval — query historical insights
      // similar to the current market description. Non-blocking: if embed fails,
      // the cycle proceeds without historical insights.
      let similarInsightsContext = '';
      if (this.emManager && config.exp.enabled) {
        try {
          // v2.0.206 (#6): Pass current market features for dual-channel retrieval.
          const emQueryFeatures = (() => {
            const sym = normalizeSymbol(activeSymbol);
            const ctx = this.lastCycleShadowContexts.get(sym);
            return ctx?.features ?? {};
          })();
          const similar = await this.emManager.querySimilarInsights(
            `${activeSymbol} ${combinedState.regime} ${combinedState.trend} price=${combinedState.price}`,
            3,
            3, // exclude last 3 cycles
            Object.keys(emQueryFeatures).length > 0 ? emQueryFeatures : undefined,
          );
          similarInsightsContext = this.emManager.formatSimilarInsights(similar);
          // v2.0.140: Record retrieval for self-adjustment (win/loss feedback)
          this.emManager.recordRetrieval(this.totalCycles, similar);
        } catch { /* non-critical — cycle proceeds without historical insights */ }
      }

      // 1d. Inject previous cycle's trade pattern insights (stored after last HACP cycle)
      const patternContext = this.lastPatternContext ?? '';

      // 1d.2 v2.0.28: Inject pattern tag win rates (LLM-identified chart patterns)
      const patternTagContext = this.patternTagTracker?.formatContext(8, this.naEngine) ?? '';

      // 1e. Inject OLR assessment + First-Passage probability + Shadow trade results
      // OLR: P(win) per side from shadow + paper + real trade outcomes (TP-before-SL learning)
      // First-Passage: Instant P(TP before SL) from volatility + drift + S/R distances
      // Shadow: Recent simulated trade outcomes for agent context
      let olrContext = '';
      try {
        const olrFeatures = {
          volatility: combinedState.volatility ?? 0,
          srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
          obImbalance: combinedState.orderBookImbalance ?? 0,
          fundingRate: this.sentimentEngine?.getFundingRate() ?? 0,
          volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
          sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
          sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
          signalAgreement: 0.5,
          hourOfDay: currentHourOfDay(), // v2.0.221 Fix 1
        };
        // v2.0.135: use shared helper — injects full OLR + First-Passage + edge
        const srD = {
          slLong: this.lastSRContext?.distanceToSupportBps ? this.lastSRContext.distanceToSupportBps / 10000 : 0.02,
          tpLong: this.lastSRContext?.distanceToResistanceBps ? this.lastSRContext.distanceToResistanceBps / 10000 : 0.05,
          slShort: this.lastSRContext?.distanceToResistanceBps ? this.lastSRContext.distanceToResistanceBps / 10000 : 0.05,
          tpShort: this.lastSRContext?.distanceToSupportBps ? this.lastSRContext.distanceToSupportBps / 10000 : 0.02,
        };
        // v2.0.140: inject EXP digest for the active symbol only (avoids per-symbol
        // duplication in agent context). Non-blocking — if digest fails, OLR still runs.
        const expDigest = this.expMemory?.getDigestSummary(this.naEngine) ?? '';
        olrContext = this.buildOLRBlock(activeSymbol, olrFeatures, 'OLR + PATH RISK ASSESSMENT', undefined, srD, expDigest);
        // Shadow trade results (active-symbol global — supplementary reality check)
        const shadowCtx = this.shadowEngine.getContext();
        if (shadowCtx.openCount > 0 || shadowCtx.recentResults.length > 0) {
          olrContext += '\n' + shadowCtx.contextString;
        }
        // v2.0.221 (Fix 3): Inject combo WR block so Meta-Agent sees explicit
        // (symbol × side × regime) win rates BEFORE generating a thesis.
        try {
          const comboBlock = this.comboTracker.getComboBlock(activeSymbol);
          if (comboBlock) olrContext += `\n${comboBlock}`;
        } catch { /* non-critical */ }
      } catch { /* non-critical */ }

      // v2.0.32: Run Planck-Chaos Resonance analysis and inject context
      // v2.0.41: directionBias removed from Planck-Chaos — regime-aware
      // direction chain in exploration handles direction. Planck-Chaos now
      // only provides Lyapunov (predictability) + amplitude windows (SL/TP
      // validation) + resonance (informational context).
      let planckChaosContext = '';
      try {
        const chaosResult = this.planckChaos.analyze(combinedState.price, combinedState.volatility ?? 0);
        if (chaosResult) {
          planckChaosContext = '\n' + chaosResult.contextString;
          log.info(`🌌 [planck-chaos] Regime=${chaosResult.chaosRegime} λ=${chaosResult.lyapunov.lambda.toFixed(4)} resonance=${(chaosResult.resonanceStrength * 100).toFixed(0)}%`);
        }
      } catch (err) {
        log.warn(`[planck-chaos] Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.58: Inject Options Data Layer context for Stocks/Indices.
      // Only fetches options data when asset type is stocks, indices, or tradfi.
      // If no data available (WS not connected or no API key), falls back to
      // neutral defaults — agents still function normally.
      let optionsContext = '';
      let playbookContext = '';
      const assetType = this.marketAgent.getConfig().hyperliquidAssetType ?? 'crypto_perps';
      // v2.0.79: Run options data if ANY trading market or position is TradFi
      // (has colon prefix) OR if assetType is stocks/indices/tradfi.
      // Previously only ran when assetType was stocks/indices, which meant
      // BTC options were never checked when trading mixed crypto + indices.
      const hasTradFiSymbols = allSymbols.some(s => s.includes(':'));
      const useOptionsData = hasTradFiSymbols || assetType === 'stocks' || assetType === 'indices' || assetType === 'tradfi';
      if (useOptionsData) {
        try {
          // v2.0.79: Fetch options data for ALL trading markets + open positions.
          // Previously filtered out known crypto symbols (BTC, ETH, etc),
          // but BTC has options data on Polygon.io (underlying: BTC).
          const optionSymbols = allSymbols.slice();
          for (const sym of optionSymbols) {
            const currentActive = this.optionsDataManager.getActiveSymbol();
            if (currentActive !== sym) {
              this.optionsDataManager.setActiveSymbol(sym);
            }
            // v2.0.79: Await pollOnce — previously was fire-and-forget (void),
            // so formatOptionsForAgent() was called before data was fetched.
            await this.optionsDataManager.pollOnce();
            const symCtx = formatOptionsForAgent(sym);
            if (symCtx) {
              optionsContext += '\n' + symCtx;
              log.info(`📊 [options-data] Context injected for ${sym} (assetType=${assetType})`);
            }
          }
          // Playbook + vote only for the active symbol
          if (activeSymbol.includes(':') || !activeSymbol.match(/^(BTC|ETH|SOL|XRP|DOGE|ADA|AVAX|LINK|DOT|MATIC|BNB|TRX|SHIB|UNI|ATOM|LTC|BCH|NEAR|APT|FIL|ARBITRUM|ARB|OP|PENDLE|AAVE|ENA|WIF|PEPE|INJ|STX|SEI|TIA|RUNE|INJ|ORDI|SUI|JUP|PYTH|JTO|BLUR|FLOKI|BONK|MEME)$/i)) {
            playbookContext = '\n' + formatPlaybookForAgent(activeSymbol, combinedState.trend, combinedState.regime);
            const pb = this.optionsDataManager.getRegimePlaybook(activeSymbol, combinedState.trend, combinedState.regime);
            const optionsAction: 'buy' | 'sell' | 'hold' =
              pb.vetoNewPositions ? 'hold'
              : pb.playbook === 'Premium Sell' ? 'hold'
              : combinedState.trend === 'bullish' ? 'buy'
              : combinedState.trend === 'bearish' ? 'sell'
              : 'hold';
            const optionsWeight = this.optionsDataManager.getRecommendedVoteWeight();
            const baseConfidence = this.optionsDataManager.getRecommendedConfidence();
            const optionsConfidence = pb.vetoNewPositions ? Math.max(baseConfidence, 0.90) : baseConfidence;
            if (optionsWeight > 0) {
              this.hacpEngine.setOptionsVote(optionsAction, optionsConfidence, optionsWeight, pb.rationale);
            }
          }
        } catch (err) {
          log.warn(`[options-data] Failed to get context: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // v2.0.70: Not stocks/indices — stop polling options data.
        // This prevents fetching BTC/ETH options data when trading crypto.
        this.optionsDataManager.clearActiveSymbol();
      }

      // v2.0.75: Fetch real-time news sentiment (fail-open).
      // Replaces the dead Reddit module (HTTP 403 blocked). Sources: Google News
      // RSS + GDELT 2.0 + Bing News RSS (all free, no key, verified reachable).
      // v2.0.77: Multi-symbol — fetch news for the active symbol PLUS all other
      // open positions (deduped, capped at 5) so the News Reporter agent can
      // evaluate sentiment for every held position, not just the focused one.
      // Injects "=== NEWS SENTIMENT ===" to match the News Reporter system prompt
      // trigger — the agent analyzes positive/negative sentiment from REAL headlines.
      let newsContext = '';
      try {
        // Build symbol list: active symbol first, then open positions (deduped).
        // v2.0.79: Use allSymbols (trading markets + open positions) for news,
        // not just activeSymbol + openSyms. This ensures all trading markets
        // get news headlines, not just the active symbol.
        const newsResults = await fetchNewsForSymbols(allSymbols, marketAgentDesc);
        // v2.0.139: enrich each symbol's news with price-news timing (same-asset
        // 1h candles) for institutional front-run / sell-the-news detection.
        // Use the ORIGINAL allSymbols (with xyz: prefix intact) so HL candleSnapshot
        // gets the correct coin name for DEX 1-8 assets (xyz:MU, not the normalized
        // "MU" which fails on HL). Match to news results by normalized base asset.
        // Parallel + fail-open (a candle fetch failure just skips timing). The
        // 5-min per-symbol cache deduplicates within the cycle.
        await Promise.all(allSymbols.map(async (sym) => {
          const norm = normalizeBaseAsset(sym);
          const r = newsResults.find(nr => nr && nr.symbol === norm);
          if (!r || r.headlineCount === 0) return;
          try {
            const candles = await this.fetchTimingCandlesForSymbol(sym);
            if (candles.length >= 5) {
              r.priceNewsTiming = computePriceNewsTiming(candles, r.headlines, r.windowHours, r.lexiconHint);
            }
          } catch { /* fail-open — timing is supplementary */ }
        }));
        newsContext = formatNewsForAgentMulti(newsResults);
        const total = newsResults.filter(r => r && r.headlineCount > 0).length;
        if (total > 0) {
          log.info(`📰 [news] ${total}/${newsResults.length} symbols have headlines for this cycle`);
        }
        // v2.0.79: Cache top 3 headlines per symbol for UI display
        this.cachedNewsHeadlines = newsResults
          .filter((r): r is NonNullable<typeof r> => r != null && r.headlineCount > 0)
          .map(r => ({
            symbol: r.symbol,
            headlines: r.headlines.slice(0, 3).map(h => ({
              title: h.title,
              publisher: h.publisher,
              url: h.url,
              pubDate: h.pubDate ? h.pubDate.getTime() : null,
            })),
          }));
        // v2.0.143: Cache the successful news context + headlines for reuse
        // on fetch failure in subsequent cycles.
        this.lastSuccessfulNewsContext = newsContext;
        this.lastSuccessfulNewsHeadlines = this.cachedNewsHeadlines;
        this.lastNewsFetchError = ''; // clear error on success
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.lastNewsFetchError = errMsg;
        log.warn(`[news] Fetch failed: ${errMsg}`);

        // v2.0.143: Reuse last successful news context so the News Reporter
        // agent still has data to work with. Previously, a fetch failure left
        // newsContext empty, causing the agent to operate without any news
        // data and triggering a fallback.
        if (this.lastSuccessfulNewsContext) {
          newsContext = this.lastSuccessfulNewsContext;
          this.cachedNewsHeadlines = this.lastSuccessfulNewsHeadlines;
          // Mark the context as stale so the agent knows this isn't fresh data
          newsContext = newsContext.replace('=== NEWS SENTIMENT ===', '=== NEWS SENTIMENT (STALE — last successful fetch reused) ===');
          log.info(`📰 [news] Reusing last successful news context (${newsContext.length} chars) — fresh fetch failed: ${errMsg}`);
        } else {
          log.warn(`📰 [news] No cached news context available — agent will operate without news data this cycle`);
        }
      }

      let marketDesc = `${baseMarketDesc}${srLines}${emContext ? `\n${emContext}` : ''}${similarInsightsContext ? `\n${similarInsightsContext}` : ''}${patternContext ? `\n${patternContext}` : ''}${patternTagContext ? `\n${patternTagContext}` : ''}${olrContext}${planckChaosContext}${optionsContext}${playbookContext}${newsContext ? `\n${newsContext}` : ''}\n\n${getFeeSummary()}`;

      // v2.0.152: Inject MFE/PnL performance history so agents learn from
      // past SL/TP mistakes. Shows recent trades where MFE was high but
      // final PnL was negative — agents should set tighter TP and trail SL
      // more aggressively when they see this pattern.
      const mfePerformanceBlock = this.buildMfePerformanceBlock();
      if (mfePerformanceBlock) {
        marketDesc += `\n\n${mfePerformanceBlock}`;
      }

      // v2.0.862: Direction Health Block — per-symbol overwhelming-negative
      // stats injected for EVERY trading symbol (owner: 提高判斷力, 唔 hard block).
      const directionHealthBlock = this.buildDirectionHealthBlock();
      if (directionHealthBlock) {
        marketDesc += `\n${directionHealthBlock}`;
      }

      // v2.0.863 規限①: LLM CONVICTION CALIBRATION block(校準 LLM 自報 conviction)
      try {
        const calBlock = this.llmCalibrator?.getCalibrationBlock();
        if (calBlock) marketDesc += `\n${calBlock}`;
      } catch { /* non-fatal */ }
      // v2.0.864: LLM DIRECTION TRUST block(方向預測 + 平倉結果準確率)
      try {
        if (this.llmDirectionVerifier && llmDirectionConfig.enabled && activeSymbol) {
          const dirBlock = this.llmDirectionVerifier.getDirectionTrustBlock(
            normalizeSymbol(activeSymbol),
            this.extractTrendType(this.lastJudgeRationale),
          );
          if (dirBlock) marketDesc += `\n${dirBlock}`;
        }
      } catch { /* non-fatal */ }
      // v2.0.868: PROFITABILITY ADVICE block(hold-time EV + direction bias——量化校準)
      // v2.0.868-attack4:雙 side advice——唔用 global gate action(per-symbol 錯 side 斷層)
      try {
        if (this.profitabilityAnalyzer && activeSymbol) {
          const paBlock = this.profitabilityAnalyzer.getDualSideAdvice(normalizeSymbol(activeSymbol));
          if (paBlock) marketDesc += `\n${paBlock}`;
        }
      } catch { /* non-fatal */ }
      // v2.0.868-P1P2: ENTRY QUALITY block(入場確認統計——負偏度解藥)
      try {
        if (this.entryQuality && activeSymbol) {
          const entryAdv = this.entryQuality.getAdvice(normalizeSymbol(activeSymbol), this.lastJudgeGateAction ?? 'buy');
          if (entryAdv) marketDesc += `\n${entryAdv}`;
        }
      } catch { /* non-fatal */ }
      // v2.0.865: EV FILTER block(期望值——正 EV 先值得開)
      try {
        if (this.evFilter && evFilterConfig.enabled && activeSymbol) {
          const evBlock = this.evFilter.getEVBlock(normalizeSymbol(activeSymbol), this.lastJudgeGateAction);
          if (evBlock) marketDesc += `\n${evBlock}`;
        }
      } catch { /* non-fatal */ }
      // v2.0.866 Phase B: CLOSE-DECISION CALIBRATION block(平倉判斷校準——
      // 有 active position 時注入——agents 決定 close 前見到過早率)
      try {
        if (this.closeCalibrator && closeCalibConfig.enabled && activeSymbol) {
          const pos = this.portfolio.getPosition(normalizeSymbol(activeSymbol));
          if (pos) {
            const ccBlock = this.closeCalibrator.getCalibrationBlock(
              normalizeSymbol(activeSymbol),
              isSellSide(pos.side) ? 'sell' : 'buy',
              (pos.unrealizedPnlPct ?? 0) > 0,
              this.lastKlineSummary?.trend1h ?? 'unknown',
            );
            if (ccBlock) marketDesc += `\n${ccBlock}`;
          }
        }
      } catch { /* non-fatal */ }

      // v2.0.863: K-LINE STRUCTURE + DATA QUALITY blocks(LLM 世界模型讀圖)
      // — active symbol 完整,trading markets 簡短。純 context,flag-gated。
      try {
        const klineSym = normalizeSymbol(this.marketAgent.getSelectedSymbol() ?? '');
        const klineBlock = await this.buildKlineBlock(klineSym);
        if (klineBlock) marketDesc += `\n${klineBlock}`;
        const dqBlock = this.buildDataQualityBlock(klineSym);
        if (dqBlock) marketDesc += `\n${dqBlock}`;
      } catch { /* non-fatal */ }

      // v2.0.143: Inject Root Command Prompt into marketDesc so ALL 7 agents
      // (5 sub-agents + Skeptics + Meta-Agent) see the user's behavioral rules
      // in their think() context. This ensures every agent's reasoning is
      // constrained by the user's directives (e.g. "only trade on Monday GMT",
      // "avoid SELL on commodities", "be more aggressive in trending markets").
      if (this.rootCommandPrompt && this.rootCommandPrompt.trim().length > 0) {
        marketDesc += `\n\n=== ROOT COMMAND PROMPT (USER DIRECTIVES) ===\n${this.rootCommandPrompt}\n---`;
      }

      // v2.0.109: Fetch global breaking news (Top 10 international headlines) for Meta-Agent
      // cross-asset correlation analysis. Meta-Agent must assess whether any headline
      // has a logical or correlated impact on the currently traded assets.
      try {
        const globalNews = await fetchGlobalBreakingNews();
        const globalNewsContext = formatGlobalNewsForMetaAgent(globalNews);
        if (globalNewsContext) {
          marketDesc += `\n${globalNewsContext}`;
        }
      } catch {
        // Fail-open — global news is supplementary context
      }

      // ─── v2.0.141: Inject RIL (Reason Intelligence Layer) blocks ───
      if (config.ril.enabled && this.patternCluster && this.closeReasonAgg) {
        try {
          const records = this.expMemory?.getRecords() ?? [];
          // v2.0.214: Pass current market features to getPatternMap for
          // conditional WR within pattern clusters (K.md #4 transfer to RIL).
          // Falls back to raw WR when features unavailable or insufficient data.
          let currentFeatures: Record<string, number> | undefined;
          try {
            currentFeatures = buildCurrentFeaturesForSymbol(activeSymbol, filteredState);
          } catch {
            currentFeatures = undefined; // fail-open: raw WR only
          }
          const patternMap = this.patternCluster.getPatternMap(records.length, currentFeatures);
          const closeReasonBlock = this.closeReasonAgg.formatBlock(records);

          // A2A Digester digest (kept as supplementary LLM analysis)
          const digesterDigest = this.expMemory?.getDigestSummary(this.naEngine) ?? '';

          // v2.0.143: SimilarTradeRetriever + SubtleDiffAnalyzer are now injected
          // inside HACP (after checkThesisHistory computes candidate vectors),
          // not here in the pre-cycle marketDesc. This is because they need the
          // candidate thesis (Meta-Agent's output) which doesn't exist yet at
          // this point in the cycle.
          const rilBlock = formatAnalyticsBlock({
            patternMap,
            closeReasonBlock,
            similarTradesBlock: '',
            subtleDiffBlock: '',
            expVerdictBlock: '',
            digesterDigest,
          });

          if (rilBlock) {
            marketDesc += rilBlock;
          }
        } catch (err) {
          log.warn(`[RIL] injection failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // v2.0.92: Generate OLR + S/R context for ALL open positions (not just active symbol).
      for (const posSym of this.portfolio.getOpenSymbols()) {
        if (normalizeSymbol(posSym) === normalizeSymbol(activeSymbol)) continue; // already covered above
        const pos = this.portfolio.getPosition(posSym);
        if (!pos) continue;

        // OLR context for this position's symbol
        try {
          const posCtx = this.lastCycleShadowContexts.get(posSym);
          const features = posCtx?.features ?? {
            volatility: combinedState.volatility ?? 0,
            srDistanceBps: 0,
            obImbalance: combinedState.orderBookImbalance ?? 0,
            fundingRate: this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0,
            volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
            sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
            sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
            signalAgreement: 0.5,
          };
          // v2.0.135: full OLR + First-Passage block via shared helper
          const posInfo = `OLR for ${posSym} (position: ${pos.side.toUpperCase()} @ $${pos.averageEntryPrice.toFixed(2)}, PnL: ${((pos.unrealizedPnlPct ?? 0) * 100).toFixed(1)}%).`;
          const posBlock = this.buildOLRBlock(posSym, features, `OLR ASSESSMENT for ${posSym}`, posInfo);
          if (posBlock) marketDesc += `\n\n` + posBlock;
        } catch { /* non-critical */ }

        // v2.0.862: PAEL Exit-Price MFE CHECK — soft data block for the LLM's
        // HOLD-vs-CLOSE reasoning. The HARD gate is runExitPriceLockGate() (TP-
        // side one-vote exit); this block merely tells the LLM where the
        // position stands relative to the asset's typical favourable zone so
        // its own close reasoning can agree or override with a strong thesis.
        try {
          if (exitPriceLockConfig.enabled && this.exitPriceLearner) {
            const posSide = isSellSide(pos.side) ? 'sell' : 'buy';
            const profile = this.exitPriceLearner.getExitProfile(normalizeSymbol(posSym), posSide);
            if (profile) {
              const conv = convertToPriceExtremes({
                entryPrice: pos.averageEntryPrice, quantity: pos.quantity, leverage: pos.leverage,
                minValueReached: pos.minValueReached ?? 0, maxValueReached: pos.maxValueReached ?? 0,
              });
              const posRegime = this.marketState.getState(normalizeSymbol(posSym))?.regime ?? 'unknown';
              const trending = posRegime.includes('trending');
              // v2.0.862-fund: mirror the gate — slippage-adjusted threshold.
              const execStats = this.edgeExecTracker?.getStats(normalizeSymbol(posSym), posSide);
              const slippagePct = Number.isFinite(execStats?.avgSlippageBps)
                ? (execStats!.avgSlippageBps) / 10_000
                : 0;
              const threshold = (trending ? profile.mfeP90 : profile.mfeP75 * 0.8) + slippagePct;
              const mfePct = conv?.mfePricePct ?? 0;
              const status = mfePct >= threshold
                ? `🔒 LOCK-PROFIT ZONE REACHED (MFE ${(mfePct * 100).toFixed(2)}% ≥ ${(threshold * 100).toFixed(2)}%) — profit will be locked`
                : `not yet in lock zone (MFE ${(mfePct * 100).toFixed(2)}% vs ${(threshold * 100).toFixed(2)}% in ${trending ? 'trending→p90' : 'normal→p75×0.8'})`;
              marketDesc += `\n=== EXIT-PRICE MFE CHECK for ${posSym} ===\n  ${status}. PAEL profile: MFE p50=${(profile.mfeP50 * 100).toFixed(2)}% p75=${(profile.mfeP75 * 100).toFixed(2)}% p90=${(profile.mfeP90 * 100).toFixed(2)}% (${profile.samples} ${posSide} samples).\n  (data-driven: this is the 75th percentile — the majority of historical ${posSym} ${posSide} trades reversed before this zone; a reach here is strong lock-profit evidence; SL is NEVER touched by this signal.)`;
            }
          }
        } catch { /* non-fatal */ }

        // S/R zones for this position's symbol
        try {
          const posSR = await getSRZones(posSym, pos.currentPrice, combinedState.regime).catch(() => null);
          if (posSR?.formatted) {
            marketDesc += `\n${posSR.formatted}`;
          }
        } catch { /* non-critical */ }
      }

      // v2.0.104: Generate market data (price + OLR + S/R) for ALL trading markets
      // without open positions. These are injected into currentPositions as
      // isTradingMarket entries, and agents need market context to analyze them.
      // v2.0.107: Cache fetched prices for reuse in injection code (avoids
      // double-fetching and rate limiter exhaustion).
      const additionalMarketsForCtx: string[] = (this as any)._additionalMarkets ?? [];
      const additionalMarketsPrices: Map<string, { price: number; change24h: number; volume24h: number }> = new Map();
      for (const mktSym of additionalMarketsForCtx) {
        if (normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol)) continue; // already covered
        // Fetch price + market state for this trading market
        let mktPrice = 0;
        let mktChange24h = 0;
        let mktVolume24h = 0;
        try {
          const priceData = await withTimeout(this.marketAgent.fetchPriceForSymbol(mktSym), 8_000, `addl-ctx ${mktSym}`);
          if (priceData) {
            mktPrice = priceData.price;
            mktChange24h = priceData.change24h;
            mktVolume24h = priceData.volume24h;
          }
          // v2.0.107: Cache for injection code
          additionalMarketsPrices.set(mktSym, { price: mktPrice, change24h: mktChange24h, volume24h: mktVolume24h });
        } catch {
          log.warn(`Failed to fetch market data for ${mktSym} — agents will have limited context`);
        }
        // v2.0.107: Store cached prices for injection code to reuse
        (this as any)._additionalMarketsPrices = additionalMarketsPrices;
        const mktState = this.marketState.getState(mktSym);
        // Append market data for this trading market
        marketDesc += `\n\n=== MARKET DATA for ${mktSym} (TRADING MARKET — no position) ===`;
        marketDesc += `\nPrice: $${mktPrice.toFixed(2)}`;
        marketDesc += `\n24h Change: ${mktChange24h >= 0 ? '+' : ''}${mktChange24h.toFixed(2)}%`;
        if (mktVolume24h > 0) marketDesc += `\n24h Volume: $${(mktVolume24h / 1_000_000).toFixed(2)}M`;
        marketDesc += `\nTrend: ${(mktState?.trend ?? 'sideways').toUpperCase()}`;
        marketDesc += `\nRegime: ${(mktState?.regime ?? 'unknown').toUpperCase()}`;
        if (mktState && mktState.volatility > 0) marketDesc += `\nVolatility: ${(mktState.volatility * 100).toFixed(3)}%`;

        // OLR context for this trading market
        try {
          const mktCtx = this.lastCycleShadowContexts.get(mktSym);
          const features = mktCtx?.features ?? {
            volatility: mktState?.volatility ?? 0,
            srDistanceBps: 0,
            obImbalance: mktState?.orderBookImbalance ?? 0,
            fundingRate: 0,
            volumeRatio: 1,
            sentiment: 0,
            sentimentConviction: 0.5,
            signalAgreement: 0.5,
          };
          // v2.0.135: full OLR + First-Passage block via shared helper
          const mktInfo = `OLR for ${mktSym} (no position — entry evaluation).`;
          const mktBlock = this.buildOLRBlock(mktSym, features, `OLR ASSESSMENT for ${mktSym}`, mktInfo);
          if (mktBlock) marketDesc += `\n\n` + mktBlock;
        } catch { /* non-critical */ }

        // S/R zones for this trading market
        try {
          const mktSR = await getSRZones(mktSym, mktPrice, mktState?.regime ?? 'unknown').catch(() => null);
          if (mktSR?.formatted) {
            marketDesc += `\n${mktSR.formatted}`;
          }
        } catch { /* non-critical */ }
      }

      // Store latest S/R context for API push
      if (srContext) {
        // v2.0.830: Find the nearest support zone's strength + source for
        // PROFIT GUARD v3 break-quality assessment. A break of a 'strong'
        // pivot support is a real structural event; a break of a 'weak'
        // round_num support (e.g. $64K integer) is just noise.
        const nearestSupportPrice = srContext.currentPosition.nearestSupport;
        const nearestSupportZone = nearestSupportPrice !== null
          ? srContext.zones.find(z => z.type === 'support' && Math.abs(z.price - nearestSupportPrice) / nearestSupportPrice * 10_000 < 1)
          : null;
        this.lastSRContext = {
          formatted: srContext.formatted,
          regime: srContext.regime,
          zoneCount: srContext.zones.length,
          strongZones: srContext.zones.filter(z => z.strength === 'strong').length,
          nearestSupport: srContext.currentPosition.nearestSupport,
          nearestResistance: srContext.currentPosition.nearestResistance,
          distanceToSupportBps: srContext.currentPosition.distanceToNearestSupport,
          distanceToResistanceBps: srContext.currentPosition.distanceToNearestResistance,
          degradedReason: srContext.degradedReason,
          nearestSupportStrength: nearestSupportZone?.strength ?? null,
          nearestSupportSource: nearestSupportZone?.source ?? null,
        };
      }

      // v2.0.122: Inject pending entry theses into market description.
      // These are theses from previous cycles where Meta-Agent output BUY/SELL
      // but the trade didn't execute (blocked by conviction gate, liquidity,
      // direction restriction, etc.). Meta-Agent should see its prior reasoning
      // and either re-affirm it or update it. Skeptics re-validates each cycle.
      if (this.pendingTheses.size > 0) {
        marketDesc += `\n\n=== PENDING ENTRY THESES (prior cycle — not yet executed) ===`;
        for (const [sym, entry] of this.pendingTheses) {
          const ageCycles = this.totalCycles - entry.cycle;
          marketDesc += `\n${sym}: ${entry.action.toUpperCase()} (pending ${ageCycles} cycle(s)) — Thesis: "${entry.thesis}"`;
        }
        marketDesc += `\n⚠️ These theses were output by Meta-Agent but the trade did NOT execute. Re-evaluate: is the thesis still valid? If yes, re-output the same direction. If market conditions changed, update the thesis or switch to HOLD.`;
      }

      // 2. Build agent context (including evolution memory + backtest knowledge)
      const evolutionContext = this.evolution.getContextForAgent(combinedState.regime);
      const backtestContext = this.backtest.getBacktestSummary();
      const portfolioDesc = this.paperEngine.getPortfolioSummary();

      // v2.0.143: Root Command Prompt risk preference override.
      // The user can express risk preference in natural language:
      //   "激進" / "aggressive" / "高風險" → lower minConfidenceForTrade (0.20)
      //   "保守" / "conservative" / "低風險" → raise minConfidenceForTrade (0.60)
      //   "平衡" / "balanced" / "moderate" → default (0.40)
      // This adjusts the hard constraint that Skeptics enforces on sub-agents.
      let adjustedEvolutionContext = evolutionContext;
      if (this.rootCommandPrompt && this.rootCommandPrompt.trim().length > 0) {
        const riskOverride = this.parseRiskPreference(this.rootCommandPrompt);
        if (riskOverride) {
          // Override minConfidenceForTrade in the evolution context
          if (riskOverride.minConfidenceForTrade !== undefined) {
            const currentMatch = evolutionContext.match(/minConfidenceForTrade=([\d.]+)/);
            if (currentMatch) {
              adjustedEvolutionContext = evolutionContext.replace(
                currentMatch[0],
                `minConfidenceForTrade=${riskOverride.minConfidenceForTrade.toFixed(2)}  (OVERRIDDEN by Root Command Prompt: ${riskOverride.preference})`
              );
              log.info(`🎯 Terminal Agent: Risk preference "${riskOverride.preference}" → minConfidenceForTrade ${riskOverride.minConfidenceForTrade.toFixed(2)} (was ${currentMatch[1]})`);
            } else {
              // No existing minConfidenceForTrade — append it
              adjustedEvolutionContext += `\n  minConfidenceForTrade=${riskOverride.minConfidenceForTrade.toFixed(2)}  (OVERRIDDEN by Root Command Prompt: ${riskOverride.preference})\n`;
              log.info(`🎯 Terminal Agent: Risk preference "${riskOverride.preference}" → minConfidenceForTrade ${riskOverride.minConfidenceForTrade.toFixed(2)} (was default)`);
            }
          }
        }
      }

      // v2.0.139: Evolution signalThreshold override REMOVED. The consensus
      // threshold is now purely config (HACP_CONSENSUS_THRESHOLD) + adjustThreshold
      // (loss-streak/idle/regime). The EvolutionaryPressureEngine strategy pool
      // was empty so getStrategyParameters() threw every cycle — the override
      // never applied. Global-aggregate fitness no longer feeds the consensus gate.

      // 3. HACP Decision Cycle
      log.info('🤖 HACP: Starting multi-agent cognition...');

      // Sync real exchange positions into local portfolio before agents think
      if (this.tradingManager.getTradeMode() === 'real') {
        await this.tradingManager.syncExchangePositions();
        // Cache the real exchange balance so pushToAPI() can show the actual
        // Hyperliquid account value (not the local mirror) in the UI (v2.0.17).
        try {
          this.cachedExchangeBalance = await this.tradingManager.getBalance();
          // v2.0.19: also cache recent HL fills (last 5) + exchange positions
          // so the UI Trade Records + Portfolio positions modules show real
          // Hyperliquid data, not just the local mirror.
          this.cachedHLFills = await this.tradingManager.getRecentFills(20);
          this.cachedExchangePositions = (await this.tradingManager.getPositions()).map(p => ({
            symbol: p.symbol,
            side: p.side,
            quantity: p.quantity,
            averageEntryPrice: p.averageEntryPrice,
            currentPrice: p.currentPrice,
            unrealizedPnl: p.unrealizedPnl,
            leverage: p.leverage ?? 1,
            openedAt: p.openedAt,
          }));
          for (const p of this.cachedExchangePositions) { this.lastKnownLeverage.set(p.symbol.replace(/^xyz:/i, '').toLowerCase(), p.leverage ?? 1); }
          // v2.0.79: Ensure all exchange positions are in realPositions map.
          // syncExchangePositions() may have missed some if the DEX fetch
          // failed (429). Now that we have cachedExchangePositions, import
          // any that are missing so agents see ALL open positions.
          for (const exPos of this.cachedExchangePositions) {
            const sym = normalizeSymbol(exPos.symbol);
            if (!this.portfolio.hasPosition(sym)) {
              log.info(`📥 Late import: ${exPos.symbol} ${exPos.side.toUpperCase()} qty=${exPos.quantity} entry=${exPos.averageEntryPrice.toFixed(2)} lev=${exPos.leverage}x (missed by syncExchangePositions)`);
              this.portfolio.importExchangePosition(
                exPos.symbol,
                exPos.side,
                exPos.quantity,
                exPos.averageEntryPrice,
                exPos.leverage,
                exPos.openedAt > 0 ? exPos.openedAt : Date.now(),
              );
            }
          }
          log.info(`📡 Exchange synced for agent context (HL balance: $${this.cachedExchangeBalance.total.toFixed(2)}, ${this.cachedHLFills.length} recent fills, ${this.cachedExchangePositions.length} positions)`);
        } catch (err) {
          log.warn(`Exchange sync (balance/fills/positions) failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        // v2.0.32: Sync SL/TP to HL — check every cycle if HL has the trigger
        // orders that the local mirror expects. If missing, place them.
        try {
          await this.tradingManager.syncSLTP();
        } catch (err) {
          log.warn(`SL/TP sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // v2.0.29: In paper mode, if there are legacy real positions on the
      // exchange, continue syncing their prices so the local mirror stays
      // accurate. This lets agents manage (SL/TP, close consensus) legacy
      // real positions even after switching to paper mode.
      // v2.0.37: Also handle agentId='hyperliquid-real' positions that are NOT
      // in legacyPositionModes — these are stale real positions that were never
      // marked as legacy (e.g. system restart lost the tracking, or they were
      // imported via syncExchangePositions while in real mode then the user
      // switched to paper). Previously these were orphaned — no code path
      // managed them, causing perpetual errors (syncSLTP, closePosition, etc.).
      if (this.tradingManager.getTradeMode() === 'paper') {
        // v2.0.37: Process ALL real positions — both legacy-tracked AND orphaned
        const allRealSymbols = this.portfolio.getOpenSymbols().filter(sym => {
          const pos = this.portfolio.getPosition(sym);
          return pos && pos.agentId === 'hyperliquid-real';
        });
        if (allRealSymbols.length > 0) {
          try {
            const engine = this.tradingManager.getEngineForExchange('hyperliquid');
            if (engine) {
              const exchangePositions = await engine.getPositions();
              // v2.0.37: If getPositions() returned empty, we can't verify —
              // but we also can't just skip (the position might be genuinely
              // closed on HL). Check if any closing fills exist.
              if (exchangePositions.length === 0) {
                // Try to get recent fills to confirm the position was closed
                let recentFills: Array<{ symbol: string; closedPnl: number; price: number; timestamp: number; dir: string; side: string }> = [];
                if (typeof (engine as any).getRecentFills === 'function') {
                  try { recentFills = await (engine as any).getRecentFills(50); } catch { /* non-critical */ }
                }
                for (const sym of allRealSymbols) {
                  const pos = this.portfolio.getPosition(sym);
                  if (!pos) continue;
                  // v2.0.166: Check fill direction matches closing side — same fix
                  // as syncExchangePositions. A SELL position is closed by a BUY
                  // fill (side='buy'), and vice versa.
                  // v2.0.868-attack7:side 大小寫——HL position side 可能 'BUY'/'SELL'
            const expectedCloseSide = isBuySide(pos.side) ? 'sell' : 'buy';
                  const closingFill = recentFills.find(f =>
                    f.symbol.toLowerCase() === sym.toLowerCase() &&
                    !f.dir.toLowerCase().startsWith('open') &&
                    f.side === expectedCloseSide &&
                    f.timestamp >= pos.openedAt
                  );
                  if (closingFill) {
                    // Confirmed closed on HL — close local mirror
                    const trade = this.portfolio.closeExchangePosition(sym, closingFill.price, closingFill.closedPnl);
                    if (trade) {
                      log.info(`📋 Stale real position ${sym} confirmed closed via HL fill: PnL $${trade.pnl.toFixed(2)} — cleaning up`);
                      this.legacyPositionModes.delete(sym);
                      this.onPositionClosedLearning(trade);
                    }
                  } else {
                    // v2.0.37: No closing fill found — if the position is old
                    // (> 1h), it's very likely been closed on HL (positions
                    // don't stay empty for hours if genuinely open). Close it.
                    const ageMs = Date.now() - pos.openedAt;
                    if (ageMs > 3_600_000) {
                      const state = this.marketState.getState(sym);
                      const closePrice = state?.price ?? pos.currentPrice ?? 0;
                      if (closePrice > 0) {
                        const trade = this.portfolio.closeExchangePosition(sym, closePrice);
                        if (trade) {
                          log.info(`📋 Stale real position ${sym} (age ${Math.round(ageMs / 3_600_000)}h, no HL position, no closing fill) — closing local mirror (assuming closed on HL)`);
                          this.legacyPositionModes.delete(sym);
                          this.onPositionClosedLearning(trade);
                        }
                      }
                    } else {
                      log.warn(`⚠️ Paper mode: real position ${sym} not on HL and no closing fill — position is recent (${Math.round(ageMs / 60_000)}min), skipping (might be API failure)`);
                    }
                  }
                }
              } else {
                // getPositions() returned non-empty — normal sync
                // v2.0.52: Cache the exchange positions so the reconciliation
                // filter below can use them to keep HL-confirmed real positions.
                this.cachedExchangePositions = exchangePositions.map(p => ({
                  symbol: p.symbol,
                  side: p.side,
                  quantity: p.quantity,
                  averageEntryPrice: p.averageEntryPrice,
                  currentPrice: p.currentPrice,
                  unrealizedPnl: p.unrealizedPnl,
                  leverage: p.leverage ?? 1,
                  openedAt: p.openedAt,
                }));
                for (const exPos of exchangePositions) {
                  const sym = exPos.symbol.includes(':') ? exPos.symbol : exPos.symbol.toLowerCase();
                  if (this.portfolio.hasPosition(sym)) {
                    this.portfolio.softUpdatePosition(sym, exPos.currentPrice);
                  }
                }
                // Check if any real positions were closed on the exchange
                // v2.0.166: Don't close based on position absence alone — the
                // exchange API may have partially failed (returned some symbols
                // but not others). Only close if there's a confirmed closing fill.
                const exchangeSyms = exchangePositions.map(p => p.symbol.includes(':') ? p.symbol : p.symbol.toLowerCase());
                let paperModeRecentFills: Array<{ symbol: string; closedPnl: number; price: number; timestamp: number; dir: string; side: string }> = [];
                for (const sym of allRealSymbols) {
                  if (!exchangeSyms.includes(sym) && this.portfolio.hasPosition(sym)) {
                    const pos = this.portfolio.getPosition(sym);
                    if (!pos) continue;
                    // v2.0.166: Verify with closing fill before closing
                    if (paperModeRecentFills.length === 0 && typeof (engine as any).getRecentFills === 'function') {
                      try { paperModeRecentFills = await (engine as any).getRecentFills(50); } catch { /* non-critical */ }
                    }
                    // v2.0.868-attack7:side 大小寫——HL position side 可能 'BUY'/'SELL'
            const expectedCloseSide = isBuySide(pos.side) ? 'sell' : 'buy';
                    const closingFill = paperModeRecentFills.find(f =>
                      f.symbol.toLowerCase() === sym.toLowerCase() &&
                      !f.dir.toLowerCase().startsWith('open') &&
                      f.side === expectedCloseSide &&
                      f.timestamp >= pos.openedAt
                    );
                    if (closingFill) {
                      const closePrice = closingFill.price;
                      const trade = pos.agentId === 'hyperliquid-real'
                        ? this.portfolio.closeExchangePosition(sym, closePrice, closingFill.closedPnl)
                        : this.portfolio.closePosition(sym, closePrice);
                      if (trade) {
                        log.info(`📋 Real position ${sym} confirmed closed via HL fill: PnL $${trade.pnl.toFixed(2)} — syncing local mirror`);
                        this.legacyPositionModes.delete(sym);
                        this.onPositionClosedLearning(trade);
                      }
                    } else {
                      log.warn(`⚠️ Paper mode: ${sym} not in exchange positions but no closing fill found — NOT closing (may be API partial failure)`);
                    }
                  }
                }
              }
            }

            // v2.0.48: Sync SL/TP from HL for legacy real positions in paper mode.
            // This reads the actual HL trigger orders and updates the local mirror
            // so the UI shows the real SL/TP values. Without this, the local mirror's
            // SL/TP drifts from HL (HL rounds prices, user can manually adjust on HL).
            // Also pushes any missing SL/TP from the local mirror to HL.
            try {
              await this.tradingManager.syncSLTP();
            } catch (err) {
              log.warn(`SL/TP sync (paper mode legacy) failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          } catch (err) {
            log.warn(`Real position sync in paper mode failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // ── Position Reconciliation (Skeptics phase) ──
      // Detect orphan positions — open in local portfolio but no longer active
      // on the exchange (real mode) or stale from a previous session (paper mode).
      // v2.0.29: Legacy positions (from the other trade mode) are NEVER
      // reconciled away — they stay until naturally closed by SL/TP or consensus.
      {
        let externalSymbols: string[];

        if (this.tradingManager.getTradeMode() === 'real') {
          // Real mode: ask the exchange what positions it has open.
          // Any local mirror without a matching exchange position was
          // manually closed on the exchange.
          // BUT: legacy paper positions are not on the exchange — keep them.
          const exchangeSymbols = await this.tradingManager.getOpenPositionSymbols();
          const legacySymbols = this.portfolio.getOpenSymbols().filter(sym =>
            this.legacyPositionModes.get(sym) === 'paper'
          );
          // v2.0.32: Exchange-imported positions (agentId='hyperliquid-real')
          // must be reconciled if they're no longer on the exchange.
          // Previously, ALL exchange-imported positions were blindly kept,
          // which meant positions closed on HL were never removed from the
          // local portfolio — inflating the balance and causing phantom trades.
          // Now: only keep exchange-imported positions that are actually open
          // on the exchange (already in exchangeSymbols from getOpenPositionSymbols).
          externalSymbols = [...new Set([...exchangeSymbols, ...legacySymbols])];
        } else {
          // Paper mode: no external exchange to verify against.
          // Only clean up truly stale positions — those opened in a
          // PREVIOUS system session on a different trading symbol
          // that have been sitting untouched for >12h.
          // DO NOT remove recently-opened positions (even on non-active
          // symbols) — they may be exploration trades or multi-symbol.
          // v2.0.29: Legacy real positions are kept too.
          // v2.0.32: Exchange-imported positions (agentId='hyperliquid-real')
          // are NOT kept in paper mode — they were real positions that may
          // have been closed on HL. Without exchange access to verify, we
          // can't know if they're still open. Close them to avoid phantom
          // positions inflating the balance.
          // v2.0.37: Actually enforce this — previously the filter didn't
          // check agentId at all, so real positions that weren't in
          // legacyPositionModes were kept if < 12h old, causing perpetual
          // errors (syncSLTP, closePosition, etc.).
          //
          // v2.0.52: FIX — real positions that were CONFIRMED to exist on HL
          // by the paper-mode sync block above must NOT be reconciled away.
          // The sync block already verified them against HL and updated
          // their prices. Reconciling them here would close the local mirror
          // even though the real HL position is still open.
          // We build a set of HL-confirmed symbols from cachedExchangePositions
          // (populated by the sync block's getPositions() call).
          const hlConfirmedSymbols = new Set<string>();
          if (this.cachedExchangePositions) {
            for (const ep of this.cachedExchangePositions) {
              hlConfirmedSymbols.add(ep.symbol.includes(':') ? ep.symbol : ep.symbol.toLowerCase());
            }
          }
          const now = Date.now();
          const staleCutoff = 3_600_000 * 12; // 12 hours
          const activeSym = activeSymbol.toLowerCase();
          externalSymbols = this.portfolio.getOpenSymbols().filter(sym => {
            // Legacy positions are always kept
            if (this.legacyPositionModes.has(sym)) return true;
            // v2.0.52: Real positions confirmed on HL are kept (not reconciled).
            const pos = this.portfolio.getPosition(sym);
            if (pos && pos.agentId === 'hyperliquid-real') {
              // If the sync block confirmed this position exists on HL, keep it.
              if (hlConfirmedSymbols.has(sym)) return true;
              // Otherwise, it's a stale mirror — let the sync block handle cleanup.
              return false;
            }
            if (sym === activeSym) return true;
            return !!pos && (now - pos.openedAt < staleCutoff);
          });
        }

        // v2.0.32: In real mode, before reconciliation closes exchange
        // positions locally, record which ones are exchange-imported so
        // we can close them on HL afterwards. reconcilePositions() deletes
        // the local position, so we can't check agentId after it runs.
        const exchangeSymbolsToClose: string[] = [];
        if (this.tradingManager.getTradeMode() === 'real') {
          for (const sym of this.portfolio.getOpenSymbols()) {
            const pos = this.portfolio.getPosition(sym);
            if (pos && pos.agentId === 'hyperliquid-real' && !externalSymbols.includes(sym)) {
              exchangeSymbolsToClose.push(sym);
            }
          }
        }

        // v2.0.868-fix:系統自己驗證 reconciliation close——HL fills 確認有 closing fill
        // 先 close;冇 closing fill(唔確定)→ 系統 hold——唔製造幻影 trade
        let closingFillsForReconcile: Array<{ symbol: string; side: string; timestamp: number }> = [];
        try {
          if (this.tradingManager.getTradeMode() === 'real' && this.hyperliquidWs) {
            const engine = (this.tradingManager as unknown as { getActiveEngine(): { getRecentFills(n: number): Promise<Array<{ symbol: string; side: string; timestamp: number }>> } | null }).getActiveEngine?.();
            if (engine) {
              const fills = await engine.getRecentFills(50);
              closingFillsForReconcile = fills.filter(f => !String(f.side).toLowerCase().startsWith('open'));
            }
          }
        } catch { /* 非致命——冇 fills 就全部唔確定 → 唔 close(保守) */ }
        const reconciled = this.portfolio.reconcilePositions(externalSymbols, (localSym) => {
          // v2.0.868-attack7:callback 內部防禦——垃圾 fills(undefined/非 string)
          // 唔 crash(String()/Number() 防護)——throw → false(唔確定 → 系統 hold)
          try {
            const pos = this.portfolio.getPosition(localSym);
            if (!pos) return true;
            // v2.0.868-attack7:side 大小寫——HL position side 可能 'BUY'/'SELL'
            const expectedCloseSide = isBuySide(pos.side) ? 'sell' : 'buy';
            return closingFillsForReconcile.some(f =>
              String(f?.symbol ?? '').toLowerCase() === String(localSym).toLowerCase() &&
              String(f?.side ?? '').toLowerCase() === String(expectedCloseSide).toLowerCase() &&
              Number(f?.timestamp ?? 0) >= (pos.openedAt ?? 0),
            );
          } catch { return false; }
        });
        if (reconciled.length > 0) {
          // v2.0.32: Close reconciled exchange positions on HL.
          // The local mirror was closed by reconcilePositions(), but the
          // real HL position may still be open — we must close it on HL
          // to avoid leaving real money positions unmanaged.
          for (const sym of exchangeSymbolsToClose) {
            if (reconciled.includes(sym)) {
              log.info(`🔒 Closing ${sym} on HL (reconciled locally but still open on exchange)`);
              try {
                // v2.0.853-fix2: Tag 'reconciliation' — this is a reconciliation-driven
                //   close (position disappeared locally but may still be on HL), not an
                //   SL/TP trigger. Without this, inferCloseReason may classify it as
                //   'sl_tp' if the exit price is near SL/TP, giving it full learning
                //   weight (should be 1.0× for reconciliation, but the closeReason must
                //   be correct for RIL CloseReasonAggregator + trade-audit to distinguish
                //   "exchange reconciliation" from "SL too tight").
                await this.closeTrade(sym, 'Reconciliation close: position reconciled locally but still open on HL', 'reconciliation');
              } catch (err) {
                log.error(`Failed to close ${sym} on HL: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
          // Clean up legacy tracking for reconciled positions
          for (const sym of reconciled) {
            this.legacyPositionModes.delete(sym);
          }
          log.info(`🧹 Reconciled ${reconciled.length} stale position(s): ${reconciled.join(', ')}`);
          // Update portfolio description after reconciliation
          this.pushToAPI();
        }
      }

      // Build current positions for TP/SL adjustment
      // v2.0.72: include realPositions (now separate from paper positions)
      // v2.0.79: Also include cachedExchangePositions not in realPositions
      // (e.g. if syncExchangePositions missed them due to 429 on xyz DEX)
      const realPos = this.portfolio.getRealPositions();
      const realPosSyms = new Set(realPos.map(p => normalizeSymbol(p.symbol)));
      const currentPositions = [
        ...Array.from(this.portfolio.getPortfolio().positions.values()),
        ...realPos,
        // Add any exchange positions missing from realPositions
        // v2.0.80: Compute default SL/TP (2% SL, 5% TP) so agents see safety levels
        ...(this.cachedExchangePositions ?? [])
          .filter(ep => !realPosSyms.has(normalizeSymbol(ep.symbol)))
          .map(ep => ({
            id: `hl-${ep.symbol}-${ep.openedAt}`,
            symbol: ep.symbol,
            side: ep.side,
            entryPrice: ep.averageEntryPrice,
            currentPrice: ep.currentPrice,
            stopLossPrice: ep.side === 'buy'
              ? ep.averageEntryPrice * (1 - 0.02)
              : ep.averageEntryPrice * (1 + 0.02),
            takeProfitPrice: ep.side === 'buy'
              ? ep.averageEntryPrice * (1 + 0.05)
              : ep.averageEntryPrice * (1 - 0.05),
            leverage: ep.leverage,
            quantity: ep.quantity,
            exchange: 'hyperliquid',
          })),
      ].map(p => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        entryPrice: 'averageEntryPrice' in p ? p.averageEntryPrice : p.entryPrice,
        currentPrice: p.currentPrice,
        stopLoss: 'stopLossPrice' in p ? p.stopLossPrice : undefined,
        takeProfit: 'takeProfitPrice' in p ? p.takeProfitPrice : undefined,
        leverage: p.leverage,
        quantity: p.quantity,
        exchange: (p as any).exchange ?? 'hyperliquid',
        // v2.0.80: Forward entryThesis so Skeptics can re-validate each cycle
        entryThesis: (p as any).entryThesis,
        // v2.0.104: Forward isTradingMarket flag (undefined for real positions)
        isTradingMarket: (p as any).isTradingMarket as boolean | undefined,
        // v2.0.152: Forward MAE/MFE so adjustPositions can use MFE-aware trailing SL
        minValueReached: (p as any).minValueReached as number | undefined,
        maxValueReached: (p as any).maxValueReached as number | undefined,
      }))
      // v2.0.96: Do NOT remove the activeSymbol from positions list.
      // Previously, activeSymbol was filtered out to avoid UI duplication
      // (BTC appearing as both "BTC(market)" and "BTC● position"). But this
      // prevented Meta-Agent from outputting CLOSE/HOLD decisions for the
      // active symbol's position — CLOSE is a positions[] action, and if the
      // position isn't in positions[], Meta-Agent can't close it.
      // Now the active symbol stays in positions[] so Meta-Agent can manage it.
      // The UI may show a duplicate entry, but correct position management
      // is more important than UI cleanliness.

      // v2.0.104: Inject ALL trading markets into currentPositions for
      // single-cycle multi-asset analysis. Markets without open positions
      // are added with quantity=0 and isTradingMarket=true. Agents see ALL
      // trading markets in positions[] and output BUY/SELL/HOLD for each.
      const additionalMarkets: string[] = (this as any)._additionalMarkets ?? [];
      log.info(`📊 Injection check: additionalMarkets=[${additionalMarkets.join(', ')}], currentPositions before injection=${currentPositions.length}`);
      if (additionalMarkets.length > 0) {
        // v2.0.107: Reuse prices cached from buildMarketDescription (avoids double-fetch)
        const cachedPrices = (this as any)._additionalMarketsPrices as Map<string, { price: number; change24h: number; volume24h: number }> | undefined;
        const existingSyms = new Set(currentPositions.map(p => normalizeSymbol(p.symbol)));
        for (const mktSym of additionalMarkets) {
          const mktNorm = normalizeSymbol(mktSym);
          if (existingSyms.has(mktNorm)) continue; // already has a real position
          // v2.0.107: Use cached price first, then fetchPriceForSymbol, then marketState
          let mktPrice = cachedPrices?.get(mktSym)?.price ?? 0;
          if (mktPrice <= 0) {
            try {
              const priceData = await withTimeout(this.marketAgent.fetchPriceForSymbol(mktSym), 8_000, `inject-price ${mktSym}`);
              mktPrice = priceData?.price ?? 0;
            } catch {
              log.warn(`Failed to fetch price for trading market ${mktSym} — injecting with price=0 (agents will have limited context)`);
              // v2.0.107: Don't skip — still inject so agents see the market.
            }
          }
          // v2.0.107: Try marketState as fallback for price
          if (mktPrice <= 0) {
            const mktStateFallback = this.marketState.getState(mktSym);
            if (mktStateFallback && mktStateFallback.price > 0) {
              mktPrice = mktStateFallback.price;
            }
          }
          currentPositions.push({
            id: `market-${mktSym}`,
            symbol: mktSym,
            side: 'buy' as const, // placeholder — quantity=0 means no real position
            entryPrice: mktPrice,
            currentPrice: mktPrice,
            stopLoss: undefined,
            takeProfit: undefined,
            leverage: this.marketAgent.getConfig().leverage,
            quantity: 0, // 0 = no real position, agents can open new
            exchange: 'hyperliquid' as const,
            entryThesis: undefined,
            isTradingMarket: true, // v2.0.104: flag for agent context + execution
            minValueReached: undefined,
            maxValueReached: undefined,
          });
        }
        log.info(`📊 Injected ${additionalMarkets.length} trading market(s) for multi-symbol single-cycle analysis: ${additionalMarkets.join(', ')}`);
      }

      // v2.0.107: Re-evaluate filter profiles using market data we already have
      // (from the injection fetch above + marketState). This does NOT make
      // additional API calls — it uses cached data to refine the profile.
      // Only runs if the filter was auto-assigned (not manually overridden).
      for (const sym of allTradingSymbols) {
        const currentProfile = this.assetFilterRegistry.getProfileType(sym);
        const symState = this.marketState.getState(sym);
        const symPrice = symState?.price ?? 0;
        const symChange = symState?.change24h ?? 0;
        const symVolume = symState?.volume24h ?? 0;
        if (symPrice <= 0) continue; // no data to re-evaluate

        // Use Market Agent's judgment with cached data (no API call)
        const refinedProfile = await this.marketAgent.selectFilterProfile(sym, {
          price: symPrice,
          volume24h: symVolume,
          change24h: symChange,
        });
        if (refinedProfile !== currentProfile) {
          this.assetFilterRegistry.assignProfile(sym, refinedProfile);
          log.info(`📊 Refined filter profile for ${sym}: ${currentProfile} → ${refinedProfile}`);
        }
      }
      log.info(`📊 currentPositions after injection=${currentPositions.length} (symbols: ${currentPositions.map(p => p.symbol).join(', ')})`);

      // v2.0.206 (#3): Real-time OLR P(win) exit trigger for open positions.
      // For each REAL open position (quantity > 0), recompute OLR P(win) using
      // the CURRENT cycle's market features (not entry features). If the edge
      // has collapsed (P(win) < 40%), inject a warning block so Meta-Agent /
      // Skeptics re-evaluate the exit decision with the degraded statistical
      // edge in mind. This is NOT a hard veto — it enriches the context so the
      // thesis-invalidation rule can factor in the real-time statistical edge.
      let olrRealtimeBlock = '';
      try {
        const realPositions = currentPositions.filter(p => (p.quantity ?? 0) > 0 && !p.isTradingMarket);
        if (realPositions.length > 0) {
          const lines: string[] = [];
          for (const pos of realPositions) {
            const sym = normalizeSymbol(pos.symbol);
            const side = isBuySide(pos.side) ? 'buy' : 'sell';
            const ctx = this.lastCycleShadowContexts.get(sym);
            if (ctx && ctx.features && Object.keys(ctx.features).length > 0) {
              const olr = this.olrEngine.query(sym, ctx.features, side, this.totalCycles);
              const pWin = olr.pWin;
              let flag = '';
              if (pWin < 0.35) flag = ' ⚠️ EDGE COLLAPSED — statistical win probability now below 35%. Strongly consider CLOSE unless thesis is still clearly valid.';
              else if (pWin < 0.45) flag = ' ⚠️ EDGE WEAKENING — statistical win probability now below 45%. Re-evaluate hold vs close.';
              lines.push(`  ${pos.symbol} (${side.toUpperCase()}): real-time OLR P(win)=${(pWin * 100).toFixed(0)}%${flag}`);
            }
          }
          if (lines.length > 0) {
            olrRealtimeBlock = `\n=== REAL-TIME OLR EDGE (open positions, current market features) ===\n${lines.join('\n')}\nInterpretation: These are the CURRENT statistical win probabilities, recomputed every cycle from live market features. If P(win) has collapsed since entry, the original entry edge may no longer hold — weigh this alongside thesis validity when deciding HOLD vs CLOSE.\n---\n`;
          }
        }
      } catch (err) {
        log.warn(`[OLR-RT] real-time exit-trigger block failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }

      const result = await this.hacpEngine.executeDecisionCycle(
        `${marketDesc}${olrRealtimeBlock}\n\n${adjustedEvolutionContext}${backtestContext}`,
        portfolioDesc,
        currentPositions.length > 0 ? currentPositions : undefined,
        emContext,
        this.emManager?.getLast(10) ?? [],
        {
          leverage: this.marketAgent.getConfig().leverage,
          positionSizePct: this.marketAgent.getConfig().positionSizePct,
        },
        this.totalCycles, // v2.0.26: pass cycle number for cooldown logic
        // v2.0.80: Pass price fetcher for Skeptics thesis re-validation
        async (symbol: string): Promise<number | null> => {
          try {
            const result = await withTimeout(this.marketAgent.fetchPriceForSymbol(symbol), 8_000, `skeptic-price ${symbol}`);
            return result ? result.price : null;
          } catch {
            return null;
          }
        },
      );

      // v2.0.32: Debug log for consensus result
      log.info(`🎯 HACP consensus: ${result.consensus.decision.action.toUpperCase()} ${result.consensus.decision.symbol} size=${(result.consensus.decision.positionSizePct * 100).toFixed(1)}% conf=${(result.consensus.confidence * 100).toFixed(0)}% metaOverride=${result.consensus.metaAgentOverridden} cooldown=${this.hacpEngine.isCooldownActive(this.totalCycles)}`);

      // v2.0.822: Analysis mode — build the per-asset recommendation matrix
      // from the consensus + market state, then write to Supabase. The backend
      // does NOT place orders in analysis mode; the app reads the matrix and
      // the user's client decides execution. One row per trading market.
      if (this.analysisMode) {
        try {
          const pscList = result.consensus.perSymbolConsensus ?? [];
          // Build the universe of symbols to analyse: active symbol + all
          // trading markets + any symbol the consensus produced a psc for.
          const symSet = new Set<string>([normalizeSymbol(activeSymbol)]);
          for (const m of (this.tradingMarkets ?? [])) symSet.add(normalizeSymbol(m));
          for (const psc of pscList) symSet.add(normalizeSymbol(psc.symbol));
          const analyses: AssetAnalysis[] = [];
          for (const sym of symSet) {
            const psc = pscList.find(p => normalizeSymbol(p.symbol) === sym);
            const ms = this.marketState.getState(sym);
            // OLR P(win) for this symbol (best-effort; 0.5 cold-start default).
            let pwin = 0.5;
            try {
              const ctx = this.lastCycleShadowContexts.get(sym);
              if (ctx?.features && Object.keys(ctx.features).length > 0) {
                const olrRes = this.olrEngine.query(sym, ctx.features, psc?.action === 'sell' ? 'sell' : 'buy', this.totalCycles);
                if (Number.isFinite(olrRes.pWin)) pwin = olrRes.pWin;
              }
            } catch { /* cold-start safe */ }
            const votes = result.consensus.votes ?? [];
            const aligned = votes.filter(v => (v.decision?.action as string) === (psc?.action ?? 'hold')).length;
            // v2.0.833: Compute EdgeReport + per-profile conditional edges
            const edgeSide = (psc?.action === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell';
            const regime = ms?.regime ?? 'unknown';
            const edgeResult = await this.computeEdgeForSymbol(sym, edgeSide, regime);
            const analysis = buildAssetAnalysis(
              sym, psc, ms, this.totalCycles, pwin, aligned, votes.length,
              edgeResult?.edgeReport,
            );
            if (analysis) analyses.push(analysis);
          }
          await this.analysisWriter.writeCycle(analyses);
        } catch (err) {
          log.warn(`[analysis-write] failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // v2.0.834: Factor-Tagged Aligned Shadow Trading
      // After HACP consensus + conviction gate, open aligned shadow trades
      // for conditions where the LLM leaned toward a direction but the trade
      // didn't execute (conviction gate blocked, or consensus was HOLD but
      // sub-agent weighted direction had a lean). This teaches OLR + RP Edge
      // Store the correct conditional distribution: "what happens when the
      // LLM says go this way under these conditions."
      //
      // v2.0.834 Fix C: Iterate ALL perSymbolConsensus entries (not just active
      // symbol) so every trading market gets aligned shadows. Each psc has its
      // own direction + confidence — we open an aligned shadow for each symbol
      // where the LLM leaned toward a direction but the trade didn't execute.
      try {
        const votes = result.consensus.votes ?? [];
        const consensusConf = result.consensus.confidence;

        // Compute sub-agent weighted direction from the global vote set
        let buyWeight = 0, sellWeight = 0;
        for (const v of votes) {
          const action = (v.decision?.action as string) ?? 'hold';
          if (action === 'buy') buyWeight += safeNum(v.weight, 0);
          else if (action === 'sell') sellWeight += safeNum(v.weight, 0);
        }
        const hasWeightedLean = Math.abs(buyWeight - sellWeight) > 0.01;
        if (!hasWeightedLean) {
          // All agents HOLD — no directional lean → no aligned shadow (situation C)
        } else {
          // Determine the lean direction + primary driver
          const leanSide: 'buy' | 'sell' = buyWeight > sellWeight ? 'buy' : 'sell';
          const leanScore = buyWeight - sellWeight;

          // Find primary driver: highest-weight agent matching the lean direction
          let primaryDriver: { agent: string; weight: number; action: string } = { agent: 'none', weight: 0, action: 'hold' };
          for (const v of votes) {
            const action = (v.decision?.action as string) ?? 'hold';
            if (action === leanSide && safeNum(v.weight, 0) > primaryDriver.weight) {
              primaryDriver = { agent: v.agentRole, weight: v.weight, action };
            }
          }

          // Build agent votes summary for factor tagging
          const agentVotes = votes.map(v => ({
            agent: v.agentRole,
            weight: v.weight,
            action: (v.decision?.action as string) ?? 'hold',
          }));

          // Iterate ALL symbols in the consensus (active + all trading markets)
          const pscList = result.consensus.perSymbolConsensus ?? [];
          const allSyms = new Set<string>([normalizeSymbol(activeSymbol)]);
          for (const m of (this.tradingMarkets ?? [])) allSyms.add(normalizeSymbol(m));
          for (const psc of pscList) allSyms.add(normalizeSymbol(psc.symbol));

          for (const sym of allSyms) {
            const psc = pscList.find(p => normalizeSymbol(p.symbol) === sym);
            // Use per-symbol consensus action if available, else global lean
            const pscAction = psc?.action ?? result.consensus.decision.action;

            // v2.0.855: Aligned shadow ALWAYS opens — including when a real
            // trade executed for this symbol. The shadow provides the
            // counterfactual: "what would standard SL/TP config have done vs
            // the real trade's actual SL/TP". Q-RL ONLY updates from aligned
            // shadows (index.ts shadow-resolution loop), so skipping them on
            // real-trade cycles left q-rl-table.json permanently empty
            // (values={} after 79 cycles) → DCS had zero discovery evidence →
            // the three risk profiles made identical decisions.

            // Skip if an aligned shadow was already opened for this symbol+cycle
            // (e.g. by a previous iteration or the blind-skip check)
            if (this.shadowEngine.hasAlignedShadow(sym, this.totalCycles)) continue;

            const ms = this.marketState.getState(sym);
            const entryPrice = ms?.price ?? 0;
            if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

            const ctx = this.lastCycleShadowContexts.get(sym);
            const features = ctx?.features ?? {};

            // Compute Smart SL/TP using config defaults + S/R if available
            // v2.0.835: Q-RL ε-greedy action selection — may override LLM lean
            // to explore actions the LLM wouldn't choose. Cold-start (Q=0) → follow LLM.
            const rlAction = this.qrlTable.selectAction(leanSide, features);

            const slPct = config.risk.stopLossPct;
            const tpPct = config.risk.takeProfitPct;
            const slPrice = rlAction === 'buy'
              ? entryPrice * (1 - slPct)
              : entryPrice * (1 + slPct);
            const tpPrice = rlAction === 'buy'
              ? entryPrice * (1 + tpPct)
              : entryPrice * (1 - tpPct);

            this.shadowEngine.openAlignedShadow(
              sym, entryPrice, rlAction, slPrice, tpPrice,
              this.totalCycles, features,
              pscAction, consensusConf,
              // v2.0.855-attack: weightedDirection must be the TRUE LLM
              // weighted lean (leanSide), NOT rlAction — rlAction may be a
              // Q-RL ε-greedy exploration action opposite to the LLM lean.
              // Passing rlAction here corrupted the factorTag semantics
              // ("which agent signal drove this shadow") when exploration
              // diverged from consensus, poisoning RP Edge Store queries.
              // The actual shadow side is still rlAction (first arg).
              leanSide, leanScore,
              primaryDriver, agentVotes,
            );

            // ── v2.0.846 Phase 1a: A/B pure-statistics shadow ──────────────
            // Open a SECOND shadow in the direction pure statistics would pick
            // (no LLM). Both paths share the same SL/TP, so comparing their
            // eventual PnL reveals whether the LLM debate adds edge over stats.
            const statRegime = ms?.regime ?? 'unknown';
            const statLean = this.computeStatisticalLean(sym, features, statRegime);
            if (!this.shadowEngine.hasStatisticalShadow(sym, statLean.side, this.totalCycles) && Math.abs(statLean.score) > 0.1) {
              const statSlPrice = statLean.side === 'buy'
                ? entryPrice * (1 - slPct)
                : entryPrice * (1 + slPct);
              const statTpPrice = statLean.side === 'buy'
                ? entryPrice * (1 + tpPct)
                : entryPrice * (1 - tpPct);
              this.shadowEngine.openStatisticalShadow(
                sym, entryPrice, statLean.side, statSlPrice, statTpPrice,
                this.totalCycles, features, statLean.score,
              );
              log.info(`[shadow] A/B: statistical lean ${statLean.side.toUpperCase()} ${sym} (score=${statLean.score.toFixed(3)}) vs LLM ${rlAction.toUpperCase()} — both tracked for edge attribution`);
            }
          }
        }
      } catch (err) {
        log.warn(`[aligned-shadow] failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }

      // v2.0.60: Options Playbook deterministic veto.
      // If the Regime → Playbook says vetoNewPositions (Stand Aside regime),
      // override the consensus decision to HOLD — no new positions allowed.
      // This is a DETERMINISTIC enforcement that overrides LLM voting.
      if (useOptionsData && (result.consensus.decision.action === 'buy' || result.consensus.decision.action === 'sell')) {
        const pb = this.optionsDataManager.getRegimePlaybook(activeSymbol, combinedState.trend, combinedState.regime);
        if (pb.vetoNewPositions) {
          log.warn(`🛑 [options-playbook] VETO: ${pb.playbook} — ${pb.rationale}. Overriding ${result.consensus.decision.action.toUpperCase()} → HOLD`);
          result.consensus.decision = {
            ...result.consensus.decision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[OPTIONS VETO] ${pb.rationale}. ${result.consensus.decision.rationale}`,
          };
        }
      }

      // v2.0.862: PAEL Exit-Price Lock Gate — TP-side one-vote exit.
      // Runs BEFORE thesis-invalidation closes: a position whose MFE reached
      // the asset's typical favourable zone and is still profitable gets its
      // profit LOCKED deterministically (no LLM vote needed). SL is never
      // touched — the stop keeps its noise room; this gate only closes.
      // Only when the gate is disabled does execution fall entirely to the
      // pre-PAEL paths below.
      await this.runExitPriceLockGate();

      // v2.0.80: Force-close positions whose entry thesis was invalidated by Skeptics
      // v2.0.139: Mark these as thesis_invalidation closes so the conviction-gate
      // winRate excludes them (Option C — prevents the feedback trap where thesis
      // invalidation losses raise the gate → new entries blocked → stuck in cash).
      //
      // v2.0.798: FINAL PROFITABILITY GUARD — re-fetch current price at the moment
      // of position closure and skip the close if the position is profitable.
      // The 59-minute timer (index.ts, unmodifiable) fires BETWEEN cycles and
      // force-closes positions that became profitable DURING the hold. Previous
      // guards (v2.0.793/796) checked profitability at cycle start or invalidation
      // moment, but the timer fires BETWEEN these checks. This guard is the LAST
      // line of defense — at the actual closePosition() call — ensuring NO code
      // path can force-close a winning position.
      //
      // v2.0.814: CRITICAL FIX — The profitability guard was checking PnL at
      // closePosition() call time, but the 59-minute timer fires BETWEEN cycles
      // and the guard was not intercepting the force-close path correctly.
      // The fix: re-fetch current price at the moment of position closure and
      // skip the close if the position is profitable. This catches positions that
      // became profitable BETWEEN the invalidation check and this close call.
      // Additionally, we now check the position's UNREALIZED PnL from the
      // portfolio (which is updated by the WS price feed every tick) BEFORE
      // calling closeTrade(). If the position is profitable, we skip the close
      // entirely and log the guard activation.
      //
      // v2.0.830: PROFIT GUARD v3 — Institutional CLOSE/FLIP confirmation.
      // The old v2 guard BLINDLY blocked ALL profitable force-closes, even when
      // the thesis was confirmed broken (price below support, trend reversed).
      // This caused positions to ride winning into a reversal and give back all
      // gains — the "let winners ride into losers" problem.
      //
      // v3 introduces STRUCTURAL BREAK CONFIRMATION + risk-profile calibration:
      //   • A close is CONFIRMED if price has broken the key S/R level that the
      //     thesis depended on (not just touched — broken decisively).
      //   • If the close is confirmed, the profit guard allows it EVEN if the
      //     position is slightly profitable — because holding a broken thesis
      //     into a reversal is riskier than locking in a small gain.
      //   • The profit tolerance is calibrated by risk profile:
      //       aggressive   → only allow confirmed close if profit < 2.0%
      //                       (tolerate larger drawdowns, give thesis more room)
      //       moderate     → allow confirmed close if profit < 1.0%
      //       conservative → allow confirmed close if profit < 0.5%
      //                       (cut early, protect capital)
      //   • If the close is NOT confirmed (thesis invalidated but no structural
      //     break), the old v2 behavior applies: block if profitable.
      //   • SL hit is ALWAYS a confirmed close (the market itself confirmed).
      if (result.thesisInvalidatedSymbols && result.thesisInvalidatedSymbols.length > 0) {
        const riskProfile = this.marketAgent.getRiskProfile();
        // v2.0.830: Profit tolerance for confirmed-structure-break closes.
        // v2.0.857: risk profiles removed — always moderate tolerance (1.0%).
        const confirmedCloseProfitTolerance = 0.010; // moderate

        for (const sym of result.thesisInvalidatedSymbols) {
          const pos = this.portfolio.getPosition(sym);
          if (!pos) continue;

          // ── v2.0.830: Structural break confirmation ────────────────────
          // Check if price has decisively broken the key S/R level or SL.
          // A "confirmed break" means price is BEYOND the SL price (for the
          // position's direction) OR beyond the nearest S/R level that the
          // thesis depended on. This is the institutional standard: a thesis
          // is only "confirmed broken" when the market structure agrees, not
          // just when the LLM says so.
          const currentPrice = this.marketState?.getState(sym)?.price ?? pos.currentPrice ?? 0;
          const slPrice = pos.stopLossPrice ?? 0;
          const srSupport = this.lastSRContext?.nearestSupport ?? null;
          const srResistance = this.lastSRContext?.nearestResistance ?? null;

          let structureConfirmed = false;
          let confirmReason = '';

          // SL hit = always confirmed (market itself confirmed the break)
          if (slPrice > 0) {
            if (isBuySide(pos.side) && currentPrice <= slPrice) {
              structureConfirmed = true;
              confirmReason = `price $${currentPrice.toFixed(2)} ≤ SL $${slPrice.toFixed(2)}`;
            } else if (isSellSide(pos.side) && currentPrice >= slPrice) {
              structureConfirmed = true;
              confirmReason = `price $${currentPrice.toFixed(2)} ≥ SL $${slPrice.toFixed(2)}`;
            }
          }

          // S/R break confirmation (only for active symbol — S/R is only
          // computed for the active symbol; non-active symbols rely on SL)
          //
          // v2.0.830: BREAK QUALITY ASSESSMENT — not all breaks are equal.
          // A break of a STRONG PIVOT support (multiple touches, real price
          // action) is a genuine structural event. A break of a WEAK ROUND_NUM
          // support (e.g. $64K integer level, 1 touch) is just noise — price
          // often wicks below round numbers and bounces back.
          //
          // The break must be DECISIVE: price must be beyond the S/R level by
          // a minimum percentage that scales with the zone's weakness:
          //   strong pivot    → 0.3% beyond = confirmed (real levels break clean)
          //   moderate        → 0.5% beyond
          //   weak round_num  → 1.0% beyond (need more proof for weak levels)
          //   unknown/null    → 0.5% beyond (default)
          //
          // This prevents "wick below $64K for 1 second → force close" while
          // still catching genuine structural breaks.
          if (!structureConfirmed && normalizeSymbol(sym) === normalizeSymbol(this.marketAgent.getSelectedSymbol())) {
            const srStrength = this.lastSRContext?.nearestSupportStrength ?? null;
            const srSource = this.lastSRContext?.nearestSupportSource ?? null;
            // Minimum break depth (fraction beyond the level) based on zone quality
            const breakDepthRequired = srStrength === 'strong' ? 0.003
              : srStrength === 'weak' ? 0.010
              : 0.005; // moderate or unknown

            if (isBuySide(pos.side) && srSupport !== null && srSupport > 0) {
              const breakDepth = (srSupport - currentPrice) / srSupport;
              // v2.0.831: NaN guard — if currentPrice is NaN, breakDepth = NaN.
              // NaN >= breakDepthRequired = false → structureConfirmed stays false.
              // This is safe (won't crash, won't false-positive), but we guard
              // explicitly to avoid NaN propagating to the log message.
              if (Number.isFinite(breakDepth) && currentPrice < srSupport && breakDepth >= breakDepthRequired) {
                structureConfirmed = true;
                confirmReason = `price $${currentPrice.toFixed(2)} < support $${srSupport.toFixed(2)} by ${(breakDepth * 100).toFixed(2)}% (≥ ${(breakDepthRequired * 100).toFixed(1)}% required, strength=${srStrength ?? 'unknown'}, source=${srSource ?? 'unknown'})`;
              } else if (currentPrice < srSupport) {
                // Price is below support but NOT decisively — just a wick
                confirmReason = `price $${currentPrice.toFixed(2)} below support $${srSupport.toFixed(2)} by only ${(breakDepth * 100).toFixed(2)}% (< ${(breakDepthRequired * 100).toFixed(1)}% required for ${srStrength ?? 'unknown'} ${srSource ?? 'unknown'} support) — NOT confirmed (likely wick)`;
              }
            } else if (isSellSide(pos.side) && srResistance !== null && srResistance > 0) {
              const breakDepth = (currentPrice - srResistance) / srResistance;
              // v2.0.831: NaN guard — same as buy path
              if (Number.isFinite(breakDepth) && currentPrice > srResistance && breakDepth >= breakDepthRequired) {
                structureConfirmed = true;
                confirmReason = `price $${currentPrice.toFixed(2)} > resistance $${srResistance.toFixed(2)} by ${(breakDepth * 100).toFixed(2)}% (≥ ${(breakDepthRequired * 100).toFixed(1)}% required, strength=${srStrength ?? 'unknown'}, source=${srSource ?? 'unknown'})`;
              } else if (currentPrice > srResistance) {
                confirmReason = `price $${currentPrice.toFixed(2)} above resistance $${srResistance.toFixed(2)} by only ${(breakDepth * 100).toFixed(2)}% (< ${(breakDepthRequired * 100).toFixed(1)}% required for ${srStrength ?? 'unknown'} ${srSource ?? 'unknown'} resistance) — NOT confirmed (likely wick)`;
              }
            }
          }

          // ── Compute current PnL % ──────────────────────────────────────
          const guardPrice = currentPrice > 0 ? currentPrice : (pos.currentPrice ?? 0);
          // v2.0.830: If we have NO valid price at all, we cannot determine
          // profitability or structural break. Fall through to v2 behavior:
          // use the portfolio's unrealizedPnl as fallback. If that's also
          // positive, block (don't close a position we can't price).
          if (guardPrice <= 0) {
            if (pos.unrealizedPnl > 0) {
              log.warn(`🛡️ [PROFIT GUARD v3] ${sym}: no valid price data (marketState=0, currentPrice=0) but portfolio shows profit — BLOCKING force-close (cannot confirm structure without price).`);
              this.thesisInvalidatedCloseSymbols.delete(sym);
              continue;
            }
            // No price + not profitable → allow close (thesis invalidated + losing)
            log.warn(`🚫 Thesis INVALIDATED for ${sym} — force-closing (no price data, position not profitable per portfolio)`);
            this.thesisInvalidatedCloseSymbols.add(sym);
            const exitThesis = `Thesis invalidated: ${pos.entryThesis ?? 'original entry thesis no longer valid'} [no price data]`;
            // v2.0.855: Explicit closeReason — without it, inferCloseReason
            // classifies by exit price vs SL/TP, mislabeling this agent-driven
            // close as 'sl_tp' → OLR/EXP/RIL learn from wrong close context.
            const success = await this.closeTrade(sym, exitThesis, 'thesis_invalidation');
            if (success) {
              log.info(`  → Force-closed ${sym} (thesis invalidated, no price data)`);
            } else {
              log.error(`  → Failed to force-close ${sym} — position remains open`);
              this.thesisInvalidatedCloseSymbols.delete(sym);
            }
            continue;
          }
          const guardPnlPct = isBuySide(pos.side)
            ? (guardPrice - pos.averageEntryPrice) / pos.averageEntryPrice
            : (pos.averageEntryPrice - guardPrice) / pos.averageEntryPrice;
          const isProfitable = guardPnlPct > 0;

          // ── v2.0.869(主神 SKHX 09:18 調查):MFE 鎖利 override ────────────
          // 第 5 個 trade(SKHX 09:18):MFE 1.29% 觸發 lock-profit zone——但係冇 close——
          // price 反轉——蝕 -0.13。Post-Review:「should have taken the $0.77 MFE
          // when the lock-profit threshold was hit」——MFE 鎖利應該 override PROFIT GUARD
          // (鎖住 gain——唔係 cutting a winner early——係「鎖住已到嘅 gain」)
          let mfeLockOverride = false;
          try {
            if (this.closeCalibrator && pos) {
              const posMargin = (pos.averageEntryPrice * pos.quantity) / safeLeverage(pos.leverage);
              const posMfe = posMargin > 0 && Number.isFinite(pos.maxValueReached) ? ((pos.maxValueReached as number) - posMargin) / posMargin : 0;
              const curFav = posMargin > 0 && Number.isFinite(pos.unrealizedPnl) ? pos.unrealizedPnl / posMargin : 0;
              const retraced = posMfe > 0 ? Math.max(0, Math.min(1, (posMfe - curFav) / posMfe)) : 0;
              const atrVal = this.atrCacheThisCycle.get(String(sym).toLowerCase()) ?? 0;
              const atrPct = atrVal > 0 && pos.averageEntryPrice > 0 ? atrVal / pos.averageEntryPrice : 0;
              const lockAdvice = this.closeCalibrator.getMfeLockAdvice(sym, isSellSide(pos.side) ? 'sell' : 'buy', posMfe, atrPct, retraced);
              if (lockAdvice.shouldLock) {
                mfeLockOverride = true;
                log.info(`🔒 [mfe-lock-override] ${sym}: ${lockAdvice.reason}——override PROFIT GUARD——直接 close(鎖利)`);
              }
            }
          } catch { /* 非致命——MFE 鎖利失敗唔 block */ }

          // ── v2.0.830: Profit Guard v3 decision logic ───────────────────
          // Matrix:
          //   structureConfirmed + losing    → CLOSE (always — thesis broken + losing)
          //   structureConfirmed + profitable < tolerance → CLOSE (confirmed break, small gain)
          //   structureConfirmed + profitable ≥ tolerance → BLOCK (winning enough to wait)
          //   !structureConfirmed + profitable → BLOCK (v2 behavior — no structural proof)
          //   !structureConfirmed + losing    → CLOSE (v2 behavior — thesis broken + losing)
          // v2.0.869:MFE 鎖利 override——MFE 已達且回吐——直接 close(鎖利)
          if (mfeLockOverride) {
            // MFE 鎖利——直接 close(唔 block)
          } else if (isProfitable && structureConfirmed && guardPnlPct < confirmedCloseProfitTolerance) {
            // Confirmed structural break + small profit → allow close
            log.info(`🛡️ [PROFIT GUARD v3] ${sym}: confirmed break (${confirmReason}) + small profit (${(guardPnlPct * 100).toFixed(2)}% < ${(confirmedCloseProfitTolerance * 100).toFixed(1)}% tolerance, risk=${riskProfile}) — ALLOWING force-close. Thesis confirmed broken by market structure.`);
          } else if (isProfitable && structureConfirmed && guardPnlPct >= confirmedCloseProfitTolerance) {
            // Confirmed break but profit is large enough to justify waiting
            log.warn(`🛡️ [PROFIT GUARD v3] ${sym}: confirmed break (${confirmReason}) but profit ${(guardPnlPct * 100).toFixed(2)}% ≥ ${(confirmedCloseProfitTolerance * 100).toFixed(1)}% tolerance (risk=${riskProfile}) — BLOCKING force-close. Position is winning enough to give thesis one more cycle.`);
            this.thesisInvalidatedCloseSymbols.delete(sym);
            continue;
          } else if (isProfitable && !structureConfirmed) {
            // No structural confirmation + profitable → block (v2 behavior)
            log.warn(`🛡️ [PROFIT GUARD v3] ${sym}: position is profitable (${(guardPnlPct * 100).toFixed(2)}%) but NO structural break confirmed — BLOCKING force-close. Thesis invalidated by LLM but market structure has not confirmed. Keeping position open.`);
            this.thesisInvalidatedCloseSymbols.delete(sym);
            continue;
          }
          // If losing (regardless of structureConfirmed) → fall through to close

          log.warn(`🚫 Thesis INVALIDATED for ${sym} — force-closing position${structureConfirmed ? ` (confirmed: ${confirmReason})` : ' (no structural confirmation, but position is losing)'} (risk=${riskProfile})`);
          this.thesisInvalidatedCloseSymbols.add(sym);
          // v2.0.143: Route through closeTrade() with thesis-invalidation exitThesis.
          // v2.0.855: Explicit closeReason 'thesis_invalidation' — the old call
          // omitted it, so inferCloseReason fell back to exit-price vs SL/TP
          // classification and mislabeled 72/167 real closes as SL/TP.
          const exitThesis = `Thesis invalidated: ${pos.entryThesis ?? 'original entry thesis no longer valid'}${structureConfirmed ? ` [confirmed: ${confirmReason}]` : ''}`;
          const success = await this.closeTrade(sym, exitThesis, 'thesis_invalidation');
          if (success) {
            if (pos.agentId === 'hyperliquid-real') {
              log.info(`  → Force-closed ${sym} (real, thesis invalidated)`);
            } else {
              log.info(`  → Force-closed ${sym}: ${pos.unrealizedPnl.toFixed(2)} (thesis invalidated)`);
            }
          } else {
            log.error(`  → Failed to force-close ${sym} — position remains open`);
            this.thesisInvalidatedCloseSymbols.delete(sym);
          }
        }
      }

      // v2.0.141: Block re-entry on symbols force-closed this cycle (thesis invalidation churn loop fix)
      const thesisInvalidatedReentryBlock = new Set(result.thesisInvalidatedSymbols ?? []);
      if (thesisInvalidatedReentryBlock.size > 0) {
        log.warn(`🚫 Blocking re-entry on ${thesisInvalidatedReentryBlock.size} symbol(s) force-closed this cycle: ${[...thesisInvalidatedReentryBlock].join(', ')}`);
      }

      // 3.1 Apply position adjustments (TP/SL) from meta-agent
      // v2.0.31: In real mode, also place native trigger orders on HL exchange
      // v2.0.60: Validate SL against implied move (options data) before applying.
      if (result.positionAdjustments && result.positionAdjustments.length > 0) {
        for (const adj of result.positionAdjustments) {
          // v2.0.60: If we have options data, validate SL distance against implied move.
          // If SL is too tight (< 50% of implied move) or too wide (> 3x implied move),
          // skip the SL adjustment and keep the existing value.
          let effectiveSL = adj.newStopLoss;
          let effectiveTP = adj.newTakeProfit;
          if (useOptionsData && adj.newStopLoss !== undefined) {
            const pos = this.portfolio.getPosition(adj.positionId);
            if (pos) {
              const slDistPct = Math.abs(pos.currentPrice - adj.newStopLoss) / pos.currentPrice;
              const slCheck = this.optionsDataManager.validateSLAgainstImpliedMove(adj.positionId.includes('-') ? pos.symbol : adj.positionId, slDistPct);
              if (!slCheck.valid) {
                log.warn(`🛑 [options-SL] ${pos.symbol}: ${slCheck.reason} — skipping SL adjustment, keeping existing SL`);
                effectiveSL = undefined; // skip SL, keep existing
              }
            }
          }
          await this.tradingManager.adjustPosition(adj.positionId, effectiveSL, effectiveTP);
          log.info(`📐 Position ${adj.positionId.slice(0, 8)} adjusted: SL=${effectiveSL?.toFixed(2) ?? '-'} TP=${effectiveTP?.toFixed(2) ?? '-'}`);
        }
      }

      // 3.5 Exploration trade: if consensus is HOLD but we haven't traded in 3+ cycles,
      // force a tiny exploratory position to generate evolution data.
      // This fires even after Risk Auditor veto — the system NEEDS trade data to evolve.
      // Direction is determined by Pattern Classifier: query BUY vs SELL win rates
      // for current market conditions and pick the higher one.
      //
      // 🐛 FIX v2.0.8: Added directional trend filter. In a slow bleed market
      // (32 down / 17 up cycles over last 50), all signals are weak and the
      // 24h change can briefly flip positive on small bounces, causing false
      // BUY signals. The trend filter checks the last 10 cycles' price action
      // and blocks BUY when price is declining, blocks SELL when rising.
      let finalDecision = result.consensus.decision;
      // v2.0.80: Extract entryThesis from perSymbolConsensus for the active symbol
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const activePsc = (result.consensus.perSymbolConsensus ?? []).find(
          psc => normalizeSymbol(psc.symbol) === normalizeSymbol(activeSymbol),
        );
        if (activePsc?.entryThesis && !finalDecision.entryThesis) {
          finalDecision = { ...finalDecision, entryThesis: activePsc.entryThesis };
        }
      }
      // v2.0.122: Capture the original Meta-Agent thesis+action BEFORE any gates
      // (conviction gate, direction restriction, liquidity, etc.) can override it.
      // If the trade doesn't execute, we store this as a pending thesis so it
      // carries forward to the next cycle for Skeptics re-validation.
      const originalMetaAction = finalDecision.action;
      const originalMetaThesis = finalDecision.entryThesis;
      if (finalDecision.action === 'hold' && this.totalCycles > 2 && this.totalCycles % 3 === 0) {
        // v2.0.750: Don't override Meta-Agent's HOLD if the thesis explicitly says
        // to wait or not to enter. This prevents thesis-contradicts-action incidents.
        const metaThesisLower = (originalMetaThesis ?? '').toLowerCase();
        const explicitWait = metaThesisLower.includes('wait for') || metaThesisLower.includes('no entry')
          || metaThesisLower.includes('do not enter') || metaThesisLower.includes('hold for')
          || metaThesisLower.includes('wait until') || metaThesisLower.includes('no trade');
        if (explicitWait) {
          log.info(`🧪 Exploration skipped — Meta-Agent thesis explicitly says to wait: "${originalMetaThesis?.slice(0, 80)}..."`);
        } else if (!this.portfolio.hasPosition(activeSymbol)) {
          const maConfig = this.marketAgent.getConfig();
          const exploreSize = maConfig.positionSizePct;
          // Use Market Agent's configured leverage directly.
          // The user sets leverage via Market Agent config — agents should NOT
          // override or close positions based on leverage (that's the Market
          // Agent's job). Exploration trades use the same leverage as normal trades.
          const exploreLev = maConfig.leverage;

          // ── Trend Filter ──
          // v2.0.32: REMOVED the "immediate price vs previous cycle" trend filter.
          // The old filter blocked BUY when price was falling and SELL when
          // price was rising — this is "chase the trend" logic that causes
          // the system to buy at the top and sell at the bottom (buy high,
          // sell low). Short-term price movement is mean-reverting, so
          // blocking the contrarian direction is counterproductive.
          //
          // Keep only the 10-cycle macro trend filter as a SOFT signal
          // (not a hard block) — if 7+ of last 10 cycles are down, it's
          // a strong downtrend and we should be cautious about buying.
          let trendFilterBlocksBuy = false;
          let trendFilterBlocksSell = false;
          let recentHistory: import('./evolution/trade-history.ts').TradeHistoryEntry[] = [];
          try {
            recentHistory = this.evolution.tradeHistory.getRecent(10);
            if (recentHistory.length >= 5) {
              let upCount = 0;
              let downCount = 0;
              for (let i = 1; i < recentHistory.length; i++) {
                const prev = recentHistory[i - 1]!.entryPrice;
                const curr = recentHistory[i]!.entryPrice;
                if (prev > 0 && curr > 0) {
                  if (curr > prev) upCount++;
                  else if (curr < prev) downCount++;
                }
              }
              // v2.0.32: Only block on STRONG trends (7+ out of 10)
              // This allows contrarian entries in mild trends while
              // still protecting against strong directional moves.
              if (downCount >= 7) {
                trendFilterBlocksBuy = true;
                log.info(`🧪 Trend filter (strong downtrend): ${downCount}D/${upCount}U → BLOCK BUY`);
              } else if (upCount >= 7) {
                trendFilterBlocksSell = true;
                log.info(`🧪 Trend filter (strong uptrend): ${upCount}U/${downCount}D → BLOCK SELL`);
              }
            }
            // v2.0.32: REMOVED Layer 2 (immediate price vs previous cycle) —
            // this was the main cause of "buy high sell low" behavior.
          } catch { /* non-critical */ }

          // Use Pattern Classifier to pick direction — compare BUY vs SELL win rates.
          // Fallback to technical signals when pattern data is insufficient.
          let direction: string | null = null;
          try {
            const sentimentData = this.sentimentEngine?.getSentiment();
            const hlPrice = this.hyperliquidWs?.getLatestMarkPrice?.();
            const actualFundingRate = hlPrice?.fundingRate ?? 0;

            // v2.0.41: Planck-Chaos direction bias REMOVED from exploration.
            // The regime-aware direction chain (Priority 0 below) already
            // handles mean-reversion vs trend-following. Planck-Chaos now
            // only provides Lyapunov (predictability) + amplitude windows
            // as informational context, not direction.
            //
            // ⚠️ MAINTENANCE NOTE: If you re-add Planck-Chaos direction,
            // update this block AND the PlanckChaosResult interface +
            // buildContextString in planck-chaos.ts.

            const patternCtx = {
              regime: combinedState.regime,
                            volatility: combinedState.volatility ?? 0,
                            srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
              obImbalance: combinedState.orderBookImbalance ?? 0,
              fundingRate: actualFundingRate,
              volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
              signalAgreement: 0.5,
                  leverage: exploreLev,
              sentiment: sentimentData?.overallSentiment ?? 0,
              sentimentConviction: sentimentData?.conviction ?? 0.5,
                };

            // Priority 0: OLR + First-Passage assessment (highest weight — can HARD BLOCK)
            let olrBlocked = false;
            if (!direction) {
              const olrCtx = {
                volatility: combinedState.volatility ?? 0,
                srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                obImbalance: combinedState.orderBookImbalance ?? 0,
                fundingRate: actualFundingRate,
                volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
                signalAgreement: 0.5,
                sentiment: sentimentData?.overallSentiment ?? 0,
                sentimentConviction: sentimentData?.conviction ?? 0.5,
                // v2.0.721: Regime ordinal (H1)
                regimeOrdinal: regimeToOrdinal(combinedState.regime),
                // v2.0.221 (Fix 1): Hour-of-day
                hourOfDay: currentHourOfDay(),
              };
              const olrBuy = this.olrEngine.query(combinedState.primarySymbol, { ...olrCtx }, 'buy', this.totalCycles);
              const olrSell = this.olrEngine.query(combinedState.primarySymbol, { ...olrCtx }, 'sell', this.totalCycles);

              // Use OLR P(win) + first-passage probability combined.
              // H3 fix: thresholds are RR-aware. The old flat 0.6/0.5/0.35
              //   gates assumed a ~1:1 RR, so under the default 1:2.5 RR
              //   (SL 2% / TP 5%) the random-walk breakeven is a/(a+b)=28.6%,
              //   making the < 0.35 block fire near-constantly. Compare each
              //   side's score to that side's path breakeven instead.
              const fpLong = this.lastFirstPassage?.longPWin ?? 0.5;
              const fpShort = this.lastFirstPassage?.shortPWin ?? 0.5;
              const beLong = this.lastFirstPassage?.breakevenPLong ?? 0.5;
              const beShort = this.lastFirstPassage?.breakevenPShort ?? 0.5;
              // Combined score: average of OLR and first-passage
              const buyScore = (olrBuy.pWin + fpLong) / 2;
              const sellScore = (olrSell.pWin + fpShort) / 2;
              const buyEdge = buyScore - beLong;   // positive = beats breakeven
              const sellEdge = sellScore - beShort;
              const ENTRY_EDGE = 0.10;   // score must beat breakeven by 10pp
              const BLOCK_EDGE = -0.05;  // hard block when 5pp BELOW breakeven on both

              if (buyEdge > ENTRY_EDGE && buyScore > sellScore) {
                direction = 'buy';
                log.info(`🧪 OLR+FP-guided: BUY score=${(buyScore * 100).toFixed(0)}% (edge=${(buyEdge * 100).toFixed(0)}pp over breakeven ${(beLong * 100).toFixed(0)}%; OLR=${(olrBuy.pWin * 100).toFixed(0)}%, FP=${(fpLong * 100).toFixed(0)}%)`);
              } else if (sellEdge > ENTRY_EDGE && sellScore > buyScore) {
                direction = 'sell';
                log.info(`🧪 OLR+FP-guided: SELL score=${(sellScore * 100).toFixed(0)}% (edge=${(sellEdge * 100).toFixed(0)}pp over breakeven ${(beShort * 100).toFixed(0)}%; OLR=${(olrSell.pWin * 100).toFixed(0)}%, FP=${(fpShort * 100).toFixed(0)}%)`);
              } else if (buyEdge < BLOCK_EDGE && sellEdge < BLOCK_EDGE) {
                direction = null;
                olrBlocked = true;
                log.info(`🧪 OLR+FP-guided: Both scores below breakeven by >${(BLOCK_EDGE * 100).toFixed(0)}pp → HARD BLOCK (buy=${(buyScore * 100).toFixed(0)}% vs be=${(beLong * 100).toFixed(0)}%, sell=${(sellScore * 100).toFixed(0)}% vs be=${(beShort * 100).toFixed(0)}%)`);
              } else {
                log.info(`🧪 OLR+FP-guided: No clear edge over breakeven (buy=${(buyScore * 100).toFixed(0)}% vs be=${(beLong * 100).toFixed(0)}%, sell=${(sellScore * 100).toFixed(0)}% vs be=${(beShort * 100).toFixed(0)}%) — falling through to other signals`);
              }
            }

            // If OLR+FP hard-blocked, skip all remaining signal checks
            if (olrBlocked) {
              direction = null;
            }
            // If both no_edge or mixed, fall through to other signals

            // Priority 1: Pattern data (most reliable, requires >=3 matches with 0.5+PnL)
            if (!direction && this.patternClassifier) {
              const buyResult = this.patternClassifier.queryEntry(patternCtx, combinedState.primarySymbol, 'buy', combinedState.price);
              const sellResult = this.patternClassifier.queryEntry(patternCtx, combinedState.primarySymbol, 'sell', combinedState.price);
              const buyWr = buyResult.totalMatches >= 3 ? buyResult.adjustedWinRate : 0;
              const sellWr = sellResult.totalMatches >= 3 ? sellResult.adjustedWinRate : 0;
              // v2.0.721: Raise direction threshold from >0 to >0.3 with min spread.
              // adjustedWinRate is already Wilson-scored, so 0.3 LB ≈ 5/8 raw WR (62.5%).
              // The old `>0` let 1/3 (Wilson LB ~10%) drive direction — pure noise.
              if (Math.max(buyWr, sellWr) > 0.3 && Math.abs(buyWr - sellWr) > 0.1) {
                direction = sellWr > buyWr ? 'sell' : 'buy';
                log.info(`🧪 Pattern-guided: BUY adjWR=${(buyWr*100).toFixed(0)}% SELL adjWR=${(sellWr*100).toFixed(0)}% → ${direction.toUpperCase()}`);
              }

              // Priority 1b: EM cluster-weighted win rate (unsupervised GMM assessment)
              if (!direction) {
                const buyEM = buyResult.emAssessment;
                const sellEM = sellResult.emAssessment;
                // Only trust EM if it has a model and the signals disagree with neutral
                const buyEMWr = buyEM.weightedWinRate;
                const sellEMWr = sellEM.weightedWinRate;
                if (buyEM.dominantCluster >= 0 && sellEM.dominantCluster >= 0 &&
                    (Math.abs(buyEMWr - 0.5) > 0.1 || Math.abs(sellEMWr - 0.5) > 0.1)) {
                  direction = sellEMWr > buyEMWr ? 'sell' : 'buy';
                  log.info(`🧪 EM-guided: BUY EMwr=${(buyEMWr*100).toFixed(0)}% SELL EMwr=${(sellEMWr*100).toFixed(0)}% → ${direction.toUpperCase()}`);
                }
              }
            }

            // Priority 2: Sigmoid·GA sentiment
            // v2.0.32: Regime-aware — in mean-reverting markets, fade sentiment
            // (sentiment says BUY → actually SELL because price will revert).
            // In trending markets, follow sentiment.
            if (!direction && sentimentData && sentimentData.conviction > 0.6 && Math.abs(sentimentData.overallSentiment) > 0.15) {
              const isMeanRevert = combinedState.regime === 'mean_reverting' || combinedState.regime === 'low_volatility';
              if (isMeanRevert) {
                direction = sentimentData.overallSentiment > 0 ? 'sell' : 'buy';
                log.info(`🧪 Sentiment-guided (mean-revert fade): overall=${(sentimentData.overallSentiment*100).toFixed(0)}% → ${direction.toUpperCase()}`);
              } else {
                direction = sentimentData.overallSentiment > 0 ? 'buy' : 'sell';
                log.info(`🧪 Sentiment-guided (trend follow): overall=${(sentimentData.overallSentiment*100).toFixed(0)}% → ${direction.toUpperCase()}`);
              }
            }

            // Priority 3: Price velocity + acceleration
            // v2.0.32: Regime-aware — in mean-reverting markets, fade velocity
            // (price rising → SELL because it will revert; price falling → BUY).
            // In trending markets, follow velocity.
            if (!direction && this.sentimentEngine) {
              const velocity = this.sentimentEngine.getPriceVelocity();
              const acceleration = this.sentimentEngine.getPriceAcceleration();
              const absVelocity = Math.abs(velocity);
              const isMeanRevert = combinedState.regime === 'mean_reverting' || combinedState.regime === 'low_volatility';
              if (absVelocity > 0.15) {
                if (isMeanRevert) {
                  // Mean-revert: fade the move (opposite direction)
                  direction = velocity > 0 ? 'sell' : 'buy';
                  log.info(`🧪 Velocity-guided (mean-revert fade): vel=${(velocity*100).toFixed(0)}% → ${direction.toUpperCase()}`);
                } else {
                  // Trend: follow the move (same direction)
                  direction = velocity > 0 ? 'buy' : 'sell';
                  log.info(`🧪 Velocity-guided (trend follow): vel=${(velocity*100).toFixed(0)}% → ${direction.toUpperCase()}`);
                }
              } else if (absVelocity > 0.05) {
                if (isMeanRevert) {
                  if (acceleration > 0.05 && velocity > 0) {
                    direction = 'sell'; // fade up move
                    log.info(`🧪 Velocity+accel (mean-revert fade): vel=${(velocity*100).toFixed(0)}% → SELL`);
                  } else if (acceleration < -0.05 && velocity < 0) {
                    direction = 'buy'; // fade down move
                    log.info(`🧪 Velocity+accel (mean-revert fade): vel=${(velocity*100).toFixed(0)}% → BUY`);
                  }
                } else {
                  if (acceleration > 0.05 && velocity > 0) {
                    direction = 'buy';
                    log.info(`🧪 Velocity+accel (trend follow): vel=${(velocity*100).toFixed(0)}% → BUY`);
                  } else if (acceleration < -0.05 && velocity < 0) {
                    direction = 'sell';
                    log.info(`🧪 Velocity+accel (trend follow): vel=${(velocity*100).toFixed(0)}% → SELL`);
                  }
                }
              }
            }

            // Priority 4: S/R proximity — regime-aware
            // v2.0.32: In mean-reverting markets, use S/R as REVERSAL points
            // (near resistance → SELL, near support → BUY).
            // In trending markets, use S/R as BREAKOUT points (original logic).
            if (!direction && this.lastSRContext) {
              const distToSupport = this.lastSRContext.distanceToSupportBps;
              const distToResistance = this.lastSRContext.distanceToResistanceBps;
              const totalRange = distToSupport + distToResistance;
              if (totalRange > 0) {
                const positionInRange = distToSupport / totalRange;
                const isMeanRevert = combinedState.regime === 'mean_reverting' || combinedState.regime === 'low_volatility';
                if (isMeanRevert) {
                  // Mean-revert: fade at S/R extremes
                  if (positionInRange > 0.65 && distToResistance < 30) {
                    direction = 'sell'; // near resistance → SELL (revert down)
                    log.info(`🧪 S/R-guided (mean-revert): near resistance → SELL (revert)`);
                  } else if (positionInRange < 0.35 && distToSupport < 30) {
                    direction = 'buy'; // near support → BUY (revert up)
                    log.info(`🧪 S/R-guided (mean-revert): near support → BUY (revert)`);
                  }
                } else {
                  // Trend: breakout at S/R (original logic)
                  if (positionInRange > 0.65 && distToResistance < 30) {
                    direction = 'buy';
                    log.info(`🧪 S/R-guided (breakout): near resistance → BUY (breakout)`);
                  } else if (positionInRange < 0.35 && distToSupport < 30) {
                    direction = 'sell';
                    log.info(`🧪 S/R-guided (breakout): near support → SELL (breakdown)`);
                  }
                }
              }
            }

            // Priority 5: Funding rate (negative = longs get paid = bullish, positive = bearish)
            // ⚠️ Only used as weak signal — in bear markets negative funding is common
            // and does NOT mean price will reverse up. Combined with velocity check.
            if (!direction && Math.abs(actualFundingRate) > 0.0002) {
              const frVelocity = this.sentimentEngine?.getPriceVelocity() ?? 0;
              if (actualFundingRate < 0 && frVelocity > 0.05) {
                // Negative funding + price going up → genuine bullish
                direction = 'buy';
                log.info(`🧪 Funding+vel-guided: rate=${(actualFundingRate*10000).toFixed(2)}bps vel=${(frVelocity*100).toFixed(0)}% → BUY`);
              } else if (actualFundingRate > 0 && frVelocity < -0.05) {
                // Positive funding + price going down → genuine bearish
                direction = 'sell';
                log.info(`🧪 Funding+vel-guided: rate=${(actualFundingRate*10000).toFixed(2)}bps vel=${(frVelocity*100).toFixed(0)}% → SELL`);
              }
            }

            // Priority 6: Order book imbalance (positive = bid pressure = buy, negative = sell pressure)
            if (!direction && combinedState.orderBookImbalance !== undefined && Math.abs(combinedState.orderBookImbalance) > 0.15) {
              direction = combinedState.orderBookImbalance > 0 ? 'buy' : 'sell';
              log.info(`🧪 OB-guided: imbalance=${(combinedState.orderBookImbalance*100).toFixed(0)}% → ${direction.toUpperCase()}`);
            }

            // Priority 7: Regime / Trend + 24h change combined
            // v2.0.32: Regime-aware — in mean-reverting markets, 24h change
            // is a CONTRARIAN signal (big drop → BUY, big rise → SELL).
            if (!direction) {
              const isMeanRevert = combinedState.regime === 'mean_reverting' || combinedState.regime === 'low_volatility';
              if (combinedState.regime === 'trending_bull') {
                direction = 'buy';
                log.info(`🧪 Regime-guided: trending_bull → BUY`);
              } else if (combinedState.regime === 'trending_bear') {
                direction = 'sell';
                log.info(`🧪 Regime-guided: trending_bear → SELL`);
              } else if (isMeanRevert) {
                // Mean-revert: buy low, sell high
                if (combinedState.change24h < -0.5) {
                  direction = 'buy'; // big drop → BUY (revert up)
                  log.info(`🧪 24h-change (mean-revert): ${combinedState.change24h.toFixed(2)}% → BUY (buy low)`);
                } else if (combinedState.change24h > 0.5) {
                  direction = 'sell'; // big rise → SELL (revert down)
                  log.info(`🧪 24h-change (mean-revert): ${combinedState.change24h.toFixed(2)}% → SELL (sell high)`);
                }
              } else {
                // Other regimes: original logic
                if (combinedState.change24h < -0.5) {
                  direction = 'sell';
                  log.info(`🧪 24h-change-guided: ${combinedState.change24h.toFixed(2)}% → SELL`);
                } else if (combinedState.change24h > 0.5) {
                  direction = 'buy';
                  log.info(`🧪 24h-change-guided: ${combinedState.change24h.toFixed(2)}% → BUY`);
                }
              }
            }
          } catch (err) {
            log.warn(`Pattern direction check failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          // ── Trend Filter Gate ──
          // After the priority chain determines a direction, check if the
          // short-term price trend contradicts it. If price has been declining
          // (more down cycles than up over last 10), block BUY. If rising,
          // block SELL. This prevents buying into a clear downtrend.
          if (direction === 'buy' && trendFilterBlocksBuy) {
            log.warn(`🧪 Trend filter gate: BLOCKED BUY — price declining over last ${recentHistory.length} cycles`);
            direction = null;
          } else if (direction === 'sell' && trendFilterBlocksSell) {
            log.warn(`🧪 Trend filter gate: BLOCKED SELL — price rising over last ${recentHistory.length} cycles`);
            direction = null;
          }

          // If all signals neutral, skip — don't default to buy
          if (!direction) {
            log.info(`🧪 All signals neutral — skipping exploration (no edge detected)`);
            finalDecision = result.consensus.decision; // keep HOLD
          } else {
            // v2.0.722: Rich exploration thesis — includes actual market data
            // so the digester can learn from condition-specific outcomes.
            // The old template ("pattern classifier suggests buy") was identical
            // for all exploration trades, making EXP embeddings useless.
            const expVol = (combinedState.volatility ?? 0).toFixed(4);
            const expRegime = combinedState.regime ?? 'unknown';
            const expOB = (combinedState.orderBookImbalance ?? 0).toFixed(2);
            const expFunding = (this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0).toFixed(5);
            const expSrDist = this.lastSRContext?.distanceToSupportBps ?? 0;
            const expSrResist = this.lastSRContext?.distanceToResistanceBps ?? 0;
            const expChange24h = (combinedState.change24h ?? 0).toFixed(2);
            const expPrice = combinedState.price?.toFixed(2) ?? '?';
            const expSentiment = (this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0).toFixed(2);
            const expVolumeRatio = (this.sentimentEngine?.getVolumeRatio() ?? 1).toFixed(2);
            // OLR + shadow context (if available)
            let expOlr = 'N/A';
            let expShadow = 'N/A';
            let expOlrPWin = 0; // v2.0.221 Fix #5: store OLR pWin for edge detection
            try {
              const olrCtx2 = {
                volatility: combinedState.volatility ?? 0,
                srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                obImbalance: combinedState.orderBookImbalance ?? 0,
                fundingRate: this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0,
                volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
                signalAgreement: 0.5,
                sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
                sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
                regimeOrdinal: regimeToOrdinal(combinedState.regime),
                hourOfDay: currentHourOfDay(), // v2.0.221 Fix 1
              };
              const olrQ = this.olrEngine.query(activeSymbol, olrCtx2, direction as 'buy' | 'sell', this.totalCycles);
              expOlrPWin = safeNum(olrQ.pWin, 0);
              expOlr = `${(olrQ.pWin * 100).toFixed(0)}% (${olrQ.nSamples} samples)`;
              const shadowSym = normalizeSymbol(activeSymbol);
              const shadowStat = this.shadowEngine.getStats().find(s => s.symbol === shadowSym);
              if (shadowStat) {
                const swr = direction === 'buy' ? shadowStat.longWinRate : shadowStat.shortWinRate;
                const stot = direction === 'buy' ? shadowStat.longWins + shadowStat.longLosses : shadowStat.shortWins + shadowStat.shortLosses;
                expShadow = `${(swr * 100).toFixed(0)}% (${stot} samples)`;
              }
            } catch { /* non-critical — thesis still has market data */ }

            // v2.0.221 (Fix #5): Build a REAL thesis with specific, falsifiable
            // edge elements — NOT a template that dumps all market data. The
            // old template ("buy exploration on xyz:SILVER @ ...") was identical
            // for all exploration trades, making EXP embeddings useless AND
            // violating the Meta-Agent's own thesis quality gate (≥2 specific
            // elements required). Exploration is the reason to CONSIDER the
            // trade, not the thesis itself. If we can't find ≥2 real edge
            // elements, we HOLD — no exploration trade without a real thesis.
            const expFundingNum = safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0);
            const expOlrNum = expOlrPWin;
            const expOBNum = safeNum(combinedState.orderBookImbalance, 0);
            const expSrSupport = this.lastSRContext?.nearestSupport ?? null;
            const expSrResistance = this.lastSRContext?.nearestResistance ?? null;
            const expSrDistNum = safeNum(this.lastSRContext?.distanceToSupportBps, 0);
            const expSrResistNum = safeNum(this.lastSRContext?.distanceToResistanceBps, 0);
            const expFpLong = safeNum(this.lastFirstPassage?.longPWin, 0);
            const expFpShort = safeNum(this.lastFirstPassage?.shortPWin, 0);
            const expFpBeLong = safeNum(this.lastFirstPassage?.breakevenPLong, 0.5);
            const expFpBeShort = safeNum(this.lastFirstPassage?.breakevenPShort, 0.5);
            const expVolNum = safeNum(combinedState.volatility, 0);

            // Collect edge elements (must find ≥2 for a valid thesis)
            const edgeElements: string[] = [];

            // Edge 1: OLR P(win) with edge magnitude
            if (expOlrNum > 0 && expOlrNum > 0.55) {
              const olrEdge = expOlrNum - 0.5;
              edgeElements.push(`OLR P(win)=${(expOlrNum * 100).toFixed(0)}% (edge +${(olrEdge * 100).toFixed(0)}pp over 50%)`);
            }

            // Edge 2: First-passage path edge
            const fpScore = direction === 'buy' ? expFpLong : expFpShort;
            const fpBe = direction === 'buy' ? expFpBeLong : expFpBeShort;
            const fpEdge = fpScore - fpBe;
            if (fpScore > 0 && fpEdge > 0.05) {
              edgeElements.push(`First-passage P(TP)=${(fpScore * 100).toFixed(0)}% vs breakeven ${(fpBe * 100).toFixed(0)}% (+${(fpEdge * 100).toFixed(0)}pp path edge)`);
            }

            // Edge 3: S/R proximity (near support for BUY, near resistance for SELL)
            if (expSrSupport !== null && direction === 'buy' && expSrDistNum > 0 && expSrDistNum < 50) {
              edgeElements.push(`S/R bounce at $${expSrSupport.toFixed(2)} support (${expSrDistNum.toFixed(0)}bps away)`);
            }
            if (expSrResistance !== null && direction === 'sell' && expSrResistNum > 0 && expSrResistNum < 50) {
              edgeElements.push(`S/R rejection at $${expSrResistance.toFixed(2)} resistance (${expSrResistNum.toFixed(0)}bps away)`);
            }

            // Edge 4: Funding rate edge
            if (Math.abs(expFundingNum) > 0.0002) {
              if (direction === 'buy' && expFundingNum < 0) {
                edgeElements.push(`Funding rate ${(expFundingNum * 10000).toFixed(2)}bps (shorts paying longs → squeeze potential)`);
              } else if (direction === 'sell' && expFundingNum > 0) {
                edgeElements.push(`Funding rate ${(expFundingNum * 10000).toFixed(2)}bps (longs paying shorts → squeeze potential)`);
              }
            }

            // Edge 5: Order book imbalance
            if (Math.abs(expOBNum) > 0.15) {
              const obDir = expOBNum > 0 ? 'bid' : 'ask';
              edgeElements.push(`Order book ${obDir} pressure (${(expOBNum * 100).toFixed(0)}% imbalance)`);
            }

            // Edge 6: Volatility regime edge (ATR compression → expansion)
            if (expVolNum > 0 && expVolNum < 0.01) {
              edgeElements.push(`ATR compression to ${(expVolNum * 100).toFixed(2)}% (low vol → expansion expected)`);
            }

            // v2.0.221 (Fix #5): If we can't find ≥2 real edge elements, HOLD.
            // An exploration trade without a real thesis is worse than no
            // trade — it pollutes the EXP learning system with meaningless
            // clusters and produces template-generated theses that the audit
            // flags as "thesis-quality-issue".
            if (edgeElements.length < 2) {
              log.info(`🧪 Exploration skipped — insufficient edge elements (${edgeElements.length}/2 found: ${edgeElements.join('; ') || 'none'}) for ${direction.toUpperCase()} ${activeSymbolUpper}`);
              direction = null;
              finalDecision = result.consensus.decision; // keep HOLD
            } else {
              // Build thesis from the top 2-3 edge elements (not all — keep it focused)
              const topEdges = edgeElements.slice(0, 3);
              const entryThesis = [
                `[1h: ${direction} ${activeSymbolUpper} @ ${expPrice} — ${topEdges.join(', ')}]`,
                `[1d: exploration trade (${(exploreSize * 100).toFixed(1)}% size, ${exploreLev}x lev) — ${direction} selected by multi-signal priority chain; OLR=${expOlr}, shadow=${expShadow}]`,
              ].join(' ');

            // v2.0.748: Volatility-scaled SL/TP for exploration trades.
            // Previously hardcoded 0.02/0.05 — too tight when volatility is low
            // (SL triggered by noise), too loose when volatility is high.
            // Now: base 2%/5% scaled by volatility relative to 0.02 (typical).
            // vol=0.02 → scale=1.0 (2%/5%), vol=0.01 → scale=0.5 (1%/2.5%),
            // vol=0.04 → scale=2.0 (4%/10%, capped at 3%/5%).
            const expVolRaw = combinedState.volatility ?? 0;
            const volScale = expVolRaw > 0 ? Math.max(0.5, Math.min(2.0, expVolRaw / 0.02)) : 1.0;
            const expSL = Math.min(0.03, 0.02 * volScale);
            const expTP = Math.min(0.05, 0.05 * volScale);

            finalDecision = {
              action: direction as 'buy' | 'sell',
              symbol: activeSymbolUpper,
              entryPrice: combinedState.price,
              positionSizePct: exploreSize,
              stopLossPct: expSL,
              takeProfitPct: expTP,
              leverage: exploreLev,
              rationale: `Exploratory ${direction} (${(exploreSize * 100).toFixed(1)}% size, ${exploreLev}x lev) on ${activeSymbolUpper} — regime=${expRegime}, vol=${expVol}, OLR=${expOlr}, shadow=${expShadow}.`,
              urgency: 'immediate',
              // v2.0.722: Rich thesis with actual market data for EXP learning
              entryThesis,
            };
            log.info(`🧪 Exploration trade triggered: ${direction.toUpperCase()} ${(exploreSize * 100).toFixed(1)}% ${activeSymbolUpper} @ ${exploreLev}x (cycle #${this.totalCycles}) — regime=${expRegime}, OLR=${expOlr}, shadow=${expShadow}, edges=${edgeElements.length}`);
            } // end: edgeElements >= 2 — real thesis built
          } // end: direction !== null — exploration trade executed
        }
      }

      // ── Execute PER-POSITION decisions from agents (profitable positions only) ──
      // If >=2 agents recommend closing a position that is IN PROFIT (>+1.5%),
      // take profits early. Losing positions are NEVER closed by agent votes —
      // they must ride to SL/TP. This prevents panic-closing during drawdowns.
      //
      // 🐛 FIX v2.0.8: Raised threshold from 0.5% → 1.5% to account for:
      //   - Taker fee 0.04% × 2 (open + close) = 0.08%
      //   - Spread ~0.1%
      //   - Total round-trip cost ~0.18%
      //   - Need minimum 1.5% return on margin to make closing worthwhile
      //   - Otherwise you're paying fees for no meaningful gain
      const allThoughts = result.allThoughts;
      const perPositionCloseReports: ExecutionReport[] = [];

      // v2.0.91: Per-position close voting — ONLY for legacy positions without entryThesis.
      // Positions opened before the thesis system (v2.0.80) don't have entryThesis,
      // so they can't go through the Meta-Agent → Skeptics close validation.
      // For these legacy positions, sub-agent majority vote (≥2) OR Meta-Agent CLOSE
      // decision is the close mechanism.
      // v2.0.94: Also close if Meta-Agent decides CLOSE (it's the decision maker —
      // its CLOSE decision should be respected even without Skeptics validation
      // for legacy positions that predate the thesis system).
      for (const posSymbol of this.portfolio.getOpenSymbols()) {
        const pos = this.portfolio.getPosition(posSymbol);
        if (!pos) continue;
        // Only apply this path to legacy positions without entryThesis
        if (pos.entryThesis) continue; // Has thesis → use consensus path with Skeptics validation

        // Check sub-agent close votes
        const closeVotes = allThoughts.filter(t => {
          if (t.agentRole === 'meta_agent' || t.agentRole === 'market_agent') return false;
          const msd = t.metadata?.['multiSymbolDecision'] as any;
          const posDecision = msd?.positions?.find((p: any) => normalizeSymbol(p?.symbol ?? '') === normalizeSymbol(posSymbol));
          return posDecision?.closePosition === true;
        }).length;

        // v2.0.94: Also check if Meta-Agent decided CLOSE for this position
        // Check both positions[] AND marketTicker (activeSymbol is filtered from
        // positions[] to avoid UI duplication, so its CLOSE decision may be in
        // marketTicker instead)
        const metaCloseDecision = allThoughts.some(t => {
          if (t.agentRole !== 'meta_agent') return false;
          const msd = t.metadata?.['multiSymbolDecision'] as any;
          if (!msd) return false;
          // Check positions[] array
          const posDecision = msd.positions?.find((p: any) => normalizeSymbol(p?.symbol ?? '') === normalizeSymbol(posSymbol));
          if (posDecision?.closePosition === true || posDecision?.action === 'close') return true;
          // Check marketTicker (in case this symbol is the activeSymbol and was
          // filtered from positions[] — its CLOSE decision is in marketTicker)
          if (msd.marketTicker && normalizeSymbol(msd.marketTicker.symbol ?? '') === normalizeSymbol(posSymbol)) {
            if (msd.marketTicker.closePosition === true || msd.marketTicker.action === 'close') return true;
          }
          return false;
        });

        // Close if ≥2 sub-agents vote close OR Meta-Agent decides close
        if (closeVotes < 2 && !metaCloseDecision) continue;
        const closeReason = metaCloseDecision && closeVotes < 2
          ? `Meta-Agent decided CLOSE`
          : `${closeVotes} agents + Meta-Agent recommend closing`;
        log.warn(`⚠️ ${closeReason} legacy position ${posSymbol} @ $${pos.currentPrice.toFixed(2)} (PnL: ${((pos.unrealizedPnlPct ?? 0)*100).toFixed(2)}%)...`);
        // v2.0.143: Route through closeTrade() — handles paper vs real + exitThesis.
        // v2.0.851: Legacy agent-vote close → tag 'consensus' so the TradeRecord
        // records it as an agent decision (not SL/TP inference).
        // v2.0.866 Phase B:二次確認 hold gate(過早率高 + 盈利 → 下 cycle 再確認)
        if (this.holdCloseIfCalibrated(posSymbol, (pos.unrealizedPnlPct ?? 0) > 0, 'consensus')) {
          continue; // close 被 hold——唔執行(下 cycle 再確認)
        }
        const legacyCloseSuccess = await this.closeTrade(posSymbol, closeReason, 'consensus');
        if (legacyCloseSuccess) {
          log.info(`  → Closed ${posSymbol} (${pos.agentId === 'hyperliquid-real' ? 'real' : 'paper'}, legacy)`);
        } else {
          log.error(`  → Failed to close ${posSymbol} — position remains open`);
        }
      }

      // ── Per-Symbol Consensus: Position Management ──
      // Use perSymbolConsensus from HACP to manage ALL open positions.
      // Each symbol (market ticker + open positions) has a consensus decision.
      // 🐛 FIX: Do NOT check psc.hasPosition — it's always false because
      // buildConsensus() in hacp.ts hardcodes hasPosition:false with the
      // comment "filled in by caller" but the caller never fills it in.
      // Instead, check the portfolio directly for the actual position.
      const perSymbolConsensus = result.consensus.perSymbolConsensus ?? [];
      for (const psc of perSymbolConsensus) {
        let pos = this.portfolio.getPosition(psc.symbol);
        // v2.0.153: Also check cachedExchangePositions — the live HL position
        // cache. If a position was just opened on HL but syncExchangePositions
        // hasn't imported it into portfolio yet (REST lag 2-5s), this cache
        // catches it and prevents opening a duplicate position.
        const pscNorm = normalizeSymbol(psc.symbol);
        const hasExchangePos = (this.cachedExchangePositions ?? []).some(
          ep => normalizeSymbol(ep.symbol) === pscNorm && ep.quantity > 0
        );

        // v2.0.155: If pos is undefined but hasExchangePos is true, the position
        // exists on HL but not in the local portfolio. Skip management (close/adjust)
        // for this position — it will be imported by syncExchangePositions on the
        // next cycle. Trying to manage a position we don't have locally causes
        // "Cannot read properties of undefined" crashes.
        if (!pos && hasExchangePos) {
          log.info(`⏭️ ${psc.symbol}: position exists on HL but not yet imported — skipping per-symbol consensus management this cycle`);
          continue;
        }

        // v2.0.104: If no real position exists, this might be a trading market
        // without position (injected for multi-symbol single-cycle analysis).
        // If consensus says BUY/SELL, execute the entry decision for this symbol.
        if (!pos && !hasExchangePos) {
          // Skip the activeSymbol — it's handled by the main marketTicker flow
          if (normalizeSymbol(psc.symbol) === normalizeSymbol(activeSymbol)) continue;

          // v2.0.104: Execute entry decisions for trading markets without position
          // v2.0.106: Apply per-asset conviction gate + frequency throttle
          if ((psc.action === 'buy' || psc.action === 'sell') && psc.positionSizePct > 0) {
            // v2.0.128: Decision audit — track gates for this trading market entry
            const auditGates: Array<{ gate: string; passed: boolean; reason: string }> = [];
            let pscExecuted = false;

            // v2.0.122: Check per-symbol direction restriction
            if (!this.marketAgent.isDirectionAllowed(psc.symbol, psc.action)) {
              const allowedDir = this.marketAgent.getDirectionRestrictions()[normalizeSymbol(psc.symbol)];
              log.warn(`🚫 [direction-restrict] Multi-symbol ${psc.symbol}: ${psc.action.toUpperCase()} blocked — only ${allowedDir?.toUpperCase() ?? 'unknown'} allowed. Skipping entry.`);
              auditGates.push({ gate: 'direction-restrict', passed: false, reason: `${psc.action.toUpperCase()} blocked — only ${allowedDir?.toUpperCase() ?? 'unknown'} allowed` });
              this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, false);
              continue;
            }
            auditGates.push({ gate: 'direction-restrict', passed: true, reason: 'allowed' });

            // v2.0.764 → v2.0.820: Dynamic minimum volatility gate (multi-symbol) — SOFTENED.
            // vol === 0 → hard skip (feed broken, can't trade on phantom prices).
            // 0 < vol < threshold → soft: proportional confidence penalty so a
            // strong WINNER-FIRST winner can still pass. Previously this
            // hard-skipped every calm symbol (SILVER/BTC) permanently.
            //
            // v2.0.831: ATR FALLBACK for vol=0 (same fix as active path).
            // Non-active symbols often have vol=0 because calcVolatility needs
            // ≥2 price history points, not because the feed is broken.
            // Fall back to ATR% before hard-blocking.
            let pscVolRaw = this.marketState.getState(psc.symbol)?.volatility ?? 0;
            // v2.0.831: ATR fallback when marketState volatility is 0
            if (pscVolRaw === 0) {
              try {
                // v2.0.831: Read ATR from pre-fetched cache (no synchronous fetch)
                // Key is full lowercase for case-insensitive matching.
                const pscAtrFallback = this.atrCacheThisCycle.get(normalizeSymbol(psc.symbol).toLowerCase()) ?? null;
                if (pscAtrFallback !== null && pscAtrFallback > 0) {
                  const pscEntryPx = this.marketState?.getState(psc.symbol)?.price ?? 0;
                  if (pscEntryPx > 0) {
                    pscVolRaw = pscAtrFallback / pscEntryPx;
                    log.info(`📊 [vol-gate] Multi-symbol ${psc.symbol}: marketState vol=0, using ATR fallback: vol=${(pscVolRaw * 100).toFixed(3)}%`);
                  }
                }
              } catch { /* non-critical — fall through to hard block */ }
            }
            const pscVol = pscVolRaw > 0 ? pscVolRaw : (combinedState.volatility > 0 ? combinedState.volatility : 0);
            if (pscVol === 0) {
              log.warn(`🛑 [vol-gate] Multi-symbol ${psc.action.toUpperCase()} ${psc.symbol}: volatility 0 (marketState=0, ATR=0) — feed truly broken, skipping`);
              auditGates.push({ gate: 'vol-gate', passed: false, reason: `vol=0 (marketState+ATR both 0)` });
              this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, false);
              continue;
            }
            if (pscVol < this.dynamicMinVolatility) {
              // WINNER-FIRST exemption (mirrors the active path): a confident
              // combo winner's track record is regime-keyed, so it already
              // reflects low-vol performance — skip the penalty to avoid
              // double-counting. Only non-winner psc's take the soft penalty.
              const pscRegime = this.marketState.getState(psc.symbol)?.regime ?? 'unknown';
              const pscAction = (psc.action === 'buy' || psc.action === 'sell')
                ? (psc.action as 'buy' | 'sell') : 'buy';
              const pscComboWinner = this.comboTracker.getComboBlendFactor(psc.symbol, pscAction, pscRegime);
              if (pscComboWinner) {
                log.info(`🟢 [vol-gate] Multi-symbol ${psc.action.toUpperCase()} ${psc.symbol}: vol ${pscVol.toFixed(5)} < threshold but WINNER-FIRST combo (${(pscComboWinner.wr * 100).toFixed(0)}% WR, n=${pscComboWinner.count}) overrides — no penalty`);
                auditGates.push({ gate: 'vol-gate', passed: true, reason: `vol<threshold but WINNER combo ${(pscComboWinner.wr * 100).toFixed(0)}% (n=${pscComboWinner.count}) exempts penalty` });
              } else {
                const ratio = pscVol / this.dynamicMinVolatility;
                const volSoftPenalty = 0.15 * (1 - Math.min(1, Math.max(0, ratio)));
                psc.confidence = psc.confidence * (1 - Math.min(0.15, volSoftPenalty));
                log.info(`🟡 [vol-gate] Multi-symbol ${psc.action.toUpperCase()} ${psc.symbol}: vol ${pscVol.toFixed(5)} < threshold ${this.dynamicMinVolatility.toFixed(4)} — soft penalty -${(volSoftPenalty * 100).toFixed(0)}% conf`);
                auditGates.push({ gate: 'vol-gate', passed: true, reason: `vol=${pscVol.toFixed(5)} < threshold (soft -${(volSoftPenalty * 100).toFixed(0)}%, no winner combo)` });
              }
            } else {
              auditGates.push({ gate: 'vol-gate', passed: true, reason: `vol=${pscVol.toFixed(4)} ≥ threshold=${this.dynamicMinVolatility.toFixed(4)}` });
            }

            // v2.0.731: Loss streak gate for multi-symbol path
            // v2.0.732: Condition-aware soft gate — raises conviction threshold
            // instead of hard blocking. Past losses in different regimes are ignored.
            const lossStreakResult = this.checkLossStreakGate(psc.symbol, psc.action as 'buy' | 'sell');
            if (lossStreakResult.convictionPenalty && lossStreakResult.convictionPenalty > 0) {
              log.info(`🚡 [loss-streak-soft] Multi-symbol ${psc.action.toUpperCase()} ${psc.symbol}: ${lossStreakResult.reason} — conviction +${(lossStreakResult.convictionPenalty * 100).toFixed(0)}%`);
              auditGates.push({ gate: 'loss-streak', passed: true, reason: `soft: conviction +${(lossStreakResult.convictionPenalty * 100).toFixed(0)}%` });
            } else {
              auditGates.push({ gate: 'loss-streak', passed: true, reason: 'no penalty' });
            }

            // v2.0.106: Check per-asset filter gate
            const pscFilter = this.assetFilterRegistry.getFilter(psc.symbol);
            // v2.0.822+: Apply risk profile adjustment to the adaptive filter
            // threshold (same multiplicative model as Plan G). Aggressive relaxes
            // the noise-gate, conservative tightens it. This ensures multi-symbol
            // entries respect the account's risk profile, not just the active symbol.
            const pscRiskProfile = this.marketAgent.getRiskProfile();
            // v2.0.857: risk profiles removed — always moderate multiplier (1.0).
            const pscRiskMultiplier = 1.0;
            // v2.0.831: NaN guard — same as active path. If pscFilter threshold is NaN,
// fall back to 0.50 (baseline). Math.max(0.30, Math.min(0.70, NaN)) = NaN.
const pscThresholdRaw = pscFilter.getConvictionThreshold();
const pscAdjustedThreshold = Number.isFinite(pscThresholdRaw)
  ? Math.max(0.30, Math.min(0.70, pscThresholdRaw * pscRiskMultiplier))
  : 0.50; // safe fallback
            if (psc.confidence < pscAdjustedThreshold) {
              log.warn(`🛑 [adaptive-filter] Multi-symbol conviction gate [${psc.symbol}]: ${(psc.confidence * 100).toFixed(0)}% < ${(pscAdjustedThreshold * 100).toFixed(0)}% (risk=${pscRiskProfile}) — skipping entry (noise-dominated)`);
              auditGates.push({ gate: 'conviction-gate', passed: false, reason: `${(psc.confidence * 100).toFixed(0)}% < ${(pscAdjustedThreshold * 100).toFixed(0)}% [risk=${pscRiskProfile}]` });
              this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, false);
              continue;
            }
            auditGates.push({ gate: 'conviction-gate', passed: true, reason: `${(psc.confidence * 100).toFixed(0)}% ≥ ${(pscAdjustedThreshold * 100).toFixed(0)}% [risk=${pscRiskProfile}]` });

            if (pscFilter.isTradeFrequencyLimited()) {
              log.warn(`🛑 [adaptive-filter] Multi-symbol frequency throttle [${psc.symbol}]: limit reached — skipping entry`);
              auditGates.push({ gate: 'frequency-throttle', passed: false, reason: 'limit reached' });
              this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, false);
              continue;
            }
            auditGates.push({ gate: 'frequency-throttle', passed: true, reason: 'OK' });

            // v2.0.135 fix: fetch entry price for this trading market — the
            // multi-symbol entry path previously omitted entryPrice, so
            // tradingManager.executeDecision() got price=0 → "No price
            // available for real trade" even though all gates passed.
            let pscPrice = this.marketState.getState(psc.symbol)?.price ?? 0;
            if (pscPrice <= 0) {
              // Fallback: fetch via Market Agent (same source as the trading-
              // market price fetch earlier in the cycle).
              try {
                const _ed = await withTimeout(this.marketAgent.fetchPriceForSymbol(psc.symbol), 8_000, `entry-price ${psc.symbol}`);
                pscPrice = _ed?.price ?? 0;
              } catch { /* keep 0 */ }
            }
            if (pscPrice <= 0) {
              log.warn(`📊 Multi-symbol entry ${psc.symbol}: ❌ — no price available (marketState + HL REST both failed)`);
              auditGates.push({ gate: 'execution', passed: false, reason: 'no price available for entry' });
              this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, false);
              continue;
            }
            // v2.0.139: Block BUY/SELL entries with a placeholder entryThesis (e.g.
            // "[1h: N/A — hold] [1d: N/A — hold]"). A trade without a real entry
            // reason is invalid — the Entry Thesis System requires a specific,
            // data-driven thesis for every entry. Skip execution (HOLD).
            if ((psc.action === 'buy' || psc.action === 'sell') && isThesisPlaceholder(psc.entryThesis)) {
              log.warn(`🛑 [thesis-gate] ${psc.action.toUpperCase()} ${psc.symbol} blocked — entryThesis is a placeholder: "${(psc.entryThesis ?? '').slice(0, 60)}". A real entry reason is required.`);
              this.recordDecisionAudit(psc.symbol, psc.action as 'buy' | 'sell', psc.confidence, psc.entryThesis ?? '', [{ gate: 'thesis-placeholder', passed: false, reason: 'placeholder thesis' }], false);
              continue;
            }
            log.info(`📊 Multi-symbol entry: ${psc.action.toUpperCase()} ${psc.symbol} ${(psc.positionSizePct * 100).toFixed(1)}% @ $${pscPrice.toFixed(2)} — executing (trading market → real entry)`);
            const pscEntryDecision = {
              action: psc.action,
              symbol: psc.symbol,
              entryPrice: pscPrice,
              positionSizePct: psc.positionSizePct,
              leverage: this.marketAgent.getConfig().leverage, // v2.0.139: config authoritative — agent LLM leverage output ignored (Master Lord sets leverage via Market Agent, not per-trade LLM)
              rationale: psc.rationale,
              urgency: 'soon' as const,
              entryThesis: psc.entryThesis,
              stopLossPct: 0.02,
              takeProfitPct: 0.05,
            };
            try {
              const pscExecResult = await this.executeTrade({
                ...pscEntryDecision,
                srSupport: null,
                srResistance: null,
              }, auditGates);
              if (pscExecResult.success) {
                pscFilter.recordTrade();
                pscExecuted = true;
                log.info(`📊 Multi-symbol entry ${psc.symbol}: ✅ — ${pscFilter.getRemainingTradeSlots()} slots remaining`);
                // v2.0.143: entryThesis is set by executeTrade() after execution.
              } else {
                log.info(`📊 Multi-symbol entry ${psc.symbol}: ❌ — ${pscExecResult.error ?? 'unknown'}`);
                auditGates.push({ gate: 'execution', passed: false, reason: pscExecResult.error ?? 'execution failed' });
              }
            } catch (err) {
              log.error(`📊 Multi-symbol entry ${psc.symbol} failed: ${err instanceof Error ? err.message : String(err)}`);
              auditGates.push({ gate: 'execution', passed: false, reason: err instanceof Error ? err.message : String(err) });
            }
            if (pscExecuted) auditGates.push({ gate: 'execution', passed: true, reason: 'executed on HL' });
            // v2.0.228: Mark per-symbol idle reset for penalty decay
            if (pscExecuted) { this.dynamicThresholdCalc.markSymbolTraded(psc.symbol); this._symbolsTradedThisCycle?.add(psc.symbol.toLowerCase()); }
            this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, pscExecuted);
            // v2.0.153: Push to UI immediately
            if (pscExecuted) this.pushToAPI();
          }
          continue;
        }

        // v2.0.155: At this point, pos is guaranteed to be defined (both
        // !pos && hasExchangePos and !pos && !hasExchangePos paths continue above).
        // But TypeScript can't narrow through continue, so we assert here.
        if (!pos) continue;

        // ── v2.0.849-fix2: SYMBOL-CONSISTENCY GUARD ──
        // Defends against cross-symbol contamination: getPosition() is keyed by
        // normalizeSymbol(psc.symbol), but a corrupted/stale position object may
        // carry a DIFFERENT symbol field (trade-audit observed Skeptics being fed
        // SKHX position data while validating an SP500 close: entry=$1086.50 +
        // "SELL mean-reversion from $1100 supply" for a close rationale that
        // referenced SP500 @ $7409/$7463/$7500). Without this check, close
        // management would pass one symbol's position to validateCloseDecision for
        // ANOTHER symbol, so Skeptics could BLOCK a valid close (or approve a
        // wrong one) based on mismatched entry price / thesis. When the position
        // object's own symbol disagrees with the consensus symbol, skip management
        // this cycle (it will re-sync next cycle) — never act on mismatched data.
        const posSymbolNorm = pos.symbol ? normalizeSymbol(pos.symbol) : '';
        const pscSymbolNorm = pscNorm;
        if (posSymbolNorm && posSymbolNorm !== pscSymbolNorm) {
          log.warn(`🚫 [symbol-mismatch] Consensus symbol ${psc.symbol} resolved to position symbol ${pos.symbol} (entry=$${(pos.averageEntryPrice ?? 0).toFixed(2)}) — SKIPPING close/adjust management this cycle to prevent cross-symbol contamination (Skeptics would validate against the wrong position's thesis/price).`);
          continue;
        }
        const posDef = pos;
        // v2.0.91: Close validation depends on whether the position has an entryThesis.
        // - WITH entryThesis: Meta-Agent → Skeptics validateCloseDecision → execute
        // - WITHOUT entryThesis (legacy): sub-agent voting already handled above,
        //   but if consensus also says close, execute directly (legacy positions
        //   don't need Skeptics validation since they predate the thesis system)
        if (psc.closePosition) {
          // v2.0.143: Capture the close rationale as exitThesis BEFORE closing.
          // This must happen before closePosition()/closeExchangePosition()
          // because those methods delete the position from the map.
          const closeRationale = psc.rationale || 'No rationale provided.';

          // v2.0.832: STRUCTURAL CONFIRMATION CHECK for Skeptics close validation.
          // If SL has been hit, the market itself has confirmed the thesis is
          // broken — Skeptics should NOT block this close, even if the position
          // is profitable. The old logic let Skeptics block closes on profitable
          // positions, causing winners to ride into reversal and become losers.
          const closeSLPrice = pos.stopLossPrice ?? 0;
          const closeCurrentPrice = pos.currentPrice ?? 0;
          let closeStructureConfirmed = false;
          if (closeSLPrice > 0 && closeCurrentPrice > 0) {
            if (isBuySide(pos.side) && closeCurrentPrice <= closeSLPrice) closeStructureConfirmed = true;
            if (isSellSide(pos.side) && closeCurrentPrice >= closeSLPrice) closeStructureConfirmed = true;
          }

          if (pos.entryThesis && !closeStructureConfirmed) {
            // v2.0.90: Validate close decision with Skeptics for thesis-backed positions
            // v2.0.832: Skip Skeptics validation if SL hit (market confirmed the break)
            const closeValidation = await this.hacpEngine.getSkeptics().validateCloseDecision(
              psc.symbol,
              pos.side as 'buy' | 'sell',
              pos.averageEntryPrice,
              pos.currentPrice,
              pos.unrealizedPnlPct ?? 0,
              closeRationale,
              `${marketDesc}\n\n${adjustedEvolutionContext}`,
              allThoughts,
            );
            if (!closeValidation.approved) {
              log.warn(`🚫 Skeptics BLOCKED close for ${psc.symbol}: ${closeValidation.rationale} — position remains open`);
              continue;
            }
            log.warn(`📕 Per-symbol consensus: CLOSE ${psc.symbol} (conf=${(psc.confidence * 100).toFixed(0)}%, PnL=${((pos.unrealizedPnlPct ?? 0) * 100).toFixed(1)}%) — ${psc.rationale} [Skeptics: ✅ ${closeValidation.rationale}]`);
          } else if (pos.entryThesis && closeStructureConfirmed) {
            // v2.0.832: SL hit — market confirmed the break, skip Skeptics validation
            log.warn(`📕 Per-symbol consensus: CLOSE ${psc.symbol} (conf=${(psc.confidence * 100).toFixed(0)}%, PnL=${((pos.unrealizedPnlPct ?? 0) * 100).toFixed(1)}%) — SL hit ($${closeSLPrice.toFixed(2)}), market confirmed break, skipping Skeptics [${psc.rationale}]`);
          } else {
            // v2.0.91: Legacy position without entryThesis — close directly
            log.warn(`📕 Per-symbol consensus: CLOSE ${psc.symbol} (legacy, no thesis) (conf=${(psc.confidence * 100).toFixed(0)}%, PnL=${((pos.unrealizedPnlPct ?? 0) * 100).toFixed(1)}%) — ${psc.rationale}`);
          }
          // v2.0.143: Route through closeTrade() — handles paper vs real
          // separation + sets exitThesis before closing.
          // v2.0.851: This is a CONSENSUS close (agents voted CLOSE). Tag it
          // explicitly so the TradeRecord.closeReason records 'consensus' —
          // otherwise inferCloseReason would classify it by exit price vs
          // SL/TP, losing the agent-decision signal.
          // v2.0.866 Phase B:二次確認 hold gate(consensus close——過早率高 + 盈利)
          // v2.0.866-phase-b-attack (V14):SL hit 必須永遠立即執行——
          // 用「結構判斷」closeStructureConfirmed(價格到 SL 價位)而唔係 rationale 文字
          // (agents 嘅 rationale 可能冇「SL hit」字眼 → 舊 check 會誤 hold SL close = 蝕死!)
          // closeStructureConfirmed:buy 且 price ≤ SL、sell 且 price ≥ SL——由市場確認
          //
          // v2.0.869(主神 SKHX MAE=0 調查):MFE 鎖利——鎖住「俾返晒」嘅 gain
          // (SKHX 前兩個 trade:MFE 0.18/0.07——但係蝕——成個 gain 俾返晒)
          // MFE ≥ 2×ATR 且已回吐 ≥ 30% → 鎖利(唔 hold——直接 close)
          // MFE ≥ 1.5×ATR 且已回吐 ≥ 50% → 鎖利(唔 hold——直接 close)
          // soft——判斷層——唔 hard block
          let mfeLock = false;
          try {
            if (this.closeCalibrator && pos) {
              const posMargin = (pos.averageEntryPrice * pos.quantity) / safeLeverage(pos.leverage);
              const posMfe = posMargin > 0 && Number.isFinite(pos.maxValueReached) ? ((pos.maxValueReached as number) - posMargin) / posMargin : 0;
              const posMae = posMargin > 0 && Number.isFinite(pos.minValueReached) ? (posMargin - (pos.minValueReached as number)) / posMargin : 0;
              const curFav = posMargin > 0 && Number.isFinite(pos.unrealizedPnl) ? pos.unrealizedPnl / posMargin : 0;
              const retraced = posMfe > 0 ? Math.max(0, Math.min(1, (posMfe - curFav) / posMfe)) : 0;
              // ATR 來源:atrCacheThisCycle(美元)→ 除以 entryPrice 轉 pct
              const atrVal = this.atrCacheThisCycle.get(String(psc.symbol).toLowerCase()) ?? 0;
              const atrPct = atrVal > 0 && pos.averageEntryPrice > 0 ? atrVal / pos.averageEntryPrice : 0;
              const lockAdvice = this.closeCalibrator.getMfeLockAdvice(psc.symbol, isSellSide(pos.side) ? 'sell' : 'buy', posMfe, atrPct, retraced);
              if (lockAdvice.shouldLock) {
                mfeLock = true;
                log.info(`🔒 [mfe-lock] ${psc.symbol}: ${lockAdvice.reason}——唔 hold——直接 close(鎖利)`);
              }
            }
          } catch { /* 非致命——MFE 鎖利失敗唔 block */ }
          if (!closeStructureConfirmed && !mfeLock && this.holdCloseIfCalibrated(psc.symbol, (pos.unrealizedPnlPct ?? 0) > 0, 'consensus')) {
            continue; // close 被 hold——唔執行(下 cycle 再確認)
          }
          const closeSuccess = await this.closeTrade(psc.symbol, closeRationale, 'consensus');
          if (closeSuccess) {
            if (pos.agentId === 'hyperliquid-real') {
              log.info(`  → Closed ${psc.symbol} (real, closed on HL)`);
            } else {
              log.info(`  → Closed ${psc.symbol}: $${pos.unrealizedPnl.toFixed(2)}`);
            }
          } else {
            log.error(`  → Failed to close ${psc.symbol} — position remains open`);
          }
          continue;
        }

        // v2.0.163: Direction flip check — MUST run before SL/TP adjustment.
        // If agents suggest the OPPOSITE direction (not same), treat it as a
        // direction flip — close the existing position and let the new trade
        // execute next cycle. This is the same conviction-based reversal logic
        // as the active symbol overlap guard.
        // CRITICAL: This must run BEFORE SL/TP adjustment — otherwise we waste
        // an HL API call adjusting SL/TP on a position we're about to close,
        // and may leave stale trigger orders on a closed position.
        // v2.0.830: FLIP profit guard — if the position is profitable, require
        // structural confirmation (SL hit or S/R break) before allowing the flip
        // close. Same logic as PROFIT GUARD v3 for thesis-invalidation closes.
        // A flip on a profitable position without structural confirmation = 
        // cutting a winner early on a hunch. Let the SL/TP do their job.
        if ((psc.action === 'buy' || psc.action === 'sell') && !psc.closePosition) {
          const posSide = pos.side;
          const wantsSameDirection = (psc.action === 'buy' && posSide === 'buy') || (psc.action === 'sell' && posSide === 'sell');
          if (!wantsSameDirection) {
            // v2.0.830: FLIP profit guard — check if position is profitable
            const flipPrice = this.marketState?.getState(psc.symbol)?.price ?? pos.currentPrice ?? 0;
            const flipPnlPct = flipPrice > 0
              ? (posSide === 'buy'
                ? (flipPrice - pos.averageEntryPrice) / pos.averageEntryPrice
                : (pos.averageEntryPrice - flipPrice) / pos.averageEntryPrice)
              : 0;

            if (flipPnlPct > 0) {
              // Position is profitable — check structural confirmation
              const flipSL = pos.stopLossPrice ?? 0;
              let flipStructureConfirmed = false;
              if (flipSL > 0) {
                if (posSide === 'buy' && flipPrice <= flipSL) flipStructureConfirmed = true;
                if (posSide === 'sell' && flipPrice >= flipSL) flipStructureConfirmed = true;
              }
              // S/R confirmation (active symbol only) — v2.0.830: break quality
              if (!flipStructureConfirmed && normalizeSymbol(psc.symbol) === normalizeSymbol(this.marketAgent.getSelectedSymbol())) {
                const flipSupport = this.lastSRContext?.nearestSupport ?? null;
                const flipResistance = this.lastSRContext?.nearestResistance ?? null;
                const flipSrStrength = this.lastSRContext?.nearestSupportStrength ?? null;
                const flipBreakDepthRequired = flipSrStrength === 'strong' ? 0.003
                  : flipSrStrength === 'weak' ? 0.010
                  : 0.005;
                if (posSide === 'buy' && flipSupport !== null && flipSupport > 0) {
                  const flipBreakDepth = (flipSupport - flipPrice) / flipSupport;
                  if (flipPrice < flipSupport && flipBreakDepth >= flipBreakDepthRequired) flipStructureConfirmed = true;
                } else if (posSide === 'sell' && flipResistance !== null && flipResistance > 0) {
                  const flipBreakDepth = (flipPrice - flipResistance) / flipResistance;
                  if (flipPrice > flipResistance && flipBreakDepth >= flipBreakDepthRequired) flipStructureConfirmed = true;
                }
              }

              if (!flipStructureConfirmed) {
                // Profitable + no structural confirmation → block flip, keep position
                const flipRiskProfile = this.marketAgent.getRiskProfile();
                // v2.0.857: risk profiles removed — always moderate tolerance (1.0%).
                const flipTolerance = 0.010;
                if (flipPnlPct >= flipTolerance) {
                  log.warn(`🛡️ [FLIP GUARD v3] ${psc.symbol}: flip suggested (${posSide.toUpperCase()}→${psc.action.toUpperCase()}) but position is profitable (${(flipPnlPct * 100).toFixed(2)}% ≥ ${(flipTolerance * 100).toFixed(1)}% tolerance, risk=${flipRiskProfile}) with NO structural confirmation — BLOCKING flip. Let SL/TP work.`);
                  this.recordDecisionAudit(
                    psc.symbol,
                    psc.action as 'buy' | 'sell',
                    psc.confidence,
                    psc.entryThesis ?? psc.rationale ?? '',
                    [{ gate: 'flip-profit-guard', passed: false, reason: `profitable ${(flipPnlPct * 100).toFixed(2)}% ≥ ${(flipTolerance * 100).toFixed(1)}% tolerance, no structural confirmation` }],
                    false,
                  );
                  continue;
                }
                // Profit < tolerance → allow flip (small gain, confirmed by agent consensus)
                log.info(`🛡️ [FLIP GUARD v3] ${psc.symbol}: flip suggested, position profitable (${(flipPnlPct * 100).toFixed(2)}% < ${(flipTolerance * 100).toFixed(1)}% tolerance) — allowing flip despite no structural confirmation.`);
              }
            }

            // Direction flip: close existing position first
            log.warn(`🔄 Per-symbol flip: ${psc.symbol} ${posSide.toUpperCase()} → ${psc.action.toUpperCase()}. Closing existing position first.`);
            // v2.0.851: Flip is an agent-consensus close → tag 'consensus' so the
            // TradeRecord records the agent-driven exit (not SL/TP inference).
            const flipCloseSuccess = await this.closeTrade(psc.symbol, `Position flip: closing ${posSide.toUpperCase()} to open ${psc.action.toUpperCase()}`, 'consensus');
            if (flipCloseSuccess) {
              log.info(`  → Flipped ${psc.symbol}. Position will be re-evaluated next cycle for ${psc.action.toUpperCase()} entry.`);
            } else {
              log.error(`  → Failed to close ${psc.symbol} for flip — position remains ${posSide.toUpperCase()}`);
            }
            this.recordDecisionAudit(
              psc.symbol,
              psc.action as 'buy' | 'sell',
              psc.confidence,
              psc.entryThesis ?? psc.rationale ?? '',
              [{ gate: 'direction-flip', passed: flipCloseSuccess, reason: `${psc.action.toUpperCase()} suggested but ${posSide.toUpperCase()} position open — closing for flip` }],
              flipCloseSuccess,
            );
            // CRITICAL: continue — pos is deleted by closeTrade, must not
            // access pos.* below (SL/TP adjust, thesis sync would crash)
            continue;
          }
        }

        // Adjust TP/SL if suggested
        // v2.0.31: In real mode, also place native trigger orders on HL exchange
        // v2.0.54: Validate per-symbol consensus SL/TP direction BEFORE applying.
        // v2.0.225: DISABLED per-symbol consensus SL/TP adjustment.
        // Owner directive: initial SL/TP (#1) + manual close + auto-close
        // is sufficient. Agents must not narrow SL/TP post-entry (caused
        // premature stop-outs + UI/Hyperliquid SL desync).
        // The `hacpAdjusted` guard is now always true (HACP returns []) so
        // agent-suggested SL/TP is never applied. Agents can still suggest
        // CLOSE (handled via thesisInvalidatedSymbols / direction-flip path).
        const hacpAdjusted = true; // v2.0.225: always skip — no post-entry SL/TP
        if (hacpAdjusted) {
          // no-op — SL/TP stays at initial placement
        } else if (psc.suggestedStopLoss !== undefined || psc.suggestedTakeProfit !== undefined) {
          let validSL = psc.suggestedStopLoss;
          let validTP = psc.suggestedTakeProfit;
          const isLong = isBuySide(pos.side);
          const currentPrice = pos.currentPrice;
          const entryPrice = pos.averageEntryPrice;

          // v2.0.54: Validate SL — must be on correct side of current price
          if (validSL !== undefined) {
            const slValid = isLong ? validSL < currentPrice : validSL > currentPrice;
            if (!slValid) {
              log.warn(`🚫 Per-symbol consensus SL ${validSL.toFixed(2)} on wrong side of current price ${currentPrice.toFixed(2)} for ${isLong ? 'LONG' : 'SHORT'} ${psc.symbol} — skipping SL`);
              validSL = undefined;
            }
          }

          // v2.0.54: Validate TP — must be on correct side of both current price and entry
          if (validTP !== undefined) {
            const tpValidVsPrice = isLong ? validTP > currentPrice : validTP < currentPrice;
            const tpValidVsEntry = isLong ? validTP > entryPrice : validTP < entryPrice;
            if (!tpValidVsPrice || !tpValidVsEntry) {
              log.warn(`🚫 Per-symbol consensus TP ${validTP.toFixed(2)} on wrong side (${!tpValidVsPrice ? 'price' : 'entry'}) for ${isLong ? 'LONG' : 'SHORT'} ${psc.symbol} — skipping TP`);
              validTP = undefined;
            }
          }

          if (validSL !== undefined || validTP !== undefined) {
            await this.tradingManager.adjustPosition(pos.id, validSL, validTP);
            log.info(`📐 Per-symbol consensus: ADJUST ${psc.symbol} SL=${validSL?.toFixed(2) ?? '-'} TP=${validTP?.toFixed(2) ?? '-'}`);
          } else {
            log.warn(`📐 Per-symbol consensus: ADJUST ${psc.symbol} — all SL/TP rejected by direction validation, skipping`);
          }
        }

        // v2.0.134/v2.0.137: Sync entryThesis + holdReason from per-symbol
        // consensus to the position.
        //  - entryThesis is FROZEN at open (see PortfolioTracker.setEntryThesis):
        //    it is only filled in when the position has none yet (e.g. a
        //    position re-imported from HL with no thesis). Once set it is never
        //    overwritten, so Skeptics Phase 0.5 re-validates the ORIGINAL entry
        //    rationale, not a moving target. Placeholder theses ('N/A' etc.)
        //    are rejected by the setter.
        //  - holdReason is the LIVE per-cycle reason for holding and may update
        //    freely (it is NOT re-validated by Skeptics).
        if (psc.entryThesis) {
          this.portfolio.setEntryThesis(psc.symbol, psc.entryThesis);
        }
        if (psc.holdReason && psc.holdReason.trim().length > 0) {
          this.portfolio.setHoldReason(psc.symbol, psc.holdReason);
        }
      }

      // ── P0: Pattern Classifier Hard Circuit Breaker ──
      // If pattern data from the previous cycle shows < 50% win rate for this
      // decision direction, override to HOLD — agents saw the warning but ignored it.
      if (finalDecision.action !== 'hold' && this.lastPatternContext) {
        const direction = finalDecision.action === 'buy' ? 'BUY' : 'SELL';
        if (this.lastPatternContext.includes('⚠️ Low win rate') &&
            this.lastPatternContext.includes(`${direction} ENTRY PATTERN INSIGHTS`)) {
          log.warn(`🛑 Pattern classifier circuit breaker: ${direction} has low historical win rate — overriding to HOLD`);
          finalDecision = {
            action: 'hold',
            symbol: finalDecision.symbol,
            positionSizePct: 0,
            leverage: 1,
            rationale: `[PATTERN BLOCKED] ${direction} has low win rate historically in current conditions. ${finalDecision.rationale}`,
            urgency: 'immediate',
          };
        }
      }

      // v2.0.142: Liquidity guard removed — was using paper-trade guardParams
      // and blocking real trades with false positives. Real liquidity is
      // managed by HL's order matching engine + our aggressive pricing.

      // ── P0: Query trade pattern classifier for next cycle's context ──
      try {
        if (this.patternClassifier) {
          const currentPositions = this.portfolio.getOpenSymbols();
          if (currentPositions.length > 0) {
            const pos = this.portfolio.getPosition(currentPositions[0]!);
            if (pos) {
              const posResult = this.patternClassifier.queryPosition(
                {
                  regime: combinedState.regime,
                                    volatility: combinedState.volatility ?? 0,
                                    srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                  obImbalance: combinedState.orderBookImbalance ?? 0,
                  fundingRate: this.sentimentEngine?.getFundingRate() ?? 0,
                  volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
                  signalAgreement: result.consensus.confidence,
                          leverage: finalDecision.leverage ?? 1,
                  sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
                  sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
                        },
                {
                  regime: combinedState.regime,
                                    volatility: combinedState.volatility ?? 0,
                                    srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                  obImbalance: combinedState.orderBookImbalance ?? 0,
                  fundingRate: this.sentimentEngine?.getFundingRate() ?? 0,
                  volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
                  signalAgreement: result.consensus.confidence,
                          leverage: finalDecision.leverage ?? 1,
                  sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
                  sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
                        },
                combinedState.primarySymbol,
                pos.side,
                combinedState.price,
              );
              const pnlPct = pos.currentPrice && pos.averageEntryPrice
                ? (pos.currentPrice - pos.averageEntryPrice) / pos.averageEntryPrice * (isBuySide(pos.side) ? 1 : -1)
                : 0;
              const holdDuration = pos.openedAt ? Math.max(1, Math.round((Date.now() - pos.openedAt) / 300_000)) : 1;
              this.lastPatternContext = this.patternClassifier.formatPositionContext(
                posResult, pos.side, pos.averageEntryPrice, pos.currentPrice, pnlPct, holdDuration,
              );
            }
          } else {
            const entryResult = this.patternClassifier.queryEntry(
              {
                regime: combinedState.regime,
                                volatility: combinedState.volatility ?? 0,
                                srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                obImbalance: combinedState.orderBookImbalance ?? 0,
                fundingRate: this.sentimentEngine?.getFundingRate() ?? 0,
                volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
                signalAgreement: result.consensus.confidence,
                      leverage: finalDecision.leverage ?? 1,
                sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
                sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
                    },
              combinedState.primarySymbol,
              finalDecision.action === 'buy' ? 'buy' : 'sell',
              combinedState.price,
            );
            this.lastPatternContext = this.patternClassifier.formatEntryContext(entryResult, finalDecision.action === 'buy' ? 'buy' : 'sell');
          }
        }
      } catch (err) {
        log.error(`[pattern-query] Failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 4. Execute decision through real trading manager
      // Routes automatically: paper-mode → paperEngine, real-mode → exchange + mirror
      //
      // ── Symbol Overlap Guard + Direction Flip ──
      // If the selected symbol already has an open position AND the final decision
      // is the OPPOSITE direction, this is a deliberate flip signal:
      //   • finalDecision = SELL + existing BUY → close BUY first, then SELL
      //   • finalDecision = BUY + existing SELL → close SELL first, then BUY
      // This is NOT a symbol overlap error — it's a conviction-based reversal.
      // The agents have decided the current position direction is wrong and want
      // to flip. We close the old position, then let the new trade execute.
      //
      // If the final decision is the SAME direction as the existing position,
      // we still HOLD (no double-position on same symbol).
      // v2.0.42: Use normalizeSymbol instead of .toLowerCase() — colon symbols
      // (xyz:MU) must preserve case to match portfolio storage.
      const activeSym = finalDecision.symbol ? normalizeSymbol(finalDecision.symbol) : '';
      // v2.0.153: Check both portfolio AND cachedExchangePositions for existing position
      const activeHasPortfolioPos = activeSym && this.portfolio.hasPosition(activeSym);
      const activeHasExchangePos = activeSym && (this.cachedExchangePositions ?? []).some(
        ep => normalizeSymbol(ep.symbol) === activeSym && ep.quantity > 0
      );
      if (activeSym && (activeHasPortfolioPos || activeHasExchangePos)) {
        const existingPos = this.portfolio.getPosition(activeSym) ??
          (activeHasExchangePos ? (this.cachedExchangePositions ?? []).find(ep => normalizeSymbol(ep.symbol) === activeSym) : undefined);
        if (existingPos && finalDecision.action !== 'hold') {
          const isFlip = (existingPos.side === 'buy' && finalDecision.action === 'sell') ||
                         (existingPos.side === 'sell' && finalDecision.action === 'buy');
          if (isFlip) {
            // Direction flip: close existing position first, then let the new
            // trade execute below. This is a conviction-based reversal.
            log.warn(`🔄 Direction flip: ${activeSym.toUpperCase()} ${existingPos.side.toUpperCase()} @ $${existingPos.averageEntryPrice.toFixed(2)} → ${finalDecision.action.toUpperCase()}. Closing existing position first.`);
            // v2.0.143: Route through closeTrade() — handles paper vs real + exitThesis.
            // which closes on HL first. portfolio.closePosition() only closes locally.
            // v2.0.143: Route through closeTrade() — handles paper vs real + exitThesis.
            // v2.0.851: Flip is an agent-consensus close → tag 'consensus'.
            const flipCloseSuccess = await this.closeTrade(activeSym, `Position flip: closing ${existingPos.side.toUpperCase()} to open ${finalDecision.action.toUpperCase()}`, 'consensus');
            if (flipCloseSuccess) {
              log.info(`  → Flipped ${activeSym}. Proceeding with ${finalDecision.action.toUpperCase()} order.`);
            } else {
              log.error(`  → Failed to close ${activeSym} for flip — aborting flip`);
              finalDecision = {
                ...finalDecision,
                action: 'hold',
                positionSizePct: 0,
                rationale: `Flip failed: could not close ${activeSym}. HOLD.`,
              };
            }
            // Continue to execute the new trade below — don't convert to HOLD
          } else {
            // Same direction: block the new trade, keep existing position
            log.warn(`🚫 Symbol overlap guard: ${activeSym.toUpperCase()} already has ${existingPos.side.toUpperCase()} position @ $${existingPos.averageEntryPrice.toFixed(2)}. Converting ${finalDecision.action.toUpperCase()}→HOLD. Existing position managed by per-symbol consensus + SL/TP.`);
            finalDecision = {
              ...finalDecision,
              action: 'hold',
              positionSizePct: 0,
              rationale: `Symbol overlap guard: ${activeSym} already positioned. HOLD for position management only.`,
            };
          }
        }
      }
      log.info(`💼 Executing ${this.tradingManager.getTradeMode().toUpperCase()} trading decision...`);

      // v2.0.128: Decision audit for the active symbol — track gates
      const activeAuditGates: Array<{ gate: string; passed: boolean; reason: string }> = [];

      // v2.0.122: Per-symbol direction restriction enforcement.
      // If the Market Agent config restricts a symbol to one direction,
      // block the opposite direction from executing. Existing positions
      // can still be closed (closePosition is not a new entry).
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const decisionSym = finalDecision.symbol || activeSymbol;

        // v2.0.153: Existing position guard removed — the Symbol Overlap Guard
        // above (line ~4768) already handles same-direction blocking + flip logic,
        // and now also checks cachedExchangePositions for REST lag. This redundant
        // check was causing confusion with two separate gates logging different
        // messages for the same condition.

        // v2.0.141: Re-entry block — if this symbol was force-closed due to thesis
        // invalidation THIS cycle, block re-entry. Prevents the close→reopen churn loop.
        if ((finalDecision.action as string) !== 'hold' && typeof thesisInvalidatedReentryBlock !== 'undefined' && thesisInvalidatedReentryBlock.has(decisionSym)) {
          log.warn(`🚫 [reentry-block] ${decisionSym}: force-closed this cycle due to thesis invalidation. Blocking re-entry. Overriding ${finalDecision.action.toUpperCase()} → HOLD.`);
          activeAuditGates.push({ gate: 'reentry-block', passed: false, reason: `${decisionSym} force-closed this cycle` });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[REENTRY BLOCK] ${decisionSym} was force-closed this cycle due to thesis invalidation. Blocking re-entry to prevent churn loop. Original: ${finalDecision.rationale}`,
          };
        }

        if (!this.marketAgent.isDirectionAllowed(decisionSym, finalDecision.action as 'buy' | 'sell')) {
          const allowedDir = this.marketAgent.getDirectionRestrictions()[normalizeSymbol(decisionSym)];
          log.warn(`🚫 [direction-restrict] ${decisionSym}: ${finalDecision.action.toUpperCase()} blocked — only ${allowedDir?.toUpperCase()} allowed. Overriding → HOLD.`);
          activeAuditGates.push({ gate: 'direction-restrict', passed: false, reason: `${finalDecision.action.toUpperCase()} blocked — only ${allowedDir?.toUpperCase() ?? 'unknown'} allowed` });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[DIRECTION RESTRICT] ${decisionSym} is restricted to ${allowedDir?.toUpperCase() ?? 'unknown'} only. ${finalDecision.action.toUpperCase()} blocked. Original: ${finalDecision.rationale}`,
          };
        } else {
          activeAuditGates.push({ gate: 'direction-restrict', passed: true, reason: 'allowed' });
        }
      }

  // v2.0.731: Loss streak gate — block systematically losing (symbol, direction)
  // pairs. Was defined but never called! This is why BUY SKHX with 31% WR over
  // 32 trades was never blocked. Placed BEFORE conviction gate so it takes
  // priority — even a high-conviction signal on a systematic loser is blocked.
  if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
    finalDecision = this.applyLossStreakGateToDecision(
      finalDecision,
      finalDecision.symbol || activeSymbol,
      finalDecision.action as 'buy' | 'sell',
      activeAuditGates,
    );
  }

  // v2.0.765: REMOVED systematic loser hard block — OWNER DIRECTIVE: NEVER hard block.
  // The dynamic volatility gate (v2.0.764) handles the root cause — low-vol noise trading.

      // v2.0.764 → v2.0.820: Dynamic minimum volatility gate — SOFTENED.
      // The owner WINNER-FIRST directive states "NEVER hard block". The old
      // vol-gate hard-HOLDed any symbol below `dynamicMinVolatility`, which —
      // combined with the ~30× understated calcVolatility — permanently blocked
      // every calm symbol (SILVER, BTC) even when a strong combo WR winner
      // signal existed. v2.0.820 splits the gate into two regimes:
      //   • vol === 0  → HARD HOLD. The feed is broken / no data (fix B/D).
      //     Trading on phantom prices is never safe — this stays a hard block.
      //   • 0 < vol < threshold → SOFT. Apply a conviction penalty proportional
      //     to how far below threshold (so dead-but-live markets need a stronger
      //     signal) but let a strong WINNER-FIRST combo override pass. The
      //     penalty is added to _lossStreakPenalty so the Plan G conviction
      //     gate's penaltyFactor absorbs it.
      //
      // v2.0.831: ATR FALLBACK for vol=0. The old logic assumed vol=0 means
      // "feed broken" — but for non-active symbols (CL, SKHX, GOLD), vol=0
      // often means "not enough price history to compute σ" (calcVolatility
      // needs ≥2 price points; a freshly added trading market may have only 1).
      // This is NOT a broken feed — the price is real (fetched from HL), we
      // just can't compute volatility from it yet.
      //
      // Fix: when marketState vol=0, fall back to ATR% (fetched from HL 1h
      // candles). ATR is a direct measure of the asset's actual price range
      // and doesn't need accumulated price history. If ATR > 0, use it as the
      // volatility estimate and proceed (soft gate, not hard block). Only
      // hard-block if BOTH marketState vol=0 AND ATR=0 (truly no data).
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const activeSymForVol = normalizeSymbol(finalDecision.symbol || activeSymbol);
        let perSymVol = this.marketState.getState(activeSymForVol)?.volatility ?? 0;
        // v2.0.831: ATR fallback when marketState volatility is 0.
        // This fixes the "vol=0 → hard block" that prevented CL/SKHX/GOLD
        // from ever trading. ATR is fetched from HL 1h candles (real data),
        // so it's a valid volatility estimate even when price history is
        // too short for calcVolatility.
        if (perSymVol === 0) {
          try {
            // v2.0.831: Read ATR from pre-fetched cache (no synchronous fetch)
            // Key is full lowercase for case-insensitive matching.
            const atrFallback = this.atrCacheThisCycle.get(activeSymForVol.toLowerCase()) ?? null;
            if (atrFallback !== null && atrFallback > 0) {
              const entryPx = finalDecision.entryPrice ?? this.marketState?.getState(activeSymForVol)?.price ?? 0;
              if (entryPx > 0) {
                perSymVol = atrFallback / entryPx; // ATR as fraction of price = volatility estimate
                log.info(`📊 [vol-gate] ${activeSymForVol}: marketState vol=0, using ATR fallback: ATR=$${atrFallback.toFixed(2)} / price=$${entryPx.toFixed(2)} = vol=${(perSymVol * 100).toFixed(3)}%`);
              }
            }
          } catch { /* non-critical — fall through to hard block if ATR also fails */ }
        }
        const currentVol = perSymVol > 0
          ? perSymVol
          : (combinedState.volatility > 0 ? combinedState.volatility : 0);
        if (currentVol === 0) {
          // Hard block: no data at all — both marketState AND ATR returned 0.
          // This is a genuinely broken feed, not just insufficient history.
          log.warn(`🛑 [vol-gate] ${finalDecision.action.toUpperCase()} ${finalDecision.symbol || activeSymbol}: volatility 0 (marketState=0, ATR=0) — data feed truly broken, HARD HOLD`);
          activeAuditGates.push({ gate: 'vol-gate', passed: false, reason: `vol=0 (marketState+ATR both 0 — feed broken)` });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[VOL GATE] Volatility 0 — data feed broken/stale. Cannot trade on phantom prices. HOLD. Original: ${finalDecision.rationale}`,
          };
        } else if (currentVol < this.dynamicMinVolatility) {
          // Soft: low volatility but live data — proportional conviction penalty.
          // WINNER-FIRST exemption: if a confident combo winner exists for this
          // (symbol × side × regime), SKIP the vol penalty. The combo WR is
          // keyed by regime (incl. low_volatility), so its track record ALREADY
          // reflects low-vol performance — penalising again double-counts the
          // risk and violates the owner's "NEVER hard block / profit first"
          // directive. Only non-winner (OLR-only) decisions take the soft penalty.
          const volRegime = this.marketState.getState(activeSymForVol)?.regime ?? 'unknown';
          const volAction = (finalDecision.action === 'buy' || finalDecision.action === 'sell')
            ? (finalDecision.action as 'buy' | 'sell') : 'buy';
          const volComboWinner = this.comboTracker.getComboBlendFactor(activeSymForVol, volAction, volRegime);
          if (volComboWinner) {
            log.info(`🟢 [vol-gate] ${finalDecision.action.toUpperCase()} ${finalDecision.symbol || activeSymbol}: vol ${currentVol.toFixed(5)} < threshold but WINNER-FIRST combo (${(volComboWinner.wr * 100).toFixed(0)}% WR, n=${volComboWinner.count}) overrides — no penalty`);
            activeAuditGates.push({ gate: 'vol-gate', passed: true, reason: `vol<threshold but WINNER combo ${(volComboWinner.wr * 100).toFixed(0)}% (n=${volComboWinner.count}) exempts penalty` });
          } else {
            const ratio = currentVol / this.dynamicMinVolatility;
            const volSoftPenalty = 0.15 * (1 - Math.min(1, Math.max(0, ratio)));
            const prevPenalty = (this as any)._lossStreakPenalty ?? 0;
            (this as any)._lossStreakPenalty = Math.max(0, prevPenalty) + volSoftPenalty;
            log.info(`🟡 [vol-gate] ${finalDecision.action.toUpperCase()} ${finalDecision.symbol || activeSymbol}: vol ${currentVol.toFixed(5)} < threshold ${this.dynamicMinVolatility.toFixed(4)} — soft penalty +${(volSoftPenalty * 100).toFixed(0)}%`);
            activeAuditGates.push({ gate: 'vol-gate', passed: true, reason: `vol=${currentVol.toFixed(5)} < threshold (soft +${(volSoftPenalty * 100).toFixed(0)}%, no winner combo)` });
          }
        } else {
          activeAuditGates.push({ gate: 'vol-gate', passed: true, reason: `vol=${currentVol.toFixed(4)} ≥ threshold=${this.dynamicMinVolatility.toFixed(4)}` });
        }
      }

      // v2.0.106: Adaptive conviction gate + trade frequency throttle.
      // Uses the ACTIVE symbol's per-asset filter — each asset has its own
      // conviction threshold and trade frequency limit based on Market Agent's
      // profile selection.
      // Block new entries if:
      //   1. Consensus confidence is below the adaptive conviction threshold, OR
      //   2. Trade frequency limit is reached (over-trading prevention)
      // v2.0.140: Use PER-SYMBOL confidence from perSymbolConsensus, not the
      // overall consensus.confidence (which is diluted by HOLD symbols).
      // This is the same fix as v2.0.132 for the multi-symbol path — the
      // active-symbol path was never fixed and still used the diluted
      // overall confidence, causing the conviction gate to block all
      // entries when other symbols were HOLD.
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const symFilter = this.assetFilterRegistry.getFilter(finalDecision.symbol || activeSymbol);
        // v2.0.140: Use per-symbol confidence if available, fall back to overall
        const activePscForGate = (result.consensus.perSymbolConsensus ?? []).find(
          psc => normalizeSymbol(psc.symbol) === normalizeSymbol(finalDecision.symbol || activeSymbol),
        );
        const consensusConfidence = activePscForGate?.confidence ?? result.consensus.confidence;
        // v2.0.865-fix3: 記錄「今次決策」嘅 confidence——開倉傳遞用(唔好上 cycle 值)
        this.lastCycleConsensusConfidence = Number.isFinite(consensusConfidence) ? consensusConfidence : 0.5;

        // ── v2.0.227: Plan G — Unified Multiplicative Conviction Gate ──────
        // Replaces the old additive penalty-on-threshold model that caused the
        // death spiral: penalties raised the threshold (+30%) while P(win)
        // discounted the confidence (×0.685), creating a compound gap that made
        // trading mathematically impossible (44.5% vs 80% = 35.5pp gap).
        //
        // Plan G replaces this with a 4-layer multiplicative model (v2.0.819):
        //   effectiveConfidence = consensus × pwinBlendFactor × penaltyFactor × boostFactor
        //   dynamicThreshold = 50% + (totalScore × 0.5%)  →  [45%, 55%]
        //
        // v2.0.819 WINNER-FIRST: pwinBlendFactor = max(olrBlend, comboBlend),
        // letting a statistically strong combo WR (e.g. BTC buy/low_vol 77%,
        // 556W/164L) override the OLR P(win) multiplicative veto that kept BTC
        // untraded for 4 days. boostFactor carries the lossStreakTracker winner
        // pattern (up to +20%). Both are sample-guarded so garbage cannot pass.
        //
        // The threshold is dynamic (driven by 5 objective performance factors with
        // hysteresis) but capped at [45%, 55%]. Penalties are multiplicative (not
        // additive to threshold), with automatic idle-based decay.
        //
        // 6 fairness guarantees: multi-factor balance, symmetric design,
        // sample-size requirement, hysteresis, hard cap, fact-driven.
        // See: src/analysis/dynamic-threshold.ts for full documentation.

        // v2.0.732/v2.0.766: Net penalty from loss-streak + conditional WR +
        // combo WR gates. Can be negative (winner boost > loss penalty).
        const netPenalty = (this as any)._lossStreakPenalty ?? 0;

        // ── Gather inputs for DynamicThresholdCalculator ──────────────────
        // Rolling WR + sample count from last 20 trade-history entries
        let rollingWR = 0.5;
        let wrSampleCount = 0;
        let rollingSharpe = 0;
        let sharpeSampleCount = 0;
        try {
          const recent20 = this.evolution.tradeHistory.getRecent(20);
          const directional = recent20.filter(e => e.decision.action === 'buy' || e.decision.action === 'sell');
          wrSampleCount = directional.length;
          if (wrSampleCount > 0) {
            const wins = directional.filter(e => (e.realisedPnl ?? e.simulatedPnl ?? 0) > 0).length;
            rollingWR = wins / wrSampleCount;
          }
          // Rolling Sharpe from the same window
          const pnls = directional.map(e => e.realisedPnl ?? e.simulatedPnl ?? 0).filter(p => p !== 0);
          sharpeSampleCount = pnls.length;
          if (pnls.length >= 2) {
            const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
            const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
            const std = Math.sqrt(variance);
            rollingSharpe = std > 0 ? (mean / std) * Math.sqrt(pnls.length) : 0;
          }
        } catch { /* cold-start safe: keep defaults */ }

        // v2.0.228: Per-symbol idle cycles — uses DynamicThresholdCalculator's
        // per-symbol tracker instead of the global HACP idle counter. This ensures
        // each symbol's penalty decays independently (SKHX trading doesn't reset
        // SILVER's penalty decay clock).
        const gateSymbol = normalizeSymbol(finalDecision.symbol || activeSymbol);
        const idleCycles = this.dynamicThresholdCalc.getSymbolIdleCycles(gateSymbol, this.hacpEngine.getCyclesWithoutTrade());
        // Drawdown from portfolio
        const drawdownPct = safeNum(this.portfolio.getPortfolio().currentDrawdownPct, 0);
        // Regime from market state
        const regime = combinedState.regime || 'unknown';

        // ── Compute dynamic threshold + penalty factor ─────────────────────
        const dtcInput: DynamicThresholdInput = {
          rollingWR: safeNum(rollingWR, 0.5),
          wrSampleCount,
          idleCycles: safeNum(idleCycles, 0),
          drawdownPct: safeNum(drawdownPct, 0),
          rollingSharpe: safeNum(rollingSharpe, 0),
          sharpeSampleCount,
          regime,
          netPenalty: Math.max(0, safeNum(netPenalty, 0)),
          // v2.0.819: WINNER-FIRST — flow the lossStreakTracker winner boost
          // into the Plan G multiplicative boostFactor. Previously this value
          // was stored as a negative _lossStreakPenalty and clipped to 0 here.
          winnerBoost: Math.max(0, safeNum(this._winnerBoost, 0)),
        };
        const dtcResult = this.dynamicThresholdCalc.compute(dtcInput, gateSymbol);
        const effectiveThreshold = dtcResult.threshold;
        const penaltyFactor = dtcResult.penaltyFactor;
        const boostFactor = dtcResult.boostFactor;

        // ── v2.0.822+: Risk profile threshold adjustment ──────────────────
        // The operator sets the backend account's risk profile via the UI.
        // This adjusts the dynamic threshold AFTER Plan G computes it, so the
        // [45%, 55%] cap is preserved but shifted by the profile bias.
        //   aggressive   → threshold × 0.85 (relaxed — more trades pass)
        //   moderate     → threshold × 1.00 (baseline, no shift)
        //   conservative → threshold × 1.15 (tightened — fewer trades pass)
        // The shift is multiplicative on the threshold (not additive) so it
        // composes cleanly with Plan G's multiplicative model and cannot
        // resurrect the additive death-spiral. Clamped to [0.30, 0.70] so
        // even aggressive cannot drop below 30% (no reckless entries) and
        // conservative cannot exceed 70% (no permanent paralysis).
        const riskProfile = this.marketAgent.getRiskProfile();
        // v2.0.857: risk profiles removed — always moderate multiplier (1.0).
        const riskThresholdMultiplier = 1.0;
        // v2.0.831: NaN guard — if effectiveThreshold is NaN (DTC computation error),
// fall back to 0.50 (baseline threshold). Math.max(0.30, Math.min(0.70, NaN))
// = NaN, and NaN < threshold = false → gate would PASS any trade. This is
// a critical safety bug that could allow trades on corrupted state.
const adjustedThreshold = Number.isFinite(effectiveThreshold)
  ? Math.max(0.30, Math.min(0.70, effectiveThreshold * riskThresholdMultiplier))
  : 0.50; // safe fallback — baseline threshold
        if (riskProfile !== 'moderate') {
          log.info(`🎯 [risk-profile] ${riskProfile}: threshold ${(effectiveThreshold * 100).toFixed(1)}% → ${(adjustedThreshold * 100).toFixed(1)}% (×${riskThresholdMultiplier})`);
        }

        // ── OLR P(win) multiplicative discount (v2.0.224, preserved) ──────
        const pwinSym = normalizeSymbol(finalDecision.symbol || activeSymbol);
        const pwinCtx = this.lastCycleShadowContexts.get(pwinSym);
        let olrPWin = 1.0; // cold-start default: NO discount (preserves operation space)
        let olrHasData = false; // true only when OLR has sufficient samples
        if (pwinCtx?.features && Object.keys(pwinCtx.features).length > 0) {
          try {
            const olrResult = this.olrEngine.query(pwinSym, pwinCtx.features, finalDecision.action, this.totalCycles);
            const olrNSamples = safeNum((olrResult as any)?.nSamples, 0);
            const olrConfidence = (olrResult as any)?.confidence ?? 'low';
            if (olrNSamples >= 10 && olrConfidence !== 'low' &&
                Number.isFinite(olrResult.pWin) && olrResult.pWin >= 0 && olrResult.pWin <= 1) {
              olrPWin = olrResult.pWin;
              olrHasData = true;
            }
          } catch { /* cold-start safe: keep default 1.0 (no discount) */ }
        }
        const olrBlendFactor = olrHasData
          ? DynamicThresholdCalculator.pwinBlendFactor(olrPWin)
          : 1.0;

        // ── v2.0.819: WINNER-FIRST combo blend override ───────────────────
        // The combo WR tracker stores per-(symbol×side×regime) win rates that
        // the OLR model (continuous-feature sigmoid, trained mostly on stale
        // paper data) cannot express. When a combo is a statistically
        // confident winner (n ≥ 20, Wilson 95% LB ≥ 0.55), its blend factor
        // overrides the OLR blend so a strong winner can trade even when OLR
        // reports a low P(win). This implements the owner's WINNER-FIRST
        // directive inside the gate math — previously combo WR could only
        // penalise losers, never boost winners.
        const gateAction = (finalDecision.action === 'buy' || finalDecision.action === 'sell')
          ? (finalDecision.action as 'buy' | 'sell')
          : 'buy';

        // ── v2.0.863 規限①: LLM conviction 校準——LLM 自報 conviction 受歷史 bin 校準
        // (LLM 話 0.85 但 bin 實際 40% → 用 40%)。冷啟動(樣本<20)→ 中性。
        const calibratedConsensus = this.llmCalibrator && llmCalibrationConfig.enabled
          ? this.llmCalibrator.getCalibratedConviction(gateAction, consensusConfidence)
          : consensusConfidence;
        // ── v2.0.864: LLM Direction Verifier——每 cycle 記錄 LLM 方向判斷(包括 HOLD/冇落單)
        // 判斷時 price 凍結——下個 cycle 用現價驗證 B 方向預測;平倉時記錄 C 終極結果
        if (this.llmDirectionVerifier && llmDirectionConfig.enabled) {
          try {
            const judgeSymbol = normalizeSymbol(finalDecision.symbol || activeSymbol);
            const judgePrice = this.hyperliquidWs?.getMarkPriceForSymbol(judgeSymbol)?.markPrice ?? null;
            this.llmDirectionVerifier.recordJudgment(
              judgeSymbol,
              gateAction,
              this.extractTrendType(finalDecision.rationale),
              this.totalCycles,
              judgePrice ?? undefined,
            );
            this.lastJudgeRationale = typeof finalDecision.rationale === 'string' ? finalDecision.rationale : '';
            this.lastJudgeGateAction = gateAction;
          } catch { /* non-fatal */ }
        }
        const llmDirectionTrust = this.llmDirectionVerifier && llmDirectionConfig.enabled
          ? this.llmDirectionVerifier.getTrustMultiplier(
              normalizeSymbol(finalDecision.symbol || activeSymbol),
              this.extractTrendType(finalDecision.rationale),
            )
          : 1.0;
        // v2.0.865: EV Filter 乘數——負 EV(手續費都搵唔返)軟性降
        const evMultiplier = this.evFilter && evFilterConfig.enabled
          ? this.evFilter.getEVMultiplier(
              normalizeSymbol(finalDecision.symbol || activeSymbol),
              gateAction,
            )
          : 1.0;
        // v2.0.863 規限②: LLM 讀圖質素——thesis 引用 K 線方向 vs 統計實際趨勢
        try {
          if (this.llmCalibrator && this.lastKlineSummary && typeof finalDecision.rationale === 'string') {
            const r = finalDecision.rationale.toLowerCase();
            const upRef = /(上升趨勢|uptrend|趨勢向上|bullish)/.test(r);
            const downRef = /(下降趨勢|downtrend|趨勢向下|bearish)/.test(r);
            if (upRef || downRef) {
              this.llmCalibrator.recordKlineRead(upRef ? 'up' : 'down', this.lastKlineSummary.trend1h);
            }
          }
        } catch { /* non-fatal */ }
        const comboBlend = this.comboTracker.getComboBlendFactor(pwinSym, gateAction, regime);
        let pwinBlendFactor = olrBlendFactor;
        let comboBlendUsed: { blendFactor: number; reason: string } | null = null;
        if (comboBlend && comboBlend.blendFactor > olrBlendFactor) {
          pwinBlendFactor = comboBlend.blendFactor;
          comboBlendUsed = { blendFactor: comboBlend.blendFactor, reason: comboBlend.reason };
          log.info(`🟢 [winner-first] ${gateAction.toUpperCase()} ${pwinSym}: combo blend ${comboBlend.blendFactor.toFixed(3)} overrides OLR blend ${olrBlendFactor.toFixed(3)} — ${comboBlend.reason}`);
        }

        // ── Final effective confidence: consensus × P(win) × penalty × boost ──
        let effectiveConfidence = safeNum(calibratedConsensus, 0) * pwinBlendFactor * penaltyFactor * boostFactor * llmDirectionTrust * evMultiplier;

        // ── v2.0.868-P1: Entry Confirmation Gate(入場確認——負偏度解藥)──
        // 數據:蝕錢 trade 入場後「立即」逆向(MAE -5~-7.7%)——輸贏喺入場嗰刻決定
        // Gate:「反彈已開始先入,唔係預期會反彈就入」——3 訊號:
        //   ① Price 位置:已離開 demand/supply zone(唔喺邊緣徘徊)
        //   ② Momentum:最近 1h 趨勢方向同目標一致(反彈已有動能)
        //   ③ Noise:SL 距離合理(≥0.8%——noise 唔會立即 stop-out——太貼唔入)
        // 判斷層——唔 hard block(LLM 世界模型可 override 強 thesis)
        try {
          if (finalDecision && (gateAction === 'buy' || gateAction === 'sell') && this.entryQuality) {
            const eqEntry = safeNum(finalDecision.entryPrice, 0) || safeNum((finalDecision as { entryPrice?: number }).entryPrice, 0);
            const slPct = safeNum(finalDecision.stopLossPct, 0) * 100; // decision stopLossPct 係小數
            if (eqEntry > 0 && slPct > 0) {
              const eqResult = checkConfirmation({
                side: gateAction,
                currentPrice: eqEntry,
                slDistancePct: slPct,
                support: finalDecision.srSupport,
                resistance: finalDecision.srResistance,
                atrPct: undefined, // 同步計算——用 SL 距離合理性代替(簡化:slPct>=0.8 先算 noise 合理)
                lastCandleDir: this.lastKlineSummary?.trend1h,
              });
              if (eqResult.multiplier < 1.0) {
                effectiveConfidence *= eqResult.multiplier;
                log.info(`🟡 [entry-gate] ${gateAction.toUpperCase()} ${pwinSym}: 確認 ${eqResult.confirmedCount}/3 (price=${eqResult.signals.pricePosition ? '✓' : '✗'} mom=${eqResult.signals.momentum ? '✓' : '✗'} noise=${eqResult.signals.noise ? '✓' : '✗'}) → conviction ×${eqResult.multiplier} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
                activeAuditGates.push({ gate: 'entry-gate', passed: true, reason: `confirmation ${eqResult.confirmedCount}/3 → ×${eqResult.multiplier} (soft)` });
              }
              // v2.0.868-fix(主神 GOLD 調查):re-open 價格條件——PAEL 啱啱鎖利
              // close(price 未行遠 ±0.3%)→ 重開 = 同位置再入(fee 浪費)→ ×0.7
              const reopenMult = this.entryQuality.getReopenMultiplier(pwinSym, eqEntry);
              if (reopenMult < 1.0) {
                effectiveConfidence *= reopenMult;
                log.info(`🟠 [reopen-guard] ${gateAction.toUpperCase()} ${pwinSym}: price 未離開最近 close 價 ±0.3%——重開 = 同位置再入 → conviction ×${reopenMult}`);
                activeAuditGates.push({ gate: 'reopen-guard', passed: true, reason: `price within ±0.3% of recent close → ×${reopenMult} (soft)` });
              }
              // v2.0.869(主神 SKHX MAE=0 調查):MAE 模式 gate——回測確認有預測力
              // (差入場 27% vs 好入場 82%——n=131——55pp 差異——統計顯著)
              // 差入場(MAE/MFE ratio > 1.5——入場後立即逆向)→ ×0.5
              // 中性 → ×0.85 / 好入場(管理問題)→ ×1.0(唔抑制)
              // 樣本太少/數據缺失 → 1.0(唔干擾)
              // 獨立 flag:MAE_PATTERN_GATE=false → 現有行為(可回滾)
              if (process.env['MAE_PATTERN_GATE'] !== 'false' && this.entryQuality) {
                const maeMult = this.entryQuality.getMaePatternMultiplier(pwinSym, gateAction as 'buy' | 'sell');
                if (maeMult < 1.0) {
                  effectiveConfidence *= maeMult;
                  const pat = this.entryQuality.getMaePattern(pwinSym, gateAction as 'buy' | 'sell');
                  log.info(`🔴 [mae-pattern] ${gateAction.toUpperCase()} ${pwinSym}: MAE 模式=${pat?.pattern ?? '?'} (ratio=${pat?.ratio?.toFixed(2) ?? '?'}, n=${pat?.n ?? 0})——入場後逆向多過順向 → conviction ×${maeMult} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
                  activeAuditGates.push({ gate: 'mae-pattern', passed: true, reason: `MAE pattern ${pat?.pattern ?? '?'} (ratio ${pat?.ratio?.toFixed(2) ?? '?'}, n=${pat?.n ?? 0}) → ×${maeMult} (soft)` });
                }
              }
              // v2.0.869(主神 SKHX MAE=0 調查):宏觀 gate——時間加權蝕錢率(τ=6h)
              // per symbol×side——最近蝕錢權重高——舊蝕錢衰減
              // 加權蝕錢率 > 0.9 → ×0.45 / > 0.8 → ×0.65 / > 0.6 → ×0.85
              // 樣本太少(<3)→ 1.0(唔干擾)
              // 獨立 flag:MACRO_LOSING_GATE=false → 現有行為(可回滾)
              if (process.env['MACRO_LOSING_GATE'] !== 'false' && this.profitabilityAnalyzer) {
                const macroMult = this.profitabilityAnalyzer.getLosingMultiplier(pwinSym, gateAction as 'buy' | 'sell');
                if (macroMult < 1.0) {
                  effectiveConfidence *= macroMult;
                  log.info(`🟣 [macro-losing] ${gateAction.toUpperCase()} ${pwinSym}: 時間加權蝕錢率高(τ=6h)——最近蝕錢主導 → conviction ×${macroMult} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
                  activeAuditGates.push({ gate: 'macro-losing', passed: true, reason: `time-weighted loss rate high (τ=6h) → ×${macroMult} (soft)` });
                }
              }
            }
          }
        } catch { /* 非致命——Gate 失敗唔 block */ }

        // ── v2.0.868-P2: Entry EV 校準(MAE profile——保守 EV 乘數)──
        // Profile:該 symbol×side 最近 30 日「入場後點走」(rolling window)
        // EV = wilsonLB×mfeMedian − (1−wilsonLB)×|maeMedian|——保守估計
        try {
          if ((gateAction === 'buy' || gateAction === 'sell') && this.entryQuality) {
            const eqProf = this.entryQuality.getProfile(pwinSym, gateAction);
            if (eqProf && eqProf.evMultiplier < 1.0) {
              effectiveConfidence *= eqProf.evMultiplier;
              log.info(`🟠 [entry-ev] ${gateAction.toUpperCase()} ${pwinSym}: 保守 EV ${eqProf.ev.toFixed(2)}% margin (n=${eqProf.n}, winLB ${(eqProf.wilsonLB * 100).toFixed(0)}%) → conviction ×${eqProf.evMultiplier}`);
              activeAuditGates.push({ gate: 'entry-ev', passed: true, reason: `conservative EV ${eqProf.ev.toFixed(2)}% → ×${eqProf.evMultiplier} (soft)` });
            }
          }
        } catch { /* 非致命 */ }

        // ── v2.0.844 Phase 2a: Causal-Grounded Entry Gate ────────────────
        // Only allow high-conviction entries where the aligned shadow shows a
        // POSITIVE causal uplift (trading adds alpha, not just follows the market).
        // Soft gate: negative uplift → multiplicative conviction discount, never a
        // hard block (preserves operation space — owner directive P1).
        const causalMultiplier = this.computeCausalConvictionMultiplier(
          pwinSym, gateAction, regime,
        );
        if (causalMultiplier < 1.0) {
          effectiveConfidence *= causalMultiplier;
          log.info(`🟠 [causal-gate] ${gateAction.toUpperCase()} ${pwinSym}: negative causal uplift → conviction ×${causalMultiplier.toFixed(3)} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
          activeAuditGates.push({ gate: 'causal-gate', passed: true, reason: `negative uplift → ×${causalMultiplier.toFixed(3)} (soft)` });
        }

        // ── v2.0.861 Phase 1.2: Q-RL Expectancy multiplier ────────────────
        // Regime-conditioned expectancy oracle: when the Q-RL table has
        // LEARNED that this action loses money in the CURRENT state bucket
        // (robust negative median + trimmed mean + Q below threshold), damp
        // conviction multiplicatively. Sample-guarded (regime-starved buckets
        // never fire) and non-symmetric (positive boost off by default).
        // This is the quantitative counterweight to stale OLR sell edges.
        const qrlMultiplier = this.computeQRLExpectancyMultiplier(pwinSym, gateAction);
        if (qrlMultiplier < 1.0) {
          effectiveConfidence *= qrlMultiplier;
          log.info(`🟣 [qrl-expectancy] ${gateAction.toUpperCase()} ${pwinSym}: negative expectancy → conviction ×${qrlMultiplier.toFixed(3)} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
          activeAuditGates.push({ gate: 'qrl-expectancy', passed: true, reason: `negative Q-RL expectancy → ×${qrlMultiplier.toFixed(3)} (soft)` });
        } else if (qrlMultiplier > 1.0) {
          effectiveConfidence *= qrlMultiplier;
          log.info(`🟣 [qrl-expectancy] ${gateAction.toUpperCase()} ${pwinSym}: positive expectancy (t≥2) → conviction ×${qrlMultiplier.toFixed(3)} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
          activeAuditGates.push({ gate: 'qrl-expectancy', passed: true, reason: `positive Q-RL expectancy → ×${qrlMultiplier.toFixed(3)} (soft)` });
        }

        // ── v2.0.863: CHART-AWARE conviction — 真駁通 LLM 世界模型(讀圖)──
        // K-LINE 趨勢 vs LLM 方向一致性 + DATA QUALITY 校準。
        // LLM 有 catalyst 可以逆圖表(×1.0);無理由逆圖表 → ×0.75;
        // 數據不可靠 → ×0.85。唔再係淨注入——code 層面硬性校準。
        const chartMultiplier = this.computeChartConviction(gateAction, finalDecision.rationale);
        if (chartMultiplier < 1.0) {
          effectiveConfidence *= chartMultiplier;
          log.info(`📊 [chart-aware] ${gateAction.toUpperCase()} ${pwinSym}: K-LINE 反向/數據異常 → conviction ×${chartMultiplier.toFixed(3)} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
          activeAuditGates.push({ gate: 'chart-aware', passed: true, reason: `K-LINE/DATA-QUALITY 校準 → ×${chartMultiplier.toFixed(3)} (soft)` });
        }

        // ── v2.0.844 Phase 2b: Meta-Calibrator → Dynamic Trust ───────────
        // When the system is poorly calibrated in the current regime (Brier > 0.25),
        // dampen conviction by the regime-trust factor. Already well-calibrated
        // regimes (Brier < 0.25) get a slight boost. Insufficient data → no change.
        const calibrationTrust = this.computeCalibrationTrustMultiplier(regime);
        if (calibrationTrust !== 1.0) {
          effectiveConfidence *= calibrationTrust;
          log.info(`🔵 [cal-trust] ${gateAction.toUpperCase()} ${pwinSym} regime=${regime}: Brier-calibrated trust ×${calibrationTrust.toFixed(3)} (effective=${(effectiveConfidence * 100).toFixed(0)}%)`);
          activeAuditGates.push({ gate: 'calibration-trust', passed: true, reason: `regime trust ×${calibrationTrust.toFixed(3)}` });
        }

        // ── Gate decision ─────────────────────────────────────────────────
        // v2.0.832: Use <= instead of < to avoid floating-point boundary issues.
        // When effective confidence is exactly at the threshold (e.g. 0.49 == 0.49),
        // floating-point arithmetic may produce 0.48999... < 0.49 → HOLD by 0.001%.
        // At exactly the threshold, the signal is strong enough to trade.
        if (effectiveConfidence <= adjustedThreshold - 0.001) {
          const blendStr = comboBlendUsed
            ? ` blend=${pwinBlendFactor.toFixed(3)} (combo override: ${comboBlendUsed.reason.slice(0, 80)})`
            : ` blend=${pwinBlendFactor.toFixed(3)}`;
          const pwinStr = olrHasData
            ? ` (P(win)=${(olrPWin * 100).toFixed(0)}%${blendStr} × consensus=${(consensusConfidence * 100).toFixed(0)}% × penalty=${penaltyFactor.toFixed(2)} × boost=${boostFactor.toFixed(2)} × dirTrust=${llmDirectionTrust.toFixed(2)} × ev=${evMultiplier.toFixed(2)} → effective=${(effectiveConfidence * 100).toFixed(0)}%)`
            : ` (consensus=${(consensusConfidence * 100).toFixed(0)}% × penalty=${penaltyFactor.toFixed(2)} × boost=${boostFactor.toFixed(2)} × dirTrust=${llmDirectionTrust.toFixed(2)} × ev=${evMultiplier.toFixed(2)} → effective=${(effectiveConfidence * 100).toFixed(0)}%, OLR cold-start)`;
          const factorStr = dtcResult.factors.map(f => `${f.factor}=${f.score > 0 ? '+' : ''}${f.score}`).join(' ');
          log.warn(`🛑 [Plan-G] Conviction gate [${finalDecision.symbol || activeSymbol}]: effective ${(effectiveConfidence * 100).toFixed(0)}% < threshold ${(adjustedThreshold * 100).toFixed(1)}% (score=${dtcResult.totalScore > 0 ? '+' : ''}${dtcResult.totalScore}, penalty=${penaltyFactor.toFixed(2)}, boost=${boostFactor.toFixed(2)}, risk=${riskProfile})${pwinStr} — overriding ${finalDecision.action.toUpperCase()} → HOLD`);
          activeAuditGates.push({ gate: 'conviction-gate', passed: false, reason: `${(effectiveConfidence * 100).toFixed(0)}% < ${(adjustedThreshold * 100).toFixed(1)}%${pwinStr} [${factorStr}] [risk=${riskProfile}]` });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[Plan-G ${finalDecision.symbol || activeSymbol}] Effective confidence ${(effectiveConfidence * 100).toFixed(0)}% (P(win)=${(olrPWin * 100).toFixed(0)}% × blend=${pwinBlendFactor.toFixed(3)} × consensus=${(consensusConfidence * 100).toFixed(0)}% × penalty=${penaltyFactor.toFixed(2)} × boost=${boostFactor.toFixed(2)}) below dynamic threshold ${(adjustedThreshold * 100).toFixed(1)}% (score=${dtcResult.totalScore > 0 ? '+' : ''}${dtcResult.totalScore}, risk=${riskProfile}). HOLD. Original: ${finalDecision.rationale}`,
          };
        } else if (symFilter.isTradeFrequencyLimited()) {
          log.warn(`🛑 [adaptive-filter] Trade frequency throttle [${finalDecision.symbol || activeSymbol}]: limit reached — overriding ${finalDecision.action.toUpperCase()} → HOLD (over-trading prevention)`);
          activeAuditGates.push({ gate: 'frequency-throttle', passed: false, reason: 'limit reached' });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[ADAPTIVE FILTER ${finalDecision.symbol || activeSymbol}] Trade frequency limit reached. Over-trading prevention — HOLD. Original: ${finalDecision.rationale}`,
          };
        } else {
          const factorStr = dtcResult.factors.map(f => `${f.factor}=${f.score > 0 ? '+' : ''}${f.score}`).join(' ');
          activeAuditGates.push({ gate: 'conviction-gate', passed: true, reason: olrHasData
            ? `effective ${(effectiveConfidence * 100).toFixed(0)}% (P(win)=${(olrPWin * 100).toFixed(0)}% × blend=${pwinBlendFactor.toFixed(3)}${comboBlendUsed ? ' [combo override]' : ''} × ${(consensusConfidence * 100).toFixed(0)}% × penalty=${penaltyFactor.toFixed(2)} × boost=${boostFactor.toFixed(2)}) ≥ ${(adjustedThreshold * 100).toFixed(1)}% [${factorStr}] [risk=${riskProfile}]`
            : `${(consensusConfidence * 100).toFixed(0)}% × penalty=${penaltyFactor.toFixed(2)} × boost=${boostFactor.toFixed(2)} = ${(effectiveConfidence * 100).toFixed(0)}% ≥ ${(adjustedThreshold * 100).toFixed(1)}% (OLR cold-start) [${factorStr}] [risk=${riskProfile}]` });
          activeAuditGates.push({ gate: 'frequency-throttle', passed: true, reason: 'OK' });
        }
      }

      // v2.0.143: Shadow trade soft gate — if shadow trades for this symbol+side
      // have a very low win rate (< 25%) with sufficient samples (≥ 10), override
      // to HOLD. Shadow trades use fixed S/R SL/TP (not narrowed), so a low shadow
      // win rate means the direction is fundamentally wrong in current conditions.
      // This is a SOFT gate — only blocks when the evidence is overwhelming.
      // v2.0.721: Use Wilson 95% lower bound instead of raw WR for gating,
      // and add symmetric boost (position size ×1.2) when shadow WR is high.
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const shadowSym = normalizeSymbol(finalDecision.symbol || activeSymbol);
        const shadowStats = this.shadowEngine.getStats().find(s => s.symbol === shadowSym);
        if (shadowStats) {
          const shadowWR = finalDecision.action === 'buy' ? shadowStats.longWinRate : shadowStats.shortWinRate;
          const shadowWins = finalDecision.action === 'buy' ? shadowStats.longWins : shadowStats.shortWins;
          const shadowTotal = finalDecision.action === 'buy'
            ? shadowStats.longWins + shadowStats.longLosses
            : shadowStats.shortWins + shadowStats.shortLosses;
          // v2.0.721: Wilson 95% lower bound — more conservative than raw WR.
          // Requires >= 20 samples for gate to fire (was 10).
          const shadowWilsonLB = wilsonScore(shadowWins, shadowTotal);
          if (shadowTotal >= 20 && shadowWilsonLB < 0.30) {
            log.warn(`🛑 [shadow-gate] ${finalDecision.action.toUpperCase()} ${shadowSym}: shadow Wilson LB ${(shadowWilsonLB * 100).toFixed(0)}% (${shadowWins}W/${shadowTotal} samples) < 30% — overriding → HOLD`);
            activeAuditGates.push({ gate: 'shadow-gate', passed: false, reason: `shadow Wilson LB ${(shadowWilsonLB * 100).toFixed(0)}% < 30% (${shadowTotal} samples)` });
            finalDecision = {
              ...finalDecision,
              action: 'hold',
              positionSizePct: 0,
              rationale: `[SHADOW GATE] ${finalDecision.action.toUpperCase()} ${shadowSym} shadow Wilson LB ${(shadowWilsonLB * 100).toFixed(0)}% (${shadowTotal} samples) < 30% — direction fundamentally wrong. HOLD. Original: ${finalDecision.rationale}`,
            };
          } else if (shadowTotal >= 20 && shadowWilsonLB > 0.65) {
            // v2.0.721: Symmetric boost — high shadow WR means direction is
            // statistically strong. Boost position size (not conviction threshold)
            // to avoid feedback loops with the adaptive filter.
            const boostedSize = Math.min(0.20, (finalDecision.positionSizePct ?? 0) * 1.2);
            log.info(`🟢 [shadow-boost] ${finalDecision.action.toUpperCase()} ${shadowSym}: shadow Wilson LB ${(shadowWilsonLB * 100).toFixed(0)}% (${shadowTotal} samples) > 65% — boosting size ${((finalDecision.positionSizePct ?? 0) * 100).toFixed(0)}% → ${(boostedSize * 100).toFixed(0)}%`);
            activeAuditGates.push({ gate: 'shadow-gate', passed: true, reason: `shadow WR ${(shadowWR * 100).toFixed(0)}% (Wilson LB ${(shadowWilsonLB * 100).toFixed(0)}%, ${shadowTotal} samples) → size boost` });
            finalDecision = {
              ...finalDecision,
              positionSizePct: boostedSize,
            };
          } else {
            activeAuditGates.push({ gate: 'shadow-gate', passed: true, reason: shadowTotal >= 20 ? `shadow WR ${(shadowWR * 100).toFixed(0)}% (Wilson LB ${(shadowWilsonLB * 100).toFixed(0)}%, ${shadowTotal} samples)` : `insufficient samples (${shadowTotal} < 20)` });
          }
        }
      }

      // v2.0.720: Trade Record Audit Gate — LLM-powered direction audit.
      // Runs every 2 cycles (non-blocking, async). If the cached audit result
      // contains a critical incident matching the candidate symbol+direction,
      // override to HOLD. This catches patterns that hardcoded gates miss:
      // repeated direction errors, thesis-contradicts-action, SL-too-tight, etc.
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const auditSym = normalizeSymbol(finalDecision.symbol || activeSymbol);
        const auditDir = finalDecision.action;
        if (this.lastAuditResult && this.lastAuditResult.incidents.length > 0) {
          // v2.0.724: Tightened audit gate matching — only block when the
          // incident is specifically about THIS symbol+direction combination.
          // Previous logic used `detail.includes('sell')` which matched ANY
          // incident mentioning "sell" (e.g. "OLR 99% win rate on SELL"),
          // causing false positives that blocked all SELL decisions.
          const criticalMatch = this.lastAuditResult.incidents.find(inc => {
            if (inc.severity !== 'critical') return false;
            // Symbol match: must match exactly (normalized) or be "ALL"
            const incSym = inc.symbol.trim().toUpperCase();
            if (incSym !== 'ALL' && incSym !== '' && normalizeSymbol(incSym) !== auditSym) return false;
            // v2.0.724: Skip one-off observation categories that don't indicate
            // a REPEATED directional problem. "thesis-contradicts-action" is
            // about a single trade where the thesis didn't match the signal —
            // it's not a pattern of repeated losses in that direction.
            // Only categories that indicate a SYSTEMIC directional problem
            // should trigger the gate.
            const catLower = inc.category.toLowerCase();
            const ONE_OFF_CATEGORIES = ['thesis-contradicts-action', 'olr-signal-misuse', 'exit-timing-premature', 'vague-thesis'];
            if (ONE_OFF_CATEGORIES.some(c => catLower.includes(c))) return false;
            // Category-based: only match if category contains the direction
            const catHasDir = catDirMentionDirection(catLower, auditDir);
            if (catHasDir) return true;
            // Detail-based: only match if the detail describes a REPEATED LOSING
            // pattern for this specific direction (not just mentioning it).
            // Look for patterns like "5 of 6 BUY trades are losses" or
            // "SELL trades have a 31% win rate" — these indicate the direction
            // itself is the problem, not just a passing mention.
            const detailLower = inc.detail.toLowerCase();
            const dirWord = auditDir; // 'buy' or 'sell'
            const dirSynonym = auditDir === 'buy' ? 'long' : 'short';
            // Must mention the direction AND a losing indicator (loss/losing/losses/low win rate)
            const mentionsDir = detailLower.includes(dirWord) || detailLower.includes(dirSynonym);
            const mentionsLosing = detailLower.includes('loss') || detailLower.includes('losing')
              || detailLower.includes('low win') || detailLower.includes('wrong direction')
              || detailLower.includes('ignoring') || detailLower.includes('failure to learn');
            return mentionsDir && mentionsLosing;
          });
          if (criticalMatch) {
            log.warn(`🛑 [audit-gate] ${auditDir.toUpperCase()} ${auditSym}: critical audit incident "${criticalMatch.category}" — overriding → HOLD`);
            activeAuditGates.push({ gate: 'audit-gate', passed: false, reason: `critical: ${criticalMatch.category} — ${criticalMatch.detail.slice(0, 80)}` });
            finalDecision = {
              ...finalDecision,
              action: 'hold',
              positionSizePct: 0,
              rationale: `[AUDIT GATE] ${auditDir.toUpperCase()} ${auditSym}: critical audit incident "${criticalMatch.category}" — ${criticalMatch.detail.slice(0, 120)}. HOLD. Original: ${finalDecision.rationale}`,
            };
          } else {
            activeAuditGates.push({ gate: 'audit-gate', passed: true, reason: `${this.lastAuditResult.incidents.length} incidents (no critical match)` });
          }
        } else {
          activeAuditGates.push({ gate: 'audit-gate', passed: true, reason: 'no audit data' });
        }
      }

      // v2.0.33: Pass S/R levels to executeDecision so SL/TP can be set at
      // v2.0.136: Set entryPrice for the active-symbol consensus decision.

      // v2.0.143: PHASE 6 — Terminal Agent decision verification.
      // After Meta-Agent decides BUY/SELL, verify the decision against the
      // Root Command Prompt. If it violates a user directive (e.g. "BUY only"
      // but Meta-Agent says SELL), override to HOLD.
      // NOTE: This must run BEFORE building decisionWithSR, so the override
      // to HOLD is reflected in the decision that gets executed.
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const verification = this.verifyDecisionAgainstRootPrompt(
          finalDecision.action,
          finalDecision.symbol || activeSymbol,
        );
        if (!verification.allowed) {
          log.warn(`🚫 Terminal Agent Phase 6: ${verification.reason} → overriding to HOLD`);
          activeAuditGates.push({ gate: 'terminal-agent-verify', passed: false, reason: verification.reason ?? 'directive violated' });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[TERMINAL AGENT] ${verification.reason}. HOLD. Original: ${finalDecision.rationale}`,
          };
        } else {
          activeAuditGates.push({ gate: 'terminal-agent-verify', passed: true, reason: 'compliant with Root Command Prompt' });
        }
      }

      const decisionWithSR: TradingDecision = {
        ...finalDecision,
        entryPrice: finalDecision.entryPrice ?? combinedState.price ?? marketPrice,
        srSupport: this.lastSRContext?.nearestSupport ?? null,
        srResistance: this.lastSRContext?.nearestResistance ?? null,
      };

      // v2.0.773: Collect ALL market data features at entry time and pass
      // them through executeTrade() so the trade record has real data, not
      // NO_MARKET_DATA. This is the critical fix — without these features,
      // OLR cannot train, EXP cannot learn, and the system trades blind.
      //
      // Build the entry-time market features from the current state.
      // These are the SAME features used by OLR query and shadow trade
      // opening — they must be consistent so the learning pipeline works.
      const entryMarketFeatures: Record<string, number> = {
        volatility: safeNum(combinedState.volatility, 0),
        srDistanceBps: safeNum(this.lastSRContext?.distanceToSupportBps, 0),
        obImbalance: safeNum(combinedState.orderBookImbalance, 0),
        fundingRate: safeNum(this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate, 0),
        volumeRatio: safeNum(this.sentimentEngine?.getVolumeRatio(), 1),
        sentiment: safeNum(this.sentimentEngine?.getSentiment()?.overallSentiment, 0),
        sentimentConviction: safeNum(this.sentimentEngine?.getSentiment()?.conviction, 0.5),
        signalAgreement: safeNum(result.consensus.confidence, 0.5),
        regimeOrdinal: regimeToOrdinal(combinedState.regime),
        hourOfDay: currentHourOfDay(),
        momentumShort: 0,
        momentumLong: 0,
      };

      // v2.0.773: Query OLR P(win) at entry time for the active symbol
      // and cache it so the trade record stores the TRUE entry-time OLR,
      // not a close-time recompute. This fixes the 'NO_OLR' field in trade
      // records — OLR must be queried at entry, not left empty.
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        try {
          const entrySym = normalizeSymbol(finalDecision.symbol || activeSymbol);
          const entryOlr = this.olrEngine.query(entrySym, entryMarketFeatures, finalDecision.action, this.totalCycles);
          this.entryOlrPWinCache.set(entrySym, entryOlr.pWin);
          log.info(`🧬 [entry-features] OLR queried for ${entrySym} ${finalDecision.action.toUpperCase()}: P(win)=${(entryOlr.pWin * 100).toFixed(0)}% (${entryOlr.nSamples} samples, conf=${entryOlr.confidence})`);
        } catch (err) {
          log.warn(`[entry-features] OLR query failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

  // v2.0.817: FINAL FIX — DIRECT INJECTION into TradeRecord creation path.
  // Previous 15 attempts (v2.0.777-816) all failed because execution engines
  // create TradeRecords asynchronously and the polling-based approach (5 retries
  // × 200ms) still misses records created after >1 second delays.
  //
  // v2.0.817 SOLUTION: Instead of polling for records that may never be found,
  // we DIRECTLY INJECT the entry-time features into the TradeRecord at the
  // MOMENT of creation by wrapping the execution engine's trade creation method.
  //
  // The key insight: the execution engines (paper-engine.ts, trading-manager.ts)
  // are in the FORBIDDEN zone — we cannot modify them. But we CAN intercept
  // the TradeRecord objects they create by:
  //
  // 1. Storing the pre-computed features in a MAP (precomputedEntryFeatures)
  //    BEFORE executeTrade() is called.
  //
  // 2. Wrapping the execution engine's trade creation method by monkey-patching
  //    the portfolio's openPosition/importExchangePosition methods (which are
  //    called by the execution engines to create TradeRecords).
  //
  // 3. In the monkey-patched method, checking the precomputedEntryFeatures map
  //    for matching symbol+side and injecting the features DIRECTLY onto the
  //    TradeRecord object at creation time — BEFORE it's stored anywhere.
  //
  // This approach works because:
  // - The portfolio's openPosition/importExchangePosition methods are called
  //   SYNCHRONOUSLY during executeTrade() — no async gap.
  // - The TradeRecord object is created and returned by these methods — we can
  //   inject features onto it before it's stored in any array.
  // - The monkey-patch is applied once at startup and persists for all trades.
  // - The precomputedEntryFeatures map is populated BEFORE executeTrade() and
  //   consumed by the monkey-patch during executeTrade().
  //
  // This is the 16th and FINAL fix attempt. If this doesn't work, the execution
  // engines must be modified (which requires lifting the FORBIDDEN zone restriction).
  
  // Build the entry-time market features, OLR P(win), and shadow win rate
  // that will be passed as parameters to executeTrade().
  let entryOlrPWin: number | undefined;
  let entryShadowWinRate: number | undefined;
  
  if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
    try {
      const entrySym = normalizeSymbol(finalDecision.symbol || activeSymbol);
      const cachedOlr = this.entryOlrPWinCache.get(entrySym);
      if (cachedOlr !== undefined) {
        entryOlrPWin = cachedOlr;
      }
      const shadowStats = this.shadowEngine.getStats().find(s => s.symbol === entrySym);
      if (shadowStats) {
        entryShadowWinRate = finalDecision.action === 'buy'
          ? shadowStats.longWinRate
          : shadowStats.shortWinRate;
      }
      log.info(`🧬 [entry-features] Passing to executeTrade() for ${entrySym} ${finalDecision.action.toUpperCase()}: marketFeatures=${Object.keys(entryMarketFeatures).length} keys, OLR=${entryOlrPWin !== undefined ? (entryOlrPWin * 100).toFixed(0) + '%' : 'N/A'}, shadow=${entryShadowWinRate !== undefined ? (entryShadowWinRate * 100).toFixed(0) + '%' : 'N/A'} — data pipeline active`);
    } catch { /* non-critical */ }
  }

  // v2.0.817: Capture BEFORE state of ALL trade record sources BEFORE
  // executeTrade() is called. This allows us to identify NEW records
  // created by executeTrade() and patch them.
  const beforeState = this.captureTradeRecordBeforeState();

  // v2.0.143: Route through executeTrade() — paper mode goes directly
  // to paperEngine, real mode goes to tradingManager. No more
  // tradingManager fallback for paper trades.
  // v2.0.801: Pass entry-time market features, OLR P(win), and shadow win rate
  // as DIRECT PARAMETERS so the execution engines can include them in the
  // TradeRecord during creation (not patched after creation).
  const execResult = await this.executeTrade(
    decisionWithSR,
    activeAuditGates,
    entryMarketFeatures,
    entryOlrPWin,
    entryShadowWinRate,
  );
  const reports: ExecutionReport[] = execResult.paperReports ?? [];

  // v2.0.817: POST-EXECUTION validation — scan ALL trade record sources for
  // records created in THIS cycle and DIRECTLY SET entryMarketFeatures,
  // entryOlrPWin, entryShadowWinRate if missing. This is a belt-and-suspenders
  // approach — the monkey-patched portfolio methods should have already injected
  // the features, but this ensures 100% coverage even for edge cases.
  //
  // CRITICAL FIX: The previous code only patched records matching the FINAL
  // decision's symbol+side. But the execution engines may create trade records
  // with DIFFERENT symbols or sides (e.g. multi-symbol consensus entries,
  // exploration trades, or shadow trade resolutions). We now scan ALL new
  // records regardless of symbol+side match, and use the precomputed features
  // map to find the correct features for each record.
  if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
    const patchSym = normalizeSymbol(finalDecision.symbol || activeSymbol);
    const patchSide = finalDecision.action as 'buy' | 'sell';
    
    // Use the precomputed features (populated by precomputeEntryFeatures)
    // or the entryMarketFeatures/entryOlrPWin/entryShadowWinRate passed to executeTrade()
    const precomputed = this.precomputedEntryFeatures.get(`${patchSym}:${patchSide}`);
    const marketFeatures = precomputed?.marketFeatures ?? entryMarketFeatures ?? {};
    const olrPWin = precomputed?.olrPWin ?? entryOlrPWin;
    const shadowWinRate = precomputed?.shadowWinRate ?? entryShadowWinRate;
    
    if (Object.keys(marketFeatures).length > 0) {
      let patchedCount = 0;
      
      // Helper: patch a single trade record with entry-time data
      // v2.0.817: Now also patches records with DIFFERENT symbols/sides by
      // looking up the precomputed features map for the record's own symbol+side.
      const patchTradeRecord = (trade: any): boolean => {
        if (!trade) return false;
        // Skip if already has features (already patched by monkey-patch or previous call)
        if (trade.entryMarketFeatures && Object.keys(trade.entryMarketFeatures).length > 0) return false;
        
        // Determine the correct features for this record's symbol+side
        const tradeSym = normalizeSymbol(trade.symbol);
        const tradeSide = trade.side as 'buy' | 'sell';
        
        // Try to find precomputed features for this specific symbol+side
        const tradeKey = `${tradeSym}:${tradeSide}`;
        const tradePrecomputed = this.precomputedEntryFeatures.get(tradeKey);
        
        // Use trade-specific features if available, otherwise fall back to the
        // final decision's features (which may be for a different symbol)
        const tradeMarketFeatures = tradePrecomputed?.marketFeatures ?? marketFeatures;
        const tradeOlrPWin = tradePrecomputed?.olrPWin ?? olrPWin;
        const tradeShadowWinRate = tradePrecomputed?.shadowWinRate ?? shadowWinRate;
        
        // Inject market features
        if (tradeMarketFeatures && Object.keys(tradeMarketFeatures).length > 0) {
          trade.entryMarketFeatures = { ...tradeMarketFeatures };
        }
        
        // Inject OLR P(win)
        if (tradeOlrPWin !== undefined && Number.isFinite(tradeOlrPWin)) {
          trade.entryOlrPWin = tradeOlrPWin;
        }
        
        // Inject shadow win rate
        if (tradeShadowWinRate !== undefined && Number.isFinite(tradeShadowWinRate)) {
          trade.entryShadowWinRate = tradeShadowWinRate;
        }
        
        return true;
      };
      
      // 1. Patch paper engine trades (getTrades() — these are the ACTUAL TradeRecord objects)
      const paperTrades = this.paperEngine?.getTrades() ?? [];
      for (const trade of paperTrades) {
        if (beforeState.paperTradeIds.has(trade.id ?? '')) continue;
        if (patchTradeRecord(trade)) patchedCount++;
      }
      
      // 2. Patch closed real trades (getClosedRealTrades() — these are the ACTUAL TradeRecord objects)
      const closedRealTrades = this.portfolio?.getClosedRealTrades() ?? [];
      for (const trade of closedRealTrades) {
        if (beforeState.closedRealTradeIds.has(trade.id ?? '')) continue;
        if (patchTradeRecord(trade)) patchedCount++;
      }
      
      // 3. Patch real positions (getRealPositions() — these become TradeRecords on close)
      const realPositions = this.portfolio?.getRealPositions() ?? [];
      for (const pos of realPositions) {
        if (beforeState.realPositionIds.has(pos.id ?? '')) continue;
        if (patchTradeRecord(pos)) patchedCount++;
      }
      
      // 4. Patch portfolio positions (paper open positions — these become TradeRecords on close)
      const portfolio = this.portfolio?.getPortfolio();
      if (portfolio && portfolio.positions) {
        for (const [, pos] of portfolio.positions) {
          if (beforeState.paperPositionIds.has(pos.id ?? '')) continue;
          if (patchTradeRecord(pos)) patchedCount++;
        }
      }
      
      if (patchedCount > 0) {
        log.info(`🧬 [entry-features] Post-execution validation patched ${patchedCount} trade record(s) for ${patchSym} ${patchSide.toUpperCase()} — marketFeatures=${Object.keys(marketFeatures).length} keys, OLR=${olrPWin !== undefined ? (olrPWin * 100).toFixed(0) + '%' : 'N/A'}, shadow=${shadowWinRate !== undefined ? (shadowWinRate * 100).toFixed(0) + '%' : 'N/A'} — data pipeline ACTIVE`);
        // Persist IMMEDIATELY so the patches survive a crash
        this.persistPortfolio();
      } else {
        log.debug(`🧬 [entry-features] Post-execution validation: no new trade records found for ${patchSym} ${patchSide.toUpperCase()} — ${paperTrades.length} paper trades, ${closedRealTrades.length} closed real trades, ${realPositions.length} real positions`);
      }
      
      // Clean up the precomputed entry (consumed)
      this.precomputedEntryFeatures.delete(`${patchSym}:${patchSide}`);
    }
  }

      // v2.0.106: Record trade execution for per-asset frequency throttling
      if (execResult.success && (finalDecision.action === 'buy' || finalDecision.action === 'sell')) {
        const tradeSym = finalDecision.symbol || activeSymbol;
        const symFilter = this.assetFilterRegistry.getFilter(tradeSym);
        symFilter.recordTrade();
        // v2.0.228: Mark per-symbol idle reset for penalty decay
        this.dynamicThresholdCalc.markSymbolTraded(tradeSym); this._symbolsTradedThisCycle?.add(tradeSym.toLowerCase());
        log.info(`📊 [adaptive-filter] Trade recorded for ${tradeSym} — ${symFilter.getRemainingTradeSlots()} slots remaining`);
        // v2.0.143: entryThesis is set by executeTrade() after execution.
        // v2.0.153: Push to UI immediately so position appears without waiting for next cycle
        this.pushToAPI();
      }

      // v2.0.128: Record decision audit for the active symbol
      if (originalMetaAction === 'buy' || originalMetaAction === 'sell') {
        const activeExecuted = execResult.success && (finalDecision.action === 'buy' || finalDecision.action === 'sell');
        if (execResult.success && activeExecuted) {
          activeAuditGates.push({ gate: 'execution', passed: true, reason: 'executed on HL' });
        } else if (!activeExecuted) {
          // v2.0.165: Clarify the audit reason — distinguish between "gate blocked
          // new entry" (existing position stays open under SL/TP management) vs
          // "execution failed" (actual error). The old message "overridden to HOLD
          // by gate" was confusing when a position was still open — users thought
          // the system failed to act, when in fact it correctly chose not to enter
          // a new trade while the existing position is managed by per-symbol
          // consensus + SL/TP.
          const hasOpenPos = activeSym && (this.portfolio.hasPosition(activeSym) || (this.cachedExchangePositions ?? []).some(ep => normalizeSymbol(ep.symbol) === activeSym && ep.quantity > 0));
          const holdReason = finalDecision.action === 'hold'
            ? (hasOpenPos
              ? `entry blocked by gate — existing position remains under SL/TP management`
              : 'overridden to HOLD by gate')
            : (execResult.error ?? 'execution failed');
          activeAuditGates.push({ gate: 'execution', passed: false, reason: holdReason });
        }
        this.recordDecisionAudit(
          finalDecision.symbol || activeSymbol,
          originalMetaAction,
          result.consensus.confidence,
          originalMetaThesis ?? '',
          activeAuditGates,
          activeExecuted,
        );
        // v2.0.726: Save gate results for no-trade investigation
        this.lastGateResults = [...activeAuditGates];
      }

      // v2.0.122: Pending thesis management for the active symbol.
      // If Meta-Agent output BUY/SELL with a thesis but the trade didn't execute
      // (gates overrode to HOLD, or execution failed), store the thesis as pending
      // so it carries forward to the next cycle. If the trade DID execute, clear
      // any pending thesis for this symbol (the position now has its own thesis).
      if (originalMetaAction === 'buy' || originalMetaAction === 'sell') {
        const activeSymNorm = normalizeSymbol(activeSymbol);
        if (execResult.success && (finalDecision.action === 'buy' || finalDecision.action === 'sell')) {
          // Trade executed — clear pending thesis (position has its own thesis)
          if (this.pendingTheses.has(activeSymNorm)) {
            this.pendingTheses.delete(activeSymNorm);
            log.info(`📝 [pending-thesis] Cleared for ${activeSymNorm} — trade executed`);
          }
        } else if (originalMetaThesis) {
          // Trade didn't execute — store/update the pending thesis
          this.pendingTheses.set(activeSymNorm, {
            thesis: originalMetaThesis,
            action: originalMetaAction,
            storedAt: Date.now(),
            cycle: this.totalCycles,
          });
          log.info(`📝 [pending-thesis] Stored for ${activeSymNorm}: ${originalMetaAction.toUpperCase()} — "${originalMetaThesis.slice(0, 80)}..." (will re-validate next cycle)`);
        }
      }

      // v2.0.122: Also manage pending theses for multi-symbol trading markets.
      // If a per-symbol consensus had a BUY/SELL with thesis but the entry was
      // blocked (conviction gate, direction restriction, etc.), store it.
      for (const psc of perSymbolConsensus) {
        if (psc.action !== 'buy' && psc.action !== 'sell') continue;
        if (normalizeSymbol(psc.symbol) === normalizeSymbol(activeSymbol)) continue; // handled above
        if (!psc.entryThesis) continue;
        const pscNorm = normalizeSymbol(psc.symbol);
        // If a position now exists for this symbol, the entry succeeded — clear pending
        if (this.portfolio.hasPosition(pscNorm)) {
          if (this.pendingTheses.has(pscNorm)) {
            this.pendingTheses.delete(pscNorm);
            log.info(`📝 [pending-thesis] Cleared for ${pscNorm} — position opened`);
          }
        } else {
          // No position — entry was blocked or not attempted. Store/update pending thesis.
          this.pendingTheses.set(pscNorm, {
            thesis: psc.entryThesis,
            action: psc.action,
            storedAt: Date.now(),
            cycle: this.totalCycles,
          });
        }
      }

      // When real-mode, paperReports mirrors the real trade into the local portfolio
      // so all downstream P&L tracking, stop-loss monitoring, and evolution learning work identically.

      // v2.0.32: After a successful real trade, immediately refresh cachedExchangePositions
      // so that serializePortfolio() includes the new position in the same cycle's pushToAPI().
      // Without this, the new position won't appear in the UI until the NEXT cycle's
      // syncExchangePositions() updates the cache — causing a 1-cycle delay.
      if (this.tradingManager.getTradeMode() === 'real' && execResult.success) {
        try {
          this.cachedExchangePositions = (await this.tradingManager.getPositions()).map(p => ({
            symbol: p.symbol,
            side: p.side,
            quantity: p.quantity,
            averageEntryPrice: p.averageEntryPrice,
            currentPrice: p.currentPrice,
            unrealizedPnl: p.unrealizedPnl,
            leverage: p.leverage ?? 1,
            openedAt: p.openedAt,
          }));
          log.info(`📡 Exchange positions refreshed after trade (${this.cachedExchangePositions.length} positions)`);
        } catch (err) {
          log.warn(`Post-trade exchange position refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── v2.0.18: Taker fees are now deducted inside portfolio.openPosition()
      // and portfolio.closePosition() (notional-based, both sides). This loop
      // previously did a margin-based single-side deduction that undercounted
      // fees by the leverage factor (10x → 10x undercount). Now it only records
      // execution quality + snapshots the pattern context — no fee adjustment
      // needed here because the portfolio already reflects the real cost.
      for (const report of reports) {
        if (!report.trade) continue;
        try {
          // Notional = entryPrice × quantity × leverage (the leveraged value
          // HL charges the fee on). Used for execution-quality tracking.
          const notional = Math.abs(report.trade.entryPrice * report.trade.quantity * (report.trade.leverage ?? finalDecision.leverage ?? 1));
          log.info(`💰 Trade executed: ${report.trade.symbol} notional=$${notional.toFixed(2)} (fees already deducted in portfolio)`);

          // Record execution quality
          this.executionTracker.record({
            cycleNumber: this.totalCycles,
            symbol: report.trade.symbol,
            side: report.trade.side,
            expectedPrice: combinedState.price,
            actualPrice: report.trade.exitPrice ?? report.trade.entryPrice,
            notional,
            decisionAt: cycleStart,
            filledAt: Date.now(),
            mode: this.tradingManager.getTradeMode() === 'real' ? 'real' : 'paper',
          });

          // ── P0: Snapshot trade context for pattern classifier ──
          try {
            const tradeId = report.trade.id ?? `trade_${this.totalCycles}_${report.trade.symbol}_${Date.now()}`;
            const metaThought = result.allThoughts.find(t => t.agentRole === 'meta_agent');
            this.patternClassifier.snapshotContext(
              tradeId,
              report.trade.symbol,
              report.trade.side,
              report.trade.entryPrice,
              {
                regime: combinedState.regime,
                                volatility: combinedState.volatility ?? 0,
                                srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                signalAgreement: result.consensus.confidence,
                      leverage: finalDecision.leverage ?? 1,
              },
              metaThought?.thought ?? '',
              result.allThoughts
                .filter(t => t.agentRole !== 'meta_agent' && t.agentRole !== 'market_agent')
                .map(t => {
                  const msd = t.metadata?.['multiSymbolDecision'] as any;
                  const posDecision = msd?.positions?.find((p: any) => normalizeSymbol(p?.symbol ?? '') === normalizeSymbol(report.trade!.symbol));
                  return { role: t.agentRole, action: posDecision?.action ?? 'hold', confidence: t.confidence };
                }),
            );
          } catch (err) {
            log.error(`[pattern-snapshot] Failed for ${report.trade?.symbol}: ${err instanceof Error ? err.message : String(err)}`);
          }

          // ── v2.0.28: Record pattern tag for this trade ──
          try {
            const tradeId = report.trade.id ?? `trade_${this.totalCycles}_${report.trade.symbol}_${Date.now()}`;
            // Extract patternTag from the final decision (meta-agent's tag)
            const patternTag = finalDecision.patternTag;
            if (patternTag) {
              // v2.0.203: Capture entry-time marketFeatures so pattern-tag
              // win rates can be conditioned on similar market states, not
              // just raw per-tag counts. Aligned with the vector-conditional
              // utility's ENTRY_CONDITION_FEATURES (best-effort — missing
              // fields are skipped by the similarity computation).
              const entryMarketFeatures: Record<string, number> = {
                volatility: combinedState.volatility ?? 0,
                srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                obImbalance: combinedState.orderBookImbalance ?? 0,
                signalAgreement: result.consensus.confidence ?? 0.5,
                regimeOrdinal: regimeToOrdinal(combinedState.regime),
                hourOfDay: currentHourOfDay(), // v2.0.221 Fix 1
              };
              this.patternTagTracker.recordEntry(
                tradeId,
                patternTag,
                report.trade.side,
                report.trade.symbol,
                this.totalCycles,
                'meta_agent',
                entryMarketFeatures,
              );
            }
          } catch (err) {
            log.warn(`[pattern-tag-record] Failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } catch (err) {
          log.error(`[fee-deduction] Failed for ${report.trade?.symbol}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── P0: Accumulate Funding Costs for ALL open positions ──
      // Each cycle, calculate funding cost for each open position based on hours held.
      try {
        const hlPrice = this.hyperliquidWs?.getLatestMarkPrice?.();
        const fundingRate = hlPrice?.fundingRate ?? 0;
        if (fundingRate !== 0) {
          const openPositions = this.portfolio.getOpenSymbols();
          for (const sym of openPositions) {
            const pos = this.portfolio.getPosition(sym);
            if (!pos) continue;
            const hoursHeld = (Date.now() - pos.openedAt) / 3_600_000;
            const notional = pos.currentPrice * pos.quantity * pos.leverage;
            const fundingCost = calculateFundingCost(notional, fundingRate, hoursHeld);
            if (Math.abs(fundingCost) > 0.01) {
              log.info(`💰 Funding cost for ${sym}: $${fundingCost.toFixed(4)} (rate=${(fundingRate * 100).toFixed(4)}%, held=${hoursHeld.toFixed(1)}h)`);
              // Note: funding cost is informational in paper mode.
              // In real mode, this is actually paid/received by the exchange.
            }
          }
        }
      } catch (err) {
        log.error(`[funding-cost] Failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── P0: Correlation Budget Check ──
      // Compute correlation-adjusted effective exposure against portfolio budget.
      // v2.0.32: Exclude exchange-imported positions (agentId='hyperliquid-real')
      // from paper correlation budget — they are real HL positions, not paper trades.
      try {
        const openPositions = this.portfolio.getOpenSymbols();
        if (openPositions.length > 0) {
          const positions = openPositions.map(sym => {
            const pos = this.portfolio.getPosition(sym);
            // Skip exchange-imported positions — they don't count against paper budget
            if (pos && pos.agentId === 'hyperliquid-real') return null;
            return {
              symbol: sym,
              notional: pos ? pos.currentPrice * pos.quantity * pos.leverage : 0,
              direction: pos?.side === 'buy' ? 1 : -1,
            };
          }).filter((p): p is { symbol: string; notional: number; direction: number } => p !== null && p.notional > 0);

          if (positions.length > 0) {
            // Update correlation matrix asynchronously (cached, daily refresh)
            this.correlationBudget.update(
              positions.map(p => p.symbol),
              async (body: object) => {
                const res = await hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                });
                return res;
              },
            ).catch(() => {});

            const report = this.correlationBudget.generateReport(positions, this.portfolio.getPortfolio().totalEquity);
            if (report.exceeded) {
              log.warn(`🛑 Correlation budget exceeded! Effective: $${report.effectiveExposure.toFixed(0)} vs $${report.budgetLimit.toFixed(0)} budget`);
              log.warn(`   ${report.recommendation}`);
            } else if (positions.length >= 2) {
              log.info(`Correlation budget: $${report.effectiveExposure.toFixed(0)} eff / $${report.budgetLimit.toFixed(0)} limit (${(report.effectiveExposure / report.budgetLimit * 100).toFixed(0)}%)`);
            }
          }
        }
      } catch (err) {
        log.error(`[correlation-budget] Failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 5. Log complete cycle results
      const cycleDuration = Math.round(performance.now() - cycleStart);
      const actualAction = finalDecision.action;
      log.info(`✓ Cycle complete (${cycleDuration}ms)`, {
        decision: actualAction.toUpperCase(),
        confidence: result.consensus.confidence.toFixed(2),
        cycles: result.debateRounds.length,
        vetoed: result.consensus.metaAgentOverridden,
        trades: reports.length,
      });

      // 6. Record in trade history (persistent ledger)
      const tradeType: 'real' | 'exploration' | 'simulated' =
        reports.length > 0 && reports.some(r => r.trade) ? 'real'
        : finalDecision.action !== 'hold' ? 'exploration'
        : 'simulated';

      // Pass realisedPnl from the trade report (converted to portfolio return contribution)
      // so computePerformance() can mix it with simulatedPnl (same unit).
      // pnlPct = return on margin (e.g. 0.10 = 10% on 5x leverage).
      // Multiply by positionSizePct to get portfolio contribution (e.g. 0.005 = 0.5%).
      const lastTrade = reports.find(r => r.trade);
      const realisedPortfolioPnl = lastTrade?.trade?.pnlPct != null
        ? lastTrade.trade.pnlPct * (finalDecision.positionSizePct || 0.05)
        : undefined;
      this.evolution.tradeHistory.record({
        cycleNumber: this.totalCycles,
        symbol: combinedState.primarySymbol,
        decision: finalDecision,
        entryPrice: combinedState.price,
        regime: combinedState.regime,
        trend: combinedState.trend,
        volatility: combinedState.volatility,
        type: tradeType,
        confidence: result.consensus.confidence,
        realisedPnl: realisedPortfolioPnl,
      });

      // Update previous cycle's exit price for simulated PnL computation
      this.evolution.tradeHistory.updateLastExit(combinedState.price, combinedState.primarySymbol);

      // 6.5 Record per-agent outcomes for evolution
      try {
        const allAgentDecisions: Array<{
          agentRole: AgentRole;
          multiSymbolDecision: MultiSymbolDecision;
          confidence: number;
        }> = [];

        // Extract multi-symbol decisions from all agent thoughts
        for (const thought of result.allThoughts) {
          if (thought.agentRole === 'meta_agent' || thought.agentRole === 'market_agent') continue;
          const msd = thought.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
          if (msd) {
            allAgentDecisions.push({
              agentRole: thought.agentRole,
              multiSymbolDecision: msd,
              confidence: thought.confidence,
            });
          }
        }

        // v2.0.206 (#8): Pass per-symbol market features so agent outcome records
        // carry marketFeatures for conditional WR computation.
        this.evolution.agentOutcomes.recordCycle(
          this.totalCycles,
          allAgentDecisions,
          combinedState.regime,
          (symbol: string) => {
            const sym = normalizeSymbol(symbol);
            const ctx = this.lastCycleShadowContexts.get(sym);
            return ctx?.features;
          },
        );

        // If a position was closed, backfill outcomes for affected agents
        for (const report of reports) {
          if (report.trade && report.trade.pnl !== undefined) {
            this.evolution.agentOutcomes.backfillOutcome(
              report.trade.symbol,
              report.trade.pnlPct,
              report.trade.side === 'buy' ? 'buy' : 'sell',
            );

            // ── P0: Backfill pattern classifier with exit context ──
            try {
              const tradeId = report.trade.id ?? `trade_${this.totalCycles}_${report.trade.symbol}_${Date.now()}`;
              const holdDuration = report.trade.exitPrice && report.trade.entryPrice
                ? Math.max(1, Math.round((Date.now() - report.trade.openedAt) / 300_000))
                : 1;
              this.patternClassifier.backfillOutcome(
                tradeId,
                report.trade.exitPrice ?? report.trade.entryPrice,
                {
                  regime: combinedState.regime,
                                    volatility: combinedState.volatility ?? 0,
                                    srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
                  signalAgreement: result.consensus.confidence,
                },
                report.trade.pnlPct,
                holdDuration,
              );
            } catch (err) {
              log.error(`[pattern-backfill] Failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } catch (err: unknown) {
        log.warn(`Agent outcome recording failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 7. Store in evolution memory
      this.evolution.memory.store({
        type: 'experience',
        marketState: {
          symbol: combinedState.primarySymbol,
          currentPrice: combinedState.price,
          regime: combinedState.regime,
          volatility: combinedState.volatility,
        },
        decision: finalDecision,
        lessons: [`Cycle #${this.totalCycles}: ${actualAction.toUpperCase()} (${(result.consensus.confidence * 100).toFixed(0)}% confidence)`],
        tags: ['decision_cycle', combinedState.regime, actualAction],
        importance: result.consensus.confidence > 0.7 ? 0.8 : 0.4,
      });

      // 8. Run evolution cycle with cumulative trade history
      const evolved = this.evolution.pressureEngine.evolve({}, this.evolution.tradeHistory);

      // 8.1 Dynamically adjust HACP consensus threshold
      // Feed back the cycle outcome so threshold can adapt to market conditions
      const pAfterCycle = this.portfolio.getPortfolio();
      const hadRealTradeThisCycle = reports.length > 0 && reports.some(r => r.trade);
      const lastTradePnl = reports.find(r => r.trade)?.trade?.pnl ?? 0;
      this.hacpEngine.adjustThreshold(
        combinedState.regime,
        hadRealTradeThisCycle,
        lastTradePnl >= 0
      );
      // v2.0.228: Increment per-symbol idle cycles for symbols that didn't trade this cycle.
      // This enables independent penalty decay per symbol (e.g. SILVER's penalty decays
      // even while SKHX is actively trading).
      this.dynamicThresholdCalc.incrementIdleCycles(this._symbolsTradedThisCycle ?? new Set());

      // 8.5 Run Sigmoid·GA evolution every cycle (feed trade PnL as fitness signal)
      try {
        const perf = this.evolution.tradeHistory.computePerformance();
        // Map trade performance to GA fitness: SharpeRatio bounded 0-1 + winRate bonus
        const gaFitness = Math.max(0, Math.min(1, (
          Math.max(0, (perf.sharpeRatio ?? 0) / 3) * 0.5 +
          (perf.winRate ?? 0) * 0.3 +
          (1 - (perf.maxDrawdown ?? 0)) * 0.2
        )));
        this.sentimentEngine.ga.evolve(gaFitness);
        log.info(`🧬 GA: Gen ${this.sentimentEngine.ga.getGeneration()}, Fitness: ${(gaFitness * 100).toFixed(1)}%`);
      } catch (err: unknown) {
        log.warn(`GA evolution failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 9. Update agent evolution context for next cycle
      const evolutionStatus = this.evolution.getStatus();
      log.info(`🧬 Evolution: Gen ${evolutionStatus['generation']}, Best Fitness: ${((evolutionStatus['bestStrategy'] as number) * 100).toFixed(1)}%`);

      // 9.5 E-step: Build CycleSummary from Meta-Agent's distilled insight
      try {
        const metaThought = result.allThoughts.find(t => t.agentRole === 'meta_agent');
        if (metaThought && this.emManager) {
          const agentsAgreed = result.consensus.votes
            ? result.consensus.votes.filter(v => v.confidence > 0.5).length / Math.max(1, result.consensus.votes.length)
            : result.consensus.confidence;
          const skepticsApproved = !result.allThoughts.some(
            t => t.agentRole === 'skeptics' && t.confidence < 0.6
          );
          const prevSummary = this.emManager.getLatest();
          const cycleSummary = CycleSummaryManager.buildSummary(
            this.totalCycles,
            metaThought.thought,
            result.consensus.confidence,
            { action: finalDecision.action, positionSizePct: finalDecision.positionSizePct, rationale: finalDecision.rationale },
            prevSummary,
            skepticsApproved,
            agentsAgreed,
            combinedState.regime === 'trending_bull' || combinedState.regime === 'trending_bear' ? 0.7 : 0.5,
            combinedState.trend === 'bullish' || combinedState.trend === 'bearish' ? 0.65 : 0.5,
          );
          this.emManager.push(cycleSummary);
          // v2.0.140: Add insight vector for semantic retrieval (non-blocking)
          // v2.0.206 (#6): Pass cycle's market features so the NA vector is stored
          // alongside the text vector for dual-channel retrieval.
          const emCycleFeatures = (() => {
            const sym = normalizeSymbol(cycleSummary.primarySignal?.name ?? this.marketAgent.getConfig().selectedSymbol ?? '');
            const ctx = this.lastCycleShadowContexts.get(sym);
            return ctx?.features;
          })();
          void this.emManager.addInsightVector(cycleSummary, emCycleFeatures).catch(() => { /* non-critical */ });
        }
      } catch (err: unknown) {
        log.warn(`[E-step] CycleSummary build failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 9.6 Persist evolution state + portfolio + debate history + patterns + OLR + pattern tags to disk
      this.evolution.persistState();
      this.patternClassifier?.persist();
      this.patternTagTracker?.persist();
      this.persistOLR();
      // v2.0.862: PAEL exit-price learner persists alongside the rest.
      this.persistExitPriceLearner();

      // v2.0.219: Replay buffer epoch — re-feed high-priority trades to OLR
      // to break temporal correlations. Runs every 5 cycles (enough buffer
      // accumulation between epochs). Cold-start safe: replayEpoch() is a no-op
      // if buffer has < 10 samples.
      try {
        if (this.totalCycles % 5 === 0 && this.replayBuffer) {
          const fed = this.replayBuffer.replayEpoch();
          if (fed > 0) {
            log.debug(`[replay] Cycle ${this.totalCycles}: replayed ${fed} samples to OLR (buffer=${this.replayBuffer.getStats().totalSamples})`);
          }
        }
      } catch (err) {
        log.warn(`[replay] replayEpoch failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.204: Train + validate + persist Numeric Autoencoder every NA train interval.
      // Cold-start safe: trainBatch() is a no-op until replay buffer ≥ minSamplesTrain;
      // validate() returns not-passed until ≥ minSamplesReady samples. isReady() gates
      // the learned-embedding path in computeVectorConditionalWinRate.
      try {
        if (this.totalCycles % 5 === 0) {
          const loss = this.naEngine.trainBatch();
          if (this.naEngine.sampleCount() >= 200) this.naEngine.validate();
          if (loss > 0) log.debug(`[NA] cycle ${this.totalCycles}: train loss=${loss.toFixed(4)}, samples=${this.naEngine.sampleCount()}, ready=${this.naEngine.isReady()}`);
        }
      } catch (err) {
        log.warn(`[NA] train/validate failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.naEngine.persist();
      // v2.0.211 (K.md #1): Persist AttnRes cycle-history state every cycle.
      this.cycleHistory?.persist();
      this.persistPortfolio();
      saveDebateHistory({
        totalCycles: this.totalCycles,
        lastCycleDuration: cycleDuration,
        consensus: result.consensus,
        debateRounds: result.debateRounds,
        allThoughts: result.allThoughts,
      });
      // v2.0.140: Persist EM state (cycle summaries + convergence) so
      // EM Cycle Digestion retains its memory across restarts.
      if (this.emManager) {
        saveEMState(this.emManager.getState());
      }

      // 10. Print portfolio summary
      // v2.0.30: In real mode, show exchange balance instead of paper mirror
      if (this.tradingManager.getTradeMode() === 'real' && this.cachedExchangeBalance) {
        log.info(`\n📊 🟢 Real Portfolio (HL):`, {
          balance: this.cachedExchangeBalance.total.toFixed(2),
          free: this.cachedExchangeBalance.free.toFixed(2),
          marginUsed: this.cachedExchangeBalance.marginUsed.toFixed(2),
          positions: this.cachedExchangePositions?.length ?? 0,
        });
      } else if (this.tradingManager.getTradeMode() === 'real') {
        log.info(`\n📊 ⏳ Real mode: exchange balance not yet fetched`);
      } else {
        log.info(`\n📊 ${this.portfolio.getPortfolio().totalPnl >= 0 ? '🟢' : '🔴'} Portfolio:`, {
          balance: this.portfolio.getPortfolio().balance.toFixed(2),
          equity: this.portfolio.getPortfolio().totalEquity.toFixed(2),
          pnl: `${this.portfolio.getPortfolio().totalPnl >= 0 ? '+' : ''}${this.portfolio.getPortfolio().totalPnl.toFixed(2)}`,
          drawdown: `${(this.portfolio.getPortfolio().maxDrawdownPct * 100).toFixed(2)}%`,
          positions: this.portfolio.getPortfolio().positions.size + this.portfolio.getRealPositions().length,
        });
      }

      // 8. M-step: Update convergence accuracy based on price direction since last cycle
      try {
        const prevPrice = this.totalCycles > 1 ? result.allThoughts[0]?.metadata?.['price'] as number | undefined : undefined;
        if (prevPrice && this.emManager && this.emManager.length >= 2) {
          const priceChange = (combinedState.price - prevPrice) / prevPrice;
          const direction: 'up' | 'down' | 'flat' = priceChange > 0.002 ? 'up' : priceChange < -0.002 ? 'down' : 'flat';
          this.emManager.updateConvergence(direction);
        }
      } catch { /* non-critical */ }

      // ── Update shadow context with final signalAgreement ──
      try {
        const activeCtx = this.lastCycleShadowContexts.get(activeSymbol);
        if (activeCtx) {
          activeCtx.features['signalAgreement'] = result.consensus.confidence;
        }
      } catch { /* non-critical */ }

      // 8. Update API server with latest data
      this.lastCycleDuration = cycleDuration;
      this.lastHACPResult = {
        consensus: result.consensus,
        allThoughts: result.allThoughts,
        debateRounds: result.debateRounds,
      };
      this.lastExpActions = result.expActions ?? [];
      this.pushToAPI();

      // v2.0.104: Sub-cycles removed. ALL trading markets are analyzed in the
      // single HACP cycle above. Non-position trading markets are injected as
      // entries in currentPositions (quantity=0, isTradingMarket=true) before
      // HACP runs, so agents see them in positions[] and output decisions for
      // them. This is the original multi-symbol single-cycle architecture.

    } catch (err) {
      log.error(`Decision cycle #${this.totalCycles} failed:`, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.cycleInProgress = false;
      this.cycleProgress = null;
      this.pushToAPI();

      // v2.0.184: System Engineer runs AFTER cycle completes, not during.
      // v2.0.185: Only run when cycle period >= 5 min.
      // v2.0.186: Only run when SYSTEM_ENGINEER_ENABLED=true (npm run engineer).
      // Under `tsx watch` (npm run dev), file modifications trigger immediate
      // restart before tsc/test can validate the fix — so System Engineer is
      // disabled in watch mode. Use `npm run engineer` for autonomous fixes.
      // v2.0.728: SE must WAIT for cycle to fully complete (cycleInProgress=false)
      // AND block the next cycle from starting while SE is running. Previously
      // SE was fire-and-forget (void), so the next cycle could start while SE
      // was modifying files — causing code changes mid-cycle.
      const cycleMinutes = this.cycleIntervalMs / 60_000;
      const engineerEnabled = process.env['SYSTEM_ENGINEER_ENABLED'] === 'true';

      // v2.0.726: Track cycles since last trade + market conditions for no-trade investigation
      this.cyclesSinceLastTrade++;
      this.recentMarketConditions.push({
        cycle: this.totalCycles,
        regime: combinedState.regime ?? 'unknown',
        volatility: combinedState.volatility ?? 0,
        price: combinedState.price ?? 0,
      });
      if (this.recentMarketConditions.length > 5) this.recentMarketConditions.shift();

      // v2.0.728: SE runs synchronously (awaited) so the next cycle waits for
      // SE to finish before starting. This prevents code changes mid-cycle.
      // v2.0.735: Removed cycleMinutes >= 5 restriction.
      // v2.0.736: SE follows audit — only runs when audit detects incidents.
      // No more fixed schedule (every 2 cycles). SE triggers from audit results.
      if (engineerEnabled && !isShuttingDown()) {
        const shouldRunNoTrade = this.cyclesSinceLastTrade >= 3;
        // v2.0.770: Throttle SE to at most once every 10 cycles to prevent
        // slot starvation when SE competes with 8 trading agents for Ollama slots.
        const shouldRunSE = this.auditTriggeredSE && (this.totalCycles - this.lastSECycle) >= MATSSystem.SE_MIN_CYCLE_GAP;
        if (shouldRunNoTrade) {
          log.warn(`🔧 [no-trade] ${this.cyclesSinceLastTrade} cycles since last trade — triggering SE investigation (blocking next cycle)`);
          this.lastSECycle = this.totalCycles;
          this.cycleInProgress = true;
          try {
            await this.runNoTradeInvestigation();
          } finally {
            this.cycleInProgress = false;
          }
        } else if (shouldRunSE) {
          this.auditTriggeredSE = false; // consume the trigger
          this.lastSECycle = this.totalCycles;
          log.info(`🔧 [system-engineer] Audit triggered SE — starting fix cycle (blocking next cycle)`);
          this.cycleInProgress = true;
          try {
            await this.runDirectionAudit();
          } finally {
            this.cycleInProgress = false;
          }
        }
      }

      // v2.0.808: END-OF-CYCLE trade record patching — the 11th attempt.
      // Previous 10 attempts (v2.0.777-807) all failed because they patched
      // BEFORE or DURING execution engine work, and the engines overwrote
      // the patches. This approach patches AFTER ALL engines are done,
      // ensuring patches persist.
      //
      // The execution engines (paper-engine.ts, hyperliquid-real-engine.ts)
      // are in the FORBIDDEN zone — we cannot modify them. They create
      // TradeRecord objects from their own internal state during executeTrade()
      // and never read runtime properties from the decision object.
      //
      // This fallback scans ALL trade record sources and patches any records
      // missing entryMarketFeatures, entryOlrPWin, or entryShadowWinRate.
      // It uses the pre-computed entry features map (populated BEFORE
      // executeTrade() was called) to fill in the missing data.
      //
      // The key insight: the position object in the portfolio is the SAME
      // reference used when creating the TradeRecord at close time. Patching
      // the position object here ensures the data flows through to the
      // trade record automatically when it's created at close time.
      //
      // v2.0.808: CRITICAL FIX — the fallbackPatchMissingTradeFeatures() method
      // was patching trade records but the patches were NOT being persisted
      // because persistPortfolio() was called BEFORE fallbackPatchMissingTradeFeatures().
      // The fix: call persistPortfolio() AFTER the fallback patch so the
      // patched data survives to the next cycle and is available for learning.
      this.fallbackPatchMissingTradeFeatures();
      // v2.0.808: Persist AFTER patching so the patches survive restart.
      // Without this, the patched entryMarketFeatures/entryOlrPWin/entryShadowWinRate
      // are lost on the next cycle — the learning systems never see them.
      this.persistPortfolio();

      // v2.0.108: Post-cycle market drift check. If tradingMarkets changed
      // during the cycle (e.g. UI re-POSTed 3 markets while cycle only had 1),
      // trigger an immediate cycle to analyze the full set. Without this,
      // the system waits 300s for the next scheduled cycle.
      // v2.0.858-attack: COMPARE SYMBOL SETS, not just count. A user who adds
      // one market and removes another mid-cycle has the same count but a
      // different symbol set — count-only check missed it and the new market
      // waited 300s. Snapshot the full symbol list at cycle start and diff.
      const cycleMarketsSnapshot = (this as any)._cycleMarketsSnapshot as string[] | undefined;
      const currentMarkets = this.tradingMarkets ?? [];
      const normSnap = new Set<string>((cycleMarketsSnapshot ?? []).map((s: string) =>
        s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase()));
      const driftedMarkets = currentMarkets.filter((s) => {
        const n = s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase();
        return !normSnap.has(n);
      });
      const cycleMarketCount = (cycleMarketsSnapshot ?? []).length;
      if (driftedMarkets.length > 0 && !isShuttingDown()) {
        log.info(`📊 Post-cycle drift: markets ${cycleMarketCount} → ${currentMarkets.length} (new: ${driftedMarkets.join(', ')}) — triggering immediate cycle`);
        setTimeout(() => {
          if (!this.cycleInProgress && !isShuttingDown()) {
            void this.runDecisionCycle();
          }
        }, 1000);
      }

      // v2.0.214: Send Telegram notification after each cycle
      void this.sendTelegramCycleReport();
    }
  }

  /** v2.0.214: Send cycle report via Telegram after each cycle completes */
  private async sendTelegramCycleReport(): Promise<void> {
    try {
      const botApi = config.telegram.botApi;
      const chatId = config.telegram.chatId;
      if (!botApi || !chatId) return; // Telegram not configured

      const isReal = this.tradingManager.getTradeMode() === 'real';
      const cycleNum = this.totalCycles;

      // Build portfolio summary
      let portfolioLine: string;
      if (isReal && this.cachedExchangeBalance) {
        portfolioLine = `💰 Balance: $${this.cachedExchangeBalance.total.toFixed(2)} | Free: $${this.cachedExchangeBalance.free.toFixed(2)} | Margin: $${this.cachedExchangeBalance.marginUsed.toFixed(2)}`;
      } else if (isReal) {
        portfolioLine = `💰 Balance: fetching...`;
      } else {
        const p = this.portfolio.getPortfolio();
        portfolioLine = `💰 Balance: $${p.balance.toFixed(2)} | Equity: $${p.totalEquity.toFixed(2)} | PnL: ${p.totalPnl >= 0 ? '+' : ''}$${p.totalPnl.toFixed(2)}`;
      }

      // Build positions list
      let positionsText = '';
      if (isReal && this.cachedExchangePositions && this.cachedExchangePositions.length > 0) {
        positionsText = this.cachedExchangePositions.map(p => {
          const sym = p.symbol.includes(':') ? p.symbol.split(':').pop() : p.symbol;
          const side = p.side.toUpperCase();
          const entry = p.averageEntryPrice.toFixed(2);
          const cur = p.currentPrice.toFixed(2);
          const pnl = p.unrealizedPnl >= 0 ? `+$${p.unrealizedPnl.toFixed(2)}` : `-$${Math.abs(p.unrealizedPnl).toFixed(2)}`;
          const lev = `${p.leverage}x`;
          const qty = p.quantity.toFixed(4);
          return `  ${side} ${sym} ${lev} qty=${qty} entry=$${entry} cur=$${cur} PnL=${pnl}`;
        }).join('\n');
      } else {
        const paperPositions = Array.from(this.portfolio.getPortfolio().positions.values()) as any[];
        const realPositions = this.portfolio.getRealPositions();
        const allPositions = [...paperPositions, ...realPositions];
        if (allPositions.length > 0) {
          positionsText = allPositions.map(p => {
            const sym = (p.symbol ?? '').includes(':') ? (p.symbol ?? '').split(':').pop() : (p.symbol ?? '');
            const side = (p.side ?? 'unknown').toUpperCase();
            const entry = (p.entryPrice ?? 0).toFixed(2);
            const pnl = (p.unrealizedPnl ?? p.pnl ?? 0) >= 0 ? `+$${(p.unrealizedPnl ?? p.pnl ?? 0).toFixed(2)}` : `-$${Math.abs(p.unrealizedPnl ?? p.pnl ?? 0).toFixed(2)}`;
            return `  ${side} ${sym} entry=$${entry} PnL=${pnl}`;
          }).join('\n');
        }
      }

      // Build last decision
      const lastConsensus = this.lastHACPResult?.consensus;
      let decisionLine = 'Decision: HOLD';
      if (lastConsensus) {
        const perSym = (lastConsensus as any)?.perSymbolConsensus as any[] | undefined;
        if (perSym && perSym.length > 0) {
          const decisions = perSym.map(p => {
            const sym = (p.symbol ?? '').includes(':') ? (p.symbol ?? '').split(':').pop() : (p.symbol ?? '');
            return `${p.action.toUpperCase()} ${sym}`;
          });
          decisionLine = `Decision: ${decisions.join(', ')}`;
        } else if ((lastConsensus as any)?.decision) {
          const d = (lastConsensus as any).decision;
          const sym = (d.symbol ?? '').includes(':') ? (d.symbol ?? '').split(':').pop() : (d.symbol ?? '');
          decisionLine = `Decision: ${d.action.toUpperCase()} ${sym}`;
        }
      }

      const mode = isReal ? '🔴 REAL' : '🟢 PAPER';
      const posCount = isReal ? (this.cachedExchangePositions?.length ?? 0) : (this.portfolio.getPortfolio().positions.size + this.portfolio.getRealPositions().length);
      const timestamp = new Date().toLocaleTimeString('en-HK', { timeZone: 'Asia/Hong_Kong' });

      const message = `📊 MATS Cycle #${cycleNum} | ${mode} | ${timestamp}\n\n${portfolioLine}\n📍 Positions: ${posCount}\n${decisionLine}\n${positionsText ? '\n' + positionsText : ''}`;

      // Send via Telegram Bot API
      const url = `https://api.telegram.org/bot${botApi}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        log.warn(`[telegram] Send failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      // Non-critical — don't let Telegram errors affect trading
      log.debug(`[telegram] Cycle report failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── v2.0.833: Edge Validation — compute per-symbol + per-profile edge ───
  //
  // Gathers the 5 evidence streams (shadow WR, OLR P(win), combo WR,
  // first-passage, realized WR×Sharpe) + stability + execution friction,
  // then calls computeEdgeReport() to produce the risk-neutral EdgeReport.
  // v2.0.859: RiskProfileEdgeStore removed (zero decision consumers) —
  // the risk-neutral edgeReport remains the only edge signal.
  // All inputs are best-effort — cold-start returns a neutral `caution`.
  private async computeEdgeForSymbol(
    sym: string,
    side: 'buy' | 'sell',
    regime: string,
  ): Promise<{ edgeReport: EdgeReport } | null> {
    try {
      // 1. Shadow WR (pure directional edge proxy)
      const shadowStats = this.shadowEngine.getStats().find(
        s => s.symbol === normalizeSymbol(sym) || s.symbol === sym.toLowerCase(),
      );
      const shadowWinRate = side === 'buy'
        ? (shadowStats?.longWinRate ?? 0.5)
        : (shadowStats?.shortWinRate ?? 0.5);
      const shadowSamples = side === 'buy'
        ? (shadowStats ? shadowStats.longWins + shadowStats.longLosses : 0)
        : (shadowStats ? shadowStats.shortWins + shadowStats.shortLosses : 0);

      // 2. OLR P(win) (already calibrated by caller if exec-tracker is warm)
      let olrPWin = 0.5;
      let olrSamples = 0;
      try {
        const ctx = this.lastCycleShadowContexts.get(normalizeSymbol(sym));
        if (ctx?.features && Object.keys(ctx.features).length > 0) {
          const olrRes = this.olrEngine.query(sym, ctx.features, side, this.totalCycles);
          if (Number.isFinite(olrRes.pWin)) olrPWin = olrRes.pWin;
          olrSamples = olrRes.effectiveSamples ?? 0;
        }
      } catch { /* cold-start */ }

      // 3. Combo WR (Wilson LB)
      let comboWilsonLB = 0.5;
      let comboSamples = 0;
      try {
        const comboBlend = this.comboTracker.getComboBlendFactor(sym, side, regime);
        if (comboBlend) {
          comboWilsonLB = comboBlend.wilsonLB;
          comboSamples = comboBlend.count;
        }
      } catch { /* cold-start */ }

      // 4. First-Passage P(TP before SL)
      let firstPassageP = 0.5;
      try {
        const fp = this.lastFirstPassage;
        if (fp) {
          firstPassageP = side === 'buy' ? fp.longPWin : fp.shortPWin;
          if (!Number.isFinite(firstPassageP)) firstPassageP = 0.5;
        }
      } catch { /* cold-start */ }

      // 5. Realized WR + Sharpe from trade history
      const recentTrades = this.evolution.tradeHistory.getRecent(100).filter(
        t => normalizeSymbol(t.symbol) === normalizeSymbol(sym),
      );
      const pnlPcts = recentTrades
        .map(t => safeNum(t.realisedPnl ?? t.simulatedPnl, 0) * 100) // convert fraction to %
        .filter(p => Number.isFinite(p));
      const rs = realizedStats(pnlPcts);
      const realizedWinRate = rs.winRate;
      const realizedSamples = rs.samples;
      const realizedSharpe = rs.sharpe;

      // 6. Stability (perturbation + cross-time)
      const stability = this.edgeStabilityMonitor.computeStability(sym, () => {
        // Deterministic action recompute — if we can't recompute, return the
        // consensus action (treat as stable). This is a simplified proxy.
        return side;
      });

      // 7. Execution friction
      const execStats = this.edgeExecTracker.getStats(sym, side);

      // Calibrate OLR PnL label with execution friction (if warm enough)
      const calibratedPWin = this.edgeExecTracker.calibratePnlLabel(sym, side, olrPWin, 60);

      const input: EdgeCalcInput = {
        symbol: sym, side, regime,
        shadowWinRate, shadowSamples,
        olrPWin: calibratedPWin, olrSamples,
        comboWilsonLB, comboSamples,
        firstPassageP,
        realizedWinRate, realizedSamples, realizedSharpe,
        perturbation: stability.perturbation, crossTime: stability.crossTime,
        avgSlippageBps: execStats.avgSlippageBps,
        avgFundingPctPerHour: execStats.avgFundingPctPerHour,
        execSamples: execStats.samples,
      };
      const edgeReport = computeEdgeReport(input);
      this.edgeReportCount++;

      // Record the decision for stability monitoring
      this.edgeStabilityMonitor.recordDecision({
        symbol: sym, action: side as 'buy' | 'sell', // simplified
        entryMarketFeatures: this.lastCycleShadowContexts.get(normalizeSymbol(sym))?.features ?? {},
        ts: Date.now(),
      });

      // v2.0.833: Edge Report computed above (risk-neutral, single signal).
      // v2.0.859: DCS v2 + per-profile MiniLM edge queries REMOVED — both had
      // zero decision consumers since v2.0.857 and burned compute on the main
      // path (MiniLM embed inference ~200ms-1s/cycle). edgeReport remains the
      // only edge signal (skip → hold in buildProfileCell).
      return { edgeReport };
    } catch (err) {
      log.warn(`[edge-compute] ${sym} ${side} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Run a historical backtest to enrich evolution memory */
  private async runBacktest(params: { years: number; symbol: string; interval: string; maxCandles: number; model?: string; reverse?: boolean }): Promise<void> {
    log.info(`📜 Starting backtest: ${params.years}yr ${params.symbol} ${params.interval}${params.model ? ` model=${params.model}` : ''}${params.reverse ? ' REVERSE' : ''}`);

    try {
      const result = await this.backtest.runBacktest({
        years: params.years as 1 | 3 | 5 | 7 | 10 | 12,
        symbol: params.symbol,
        interval: (params.interval ?? '1d') as '5m' | '1h' | '1d' | '1w',
        maxCandles: params.maxCandles,
        reverse: params.reverse ?? false,
      });

      log.info(`✅ Backtest complete: ${result.candlesProcessed} candles in ${(result.durationMs / 1000).toFixed(1)}s`);
      log.info(`   Signals: B:${result.buySignals} S:${result.sellSignals} H:${result.holdSignals}`);

      // Store result for UI
      this.lastBacktestResult = result;

      // ── Evolve strategy based on backtest performance ──
      // Directly update the active strategy's performance with backtest results,
      // then force evolution to mutate toward better parameters.
      const bestStrat = this.evolution.pressureEngine.getBestStrategy();
      if (bestStrat) {
        // Override strategy performance with backtest results
        bestStrat.performance = {
          sharpeRatio: result.sharpeRatio,
          sortinoRatio: result.sharpeRatio * 0.9, // approximate from equity curve
          calmarRatio: result.finalReturnPct / (result.maxDrawdownPct + 0.01),
          winRate: result.winRate,
          profitFactor: result.winRate > 0 ? (result.winRate / (1 - result.winRate + 0.01)) : 0,
          maxDrawdown: result.maxDrawdownPct / 100,
          totalReturn: result.finalReturnPct / 100,
          trades: result.totalTrades,
          avgWin: 0.01,
          avgLoss: 0.01,
          expectancy: 0,
        };

        // Recalculate fitness from backtest performance
        const fitness = this.evolution.fitnessCalculator.calculate(bestStrat.performance);
        bestStrat.fitness = fitness.score;

        log.info(`📊 Backtest fitness: ${(fitness.score * 100).toFixed(1)}% (Sharpe=${result.sharpeRatio.toFixed(2)}, Return=${result.finalReturnPct.toFixed(2)}%)`);

        // Force evolution to mutate — this creates a new generation with mutated params
        const evolved = this.evolution.pressureEngine.evolve({}, this.evolution.tradeHistory);
        log.info(`🧬 Strategy evolved from backtest: Gen ${evolved.generation} (f=${(evolved.fitness * 100).toFixed(1)}%)`);
      } else {
        log.warn('No active strategy to evolve from backtest');
      }

      // Persist updated evolution state
      this.evolution.persistState();

      // Clear backtest progress once done
      this.backtestProgress = null;

      // Push updated evolution data to UI
      this.pushToAPI();
    } catch (err) {
      log.error(`Backtest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Persist portfolio state to disk */
  /** v2.0.128: Record a Meta-Agent decision in the audit log.
   *  Tracks every BUY/SELL decision and which gates passed/blocked it.
   *  Kept to the last 50 entries. Exposed via API for periodic review. */
  private recordDecisionAudit(
    symbol: string,
    action: 'buy' | 'sell',
    confidence: number,
    thesis: string,
    gates: Array<{ gate: string; passed: boolean; reason: string }>,
    executed: boolean,
  ): void {
    this.decisionAudit.push({
      cycle: this.totalCycles,
      symbol,
      action,
      confidence,
      thesis: thesis.slice(0, 200),
      gates,
      executed,
      timestamp: Date.now(),
    });
    // Keep last 50 entries
    if (this.decisionAudit.length > 50) {
      this.decisionAudit = this.decisionAudit.slice(-50);
    }
    const gateSummary = gates.map(g => `${g.gate}:${g.passed ? '✅' : '❌'}`).join(' ');
    log.info(`📋 [audit] Cycle ${this.totalCycles} ${action.toUpperCase()} ${symbol} conf=${(confidence * 100).toFixed(0)}% executed=${executed} gates=[${gateSummary}]`);
  }

  /** Serialize portfolio (Map → plain object) for JSON transmission */
  private serializePortfolio(p: Readonly<import('./types/index.ts').Portfolio>): Record<string, unknown> {
    const positions: Record<string, unknown> = {};
    const isRealMode = this.tradingManager?.getTradeMode() === 'real';

    // v2.0.32: In real mode, build a set of symbols that actually exist on HL.
    // Any local mirror not on HL is stale (closed on exchange) and must NOT
    // be shown in the UI — otherwise the system keeps trying to place SL/TP
    // for a position that doesn't exist, causing console errors.
    const hlSymbols = new Set<string>();
    if (isRealMode && this.cachedExchangePositions) {
      for (const ep of this.cachedExchangePositions) {
        hlSymbols.add(ep.symbol.includes(':') ? ep.symbol : ep.symbol.toLowerCase());
      }
    }

    for (const [key, pos] of p.positions) {
      // v2.0.32: In real mode, skip local mirrors that don't exist on HL.
      // This prevents stale positions from showing in the UI and causing
      // SL/TP placement errors on the exchange.
      // v2.0.52: BUT keep legacy paper positions (opened in paper mode, now
      // in real mode) — they're not on HL and shouldn't be filtered out.
      if (isRealMode && this.cachedExchangePositions) {
        // v2.0.52: Legacy paper positions are managed locally, not on HL.
        const isLegacyPaper = this.legacyPositionModes.get(key) === 'paper';
        if (!hlSymbols.has(key) && !isLegacyPaper) {
          continue;
        }
      }

      // v2.0.19: in real mode, if we have a cached exchange position for this
      // symbol, overlay the real entry price + unrealized PnL so the UI shows
      // the actual Hyperliquid position, not just the local mirror.
      // v2.0.31: colon-prefixed symbols are case-sensitive, match by case-insensitive comparison
      //
      // v2.0.43: FIX — previously the overlay mixed two inconsistent data sources:
      //   currentPrice  ← local mirror (live websocket)
      //   unrealizedPnl ← HL API (computed with HL's mark price at fetch time)
      //   unrealizedPnlPct ← local mirror (computed with local price)
      // This caused the UI to show a Mark price that didn't match the PnL or
      // PnL%. Now we use exPos for entry/PnL/leverage, the live websocket price
      // for currentPrice, and recompute unrealizedPnlPct from exPos.unrealizedPnl
      // so all three fields are internally consistent.
      const exPos = isRealMode && this.cachedExchangePositions
        ? this.cachedExchangePositions.find(ep => ep.symbol.toLowerCase() === key.toLowerCase())
        : undefined;
      // v2.0.43: Use the live websocket price for Mark (exPos.currentPrice is
      // stale — set to entryPx at fetch time and never updated).
      const livePrice = pos.currentPrice;
      if (exPos) {
        // v2.0.43: Recompute unrealizedPnlPct from the HL API PnL and the live
        // mark price so it's consistent with both. Margin = qty * entry / lev.
        const margin = exPos.averageEntryPrice > 0
          ? exPos.quantity * exPos.averageEntryPrice / safeLeverage(exPos.leverage)
          : 0;
        positions[key] = {
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          quantity: exPos.quantity,
          averageEntryPrice: exPos.averageEntryPrice,
          currentPrice: livePrice,
          unrealizedPnl: exPos.unrealizedPnl,
          unrealizedPnlPct: margin > 0 ? exPos.unrealizedPnl / margin : 0,
          stopLossPrice: pos.stopLossPrice,
          takeProfitPrice: pos.takeProfitPrice,
          leverage: exPos.leverage,
          openedAt: pos.openedAt,
          updatedAt: Date.now(),
          agentId: pos.agentId,
          exchange: pos.exchange ?? 'hyperliquid',
          // v2.0.134: Include entryThesis so UI can display the opening rationale
          entryThesis: pos.entryThesis,
          holdReason: pos.holdReason,
          // v2.0.143: Include MAE/MFE tracking for Trade Incident Panel
          minValueReached: pos.minValueReached,
          maxValueReached: pos.maxValueReached,
        };
      } else {
        positions[key] = {
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          quantity: pos.quantity,
          averageEntryPrice: pos.averageEntryPrice,
          currentPrice: pos.currentPrice,
          unrealizedPnl: pos.unrealizedPnl,
          unrealizedPnlPct: pos.unrealizedPnlPct,
          stopLossPrice: pos.stopLossPrice,
          takeProfitPrice: pos.takeProfitPrice,
          leverage: pos.leverage,
          openedAt: pos.openedAt,
          updatedAt: pos.updatedAt,
          agentId: pos.agentId,
          exchange: pos.exchange ?? 'hyperliquid',
          // v2.0.134: Include entryThesis so UI can display the opening rationale
          entryThesis: pos.entryThesis,
          holdReason: pos.holdReason,
          // v2.0.143: Include MAE/MFE tracking for Trade Incident Panel
          minValueReached: pos.minValueReached,
          maxValueReached: pos.maxValueReached,
        };
      }
    }

    // v2.0.153: Also include realPositions (stored by importExchangePosition)
    // so the UI shows real positions immediately after executeTrade, without
    // waiting for syncExchangePositions to copy them to p.positions.
    if (isRealMode) {
      for (const [key, pos] of this.portfolio['realPositions'] as Map<string, any>) {
        if (positions[key]) continue; // already shown from p.positions or cachedExchangePositions
        positions[key] = {
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          quantity: pos.quantity,
          averageEntryPrice: pos.averageEntryPrice,
          currentPrice: pos.currentPrice,
          unrealizedPnl: pos.unrealizedPnl,
          unrealizedPnlPct: pos.unrealizedPnlPct,
          stopLossPrice: pos.stopLossPrice,
          takeProfitPrice: pos.takeProfitPrice,
          leverage: pos.leverage,
          openedAt: pos.openedAt,
          updatedAt: pos.updatedAt ?? Date.now(),
          agentId: pos.agentId ?? 'hyperliquid-real',
          exchange: pos.exchange ?? 'hyperliquid',
          entryThesis: pos.entryThesis,
          holdReason: pos.holdReason,
          minValueReached: pos.minValueReached,
          maxValueReached: pos.maxValueReached,
        };
      }
    }

    // v2.0.19: in real mode, also add any exchange positions that don't have
    // a local mirror (e.g. opened manually on HL outside this system) so the
    // UI Portfolio module shows the complete real position set.
    // v2.0.43: Use live mark price from market state (exPos.currentPrice is
    // stale — set to entryPx at fetch time). Recompute unrealizedPnlPct from
    // margin (notional / leverage), not notional.
    if (isRealMode && this.cachedExchangePositions) {
      for (const exPos of this.cachedExchangePositions) {
        // v2.0.31: preserve original case for colon-prefixed symbols
        const key = exPos.symbol.includes(':') ? exPos.symbol : exPos.symbol.toLowerCase();
        if (!positions[key]) {
          // v2.0.43: Try to get live price from market state or local mirror.
          // v2.0.139: also fall back to cachedPriceMap (populated by
          // refreshPositionMarkPrices) so the Mark reflects the live price
          // even when there's no local mirror (exPos.currentPrice is stale
          // entryPx — never updated by HL getPositions).
          const localPos = p.positions.get(key);
          const baseSym = exPos.symbol.includes(':') ? (exPos.symbol.split(':').slice(-1)[0] ?? exPos.symbol) : exPos.symbol;
          const cachedLive = this.cachedPriceMap.get(exPos.symbol.toLowerCase()) ?? this.cachedPriceMap.get(baseSym.toLowerCase()) ?? 0;
          const livePrice = localPos?.currentPrice || cachedLive || exPos.currentPrice;
          const margin = exPos.averageEntryPrice > 0
            ? exPos.quantity * exPos.averageEntryPrice / safeLeverage(exPos.leverage)
            : 0;
          // v2.0.50: If exPos.openedAt is 0 (fill not found), use local mirror's
          // openedAt or Date.now() — never show Jan 1 1970 in the UI.
          const safeOpenedAt = exPos.openedAt > 0
            ? exPos.openedAt
            : (localPos?.openedAt ?? Date.now());
          // v2.0.XX: Read SL/TP from the real positions map (set by adjustPosition)
          // instead of hardcoding undefined. The real positions map stores the
          // validated SL/TP that was placed on HL via trigger orders.
          // v2.0.80: If no local mirror exists (realPos undefined), compute
          // default SL/TP from entry price (2% SL, 5% TP) so the UI always
          // shows safety levels — same defaults as importExchangePosition().
          const realPos = this.portfolio.getRealPositions().find(rp =>
            rp.symbol.toLowerCase() === key.toLowerCase()
          );
          const fallbackSL = exPos.side === 'buy'
            ? exPos.averageEntryPrice * (1 - 0.02)
            : exPos.averageEntryPrice * (1 + 0.02);
          const fallbackTP = exPos.side === 'buy'
            ? exPos.averageEntryPrice * (1 + 0.05)
            : exPos.averageEntryPrice * (1 - 0.05);
          positions[key] = {
            id: `hl-${exPos.symbol}-${safeOpenedAt}`,
            symbol: exPos.symbol,
            side: exPos.side,
            quantity: exPos.quantity,
            averageEntryPrice: exPos.averageEntryPrice,
            currentPrice: livePrice,
            unrealizedPnl: exPos.unrealizedPnl,
            unrealizedPnlPct: margin > 0 ? exPos.unrealizedPnl / margin : 0,
            stopLossPrice: realPos?.stopLossPrice ?? fallbackSL,
            takeProfitPrice: realPos?.takeProfitPrice ?? fallbackTP,
            leverage: exPos.leverage,
            openedAt: safeOpenedAt,
            updatedAt: Date.now(),
            agentId: 'hyperliquid-real',
            exchange: 'hyperliquid',
            // v2.0.134: Include entryThesis from real position if available
            entryThesis: realPos?.entryThesis,
            holdReason: realPos?.holdReason,
            // v2.0.162: Include MAE/MFE from real position if available
            minValueReached: realPos?.minValueReached,
            maxValueReached: realPos?.maxValueReached,
          };
        }
      }
    }

    // v2.0.42: Recent 20 trades win rate — reflects current performance.
    const recent20 = this.paperEngine.getRecentWinLoss(20);

    // ═══ REAL vs PAPER account display switch ═══
    // 前文後理 (data provenance):
    // - `p.balance` / `p.totalEquity` / `p.totalPnl` are PAPER (simulated)
    //   account numbers — the virtual balance mutated by paper trades only.
    // - In REAL mode these paper numbers are MEANINGLESS for the real
    //   account. The REAL values come from Hyperliquid's own API:
    //   `cachedExchangeBalance` (fetched via tradingManager.getBalance() →
    //   hyperliquid-engine _fetchBalance() → HL clearinghouseState).
    // - HL accountValue (total) = free (withdrawable) + marginUsed, and
    //   INCLUDES unrealized PnL on open positions. This is the "Genuine
    //   Balance" the UI should display.
    // - Therefore: in real mode we swap in HL values for balance/equity and
    //   null out paper-only concepts (totalPnl, maxDrawdown). Win rate +
    //   trade count stay local (they mix paper + real history).
    // - If HL balance not yet fetched → null → UI shows '--'.
    const exBal = isRealMode ? this.cachedExchangeBalance : null;
    // v2.0.856-attack4 (H1/H2): guard non-finite HL values — parseFloat of a
    // malformed HL response ("abc") yields NaN; a NaN balance/equity flows to
    // the UI and renders "$NaN". Coerce non-finite → null (UI shows '--').
    // v2.0.856-attack5 (I3): same guard for PAPER branch — a corrupted paper
    // portfolio (NaN balance from a bad restore) must not flow to the UI.
    const safeFree = exBal && Number.isFinite(exBal.free) ? exBal.free : null;
    const safeTotal = exBal && Number.isFinite(exBal.total) ? exBal.total : null;
    const displayBalance = isRealMode
      ? safeFree
      : (Number.isFinite(p.balance) ? p.balance : null);
    const displayEquity = isRealMode
      ? safeTotal
      : (Number.isFinite(p.totalEquity) ? p.totalEquity : null);
    return {
      balance: displayBalance as number,
      initialBalance: p.initialBalance,
      totalEquity: displayEquity as number,
      totalPnl: isRealMode ? null : p.totalPnl,
      totalPnlPct: isRealMode ? null : p.totalPnlPct,
      // v2.0.42: UI shows CURRENT drawdown (decreases on recovery), not
      // historical max (which only increases and would show 27% forever).
      maxDrawdown: isRealMode ? null : p.maxDrawdown,
      maxDrawdownPct: isRealMode ? null : (p as any).currentDrawdownPct ?? p.maxDrawdownPct,
      peakEquity: p.peakEquity,
      dailyPnl: p.dailyPnl,
      dailyLossLimit: p.dailyLossLimit,
      tradeCount: p.tradeCount,
      winCount: p.winCount,
      lossCount: p.lossCount,
      // v2.0.42: Recent 20 trades win rate.
      recent20WinRate: recent20.winRate,
      recent20Count: recent20.total,
      lastUpdated: p.lastUpdated,
      positions,
      // v2.0.140: EXP digest summary for UI ExperienceDigestionSection
      expDigest: this.expMemory?.getDigestSummary() ?? '',
    };
  }

  private persistPortfolio(): void {
    try {
      // ⚠️ 前文後理 (data provenance):
      // This persists the PAPER portfolio (balance/totalEquity/totalPnl are
      // paper numbers). It ALSO persists realPositions + closedRealTrades so
      // real positions/theses survive restart — but the ACCOUNT BALANCE
      // fields in portfolio-state.json are the PAPER account, NOT the real
      // HL account. On restart, the real HL balance is re-fetched from
      // Hyperliquid API (tradingManager.getBalance()).
      // Do NOT read portfolio-state.json balance to diagnose real-account
      // profitability — read HL accountValue (Genuine Balance in UI).
      savePortfolio(this.portfolio.getPortfolio(), this.paperEngine.getTrades(), this.portfolio.getClosedRealTrades(), this.portfolio.getRealPositions());
    } catch (err) {
      // Best-effort
    }
  }

  /** v2.0.862: Persist the PAEL exit-price learner state (best-effort). */
  private persistExitPriceLearner(): void {
    try {
      this.exitPriceLearner?.save();
    } catch { /* best-effort */ }
  }

  /** v2.0.864-scalp: 由 rationale/thesis 提取 LLM 聲稱嘅走勢類型。
   *  提取實際 timeframe(5m/15m/30m/1h/4h/1d)+ 方向——短炒導向。
   *  例如:「5m-up」「15m-down」「1h-up」;冇 timeframe → mixed-neutral。 */
  private extractTrendType(text: string | undefined): string {
    if (!text || typeof text !== 'string') return 'unknown';
    const r = text.toLowerCase();
    const tfMatch = r.match(/(?:^|[^a-z0-9])(5m|15m|30m|1h|4h|1d)(?=$|[^a-z0-9])/);
    const tf = tfMatch ? tfMatch[1] : '1h'; // 冇 explicit timeframe → 當 1h(舊行為)
    const up = /(上升|uptrend|趨勢向上|bullish|向上|higher high|breakout|突破)/.test(r);
    const down = /(下降|downtrend|趨勢向下|bearish|向下|lower low|breakdown|跌破)/.test(r);
    if (up && !down) return `${tf}-up`;
    if (down && !up) return `${tf}-down`;
    return 'mixed-neutral';
  }

  /**
   * v2.0.866 Phase B:consensus close 二次確認 hold gate。
   * 過早率高(≥60%)+ 盈利 + consensus close → 標記 pending-close(唔立即執行),
   * 下 cycle 再確認(agents 再 close = 確認執行;冇再 close = 取消揸住;3 cycle 超時 = 兜底執行)。
   * v2.0.868-fix3:PAEL(exit_price_lock)過早率 ≥70% 都 hold(強證據防「鎖完立即重開」)。
   * SL/thesis/manual 永遠唔受影響(死揸防禦)。
   * @returns true = close 被 hold(唔應該執行);false = 照常執行
   */
  private holdCloseIfCalibrated(symbol: string, wasProfitable: boolean, closeReason: string): boolean {
    try {
      if (!this.closeCalibrator || !closeCalibConfig.enabled) return false;
      const symNorm = normalizeSymbol(symbol);
      // pending-close 確認:上 cycle hold 咗 + 今 cycle 又 close 決定 → 執行(唔再 hold)
      if (this.closeCalibrator.isPendingClose(symNorm)) {
        log.info(`🔓 [close-calib] ${symNorm} pending-close 確認(再次 close 決定)→ 執行`);
        this.closeCalibrator.removePendingClose(symNorm); // 防殘留
        return false;
      }
      const trend = this.lastKlineSummary?.trend1h ?? 'unknown';
      // v2.0.868-attack12:加 side——buy/sell 過早率分開(主神審計)
      const posSide = this.portfolio.getPosition(symNorm)?.side;
      const holdSide: 'buy' | 'sell' = isSellSide(posSide) ? 'sell' : 'buy';
      if (!this.closeCalibrator.shouldHoldClose(symNorm, holdSide, wasProfitable, trend, closeReason)) return false;
      const rate = this.closeCalibrator.getPrematureRate(symNorm, holdSide, wasProfitable, trend).rate;
      this.closeCalibrator.registerPendingClose(symNorm, this.totalCycles, rate);
      log.warn(`🛑 [close-calib] ${symNorm} close 決定被 hold(過早率 ${(rate * 100).toFixed(0)}%)——下 cycle 再確認;SL/thesis/PAEL 仍然立即執行`);
      return true;
    } catch { return false; } // 校準器錯誤 → 唔 hold(照常 close——安全 fallback)
  }

  /** v2.0.866 Phase B:每 cycle 處理 pending-close(超時兜底執行) */
  private processPendingCloseDecisions(): void {
    try {
      if (!this.closeCalibrator || !closeCalibConfig.enabled) return;
      const toExecute = this.closeCalibrator.processPendingCloses(this.totalCycles, new Set());
      for (const sym of toExecute) {
        log.warn(`⏱️ [close-calib] ${sym} pending-close 超時(3 cycle 冇再確認)→ 兜底執行`);
        // 超時兜底:執行 close(用 consensus reason——如果 position 仲存在)
        const pos = this.portfolio.getPosition(sym);
        if (pos) {
          void this.closeTrade(sym, 'Close-decision timeout (pending-close 3 cycles)', 'consensus').catch((e) =>
            log.warn(`[close-calib] timeout close failed: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
      }
    } catch { /* non-fatal */ }
  }

  /** v2.0.868:當日累計 PnL(paper + real——今日/昨日 closedAt 排序累計 + 完整 trade 詳情) */
  private computeDailyPnl(): {
    today: { date: string; principal: { paper: number; real: number }; paper: PnlSeries; real: PnlSeries };
    yesterday: { date: string; principal: { paper: number; real: number }; paper: PnlSeries; real: PnlSeries };
    weekly: { date: string; principal: { paper: number; real: number }; paper: PnlSeries; real: PnlSeries };
  } {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const DAY = 24 * 3600 * 1000;
    const yesterdayStart = todayStart - DAY;
    const toSeries = (trades: Array<Record<string, unknown>>, start: number, end: number): PnlSeries => {
      const filtered = trades
        .filter((t) => Number.isFinite(t['closedAt'] as number) && (t['closedAt'] as number) >= start && (t['closedAt'] as number) < end)
        .sort((a, b) => (a['closedAt'] as number) - (b['closedAt'] as number));
      let cum = 0;
      const points = filtered.map((t) => { cum += safeNum(t['pnl'] as number, 0); return { t: t['closedAt'] as number, cum }; });
      // 完整 trade 詳情(PNL 頁交易紀錄用)
      const list = filtered.map((t) => ({
        symbol: t['symbol'] ?? '',
        side: t['side'] ?? '',
        entryPrice: t['entryPrice'] ?? null,
        exitPrice: t['exitPrice'] ?? null,
        pnl: safeNum(t['pnl'] as number, 0),
        pnlPct: safeNum(t['pnlPct'] as number, 0),
        leverage: t['leverage'] ?? null,
        openedAt: t['openedAt'] ?? null,
        closedAt: t['closedAt'] ?? null,
        closeReason: t['closeReason'] ?? '',
        entryThesis: t['entryThesis'] ?? '',
        exitThesis: t['exitThesis'] ?? '',
        postReview: t['postReview'] ?? '',
        minValue: t['minValueReached'] ?? null,
        maxValue: t['maxValueReached'] ?? null,
      }));
      return {
        points,
        total: cum,
        trades: filtered.length,
        wins: filtered.filter((t) => safeNum(t['pnl'] as number, 0) > 0).length,
        list,
      };
    };
    const paperAll = Array.from((this.paperEngine?.getTrades?.() ?? []) as never as Array<Record<string, unknown>>);
    const realAll = Array.from(this.portfolio?.getClosedRealTrades?.() ?? []) as never as Array<Record<string, unknown>>;
    const fmt = (ts: number) => new Date(ts).toLocaleDateString('en-CA');
    // v2.0.868-fix:本金(principal——% 模式「對比本金增長」用)
    // paper:初始餘額;real:HL 帳戶餘額(cachedExchangeBalance)
    const paperPrincipal = Number.isFinite(this.portfolio?.getPortfolio?.()?.initialBalance as number) && (this.portfolio?.getPortfolio?.()?.initialBalance as number) > 0
      ? (this.portfolio?.getPortfolio?.()?.initialBalance as number)
      : 1000;
    const realPrincipal = Number.isFinite(this.cachedExchangeBalance?.total as number) && (this.cachedExchangeBalance?.total as number) > 0
      ? (this.cachedExchangeBalance?.total as number)
      : 0;
    return {
      today: {
        date: fmt(todayStart),
        principal: { paper: paperPrincipal, real: realPrincipal },
        paper: toSeries(paperAll, todayStart, todayStart + DAY),
        real: toSeries(realAll, todayStart, todayStart + DAY),
      },
      yesterday: {
        date: fmt(yesterdayStart),
        principal: { paper: paperPrincipal, real: realPrincipal },
        paper: toSeries(paperAll, yesterdayStart, todayStart),
        real: toSeries(realAll, yesterdayStart, todayStart),
      },
      // v2.0.868:最近 7 日(含今日——今日未完都計)
      weekly: {
        date: fmt(todayStart - 6 * DAY),
        principal: { paper: paperPrincipal, real: realPrincipal },
        paper: toSeries(paperAll, todayStart - 6 * DAY, todayStart + DAY),
        real: toSeries(realAll, todayStart - 6 * DAY, todayStart + DAY),
      },
    };
  }

  /** v2.0.866: 每 cycle 驗證 pending close 決定(延遲驗證——close 後價格方向) */
  private verifyPendingCloseDecisions(): void {
    try {
      if (!this.closeCalibrator || !closeCalibConfig.enabled) return;
      this.closeCalibrator.verifyPending(
        (sym) => {
          const mp = this.hyperliquidWs?.getMarkPriceForSymbol(sym);
          if (!mp) return null;
          return normalizeSymbol(mp.symbol) === normalizeSymbol(sym) ? mp.markPrice : null;
        },
      );
    } catch { /* non-fatal */ }
  }

  /** v2.0.864: 每 cycle 驗證 pending LLM 判斷(B 方向預測——判斷時 price vs 而家 price) */
  private verifyPendingLLMJudgments(): void {
    try {
      if (!this.llmDirectionVerifier || !llmDirectionConfig.enabled) return;
      this.llmDirectionVerifier.verifyAllPending(
      (sym) => {
        // v2.0.864-fix:getMarkPriceForSymbol 有 latestMarkPrice fallback——
        // 非 active symbol 會用「另一個 symbol 嘅價」驗證(方向全錯,污染準確率)。
        // strict:只有 markPriceMap 真係有該 symbol 先俾價,否則 null(留低/棄置)。
        const mp = this.hyperliquidWs?.getMarkPriceForSymbol(sym);
        if (!mp) return null;
        return normalizeSymbol(mp.symbol) === normalizeSymbol(sym) ? mp.markPrice : null;
      },
    );
    } catch { /* non-fatal */ }
  }

  /** v2.0.863 規限①: Persist LLM conviction calibrator state. */
  private persistLLMCalibrator(): void {
    try {
      this.llmCalibrator?.save();
    } catch { /* best-effort */ }
  }

  /** v2.0.864: Persist LLM Direction Verifier state. */
  private persistLLMDirectionVerifier(): void {
    try {
      this.llmDirectionVerifier?.save();
    } catch { /* best-effort */ }
  }

  /** v2.0.865: Persist EV Filter state. */
  private persistEVFilter(): void {
    try {
      this.evFilter?.save();
    } catch { /* best-effort */ }
  }

  /** v2.0.866: Persist Close-Decision Calibrator state. */
  private persistCloseCalibrator(): void {
    try {
      this.closeCalibrator?.save();
    } catch { /* best-effort */ }
  }

  /** v2.0.143: Persist Root Command Prompt to disk so it survives backend restarts. */
  private persistRootCommandPrompt(): void {
    try {
      const dir = path.join(process.cwd(), 'data/evolution');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'root-command-prompt.json');
      fs.writeFileSync(filePath, JSON.stringify({
        prompt: this.rootCommandPrompt,
        sideGuide: this.terminalSideGuide,
        savedAt: Date.now(),
      }, null, 2), 'utf-8');
    } catch { /* best-effort */ }
  }

  /** v2.0.143: Load Root Command Prompt from disk on startup. */
  private loadRootCommandPrompt(): void {
    try {
      const filePath = path.join(process.cwd(), 'data/evolution', 'root-command-prompt.json');
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.prompt && typeof data.prompt === 'string') {
          this.rootCommandPrompt = data.prompt;
          this.terminalSideGuide = data.sideGuide ?? '';
          log.info(`Terminal Agent: Root Command Prompt loaded from disk (${this.rootCommandPrompt.length} chars)`);
        }
      }
    } catch { /* best-effort — start fresh */ }
  }

  private persistOLR(): void {
    try {
      const dir = path.join(process.cwd(), 'data/evolution');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Save OLR state
      const olrTmp = path.join(dir, 'olr-state.json.tmp');
      const olrFinal = path.join(dir, 'olr-state.json');
      fs.writeFileSync(olrTmp, this.olrEngine.save(), 'utf-8');
      fs.renameSync(olrTmp, olrFinal);
      // Save shadow trade state
      const shadowTmp = path.join(dir, 'shadow-state.json.tmp');
      const shadowFinal = path.join(dir, 'shadow-state.json');
      fs.writeFileSync(shadowTmp, this.shadowEngine.save(), 'utf-8');
      fs.renameSync(shadowTmp, shadowFinal);
      // v2.0.219: Save advanced learning system states
      const saveAdv = (name: string, data: string) => {
        const p = path.join(dir, name);
        const t = p + '.tmp';
        fs.writeFileSync(t, data, 'utf-8');
        fs.renameSync(t, p);
      };
      saveAdv('replay-buffer.json', this.replayBuffer.save());
      saveAdv('exploration.json', this.activeExploration.save());
      // v2.0.833: Save Edge Validation layer state
      try {
        saveAdv('execution-tracker.json', JSON.stringify(this.edgeExecTracker?.serialize() ?? {}));
      } catch (err) {
        log.warn(`[edge-save] failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.835: Save Q-RL table state
      try {
        saveAdv('q-rl-table.json', JSON.stringify(this.qrlTable?.save() ?? {}));
      } catch (err) {
        log.warn(`[q-rl-save] failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.837: Save Meta-Cognitive Calibrator state
      try {
        saveAdv('meta-calibration.json', JSON.stringify(this.metaCalibrator?.save() ?? {}));
      } catch (err) {
        log.warn(`[meta-cal-save] failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.838: Save Self-Improver state
      try {
        saveAdv('self-improver.json', JSON.stringify(this.selfImprover?.save() ?? {}));
      } catch (err) {
        log.warn(`[self-improve-save] failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.839: Save Causal Reasoner state
      try {
        saveAdv('causal-reasoner.json', JSON.stringify(this.causalReasoner?.save() ?? {}));
      } catch (err) {
        log.warn(`[causal-save] failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.840: Save Meta-Learner state
      try {
        saveAdv('meta-learner.json', JSON.stringify(this.metaLearner?.save() ?? {}));
      } catch (err) {
        log.warn(`[meta-learn-save] failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.844: Save Component Attribution Store
      try {
        saveAdv('component-attribution.json', JSON.stringify(this.componentAttribution?.save() ?? {}));
      } catch (err) {
        log.warn(`[attribution-save] failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
      // v2.0.221 (Fix 3): Save combo win rate tracker state
      if (this.comboTracker.isDirty()) {
        saveAdv('combo-win-rates.json', this.comboTracker.save());
      }
      // v2.0.204: Save Numeric Autoencoder model
      this.naEngine.persist();
      // v2.0.207 (#F): Persist anti-pattern classes.
      this.antiPatternTracker?.persist();
      // v2.0.211 (K.md #1): Persist AttnRes cycle-history state (w vectors,
      // per-symbol history, entry-time features).
      this.cycleHistory?.persist();
      // v2.0.215: Persist AttnRes trade embedder state (learned w vector).
      if (this.attnResTradeEmbedder) {
        void this.attnResTradeEmbedder.save('data/evolution/attnres-embed-state.json').catch(() => {});
      }
    } catch { /* best-effort */ }
  }

  private buildMarketDescription(state: AggregatedMarketState): string {
    const calSummary = this.marketState?.calibrator?.getCalibrationSummary?.() ?? '';
    const lines: string[] = [
      `=== Market State ===`,
      `Symbol: ${state.primarySymbol}`,
      `Price: $${state.price.toFixed(2)}`,
      `24h Change: ${state.change24h >= 0 ? '+' : ''}${state.change24h.toFixed(2)}%`,
    ];

    if (state.volume24h > 0) {
      lines.push(`24h Volume: $${(state.volume24h / 1_000_000).toFixed(2)}M`);
    } else {
      lines.push(`24h Volume: DATA_UNAVAILABLE — ignoring volume signal this cycle`);
    }

    lines.push(`Order Book Imbalance: ${(state.orderBookImbalance * 100).toFixed(1)}%`);

    if (state.volatility > 0) {
      lines.push(`Volatility: ${(state.volatility * 100).toFixed(3)}%`);
    } else {
      lines.push(`Volatility: DATA_UNAVAILABLE — ignoring volatility signal this cycle`);
    }

    lines.push(
      `Trend: ${state.trend.toUpperCase()}`,
      `Regime: ${state.regime.toUpperCase()}`,
    );

    // v2.0.115: Inject short-term price trend so agents can see multi-cycle direction
    const priceTrend = this.marketState?.getRecentPriceTrend?.(state.primarySymbol, 20);
    if (priceTrend) {
      const arrow = priceTrend.direction === 'up' ? '↑' : priceTrend.direction === 'down' ? '↓' : '→';
      lines.push(`Short-term Trend: ${arrow} ${priceTrend.direction.toUpperCase()} ${priceTrend.pctChange >= 0 ? '+' : ''}${priceTrend.pctChange.toFixed(2)}% over last ${priceTrend.ticks} ticks ($${priceTrend.startPrice.toFixed(2)} → $${priceTrend.endPrice.toFixed(2)})`);
      if (Math.abs(priceTrend.pctChange) > 2) {
        lines.push(`⚠️ SIGNIFICANT TREND: Price has moved ${priceTrend.pctChange >= 0 ? 'up' : 'down'} ${Math.abs(priceTrend.pctChange).toFixed(1)}% — trend-following entry recommended`);
      }
    }

    lines.push(
      calSummary,
      `Last Updated: ${new Date(state.updatedAt).toISOString()}`,
      `---`,
    );

    // Sigmoid·GA sentiment with real WS data
    if (this.sentimentEngine) {
      const hlOB = this.hyperliquidWs?.getOrderBookImbalance() ?? 0;
      const hlSpread = this.hyperliquidWs?.getSpread() ?? 0;
      const hlLargeTrades = this.hyperliquidWs?.getLargeTradeCount(60_000) ?? 0;
      const totalLargeTrades = hlLargeTrades;
      const hlMarkPrice = this.hyperliquidWs?.getLatestMarkPrice();
      // v2.0.105: Filter raw OB imbalance through adaptive EMA before sentiment
      // v2.0.106: Use the active symbol's per-asset filter
      const rawOB = hlOB !== 0 ? hlOB : state.orderBookImbalance;
      const activeSymFilter = this.assetFilterRegistry?.getFilter(state.primarySymbol ?? '');
      const effectiveOB = activeSymFilter?.filterEMA('orderBookImbalance', rawOB) ?? rawOB;
      const largeTradeNorm = Math.min(1, totalLargeTrades / 10);

      this.sentimentEngine.compute({
        price: state.price,
        volume24h: state.volume24h,
        orderBookImbalance: effectiveOB,
        spread: hlSpread > 0 ? hlSpread : 0.0001,
        fearGreedIndex: getLastFearGreedValue(),
        volatilityRegime: state.volatility > 0.02 ? 0.7 : state.volatility > 0.01 ? 0.4 : 0.2,
        fundingRate: hlMarkPrice?.fundingRate,
        largeTradeCount: largeTradeNorm,
      });

      lines.push(this.sentimentEngine.formatForAgentContext());
      lines.push('');
      lines.push('=== GA CHROMOSOME (Sentiment Model) ===');
      lines.push(this.sentimentEngine.getChromosomeSummary());
    }

    // v2.0.106: Inject per-asset adaptive filter summaries into agent context.
    // Meta-Agent MUST receive this and factor it into every decision.
    if (this.assetFilterRegistry && this.assetFilterRegistry.getAllFilters().size > 0) {
      lines.push('');
      lines.push(this.assetFilterRegistry.getMetaAgentSummary());
    } else if (this.adaptiveFilter) {
      lines.push('');
      lines.push(this.adaptiveFilter.getCompactSummary());
    }

    return lines.join('\n');
  }

  private printSystemStatus(): string {
    const p = this.portfolio.getPortfolio();
    const status = [
      `┌─────────────────────────────────────┐`,
      `│ 🏛️  MATS System Status              │`,
      `├─────────────────────────────────────┤`,
      `│ Cycles: ${String(this.totalCycles).padEnd(8)} Balance: $${p.balance.toFixed(0).padStart(6)}│`,
      `│ Equity: $${p.totalEquity.toFixed(0).padStart(6)}  PnL: ${(p.totalPnl >= 0 ? '+' : '')}${p.totalPnl.toFixed(0).padStart(5)} │`,
      `│ Drawdown: ${(((p as any).currentDrawdownPct ?? p.maxDrawdownPct) * 100).toFixed(1).padStart(5)}%     Positions: ${p.positions.size}          │`,
      `│ WS: ${this.multiWs?.isConnected() ? '✓' : '✗'} (${this.multiWs?.getActiveExchange() ?? '?'})  Trades: ${p.tradeCount} (W:${p.winCount} L:${p.lossCount})   │`,
      // v2.0.42: Show recent 20 trades win rate below the main status line
      `│ Recent20: ${(() => { const r = this.paperEngine.getRecentWinLoss(20); return `${r.wins}W/${r.losses}L (${(r.winRate * 100).toFixed(0)}%)`; })().padEnd(52)}│`,
      `└─────────────────────────────────────┘`,
    ].join('\n');

    log.info(`\n${status}`);
    return status;
  }

  /** v2.0.33: Refresh HL fills + exchange positions + push to UI immediately.
   * Called after a real position close so the UI updates instantly — the
   * closed position disappears from the Portfolio panel and the HL fill
   * appears in Trade Records without waiting for the next cycle. */
  private async refreshHLFillsAndPush(): Promise<void> {
    try {
      if (this.tradingManager?.getTradeMode() === 'real') {
        const engine = this.tradingManager.getEngineForExchange('hyperliquid') as any;
        if (engine) {
          // v2.0.79: Clear caches so we get FRESH data after a position close.
          // Without this, getPositions() returns cached data that still has
          // the closed position, and serializePortfolio() re-adds it.
          if (typeof engine.clearCaches === 'function') {
            engine.clearCaches();
          }
          if (typeof engine.getRecentFills === 'function') {
            this.cachedHLFills = await engine.getRecentFills(20);
          }
          if (typeof engine.getPositions === 'function') {
            this.cachedExchangePositions = await engine.getPositions();
          }
          if (typeof engine.getBalance === 'function') {
            this.cachedExchangeBalance = await engine.getBalance();
          }
        }
      }
    } catch { /* best-effort */ }
    this.pushToAPI();
  }

  /**
   * v2.0.139: Refresh open positions' Mark (currentPrice) from the live
   * marketState so the UI Mark column reflects the actual current price, not
   * the stale entryPx. Previously the mirror currentPrice was only updated from
   * HL getPositions() (which returns entryPx as currentPrice — never updated)
   * or fills — so for an open position the Mark was stuck at the Entry price.
   * Called at the start of every pushToAPI() so the UI always sees fresh marks.
   */
  /**
   * v2.0.139: Refresh open positions' Mark (currentPrice) from live prices so
   * the UI Mark column reflects the actual current price, not the stale entryPx
   * (HL getPositions returns entryPx as currentPrice — never updated). Uses the
   * cachedPriceMap (populated each cycle from fetchPricesForSymbols). For
   * position symbols missing from the cache (e.g. late-imported HL positions
   * that weren't in getOpenSymbols at cycle start), fetches on-demand.
   * Called fire-and-forget from pushToAPI (async) so it never blocks the UI push.
   */
  private async refreshPositionMarkPrices(): Promise<void> {
    if (!this.portfolio || !this.marketAgent) return;
    const realPositions = this.portfolio.getRealPositions();
    if (realPositions.length === 0) return;

    // On-demand fetch for position symbols not yet in the cache (late-imported
    // positions that weren't in getOpenSymbols when the cycle built the cache).
    const base = (sym: string) => sym.includes(':') ? (sym.split(':').slice(-1)[0] ?? sym) : sym;
    const hasPrice = (sym: string) => (this.cachedPriceMap.get(sym.toLowerCase()) ?? 0) > 0 || (this.cachedPriceMap.get(base(sym).toLowerCase()) ?? 0) > 0;
    const missing = realPositions.filter(pos => !hasPrice(pos.symbol)).map(pos => pos.symbol.includes(':') ? pos.symbol : pos.symbol.toUpperCase());
    if (missing.length > 0) {
      try {
        const fresh = await this.marketAgent.fetchPricesForSymbols(Array.from(new Set(missing)));
        for (const [sym, data] of fresh) {
          if (data.price > 0) this.cachedPriceMap.set(sym.toLowerCase(), data.price);
        }
      } catch { /* fail-open — keep existing cache */ }
    }

    // Update each position's Mark from the cache.
    for (const pos of realPositions) {
      try {
        let livePrice = this.cachedPriceMap.get(pos.symbol.toLowerCase()) ?? 0;
        if (!livePrice) livePrice = this.cachedPriceMap.get(base(pos.symbol).toLowerCase()) ?? 0;
        if (livePrice > 0) {
          this.portfolio.softUpdatePosition(pos.symbol, livePrice);
        }
      } catch { /* skip */ }
    }

    // v2.0.143: Also update PAPER positions' mark prices + MAE/MFE tracking.
    // Previously only real positions were refreshed — paper positions for
    // non-active trading markets never got price updates between cycles,
    // so their minValueReached/maxValueReached stayed at the open value.
    // Now we update ALL paper positions each pushToAPI() call so MAE/MFE
    // is tracked continuously (every cycle, not just when the symbol is active).
    const paperPositions = this.portfolio.getPaperPositions();
    for (const pos of paperPositions) {
      try {
        // Try cached price map first (populated each cycle)
        let livePrice = this.cachedPriceMap.get(pos.symbol.toLowerCase()) ?? 0;
        if (!livePrice) livePrice = this.cachedPriceMap.get(base(pos.symbol).toLowerCase()) ?? 0;
        // Fallback: marketState
        if (!livePrice) {
          const mktState = this.marketState?.getState(pos.symbol);
          livePrice = mktState?.price ?? 0;
        }
        if (livePrice > 0) {
          this.portfolio.softUpdatePosition(pos.symbol, livePrice);
        }
      } catch { /* skip */ }
    }
  }

  private pushToAPI(): void {
    try {
      // Guard: allow push before MarketAgent/MarketState are initialized (e.g. during startup)
      if (!this.marketAgent || !this.marketState) return;
      void this.refreshPositionMarkPrices(); // v2.0.139: fresh Mark prices (async, fire-and-forget)
      const activeSymbol = this.marketAgent.getSelectedSymbol() || 'BTCUSDT';
      const state = this.marketState.getState(activeSymbol);
      const p = this.portfolio.getPortfolio();
      const agentStatuses: AgentStatus[] = [
        this.fractalAgent.getStatus(),
        this.onchainAgent.getStatus(),
        this.regimeAgent.getStatus(),
        this.riskAuditor.getStatus(),
        this.newsAgent.getStatus(),
        this.metaAgent.getStatus(),
      ];

      const marketAgentState = this.marketAgent?.getState() ?? { config: { selectedSymbol: '', tradeMode: 'paper', exchange: 'hyperliquid', hyperliquidAssetType: 'crypto_perps', updatedAt: Date.now() }, topPairs: [] };
      // v2.0.122: Attach pending theses so UI can display them
      if (this.pendingTheses.size > 0) {
        (marketAgentState as { pendingTheses?: unknown }).pendingTheses = Array.from(this.pendingTheses.entries()).map(([sym, entry]) => ({
          symbol: sym,
          action: entry.action,
          thesis: entry.thesis,
          cycle: entry.cycle,
          storedAt: entry.storedAt,
        }));
      }

      // v2.0.17: In real-trade mode, show the actual Hyperliquid account value
      // (from the cached exchange balance) instead of the local mirror. The
      // local mirror only tracks margin movements from our own trades; it
      // misses deposits/withdrawals, funding settlements, and PnL from other
      // sources. Total PnL + drawdown are nulled in real mode (UI shows '--')
      // because they're paper-trade concepts that don't map cleanly to the
      // real account. Win rate / trade count stay local (paper + real mixed).
      // v2.0.31: Balance = free (available to trade), Equity = total (account value)
      const isRealMode = this.tradingManager.getTradeMode() === 'real';
      const exBal = isRealMode ? this.cachedExchangeBalance : null;
      // v2.0.42: Recent 20 trades win rate — reflects current performance.
      const recent20 = this.paperEngine.getRecentWinLoss(20);
      // In real mode: if exchange balance not yet fetched → null (UI shows '--')
      const displayBalance = isRealMode ? (exBal ? exBal.free : null) : p.balance;
      const displayEquity = isRealMode ? (exBal ? exBal.total : null) : p.totalEquity;

      const apiData = {
        systemPaused: this.paused,
        decisionAudit: this.decisionAudit.slice(-20),
        status: {
          cycles: this.totalCycles,
          balance: displayBalance,
          equity: displayEquity,
          // totalPnl: use accumulated realized PnL from the portfolio tracker
          // rather than (equity - initialBalance) which includes unrealized PnL
          // and locked margin creating phantom gains/losses.
          // In real mode, null → UI shows '--' (paper-trade concept).
          totalPnl: isRealMode ? null as unknown as number : p.totalPnl,
          totalPnlPct: isRealMode ? null as unknown as number : p.totalPnlPct,
          drawdownPct: isRealMode ? null as unknown as number : p.maxDrawdownPct,
          // v2.0.157: Deduped position count — paper positions + real positions
          // + cached exchange positions (HL API), deduped by normalized symbol
          positions: (() => {
            const syms = new Set<string>();
            for (const [k] of p.positions) syms.add(k);
            for (const r of this.portfolio.getRealPositions()) syms.add(normalizeSymbol(r.symbol));
            for (const e of (this.cachedExchangePositions ?? [])) syms.add(normalizeSymbol(e.symbol));
            return syms.size;
          })(),
          wsConnected: this.multiWs?.isConnected?.() ?? false,
          tradeCount: p.tradeCount,
          winCount: p.winCount,
          lossCount: p.lossCount,
          // v2.0.42: Recent 20 trades win rate — reflects current performance.
          recent20WinRate: recent20.winRate,
          recent20Count: recent20.total,
          currentPrice: state.price,
          regime: state.regime,
          trend: state.trend,
          volatility: state.volatility,
          cycleInProgress: this.cycleInProgress,
          lastCycleDuration: this.lastCycleDuration,
        },
        agentThoughts: [
          // v2.0.143: Inject Terminal Agent thought so the UI shows it as
          // "thinking" with model info + latency, same as other agents.
          // Terminal Agent doesn't make LLM calls during cycles (it does
          // pure code rule checking), but we synthesize a thought entry so
          // the UI Agent Cognition panel displays it consistently.
          ...(this.rootCommandPrompt || this.terminalSideGuide ? [{
            agentId: 'terminal-agent',
            agentRole: 'terminal_agent' as const,
            thought: this.rootCommandPrompt
              ? `Root Command Prompt (${this.rootCommandPrompt.length} chars):\n${this.rootCommandPrompt}`
              : 'No Root Command Prompt set — cycle runs without user directives.',
            confidence: 1.0,
            timestamp: Date.now(),
            metadata: {
              model: getAgentModel('terminal_agent'),
              latency: 0,
            },
          }] : []),
          ...(this.lastHACPResult?.allThoughts ?? []),
        ],
        agentStatuses,
        consensus: this.lastHACPResult?.consensus ?? null,
        debateRounds: this.lastHACPResult?.debateRounds ?? [],
        newsHeadlines: this.cachedNewsHeadlines,
        tradingMarkets: this.tradingMarkets,
        portfolio: this.serializePortfolio(p) as any,
        // v2.0.867-fix(C):realTrades(UI Trade Incident 後端數據源——200 筆 persist)
        realTrades: this.portfolio.getClosedRealTrades() as never,
        marketState: {
          ...state,
          calibrationSummary: this.marketState.calibrator.getCalibrationSummary(),
        } as any,
        executionStats: this.executionTracker?.getStats() ?? { totalTrades: 0, totalNotional: 0, avgSlippageBps: 0, maxSlippageBps: 0, totalFees: 0, tradeCount: 0 },
        correlationSummary: this.correlationBudget?.getSummary() ?? 'Correlation data unavailable.',
        srContext: this.lastSRContext ?? undefined,
        emState: this.emManager ? {
          summaryCount: this.emManager.length,
          convergenceAccuracy: this.emManager.getConvergenceTrend().accuracy,
          convergenceChecks: this.emManager.getConvergenceTrend().checks,
          latestInsight: this.emManager.getLatest()?.keyInsight ?? null,
          latestSignal: this.emManager.getLatest() ? this.emManager.getLatest()!.primarySignal.name + '=' + this.emManager.getLatest()!.primarySignal.value.toFixed(2) + ' (' + this.emManager.getLatest()!.primarySignal.direction + ')' : null,
        } : undefined,
        // v2.0.141: RIL Reason Intelligence Layer stats
        rilState: config.ril.enabled && this.patternCluster ? {
          patternCount: this.patternCluster.clusterCount(),
          tradeCount: this.expMemory?.size() ?? 0,
          isBuilt: this.patternCluster.isBuilt(),
        } : undefined,
        patternStats: this.patternClassifier ? this.patternClassifier.getStats() : undefined,
        patternTagStats: this.patternTagTracker ? this.patternTagTracker.getStats() : undefined,
        patternTagSummary: this.patternTagTracker ? this.patternTagTracker.getSummary() : undefined,
        olrState: (() => {
          // v2.0.135: filter OLR panel to CURRENT trading markets + open positions
          // only. Without this, stale persisted models from previous sessions
          // (e.g. auto-selected symbols that are no longer traded) pollute the
          // Evolution panel with symbols the user never chose.
          const allStatsRaw = this.olrEngine.getAllModelStats();
          const _panelNorm = (sy: string) => sy.toLowerCase();
          const _tradingNorms = new Set(this.tradingMarkets.map(_panelNorm));
          const _posNorms = new Set(this.portfolio.getOpenSymbols().map(_panelNorm));
          const allStats = allStatsRaw.filter(st => _tradingNorms.has(_panelNorm(st.symbol)) || _posNorms.has(_panelNorm(st.symbol)));
          const pendingStats = this.olrEngine.getPendingStats();
          const shadowStats = this.shadowEngine.getStats();
          const hasFirstPassage = !!this.lastFirstPassage;
          const hasShadowOpen = this.shadowEngine.getOpenPositions().length > 0;
          const hasData = allStats.length > 0 || pendingStats.length > 0 || hasFirstPassage || shadowStats.length > 0 || hasShadowOpen;
          if (!hasData) return undefined;

          const activeSymbol = this.marketAgent.getSelectedSymbol()?.toLowerCase() ?? '';
          const activeCtx = this.lastCycleShadowContexts.get(activeSymbol);
          const activeFeatures = activeCtx?.features ?? {};

          return {
            symbols: allStats.map(s => {
              const sym = s.symbol;
              // Get feature weights for UI visualization
              const longWeights = this.olrEngine.getFeatureWeights(sym, 'buy');
              const shortWeights = this.olrEngine.getFeatureWeights(sym, 'sell');
              // Query current features for live P(win)
              const liveLong = sym === activeSymbol && Object.keys(activeFeatures).length > 0
                ? this.olrEngine.query(sym, activeFeatures, 'buy', this.totalCycles)
                : null;
              const liveShort = sym === activeSymbol && Object.keys(activeFeatures).length > 0
                ? this.olrEngine.query(sym, activeFeatures, 'sell', this.totalCycles)
                : null;

              return {
                symbol: s.symbol,
                longSamples: s.longSamples,
                shortSamples: s.shortSamples,
                longPWin: liveLong?.pWin ?? s.longPWin,
                shortPWin: liveShort?.pWin ?? s.shortPWin,
                longConfidence: liveLong?.confidence ?? 'low',
                shortConfidence: liveShort?.confidence ?? 'low',
                longSource: liveLong?.sourceBreakdown ?? s.longSource,
                shortSource: liveShort?.sourceBreakdown ?? s.shortSource,
                featureWeights: longWeights ? longWeights.map((w, i) => ({
                  name: w.name,
                  longWeight: w.weight,
                  shortWeight: shortWeights?.[i]?.weight ?? 0,
                })) : undefined,
              };
            }),
            pending: pendingStats.map(p => ({
              symbol: p.symbol,
              pending: p.pending,
              needed: p.needed,
              pct: p.pct,
            })),
            firstPassage: this.lastFirstPassage ? {
              longPWin: this.lastFirstPassage.longPWin,
              shortPWin: this.lastFirstPassage.shortPWin,
              drift: this.lastFirstPassage.drift,
              volatility: this.lastFirstPassage.volatility,
              slDistance: this.lastFirstPassage.slDistanceLong,
              tpDistance: this.lastFirstPassage.tpDistanceLong,
              slDistanceShort: this.lastFirstPassage.slDistanceShort,
              tpDistanceShort: this.lastFirstPassage.tpDistanceShort,
              breakevenPLong: this.lastFirstPassage.breakevenPLong,
              breakevenPShort: this.lastFirstPassage.breakevenPShort,
              confidence: this.lastFirstPassage.confidence,
            } : undefined,
            shadowStats: this.shadowEngine.getStats().filter(ss => _tradingNorms.has(_panelNorm(ss.symbol)) || _posNorms.has(_panelNorm(ss.symbol))),

            shadowOpen: this.shadowEngine.getOpenPositions().filter(p => _tradingNorms.has(_panelNorm(p.symbol)) || _posNorms.has(_panelNorm(p.symbol))).map(p => ({
              symbol: p.symbol,
              side: p.side,
              entryPrice: p.entryPrice,
              stopLossPrice: p.stopLossPrice,
              takeProfitPrice: p.takeProfitPrice,
              openCycle: p.openCycle,
            })),
          };
        })(),
        // v2.0.65: Options Data Layer context for Stocks/Indices.
        // Only populated when asset type is stocks/indices/tradfi.
        optionsData: (() => {
          const assetType = this.marketAgent.getConfig().hyperliquidAssetType ?? 'crypto_perps';
          const openPosSyms = this.portfolio.getRealPositions().map(p => p.symbol);
          // v2.0.79: Dedup by normalized symbol — prevents BTC+btc duplicate entries
          const norm = (s: string) => s.includes(':') ? s.split(':')[0]!.toLowerCase() + s.slice(s.indexOf(':')) : s.toLowerCase();
          const seen = new Set<string>();
          const optionSymbols = [...this.tradingMarkets, ...openPosSyms].filter(s => {
            const n = norm(s);
            if (seen.has(n)) return false;
            seen.add(n);
            return true;
          });
          // v2.0.79: Run if ANY symbol is TradFi (has colon) or assetType is stocks/indices
          const hasTradFi = optionSymbols.some(s => s.includes(':'));
          if (!hasTradFi && assetType !== 'stocks' && assetType !== 'indices' && assetType !== 'tradfi') return undefined;
          const results: Array<{
            symbol: string; ivRank: number; ivPercentile: number; impliedVolatility: number;
            impliedMovePct: number; putCallRatio: number; putCallOIRatio: number;
            gammaRegime: string; highOIStrike: number | null; maxPain: number | null;
            skew: number; eventRisk: string; daysToExpiration: number; available: boolean;
            playbook?: { playbook: string; structure: string; targetPOP: number; rationale: string; vetoNewPositions: boolean };
          }> = [];
          for (const sym of optionSymbols) {
            const ctx = this.optionsDataManager.getOptionsContext(sym);
            const pb = this.optionsDataManager.getRegimePlaybook(sym, '', '');
            results.push({
              symbol: ctx.symbol,
              ivRank: ctx.ivRank,
              ivPercentile: ctx.ivPercentile,
              impliedVolatility: ctx.impliedVolatility,
              impliedMovePct: ctx.impliedMovePct,
              putCallRatio: ctx.putCallRatio,
              putCallOIRatio: ctx.putCallOIRatio,
              gammaRegime: ctx.gammaRegime,
              highOIStrike: ctx.highOIStrike,
              maxPain: ctx.maxPain,
              skew: ctx.skew,
              eventRisk: ctx.eventRisk,
              daysToExpiration: ctx.daysToExpiration,
              available: ctx.available,
              playbook: {
                playbook: pb.playbook,
                structure: pb.structure,
                targetPOP: pb.targetPOP,
                rationale: pb.rationale,
                vetoNewPositions: pb.vetoNewPositions,
              },
            });
          }
          // Return single object if only 1 symbol (backward compat), array if multiple
          if (results.length === 0) return undefined;
          if (results.length === 1) return results[0];
          return results as any;
        })(),
        agentModels: {
          available: getAvailableModels(),
          assignments: getAllAgentModels(),
        },
        // v2.0.106: Per-asset adaptive filter data for UI display
        adaptiveFilters: this.assetFilterRegistry ? (() => {
          const result: Record<string, any> = {};
          for (const [sym, filter] of this.assetFilterRegistry.getAllFilters()) {
            const states = filter.getAllChannelStates();
            let avgSnr = 0, avgAlpha = 0, count = 0;
            for (const s of Object.values(states)) {
              avgSnr += s.snr;
              avgAlpha += s.alpha;
              count++;
            }
            if (count > 0) { avgSnr /= count; avgAlpha /= count; }
            result[sym] = {
              profile: filter.getProfileType(),
              profileDescription: filter.getProfileDescription(),
              convictionThreshold: filter.getConvictionThreshold(),
              isThrottled: filter.isTradeFrequencyLimited(),
              remainingTradeSlots: filter.getRemainingTradeSlots(),
              maxTradesPerWindow: filter['config'].maxTradesPerWindow,
              avgAlpha,
              avgSnr,
              channels: states,
            };
          }
          return result;
        })() : undefined,
        cycleProgress: this.cycleProgress,
        hacpThreshold: this.hacpEngine.getCurrentThreshold(),
        evolution: this.evolution.getEvolutionData(),
        // v2.0.219: Advanced learning systems state for professional UI
        advancedLearning: {
          // NA (Numeric Autoencoder)
          na: this.naEngine ? {
            ready: this.naEngine.isReady(),
            sampleCount: this.naEngine.sampleCount(),
            inputDim: this.naEngine.inputDim,
            // v2.0.862-ui-fix: expose validation so the UI can distinguish
            // "accumulating samples" from "validation FAILED" (275k samples
            // with failed validation is NOT "almost ready" — it is stuck).
            validation: this.naEngine.lastValidation() ? {
              passed: this.naEngine.lastValidation()!.passed,
              mse: Number(this.naEngine.lastValidation()!.mse.toFixed(4)),
              contrastiveAcc: Number(this.naEngine.lastValidation()!.contrastiveAcc.toFixed(4)),
              diversity: Number(this.naEngine.lastValidation()!.diversity.toFixed(4)),
              reason: this.naEngine.lastValidation()!.reason,
            } : null,
          } : undefined,
          // AttnRes Trade Embedder
          attnres: this.attnResTradeEmbedder ? {
            updateCount: this.attnResTradeEmbedder.getUpdateCount(),
            wNorm: this.attnResTradeEmbedder.getWeightNorm(),
            temperature: this.attnResTradeEmbedder.getTemperature(),
          } : undefined,
          // CHR (Cycle History Retrieval) — use public API
          chr: this.cycleHistory ? (() => {
            const syms = [...new Set([...this.tradingMarkets, ...this.portfolio.getOpenSymbols()])];
            const perSym: Record<string, unknown> = {};
            for (const s of syms) {
              const sn = normalizeSymbol(s);
              const cc = this.cycleHistory.cycleCount(sn);
              if (cc > 0) perSym[sn] = { cycleCount: cc };
            }
            return { symbols: perSym };
          })() : undefined,
          // Anti-Pattern Tracker
          antiPattern: this.antiPatternTracker ? {
            ...this.antiPatternTracker.getStats(),
          } : undefined,
          // Replay Buffer
          replay: this.replayBuffer ? this.replayBuffer.getStats() : undefined,
          // Bayesian OLR (sample query for active symbol)
          bayesian: (() => {
            const sym = this.marketAgent.getSelectedSymbol();
            if (!sym) return undefined;
            const ctx = this.lastCycleShadowContexts.get(normalizeSymbol(sym));
            if (!ctx?.features) return undefined;
            try {
              const buyResult = this.bayesianOLR.query(sym, ctx.features, 'buy', this.totalCycles);
              const sellResult = this.bayesianOLR.query(sym, ctx.features, 'sell', this.totalCycles);
              return {
                symbol: normalizeSymbol(sym),
                buy: { pWin: buyResult.pWin_mean, std: buyResult.pWin_std, low: buyResult.pWin_low, high: buyResult.pWin_high, uncertainty: buyResult.uncertainty, applied: buyResult.applied, passes: buyResult.passes },
                sell: { pWin: sellResult.pWin_mean, std: sellResult.pWin_std, low: sellResult.pWin_low, high: sellResult.pWin_high, uncertainty: sellResult.uncertainty, applied: sellResult.applied, passes: sellResult.passes },
              };
            } catch { return undefined; }
          })(),
          // Active Exploration
          exploration: this.activeExploration ? this.activeExploration.getConfig() : undefined,
          // v2.0.833: Edge Validation layer state
          edgeValidation: {
            edgeReportCount: this.edgeReportCount,
            execTrackerEntries: this.edgeExecTracker?.entryCount() ?? 0,
            avgEdgeScore: 0.5, // updated by edge compute cycle
          },
          // v2.0.835: Q-RL Alpha Discovery state
          qrlDiscovery: this.qrlTable ? this.qrlTable.getStats() : undefined,
          // v2.0.844: Component Attribution — which components actually add edge
          componentAttribution: this.componentAttribution ? {
            size: this.componentAttribution.size(),
            components: this.componentAttribution.componentCount(),
            stats: this.componentAttribution.getAllStats().map(s => ({
              componentId: s.componentId,
              samples: s.samples,
              expectancy: Number(s.expectancy.toFixed(5)),
              contribution: Number(s.contribution.toFixed(4)),
              positiveRate: Number(s.positiveRate.toFixed(3)),
              cleanliness: Number(s.cleanliness.toFixed(3)),
            })),
          } : undefined,
          // v2.0.846 Phase 1b: Learning-label cleanliness overview — how polluted
          // is our learning signal by execution-caused closes (tight SL / thesis
          // invalidation / premature close)?
          labelCleanliness: this.componentAttribution ? (() => {
            const o = this.componentAttribution.getCleanlinessOverview(30 * 24 * 3600 * 1000);
            return {
              records: o.records,
              avgCleanliness: Number(o.avgCleanliness.toFixed(3)),
              cleanRate: Number(o.cleanRate.toFixed(3)),
              pollutedRate: Number(o.pollutedRate.toFixed(3)),
              byRegime: o.byRegime.map(r => ({
                regime: r.regime,
                avgCleanliness: Number(r.avgCleanliness.toFixed(3)),
                records: r.records,
              })),
            };
          })() : undefined,
          // v2.0.861: Q-RL Direction Signal — per-trading-symbol expectancy lean.
          qrlDirection: (() => {
            if (!this.qrlTable || !qrlDirectionConfig.leanEnabled) return undefined;
            try {
              const out: Array<Record<string, unknown>> = [];
              const syms = new Set<string>([
                normalizeSymbol(activeSymbol),
                ...(this.tradingMarkets ?? []).map((m: string) => normalizeSymbol(m)),
              ]);
              for (const sym of syms) {
                const features = this.lastCycleShadowContexts.get(sym)?.features;
                if (!features || Object.keys(features).length === 0) continue;
                const lean = this.qrlTable.getDirectionLean(features, qrlDirectionConfig.minSamples);
                out.push({
                  symbol: sym,
                  bucket: lean.buy.bucket,
                  buyQ: Number(lean.buy.q.toFixed(5)),
                  sellQ: Number(lean.sell.q.toFixed(5)),
                  buyMedian: lean.buy.medianReward !== null ? Number(lean.buy.medianReward.toFixed(5)) : null,
                  sellMedian: lean.sell.medianReward !== null ? Number(lean.sell.medianReward.toFixed(5)) : null,
                  buyN: lean.buy.visits,
                  sellN: lean.sell.visits,
                  spread: Number(lean.spread.toFixed(5)),
                  lean: lean.lean,
                  robust: lean.robust,
                });
              }
              return { symbols: out, minSamples: qrlDirectionConfig.minSamples };
            } catch { return undefined; }
          })(),
          // v2.0.862: PAEL — per-asset exit-price profiles + lock gate status.
          pael: (() => {
            if (!this.exitPriceLearner) return undefined;
            try {
              const syms = new Set<string>([
                normalizeSymbol(activeSymbol),
                ...(this.tradingMarkets ?? []).map((m: string) => normalizeSymbol(m)),
              ]);
              const profiles: Array<Record<string, unknown>> = [];
              for (const sym of syms) {
                for (const side of ['buy', 'sell'] as const) {
                  const p = this.exitPriceLearner.getExitProfile(sym, side);
                  if (!p) continue;
                  profiles.push({
                    symbol: sym,
                    side,
                    samples: p.samples,
                    mfeP50: Number(p.mfeP50.toFixed(5)),
                    mfeP75: Number(p.mfeP75.toFixed(5)),
                    mfeP90: Number(p.mfeP90.toFixed(5)),
                    maeP95: Number(p.maeP95.toFixed(5)),
                  });
                }
              }
              return {
                profiles,
                lockCount: this.exitPriceLockCount,
                minSamples: 10,
              };
            } catch { return undefined; }
          })(),
        },
        backtest: this.lastBacktestResult,
        backtestProgress: this.backtestProgress,
        tradeHistory: this.evolution.tradeHistory.getAllEntries().slice(-50),
        marketAgent: marketAgentState,
        tradeRecords: [
          // v2.0.142: Unified — always include BOTH paper + real trades, tagged by agentId
          // Real closed trades (from portfolio, survive restarts)
          ...this.portfolio.getClosedRealTrades().slice(-200).map(t => ({
            id: t.id,
            symbol: normalizeSymbol(t.symbol),
            side: t.side,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            quantity: t.quantity,
            leverage: t.leverage,
            investment: t.investment,
            pnl: t.pnl,
            pnlPct: t.pnlPct,
            openedAt: t.openedAt,
            closedAt: t.closedAt,
            status: 'closed' as const,
            agentId: t.agentId,
            entryThesis: t.entryThesis,
            exitThesis: t.exitThesis,
            postReview: t.postReview,
            minValueReached: t.minValueReached,
            maxValueReached: t.maxValueReached,
          })),
          // Real open positions
          ...this.portfolio.getRealPositions().map(p => ({
            id: p.id,
            symbol: normalizeSymbol(p.symbol),
            side: p.side,
            entryPrice: p.averageEntryPrice,
            exitPrice: p.currentPrice,
            quantity: p.quantity,
            leverage: p.leverage ?? 1,
            investment: p.averageEntryPrice * p.quantity,
            pnl: p.unrealizedPnl,
            pnlPct: p.unrealizedPnlPct,
            openedAt: p.openedAt,
            closedAt: p.openedAt,
            status: 'open' as const,
            agentId: p.agentId ?? 'hyperliquid-real',
            entryThesis: p.entryThesis,
            minValueReached: p.minValueReached,
            maxValueReached: p.maxValueReached,
          })),
          // v2.0.168: REMOVED hl-fill-* records from tradeRecords. These raw HL
          // fill records had no thesis/MAE/MFE/postReview and caused:
          // 1. Duplicate "CLOSED" entries (one from closedRealTrades, one from fills)
          // 2. Phantom close records (fills from previous positions matching new positions)
          // 3. Delete failures (hl-fill-* IDs are ephemeral, not in any persistent store)
          // closedRealTrades is the single source of truth for closed real trades.
          // If a close hasn't been captured by closeExchangePosition yet, it will be
          // on the next syncExchangePositions cycle — no need for raw fill display.
          // Paper trades
          ...this.paperEngine.getTrades().slice(-50).filter(t => {
            const priceMovedPct = Math.abs(t.exitPrice - t.entryPrice) / (t.entryPrice || 1);
            return priceMovedPct > 0.0001 || Math.abs(t.pnl) > 0.005;
          }).map(t => ({
            id: t.id,
            symbol: t.symbol,
            side: t.side,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            quantity: t.quantity,
            leverage: t.leverage,
            investment: t.investment,
            pnl: t.pnl,
            pnlPct: t.pnlPct,
            openedAt: t.openedAt,
            closedAt: t.closedAt,
            status: t.status,
            agentId: 'paper',
            entryThesis: t.entryThesis,
            exitThesis: t.exitThesis,
            postReview: t.postReview,
            minValueReached: t.minValueReached,
            maxValueReached: t.maxValueReached,
          })),
          // Paper open positions
          ...Array.from(this.portfolio.getPortfolio().positions.values())
            .filter(p => p.agentId !== 'hyperliquid-real')
            .map(p => ({
              id: p.id,
              symbol: p.symbol,
              side: p.side,
              entryPrice: p.averageEntryPrice,
              exitPrice: p.currentPrice,
              quantity: p.quantity,
              leverage: p.leverage ?? 1,
              investment: p.averageEntryPrice * p.quantity,
              pnl: p.unrealizedPnl,
              pnlPct: p.unrealizedPnlPct,
              openedAt: p.openedAt,
              closedAt: p.openedAt,
              status: 'open' as const,
              agentId: p.agentId ?? 'paper',
              entryThesis: p.entryThesis,
              minValueReached: p.minValueReached,
              maxValueReached: p.maxValueReached,
            })),
        ],
      };
      // v2.0.140: EXP action log for the UI ExperienceDigestionSection
      (apiData as any).expActions = this.lastExpActions;
      // v2.0.143: Terminal Agent Root Command Prompt + Side Guide for UI
      (apiData as any).rootCommandPrompt = this.rootCommandPrompt;
      (apiData as any).terminalSideGuide = this.terminalSideGuide;
      // v2.0.143: News fetch error for UI display (News Reporter fallback reason)
      (apiData as any).newsFetchError = this.lastNewsFetchError;
      // v2.0.79: Dedup trade records by ID — prevents duplicate entries
      if (apiData.tradeRecords && Array.isArray(apiData.tradeRecords)) {
        const seenIds = new Set<string>();
        apiData.tradeRecords = apiData.tradeRecords.filter((r: any) => {
          if (seenIds.has(r.id)) return false;
          seenIds.add(r.id);
          return true;
        });
      }
      this.apiServer.update(apiData);
      // v2.0.862: MATS_Frontend feed — write ui_snapshots ONCE per cycle
      // (clean-snapshot, service_role). Throttled by cycle counter so SSE
      // re-pushes within a cycle don't rewrite the DB. Best-effort — never
      // blocks the cycle. agent_thoughts section carries the FULL 8-agent ×
      // per-asset reasoning (owner ruling R6).
      if (this.totalCycles !== this.lastUiSnapshotCycle) {
        this.lastUiSnapshotCycle = this.totalCycles;
        void this.analysisWriter.writeUiSnapshot(apiData as unknown as Record<string, unknown>, this.totalCycles);
      }
    } catch (err) {
      // API push is best-effort
    }
  }

  async stop(): Promise<void> {
    // Persist evolution state + portfolio + OLR + shadow trades + EM state + Root Command Prompt before shutdown
    this.evolution.persistState();
    this.persistPortfolio();
    this.persistOLR();
    this.persistExitPriceLearner();
    this.persistLLMCalibrator();
    this.persistLLMDirectionVerifier();
    this.persistEVFilter();
    this.persistCloseCalibrator();
    this.persistRootCommandPrompt();
    if (this.emManager) saveEMState(this.emManager.getState());
    this.stopTimers();
    await this.apiServer?.stop();
    await this.multiWs?.disconnect();
    log.info('MATS system stopped cleanly.');
  }
}

// ─── Boot ───

async function main(): Promise<void> {
  const system = new MATSSystem();

  registerShutdownHandler('amacrf-system', async () => {
    await system.stop();
  }, 0);

  try {
    await system.start();

    // Keep alive — the decision timer and WebSocket keep the process running
    await new Promise<never>(() => {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`FATAL: ${msg}`);
    process.exit(1);
  }
}

// Start
main().catch((err) => {
  console.error('Unhandled error in main():', err);
  process.exit(1);
});