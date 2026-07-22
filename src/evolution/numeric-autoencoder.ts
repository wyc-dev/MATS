// ─── Numeric Autoencoder + Contrastive Embedding (NA, v2.0.204) ───
//
// In-process numeric embedding model for MATS market-condition features.
// Learns a non-linear 8-d representation of the 9 entry-condition features
// (volatility, srDistanceBps, obImbalance, fundingRate, volumeRatio,
// signalAgreement, sentiment, sentimentConviction, regimeOrdinal) so that
// "similar market conditions" = "conditions that historically led to similar
// trade outcomes", not just "conditions with similar raw numbers".
//
// Architecture:
//   Encoder: 9 → hidden(16, leaky ReLU) → 8 (linear, L2-normalised)
//   Decoder: 8 → hidden(16, leaky ReLU) → 9 (linear, reconstruction)
//   Loss:    α·MSE_recon + β·L_contrastive + γ·L2_reg + δ·L_diversity
//   Optim:   Adam (pure TS) + gradient clip + weight clip + LR decay
//
// Why NOT MiniLM: MiniLM is a text embedding model (input = string). Market
// features are numeric. A text model cannot embed numbers. This module is a
// purpose-built numeric autoencoder trained on MATS's own trade history.
//
// Why NOT replace v2.0.203 min-max: min-max + cosine is the cold-start
// fallback. The autoencoder only takes over once it has ≥200 samples AND
// passes validation (reconstruction MSE < 0.1, contrastive acc > 60%).
// Both paths coexist in `computeVectorConditionalWinRate` via the
// `embeddingProvider` option.
//
// Safety design (see NA.md §3):
//   - NaN/Infinity guard on every weight update → auto-reset to last good.
//   - Weight clip |w| ≤ 10, gradient clip ‖g‖ ≤ 5.
//   - Leaky ReLU (0.01) to avoid dead neurons.
//   - He initialisation for ReLU layers.
//   - Seeded RNG (mulberry32) for determinism across restarts.
//   - Replay buffer (last N samples) to prevent catastrophic forgetting.
//   - Embedding diversity penalty to prevent degenerate (all-same) vectors.
//   - Input z-score normalisation via running mean/std (Welford), per-feature.
//   - Missing-feature masking: reconstruction loss only on present dims;
//     embedding computed on present dims only, zero-filled absent dims
//     before the final dense layer (so absent dims contribute nothing).
//
// Persistence: `data/evolution/na-model.json`, atomic write, versioned.

import { createLogger } from '../observability/logger.ts';
import { writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const log = createLogger({ phase: 'na' });

// ─── Config ───

export interface NAConfig {
  enabled: boolean;
  inputDim: number;
  embedDim: number;
  hiddenDim: number;
  learningRate: number;
  minSamplesTrain: number;
  minSamplesReady: number;
  trainEveryCycles: number;
  validationMseMax: number;
  validationContrastiveAccMin: number;
  reconLossWeight: number;
  contrastiveLossWeight: number;
  l2Reg: number;
  diversityLossWeight: number;
  modelPath: string;
  /** Max samples kept in the replay buffer (catastrophic-forgetting defence). */
  replayBufferSize: number;
  /** V12: half-life for time-weighted training sampling (ms). Recent samples
   *  are sampled with exponentially higher probability, so the model adapts
   *  to feature drift instead of being anchored by stale market regimes.
   *  Default 30 days. weight = 0.5^(age / halfLife). */
  replayHalfLifeMs: number;
  /** Batch size for training. */
  batchSize: number;
  /** Training epochs per trainBatch() call. */
  epochsPerTrain: number;
}

export const DEFAULT_NA_CONFIG: NAConfig = {
  enabled: true,
  inputDim: 9,
  embedDim: 8,
  hiddenDim: 16,
  learningRate: 0.001,
  minSamplesTrain: 50,
  minSamplesReady: 200,
  trainEveryCycles: 5,
  validationMseMax: 0.1,
  validationContrastiveAccMin: 0.6,
  reconLossWeight: 1.0,
  contrastiveLossWeight: 0.5,
  l2Reg: 0.01,
  diversityLossWeight: 0.01,
  modelPath: 'data/evolution/na-model.json',
  replayBufferSize: 1000,
  replayHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
  batchSize: 32,
  epochsPerTrain: 5,
};

// ─── Types ───

/** A training sample: input features + binary outcome label. */
export interface NATrainingSample {
  features: Record<string, number>;
  outcome: 1 | 0;
  /** Feature names that are present (non-missing). */
  presentFeatures: string[];
  /** Timestamp (ms) for time-weighting + replay ordering. */
  ts: number;
}

/** Validation result returned by validate(). */
export interface NAValidationResult {
  mse: number;
  contrastiveAcc: number;
  diversity: number;
  passed: boolean;
  reason: string;
}

/** Internal forward-pass record used during training (reconstruction +
 *  contrastive + diversity). Shared across trainStep + helpers so the
 *  typed structure propagates instead of falling back to index signatures. */
interface NAForward {
  sample: NATrainingSample;
  x: number[];
  embedding: number[];
  reconstruction: number[];
  reconTarget: number[];
  reconGradToZ: number[];
}

/** Public provider interface — mirrors the text EmbedProvider pattern so
 *  consumers (computeVectorConditionalWinRate) can depend on an abstraction,
 *  and tests can inject a mock. */
export interface NumericEmbedProvider {
  readonly name: string;
  readonly inputDim: number;
  readonly embedDim: number;
  /** True once the model has enough samples AND validation has passed. */
  isReady(): boolean;
  /** Warmup is a no-op for this in-process model; exists for API parity. */
  warmup(): Promise<void>;
  /** Embed a batch of feature records → one L2-normalised vector each.
   *  Missing features are treated as the running mean (neutral z=0). */
  embed(features: Record<string, number>[]): number[][];
  /** Total training samples seen (including replay buffer). */
  sampleCount(): number;
  /** Latest validation result (null if never validated). */
  lastValidation(): NAValidationResult | null;
}

// ─── Deterministic RNG (mulberry32) ───
// Seeded so that model initialisation + pair sampling are reproducible
// across restarts (determinism for debugging — V10).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Matrix helpers (pure JS, row-major) ───

function zeros(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

function zeros1d(n: number): number[] {
  return new Array<number>(n).fill(0);
}

/** He initialisation for ReLU/leaky-ReLU layers (V9: avoids dead neurons). */
function heInit(rows: number, cols: number, rng: () => number): number[][] {
  const scale = Math.sqrt(2 / cols);
  const m = zeros(rows, cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      // Box-Muller for a normal sample, scaled by He factor.
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      m[i]![j] = z * scale;
    }
  }
  return m;
}

function leakyRelu(x: number): number {
  return x > 0 ? x : 0.01 * x;
}

function leakyReluGrad(x: number): number {
  return x > 0 ? 1 : 0.01;
}

function l2Normalise(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n < 1e-12) {
    // Zero vector → uniform normalised (preserves unit norm so downstream cosine
    // is well-defined during cold-start, before weights are trained).
    const u = 1 / Math.sqrt(v.length);
    return v.map(() => u);
  }
  return v.map((x) => x / n);
}

// ─── Layer ───

interface Layer {
  weights: number[][]; // [out][in]
  biases: number[]; // [out]
  // Adam moments
  mW: number[][];
  vW: number[][];
  mB: number[];
  vB: number[];
  // last forward cache (for backprop)
  lastInput: number[]; // [in]
  lastZ: number[]; // [out] pre-activation
  lastA: number[]; // [out] post-activation
  activation: 'leakyRelu' | 'linear';
}

function makeLayer(inDim: number, outDim: number, activation: 'leakyRelu' | 'linear', rng: () => number): Layer {
  const weights = activation === 'linear'
    ? zeros(outDim, inDim) // linear layers start at 0 (stable) — small init alt
    : heInit(outDim, inDim, rng);
  return {
    weights,
    biases: zeros1d(outDim),
    mW: zeros(outDim, inDim),
    vW: zeros(outDim, inDim),
    mB: zeros1d(outDim),
    vB: zeros1d(outDim),
    lastInput: zeros1d(inDim),
    lastZ: zeros1d(outDim),
    lastA: zeros1d(outDim),
    activation,
  };
}

function forwardLayer(l: Layer, x: number[]): number[] {
  l.lastInput = x.slice();
  const out = zeros1d(l.biases.length);
  for (let i = 0; i < l.biases.length; i++) {
    let z = l.biases[i]!;
    const w = l.weights[i]!;
    for (let j = 0; j < w.length; j++) z += w[j]! * x[j]!;
    l.lastZ[i] = z;
    out[i] = l.activation === 'leakyRelu' ? leakyRelu(z) : z;
    l.lastA[i] = out[i]!;
  }
  return out;
}

// ─── Model snapshot (persisted) ───

interface NAModelState {
  version: number;
  inputDim: number;
  embedDim: number;
  hiddenDim: number;
  encoderL1: Layer;
  encoderL2: Layer;
  decoderL1: Layer;
  decoderL2: Layer;
  // Input normalisation running stats (Welford per-feature)
  inputMean: number[];
  inputM2: number[];
  inputCount: number[];
  sampleCount: number;
  trainStep: number;
  seed: number;
  validation: NAValidationResult | null;
  featureNames: string[];
  // v2.0.222: Persist replay buffer so validation survives restart.
  // Previously replay was in-memory only → wiped on restart → validate()
  // always failed ("insufficient samples") until 200+ new trades accumulated.
  replay?: NATrainingSample[];
}

const NA_MODEL_VERSION = 1;

// ─── NumericAutoencoder ───

export class NumericAutoencoder implements NumericEmbedProvider {
  readonly name = 'numeric-autoencoder';
  readonly inputDim: number;
  readonly embedDim: number;

  private cfg: NAConfig;
  private encoderL1: Layer;
  private encoderL2: Layer;
  private decoderL1: Layer;
  private decoderL2: Layer;
  private inputMean: number[];
  private inputM2: number[];
  private inputCount: number[];
  private _sampleCount = 0;
  private trainStep = 0;
  private seed: number;
  private rng: () => number;
  private validation: NAValidationResult | null = null;
  private featureNames: string[];
  private replay: NATrainingSample[] = [];
  private lastGoodWeights: NAModelState | null = null;
  private dirty = false;

  constructor(cfg: Partial<NAConfig> = {}, featureNames: readonly string[] = []) {
    this.cfg = { ...DEFAULT_NA_CONFIG, ...cfg };
    this.inputDim = this.cfg.inputDim;
    this.embedDim = this.cfg.embedDim;
    this.featureNames = [...featureNames];
    this.seed = 0x5eed1234;
    this.rng = mulberry32(this.seed);
    this.inputMean = zeros1d(this.cfg.inputDim);
    this.inputM2 = zeros1d(this.cfg.inputDim);
    this.inputCount = zeros1d(this.cfg.inputDim);
    this.encoderL1 = makeLayer(this.cfg.inputDim, this.cfg.hiddenDim, 'leakyRelu', this.rng);
    this.encoderL2 = makeLayer(this.cfg.hiddenDim, this.cfg.embedDim, 'linear', this.rng);
    this.decoderL1 = makeLayer(this.cfg.embedDim, this.cfg.hiddenDim, 'leakyRelu', this.rng);
    this.decoderL2 = makeLayer(this.cfg.hiddenDim, this.cfg.inputDim, 'linear', this.rng);
  }

  // ─── Lifecycle ───

  load(path?: string): void {
    const p = path ?? this.cfg.modelPath;
    try {
      if (!existsSync(p)) {
        log.info(`[NA] No model file at ${p} — starting fresh`);
        return;
      }
      const data = readFileSync(p, 'utf-8');
      const parsed = JSON.parse(data) as NAModelState;
      this.migrate(parsed);
      log.info(`[NA] Loaded model v${parsed.version}: ${parsed.sampleCount} samples, step=${parsed.trainStep}, validation=${parsed.validation?.passed ? 'PASS' : 'FAIL/none'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[NA] load failed (${msg}) — starting fresh`);
    }
  }

  persist(path?: string): void {
    if (!this.dirty) return;
    const p = path ?? this.cfg.modelPath;
    try {
      const state = this.snapshotState();
      const tmp = p + '.tmp';
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
      renameSync(tmp, p);
      this.dirty = false;
      this.lastGoodWeights = state; // save last good for NaN recovery (V1)
      log.info(`[NA] Persisted model: ${this._sampleCount} samples, step=${this.trainStep}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[NA] persist failed: ${msg}`);
    }
  }

  private migrate(parsed: NAModelState): void {
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid state');
    // Version migration: currently only v1 exists. Future versions branch here.
    if (parsed.version > NA_MODEL_VERSION) {
      log.warn(`[NA] model version ${parsed.version} > supported ${NA_MODEL_VERSION} — loading anyway (forward-compat)`);
    }
    // v2.0.207 (#D): Feature-dimension guard — if the persisted model was
    // trained with a different inputDim (e.g. 9 → 11 after adding momentum
    // features), the encoder weights are incompatible. Reset to fresh instead
    // of crashing on forward pass. Cold-start fallback (min-max) covers the
    // gap until enough new samples retrain the model.
    if (parsed.inputDim && parsed.inputDim !== this.inputDim) {
      log.warn(`[NA] inputDim mismatch (persisted=${parsed.inputDim}, current=${this.inputDim}) — resetting to fresh (feature set changed)`);
      throw new Error(`inputDim mismatch ${parsed.inputDim}→${this.inputDim}`);
    }
    this.encoderL1 = parsed.encoderL1;
    this.encoderL2 = parsed.encoderL2;
    this.decoderL1 = parsed.decoderL1;
    this.decoderL2 = parsed.decoderL2;
    this.inputMean = parsed.inputMean ?? zeros1d(this.inputDim);
    this.inputM2 = parsed.inputM2 ?? zeros1d(this.inputDim);
    this.inputCount = parsed.inputCount ?? zeros1d(this.inputDim);
    this._sampleCount = parsed.sampleCount ?? 0;
    this.trainStep = parsed.trainStep ?? 0;
    this.seed = parsed.seed ?? 0x5eed1234;
    this.validation = parsed.validation ?? null;
    this.featureNames = parsed.featureNames ?? [];
    this.rng = mulberry32(this.seed ^ (this.trainStep + 1)); // advance RNG past init
    // NaN guard on load (V1): a poisoned state file would resurrect NaN weights.
    this.sanitiseWeights();
    // v2.0.222: Restore replay buffer from persisted state.
    // Edge cases handled:
    //   - Missing replay (old state files) → replay = [], cold-start fallback
    //   - Corrupt entries (non-object, missing features) → skipped
    //   - NaN/Infinity in feature values → sanitized to 0
    //   - Replay larger than buffer size → truncated to most recent
    //   - Entries with mismatched feature names → accepted (featuresToVector maps by name)
    //   - ts=0 (cold-start samples) → accepted
    this.replay = this.restoreReplay(parsed.replay);
    // v2.0.222: Re-validate immediately if we have enough restored samples.
    // This avoids the stale "insufficient samples" validation result after restart.
    if (this.replay.length >= this.cfg.minSamplesReady) {
      log.info(`[NA] Re-validating with ${this.replay.length} restored replay samples...`);
      this.validate();
    } else if (this.replay.length > 0) {
      log.info(`[NA] Restored ${this.replay.length} replay samples (need ${this.cfg.minSamplesReady} for validation)`);
    }
  }

  /** v2.0.222: Restore replay buffer from persisted state with full edge-case handling. */
  private restoreReplay(raw: NATrainingSample[] | undefined): NATrainingSample[] {
    if (!Array.isArray(raw)) return [];
    const valid: NATrainingSample[] = [];
    let skipped = 0;
    for (const s of raw) {
      // Skip non-object entries
      if (!s || typeof s !== 'object') { skipped++; continue; }
      // Skip entries without features object
      if (!s.features || typeof s.features !== 'object') { skipped++; continue; }
      // Sanitize feature values: NaN/Infinity → 0 (prevent poisoning)
      const cleanFeatures: Record<string, number> = {};
      for (const [k, v] of Object.entries(s.features)) {
        const num = Number(v);
        cleanFeatures[k] = Number.isFinite(num) ? num : 0;
      }
      // Ensure presentFeatures is an array
      const presentFeatures = Array.isArray(s.presentFeatures) ? s.presentFeatures.filter((f: any) => typeof f === 'string') : [];
      // Ensure outcome is 0 or 1
      const outcome: 1 | 0 = s.outcome === 1 ? 1 : 0;
      // Ensure ts is a finite number (0 is acceptable for cold-start samples)
      const ts = Number.isFinite(s.ts) ? s.ts : 0;
      valid.push({ features: cleanFeatures, outcome, presentFeatures, ts });
    }
    if (skipped > 0) {
      log.warn(`[NA] Skipped ${skipped} corrupt replay entries during restore`);
    }
    // Truncate to buffer size (keep most recent — assumes raw is ordered by ts ascending)
    return valid.slice(-this.cfg.replayBufferSize);
  }

  private snapshotState(): NAModelState {
    return {
      version: NA_MODEL_VERSION,
      inputDim: this.inputDim,
      embedDim: this.embedDim,
      hiddenDim: this.cfg.hiddenDim,
      encoderL1: this.encoderL1,
      encoderL2: this.encoderL2,
      decoderL1: this.decoderL1,
      decoderL2: this.decoderL2,
      inputMean: this.inputMean,
      inputM2: this.inputM2,
      inputCount: this.inputCount,
      sampleCount: this._sampleCount,
      trainStep: this.trainStep,
      seed: this.seed,
      validation: this.validation,
      featureNames: this.featureNames,
      // v2.0.222: Persist replay buffer so validation survives restart.
      replay: this.replay.slice(-this.cfg.replayBufferSize),
    };
  }

  /** V1: reset any non-finite weight/bias to 0. Called after load + after every
   *  weight update. If NaNs appeared, restore last good weights if available. */
  private sanitiseWeights(): boolean {
    let poisoned = false;
    const checkLayer = (l: Layer) => {
      for (let i = 0; i < l.weights.length; i++) {
        for (let j = 0; j < l.weights[i]!.length; j++) {
          if (!Number.isFinite(l.weights[i]![j]!)) { l.weights[i]![j] = 0; poisoned = true; }
        }
        if (!Number.isFinite(l.biases[i]!)) { l.biases[i] = 0; poisoned = true; }
      }
    };
    checkLayer(this.encoderL1);
    checkLayer(this.encoderL2);
    checkLayer(this.decoderL1);
    checkLayer(this.decoderL2);
    if (poisoned) {
      log.warn(`[NA] NaN/Infinity detected in weights — sanitised to 0`);
      if (this.lastGoodWeights) {
        log.info(`[NA] Restoring last good weights (step=${this.lastGoodWeights.trainStep})`);
        this.migrate(this.lastGoodWeights);
      }
    }
    return !poisoned;
  }

  // ─── Forward pass ───

  /** Encode features → 8-d L2-normalised embedding.
   *  Missing features use the running mean (neutral z=0 contribution). */
  encode(features: Record<string, number>): number[] {
    const x = this.featuresToVector(features);
    const xNorm = this.normaliseInput(x);
    const h1 = forwardLayer(this.encoderL1, xNorm);
    const z = forwardLayer(this.encoderL2, h1);
    return l2Normalise(z);
  }

  /** Full forward (encode + decode) for reconstruction loss. Returns embedding
   *  AND reconstruction (in normalised space). */
  private forwardFull(x: number[]): { embedding: number[]; reconstruction: number[] } {
    const h1 = forwardLayer(this.encoderL1, x);
    const z = forwardLayer(this.encoderL2, h1);
    const h2 = forwardLayer(this.decoderL1, z);
    const recon = forwardLayer(this.decoderL2, h2);
    return { embedding: z, reconstruction: recon };
  }

  embed(features: Record<string, number>[]): number[][] {
    return features.map((f) => this.encode(f));
  }

  // ─── Input normalisation (Welford, per-feature, present-only) ───

  private featuresToVector(features: Record<string, number>): number[] {
    const v = zeros1d(this.inputDim);
    for (let i = 0; i < this.featureNames.length && i < this.inputDim; i++) {
      const val = features[this.featureNames[i]!];
      v[i] = val !== undefined && val !== null && Number.isFinite(val) ? val : this.inputMean[i]!;
    }
    return v;
  }

  private normaliseInput(x: number[]): number[] {
    const out = zeros1d(this.inputDim);
    for (let i = 0; i < this.inputDim; i++) {
      const n = this.inputCount[i]!;
      if (n < 2) { out[i] = 0; continue; }
      const variance = this.inputM2[i]! / (n - 1);
      const std = Math.sqrt(Math.max(variance, 1e-8));
      out[i] = (x[i]! - this.inputMean[i]!) / std;
    }
    return out;
  }

  /** Update running input stats with a new sample (Welford, per-feature, present-only).
   *  V5: only present features update their own stats — missing features keep
   *  count=0 and stay neutral, so the first live value does not explode. */
  private updateInputStats(features: Record<string, number>, presentFeatures: string[]): void {
    const presentSet = new Set(presentFeatures);
    for (let i = 0; i < this.featureNames.length && i < this.inputDim; i++) {
      const name = this.featureNames[i]!;
      if (!presentSet.has(name)) continue;
      const val = features[name];
      if (val === undefined || val === null || !Number.isFinite(val)) continue;
      const n = this.inputCount[i]! + 1;
      this.inputCount[i] = n;
      const delta = val - this.inputMean[i]!;
      this.inputMean[i]! += delta / n;
      this.inputM2[i]! += delta * (val - this.inputMean[i]!);
    }
  }

  // ─── Training ───

  /** Add a sample to the replay buffer + update input stats. Safe to call
   *  every cycle for every closed trade. */
  addSample(sample: NATrainingSample): void {
    this.replay.push(sample);
    if (this.replay.length > this.cfg.replayBufferSize) {
      this.replay.splice(0, this.replay.length - this.cfg.replayBufferSize);
    }
    this.updateInputStats(sample.features, sample.presentFeatures);
    this._sampleCount++;
    this.dirty = true;
  }

  /** Train one batch. Returns the average total loss. No-op if too few samples. */
  trainBatch(): number {
    if (this.replay.length < this.cfg.minSamplesTrain) return 0;
    let totalLoss = 0;
    for (let epoch = 0; epoch < this.cfg.epochsPerTrain; epoch++) {
      // Sample a random batch from the replay buffer (V8: replay prevents
      // catastrophic forgetting by mixing recent + older samples).
      const batch = this.sampleBatch(this.cfg.batchSize);
      totalLoss += this.trainStepRun(batch);
    }
    this.sanitiseWeights(); // V1: post-update NaN guard
    this.dirty = true;
    return totalLoss / this.cfg.epochsPerTrain;
  }

  /** Sample up to `n` random samples from the replay buffer. */
  /** V12: time-weighted sampling. Recent samples get exponentially higher
   *  selection probability (weight = 0.5^(age/halfLife)), so the model adapts
   *  to feature drift instead of being anchored by stale market regimes.
   *  Without-replacement via the `used` set (same as before). */
  private sampleBatch(n: number): NATrainingSample[] {
    const n2 = Math.min(n, this.replay.length);
    const out: NATrainingSample[] = [];
    const used = new Set<number>();
    const now = Date.now();
    const halfLife = this.cfg.replayHalfLifeMs;
    // Precompute weights + total for weighted selection.
    const weights = this.replay.map((s) => Math.pow(0.5, (now - s.ts) / halfLife));
    let totalWeight = 0;
    for (const w of weights) totalWeight += w;
    if (totalWeight <= 0) {
      // Degenerate (all weights 0 / overflow) → uniform fallback.
      while (out.length < n2 && used.size < this.replay.length) {
        const idx = Math.floor(this.rng() * this.replay.length);
        if (used.has(idx)) continue;
        used.add(idx);
        out.push(this.replay[idx]!);
      }
      return out;
    }
    while (out.length < n2 && used.size < this.replay.length) {
      // Weighted pick: draw r ∈ [0, totalWeight), walk cumulative sum.
      let r = this.rng() * totalWeight;
      let picked = -1;
      for (let i = 0; i < this.replay.length; i++) {
        if (used.has(i)) continue;
        r -= weights[i]!;
        if (r <= 0) { picked = i; break; }
      }
      if (picked < 0) {
        // Fallback (floating-point edge): pick first unused.
        for (let i = 0; i < this.replay.length; i++) { if (!used.has(i)) { picked = i; break; } }
      }
      if (picked < 0) break;
      used.add(picked);
      out.push(this.replay[picked]!);
      // Without-replacement: subtract picked weight from total.
      totalWeight -= weights[picked]!;
    }
    return out;
  }

  /** Run one training step on a batch: forward, compute losses, backprop, Adam update. */
  private trainStepRun(batch: NATrainingSample[]): number {
    let totalLoss = 0;
    const allGrads: Array<{ layer: Layer; gradW: number[][]; gradB: number[] }> = [];
    let pairCount = 0;
    let pairCorrect = 0;

    // Forward all samples + cache embeddings for contrastive pairs.
    const forwards: NAForward[] = batch.map((s) => {
      const x = this.featuresToVector(s.features);
      const xNorm = this.normaliseInput(x);
      const { embedding, reconstruction } = this.forwardFull(xNorm);
      return { sample: s, x: xNorm, embedding: l2Normalise(embedding), reconstruction, reconTarget: xNorm, reconGradToZ: zeros1d(this.embedDim) };
    });

    // ── Reconstruction loss (per present feature) + accumulate grads ──
    for (const f of forwards) {
      const reconErr = this.reconstructionLossGrad(f.reconstruction, f.reconTarget, f.sample.presentFeatures);
      totalLoss += this.cfg.reconLossWeight * reconErr.loss;
      this.accumulateGrad(allGrads, this.decoderL2, reconErr.gradW, reconErr.gradB);
      // Backprop reconstruction error through decoder → encoder (chain rule).
      const dReconToEmbedding = this.backpropDecoder(f.reconstruction, f.reconTarget, f.sample.presentFeatures, allGrads);
      // dReconToEmbedding is grad w.r.t. the embedding (pre-L2-norm) from recon.
      // We'll add contrastive grads to it below.
      f.reconGradToZ = dReconToEmbedding;
    }

    // ── Contrastive loss + grads ──
    // Build pairs: same-outcome (positive) + diff-outcome (negative).
    const { loss: cLoss, grads: cGrads, correct, count } = this.contrastiveLossAndGrad(forwards);
    totalLoss += this.cfg.contrastiveLossWeight * cLoss;
    pairCount = count;
    pairCorrect = correct;
    // Add contrastive grads (w.r.t. each embedding) to the recon grads.
    for (let i = 0; i < forwards.length; i++) {
      const reconG = forwards[i]!.reconGradToZ;
      const conG = cGrads[i] ?? zeros1d(this.embedDim);
      const combined = reconG.map((g, j) => g + this.cfg.contrastiveLossWeight * conG[j]!);
      this.backpropEncoder(combined, forwards[i]!.x, allGrads);
    }

    // ── Diversity penalty (V13): prevent all embeddings collapsing to one point ──
    const divLoss = this.diversityLoss(forwards);
    totalLoss += this.cfg.diversityLossWeight * divLoss.loss;
    for (let i = 0; i < forwards.length; i++) {
      this.backpropEncoder(divLoss.grads[i]!, forwards[i]!.x, allGrads);
    }

    // ── Apply Adam update with L2 reg + gradient clip ──
    this.applyAdamUpdate(allGrads);

    this.trainStep++;
    const acc = pairCount > 0 ? pairCorrect / pairCount : 0;
    log.debug(`[NA] train step ${this.trainStep}: loss=${totalLoss.toFixed(4)}, contrastive acc=${(acc * 100).toFixed(0)}%, pairs=${pairCount}`);
    return totalLoss;
  }

  // ─── Loss + gradient helpers ───

  /** Reconstruction MSE + gradient (only on present features — V5). */
  private reconstructionLossGrad(recon: number[], target: number[], present: string[]): { loss: number; gradW: number[][]; gradB: number[] } {
    const presentSet = new Set(present);
    const outDim = this.decoderL2.biases.length;
    const gradB = zeros1d(outDim);
    const gradW = zeros(outDim, this.decoderL2.weights[0]!.length);
    let loss = 0;
    let count = 0;
    for (let i = 0; i < outDim; i++) {
      const name = this.featureNames[i]!;
      if (!presentSet.has(name)) continue; // V5: skip missing-feature dims
      const err = recon[i]! - target[i]!;
      loss += err * err;
      count++;
      // dL/drecon[i] = 2 * err
      const d = 2 * err;
      gradB[i] = d;
      const w = this.decoderL2.weights[i]!;
      const inDim = w.length;
      for (let j = 0; j < inDim; j++) gradW[i]![j] = d * this.decoderL2.lastInput[j]!;
    }
    return { loss: count > 0 ? loss / count : 0, gradW, gradB };
  }

  /** Backprop reconstruction error through decoder, returning gradient w.r.t.
   *  the embedding (pre-L2-norm). Accumulates decoder L1/L2 grads. */
  private backpropDecoder(recon: number[], target: number[], present: string[], allGrads: Array<{ layer: Layer; gradW: number[][]; gradB: number[] }>): number[] {
    const presentSet = new Set(present);
    const outDim = this.decoderL2.biases.length;
    // dL/drecon (only present dims)
    const dRecon = zeros1d(outDim);
    for (let i = 0; i < outDim; i++) {
      if (!presentSet.has(this.featureNames[i]!)) continue;
      dRecon[i] = 2 * (recon[i]! - target[i]!);
    }
    // Backprop decoderL2 (linear): dL/d(decL2 input) = W^T · dRecon
    const dDecL2In = zeros1d(this.decoderL2.weights[0]!.length);
    const gradB_L2 = zeros1d(outDim);
    const gradW_L2 = zeros(outDim, this.decoderL2.weights[0]!.length);
    for (let i = 0; i < outDim; i++) {
      const d = dRecon[i]!;
      gradB_L2[i] = d;
      const w = this.decoderL2.weights[i]!;
      for (let j = 0; j < w.length; j++) {
        gradW_L2[i]![j] = d * this.decoderL2.lastInput[j]!;
        dDecL2In[j]! += w[j]! * d;
      }
    }
    this.accumulateGrad(allGrads, this.decoderL2, gradW_L2, gradB_L2);
    // Backprop decoderL1 (leaky ReLU)
    const dDecL1In = this.backpropLeakyReluLayer(this.decoderL1, dDecL2In, allGrads);
    // dDecL1In is gradient w.r.t. decoderL1 input = embedding (pre-L2-norm)
    return dDecL1In;
  }

  /** Backprop a leaky-ReLU layer, accumulate grads, return grad w.r.t. input. */
  private backpropLeakyReluLayer(layer: Layer, gradOut: number[], allGrads: Array<{ layer: Layer; gradW: number[][]; gradB: number[] }>): number[] {
    const outDim = layer.biases.length;
    const inDim = layer.weights[0]!.length;
    const gradB = zeros1d(outDim);
    const gradW = zeros(outDim, inDim);
    const dIn = zeros1d(inDim);
    for (let i = 0; i < outDim; i++) {
      const dZ = gradOut[i]! * leakyReluGrad(layer.lastZ[i]!);
      gradB[i] = dZ;
      const w = layer.weights[i]!;
      for (let j = 0; j < inDim; j++) {
        gradW[i]![j] = dZ * layer.lastInput[j]!;
        dIn[j]! += w[j]! * dZ;
      }
    }
    this.accumulateGrad(allGrads, layer, gradW, gradB);
    return dIn;
  }

  /** Backprop gradient w.r.t. embedding through the encoder, accumulate grads. */
  private backpropEncoder(gradEmbedding: number[], xInput: number[], allGrads: Array<{ layer: Layer; gradW: number[][]; gradB: number[] }>): void {
    // encoderL2 is linear: dL/d(encL2 input) = W^T · gradEmbedding
    const dEncL2In = zeros1d(this.encoderL2.weights[0]!.length);
    const gradB_E2 = zeros1d(this.encoderL2.biases.length);
    const gradW_E2 = zeros(this.encoderL2.biases.length, this.encoderL2.weights[0]!.length);
    for (let i = 0; i < this.encoderL2.biases.length; i++) {
      const d = gradEmbedding[i]!;
      gradB_E2[i] = d;
      const w = this.encoderL2.weights[i]!;
      for (let j = 0; j < w.length; j++) {
        gradW_E2[i]![j] = d * this.encoderL2.lastInput[j]!;
        dEncL2In[j]! += w[j]! * d;
      }
    }
    this.accumulateGrad(allGrads, this.encoderL2, gradW_E2, gradB_E2);
    // encoderL1 is leaky ReLU
    this.backpropLeakyReluLayer(this.encoderL1, dEncL2In, allGrads);
  }

  /** Contrastive loss + grads on L2-normalised embeddings.
   *  Positive pairs (same outcome): pull together. Negative pairs (diff): push apart.
   *  Returns per-sample gradient w.r.t. the (pre-L2) embedding. */
  private contrastiveLossAndGrad(forwards: NAForward[]): { loss: number; grads: number[][]; correct: number; count: number } {
    const n = forwards.length;
    const grads = forwards.map(() => zeros1d(this.embedDim));
    let loss = 0;
    let count = 0;
    let correct = 0;
    // Limit pairs to avoid O(n²) blowup (V7: bounded).
    const maxPairs = Math.min(n * n, 200);
    const pairSeen = new Set<string>();
    let attempts = 0;
    while (count < maxPairs && attempts < maxPairs * 3) {
      attempts++;
      const i = Math.floor(this.rng() * n);
      const j = Math.floor(this.rng() * n);
      if (i === j) continue;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (pairSeen.has(key)) continue;
      pairSeen.add(key);
      const a = forwards[i]!.embedding;
      const b = forwards[j]!.embedding;
      const same = forwards[i]!.sample.outcome === forwards[j]!.sample.outcome;
      // cosine of L2-normalised vectors = dot product.
      let cos = 0;
      for (let k = 0; k < a.length; k++) cos += a[k]! * b[k]!;
      cos = Math.max(-0.999, Math.min(0.999, cos));
      // Logistic loss: same → -log(σ(cos)); diff → -log(σ(-cos))
      const sigma = 1 / (1 + Math.exp(-cos));
      let dCos: number;
      if (same) {
        loss += -Math.log(Math.max(sigma, 1e-12));
        // dL/dcos = -(1 - σ)
        dCos = -(1 - sigma);
        // accuracy: cos > 0 → predicted same
        if (cos > 0) correct++;
      } else {
        loss += -Math.log(Math.max(1 - sigma, 1e-12));
        dCos = sigma;
        if (cos < 0) correct++;
      }
      count++;
      // dcos/da = b (since L2-normalised, but we approximate via unnormalised grad).
      // Gradient w.r.t. L2-normalised embedding: dL/da = dCos * b
      for (let k = 0; k < a.length; k++) {
        grads[i]![k]! += dCos * b[k]!;
        grads[j]![k]! += dCos * a[k]!;
      }
    }
    return { loss: count > 0 ? loss / count : 0, grads, correct, count };
  }

  /** Diversity penalty (V13): penalise low variance across the batch's embeddings
   *  to prevent all vectors collapsing to a single point (which would make cosine
   *  meaningless). Returns per-sample gradient. */
  private diversityLoss(forwards: NAForward[]): { loss: number; grads: number[][] } {
    const n = forwards.length;
    if (n < 2) return { loss: 0, grads: forwards.map(() => zeros1d(this.embedDim)) };
    const mean = zeros1d(this.embedDim);
    for (const f of forwards) for (let k = 0; k < this.embedDim; k++) mean[k]! += f.embedding[k]! / n;
    let variance = 0;
    for (const f of forwards) {
      for (let k = 0; k < this.embedDim; k++) {
        const d = f.embedding[k]! - mean[k]!;
        variance += d * d;
      }
    }
    variance /= n;
    // Loss = -variance (minimising → maximising variance). Clamped.
    const loss = -Math.min(variance, 10);
    // dL/d(embedding[i,k]) = -2 * (embedding[i,k] - mean[k]) / n
    const grads = forwards.map(() => zeros1d(this.embedDim));
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < this.embedDim; k++) {
        grads[i]![k]! = (-2 * (forwards[i]!.embedding[k]! - mean[k]!)) / n;
      }
    }
    return { loss, grads };
  }

  // ─── Adam update ───

  private accumulateGrad(allGrads: Array<{ layer: Layer; gradW: number[][]; gradB: number[] }>, layer: Layer, gradW: number[][], gradB: number[]): void {
    const existing = allGrads.find((g) => g.layer === layer);
    if (existing) {
      for (let i = 0; i < gradW.length; i++) {
        for (let j = 0; j < gradW[i]!.length; j++) existing.gradW[i]![j]! += gradW[i]![j]!;
        existing.gradB[i]! += gradB[i]!;
      }
    } else {
      allGrads.push({ layer, gradW, gradB });
    }
  }

  private applyAdamUpdate(allGrads: Array<{ layer: Layer; gradW: number[][]; gradB: number[] }>): void {
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    // LR decay (V9: prevents late-step oscillation).
    const lr = this.cfg.learningRate / (1 + 0.001 * this.trainStep);
    for (const g of allGrads) {
      const l = g.layer;
      // Global gradient norm clip (V1: prevents explosion).
      let norm = 0;
      for (let i = 0; i < g.gradW.length; i++) {
        for (let j = 0; j < g.gradW[i]!.length; j++) norm += g.gradW[i]![j]! * g.gradW[i]![j]!;
        norm += g.gradB[i]! * g.gradB[i]!;
      }
      norm = Math.sqrt(norm);
      const clip = norm > 5.0 ? 5.0 / Math.max(norm, 1e-12) : 1.0;
      for (let i = 0; i < l.weights.length; i++) {
        for (let j = 0; j < l.weights[i]!.length; j++) {
          let grad = g.gradW[i]![j]! * clip;
          grad += this.cfg.l2Reg * l.weights[i]![j]!; // L2 (V3)
          l.mW[i]![j] = beta1 * l.mW[i]![j]! + (1 - beta1) * grad;
          l.vW[i]![j] = beta2 * l.vW[i]![j]! + (1 - beta2) * grad * grad;
          const mHat = l.mW[i]![j]! / (1 - Math.pow(beta1, this.trainStep + 1));
          const vHat = l.vW[i]![j]! / (1 - Math.pow(beta2, this.trainStep + 1));
          let nw = l.weights[i]![j]! - lr * mHat / (Math.sqrt(vHat) + eps);
          // Weight clip (V1: prevents NaN propagation).
          nw = Math.max(-10, Math.min(10, nw));
          if (!Number.isFinite(nw)) nw = 0;
          l.weights[i]![j] = nw;
        }
        let gradB = g.gradB[i]! * clip;
        l.mB[i] = beta1 * l.mB[i]! + (1 - beta1) * gradB;
        l.vB[i] = beta2 * l.vB[i]! + (1 - beta2) * gradB * gradB;
        const mHatB = l.mB[i]! / (1 - Math.pow(beta1, this.trainStep + 1));
        const vHatB = l.vB[i]! / (1 - Math.pow(beta2, this.trainStep + 1));
        let nb = l.biases[i]! - lr * mHatB / (Math.sqrt(vHatB) + eps);
        nb = Math.max(-10, Math.min(10, nb));
        if (!Number.isFinite(nb)) nb = 0;
        l.biases[i] = nb;
      }
    }
  }

  // ─── Validation ───

  validate(): NAValidationResult {
    if (this.replay.length < this.cfg.minSamplesReady) {
      const r: NAValidationResult = { mse: NaN, contrastiveAcc: 0, diversity: 0, passed: false, reason: `insufficient samples (${this.replay.length} < ${this.cfg.minSamplesReady})` };
      this.validation = r;
      return r;
    }
    // Use a held-out slice (last 20%) for validation to avoid train-on-test bias.
    const splitIdx = Math.floor(this.replay.length * 0.8);
    const valSet = this.replay.slice(splitIdx);
    if (valSet.length < 10) {
      const r: NAValidationResult = { mse: NaN, contrastiveAcc: 0, diversity: 0, passed: false, reason: 'validation set too small' };
      this.validation = r;
      return r;
    }
    let mseSum = 0;
    let mseCount = 0;
    const embeddings: Array<{ z: number[]; outcome: 1 | 0 }> = [];
    for (const s of valSet) {
      const x = this.featuresToVector(s.features);
      const xNorm = this.normaliseInput(x);
      const { embedding, reconstruction } = this.forwardFull(xNorm);
      const z = l2Normalise(embedding);
      embeddings.push({ z, outcome: s.outcome });
      const presentSet = new Set(s.presentFeatures);
      for (let i = 0; i < reconstruction.length; i++) {
        if (!presentSet.has(this.featureNames[i]!)) continue;
        const err = reconstruction[i]! - xNorm[i]!;
        mseSum += err * err;
        mseCount++;
      }
    }
    const mse = mseCount > 0 ? mseSum / mseCount : NaN;
    // Contrastive accuracy on validation pairs.
    let correct = 0;
    let count = 0;
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        let cos = 0;
        for (let k = 0; k < this.embedDim; k++) cos += embeddings[i]!.z[k]! * embeddings[j]!.z[k]!;
        const same = embeddings[i]!.outcome === embeddings[j]!.outcome;
        if ((same && cos > 0) || (!same && cos < 0)) correct++;
        count++;
      }
    }
    const contrastiveAcc = count > 0 ? correct / count : 0;
    // Diversity: variance of embeddings.
    const mean = zeros1d(this.embedDim);
    for (const e of embeddings) for (let k = 0; k < this.embedDim; k++) mean[k]! += e.z[k]! / embeddings.length;
    let diversity = 0;
    for (const e of embeddings) for (let k = 0; k < this.embedDim; k++) { const d = e.z[k]! - mean[k]!; diversity += d * d; }
    diversity /= embeddings.length;
    const passed = Number.isFinite(mse)
      && mse < this.cfg.validationMseMax
      && contrastiveAcc >= this.cfg.validationContrastiveAccMin
      && diversity > 0.01; // V13: non-degenerate
    const reason = passed
      ? 'pass'
      : `mse=${mse?.toFixed(4)} (max ${this.cfg.validationMseMax}), acc=${(contrastiveAcc * 100).toFixed(0)}% (min ${(this.cfg.validationContrastiveAccMin * 100).toFixed(0)}%), diversity=${diversity.toFixed(4)}`;
    const r: NAValidationResult = { mse, contrastiveAcc, diversity, passed, reason };
    this.validation = r;
    this.dirty = true;
    log.info(`[NA] validation: ${passed ? 'PASS' : 'FAIL'} — ${reason}`);
    return r;
  }

  // ─── Public API ───

  isReady(): boolean {
    if (!this.cfg.enabled) return false;
    return this._sampleCount >= this.cfg.minSamplesReady && this.validation?.passed === true;
  }

  async warmup(): Promise<void> {
    // In-process model — no async init needed. Exists for API parity.
    return;
  }

  sampleCount(): number {
    return this._sampleCount;
  }

  lastValidation(): NAValidationResult | null {
    return this.validation;
  }

  /** Test scaffolding: directly set replay + stats. */
  _setReplay(samples: NATrainingSample[]): void {
    this.replay = samples.slice(-this.cfg.replayBufferSize);
    for (const s of samples) this.updateInputStats(s.features, s.presentFeatures);
    this._sampleCount = samples.length;
  }

  /** Test scaffolding: force validation result. */
  _setValidation(v: NAValidationResult | null): void {
    this.validation = v;
  }
}