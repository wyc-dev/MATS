/**
 * ─── Planck-Chaos Resonance Module ───
 *
 * Integrates quantum physics (Planck constant) and chaos theory (Lyapunov exponent)
 * to detect hidden resonances in price action and predict 2-8 hour amplitude windows.
 *
 * Core concepts:
 * 1. Markets are deterministic chaotic systems — prediction error grows as e^(λt)
 *    where λ is the Lyapunov exponent. Beyond ~30 min, direction is unpredictable.
 * 2. Price moves in discrete ticks (quantum-like events). Few-hour amplitude is
 *    the statistical accumulation of many tick events — predictable via diffusion:
 *    Amplitude ≈ √(2Dt) where D = volatility²/2.
 * 3. Hidden resonances (dominant frequencies) in price action reveal when the
 *    market is "in sync" with a repeating pattern — these windows are tradeable.
 *
 * @module planck-chaos
 */

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'planck-chaos' });

// ─── Types ───

export interface LyapunovEstimate {
  /** Lyapunov exponent λ — positive = chaotic, negative = stable/converging */
  lambda: number;
  /** Predictability horizon in minutes (time for error to grow 2x) */
  predictabilityHorizonMin: number;
  /** Confidence in the estimate (0-1, based on sample size) */
  confidence: number;
}

export interface ResonanceFrequency {
  /** Dominant cycle period in minutes */
  periodMin: number;
  /** Strength of this frequency (0-1, relative to total power) */
  strength: number;
  /** Phase position (0-1, where in the cycle we are now) */
  phase: number;
}

export interface AmplitudeWindow {
  /** Predicted price range for the next T hours */
  upperBound: number;
  lowerBound: number;
  /** Expected midpoint */
  midpoint: number;
  /** Confidence in the prediction (0-1) */
  confidence: number;
  /** Hours predicted ahead */
  hoursAhead: number;
  /** Diffusion coefficient D = σ²/2 */
  diffusionCoeff: number;
}

export interface PlanckChaosResult {
  /** Lyapunov exponent estimate */
  lyapunov: LyapunovEstimate;
  /** Detected resonance frequencies (sorted by strength) */
  resonances: ResonanceFrequency[];
  /** Predicted amplitude windows for 2h, 4h, 8h */
  amplitudeWindows: AmplitudeWindow[];
  /** Current regime classification based on chaos analysis */
  chaosRegime: 'predictable' | 'chaotic' | 'edge_of_chaos' | 'laminar';
  /** Resonance strength (0-1) — how "in sync" the market is */
  resonanceStrength: number;
  // v2.0.41: directionBias REMOVED — regime-aware mean-reversion in index.ts
  // already does the same thing. Having two direction signals caused
  // confusion. Planck-Chaos now only provides Lyapunov (predictability)
  // + amplitude windows (SL/TP validation) + resonance (cycle detection
  // as informational context). Direction is handled by the regime-aware
  // direction chain in index.ts.
  //
  // ⚠️ MAINTENANCE NOTE: If you re-add directionBias, you MUST update the
  // exploration direction chain in index.ts (Priority -1 block) and ensure
  // it doesn't conflict with the regime-aware direction logic (Priority 0).
  /** Formatted context string for agent injection */
  contextString: string;
  /** Timestamp of this analysis */
  timestamp: number;
}

// ─── Constants ───

/** Minimum number of price samples needed for analysis */
const MIN_SAMPLES = 50;
/** Maximum samples to keep in the price buffer */
const MAX_SAMPLES = 500;
/** Lyapunov estimation window (number of samples to compare) */
const LYAPUNOV_WINDOW = 20;
/** FFT-like frequency detection: number of periods to check */
const FREQUENCY_PERIODS = [15, 30, 60, 120, 240, 480]; // minutes

// ─── PlanckChaosEngine ───

export class PlanckChaosEngine {
  private priceBuffer: number[] = [];
  private timeBuffer: number[] = [];
  private lastResult: PlanckChaosResult | null = null;

  /**
   * Feed a new price tick into the engine.
   * Prices should be at regular intervals (e.g. every 30s from REST polling).
   */
  feedPrice(price: number, timestamp: number): void {
    this.priceBuffer.push(price);
    this.timeBuffer.push(timestamp);
    if (this.priceBuffer.length > MAX_SAMPLES) {
      this.priceBuffer.shift();
      this.timeBuffer.shift();
    }
  }

  /**
   * Run the full Planck-Chaos analysis on the current price buffer.
   * Returns null if insufficient data.
   */
  analyze(currentPrice: number, volatility: number): PlanckChaosResult | null {
    if (this.priceBuffer.length < MIN_SAMPLES) {
      log.info(`[planck-chaos] Insufficient data: ${this.priceBuffer.length}/${MIN_SAMPLES} samples`);
      return null;
    }

    const prices = this.priceBuffer;
    const n = prices.length;

    // ── 1. Lyapunov Exponent Estimation ──
    // Estimate λ by measuring how quickly nearby trajectories diverge.
    // We use the "nearest neighbor divergence" method:
    // For each point i, find the nearest neighbor j, measure |x[i+k] - x[j+k]| / |x[i] - x[j]|
    // The growth rate of this ratio gives λ.
    const lyapunov = this.estimateLyapunov(prices);

    // ── 2. Resonance Frequency Detection ──
    // Detect dominant cycle periods using autocorrelation.
    // This is a simplified FFT — we check specific periods and measure
    // how well the price correlates with itself at that lag.
    const resonances = this.detectResonances(prices, this.timeBuffer, currentPrice);

    // ── 3. Amplitude Window Prediction ──
    // Using diffusion model: Amplitude ≈ √(2Dt) where D = σ²/2
    // This gives the EXPECTED range, not the exact price.
    const amplitudeWindows = this.predictAmplitudeWindows(currentPrice, volatility);

    // ── 4. Chaos Regime Classification ──
    const chaosRegime = this.classifyChaosRegime(lyapunov.lambda, resonances);

    // ── 5. Resonance Strength ──
    const resonanceStrength = this.calculateResonanceStrength(resonances);

    // v2.0.41: directionBias REMOVED — regime-aware mean-reversion in
    // index.ts already handles direction. Planck-Chaos now focuses on
    // predictability (Lyapunov) + amplitude (diffusion model) only.
    // Resonance is kept as informational context for agents.

    // ── 6. Build context string ──
    const contextString = this.buildContextString(
      lyapunov, resonances, amplitudeWindows, chaosRegime, resonanceStrength
    );

    const result: PlanckChaosResult = {
      lyapunov,
      resonances,
      amplitudeWindows,
      chaosRegime,
      resonanceStrength,
      contextString,
      timestamp: Date.now(),
    };

    this.lastResult = result;
    return result;
  }

  /**
   * Estimate the Lyapunov exponent using nearest-neighbor divergence.
   * λ > 0 → chaotic (unpredictable beyond horizon)
   * λ ≈ 0 → edge of chaos (marginally predictable)
   * λ < 0 → laminar/stable (predictable)
   */
  private estimateLyapunov(prices: number[]): LyapunovEstimate {
    const n = prices.length;
    const k = LYAPUNOV_WINDOW; // steps ahead to measure divergence
    let totalLogDivergence = 0;
    let pairs = 0;

    for (let i = 0; i < n - k - 1; i++) {
      // Find nearest neighbor (smallest |price[i] - price[j]| for j != i)
      let minDist = Infinity;
      let nearestJ = -1;
      for (let j = 0; j < n - k - 1; j++) {
        if (j === i) continue;
        const dist = Math.abs(prices[i]! - prices[j]!);
        if (dist < minDist && dist > 0) {
          minDist = dist;
          nearestJ = j;
        }
      }
      if (nearestJ < 0) continue;

      // Measure divergence after k steps
      const initialDist = Math.abs(prices[i]! - prices[nearestJ]!);
      const finalDist = Math.abs(prices[i + k]! - prices[nearestJ + k]!);
      if (initialDist > 0 && finalDist > 0) {
        totalLogDivergence += Math.log(finalDist / initialDist);
        pairs++;
      }
    }

    const lambda = pairs > 0 ? totalLogDivergence / (pairs * k) : 0;
    // Predictability horizon: time for error to double = ln(2) / λ
    const predictabilityHorizonMin = lambda > 0
      ? (Math.LN2 / lambda) * (this.timeBuffer.length > 1
          ? (this.timeBuffer[1]! - this.timeBuffer[0]!) / 1000 / 60  // interval in minutes
          : 0.5) // default 30s = 0.5 min
      : Infinity;

    const confidence = Math.min(1, pairs / 100);

    return { lambda, predictabilityHorizonMin, confidence };
  }

  /**
   * Detect dominant cycle frequencies using autocorrelation.
   * Checks specific periods (15min, 30min, 1h, 2h, 4h, 8h) and measures
   * how well the price correlates with itself at that lag.
   */
  private detectResonances(prices: number[], times: number[], currentPrice?: number): ResonanceFrequency[] {
    const n = prices.length;
    if (n < 30 || times.length < 2) return [];

    // Calculate average interval between samples (in minutes)
    const avgInterval = (times[n - 1]! - times[0]!) / (n - 1) / 1000 / 60;

    const results: ResonanceFrequency[] = [];

    for (const targetPeriod of FREQUENCY_PERIODS) {
      // Convert period to sample lag
      const lag = Math.round(targetPeriod / avgInterval);
      if (lag < 2 || lag >= n / 2) continue;

      // Calculate autocorrelation at this lag
      const mean = prices.reduce((a, b) => a + b, 0) / n;
      let numerator = 0;
      let denominator = 0;
      for (let i = 0; i < n - lag; i++) {
        numerator += (prices[i]! - mean) * (prices[i + lag]! - mean);
      }
      for (let i = 0; i < n; i++) {
        denominator += (prices[i]! - mean) ** 2;
      }
      const autocorr = denominator > 0 ? numerator / denominator : 0;

      if (autocorr > 0.1) {
        // Phase: where in the cycle are we?
        // Use the last `lag` samples to estimate phase
        const recentPrices = prices.slice(-lag);
        const cycleMin = Math.min(...recentPrices);
        const cycleMax = Math.max(...recentPrices);
        const range = cycleMax - cycleMin;
        const phase = range > 0 ? ((currentPrice ?? prices[prices.length - 1]!) - cycleMin) / range : 0.5;

        results.push({
          periodMin: targetPeriod,
          strength: Math.abs(autocorr),
          phase: Math.max(0, Math.min(1, phase)),
        });
      }
    }

    // Sort by strength (descending)
    results.sort((a, b) => b.strength - a.strength);
    return results;
  }

  /**
   * Predict amplitude windows using the diffusion model.
   * Amplitude ≈ √(2Dt) where D = σ²/2
   * This gives the expected price RANGE, not the exact price.
   */
  private predictAmplitudeWindows(currentPrice: number, volatility: number): AmplitudeWindow[] {
    const sigma = volatility; // volatility as decimal (e.g. 0.02 = 2%)
    const D = (sigma * sigma) / 2; // diffusion coefficient

    const windows: AmplitudeWindow[] = [];
    for (const hours of [2, 4, 8]) {
      const t = hours * 3600; // seconds
      // Amplitude in price terms: currentPrice * √(2Dt)
      // D is per-second, t is in seconds
      // But volatility is typically per-cycle (5 min), so we need to scale
      // Assume volatility is per-cycle (300s), so D_per_sec = D / 300
      const D_per_sec = D / 300;
      const amplitude = currentPrice * Math.sqrt(2 * D_per_sec * t);

      windows.push({
        upperBound: currentPrice + amplitude,
        lowerBound: currentPrice - amplitude,
        midpoint: currentPrice,
        confidence: Math.max(0.3, Math.min(0.95, 1 - hours / 12)), // confidence decreases with time
        hoursAhead: hours,
        diffusionCoeff: D_per_sec,
      });
    }
    return windows;
  }

  /**
   * Classify the chaos regime based on Lyapunov exponent and resonances.
   */
  private classifyChaosRegime(lambda: number, resonances: ResonanceFrequency[]): PlanckChaosResult['chaosRegime'] {
    if (lambda < -0.01) return 'laminar';
    if (lambda > 0.05) return 'chaotic';
    if (Math.abs(lambda) <= 0.05 && resonances.length > 0 && resonances[0]!.strength > 0.3) {
      return 'edge_of_chaos';
    }
    return 'predictable';
  }

  /**
   * Calculate overall resonance strength (0-1).
   * Higher = more "in sync" with a repeating pattern = more tradeable.
   */
  private calculateResonanceStrength(resonances: ResonanceFrequency[]): number {
    if (resonances.length === 0) return 0;
    const topStrengths = resonances.slice(0, 3).map(r => r.strength);
    return Math.min(1, topStrengths.reduce((a, b) => a + b, 0) / 1.5);
  }

  // v2.0.41: deriveDirectionBias() REMOVED — regime-aware mean-reversion
  // in index.ts already handles direction. This method was redundant with
  // the regime-aware direction chain (Priority 0 in exploration).
  //
  // ⚠️ MAINTENANCE NOTE: If you re-add direction bias, update the
  // exploration direction chain in index.ts and this file's
  // PlanckChaosResult interface + buildContextString().

  /**
   * Build a formatted context string for injection into agent prompts.
   * v2.0.41: directionBias line removed — only Lyapunov + amplitude +
   * resonance are shown.
   */
  private buildContextString(
    lyapunov: LyapunovEstimate,
    resonances: ResonanceFrequency[],
    amplitudeWindows: AmplitudeWindow[],
    chaosRegime: PlanckChaosResult['chaosRegime'],
    resonanceStrength: number,
  ): string {
    const lines: string[] = [];
    lines.push('=== PLANCK-CHAOS RESONANCE ===');

    // Chaos regime
    const regimeLabel = {
      'predictable': '🟢 PREDICTABLE',
      'chaotic': '🔴 CHAOTIC',
      'edge_of_chaos': '🟡 EDGE OF CHAOS',
      'laminar': '🔵 LAMINAR',
    }[chaosRegime];
    lines.push(`Regime: ${regimeLabel}`);

    // Lyapunov
    lines.push(`Lyapunov λ=${lyapunov.lambda.toFixed(4)} | Horizon=${lyapunov.predictabilityHorizonMin < 9999 ? lyapunov.predictabilityHorizonMin.toFixed(0) + 'min' : '∞'} | Conf=${(lyapunov.confidence * 100).toFixed(0)}%`);

    // Resonances
    if (resonances.length > 0) {
      const top = resonances.slice(0, 3);
      lines.push(`Resonances: ${top.map(r => `${r.periodMin}min(${(r.strength * 100).toFixed(0)}%, phase=${(r.phase * 100).toFixed(0)}%)`).join(', ')}`);
      lines.push(`Resonance strength: ${(resonanceStrength * 100).toFixed(0)}%`);
    } else {
      lines.push('Resonances: none detected');
    }

    // Amplitude windows
    for (const w of amplitudeWindows) {
      const range = w.upperBound - w.lowerBound;
      lines.push(`${w.hoursAhead}h window: $${w.lowerBound.toFixed(2)} - $${w.upperBound.toFixed(2)} (range $${range.toFixed(2)}, conf ${(w.confidence * 100).toFixed(0)}%)`);
    }

    // v2.0.41: directionBias line removed — regime-aware direction in index.ts

    lines.push('---');
    return lines.join('\n');
  }

  /** Get the last analysis result (cached) */
  getLastResult(): PlanckChaosResult | null {
    return this.lastResult;
  }

  /** Get formatted context for agent injection (cached) */
  getContextString(): string {
    return this.lastResult?.contextString ?? '';
  }
}