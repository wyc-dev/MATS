// ─── Evolution Systems ───
// Dual memory, survival fitness, evolutionary pressure, and adaptation orchestrator

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { AgentOutcomeTracker } from './agent-outcomes.ts';
import type {
  AgentRole,
  MultiSymbolDecision,
  MarketRegime,
  MemoryEntry,
  EvolutionaryStrategy,
  StrategyParameters,
  StrategyPerformance,
  SurvivalFitness,
  GAPopulation,
} from '../types/index.ts';
import { TradeHistory } from './trade-history.ts';
import { saveEvolution, loadEvolution } from './persistence.ts';

const log = createLogger({ phase: 'evolution' });

// ─── Dual Memory System ───
// Short-term (episodic) + long-term (semantic) memory for experience retention

const MAX_SHORT_TERM = 100;
const MAX_LONG_TERM = 1000;

export class DualMemory {
  private shortTerm: MemoryEntry[] = [];
  private longTerm: MemoryEntry[] = [];

  /** Load memories from saved state (restore after restart) */
  load(shortTerm: MemoryEntry[], longTerm: MemoryEntry[]): void {
    this.shortTerm = shortTerm.slice(-MAX_SHORT_TERM);
    this.longTerm = longTerm.slice(-MAX_LONG_TERM);
    log.info(`DualMemory loaded: ${this.shortTerm.length}ST / ${this.longTerm.length}LT`);
  }

  /** Get raw short-term memories for serialization */
  getShortTermMemories(): MemoryEntry[] {
    return [...this.shortTerm];
  }

  /** Get raw long-term memories for serialization */
  getLongTermMemories(): MemoryEntry[] {
    return [...this.longTerm];
  }

  store(entry: Omit<MemoryEntry, 'id' | 'timestamp' | 'accessCount' | 'lastAccessed'>): void {
    const memory: MemoryEntry = {
      ...entry,
      id: uuidv4(),
      timestamp: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
    };

    // Store in short-term, consolidate to long-term if important
    this.shortTerm.push(memory);
    if (this.shortTerm.length > MAX_SHORT_TERM) {
      this.consolidate();
    }
  }

  recall(regime: MarketRegime, limit = 10): MemoryEntry[] {
    const relevant = [...this.longTerm, ...this.shortTerm]
      .filter((m) => m.tags.includes(regime) || m.marketState?.regime === regime)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);

    // Update access counts
    for (const m of relevant) {
      m.accessCount++;
      m.lastAccessed = Date.now();
    }

    return relevant;
  }

  recallByTag(tag: string, limit = 10): MemoryEntry[] {
    return [...this.longTerm, ...this.shortTerm]
      .filter((m) => m.tags.includes(tag))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  private consolidate(): void {
    // Move most important short-term to long-term
    const sorted = [...this.shortTerm].sort((a, b) => b.importance - a.importance);
    const toPromote = sorted.slice(0, Math.ceil(MAX_SHORT_TERM * 0.3));

    for (const m of toPromote) {
      if (!this.longTerm.some((lm) => lm.id === m.id)) {
        this.longTerm.push(m);
      }
    }

    // Prune short-term to capacity
    this.shortTerm = this.shortTerm.slice(-Math.floor(MAX_SHORT_TERM * 0.7));

    // Prune long-term
    if (this.longTerm.length > MAX_LONG_TERM) {
      this.longTerm.sort((a, b) => {
        const scoreA = a.importance * (a.accessCount + 1);
        const scoreB = b.importance * (b.accessCount + 1);
        return scoreB - scoreA;
      });
      this.longTerm = this.longTerm.slice(0, MAX_LONG_TERM);
    }

    log.info(`Memory consolidated: ${this.shortTerm.length} short-term, ${this.longTerm.length} long-term`);
  }

  getStats(): { shortTerm: number; longTerm: number } {
    return {
      shortTerm: this.shortTerm.length,
      longTerm: this.longTerm.length,
    };
  }
}

// ─── Survival Fitness Function ───
// Evaluates agent/strategy performance holistically

export class SurvivalFitnessCalculator {
  /**
   * Production-grade scalping fitness function.
   *
   * Core principle: profit per trade > win rate.
   * A strategy that wins 40% of trades but makes 5% on winners and loses 1% on losers
   * is FAR superior to one that wins 90% but makes 0.01% each.
   *
   * Weight allocation reflects scalping priorities:
   *   Profit Efficiency (35%): avgWin/avgLoss ratio + profitFactor + expectancy
   *   Return Generation (25%): totalReturn + sharpeRatio — absolute performance
   *   Capital Preservation (20%): maxDrawdown penalty — leverage amplifies losses
   *   Win Quality (10%): avgWin magnitude — penalizes microscopic wins
   *   Consistency (5%): winRate stability
   *   Adaptability (5%): trade count — more trades = more proof
   *
   * Minimum profit threshold: avgWin < 0.5% → 0.7× penalty.
   *   Rationale: a scalping system with 5-10x leverage should earn ≥0.5% per winning trade
   *   (2.5-5% on margin). Strategies that "win" but make nothing are wasting capital.
   */
  calculate(performance: StrategyPerformance): SurvivalFitness {
    // ─── Profit Efficiency (35%) ───
    // Measures how efficiently the strategy converts risk into reward.
    // avgWin/avgLoss ratio: how much bigger are wins than losses?
    // profitFactor: totalWin / totalLoss
    // expectancy: expected value per trade
    const avgWinLossRatio = performance.avgWin / (Math.abs(performance.avgLoss) + 0.0001);
    const profitEfficiency = this.normalize(
      this.normalize(avgWinLossRatio / 5) * 0.4 +   // 5:1 win/loss ratio = perfect
      this.normalize(performance.profitFactor / 3) * 0.3 +
      this.normalize(performance.expectancy * 20) * 0.3  // 5% expectancy = perfect
    );

    // ─── Return Generation (25%) ───
    // Absolute performance: how much money did this strategy make?
    const returnGen = this.normalize(
      (performance.sharpeRatio / 2) * 0.35 +       // Sharpe 2.0 = perfect
      (performance.totalReturn / 50) * 0.35 +       // 50% return = perfect (scalping target)
      (performance.winRate) * 0.30
    );

    // ─── Capital Preservation (20%) ───
    // Drawdown control — critical for leveraged scalping.
    // maxDrawdown > 15% → heavy penalty (0.5× on entire score)
    const capitalPreservation = this.normalize(1 - Math.abs(performance.maxDrawdown / 0.3));
    const drawdownPenalty = performance.maxDrawdown > 0.15 ? 0.5 : 1.0;

    // ─── Win Quality (10%) ───
    // Penalizes strategies that "win" but make microscopic profits.
    // avgWin >= 2% = perfect, avgWin < 0.5% = heavily penalized.
    const winQuality = this.normalize(performance.avgWin / 0.02);
    // Minimum profit threshold: if avgWin < 0.5%, apply 0.7× penalty
    const minProfitPenalty = performance.avgWin < 0.005 && performance.trades > 5 ? 0.7 : 1.0;

    // ─── Consistency (5%) ───
    const consistency = this.normalize(
      (performance.winRate) * 0.5 +
      (performance.sortinoRatio / 2) * 0.3 +
      (performance.calmarRatio / 3) * 0.2
    );

    // ─── Adaptability (5%) ───
    const adaptability = this.normalize(Math.min(performance.trades / 100, 1));

    // ─── Composite Score ───
    const score = (
      profitEfficiency * 0.35 +
      returnGen * 0.25 +
      capitalPreservation * 0.20 +
      winQuality * 0.10 +
      consistency * 0.05 +
      adaptability * 0.05
    ) * drawdownPenalty * minProfitPenalty;

    return {
      score: parseFloat(score.toFixed(4)),
      capitalPreservation: parseFloat(capitalPreservation.toFixed(4)),
      returnGeneration: parseFloat(returnGen.toFixed(4)),
      adaptability: parseFloat(adaptability.toFixed(4)),
      consistency: parseFloat(consistency.toFixed(4)),
      riskManagement: parseFloat(profitEfficiency.toFixed(4)),
      decisionQuality: parseFloat(winQuality.toFixed(4)),
    };
  }

  private normalize(value: number): number {
    return Math.max(0, Math.min(1, value));
  }
}

// ─── Evolutionary Pressure Engine ───
// Applies evolutionary pressure to strategies, mutates, selects, and retires

export class EvolutionaryPressureEngine {
  private generation = 1;
  private strategies: EvolutionaryStrategy[] = [];
  private readonly maxActiveStrategies = 5;

  constructor() {
    // Initialize with a default strategy
    this.initializeDefaultStrategy();
  }

  /** Load strategies from saved state (restore after restart) */
  load(strategies: EvolutionaryStrategy[], generation: number): void {
    this.strategies = strategies;
    this.generation = generation;
    log.info(`EvolutionaryPressureEngine loaded: ${this.strategies.length} strategies, Gen ${this.generation}`);
  }

  /** Get raw strategies for serialization */
  getAllStrategies(): EvolutionaryStrategy[] {
    return [...this.strategies];
  }

  private initializeDefaultStrategy(): void {
    const defaultStrat: EvolutionaryStrategy = {
      id: uuidv4(),
      generation: 1,
      fitness: 0.5,
      parameters: {
        momentumWindow: 20,
        volatilityThreshold: 0.02,
        regimeWeights: {
          trending_bull: 0.8,
          trending_bear: 0.3,
          high_volatility: 0.2,
          low_volatility: 0.6,
          mean_reverting: 0.5,
          unknown: 0.3,
          breakout: 0.6,
          accumulation: 0.5,
          distribution: 0.2,
          chaotic: 0.1,
        },
        positionSizingModel: 'volatility_adjusted',
        riskAversion: 0.6,
        signalThreshold: 0.5,
        confirmationRequired: 2,
      },
      performance: {
        sharpeRatio: 0,
        sortinoRatio: 0,
        calmarRatio: 0,
        winRate: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        totalReturn: 0,
        trades: 0,
        avgWin: 0,
        avgLoss: 0,
        expectancy: 0,
      },
      status: 'active',
      createdAt: Date.now(),
      lineage: [],
    };

    this.strategies.push(defaultStrat);
  }

  evolve(
    performanceMetrics: Partial<StrategyPerformance>,
    tradeHistory?: TradeHistory
  ): EvolutionaryStrategy {
    this.generation++;

    // If trade history is available, use cumulative performance instead of per-cycle
    let cumulativePerf: StrategyPerformance | null = null;
    if (tradeHistory) {
      const hist = tradeHistory.computePerformance();
      cumulativePerf = {
        sharpeRatio: hist.sharpeRatio,
        sortinoRatio: hist.sortinoRatio,
        calmarRatio: hist.calmarRatio,
        winRate: hist.winRate,
        profitFactor: hist.profitFactor,
        maxDrawdown: hist.maxDrawdown,
        totalReturn: hist.totalReturn,
        trades: hist.trades,
        avgWin: hist.avgWin,
        avgLoss: hist.avgLoss,
        expectancy: hist.expectancy,
      };
    }

    // Evaluate current strategies
    for (const strat of this.strategies) {
      if (strat.status === 'active') {
        // Use cumulative performance when available, fallback to per-cycle metrics
        strat.performance = cumulativePerf ?? { ...strat.performance, ...performanceMetrics };
        const calculator = new SurvivalFitnessCalculator();
        const fitness = calculator.calculate(strat.performance);
        strat.fitness = fitness.score;

        // Retire low-fitness strategies
        if (fitness.score < 0.2) {
          strat.status = 'retired';
          log.info(`Strategy ${strat.id.slice(0, 8)} retired (fitness: ${fitness.score.toFixed(4)})`);
        }
      } else if (strat.status === 'evaluating') {
        // Evaluating strategies: after 1 generation, compare vs parent
        // 🐛 FIX v2.0.8: Reduced from 3→1 gen incubation. In fast-moving markets,
        // 3 generations of delay means the child strategy never gets a chance to
        // adapt to current conditions before being compared against the parent's
        // stale performance. 1 generation is enough to evaluate viability while
        // still allowing rapid adaptation to regime changes.
        if (this.generation - strat.generation >= 1) {
          strat.performance = cumulativePerf ?? { ...strat.performance, ...performanceMetrics };
          const calculator = new SurvivalFitnessCalculator();
          const fitness = calculator.calculate(strat.performance);
          strat.fitness = fitness.score;

          // Find parent strategy to compare against
          const parent = strat.parentId
            ? this.strategies.find(s => s.id === strat.parentId)
            : null;
          const parentFitness = parent?.fitness ?? 0;

          if (fitness.score >= 0.2 && fitness.score > parentFitness) {
            // Child beats parent → promote child, retire parent
            if (parent && parent.status === 'active') {
              parent.status = 'retired';
              log.info(`Strategy ${parent.id.slice(0, 8)} retired (outperformed by child ${strat.id.slice(0, 8)}, f=${parentFitness.toFixed(4)} → ${fitness.score.toFixed(4)})`);
            }
            strat.status = 'active';
            log.info(`Strategy ${strat.id.slice(0, 8)} promoted to active (fitness: ${fitness.score.toFixed(4)} > parent ${parentFitness.toFixed(4)})`);
          } else if (fitness.score >= 0.2) {
            // Child is viable but didn't beat parent — keep as active for diversity
            strat.status = 'active';
            log.info(`Strategy ${strat.id.slice(0, 8)} promoted to active (viable, f=${fitness.score.toFixed(4)}, parent f=${parentFitness.toFixed(4)})`);
          } else {
            strat.status = 'retired';
            log.info(`Strategy ${strat.id.slice(0, 8)} retired after evaluation (fitness: ${fitness.score.toFixed(4)} < 0.2)`);
          }
        }
      }
    }

    // ─── Production-Grade Evolution Gate ───
    // Two triggers for creating a new child strategy:
    //
    // TRIGGER 1 (Loss-Adaptation): The most recent completed cycle lost money.
    //   Real quant firms have loss-triggered circuit breakers that force immediate
    //   strategy review. Every losing trade is a signal that the current parameters
    //   are misaligned with market conditions — adapt now, don't wait.
    //
    // TRIGGER 2 (Scheduled Evolution): 3+ countedTrades accumulated.
    //   Once there's enough data for basic evaluation, evolve on schedule.
    //   Low threshold (3) ensures rapid adaptation in scalping environments.
    //
    const best = this.getBestStrategy();
    const activeCount = this.strategies.filter(s => s.status === 'active').length;
    const evalCount = this.strategies.filter(s => s.status === 'evaluating').length;
    const hasCapacity = (activeCount + evalCount) < this.maxActiveStrategies * 2;

    // Check if the most recent completed cycle was a losing trade
    let lastTradeWasLoss = false;
    if (tradeHistory) {
      const allEntries = tradeHistory.getAll();
      // The last entry is the CURRENT cycle (just recorded, no PnL yet).
      // The SECOND-TO-LAST entry is the PREVIOUS completed cycle with PnL computed.
      const lastCompleted = allEntries.length >= 2 ? allEntries[allEntries.length - 2] : null;
      if (lastCompleted) {
        const lastPnl = lastCompleted.realisedPnl ?? lastCompleted.simulatedPnl ?? 0;
        lastTradeWasLoss = lastPnl < 0;
      }
    }

    const minTradesForScheduledEvo = 3;
    const hasEnoughData = cumulativePerf && cumulativePerf.trades >= minTradesForScheduledEvo;
    const shouldEvolve = (lastTradeWasLoss || hasEnoughData) && hasCapacity && best && best.fitness > 0.3;

    if (shouldEvolve) {
      const trigger = lastTradeWasLoss ? 'loss-triggered' : 'scheduled';
      const child = this.mutate(best);
      child.status = 'evaluating';
      // Child inherits parent's performance as baseline (not zero)
      child.performance = { ...best.performance };
      child.fitness = best.fitness;
      this.strategies.push(child);

      log.info(`🧬 New incubating strategy [${trigger}]: Gen ${child.generation} (parent f=${(best.fitness * 100).toFixed(1)}%, countedTrades=${cumulativePerf?.trades ?? 0})`);
      this.prune();
      return child;
    }

    if (!hasEnoughData && !lastTradeWasLoss && best && best.fitness > 0.3) {
      log.info(`🧬 Evolution deferred: ${cumulativePerf?.trades ?? 0} countedTrades (need ${minTradesForScheduledEvo} or a loss), no recent loss`);
    }

    // No evolution this cycle — return current best (stays active, accumulates track record)
    if (best) return best;
    return this.strategies[0]!;
  }

  getBestStrategy(): EvolutionaryStrategy | undefined {
    const active = this.strategies
      .filter((s) => s.status === 'active')
      .sort((a, b) => b.fitness - a.fitness);
    return active[0];
  }

  getStrategyParameters(): StrategyParameters {
    const best = this.getBestStrategy();
    return best?.parameters ?? this.strategies[0]!.parameters;
  }

  getGeneration(): number {
    return this.generation;
  }

  private mutate(parent: EvolutionaryStrategy): EvolutionaryStrategy {
    const params = { ...parent.parameters };
    const noise = () => (Math.random() - 0.5) * 0.2; // ±10% mutation

    params.momentumWindow = Math.max(5, Math.round(params.momentumWindow * (1 + noise())));
    params.volatilityThreshold = Math.max(0.005, params.volatilityThreshold * (1 + noise()));
    params.riskAversion = Math.max(0, Math.min(1, params.riskAversion * (1 + noise())));
    params.signalThreshold = Math.max(0.1, Math.min(0.95, params.signalThreshold * (1 + noise())));

    return {
      id: uuidv4(),
      generation: this.generation,
      parentId: parent.id,
      fitness: 0, // will be evaluated
      parameters: params,
      performance: {
        sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
        winRate: 0, profitFactor: 0, maxDrawdown: 0,
        totalReturn: 0, trades: 0, avgWin: 0, avgLoss: 0, expectancy: 0,
      },
      status: 'evaluating',
      createdAt: Date.now(),
      lineage: [...parent.lineage, parent.id],
    };
  }

  getStrategies(): EvolutionaryStrategy[] {
    return [...this.strategies];
  }

  private prune(): void {
    this.strategies.sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      return b.fitness - a.fitness;
    });

    if (this.strategies.length > this.maxActiveStrategies * 3) {
      this.strategies = this.strategies.slice(0, this.maxActiveStrategies * 3);
    }
  }
}

// ─── Evolution Orchestrator ───
// Ties memory, fitness, and evolutionary pressure together

export class EvolutionOrchestrator {
  readonly memory: DualMemory;
  readonly fitnessCalculator: SurvivalFitnessCalculator;
  readonly pressureEngine: EvolutionaryPressureEngine;
  readonly tradeHistory: TradeHistory;
  readonly agentOutcomes: AgentOutcomeTracker;

  constructor() {
    this.memory = new DualMemory();
    this.fitnessCalculator = new SurvivalFitnessCalculator();
    this.pressureEngine = new EvolutionaryPressureEngine();
    this.tradeHistory = new TradeHistory();
    this.agentOutcomes = new AgentOutcomeTracker();

    // Restore evolution state from disk (if any)
    this.restoreState();
  }

  /** Restore all evolution state from disk */
  private restoreState(): void {
    const saved = loadEvolution();
    if (saved) {
      this.tradeHistory.load(saved.tradeHistory);
      this.memory.load(saved.shortTermMemory, saved.longTermMemory);
      this.pressureEngine.load(saved.strategies, saved.generation);
      log.info(`🧬 Evolution state restored: ${saved.tradeHistory.length} trades, Gen ${saved.generation}`);
    }
  }

  /** Attach a Sigmoid·GA sentiment engine for persistent GA state */
  private sentimentEngineRef: { getGAPopulation(): GAPopulation; loadGAPopulation(p: GAPopulation): void } | null = null;

  /** Register the sentiment engine so GA state is persisted with evolution */
  attachSentimentEngine(engine: { getGAPopulation(): GAPopulation; loadGAPopulation(p: GAPopulation): void }): void {
    this.sentimentEngineRef = engine;
    // If restored evolution has a GA population, feed it to the engine
    const saved = loadEvolution();
    if (saved?.gaPopulation) {
      engine.loadGAPopulation(saved.gaPopulation);
      log.info(`🧬 GA population restored: Gen ${saved.gaPopulation.generation}, ${saved.gaPopulation.chromosomes.length} chromosomes`);
    }
  }

  /** Persist all evolution state to disk */
  persistState(): void {
    saveEvolution({
      tradeHistory: this.tradeHistory.getAllEntries(),
      shortTermMemory: this.memory.getShortTermMemories(),
      longTermMemory: this.memory.getLongTermMemories(),
      strategies: this.pressureEngine.getAllStrategies(),
      generation: this.pressureEngine.getGeneration(),
      gaPopulation: this.sentimentEngineRef?.getGAPopulation(),
    });
  }

  getStatus(): Record<string, unknown> {
    return {
      generation: this.pressureEngine.getGeneration(),
      memory: this.memory.getStats(),
      tradeHistory: this.tradeHistory.getStats(),
      bestStrategy: this.pressureEngine.getBestStrategy()?.fitness ?? 0,
    };
  }

  /** Reset trade history without affecting strategies, generation, or memory */
  resetTradeHistory(): void {
    const prevCount = this.tradeHistory.getStats().totalEntries;
    this.tradeHistory.clear();
    this.agentOutcomes.clear();
    log.info(`🧹 Trade history reset: ${prevCount} entries cleared (strategies + generation preserved)`);
  }

  getEvolutionData(): Record<string, unknown> {
    const perf = this.tradeHistory.computePerformance();
    const bestStrat = this.pressureEngine.getBestStrategy();
    const strategies = this.pressureEngine.getStrategies();

    // Compute fitness breakdown for the best active strategy
    let fitnessBreakdown: Record<string, number> | null = null;
    if (bestStrat) {
      const calculator = new SurvivalFitnessCalculator();
      const fitness = calculator.calculate(bestStrat.performance);
      fitnessBreakdown = {
        score: fitness.score,
        capitalPreservation: fitness.capitalPreservation,
        returnGeneration: fitness.returnGeneration,
        adaptability: fitness.adaptability,
        consistency: fitness.consistency,
        riskManagement: fitness.riskManagement,
        decisionQuality: fitness.decisionQuality,
      };
    }

    return {
      generation: this.pressureEngine.getGeneration(),
      bestFitness: bestStrat?.fitness ?? 0,
      fitnessBreakdown,
      memoryShortTerm: this.memory.getStats().shortTerm,
      memoryLongTerm: this.memory.getStats().longTerm,
      tradeHistory: {
        totalEntries: this.tradeHistory.getStats().totalEntries,
        realTrades: this.tradeHistory.getStats().realTrades,
        simulatedTrades: this.tradeHistory.getStats().simulatedTrades,
        countedTrades: perf.countedTrades,
        winRate: perf.winRate,
        sharpeRatio: perf.sharpeRatio,
        sortinoRatio: perf.sortinoRatio,
        calmarRatio: perf.calmarRatio,
        totalReturn: perf.totalReturn,
        maxDrawdown: perf.maxDrawdown,
        profitFactor: perf.profitFactor,
        expectancy: perf.expectancy,
        avgWin: perf.avgWin,
        avgLoss: perf.avgLoss,
      },
      strategies: strategies.map(s => ({
        id: s.id.slice(0, 8),
        generation: s.generation,
        fitness: s.fitness,
        status: s.status,
        momentumWindow: s.parameters.momentumWindow,
        riskAversion: s.parameters.riskAversion,
        signalThreshold: s.parameters.signalThreshold,
        volatilityThreshold: s.parameters.volatilityThreshold,
        confirmationRequired: s.parameters.confirmationRequired,
        positionSizingModel: s.parameters.positionSizingModel,
      })),
    };
  }

  getContextForAgent(regime: MarketRegime): string {
    const memories = this.memory.recall(regime, 5);
    const bestStrat = this.pressureEngine.getBestStrategy();
    const tradeSummary = this.tradeHistory.getSummary(3);
    const allAgentRoles: AgentRole[] = [
      'fractal_momentum_sentinel', 'onchain_whisperer', 'rbc_sentiment_analyst',
      'news_reporter', 'independent_risk_auditor',
    ];

    let ctx = `=== EVOLUTION HARD CONSTRAINTS ===\n`;
    ctx += `These are NON-NEGOTIABLE limits derived from the evolution engine's best strategy.\n`;
    ctx += `Skeptics will reject any decision that violates them.\n\n`;

    if (bestStrat) {
      const p = bestStrat.parameters;
      // Map riskAversion to max leverage + position size
      // riskAversion=0 → max 10x, 20% position
      // riskAversion=1 → max 2x, 5% position
      const maxLevRaw = 10 - (p.riskAversion * 8);
      const maxLev = Math.max(2, Math.round(maxLevRaw));
      const maxPosPct = (0.20 * (1 - p.riskAversion * 0.75)).toFixed(3);
      const minConfForTrade = (0.3 + p.signalThreshold * 0.5).toFixed(2);

      ctx += `  riskAversion=${p.riskAversion.toFixed(2)}  (0=aggro, 1=conservative)\n`;
      ctx += `  signalThreshold=${p.signalThreshold.toFixed(2)}\n`;
      ctx += `  ── DERIVED CONSTRAINTS ──\n`;
      ctx += `  maxLeverage=${maxLev}x  (any agent proposing >${maxLev}x = REJECTED)\n`;
      ctx += `  maxPositionSize=${maxPosPct}  (any agent proposing >${(parseFloat(maxPosPct)*100).toFixed(1)}% = REJECTED)\n`;
      ctx += `  minConfidenceForTrade=${minConfForTrade}  (any trade with confidence <${(parseFloat(minConfForTrade)*100).toFixed(0)}% = REJECTED)\n`;
      ctx += `  momentumWindow=${p.momentumWindow}  (signals inside this window get more weight)\n`;
      ctx += `  volatilityThreshold=${p.volatilityThreshold.toFixed(4)}  (vol > this → mandatory size reduction)\n`;
      ctx += `\n`;
      ctx += `Generation: ${this.pressureEngine.getGeneration()}\n`;
      ctx += `Best Strategy Fitness: ${(bestStrat.fitness * 100).toFixed(1)}%\n`;
    } else {
      ctx += `  (no best strategy yet — using default constraints)\n`;
      ctx += `  maxLeverage=5x\n`;
      ctx += `  maxPositionSize=0.10\n`;
      ctx += `  minConfidenceForTrade=0.50\n`;
      ctx += `\n`;
      ctx += `Generation: ${this.pressureEngine.getGeneration()}\n`;
    }

    ctx += `\n${tradeSummary}\n`;

    // Per-agent outcome summary
    ctx += `\n=== Agent Track Records (recent) ===\n`;
    for (const role of allAgentRoles) {
      ctx += this.agentOutcomes.getContextSummary(role, 3) + '\n';
    }
    ctx += `\n`;

    if (memories.length > 0) {
      ctx += `Relevant Past Experiences:\n`;
      for (const m of memories.slice(0, 3)) {
        ctx += `- [${m.type}] ${m.lessons.join(', ')}\n`;
      }
    }

    return ctx;
  }
}