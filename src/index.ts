// ─── MATS Main Entry Point ───
// System orchestrator — ties together data, agents, cognition, risk, trading, evolution

import { config } from './config/index.ts';
import { rootLogger, createLogger } from './observability/logger.ts';
import { setupShutdownHandlers, registerShutdownHandler, isShuttingDown } from './utils/shutdown.ts';
import { hlRateLimitedFetch } from './utils/hl-global-limiter.ts';
import { initializeLLM, getActiveProviderType } from './llm/index.ts';
import { BinanceWebSocketManager, MarketStateAggregator, type AggregatedMarketState } from './data/binance-websocket.ts';
import { HyperliquidWebSocketManager } from './data/hyperliquid-websocket.ts';
import { MultiExchangeWebSocketManager, detectExchange, type UnifiedPrice, type UnifiedOrderBook } from './data/multi-exchange-ws.ts';
import { HACPEngine } from './cognition/hacp.ts';
import { RiskEngine } from './risk/engine.ts';
import { PortfolioTracker, normalizeSymbol } from './trading/portfolio.ts';
import { PaperTradingEngine, type ExecutionReport } from './trading/paper-engine.ts';
import { EvolutionOrchestrator } from './evolution/index.ts';
import { savePortfolio, saveDebateHistory, loadDebateHistory } from './evolution/persistence.ts';
import fs from 'node:fs';
import path from 'node:path';
import { FractalMomentumSentinel, OnChainWhisperer, OLRSentimentAnalyst, IndependentRiskAuditor, NewsReporter, SkepticsAgent, getLastFearGreedValue } from './agents/agents.ts';
import { MetaAgent } from './agents/meta-agent.ts';
import { APIServer } from './api-server.ts';
import { getAllAgentModels, getAvailableModels } from './agents/agent-models.ts';
import { BacktestEngine, type BacktestProgress } from './backtest/index.ts';
import { MarketAgent } from './market-agent/index.ts';
import { RealTradingManager } from './trading/real-trading-manager.ts';
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
import { OLREngine, type OLRQueryResult } from './evolution/olr-engine.ts';
import { ShadowTradeEngine } from './evolution/shadow-trade-engine.ts';
import { calculateFirstPassage, estimateDrift, estimateVolatility, type FirstPassageResult } from './evolution/first-passage.ts';
import { backfillOLRFromCandles, type HLCandle, type CandleFetcher } from './evolution/olr-backfill.ts';
import { getOptionsDataManager, formatOptionsForAgent, formatPlaybookForAgent } from './analysis/options-data.ts';
import { fetchNewsSentiment, formatNewsForAgent, fetchNewsForSymbols, formatNewsForAgentMulti, fetchGlobalBreakingNews, formatGlobalNewsForMetaAgent } from './analysis/news-sentiment.ts';
import type { ConsensusResult, Ticker, AgentThought, AgentStatus, DebateRound, CycleProgress, TradingDecision, MarketAgentConfig, TopVolumePair, MultiSymbolDecision, AgentRole, ExchangeAccountInfo, TradeRecord } from './types/index.ts';

const log = createLogger({ phase: 'system' });

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
  private backtest!: BacktestEngine;
  private apiServer!: APIServer;
  private marketAgent!: MarketAgent;
  private realTradingManager!: RealTradingManager;
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private restPollTimer: ReturnType<typeof setInterval> | null = null;
  private tradesToday = 0;
  private totalCycles = 0;
  private cycleInProgress = false;
  private lastCycleDuration = 0;
  private lastHACPResult: { consensus: ConsensusResult; allThoughts: AgentThought[]; debateRounds: DebateRound[] } | null = null;
  private cycleProgress: CycleProgress | null = null;
  /** Cached real-exchange balance (v2.0.17). Refreshed each cycle in real mode
   *  via realTradingManager.getBalance(); used by pushToAPI() so the UI shows
   *  the actual Hyperliquid account value instead of the local mirror. */
  private cachedExchangeBalance: ExchangeAccountInfo | null = null;
  /** Cached recent HL fills (v2.0.19). Refreshed each cycle in real mode via
   *  realTradingManager.getRecentFills(5); merged into tradeRecords so the UI
   *  Trade Records panel shows the real Hyperliquid trade history. */
  private cachedHLFills: Array<{ symbol: string; side: 'buy' | 'sell'; price: number; size: number; timestamp: number; closedPnl: number; fee: number; dir: string }> = [];
  /** Cached real-exchange positions (v2.0.19). Refreshed each cycle in real
   *  mode so the UI Portfolio positions module shows the actual Hyperliquid
   *  positions, not just the local mirror. */
  private cachedExchangePositions: Array<{ symbol: string; side: 'buy' | 'sell'; quantity: number; averageEntryPrice: number; currentPrice: number; unrealizedPnl: number; leverage: number; openedAt: number }> | null = null;
  private lastSRContext: { formatted: string; regime: string; zoneCount: number; strongZones: number; nearestSupport: number | null; nearestResistance: number | null; distanceToSupportBps: number; distanceToResistanceBps: number; degradedReason: string | null } | null = null;
  /** v2.0.79: Cached news headlines per symbol for UI display in News Reporter card. */
  private cachedNewsHeadlines: Array<{ symbol: string; headlines: Array<{ title: string; publisher: string; url?: string; pubDate: number | null }> }> = [];
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
      log.info('✓ Trading systems ready');

      // 3.5 Initialize Sigmoid·GA Sentiment Engine + Adaptive Noise Filter
      log.info('Step 3.5/8: Initializing Sentiment Engine + Adaptive Filter...');
      this.sentimentEngine = new SentimentEngine();
      this.adaptiveFilter = new AdaptiveNoiseFilter({}, 'global');
      this.assetFilterRegistry = new AssetFilterRegistry();
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
      log.info('✓ EM CycleSummary Manager ready');

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
      this.realTradingManager = new RealTradingManager(
        {
          tradeMode: 'paper',
          exchange: 'hyperliquid',
          binanceApiKey: config.binance.apiKey,
          binanceSecretKey: config.realTrading.binanceSecretKey,
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

      // Wire up Market Agent API handlers
      this.apiServer.setMarketAgentSetTradeModeHandler(async (mode) => {
        log.info(`Market Agent: trade mode → ${mode}`);
        const previousMode = this.realTradingManager.getTradeMode();
        this.marketAgent.setTradeMode(mode);
        this.realTradingManager.setTradeMode(mode);

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
            this.cachedExchangeBalance = await this.realTradingManager.getBalance();
            this.cachedHLFills = await this.realTradingManager.getRecentFills(20);
            this.cachedExchangePositions = (await this.realTradingManager.getPositions()).map(p => ({
              symbol: p.symbol,
              side: p.side,
              quantity: p.quantity,
              averageEntryPrice: p.averageEntryPrice,
              currentPrice: p.currentPrice,
              unrealizedPnl: p.unrealizedPnl,
              leverage: p.leverage ?? 1,
              openedAt: p.openedAt,
            }));
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
        this.realTradingManager.setExchange(exchange);
        await this.marketAgent.fetchTopPairs();
        this.pushToAPI();
      });
      this.apiServer.setMarketAgentSetAssetTypeHandler(async (assetType) => {
        log.info(`Market Agent: HL asset type → ${assetType}`);
        this.marketAgent.setHyperliquidAssetType(assetType);
        await this.marketAgent.fetchTopPairs();
        // Immediately connect WS + trigger a new decision cycle on the newly selected symbol
        const selectedSymbol = this.marketAgent.getSelectedSymbol();
        if (selectedSymbol) {
          const exchange = detectExchange(selectedSymbol);
          if (exchange === 'hyperliquid') {
            await this.hyperliquidWs.connect(selectedSymbol);
          }
          await this.multiWs.connect(selectedSymbol).catch((err: Error) => {
            log.warn(`Multi-WS connect failed for ${selectedSymbol}: ${err.message}`);
          });
        }
        // Abort any running cycle and trigger a fresh one
        log.info('Asset type changed — triggering immediate HACP cycle');
        this.pushToAPI();
        if (!this.cycleInProgress && !isShuttingDown()) {
          setTimeout(() => void this.runDecisionCycle(), 500);
        }
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
        this.realTradingManager.setMaxPortionPct(pct);
        this.pushToAPI();
      });
      this.apiServer.setMarketAgentSetLeverageHandler((lev) => {
        log.info(`Market Agent: leverage → ${lev}x`);
        this.marketAgent.setLeverage(lev);
        this.pushToAPI();
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
        const keys = ['HYPERLIQUID_WALLET_ADDRESS', 'HYPERLIQUID_PRIVATE_KEY', 'OLLAMA_API_KEY', 'MASSIVE_API_KEY', 'OLLAMA_PLAN'];
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

          // If real mode (or legacy real position), close on the exchange first
          const isRealPosition = this.realTradingManager.getTradeMode() === 'real' ||
            this.legacyPositionModes.get(sym) === 'real';

          if (isRealPosition) {
            const engine = this.realTradingManager.getEngineForExchange('hyperliquid');
            if (engine) {
              log.info(`📤 Closing ${sym} on Hyperliquid exchange...`);
              const exchangeResult = await engine.closePosition(sym);
              if (!exchangeResult) {
                log.error(`❌ Exchange close failed for ${sym}`);
                return { success: false, error: `Failed to close ${sym} on Hyperliquid` };
              }
              log.info(`✅ Exchange position closed for ${sym}`);
            }
          }

          // Close in local portfolio
          // v2.0.33: Use closeExchangePosition() for real positions —
          // closePosition() adds margin back to paper balance (wrong for
          // real positions where margin was never deducted from paper balance).
          const existingPos = this.portfolio.getPosition(sym);
          const trade = existingPos?.agentId === 'hyperliquid-real'
            ? this.portfolio.closeExchangePosition(sym, closePrice)
            : this.portfolio.closePosition(sym, closePrice);
          if (trade) {
            // Tag the trade record with manual close reason
            trade.closeReason = 'manual';
            log.info(`📕 Manual close completed: ${sym} PnL: $${trade.pnl.toFixed(2)} (${trade.pnl >= 0 ? 'profit' : 'loss'})`);

            // Trigger learning (so the system records this trade)
            // But the closeReason='manual' tag lets agents know this was NOT a system decision
            this.onPositionClosedLearning(trade);

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
            if (existing!.agentId === 'hyperliquid-real') {
              await this.realTradingManager.closePosition(sym);
            } else {
              this.portfolio.closePosition(sym, existing!.currentPrice);
            }
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

          const execResult = await this.realTradingManager.executeDecision({
            ...decision,
            srSupport: this.lastSRContext?.nearestSupport ?? null,
            srResistance: this.lastSRContext?.nearestResistance ?? null,
          });

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
              // Position was on HL but is now gone — closed by SL/TP
              // Only close if we have at least one HL position (proving the
              // clearinghouseState push is valid, not an empty failure)
              if (positions.length > 0 || hlSymbols.size > 0) {
                const pos = this.portfolio.getPosition(sym);
                if (pos) {
                  log.info(`📡 HL WS position disappeared: ${sym} — closing local mirror (SL/TP triggered on HL)`);
                  this.portfolio.closeExchangePosition(sym, pos.currentPrice);
                }
              }
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
              log.info(`📡 HL WS closing fill: ${fill.symbol} ${fill.side} ${fill.size} @ ${fill.price} dir=${fill.dir} closedPnl=${fill.closedPnl} — closing local mirror immediately`);
              // Close the local mirror with the actual HL fill price + realized PnL
              this.portfolio.closeExchangePosition(sym, fill.price, fill.closedPnl);
              return;
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
      await this.marketAgent.fetchTopPairs();
      log.info('✓ Market Agent ready');
      MarketAgent.registerSRModule();

      // v2.0.XX: Sync initial maxPortionPct from Market Agent to paper engine + real manager
      this.paperEngine.setMaxPortionPct(this.marketAgent.getConfig().maxPortionPct);
      this.realTradingManager.setMaxPortionPct(this.marketAgent.getConfig().maxPortionPct);

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
      // RealTradingManager. The RTM was created with hardcoded 'paper' in step 5.6
      // because MarketAgent didn't exist yet. Now that MarketAgent has loaded its
      // saved config from disk (which may be 'real'), we must sync RTM to match.
      const restoredTradeMode = this.marketAgent.getTradeMode();
      const restoredExchange = this.marketAgent.getExchange();
      if (restoredTradeMode !== this.realTradingManager.getTradeMode()) {
        log.info(`🔄 Syncing restored trade mode to Real Trading Manager: ${this.realTradingManager.getTradeMode()} → ${restoredTradeMode}`);
        this.realTradingManager.setTradeMode(restoredTradeMode);
      }
      if (restoredExchange !== this.realTradingManager.getExchange()) {
        this.realTradingManager.setExchange(restoredExchange);
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
            this.cachedExchangeBalance = await this.realTradingManager.getBalance();
            this.cachedHLFills = await this.realTradingManager.getRecentFills(20);
            this.cachedExchangePositions = (await this.realTradingManager.getPositions()).map(p => ({
              symbol: p.symbol,
              side: p.side,
              quantity: p.quantity,
              averageEntryPrice: p.averageEntryPrice,
              currentPrice: p.currentPrice,
              unrealizedPnl: p.unrealizedPnl,
              leverage: p.leverage ?? 1,
              openedAt: p.openedAt,
            }));
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
        const engine = this.realTradingManager.getEngineForExchange('hyperliquid');
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
            await this.realTradingManager.syncExchangePositions();
            // Sync SL/TP from HL trigger orders → local mirror
            await this.realTradingManager.syncSLTP();
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

  private startDecisionCycle(): void {
    const intervalMs = config.system.decisionIntervalMs;
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

  private stopTimers(): void {
    if (this.decisionTimer) {
      clearInterval(this.decisionTimer);
      this.decisionTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
        for (const [sym, data] of priceMap) {
          if (data.price > 0) {
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
  private onPositionClosedLearning(trade: TradeRecord): void {
    try {
      const symbol = trade.symbol;
      const isWin = trade.pnl >= 0;
      const pnlPct = trade.pnlPct;
      const outcome: 1 | 0 = isWin ? 1 : 0;

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
      const signalAgreement = 0.5; // unknown at close time

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
        });
      } catch (err) {
        log.warn(`[close-learning] Trade history record failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Feed OLR — learn "these conditions → LONG/SHORT wins/loses" from trade outcome
      // Source type: 'real' if exchange trade (agentId='hyperliquid-real'), 'paper' otherwise
      try {
        const features = {
          volatility,
          srDistanceBps,
          obImbalance,
          sentiment,
          signalAgreement,
          fundingRate,
          volumeRatio,
          sentimentConviction,
        };
        const tradeSource: 'paper' | 'real' = trade.agentId === 'hyperliquid-real' ? 'real' : 'paper';
        this.olrEngine.feedTrade(symbol, features, outcome, trade.side === 'buy' ? 'buy' : 'sell', tradeSource, this.totalCycles);
        log.info(`🧬 [close-learning] OLR fed (${tradeSource}): ${symbol} ${trade.side.toUpperCase()} ${isWin ? 'WIN' : 'LOSS'} (pnl=${(pnlPct * 100).toFixed(1)}%)`);
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
      try {
        this.evolution.agentOutcomes.backfillOutcome(symbol, pnlPct);
        log.info(`🧬 [close-learning] Agent outcomes backfilled: ${symbol} ${isWin ? 'WIN' : 'LOSS'}`);
      } catch (err) {
        log.warn(`[close-learning] Agent outcomes backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      }

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

      log.info(`🧬 [close-learning] ${isWin ? '✅ WIN' : '❌ LOSS'} ${trade.side.toUpperCase()} ${symbol} PnL: $${trade.pnl.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%) — all learning mechanisms fed`);
    } catch (err) {
      log.error(`[onPositionClosedLearning] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      const body = { type: 'candleSnapshot', req: { coin, interval, startTime, endTime } };
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
    const recentWinRate = recentTrades.length >= 3
      ? recentTrades.filter(t => (t.realisedPnl ?? t.simulatedPnl ?? 0) > 0).length / recentTrades.length
      : undefined;
    const recentTradeCount = recentTrades.filter(t =>
      t.type === 'real' && (Date.now() - t.timestamp) < 600_000
    ).length;
    const cyclesSinceLastTrade = recentTrades.length > 0
      ? this.totalCycles - (recentTrades[recentTrades.length - 1]?.cycleNumber ?? 0)
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
    for (const [sym, filter] of this.assetFilterRegistry.getAllFilters()) {
      const symState = this.marketState.getState(sym);
      const symVolatility = symState?.volatility ?? combinedState.volatility;
      const symRegime = symState?.regime ?? combinedState.regime;
      filter.adapt({
        volatility: symVolatility,
        regime: symRegime,
        recentWinRate,
        recentTradeCount,
        cyclesSinceLastTrade,
        totalCycles: this.totalCycles,
      });
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
    if (marketPrice > 0) {
      try {
        // Check + resolve existing shadow positions for active symbol (H1: pass intra-cycle high/low)
        const activeHL = this.marketState.getHighLow(activeSymbol);
        const resolved = this.shadowEngine.checkPositions(activeSymbol, marketPrice, this.totalCycles, activeHL.high, activeHL.low);
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
            const mktResolved = this.shadowEngine.checkPositions(mktSym, mktChkPrice, this.totalCycles, mktHL.high, mktHL.low);
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

          const mktFeatures = {
            volatility: mktState?.volatility ?? 0,
            srDistanceBps: 0, // S/R is only fetched for active symbol
            obImbalance: mktState?.orderBookImbalance ?? 0,
            fundingRate: this.hyperliquidWs?.getLatestMarkPrice()?.fundingRate ?? 0,
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
    // v2.0.32: In real mode, drawdown/dailyPnl from paper portfolio are meaningless
    // (paper balance is inflated by exchange position closes). Use 0 so the
    // drawdown guard doesn't block real trading. Real risk is managed by HL's
    // own margin/liquidation system + our SL/TP trigger orders.
    const isRealMode = this.realTradingManager.getTradeMode() === 'real';
    const paperPortfolio = this.portfolio.getPortfolio();
    const guardParams = {
      activeSymbol,
      marketPrice,
      // v2.0.42: Use currentDrawdownPct (decreases on recovery) instead of
      // maxDrawdownPct (high-water mark that only increases). In real mode,
      // drawdown is 0 (SystemGuard uses 0 for real mode — real drawdown is
      // tracked on HL, not in paper portfolio).
      currentDrawdownPct: isRealMode ? 0 : paperPortfolio.currentDrawdownPct,
      maxDrawdownPct: isRealMode ? 0 : paperPortfolio.maxDrawdownPct,
      dailyPnl: isRealMode ? 0 : paperPortfolio.dailyPnl,
      balance: isRealMode ? (this.cachedExchangeBalance?.total ?? paperPortfolio.balance) : paperPortfolio.balance,
      lastBookTimestamp: this.hyperliquidWs?.getLastBookTimestamp?.() ?? 0,
      lastFetchTime: this.marketAgent.getLastFetchTime(),
      agentWinRates: this.evolution.agentOutcomes.getAllAgentWinRates(),
      orderBookDepth: this.hyperliquidWs?.getOrderBookLevels?.(20) ?? [],
      proposedPositionUsd: 0,
      proposedLeverage: 1,
    };

    const guardReport = this.systemGuard.check(guardParams);

    if (guardReport.blocked) {
      const restrictions = this.systemGuard.getActiveRestrictions(guardReport);
      for (const line of restrictions) {
        log.warn(`🛑 ${line}`);
      }
      log.warn('SystemGuard blocked this cycle.');
      this.pushToAPI();
      // v2.0.110: Reset cycleInProgress — we set it at the top of runDecisionCycle()
      this.cycleInProgress = false;
      return;
    }

    // Log guard health summary
    const healthSummary = this.systemGuard.getHealthSummary(guardReport);
    if (guardReport.results.some(r => r.severity === 'warn' || r.severity === 'error')) {
      log.warn(`SystemGuard: ${healthSummary}`);
    } else {
      log.info(`SystemGuard: ${healthSummary}`);
    }

    // ── PAUSE CHECK: If paused, skip agents/trading but keep OLR/shadow running ──
    if (this.paused) {
      log.info(`⏸️ System paused — OLR/shadow training complete, skipping HACP agents and trading (cycle #${this.totalCycles})`);
      this.cycleInProgress = false;
      this.pushToAPI();
      return;
    }

    // v2.0.110: cycleInProgress was already set at the top of runDecisionCycle()
    this.totalCycles++;
    const cycleStart = performance.now();

    try {
      // 1. Gather market state (using Market Agent's selected symbol)
      const marketAgentDesc = this.marketAgent.getMarketDescription();
      const guardContextLines = guardReport.contextLines.length > 0 ? `\n${guardReport.contextLines.join('\n')}` : '';
      const baseMarketDesc = `${marketAgentDesc}\n${this.buildMarketDescription(combinedState)}${guardContextLines}`;

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
        olrContext = this.buildOLRBlock(activeSymbol, olrFeatures, 'OLR + PATH RISK ASSESSMENT', undefined, srD);
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
      } catch (err) {
        log.debug(`[news] Failed for ${activeSymbol}: ${err instanceof Error ? err.message : String(err)}`);
      }

      let marketDesc = `${baseMarketDesc}${srLines}${emContext ? `\n${emContext}` : ''}${patternContext ? `\n${patternContext}` : ''}${patternTagContext ? `\n${patternTagContext}` : ''}${olrContext}${planckChaosContext}${optionsContext}${playbookContext}${newsContext ? `\n${newsContext}` : ''}\n\n${getFeeSummary()}`;

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

      // v2.0.41: Apply Evolution signalThreshold as HACP consensus threshold.
      // This gives the Evolution Engine DETERMINISTIC control over how strict
      // the consensus must be. Higher signalThreshold = agents need stronger
      // directional agreement to pass.
      //
      // ⚠️ MAINTENANCE NOTE: If you modify the threshold enforcement chain,
      // you MUST update the comment in hacp.ts setEvolutionThreshold() and
      // getEffectiveConsensusThreshold(). The chain is:
      //   1. Here: evolution.getStrategyParameters(regime).signalThreshold
      //   2. hacpEngine.setEvolutionThreshold() stores it
      //   3. hacpEngine.adjustThreshold() adjusts base (loss-streak etc.)
      //   4. getEffectiveConsensusThreshold() returns Evolution override
      //   5. calcWeightedConsensus() compared against effective threshold
      try {
        const evoParams = this.evolution.pressureEngine.getStrategyParameters(combinedState.regime);
        if (evoParams && typeof evoParams.signalThreshold === 'number') {
          this.hacpEngine.setEvolutionThreshold(evoParams.signalThreshold);
        }
      } catch { /* non-critical — fallback to config threshold */ }

      // 3. HACP Decision Cycle
      log.info('🤖 HACP: Starting multi-agent cognition...');

      // Sync real exchange positions into local portfolio before agents think
      if (this.realTradingManager.getTradeMode() === 'real') {
        await this.realTradingManager.syncExchangePositions();
        // Cache the real exchange balance so pushToAPI() can show the actual
        // Hyperliquid account value (not the local mirror) in the UI (v2.0.17).
        try {
          this.cachedExchangeBalance = await this.realTradingManager.getBalance();
          // v2.0.19: also cache recent HL fills (last 5) + exchange positions
          // so the UI Trade Records + Portfolio positions modules show real
          // Hyperliquid data, not just the local mirror.
          this.cachedHLFills = await this.realTradingManager.getRecentFills(20);
          this.cachedExchangePositions = (await this.realTradingManager.getPositions()).map(p => ({
            symbol: p.symbol,
            side: p.side,
            quantity: p.quantity,
            averageEntryPrice: p.averageEntryPrice,
            currentPrice: p.currentPrice,
            unrealizedPnl: p.unrealizedPnl,
            leverage: p.leverage ?? 1,
            openedAt: p.openedAt,
          }));
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
          await this.realTradingManager.syncSLTP();
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
      if (this.realTradingManager.getTradeMode() === 'paper') {
        // v2.0.37: Process ALL real positions — both legacy-tracked AND orphaned
        const allRealSymbols = this.portfolio.getOpenSymbols().filter(sym => {
          const pos = this.portfolio.getPosition(sym);
          return pos && pos.agentId === 'hyperliquid-real';
        });
        if (allRealSymbols.length > 0) {
          try {
            const engine = this.realTradingManager.getEngineForExchange('hyperliquid');
            if (engine) {
              const exchangePositions = await engine.getPositions();
              // v2.0.37: If getPositions() returned empty, we can't verify —
              // but we also can't just skip (the position might be genuinely
              // closed on HL). Check if any closing fills exist.
              if (exchangePositions.length === 0) {
                // Try to get recent fills to confirm the position was closed
                let recentFills: Array<{ symbol: string; closedPnl: number; price: number; timestamp: number; dir: string }> = [];
                if (typeof (engine as any).getRecentFills === 'function') {
                  try { recentFills = await (engine as any).getRecentFills(50); } catch { /* non-critical */ }
                }
                for (const sym of allRealSymbols) {
                  const pos = this.portfolio.getPosition(sym);
                  if (!pos) continue;
                  const closingFill = recentFills.find(f =>
                    f.symbol.toLowerCase() === sym.toLowerCase() &&
                    !f.dir.toLowerCase().startsWith('open') &&
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
                const exchangeSyms = exchangePositions.map(p => p.symbol.includes(':') ? p.symbol : p.symbol.toLowerCase());
                for (const sym of allRealSymbols) {
                  if (!exchangeSyms.includes(sym) && this.portfolio.hasPosition(sym)) {
                    const state = this.marketState.getState(sym);
                    const closePrice = state?.price ?? this.portfolio.getPosition(sym)?.currentPrice ?? 0;
                    if (closePrice > 0) {
                      const pos = this.portfolio.getPosition(sym);
                      const trade = pos?.agentId === 'hyperliquid-real'
                        ? this.portfolio.closeExchangePosition(sym, closePrice)
                        : this.portfolio.closePosition(sym, closePrice);
                      if (trade) {
                        log.info(`📋 Real position ${sym} closed on exchange: PnL $${trade.pnl.toFixed(2)} — syncing local mirror`);
                        this.legacyPositionModes.delete(sym);
                        this.onPositionClosedLearning(trade);
                      }
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
              await this.realTradingManager.syncSLTP();
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

        if (this.realTradingManager.getTradeMode() === 'real') {
          // Real mode: ask the exchange what positions it has open.
          // Any local mirror without a matching exchange position was
          // manually closed on the exchange.
          // BUT: legacy paper positions are not on the exchange — keep them.
          const exchangeSymbols = await this.realTradingManager.getOpenPositionSymbols();
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
        if (this.realTradingManager.getTradeMode() === 'real') {
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
                await this.realTradingManager.closePosition(sym);
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
        `${marketDesc}\n\n${evolutionContext}${backtestContext}`,
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
      if (result.thesisInvalidatedSymbols && result.thesisInvalidatedSymbols.length > 0) {
        for (const sym of result.thesisInvalidatedSymbols) {
          const pos = this.portfolio.getPosition(sym);
          if (!pos) continue;
          log.warn(`🚫 Thesis INVALIDATED for ${sym} — force-closing position (entry thesis no longer valid)`);
          if (pos.agentId === 'hyperliquid-real') {
            const success = await this.realTradingManager.closePosition(sym);
            if (success) {
              log.info(`  → Force-closed ${sym} (real, thesis invalidated)`);
            } else {
              log.error(`  → Failed to force-close ${sym} on HL — position remains open`);
            }
          } else {
            const trade = this.portfolio.closePosition(sym, pos.currentPrice);
            if (trade) {
              log.info(`  → Force-closed ${sym}: $${trade.pnl.toFixed(2)} (thesis invalidated)`);
            }
          }
        }
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
          await this.realTradingManager.adjustPosition(adj.positionId, effectiveSL, effectiveTP);
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
        // Independent exploration: only block if the ACTIVE symbol has a position.
        // Previously checked p.positions.size === 0 which blocked exploration on
        // xyz:SPCX when BTC had an open position. Now we check per-symbol, so
        // exploration can fire on the Market Agent's symbol independently of
        // other positions being managed by per-symbol consensus.
        if (!this.portfolio.hasPosition(activeSymbol)) {
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
              if (buyWr > 0 || sellWr > 0) {
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
            finalDecision = {
              action: direction as 'buy' | 'sell',
              symbol: activeSymbolUpper,
              entryPrice: combinedState.price,
              positionSizePct: exploreSize,
              stopLossPct: 0.02,
              takeProfitPct: 0.05,
              leverage: exploreLev,
              rationale: `Exploratory ${direction} (${(exploreSize * 100).toFixed(1)}% size, ${exploreLev}x lev) on ${activeSymbolUpper} — ${direction} exploration.`,
              urgency: 'immediate',
              // v2.0.80: Exploration trades also require an entry thesis
              entryThesis: `[1h: ${direction} exploration — pattern classifier suggests ${direction} has higher historical win rate in current regime] [1d: system needs trade data for evolution; ${direction} direction selected by pattern win-rate query]`,
            };
            log.info(`🧪 Exploration trade triggered: ${direction.toUpperCase()} ${(exploreSize * 100).toFixed(1)}% ${activeSymbolUpper} @ ${exploreLev}x (cycle #${this.totalCycles})`);
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
        if (pos.agentId === 'hyperliquid-real') {
          const success = await this.realTradingManager.closePosition(posSymbol);
          if (success) {
            log.info(`  → Closed ${posSymbol} (real, legacy position)`);
          } else {
            log.error(`  → Failed to close ${posSymbol} on HL — position remains open`);
          }
        } else {
          const trade = this.portfolio.closePosition(posSymbol, pos.currentPrice);
          if (trade) {
            perPositionCloseReports.push({ order: {} as any, trade });
            log.info(`  → Closed ${posSymbol}: $${trade.pnl.toFixed(2)} (legacy)`);
          }
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
        const pos = this.portfolio.getPosition(psc.symbol);

        // v2.0.104: If no real position exists, this might be a trading market
        // without position (injected for multi-symbol single-cycle analysis).
        // If consensus says BUY/SELL, execute the entry decision for this symbol.
        if (!pos) {
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
            // realTradingManager.executeDecision() got price=0 → "No price
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
            log.info(`📊 Multi-symbol entry: ${psc.action.toUpperCase()} ${psc.symbol} ${(psc.positionSizePct * 100).toFixed(1)}% @ $${pscPrice.toFixed(2)} — executing (trading market → real entry)`);
            const pscEntryDecision = {
              action: psc.action,
              symbol: psc.symbol,
              entryPrice: pscPrice,
              positionSizePct: psc.positionSizePct,
              leverage: psc.leverage ?? this.marketAgent.getConfig().leverage,
              rationale: psc.rationale,
              urgency: 'soon' as const,
              entryThesis: psc.entryThesis,
              stopLossPct: 0.02,
              takeProfitPct: 0.05,
            };
            try {
              const pscExecResult = await this.realTradingManager.executeDecision({
                ...pscEntryDecision,
                srSupport: null,
                srResistance: null,
              });
              if (pscExecResult.success) {
                pscFilter.recordTrade();
                pscExecuted = true;
                log.info(`📊 Multi-symbol entry ${psc.symbol}: ✅ — ${pscFilter.getRemainingTradeSlots()} slots remaining`);
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
          }
          continue;
        }

        // Close position if consensus says so
        // v2.0.91: Close validation depends on whether the position has an entryThesis.
        // - WITH entryThesis: Meta-Agent → Skeptics validateCloseDecision → execute
        // - WITHOUT entryThesis (legacy): sub-agent voting already handled above,
        //   but if consensus also says close, execute directly (legacy positions
        //   don't need Skeptics validation since they predate the thesis system)
        if (psc.closePosition) {
          if (pos.entryThesis) {
            // v2.0.90: Validate close decision with Skeptics for thesis-backed positions
            const closeRationale = psc.rationale || 'No rationale provided.';
            const closeValidation = await this.hacpEngine.getSkeptics().validateCloseDecision(
              psc.symbol,
              pos.side as 'buy' | 'sell',
              pos.averageEntryPrice,
              pos.currentPrice,
              pos.unrealizedPnlPct ?? 0,
              closeRationale,
              `${marketDesc}\n\n${evolutionContext}`,
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
          // v2.0.33: Route real positions through realTradingManager.closePosition()
          // which closes on HL first. portfolio.closePosition() only closes locally.
          if (pos.agentId === 'hyperliquid-real') {
            const success = await this.realTradingManager.closePosition(psc.symbol);
            if (success) {
              log.info(`  → Closed ${psc.symbol} (real, closed on HL)`);
            } else {
              log.error(`  → Failed to close ${psc.symbol} on HL — position remains open`);
            }
          } else {
            const trade = this.portfolio.closePosition(psc.symbol, combinedState.price);
            if (trade) {
              perPositionCloseReports.push({ order: {} as any, trade });
              log.info(`  → Closed ${psc.symbol}: $${trade.pnl.toFixed(2)}`);
            }
          }
          continue;
        }

        // Adjust TP/SL if suggested
        // v2.0.31: In real mode, also place native trigger orders on HL exchange
        // v2.0.54: Validate per-symbol consensus SL/TP direction BEFORE applying.
        // The consensus averages SL/TP from all agents — if agents disagree on
        // direction, the averaged SL/TP can end up on the wrong side of current
        // price. We must validate and skip invalid values rather than sending
        // them to adjustPosition() which would place them on HL.
        if (psc.suggestedStopLoss !== undefined || psc.suggestedTakeProfit !== undefined) {
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
            await this.realTradingManager.adjustPosition(pos.id, validSL, validTP);
            log.info(`📐 Per-symbol consensus: ADJUST ${psc.symbol} SL=${validSL?.toFixed(2) ?? '-'} TP=${validTP?.toFixed(2) ?? '-'}`);
          } else {
            log.warn(`📐 Per-symbol consensus: ADJUST ${psc.symbol} — all SL/TP rejected by direction validation, skipping`);
          }
        }

        // v2.0.134: Sync entryThesis + holdReason from per-symbol consensus to
        // the position. Positions imported via importExchangePosition() don't
        // have entryThesis. The thesis/holdReason from HACP consensus is the
        // best available — sync it so the UI Portfolio can display the rationale.
        if (psc.entryThesis && psc.entryThesis.trim().length > 0
            && !psc.entryThesis.includes('Not applicable')) {
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

      // ── Guard E: Liquidity Check (Execution Feasibility) ──
      // Runs AFTER agents produce a decision so we have the actual position size
      if (finalDecision.action !== 'hold' && (finalDecision.positionSizePct ?? 0) > 0) {
        const positionUsd = (finalDecision.positionSizePct ?? 0.05) * (this.portfolio.getPortfolio().balance ?? 10_000);
        const liquidityParams = { ...guardParams, proposedPositionUsd: positionUsd, proposedLeverage: finalDecision.leverage ?? 1 };
        const liquidityResult = await this.systemGuard.checkLiquidity(liquidityParams);
        if (!liquidityResult.allowed) {
          log.warn(`🛑 Liquidity guard blocked execution: ${liquidityResult.reason}`);
          // Override to HOLD rather than executing a position that can't be filled
          finalDecision.action = 'hold';
          finalDecision.positionSizePct = 0;
          finalDecision.rationale = `[LIQUIDITY BLOCKED] ${liquidityResult.reason} Original: ${finalDecision.rationale}`;
        } else if (liquidityResult.severity === 'warn') {
          log.warn(`⚠️ Liquidity guard warning: ${liquidityResult.reason}`);
          // Reduce position size if flagged
          if (liquidityResult.action === 'reduce_size') {
            finalDecision.positionSizePct = Math.min(finalDecision.positionSizePct ?? 0.05, 0.02);
          }
        }
      }

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
      if (activeSym && this.portfolio.hasPosition(activeSym)) {
        const existingPos = this.portfolio.getPosition(activeSym);
        if (existingPos && finalDecision.action !== 'hold') {
          const isFlip = (existingPos.side === 'buy' && finalDecision.action === 'sell') ||
                         (existingPos.side === 'sell' && finalDecision.action === 'buy');
          if (isFlip) {
            // Direction flip: close existing position first, then let the new
            // trade execute below. This is a conviction-based reversal.
            log.warn(`🔄 Direction flip: ${activeSym.toUpperCase()} ${existingPos.side.toUpperCase()} @ $${existingPos.averageEntryPrice.toFixed(2)} → ${finalDecision.action.toUpperCase()}. Closing existing position first.`);
            // v2.0.33: Route real positions through realTradingManager.closePosition()
            // which closes on HL first. portfolio.closePosition() only closes locally.
            if (existingPos.agentId === 'hyperliquid-real') {
              const success = await this.realTradingManager.closePosition(activeSym);
              if (success) {
                log.info(`  → Flipped ${activeSym} (real, closed on HL). Proceeding with ${finalDecision.action.toUpperCase()} order.`);
              } else {
                log.error(`  → Failed to close ${activeSym} on HL for flip — aborting flip`);
                finalDecision = {
                  ...finalDecision,
                  action: 'hold',
                  positionSizePct: 0,
                  rationale: `Flip failed: could not close ${activeSym} on HL. HOLD.`,
                };
              }
            } else {
              const flipTrade = this.portfolio.closePosition(activeSym, combinedState.price);
              if (flipTrade) {
                perPositionCloseReports.push({ order: {} as any, trade: flipTrade });
                log.info(`  → Flipped ${activeSym}: $${flipTrade.pnl.toFixed(2)} (${flipTrade.pnl >= 0 ? 'profit' : 'loss'}). Proceeding with ${finalDecision.action.toUpperCase()} order.`);
              }
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
      log.info(`💼 Executing ${this.realTradingManager.getTradeMode().toUpperCase()} trading decision...`);

      // v2.0.128: Decision audit for the active symbol — track gates
      const activeAuditGates: Array<{ gate: string; passed: boolean; reason: string }> = [];

      // v2.0.122: Per-symbol direction restriction enforcement.
      // If the Market Agent config restricts a symbol to one direction,
      // block the opposite direction from executing. Existing positions
      // can still be closed (closePosition is not a new entry).
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const decisionSym = finalDecision.symbol || activeSymbol;
        if (!this.marketAgent.isDirectionAllowed(decisionSym, finalDecision.action)) {
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

      // v2.0.106: Adaptive conviction gate + trade frequency throttle.
      // Uses the ACTIVE symbol's per-asset filter — each asset has its own
      // conviction threshold and trade frequency limit based on Market Agent's
      // profile selection.
      // Block new entries if:
      //   1. Consensus confidence is below the adaptive conviction threshold, OR
      //   2. Trade frequency limit is reached (over-trading prevention)
      if (finalDecision.action === 'buy' || finalDecision.action === 'sell') {
        const symFilter = this.assetFilterRegistry.getFilter(finalDecision.symbol || activeSymbol);
        const convictionThreshold = symFilter.getConvictionThreshold();
        const consensusConfidence = result.consensus.confidence;
        if (consensusConfidence < convictionThreshold) {
          log.warn(`🛑 [adaptive-filter] Conviction gate [${finalDecision.symbol || activeSymbol}]: ${(consensusConfidence * 100).toFixed(0)}% < threshold ${(convictionThreshold * 100).toFixed(0)}% — overriding ${finalDecision.action.toUpperCase()} → HOLD (signal below noise floor)`);
          activeAuditGates.push({ gate: 'conviction-gate', passed: false, reason: `${(consensusConfidence * 100).toFixed(0)}% < ${(convictionThreshold * 100).toFixed(0)}%` });
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

      // v2.0.33: Pass S/R levels to executeDecision so SL/TP can be set at
      // v2.0.136: Set entryPrice for the active-symbol consensus decision. The
      // HACP consensus decision does not carry an entryPrice (only the
      // multi-symbol entry path and exploration path set it). Without this,
      // realTradingManager.executeDecision() received price=0 and silently
      // returned "No price available for real trade" -> execution FAILED even
      // after every gate (thesis, conviction, direction, frequency) passed.
      // This was the direct cause of "BTC SELL shown but never opens".
      const decisionWithSR: TradingDecision = {
        ...finalDecision,
        entryPrice: finalDecision.entryPrice ?? combinedState.price ?? marketPrice,
        srSupport: this.lastSRContext?.nearestSupport ?? null,
        srResistance: this.lastSRContext?.nearestResistance ?? null,
      };
      const execResult = await this.realTradingManager.executeDecision(decisionWithSR);
      const reports: ExecutionReport[] = execResult.paperReports ?? [];

      // v2.0.106: Record trade execution for per-asset frequency throttling
      if (execResult.success && (finalDecision.action === 'buy' || finalDecision.action === 'sell')) {
        const tradeSym = finalDecision.symbol || activeSymbol;
        const symFilter = this.assetFilterRegistry.getFilter(tradeSym);
        symFilter.recordTrade();
        log.info(`📊 [adaptive-filter] Trade recorded for ${tradeSym} — ${symFilter.getRemainingTradeSlots()} slots remaining`);
      }

      // v2.0.128: Record decision audit for the active symbol
      if (originalMetaAction === 'buy' || originalMetaAction === 'sell') {
        const activeExecuted = execResult.success && (finalDecision.action === 'buy' || finalDecision.action === 'sell');
        if (execResult.success && activeExecuted) {
          activeAuditGates.push({ gate: 'execution', passed: true, reason: 'executed on HL' });
        } else if (!activeExecuted) {
          activeAuditGates.push({ gate: 'execution', passed: false, reason: finalDecision.action === 'hold' ? 'overridden to HOLD by gate' : (execResult.error ?? 'execution failed') });
        }
        this.recordDecisionAudit(
          finalDecision.symbol || activeSymbol,
          originalMetaAction,
          result.consensus.confidence,
          originalMetaThesis ?? '',
          activeAuditGates,
          activeExecuted,
        );
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
      if (this.realTradingManager.getTradeMode() === 'real' && execResult.success && execResult.orderId) {
        try {
          this.cachedExchangePositions = (await this.realTradingManager.getPositions()).map(p => ({
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
            mode: this.realTradingManager.getTradeMode() === 'real' ? 'real' : 'paper',
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

      // 10. Print portfolio summary
      // v2.0.30: In real mode, show exchange balance instead of paper mirror
      if (this.realTradingManager.getTradeMode() === 'real' && this.cachedExchangeBalance) {
        log.info(`\n📊 🟢 Real Portfolio (HL):`, {
          balance: this.cachedExchangeBalance.total.toFixed(2),
          free: this.cachedExchangeBalance.free.toFixed(2),
          marginUsed: this.cachedExchangeBalance.marginUsed.toFixed(2),
          positions: this.cachedExchangePositions?.length ?? 0,
        });
      } else if (this.realTradingManager.getTradeMode() === 'real') {
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
    const isRealMode = this.realTradingManager?.getTradeMode() === 'real';

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
          holdReason: (pos as any).holdReason,
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
          holdReason: (pos as any).holdReason,
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
          const localPos = p.positions.get(key);
          const livePrice = localPos?.currentPrice ?? exPos.currentPrice;
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
            holdReason: (realPos as any)?.holdReason,
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
    };
  }

  private persistPortfolio(): void {
    try {
      // v2.0.38: Pass closedRealTrades so real exchange trades survive restarts.
      // They're stored separately from paper trades and don't affect paper stats.
      savePortfolio(this.portfolio.getPortfolio(), this.paperEngine.getTrades(), this.portfolio.getClosedRealTrades());
    } catch (err) {
      // Best-effort
    }
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
      if (this.realTradingManager?.getTradeMode() === 'real') {
        const engine = this.realTradingManager.getEngineForExchange('hyperliquid') as any;
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

  private pushToAPI(): void {
    try {
      // Guard: allow push before MarketAgent/MarketState are initialized (e.g. during startup)
      if (!this.marketAgent || !this.marketState) return;
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
      const isRealMode = this.realTradingManager.getTradeMode() === 'real';
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
          positions: p.positions.size,
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
        agentThoughts: this.lastHACPResult?.allThoughts ?? [],
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
        tradeRecords: isRealMode ? [
          // v2.0.79: Removed the cachedExchangePositions filter — it was
          // filtering out xyz:DEX positions when cachedExchangePositions
          // didn't include them (timing mismatch between getPositions()
          // and getRealPositions()). getRealPositions() already reflects
          // the actual exchange state, so no additional filter is needed.
          // v2.0.79: Also add any cachedExchangePositions that are missing
          // from realPositions (e.g. syncExchangePositions missed them due
          // to 429 on the xyz DEX fetch).
          ...this.portfolio.getRealPositions()
            .map(p => ({
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
            })),
          // v2.0.79: Fallback — add exchange positions not in realPositions
          ...(this.cachedExchangePositions ?? [])
            .filter(ep => {
              const sym = normalizeSymbol(ep.symbol);
              return !this.portfolio.getRealPositions().some(rp => normalizeSymbol(rp.symbol) === sym);
            })
            .map(ep => ({
              id: `hl-${ep.symbol}-${ep.openedAt}`,
              symbol: normalizeSymbol(ep.symbol),
              side: ep.side,
              entryPrice: ep.averageEntryPrice,
              exitPrice: ep.currentPrice,
              quantity: ep.quantity,
              leverage: ep.leverage ?? 1,
              investment: ep.averageEntryPrice * ep.quantity,
              pnl: ep.unrealizedPnl,
              pnlPct: ep.unrealizedPnl / Math.max(0.01, ep.averageEntryPrice * ep.quantity / (ep.leverage ?? 1)),
              openedAt: ep.openedAt,
              closedAt: ep.openedAt,
              status: 'open' as const,
            })),
          // Recent HL fills — ONLY closing fills shown as trade history.
          // v2.0.79: Open fills are skipped because the corresponding open
          // position is already displayed above from getRealPositions().
          // Showing both would create duplicate OPEN entries (1 position +
          // N open fills = N+1 OPEN rows for the same position).
          // v2.0.79: Use dir field to distinguish Open vs Close fills, and
          // look up actual leverage from cachedExchangePositions.
          ...this.cachedHLFills
            .filter(f => !f.dir.toLowerCase().includes('open'))
            .map(f => {
              // v2.0.133: Extract position side from dir ("Close Short" → sell,
              // "Close Long" → buy). Previously used f.side which is the ORDER
              // side (buy to close short), not the POSITION side (sell/short).
              const positionSide: 'buy' | 'sell' = f.dir.toLowerCase().includes('short') ? 'sell' : 'buy';

              // v2.0.133: Find the matching open fill to get the entry price.
              // HL fills are sorted newest-first in cachedHLFills. Look for an
              // "Open Short" or "Open Long" fill for the same symbol with the
              // same size, before this close fill.
              const openFill = this.cachedHLFills.find(of =>
                of.dir.toLowerCase().includes('open') &&
                of.symbol === f.symbol &&
                Math.abs(of.size - f.size) < 0.0001 &&
                of.timestamp < f.timestamp
              );
              const entryPrice = openFill?.price ?? f.price;
              const exitPrice = f.price;

              // Look up leverage from cached exchange positions (for still-open positions)
              const posMatch = this.cachedExchangePositions?.find(ep => {
                const epSym = ep.symbol.replace(/^xyz:/i, '').toLowerCase();
                const fSym = f.symbol.replace(/^xyz:/i, '').toLowerCase();
                return epSym === fSym;
              });
              // v2.0.79: For closed positions, posMatch is undefined (position
              // no longer on HL). Default to 10x — the system's standard leverage.
              // Previously defaulted to 1x, making PnL% look wrong.
              return {
                id: `hl-fill-${f.timestamp}-${f.symbol}`,
                symbol: normalizeSymbol(f.symbol),
                side: positionSide,
                entryPrice,
                exitPrice,
                quantity: f.size,
                leverage: posMatch?.leverage ?? 10,
                investment: entryPrice * f.size,
                pnl: f.closedPnl - f.fee,
                pnlPct: entryPrice * f.size > 0 ? (f.closedPnl - f.fee) / (entryPrice * f.size) : 0,
                openedAt: openFill?.timestamp ?? f.timestamp,
                closedAt: f.timestamp,
                status: 'closed' as const,
              };
            }),
        ] : [
          // Paper mode: paper engine trades + paper open positions
          // v2.0.79: Relaxed filter — only filter out truly phantom trades
          // (entry ≈ exit AND PnL ≈ 0). Previous filter was too aggressive,
          // hiding real trades with small price movements.
          ...this.paperEngine.getTrades().slice(-50).filter(t => {
            // Only filter out trades where NOTHING happened — no price
            // movement AND no PnL. These are phantom reconciliation trades.
            const priceMovedPct = Math.abs(t.exitPrice - t.entryPrice) / (t.entryPrice || 1);
            const priceMoved = priceMovedPct > 0.0001; // >0.01% = 1 bps
            const hasPnl = Math.abs(t.pnl) > 0.005; // >$0.005
            return priceMoved || hasPnl;
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
          })),
          // Open paper positions only (real positions hidden in paper mode)
          ...Array.from(this.portfolio.getPortfolio().positions.values())
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
          })),
        ],
      };
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
    // Persist evolution state + portfolio + OLR + shadow trades before shutdown
    this.evolution.persistState();
    this.persistPortfolio();
    this.persistOLR();
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