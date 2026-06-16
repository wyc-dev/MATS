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
  calculate(performance: StrategyPerformance): SurvivalFitness {
    // Capital preservation is #1 priority
    const capitalPreservation = this.normalize(1 - Math.abs(performance.maxDrawdown / 0.3));
    const drawdownPenalty = performance.maxDrawdown > 0.15 ? 0.5 : 1.0;

    // Return generation (risk-adjusted)
    const returnGen = this.normalize(
      (performance.sharpeRatio / 3) * 0.4 +
      (performance.totalReturn / 100) * 0.3 +
      (performance.winRate) * 0.3
    );

    // Adaptability (trades count suggests active adaptation)
    const adaptability = this.normalize(Math.min(performance.trades / 200, 1));

    // Consistency
    const consistency = this.normalize(
      (performance.winRate) * 0.5 +
      (performance.sortinoRatio / 3) * 0.3 +
      (performance.calmarRatio / 2) * 0.2
    );

    // Risk management
    const riskMgmt = this.normalize(
      (1 - Math.abs(performance.maxDrawdown / 0.3)) * 0.5 +
      this.normalize(performance.profitFactor / 5) * 0.3 +
      this.normalize(performance.expectancy * 10) * 0.2
    );

    // Decision quality
    const decisionQuality = this.normalize(
      (performance.winRate) * 0.4 +
      (performance.avgWin / (Math.abs(performance.avgLoss) + 0.01)) * 0.3 +
      (performance.profitFactor / 3) * 0.3
    );

    // Composite score — capital preservation heavily weighted
    const score = (
      capitalPreservation * 0.35 +
      returnGen * 0.20 +
      adaptability * 0.10 +
      consistency * 0.15 +
      riskMgmt * 0.15 +
      decisionQuality * 0.05
    ) * drawdownPenalty;

    return {
      score: parseFloat(score.toFixed(4)),
      capitalPreservation: parseFloat(capitalPreservation.toFixed(4)),
      returnGeneration: parseFloat(returnGen.toFixed(4)),
      adaptability: parseFloat(adaptability.toFixed(4)),
      consistency: parseFloat(consistency.toFixed(4)),
      riskManagement: parseFloat(riskMgmt.toFixed(4)),
      decisionQuality: parseFloat(decisionQuality.toFixed(4)),
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
        // Evaluating strategies: after 3 generations, promote to active or retire
        if (this.generation - strat.generation >= 3) {
          strat.performance = cumulativePerf ?? { ...strat.performance, ...performanceMetrics };
          const calculator = new SurvivalFitnessCalculator();
          const fitness = calculator.calculate(strat.performance);
          strat.fitness = fitness.score;
          if (fitness.score >= 0.2) {
            strat.status = 'active';
            log.info(`Strategy ${strat.id.slice(0, 8)} promoted to active (fitness: ${fitness.score.toFixed(4)})`);
          } else {
            strat.status = 'retired';
            log.info(`Strategy ${strat.id.slice(0, 8)} retired after evaluation (fitness: ${fitness.score.toFixed(4)})`);
          }
        }
      }
    }

    // Mutate best strategy to create new generation
    const best = this.getBestStrategy();
    if (best && best.fitness > 0.3) {
      const child = this.mutate(best);
      // Demote parent, promote child immediately so the active strategy evolves
      best.status = 'retired';
      child.status = 'active';
      this.strategies.push(child);

      log.info(`Evolved: Gen ${best.generation} (f=${(best.fitness * 100).toFixed(1)}%) → Gen ${child.generation} (active)`);

      // Prune old strategies
      this.prune();

      return child;
    }

    // If best fitness <= 0.3, still mutate but keep parent active for comparison
    if (best) {
      const child = this.mutate(best);
      child.status = 'evaluating';
      this.strategies.push(child);
      log.info(`New evaluating strategy: Gen ${child.generation} (parent fitness: ${(best.fitness * 100).toFixed(1)}%)`);
      this.prune();
      return child;
    }

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