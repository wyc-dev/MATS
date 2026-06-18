// ─── Sigmoid·GA Sentiment Engine ───
// Genetic Algorithm that evolves sigmoid-based sentiment functions
// to model whale presence, institutional flow, microstructure tension,
// momentum bias, and fear/greed — all without lagging technical indicators.
//
// "Predict institutions, not prices. Sentiment precedes move."

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import type {
  GAChromosome,
  GAPopulation,
  SigmoidParams,
  SentimentSignal,
  SentimentAggregate,
} from '../types/index.ts';

const log = createLogger({ phase: 'sigmoid-ga' });

// ─── Constants ───

const POPULATION_SIZE = 20;
const TOURNAMENT_SIZE = 6;
const CROSSOVER_RATE = 0.70;
const MUTATION_RATE = 0.15;
const MUTATION_SIGMA = 0.05; // ±5% of parameter range
const ELITE_COUNT = 2;        // Keep top N unchanged
const DEFAULT_FITNESS = 0.5;

// Parameter bounds
const K_MIN = 0.1, K_MAX = 10.0;
const X0_MIN = -2.0, X0_MAX = 2.0;
const WEIGHT_MIN = 0.0, WEIGHT_MAX = 1.0;
const LINEAR_W_MIN = 0.0, LINEAR_W_MAX = 1.0;
const PROD_W_MIN = 0.0, PROD_W_MAX = 1.0;
const CONVICTION_MIN = 0.3, CONVICTION_MAX = 0.9;

// ─── Sigmoid Function ───

export function sigmoid(x: number, k: number, x0: number): number {
  // Clamp input to avoid overflow
  const z = Math.max(-500, Math.min(500, k * (x - x0)));
  return 1 / (1 + Math.exp(-z));
}

/** Scale a sigmoid output (0-1) to a bipolar range (-1 to +1) */
export function sigmoidBipolar(x: number, k: number, x0: number): number {
  return sigmoid(x, k, x0) * 2 - 1;
}

// ─── Default Chromosome ───

export function createDefaultChromosome(generation = 1): GAChromosome {
  return {
    id: uuidv4(),
    generation,
    fitness: DEFAULT_FITNESS,
    whale: { k: 2.0, x0: 0.3, weight: 0.25 },
    institutional: { k: 1.5, x0: 0.0, weight: 0.20 },
    microstructure: { k: 3.0, x0: 0.2, weight: 0.15 },
    momentum: { k: 1.0, x0: 0.0, weight: 0.25 },
    fearGreed: { k: 2.0, x0: 0.0, weight: 0.15 },
    linearWeight: 0.6,
    productWeight: 0.4,
    convictionThreshold: 0.60,
    parentIds: [],
    createdAt: Date.now(),
  };
}

// ─── Random Chromosome (for population initialization) ───

function randomParam(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomSigmoidParams(): SigmoidParams {
  return {
    k: randomParam(K_MIN, K_MAX),
    x0: randomParam(X0_MIN, X0_MAX),
    weight: randomParam(WEIGHT_MIN, WEIGHT_MAX),
  };
}

function randomChromosome(generation: number): GAChromosome {
  const c = createDefaultChromosome(generation);
  c.whale = randomSigmoidParams();
  c.institutional = randomSigmoidParams();
  c.microstructure = randomSigmoidParams();
  c.momentum = randomSigmoidParams();
  c.fearGreed = randomSigmoidParams();
  c.linearWeight = randomParam(LINEAR_W_MIN, LINEAR_W_MAX);
  c.productWeight = randomParam(PROD_W_MIN, PROD_W_MAX);
  c.convictionThreshold = randomParam(CONVICTION_MIN, CONVICTION_MAX);
  c.fitness = 0; // Unevaluated — set by real trade performance
  return c;
}

// ─── Sentiment Computation ───

/** Raw market data that feeds into the sentiment engine */
export interface SentimentInputs {
  orderBookImbalance: number;   // -1 (all asks) to +1 (all bids)
  volumeAcceleration: number;    // Δvol / Δt normalized (-1 to +1)
  fundingRateDelta: number;      // change in funding rate (-1 to +1)
  fundingRateAccel: number;      // funding rate acceleration (-1 to +1)
  spreadPressure: number;        // bid/ask pressure (-1 to +1)
  priceAcceleration: number;     // Δ²p / Δt² normalized (-1 to +1)
  largeTradeCount: number;       // count of large trades normalized (0-1)
  fearGreedIndex: number;        // 0-100 scaled to 0-1
  volatilityRegime: number;      // 0 (low) to 1 (chaotic)
}

/** Compute sentiment from raw inputs using a chromosome's sigmoid params */
export function computeSentiment(
  inputs: SentimentInputs,
  chromosome: GAChromosome,
): SentimentAggregate {
  const c = chromosome;

  // Compute individual signal channels
  const signals: SentimentSignal = {
    whaleScore: sigmoid(inputs.orderBookImbalance + inputs.largeTradeCount - 0.5, c.whale.k, c.whale.x0),
    institutionalPressure: sigmoid(inputs.volumeAcceleration + inputs.fundingRateDelta + inputs.fundingRateAccel * 0.5, c.institutional.k, c.institutional.x0),
    microstructureTension: sigmoid(inputs.spreadPressure + inputs.orderBookImbalance * 0.5, c.microstructure.k, c.microstructure.x0),
    momentumBias: sigmoidBipolar(inputs.priceAcceleration, c.momentum.k, c.momentum.x0),
    fearGreedEcho: sigmoidBipolar(inputs.fearGreedIndex - 0.5 + inputs.volatilityRegime * 0.3, c.fearGreed.k, c.fearGreed.x0),
  };

  // Weighted combination
  const weights = [
    c.whale.weight,
    c.institutional.weight,
    c.microstructure.weight,
    c.momentum.weight,
    c.fearGreed.weight,
  ];

  // Normalize weights
  const wSum = weights.reduce((a, b) => a + b, 0);
  const wNorm = wSum > 0 ? weights.map(w => w / wSum) : [0.2, 0.2, 0.2, 0.2, 0.2];

  const linearVals = [
    signals.whaleScore,
    signals.institutionalPressure,
    signals.microstructureTension,
    (signals.momentumBias + 1) / 2,
    (signals.fearGreedEcho + 1) / 2,
  ];

  // Linear combination (0-1)
  const linearSum = linearVals.reduce((s, v, i) => s + v * wNorm[i]!, 0);

  // Product combination (captures signal agreement — if any signal is 0, product dampens)
  const productRaw = linearVals.reduce((p, v) => p * v, 1);
  const productSum = Math.pow(productRaw, 1 / linearVals.length); // geometric mean

  // Blend linear + product.
  // Normalise the two blend weights so their sum = 1 — this guarantees the
  // blend stays in [0,1] (and overallSentiment in [-1,+1]) even if GA mutation
  // drifts linearWeight + productWeight away from 1.0.
  const blendWSum = c.linearWeight + c.productWeight;
  const lw = blendWSum > 0 ? c.linearWeight / blendWSum : 0.5;
  const pw = blendWSum > 0 ? c.productWeight / blendWSum : 0.5;
  const blend = lw * linearSum + pw * productSum;

  // Scale to bipolar (-1 to +1)
  const overallSentiment = blend * 2 - 1;

  // Conviction = how much the signals agree (low variance = high conviction)
  const mean = linearSum;
  const variance = linearVals.reduce((s, v) => s + (v - mean) ** 2, 0) / linearVals.length;
  const agreementPenalty = Math.sqrt(variance) * 2; // 0 to ~1
  const conviction = Math.max(0, Math.min(1, 1 - agreementPenalty)) * (blend > c.convictionThreshold ? 1.0 : 0.5);

  return {
    signals,
    overallSentiment,
    conviction,
    rawInputs: {
      orderBookImbalance: inputs.orderBookImbalance,
      volumeAcceleration: inputs.volumeAcceleration,
      fundingRateDelta: inputs.fundingRateDelta,
      fundingRateAccel: inputs.fundingRateAccel,
      spreadPressure: inputs.spreadPressure,
      priceAcceleration: inputs.priceAcceleration,
      largeTradeCount: inputs.largeTradeCount,
      fearGreedIndex: inputs.fearGreedIndex,
      volatilityRegime: inputs.volatilityRegime,
    },
  };
}

// ─── Genetic Algorithm ───

export class SigmoidGA {
  private population: GAPopulation;
  private tradeHistoryFitness: Array<{ fitness: number; generation: number }> = [];

  constructor() {
    this.population = {
      generation: 1,
      chromosomes: this.initializePopulation(),
      bestFitness: 0,
      bestChromosome: null,
    };
    this.evaluate();
  }

  /** Load population from saved state */
  load(population: GAPopulation): void {
    this.population = population;
    log.info(`GA loaded: Gen ${population.generation}, ${population.chromosomes.length} chromosomes, best fitness: ${(population.bestFitness * 100).toFixed(1)}%`);
  }

  /** Get current population for serialization */
  getPopulation(): GAPopulation {
    return this.population;
  }

  /** Get the best chromosome */
  getBestChromosome(): GAChromosome {
    return this.population.bestChromosome ?? this.population.chromosomes[0] ?? createDefaultChromosome(1);
  }

  /** Get generation number */
  getGeneration(): number {
    return this.population.generation;
  }

  /** Get fitness history for trend analysis */
  getFitnessHistory(): Array<{ fitness: number; generation: number }> {
    return [...this.tradeHistoryFitness];
  }

  /** Run one generation of evolution */
  evolve(fitnessOverride?: number): GAChromosome {
    this.population.generation++;

    if (fitnessOverride !== undefined) {
      // Assign fitness to the best chromosome from last evaluation
      const best = this.getBestChromosome();
      best.fitness = fitnessOverride;
      this.tradeHistoryFitness.push({ fitness: fitnessOverride, generation: this.population.generation });
    }

    const nextGen: GAChromosome[] = [];

    // Elitism: keep top N
    const sorted = [...this.population.chromosomes].sort((a, b) => b.fitness - a.fitness);
    for (let i = 0; i < Math.min(ELITE_COUNT, sorted.length); i++) {
      nextGen.push({ ...sorted[i]!, id: uuidv4(), generation: this.population.generation });
    }

    // Fill rest with offspring
    while (nextGen.length < POPULATION_SIZE) {
      const parent1 = this.tournamentSelect();
      const parent2 = this.tournamentSelect();
      const child = this.crossover(parent1, parent2);
      this.mutate(child);
      child.parentIds = [parent1.id, parent2.id];
      child.createdAt = Date.now();
      nextGen.push(child);
    }

    this.population.chromosomes = nextGen;
    this.evaluate();

    log.info(`🧬 GA evolved: Gen ${this.population.generation}, best fitness: ${(this.population.bestFitness * 100).toFixed(1)}%`);
    return this.getBestChromosome();
  }

  /** Format sentiment for agent context injection */
  formatForAgentContext(sentiment: SentimentAggregate): string {
    const s = sentiment.signals;
    const emoji = sentiment.overallSentiment > 0.3 ? '🟢' : sentiment.overallSentiment < -0.3 ? '🔴' : '🟡';

    return [
      `=== SIGMOID·GA SENTIMENT ===`,
      `${emoji} Overall: ${(sentiment.overallSentiment * 100).toFixed(1)}% (conviction: ${(sentiment.conviction * 100).toFixed(0)}%)`,
      `  Whale Presence:    ${(s.whaleScore * 100).toFixed(0)}%`,
      `  Institutional Flow: ${(s.institutionalPressure * 100).toFixed(0)}%`,
      `  Microstructure:    ${(s.microstructureTension * 100).toFixed(0)}%`,
      `  Momentum Bias:     ${(s.momentumBias * 100).toFixed(1)}%`,
      `  Fear/Greed Echo:   ${(s.fearGreedEcho * 100).toFixed(1)}%`,
      `Raw Signals:`,
      `  OB Imbalance: ${sentiment.rawInputs.orderBookImbalance.toFixed(3)}`,
      `  Vol Accel:    ${sentiment.rawInputs.volumeAcceleration.toFixed(3)}`,
      `  Spread Pres:  ${sentiment.rawInputs.spreadPressure.toFixed(3)}`,
      `  Price Accel:  ${sentiment.rawInputs.priceAcceleration.toFixed(3)}`,
      `  Large Trades: ${(sentiment.rawInputs.largeTradeCount * 100).toFixed(0)}%`,
    ].join('\n');
  }

  // ── Private Methods ──

  private initializePopulation(): GAChromosome[] {
    const pop: GAChromosome[] = [];
    // Seed with 1 default chromosome (proven starting point)
    pop.push(createDefaultChromosome(1));
    // Fill with random chromosomes
    for (let i = 1; i < POPULATION_SIZE; i++) {
      pop.push(randomChromosome(1));
    }
    return pop;
  }

  private evaluate(): void {
    // Evaluate all chromosomes
    for (const c of this.population.chromosomes) {
      // Fitness comes from external trade history (set via evolve())
      // If not yet evaluated, keep default
    }

    // Find best
    const sorted = [...this.population.chromosomes].sort((a, b) => b.fitness - a.fitness);
    this.population.bestFitness = sorted[0]?.fitness ?? 0;
    this.population.bestChromosome = sorted[0] ?? null;
  }

  private tournamentSelect(): GAChromosome {
    let best: GAChromosome | null = null;
    let bestFitness = -Infinity;
    for (let i = 0; i < TOURNAMENT_SIZE; i++) {
      const idx = Math.floor(Math.random() * this.population.chromosomes.length);
      const candidate = this.population.chromosomes[idx]!;
      if (candidate.fitness > bestFitness) {
        best = candidate;
        bestFitness = candidate.fitness;
      }
    }
    return { ...best! };
  }

  private crossover(p1: GAChromosome, p2: GAChromosome): GAChromosome {
    if (Math.random() > CROSSOVER_RATE) {
      // No crossover: return copy of fitter parent
      return p1.fitness >= p2.fitness ? { ...p1 } : { ...p2 };
    }

    // 2-point crossover across the flattened parameter space
    const fields: Array<keyof GAChromosome> = [
      'whale', 'institutional', 'microstructure', 'momentum', 'fearGreed',
      'linearWeight', 'productWeight', 'convictionThreshold',
    ];

    const point1 = Math.floor(Math.random() * fields.length);
    const point2 = Math.floor(Math.random() * fields.length);
    const start = Math.min(point1, point2);
    const end = Math.max(point1, point2);

    const child = { ...p1 };
    for (let i = start; i < end && i < fields.length; i++) {
      const field = fields[i]!;
      (child as any)[field] = (p2 as any)[field];
    }

    child.fitness = 0; // Unevaluated — set by real trade performance — will be re-evaluated
    return child;
  }

  private mutate(c: GAChromosome): void {
    const fields: Array<keyof GAChromosome> = [
      'whale', 'institutional', 'microstructure', 'momentum', 'fearGreed',
      'linearWeight', 'productWeight', 'convictionThreshold',
    ];

    for (const field of fields) {
      if (Math.random() > MUTATION_RATE) continue;

      if (field === 'linearWeight' || field === 'productWeight' || field === 'convictionThreshold') {
        // Scalar field
        const val = c[field] as number;
        const delta = (Math.random() - 0.5) * 2 * MUTATION_SIGMA;
        const min = field === 'convictionThreshold' ? CONVICTION_MIN : LINEAR_W_MIN;
        const max = field === 'convictionThreshold' ? CONVICTION_MAX : LINEAR_W_MAX;
        (c as any)[field] = Math.max(min, Math.min(max, val + delta * (max - min)));
      } else {
        // SigmoidParams object
        const params = c[field] as SigmoidParams;
        if (Math.random() < 0.33) {
          params.k = Math.max(K_MIN, Math.min(K_MAX, params.k + (Math.random() - 0.5) * 2 * MUTATION_SIGMA * (K_MAX - K_MIN)));
        }
        if (Math.random() < 0.33) {
          params.x0 = Math.max(X0_MIN, Math.min(X0_MAX, params.x0 + (Math.random() - 0.5) * 2 * MUTATION_SIGMA * (X0_MAX - X0_MIN)));
        }
        if (Math.random() < 0.33) {
          params.weight = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, params.weight + (Math.random() - 0.5) * 2 * MUTATION_SIGMA * (WEIGHT_MAX - WEIGHT_MIN)));
        }
        (c as any)[field] = params;
      }
    }
  }
}