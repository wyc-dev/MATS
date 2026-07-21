// ─── v2.0.219: Temporal Attention Layer ─────────────────────────────
//
// Learns regime transitions by attending over the SEQUENCE of recent trade
// outcomes. Unlike AttnRes (which attends within a single trade's rationales),
// this module attends ACROSS trades — learning patterns like:
//   "after 3 losses in low-vol regime, the next trade is likely to fail"
//   "after a win in trending_bull regime, momentum favors continuation"
//
// Architecture:
//   - Input: sequence of recent trade embeddings (features + outcome)
//   - Pseudo-query w (learned, zero-init) attends over the sequence
//   - Output: weighted historical context vector h
//   - Learning: reward-weighted regression (same as AttnRes trade embedder)
//
// This is the K3 AttnRes mechanism applied at the TEMPORAL level (across trades)
// rather than the RATIONALE level (within a trade).
//
// Production-grade:
// - Ring buffer of recent trade records (configurable depth)
// - Zero-init pseudo-query (cold-start safe)
// - Adaptive temperature + label smoothing (anti-collapse, mirrors v2.0.217)
// - Persistence with corrupt-last-good recovery
// - NaN sanitization throughout

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'temporal-attn' });

// ─── Types ───

export interface TemporalTradeRecord {
  symbol: string;
  side: 'buy' | 'sell';
  features: Record<string, number>;
  outcome: 0 | 1;
  pnl: number;
  pnlPct: number;
  ts: number;
  regime: string;
}

export interface TemporalAttentionConfig {
  /** Max sequence length (ring buffer depth) */
  seqLen: number;
  /** Feature dimension (compressed trade representation) */
  featureDim: number;
  /** Learning rate for pseudo-query */
  learningRate: number;
  /** Min temperature (anti-collapse floor) */
  minTemperature: number;
  /** Max temperature (anti-collapse ceiling) */
  maxTemperature: number;
  /** Entropy floor — if H(α) < this, temperature increases */
  entropyFloor: number;
  /** Warmup factor — temperature multiplier when entropy is low */
  warmupFactor: number;
  /** Label smoothing mix — prevents winner-takes-all (0 = disabled) */
  smoothMix: number;
  /** Min history to start blending (cold-start threshold) */
  minHistoryToBlend: number;
}

export interface TemporalAttentionResult {
  /** Blended context vector */
  hBlend: number[];
  /** Attention weights over the sequence */
  attention: number[];
  /** Current temperature */
  temperature: number;
  /** Entropy of attention distribution */
  entropy: number;
  /** Whether blending was applied (false = cold-start, returned current only) */
  applied: boolean;
  /** Number of trades in history */
  historyLen: number;
}

// ─── TemporalAttention ───

export class TemporalAttention {
  private config: TemporalAttentionConfig;
  private history: TemporalTradeRecord[] = [];
  /** Pseudo-query — learned vector that determines which historical trades matter */
  private w: number[];
  /** Adaptive temperature */
  private temperature: number;
  /** Update count */
  private updateCount = 0;
  /** Feature keys we've seen (for vectorization) */
  private featureKeys: string[] = [];
  /** RMSNorm cache */
  private rmsNormEps = 1e-8;

  constructor(config?: Partial<TemporalAttentionConfig>) {
    this.config = {
      seqLen: 50,
      featureDim: 14, // OLR feature count
      learningRate: 0.01,
      minTemperature: 1.0,
      maxTemperature: 10.0,
      entropyFloor: 0.5,
      warmupFactor: 1.5,
      smoothMix: 0.1,
      minHistoryToBlend: 3,
      ...config,
    };
    // Clamp config for safety
    this.config.smoothMix = Math.max(0, Math.min(0.5, this.config.smoothMix));
    this.config.warmupFactor = Math.max(1.0, Math.min(10.0, this.config.warmupFactor));
    this.config.minTemperature = Math.max(0.1, this.config.minTemperature);
    this.config.maxTemperature = Math.max(this.config.minTemperature, this.config.maxTemperature);

    this.w = new Array(this.config.featureDim).fill(0);
    this.temperature = this.config.minTemperature;
  }

  /**
   * Convert a trade record to a fixed-dimension feature vector.
   * Uses the same feature keys as OLR (14 features).
   */
  private toVector(rec: TemporalTradeRecord): number[] {
    const f = rec.features;
    const vec = [
      safeNum(f['volatility'], 0),
      safeNum(f['srDistanceBps'], 0),
      safeNum(f['obImbalance'], 0),
      safeNum(f['fundingRate'], 0),
      safeNum(f['volumeRatio'], 0),
      safeNum(f['sentiment'], 0),
      safeNum(f['sentimentConviction'], 0.5),
      safeNum(f['signalAgreement'], 0.5),
      safeNum(f['mfePct'], 0),
      safeNum(f['maePct'], 0),
      safeNum(f['mfeToPnlRatio'], 0),
      // Encode side: buy=1, sell=-1
      rec.side === 'buy' ? 1 : -1,
      // Encode outcome: win=1, loss=-1
      rec.outcome === 1 ? 1 : -1,
      // PnL percentage (normalized to [-1, 1] range via tanh)
      Math.tanh(safeNum(rec.pnlPct, 0) * 10),
    ];
    // Pad or truncate to featureDim
    while (vec.length < this.config.featureDim) vec.push(0);
    return vec.slice(0, this.config.featureDim);
  }

  /**
   * RMSNorm: normalize vector to unit L2 norm (critical for AttnRes).
   */
  private rmsNorm(v: number[]): number[] {
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm / v.length + this.rmsNormEps);
    return v.map(x => x / norm);
  }

  /**
   * Compute attention weights over the history sequence.
   */
  private computeAttention(vectors: number[][]): { alphaRaw: number[]; alpha: number[]; entropy: number } {
    const N = vectors.length;
    if (N === 0) return { alphaRaw: [], alpha: [], entropy: 0 };

    // Compute logits: w · RMSNorm(v_i) / T
    const logits = new Array(N);
    for (let i = 0; i < N; i++) {
      const vNormed = this.rmsNorm(vectors[i]!);
      let dot = 0;
      for (let j = 0; j < this.config.featureDim; j++) {
        dot += this.w[j]! * vNormed[j]!;
      }
      logits[i] = dot / this.temperature;
    }

    // Softmax with numerical stability
    const maxLogit = Math.max(...logits);
    const expLogits = logits.map(l => Math.exp(l - maxLogit));
    const sumExp = expLogits.reduce((a, b) => a + b, 0);
    const alphaRaw = expLogits.map(e => e / (sumExp || 1));

    // Label smoothing: α_i = α_i * (1 - smoothMix) + smoothMix / N
    const alpha = alphaRaw.map(a => a * (1 - this.config.smoothMix) + this.config.smoothMix / N);

    // Entropy: H(α_raw) = -Σ α_raw * log(α_raw)
    let entropy = 0;
    for (const a of alphaRaw) {
      if (a > 1e-10) entropy -= a * Math.log(a);
    }

    return { alphaRaw, alpha, entropy };
  }

  /**
   * Adaptive temperature: if entropy < floor, increase temperature (sharpen → smooth).
   * Hysteresis: only decrease when entropy > floor * 1.5 (prevents oscillation).
   */
  private adaptTemperature(entropy: number): void {
    if (entropy < this.config.entropyFloor) {
      this.temperature = Math.min(this.config.maxTemperature, this.temperature * this.config.warmupFactor);
    } else if (entropy > this.config.entropyFloor * 1.5) {
      this.temperature = Math.max(this.config.minTemperature, this.temperature / this.config.warmupFactor);
    }
  }

  /**
   * Add a trade to the temporal history.
   */
  addTrade(rec: TemporalTradeRecord): void {
    this.history.push(rec);
    if (this.history.length > this.config.seqLen) {
      this.history.shift();
    }
  }

  /**
   * Retrieve a blended context vector from temporal attention.
   * Cold-start safe: if history < minHistoryToBlend, returns the most recent trade.
   */
  retrieveBlend(): TemporalAttentionResult {
    if (this.history.length < this.config.minHistoryToBlend) {
      const last = this.history[this.history.length - 1];
      const currentVec = last ? this.toVector(last) : new Array(this.config.featureDim).fill(0);
      return {
        hBlend: currentVec,
        attention: [],
        temperature: this.temperature,
        entropy: 0,
        applied: false,
        historyLen: this.history.length,
      };
    }

    const vectors = this.history.map(h => this.toVector(h));
    const { alpha, alphaRaw, entropy } = this.computeAttention(vectors);

    // Blend: h = Σ α_i · v_i (L2-normalized)
    const hBlend = new Array(this.config.featureDim).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      for (let j = 0; j < this.config.featureDim; j++) {
        hBlend[j]! += alpha[i]! * vectors[i]![j]!;
      }
    }

    // Adapt temperature after computing attention
    this.adaptTemperature(entropy);

    return {
      hBlend,
      attention: alpha,
      temperature: this.temperature,
      entropy,
      applied: true,
      historyLen: this.history.length,
    };
  }

  /**
   * Update pseudo-query from trade outcome (reward-weighted regression).
   * w += lr * sign(pnl) * mean_key
   * where mean_key = Σ α_i * RMSNorm(v_i)
   */
  updateOnOutcome(pnl: number): void {
    if (this.history.length < 2) return;

    const vectors = this.history.map(h => this.toVector(h));
    const { alpha } = this.computeAttention(vectors);

    // Compute mean_key: weighted average of normalized vectors
    const meanKey = new Array(this.config.featureDim).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const vNormed = this.rmsNorm(vectors[i]!);
      for (let j = 0; j < this.config.featureDim; j++) {
        meanKey[j]! += alpha[i]! * vNormed[j]!;
      }
    }

    // Reward-weighted regression: w += lr * reward * mean_key
    const reward = Math.sign(pnl);
    if (reward === 0) return;
    const lr = this.config.learningRate;
    for (let j = 0; j < this.config.featureDim; j++) {
      this.w[j]! += lr * reward * meanKey[j]!;
    }

    this.updateCount++;

    // Log periodically
    if (this.updateCount % 20 === 0) {
      const wNorm = Math.sqrt(this.w.reduce((a, b) => a + b * b, 0));
      log.debug(`[temporal-attn] update #${this.updateCount}: |w|=${wNorm.toFixed(4)}, T=${this.temperature.toFixed(2)}`);
    }
  }

  /**
   * Get current state for monitoring.
   */
  getState() {
    return {
      historyLen: this.history.length,
      updateCount: this.updateCount,
      temperature: this.temperature,
      wNorm: Math.sqrt(this.w.reduce((a, b) => a + b * b, 0)),
    };
  }

  /**
   * Save state for persistence.
   */
  save(): string {
    return JSON.stringify({
      history: this.history.slice(-this.config.seqLen),
      w: this.w,
      temperature: this.temperature,
      updateCount: this.updateCount,
      config: this.config,
    });
  }

  /**
   * Load state with corrupt-last-good recovery.
   */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (Array.isArray(data.history)) this.history = data.history.slice(-this.config.seqLen);
      if (Array.isArray(data.w)) {
        // Backward compat: pad/truncate w to current featureDim
        const loaded = data.w as number[];
        this.w = new Array(this.config.featureDim).fill(0);
        for (let i = 0; i < Math.min(loaded.length, this.config.featureDim); i++) {
          if (Number.isFinite(loaded[i])) this.w[i] = loaded[i]!;
        }
      }
      if (Number.isFinite(data.temperature)) this.temperature = Math.max(this.config.minTemperature, Math.min(this.config.maxTemperature, data.temperature));
      if (Number.isFinite(data.updateCount)) this.updateCount = data.updateCount;
      log.info(`Temporal attention loaded: ${this.history.length} trades, ${this.updateCount} updates, T=${this.temperature.toFixed(2)}`);
    } catch {
      log.warn('[temporal-attn] Failed to load, starting fresh');
    }
  }
}