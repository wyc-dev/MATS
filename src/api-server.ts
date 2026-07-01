// ─── MATS API Server ───
// Lightweight HTTP server exposing system state via REST + SSE for the React UI

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './observability/logger.ts';
// v2.0.42: Import normalizeSymbol for manual close symbol normalization.
import { normalizeSymbol } from './trading/portfolio.ts';
import { getAllAgentModels, getAvailableModels, setAgentModel, resetAgentModel, type AgentModelConfig, type ModelDefinition } from './agents/agent-models.ts';
import type { AgentThought, ConsensusResult, DebateRound, Portfolio, MarketState, AgentStatus, CycleProgress, MarketAgentConfig, TopVolumePair, TradeMode, ExchangeType, HyperliquidAssetType } from './types/index.ts';
import type { BacktestResult, BacktestProgress } from './backtest/index.ts';

const log = createLogger({ phase: 'api' });

export interface SystemSnapshot {
  cycles: number;
  balance: number | null;
  equity: number | null;
  totalPnl: number | null;
  totalPnlPct: number;
  drawdownPct: number;
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
  evolution?: Record<string, unknown>;
  backtest?: BacktestResult | null;
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
    id: string; symbol: string; side: string;
    entryPrice: number; exitPrice: number; quantity: number;
    leverage: number; investment: number;
    pnl: number; pnlPct: number;
    openedAt: number; closedAt: number;
    /** 'hl-fill' = a real Hyperliquid fill synced from the exchange (v2.0.19) */
    status: 'open' | 'closed' | 'hl-fill';
  }>;
  marketAgent?: {
    config: MarketAgentConfig;
    topPairs: TopVolumePair[];
  };
  executionStats?: {
    totalTrades: number;
    totalNotional: number;
    avgSlippageBps: number;
    maxSlippageBps: number;
    totalFees: number;
    tradeCount: number;
  };
  correlationSummary?: string;
  srContext?: {
    formatted: string;
    regime: string;
    zoneCount: number;
    strongZones: number;
    nearestSupport: number | null;
    nearestResistance: number | null;
    distanceToSupportBps: number;
    distanceToResistanceBps: number;
    degradedReason: string | null;
  };
  emState?: {
    summaryCount: number;
    convergenceAccuracy: number;
    convergenceChecks: number;
    latestInsight: string | null;
    latestSignal: string | null;
  };
  patternStats?: {
    totalPatterns: number;
    closedTrades: number;
    wins: number;
    losses: number;
    cacheEntries: number;
  };
  /** v2.0.28: Pattern tag tracker stats */
  patternTagStats?: {
    totalRecords: number;
    pending: number;
    closed: number;
    uniqueTags: number;
  };
  patternTagSummary?: {
    stats: Array<{
      tag: string;
      side: 'buy' | 'sell';
      total: number;
      wins: number;
      losses: number;
      winRate: number;
      adjustedWinRate: number;
      avgPnlPct: number;
    }>;
    totalRecords: number;
    uniqueTags: number;
  };
  /** GMM EM clustering model summary (per-symbol) — DEPRECATED, use rbcState */
  emClusterState?: {
    symbols: Array<{
      symbol: string;
      clusterCount: number;
      totalSamples: number;
      bic: number;
      clusters: Array<{ index: number; winRate: number; sampleCount: number; weight: number }>;
    }>;
  };
  /** RBC (Range-Based Clustering) state summary (per-symbol) */
  rbcState?: {
    symbols: Array<{
      symbol: string;
      winCount: number;
      lossCount: number;
      totalSamples: number;
      discriminativeDims: number;
      totalDims: number;
      /** Per-dimension range details for UI colour bars (🆕 per-symbol, v2.0.6) */
      dimDetails?: Array<{
        name: string;
        value: number;
        winMin: number; winMax: number; winCentroid: number;
        lossMin: number; lossMax: number; lossCentroid: number;
        overlap: boolean; boundary: number | null;
        globalMin: number; globalMax: number;
      }>;
    }>;
    pending: Array<{
      symbol: string;
      pending: number;
      needed: number;
      pct: number;
    }>;
  };
  systemPaused?: boolean;
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
  };
}

type SSECallback = (data: APIData) => void;

export class APIServer {
  private server: http.Server | null = null;
  private port: number;
  private sseClients: Set<http.ServerResponse> = new Set();
  private data: APIData | null = null;
  private uiDir: string;
  private onShutdown: (() => void) | null = null;
  private onTriggerCycle: (() => void) | null = null;
  private onBacktest: ((params: { years: number; symbol: string; interval: string; maxCandles: number; model?: string; reverse?: boolean }) => void) | null = null;
  private onBacktestPause: (() => void) | null = null;
  private onBacktestResume: (() => void) | null = null;
  private onBacktestStop: (() => void) | null = null;
  private onMarketAgentSetTradeMode: ((mode: TradeMode) => void) | null = null;
  private onMarketAgentSetExchange: ((exchange: ExchangeType) => void) | null = null;
  private onMarketAgentSetAssetType: ((assetType: HyperliquidAssetType) => void) | null = null;
  private onMarketAgentFetchPairs: (() => void) | null = null;
  private onMarketAgentSetPositionSize: ((pct: number) => void) | null = null;
  /** v2.0.XX: Max portion of balance for all positions combined. */
  private onMarketAgentSetMaxPortion: ((pct: number) => void) | null = null;
  private onMarketAgentSetLeverage: ((lev: number) => void) | null = null;
  /** v2.0.44: Manual symbol selection from Top Volume Pairs list. */
  private onMarketAgentSelectSymbol: ((symbol: string) => void) | null = null;
  /** v2.0.79: Set trading markets list from UI pills. */
  private onSetTradingMarkets: ((markets: string[]) => void) | null = null;
  /** v2.0.45: Clear drawdown data to relaunch trading after circuit breaker. */
  private onClearDrawdown: (() => void) | null = null;
  private onManualClosePosition: ((symbol: string) => Promise<{ success: boolean; error?: string }>) | null = null;
  private onCandlesRequest: ((symbol: string, interval: string, limit: number) => Promise<Array<{ time: number; open: number; high: number; low: number; close: number }>>) | null = null;
  private onResetTradeHistory: (() => void) | null = null;
  /** v2.0.79: Reset paper engine trades */
  private onResetPaperTrades: (() => void) | null = null;
  private onPause: (() => void) | null = null;
  private onResume: (() => void) | null = null;

  constructor(port = 3456) {
    this.port = port;
    const possiblePaths = [
      path.resolve(import.meta.dirname ?? process.cwd(), '../ui/dist'),
      path.resolve(process.cwd(), 'ui/dist'),
      path.resolve(process.cwd(), '../ui/dist'),
    ];
    this.uiDir = possiblePaths.find(p => fs.existsSync(p)) ?? possiblePaths[0]!;
  }

  /** Register a callback for graceful shutdown */
  setShutdownHandler(cb: () => void): void {
    this.onShutdown = cb;
  }

  /** Register a callback for triggering an immediate cycle */
  setTriggerCycleHandler(cb: () => void): void {
    this.onTriggerCycle = cb;
  }

  /** Register a callback for running a backtest */
  setBacktestHandler(cb: (params: { years: number; symbol: string; interval: string; maxCandles: number; model?: string; reverse?: boolean }) => void): void {
    this.onBacktest = cb;
  }

  /** Register a callback for pausing the running backtest */
  setBacktestPauseHandler(cb: () => void): void {
    this.onBacktestPause = cb;
  }

  /** Register a callback for resuming the paused backtest */
  setBacktestResumeHandler(cb: () => void): void {
    this.onBacktestResume = cb;
  }

  /** Register a callback for stopping/cancelling the running backtest */
  setBacktestStopHandler(cb: () => void): void {
    this.onBacktestStop = cb;
  }

  /** Register a callback for setting trade mode */
  setMarketAgentSetTradeModeHandler(cb: (mode: TradeMode) => void): void {
    this.onMarketAgentSetTradeMode = cb;
  }

  /** Register a callback for setting exchange */
  setMarketAgentSetExchangeHandler(cb: (exchange: ExchangeType) => void): void {
    this.onMarketAgentSetExchange = cb;
  }

  /** Register a callback for setting Hyperliquid asset type */
  setMarketAgentSetAssetTypeHandler(cb: (assetType: HyperliquidAssetType) => void): void {
    this.onMarketAgentSetAssetType = cb;
  }

  /** Register a callback for fetching top pairs */
  setMarketAgentFetchPairsHandler(cb: () => void): void {
    this.onMarketAgentFetchPairs = cb;
  }

  /** Register a callback for setting position size */
  setMarketAgentSetPositionSizeHandler(cb: (pct: number) => void): void {
    this.onMarketAgentSetPositionSize = cb;
  }

  /** v2.0.XX: Register a callback for setting max portion */
  setMarketAgentSetMaxPortionHandler(cb: (pct: number) => void): void {
    this.onMarketAgentSetMaxPortion = cb;
  }

  /** Register a callback for manual position close */
  setManualClosePositionHandler(cb: (symbol: string) => Promise<{ success: boolean; error?: string }>): void {
    this.onManualClosePosition = cb;
  }

  /** Register a callback for setting leverage */
  setMarketAgentSetLeverageHandler(cb: (lev: number) => void): void {
    this.onMarketAgentSetLeverage = cb;
  }

  /** v2.0.44: Register a callback for manual symbol selection from Top Volume Pairs */
  setMarketAgentSelectSymbolHandler(cb: (symbol: string) => void): void {
    this.onMarketAgentSelectSymbol = cb;
  }

  /** v2.0.79: Register a callback for setting trading markets list from UI */
  setTradingMarketsHandler(cb: (markets: string[]) => void): void {
    this.onSetTradingMarkets = cb;
  }

  /** v2.0.45: Register a callback for clearing drawdown data to relaunch trading */
  setClearDrawdownHandler(cb: () => void): void {
    this.onClearDrawdown = cb;
  }

  /** Register a callback for fetching candle data */
  setCandlesRequestHandler(cb: (symbol: string, interval: string, limit: number) => Promise<Array<{ time: number; open: number; high: number; low: number; close: number }>>): void {
    this.onCandlesRequest = cb;
  }

  /** Register a callback for resetting trade history */
  setResetTradeHistoryHandler(cb: () => void): void {
    this.onResetTradeHistory = cb;
  }

  /** v2.0.79: Register a callback for resetting paper engine trades */
  setResetPaperTradesHandler(cb: () => void): void {
    this.onResetPaperTrades = cb;
  }

  /** Register a callback for pausing the system (RBC only mode) */
  setPauseHandler(cb: () => void): void {
    this.onPause = cb;
  }

  /** Register a callback for resuming the system */
  setResumeHandler(cb: () => void): void {
    this.onResume = cb;
  }

  /** Update the latest system data and broadcast to SSE clients */
  update(data: APIData): void {
    this.data = data;
    this.broadcastSSE(data);
  }

  private broadcastSSE(data: APIData): void {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  start(): void {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // ── API Routes ──

      // SSE endpoint for real-time updates
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Send initial data if available
        if (this.data) {
          res.write(`data: ${JSON.stringify(this.data)}\n\n`);
        }

        this.sseClients.add(res);
        log.info(`SSE client connected (total: ${this.sseClients.size})`);

        req.on('close', () => {
          this.sseClients.delete(res);
          log.info(`SSE client disconnected (total: ${this.sseClients.size})`);
        });
        return;
      }

      // REST: system status
      if (pathname === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.data?.status ?? {}));
        return;
      }

      // REST: agent thoughts
      if (pathname === '/api/agents') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          thoughts: this.data?.agentThoughts ?? [],
          statuses: this.data?.agentStatuses ?? [],
        }));
        return;
      }

      // REST: portfolio
      if (pathname === '/api/portfolio') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.data?.portfolio ?? {}));
        return;
      }

      // REST: latest cycle
      if (pathname === '/api/cycle') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          consensus: this.data?.consensus,
          debateRounds: this.data?.debateRounds,
        }));
        return;
      }

      // REST: market state
      if (pathname === '/api/market') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.data?.marketState ?? {}));
        return;
      }

      // REST: agent model config
      if (pathname === '/api/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          available: getAvailableModels(),
          assignments: getAllAgentModels(),
        }));
        return;
      }

      // POST: update agent model
      if (pathname === '/api/models/assign' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { role, model } = JSON.parse(body) as { role: string; model: string };
            const success = setAgentModel(role as any, model);
            res.writeHead(success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success,
              assignments: getAllAgentModels(),
              message: success ? `Model updated for ${role}` : 'Invalid role or model ID',
            }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: reset agent model to default
      if (pathname === '/api/models/reset' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { role } = JSON.parse(body) as { role: string };
            resetAgentModel(role as any);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              assignments: getAllAgentModels(),
            }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: pause/resume system
      if (pathname === '/api/pause' && req.method === 'POST') {
        if (this.onPause) this.onPause();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, paused: true }));
        return;
      }
      if (pathname === '/api/resume' && req.method === 'POST') {
        if (this.onResume) this.onResume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, paused: false }));
        return;
      }

      // POST: trigger immediate decision cycle
      if (pathname === '/api/cycle/trigger' && req.method === 'POST') {
        if (this.onTriggerCycle) {
          this.onTriggerCycle();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Cycle triggered' }));
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Cycle handler not available' }));
        }
        return;
      }

      // POST: trigger backtest
      if (pathname === '/api/backtest' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const params = JSON.parse(body) as { years?: number; symbol?: string; interval?: string; maxCandles?: number; model?: string; reverse?: boolean };
            const years = Math.min(12, Math.max(1, params.years ?? 3)) as 1 | 3 | 5 | 7 | 10 | 12;
            const symbol = (params.symbol ?? 'BTCUSDT').toUpperCase();
            const interval = (params.interval ?? '1d') as '5m' | '1h' | '1d' | '1w';
            const maxCandles = Math.min(5000, params.maxCandles ?? 1000);
            const model = params.model;
            const reverse = params.reverse ?? false;

            // Fire and forget — backtest runs async
            log.info(`Backtest requested: ${years}yr ${symbol} ${interval} (max ${maxCandles} candles)${model ? ` model=${model}` : ''}${reverse ? ' REVERSE' : ''}`);

            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: `Backtest started: ${years}yr ${symbol} ${interval}${reverse ? ' (reverse)' : ''}`,
              params: { years, symbol, interval, maxCandles, model, reverse },
            }));

            // Run backtest asynchronously
            if (this.onBacktest) {
              this.onBacktest({ years, symbol, interval, maxCandles, model, reverse });
            }
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: pause backtest
      if (pathname === '/api/backtest/pause' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Backtest pause requested' }));
        if (this.onBacktestPause) this.onBacktestPause();
        return;
      }

      // POST: resume backtest
      if (pathname === '/api/backtest/resume' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Backtest resume requested' }));
        if (this.onBacktestResume) this.onBacktestResume();
        return;
      }

      // POST: stop/cancel backtest
      if (pathname === '/api/backtest/stop' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Backtest stop requested' }));
        if (this.onBacktestStop) this.onBacktestStop();
        return;
      }

      // POST: reset trade history (keeps strategies + generation)
      if (pathname === '/api/evolution/reset-trade-history' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Trade history reset requested' }));
        if (this.onResetTradeHistory) this.onResetTradeHistory();
        return;
      }

      // v2.0.79: POST — reset paper engine trades (clears paper trade records)
      if (pathname === '/api/paper/reset-trades' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Paper trades reset' }));
        if (this.onResetPaperTrades) this.onResetPaperTrades();
        return;
      }

      // ── Market Agent API Routes ──

      // GET: market agent state
      if (pathname === '/api/market-agent') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.data?.marketAgent ?? {}));
        return;
      }

      // POST: set trade mode (paper/real)
      if (pathname === '/api/market-agent/trade-mode' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { mode } = JSON.parse(body) as { mode: string };
            if (mode === 'paper' || mode === 'real') {
              if (this.onMarketAgentSetTradeMode) this.onMarketAgentSetTradeMode(mode);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: `Trade mode set to ${mode}` }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Invalid trade mode. Use "paper" or "real".' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: exchange change (DEPRECATED — exchange is now fixed to hyperliquid)
      if (pathname === '/api/market-agent/exchange' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Exchange fixed to hyperliquid. Ignoring request.' }));
        return;
      }

      // POST: set hyperliquid asset type
      if (pathname === '/api/market-agent/asset-type' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { assetType } = JSON.parse(body) as { assetType: string };
            const validTypes = ['crypto_perps', 'tradfi', 'indices', 'stocks', 'commodities', 'fx'];
            if (validTypes.includes(assetType)) {
              if (this.onMarketAgentSetAssetType) this.onMarketAgentSetAssetType(assetType as HyperliquidAssetType);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: `Asset type set to ${assetType}` }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Invalid asset type.' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: set position size (0.01-0.20 = 1%-20%)
      if (pathname === '/api/market-agent/position-size' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { pct } = JSON.parse(body) as { pct: number };
            const clamped = Math.max(0.01, Math.min(0.50, pct));
            if (this.onMarketAgentSetPositionSize) this.onMarketAgentSetPositionSize(clamped);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Position size set to ${(clamped * 100).toFixed(1)}%` }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // v2.0.XX: POST: set max portion (0.10-0.50 = 10%-50%)
      if (pathname === '/api/market-agent/max-portion' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { pct } = JSON.parse(body) as { pct: number };
            const clamped = Math.max(0.10, Math.min(0.50, pct));
            if (this.onMarketAgentSetMaxPortion) this.onMarketAgentSetMaxPortion(clamped);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Max portion set to ${(clamped * 100).toFixed(0)}%` }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: manual close position (v2.0.30)
      // Body: { "symbol": "btc" }
      // Closes the position in both local portfolio and (if real mode) on the exchange.
      if (pathname === '/api/positions/close' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { symbol } = JSON.parse(body) as { symbol: string };
            if (!symbol || typeof symbol !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Symbol is required' }));
              return;
            }
            if (this.onManualClosePosition) {
              // v2.0.42: Use normalizeSymbol for consistent casing with portfolio.
              const result = await this.onManualClosePosition(normalizeSymbol(symbol));
              res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } else {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Close handler not registered' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: set leverage (1-10)
      if (pathname === '/api/market-agent/leverage' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { leverage } = JSON.parse(body) as { leverage: number };
            const clamped = Math.max(1, Math.min(10, Math.round(leverage)));
            if (this.onMarketAgentSetLeverage) this.onMarketAgentSetLeverage(clamped);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: `Leverage set to ${clamped}x` }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // POST: refresh top pairs
      if (pathname === '/api/market-agent/refresh' && req.method === 'POST') {
        if (this.onMarketAgentFetchPairs) this.onMarketAgentFetchPairs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Refreshing top pairs...' }));
        return;
      }

      // v2.0.44: POST — manual symbol selection from Top Volume Pairs list.
      // Sets the manualSymbolLock so autoSelectTopPair() doesn't override it.
      // The UI triggers this when the user clicks a pair in the Top Volume table.
      if (pathname === '/api/market-agent/select-symbol' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { symbol } = JSON.parse(body) as { symbol: string };
            if (!symbol || typeof symbol !== 'string' || symbol.length > 50) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Invalid symbol. Must be a non-empty string (max 50 chars).' }));
              return;
            }
            if (this.onMarketAgentSelectSymbol) {
              this.onMarketAgentSelectSymbol(symbol);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: `Symbol set to ${symbol}. Cycle triggered.` }));
            } else {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Symbol selection handler not registered.' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // v2.0.79: POST — set trading markets list (from UI pills).
      // The backend uses this list + open positions to determine which
      // symbols agents should analyze, instead of auto-selecting top pair.
      if (pathname === '/api/market-agent/trading-markets' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          try {
            const { markets } = JSON.parse(body) as { markets: string[] };
            if (!Array.isArray(markets)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'markets must be an array' }));
              return;
            }
            const valid = markets.filter(s => typeof s === 'string' && s.length > 0 && s.length <= 50).slice(0, 3);
            if (this.onSetTradingMarkets) {
              this.onSetTradingMarkets(valid);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: `Trading markets set: ${valid.join(', ')}` }));
            } else {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, message: 'Handler not registered' }));
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
          }
        });
        return;
      }

      // v2.0.45: POST — clear drawdown data to relaunch trading.
      // Resets peakEquity, currentDrawdownPct, maxDrawdown, dailyPnl.
      // The next decision cycle will pass the SystemGuard drawdown check.
      if (pathname === '/api/clear-drawdown' && req.method === 'POST') {
        if (this.onClearDrawdown) {
          this.onClearDrawdown();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Drawdown cleared. Trading will resume on the next cycle.' }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Clear drawdown handler not registered.' }));
        }
        return;
      }

      // GET: candle data for chart
      if (pathname === '/api/candles' && req.method === 'GET') {
        const symbol = url.searchParams.get('symbol') ?? '';
        const interval = url.searchParams.get('interval') ?? '1h';
        const limit = parseInt(url.searchParams.get('limit') ?? '168', 10);
        if (!symbol) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Missing symbol parameter' }));
          return;
        }
        if (this.onCandlesRequest) {
          try {
            const candles = await this.onCandlesRequest(symbol, interval, limit);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, candles }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: err instanceof Error ? err.message : String(err) }));
          }
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Candles handler not available' }));
        }
        return;
      }

      // POST: graceful shutdown
      if (pathname === '/api/shutdown' && req.method === 'POST') {
        log.warn('🚨 Shutdown requested via API');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Shutting down...' }));
        // Delay slightly so the response can be sent before process exits
        setTimeout(() => {
          if (this.onShutdown) this.onShutdown();
          process.exit(0);
        }, 100);
        return;
      }

      // ── Serve UI static files ──
      // Try to serve the built React app
      if (fs.existsSync(this.uiDir)) {
        let filePath = path.join(this.uiDir, pathname === '/' ? 'index.html' : pathname);

        if (!fs.existsSync(filePath)) {
          filePath = path.join(this.uiDir, 'index.html');
        }

        const ext = path.extname(filePath);
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.jpg': 'image/jpg',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
        };

        try {
          const content = fs.readFileSync(filePath);
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      } else {
        // No UI build found — return API info
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'AMACRF API Server',
          version: '1.0.0',
          endpoints: {
            '/api/status': 'System status snapshot',
            '/api/agents': 'Agent thoughts and statuses',
            '/api/portfolio': 'Portfolio state',
            '/api/cycle': 'Latest HACP cycle result',
            '/api/market': 'Current market state',
            '/api/events': 'SSE real-time event stream',
          },
          ui: 'Build the UI with: cd ui && npm run build',
        }));
      }
    });

    this.server.listen(this.port, () => {
      log.info(`🌐 API Server running on http://localhost:${this.port}`);
      log.info(`   SSE: http://localhost:${this.port}/api/events`);
      if (fs.existsSync(this.uiDir)) {
        log.info(`   UI: http://localhost:${this.port}`);
      }
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all SSE clients
      for (const client of this.sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      this.sseClients.clear();

      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
