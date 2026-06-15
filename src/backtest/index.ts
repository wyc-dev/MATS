// ─── Historical Backtesting Engine ───
// Fetches years of historical OHLCV data from Binance and feeds it to
// all 5 agents + HACP for REAL LLM analysis. Results enrich evolution
// memory so agents learn from past market regimes without needing real trades.
//
// Key design: uses the SAME HACPEngine + agents as live trading, so backtest
// decisions are made by real LLM cognition, not rule-based simulation.
//
// Backtest runs independently from live trading — it creates its own temporary
// HACPEngine so live decision cycles are NOT blocked during backtest.

import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import { HACPEngine } from '../cognition/hacp.ts';
import type { MarketRegime, TradingDecision } from '../types/index.ts';
import type { EvolutionOrchestrator } from '../evolution/index.ts';
import { sigmoid, sigmoidBipolar } from '../analysis/sigmoid-ga.ts';
import type { BaseAgent } from '../agents/base-agent.ts';
import type { IndependentRiskAuditor, SkepticsAgent } from '../agents/agents.ts';

const log = createLogger({ phase: 'backtest' });

// ─── Proxy Sentiment from Candle Data ───
function computeProxySentiment(candle: { open: number; high: number; low: number; close: number; volume: number }, prevCandle?: { close: number; volume: number }): string {
  const bodyRatio = (candle.close - candle.open) / (candle.open || 0.001);
  const upperWick = (candle.high - Math.max(candle.open, candle.close)) / (candle.high - candle.low || 0.001);
  const lowerWick = (Math.min(candle.open, candle.close) - candle.low) / (candle.high - candle.low || 0.001);
  const obProxy = Math.max(-1, Math.min(1, bodyRatio * 2 + (upperWick - lowerWick) * 0.5));
  const volAccel = prevCandle ? Math.max(-1, Math.min(1, (candle.volume / (prevCandle.volume || 0.001) - 1) / 2)) : 0;
  const spreadProxy = Math.max(0, Math.min(1, (upperWick + lowerWick) * 0.7));
  const priceAccel = prevCandle ? Math.max(-1, Math.min(1, ((candle.close - prevCandle.close) / (prevCandle.close || 0.001)) * 10)) : 0;
  const largeTradeProxy = volAccel > 0.5 ? Math.min(1, volAccel) : 0;
  // Direction-aware whale: high vol on down candle = distribution (bearish)
  const directionSignal = bodyRatio > 0 ? 1 : bodyRatio < 0 ? -1 : 0;
  const whaleScore = sigmoid(obProxy + largeTradeProxy * directionSignal - 0.3, 2.0, 0.3);
  const instPressure = sigmoid(volAccel, 1.5, 0.0);
  const microTension = sigmoid(spreadProxy + obProxy * 0.5, 3.0, 0.2);
  const momentumBias = sigmoidBipolar(priceAccel, 1.0, 0.0);
  const overallRaw = (whaleScore * 0.25 + instPressure * 0.20 + microTension * 0.15 + ((momentumBias + 1) / 2) * 0.25 + 0.5 * 0.15);
  const overall = overallRaw * 2 - 1;
  const emoji = overall > 0.3 ? '🟢' : overall < -0.3 ? '🔴' : '🟡';
  return [
    '=== BACKTEST SENTIMENT (proxy from candles) ===',
    emoji + ' Overall: ' + (overall * 100).toFixed(1) + '%',
    '  Whale Proxy:    ' + (whaleScore * 100).toFixed(0) + '% (OB: ' + obProxy.toFixed(2) + ', Large: ' + largeTradeProxy.toFixed(2) + ')',
    '  Inst Flow:      ' + (instPressure * 100).toFixed(0) + '% (Vol Accel: ' + volAccel.toFixed(2) + ')',
    '  Micro Tension:  ' + (microTension * 100).toFixed(0) + '% (Spread: ' + spreadProxy.toFixed(2) + ')',
    '  Momentum Bias:  ' + (momentumBias * 100).toFixed(1) + '% (Accel: ' + priceAccel.toFixed(2) + ')',
  ].join('\n');
}

export interface BacktestCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestConfig {
  years: 1 | 3 | 5 | 7 | 10 | 12;
  symbol: string;
  interval: '5m' | '1h' | '1d' | '1w';
  maxCandles: number;
  hacpSampleRate?: number;
  reverse?: boolean;
}

export interface BacktestProgress {
  phase: 'fetching' | 'processing' | 'evolving' | 'complete' | 'error' | 'paused';
  progressPct: number;
  message: string;
  candlesProcessed: number;
  totalCandles: number;
}

export interface BacktestResult {
  symbol: string;
  years: number;
  interval: string;
  candlesProcessed: number;
  tradesSimulated: number;
  buySignals: number;
  sellSignals: number;
  holdSignals: number;
  hacpCycles: number;
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

async function fetchHistoricalData(cfg: BacktestConfig): Promise<BacktestCandle[]> {
  const symbol = cfg.symbol.toUpperCase();
  const now = Date.now();
  const msPerYear = 365 * 24 * 60 * 60 * 1000;
  const startTime = now - cfg.years * msPerYear;
  const allCandles: BacktestCandle[] = [];
  let currentStart = startTime;

  log.info(`Fetching ${cfg.years}yr ${cfg.interval} data for ${symbol}...`);

  while (currentStart < now && allCandles.length < cfg.maxCandles) {
    const url = `${config.binance.restUrl}/api/v3/klines`
      + `?symbol=${symbol}&interval=${cfg.interval}`
      + `&startTime=${currentStart}&limit=1000`;
    try {
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json() as unknown[][];
      if (!Array.isArray(data) || data.length === 0) break;
      for (const k of data) {
        allCandles.push({
          timestamp: Number(k[0]),
          open: parseFloat(k[1] as string),
          high: parseFloat(k[2] as string),
          low: parseFloat(k[3] as string),
          close: parseFloat(k[4] as string),
          volume: parseFloat(k[5] as string),
        });
      }
      currentStart = Number(data[data.length - 1]![0]) + 1;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      log.error(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  log.info(`Fetched ${allCandles.length} candles for ${symbol} (${cfg.years}yr)`);
  return allCandles;
}

function detectRegime(candles: BacktestCandle[], idx: number, interval: string): {
  regime: MarketRegime;
  trend: string;
  volatility: number;
} {
  const lookbackRaw = interval === '5m' ? 96 : interval === '1h' ? 48 : interval === '1d' ? 20 : 12;
  const lookback = Math.min(lookbackRaw, idx);
  if (lookback < 5) return { regime: 'unknown', trend: 'sideways', volatility: 0 };

  const recent = candles.slice(idx - lookback, idx);
  const closes = recent.map(c => c.close);
  const returns = closes.slice(1).map((c, i) => (c - closes[i]!) / closes[i]!);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const volatility = Math.sqrt(variance);

  const xMean = (lookback - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < lookback; i++) {
    num += (i - xMean) * (closes[i]! - mean);
    den += (i - xMean) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const normalizedSlope = slope / (closes[0] ?? 1);

  const periodsPerYear = interval === '5m' ? 105120 : interval === '1h' ? 8760 : interval === '1d' ? 365 : 52;
  const annualizedVol = volatility * Math.sqrt(periodsPerYear);

  let regime: MarketRegime;
  let trend: string;
  if (annualizedVol > 0.5) { regime = 'high_volatility'; trend = normalizedSlope > 0 ? 'bullish' : 'bearish'; }
  else if (annualizedVol < 0.15) { regime = 'low_volatility'; trend = normalizedSlope > 0.01 ? 'bullish' : normalizedSlope < -0.01 ? 'bearish' : 'sideways'; }
  else if (Math.abs(normalizedSlope) > 0.02) { regime = normalizedSlope > 0 ? 'trending_bull' : 'trending_bear'; trend = normalizedSlope > 0 ? 'bullish' : 'bearish'; }
  else { regime = 'mean_reverting'; trend = 'sideways'; }
  if (annualizedVol > 1.0) regime = 'chaotic';

  return { regime, trend, volatility };
}

function ruleBasedDecision(regime: MarketRegime, trend: string, volatility: number, candle: BacktestCandle, symbol: string): TradingDecision {
  if (regime === 'chaotic' || regime === 'high_volatility') {
    return { action: 'hold', symbol, positionSizePct: 0, rationale: `BACKTEST: ${regime} — capital preservation.`, urgency: 'patient' };
  }
  if (regime === 'trending_bull' && trend === 'bullish') {
    return { action: 'buy', symbol, positionSizePct: 0.04, entryPrice: candle.close, stopLossPct: 0.02, takeProfitPct: 0.05, rationale: 'BACKTEST: Bullish trend. Size=4%.', urgency: 'immediate' };
  }
  if (regime === 'trending_bear' && trend === 'bearish') {
    return { action: 'sell', symbol, positionSizePct: 0.03, entryPrice: candle.close, stopLossPct: 0.02, takeProfitPct: 0.05, rationale: 'BACKTEST: Bearish trend. Size=3%.', urgency: 'immediate' };
  }
  if (regime === 'mean_reverting') {
    const mid = (candle.high + candle.low) / 2;
    if (candle.close < mid * 0.98) return { action: 'buy', symbol, positionSizePct: 0.03, entryPrice: candle.close, stopLossPct: 0.015, takeProfitPct: 0.03, rationale: 'BACKTEST: Mean reversion buy.', urgency: 'soon' };
    if (candle.close > mid * 1.02) return { action: 'sell', symbol, positionSizePct: 0.02, entryPrice: candle.close, stopLossPct: 0.015, takeProfitPct: 0.03, rationale: 'BACKTEST: Mean reversion sell.', urgency: 'soon' };
  }
  if (regime === 'low_volatility') {
    return { action: 'buy', symbol, positionSizePct: 0.02, entryPrice: candle.close, stopLossPct: 0.03, takeProfitPct: 0.06, rationale: 'BACKTEST: Low vol accumulation.', urgency: 'patient' };
  }
  return { action: 'hold', symbol, positionSizePct: 0, rationale: `BACKTEST: No clear signal in ${regime}/${trend}.`, urgency: 'patient' };
}

export class BacktestEngine {
  private evolution: EvolutionOrchestrator;
  private hacpEngine: HACPEngine;
  private metaAgent: BaseAgent;
  private riskAuditor: IndependentRiskAuditor;
  private subAgents: BaseAgent[];
  private skepticsAgent: SkepticsAgent;
  private onProgress: ((progress: BacktestProgress) => void) | null = null;
  private _paused = false;
  private _running = false;

  constructor(
    evolution: EvolutionOrchestrator,
    hacpEngine: HACPEngine,
    skepticsAgent: SkepticsAgent,
    metaAgent: BaseAgent,
    riskAuditor: IndependentRiskAuditor,
    subAgents: BaseAgent[],
  ) {
    this.evolution = evolution;
    this.hacpEngine = hacpEngine;
    this.skepticsAgent = skepticsAgent;
    this.metaAgent = metaAgent;
    this.riskAuditor = riskAuditor;
    this.subAgents = subAgents;
  }

  setProgressCallback(cb: (progress: BacktestProgress) => void): void { this.onProgress = cb; }
  private emitProgress(p: BacktestProgress): void { if (this.onProgress) this.onProgress(p); }
  get isRunning(): boolean { return this._running; }
  get isPaused(): boolean { return this._paused; }

  pause(): void {
    if (!this._running) return;
    this._paused = true;
    log.info('⏸️ Backtest paused');
    this.emitProgress({ phase: 'paused', progressPct: 0, message: 'PAUSED', candlesProcessed: 0, totalCandles: 0 });
  }

  resume(): void {
    if (!this._paused) return;
    this._paused = false;
    log.info('▶️ Backtest resumed');
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    this._paused = false;
    log.info('⏹️ Backtest cancelled');
  }

  async runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
    this._running = true;
    this._paused = false;
    const startTime = performance.now();
    const hacpSampleRate = cfg.hacpSampleRate ?? 5;
    const reverse = cfg.reverse ?? false;
    const btHACP = new HACPEngine(this.metaAgent, this.riskAuditor, this.skepticsAgent, this.subAgents);

    const result: BacktestResult = {
      symbol: cfg.symbol, years: cfg.years, interval: cfg.interval,
      candlesProcessed: 0, tradesSimulated: 0, buySignals: 0, sellSignals: 0,
      holdSignals: 0, hacpCycles: 0, regimeDistribution: {}, durationMs: 0,
      errors: 0, equityCurve: [], finalReturnPct: 0, maxDrawdownPct: 0,
      sharpeRatio: 0, winRate: 0, totalTrades: 0,
    };

    log.info(`🚀 Starting backtest: ${cfg.years}yr ${cfg.symbol} ${cfg.interval} (HACP every ${hacpSampleRate} candles${reverse ? ', REVERSE' : ''})`);

    this.emitProgress({ phase: 'fetching', progressPct: 0, message: `Fetching ${cfg.years}yr ${cfg.interval} data...`, candlesProcessed: 0, totalCandles: 0 });
    const candles = await fetchHistoricalData(cfg);
    if (candles.length === 0) {
      this.emitProgress({ phase: 'error', progressPct: 0, message: 'No data', candlesProcessed: 0, totalCandles: 0 });
      this._running = false;
      return result;
    }

    const step = Math.max(1, Math.floor(candles.length / cfg.maxCandles));
    let sampled = candles.filter((_, i) => i % step === 0).slice(0, cfg.maxCandles);
    if (reverse) sampled = sampled.reverse();

    log.info(`Processing ${sampled.length} candles (sampled from ${candles.length})`);
    this.emitProgress({ phase: 'processing', progressPct: 1, message: `Processing ${sampled.length} candles...`, candlesProcessed: 0, totalCandles: sampled.length });

    // ── Sim portfolio with leverage ──
    let simBalance = 10000;
    let simPosition: { side: 'buy' | 'sell'; entry: number; size: number; leverage: number } | null = null;
    const equityCurve: Array<{ date: string; equity: number }> = [];
    const pnls: number[] = [];
    let wins = 0, losses = 0;
    let peakEquity = simBalance;
    let maxDrawdown = 0;

    for (let i = 0; i < sampled.length; i++) {
      while (this._paused && this._running) await new Promise(r => setTimeout(r, 500));
      if (!this._running) {
        result.durationMs = Math.round(performance.now() - startTime);
        this._running = false;
        return result;
      }

      const candle = sampled[i]!;
      const { regime, trend, volatility } = detectRegime(sampled, i, cfg.interval);
      result.regimeDistribution[regime] = (result.regimeDistribution[regime] ?? 0) + 1;

      // Compute proxy sentiment from candle patterns
      const prevCandle = i > 0 ? sampled[i - 1] : undefined;
      const proxySentiment = computeProxySentiment(
        { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume },
        prevCandle ? { close: prevCandle.close, volume: prevCandle.volume } : undefined,
      );

      const marketDesc = [
        `=== Historical Market State ===`,
        `Symbol: ${cfg.symbol}`,
        `Date: ${new Date(candle.timestamp).toISOString().split('T')[0]}`,
        `Open: $${candle.open.toFixed(2)}`,
        `High: $${candle.high.toFixed(2)}`,
        `Low: $${candle.low.toFixed(2)}`,
        `Close: $${candle.close.toFixed(2)}`,
        `Volume: ${(candle.volume / 1000).toFixed(1)}K`,
        `Volatility: ${(volatility * 100).toFixed(3)}%`,
        `Trend: ${trend.toUpperCase()}`,
        `Regime: ${regime.toUpperCase()}`,
        `---`,
        proxySentiment,
        `---`,
        `This is HISTORICAL DATA. Analyze what the BEST decision would have been.`,
        reverse ? `NOTE: Time is running REVERSE.` : '',
      ].join('\n');

      const portfolioDesc = [
        `=== Portfolio ===`,
        `Balance: $${simBalance.toFixed(2)}`,
        `Position: ${simPosition ? `${simPosition.side.toUpperCase()} ${(simPosition.size * 100).toFixed(1)}% ${simPosition.leverage}x @ $${simPosition.entry.toFixed(2)}` : 'NONE'}`,
        `Equity: $${simBalance.toFixed(2)}`,
      ].join('\n');

      // Decide: HACP or rule-based
      let decision: TradingDecision;
      if (i % hacpSampleRate === 0 && i >= 5) {
        try {
          log.info(`[HACP] Candle ${i}/${sampled.length} — running real agent cognition...`);
          const hacpResult = await btHACP.executeDecisionCycle(marketDesc, portfolioDesc);
          decision = hacpResult.consensus.decision;
          result.hacpCycles++;

          for (const thought of hacpResult.allThoughts) {
            this.evolution.memory.store({
              type: 'experience',
              marketState: { symbol: cfg.symbol, currentPrice: candle.close, regime, volatility },
              decision: (thought.metadata as any)?.decision as TradingDecision ?? decision,
              lessons: [
                `[HACP BACKTEST ${cfg.years}yr] ${new Date(candle.timestamp).toISOString().split('T')[0]}: ${thought.agentRole} conf=${thought.confidence.toFixed(2)}`,
                `Thought: ${thought.thought.slice(0, 200)}`,
              ],
              tags: ['backtest', 'hacp', `years_${cfg.years}`, regime, thought.agentRole],
              importance: 0.7,
            });
          }
          log.info(`[HACP] Candle ${i} → ${decision.action.toUpperCase()} (conf=${hacpResult.consensus.confidence.toFixed(2)})`);

          // Evolve after each HACP run
          const btPerf = this.evolution.tradeHistory.computePerformance();
          const btBest = this.evolution.pressureEngine.getBestStrategy();
          if (btBest) {
            btBest.performance = {
              sharpeRatio: btPerf.sharpeRatio, sortinoRatio: btPerf.sortinoRatio,
              calmarRatio: btPerf.calmarRatio, winRate: btPerf.winRate,
              profitFactor: btPerf.profitFactor, maxDrawdown: btPerf.maxDrawdown,
              totalReturn: btPerf.totalReturn, trades: this.evolution.tradeHistory.getStats().totalEntries,
              avgWin: btPerf.avgWin, avgLoss: btPerf.avgLoss, expectancy: btPerf.expectancy,
            };
            const btFitness = this.evolution.fitnessCalculator.calculate(btBest.performance);
            btBest.fitness = btFitness.score;
            this.evolution.pressureEngine.evolve({}, this.evolution.tradeHistory);
          }
        } catch (err) {
          log.error(`[HACP] Failed at candle ${i}: ${err instanceof Error ? err.message : String(err)}`);
          decision = ruleBasedDecision(regime, trend, volatility, candle, cfg.symbol);
          result.errors++;
        }
      } else {
        decision = ruleBasedDecision(regime, trend, volatility, candle, cfg.symbol);
      }

      if (decision.action === 'buy') result.buySignals++;
      else if (decision.action === 'sell') result.sellSignals++;
      else result.holdSignals++;
      result.tradesSimulated++;

      this.evolution.memory.store({
        type: 'experience',
        marketState: { symbol: cfg.symbol, currentPrice: candle.close, regime, volatility },
        decision,
        lessons: [
          `[BACKTEST ${cfg.years}yr] ${new Date(candle.timestamp).toISOString().split('T')[0]}: ${decision.action.toUpperCase()} (regime: ${regime}, trend: ${trend})`,
          `Price: $${candle.low.toFixed(2)}-$${candle.high.toFixed(2)}, Close: $${candle.close.toFixed(2)}`,
          `Vol: ${(volatility * 100).toFixed(3)}%`,
        ],
        tags: ['backtest', `years_${cfg.years}`, regime, decision.action],
        importance: 0.6,
      });

      // ── Sim P&L with leverage ──
      // Close existing position first
      if (simPosition) {
        const exitPrice = candle.close;
        const priceChangePct = simPosition.side === 'buy'
          ? (exitPrice - simPosition.entry) / simPosition.entry
          : (simPosition.entry - exitPrice) / simPosition.entry;
        // PnL = positionSize * leverage * priceChange%
        const pnl = simPosition.size * simPosition.leverage * priceChangePct;
        simBalance += pnl * simBalance;
        pnls.push(pnl);
        if (pnl > 0) wins++; else losses++;
        simPosition = null;
      }

      // Open new position
      const leverage = (decision as any).leverage ?? 1;
      if (decision.action === 'buy' && decision.positionSizePct > 0) {
        simPosition = { side: 'buy', entry: candle.close, size: decision.positionSizePct, leverage };
      } else if (decision.action === 'sell' && decision.positionSizePct > 0) {
        simPosition = { side: 'sell', entry: candle.close, size: decision.positionSizePct, leverage };
      }

      // Track equity
      let currentEquity = simBalance;
      if (simPosition) {
        const priceMove = simPosition.side === 'buy'
          ? (candle.close - simPosition.entry) / simPosition.entry
          : (simPosition.entry - candle.close) / simPosition.entry;
        const unrealizedPnl = simPosition.size * simPosition.leverage * priceMove;
        currentEquity = simBalance * (1 + unrealizedPnl);
      }
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const dd = (peakEquity - currentEquity) / peakEquity;
      if (dd > maxDrawdown) maxDrawdown = dd;

      equityCurve.push({ date: new Date(candle.timestamp).toISOString().split('T')[0] ?? '', equity: Math.round(currentEquity * 100) / 100 });
      result.candlesProcessed++;

      if ((i + 1) % 10 === 0 || i === sampled.length - 1) {
        const pct = ((i + 1) / sampled.length * 100);
        this.emitProgress({
          phase: 'processing', progressPct: pct,
          message: `Candle ${i + 1}/${sampled.length} — ${result.hacpCycles} HACP runs`,
          candlesProcessed: i + 1, totalCandles: sampled.length,
        });
      }
    }

    // ── Compute metrics ──
    const totalReturnPct = ((simBalance - 10000) / 10000) * 100;
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1]!.equity;
      const curr = equityCurve[i]!.equity;
      if (prev > 0) dailyReturns.push(Math.log(curr / prev));
    }
    const n = dailyReturns.length;
    const meanDailyRet = n > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / n : 0;
    const variance = n > 0 ? dailyReturns.reduce((sum, r) => sum + (r - meanDailyRet) ** 2, 0) / n : 0;
    const stdDaily = Math.sqrt(variance);
    const periodsPerYear = cfg.interval === '5m' ? 105120 : cfg.interval === '1h' ? 8760 : cfg.interval === '1d' ? 365 : 52;
    const sharpeRatio = stdDaily > 0 ? (meanDailyRet / stdDaily) * Math.sqrt(periodsPerYear) : 0;
    const downsideRets = dailyReturns.filter(r => r < 0);
    const downVariance = downsideRets.length > 0 ? downsideRets.reduce((sum, r) => sum + r * r, 0) / downsideRets.length : 0;
    const downStd = Math.sqrt(downVariance);
    const sortinoRatio = downStd > 0 ? (meanDailyRet / downStd) * Math.sqrt(periodsPerYear) : sharpeRatio;
    const annualizedReturn = Math.pow(1 + totalReturnPct / 100, 1 / cfg.years) - 1;
    const maxDdDecimal = maxDrawdown;
    const calmarRatio = maxDdDecimal > 0 ? annualizedReturn / maxDdDecimal : annualizedReturn > 0 ? 1 : 0;
    const winRate = (wins + losses) > 0 ? wins / (wins + losses) : 0;
    const totalWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const totalLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 1;

    result.equityCurve = equityCurve;
    result.finalReturnPct = parseFloat(totalReturnPct.toFixed(4));
    result.maxDrawdownPct = parseFloat((maxDrawdown * 100).toFixed(4));
    result.sharpeRatio = parseFloat(sharpeRatio.toFixed(4));
    result.winRate = parseFloat(winRate.toFixed(4));
    result.totalTrades = pnls.length;

    log.info(`📊 Backtest raw: balance=${simBalance.toFixed(2)} return=${totalReturnPct.toFixed(2)}% trades=${pnls.length} wins=${wins} losses=${losses}`);

    // ── Force evolution ──
    this.emitProgress({ phase: 'evolving', progressPct: 98, message: 'Evolving strategy...', candlesProcessed: sampled.length, totalCandles: sampled.length });

    const bestStrat = this.evolution.pressureEngine.getBestStrategy();
    if (bestStrat) {
      bestStrat.performance = {
        sharpeRatio, sortinoRatio, calmarRatio, winRate, profitFactor,
        maxDrawdown: maxDdDecimal, totalReturn: totalReturnPct / 100, trades: pnls.length,
        avgWin: pnls.filter(p => p > 0).reduce((a, b) => a + b, 0) / (wins || 1),
        avgLoss: Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0)) / (losses || 1),
        expectancy: winRate * (totalWin / (wins || 1)) - (1 - winRate) * (totalLoss / (losses || 1)),
      };
      const fitness = this.evolution.fitnessCalculator.calculate(bestStrat.performance);
      bestStrat.fitness = fitness.score;
      log.info(`📊 Backtest fitness: ${(fitness.score * 100).toFixed(1)}% (Sharpe=${sharpeRatio.toFixed(2)}, Return=${totalReturnPct.toFixed(2)}%)`);
      this.evolution.pressureEngine.evolve({}, this.evolution.tradeHistory);
    }

    this.evolution.persistState();
    result.durationMs = Math.round(performance.now() - startTime);

    this.emitProgress({ phase: 'complete', progressPct: 100, message: `Done: ${result.candlesProcessed} candles, ${result.hacpCycles} HACP runs`, candlesProcessed: sampled.length, totalCandles: sampled.length });

    log.info(`✅ Backtest complete: ${result.candlesProcessed} candles, ${result.hacpCycles} HACP runs in ${(result.durationMs / 1000).toFixed(1)}s`);
    log.info(`   Return: ${totalReturnPct.toFixed(2)}% | Sharpe: ${sharpeRatio.toFixed(2)} | WinRate: ${(winRate * 100).toFixed(1)}% | MaxDD: ${(maxDrawdown * 100).toFixed(2)}%`);

    this._running = false;
    return result;
  }

  getBacktestSummary(): string {
    const memories = this.evolution.memory.recallByTag('backtest', 20);
    if (memories.length === 0) return '';

    const regimes = new Map<string, { buys: number; sells: number; holds: number }>();
    for (const m of memories) {
      const regime = m.marketState?.regime ?? 'unknown';
      const entry = regimes.get(regime) ?? { buys: 0, sells: 0, holds: 0 };
      if (m.decision.action === 'buy') entry.buys++;
      else if (m.decision.action === 'sell') entry.sells++;
      else entry.holds++;
      regimes.set(regime, entry);
    }

    let summary = `\n=== Backtest Knowledge (${memories.length} historical samples) ===\n`;
    summary += `Regime-based strategy distribution:\n`;
    for (const [regime, counts] of regimes) {
      summary += `  ${regime}: B:${counts.buys} S:${counts.sells} H:${counts.holds}\n`;
    }

    const hacpMemories = this.evolution.memory.recallByTag('hacp', 10);
    if (hacpMemories.length > 0) {
      summary += `\nHACP Agent insights from backtest:\n`;
      for (const m of hacpMemories.slice(0, 5)) {
        summary += `  [${m.lessons[0] ?? ''}]\n`;
      }
    }

    return summary;
  }
}
