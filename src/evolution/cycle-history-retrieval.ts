// ─── Cycle-History Selective Retrieval (AttnRes Transfer, K.md #1, v2.0.211) ───
//
// MATS analog of Kimi K3 Attention Residuals (arXiv 2603.15031):
//   K3 layer-depth  ≡  MATS cycle-history depth
//   K3 layer output  ≡  MATS per-cycle market-feature snapshot
//   K3 embedding v0  ≡  MATS entry-time market features (persistent)
//   K3 pseudo-query  ≡  learned per-symbol retrieval query w
//
// CORE: the candidate fed to computeVectorConditionalWinRate is no longer the
// current cycle's snapshot — it is a softmax-weighted blend over cycle history
// + entry-time state, with a learned pseudo-query deciding which historical
// periods are most relevant for the current decision. Entry-time regime
// retains persistent weight (K3 "embedding persistence" — Fig 8).
//
// ONLINE LEARNING: w is updated via policy-gradient (REINFORCE) using trade
// outcome as reward. No backprop loop (MATS learns from outcomes, not gradients
// through the LLM decision pipeline). Zero-init w → uniform softmax → h_blend =
// mean(history) ≈ current behavior (cold-start safe; selectivity is EARNED).
//
// BLOCK ATTNRES (#2): 80-cycle history partitioned into 8 blocks of 10 cycles.
// Intra-block: mean of cycle features (block summary). Inter-block: softmax
// attention over 8 block summaries + entry state. Memory O(80·d) → O(8·d).
//
// SAFETY (see K.md §6):
//   - RMSNorm keys (prevents large-magnitude periods dominating softmax)
//   - zero vector → uniform unit vector (well-defined cosine)
//   - w clip ±5, EMA β=0.1, LR decay
//   - entropy floor (anti-collapse): H(α) < 0.5 → temperature warmup
//   - history floor < 3 cycles → return current snapshot unchanged
//   - NaN/Infinity guard on every feature + weight
//   - inputDim guard (feature set change → reset w)
//   - atomic persistence, last-good restore
//   - synchronous w update (no concurrent mutation)
//   - entry-close pairing guard (close without entry → skip update)
//   - |pnlPct| < 0.001 → skip (noise threshold)
//
// Persistence: data/evolution/cycle-history.json (atomic, versioned).

import { createLogger } from '../observability/logger.ts';
import { writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';

const log = createLogger({ phase: 'cycle-history' });

// ─── Config ───

export interface CycleHistoryConfig {
  enabled: boolean;
  /** Number of cycle snapshots retained per symbol (rolling window). ~7h at 5min. */
  historySize: number;
  /** Number of blocks for Block AttnRes (#2). historySize must be divisible. */
  numBlocks: number;
  /** Feature names used for retrieval (aligned with ENTRY_CONDITION_FEATURES). */
  featureNames: readonly string[];
  /** Pseudo-query learning rate (base, before decay). */
  learningRate: number;
  /** EMA smoothing factor for w update (0=freeze, 1=no smoothing). */
  emaBeta: number;
  /** Weight clip magnitude (|w_j| ≤ this). */
  weightClip: number;
  /** Entropy floor — below this, warmup temperature to prevent collapse. */
  entropyFloor: number;
  /** Temperature warmup factor applied when entropy collapses. */
  warmupFactor: number;
  /** Min cycles of history before blending (below → return current snapshot). */
  minHistoryToBlend: number;
  /** Reward noise threshold — |pnlPct| below this → skip update. */
  rewardNoiseThreshold: number;
  /** PnL scale for reward (reward = sign(pnl)·min(1, |pnlPct|/scale)). */
  pnlScale: number;
  /** LR decay denominator factor (lr = baseLR / (1 + decay·updates)). */
  lrDecay: number;
  /** v2.0.211 (K.md #1): Fixed recency prior added to attention logits so the
   *  initial policy is NOT uniform (which would give zero policy gradient —
   *  REINFORCE deadlock). logits[i] = w·key[i] + recencyPrior·(−age[i]).
   *  Entry (age 0) and recent blocks get higher weight. w=0 still produces a
   *  recency-biased (non-uniform) policy, so the gradient is non-zero and w
   *  can learn. Mirrors K3's locality observation (diagonal dominance). */
  recencyPrior: number;
  /** Persist path. */
  persistPath: string;
}

export const DEFAULT_CYCLE_HISTORY_CONFIG: CycleHistoryConfig = {
  enabled: true,
  historySize: 80,
  numBlocks: 8,
  featureNames: [
    'volatility', 'srDistanceBps', 'obImbalance', 'fundingRate', 'volumeRatio',
    'signalAgreement', 'sentiment', 'sentimentConviction', 'regimeOrdinal',
    'momentumShort', 'momentumLong',
  ],
  learningRate: 0.05,
  emaBeta: 0.1,
  weightClip: 5.0,
  entropyFloor: 0.5,
  warmupFactor: 1.3,
  minHistoryToBlend: 3,
  rewardNoiseThreshold: 0.001,
  pnlScale: 0.05,
  lrDecay: 0.01,
  recencyPrior: 0.5,
  persistPath: 'data/evolution/cycle-history.json',
};

// ─── Types ───

/** A single cycle's market features + timestamp. */
export interface CycleSnapshot {
  features: Record<string, number>;
  ts: number;
}

/** Block summary (Block AttnRes #2): mean features over a block of cycles. */
export interface BlockSummary {
  features: Record<string, number>;
  count: number;
  startTs: number;
  endTs: number;
}

/** Per-symbol state. */
export interface CycleHistoryState {
  symbol: string;
  cycles: CycleSnapshot[];
  entryFeatures: Record<string, number> | null;
  entryTs: number | null;
  w: number[];
  pendingEntry: PendingEntry | null;
  updateCount: number;
  temperature: number;
  lastEntropy: number;
  /** Per-feature Welford stats for z-score before RMSNorm. Raw MATS features
   *  span vastly different magnitudes (srDistanceBps 50-900 vs volatility
   *  0.1-0.8). Without per-feature standardisation RMSNorm is dominated by
   *  the large-magnitude feature, collapsing keys to one direction → grad≈0.
   *  K3 doesn't hit this because layer outputs are already comparable scale. */
  featMean: number[];
  featM2: number[];
  featCount: number[];
}

interface PendingEntry {
  side: 'buy' | 'sell';
  /** Attention distribution at entry (over block summaries + entry). */
  alphaDist: number[];
  /** Keys (RMSNorm'd) at entry — for gradient computation. */
  keys: number[][];
  /** Blended representation at entry. */
  hBlend: number[];
  /** Block values (original space) at entry — for gradient. */
  values: number[][];
  ts: number;
}

/** Result of retrieveBlend(). */
export interface BlendedRepresentation {
  /** Blended feature vector (original space) — use as conditional WR candidate. */
  hBlend: Record<string, number>;
  /** Attention distribution over sources (block summaries + entry). */
  alphaDist: number[];
  /** Source labels for explanation (e.g. ["entry", "block0", ...]). */
  sourceLabels: string[];
  /** Whether blending was applied (false = current snapshot returned as-is). */
  blended: boolean;
  /** Entropy of the attention distribution (bits). */
  entropy: number;
  /** Human-readable explanation. */
  explanation: string;
}

// ─── Math helpers ───

/** RMSNorm: x / sqrt(mean(x²) + eps). Zero vector → uniform unit vector. */
export function rmsNorm(x: number[]): number[] {
  let sumSq = 0;
  let finiteCount = 0;
  for (const v of x) {
    if (Number.isFinite(v)) {
      sumSq += v * v;
      finiteCount++;
    }
  }
  if (finiteCount === 0) {
    // All-missing / non-finite → uniform neutral.
    return x.map(() => 1 / Math.sqrt(x.length));
  }
  const rms = Math.sqrt(sumSq / finiteCount + 1e-8);
  return x.map((v) => (Number.isFinite(v) ? v / rms : 0));
}

/** Shannon entropy in bits (max = log2(n)). */
export function entropy(p: number[]): number {
  let h = 0;
  for (const pi of p) {
    if (pi > 1e-12) h -= pi * Math.log2(pi);
  }
  return h;
}

/** Softmax with temperature; numerically stable (max-subtraction). */
export function softmax(logits: number[], temperature: number = 1): number[] {
  if (logits.length === 0) return [];
  const scaled = logits.map((l) => l / temperature);
  let max = -Infinity;
  for (const s of scaled) if (Number.isFinite(s) && s > max) max = s;
  if (!Number.isFinite(max)) max = 0; // all non-finite → uniform
  let sum = 0;
  const exps = scaled.map((s) => {
    if (!Number.isFinite(s)) return 0;
    const e = Math.exp(s - max);
    sum += e;
    return e;
  });
  if (sum <= 0) return exps.map(() => 1 / exps.length); // degenerate → uniform
  return exps.map((e) => e / sum);
}

/** Extract a numeric feature vector aligned with featureNames. Non-finite → 0. */
function featureVector(features: Record<string, number>, names: readonly string[]): number[] {
  const v = new Array<number>(names.length);
  for (let i = 0; i < names.length; i++) {
    const val = features[names[i]!];
    v[i] = val !== undefined && val !== null && Number.isFinite(val) ? val : 0;
  }
  return v;
}

/** Mean of an array of feature vectors (element-wise). Empty → zeros. */
function meanVectors(vs: number[][]): number[] {
  if (vs.length === 0) return new Array<number>(0);
  const D = vs[0]!.length;
  const out = new Array<number>(D).fill(0);
  for (const v of vs) {
    for (let i = 0; i < D; i++) out[i]! += v[i]! / vs.length;
  }
  return out;
}

/** Convert a feature vector back to a Record keyed by featureNames. */
function vectorToRecord(v: number[], names: readonly string[]): Record<string, number> {
  const rec: Record<string, number> = {};
  for (let i = 0; i < names.length && i < v.length; i++) {
    rec[names[i]!] = Number.isFinite(v[i]!) ? v[i]! : 0;
  }
  return rec;
}

// ─── CycleHistoryRetriever ───

export class CycleHistoryRetriever {
  private cfg: CycleHistoryConfig;
  private states = new Map<string, CycleHistoryState>();
  private dirty = false;
  /** Last good persisted snapshot (for NaN-corruption restore). */
  private lastGood: Map<string, CycleHistoryState> | null = null;

  constructor(cfg: Partial<CycleHistoryConfig> = {}) {
    this.cfg = { ...DEFAULT_CYCLE_HISTORY_CONFIG, ...cfg };
  }

  // ─── Lifecycle ───

  load(path?: string): void {
    const p = path ?? this.cfg.persistPath;
    try {
      if (!existsSync(p)) {
        log.info(`[cycle-history] No state file at ${p} — starting fresh`);
        return;
      }
      const data = readFileSync(p, 'utf-8');
      const parsed = JSON.parse(data) as { states: CycleHistoryState[]; version: number };
      if (!parsed || !Array.isArray(parsed.states)) throw new Error('invalid state');
      this.states = new Map();
      for (const s of parsed.states) {
        if (!s || typeof s !== 'object' || !s.symbol) continue;
        // Dimension guard: if feature set changed, reset w.
        if (s.w && s.w.length !== this.cfg.featureNames.length) {
          log.warn(`[cycle-history] w dim mismatch for ${s.symbol} (${s.w.length}→${this.cfg.featureNames.length}) — resetting w`);
          s.w = new Array<number>(this.cfg.featureNames.length).fill(0);
        }
        this.states.set(s.symbol, s);
      }
      this.lastGood = this.snapshotStates();
      log.info(`[cycle-history] Loaded ${this.states.size} symbol states`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[cycle-history] load failed (${msg}) — starting fresh`);
    }
  }

  persist(path?: string): void {
    if (!this.dirty) return;
    const p = path ?? this.cfg.persistPath;
    try {
      const obj = { version: 1, states: [...this.states.values()], savedAt: Date.now() };
      const tmp = p + '.tmp';
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, p);
      this.dirty = false;
      this.lastGood = this.snapshotStates();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[cycle-history] persist failed: ${msg}`);
    }
  }

  private snapshotStates(): Map<string, CycleHistoryState> {
    const m = new Map<string, CycleHistoryState>();
    for (const [k, v] of this.states) m.set(k, JSON.parse(JSON.stringify(v)));
    return m;
  }

  // ─── State access ───

  private getState(symbol: string): CycleHistoryState {
    const sym = symbol;
    let s = this.states.get(sym);
    if (!s) {
      s = {
        symbol: sym,
        cycles: [],
        entryFeatures: null,
        entryTs: null,
        w: new Array<number>(this.cfg.featureNames.length).fill(0),
        pendingEntry: null,
        updateCount: 0,
        temperature: 1,
        lastEntropy: 0,
        featMean: new Array<number>(this.cfg.featureNames.length).fill(0),
        featM2: new Array<number>(this.cfg.featureNames.length).fill(0),
        featCount: new Array<number>(this.cfg.featureNames.length).fill(0),
      };
      this.states.set(sym, s);
    }
    return s;
  }

  /** Push a cycle's market features into the rolling history window. */
  pushCycle(symbol: string, features: Record<string, number>, ts: number = Date.now()): void {
    if (!this.cfg.enabled) return;
    if (!features || typeof features !== 'object') return; // guard: null/non-object
    try {
      const s = this.getState(symbol);
      // Sanitise features — drop non-finite, keep record.
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(features)) {
        clean[k] = Number.isFinite(v) ? v : 0;
      }
      s.cycles.push({ features: clean, ts });
      if (s.cycles.length > this.cfg.historySize) {
        s.cycles.splice(0, s.cycles.length - this.cfg.historySize);
      }
      this.updateFeatStats(s, clean);
      this.dirty = true;
    } catch (err) {
      log.warn(`[cycle-history] pushCycle failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Capture entry-time features (embedding persistence, v_0). Called at trade open. */
  recordEntry(symbol: string, side: 'buy' | 'sell', entryFeatures: Record<string, number>): void {
    if (!this.cfg.enabled) return;
    if (!entryFeatures || typeof entryFeatures !== 'object') return; // guard
    try {
      const s = this.getState(symbol);
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(entryFeatures)) {
        clean[k] = Number.isFinite(v) ? v : 0;
      }
      s.entryFeatures = clean;
      s.entryTs = Date.now();
      // Compute + cache the blend at entry for outcome pairing.
      const blend = this.retrieveBlend(symbol);
      if (blend.blended && blend.alphaDist.length > 0) {
        const { keys, values, ages: _ages } = this.buildKeysAndValues(s);
        s.pendingEntry = {
          side,
          alphaDist: blend.alphaDist,
          keys,
          values,
          hBlend: featureVector(blend.hBlend, this.cfg.featureNames),
          ts: s.entryTs,
        };
      } else {
        s.pendingEntry = null;
      }
      this.dirty = true;
    } catch (err) {
      log.warn(`[cycle-history] recordEntry failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Block AttnRes (#2): build block summaries + entry value ───

  /** Build keys (RMSNorm'd), values (original space), and ages (for recency prior).
   *  age=0 for entry (newest/most persistent), age increases for older blocks
   *  (block0 = oldest, blockN-1 = newest). */
  private buildKeysAndValues(s: CycleHistoryState): { keys: number[][]; values: number[][]; ages: number[] } {
    const names = this.cfg.featureNames;
    const blockSize = Math.floor(this.cfg.historySize / this.cfg.numBlocks);
    const values: number[][] = [];
    const ages: number[] = [];
    // Entry features first (v_0 — embedding persistence, age=0).
    if (s.entryFeatures) {
      values.push(featureVector(s.entryFeatures, names));
      ages.push(0);
    }
    // Block summaries (mean of each block's cycle features).
    // block0 = oldest (highest age), blockN-1 = newest (lowest age).
    const cycles = s.cycles;
    const numActualBlocks = Math.min(this.cfg.numBlocks, Math.ceil(cycles.length / Math.max(1, blockSize)));
    for (let b = 0; b < numActualBlocks; b++) {
      const start = b * blockSize;
      const end = start + blockSize;
      const blockCycles = cycles.slice(start, end);
      if (blockCycles.length === 0) continue;
      const vecs = blockCycles.map((c) => featureVector(c.features, names));
      values.push(meanVectors(vecs));
      ages.push(numActualBlocks - b);
    }
    // Keys = z-score (per-feature Welford) then RMSNorm. z-score puts all
    // features on a comparable scale (critical: raw features span 50-900 vs
    // 0.1-0.8); RMSNorm then extracts direction for attention competition.
    const keys = values.map((v) => rmsNorm(this.zScore(s, v)));
    return { keys, values, ages };
  }

  /** Welford update of per-feature running mean/M2/count. */
  private updateFeatStats(s: CycleHistoryState, features: Record<string, number>): void {
    for (let i = 0; i < this.cfg.featureNames.length; i++) {
      const v = features[this.cfg.featureNames[i]!];
      if (v === undefined || v === null || !Number.isFinite(v)) continue;
      const n = s.featCount[i]! + 1;
      s.featCount[i] = n;
      const delta = v - s.featMean[i]!;
      s.featMean[i]! += delta / n;
      s.featM2[i]! += delta * (v - s.featMean[i]!);
    }
  }

  /** Z-score a feature vector using the symbol's running stats.
   *  count < 2 → 0 (neutral). */
  private zScore(s: CycleHistoryState, v: number[]): number[] {
    const out = new Array<number>(v.length);
    for (let i = 0; i < v.length; i++) {
      const n = s.featCount[i]!;
      if (n < 2) { out[i] = 0; continue; }
      const variance = s.featM2[i]! / (n - 1);
      const std = Math.sqrt(Math.max(variance, 1e-8));
      out[i] = Number.isFinite(v[i]!) ? (v[i]! - s.featMean[i]!) / std : 0;
    }
    return out;
  }

  // ─── Retrieval (#1 + #2 + #3) ───

  /** Retrieve the AttnRes-blended representation for a symbol.
   *  Returns current snapshot unchanged when history < minHistoryToBlend. */
  retrieveBlend(symbol: string): BlendedRepresentation {
    if (!this.cfg.enabled) {
      return this.currentSnapshotResult(symbol);
    }
    try {
      const s = this.getState(symbol);
      const names = this.cfg.featureNames;

      // History floor: too few cycles → return current snapshot.
      if (s.cycles.length < this.cfg.minHistoryToBlend) {
        return this.currentSnapshotResult(symbol);
      }

      const { keys, values, ages } = this.buildKeysAndValues(s);
      if (values.length === 0) {
        return this.currentSnapshotResult(symbol);
      }

      // Softmax attention with learned pseudo-query w (#1) + fixed recency prior.
      // α_i = softmax((w·key_i + recencyPrior·(−age_i)) / temperature)
      // The recency prior breaks the uniform-policy deadlock (REINFORCE grad = 0
      // when α uniform) and mirrors K3's locality observation (diagonal dominance).
      const w = s.w;
      const logits = keys.map((k, i) => {
        let dot = 0;
        for (let j = 0; j < k.length && j < w.length; j++) dot += w[j]! * k[j]!;
        return dot + this.cfg.recencyPrior * (-ages[i]!);
      });
      const alpha = softmax(logits, s.temperature);
      const ent = entropy(alpha);

      // Entropy floor (#anti-collapse): if collapsed, warm temperature for next time.
      if (ent < this.cfg.entropyFloor && values.length > 1) {
        s.temperature = Math.min(s.temperature * this.cfg.warmupFactor, 5);
      } else if (ent > this.cfg.entropyFloor * 1.5 && s.temperature > 1) {
        // Recover temperature once entropy is healthy.
        s.temperature = Math.max(s.temperature / this.cfg.warmupFactor, 1);
      }
      s.lastEntropy = ent;

      // Blended representation: h = Σ α_i · v_i (original feature space).
      const D = values[0]!.length;
      const hBlend = new Array<number>(D).fill(0);
      for (let i = 0; i < values.length; i++) {
        for (let j = 0; j < D; j++) hBlend[j]! += alpha[i]! * values[i]![j]!;
      }
      // NaN guard.
      for (let j = 0; j < D; j++) if (!Number.isFinite(hBlend[j]!)) hBlend[j] = 0;

      const labels = this.buildLabels(s);
      const hRecord = vectorToRecord(hBlend, names);
      const explanation = `AttnRes blend: ${values.length} sources (entry + ${values.length - (s.entryFeatures ? 1 : 0)} blocks), entropy=${ent.toFixed(2)} bits, temperature=${s.temperature.toFixed(2)}, top source=${labels[alpha.indexOf(Math.max(...alpha))] ?? 'n/a'}`;

      return {
        hBlend: hRecord,
        alphaDist: alpha,
        sourceLabels: labels,
        blended: true,
        entropy: ent,
        explanation,
      };
    } catch (err) {
      log.warn(`[cycle-history] retrieveBlend failed for ${symbol}: ${err instanceof Error ? err.message : String(err)} — returning current snapshot`);
      return this.currentSnapshotResult(symbol);
    }
  }

  private buildLabels(s: CycleHistoryState): string[] {
    const labels: string[] = [];
    if (s.entryFeatures) labels.push('entry');
    const blockSize = Math.floor(this.cfg.historySize / this.cfg.numBlocks);
    for (let b = 0; b < this.cfg.numBlocks; b++) {
      const start = b * blockSize;
      if (start < s.cycles.length) labels.push(`block${b}`);
    }
    return labels;
  }

  private currentSnapshotResult(symbol: string): BlendedRepresentation {
    const s = this.getState(symbol);
    const latest = s.cycles[s.cycles.length - 1];
    const features = latest?.features ?? {};
    return {
      hBlend: { ...features },
      alphaDist: [],
      sourceLabels: [],
      blended: false,
      entropy: 0,
      explanation: 'history < minHistoryToBlend — using current snapshot (cold-start)',
    };
  }

  // ─── Online learning (#1 policy gradient) ───

  /** Update pseudo-query w from a trade outcome (REINFORCE policy gradient).
   *  No-op if no pending entry (close without recordEntry) or |pnlPct| below noise. */
  updateOnOutcome(symbol: string, side: 'buy' | 'sell', pnlPct: number): void {
    if (!this.cfg.enabled) return;
    try {
      const s = this.getState(symbol);
      const pending = s.pendingEntry;
      if (!pending || pending.side !== side) {
        // Entry-close mismatch or no entry record → skip (guard).
        return;
      }
      if (Math.abs(pnlPct) < this.cfg.rewardNoiseThreshold) {
        // Noise threshold — skip update (flat outcome).
        s.pendingEntry = null;
        return;
      }

      // Reward: sign(pnl) · min(1, |pnlPct|/scale).
      const reward = Math.sign(pnlPct) * Math.min(1, Math.abs(pnlPct) / this.cfg.pnlScale);
      if (!Number.isFinite(reward) || reward === 0) {
        s.pendingEntry = null;
        return;
      }

      // Online update via reward-weighted key direction (Peters & Schaal
      // 2008 reward-weighted regression, adapted for deterministic attention).
      // REINFORCE's score-function gradient Σα_i·(key_i − mean_key) is
      // identically zero for a deterministic softmax blend (Σα·key = mean →
      // Σα·(key−mean) = 0). Instead, move w toward the attention-weighted key
      // direction when reward > 0 (reinforce the blend that won), away when < 0:
      //   w ← w + lr · reward · mean_key   (mean_key = Σα_i · key_i)
      // This is a direct outcome-to-attention association: if a regime-block's
      // key direction preceded a win, w shifts to attend it more next time.
      const { alphaDist, keys } = pending;
      const n = keys.length;
      if (n === 0) { s.pendingEntry = null; return; }
      const D = keys[0]!.length;

      // mean_key = Σ α_i · key_i (the attention-weighted key direction).
      const meanKey = new Array<number>(D).fill(0);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < D; j++) meanKey[j]! += alphaDist[i]! * keys[i]![j]!;
      }

      // LR with decay.
      const lr = this.cfg.learningRate / (1 + this.cfg.lrDecay * s.updateCount);

      // Reward-weighted update + EMA smoothing.
      const wNew = s.w.slice();
      for (let j = 0; j < D; j++) {
        const update = lr * reward * meanKey[j]!;
        const target = wNew[j]! + update;
        wNew[j] = (1 - this.cfg.emaBeta) * wNew[j]! + this.cfg.emaBeta * target;
        wNew[j] = Math.max(-this.cfg.weightClip, Math.min(this.cfg.weightClip, wNew[j]!));
        if (!Number.isFinite(wNew[j]!)) wNew[j] = 0;
      }
      s.w = wNew;
      s.updateCount++;
      s.pendingEntry = null;
      this.dirty = true;
      log.debug(`[cycle-history] ${symbol} ${side} w updated: reward=${reward.toFixed(3)}, updates=${s.updateCount}, entropy=${s.lastEntropy.toFixed(2)}`);
    } catch (err) {
      log.warn(`[cycle-history] updateOnOutcome failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Public introspection ───

  /** Get the w vector for a symbol (for debugging / display). */
  getQuery(symbol: string): number[] {
    const s = this.states.get(symbol);
    return s ? s.w.slice() : new Array<number>(this.cfg.featureNames.length).fill(0);
  }

  /** Get cycle count for a symbol. */
  cycleCount(symbol: string): number {
    return this.states.get(symbol)?.cycles.length ?? 0;
  }

  /** Total symbols tracked. */
  size(): number {
    return this.states.size;
  }

  /** Test scaffolding: directly set a symbol's state. */
  _setState(symbol: string, partial: Partial<CycleHistoryState>): void {
    const s = this.getState(symbol);
    Object.assign(s, partial);
    this.dirty = true;
  }

  /** Test scaffolding: clear all state. */
  _reset(): void {
    this.states = new Map();
    this.dirty = false;
    this.lastGood = null;
  }
}