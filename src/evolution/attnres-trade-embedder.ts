// ─── v2.0.215: AttnRes Trade Embedder ──────────────────────────────────────
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
// Cold-start safety:
//   w = 0 (zero-init) → uniform softmax → h = mean(v_i) ≈ current behavior.
//   The system must EARN selectivity through observed trade outcomes.
//
// Backward compatible:
//   When not injected into PatternClusterManager / SimilarTradeRetriever,
//   they use existing combinationSimilarity (exact current behavior).
//   When injected, trades are represented by their blended vector.

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

export interface AttnResEmbedState {
  w: number[];
  emaW: number[];
  updateCount: number;
  embedDim: number;
  temperature: number;
  lr: number;
  lrDecay: number;
  emaAlpha: number;
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
  /** Softmax temperature (lower = sharper). */
  private temperature: number;
  /** Initial learning rate. */
  private lr: number;
  /** LR decay per update (multiplicative). */
  private lrDecay: number;
  /** EMA smoothing factor for w (0-1, lower = smoother). */
  private emaAlpha: number;

  constructor(opts?: {
    embedDim?: number;
    temperature?: number;
    lr?: number;
    lrDecay?: number;
    emaAlpha?: number;
  }) {
    this.embedDim = opts?.embedDim ?? DEFAULT_EMBED_DIM;
    this.temperature = opts?.temperature ?? DEFAULT_TEMPERATURE;
    this.lr = opts?.lr ?? DEFAULT_LR;
    this.lrDecay = opts?.lrDecay ?? DEFAULT_LR_DECAY;
    this.emaAlpha = opts?.emaAlpha ?? DEFAULT_EMA_ALPHA;
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

    // Numerically stable softmax (max-subtraction)
    const α = this.softmax(logits);

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
   * When the trade wins, w shifts toward the blend direction that won.
   * When the trade loses, w shifts away from that direction.
   */
  updateOnOutcome(rationaleVectors: number[][], pnl: number): void {
    // Need 2+ rationales to learn a meaningful blend
    if (rationaleVectors.length < 2) return;

    const keys = rationaleVectors.map((v) => this.rmsNorm(v));
    const logits = keys.map((k) => this.dot(this.w, k) / this.temperature);
    const α = this.softmax(logits);

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
  }

  async save(filePath: string): Promise<void> {
    try {
      const state = JSON.stringify(this.getState());
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, state, 'utf-8');
      log.info(`[attnres-embed] state saved (${this.updateCount} updates, |w|=${this.getWeightNorm().toFixed(4)})`);
    } catch (err) {
      log.warn(`[attnres-embed] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async load(filePath: string): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const state = JSON.parse(raw) as AttnResEmbedState;
      this.loadState(state);
      log.info(`[attnres-embed] state loaded (${this.updateCount} updates, |w|=${this.getWeightNorm().toFixed(4)})`);
    } catch {
      log.info('[attnres-embed] no saved state — cold-start (zero-init w)');
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