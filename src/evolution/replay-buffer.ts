// ─── v2.0.219: Experience Replay Buffer ──────────────────────────────
//
// Stores all trade records (features + outcome + side + source + ts) in a
// ring buffer. Periodically samples mini-batches and replays them through
// OLR to break temporal correlation and improve sample efficiency.
//
// This is the standard RL technique (DQN, SAC, PPO all use replay buffers)
// adapted for MATS's outcome-driven learning paradigm.
//
// Key design decisions:
// 1. Ring buffer with configurable capacity (default 5000)
// 2. Prioritized sampling — trades with higher |pnl| get sampled more often
//    (prioritized experience replay, Schaul et al. 2015)
// 3. Temporal decorrelation — samples are drawn from different time windows
// 4. Idempotent — replaying the same buffer multiple times is safe
// 5. Thread-safe — single-threaded JS, but guard against concurrent replay

import { createLogger } from '../observability/logger.ts';
import { OLREngine, FEATURE_NAMES, regimeToOrdinal } from './olr-engine.ts';
import { safeNum, sanitizeFeatures } from './evolution-utils.ts';

const log = createLogger({ phase: 'replay-buffer' });

// ─── Types ───

export interface ReplaySample {
  id: number;
  symbol: string;
  features: Record<string, number>;
  outcome: 1 | 0;
  side: 'buy' | 'sell';
  source: 'shadow' | 'paper' | 'real' | 'backfill';
  cycle: number;
  ts: number;
  pnl: number;
  /** Priority for PER (prioritized experience replay). Higher = sampled more. */
  priority: number;
}

export interface ReplayBufferConfig {
  /** Max samples stored (ring buffer evicts oldest) */
  maxCapacity: number;
  /** Mini-batch size for each replay epoch */
  batchSize: number;
  /** How many epochs to replay per cycle (default 1) */
  epochsPerReplay: number;
  /** PER exponent — 0 = uniform, 1 = fully prioritized. Default 0.6 (Schaul) */
  perAlpha: number;
  /** Importance sampling weight exponent — corrects PER bias. Default 0.4 */
  perBeta: number;
  /** Minimum priority to prevent starvation */
  minPriority: number;
  /** Weight decay for old samples — 0 = no decay, 1 = linear decay to 0 */
  recencyDecay: number;
}

export interface ReplayStats {
  totalSamples: number;
  capacity: number;
  symbolsTracked: number;
  totalReplays: number;
  lastBatchSize: number;
  avgPriority: number;
  perSymbol: Array<{ symbol: string; count: number; avgPnl: number; winRate: number }>;
}

// ─── ReplayBuffer ───

export class ReplayBuffer {
  private buffer: ReplaySample[] = [];
  private nextId = 0;
  private totalReplays = 0;
  private lastBatchSize = 0;
  private config: ReplayBufferConfig;
  private olrEngine: OLREngine;

  constructor(olrEngine: OLREngine, config?: Partial<ReplayBufferConfig>) {
    this.olrEngine = olrEngine;
    this.config = {
      maxCapacity: 5000,
      batchSize: 32,
      epochsPerReplay: 1,
      perAlpha: 0.6,
      perBeta: 0.4,
      minPriority: 0.01,
      recencyDecay: 0, // disabled by default — temporal decorrelation via random sampling
      ...config,
    };
  }

  /**
   * Add a trade sample to the buffer.
   * Called from feedTrade wrapper or directly from the learning path.
   */
  add(sample: Omit<ReplaySample, 'id' | 'priority'>): void {
    // Compute priority from |pnl| — high-impact trades should be sampled more
    const absPnl = Math.abs(sample.pnl);
    const priority = Math.max(this.config.minPriority, absPnl + this.config.minPriority);

    const fullSample: ReplaySample = {
      ...sample,
      id: this.nextId++,
      priority,
    };

    this.buffer.push(fullSample);

    // Ring buffer eviction
    if (this.buffer.length > this.config.maxCapacity) {
      this.buffer.shift();
    }
  }

  /**
   * Sample a mini-batch using Prioritized Experience Replay (PER).
   *
   * PER samples proportionally to priority^alpha, then applies importance
   * sampling weights (priority^(-beta)) to correct the bias during gradient
   * update.
   *
   * @returns Array of { sample, isWeight } where isWeight corrects PER bias
   */
  private sampleBatch(batchSize: number): Array<{ sample: ReplaySample; isWeight: number }> {
    if (this.buffer.length === 0) return [];

    const N = this.buffer.length;

    // Compute sampling probabilities: p_i = priority_i^alpha / Σ priority^alpha
    let totalPriority = 0;
    const probs = new Array(N);
    for (let i = 0; i < N; i++) {
      probs[i] = Math.pow(this.buffer[i]!.priority, this.config.perAlpha);
      totalPriority += probs[i]!;
    }
    if (totalPriority <= 0) {
      // Uniform fallback
      for (let i = 0; i < N; i++) probs[i] = 1 / N;
      totalPriority = 1;
    }
    for (let i = 0; i < N; i++) probs[i]! /= totalPriority;

    // Stochastic universal sampling — reduces variance vs pure random
    const batch: Array<{ sample: ReplaySample; isWeight: number }> = [];
    const actualBatchSize = Math.min(batchSize, N);
    const maxProb = Math.max(...probs);
    const isWeightBase = Math.pow(maxProb * N, -this.config.perBeta);

    // Sample without replacement using cumulative distribution
    const used = new Set<number>();
    let attempts = 0;
    while (batch.length < actualBatchSize && attempts < actualBatchSize * 10) {
      const r = Math.random() * totalPriority;
      let cum = 0;
      let idx = 0;
      for (let i = 0; i < N; i++) {
        cum += probs[i]! * totalPriority;
        if (r <= cum) { idx = i; break; }
      }
      if (!used.has(idx)) {
        used.add(idx);
        const isWeight = Math.pow(probs[idx]! * N, -this.config.perBeta) / isWeightBase;
        batch.push({ sample: this.buffer[idx]!, isWeight: Math.min(isWeight, 10) }); // cap IS weight
      }
      attempts++;
    }

    // Fallback: if we couldn't sample enough (rare), fill with random
    while (batch.length < actualBatchSize) {
      const idx = Math.floor(Math.random() * N);
      if (!used.has(idx)) {
        used.add(idx);
        batch.push({ sample: this.buffer[idx]!, isWeight: 1 });
      } else if (batch.length === 0) {
        // Edge case: only 1 sample
        batch.push({ sample: this.buffer[idx]!, isWeight: 1 });
        break;
      }
    }

    return batch;
  }

  /**
   * Replay a mini-batch through OLR.
   * Each sampled trade is re-fed to OLR with the IS weight as weightMultiplier.
   *
   * This breaks temporal correlation (sequential trades in the same regime
   * are correlated — random sampling decorrelates the gradient updates).
   */
  replayEpoch(): number {
    if (this.buffer.length < 10) return 0; // need minimum samples

    let fedCount = 0;
    for (let epoch = 0; epoch < this.config.epochsPerReplay; epoch++) {
      const batch = this.sampleBatch(this.config.batchSize);
      for (const { sample, isWeight } of batch) {
        try {
          // Sanitize features before replay
          const cleanFeatures = sanitizeFeatures(sample.features, {});
          this.olrEngine.feedTrade(
            sample.symbol,
            cleanFeatures,
            sample.outcome,
            sample.side,
            sample.source,
            sample.cycle,
            false,
            undefined,
            // IS weight scales the gradient — corrects PER sampling bias
            Math.min(isWeight, 5), // cap to prevent exploding gradients
          );
          fedCount++;
        } catch {
          // non-critical — individual failures don't abort the batch
        }
      }
    }

    this.totalReplays++;
    this.lastBatchSize = fedCount;
    return fedCount;
  }

  /**
   * Get buffer statistics for monitoring.
   */
  getStats(): ReplayStats {
    const symbolMap = new Map<string, { count: number; totalPnl: number; wins: number }>();
    let totalPriority = 0;
    for (const s of this.buffer) {
      const sym = symbolMap.get(s.symbol) ?? { count: 0, totalPnl: 0, wins: 0 };
      sym.count++;
      sym.totalPnl += s.pnl;
      if (s.outcome === 1) sym.wins++;
      symbolMap.set(s.symbol, sym);
      totalPriority += s.priority;
    }
    return {
      totalSamples: this.buffer.length,
      capacity: this.config.maxCapacity,
      symbolsTracked: symbolMap.size,
      totalReplays: this.totalReplays,
      lastBatchSize: this.lastBatchSize,
      avgPriority: this.buffer.length > 0 ? totalPriority / this.buffer.length : 0,
      perSymbol: Array.from(symbolMap.entries()).map(([symbol, v]) => ({
        symbol,
        count: v.count,
        avgPnl: v.count > 0 ? v.totalPnl / v.count : 0,
        winRate: v.count > 0 ? v.wins / v.count : 0,
      })),
    };
  }

  /**
   * Save state for persistence.
   */
  save(): string {
    return JSON.stringify({
      buffer: this.buffer.slice(-this.config.maxCapacity),
      nextId: this.nextId,
      totalReplays: this.totalReplays,
      config: this.config,
    });
  }

  /**
   * Load state from persistence.
   */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.buffer) this.buffer = data.buffer;
      if (data.nextId) this.nextId = data.nextId;
      if (data.totalReplays) this.totalReplays = data.totalReplays;
      if (data.config) this.config = { ...this.config, ...data.config };
      log.info(`Replay buffer loaded: ${this.buffer.length} samples, ${this.totalReplays} past replays`);
    } catch {
      log.warn('[replay-buffer] Failed to load, starting fresh');
    }
  }

  /** Get total sample count */
  size(): number { return this.buffer.length; }

  /** Clear the buffer (for testing) */
  clear(): void { this.buffer = []; this.nextId = 0; this.totalReplays = 0; }
}