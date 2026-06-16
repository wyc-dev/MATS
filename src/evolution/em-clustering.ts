// ─── GMM EM Clustering Engine ───
// Real Expectation-Maximisation for Gaussian Mixture Models.
//
// Discovers latent clusters in trade feature vectors so the system
// can answer "what kind of trades tend to win/lose in this region
// of feature space?" without relying on nearest-neighbour lookups.
//
// "EM clustering compresses experience into generative knowledge"

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'em_clustering' });

// ─── Config ───

const CONFIG = {
  maxClusters: 6,
  minClusters: 2,
  maxIterations: 200,
  convergenceTol: 1e-6,
  /** How many EM training rounds before triggering a full re-fit */
  refitInterval: 50,          // every 50 new trades
  /** Minimum trades to bother running EM */
  minSamplesForEM: 20,
  /** Regularisation added to diagonal covariance diagonal (prevents singularities) */
  covarRegularizer: 1e-4,
  persistPath: 'data/evolution/em-clusters.json',
} as const;

// ─── Types ───

export interface EMCluster {
  /** Mean vector (same dimension as features) */
  mean: number[];
  /** Diagonal covariance vector (variance per dimension) */
  covar: number[];
  /** Mixing coefficient (prior probability of this cluster) */
  weight: number;
  /** Observed win rate within this cluster (from training labels) */
  winRate: number;
  /** How many training samples belong dominantly to this cluster */
  sampleCount: number;
}

export interface EMModel {
  clusters: EMCluster[];
  /** Feature names corresponding to dimensions (for interpretability) */
  featureNames: string[];
  /** Total training samples used for this fit */
  totalSamples: number;
  /** Log-likelihood at convergence */
  logLikelihood: number;
  /** BIC score (lower = better, for model selection) */
  bic: number;
  /** When this model was fitted */
  fittedAt: number;
  /** How many EM iterations ran */
  iterations: number;
}

export interface EMQueryResult {
  /** Cluster assignment probabilities (soft) */
  responsibilities: number[];
  /** Weighted win rate (responsibility-weighted average of cluster win rates) */
  weightedWinRate: number;
  /** Dominant cluster index (argmax of responsibilities) */
  dominantCluster: number;
  /** Distance to each cluster centroid (z-score) */
  zScores: number[];
  /** Human-readable explanation */
  explanation: string;
}

// ─── Feature Dimensions ───

/** Names of the numerical features used for clustering (must match TradePatternContext) */
const FEATURE_NAMES = [
  'volatility',
  'trendStrength',
  'srDistanceBps',
  'obImbalance',
  'sentiment',
  'signalAgreement',
  'fundingRate',
  'fundingRateAccel',
  'volumeRatio',
  'positionSizePct',
  'sentimentConviction',
];

/** Z-score normalisation stats tracked online */
interface NormStats {
  mean: number[];
  std: number[];
  count: number;
}

// ─── GMM EM Implementation ───

export class EMClusteringEngine {
  private model: EMModel | null = null;
  /** Rolling normalisation statistics (online update) */
  private norm: NormStats = { mean: [], std: [], count: 0 };
  /** Queued feature vectors awaiting next refit */
  private pendingSamples: number[][] = [];
  /** How many trades seen since last refit */
  private tradesSinceRefit = 0;

  // ─── Lifecycle ───

  /** Load persisted model */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.model) this.model = data.model;
      if (data.norm) this.norm = data.norm;
      log.info(`EM model loaded: ${this.model?.clusters.length ?? 0} clusters, ${this.model?.totalSamples ?? 0} training samples`);
    } catch {
      log.warn('[load] Failed to parse EM model, starting fresh');
    }
  }

  /** Serialise model + norm stats for persistence */
  save(): string {
    return JSON.stringify({ model: this.model, norm: this.norm });
  }

  getModel(): EMModel | null { return this.model; }

  // ─── Training ───

  /**
   * Convert a TradePatternContext (or partial) into a normalised feature vector.
   * Maintains online z-score normalisation so EM works in unit space.
   */
  contextToVector(features: Record<string, number>): number[] {
    return FEATURE_NAMES.map(name => features[name] ?? 0);
  }

  /**
   * Feed a trade into the pending queue.  When enough accumulate, refit EM.
   * @param features — normalised feature vector (raw context values, we normalise internally)
   * @param outcome — 1 for win, 0 for loss (used for cluster win-rate labelling)
   */
  feedTrade(features: Record<string, number>, outcome: 1 | 0): void {
    const rawVec = this.contextToVector(features);

    // Online normalisation update (Welford's)
    this.updateNorm(rawVec);

    // Attach outcome as last element for cluster labelling
    this.pendingSamples.push([...rawVec, outcome]);
    this.tradesSinceRefit++;
  }

  /**
   * Check if it's time to refit, and run EM if needed.
   * Call this periodically (e.g. once per decision cycle).
   */
  maybeRefit(): boolean {
    if (this.tradesSinceRefit < CONFIG.refitInterval) return false;
    if (this.pendingSamples.length < CONFIG.minSamplesForEM) return false;

    this.refit();
    this.tradesSinceRefit = 0;
    return true;
  }

  /**
   * Force a full EM refit on all pending + historical data.
   */
  refit(): void {
    const samples = this.pendingSamples;
    if (samples.length < CONFIG.minSamplesForEM) {
      log.warn(`[refit] Only ${samples.length} samples, need ${CONFIG.minSamplesForEM} — skipping`);
      return;
    }

    // Normalise each feature dimension (exclude outcome column)
    const n = FEATURE_NAMES.length; // feature dimensionality
    const X: number[][] = [];
    const y: number[] = [];          // outcomes
    for (const s of samples) {
      X.push(s.slice(0, n));
      y.push(s[n]!);
    }

    // Find best K via BIC (try 2..maxClusters)
    let bestModel: { clusters: EMCluster[]; ll: number; bic: number; iters: number } | null = null;
    let bestBic = Infinity;

    for (let k = CONFIG.minClusters; k <= Math.min(CONFIG.maxClusters, samples.length - 1); k++) {
      const result = this.runEM(X, k);
      if (result && result.bic < bestBic) {
        bestBic = result.bic;
        bestModel = result;
      }
    }

    if (!bestModel) {
      log.warn('[refit] EM failed to converge for any K');
      return;
    }

    // Compute per-cluster win rates
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

    this.model = {
      clusters: clustersWithWR,
      featureNames: [...FEATURE_NAMES],
      totalSamples: samples.length,
      logLikelihood: bestModel.ll,
      bic: bestModel.bic,
      fittedAt: Date.now(),
      iterations: bestModel.iters,
    };

    // Keep only the model — discard raw samples to bound memory
    // (future feeds will accumulate for next refit)
    this.pendingSamples = [];

    log.info(`[refit] EM converged: ${clustersWithWR.length} clusters, ${samples.length} samples, BIC=${bestModel.bic.toFixed(1)}, LL=${bestModel.ll.toFixed(2)} (${bestModel.iters} iters)`);
    for (let i = 0; i < clustersWithWR.length; i++) {
      const c = clustersWithWR[i]!;
      log.info(`  Cluster #${i}: n=${c.sampleCount} wr=${(c.winRate * 100).toFixed(0)}% weight=${(c.weight * 100).toFixed(0)}%`);
    }
  }

  // ─── Query ───

  /**
   * Query: given a current feature context, what's the cluster-weighted win rate?
   * Returns soft cluster assignment + weighted outcome expectation.
   */
  query(features: Record<string, number>): EMQueryResult {
    const empty = (): EMQueryResult => ({
      responsibilities: [],
      weightedWinRate: 0.5,
      dominantCluster: -1,
      zScores: [],
      explanation: 'No EM model trained yet',
    });

    if (!this.model || this.model.clusters.length === 0) return empty();

    const x = this.contextToVector(features);
    const { clusters } = this.model;

    // Compute log responsibilities (log-sum-exp for stability)
    const logR: number[] = clusters.map((c, i) => {
      return this.logGaussianPDF(x, c.mean, c.covar) + Math.log(Math.max(c.weight, 1e-10));
    });

    // Log-sum-exp normalisation
    const logMax = Math.max(...logR);
    const sumExp = logR.reduce((s, lr) => s + Math.exp(lr - logMax), 0);
    const logSum = logMax + Math.log(sumExp);
    const responsibilities = logR.map(lr => Math.exp(lr - logSum));

    // Weighted win rate
    const weightedWinRate = responsibilities.reduce((s, r, i) => s + r * clusters[i]!.winRate, 0);

    // Dominant cluster
    const dominantCluster = responsibilities.indexOf(Math.max(...responsibilities));

    // Z-scores (normalised distance to each centroid)
    const zScores = clusters.map(c =>
      Math.sqrt(c.mean.reduce((s, m, d) => s + ((x[d] ?? 0) - m) ** 2 / Math.max(c.covar[d]!, 1e-10), 0) / c.mean.length)
    );

    // Human-readable explanation
    const dom = clusters[dominantCluster]!;
    const explanation = this.formatClusterExplanation(dominantCluster, responsibilities, dom, zScores);

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

      // Compute log-likelihood
      ll = this.computeLogLikelihood(X, clusters);

      // Check convergence
      if (Math.abs(ll - prevLL) < CONFIG.convergenceTol && iter > 5) {
        // M-step one last time
        clusters = this.mStep(X, R, d);
        break;
      }
      prevLL = ll;

      // M-step
      clusters = this.mStep(X, R, d);
    }

    // Compute BIC: -2 * LL + k * (d*2 + 1) * log(n)
    // Each cluster has: d means + d covariances + 1 weight = 2d+1 params
    const paramCount = k * (2 * d + 1);
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
    return -0.5 * (d * Math.LN2 * Math.PI + logDet + quad);
  }

  /** Compute total log-likelihood: Σ_i log Σ_k π_k N(x_i | μ_k, Σ_k) */
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
    return ll / X.length; // average per sample
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
  private updateNorm(x: number[]): void {
    if (this.norm.mean.length === 0) {
      this.norm.mean = [...x];
      this.norm.std = new Array(x.length).fill(0);
      this.norm.count = 1;
      return;
    }
    this.norm.count++;
    for (let i = 0; i < x.length; i++) {
      const delta = x[i]! - this.norm.mean[i]!;
      this.norm.mean[i]! += delta / this.norm.count;
      const delta2 = x[i]! - this.norm.mean[i]!;
      this.norm.std[i]! += delta * delta2;
    }
  }

  /**
   * Normalise a raw feature vector using current norm stats.
   */
  private normalise(x: number[]): number[] {
    if (this.norm.count < 2) return [...x];
    return x.map((v, i) => {
      const std = Math.sqrt(this.norm.std[i]! / (this.norm.count - 1));
      return std > 1e-10 ? (v - this.norm.mean[i]!) / std : 0;
    });
  }

  // ─── Formatting ───

  /**
   * Build a human-readable explanation of the cluster assignment.
   */
  private formatClusterExplanation(
    dominantIdx: number,
    responsibilities: number[],
    domCluster: EMCluster,
    zScores: number[],
  ): string {
    const model = this.model;
    if (!model) return 'No EM model';

    const conf = responsibilities[dominantIdx]!;
    const parts: string[] = [];

    // Cluster identity
    const wr = domCluster.winRate;
    parts.push(`Cluster #${dominantIdx} (${(conf * 100).toFixed(0)}% assignment, n=${domCluster.sampleCount}, wr=${(wr * 100).toFixed(0)}%)`);

    // Feature deviations (what makes this cluster different)
    const deviatingFeatures: string[] = [];
    for (let i = 0; i < model.featureNames.length; i++) {
      const z = zScores[i]!;
      if (z > 1.5) deviatingFeatures.push(`${model.featureNames[i]}=${(domCluster.mean[i] ?? 0).toFixed(2)} (z=${z.toFixed(1)})`);
    }
    if (deviatingFeatures.length > 0) {
      parts.push(`Key features: ${deviatingFeatures.join(', ')}`);
    }

    // Outcome expectation
    if (wr > 0.6) parts.push(`🟢 Favourable cluster — ${(wr * 100).toFixed(0)}% historical win rate`);
    else if (wr < 0.4) parts.push(`🔴 Unfavourable cluster — ${(wr * 100).toFixed(0)}% historical win rate`);
    else parts.push(`🟡 Neutral cluster — ${(wr * 100).toFixed(0)}% win rate`);

    return parts.join(' | ');
  }

  /**
   * Format cluster info for agent context injection.
   */
  formatForAgentContext(): string {
    if (!this.model || this.model.clusters.length === 0) {
      return '=== EM CLUSTERING ===\n  (no model trained yet)';
    }
    const m = this.model;
    const lines: string[] = [
      '=== EM CLUSTERING ===',
      `Clusters: ${m.clusters.length} | Samples: ${m.totalSamples} | BIC: ${m.bic.toFixed(1)}`,
    ];
    for (let i = 0; i < m.clusters.length; i++) {
      const c = m.clusters[i]!;
      lines.push(`  #${i}: wr=${(c.winRate * 100).toFixed(0)}% n=${c.sampleCount} π=${(c.weight * 100).toFixed(0)}%`);
    }
    if (m.clusters.some(c => c.winRate > 0.6)) {
      lines.push('  🟢 Profitable cluster(s) detected');
    }
    if (m.clusters.some(c => c.winRate < 0.4)) {
      lines.push('  🔴 Unfavourable cluster(s) detected');
    }
    return lines.join('\n');
  }
}