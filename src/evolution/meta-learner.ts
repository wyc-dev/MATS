// ─── Meta-Learner (v2.0.840) ──────────────────────────────────────
//
// System learns HOW to learn. Adjusts learning rates, feature weights,
// and exploration priorities based on observed learning efficiency.
//
// Architecture:
//   1. Per-cell adaptive learning rate (high variance → low α)
//   2. Feature weight meta-learning (rolling predictive power → weight)
//   3. Regime learning speed tracking (fast-learning regimes → prioritize)
//   4. Curriculum: suggest which regime to explore next
//
// Theory:
//   Meta-RL (learn-to-learn): α_cell = 1/(1+n) × stabilityFactor
//   Feature weight meta-learning: w_i(t) = w_i(t-1)(1-η) + η × predictivePower_i
//   Curriculum learning: prioritize regimes with highest learning speed

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'meta-learner' });

// ─── Types ───

interface CellLearningState {
  cellKey: string;
  visits: number;
  rewardMean: number;
  rewardStd: number;
  qValueChangeRate: number;
  alphaMultiplier: number;  // [0.1, 2.0]
  lastQValue: number;
  lastUpdateCycle: number;
}

interface FeatureMetaState {
  feature: string;
  predictivePower: number;  // [-1, 1]
  weight: number;           // [0.1, 3.0]
  history: Array<{ value: number; pnlPct: number }>;
}

interface RegimeLearningSpeed {
  regime: string;
  avgLearningSpeed: number;
  cellCount: number;
  curriculumPriority: number;  // [0, 1]
}

// ─── v2.0.843: Asset-aware feature weighting ─────────────────────
//
// Different assets have fundamentally different microstructure:
//   - BTC/ETH (high-volume crypto): funding rate is a strong signal
//   - SILVER/GOLD (commodity): S/R levels dominate, funding irrelevant
//   - Low-volume alts: OB imbalance unreliable (thin book), volatility noisy
//
// The Meta-Learner now tracks per-feature predictive power SEPARATELY
// for each asset tier. When computing feature weights for OLR queries,
// it blends the asset-specific weight with the global weight:
//   effectiveWeight = α × assetSpecificWeight + (1-α) × globalWeight
// where α = min(1, assetSamples / 30) — cold-start leans on global,
// warm leans on asset-specific. This is "transfer learning" within
// the trading domain: a feature's value in one asset class informs
// its starting weight in a new asset class, then adapts.

export type AssetTier = 'crypto' | 'commodity' | 'forex' | 'equity' | 'other';

export interface AssetMetadata {
  /** Asset class — groups assets that share structural characteristics.
   *  NOTE: This does NOT imply "better" or "worse" — each tier has its own
   *  patterns. A low-volume alt (SILVER) has its own microstructure edge
   *  that BTC doesn't. The tier just controls HOW knowledge transfers. */
  category: AssetTier;
  /** Volume tier: 'high' (top-10), 'medium' (top-50), 'low' (rest).
   *  Used to tag observations for diagnostics + volume-tier-aware transfer.
   *  Low volume ≠ unreliable — it means the market microstructure is
   *  different (thin order books, fewer market makers, larger spreads). */
  volumeTier: 'high' | 'medium' | 'low';
  /** Volatility tier from market state: 'high' (>3%), 'medium' (1-3%), 'low' (<1%).
   *  Used for diagnostics + volatility-tier-aware transfer. Low vol assets
   *  have different pattern characteristics (mean-reversion vs trending). */
  volatilityTier: 'high' | 'medium' | 'low';
  /** Normalized symbol for per-symbol tracking. Each asset gets its own
   *  feature weight track, so SILVER can learn "OB imbalance works for me"
   *  independently of BTC's "funding rate works for me". The category
   *  controls cross-asset transfer; the symbol controls fine-grained
   *  adaptation. */
  symbol: string;
}

interface AssetTierFeatureState {
  /** Per-asset-tier predictive power tracking. */
  predictivePower: number;  // [-1, 1]
  weight: number;           // [0.1, 3.0]
  sampleCount: number;
}

/**
 * v2.0.843: Derive asset tier from symbol + market state.
 * Used by the shadow learning loop to pass asset metadata to the Meta-Learner
 * for per-asset-tier feature weight tracking.
 *
 * Asset tier classification:
 *   - crypto: All perpetual crypto (BTC, ETH, alts, stables). NOT split by
 *     volatility — a low-volume alt has its own patterns, not a "worse
 *     version of BTC". The tier controls transfer, not quality.
 *   - commodity: XAU, XAG, SILVER, GOLD, OIL
 *   - forex: EURUSD, USDJPY, etc.
 *   - equity: SPX, NDX, individual stocks
 *   - other: Everything else
 *
 * Volume tier from 24h volume:
 *   - high: >$100M (BTC, ETH)
 *   - medium: $1M-$100M (most alts)
 *   - low: <$1M (thin books)
 *
 * Volatility tier from market state vol:
 *   - high: >3%
 *   - medium: 1-3%
 *   - low: <1%
 */
export function deriveAssetMetadata(
  symbol: string,
  marketState?: { volume24h?: number; volatility?: number },
): AssetMetadata {
  // v2.0.843: Guard against undefined/null/empty symbol — .toUpperCase()
  // would throw TypeError on undefined. Fall back to 'UNKNOWN'.
  const s = (typeof symbol === 'string' && symbol.length > 0
    ? symbol.toUpperCase().replace(/^(XYZ:|HL:)/, '')
    : 'UNKNOWN');

  let category: AssetTier;
  if (s === 'BTC' || s === 'ETH' || s.includes('USDT') || s.includes('USDC') || s.startsWith('XYZ:')) {
    category = 'crypto';
  } else if (s.includes('SILVER') || s.includes('GOLD') || s === 'XAU' || s === 'XAG' || s.includes('OIL')) {
    category = 'commodity';
  } else if (s.includes('EUR') || s.includes('JPY') || s.includes('GBP') || (s.includes('USD') && s.length === 6)) {
    category = 'forex';
  } else if (s.includes('SPX') || s.includes('NDX') || s.includes('SP500')) {
    category = 'equity';
  } else {
    category = 'crypto';  // default for unknown perpetual DEX assets
  }

  const vol24h = marketState?.volume24h ?? 0;
  let volumeTier: 'high' | 'medium' | 'low';
  if (vol24h > 100_000_000) volumeTier = 'high';
  else if (vol24h > 1_000_000) volumeTier = 'medium';
  else volumeTier = 'low';

  const volatility = marketState?.volatility ?? 0;
  let volatilityTier: 'high' | 'medium' | 'low';
  if (volatility > 0.03) volatilityTier = 'high';
  else if (volatility > 0.01) volatilityTier = 'medium';
  else volatilityTier = 'low';

  return { category, volumeTier, volatilityTier, symbol: s };
}

// ─── Constants ───

const FEATURE_HISTORY_MAX = 100;
const MIN_HISTORY_FOR_CORR = 10;
const MIN_CELLS_FOR_OUTPUT = 10;
const MIN_REGIME_SAMPLES = 3;
const FEATURE_WEIGHT_MIN = 0.1;
const FEATURE_WEIGHT_MAX = 3.0;
const ALPHA_MULT_MIN = 0.1;
const ALPHA_MULT_MAX = 2.0;
const PREDICTIVE_POWER_EMA_DECAY = 0.8;
const FEATURE_WEIGHT_EMA_DECAY = 0.9;
// v2.0.843: Asset-specific weight takes over after 30 samples.
const ASSET_WARMUP_SAMPLES = 30;

// ─── Meta-Learner ───

export class MetaLearner {
  private cellStates: Map<string, CellLearningState> = new Map();
  private featureStates: Map<string, FeatureMetaState> = new Map();
  private regimeSpeeds: Map<string, RegimeLearningSpeed> = new Map();
  private totalCycles = 0;
  // v2.0.843: Per-asset-tier feature tracking.
  // Key = `${feature}|${assetTier}` → AssetTierFeatureState
  private assetTierStates: Map<string, AssetTierFeatureState> = new Map();

  /**
   * Record a Q-value update and compute adaptive learning rate.
   * Called from QRLTable.update() BEFORE the update happens.
   *
   * @returns adaptive alpha multiplier [0.1, 2.0]
   */
  recordCellUpdate(
    cellKey: string,
    oldQ: number,
    newQ: number,
    reward: number,
    cycle: number,
  ): number {
    if (!Number.isFinite(oldQ) || !Number.isFinite(newQ) || !Number.isFinite(reward)) return 1.0;

    let state = this.cellStates.get(cellKey);
    if (!state) {
      state = {
        cellKey,
        visits: 0,
        rewardMean: 0,
        rewardStd: 0,
        qValueChangeRate: 0,
        alphaMultiplier: 1.0,
        lastQValue: oldQ,
        lastUpdateCycle: cycle,
      };
      this.cellStates.set(cellKey, state);
    }

    // Update reward statistics (rolling EMA)
    state.visits++;
    const qChange = Math.abs(newQ - oldQ);
    state.qValueChangeRate = 0.8 * state.qValueChangeRate + 0.2 * qChange;

    // Update reward std (rolling approximation)
    const delta = reward - state.rewardMean;
    state.rewardMean = 0.9 * state.rewardMean + 0.1 * reward;
    state.rewardStd = Math.sqrt(0.81 * state.rewardStd * state.rewardStd + 0.19 * delta * delta);

    // High reward variance → lower learning rate (don't over-react to noise)
    // Low reward variance → higher learning rate (stable signal, learn faster)
    const stability = 1 / (1 + state.rewardStd * 10);
    state.alphaMultiplier = Math.max(ALPHA_MULT_MIN, Math.min(ALPHA_MULT_MAX, 0.5 + stability));

    state.lastQValue = newQ;
    state.lastUpdateCycle = cycle;

    return state.alphaMultiplier;
  }

  /**
   * Record a feature-PnL observation and update adaptive feature weight.
   * Called from the learning pipeline when a trade closes.
   *
   * v2.0.843: Accepts optional `assetMeta` for per-asset-tier tracking.
   * When provided, the feature's predictive power is tracked SEPARATELY
   * for the asset tier + symbol, enabling cross-asset transfer learning:
   *   - Per-category (e.g. 'crypto'): broad transfer priors — BTC fundingRate
   *     pattern can transfer to ETH, but NOT override SILVER's own pattern.
   *   - Per-symbol (e.g. 'SILVER'): fine-grained adaptation — SILVER can
   *     learn "OB imbalance works for me even though it doesn't for BTC"
   *     without being dragged down by BTC's different microstructure.
   *   - Each asset has its own pattern. Low volume ≠ unreliable — it means
   *     different microstructure (thin books, wider spreads, fewer MMs).
   *     The system learns these per-symbol patterns from the data, not from
   *     a volume-based assumption.
   *   - Hierarchy: symbol (fine) → category (transfer) → global (fallback).
   *     When symbol has < 5 samples, falls back to category weight; when
   *     category has < 5 samples, falls back to global weight.
   */
  recordFeatureOutcome(
    feature: string,
    featureValue: number,
    pnlPct: number,
    assetMeta?: AssetMetadata,
  ): void {
    if (!Number.isFinite(featureValue) || !Number.isFinite(pnlPct)) return;
    if (typeof feature !== 'string' || feature.length === 0) return;
    // v2.0.843: Sanitize feature name — reject or escape pipe characters
    // to prevent tier key parsing corruption (feature|sym:SYMBOL →
    // indexOf('|') splits at wrong position if feature contains '|').
    const safeFeature = feature.includes('|') ? feature.replace(/\|/g, '_') : feature;

    // ── Global feature tracking (unchanged from v2.0.840) ──
    let state = this.featureStates.get(safeFeature);
    if (!state) {
      state = {
        feature: safeFeature,
        predictivePower: 0,
        weight: 1.0,
        history: [],
      };
      this.featureStates.set(safeFeature, state);
    }

    state.history.push({ value: featureValue, pnlPct });
    if (state.history.length > FEATURE_HISTORY_MAX) state.history.shift();

    // Compute rolling predictive power (correlation)
    if (state.history.length >= MIN_HISTORY_FOR_CORR) {
      const values = state.history.map(h => h.value);
      const pnls = state.history.map(h => h.pnlPct);
      const corr = this.pearsonCorrelation(values, pnls);
      // EMA update of predictive power
      state.predictivePower = PREDICTIVE_POWER_EMA_DECAY * state.predictivePower +
        (1 - PREDICTIVE_POWER_EMA_DECAY) * corr;
      // Adaptive weight: |predictivePower| high → weight high
      const targetWeight = 0.3 + 2.7 * Math.abs(state.predictivePower);
      state.weight = FEATURE_WEIGHT_EMA_DECAY * state.weight +
        (1 - FEATURE_WEIGHT_EMA_DECAY) * targetWeight;
      state.weight = Math.max(FEATURE_WEIGHT_MIN, Math.min(FEATURE_WEIGHT_MAX, state.weight));
    }

    // ── v2.0.843: Per-symbol + per-category tracking (3-level hierarchy) ──
    // Hierarchy: symbol (finest) → category (transfer) → global (fallback).
    // Each level tracks feature predictive power independently. A low-volume
    // alt like SILVER can learn "OB imbalance is predictive FOR ME" even if
    // BTC's data shows OB imbalance is noise — because they're tracked
    // separately. The category level enables transfer: a new crypto asset
    // starts with the crypto-category prior, then adapts to its own pattern.
    if (assetMeta) {
      // Sign-agreement heuristic: does the feature direction match PnL direction?
      // O(1) memory, converges faster than Pearson for small N.
      const featureSign = Math.sign(featureValue);
      const pnlSign = Math.sign(pnlPct);
      const agreement = featureSign === pnlSign ? 1 : -1;

      // Level 1: Per-symbol tracking (finest granularity).
      // Key = `safeFeature|sym:SYMBOL` — each asset gets its own weight track.
      // This lets SILVER learn its own pattern independently of BTC.
      const symKey = `${safeFeature}|sym:${assetMeta.symbol}`;
      this.updateTierState(symKey, agreement);

      // Level 2: Per-category tracking (cross-asset transfer).
      // Key = `safeFeature|cat:CATEGORY` — assets in the same class share a prior.
      // BTC + ETH + alts share 'crypto' prior; SILVER + GOLD share 'commodity'.
      const catKey = `${safeFeature}|cat:${assetMeta.category}`;
      this.updateTierState(catKey, agreement);
    }
  }

  /**
   * v2.0.843: Update a single tier state with sign-agreement EMA.
   * Used for both per-symbol and per-category tracking.
   */
  private updateTierState(key: string, agreement: number): void {
    let tierState = this.assetTierStates.get(key);
    if (!tierState) {
      tierState = { predictivePower: 0, weight: 1.0, sampleCount: 0 };
      this.assetTierStates.set(key, tierState);
    }
    tierState.sampleCount++;
    // EMA update of predictive power
    tierState.predictivePower = PREDICTIVE_POWER_EMA_DECAY * tierState.predictivePower +
      (1 - PREDICTIVE_POWER_EMA_DECAY) * agreement;
    tierState.predictivePower = Math.max(-1, Math.min(1, tierState.predictivePower));
    // Weight from predictive power: |pp| high → weight high
    const targetWeight = 0.3 + 2.7 * Math.abs(tierState.predictivePower);
    tierState.weight = FEATURE_WEIGHT_EMA_DECAY * tierState.weight +
      (1 - FEATURE_WEIGHT_EMA_DECAY) * targetWeight;
    tierState.weight = Math.max(FEATURE_WEIGHT_MIN, Math.min(FEATURE_WEIGHT_MAX, tierState.weight));
  }

  /**
   * Get adaptive feature weights (for OLR query weighting).
   */
  getFeatureWeights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [feature, state] of this.featureStates) {
      out[feature] = state.weight;
    }
    return out;
  }

  /**
   * v2.0.843: Get asset-aware feature weights — 3-level hierarchy:
   *   symbol (finest) → category (transfer) → global (fallback).
   *
   * - If symbol has enough samples (≥5): blend symbol weight with category
   *   weight. The symbol weight captures the asset's own pattern (e.g.
   *   SILVER's OB imbalance edge); the category weight provides transfer
   *   from structurally similar assets.
   * - If symbol is cold-start (<5 samples) but category has samples: use
   *   category weight (cross-asset transfer from the same asset class).
   * - If both are cold-start: use global weight (broad prior from all assets).
   *
   * Each asset has its own pattern. Low volume ≠ unreliable — it means
   * different microstructure. The weight comes from the data, not from a
   * volume-based assumption. SILVER can have weight=2.5 on OB imbalance
   * if the data shows it's predictive for SILVER, regardless of BTC's
   * weight=0.5 on the same feature.
   */
  getAssetAwareFeatureWeights(assetMeta?: AssetMetadata): Record<string, number> {
    if (!assetMeta) return this.getFeatureWeights();

    const out: Record<string, number> = {};
    for (const [feature, globalState] of this.featureStates) {
      const symKey = `${feature}|sym:${assetMeta.symbol}`;
      const catKey = `${feature}|cat:${assetMeta.category}`;
      const symState = this.assetTierStates.get(symKey);
      const catState = this.assetTierStates.get(catKey);

      if (symState && symState.sampleCount >= 5) {
        // Symbol has enough data — blend symbol + category.
        // α = min(1, symSamples / ASSET_WARMUP_SAMPLES) — symbol weight
        // dominates as its own data accumulates, category provides stability.
        const alpha = Math.min(1, symState.sampleCount / ASSET_WARMUP_SAMPLES);
        const catWeight = catState && catState.sampleCount >= 5 ? catState.weight : globalState.weight;
        out[feature] = alpha * symState.weight + (1 - alpha) * catWeight;
      } else if (catState && catState.sampleCount >= 5) {
        // Symbol cold-start, category warm — transfer from same asset class.
        const alpha = Math.min(1, catState.sampleCount / ASSET_WARMUP_SAMPLES);
        out[feature] = alpha * catState.weight + (1 - alpha) * globalState.weight;
      } else {
        // Both cold-start — use global weight (broad prior).
        out[feature] = globalState.weight;
      }
    }
    return out;
  }

  /**
   * Get adaptive learning rate multiplier for a cell.
   */
  getCellAlphaMultiplier(cellKey: string): number {
    return this.cellStates.get(cellKey)?.alphaMultiplier ?? 1.0;
  }

  /**
   * Update regime learning speeds (called every N cycles).
   */
  updateRegimeSpeeds(cycle: number): void {
    this.totalCycles = cycle;
    const regimeMap = new Map<string, number[]>();

    for (const [cellKey, state] of this.cellStates) {
      const regime = cellKey.split('|')[0] ?? 'unknown';
      const speeds = regimeMap.get(regime) ?? [];
      speeds.push(state.qValueChangeRate);
      regimeMap.set(regime, speeds);
    }

    // Compute per-regime average learning speed
    const speeds: Array<{ regime: string; speed: number; count: number }> = [];
    for (const [regime, changeRates] of regimeMap) {
      if (changeRates.length < MIN_REGIME_SAMPLES) continue;
      const avg = changeRates.reduce((a, b) => a + b, 0) / changeRates.length;
      speeds.push({ regime, speed: avg, count: changeRates.length });
    }

    // Normalize to [0, 1] curriculum priority
    const maxSpeed = Math.max(...speeds.map(s => s.speed), 0.000001);
    for (const s of speeds) {
      this.regimeSpeeds.set(s.regime, {
        regime: s.regime,
        avgLearningSpeed: s.speed,
        cellCount: s.count,
        curriculumPriority: s.speed / maxSpeed,
      });
    }
  }

  /**
   * Get curriculum suggestion: which regime to explore next.
   * Higher learning speed → higher priority (learn fast while you can).
   */
  getCurriculumSuggestion(): string | null {
    let best: RegimeLearningSpeed | null = null;
    for (const [, speed] of this.regimeSpeeds) {
      if (!best || speed.curriculumPriority > best.curriculumPriority) {
        best = speed;
      }
    }
    return best?.regime ?? null;
  }

  /**
   * Generate meta-learning block for HACP injection.
   */
  getMetaLearningBlock(): string {
    if (this.cellStates.size < MIN_CELLS_FOR_OUTPUT) {
      return '=== META-LEARNING ===\nInsufficient data for meta-learning.\n---';
    }

    const lines: string[] = [
      '=== META-LEARNING (Learning to Learn) ===',
      `📊 Tracked cells: ${this.cellStates.size}`,
      `📊 Tracked features: ${this.featureStates.size}`,
    ];

    // Top feature weights
    const features = [...this.featureStates.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 5);
    if (features.length > 0) {
      lines.push('');
      lines.push('Adaptive feature weights (top 5):');
      for (const [name, state] of features) {
        const tag = state.predictivePower > 0.1 ? '✅' : state.predictivePower < -0.1 ? '❌' : '⚪';
        lines.push(
          `  ${tag} ${name}: weight=${state.weight.toFixed(2)}, ` +
          `predictivePower=${state.predictivePower.toFixed(3)}`
        );
      }
    }

    // v2.0.843: Per-symbol + per-category feature weights (3-level hierarchy)
    if (this.assetTierStates.size > 0) {
      // Group by tier (symbol-level and category-level)
      const tierMap = new Map<string, Array<{ feature: string; weight: number; pp: number; n: number }>>();
      for (const [key, ts] of this.assetTierStates) {
        if (ts.sampleCount < 3) continue;
        // Keys are `feature|sym:SYMBOL` or `feature|cat:CATEGORY`
        const pipeIdx = key.indexOf('|');
        if (pipeIdx < 0) continue;
        const feature = key.substring(0, pipeIdx);
        const tier = key.substring(pipeIdx + 1);  // "sym:BTC" or "cat:crypto"
        if (!feature || !tier) continue;
        const arr = tierMap.get(tier) ?? [];
        arr.push({ feature, weight: ts.weight, pp: ts.predictivePower, n: ts.sampleCount });
        tierMap.set(tier, arr);
      }
      if (tierMap.size > 0) {
        lines.push('');
        lines.push('Per-asset feature weights (symbol + category hierarchy):');
        // Show category-level first (broader), then per-symbol (finest)
        const sortedTiers = [...tierMap.entries()].sort((a, b) => {
          const aIsCat = a[0].startsWith('cat:');
          const bIsCat = b[0].startsWith('cat:');
          if (aIsCat && !bIsCat) return -1;
          if (!aIsCat && bIsCat) return 1;
          return b[1].length - a[1].length;
        });
        for (const [tier, feats] of sortedTiers) {
          const top = feats.sort((a, b) => b.weight - a.weight).slice(0, 3);
          lines.push(`  [${tier}] (${feats.length} features, ${feats.reduce((s, f) => s + f.n, 0)} samples):`);
          for (const f of top) {
            const tag = f.pp > 0.1 ? '✅' : f.pp < -0.1 ? '❌' : '⚪';
            lines.push(`    ${tag} ${f.feature}: ${f.weight.toFixed(2)} (pp=${f.pp.toFixed(2)}, n=${f.n})`);
          }
        }
      }
    }

    // Curriculum suggestions
    const sortedRegimes = [...this.regimeSpeeds.values()]
      .sort((a, b) => b.curriculumPriority - a.curriculumPriority);
    if (sortedRegimes.length > 0) {
      lines.push('');
      lines.push('Regime learning speeds (curriculum priority):');
      for (const r of sortedRegimes.slice(0, 5)) {
        const tag = r.curriculumPriority > 0.7 ? '🔥' : r.curriculumPriority > 0.4 ? '📈' : '⏸';
        lines.push(
          `  ${tag} ${r.regime}: speed=${r.avgLearningSpeed.toFixed(6)}, ` +
          `priority=${r.curriculumPriority.toFixed(2)}, cells=${r.cellCount}`
        );
      }
    }

    // Curriculum suggestion
    const suggestion = this.getCurriculumSuggestion();
    if (suggestion) {
      lines.push('');
      lines.push(`💡 Curriculum: prioritize exploration in "${suggestion}" regime (fastest learning).`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  getCellCount(): number {
    return this.cellStates.size;
  }

  getFeatureCount(): number {
    return this.featureStates.size;
  }

  /**
   * v2.0.842: Record an audit-detected feature weight adjustment.
   * When the LLM audit finds "thesis-contradicts-action", the thesis feature
   * has low predictive power and should be downweighted. This directly adjusts
   * the feature's predictive power EMA, causing the adaptive weight to drop.
   *
   * @param featureName  Feature to adjust (e.g. "thesisSignal")
   * @param predictivePowerDelta  Change in predictive power (negative = downweight)
   */
  recordAuditFeatureAdjustment(featureName: string, predictivePowerDelta: number): void {
    if (typeof featureName !== 'string' || featureName.length === 0) return;
    if (!Number.isFinite(predictivePowerDelta)) return;
    // v2.0.843c: Sanitize feature name — reject or escape pipe characters
    // (same guard as recordFeatureOutcome, prevents tier key parsing corruption).
    const safeFeature = featureName.includes('|') ? featureName.replace(/\|/g, '_') : featureName;

    let state = this.featureStates.get(safeFeature);
    if (!state) {
      state = {
        feature: safeFeature,
        predictivePower: 0,
        weight: 1.0,
        history: [],
      };
      this.featureStates.set(safeFeature, state);
    }

    // Apply delta to predictive power EMA (clamped [-1, 1])
    state.predictivePower = Math.max(-1, Math.min(1, state.predictivePower + predictivePowerDelta));

    // Recompute weight from new predictive power
    const targetWeight = 0.3 + 2.7 * Math.abs(state.predictivePower);
    state.weight = Math.max(0.1, Math.min(3.0, targetWeight));

    log.info(
      `[meta-learn] audit feature adjustment: ${safeFeature} ` +
      `delta=${predictivePowerDelta.toFixed(3)} → predictivePower=${state.predictivePower.toFixed(3)}, ` +
      `weight=${state.weight.toFixed(2)}`
    );
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 5) return 0;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denomX = 0, denomY = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i]! - meanX) * (y[i]! - meanY);
      denomX += (x[i]! - meanX) ** 2;
      denomY += (y[i]! - meanY) ** 2;
    }
    const denom = Math.sqrt(denomX * denomY);
    if (denom === 0) return 0;
    return num / denom;
  }

  // ── Persistence ──
  save(): Record<string, unknown> {
    return {
      cellStates: Object.fromEntries(this.cellStates),
      featureStates: Object.fromEntries(
        [...this.featureStates.entries()].map(([k, v]) => [k, { ...v, history: v.history.slice(-20) }])
      ),
      regimeSpeeds: Object.fromEntries(this.regimeSpeeds),
      // v2.0.843: Persist asset tier states for cross-asset transfer learning
      assetTierStates: Object.fromEntries(this.assetTierStates),
      totalCycles: this.totalCycles,
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const cells = s['cellStates'];
    if (cells && typeof cells === 'object' && !Array.isArray(cells)) {
      this.cellStates = new Map(Object.entries(cells as Record<string, CellLearningState>));
    }
    const features = s['featureStates'] as Record<string, FeatureMetaState>;
    if (features) {
      for (const [name, fs] of Object.entries(features)) {
        if (fs && typeof fs === 'object') {
          this.featureStates.set(name, {
            ...fs,
            history: Array.isArray(fs.history) ? fs.history : [],
          });
        }
      }
    }
    const regimes = s['regimeSpeeds'];
    if (regimes && typeof regimes === 'object' && !Array.isArray(regimes)) {
      this.regimeSpeeds = new Map(Object.entries(regimes as Record<string, RegimeLearningSpeed>));
    }
    // v2.0.843: Load asset tier states
    const tiers = s['assetTierStates'];
    if (tiers && typeof tiers === 'object' && !Array.isArray(tiers)) {
      for (const [key, ts] of Object.entries(tiers as Record<string, unknown>)) {
        if (ts && typeof ts === 'object') {
          const tsObj = ts as Record<string, unknown>;
          this.assetTierStates.set(key, {
            predictivePower: safeNum(tsObj['predictivePower'] as number, 0),
            weight: safeNum(tsObj['weight'] as number, 1.0),
            sampleCount: typeof tsObj['sampleCount'] === 'number' ? tsObj['sampleCount'] : 0,
          });
        }
      }
    }
    this.totalCycles = safeNum(s['totalCycles'] as number, 0);
    log.info(`[meta-learn] loaded: ${this.cellStates.size} cells, ${this.featureStates.size} features, ${this.regimeSpeeds.size} regimes, ${this.assetTierStates.size} asset tiers`);
  }

  reset(): void {
    this.cellStates.clear();
    this.featureStates.clear();
    this.regimeSpeeds.clear();
    this.assetTierStates.clear();
    this.totalCycles = 0;
  }
}