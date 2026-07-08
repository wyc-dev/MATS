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
  /** Welford running stats for feature normalization */
  mean: number[];
  m2: number[];
  /** Total count for Welford */
  welfordCount: number;
  /** Per-source-type sample counts (for agent context — no weighting, just info) */
  shadowSamples: number;
  paperSamples: number;
  realSamples: number;
  /** Recent resolved trades (last N, for agent context recency display) */
  recentTrades: Array<{
    source: 'shadow' | 'paper' | 'real';
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
  sourceBreakdown: { shadow: number; paper: number; real: number };
  /** Recent resolved trades for this side (for recency judgment) */
  recentTrades: Array<{
    source: 'shadow' | 'paper' | 'real';
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
}

// ─── Config ───

const OLR_CONFIG = {
  learningRate: 0.05,
  l2Regularization: 0.001,
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
    welfordCount: 0,
    shadowSamples: 0,
    paperSamples: 0,
    realSamples: 0,
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
    const weights = Array.isArray(m.weights) ? m.weights : new Array(D + 1).fill(0);
    while (weights.length < D + 1) weights.push(0);
    return {
      weights: weights.slice(0, D + 1),
      nSamples: m.nSamples ?? 0,
      mean: Array.isArray(m.mean) ? m.mean.slice(0, D) : new Array(D).fill(0),
      m2: Array.isArray(m.m2) ? m.m2.slice(0, D) : new Array(D).fill(0),
      welfordCount: m.welfordCount ?? 0,
      shadowSamples: m.shadowSamples ?? 0,
      paperSamples: m.paperSamples ?? 0,
      realSamples: m.realSamples ?? 0,
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

  private updateWelford(model: OLRModel, x: number[]): void {
    model.welfordCount++;
    const n = model.welfordCount;
    for (let i = 0; i < D; i++) {
      const delta = x[i]! - model.mean[i]!;
      model.mean[i]! += delta / n;
      model.m2[i]! += delta * (x[i]! - model.mean[i]!);
    }
  }

  private normalize(model: OLRModel, x: number[]): number[] {
    const result = new Array(D);
    const n = model.welfordCount;
    for (let i = 0; i < D; i++) {
      const variance = n > 1 ? model.m2[i]! / (n - 1) : 1;
      const std = Math.sqrt(Math.max(variance, OLR_CONFIG.welfordEpsilon));
      result[i] = (x[i]! - model.mean[i]!) / std;
    }
    return result;
  }

  private sgdUpdate(model: OLRModel, xNorm: number[], y: number): void {
    const xFull = [1, ...xNorm];
    let z = 0;
    for (let i = 0; i <= D; i++) z += model.weights[i]! * xFull[i]!;
    const p = sigmoid(z);
    const error = p - y;
    for (let i = 0; i <= D; i++) {
      const reg = i > 0 ? OLR_CONFIG.l2Regularization * model.weights[i]! : 0;
      model.weights[i]! -= OLR_CONFIG.learningRate * (error * xFull[i]! + reg);
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
   * @param source     'shadow' | 'paper' | 'real' — recorded for agent context (no weighting)
   * @param cycle      Cycle number when trade resolved
   * @param slNarrowed Whether SL/TP was narrowed during the trade (for Meta-Agent feedback)
   */
  feedTrade(
    symbol: string,
    features: Record<string, number>,
    outcome: 1 | 0,
    side: 'buy' | 'sell',
    source: 'shadow' | 'paper' | 'real' = 'shadow',
    cycle: number = 0,
    slNarrowed: boolean = false,
  ): void {
    const models = this.getOrCreate(symbol);
    const vec = this.contextToVector(features);

    this.updateWelford(models.long, vec);
    this.updateWelford(models.short, vec);

    const xNorm = this.normalize(models.long, vec);
    const outcomeLabel: 'win' | 'loss' = outcome === 1 ? 'win' : 'loss';
    const ts = Date.now();

    if (side === 'sell') {
      this.sgdUpdate(models.short, xNorm, outcome);
      models.short.nSamples++;
      if (source === 'shadow') models.short.shadowSamples++;
      else if (source === 'paper') models.short.paperSamples++;
      else models.short.realSamples++;
      models.short.recentTrades.push({ source, side, outcome: outcomeLabel, timestamp: ts, cycle, slNarrowed });
      if (models.short.recentTrades.length > 20) models.short.recentTrades.shift();
    } else {
      this.sgdUpdate(models.long, xNorm, outcome);
      models.long.nSamples++;
      if (source === 'shadow') models.long.shadowSamples++;
      else if (source === 'paper') models.long.paperSamples++;
      else models.long.realSamples++;
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
      sourceBreakdown: { shadow: 0, paper: 0, real: 0 },
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
    };

    const sourceStr = `shadow=${sourceBreakdown.shadow} paper=${sourceBreakdown.paper} real=${sourceBreakdown.real}`;
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
      });
    }
    return result;
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
    const n = model.welfordCount;
    const result: Array<{ name: string; mean: number; std: number }> = [];
    for (let i = 0; i < D; i++) {
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