// ─── AMACRF Main Entry Point ───
// System orchestrator — ties together data, agents, cognition, risk, trading, evolution

import { config } from './config/index.ts';
import { rootLogger, createLogger } from './observability/logger.ts';
import { setupShutdownHandlers, registerShutdownHandler, isShuttingDown } from './utils/shutdown.ts';
import { initializeLLM, getActiveProviderType } from './llm/index.ts';
import { BinanceWebSocketManager, MarketStateAggregator, type AggregatedMarketState } from './data/binance-websocket.ts';
import { HyperliquidWebSocketManager } from './data/hyperliquid-websocket.ts';
import { MultiExchangeWebSocketManager, detectExchange, type UnifiedPrice, type UnifiedOrderBook } from './data/multi-exchange-ws.ts';
import { HACPEngine } from './cognition/hacp.ts';
import { RiskEngine } from './risk/engine.ts';
import { PortfolioTracker } from './trading/portfolio.ts';
import { PaperTradingEngine, type ExecutionReport } from './trading/paper-engine.ts';
import { EvolutionOrchestrator } from './evolution/index.ts';
import { savePortfolio, saveDebateHistory, loadDebateHistory } from './evolution/persistence.ts';
import fs from 'node:fs';
import path from 'node:path';
import { FractalMomentumSentinel, OnChainWhisperer, RBCSentimentAnalyst, IndependentRiskAuditor, NewsReporter, SkepticsAgent, getLastFearGreedValue } from './agents/agents.ts';
import { MetaAgent } from './agents/meta-agent.ts';
import { APIServer } from './api-server.ts';
import { getAllAgentModels, getAvailableModels } from './agents/agent-models.ts';
import { BacktestEngine, type BacktestProgress } from './backtest/index.ts';
import { MarketAgent } from './market-agent/index.ts';
import { RealTradingManager } from './trading/real-trading-manager.ts';
import { SentimentEngine } from './analysis/sentiment-engine.ts';
import { SystemGuard } from './system-guard/index.ts';
import { ExecutionTracker } from './trading/execution-tracker.ts';
import { CorrelationBudget } from './risk/correlation-budget.ts';
import { calculateTakerFee, calculateFundingCost, getFeeSummary } from './trading/cost-model.ts';
import { getSRZones } from './analysis/support-resistance.ts';
import { CycleSummaryManager } from './evolution/cycle-summary.ts';
import { TradePatternClassifier } from './evolution/trade-pattern-classifier.ts';
import { RBCEngine } from './evolution/rbc-clustering.ts';
import type { ConsensusResult, Ticker, AgentThought, AgentStatus, DebateRound, CycleProgress, TradingDecision, MarketAgentConfig, TopVolumePair, MultiSymbolDecision, AgentRole } from './types/index.ts';

const log = createLogger({ phase: 'system' });

class AMACRFSystem {
  private marketState!: MarketStateAggregator;
  private fractalAgent!: FractalMomentumSentinel;
  private onchainAgent!: OnChainWhisperer;
  private regimeAgent!: RBCSentimentAnalyst;
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
  private hyperliquidWs!: HyperliquidWebSocketManager;
  private multiWs!: MultiExchangeWebSocketManager;
  private systemGuard!: SystemGuard;
  private executionTracker!: ExecutionTracker;
  private correlationBudget!: CorrelationBudget;

  private decisionTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private restPollTimer: ReturnType<typeof setInterval> | null = null;
  private tradesToday = 0;
  private totalCycles = 0;
  private cycleInProgress = false;
  private lastCycleDuration = 0;
  private lastHACPResult: { consensus: ConsensusResult; allThoughts: AgentThought[]; debateRounds: DebateRound[] } | null = null;
  private cycleProgress: CycleProgress | null = null;
  private lastSRContext: { formatted: string; regime: string; zoneCount: number; strongZones: number; nearestSupport: number | null; nearestResistance: number | null; distanceToSupportBps: number; distanceToResistanceBps: number; degradedReason: string | null } | null = null;
  private emManager!: CycleSummaryManager;
  private patternClassifier!: TradePatternClassifier;
  private rbcEngine!: RBCEngine;
  private lastPatternContext = '';
  /** Previous cycle's market context + price for hypothetical RBC training */
  private lastCycleRBCContext: { price: number; features: Record<string, number> } | null = null;
  private lastBacktestResult: import('./backtest/index.ts').BacktestResult | null = null;
  private backtestProgress: BacktestProgress | null = null;
  private paused = false;

  constructor() {
    log.info('🏛️  AMACRF System Initializing...');
    log.info(`   Config: ${config.nim.models.default} (NIM), ${config.paper.initialBalance} USDT paper, ${config.system.decisionIntervalMs / 1000}s cycle`);

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
      this.regimeAgent = new RBCSentimentAnalyst();
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

      // 3.5 Initialize Sigmoid·GA Sentiment Engine
      log.info('Step 3.5/8: Initializing Sentiment Engine...');
      this.sentimentEngine = new SentimentEngine();
      log.info('✓ Sentiment Engine ready');

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

      // 3.10 Initialize RBC Engine (replaces GMM EM + Pattern Data)
      log.info('Step 3.10/8: Initializing RBC Engine...');
      this.rbcEngine = new RBCEngine();
      // Load persisted RBC state
      try {
        const rbcPath = path.join(process.cwd(), 'data/evolution/rbc-state.json');
        if (fs.existsSync(rbcPath)) {
          const data = fs.readFileSync(rbcPath, 'utf-8');
          this.rbcEngine.load(data);
        }
      } catch { /* start fresh */ }
      log.info('✓ RBC Engine ready');

      // 3.11 Initialize Trade Pattern Classifier (kept for position management only)
      log.info('Step 3.11/8: Initializing Trade Pattern Classifier...');
      this.patternClassifier = new TradePatternClassifier();
      this.patternClassifier.load();
      log.info('✓ Trade Pattern Classifier ready');

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
      // Wire real-time progress updates to API
      this.hacpEngine.setProgressCallback((progress) => {
        this.cycleProgress = progress;
        this.pushToAPI();
      });
      log.info('✓ HACP engine ready');

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

      // 5.5. Pre-warm NIM models (避免冷啟動)
      const providerType = getActiveProviderType();
      if (providerType === 'nim') {
        log.info('Step 5.5/6: Pre-warming NIM models...');
        const { getActiveProvider } = await import('./llm/index.ts');
        const provider = getActiveProvider();
        // 使用 provider 的 warmUpAllModels 方法（如果可用）
        if ('warmUpAllModels' in provider) {
          await (provider as any).warmUpAllModels();
        } else {
          log.info('✓ Pre-warm skipped (provider does not support)');
        }
      }

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

      // Wire up Market Agent API handlers
      this.apiServer.setMarketAgentSetTradeModeHandler((mode) => {
        log.info(`Market Agent: trade mode → ${mode}`);
        this.marketAgent.setTradeMode(mode);
        this.realTradingManager.setTradeMode(mode);
        this.pushToAPI();
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
      this.apiServer.setMarketAgentSetLeverageHandler((lev) => {
        log.info(`Market Agent: leverage → ${lev}x`);
        this.marketAgent.setLeverage(lev);
        this.pushToAPI();
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
      // Global HL rate-limit queue to prevent 429 across all backend HL calls
      let lastHLCall = 0;
      const HL_MIN_GAP_MS = 500;
      const hlFetchQueued = async (body: object, retries = 5): Promise<Response> => {
        for (let attempt = 0; attempt < retries; attempt++) {
          const now = Date.now();
          const wait = Math.max(0, lastHLCall + HL_MIN_GAP_MS - now);
          if (wait > 0) await new Promise(r => setTimeout(r, wait));
          lastHLCall = Date.now();
          const res = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (res.status !== 429) return res;
          const delay = Math.min(1000 * 2 ** attempt, 8000);
          console.warn(`[candle-proxy] HL 429 for ${(body as any).req?.coin || '?'}, retry ${attempt + 1}/${retries} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
        throw new Error('Hyperliquid API 429 after retries');
      };

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
          // Hyperliquid
          const hlInterval = { '5m': '5m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' }[interval] || '1h';
          const endTime = Date.now();
          const msMap: Record<string, number> = { '5m': 300_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000 };
          const startTime = endTime - (msMap[hlInterval] ?? 3_600_000) * limit;

          const res = await hlFetchQueued({ type: 'candleSnapshot', req: { coin: symbol.toUpperCase().replace(/^.*:/, ''), interval: hlInterval, startTime, endTime } });
          if (!res.ok) throw new Error(`HL ${res.status}`);
          const data = await res.json() as Array<{ t: number; o: string; c: string; h: string; l: string }>;
          return data.map(k => ({
            time: Math.floor(k.t / 1000),
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
      log.info('✓ Hyperliquid WebSocket ready');

      // Multi-Exchange WS — binance left null intentionally (HL-only mode)
      this.multiWs = new MultiExchangeWebSocketManager(null as any, this.hyperliquidWs);
      // Wire unified WS data into sentiment engine + paper engine + marketState
      this.multiWs.onPrice((data: UnifiedPrice) => {
        this.paperEngine.updatePrice(data.symbol, data.price);
        this.sentimentEngine.updatePrice(data.price);
        if (data.fundingRate !== undefined) {
          this.sentimentEngine.updateFundingRate(data.fundingRate);
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

      // REST API polling fallback for price data — 30s interval to avoid HL 429
      this.startRESTPolling();

      // Register shutdown handlers
      registerShutdownHandler('system-timers', async () => {
        this.stopTimers();
      }, 5);

      // Start decision cycles
      this.startDecisionCycle();
      this.startHeartbeat();

      log.info('🚀 AMACRF System is LIVE — paper trading on Binance Mainnet data');

      // Push any restored state (debate history, evolution, portfolio) to UI immediately
      this.pushToAPI();

      // Wait for WebSocket data before first cycle
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Push again after API server is definitely serving SSE clients
      setTimeout(() => this.pushToAPI(), 2000);

      // Run first decision cycle immediately
      await this.runDecisionCycle();
    } catch (err) {
      log.error(`Failed to start AMACRF system: ${err instanceof Error ? err.message : String(err)}`);
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

  /** REST API polling fallback for price data — 30s interval to avoid HL rate limiting */
  private startRESTPolling(): void {
    const pollMs = 30_000;
    log.info(`REST polling started (every ${pollMs / 1000}s) as WebSocket fallback`);

    const poll = async () => {
      try {
        // Fetch price for the Market Agent's active symbol (not just hardcoded BTCUSDT)
        const activeSymbol = this.marketAgent.getSelectedSymbol() || 'BTCUSDT';
        const priceData = await this.marketAgent.fetchPriceForSymbol(activeSymbol);
        if (priceData.price > 0) {
          this.paperEngine.updatePrice(activeSymbol, priceData.price);
        }
      } catch {
        // silent retry on next poll
      }
    };

    void poll();
    this.restPollTimer = setInterval(() => { void poll(); }, pollMs);
  }

  private async runDecisionCycle(): Promise<void> {
    if (isShuttingDown()) return;
    if (this.cycleInProgress) {
      log.warn('Previous decision cycle still running. Skipping this tick.');
      return;
    }

    // ── Market Agent: auto-select top volume pair before agents think ──
    // This blocks until a symbol is selected. If no pairs available yet,
    // we skip the cycle entirely — agents must NOT run without a market.
    const selectedSymbol = await this.marketAgent.autoSelectTopPair();
    if (!selectedSymbol || !this.marketAgent.hasValidSymbol()) {
      log.warn('Market Agent has no valid symbol. Skipping cycle.');
      this.cycleInProgress = false;
      return;
    }
    const activeSymbol = selectedSymbol;
    const activeSymbolUpper = activeSymbol.toUpperCase();

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

    // Update paper engine with the latest price for the active symbol
    // so positions are correctly marked-to-market before the decision cycle
    if (marketPrice > 0) {
      this.paperEngine.updatePrice(activeSymbol, marketPrice);
    }

    // Feed volume data into sentiment engine for volumeRatio computation
    if (marketVolume24h > 0) {
      this.sentimentEngine?.updateVolume(marketVolume24h);
    }

    if (marketPrice <= 0) {
      log.warn(`No market price for ${activeSymbolUpper} — HL API may be rate-limited. Will retry next cycle.`);
      return;
    }

    // ── RBC HYPOTHETICAL TRAINING: Learn from every cycle's price action ──
    // Compare current price vs last cycle's price.
    //   - Price up >0.1% → BUY would have won (feed 1 sample: direction=+1, outcome=WIN)
    //   - Price down >0.1% → SELL would have won (feed 1 sample: direction=-1, outcome=WIN)
    //   - Price change <0.05% → flat market, both sides lose (feed 2 samples: both LOSS)
    //   - 0.05%-0.1% → noise, skip
    // This avoids the 50/50 problem of feeding both outcomes with identical features.
    if (this.lastCycleRBCContext && marketPrice > 0) {
      try {
        const prevPrice = this.lastCycleRBCContext.price;
        const priceChange = (marketPrice - prevPrice) / prevPrice;
        const absChange = Math.abs(priceChange);
        const baseFeatures = this.lastCycleRBCContext.features;

        if (absChange >= 0.001) {
          // Directional move: feed only the winning side
          const buyWon = priceChange > 0;
          this.rbcEngine.feedTrade(activeSymbol, { ...baseFeatures }, 1);
          log.info(`🧬 RBC hypothetical: ${activeSymbol} ${(priceChange * 100).toFixed(2)}% → ${buyWon ? 'BUY=WIN' : 'SELL=WIN'} (cycle #${this.totalCycles})`);
        } else if (absChange < 0.0005) {
          // Flat market: both sides lose
          this.rbcEngine.feedTrade(activeSymbol, { ...baseFeatures }, 0);
          this.rbcEngine.feedTrade(activeSymbol, { ...baseFeatures }, 0);
          log.info(`🧬 RBC hypothetical: ${activeSymbol} flat (${(priceChange * 100).toFixed(2)}%) → BUY=LOSS SELL=LOSS (cycle #${this.totalCycles})`);
        }
        // else: noise (0.05%-0.1%), skip
      } catch (err) {
        log.warn(`[RBC-hypothetical] Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── Save current cycle context for NEXT cycle's RBC hypothetical training ──
    // Do this AFTER the training above so the old context is used for comparison.
    try {
      this.lastCycleRBCContext = {
        price: combinedState.price,
        features: {
          volatility: combinedState.volatility ?? 0,
          srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
          obImbalance: combinedState.orderBookImbalance ?? 0,
          fundingRate: this.sentimentEngine?.getFundingRate() ?? 0,
          volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
          sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
          sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
          signalAgreement: 0.5, // updated after cycle with actual consensus confidence
        },
      };
    } catch { /* non-critical */ }

    // ── SYSTEM GUARD: Run 5-layer protection before any agent thinking ──
    // Guards A (economic calendar), B (drawdown), C (data freshness), D (agent track)
    // Guard E (liquidity) runs later after agents produce a decision
    const guardParams = {
      activeSymbol,
      marketPrice,
      maxDrawdownPct: this.portfolio.getPortfolio().maxDrawdownPct,
      dailyPnl: this.portfolio.getPortfolio().dailyPnl,
      balance: this.portfolio.getPortfolio().balance,
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
      return;
    }

    // Log guard health summary
    const healthSummary = this.systemGuard.getHealthSummary(guardReport);
    if (guardReport.results.some(r => r.severity === 'warn' || r.severity === 'error')) {
      log.warn(`SystemGuard: ${healthSummary}`);
    } else {
      log.info(`SystemGuard: ${healthSummary}`);
    }

    // ── PAUSE CHECK: If paused, skip agents/trading but keep RBC running ──
    if (this.paused) {
      log.info(`⏸️ System paused — RBC training complete, skipping HACP agents and trading (cycle #${this.totalCycles})`);
      this.cycleInProgress = false;
      this.pushToAPI();
      return;
    }

    this.cycleInProgress = true;
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

      // 1e. Inject RBC assessment (range-based win/loss regions from price action)
      let rbcContext = '';
      try {
        const rbcBuy = this.rbcEngine.query(activeSymbol, {
          volatility: combinedState.volatility ?? 0,
          srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
          obImbalance: combinedState.orderBookImbalance ?? 0,
          fundingRate: this.sentimentEngine?.getFundingRate() ?? 0,
          volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
          sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
          sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
          signalAgreement: 0.5, // updated after cycle with actual consensus confidence
        });
        const rbcSell = this.rbcEngine.query(activeSymbol, {
          volatility: combinedState.volatility ?? 0,
          srDistanceBps: this.lastSRContext?.distanceToSupportBps ?? 0,
          obImbalance: combinedState.orderBookImbalance ?? 0,
          fundingRate: this.sentimentEngine?.getFundingRate() ?? 0,
          volumeRatio: this.sentimentEngine?.getVolumeRatio() ?? 1,
          sentiment: this.sentimentEngine?.getSentiment()?.overallSentiment ?? 0,
          sentimentConviction: this.sentimentEngine?.getSentiment()?.conviction ?? 0.5,
          signalAgreement: 0.5, // updated after cycle with actual consensus confidence
        });
        const hasData = rbcBuy.verdict !== 'no_edge' || rbcSell.verdict !== 'no_edge'
          || (rbcBuy.explanation && !rbcBuy.explanation.startsWith('Only'))
          || (rbcSell.explanation && !rbcSell.explanation.startsWith('Only'));
        if (hasData) {
          const lines: string[] = ['=== RBC ASSESSMENT ==='];
          lines.push('Range-Based Clustering: growing hyperrectangles from hypothetical price action.');
          lines.push(`BUY  → ${rbcBuy.verdict.toUpperCase()} (edge=${(rbcBuy.edgeScore * 100).toFixed(0)}%, ${rbcBuy.winDims}W/${rbcBuy.lossDims}L dims, ${rbcBuy.discriminativeDims}/${rbcBuy.totalDims} discriminative)`);
          lines.push(`SELL → ${rbcSell.verdict.toUpperCase()} (edge=${(rbcSell.edgeScore * 100).toFixed(0)}%, ${rbcSell.winDims}W/${rbcSell.lossDims}L dims, ${rbcSell.discriminativeDims}/${rbcSell.totalDims} discriminative)`);
          lines.push(`INTERPRETATION: FAVORABLE → win territory, increase conviction. UNFAVORABLE → loss territory, strong bias against entry. NO_EDGE → current values sit in the overlap zone on every dimension — the system lacks directional clarity. This is itself a useful signal: it means the market state is ambiguous relative to past patterns, and the RBC agent should HOLD or rely on other signals. winDims/lossDims still show tilt even in NO_EDGE (which side of each overlap boundary the value falls).`);
          rbcContext = '\n' + lines.join('\n');
        }
      } catch { /* non-critical */ }

      const marketDesc = `${baseMarketDesc}${srLines}${emContext ? `\n${emContext}` : ''}${patternContext ? `\n${patternContext}` : ''}${rbcContext}`;

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

      // 2. Build agent context (including evolution memory + backtest knowledge)
      const evolutionContext = this.evolution.getContextForAgent(combinedState.regime);
      const backtestContext = this.backtest.getBacktestSummary();
      const portfolioDesc = this.paperEngine.getPortfolioSummary();

      // 3. HACP Decision Cycle
      log.info('🤖 HACP: Starting multi-agent cognition...');

      // Sync real exchange positions into local portfolio before agents think
      if (this.realTradingManager.getTradeMode() === 'real') {
        await this.realTradingManager.syncExchangePositions();
        log.info('📡 Exchange positions synced for agent context');
      }

      // ── Position Reconciliation (Skeptics phase) ──
      // Detect orphan positions — open in local portfolio but no longer active
      // on the exchange (real mode) or stale from a previous session (paper mode).
      {
        let externalSymbols: string[];

        if (this.realTradingManager.getTradeMode() === 'real') {
          // Real mode: ask the exchange what positions it has open.
          // Any local mirror without a matching exchange position was
          // manually closed on the exchange.
          externalSymbols = await this.realTradingManager.getOpenPositionSymbols();
        } else {
          // Paper mode: no external exchange to verify against.
          // Only clean up truly stale positions — those opened in a
          // PREVIOUS system session on a different trading symbol
          // that have been sitting untouched for >12h.
          // DO NOT remove recently-opened positions (even on non-active
          // symbols) — they may be exploration trades or multi-symbol.
          const now = Date.now();
          const staleCutoff = 3_600_000 * 12; // 12 hours
          // Keep ALL positions opened within the session window +
          // positions on the active symbol (regardless of age)
          const activeSym = activeSymbol.toLowerCase();
          externalSymbols = this.portfolio.getOpenSymbols().filter(sym => {
            if (sym === activeSym) return true;
            const pos = this.portfolio.getPosition(sym);
            return !!pos && (now - pos.openedAt < staleCutoff);
          });
        }

        const reconciled = this.portfolio.reconcilePositions(externalSymbols);
        if (reconciled.length > 0) {
          log.info(`🧹 Reconciled ${reconciled.length} stale position(s): ${reconciled.join(', ')}`);
          // Update portfolio description after reconciliation
          this.pushToAPI();
        }
      }

      // Build current positions for TP/SL adjustment
      const currentPositions = Array.from(this.portfolio.getPortfolio().positions.values()).map(p => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.averageEntryPrice,
        currentPrice: p.currentPrice,
        stopLoss: p.stopLossPrice,
        takeProfit: p.takeProfitPrice,
        leverage: p.leverage,
        quantity: p.quantity,
        exchange: (p as any).exchange ?? 'hyperliquid',
      }));

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
      );

      // 3.1 Apply position adjustments (TP/SL) from meta-agent
      if (result.positionAdjustments && result.positionAdjustments.length > 0) {
        for (const adj of result.positionAdjustments) {
          this.portfolio.adjustPosition(adj.positionId, adj.newStopLoss, adj.newTakeProfit);
          log.info(`📐 Position ${adj.positionId.slice(0, 8)} adjusted: SL=${adj.newStopLoss?.toFixed(2) ?? '-'} TP=${adj.newTakeProfit?.toFixed(2) ?? '-'}`);
        }
      }

      // 3.5 Exploration trade: if consensus is HOLD but we haven't traded in 3+ cycles,
      // force a tiny exploratory position to generate evolution data.
      // This fires even after Risk Auditor veto — the system NEEDS trade data to evolve.
      // Direction is determined by Pattern Classifier: query BUY vs SELL win rates
      // for current market conditions and pick the higher one.
      let finalDecision = result.consensus.decision;
      if (finalDecision.action === 'hold' && this.totalCycles > 2 && this.totalCycles % 3 === 0) {
        const p = this.portfolio.getPortfolio();
        if (p.positions.size === 0) {
          const maConfig = this.marketAgent.getConfig();
          const exploreSize = maConfig.positionSizePct;
          const exploreLev = maConfig.leverage;

          // Use Pattern Classifier to pick direction — compare BUY vs SELL win rates.
          // Fallback to technical signals when pattern data is insufficient.
          let direction: string | null = null;
          try {
            const sentimentData = this.sentimentEngine?.getSentiment();
            const hlPrice = this.hyperliquidWs?.getLatestMarkPrice?.();
            const actualFundingRate = hlPrice?.fundingRate ?? 0;
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

            // Priority 0: RBC assessment (highest weight — RBC & Sentiment Analyst's primary factor)
            if (!direction) {
              const rbcCtx = {
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
              const rbcBuy = this.rbcEngine.query(combinedState.primarySymbol, { ...rbcCtx });
              const rbcSell = this.rbcEngine.query(combinedState.primarySymbol, { ...rbcCtx });
              if (rbcBuy.verdict === 'favorable' && rbcSell.verdict !== 'favorable') {
                direction = 'buy';
                log.info(`🧪 RBC-guided: BUY favorable (edge=${(rbcBuy.edgeScore * 100).toFixed(0)}%)`);
              } else if (rbcSell.verdict === 'favorable' && rbcBuy.verdict !== 'favorable') {
                direction = 'sell';
                log.info(`🧪 RBC-guided: SELL favorable (edge=${(rbcSell.edgeScore * 100).toFixed(0)}%)`);
              } else if (rbcBuy.verdict === 'unfavorable' && rbcSell.verdict === 'favorable') {
                direction = 'sell';
                log.info(`🧪 RBC-guided: BUY unfavorable, SELL favorable → SELL`);
              } else if (rbcSell.verdict === 'unfavorable' && rbcBuy.verdict === 'favorable') {
                direction = 'buy';
                log.info(`🧪 RBC-guided: SELL unfavorable, BUY favorable → BUY`);
              } else if (rbcBuy.verdict === 'unfavorable' && rbcSell.verdict === 'unfavorable') {
                direction = null; // both unfavorable → no exploration
                log.info(`🧪 RBC-guided: Both BUY and SELL unfavorable → skip exploration`);
              }
              // If both no_edge or mixed, fall through to other signals
            }

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

            // Priority 2: Sigmoid·GA sentiment (forward-looking market emotion)
            if (!direction && sentimentData && Math.abs(sentimentData.overallSentiment) > 0.15) {
              direction = sentimentData.overallSentiment > 0 ? 'buy' : 'sell';
              log.info(`🧪 Sentiment-guided: overall=${(sentimentData.overallSentiment*100).toFixed(0)}% → ${direction.toUpperCase()}`);
            }

            // Priority 3: Funding rate (negative = longs get paid = bullish, positive = bearish)
            if (!direction && Math.abs(actualFundingRate) > 0.0001) {
              direction = actualFundingRate < 0 ? 'buy' : 'sell';
              log.info(`🧪 Funding-guided: rate=${(actualFundingRate*10000).toFixed(2)}bps → ${direction.toUpperCase()}`);
            }

            // Priority 4: Order book imbalance (positive = bid pressure = buy, negative = sell pressure)
            if (!direction && combinedState.orderBookImbalance !== undefined && Math.abs(combinedState.orderBookImbalance) > 0.15) {
              direction = combinedState.orderBookImbalance > 0 ? 'buy' : 'sell';
              log.info(`🧪 OB-guided: imbalance=${(combinedState.orderBookImbalance*100).toFixed(0)}% → ${direction.toUpperCase()}`);
            }

            // Priority 5: Regime / Trend
            if (!direction) {
              if (combinedState.regime === 'trending_bull') {
                direction = 'buy';
                log.info(`🧪 Regime-guided: trending_bull → BUY`);
              } else if (combinedState.regime === 'trending_bear') {
                direction = 'sell';
                log.info(`🧪 Regime-guided: trending_bear → SELL`);
              }
            }
          } catch (err) {
            log.warn(`Pattern direction check failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          // If all signals neutral (e.g. sideways regime, no sentiment), default to buy as neutral
          if (!direction) {
            direction = 'buy';
            log.info(`🧪 No directional signal — defaulting to BUY (neutral exploration)`);
          }

          finalDecision = {
            action: direction as 'buy' | 'sell',
            symbol: activeSymbolUpper,
            entryPrice: combinedState.price,
            positionSizePct: exploreSize,
            stopLossPct: 0.01,
            takeProfitPct: 0.02,
            leverage: exploreLev,
            rationale: `Exploratory ${direction} (${(exploreSize * 100).toFixed(1)}% size, ${exploreLev}x lev) on ${activeSymbolUpper} — ${direction} exploration.`,
            urgency: 'immediate',
          };
          log.info(`🧪 Exploration trade triggered: ${direction.toUpperCase()} ${(exploreSize * 100).toFixed(1)}% ${activeSymbolUpper} @ ${exploreLev}x (cycle #${this.totalCycles})`);
        }
      }

      // ── Execute PER-POSITION decisions from agents (profitable positions only) ──
      // If >=2 agents recommend closing a position that is IN PROFIT (>+0.5%),
      // take profits early. Losing positions are NEVER closed by agent votes —
      // they must ride to SL/TP. This prevents panic-closing during drawdowns.
      const allThoughts = result.allThoughts;
      const perPositionCloseReports: ExecutionReport[] = [];
      for (const posSymbol of this.portfolio.getOpenSymbols()) {
        const pos = this.portfolio.getPosition(posSymbol);
        if (!pos) continue;
        // Only allow agent-based close if position is in profit (>+0.5% return on margin)
        if ((pos.unrealizedPnlPct ?? 0) <= 0.005) continue; // Not enough profit — let SL/TP handle it

        const closeVotes = allThoughts.filter(t => {
          if (t.agentRole === 'meta_agent' || t.agentRole === 'market_agent') return false;
          const msd = t.metadata?.['multiSymbolDecision'] as any;
          const posDecision = msd?.positions?.find((p: any) => p.symbol?.toLowerCase() === posSymbol.toLowerCase());
          return posDecision?.closePosition === true;
        }).length;
        if (closeVotes >= 2) {
          log.warn(`⚠️ ${closeVotes} agents recommend taking profit on ${posSymbol} @ $${pos.currentPrice.toFixed(2)} (PnL: +${((pos.unrealizedPnlPct ?? 0)*100).toFixed(2)}%)...`);
          const trade = this.portfolio.closePosition(posSymbol, pos.currentPrice);
          if (trade) {
            perPositionCloseReports.push({ order: {} as any, trade });
            log.info(`  → Took profit on ${posSymbol}: $${trade.pnl.toFixed(2)}`);
          }
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
      log.info(`💼 Executing ${this.realTradingManager.getTradeMode().toUpperCase()} trading decision...`);
      const execResult = await this.realTradingManager.executeDecision(finalDecision);
      const reports: ExecutionReport[] = execResult.paperReports ?? [];
      // When real-mode, paperReports mirrors the real trade into the local portfolio
      // so all downstream P&L tracking, stop-loss monitoring, and evolution learning work identically.

      // ── P0: Apply Taker Fees to all executed trades ──
      // Deduct HL taker fee (0.04%) from each trade's PnL so paper PnL reflects real costs.
      for (const report of reports) {
        if (!report.trade) continue;
        try {
          const notional = Math.abs(report.trade.entryPrice * report.trade.quantity);
          const fee = calculateTakerFee(notional);
          // Deduct fee from trade PnL (portfolio trade already recorded, adjust balance)
          report.trade.pnl -= fee;
          report.trade.pnlPct = report.trade.investment > 0 ? report.trade.pnl / report.trade.investment : 0;
          log.info(`💰 Fee deducted: $${fee.toFixed(2)} (${(fee / notional * 100).toFixed(4)}%) from ${report.trade.symbol}`);

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
                  const posDecision = msd?.positions?.find((p: any) => p.symbol?.toLowerCase() === report.trade!.symbol.toLowerCase());
                  return { role: t.agentRole, action: posDecision?.action ?? 'hold', confidence: t.confidence };
                }),
            );
          } catch (err) {
            log.error(`[pattern-snapshot] Failed for ${report.trade?.symbol}: ${err instanceof Error ? err.message : String(err)}`);
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
      try {
        const openPositions = this.portfolio.getOpenSymbols();
        if (openPositions.length > 0) {
          const positions = openPositions.map(sym => {
            const pos = this.portfolio.getPosition(sym);
            return {
              symbol: sym,
              notional: pos ? pos.currentPrice * pos.quantity * pos.leverage : 0,
              direction: pos?.side === 'buy' ? 1 : -1,
            };
          }).filter(p => p.notional > 0);

          if (positions.length > 0) {
            // Update correlation matrix asynchronously (cached, daily refresh)
            this.correlationBudget.update(
              positions.map(p => p.symbol),
              async (body: object) => {
                const res = await fetch('https://api.hyperliquid.xyz/info', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body),
                });
                return res;
              },
            ).catch(() => {});

            const report = this.correlationBudget.generateReport(positions, this.portfolio.getPortfolio().balance);
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
      this.evolution.tradeHistory.updateLastExit(combinedState.price);

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

      // 9.6 Persist evolution state + portfolio + debate history + patterns + RBC to disk
      this.evolution.persistState();
      this.patternClassifier?.persist();
      this.persistRBC();
      this.persistPortfolio();
      saveDebateHistory({
        totalCycles: this.totalCycles,
        lastCycleDuration: cycleDuration,
        consensus: result.consensus,
        debateRounds: result.debateRounds,
        allThoughts: result.allThoughts,
      });

      // 10. Print portfolio summary
      log.info(`\n📊 ${this.portfolio.getPortfolio().totalPnl >= 0 ? '🟢' : '🔴'} Portfolio:`, {
        balance: this.portfolio.getPortfolio().balance.toFixed(2),
        equity: this.portfolio.getPortfolio().totalEquity.toFixed(2),
        pnl: `${this.portfolio.getPortfolio().totalPnl >= 0 ? '+' : ''}${this.portfolio.getPortfolio().totalPnl.toFixed(2)}`,
        drawdown: `${(this.portfolio.getPortfolio().maxDrawdownPct * 100).toFixed(2)}%`,
        positions: this.portfolio.getPortfolio().positions.size,
      });

      // 8. M-step: Update convergence accuracy based on price direction since last cycle
      try {
        const prevPrice = this.totalCycles > 1 ? result.allThoughts[0]?.metadata?.['price'] as number | undefined : undefined;
        if (prevPrice && this.emManager && this.emManager.length >= 2) {
          const priceChange = (combinedState.price - prevPrice) / prevPrice;
          const direction: 'up' | 'down' | 'flat' = priceChange > 0.002 ? 'up' : priceChange < -0.002 ? 'down' : 'flat';
          this.emManager.updateConvergence(direction);
        }
      } catch { /* non-critical */ }

      // ── Save current cycle context for NEXT cycle's RBC hypothetical training ──
      // (Primary save is at cycle START; this is a backup update with final signalAgreement)
      try {
        if (this.lastCycleRBCContext) {
          this.lastCycleRBCContext.features['signalAgreement'] = result.consensus.confidence;
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

    } catch (err) {
      log.error(`Decision cycle #${this.totalCycles} failed:`, {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.cycleInProgress = false;
      this.cycleProgress = null;
      this.pushToAPI();
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
  /** Serialize portfolio (Map → plain object) for JSON transmission */
  private serializePortfolio(p: Readonly<import('./types/index.ts').Portfolio>): Record<string, unknown> {
    const positions: Record<string, unknown> = {};
    for (const [key, pos] of p.positions) {
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
        exchange: pos.exchange,
      };
    }
    return {
      balance: p.balance,
      initialBalance: p.initialBalance,
      totalEquity: p.totalEquity,
      totalPnl: p.totalPnl,
      totalPnlPct: p.totalPnlPct,
      maxDrawdown: p.maxDrawdown,
      maxDrawdownPct: p.maxDrawdownPct,
      peakEquity: p.peakEquity,
      dailyPnl: p.dailyPnl,
      dailyLossLimit: p.dailyLossLimit,
      tradeCount: p.tradeCount,
      winCount: p.winCount,
      lossCount: p.lossCount,
      lastUpdated: p.lastUpdated,
      positions,
    };
  }

  private persistPortfolio(): void {
    try {
      savePortfolio(this.portfolio.getPortfolio(), this.paperEngine.getTrades());
    } catch (err) {
      // Best-effort
    }
  }

  private persistRBC(): void {
    try {
      const dir = path.join(process.cwd(), 'data/evolution');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, 'rbc-state.json.tmp');
      const final = path.join(dir, 'rbc-state.json');
      fs.writeFileSync(tmp, this.rbcEngine.save(), 'utf-8');
      fs.renameSync(tmp, final);
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
      const effectiveOB = hlOB;
      const largeTradeNorm = Math.min(1, totalLargeTrades / 10);

      this.sentimentEngine.compute({
        price: state.price,
        volume24h: state.volume24h,
        orderBookImbalance: effectiveOB !== 0 ? effectiveOB : state.orderBookImbalance,
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

    return lines.join('\n');
  }

  private printSystemStatus(): string {
    const p = this.portfolio.getPortfolio();
    const status = [
      `┌─────────────────────────────────────┐`,
      `│ 🏛️  AMACRF System Status              │`,
      `├─────────────────────────────────────┤`,
      `│ Cycles: ${String(this.totalCycles).padEnd(8)} Balance: $${p.balance.toFixed(0).padStart(6)}│`,
      `│ Equity: $${p.totalEquity.toFixed(0).padStart(6)}  PnL: ${(p.totalPnl >= 0 ? '+' : '')}${p.totalPnl.toFixed(0).padStart(5)} │`,
      `│ Drawdown: ${(p.maxDrawdownPct * 100).toFixed(1).padStart(5)}%     Positions: ${p.positions.size}          │`,
      `│ WS: ${this.multiWs?.isConnected() ? '✓' : '✗'} (${this.multiWs?.getActiveExchange() ?? '?'})  Trades: ${p.tradeCount} (W:${p.winCount} L:${p.lossCount})   │`,
      `└─────────────────────────────────────┘`,
    ].join('\n');

    log.info(`\n${status}`);
    return status;
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

      this.apiServer.update({
        systemPaused: this.paused,
        status: {
          cycles: this.totalCycles,
          balance: p.balance,
          equity: p.totalEquity,
          totalPnl: p.totalEquity - p.initialBalance,
          totalPnlPct: p.initialBalance > 0 ? (p.totalEquity - p.initialBalance) / p.initialBalance : 0,
          drawdownPct: p.maxDrawdownPct,
          positions: p.positions.size,
          wsConnected: this.multiWs?.isConnected?.() ?? false,
          tradeCount: p.tradeCount,
          winCount: p.winCount,
          lossCount: p.lossCount,
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
        rbcState: (() => {
          const allStats = this.rbcEngine.getAllModelStats();
          const pendingStats = this.rbcEngine.getPendingStats();
          const hasData = allStats.length > 0 || pendingStats.length > 0;
          if (!hasData) return undefined;
          // Get dim details for the first symbol with data
          const firstSymbol = allStats[0]!.symbol;
          const dimDetails = this.rbcEngine.getDimDetails(firstSymbol);
          // Merge current feature values from query()
          const queryResult = this.lastCycleRBCContext ? this.rbcEngine.query(firstSymbol, this.lastCycleRBCContext.features) : null;
          const valueMap = new Map(queryResult?.dimDetails.map(d => [d.name, d.value]) ?? []);
          // Use query()'s discriminativeDims (considers current value position) instead of getAllModelStats()'s static count
          const liveDiscriminativeDims = queryResult?.discriminativeDims ?? 0;
          return {
            symbols: allStats.map(s => ({
              symbol: s.symbol,
              winCount: s.winCount,
              lossCount: s.lossCount,
              totalSamples: s.totalSamples,
              discriminativeDims: liveDiscriminativeDims,
              totalDims: s.totalDims,
            })),
            pending: pendingStats.map(p => ({
              symbol: p.symbol,
              pending: p.pending,
              needed: p.needed,
              pct: p.pct,
            })),
            dimDetails: dimDetails ? dimDetails.map(d => ({
              name: d.name,
              value: valueMap.get(d.name) ?? 0,
              winMin: d.winMin, winMax: d.winMax, winCentroid: d.winCentroid,
              lossMin: d.lossMin, lossMax: d.lossMax, lossCentroid: d.lossCentroid,
              overlap: d.overlap, boundary: d.boundary,
              globalMin: d.globalMin, globalMax: d.globalMax,
            })) : undefined,
          };
        })(),
        agentModels: {
          available: getAvailableModels(),
          assignments: getAllAgentModels(),
        },
        cycleProgress: this.cycleProgress,
        hacpThreshold: this.hacpEngine.getCurrentThreshold(),
        evolution: this.evolution.getEvolutionData(),
        backtest: this.lastBacktestResult,
        backtestProgress: this.backtestProgress,
        tradeHistory: this.evolution.tradeHistory.getAllEntries().slice(-50),
        marketAgent: marketAgentState,
        tradeRecords: [
          ...this.paperEngine.getTrades().slice(-50).map(t => ({
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
        ],
        // Include open positions separately for the positions table
        // (NOT duplicated in tradeRecords which is for CLOSED trades only)
      });
    } catch (err) {
      // API push is best-effort
    }
  }

  async stop(): Promise<void> {
    // Persist evolution state + portfolio + RBC before shutdown
    this.evolution.persistState();
    this.persistPortfolio();
    this.persistRBC();
    this.stopTimers();
    await this.apiServer?.stop();
    await this.multiWs?.disconnect();
    log.info('AMACRF system stopped cleanly.');
  }
}

// ─── Boot ───

async function main(): Promise<void> {
  const system = new AMACRFSystem();

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