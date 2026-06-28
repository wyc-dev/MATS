// ─── Evolution Systems ───
// Dual memory, survival fitness, evolutionary pressure, and adaptation orchestrator

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { AgentOutcomeTracker } from './agent-outcomes.ts';
import { AgentEvolutionEngine } from './agent-evolution.ts';
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

    // ─── Consistency (5%) ──
    // v2.0.22 fix: previously used raw sortinoRatio/2 + calmarRatio/3 which are
    // unbounded — once the strategy performs well these exceed 1.0 and normalize
    // clamps to 1.0, making consistency permanently 100%. Now uses bounded
    // transforms (x / (x + k)) so the ratios asymptote to 1.0 instead of
    // blowing past it. winRate is already 0-1.
    // sortino: k=2 (sortino 2.0 → 0.5, 4.0 → 0.67, ∞ → 1.0)
    // calmar: k=3 (calmar 3.0 → 0.5, 6.0 → 0.67, ∞ → 1.0)
    const consistency = this.normalize(
      (performance.winRate) * 0.5 +
      (performance.sortinoRatio / (performance.sortinoRatio + 2)) * 0.3 +
      (performance.calmarRatio / (performance.calmarRatio + 3)) * 0.2
    );

    // ─── Adaptability (5%) ──
    // v2.0.22 fix: previously used Math.min(trades/100, 1) which saturates to
    // 1.0 once cumulative trades exceed 100 — so adaptability was permanently
    // 100% after the first 100 trades, regardless of recent performance.
    // Now combines trade sufficiency (≥50 trades = full sample) with actual
    // win rate, so a strategy with 500 trades but 20% win rate gets low
    // adaptability (it's NOT adapting to the market), while a strategy with
    // 50 trades and 60% win rate gets high adaptability.
    const tradeSufficiency = Math.min(performance.trades / 50, 1);
    const adaptability = this.normalize(tradeSufficiency * performance.winRate);

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
        // Store the full breakdown so mutate() can guide the next child toward
        // fixing the weakest dimension (v2.0.15 directional mutation).
        strat.fitnessBreakdown = fitness;

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

  /**
   * Regime-aware best strategy selection (v2.0.15).
   *
   * Instead of always returning the globally-highest-fitness strategy, score
   * each active strategy by how well its regimeWeights align with the current
   * regime, then pick the best. A strategy tuned for trending_bull (weight 0.8)
   * is a poor fit for a chaotic regime (weight 0.1) even if its overall
   * fitness is high.
   *
   * Score = fitness × regimeWeight[currentRegime] (normalised by the max
   * regimeWeight so a strategy with all-low weights isn't unfairly penalised).
   * Falls back to getBestStrategy() when no regime is provided or no active
   * strategies have a weight for the regime.
   */
  getBestStrategyForRegime(regime?: MarketRegime): EvolutionaryStrategy | undefined {
    if (!regime) return this.getBestStrategy();
    const active = this.strategies.filter((s) => s.status === 'active');
    if (active.length === 0) return undefined;

    let best: EvolutionaryStrategy | undefined;
    let bestScore = -Infinity;
    for (const strat of active) {
      const regimeWeight = strat.parameters.regimeWeights[regime] ?? 0.3;
      // Normalise: scale by the strategy's own max regime weight so a
      // uniformly-conservative strategy isn't always deprioritised.
      const maxRW = Math.max(...Object.values(strat.parameters.regimeWeights), 0.01);
      const normalisedRW = regimeWeight / maxRW;
      const score = strat.fitness * normalisedRW;
      if (score > bestScore) {
        bestScore = score;
        best = strat;
      }
    }
    return best ?? this.getBestStrategy();
  }

  getStrategyParameters(regime?: MarketRegime): StrategyParameters {
    const best = regime ? this.getBestStrategyForRegime(regime) : this.getBestStrategy();
    return best?.parameters ?? this.strategies[0]!.parameters;
  }

  getGeneration(): number {
    return this.generation;
  }

  /**
   * Directional mutation (v2.0.15): guide the child's parameter changes toward
   * fixing the parent's weakest fitness dimension, instead of blind random
   * noise. This is how institutional quant funds mutate — gradient-guided by
   * the fitness breakdown, not undirected search.
   *
   * For each weak dimension (breakdown < 0.4), apply a targeted parameter
   * shift in the direction that should improve it. A small random noise is
   * still added so the search doesn't collapse to a single gradient line.
   *
   * If no breakdown is available (legacy/loaded strategy), fall back to the
   * original random ±10% mutation.
   */
  private mutate(parent: EvolutionaryStrategy): EvolutionaryStrategy {
    const params = { ...parent.parameters };
    const noise = () => (Math.random() - 0.5) * 0.2; // ±10% residual noise
    const fb = parent.fitnessBreakdown;

    if (!fb) {
      // Legacy fallback: undirected mutation
      params.momentumWindow = Math.max(5, Math.round(params.momentumWindow * (1 + noise())));
      params.volatilityThreshold = Math.max(0.005, params.volatilityThreshold * (1 + noise()));
      params.riskAversion = Math.max(0, Math.min(1, params.riskAversion * (1 + noise())));
      params.signalThreshold = Math.max(0.1, Math.min(0.95, params.signalThreshold * (1 + noise())));
    } else {
      // Directional shifts: each weak dimension (< 0.4) nudges a parameter
      // in the remediation direction, plus residual noise for exploration.
      const weak = (v: number) => v < 0.4;
      const nudge = (base: number, direction: number, magnitude = 0.15) =>
        Math.max(0, Math.min(1, base * (1 + direction * magnitude + noise())));

      // capitalPreservation low → raise riskAversion (more conservative)
      if (weak(fb.capitalPreservation)) {
        params.riskAversion = Math.min(1, params.riskAversion * (1 + 0.15 + noise() * 0.5));
        log.info(`🧬 directional mutate: capitalPreservation=${fb.capitalPreservation.toFixed(2)} → raise riskAversion`);
      }
      // decisionQuality low (microscopic wins) → raise signalThreshold (pickier)
      if (weak(fb.decisionQuality)) {
        params.signalThreshold = Math.min(0.95, params.signalThreshold * (1 + 0.12 + noise() * 0.5));
        log.info(`🧬 directional mutate: decisionQuality=${fb.decisionQuality.toFixed(2)} → raise signalThreshold`);
      }
      // adaptability low (few trades) → lower signalThreshold + confirmationRequired
      if (weak(fb.adaptability)) {
        params.signalThreshold = Math.max(0.1, params.signalThreshold * (1 - 0.10 + noise() * 0.5));
        params.confirmationRequired = Math.max(1, (params.confirmationRequired ?? 2) - 1);
        log.info(`🧬 directional mutate: adaptability=${fb.adaptability.toFixed(2)} → lower signalThreshold + confirmationRequired`);
      }
      // consistency low → raise riskAversion + narrow volatilityThreshold
      if (weak(fb.consistency)) {
        params.riskAversion = Math.min(1, (params.riskAversion + 0.05) * (1 + noise() * 0.3));
        params.volatilityThreshold = Math.max(0.005, params.volatilityThreshold * (1 - 0.08 + noise() * 0.3));
        log.info(`🧬 directional mutate: consistency=${fb.consistency.toFixed(2)} → raise riskAversion + narrow volThreshold`);
      }
      // returnGeneration low → lower riskAversion (more aggressive) + widen volThreshold
      if (weak(fb.returnGeneration)) {
        params.riskAversion = Math.max(0, params.riskAversion * (1 - 0.10 + noise() * 0.5));
        params.volatilityThreshold = Math.max(0.005, params.volatilityThreshold * (1 + 0.10 + noise() * 0.3));
        log.info(`🧬 directional mutate: returnGeneration=${fb.returnGeneration.toFixed(2)} → lower riskAversion + widen volThreshold`);
      }
      // riskManagement low (poor win/loss ratio) → raise signalThreshold (only high-quality signals)
      if (weak(fb.riskManagement)) {
        params.signalThreshold = Math.min(0.95, params.signalThreshold * (1 + 0.08 + noise() * 0.3));
        log.info(`🧬 directional mutate: riskManagement=${fb.riskManagement.toFixed(2)} → raise signalThreshold`);

      }

      // Always apply a small residual mutation to momentumWindow for exploration
      params.momentumWindow = Math.max(5, Math.round(params.momentumWindow * (1 + noise())));

      // Clamp all params to valid ranges
      params.riskAversion = Math.max(0, Math.min(1, params.riskAversion));
      params.signalThreshold = Math.max(0.1, Math.min(0.95, params.signalThreshold));
      params.volatilityThreshold = Math.max(0.005, params.volatilityThreshold);
    }

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
  /** v2.0.15: per-agent dynamic weight engine (regime-aware). */
  readonly agentEvolution: AgentEvolutionEngine;

  constructor() {
    this.memory = new DualMemory();
    this.fitnessCalculator = new SurvivalFitnessCalculator();
    this.pressureEngine = new EvolutionaryPressureEngine();
    this.tradeHistory = new TradeHistory();
    this.agentOutcomes = new AgentOutcomeTracker();
    this.agentEvolution = new AgentEvolutionEngine(this.agentOutcomes);

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

  // ═══════════════════════════════════════════════════════════════
  // v2.0.41: Evolution params now have DETERMINISTIC ENFORCEMENT.
  //
  // signalThreshold → directly overrides HACP consensusThreshold.
  //   The Evolution Engine's best strategy signalThreshold (0.1-0.95)
  //   is applied as the HACP consensus threshold via
  //   hacpEngine.setEvolutionThreshold() every cycle.
  //   This means: if Evolution says "be pickier" (high signalThreshold),
  //   the consensus threshold actually rises — agents need stronger
  //   directional agreement to pass.
  //
  // riskAversion → no longer controls position size (Market Agent does).
  //   riskAversion is still used in getContextForAgent() as informational
  //   context for the LLM, but it does NOT deterministically enforce
  //   any position size cap.
  //
  // ⚠️ MAINTENANCE NOTE: If you add new Evolution param enforcement,
  // you MUST update this comment AND add the enforcement code in the
  // appropriate runtime location (HACP, Risk Engine, etc.). Evolution
  // params without deterministic enforcement are just decoration.
  // ═══════════════════════════════════════════════════════════════

  getContextForAgent(regime: MarketRegime): string {
    const memories = this.memory.recall(regime, 5);
    const bestStrat = this.pressureEngine.getBestStrategy();
    const tradeSummary = this.tradeHistory.getSummary(3);
    const allAgentRoles: AgentRole[] = [
      'fractal_momentum_sentinel', 'onchain_whisperer', 'rbc_sentiment_analyst',
      'news_reporter', 'independent_risk_auditor',
    ];

    // v2.0.41: Changed label from "HARD CONSTRAINTS" to "STRATEGY CONTEXT"
    // because maxPositionSize is no longer enforced (Market Agent controls
    // size). Only signalThreshold has deterministic enforcement (via
    // setEvolutionThreshold in HACP). Other params are informational.
    let ctx = `=== EVOLUTION STRATEGY CONTEXT ===\n`;
    ctx += `signalThreshold is DETERMINISTICALLY ENFORCED as the HACP consensus threshold.\n`;
    ctx += `Other params are informational — Market Agent controls position size.\n\n`;

    if (bestStrat) {
      const p = bestStrat.parameters;
      const minConfForTrade = (0.3 + p.signalThreshold * 0.5).toFixed(2);

      ctx += `  riskAversion=${p.riskAversion.toFixed(2)}  (0=aggro, 1=conservative) [informational]\n`;
      ctx += `  signalThreshold=${p.signalThreshold.toFixed(2)}  [ENFORCED as consensus threshold]\n`;
      ctx += `  ── DERIVED ──\n`;
      ctx += `  minConfidenceForTrade=${minConfForTrade}  (informational — LLM should consider)\n`;
      ctx += `  momentumWindow=${p.momentumWindow}  (informational — signals inside this window get more weight)\n`;
      ctx += `  volatilityThreshold=${p.volatilityThreshold.toFixed(4)}  (informational — vol > this suggests caution)\n`;
      ctx += `\n`;
      ctx += `Generation: ${this.pressureEngine.getGeneration()}\n`;
      ctx += `Best Strategy Fitness: ${(bestStrat.fitness * 100).toFixed(1)}%\n`;
    } else {
      ctx += `  (no best strategy yet — using default constraints)\n`;
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