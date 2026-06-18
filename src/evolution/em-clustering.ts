// ─── GMM EM Clustering Engine ───
// Real Expectation-Maximisation for Gaussian Mixture Models.
//
// Discovers latent clusters in trade feature vectors so the system
// can answer "what kind of trades tend to win/lose in this region
// of feature space?" without relying on nearest-neighbour lookups.
//
// 「EM clustering compresses experience into generative knowledge」
//
// Symbol-aware: each symbol has its own GMM model, since BTC's
// volatility/funding profile differs entirely from MU or ETH.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'em_clustering' });

// ─── Config ───

const CONFIG = {
  maxClusters: 6,
  minClusters: 2,
  maxIterations: 200,
  convergenceTol: 1e-6,
  /** How many new trades before triggering a full re-fit */
  refitInterval: 10,           // every 10 new trades per symbol
  /** Minimum trades to bother running EM */
  minSamplesForEM: 10,
  /** Regularisation added to diagonal covariance diagonal (prevents singularities) */
  covarRegularizer: 1e-4,
  persistPath: 'data/evolution/em-clusters.json',
} as const;

/** log(2π) — precomputed constant for Gaussian PDF */
const LOG_2PI = Math.log(2 * Math.PI);

// ─── Types ───

export interface EMCluster {
  mean: number[];
  covar: number[];
  weight: number;
  winRate: number;
  sampleCount: number;
}

export interface EMModel {
  clusters: EMCluster[];
  featureNames: string[];
  totalSamples: number;
  logLikelihood: number;
  bic: number;
  fittedAt: number;
  iterations: number;
}

export interface EMQueryResult {
  responsibilities: number[];
  weightedWinRate: number;
  dominantCluster: number;
  zScores: number[];
  explanation: string;
}

/** Per-symbol state: model + norm stats + pending queue */
interface SymbolEMState {
  model: EMModel | null;
  norm: NormStats;
  pendingSamples: number[][];
  tradesSinceRefit: number;
}

// ─── Feature Dimensions ───

const FEATURE_NAMES = [
  'direction', 'volatility', 'srDistanceBps', 'obImbalance',
  'sentiment', 'signalAgreement', 'fundingRate',
  'volumeRatio', 'sentimentConviction',
];

interface NormStats {
  mean: number[];
  std: number[];
  count: number;
}

function defaultNorm(): NormStats {
  return { mean: [], std: [], count: 0 };
}

/**
 * Standardise a raw feature vector using running norm stats (z-score).
 * Falls back to raw values if norm not yet populated (count < 2 or zero std).
 * This ensures all feature dimensions contribute comparably to the Gaussian
 * PDF quadratic term, regardless of their native scale (e.g. srDistanceBps ~50
 * vs fundingRate ~0.001).
 */
function normalize(x: number[], norm: NormStats): number[] {
  if (norm.mean.length !== x.length || norm.count < 2) return [...x];
  return x.map((v, i) => {
    const std = Math.sqrt(norm.std[i]! / Math.max(1, norm.count - 1));
    return std > 1e-12 ? (v - norm.mean[i]!) / std : 0;
  });
}

function makeEmptyState(): SymbolEMState {
  return { model: null, norm: defaultNorm(), pendingSamples: [], tradesSinceRefit: 0 };
}

// ─── GMM EM Implementation ───

export class EMClusteringEngine {
  /** Per-symbol GMM states — key is lowercase symbol */
  private symbols = new Map<string, SymbolEMState>();

  // ─── Lifecycle ───

  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.symbols) {
        for (const [sym, raw] of Object.entries(data.symbols)) {
          const s = raw as any;
          // Reject stale models with wrong feature count (e.g. missing direction)
          const model = s.model ?? null;
          if (model && model.featureNames && model.featureNames.length !== FEATURE_NAMES.length) {
            log.warn(`[load] ${sym}: stale model has ${model.featureNames.length} features, expected ${FEATURE_NAMES.length} — discarding`);
            continue;
          }
          this.symbols.set(sym, {
            model,
            norm: s.norm ?? defaultNorm(),
            pendingSamples: s.pendingSamples ?? [],
            tradesSinceRefit: s.tradesSinceRefit ?? 0,
          });
        }
        log.info(`EM models loaded: ${this.symbols.size} symbols`);
        for (const [sym, state] of this.symbols) {
          if (state.model) log.info(`  ${sym}: ${state.model.clusters.length} clusters, ${state.model.totalSamples} samples`);
        }
      }
    } catch {
      log.warn('[load] Failed to parse EM data, starting fresh');
    }
  }

  save(): string {
    const obj: Record<string, any> = {};
    for (const [sym, state] of this.symbols) {
      obj[sym] = {
        model: state.model,
        norm: state.norm,
        pendingSamples: state.pendingSamples,
        tradesSinceRefit: state.tradesSinceRefit,
      };
    }
    return JSON.stringify({ symbols: obj });
  }

  /** Get model for a specific symbol (null if not enough data yet) */
  getModel(symbol: string): EMModel | null {
    const sym = symbol.toLowerCase();
    return this.symbols.get(sym)?.model ?? null;
  }

  /** Get all symbols that have a trained model */
  getSymbolsWithModels(): string[] {
    return Array.from(this.symbols.entries())
      .filter(([, s]) => s.model !== null)
      .map(([sym]) => sym);
  }

  /** Get aggregate stats across all symbols (for UI) */
  getAllModelStats(): Array<{
    symbol: string;
    clusterCount: number;
    totalSamples: number;
    bic: number;
    clusters: Array<{ index: number; winRate: number; sampleCount: number; weight: number; mean: number[]; featureNames: string[] }>;
  }> {
    const result: Array<any> = [];
    for (const [sym, state] of this.symbols) {
      if (!state.model) continue;
      result.push({
        symbol: sym,
        clusterCount: state.model.clusters.length,
        totalSamples: state.model.totalSamples,
        bic: state.model.bic,
        clusters: state.model.clusters.map((c, i) => ({
          index: i,
          winRate: c.winRate,
          sampleCount: c.sampleCount,
          weight: c.weight,
          mean: c.mean,
          featureNames: state.model!.featureNames,
        })),
      });
    }
    return result;
  }

  /** Get pending sample counts per symbol (real-time accumulation before EM train) */
  getPendingStats(): Array<{ symbol: string; pending: number; needed: number; pct: number }> {
    const result: Array<{ symbol: string; pending: number; needed: number; pct: number }> = [];
    for (const [sym, state] of this.symbols) {
      const pending = state.pendingSamples.length;
      if (pending === 0 && !state.model) continue;
      result.push({
        symbol: sym,
        pending,
        needed: CONFIG.minSamplesForEM,
        pct: Math.min(100, Math.round((pending / CONFIG.minSamplesForEM) * 100)),
      });
    }
    return result;
  }

  // ─── Training ───

  private getOrCreateState(symbol: string): SymbolEMState {
    const sym = symbol.toLowerCase();
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, makeEmptyState());
    }
    return this.symbols.get(sym)!;
  }

  contextToVector(features: Record<string, number>): number[] {
    return FEATURE_NAMES.map(name => features[name] ?? 0);
  }

  /**
   * Feed a trade into the per-symbol pending queue.
   */
  feedTrade(symbol: string, features: Record<string, number>, outcome: 1 | 0): void {
    const state = this.getOrCreateState(symbol);
    const rawVec = this.contextToVector(features);

    this.updateNorm(state, rawVec);
    state.pendingSamples.push([...rawVec, outcome]);
    state.tradesSinceRefit++;
  }

  maybeRefit(symbol: string): boolean {
    const state = this.getOrCreateState(symbol);
    // First refit: run as soon as we have enough samples
    if (!state.model) {
      if (state.pendingSamples.length < CONFIG.minSamplesForEM) return false;
      this.refit(state);
      state.tradesSinceRefit = 0;
      return true;
    }
    // Subsequent refits: wait for refitInterval new trades
    if (state.tradesSinceRefit < CONFIG.refitInterval) return false;
    if (state.pendingSamples.length < CONFIG.minSamplesForEM) return false;
    this.refit(state);
    state.tradesSinceRefit = 0;
    return true;
  }

  private refit(state: SymbolEMState): void {
    const samples = state.pendingSamples;
    if (samples.length < CONFIG.minSamplesForEM) {
      log.warn(`[refit] Only ${samples.length} samples — skipping`);
      return;
    }

    const n = FEATURE_NAMES.length;
    const X: number[][] = [];
    const y: number[] = [];
    for (const s of samples) {
      // Normalise features via z-score using running Welford stats.
      // Without this, large-scale dims (srDistanceBps ~50) dominate the
      // Gaussian quadratic term and small-scale dims (fundingRate ~0.001)
      // have ~zero discriminative power.
      X.push(normalize(s.slice(0, n), state.norm));
      y.push(s[n]!);
    }

    let bestModel: { clusters: EMCluster[]; ll: number; bic: number; iters: number } | null = null;
    let bestBic = Infinity;

    for (let k = CONFIG.minClusters; k <= Math.min(CONFIG.maxClusters, samples.length - 1); k++) {
      const result = this.runEM(X, k);
      if (result && result.bic < bestBic) {
        bestBic = result.bic;
        bestModel = result;
      }
    }

    if (!bestModel) { log.warn('[refit] EM failed to converge'); return; }

    const clusterLabels = this.assignClusters(X, bestModel.clusters);
    const clusterWinRates: Array<{ wins: number; total: number }> = bestModel.clusters.map(() => ({ wins: 0, total: 0 }));
    for (let i = 0; i < clusterLabels.length; i++) {
      const ci = clusterLabels[i]!;
      clusterWinRates[ci]!.total++;
      if (y[i] === 1) clusterWinRates[ci]!.wins++;
    }

    const clustersWithWR = bestModel.clusters.map((c, i) => ({
      ...c,
      winRate: clusterWinRates[i]!.total > 0 ? clusterWinRates[i]!.wins / clusterWinRates[i]!.total : 0.5,
      sampleCount: clusterWinRates[i]!.total,
    }));

    state.model = {
      clusters: clustersWithWR,
      featureNames: [...FEATURE_NAMES],
      totalSamples: samples.length,
      logLikelihood: bestModel.ll,
      bic: bestModel.bic,
      fittedAt: Date.now(),
      iterations: bestModel.iters,
    };

    state.pendingSamples = [];

    log.info(`[refit] EM converged: ${clustersWithWR.length} clusters, ${samples.length} samples, BIC=${bestModel.bic.toFixed(1)}`);
    for (let i = 0; i < clustersWithWR.length; i++) {
      const c = clustersWithWR[i]!;
      log.info(`  Cluster #${i}: n=${c.sampleCount} wr=${(c.winRate * 100).toFixed(0)}% π=${(c.weight * 100).toFixed(0)}%`);
    }
  }

  // ─── Query ───

  /**
   * Query: given a current feature context, what's the cluster-weighted win rate
   * for this specific symbol?
   */
  query(symbol: string, features: Record<string, number>): EMQueryResult {
    const empty = (): EMQueryResult => ({
      responsibilities: [], weightedWinRate: 0.5, dominantCluster: -1, zScores: [],
      explanation: 'No EM model trained yet for this symbol',
    });

    const state = this.getOrCreateState(symbol);
    if (!state.model || state.model.clusters.length === 0) return empty();

    // Normalise query vector with the same running stats used during training.
    // Model means/covars live in normalised space, so queries must match.
    const x = normalize(this.contextToVector(features), state.norm);
    const { clusters } = state.model;

    const logR: number[] = clusters.map(c =>
      this.logGaussianPDF(x, c.mean, c.covar) + Math.log(Math.max(c.weight, 1e-10))
    );

    const logMax = Math.max(...logR);
    const sumExp = logR.reduce((s, lr) => s + Math.exp(lr - logMax), 0);
    const logSum = logMax + Math.log(sumExp);
    const responsibilities = logR.map(lr => Math.exp(lr - logSum));

    const weightedWinRate = responsibilities.reduce((s, r, i) => s + r * clusters[i]!.winRate, 0);
    const dominantCluster = responsibilities.indexOf(Math.max(...responsibilities));
    const zScores = clusters.map(c =>
      Math.sqrt(c.mean.reduce((s, m, d) => s + ((x[d] ?? 0) - m) ** 2 / Math.max(c.covar[d]!, 1e-10), 0) / c.mean.length)
    );

    const dom = clusters[dominantCluster]!;
    const explanation = this.formatClusterExplanation(state.model, dominantCluster, responsibilities, dom, zScores);

    return { responsibilities, weightedWinRate, dominantCluster, zScores, explanation };
  }

  // ─── GMM Core ───

  /**
   * Run EM for a given K. Returns cluster params, log-likelihood, BIC.
   */
  private runEM(X: number[][], k: number): { clusters: EMCluster[]; ll: number; bic: number; iters: number } | null {
    const n = X.length;
    const d = FEATURE_NAMES.length;

    // Initialise: k-means++ style initialisation + small random jitter
    let clusters = this.initClusters(X, k, d);

    let prevLL = -Infinity;
    let ll = -Infinity;

    for (let iter = 0; iter < CONFIG.maxIterations; iter++) {
      // E-step: compute responsibilities
      const R = this.eStep(X, clusters);
      if (!R) return null;

      // Compute log-likelihood (total over all samples)
      ll = this.computeLogLikelihood(X, clusters);

      // Check convergence on per-sample average (ll is now a sum, so divide by n)
      const llAvg = ll / n;
      const prevLlAvg = prevLL / n;
      if (Math.abs(llAvg - prevLlAvg) < CONFIG.convergenceTol && iter > 5) {
        // M-step one last time
        clusters = this.mStep(X, R, d);
        break;
      }
      prevLL = ll;

      // M-step
      clusters = this.mStep(X, R, d);
    }

    // Compute BIC: -2 * LL + p * log(n)
    // Free params p = (k-1) mixing weights (Σπ=1 constraint) + k*d means + k*d covariances
    const paramCount = (k - 1) + k * (2 * d);
    const bic = -2 * ll + paramCount * Math.log(n);

    return { clusters, ll, bic, iters: Math.min(CONFIG.maxIterations, 200) };
  }

  /**
   * E-step: compute posterior probabilities P(cluster | sample)
   */
  private eStep(X: number[][], clusters: EMCluster[]): number[][] | null {
    const n = X.length;
    const k = clusters.length;
    const R: number[][] = [];

    for (let i = 0; i < n; i++) {
      const x = X[i]!;
      const logR: number[] = clusters.map(c =>
        this.logGaussianPDF(x, c.mean, c.covar) + Math.log(Math.max(c.weight, 1e-10))
      );
      const logMax = Math.max(...logR);
      const sumExp = logR.reduce((s, lr) => s + Math.exp(lr - logMax), 0);
      if (sumExp === 0) return null;
      const logSum = logMax + Math.log(sumExp);
      R.push(logR.map(lr => Math.exp(lr - logSum)));
    }
    return R;
  }

  /**
   * M-step: update cluster parameters from responsibilities.
   */
  private mStep(X: number[][], R: number[][], d: number): EMCluster[] {
    const n = X.length;
    const k = R[0]!.length;

    const clusters: EMCluster[] = [];

    for (let j = 0; j < k; j++) {
      // Sum of responsibilities for this cluster
      let Nk = 0;
      for (let i = 0; i < n; i++) Nk += R[i]![j]!;

      if (Nk < 1e-10) {
        // Dead cluster — reinitialise with random sample
        const randIdx = Math.floor(Math.random() * n);
        clusters.push({
          mean: [...X[randIdx]!],
          covar: new Array(d).fill(0.1),
          weight: 1 / k,
          winRate: 0.5,
          sampleCount: 0,
        });
        continue;
      }

      // Update mean
      const mean = new Array(d).fill(0);
      for (let i = 0; i < n; i++) {
        for (let di = 0; di < d; di++) {
          mean[di]! += R[i]![j]! * X[i]![di]!;
        }
      }
      for (let di = 0; di < d; di++) mean[di]! /= Nk;

      // Update diagonal covariance
      const covar = new Array(d).fill(0);
      for (let i = 0; i < n; i++) {
        for (let di = 0; di < d; di++) {
          const diff = X[i]![di]! - mean[di]!;
          covar[di]! += R[i]![j]! * diff * diff;
        }
      }
      for (let di = 0; di < d; di++) {
        covar[di] = covar[di]! / Nk + CONFIG.covarRegularizer;
      }

      // Update mixing coefficient
      const weight = Nk / n;

      clusters.push({ mean, covar, weight, winRate: 0.5, sampleCount: 0 });
    }

    return clusters;
  }

  /**
   * Initialise clusters using k-means++ style centroids + uniform covariances.
   */
  private initClusters(X: number[][], k: number, d: number): EMCluster[] {
    const n = X.length;
    if (n === 0) return [];

    // k-means++ centroid selection
    const centroids: number[][] = [];
    // First centroid: random sample
    centroids.push([...X[Math.floor(Math.random() * n)]!]);

    for (let c = 1; c < k; c++) {
      // Distance from nearest centroid
      const dists = X.map(x => {
        let minDist = Infinity;
        for (const cent of centroids) {
          const dist = Math.sqrt(cent.reduce((s, v, d) => s + (x[d]! - v) ** 2, 0));
          if (dist < minDist) minDist = dist;
        }
        return minDist;
      });
      const totalDist = dists.reduce((s, d) => s + d, 0);
      if (totalDist === 0) {
        centroids.push([...X[Math.floor(Math.random() * n)]!]);
        continue;
      }
      // Weighted random selection
      let r = Math.random() * totalDist;
      for (let i = 0; i < n; i++) {
        r -= dists[i]!;
        if (r <= 0) { centroids.push([...X[i]!]); break; }
      }
    }

    // Global variance for initialisation
    const globalMean = new Array(d).fill(0);
    for (const x of X) for (let di = 0; di < d; di++) globalMean[di]! += x[di]!;
    for (let di = 0; di < d; di++) globalMean[di]! /= n;
    const globalVar = new Array(d).fill(0);
    for (const x of X) for (let di = 0; di < d; di++) globalVar[di]! += (x[di]! - globalMean[di]!) ** 2;
    for (let di = 0; di < d; di++) globalVar[di] = globalVar[di]! / n + CONFIG.covarRegularizer;

    return centroids.map(cent => ({
      mean: cent,
      covar: [...globalVar],
      weight: 1 / k,
      winRate: 0.5,
      sampleCount: 0,
    }));
  }

  // ─── Utilities ───

  /**
   * Log of multivariate Gaussian PDF (diagonal covariance).
   * log N(x | μ, Σ) = -0.5 * [d * log(2π) + Σ log(σ²_j) + Σ (x_j - μ_j)² / σ²_j]
   */
  private logGaussianPDF(x: number[], mean: number[], covar: number[]): number {
    const d = x.length;
    let logDet = 0;
    let quad = 0;
    for (let j = 0; j < d; j++) {
      const v = Math.max(covar[j]!, CONFIG.covarRegularizer);
      logDet += Math.log(v);
      const diff = x[j]! - mean[j]!;
      quad += diff * diff / v;
    }
    return -0.5 * (d * LOG_2PI + logDet + quad);
  }

  /** Compute total log-likelihood: Σ_i log Σ_k π_k N(x_i | μ_k, Σ_k)
   *  Returns the SUM (not average) over all samples — required for correct BIC. */
  private computeLogLikelihood(X: number[][], clusters: EMCluster[]): number {
    let ll = 0;
    for (const x of X) {
      const logR = clusters.map(c =>
        this.logGaussianPDF(x, c.mean, c.covar) + Math.log(Math.max(c.weight, 1e-10))
      );
      const logMax = Math.max(...logR);
      const sumExp = logR.reduce((s, lr) => s + Math.exp(lr - logMax), 0);
      ll += logMax + Math.log(sumExp);
    }
    return ll; // total log-likelihood (not averaged)
  }

  /**
   * Hard-assign each sample to its most-likely cluster (for win-rate computation).
   */
  private assignClusters(X: number[][], clusters: EMCluster[]): number[] {
    return X.map(x => {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let j = 0; j < clusters.length; j++) {
        const score = this.logGaussianPDF(x, clusters[j]!.mean, clusters[j]!.covar) + Math.log(clusters[j]!.weight);
        if (score > bestScore) { bestScore = score; bestIdx = j; }
      }
      return bestIdx;
    });
  }

  // ─── Online Normalisation ───

  /**
   * Welford's online algorithm for mean + variance.
   */
  private updateNorm(state: SymbolEMState, x: number[]): void {
    if (state.norm.mean.length === 0) {
      state.norm.mean = [...x];
      state.norm.std = new Array(x.length).fill(0);
      state.norm.count = 1;
      return;
    }
    state.norm.count++;
    for (let i = 0; i < x.length; i++) {
      const delta = x[i]! - state.norm.mean[i]!;
      state.norm.mean[i]! += delta / state.norm.count;
      const delta2 = x[i]! - state.norm.mean[i]!;
      state.norm.std[i]! += delta * delta2;
    }
  }

  /**
   * Build a human-readable explanation of the cluster assignment.
   */
  private formatClusterExplanation(
    model: EMModel,
    dominantIdx: number,
    responsibilities: number[],
    domCluster: EMCluster,
    zScores: number[],
  ): string {
    const conf = responsibilities[dominantIdx]!;
    const parts: string[] = [];

    const wr = domCluster.winRate;
    parts.push(`Cluster #${dominantIdx} (${(conf * 100).toFixed(0)}% assignment, n=${domCluster.sampleCount}, wr=${(wr * 100).toFixed(0)}%)`);

    const deviatingFeatures: string[] = [];
    for (let i = 0; i < model.featureNames.length; i++) {
      const z = zScores[i]!;
      if (z > 1.5) deviatingFeatures.push(`${model.featureNames[i]}=${(domCluster.mean[i] ?? 0).toFixed(2)} (z=${z.toFixed(1)})`);
    }
    if (deviatingFeatures.length > 0) {
      parts.push(`Key features: ${deviatingFeatures.join(', ')}`);
    }

    if (wr > 0.6) parts.push(`🟢 Favourable — ${(wr * 100).toFixed(0)}%`);
    else if (wr < 0.4) parts.push(`🔴 Unfavourable — ${(wr * 100).toFixed(0)}%`);
    else parts.push(`🟡 Neutral — ${(wr * 100).toFixed(0)}%`);

    return parts.join(' | ');
  }

  /**
   * Format cluster info for agent context injection (all symbols).
   */
  formatForAgentContext(): string {
    const parts: string[] = ['=== EM CLUSTERING ==='];
    for (const [sym, state] of this.symbols) {
      if (!state.model || state.model.clusters.length === 0) continue;
      const m = state.model;
      parts.push(`${sym}: ${m.clusters.length} clusters, ${m.totalSamples} samples, BIC=${m.bic.toFixed(1)}`);
      for (let i = 0; i < m.clusters.length; i++) {
        const c = m.clusters[i]!;
        parts.push(`  #${i}: wr=${(c.winRate * 100).toFixed(0)}% n=${c.sampleCount} π=${(c.weight * 100).toFixed(0)}%`);
      }
    }
    if (parts.length === 1) parts.push('  (no models trained yet)');
    return parts.join('\n');
  }
}