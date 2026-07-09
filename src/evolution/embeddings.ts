// ─── EXP Embedding Layer (v2.0.138) ───
// Abstract embedding provider + transformers.js MiniLM production impl + vector math.
// See /Users/y.c./Downloads/EXP_core_plan.md §4 (方案 B: all-MiniLM-L6-v2, 384-dim).
//
// Machine constraint: NEVER use 30B+ local models. MiniLM is 22MB ONNX, CPU-friendly,
// loaded lazily on warmup() (downloads from HuggingFace CDN on first use).

import { config } from '../config/index.ts';
import { rootLogger } from '../observability/logger.ts';

const log = rootLogger;

/** Abstract embedding provider — mockable for tests. */
export interface EmbedProvider {
  readonly name: string;
  readonly dim: number;
  isReady(): boolean;
  /** Preload the model so the first embed() call isn't delayed (startup warmup). */
  warmup(): Promise<void>;
  /** Embed a batch of short texts → one vector per text (each `dim`-dim, L2-normalised). */
  embed(texts: string[]): Promise<number[][]>;
}

// ─── Transformers.js production provider (all-MiniLM-L6-v2, 384-dim) ───

/**
 * Lazily-loaded transformers.js pipeline. We dynamic-import the package so the
 * heavy ONNX runtime is only pulled in when EXP is actually enabled (not at module
 * load time), keeping the module importable in tests without a model download.
 */
type FeatureExtractionFn = (
  texts: string | string[],
  options?: { pooling?: 'mean' | 'cls' | 'max'; normalize?: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

export class TransformersEmbedProvider implements EmbedProvider {
  readonly name = 'transformers.js:all-MiniLM-L6-v2';
  readonly dim: number;
  private extractor: FeatureExtractionFn | null = null;
  private ready = false;
  private readonly model: string;

  constructor(model?: string, dim?: number) {
    this.model = model ?? config.exp.embedModel;
    this.dim = dim ?? config.exp.embedDim;
  }

  isReady(): boolean {
    return this.ready;
  }

  async warmup(): Promise<void> {
    if (this.ready) return;
    try {
      const transformers = await import('@xenova/transformers');
      // Suppress remote model download warnings in prod; allow local cache.
      // (Model downloads to a cache dir on first use; subsequent loads are local.)
      const env = (transformers as { env: Record<string, unknown> }).env;
      env['allowLocalModels'] = true;
      env['allowRemoteModels'] = true;
      const pipe = (transformers as unknown as {
        pipeline: (task: string, model: string, opts?: unknown) => Promise<FeatureExtractionFn>;
      }).pipeline;
      this.extractor = await pipe('feature-extraction', this.model, { quantized: true });
      // Prime the model with a tiny input so the first real call is fast.
      await this.extractor(['warmup'], { pooling: 'mean', normalize: true });
      this.ready = true;
      log.info(`[EXP-embed] warmup complete: ${this.model} (${this.dim}-d)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[EXP-embed] warmup failed: ${msg}`);
      this.ready = false;
      throw err;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.extractor || !this.ready) {
      await this.warmup();
    }
    if (!this.extractor) {
      throw new Error('embed: extractor not initialised after warmup');
    }
    const output = await this.extractor(texts, { pooling: 'mean', normalize: true });
    const data = output.data as Float32Array | number[];
    const dims = output.dims; // [batch, seq, dim] after pooling → [batch, dim]
    const dim = this.dim;
    const batch = dims.length > 1 ? dims[0]! : texts.length;
    // Flatten [batch, dim] into number[][]
    const arr = Array.from(data);
    const out: number[][] = [];
    for (let i = 0; i < batch; i++) {
      out.push(arr.slice(i * dim, (i + 1) * dim));
    }
    return out;
  }
}

// ─── Mock provider for tests — deterministic, no model download ───

/**
 * Deterministic hash-based embedder. Maps each text to a stable `dim`-dim vector
 * so tests can construct controlled similarity relationships (e.g. B=[1,0], C=[0,1]).
 * Vectors are L2-normalised so cosine arithmetic matches the production provider.
 *
 * For explicit control, tests may inject pre-built vectors via `setVector(text, vec)`.
 */
export class MockEmbedProvider implements EmbedProvider {
  readonly name = 'mock';
  readonly dim: number;
  private ready = true;
  private overrides = new Map<string, number[]>();

  constructor(dim = 384) {
    this.dim = dim;
  }

  isReady(): boolean {
    return this.ready;
  }

  async warmup(): Promise<void> {
    this.ready = true;
  }

  /** Public accessor for the deterministic vector of a text (test scaffolding). */
  vectorFor(text: string): number[] {
    return this.overrideOrHash(text);
  }

  /** Inject an explicit vector for a specific text (test scaffolding). */
  setVector(text: string, vec: number[]): void {
    // normalise to unit length so cosine is consistent
    const norm = Math.hypot(...vec) || 1;
    this.overrides.set(text, vec.map((v) => v / norm));
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.overrideOrHash(t));
  }

  private overrideOrHash(text: string): number[] {
    const ov = this.overrides.get(text);
    if (ov) return ov;
    // Deterministic hash → vector. Seeded by string char codes.
    const seed = this.hash(text);
    const vec: number[] = [];
    for (let i = 0; i < this.dim; i++) {
      vec.push(Math.sin((seed + i) * 12.9898) * 43758.5453 % 1);
    }
    const norm = Math.hypot(...vec) || 1;
    return vec.map((v) => v / norm);
  }

  private hash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }
}

// ─── Vector math ───

/** Cosine similarity for L2-normalised vectors (= dot product). Falls back to full cosine. */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Set-to-set combination similarity (non-symmetric, §8.3).
 * For each candidate vector, find the best-matching (max cosine) historical vector,
 * then average across candidates. Captures the Master Lord's intuition:
 *   combSim(B+Z, B+C) = (cos(B,B) + cos(Z,C)) / 2 = (1 + cos(Z,C)) / 2
 */
export function combinationSimilarityAsymmetric(cand: number[][], hist: number[][]): number {
  if (cand.length === 0 || hist.length === 0) return 0;
  let sum = 0;
  for (const cv of cand) {
    let best = -Infinity;
    for (const hv of hist) {
      const c = cosine(cv, hv);
      if (c > best) best = c;
    }
    sum += best;
  }
  return sum / cand.length;
}

/**
 * Symmetric variant: average both directions (cand→hist and hist→cand).
 * More fair when set sizes differ. v1 uses non-symmetric (Master Lord 漏問二).
 */
export function combinationSimilaritySymmetric(cand: number[][], hist: number[][]): number {
  if (cand.length === 0 || hist.length === 0) return 0;
  const fwd = combinationSimilarityAsymmetric(cand, hist);
  const bwd = combinationSimilarityAsymmetric(hist, cand);
  return (fwd + bwd) / 2;
}

export function combinationSimilarity(
  cand: number[][],
  hist: number[][],
  mode: 'asymmetric' | 'symmetric' = 'asymmetric',
): number {
  return mode === 'symmetric'
    ? combinationSimilaritySymmetric(cand, hist)
    : combinationSimilarityAsymmetric(cand, hist);
}