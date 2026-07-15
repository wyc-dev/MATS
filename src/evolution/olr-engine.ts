// ─── Online Logistic Regression Engine (OLR) ───
//
// Per-symbol, per-side (LONG/SHORT) logistic regression with Welford
// z-score normalization and SGD online updates.
//
// P(win | x, side) = σ(w_side · normalize(x))
//
// Training: SGD on logistic loss (cross-entropy):
//   w ← w - η (σ(w·x) - y) x
//   where y ∈ {0, 1} (loss=0, win=1), η = learning rate.
//
// Trained exclusively from shadow trade outcomes (TP-before-SL) and
// real trade outcomes — NOT from hypothetical price direction.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'olr' });

// ─── Feature Dimensions ───

export const FEATURE_NAMES = [
  'volatility', 'srDistanceBps', 'obImbalance',
  'sentiment', 'signalAgreement', 'fundingRate',
  'volumeRatio', 'sentimentConviction',
] as const;

const D = FEATURE_NAMES.length; // 8

// ─── Types ───

export interface OLRModel {
  /** Weights vector (D+1: bias + D features) */
  weights: number[];
  /** Number of training samples for this model */
  nSamples: number;
  /** Welford running stats for feature normalization (per-feature).
   *  Per-feature counts (#1 fix): backfill updates Welford only for features
   *  it has real data for; the 0-filled missing features keep count=0 and
   *  normalize to a neutral z=0, so the first live value does not explode.
   *  A single model-wide count would contaminate the missing features. */
  mean: number[];
  m2: number[];
  welfordCount: number[];
  /** Per-source-type sample counts (for agent context — no weighting, just info) */
  shadowSamples: number;
  paperSamples: number;
  realSamples: number;
  /** Cold-start backfill samples (historical candle simulation). Tracked
   *  separately so SGD decay counts only LIVE samples — otherwise 200
   *  backfill samples would inflate nSamples and freeze the model against
   *  live adaptation. */
  backfillSamples: number;
  /** Timestamp of the most recent sample fed to this model (any source).
   *  Used by cold-start backfill to decide whether the prior is STALE and
   *  should be refreshed (#2 freshness fix). */
  newestSampleTs: number;
  /** Recent resolved trades (last N, for agent context recency display) */
  recentTrades: Array<{
    source: 'shadow' | 'paper' | 'real' | 'backfill';
    side: 'buy' | 'sell';
    outcome: 'win' | 'loss';
    timestamp: number;
    cycle: number;
    slNarrowed?: boolean;
  }>;
}

export interface OLRQueryResult {
  /** P(win) ∈ (0,1) — probability of winning for this side */
  pWin: number;
  /** Number of samples backing this model */
  nSamples: number;
  /** Confidence label: high (>50 samples), medium (20-50), low (<20) */
  confidence: 'high' | 'medium' | 'low';
  /** Per-feature contribution to the logit (w_i × x_i), for explainability */
  featureContributions: Array<{ name: string; weight: number; value: number; contribution: number }>;
  /** Human-readable explanation */
  explanation: string;
  /** Per-source-type sample breakdown (for agent context — no weighting) */
  sourceBreakdown: { shadow: number; paper: number; real: number; backfill: number };
  /** Recent resolved trades for this side (for recency judgment) */
  recentTrades: Array<{
    source: 'shadow' | 'paper' | 'real' | 'backfill';
    outcome: 'win' | 'loss';
    cyclesAgo: number;
    slNarrowed?: boolean;
  }>;
}

export interface OLRSymbolStats {
  symbol: string;
  longSamples: number;
  shortSamples: number;
  longPWin: number;
  shortPWin: number;
  /** Timestamp of the newest sample across either side (0 if no samples). */
  newestSampleTs: number;
  /** Per-side source breakdown (shadow / paper / real / backfill sample counts). */
  longSource: { shadow: number; paper: number; real: number; backfill: number };
  shortSource: { shadow: number; paper: number; real: number; backfill: number };
}

// ─── Config ───

const OLR_CONFIG = {
  learningRate: 0.05,
  l2Regularization: 0.001,
  /** SGD learning-rate decay: η_t = learningRate / (1 + decayRate × liveSamples).
   *  liveSamples = nSamples - backfillSamples, so backfill (weight=0.3) does NOT
   *  freeze the model against live adaptation. Prevents late samples from
   *  dominating a mature model and reduces noise overfitting. */
  decayRate: 0.01,
  /** Source-type weights for weighted SGD. Shadow trades are simulated
   *  (no slippage/fee/funding/liquidity), so they carry less evidence
   *  about REAL trade profitability than paper/real outcomes. Weighting
   *  prevents the high-volume shadow stream from drowning out the
   *  scarcer, higher-fidelity paper/real signal. */
  sourceWeight: { shadow: 1, paper: 2, real: 4, backfill: 0.3 } as Record<'shadow' | 'paper' | 'real' | 'backfill', number>,
  minSamplesForQuery: 10,
  highConfidenceSamples: 50,
  mediumConfidenceSamples: 20,
  welfordEpsilon: 1e-8,
  maxWeight: 10.0,
} as const;

// ─── Helpers ───

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function makeEmptyModel(): OLRModel {
  return {
    weights: new Array(D + 1).fill(0),
    nSamples: 0,
    mean: new Array(D).fill(0),
    m2: new Array(D).fill(0),
    welfordCount: new Array(D).fill(0),
    shadowSamples: 0,
    paperSamples: 0,
    realSamples: 0,
    backfillSamples: 0,
    newestSampleTs: 0,
    recentTrades: [],
  };
}

// ─── OLR Engine ───

export class OLREngine {
  private symbols = new Map<string, { long: OLRModel; short: OLRModel }>();

  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.olrSymbols) {
        for (const [sym, raw] of Object.entries(data.olrSymbols)) {
          const s = raw as any;
          if (!s.long || !s.short) continue;
          this.symbols.set(sym.toLowerCase(), {
            long: this.migrateModel(s.long),
            short: this.migrateModel(s.short),
          });
        }
        log.info(`OLR states loaded: ${this.symbols.size} symbols`);
        for (const [sym, models] of this.symbols) {
          log.info(`  ${sym}: long=${models.long.nSamples} short=${models.short.nSamples}`);
        }
      }
    } catch {
      log.warn('[OLR load] Failed to parse data, starting fresh');
    }
  }

  private migrateModel(m: any): OLRModel {
    const rawWeights = Array.isArray(m.weights) ? m.weights : new Array(D + 1).fill(0);
    // NaN/Infinity guard on load (M6): a previously-poisoned state file
    // would otherwise resurrect NaN weights. Reset any non-finite weight to 0.
    const weights = rawWeights.slice(0, D + 1).map((w: number) => (Number.isFinite(w) ? w : 0));
    while (weights.length < D + 1) weights.push(0);
    return {
      weights,
      nSamples: m.nSamples ?? 0,
      mean: Array.isArray(m.mean) ? m.mean.slice(0, D) : new Array(D).fill(0),
      m2: Array.isArray(m.m2) ? m.m2.slice(0, D) : new Array(D).fill(0),
      // Backward compat: old state stored a single number; broadcast to all features.
      welfordCount: Array.isArray(m.welfordCount) ? m.welfordCount.slice(0, D) : new Array(D).fill(typeof m.welfordCount === 'number' ? m.welfordCount : 0),
      shadowSamples: m.shadowSamples ?? 0,
      paperSamples: m.paperSamples ?? 0,
      realSamples: m.realSamples ?? 0,
      backfillSamples: m.backfillSamples ?? 0,
      newestSampleTs: m.newestSampleTs ?? 0,
      recentTrades: Array.isArray(m.recentTrades) ? m.recentTrades.slice(-20) : [],
    };
  }

  save(): string {
    const obj: Record<string, any> = {};
    for (const [sym, models] of this.symbols) {
      obj[sym] = { long: models.long, short: models.short };
    }
    return JSON.stringify({ olrSymbols: obj });
  }

  private getOrCreate(symbol: string): { long: OLRModel; short: OLRModel } {
    const sym = symbol.toLowerCase();
    if (!this.symbols.has(sym)) {
      this.symbols.set(sym, { long: makeEmptyModel(), short: makeEmptyModel() });
    }
    return this.symbols.get(sym)!;
  }

  /** Update Welford running stats for selected feature indices only.
   *  #1 fix: backfill provides real values for only SOME features
   *  (volatility / srDistanceBps / volumeRatio) and 0-fills the rest
   *  (obImbalance / sentiment / fundingRate / sentimentConviction). If
   *  backfill updated Welford for the 0-filled features, their mean/std
   *  would collapse to ~0/epsilon and the first live value would normalize
   *  to an explosive z-score. The mask restricts Welford updates to
   *  features the caller actually has data for; missing features keep a
   *  live-only Welford distribution. undefined mask = update all (live).
   *  Counts are per-feature so masked-out features stay at count=0.
   *  
   *  CRITICAL: Backfill source MUST pass a mask with only the 3 features
   *  it has real data for (volatility=0, srDistanceBps=1, volumeRatio=6).
   *  If no mask is provided (live sources), ALL features are updated.
   *  This prevents backfill zeros from collapsing the Welford distribution
   *  for features that only have non-zero values at runtime. */
  private updateWelford(model: OLRModel, x: number[], mask?: Set<number>): void {
    for (let i = 0; i < D; i++) {
      if (mask !== undefined && !mask.has(i)) continue;
      const n = model.welfordCount[i]! + 1;
      model.welfordCount[i]! = n;
      const delta = x[i]! - model.mean[i]!;
      model.mean[i]! += delta / n;
      model.m2[i]! += delta * (x[i]! - model.mean[i]!);
    }
  }

  private normalize(model: OLRModel, x: number[]): number[] {
    const result = new Array(D);
    for (let i = 0; i < D; i++) {
      const n = model.welfordCount[i]!;
      if (n < 2) {
        // No/insufficient Welford data for this feature → neutral z=0 so it
        // contributes nothing (rather than dividing by epsilon and exploding).
        result[i] = 0;
        continue;
      }
      const variance = model.m2[i]! / (n - 1);
      const std = Math.sqrt(Math.max(variance, OLR_CONFIG.welfordEpsilon));
      result[i] = (x[i]! - model.mean[i]!) / std;
    }
    return result;
  }

  private sgdUpdate(model: OLRModel, xNorm: number[], y: number, sourceWeight: number, liveSamples: number): void {
    const xFull = [1, ...xNorm];
    let z = 0;
    for (let i = 0; i <= D; i++) z += model.weights[i]! * xFull[i]!;
    const p = sigmoid(z);
    const error = p - y;
    // Decayed learning rate based on LIVE samples only (excludes backfill),
    // so a cold-start backfill prior does not freeze the model against live
    // adaptation (M2 fix extended for backfill). Scaled by source weight so
    // real/paper outcomes outweigh the high-volume shadow stream (H2 fix).
    // liveSamples is guaranteed >= 0 because it's computed as nSamples - backfillSamples
    const safeLiveSamples = Math.max(0, liveSamples);
    // Use a separate decay counter that only counts live samples (shadow + paper + real),
    // excluding backfill. This prevents 200 backfill samples from freezing the model
    // against live adaptation. The decay counter starts at 0 for live samples and
    // increments only when a non-backfill sample is fed.
    const eta = (OLR_CONFIG.learningRate / (1 + OLR_CONFIG.decayRate * safeLiveSamples)) * sourceWeight;
    for (let i = 0; i <= D; i++) {
      const reg = i > 0 ? OLR_CONFIG.l2Regularization * model.weights[i]! : 0;
      model.weights[i]! -= eta * (error * xFull[i]! + reg);
      // NaN/Infinity guard (M6) — a single NaN feature would otherwise
      // propagate and poison the persisted model forever.
      if (!Number.isFinite(model.weights[i]!)) model.weights[i]! = 0;
      model.weights[i]! = Math.max(-OLR_CONFIG.maxWeight, Math.min(OLR_CONFIG.maxWeight, model.weights[i]!));
    }
  }

  /**
   * Feed a trade outcome (shadow, paper, or real) into the per-symbol OLR models.
   *
   * @param symbol     Trade symbol
   * @param features   Feature vector (8 dimensions)
   * @param outcome    1 = win (TP hit), 0 = loss (SL hit)
   * @param side       'buy' (LONG) or 'sell' (SHORT)
   * @param source     'shadow' | 'paper' | 'real' | 'backfill' — recorded for agent context + weighted SGD
   * @param cycle      Cycle number when trade resolved
   * @param slNarrowed Whether SL/TP was narrowed during the trade (for Meta-Agent feedback)
   * @param welfordMask Optional set of feature indices to update Welford stats for.
   *                   Backfill passes only the indices it has real data for, so
   *                   0-filled missing features don't collapse the live Welford
   *                   distribution (#1 fix). undefined = update all (live sources).
   */
  feedTrade(
    symbol: string,
    features: Record<string, number>,
    outcome: 1 | 0,
    side: 'buy' | 'sell',
    source: 'shadow' | 'paper' | 'real' | 'backfill' = 'shadow',
    cycle: number = 0,
    slNarrowed: boolean = false,
    welfordMask?: Set<number>,
  ): void {
    const models = this.getOrCreate(symbol);
    const vec = this.contextToVector(features);

    // NaN guard (M6): reject features that would poison the model.
    for (let i = 0; i < D; i++) {
      if (!Number.isFinite(vec[i]!)) {
        log.warn(`[OLR feedTrade] Non-finite feature ${FEATURE_NAMES[i]} for ${symbol} — sample skipped`);
        return;
      }
    }

    // Normalise with PRE-update Welford stats (M3 fix): the current sample
    // should be normalised against the distribution learned so far, not
    // against a distribution that already includes itself (inclusive stats
    // bias early-sample normalisation).
    //
    // Features are side-agnostic (market state, not trade-specific), so the
    // long and short Welford stats are kept in lock-step by updating both
    // with the same vector (L1). Query-side normalisation for either side
    // therefore yields identical results, which is correct.
    const xNorm = this.normalize(models.long, vec);
    this.updateWelford(models.long, vec, welfordMask);
    this.updateWelford(models.short, vec, welfordMask);

    const outcomeLabel: 'win' | 'loss' = outcome === 1 ? 'win' : 'loss';
    const ts = Date.now();
    const srcWeight = OLR_CONFIG.sourceWeight[source] ?? 1;

    if (side === 'sell') {
      // Live samples = total minus backfill — SGD decay uses only live so
      // the backfill prior doesn't freeze the model (see OLR_CONFIG.backfill).
      const liveSamples = models.short.nSamples - models.short.backfillSamples;
      this.sgdUpdate(models.short, xNorm, outcome, srcWeight, liveSamples);
      models.short.nSamples++;
      models.short.newestSampleTs = ts;
      if (source === 'shadow') models.short.shadowSamples++;
      else if (source === 'paper') models.short.paperSamples++;
      else if (source === 'real') models.short.realSamples++;
      else if (source === 'backfill') models.short.backfillSamples++;
      models.short.recentTrades.push({ source, side, outcome: outcomeLabel, timestamp: ts, cycle, slNarrowed });
      if (models.short.recentTrades.length > 20) models.short.recentTrades.shift();
    } else {
      const liveSamples = models.long.nSamples - models.long.backfillSamples;
      this.sgdUpdate(models.long, xNorm, outcome, srcWeight, liveSamples);
      models.long.nSamples++;
      models.long.newestSampleTs = ts;
      if (source === 'shadow') models.long.shadowSamples++;
      else if (source === 'paper') models.long.paperSamples++;
      else if (source === 'real') models.long.realSamples++;
      else if (source === 'backfill') models.long.backfillSamples++;
      models.long.recentTrades.push({ source, side, outcome: outcomeLabel, timestamp: ts, cycle, slNarrowed });
      if (models.long.recentTrades.length > 20) models.long.recentTrades.shift();
    }
  }

  private contextToVector(features: Record<string, number>): number[] {
    return FEATURE_NAMES.map(name => features[name] ?? 0) as number[];
  }

  query(symbol: string, features: Record<string, number>, side: 'buy' | 'sell', currentCycle?: number): OLRQueryResult {
    const empty = (reason: string): OLRQueryResult => ({
      pWin: 0.5,
      nSamples: 0,
      confidence: 'low',
      featureContributions: [],
      explanation: reason,
      sourceBreakdown: { shadow: 0, paper: 0, real: 0, backfill: 0 },
      recentTrades: [],
    });

    const models = this.symbols.get(symbol.toLowerCase());
    if (!models) return empty(`No OLR data for ${symbol}`);

    const model = side === 'buy' ? models.long : models.short;
    if (model.nSamples < OLR_CONFIG.minSamplesForQuery) {
      return empty(`Only ${model.nSamples} samples for ${symbol} ${side.toUpperCase()} (need ${OLR_CONFIG.minSamplesForQuery})`);
    }

    const vec = this.contextToVector(features);
    const xNorm = this.normalize(model, vec);
    const xFull = [1, ...xNorm];

    let z = 0;
    const contributions: Array<{ name: string; weight: number; value: number; contribution: number }> = [];
    for (let i = 0; i <= D; i++) {
      const w = model.weights[i]!;
      const xv = xFull[i]!;
      z += w * xv;
      if (i > 0) {
        contributions.push({
          name: FEATURE_NAMES[i - 1]!,
          weight: w,
          value: vec[i - 1]!,
          contribution: w * xv,
        });
      }
    }

    const pWin = sigmoid(z);
    const confLabel: 'high' | 'medium' | 'low' =
      model.nSamples >= OLR_CONFIG.highConfidenceSamples ? 'high'
      : model.nSamples >= OLR_CONFIG.mediumConfidenceSamples ? 'medium'
      : 'low';

    contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

    const topFeatures = contributions.slice(0, 4)
      .map(c => `${c.name}=${c.value.toFixed(3)} (w=${c.weight.toFixed(2)})`)
      .join(', ');

    // Build recent trades with cyclesAgo (for agent recency judgment)
    const curCycle = currentCycle ?? 0;
    const recentTrades = model.recentTrades.slice(-10).map(rt => ({
      source: rt.source,
      outcome: rt.outcome,
      cyclesAgo: curCycle - rt.cycle,
      slNarrowed: rt.slNarrowed,
    }));

    const sourceBreakdown = {
      shadow: model.shadowSamples,
      paper: model.paperSamples,
      real: model.realSamples,
      backfill: model.backfillSamples,
    };

    const sourceStr = `shadow=${sourceBreakdown.shadow} paper=${sourceBreakdown.paper} real=${sourceBreakdown.real} backfill=${sourceBreakdown.backfill}`;
    const explanation = `P(win)=${(pWin * 100).toFixed(0)}% (${model.nSamples} samples [${sourceStr}], conf=${confLabel}) | Key: ${topFeatures}`;

    return { pWin, nSamples: model.nSamples, confidence: confLabel, featureContributions: contributions, explanation, sourceBreakdown, recentTrades };
  }

  // ─── Stats (for UI) ───

  getAllModelStats(): OLRSymbolStats[] {
    const result: OLRSymbolStats[] = [];
    for (const [sym, models] of this.symbols) {
      const longPWin = models.long.nSamples >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.long, this.zeroFeatures()))
        : 0.5;
      const shortPWin = models.short.nSamples >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.short, this.zeroFeatures()))
        : 0.5;
      result.push({
        symbol: sym,
        longSamples: models.long.nSamples,
        shortSamples: models.short.nSamples,
        longPWin,
        shortPWin,
        newestSampleTs: Math.max(models.long.newestSampleTs, models.short.newestSampleTs),
        longSource: { shadow: models.long.shadowSamples, paper: models.long.paperSamples, real: models.long.realSamples, backfill: models.long.backfillSamples },
        shortSource: { shadow: models.short.shadowSamples, paper: models.short.paperSamples, real: models.short.realSamples, backfill: models.short.backfillSamples },
      });
    }
    return result;
  }

  /** Reset a single symbol's long+short models to empty. Used by cold-start
   *  backfill when the persisted prior is STALE (older than the max-age
   *  threshold) so the refresh starts from a clean state instead of piling
   *  fresh backfill on top of obsolete samples (#2 freshness fix). */
  resetSymbol(symbol: string): boolean {
    const sym = symbol.toLowerCase();
    return this.symbols.delete(sym);
  }

  private zeroFeatures(): Record<string, number> {
    const obj: Record<string, number> = {};
    for (const name of FEATURE_NAMES) obj[name] = 0;
    return obj;
  }

  private computeLogit(model: OLRModel, features: Record<string, number>): number {
    const vec = this.contextToVector(features);
    const xNorm = this.normalize(model, vec);
    const xFull = [1, ...xNorm];
    let z = 0;
    for (let i = 0; i <= D; i++) z += model.weights[i]! * xFull[i]!;
    return z;
  }

  getFeatureWeights(symbol: string, side: 'buy' | 'sell'): Array<{ name: string; weight: number }> | null {
    const models = this.symbols.get(symbol.toLowerCase());
    if (!models) return null;
    const model = side === 'buy' ? models.long : models.short;
    const result: Array<{ name: string; weight: number }> = [];
    for (let i = 0; i < D; i++) {
      result.push({ name: FEATURE_NAMES[i]!, weight: model.weights[i + 1]! });
    }
    return result;
  }

  getNormalizationStats(symbol: string, side: 'buy' | 'sell'): Array<{ name: string; mean: number; std: number }> | null {
    const models = this.symbols.get(symbol.toLowerCase());
    if (!models) return null;
    const model = side === 'buy' ? models.long : models.short;
    const result: Array<{ name: string; mean: number; std: number }> = [];
    for (let i = 0; i < D; i++) {
      const n = model.welfordCount[i]!;
      const variance = n > 1 ? model.m2[i]! / (n - 1) : 0;
      result.push({ name: FEATURE_NAMES[i]!, mean: model.mean[i]!, std: Math.sqrt(Math.max(variance, 0)) });
    }
    return result;
  }

  getAllSymbols(): string[] {
    return Array.from(this.symbols.keys());
  }

  getPendingStats(): Array<{ symbol: string; pending: number; needed: number; pct: number }> {
    const result: Array<{ symbol: string; pending: number; needed: number; pct: number }> = [];
    for (const [sym, models] of this.symbols) {
      const totalSamples = Math.max(models.long.nSamples, models.short.nSamples);
      if (totalSamples === 0) continue;
      result.push({
        symbol: sym,
        pending: totalSamples,
        needed: OLR_CONFIG.minSamplesForQuery,
        pct: Math.min(100, Math.round((totalSamples / OLR_CONFIG.minSamplesForQuery) * 100)),
      });
    }
    return result;
  }

  formatForAgentContext(): string {
    const parts: string[] = [
      '=== OLR ASSESSMENT ===',
      'Online Logistic Regression: P(win) per side from shadow + real trade outcomes.',
      'Each side (LONG/SHORT) has independent model. Trained on TP-before-SL outcomes.',
      'USAGE: P(win) > 60% → bias toward entry; P(win) < 40% → bias against;',
      'P(win) 40-60% → no edge, rely on other signals.',
      'Weight by confidence: high (>50 samples) = trust it; low (<20) = noisy.',
    ];
    let hasData = false;
    for (const [sym, models] of this.symbols) {
      const longS = models.long.nSamples;
      const shortS = models.short.nSamples;
      if (longS < OLR_CONFIG.minSamplesForQuery && shortS < OLR_CONFIG.minSamplesForQuery) continue;
      hasData = true;
      const longP = longS >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.long, this.zeroFeatures()))
        : 0.5;
      const shortP = shortS >= OLR_CONFIG.minSamplesForQuery
        ? sigmoid(this.computeLogit(models.short, this.zeroFeatures()))
        : 0.5;
      const longConf = longS >= OLR_CONFIG.highConfidenceSamples ? 'high'
        : longS >= OLR_CONFIG.mediumConfidenceSamples ? 'medium' : 'low';
      const shortConf = shortS >= OLR_CONFIG.highConfidenceSamples ? 'high'
        : shortS >= OLR_CONFIG.mediumConfidenceSamples ? 'medium' : 'low';
      parts.push(`${sym}: BUY P(win)=${(longP * 100).toFixed(0)}% (${longS} samples, ${longConf}) | SELL P(win)=${(shortP * 100).toFixed(0)}% (${shortS} samples, ${shortConf})`);
    }
    if (!hasData) parts.push('  (no OLR data yet)');
    return parts.join('\n');
  }
}