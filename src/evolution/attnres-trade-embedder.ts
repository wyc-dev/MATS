// ─── v2.0.217: AttnRes Trade Embedder — anti-collapse fix ──────────────────
//
// Applies Kimi K3 AttnRes theory (arXiv 2603.15031) to the MiniLM embedding
// pipeline. Instead of accessing MiniLM's internal layers (impossible — the
// ONNX model only outputs last_hidden_state), we apply AttnRes at the
// RATIONALE level: each trade has N rationale vectors (one per rationale point,
// each 384-d from MiniLM). We learn a softmax attention over these vectors,
// producing a single context-aware trade embedding.
//
// K3 analogy:
//   K3 layer-depth       = MATS rationale-index (each rationale ≈ a layer output)
//   K3 fixed residual    = MATS fixed max-matching (all rationales equal weight)
//   K3 AttnRes           = MATS learned blend (which rationales predict outcome)
//   K3 embedding persist = MATS first rationale retains weight (primary thesis)
//
// Learning: reward-weighted key direction (Peters & Schaal 2008), NOT REINFORCE.
//   w += lr · reward · mean_key  where  mean_key = Σ α_i · RMSNorm(v_i)
//   REINFORCE score-function gradient Σα·(key−mean) ≡ 0 for deterministic softmax.
//
// v2.0.217 anti-collapse: triple mechanism prevents mode collapse.
//   1. Adaptive temperature entropy floor (mirrors CycleHistoryRetriever):
//      When H(α) < entropyFloor bits, temperature *= warmupFactor (soften).
//      When H(α) > entropyFloor * 1.5, temperature /= warmupFactor (sharpen).
//      Hysteresis band prevents oscillation. Temperature clamped [1, max].
//   2. Label smoothing (hard floor, belt-and-suspenders):
//      α_i = α_i * (1 - smoothMix) + smoothMix / N
//      Ensures no rationale gets less than smoothMix/N weight. Prevents
//      winner-takes-all even when temperature adaptation can't keep up.
//   3. Config clamping:
//      smoothMix ∈ [0, 0.5], warmupFactor ∈ [1.0, 10.0], temperature ∈ [1, 10].
//
// Cold-start safety:
//   w = 0 (zero-init) → uniform softmax → h = mean(v_i) ≈ current behavior.
//   The system must EARN selectivity through observed trade outcomes.
//   Anti-collapse ensures selectivity is SELECTIVE, not EXCLUSIVE.
//
// Backward compatible:
//   When not injected into PatternClusterManager / SimilarTradeRetriever,
//   they use existing combinationSimilarity (exact current behavior).
//   When injected, trades are represented by their blended vector.
//   Old state files without new fields → defaults applied (safe).

import { rootLogger } from '../observability/logger.ts';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

const log = rootLogger;

const DEFAULT_EMBED_DIM = 384;
const DEFAULT_TEMPERATURE = 1.0;
const DEFAULT_LR = 0.01;
const DEFAULT_LR_DECAY = 0.995;
const DEFAULT_EMA_ALPHA = 0.1;
const MIN_LR = 1e-6;
const MAX_W = 5.0; // weight clipping (K3 does this too)

// ─── v2.0.217 anti-collapse defaults ───
const DEFAULT_ENTROPY_FLOOR = 0.5; // bits — minimum attention entropy
const DEFAULT_WARMUP_FACTOR = 1.5; // temperature multiplier when entropy too low
const DEFAULT_MAX_TEMPERATURE = 10.0; // cap to prevent runaway
const DEFAULT_MIN_TEMPERATURE = 1.0; // floor (never softer than this baseline)
const DEFAULT_SMOOTH_MIX = 0.1; // 10% uniform blend in attention weights
const MIN_SMOOTH_MIX = 0.0;
const MAX_SMOOTH_MIX = 0.5; // never smooth more than 50% (would kill learning)
const MIN_WARMUP_FACTOR = 1.0;
const MAX_WARMUP_FACTOR = 10.0;

export interface AttnResEmbedState {
  w: number[];
  emaW: number[];
  updateCount: number;
  embedDim: number;
  temperature: number;
  lr: number;
  lrDecay: number;
  emaAlpha: number;
  // v2.0.217 fields (optional for backward compat with old state files)
  entropyFloor?: number;
  warmupFactor?: number;
  maxTemperature?: number;
  minTemperature?: number;
  smoothMix?: number;
}

/**
 * AttnRes Trade Embedder — learned softmax attention over rationale vectors.
 *
 * Blends multiple MiniLM rationale embeddings (384-d each) into a single
 * trade representation using a learned pseudo-query w. The blend learns which
 * rationales are most predictive of trade outcome via reward-weighted key
 * direction (outcome-driven, no backprop).
 *
 * K3 design choices applied:
 *   - Zero-init w (uniform start = mean = backward compatible)
 *   - RMSNorm on keys (prevents magnitude domination)
 *   - Softmax (competitive normalization, K3 ablation: > sigmoid)
 *   - Single-head (K3 ablation: multi-head hurts depth mixture)
 *   - EMA smoothing on w (stable inference between updates)
 *   - LR decay (prevents oscillation in late training)
 *   - Weight clipping (prevents unbounded growth)
 *
 * v2.0.217 anti-collapse:
 *   - Adaptive temperature entropy floor (softens softmax when collapsing)
 *   - Label smoothing (hard floor, no rationale gets < smoothMix/N weight)
 *   - Config clamping (prevents misconfiguration from breaking safety)
 */
export class AttnResTradeEmbedder {
  /** Learned pseudo-query — determines which rationale directions matter. */
  private w: number[];
  /** EMA-smoothed w for stable inference (blends are read from emaW, not w). */
  private emaW: number[];
  /** Number of outcome-driven updates applied. */
  private updateCount = 0;
  /** Embedding dimension (384 for MiniLM). */
  readonly embedDim: number;
  /** Softmax temperature (lower = sharper, higher = softer). Adaptive. */
  private temperature: number;
  /** Initial learning rate. */
  private lr: number;
  /** LR decay per update (multiplicative). */
  private lrDecay: number;
  /** EMA smoothing factor for w (0-1, lower = smoother). */
  private emaAlpha: number;
  // ─── v2.0.217 anti-collapse fields ───
  /** Minimum attention entropy in bits. Below this → temperature increases. */
  private entropyFloor: number;
  /** Temperature multiplier when entropy < floor (must be ≥ 1.0). */
  private warmupFactor: number;
  /** Maximum temperature cap (prevents runaway softening). */
  private maxTemperature: number;
  /** Minimum temperature (never go below this baseline, prevents over-sharpening). */
  private minTemperature: number;
  /** Label smoothing factor: α_i = α_i * (1 - smoothMix) + smoothMix / N. */
  private smoothMix: number;

  constructor(opts?: {
    embedDim?: number;
    temperature?: number;
    lr?: number;
    lrDecay?: number;
    emaAlpha?: number;
    entropyFloor?: number;
    warmupFactor?: number;
    maxTemperature?: number;
    minTemperature?: number;
    smoothMix?: number;
  }) {
    this.embedDim = opts?.embedDim ?? DEFAULT_EMBED_DIM;
    this.temperature = opts?.temperature ?? DEFAULT_TEMPERATURE;
    this.lr = opts?.lr ?? DEFAULT_LR;
    this.lrDecay = opts?.lrDecay ?? DEFAULT_LR_DECAY;
    this.emaAlpha = opts?.emaAlpha ?? DEFAULT_EMA_ALPHA;

    // v2.0.217 anti-collapse config with clamping (minTemperature first — maxTemperature depends on it)
    this.minTemperature = Math.max(0.1, opts?.minTemperature ?? DEFAULT_MIN_TEMPERATURE);
    this.maxTemperature = Math.max(this.minTemperature, opts?.maxTemperature ?? DEFAULT_MAX_TEMPERATURE);
    this.entropyFloor = Math.max(0, opts?.entropyFloor ?? DEFAULT_ENTROPY_FLOOR);
    this.warmupFactor = clamp(opts?.warmupFactor ?? DEFAULT_WARMUP_FACTOR, MIN_WARMUP_FACTOR, MAX_WARMUP_FACTOR);
    this.smoothMix = clamp(opts?.smoothMix ?? DEFAULT_SMOOTH_MIX, MIN_SMOOTH_MIX, MAX_SMOOTH_MIX);

    // Ensure temperature starts within [min, max]
    this.temperature = clamp(this.temperature, this.minTemperature, this.maxTemperature);

    this.w = new Array(this.embedDim).fill(0);
    this.emaW = new Array(this.embedDim).fill(0);
  }

  // ─── Public API ───

  /**
   * Blend multiple rationale vectors into a single trade embedding.
   *
   * @param rationaleVectors - N × embedDim vectors from MiniLM (L2-normalised)
   * @returns A single embedDim-d L2-normalised blended vector, or [] if empty.
   *
   * Cold-start (w=0): uniform softmax → mean of vectors ≈ current behavior.
   * Trained: learned softmax weights rationales by predictive value.
   * Anti-collapse: label smoothing ensures no rationale gets < smoothMix/N.
   */
  blend(rationaleVectors: number[][]): number[] {
    const n = rationaleVectors.length;
    if (n === 0) return [];
    if (n === 1) return rationaleVectors[0]!;

    // RMSNorm keys (K3 requirement — prevents magnitude domination)
    const keys = rationaleVectors.map((v) => this.rmsNorm(v));

    // logits = emaW · key / temperature
    // w=0 → all logits = 0 → uniform softmax → mean (backward compatible)
    const logits = keys.map((k) => this.dot(this.emaW, k) / this.temperature);

    // Raw softmax
    const rawAlpha = this.softmax(logits);

    // v2.0.217: label smoothing (hard floor, prevents winner-takes-all)
    const α = this.smoothAttention(rawAlpha, n);

    // Weighted blend
    const h = new Array(this.embedDim).fill(0);
    for (let i = 0; i < n; i++) {
      const weight = α[i]!;
      const vec = rationaleVectors[i]!;
      for (let d = 0; d < this.embedDim; d++) {
        h[d] += weight * vec[d]!;
      }
    }

    return this.l2Normalize(h);
  }

  /**
   * Update the pseudo-query based on a trade outcome.
   * Uses reward-weighted key direction (Peters & Schaal 2008).
   *
   * @param rationaleVectors - The trade's rationale embeddings (from MiniLM)
   * @param pnl - The trade's PnL (positive = win, negative = loss)
   *
   * Learning rule: w += lr · reward · mean_key
   *   where reward = sign(pnl), mean_key = Σ α_i · RMSNorm(v_i)
   *
   * v2.0.217: After computing α, adapt temperature based on entropy.
   * Low entropy → increase temperature (soften). High entropy → decrease.
   * Label smoothing applied to α for both learning and entropy check.
   */
  updateOnOutcome(rationaleVectors: number[][], pnl: number): void {
    // Need 2+ rationales to learn a meaningful blend
    if (rationaleVectors.length < 2) return;

    const n = rationaleVectors.length;
    const keys = rationaleVectors.map((v) => this.rmsNorm(v));
    const logits = keys.map((k) => this.dot(this.w, k) / this.temperature);

    // Raw softmax (for entropy check)
    const rawAlpha = this.softmax(logits);

    // v2.0.217: adapt temperature based on RAW entropy (before smoothing)
    // This ensures temperature responds to the actual attention sharpness,
    // not the artificially raised entropy from smoothing.
    this.adaptTemperature(rawAlpha, n);

    // v2.0.217: label smoothing for learning (same as blend)
    const α = this.smoothAttention(rawAlpha, n);

    // mean_key = Σ α_i · key_i (attention-weighted key direction)
    const meanKey = new Array(this.embedDim).fill(0);
    for (let i = 0; i < keys.length; i++) {
      const weight = α[i]!;
      const key = keys[i]!;
      for (let d = 0; d < this.embedDim; d++) {
        meanKey[d] += weight * key[d]!;
      }
    }

    // Reward-weighted key direction (NOT REINFORCE)
    const reward = pnl > 0 ? 1 : pnl < 0 ? -1 : 0;
    if (reward === 0) return; // neutral outcome → no update

    const lr = Math.max(MIN_LR, this.lr * Math.pow(this.lrDecay, this.updateCount));

    for (let d = 0; d < this.embedDim; d++) {
      this.w[d] = (this.w[d] ?? 0) + lr * reward * (meanKey[d] ?? 0);
      // Weight clipping (K3 does this too — prevents unbounded growth)
      this.w[d] = Math.max(-MAX_W, Math.min(MAX_W, this.w[d] ?? 0));
    }

    // EMA smoothing for stable inference
    for (let d = 0; d < this.embedDim; d++) {
      this.emaW[d] = (1 - this.emaAlpha) * this.emaW[d]! + this.emaAlpha * this.w[d]!;
    }

    this.updateCount++;
  }

  /** Has the pseudo-query been trained at least once? */
  isReady(): boolean {
    return this.updateCount > 0;
  }

  /** Number of outcome-driven updates applied. */
  getUpdateCount(): number {
    return this.updateCount;
  }

  /** Current pseudo-query norm (for diagnostics — 0 at cold-start). */
  getWeightNorm(): number {
    let sum = 0;
    for (const v of this.w) sum += v * v;
    return Math.sqrt(sum);
  }

  /** Current adaptive temperature (for diagnostics). */
  getTemperature(): number {
    return this.temperature;
  }

  // ─── Persistence ───

  getState(): AttnResEmbedState {
    return {
      w: [...this.w],
      emaW: [...this.emaW],
      updateCount: this.updateCount,
      embedDim: this.embedDim,
      temperature: this.temperature,
      lr: this.lr,
      lrDecay: this.lrDecay,
      emaAlpha: this.emaAlpha,
      entropyFloor: this.entropyFloor,
      warmupFactor: this.warmupFactor,
      maxTemperature: this.maxTemperature,
      minTemperature: this.minTemperature,
      smoothMix: this.smoothMix,
    };
  }

  loadState(state: AttnResEmbedState): void {
    if (state.embedDim !== this.embedDim) {
      log.warn(`[attnres-embed] embedDim mismatch: state=${state.embedDim} vs this=${this.embedDim}. Resetting to zero-init.`);
      return; // cold-start safe: ignore incompatible state
    }
    this.w = [...state.w];
    this.emaW = [...state.emaW];
    this.updateCount = state.updateCount;
    this.temperature = state.temperature ?? this.temperature;
    this.lr = state.lr ?? this.lr;
    this.lrDecay = state.lrDecay ?? this.lrDecay;
    this.emaAlpha = state.emaAlpha ?? this.emaAlpha;
    // v2.0.217: load new fields with fallback to current config
    this.entropyFloor = state.entropyFloor ?? this.entropyFloor;
    this.warmupFactor = state.warmupFactor ?? this.warmupFactor;
    this.maxTemperature = state.maxTemperature ?? this.maxTemperature;
    this.minTemperature = state.minTemperature ?? this.minTemperature;
    this.smoothMix = state.smoothMix ?? this.smoothMix;
    // Ensure loaded temperature is within bounds
    this.temperature = clamp(this.temperature, this.minTemperature, this.maxTemperature);
  }

  async save(filePath: string): Promise<void> {
    try {
      const state = JSON.stringify(this.getState());
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, state, 'utf-8');
      log.info(`[attnres-embed] state saved (${this.updateCount} updates, |w|=${this.getWeightNorm().toFixed(4)}, T=${this.temperature.toFixed(2)})`);
    } catch (err) {
      log.warn(`[attnres-embed] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async load(filePath: string): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const state = JSON.parse(raw) as AttnResEmbedState;
      this.loadState(state);
      log.info(`[attnres-embed] state loaded (${this.updateCount} updates, |w|=${this.getWeightNorm().toFixed(4)}, T=${this.temperature.toFixed(2)})`);
    } catch {
      log.info('[attnres-embed] no saved state — cold-start (zero-init w)');
    }
  }

  // ─── v2.0.217 anti-collapse helpers ───

  /**
   * Shannon entropy in bits. Returns 0 for empty/single-element arrays.
   * Guards against NaN/Infinity in input probabilities.
   */
  private entropy(α: number[]): number {
    let h = 0;
    for (const p of α) {
      if (p > 0 && Number.isFinite(p)) {
        h -= p * Math.log2(p);
      }
    }
    // If all entries were non-finite, h stays 0 (will trigger temperature warmup)
    return Number.isFinite(h) ? h : 0;
  }

  /**
   * Label smoothing: blends attention weights toward uniform.
   * α_i = α_i * (1 - smoothMix) + smoothMix / N
   *
   * This ensures no rationale gets less than smoothMix/N weight, preventing
   * winner-takes-all collapse even when adaptive temperature can't keep up.
   *
   * For N=3, smoothMix=0.1: min weight = 0.033 (vs 0.0 without smoothing)
   */
  private smoothAttention(α: number[], n: number): number[] {
    if (n <= 1 || this.smoothMix <= 0) return α;
    const uniform = this.smoothMix / n;
    const keep = 1 - this.smoothMix;
    return α.map((a) => (Number.isFinite(a) ? a * keep + uniform : uniform));
  }

  /**
   * Adaptive temperature: increases when entropy too low, decreases when recovered.
   * Hysteresis band [entropyFloor, entropyFloor * 1.5] prevents oscillation.
   *
   * - H(α) < entropyFloor: temperature *= warmupFactor (soften softmax)
   * - H(α) > entropyFloor * 1.5: temperature /= warmupFactor (allow sharpening)
   * - Temperature clamped to [minTemperature, maxTemperature]
   */
  private adaptTemperature(α: number[], n: number): void {
    if (n <= 1) return;
    const ent = this.entropy(α);

    if (ent < this.entropyFloor) {
      // Entropy too low → soften softmax
      this.temperature = Math.min(this.temperature * this.warmupFactor, this.maxTemperature);
    } else if (ent > this.entropyFloor * 1.5 && this.temperature > this.minTemperature) {
      // Entropy recovered → allow sharpening (but not below min)
      this.temperature = Math.max(this.temperature / this.warmupFactor, this.minTemperature);
    }
  }

  // ─── Internal helpers ───

  /** RMSNorm: x / sqrt(mean(x²) + eps). Zero vector → uniform (well-defined). */
  private rmsNorm(vec: number[]): number[] {
    let sumSq = 0;
    let count = 0;
    for (const v of vec) {
      if (Number.isFinite(v)) {
        sumSq += v * v;
        count++;
      }
    }
    if (count === 0) {
      // All-missing → uniform (neutral contribution)
      return new Array(vec.length).fill(1 / Math.sqrt(vec.length));
    }
    const rms = Math.sqrt(sumSq / count + 1e-8);
    return vec.map((v) => (Number.isFinite(v) ? v / rms : 0));
  }

  /** Dot product (returns 0 for dimension mismatch or all-NaN). */
  private dot(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i]!;
      const bv = b[i]!;
      if (Number.isFinite(av) && Number.isFinite(bv)) {
        sum += av * bv;
      }
    }
    return sum;
  }

  /** Numerically stable softmax (max-subtraction). Returns uniform for degenerate. */
  private softmax(logits: number[]): number[] {
    const n = logits.length;
    if (n === 0) return [];
    if (n === 1) return [1];

    // Find max (skip non-finite)
    let max = -Infinity;
    for (const l of logits) {
      if (Number.isFinite(l) && l > max) max = l;
    }
    if (!Number.isFinite(max)) max = 0;

    // Compute exps
    let sumExp = 0;
    const exps = logits.map((l) => {
      if (!Number.isFinite(l)) return 0;
      const e = Math.exp(l - max);
      sumExp += e;
      return e;
    });

    if (sumExp <= 0 || !Number.isFinite(sumExp)) {
      // Degenerate: uniform fallback
      return new Array(n).fill(1 / n);
    }

    return exps.map((e) => e / sumExp);
  }

  /** L2-normalize a vector. Zero vector → uniform (well-defined cosine). */
  private l2Normalize(vec: number[]): number[] {
    let norm = 0;
    for (const v of vec) {
      if (Number.isFinite(v)) norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm < 1e-12) {
      // Zero vector → uniform (neutral, well-defined cosine)
      return new Array(vec.length).fill(1 / Math.sqrt(vec.length));
    }
    return vec.map((v) => (Number.isFinite(v) ? v / norm : 0));
  }
}

// ─── Utility ───

/** Clamp a value to [min, max]. Handles NaN (returns min). */
function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}