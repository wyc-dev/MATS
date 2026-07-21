// ─── MATS Main Entry Point ───
// System orchestrator — ties together data, agents, cognition, risk, trading, evolution

import { config } from './config/index.ts';
import { rootLogger, createLogger } from './observability/logger.ts';
import { setupShutdownHandlers, registerShutdownHandler, isShuttingDown } from './utils/shutdown.ts';
import { hlRateLimitedFetch } from './utils/hl-global-limiter.ts';
import { initializeLLM, getActiveProviderType } from './llm/index.ts';
import { getActiveProvider } from './llm/index.ts';
import { getAgentModel } from './agents/agent-models.ts';
import { BinanceWebSocketManager, MarketStateAggregator, type AggregatedMarketState } from './data/binance-websocket.ts';
import { HyperliquidWebSocketManager } from './data/hyperliquid-websocket.ts';
import { MultiExchangeWebSocketManager, detectExchange, type UnifiedPrice, type UnifiedOrderBook } from './data/multi-exchange-ws.ts';
import { HACPEngine } from './cognition/hacp.ts';
import { RiskEngine } from './risk/engine.ts';
import { PortfolioTracker, normalizeSymbol, isThesisPlaceholder } from './trading/portfolio.ts';
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
import { ThesisExperience, ActiveProviderLLMCaller } from './evolution/thesis-experience.ts';
import {
  PatternClusterManager,
  CloseReasonAggregator,
  SimilarTradeRetriever,
  SubtleDiffAnalyzer,
  formatAnalyticsBlock,
} from './evolution/reason-analytics.ts';
import { TransformersEmbedProvider } from './evolution/embeddings.ts';
import { SentimentEngine } from './analysis/sentiment-engine.ts';
import { AdaptiveNoiseFilter, AssetFilterRegistry, type MarketContext as FilterMarketContext, type FilterProfileType } from './analysis/adaptive-filter.ts';
import { PlanckChaosEngine } from './analysis/planck-chaos.ts';
import { SystemGuard } from './system-guard/index.ts';
import { ExecutionTracker } from './trading/execution-tracker.ts';
import { CorrelationBudget } from './risk/correlation-budget.ts';
import { calculateTakerFee, calculateFundingCost, getFeeSummary } from './trading/cost-model.ts';
import { getSRZones } from './analysis/support-resistance.ts';
import { CycleSummaryManager } from './evolution/cycle-summary.ts';
import { TradePatternClassifier } from './evolution/trade-pattern-classifier.ts';
import { PatternTagTracker } from './evolution/pattern-tag-tracker.ts';
import { OLREngine, type OLRQueryResult, regimeToOrdinal } from './evolution/olr-engine.ts';
import { ShadowTradeEngine } from './evolution/shadow-trade-engine.ts';
import { calculateFirstPassage, estimateDrift, estimateVolatility, type FirstPassageResult } from './evolution/first-passage.ts';
import { backfillOLRFromCandles, type HLCandle, type CandleFetcher } from './evolution/olr-backfill.ts';
import { wilsonScore } from './evolution/evolution-utils.ts';
import { auditTradeRecordsLLM, type AuditResult } from './evolution/direction-audit.ts';
import { runSystemEngineer } from './evolution/system-engineer.ts';
import { getOptionsDataManager, formatOptionsForAgent, formatPlaybookForAgent } from './analysis/options-data.ts';
import { fetchNewsSentiment, formatNewsForAgent, fetchNewsForSymbols, formatNewsForAgentMulti, fetchGlobalBreakingNews, formatGlobalNewsForMetaAgent, computePriceNewsTiming, normalizeBaseAsset, type TimingCandle } from './analysis/news-sentiment.ts';
import type { ConsensusResult, Ticker, AgentThought, AgentStatus, DebateRound, CycleProgress, TradingDecision, MarketAgentConfig, TopVolumePair, MultiSymbolDecision, AgentRole, ExchangeAccountInfo, TradeRecord, CycleSummary } from './types/index.ts';

const log = createLogger({ phase: 'system' });

/** v2.0.720: Check if an audit category string mentions a specific direction.
 *  Used by the audit gate to match critical incidents to candidate decisions. */
function catDirMentionDirection(category: string, dir: 'buy' | 'sell'): boolean {
  if (dir === 'buy') return category.includes('buy') || category.includes('long');
  return category.includes('sell') || category.includes('short');
}

class MATSSystem {
  private marketState!: MarketStateAggregator;
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
  private sentimentEngine!: SentimentEngine;
  /** v2.0.105: Adaptive noise filter — sigmoid+EMA with per-cycle auto-tuning */
  private adaptiveFilter!: AdaptiveNoiseFilter;
  /** v2.0.106: Per-asset filter registry — each asset gets its own filter */
  private assetFilterRegistry!: AssetFilterRegistry;
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
  private lastSRContext: { formatted: string; regime: string; zoneCount: number; strongZones: number; nearestSupport: number | null; nearestResistance: number | null; distanceToSupportBps: number; distanceToResistanceBps: number; degradedReason: string | null } | null = null;
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
  private patternClassifier!: TradePatternClassifier;
  private patternTagTracker!: PatternTagTracker;
  /** OLR (Online Logistic Regression) engine — learns P(win) from shadow + real trade outcomes. */
  private olrEngine!: OLREngine;
  /** Shadow Trade Engine — opens simulated LONG+SHORT each cycle, tracks TP-before-SL outcomes. */
  private shadowEngine!: ShadowTradeEngine;
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
    /** v2.0.732: Per-regime win/loss tracking for condition-aware gating. */
    regimeStats: Map<string, { trades: number; wins: number; volatility: number }>;
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
  private updateLossStreakTracker(symbol: string, direction: 'buy' | 'sell', isWin: boolean): void {
    const key = `${normalizeSymbol(symbol)}:${direction}`;
    let entry = this.lossStreakTracker.get(key);
    if (!entry) {
      entry = { consecutiveLosses: 0, blockedUntilCycle: 0, totalTrades: 0, totalWins: 0, regimeStats: new Map() };
      this.lossStreakTracker.set(key, entry);
    }

    entry.totalTrades++;

    // v2.0.732: Track per-regime stats for condition-aware gating
    const regime = this.marketState.getState(symbol)?.regime
      ?? this.marketState.getState(this.marketAgent.getConfig().selectedSymbol)?.regime
      ?? 'unknown';
    const volatility = this.marketState.getState(symbol)?.volatility ?? 0;
    let regimeStat = entry.regimeStats.get(regime);
    if (!regimeStat) {
      regimeStat = { trades: 0, wins: 0, volatility: 0 };
      entry.regimeStats.set(regime, regimeStat);
    }
    regimeStat.trades++;
    regimeStat.volatility = volatility; // latest volatility for this regime
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
      (this as any)._lossStreakPenalty = -winnerBoost;

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
    const netPenalty = lossPenalty;

    (this as any)._lossStreakPenalty = netPenalty;

    if (netPenalty > 0) {
      log.info(`🚡 [loss-streak-soft] ${action.toUpperCase()} ${symbol}: conviction +${(netPenalty * 100).toFixed(0)}% (${gateResult.reason?.slice(0, 60)}) — no winner pattern found, applying loss penalty`);
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
      } catch { /* start fresh */ }
      log.info('✓ OLR + Shadow Trade Engine ready');

      // v2.0.143: Load persisted Root Command Prompt so it survives backend restarts.
      this.loadRootCommandPrompt();

      // 3.10b: Cold-start OLR backfill helper — defined here, invoked lazily
      // on the first decision cycle with non-empty trading markets (markets
      // may arrive from UI or persistence after init completes).


      // 3.11 Initialize Trade Pattern Classifier (kept for position management only)
      log.info('Step 3.11/8: Initializing Trade Pattern Classifier...');
      this.patternClassifier = new TradePatternClassifier();
      this.patternClassifier.load();
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

      // 6. Start API Server
      log.info('Step 6/7: Starting API server...');
      this.apiServer = new APIServer(config.system.apiPort ?? 3456);
      this.apiServer.setShutdownHandler(() => {
        log.info('Shutdown handler called from API');
        void this.stop();
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
          const margin = (trade.entryPrice * trade.quantity) / (trade.leverage ?? 1);
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
      let selectSymbolTimer: ReturnType<typeof setTimeout> | null = null;
      this.apiServer.setMarketAgentSelectSymbolHandler((symbol) => {
        if (selectSymbolTimer) clearTimeout(selectSymbolTimer);
        selectSymbolTimer = setTimeout(() => {
          log.info(`Market Agent: manual symbol selection → ${symbol}`);
          this.marketAgent.setSelectedSymbolManual(symbol);
          this.pushToAPI();
          // v2.0.110: No cycle trigger here — trading-markets handler handles it.
          // If this was a pure symbol switch (not a trading market add),
          // the next scheduled cycle (300s) will pick it up.
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
      let lastTradingMarketsAccept = 0;
      const TRADING_MARKETS_THROTTLE_MS = 3000;
      this.apiServer.setTradingMarketsHandler((markets) => {
        // Skip if markets haven't changed
        const prevJson = JSON.stringify(this.tradingMarkets);
        const newJson = JSON.stringify(markets);
        if (prevJson === newJson) return;
        // v2.0.114: Throttle — skip if within throttle window
        const now = Date.now();
        if (now - lastTradingMarketsAccept < TRADING_MARKETS_THROTTLE_MS) {
          log.debug(`Trading markets POST throttled (within ${TRADING_MARKETS_THROTTLE_MS}ms window): ${markets.join(', ')}`);
          return;
        }
        lastTradingMarketsAccept = now;
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
        const keys = ['HYPERLIQUID_WALLET_ADDRESS', 'HYPERLIQUID_PRIVATE_KEY', 'OLLAMA_API_KEY', 'MASSIVE_API_KEY', 'OLLAMA_PLAN', 'TELEGRAM_BOT_API', 'TELEGRAM_CHAT_ID'];
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
          const envPath = path.join(process.cwd(), '.env');
          let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
          for (const [key, value] of Object.entries(settings)) {
            // Skip if value is masked (contains ••••) — means user didn't change it
            if (value.includes('••••')) continue;
            // Update or add the env var
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
          const closeSuccess = await this.closeTrade(sym, 'Manual close by user');
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
            const closeSuccess = await this.closeTrade(sym, 'Close-all before Trade Mode switch');
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
            await this.closeTrade(sym, `Manual flip: closing ${existing!.side.toUpperCase()} to open ${action.toUpperCase()}`);
          }

          // Fetch current price
          let price = 0;
          try {
            const priceData = await this.marketAgent.fetchPriceForSymbol(sym);
            price = priceData.price;
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
                const priceData2 = await this.marketAgent.fetchPriceForSymbol(selected);
                price = priceData2.price;
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
              this.portfolio.softUpdatePosition(sym, p.entryPx);
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
              const expectedCloseSideRaw = pos.side === 'buy' ? 'A' : 'B';
              if (fill.side !== expectedCloseSideRaw) {
                log.info(`📡 HL WS closing fill ${fill.symbol} side=${fill.side} doesn't match closing side ${expectedCloseSideRaw} for ${pos.side} position — skipping (may be from a previous position)`);
              } else {
                log.info(`📡 HL WS closing fill: ${fill.symbol} ${fill.side} ${fill.size} @ ${fill.price} dir=${fill.dir} closedPnl=${fill.closedPnl} — closing local mirror immediately`);
                // Close the local mirror with the actual HL fill price + realized PnL
                this.portfolio.closeExchangePosition(sym, fill.price, fill.closedPnl);
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
      this.multiWs = new MultiExchangeWebSocketManager(null as any, this.hyperliquidWs);
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
        embed: new TransformersEmbedProvider(),
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
          this.emManager.setEmbedProvider(new TransformersEmbedProvider());
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
        const embed = new TransformersEmbedProvider();
        this.patternCluster = new PatternClusterManager(embed);
        this.closeReasonAgg = new CloseReasonAggregator();
        this.similarTradeRetriever = new SimilarTradeRetriever();
        this.subtleDiffAnalyzer = new SubtleDiffAnalyzer();
        // Rebuild clusters from EXP records (non-blocking)
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

      // v2.0.29: Clean up legacy position tracking when a position closes
      if (this.legacyPositionModes.has(symbol)) {
        const origMode = this.legacyPositionModes.get(symbol);
        this.legacyPositionModes.delete(symbol);
        log.info(`📋 Legacy position ${symbol} (from ${origMode} mode) closed: ${isWin ? 'WIN' : 'LOSS'} $${trade.pnl.toFixed(2)}`);
      }

      // Get current market context for learning
      const activeSymbol = this.marketAgent?.getSelectedSymbol()?.toLowerCase() ?? symbol;
      const state = this.marketState?.getState(activeSymbol) ?? null;
      const regime = state?.regime ?? 'unknown';
      const volatility = state?.volatility ?? 0;
      const srDistanceBps = this.lastSRContext?.distanceToSupportBps ?? 0;
      const obImbalance = state?.orderBookImbalance ?? 0;
      const fundingRate = this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0;
      const volumeRatio = this.sentimentEngine?.getVolumeRatio() ?? 1;
      const sentimentAgg = this.sentimentEngine?.getSentiment();
      const sentiment = sentimentAgg?.overallSentiment ?? 0;
      const sentimentConviction = sentimentAgg?.conviction ?? 0.5;
      // v2.0.721: Use last HACP consensus confidence instead of hardcoded 0.5.
      // This fixes a train/test mismatch — query-time features use real consensus
      // confidence (index.ts:5370+), but close-learning was always 0.5, so OLR
      // trained on a constant feature that varied at query time.
      const signalAgreement = this.lastHACPResult?.consensus?.confidence ?? 0.5;

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
        const mae = trade.minValueReached ?? 0;
        const mfe = trade.maxValueReached ?? 0;
        const margin = trade.investment > 0 ? trade.investment / (trade.leverage ?? 1) : 0;
        const maePct = margin > 0 ? (margin - mae) / margin : 0;
        const mfePct = margin > 0 ? (mfe - margin) / margin : 0;
        const features = {
          volatility,
          srDistanceBps,
          obImbalance,
          sentiment,
          signalAgreement,
          fundingRate,
          volumeRatio,
          sentimentConviction,
          // v2.0.152: MFE/MAE features for SL/TP learning
          mfePct,
          maePct,
          mfeToPnlRatio: mfePct > 0 ? (mfePct - pnlPct) / mfePct : 0, // 0 = perfect exit, 1 = gave back everything
          // v2.0.721: Regime as ordinal feature (H1)
          regimeOrdinal: regimeToOrdinal(regime),
        };
        const tradeSource: 'paper' | 'real' = trade.agentId === 'hyperliquid-real' ? 'real' : 'paper';
        this.olrEngine.feedTrade(symbol, features, outcome, trade.side === 'buy' ? 'buy' : 'sell', tradeSource, this.totalCycles);
        log.info(`🧬 [close-learning] OLR fed (${tradeSource}): ${symbol} ${trade.side.toUpperCase()} ${isWin ? 'WIN' : 'LOSS'} (pnl=${(pnlPct * 100).toFixed(1)}%, MFE=${(mfePct * 100).toFixed(1)}%, MAE=${(maePct * 100).toFixed(1)}%)`);
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

      // v2.0.138: Feed EXP thesis-experience memory (Skeptics Phase 1.8a).
      // Fire-and-forget — recordClose is async but must NEVER block the close path.
      // It honours config.exp.enabled, breakeven-exclude, and placeholder-thesis internally.
      try {
        const holdMin = Math.max(0, Math.round((trade.closedAt - trade.openedAt) / 60_000));
        const expSource: 'paper' | 'real' = trade.agentId === 'hyperliquid-real' ? 'real' : 'paper';
        void this.expMemory?.recordClose({
          symbol,
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
          olrPWinAtEntry: (() => {
            try {
              const sym = normalizeSymbol(symbol);
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
        this.updateLossStreakTracker(symbol, trade.side === 'buy' ? 'buy' : 'sell', isWin);
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
      const margin = (trade.entryPrice * trade.quantity) / (trade.leverage ?? 1);
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
        const margin = (t.quantity ?? 0) * (t.entryPrice ?? 0) / (t.leverage ?? 1);
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
   */
  private async executeTrade(
    decision: TradingDecision,
    auditGates: Array<{ gate: string; passed: boolean; reason: string }>,
  ): Promise<{ success: boolean; error?: string; paperReports?: any[] }> {
    const isRealMode = this.tradingManager.getTradeMode() === 'real';

    if (isRealMode) {
      // Real mode: TradingManager places the order on HL + mirrors via
      // importExchangePosition. entryThesis is set after execution succeeds.
      const execResult = await this.tradingManager.executeDecision(decision);
      if (execResult.success && (decision.action === 'buy' || decision.action === 'sell')) {
        if (decision.entryThesis) {
          this.portfolio.setEntryThesis(decision.symbol, decision.entryThesis);
        }
        // v2.0.726: Reset cycles-since-last-trade counter
        this.cyclesSinceLastTrade = 0;
      }
      return execResult;
    }

    // Paper mode: execute directly via PaperTradingEngine.
    // No TradingManager involvement — clean separation.
    const reports = await this.paperEngine.executeDecision(decision);
    const success = reports.length === 0 || reports.every(r => !r.error);
    if (success && (decision.action === 'buy' || decision.action === 'sell')) {
      // PaperTradingEngine.openPosition already sets entryThesis from
      // decision.entryThesis, but setEntryThesis is a belt-and-suspenders
      // fix in case the position was re-imported without thesis.
      if (decision.entryThesis) {
        this.portfolio.setEntryThesis(decision.symbol, decision.entryThesis);
      }
      // v2.0.726: Reset cycles-since-last-trade counter
      this.cyclesSinceLastTrade = 0;
    }
    return { success, paperReports: reports };
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
   */
  private async closeTrade(symbol: string, exitThesis: string): Promise<boolean> {
    const sym = symbol.includes(':') ? symbol : symbol.toLowerCase();
    const pos = this.portfolio.getPosition(sym);
    if (!pos) return false;

    // Set exit thesis before closing (captured in TradeRecord at close time)
    this.portfolio.setExitThesis(sym, exitThesis);

    if (pos.agentId === 'hyperliquid-real') {
      // Real position: close on HL first, then locally
      return await this.tradingManager.closePosition(sym);
    } else {
      // Paper position: close locally
      const state = this.marketState?.getState(sym);
      const closePrice = state?.price ?? pos.currentPrice ?? 0;
      if (closePrice <= 0) {
        log.error(`closeTrade: no price available for ${sym}`);
        return false;
      }
      const trade = this.portfolio.closePosition(sym, closePrice);
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
      lines.push(`  BUY  P(win)=${(olrBuy.pWin * 100).toFixed(0)}% (${olrBuy.nSamples} samples [${sb(olrBuy)}], conf=${olrBuy.confidence})`);
      lines.push(`  SELL P(win)=${(olrSell.pWin * 100).toFixed(0)}% (${olrSell.nSamples} samples [${sb(olrSell)}], conf=${olrSell.confidence})`);

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
      // v2.0.140: inject EXP digest (only for active symbol — avoids per-symbol duplication)
      if (digest) lines.push(`\n${digest}`);
      return '\n' + lines.join('\n');
    } catch { /* non-critical */ }
    return '';
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
      if (this.marketAgent.getSelectedSymbol() !== activeSymbol) {
        this.marketAgent.setSelectedSymbolManual(activeSymbol);
      }
      log.info(`Cycle symbols: ${allSymbols.join(', ')} (active: ${activeSymbol})`);
      // v2.0.104: Store additional non-position trading markets to inject into currentPositions
      (this as any)._additionalMarkets = nonPositionMarkets.filter(s => s !== activeSymbol);
      log.info(`📊 _additionalMarkets: [${((this as any)._additionalMarkets as string[]).join(', ')}] (tradingMarkets=${this.tradingMarkets.length}, nonPosition=${nonPositionMarkets.length})`);
      // v2.0.108: Record market count at cycle start for post-cycle drift detection
      (this as any)._cycleMarketCount = this.tradingMarkets.length;
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
      (this as any)._cycleMarketCount = this.tradingMarkets.length;
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

    // Fill in volume/change from cached REST data (dex0CtxsCache, no REST call)
    // fetchPriceForSymbol checks internal cache first, falls back to REST only on cache miss
    const priceData = await this.marketAgent.fetchPriceForSymbol(activeSymbol);
    if (priceData.volume24h > 0 && marketVolume24h === 0) {
      marketVolume24h = priceData.volume24h;
    }
    if (marketPrice <= 0 && priceData.price > 0) {
      marketPrice = priceData.price; // REST price as fallback if WS price not available
    }
    marketChange24h = marketChange24h || priceData.change24h;

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
        volatility: symState?.volatility ?? (isActiveSym ? (combined.volatility ?? 0) : 0),
        srDistanceBps: isActiveSym ? (this.lastSRContext?.distanceToSupportBps ?? 0) : 0,
        obImbalance: symState?.orderBookImbalance ?? (isActiveSym ? (combined.orderBookImbalance ?? 0) : 0),
        fundingRate: this.hyperliquidWs?.getMarkPriceForSymbol(sym)?.fundingRate
          ?? this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0,
        volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
        sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
        sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
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
            try { mktChkPrice = (await this.marketAgent.fetchPriceForSymbol(mktSym)).price; } catch { /* keep 0 */ }
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
              mktPrice = (await this.marketAgent.fetchPriceForSymbol(mktSym)).price;
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
            volatility: mktState?.volatility ?? (isActiveSym ? (combinedState.volatility ?? 0) : 0),
            srDistanceBps: isActiveSym ? (this.lastSRContext?.distanceToSupportBps ?? 0) : 0,
            obImbalance: mktState?.orderBookImbalance ?? (isActiveSym ? (combinedState.orderBookImbalance ?? 0) : 0),
            // v2.0.143: Use per-symbol funding rate from HL WS mark price cache,
            // not the global latest mark price (which is for the active symbol).
            fundingRate: this.hyperliquidWs?.getMarkPriceForSymbol(mktSym)?.fundingRate
              ?? this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0,
            // v2.0.143: volumeRatio and sentiment are global (not per-symbol),
            // but we note this in the feature so OLR can learn the global context.
            volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
            sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
            sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
            signalAgreement: 0.5,
          };

          // Use S/R levels for active symbol; default distances for others
          const srSupport = normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol)
            ? (this.lastSRContext?.nearestSupport ?? null) : null;
          const srResistance = normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol)
            ? (this.lastSRContext?.nearestResistance ?? null) : null;

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
        const mktFeatures = {
          volatility: mktState?.volatility ?? (normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? (combinedState.volatility ?? 0) : 0),
          srDistanceBps: normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? (this.lastSRContext?.distanceToSupportBps ?? 0) : 0,
          obImbalance: mktState?.orderBookImbalance ?? (normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? (combinedState.orderBookImbalance ?? 0) : 0),
          fundingRate: this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0,
          volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
          sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
          sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
          signalAgreement: 0.5,
        };
        const mktPrice = normalizeSymbol(mktSym) === normalizeSymbol(activeSymbol) ? combinedState.price : (mktState?.price ?? 0);
        this.lastCycleShadowContexts.set(mktSym, {
          symbol: mktSym,
          price: mktPrice,
          features: mktFeatures,
        });
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
        void auditTradeRecordsLLM(records)
          .then((result: AuditResult) => {
            this.lastAuditResult = result;
            this.auditRunning = false;
            if (result.incidents.length > 0) {
              log.info(`[audit] Cached ${result.incidents.length} incidents (${result.incidents.filter(i => i.severity === 'critical').length} critical) — will gate next decisions`);
              // v2.0.736: Trigger SE when audit has incidents — SE follows audit, not a fixed schedule
              this.auditTriggeredSE = true;
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
          const similar = await this.emManager.querySimilarInsights(
            `${activeSymbol} ${combinedState.regime} ${combinedState.trend} price=${combinedState.price}`,
            3,
            3, // exclude last 3 cycles
          );
          similarInsightsContext = this.emManager.formatSimilarInsights(similar);
          // v2.0.140: Record retrieval for self-adjustment (win/loss feedback)
          this.emManager.recordRetrieval(this.totalCycles, similar);
        } catch { /* non-critical — cycle proceeds without historical insights */ }
      }

      // 1d. Inject previous cycle's trade pattern insights (stored after last HACP cycle)
      const patternContext = this.lastPatternContext ?? '';

      // 1d.2 v2.0.28: Inject pattern tag win rates (LLM-identified chart patterns)
      const patternTagContext = this.patternTagTracker?.formatContext(8) ?? '';

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
        const expDigest = this.expMemory?.getDigestSummary() ?? '';
        olrContext = this.buildOLRBlock(activeSymbol, olrFeatures, 'OLR + PATH RISK ASSESSMENT', undefined, srD, expDigest);
        // Shadow trade results (active-symbol global — supplementary reality check)
        const shadowCtx = this.shadowEngine.getContext();
        if (shadowCtx.openCount > 0 || shadowCtx.recentResults.length > 0) {
          olrContext += '\n' + shadowCtx.contextString;
        }
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
          const patternMap = this.patternCluster.getPatternMap(records.length);
          const closeReasonBlock = this.closeReasonAgg.formatBlock(records);

          // A2A Digester digest (kept as supplementary LLM analysis)
          const digesterDigest = this.expMemory?.getDigestSummary() ?? '';

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
          const priceData = await this.marketAgent.fetchPriceForSymbol(mktSym);
          mktPrice = priceData.price;
          mktChange24h = priceData.change24h;
          mktVolume24h = priceData.volume24h;
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
                  const expectedCloseSide = pos.side === 'buy' ? 'sell' : 'buy';
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
                    const expectedCloseSide = pos.side === 'buy' ? 'sell' : 'buy';
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

        const reconciled = this.portfolio.reconcilePositions(externalSymbols);
        if (reconciled.length > 0) {
          // v2.0.32: Close reconciled exchange positions on HL.
          // The local mirror was closed by reconcilePositions(), but the
          // real HL position may still be open — we must close it on HL
          // to avoid leaving real money positions unmanaged.
          for (const sym of exchangeSymbolsToClose) {
            if (reconciled.includes(sym)) {
              log.info(`🔒 Closing ${sym} on HL (reconciled locally but still open on exchange)`);
              try {
                await this.closeTrade(sym, 'Reconciliation close: position reconciled locally but still open on HL');
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
              const priceData = await this.marketAgent.fetchPriceForSymbol(mktSym);
              mktPrice = priceData.price;
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

      const result = await this.hacpEngine.executeDecisionCycle(
        `${marketDesc}\n\n${adjustedEvolutionContext}${backtestContext}`,
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
            const result = await this.marketAgent.fetchPriceForSymbol(symbol);
            return result.price;
          } catch {
            return null;
          }
        },
      );

      // v2.0.32: Debug log for consensus result
      log.info(`🎯 HACP consensus: ${result.consensus.decision.action.toUpperCase()} ${result.consensus.decision.symbol} size=${(result.consensus.decision.positionSizePct * 100).toFixed(1)}% conf=${(result.consensus.confidence * 100).toFixed(0)}% metaOverride=${result.consensus.metaAgentOverridden} cooldown=${this.hacpEngine.isCooldownActive(this.totalCycles)}`);

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

      // v2.0.80: Force-close positions whose entry thesis was invalidated by Skeptics
      // v2.0.139: Mark these as thesis_invalidation closes so the conviction-gate
      // winRate excludes them (Option C — prevents the feedback trap where thesis
      // invalidation losses raise the gate → new entries blocked → stuck in cash).
      if (result.thesisInvalidatedSymbols && result.thesisInvalidatedSymbols.length > 0) {
        for (const sym of result.thesisInvalidatedSymbols) {
          const pos = this.portfolio.getPosition(sym);
          if (!pos) continue;
          log.warn(`🚫 Thesis INVALIDATED for ${sym} — force-closing position (entry thesis no longer valid)`);
          this.thesisInvalidatedCloseSymbols.add(sym);
          // v2.0.143: Route through closeTrade() with thesis-invalidation exitThesis.
          const exitThesis = `Thesis invalidated: ${pos.entryThesis ?? 'original entry thesis no longer valid'}`;
          const success = await this.closeTrade(sym, exitThesis);
          if (success) {
            if (pos.agentId === 'hyperliquid-real') {
              log.info(`  → Force-closed ${sym} (real, thesis invalidated)`);
            } else {
              log.info(`  → Force-closed ${sym}: $${pos.unrealizedPnl.toFixed(2)} (thesis invalidated)`);
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
              };
              const olrQ = this.olrEngine.query(activeSymbol, olrCtx2, direction as 'buy' | 'sell', this.totalCycles);
              expOlr = `${(olrQ.pWin * 100).toFixed(0)}% (${olrQ.nSamples} samples)`;
              const shadowSym = normalizeSymbol(activeSymbol);
              const shadowStat = this.shadowEngine.getStats().find(s => s.symbol === shadowSym);
              if (shadowStat) {
                const swr = direction === 'buy' ? shadowStat.longWinRate : shadowStat.shortWinRate;
                const stot = direction === 'buy' ? shadowStat.longWins + shadowStat.longLosses : shadowStat.shortWins + shadowStat.shortLosses;
                expShadow = `${(swr * 100).toFixed(0)}% (${stot} samples)`;
              }
            } catch { /* non-critical — thesis still has market data */ }

            const entryThesis = [
              `[1h: ${direction} exploration on ${activeSymbolUpper} @ ${expPrice} — regime=${expRegime}, vol=${expVol}, OB=${expOB}, funding=${expFunding}, 24h=${expChange24h}%, S/R: support=${expSrDist}bps/resistance=${expSrResist}bps, sentiment=${expSentiment}, volRatio=${expVolumeRatio}, OLR_pWin=${expOlr}, shadowWR=${expShadow}]`,
              `[1d: exploration trade (${(exploreSize * 100).toFixed(1)}% size, ${exploreLev}x lev) — system needs trade data for evolution; ${direction} selected by multi-signal priority chain]`,
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
            log.info(`🧪 Exploration trade triggered: ${direction.toUpperCase()} ${(exploreSize * 100).toFixed(1)}% ${activeSymbolUpper} @ ${exploreLev}x (cycle #${this.totalCycles}) — regime=${expRegime}, OLR=${expOlr}, shadow=${expShadow}`);
          }
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
        const legacyCloseSuccess = await this.closeTrade(posSymbol, closeReason);
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

            // v2.0.764: Dynamic minimum volatility gate for multi-symbol path
            const pscVol = this.marketState.getState(psc.symbol)?.volatility ?? combinedState.volatility ?? 0;
            if (pscVol < this.dynamicMinVolatility) {
              log.warn(`🛑 [vol-gate] Multi-symbol ${psc.action.toUpperCase()} ${psc.symbol}: volatility ${pscVol.toFixed(4)} < dynamic threshold ${this.dynamicMinVolatility.toFixed(4)} — market too quiet, skipping`);
              auditGates.push({ gate: 'vol-gate', passed: false, reason: `vol=${pscVol.toFixed(4)} < threshold=${this.dynamicMinVolatility.toFixed(4)}` });
              this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, false);
              continue;
            }
            auditGates.push({ gate: 'vol-gate', passed: true, reason: `vol=${pscVol.toFixed(4)} ≥ threshold=${this.dynamicMinVolatility.toFixed(4)}` });

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
            if (psc.confidence < pscFilter.getConvictionThreshold()) {
              log.warn(`🛑 [adaptive-filter] Multi-symbol conviction gate [${psc.symbol}]: ${(psc.confidence * 100).toFixed(0)}% < ${(pscFilter.getConvictionThreshold() * 100).toFixed(0)}% — skipping entry (noise-dominated)`);
              auditGates.push({ gate: 'conviction-gate', passed: false, reason: `${(psc.confidence * 100).toFixed(0)}% < ${(pscFilter.getConvictionThreshold() * 100).toFixed(0)}%` });
              this.recordDecisionAudit(psc.symbol, psc.action, psc.confidence, psc.entryThesis ?? '', auditGates, false);
              continue;
            }
            auditGates.push({ gate: 'conviction-gate', passed: true, reason: `${(psc.confidence * 100).toFixed(0)}% ≥ ${(pscFilter.getConvictionThreshold() * 100).toFixed(0)}%` });

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
                pscPrice = (await this.marketAgent.fetchPriceForSymbol(psc.symbol)).price;
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
          if (pos.entryThesis) {
            // v2.0.90: Validate close decision with Skeptics for thesis-backed positions
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
          } else {
            // v2.0.91: Legacy position without entryThesis — close directly
            log.warn(`📕 Per-symbol consensus: CLOSE ${psc.symbol} (legacy, no thesis) (conf=${(psc.confidence * 100).toFixed(0)}%, PnL=${((pos.unrealizedPnlPct ?? 0) * 100).toFixed(1)}%) — ${psc.rationale}`);
          }
          // v2.0.143: Route through closeTrade() — handles paper vs real
          // separation + sets exitThesis before closing.
          const closeSuccess = await this.closeTrade(psc.symbol, closeRationale);
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
        if ((psc.action === 'buy' || psc.action === 'sell') && !psc.closePosition) {
          const posSide = pos.side;
          const wantsSameDirection = (psc.action === 'buy' && posSide === 'buy') || (psc.action === 'sell' && posSide === 'sell');
          if (!wantsSameDirection) {
            // Direction flip: close existing position first
            log.warn(`🔄 Per-symbol flip: ${psc.symbol} ${posSide.toUpperCase()} → ${psc.action.toUpperCase()}. Closing existing position first.`);
            const flipCloseSuccess = await this.closeTrade(psc.symbol, `Position flip: closing ${posSide.toUpperCase()} to open ${psc.action.toUpperCase()}`);
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
        // v2.0.152: Skip if HACP adjustPositions already adjusted this position
        // this cycle — HACP's MFE-aware trailing SL takes priority over
        // agent-suggested averaged SL/TP. The agent suggestions are blind to
        // MFE/giveback patterns; HACP's adaptive trail is data-driven.
        const hacpAdjusted = result.positionAdjustments?.some(a => a.positionId === pos.id);
        if (hacpAdjusted) {
          log.info(`📐 Per-symbol consensus SL/TP for ${psc.symbol} skipped — HACP adaptive SL already applied this cycle`);
        } else if (psc.suggestedStopLoss !== undefined || psc.suggestedTakeProfit !== undefined) {
          let validSL = psc.suggestedStopLoss;
          let validTP = psc.suggestedTakeProfit;
          const isLong = pos.side === 'buy';
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
                ? (pos.currentPrice - pos.averageEntryPrice) / pos.averageEntryPrice * (pos.side === 'buy' ? 1 : -1)
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
            const flipCloseSuccess = await this.closeTrade(activeSym, `Position flip: closing ${existingPos.side.toUpperCase()} to open ${finalDecision.action.toUpperCase()}`);
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

      // v2.0.764: Dynamic minimum volatility gate — if current volatility is below
      // the dynamic threshold, HOLD. This prevents trading in dead markets where
      // SL gets triggered by noise. The threshold adapts based on recent trade outcomes.
      // This is NOT a hard block on symbols/directions — it's a market condition gate
      // (like conviction gate). When volatility returns, trades resume automatically.
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const currentVol = combinedState.volatility ?? 0;
        if (currentVol < this.dynamicMinVolatility) {
          log.warn(`🛑 [vol-gate] ${finalDecision.action.toUpperCase()} ${finalDecision.symbol || activeSymbol}: volatility ${currentVol.toFixed(4)} < dynamic threshold ${this.dynamicMinVolatility.toFixed(4)} — market too quiet, HOLD`);
          activeAuditGates.push({ gate: 'vol-gate', passed: false, reason: `vol=${currentVol.toFixed(4)} < threshold=${this.dynamicMinVolatility.toFixed(4)} (market too quiet)` });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[VOL GATE] Volatility ${currentVol.toFixed(4)} below dynamic threshold ${this.dynamicMinVolatility.toFixed(4)} — market too quiet for profitable trading. HOLD. Original: ${finalDecision.rationale}`,
          };
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
        const convictionThreshold = symFilter.getConvictionThreshold();
        // v2.0.732: Apply loss streak soft penalty — raises effective threshold
        // v2.0.766: Apply winner pattern boost — lowers effective threshold
        // Net penalty can be negative (winner boost > loss penalty = easier entry)
        const lossStreakPenalty = (this as any)._lossStreakPenalty ?? 0;
        const effectiveThreshold = Math.max(0.25, Math.min(0.85, convictionThreshold + lossStreakPenalty));
        // v2.0.140: Use per-symbol confidence if available, fall back to overall
        const activePscForGate = (result.consensus.perSymbolConsensus ?? []).find(
          psc => normalizeSymbol(psc.symbol) === normalizeSymbol(finalDecision.symbol || activeSymbol),
        );
        const consensusConfidence = activePscForGate?.confidence ?? result.consensus.confidence;
        if (consensusConfidence < effectiveThreshold) {
          const penaltyStr = lossStreakPenalty > 0 ? ` (base ${(convictionThreshold * 100).toFixed(0)}% + loss-streak ${(lossStreakPenalty * 100).toFixed(0)}%)` : lossStreakPenalty < 0 ? ` (base ${(convictionThreshold * 100).toFixed(0)}% - winner ${(-lossStreakPenalty * 100).toFixed(0)}%)` : '';
          log.warn(`🛑 [adaptive-filter] Conviction gate [${finalDecision.symbol || activeSymbol}]: ${(consensusConfidence * 100).toFixed(0)}% < threshold ${(effectiveThreshold * 100).toFixed(0)}%${penaltyStr} — overriding ${finalDecision.action.toUpperCase()} → HOLD (signal below noise floor)`);
          activeAuditGates.push({ gate: 'conviction-gate', passed: false, reason: `${(consensusConfidence * 100).toFixed(0)}% < ${(effectiveThreshold * 100).toFixed(0)}%${lossStreakPenalty > 0 ? ` (+${(lossStreakPenalty * 100).toFixed(0)}% loss-streak)` : ''}` });
          finalDecision = {
            ...finalDecision,
            action: 'hold',
            positionSizePct: 0,
            rationale: `[ADAPTIVE FILTER ${finalDecision.symbol || activeSymbol}] Conviction ${(consensusConfidence * 100).toFixed(0)}% below threshold ${(convictionThreshold * 100).toFixed(0)}%. Signal is noise-dominated — HOLD. Original: ${finalDecision.rationale}`,
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
          activeAuditGates.push({ gate: 'conviction-gate', passed: true, reason: `${(consensusConfidence * 100).toFixed(0)}% ≥ ${(convictionThreshold * 100).toFixed(0)}%` });
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

      // v2.0.143: Route through executeTrade() — paper mode goes directly
      // to paperEngine, real mode goes to tradingManager. No more
      // tradingManager fallback for paper trades.
      const execResult = await this.executeTrade(decisionWithSR, activeAuditGates);
      const reports: ExecutionReport[] = execResult.paperReports ?? [];

      // v2.0.106: Record trade execution for per-asset frequency throttling
      if (execResult.success && (finalDecision.action === 'buy' || finalDecision.action === 'sell')) {
        const tradeSym = finalDecision.symbol || activeSymbol;
        const symFilter = this.assetFilterRegistry.getFilter(tradeSym);
        symFilter.recordTrade();
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
              this.patternTagTracker.recordEntry(
                tradeId,
                patternTag,
                report.trade.side,
                report.trade.symbol,
                this.totalCycles,
                'meta_agent',
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

        this.evolution.agentOutcomes.recordCycle(
          this.totalCycles,
          allAgentDecisions,
          combinedState.regime,
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
          void this.emManager.addInsightVector(cycleSummary).catch(() => { /* non-critical */ });
        }
      } catch (err: unknown) {
        log.warn(`[E-step] CycleSummary build failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 9.6 Persist evolution state + portfolio + debate history + patterns + OLR + pattern tags to disk
      this.evolution.persistState();
      this.patternClassifier?.persist();
      this.patternTagTracker?.persist();
      this.persistOLR();
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

      // v2.0.108: Post-cycle market drift check. If tradingMarkets changed
      // during the cycle (e.g. UI re-POSTed 3 markets while cycle only had 1),
      // trigger an immediate cycle to analyze the full set. Without this,
      // the system waits 300s for the next scheduled cycle.
      const cycleMarketCount = (this as any)._cycleMarketCount ?? 0;
      const currentMarketCount = this.tradingMarkets.length;
      if (currentMarketCount > cycleMarketCount && !isShuttingDown()) {
        log.info(`📊 Post-cycle drift: markets ${cycleMarketCount} → ${currentMarketCount} — triggering immediate cycle`);
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
          ? exPos.quantity * exPos.averageEntryPrice / (exPos.leverage ?? 1)
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
            ? exPos.quantity * exPos.averageEntryPrice / (exPos.leverage ?? 1)
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

    // v2.0.17: in real mode, show the actual Hyperliquid account value +
    // null out totalPnl/drawdown (paper-trade concepts). Win rate / trade
    // count stay local (paper + real mixed).
    // If real mode but exchange balance not yet fetched → null (UI shows '--')
    // v2.0.31: Balance = free (available to trade), Equity = total (account value)
    const exBal = isRealMode ? this.cachedExchangeBalance : null;
    const displayBalance = isRealMode ? (exBal ? exBal.free : null) : p.balance;
    const displayEquity = isRealMode ? (exBal ? exBal.total : null) : p.totalEquity;
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
      // v2.0.160: Pass realPositions so they survive restart with thesis + MAE/MFE
      savePortfolio(this.portfolio.getPortfolio(), this.paperEngine.getTrades(), this.portfolio.getClosedRealTrades(), this.portfolio.getRealPositions());
    } catch (err) {
      // Best-effort
    }
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
    } catch (err) {
      // API push is best-effort
    }
  }

  async stop(): Promise<void> {
    // Persist evolution state + portfolio + OLR + shadow trades + EM state + Root Command Prompt before shutdown
    this.evolution.persistState();
    this.persistPortfolio();
    this.persistOLR();
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