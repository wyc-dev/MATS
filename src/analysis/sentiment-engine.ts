// ─── Sentiment Engine ───
// Computes raw market signals from exchange data, feeds them into
// the Sigmoid·GA engine to produce sentiment scores for agent context.
//
// "From raw data to emotional state of the market — in one sigmoid step."

import { createLogger } from '../observability/logger.ts';
import { SigmoidGA, computeSentiment, type SentimentInputs } from './sigmoid-ga.ts';
import type { GAChromosome, SentimentAggregate, MarketState } from '../types/index.ts';

const log = createLogger({ phase: 'sentiment' });

// ─── Price Buffer for Acceleration Computation ───
// Stores recent prices to compute Δp/Δt and Δ²p/Δt²

const PRICE_BUFFER_SIZE = 20;

export class PriceBuffer {
  private prices: Array<{ price: number; timestamp: number }> = [];

  push(price: number): void {
    this.prices.push({ price, timestamp: Date.now() });
    if (this.prices.length > PRICE_BUFFER_SIZE) {
      this.prices.shift();
    }
  }

  /** Price change rate: Δp/Δt normalized (-1 to +1).
   *  Uses rolling std of per-tick returns for adaptive normalisation —
   *  a 1% move in a low-vol asset scores higher than 1% in a high-vol asset. */
  getVelocity(): number {
    if (this.prices.length < 2) return 0;
    const first = this.prices[0]!;
    const last = this.prices[this.prices.length - 1]!;
    const dt = last.timestamp - first.timestamp;
    if (dt < 100) return 0; // Too short
    const dp = (last.price - first.price) / first.price;

    // Adaptive scale: rolling std of per-tick returns.
    // Fallback to a conservative 0.002 (0.2%) if insufficient data.
    const rets: number[] = [];
    for (let i = 1; i < this.prices.length; i++) {
      const prev = this.prices[i - 1]!.price;
      if (prev > 0) rets.push((this.prices[i]!.price - prev) / prev);
    }
    const scale = rets.length >= 3 ? stdDev(rets) * Math.sqrt(this.prices.length) : 0.002;
    return Math.max(-1, Math.min(1, scale > 0 ? dp / scale : 0));
  }

  /** Price acceleration: Δ²p/Δt² normalized (-1 to +1).
   *  Adaptive normalisation via rolling std of per-tick returns. */
  getAcceleration(): number {
    if (this.prices.length < 6) return 0;
    const half = Math.floor(this.prices.length / 2);

    const avgFirst = this.prices.slice(0, half).reduce((s, p) => s + p.price, 0) / half;
    if (avgFirst <= 0) return 0;

    // Velocity of first half vs second half (fractional, per-tick)
    const v1 = (this.prices[half - 1]!.price - this.prices[0]!.price) / this.prices[0]!.price;
    const v2 = (this.prices[this.prices.length - 1]!.price - this.prices[half]!.price) / this.prices[half]!.price;
    const accel = v2 - v1;

    // Adaptive scale: rolling std of per-tick returns.
    const rets: number[] = [];
    for (let i = 1; i < this.prices.length; i++) {
      const prev = this.prices[i - 1]!.price;
      if (prev > 0) rets.push((this.prices[i]!.price - prev) / prev);
    }
    const scale = rets.length >= 3 ? stdDev(rets) : 0.001;
    return Math.max(-1, Math.min(1, scale > 0 ? accel / scale : 0));
  }

  reset(): void {
    this.prices = [];
  }
}

/** Sample standard deviation (Bessel-corrected). */
function stdDev(x: number[]): number {
  if (x.length < 2) return 0;
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  const variance = x.reduce((s, v) => s + (v - mean) ** 2, 0) / (x.length - 1);
  return Math.sqrt(variance);
}

// ─── Volume Acceleration Buffer ───

const VOLUME_BUFFER_SIZE = 10;

export class VolumeBuffer {
  private volumes: Array<{ volume: number; timestamp: number }> = [];

  push(volume: number): void {
    this.volumes.push({ volume, timestamp: Date.now() });
    if (this.volumes.length > VOLUME_BUFFER_SIZE) {
      this.volumes.shift();
    }
  }

  /** Volume acceleration normalized (0-1) */
  getAcceleration(): number {
    if (this.volumes.length < 3) return 0;
    const half = Math.floor(this.volumes.length / 2);
    const firstHalf = this.volumes.slice(0, half);
    const secondHalf = this.volumes.slice(half);

    const avgFirst = firstHalf.reduce((s, v) => s + v.volume, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, v) => s + v.volume, 0) / secondHalf.length;

    if (avgFirst < 0.001) return 0;
    const ratio = avgSecond / avgFirst - 1; // -1 to +inf
    // Normalize: 100% increase → 0.8, 200% → ~0.95
    return Math.max(-1, Math.min(1, ratio / 2));
  }

  /** Volume ratio: current volume / rolling average. 1.0 = normal, 0.5 = half, 2.0 = double */
  getVolumeRatio(): number {
    if (this.volumes.length < 2) return 1;
    const avg = this.volumes.reduce((s, v) => s + v.volume, 0) / this.volumes.length;
    const current = this.volumes[this.volumes.length - 1]!.volume;
    if (avg < 0.001) return 1;
    return current / avg;
  }
}

// ─── Sentiment Engine ───

export class SentimentEngine {
  readonly ga: SigmoidGA;
  private priceBuffer: PriceBuffer;
  private volumeBuffer: VolumeBuffer;
  private lastSentiment: SentimentAggregate | null = null;
  private lastFundingRate = 0;
  /** Rolling funding rate history for acceleration computation (last 5 values) */
  private fundingRateHistory: number[] = [];

  constructor() {
    this.ga = new SigmoidGA();
    this.priceBuffer = new PriceBuffer();
    this.volumeBuffer = new VolumeBuffer();
  }

  /** Load GA population from saved data */
  loadGAPopulation(population: Parameters<SigmoidGA['load']>[0]): void {
    this.ga.load(population);
  }

  /** Get GA population for persistence */
  getGAPopulation() {
    return this.ga.getPopulation();
  }

  /** Update price tick data */
  updatePrice(price: number): void {
    this.priceBuffer.push(price);
  }

  /** Update volume data */
  updateVolume(volume: number): void {
    this.volumeBuffer.push(volume);
  }

  /** Update funding rate for funding Δ computation */
  updateFundingRate(rate: number): void {
    this.fundingRateHistory.push(rate);
    if (this.fundingRateHistory.length > 5) this.fundingRateHistory.shift();
    this.lastFundingRate = rate;
  }

  /** Get funding rate acceleration: direction of change (signed, -1..+1).
   *  Positive = funding rising (longs paying more → bearish signal for longs).
   *  Computed as the slope over the last 5 observations. */
  getFundingRateAcceleration(): number {
    if (this.fundingRateHistory.length < 3) return 0;
    const recent = this.fundingRateHistory.slice(-5);
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    const diff = last - first;
    // Normalize: typical funding ranges -0.001..+0.001, multiply to get sensible range
    return Math.max(-1, Math.min(1, diff * 5000));
  }

  /** Get the raw current funding rate (or 0 if never updated) */
  getFundingRate(): number {
    return this.lastFundingRate;
  }

  /** Volume ratio: current 24h volume / rolling average. 1.0 = normal */
  getVolumeRatio(): number {
    return this.volumeBuffer.getVolumeRatio();
  }

  /** Price velocity: Δp/Δt normalized (-1 to +1). Positive = price rising. */
  getPriceVelocity(): number {
    return this.priceBuffer.getVelocity();
  }

  /** Price acceleration: Δ²p/Δt² normalized (-1 to +1). Positive = velocity increasing. */
  getPriceAcceleration(): number {
    return this.priceBuffer.getAcceleration();
  }

  /** Get current sentiment for agent context injection */
  getSentiment(): SentimentAggregate | null {
    return this.lastSentiment;
  }

  /** Run full sentiment computation cycle */
  compute(marketState: {
    price: number;
    volume24h: number;
    orderBookImbalance: number;
    spread: number;
    fearGreedIndex: number;
    volatilityRegime: number;
    fundingRate?: number;
    largeTradeCount?: number;
  }, chromosomeOverride?: GAChromosome): SentimentAggregate {
    // Update buffers
    this.priceBuffer.push(marketState.price);
    this.volumeBuffer.push(marketState.volume24h);

    // Compute funding rate delta BEFORE updating lastFundingRate
    let fundingRateDelta = 0;
    let fundingRateAccel = 0;
    if (marketState.fundingRate !== undefined) {
      const prevFunding = this.lastFundingRate;
      this.fundingRateHistory.push(marketState.fundingRate);
      if (this.fundingRateHistory.length > 5) this.fundingRateHistory.shift();
      this.lastFundingRate = marketState.fundingRate;
      fundingRateDelta = prevFunding !== 0
        ? Math.max(-1, Math.min(1, (marketState.fundingRate - prevFunding) * 1000))
        : 0;
      fundingRateAccel = this.getFundingRateAcceleration();
    }

    // Compute raw inputs
    const inputs: SentimentInputs = {
      orderBookImbalance: marketState.orderBookImbalance,
      volumeAcceleration: this.volumeBuffer.getAcceleration(),
      fundingRateDelta,
      fundingRateAccel,
      spreadPressure: marketState.spread > 0
        ? Math.max(-1, Math.min(1, -Math.log(marketState.spread / 0.001) / 5))
        : 0,
      priceAcceleration: this.priceBuffer.getAcceleration(),
      largeTradeCount: marketState.largeTradeCount ?? 0,
      fearGreedIndex: marketState.fearGreedIndex / 100,
      volatilityRegime: marketState.volatilityRegime,
    };

    // Compute sentiment using best chromosome
    const chromosome = chromosomeOverride ?? this.ga.getBestChromosome();
    this.lastSentiment = computeSentiment(inputs, chromosome);

    return this.lastSentiment;
  }

  /** Format sentiment for agent context injection */
  formatForAgentContext(): string {
    if (!this.lastSentiment) return '=== SIGMOID·GA SENTIMENT ===\n  (no data yet — waiting for market data)';
    return this.ga.formatForAgentContext(this.lastSentiment);
  }

  /** Get the best chromosome description */
  getChromosomeSummary(): string {
    const c = this.ga.getBestChromosome();
    return [
      `Gen ${c.generation} | Fitness: ${(c.fitness * 100).toFixed(1)}%`,
      `  Whale: k=${c.whale.k.toFixed(2)} x0=${c.whale.x0.toFixed(2)} w=${(c.whale.weight * 100).toFixed(0)}%`,
      `  Inst:  k=${c.institutional.k.toFixed(2)} x0=${c.institutional.x0.toFixed(2)} w=${(c.institutional.weight * 100).toFixed(0)}%`,
      `  Micro: k=${c.microstructure.k.toFixed(2)} x0=${c.microstructure.x0.toFixed(2)} w=${(c.microstructure.weight * 100).toFixed(0)}%`,
      `  Mom:   k=${c.momentum.k.toFixed(2)} x0=${c.momentum.x0.toFixed(2)} w=${(c.momentum.weight * 100).toFixed(0)}%`,
      `  F&G:   k=${c.fearGreed.k.toFixed(2)} x0=${c.fearGreed.x0.toFixed(2)} w=${(c.fearGreed.weight * 100).toFixed(0)}%`,
      `  Blend: linear=${(c.linearWeight * 100).toFixed(0)}% product=${(c.productWeight * 100).toFixed(0)}%`,
      `  Conviction threshold: ${(c.convictionThreshold * 100).toFixed(0)}%`,
    ].join('\n');
  }
}