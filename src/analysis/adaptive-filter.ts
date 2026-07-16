// ─── Adaptive Sigmoid+EMA Noise Filter (v2.0.105) ───
//
// Production-grade signal denoising for multi-agent trading.
//
// PROBLEM: Raw market data (price ticks, order book imbalance, volume)
// contains microstructure noise that causes:
//   - Over-trading (agents react to noise as if it were signal)
//   - Whipsaw entries (BUY → immediate SELL → BUY on noise oscillation)
//   - Unstable sentiment (conviction flips every cycle)
//
// SOLUTION: Three-layer adaptive filter with PER-ASSET profiles:
//
// 1. EMA Layer — Exponential Moving Average smooths raw inputs.
//    Each signal channel has its own EMA with an independent alpha.
//    Alpha is adapted per-cycle based on:
//      - Market volatility (high vol → lower alpha → more smoothing)
//      - Recent trade performance (losses → lower alpha → more smoothing)
//      - Signal-to-noise ratio (low SNR → lower alpha → more smoothing)
//
// 2. Sigmoid Layer — Sigmoid squashing function maps smoothed values
//    to bounded [-1, +1] range. The sigmoid steepness (k) and midpoint
//    (x0) are adapted per-cycle:
//      - High noise → lower k (gentler slope → less reactive)
//      - Strong trend → higher k (sharper slope → more decisive)
//
// 3. Conviction Gate — Minimum conviction threshold for trade entry.
//    Adapted based on recent trade frequency and win rate:
//      - Over-trading → raise threshold (require stronger signal)
//      - Under-trading + winning → lower threshold (relax entry)
//
// v2.0.106: PER-ASSET PROFILES — Market Agent selects a FilterProfile
// for each asset based on its characteristics (volatility, liquidity,
// asset type). Each asset gets its own AdaptiveNoiseFilter instance
// with independent channel states, alpha/k ranges, and conviction gates.
// Meta-Agent receives per-asset filter data and must factor it into
// every decision.
//
// "Smooth the noise, sharpen the signal, throttle the frequency — per asset."

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'adaptive-filter' });

// ─── Per-Asset Filter Profiles (v2.0.106) ───
//
// Market Agent selects one of these profiles for each asset based on
// the asset's characteristics. Each profile defines different smoothing
// aggressiveness, sigmoid sharpness, and conviction requirements.

export type FilterProfileType =
  | 'high_vol_crypto'    // BTC, ETH — high liquidity, moderate vol
  | 'low_vol_crypto'     // Stablecoins, low-vol alts
  | 'high_vol_alt'       // Meme coins, small caps — extreme vol
  | 'dex_perp'           // xyz:SKHX, xyz:SP500 — DEX perps
  | 'forex_index'        // xyz:EURUSD, xyz:NI225 — forex/indices
  | 'commodity'          // xyz:XAU, xyz:OIL — commodities
  | 'default';           // Fallback

export interface FilterProfile {
  /** Profile type identifier */
  type: FilterProfileType;
  /** Human-readable description for agent context */
  description: string;
  /** EMA alpha bounds — lower = more smoothing */
  alphaMin: number;
  alphaMax: number;
  /** Sigmoid k bounds — lower = gentler (noise-tolerant) */
  kMin: number;
  kMax: number;
  /** Conviction gate bounds — higher = stricter entry */
  convictionFloor: number;
  convictionCeiling: number;
  /** Max trades per frequency window */
  maxTradesPerWindow: number;
  /** Trade frequency window size (cycles) */
  tradeFrequencyWindow: number;
  /** Adaptation rate (how fast params adjust per cycle) */
  adaptationRate: number;
}

/** Predefined filter profiles for each asset category */
export const FILTER_PROFILES: Record<FilterProfileType, FilterProfile> = {
  // High-volume crypto (BTC, ETH): moderate noise, high liquidity
  // → moderate smoothing, moderate conviction
  high_vol_crypto: {
    type: 'high_vol_crypto',
    description: 'High-volume crypto (BTC/ETH) — moderate noise, high liquidity. Balanced smoothing.',
    alphaMin: 0.08,
    alphaMax: 0.45,
    kMin: 0.8,
    kMax: 4.0,
    convictionFloor: 0.40,
    convictionCeiling: 0.70,
    maxTradesPerWindow: 3,
    tradeFrequencyWindow: 10,
    adaptationRate: 0.15,
  },
  // Low-vol crypto: low noise, stable
  // → light smoothing, lower conviction (easier entry when signal is clean)
  low_vol_crypto: {
    type: 'low_vol_crypto',
    description: 'Low-vol crypto — low noise, stable. Light smoothing, relaxed entry.',
    alphaMin: 0.15,
    alphaMax: 0.55,
    kMin: 1.0,
    kMax: 5.0,
    convictionFloor: 0.35,
    convictionCeiling: 0.65,
    maxTradesPerWindow: 4,
    tradeFrequencyWindow: 10,
    adaptationRate: 0.12,
  },
  // High-vol alt (meme coins, small caps): extreme noise, low liquidity
  // → heavy smoothing, high conviction (require very strong signal)
  high_vol_alt: {
    type: 'high_vol_alt',
    description: 'High-vol alt (meme/small cap) — extreme noise, low liquidity. Heavy smoothing, strict entry.',
    alphaMin: 0.03,
    alphaMax: 0.25,
    kMin: 0.5,
    kMax: 2.5,
    convictionFloor: 0.55,
    convictionCeiling: 0.85,
    maxTradesPerWindow: 2,
    tradeFrequencyWindow: 15,
    adaptationRate: 0.20,
  },
  // DEX perps (xyz:SKHX, xyz:SP500): moderate vol, DEX-specific microstructure
  // → moderate-heavy smoothing, moderate conviction
  dex_perp: {
    type: 'dex_perp',
    description: 'DEX perp (xyz: assets) — DEX microstructure noise. Moderate-heavy smoothing.',
    alphaMin: 0.05,
    alphaMax: 0.35,
    kMin: 0.7,
    kMax: 3.5,
    convictionFloor: 0.45,
    convictionCeiling: 0.75,
    maxTradesPerWindow: 3,
    tradeFrequencyWindow: 12,
    adaptationRate: 0.15,
  },
  // Forex/indices (xyz:EURUSD, xyz:NI225): low vol, high liquidity, trending
  // → light smoothing, moderate conviction (trends are cleaner)
  forex_index: {
    type: 'forex_index',
    description: 'Forex/index — low vol, high liquidity, cleaner trends. Light smoothing.',
    alphaMin: 0.12,
    alphaMax: 0.50,
    kMin: 1.2,
    kMax: 5.0,
    convictionFloor: 0.40,
    convictionCeiling: 0.70,
    maxTradesPerWindow: 3,
    tradeFrequencyWindow: 10,
    adaptationRate: 0.12,
  },
  // Commodities (xyz:XAU, xyz:OIL): moderate vol, cyclical
  // → moderate smoothing, moderate conviction
  commodity: {
    type: 'commodity',
    description: 'Commodity (gold/oil) — moderate vol, cyclical. Moderate smoothing.',
    alphaMin: 0.08,
    alphaMax: 0.40,
    kMin: 0.9,
    kMax: 4.0,
    convictionFloor: 0.42,
    convictionCeiling: 0.72,
    maxTradesPerWindow: 3,
    tradeFrequencyWindow: 11,
    adaptationRate: 0.14,
  },
  // Default fallback
  default: {
    type: 'default',
    description: 'Default profile — balanced smoothing for unknown asset types.',
    alphaMin: 0.05,
    alphaMax: 0.50,
    kMin: 0.5,
    kMax: 5.0,
    convictionFloor: 0.40,
    convictionCeiling: 0.75,
    maxTradesPerWindow: 3,
    tradeFrequencyWindow: 10,
    adaptationRate: 0.15,
  },
};

// ─── Types ───

/** Per-channel adaptive filter state */
export interface ChannelFilterState {
  /** EMA smoothed value (persisted across cycles) */
  emaValue: number;
  /** Current EMA alpha (0-1, higher = faster adaptation = less smoothing) */
  alpha: number;
  /** Current sigmoid steepness k (higher = sharper transition) */
  k: number;
  /** Current sigmoid midpoint x0 */
  x0: number;
  /** Rolling signal-to-noise ratio (0-1, higher = cleaner signal) */
  snr: number;
  /** Rolling noise estimate (variance of residual) */
  noiseEstimate: number;
  /** History of raw values for SNR computation */
  rawHistory: number[];
}

/** Market context for adaptation */
export interface MarketContext {
  /** Current volatility (0-1, fraction of price) */
  volatility: number;
  /** Current market regime */
  regime: string;
  /** Recent trade win rate (0-1, undefined if no trades) */
  recentWinRate?: number;
  /** Recent trade count (last N cycles) */
  recentTradeCount: number;
  /** Cycles since last trade */
  cyclesSinceLastTrade: number;
  /** Total cycles elapsed */
  totalCycles: number;
}

/** Adaptive filter configuration */
export interface AdaptiveFilterConfig {
  /** v2.0.106: Per-asset filter profile type */
  profileType: FilterProfileType;
  /** EMA alpha bounds [min, max] — adapted per-cycle */
  alphaMin: number;
  alphaMax: number;
  /** Sigmoid k bounds [min, max] */
  kMin: number;
  kMax: number;
  /** SNR window size (number of raw values to keep for SNR computation) */
  snrWindowSize: number;
  /** Adaptation rate (how fast alpha/k adjust, 0-1) */
  adaptationRate: number;
  /** Min conviction for trade entry (adapted) */
  convictionFloor: number;
  convictionCeiling: number;
  /** Max trades per N cycles (frequency throttle) */
  maxTradesPerWindow: number;
  tradeFrequencyWindow: number;
}

// ─── Default Config ───

export const DEFAULT_FILTER_CONFIG: AdaptiveFilterConfig = {
  profileType: 'default',
  alphaMin: 0.05,       // Very strong smoothing (95% weight on history)
  alphaMax: 0.50,       // Moderate smoothing (50% weight on history)
  kMin: 0.5,            // Gentle sigmoid (noise-tolerant)
  kMax: 5.0,            // Sharp sigmoid (trend-decisive)
  snrWindowSize: 20,    // 20-cycle SNR window
  adaptationRate: 0.15, // 15% per-cycle adjustment
  convictionFloor: 0.40,
  convictionCeiling: 0.75,
  maxTradesPerWindow: 3,
  tradeFrequencyWindow: 10,
};

/** Create a filter config from a profile */
export function configFromProfile(profile: FilterProfile): AdaptiveFilterConfig {
  return {
    profileType: profile.type,
    alphaMin: profile.alphaMin,
    alphaMax: profile.alphaMax,
    kMin: profile.kMin,
    kMax: profile.kMax,
    convictionFloor: profile.convictionFloor,
    convictionCeiling: profile.convictionCeiling,
    maxTradesPerWindow: profile.maxTradesPerWindow,
    tradeFrequencyWindow: profile.tradeFrequencyWindow,
    adaptationRate: profile.adaptationRate,
    snrWindowSize: 20,
  };
}

// ─── Channel Definitions ───

/** Signal channels — each has independent filter state */
export type SignalChannel =
  | 'price'
  | 'orderBookImbalance'
  | 'volumeAcceleration'
  | 'fundingRateDelta'
  | 'spreadPressure'
  | 'priceAcceleration'
  | 'largeTradeCount'
  | 'fearGreed'
  | 'volatilityRegime';

/** Default per-channel initial state */
function createChannelState(channel: SignalChannel): ChannelFilterState {
  // Each channel starts with different defaults based on its noise characteristics
  const defaults: Record<SignalChannel, { alpha: number; k: number; x0: number }> = {
    // Price: moderate smoothing, moderate sigmoid
    price:              { alpha: 0.20, k: 2.0, x0: 0.0 },
    // OB imbalance: heavy noise → strong smoothing, gentle sigmoid
    orderBookImbalance: { alpha: 0.10, k: 1.5, x0: 0.0 },
    // Volume acceleration: very noisy → strong smoothing
    volumeAcceleration: { alpha: 0.08, k: 1.0, x0: 0.0 },
    // Funding rate: slow-moving → light smoothing
    fundingRateDelta:   { alpha: 0.30, k: 2.0, x0: 0.0 },
    // Spread: moderate noise
    spreadPressure:     { alpha: 0.15, k: 2.0, x0: 0.0 },
    // Price acceleration: very noisy → strong smoothing
    priceAcceleration:  { alpha: 0.08, k: 1.0, x0: 0.0 },
    // Large trade count: sparse → moderate smoothing
    largeTradeCount:    { alpha: 0.15, k: 2.0, x0: 0.3 },
    // Fear/Greed: slow-moving → light smoothing
    fearGreed:          { alpha: 0.30, k: 2.0, x0: 0.5 },
    // Volatility regime: slow-moving → light smoothing
    volatilityRegime:   { alpha: 0.25, k: 2.0, x0: 0.0 },
  };

  const d = defaults[channel];
  return {
    emaValue: 0,
    alpha: d.alpha,
    k: d.k,
    x0: d.x0,
    snr: 0.5,
    noiseEstimate: 0,
    rawHistory: [],
  };
}

// ─── Adaptive Noise Filter ───

export class AdaptiveNoiseFilter {
  private channelStates: Map<SignalChannel, ChannelFilterState> = new Map();
  private config: AdaptiveFilterConfig;
  /** v2.0.106: The asset symbol this filter is for */
  private symbol: string;
  private currentConvictionThreshold: number;
  private tradeTimestamps: number[] = [];
  private lastAdaptationLog = 0;
  /** v2.0.211: Decision interval in ms — used for time-based trade frequency pruning */
  private decisionIntervalMs: number = 300_000; // default 5 min, updated via setDecisionInterval

  /** v2.0.106: Create from a filter profile for a specific asset */
  static fromProfile(symbol: string, profile: FilterProfile): AdaptiveNoiseFilter {
    const cfg = configFromProfile(profile);
    return new AdaptiveNoiseFilter(cfg, symbol);
  }

  constructor(config: Partial<AdaptiveFilterConfig> = {}, symbol: string = 'unknown') {
    this.config = { ...DEFAULT_FILTER_CONFIG, ...config };
    this.symbol = symbol;
    this.currentConvictionThreshold = this.config.convictionFloor + 0.10;

    // Initialize all channel states
    const channels: SignalChannel[] = [
      'price', 'orderBookImbalance', 'volumeAcceleration', 'fundingRateDelta',
      'spreadPressure', 'priceAcceleration', 'largeTradeCount', 'fearGreed', 'volatilityRegime',
    ];
    for (const ch of channels) {
      this.channelStates.set(ch, createChannelState(ch));
    }

    log.info('AdaptiveNoiseFilter initialized', {
      symbol: this.symbol,
      profile: this.config.profileType,
      alphaRange: `[${this.config.alphaMin}, ${this.config.alphaMax}]`,
      kRange: `[${this.config.kMin}, ${this.config.kMax}]`,
      convictionRange: `[${this.config.convictionFloor}, ${this.config.convictionCeiling}]`,
    });
  }

  /** v2.0.106: Get the symbol this filter is for */
  getSymbol(): string {
    return this.symbol;
  }

  /** v2.0.211: Set the decision interval for time-based trade frequency pruning */
  setDecisionInterval(ms: number): void {
    this.decisionIntervalMs = ms;
  }

  /** v2.0.106: Get the filter profile type */
  getProfileType(): FilterProfileType {
    return this.config.profileType;
  }

  /** v2.0.106: Get the filter profile description */
  getProfileDescription(): string {
    const profile = FILTER_PROFILES[this.config.profileType];
    return profile?.description ?? 'Unknown profile';
  }

  // ─── Core: Filter a raw signal value ───

  /**
   * Filter a raw signal value through EMA + sigmoid.
   * Returns the smoothed, squashed value in [-1, +1] range.
   */
  filter(channel: SignalChannel, rawValue: number): number {
    const state = this.channelStates.get(channel);
    if (!state) return rawValue; // unknown channel — passthrough

    // 1. EMA smoothing
    state.emaValue = state.alpha * rawValue + (1 - state.alpha) * state.emaValue;

    // 2. Update raw history for SNR computation
    state.rawHistory.push(rawValue);
    if (state.rawHistory.length > this.config.snrWindowSize) {
      state.rawHistory.shift();
    }

    // 3. Compute SNR (signal-to-noise ratio)
    this.updateSNR(state);

    // 4. Sigmoid squashing: map smoothed value to [-1, +1]
    const smoothed = state.emaValue;
    const z = Math.max(-500, Math.min(500, state.k * (smoothed - state.x0)));
    const sigmoidOutput = 1 / (1 + Math.exp(-z)); // [0, 1]
    const bipolar = sigmoidOutput * 2 - 1; // [-1, +1]

    return bipolar;
  }

  /**
   * Filter a raw signal value and return the EMA-smoothed value (without sigmoid).
   * Useful for price smoothing where we need the actual value, not a bounded score.
   */
  filterEMA(channel: SignalChannel, rawValue: number): number {
    const state = this.channelStates.get(channel);
    if (!state) return rawValue;

    state.emaValue = state.alpha * rawValue + (1 - state.alpha) * state.emaValue;

    state.rawHistory.push(rawValue);
    if (state.rawHistory.length > this.config.snrWindowSize) {
      state.rawHistory.shift();
    }
    this.updateSNR(state);

    return state.emaValue;
  }

  // ─── SNR Computation ───

  private updateSNR(state: ChannelFilterState): void {
    if (state.rawHistory.length < 5) return;

    // Signal = variance of EMA-smoothed values (trend strength)
    // Noise = variance of (raw - EMA) residuals (noise level)
    const residuals: number[] = [];
    const smoothedVals: number[] = [];

    let ema = state.rawHistory[0]!;
    for (let i = 0; i < state.rawHistory.length; i++) {
      const raw = state.rawHistory[i]!;
      ema = state.alpha * raw + (1 - state.alpha) * ema;
      smoothedVals.push(ema);
      residuals.push(raw - ema);
    }

    const signalVar = this.variance(smoothedVals);
    const noiseVar = this.variance(residuals);

    state.noiseEstimate = Math.sqrt(noiseVar);
    // SNR = signal / (signal + noise), bounded [0, 1]
    const total = signalVar + noiseVar;
    state.snr = total > 0 ? signalVar / total : 0.5;
  }

  private variance(x: number[]): number {
    if (x.length < 2) return 0;
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    return x.reduce((s, v) => s + (v - mean) ** 2, 0) / x.length;
  }

  // ─── Per-Cycle Adaptation ───

  /**
   * Adapt filter parameters (alpha, k, conviction threshold) based on
   * market context and recent trade performance.
   *
   * Call this ONCE per decision cycle, BEFORE filtering signals.
   */
  adapt(ctx: MarketContext): void {
    const rate = this.config.adaptationRate;

    // ── Compute adaptation factors ──

    // 1. Volatility factor: high vol → reduce alpha (more smoothing)
    //    volFactor ∈ [0, 1], 0 = max smoothing, 1 = min smoothing
    const volFactor = Math.max(0, Math.min(1, 1 - ctx.volatility * 20));

    // 2. Performance factor: losses → reduce alpha (more smoothing)
    //    perfFactor ∈ [0, 1], 0 = max smoothing, 1 = min smoothing
    let perfFactor = 0.5; // neutral
    if (ctx.recentWinRate !== undefined) {
      perfFactor = Math.max(0, Math.min(1, ctx.recentWinRate));
    }

    // 3. Trade frequency factor: over-trading → reduce alpha + raise conviction
    //    freqFactor ∈ [0, 1], 0 = over-trading (max smoothing), 1 = under-trading
    const recentTradesInWindow = this.countRecentTradesInWindow();
    const maxTrades = this.config.maxTradesPerWindow;
    const freqFactor = Math.max(0, Math.min(1, 1 - recentTradesInWindow / maxTrades));

    // 4. SNR factor: low SNR → reduce alpha (more smoothing)
    //    Average SNR across all channels
    let avgSnr = 0;
    let snrCount = 0;
    for (const state of this.channelStates.values()) {
      if (state.rawHistory.length >= 5) {
        avgSnr += state.snr;
        snrCount++;
      }
    }
    avgSnr = snrCount > 0 ? avgSnr / snrCount : 0.5;

    // ── Combine factors (weighted geometric mean) ──
    // Combined factor ∈ [0, 1], 0 = max smoothing, 1 = min smoothing
    const combined = (
      volFactor * 0.30 +
      perfFactor * 0.25 +
      freqFactor * 0.25 +
      avgSnr * 0.20
    );

    // ── Adapt each channel's alpha and k ──
    for (const [channel, state] of this.channelStates) {
      // Target alpha: map combined factor to [alphaMin, alphaMax]
      const targetAlpha = this.config.alphaMin + combined * (this.config.alphaMax - this.config.alphaMin);

      // Smooth adaptation: move toward target by adaptationRate
      state.alpha = state.alpha + rate * (targetAlpha - state.alpha);

      // Per-channel alpha adjustment based on channel-specific SNR
      // Noisy channels get extra smoothing
      if (state.snr < 0.3) {
        state.alpha = Math.max(this.config.alphaMin, state.alpha * 0.90);
      }

      // Target k: high SNR + strong trend → higher k (sharper)
      // Low SNR + choppy → lower k (gentler)
      const isTrending = ctx.regime.includes('trending') || ctx.regime.includes('bull') || ctx.regime.includes('bear');
      const targetK = isTrending && state.snr > 0.5
        ? this.config.kMax * 0.7
        : this.config.kMin + state.snr * (this.config.kMax - this.config.kMin);

      state.k = state.k + rate * (targetK - state.k);

      // Clamp
      state.alpha = Math.max(this.config.alphaMin, Math.min(this.config.alphaMax, state.alpha));
      state.k = Math.max(this.config.kMin, Math.min(this.config.kMax, state.k));
    }

    // ── Adapt conviction threshold ──
    // Over-trading → raise threshold (require stronger signal)
    // Under-trading + winning → lower threshold (relax entry)
    let targetConviction = this.config.convictionFloor + 0.10; // default

    if (recentTradesInWindow >= maxTrades) {
      // Over-trading: raise threshold significantly
      targetConviction = this.config.convictionCeiling;
    } else if (recentTradesInWindow === 0 && ctx.cyclesSinceLastTrade > 5) {
      // Under-trading: lower threshold (but not below floor)
      targetConviction = this.config.convictionFloor;
    } else if (ctx.recentWinRate !== undefined && ctx.recentWinRate < 0.4) {
      // Losing: raise threshold — but cap at ceiling × 0.70 (v2.0.139, was 0.85).
      // At 0.85 the losing target was 0.64 — above what the Meta-Agent can
      // typically produce (55-62%), creating a feedback trap: loss → gate
      // 64% → entries blocked → no new wins → gate never recovers. At 0.70
      // the target is 0.525 — still tightens on real SL-hit losses but stays
      // within the Meta-Agent's producible conviction range so re-entry remains
      // possible after a losing streak.
      targetConviction = this.config.convictionCeiling * 0.70;
    } else if (ctx.recentWinRate !== undefined && ctx.recentWinRate > 0.6) {
      // Winning: lower threshold
      targetConviction = this.config.convictionFloor + 0.05;
    }

    this.currentConvictionThreshold = this.currentConvictionThreshold + rate * (targetConviction - this.currentConvictionThreshold);
    this.currentConvictionThreshold = Math.max(
      this.config.convictionFloor,
      Math.min(this.config.convictionCeiling, this.currentConvictionThreshold),
    );

    // Log adaptation every 5 cycles
    if (ctx.totalCycles - this.lastAdaptationLog >= 5 || ctx.totalCycles === 0) {
      this.lastAdaptationLog = ctx.totalCycles;
      log.info('Adaptive filter adjusted', {
        cycle: ctx.totalCycles,
        vol: `${(ctx.volatility * 100).toFixed(2)}%`,
        regime: ctx.regime,
        winRate: ctx.recentWinRate !== undefined ? `${(ctx.recentWinRate * 100).toFixed(0)}%` : 'N/A',
        recentTrades: recentTradesInWindow,
        avgSnr: `${(avgSnr * 100).toFixed(0)}%`,
        conviction: `${(this.currentConvictionThreshold * 100).toFixed(0)}%`,
        combined: `${(combined * 100).toFixed(0)}%`,
      });
    }
  }

  // ─── Trade Frequency Tracking ───

  /** Record a trade execution for frequency throttling */
  recordTrade(): void {
    this.tradeTimestamps.push(Date.now());
    // v2.0.211: Time-based pruning — remove timestamps older than
    // tradeFrequencyWindow * decisionIntervalMs. Previous count-based pruning
    // never expired old trades, so after maxTradesPerWindow trades the throttle
    // was permanent (timestamps only pruned at 2x window, kept last window count
    // which was still >= maxTradesPerWindow). This caused the system to stop
    // trading permanently after 3 trades.
    const windowMs = this.config.tradeFrequencyWindow * this.decisionIntervalMs;
    const cutoff = Date.now() - windowMs;
    this.tradeTimestamps = this.tradeTimestamps.filter(ts => ts > cutoff);
  }

  /** Count trades in the recent frequency window */
  private countRecentTradesInWindow(): number {
    // v2.0.211: Only count timestamps within the time window
    const windowMs = this.config.tradeFrequencyWindow * this.decisionIntervalMs;
    const cutoff = Date.now() - windowMs;
    return this.tradeTimestamps.filter(ts => ts > cutoff).length;
  }

  /** Check if trade frequency limit is reached */
  isTradeFrequencyLimited(): boolean {
    return this.countRecentTradesInWindow() >= this.config.maxTradesPerWindow;
  }

  /** Get remaining trade slots in current window */
  getRemainingTradeSlots(): number {
    return Math.max(0, this.config.maxTradesPerWindow - this.countRecentTradesInWindow());
  }

  // ─── Conviction Gate ───

  /** Get the current adaptive conviction threshold for trade entry */
  getConvictionThreshold(): number {
    return this.currentConvictionThreshold;
  }

  /** Check if a conviction score passes the adaptive gate */
  passesConvictionGate(conviction: number): boolean {
    return conviction >= this.currentConvictionThreshold;
  }

  // ─── State Access ───

  /** Get filter state for a channel (for debugging/UI) */
  getChannelState(channel: SignalChannel): ChannelFilterState | undefined {
    return this.channelStates.get(channel);
  }

  /** Get all channel states (for UI display) */
  getAllChannelStates(): Record<string, ChannelFilterState> {
    const result: Record<string, ChannelFilterState> = {};
    for (const [ch, state] of this.channelStates) {
      result[ch] = state;
    }
    return result;
  }

  /** Get a summary string for agent context injection */
  getFilterSummary(): string {
    const states = this.getAllChannelStates();
    const lines: string[] = [
      `=== ADAPTIVE NOISE FILTER (v2.0.106) — ${this.symbol} ===`,
      `Profile: ${this.config.profileType} — ${this.getProfileDescription()}`,
      `Conviction Gate: ${(this.currentConvictionThreshold * 100).toFixed(0)}% (floor ${(this.config.convictionFloor * 100).toFixed(0)}%, ceiling ${(this.config.convictionCeiling * 100).toFixed(0)}%)`,
      `Trade Frequency: ${this.countRecentTradesInWindow()}/${this.config.maxTradesPerWindow} in window${this.isTradeFrequencyLimited() ? ' — THROTTLED' : ''}`,
      `Channel Parameters:`,
    ];

    for (const [ch, s] of Object.entries(states)) {
      lines.push(`  ${ch.padEnd(22)} α=${s.alpha.toFixed(3)} k=${s.k.toFixed(2)} SNR=${(s.snr * 100).toFixed(0)}% noise=${s.noiseEstimate.toFixed(4)}`);
    }

    return lines.join('\n');
  }

  /** Get a compact summary for agent context (shorter version) */
  getCompactSummary(): string {
    let avgAlpha = 0, avgSnr = 0, count = 0;
    for (const s of this.channelStates.values()) {
      avgAlpha += s.alpha;
      avgSnr += s.snr;
      count++;
    }
    avgAlpha /= count;
    avgSnr /= count;

    return [
      `=== ADAPTIVE FILTER [${this.symbol}] (${this.config.profileType}) ===`,
      `Smoothing: α=${avgAlpha.toFixed(3)} (lower=more smooth) | SNR=${(avgSnr * 100).toFixed(0)}%`,
      `Conviction Gate: ${(this.currentConvictionThreshold * 100).toFixed(0)}% | Trade Freq: ${this.countRecentTradesInWindow()}/${this.config.maxTradesPerWindow}${this.isTradeFrequencyLimited() ? ' [THROTTLED]' : ''}`,
    ].join('\n');
  }

  // ─── Persistence ───

  /** Serialize state for persistence */
  serialize(): {
    channelStates: Record<string, ChannelFilterState>;
    convictionThreshold: number;
    tradeTimestamps: number[];
    config: AdaptiveFilterConfig;
  } {
    const states: Record<string, ChannelFilterState> = {};
    for (const [ch, s] of this.channelStates) {
      states[ch] = { ...s, rawHistory: s.rawHistory.slice(-10) }; // keep last 10 for SNR seed
    }
    return {
      channelStates: states,
      convictionThreshold: this.currentConvictionThreshold,
      tradeTimestamps: this.tradeTimestamps.slice(-this.config.tradeFrequencyWindow),
      config: this.config,
    };
  }

  /** Restore state from persistence */
  deserialize(data: {
    channelStates?: Record<string, ChannelFilterState>;
    convictionThreshold?: number;
    tradeTimestamps?: number[];
    config?: Partial<AdaptiveFilterConfig>;
  }): void {
    if (data.config) {
      this.config = { ...this.config, ...data.config };
    }
    if (data.convictionThreshold !== undefined) {
      this.currentConvictionThreshold = data.convictionThreshold;
    }
    if (data.tradeTimestamps) {
      this.tradeTimestamps = data.tradeTimestamps;
    }
    if (data.channelStates) {
      for (const [ch, s] of Object.entries(data.channelStates)) {
        this.channelStates.set(ch as SignalChannel, s);
      }
    }
  }
}

// ─── Asset Filter Registry (v2.0.106) ───
//
// Manages per-asset AdaptiveNoiseFilter instances.
// Market Agent selects a FilterProfile for each asset, and this registry
// creates and maintains the corresponding filter instances.
//
// Each asset gets its own independent filter with:
//   - Independent EMA channel states (price, OB, volume, etc.)
//   - Independent alpha/k adaptation
//   - Independent conviction gate
//   - Independent trade frequency tracking

export class AssetFilterRegistry {
  private filters: Map<string, AdaptiveNoiseFilter> = new Map();
  /** Map of symbol → profile type (assigned by Market Agent) */
  private profileAssignments: Map<string, FilterProfileType> = new Map();
  /** v2.0.211: Decision interval for all filters (set from index.ts) */
  private decisionIntervalMs: number = 300_000;

  /** v2.0.211: Set decision interval for all current and future filters */
  setDecisionInterval(ms: number): void {
    this.decisionIntervalMs = ms;
    for (const filter of this.filters.values()) {
      filter.setDecisionInterval(ms);
    }
  }

  /**
   * Assign a filter profile to an asset.
   * Called by Market Agent when it selects/judges an asset.
   * Creates a new filter instance if one doesn't exist, or reconfigures
   * the existing one with the new profile's bounds.
   */
  assignProfile(symbol: string, profileType: FilterProfileType): AdaptiveNoiseFilter {
    const profile = FILTER_PROFILES[profileType];
    if (!profile) {
      log.warn(`Unknown filter profile: ${profileType}, using default`);
      return this.assignProfile(symbol, 'default');
    }

    this.profileAssignments.set(symbol, profileType);
    const existing = this.filters.get(symbol);

    if (existing) {
      // Reconfigure existing filter with new profile bounds
      const oldState = existing.serialize();
      const newConfig = configFromProfile(profile);
      const newFilter = new AdaptiveNoiseFilter(newConfig, symbol);
      // Preserve channel states and conviction from old filter
      newFilter.deserialize({
        channelStates: oldState.channelStates,
        convictionThreshold: oldState.convictionThreshold,
        tradeTimestamps: oldState.tradeTimestamps,
      });
      this.filters.set(symbol, newFilter);
      newFilter.setDecisionInterval(this.decisionIntervalMs);
      log.info(`AssetFilterRegistry: reassigned ${symbol} → ${profileType}`);
      return newFilter;
    }

    // Create new filter from profile
    const filter = AdaptiveNoiseFilter.fromProfile(symbol, profile);
    filter.setDecisionInterval(this.decisionIntervalMs);
    this.filters.set(symbol, filter);
    log.info(`AssetFilterRegistry: assigned ${symbol} → ${profileType}`);
    return filter;
  }

  /** Get the filter for an asset (creates default if not assigned) */
  getFilter(symbol: string): AdaptiveNoiseFilter {
    let filter = this.filters.get(symbol);
    if (!filter) {
      // Auto-assign based on symbol characteristics
      const profileType = this.autoDetectProfile(symbol);
      filter = this.assignProfile(symbol, profileType);
    }
    return filter;
  }

  /** Get the profile type assigned to an asset */
  getProfileType(symbol: string): FilterProfileType {
    return this.profileAssignments.get(symbol) ?? 'default';
  }

  /** Check if a filter exists for an asset */
  hasFilter(symbol: string): boolean {
    return this.filters.has(symbol);
  }

  /** Get all asset filters */
  getAllFilters(): Map<string, AdaptiveNoiseFilter> {
    return this.filters;
  }

  /** Remove a filter for an asset (e.g. when asset is removed from trading markets) */
  removeFilter(symbol: string): void {
    this.filters.delete(symbol);
    this.profileAssignments.delete(symbol);
  }

  /**
   * Auto-detect the appropriate filter profile for a symbol based on
   * its naming convention and asset type.
   *
   * This is the FALLBACK when Market Agent hasn't explicitly assigned a profile.
   * Market Agent's `selectFilterProfile()` is the primary method — it uses
   * real market data (volatility, liquidity, volume) to make a more informed
   * choice. This auto-detection is used only for initial assignment before
   * Market Agent has had a chance to evaluate the asset.
   */
  autoDetectProfile(symbol: string): FilterProfileType {
    const symLower = symbol.toLowerCase();

    // DEX perps (xyz: prefix)
    if (symLower.startsWith('xyz:')) {
      const asset = symLower.slice(4);
      // Forex pairs
      if (/^(eur|gbp|jpy|aud|cad|chf|nzd|usd)/.test(asset) || /^(eurusd|gbpusd|usdjpy|audusd|usdcad|nzdusd|usdchf)/.test(asset)) {
        return 'forex_index';
      }
      // Indices
      if (/^(sp500|spx|nasdaq|ndx|ni225|nikkei|dax|ftse|hsi|spx500|nas100|ger30|uk100)/.test(asset)) {
        return 'forex_index';
      }
      // Commodities
      if (/^(xau|gold|silver|xag|oil|wti|brent|copper|natgas|gas)/.test(asset)) {
        return 'commodity';
      }
      // Default for DEX perps
      return 'dex_perp';
    }

    // High-volume crypto (BTC, ETH)
    if (/^(btc|eth|sol|bnb)$/.test(symLower)) {
      return 'high_vol_crypto';
    }

    // Known high-vol alts (meme coins, small caps)
    if (/^(doge|shib|pepe|wif|bonk|floki|meme|pump|wen|bome)/.test(symLower)) {
      return 'high_vol_alt';
    }

    // Stablecoins (shouldn't trade, but just in case)
    if (/^(usdt|usdc|dai|busd|tusd|frax)/.test(symLower)) {
      return 'low_vol_crypto';
    }

    // Default for other crypto
    return 'high_vol_crypto';
  }

  /**
   * Generate a summary of all asset filters for agent context.
   * This is injected into Meta-Agent context so it can see the filter
   * state for ALL assets it's analyzing.
   */
  getAllFiltersSummary(): string {
    if (this.filters.size === 0) {
      return '=== ADAPTIVE FILTERS ===\n(No asset filters initialized yet)';
    }

    const lines: string[] = ['=== ADAPTIVE FILTERS (per-asset) ==='];

    for (const [symbol, filter] of this.filters) {
      const profile = filter.getProfileType();
      const conviction = filter.getConvictionThreshold();
      const throttled = filter.isTradeFrequencyLimited();
      const remaining = filter.getRemainingTradeSlots();

      // Get average SNR across channels
      const states = filter.getAllChannelStates();
      let avgSnr = 0, avgAlpha = 0, count = 0;
      for (const s of Object.values(states)) {
        avgSnr += s.snr;
        avgAlpha += s.alpha;
        count++;
      }
      if (count > 0) { avgSnr /= count; avgAlpha /= count; }

      lines.push(`  ${symbol.padEnd(14)} [${profile}]`);
      lines.push(`    α=${avgAlpha.toFixed(3)} SNR=${(avgSnr * 100).toFixed(0)}% conviction_gate=${(conviction * 100).toFixed(0)}% trades=${remaining}/${filter['config'].maxTradesPerWindow}${throttled ? ' [THROTTLED]' : ''}`);
    }

    return lines.join('\n');
  }

  /**
   * Generate a compact per-asset filter summary for Meta-Agent context.
   * v2.0.106: Meta-Agent MUST receive this and factor it into every decision.
   */
  getMetaAgentSummary(): string {
    if (this.filters.size === 0) return '';

    const lines: string[] = [
      '=== PER-ASSET NOISE FILTER STATUS (Market Agent judgment) ===',
      '⚠️ CRITICAL: Review each asset\'s filter state before deciding. High noise = signal unreliable.',
      '',
    ];

    for (const [symbol, filter] of this.filters) {
      const profile = filter.getProfileType();
      const conviction = filter.getConvictionThreshold();
      const throttled = filter.isTradeFrequencyLimited();

      const states = filter.getAllChannelStates();
      let avgSnr = 0, avgAlpha = 0, count = 0;
      for (const s of Object.values(states)) {
        avgSnr += s.snr;
        avgAlpha += s.alpha;
        count++;
      }
      if (count > 0) { avgSnr /= count; avgAlpha /= count; }

      // Noise level assessment
      const noiseLevel = avgSnr < 0.3 ? 'HIGH (signal unreliable — require strong conviction)'
        : avgSnr < 0.5 ? 'MODERATE (caution — signal partially noise)'
        : avgSnr < 0.7 ? 'LOW (signal mostly clean)'
        : 'VERY LOW (signal clean — confident entry OK)';

      lines.push(`${symbol} [${profile}]:`);
      lines.push(`  Smoothing: α=${avgAlpha.toFixed(3)} | SNR=${(avgSnr * 100).toFixed(0)}% | Noise: ${noiseLevel}`);
      lines.push(`  Conviction Gate: ${(conviction * 100).toFixed(0)}%${throttled ? ' | ⛔ TRADE FREQUENCY THROTTLED' : ''}`);
    }

    return lines.join('\n');
  }
}