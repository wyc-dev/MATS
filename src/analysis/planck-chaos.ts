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
 * v2.0.871-P7(主神 BTC 永遠 chaotic 調查):estimator 重寫 + per-symbol 隔離
 * ── 舊 estimator(level-space nearest-neighbor, k=20)有兩個致命缺陷:
 *   1. 對「原始價格水平」做 nearest-neighbor,量度嘅係擴散唔係混沌:
 *      Monte Carlo 證實 random walk / OU / 趨勢 / sine 全部 20/20 誤判
 *      chaotic(λ≈0.2-0.3 >> 0.05 門檻)→ BTC 永遠「🔴 CHAOTIC」→ 永遠 HOLD。
 *   2. 單一 global buffer:WS 只訂閱 active symbol,但切 symbol 後 buffer
 *      混埋兩個 symbol 嘅價格,nearest-neighbor 完全垃圾。
 * 新 estimator:標準 Rosenstein slope 法(Rosenstein et al. 1993):
 *   - log-returns + time-delay embedding(m=3, τ=3, Theiler window m·τ)
 *   - S(k) = ⟨ln d_i(k)⟩(mean log divergence curve)
 *   - λ = least-squares slope of S(k) over k∈[1,5],per tick → 換算 per minute
 *   - iid 序列 S(k) 平坦 → λ≈0;真混沌指數發散 → λ>0;OU 收斂 → λ<0
 *   - 驗證:scripts/p7-lyapunov-experiment.ts 8/8 ground truth 全過
 *     (RW/OU/趨勢/sine/厚尾 → 唔判 chaotic;Lorenz → 判 chaotic)
 *
 * @module planck-chaos
 */

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'planck-chaos' });

// ─── Types ───

export interface LyapunovEstimate {
  /** Lyapunov exponent λ (per MINUTE) — positive = chaotic, negative = stable/converging */
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

/** Minimum number of price samples needed for analysis (per symbol) */
const MIN_SAMPLES = 50;
/** Maximum samples to keep in the price buffer (per symbol) */
const MAX_SAMPLES = 500;
/** Embedding dimension (Rosenstein method, m=3 validated by P7 experiment) */
const EMBED_DIM = 3;
/** Time-delay embedding lag in samples (τ=3 validated by P7 experiment) */
const EMBED_TAU = 3;
/** Slope fit window: λ estimated from S(k) over k ∈ [K1, K2] (P7 validated) */
const SLOPE_K1 = 1;
const SLOPE_K2 = 5;
/** Minimum embedded vectors required for a meaningful estimate */
const MIN_EMBEDDED = 20;
/** FFT-like frequency detection: number of periods to check */
const FREQUENCY_PERIODS = [15, 30, 60, 120, 240, 480]; // minutes

// ─── PlanckChaosEngine ───

interface SymbolChaosState {
  priceBuffer: number[];
  timeBuffer: number[];
  lastResult: PlanckChaosResult | null;
}

export class PlanckChaosEngine {
  // v2.0.871-P7: per-symbol state — 切 symbol 唔會污染 buffer
  private states = new Map<string, SymbolChaosState>();

  private getState(symbol: string): SymbolChaosState {
    const key = String(symbol ?? '').toLowerCase();
    let st = this.states.get(key);
    if (!st) {
      st = { priceBuffer: [], timeBuffer: [], lastResult: null };
      this.states.set(key, st);
    }
    return st;
  }

  /**
   * Feed a new price tick into the engine (per symbol).
   * Prices should be at regular intervals (e.g. every 30s from WS marks).
   * Non-finite / non-positive prices are silently ignored (attack hardening).
   */
  feedPrice(symbol: string, price: number, timestamp: number): void {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp)) return;
    const st = this.getState(symbol);
    st.priceBuffer.push(price);
    st.timeBuffer.push(timestamp);
    if (st.priceBuffer.length > MAX_SAMPLES) {
      st.priceBuffer.shift();
      st.timeBuffer.shift();
    }
  }

  /**
   * Run the full Planck-Chaos analysis for one symbol's price buffer.
   * Returns null if that symbol has insufficient data.
   */
  analyze(symbol: string, currentPrice: number, volatility: number): PlanckChaosResult | null {
    const st = this.getState(symbol);
    if (st.priceBuffer.length < MIN_SAMPLES) {
      log.info(`[planck-chaos] ${symbol}: insufficient data: ${st.priceBuffer.length}/${MIN_SAMPLES} samples`);
      return null;
    }

    const prices = st.priceBuffer;
    const times = st.timeBuffer;

    // ── 1. Lyapunov Exponent Estimation (Rosenstein slope, per minute) ──
    const lyapunov = this.estimateLyapunov(prices, times);

    // ── 2. Resonance Frequency Detection ──
    const resonances = this.detectResonances(prices, times, currentPrice);

    // ── 3. Amplitude Window Prediction (diffusion model) ──
    const amplitudeWindows = this.predictAmplitudeWindows(currentPrice, volatility);

    // ── 4. Chaos Regime Classification ──
    const chaosRegime = this.classifyChaosRegime(lyapunov.lambda, resonances);

    // ── 5. Resonance Strength ──
    const resonanceStrength = this.calculateResonanceStrength(resonances);

    // ── 4/6. Build context string ──
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

    st.lastResult = result;
    return result;
  }

  /**
   * v2.0.871-P7: Estimate the largest Lyapunov exponent with the standard
   * Rosenstein slope method on log-returns with time-delay embedding.
   *
   *   1. r[t] = ln(p[t]/p[t-1])            (stationary increments)
   *   2. embed: v_i = (r[i], r[i+τ], r[i+2τ]), m=3, τ=3
   *   3. for each i: nearest neighbour j (|i−j| > m·τ, Theiler exclusion)
   *   4. S(k) = ⟨ln d_i(k)⟩  where d_i(k) = ‖v_i(k) − v_j(k)‖ (embedded, k steps ahead)
   *   5. λ_per_tick = least-squares slope of S(k) over k ∈ [1,5]
   *   6. λ_per_min = λ_per_tick / median_tick_interval_min
   *
   * Slope (not ratio-to-d0) is unbiased: iid series have flat S(k) → λ≈0,
   * chaotic attractors diverge exponentially → λ>0, converging processes → λ<0.
   * Validated against 8 ground-truth synthetic markets (scripts/p7-lyapunov-experiment.ts).
   */
  private estimateLyapunov(prices: number[], times: number[]): LyapunovEstimate {
    const K = SLOPE_K2;
    // ── 1. log returns (skip non-finite / non-positive defensively) ──
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1]!, cur = prices[i]!;
      if (Number.isFinite(prev) && Number.isFinite(cur) && prev > 0 && cur > 0) {
        returns.push(Math.log(cur / prev));
      }
    }
    const n = returns.length;
    const nEmb = n - (EMBED_DIM - 1) * EMBED_TAU - K;
    if (nEmb < MIN_EMBEDDED) {
      return { lambda: 0, predictabilityHorizonMin: Infinity, confidence: 0 };
    }

    const excl = EMBED_DIM * EMBED_TAU; // Theiler window — exclude temporal neighbours
    const sumLog = new Array<number>(K + 1).fill(0);
    let count = 0;

    for (let i = 0; i < nEmb; i++) {
      // Nearest neighbour in embedded space (Theiler-excluded)
      let bestJ = -1, bestD2 = Infinity;
      for (let j = 0; j < nEmb; j++) {
        if (Math.abs(i - j) <= excl) continue;
        let d2 = 0;
        for (let d = 0; d < EMBED_DIM; d++) {
          const diff = returns[i + d * EMBED_TAU]! - returns[j + d * EMBED_TAU]!;
          d2 += diff * diff;
        }
        if (d2 < bestD2) { bestD2 = d2; bestJ = j; }
      }
      if (bestJ < 0 || bestD2 <= 0) continue;

      // Divergence curve d_i(k) for k = 0..K
      for (let k = 0; k <= K; k++) {
        let d2k = 0;
        for (let d = 0; d < EMBED_DIM; d++) {
          const a = returns[i + d * EMBED_TAU + k]!;
          const b = returns[bestJ + d * EMBED_TAU + k]!;
          d2k += (a - b) * (a - b);
        }
        if (d2k > 0) sumLog[k]! += 0.5 * Math.log(d2k);
      }
      count++;
    }

    if (count === 0) {
      return { lambda: 0, predictabilityHorizonMin: Infinity, confidence: 0 };
    }
    const S = sumLog.map(v => v / count);

    // Least-squares slope over k ∈ [K1, K2]
    let num = 0, den = 0;
    const kmid = (SLOPE_K1 + SLOPE_K2) / 2;
    for (let k = SLOPE_K1; k <= SLOPE_K2; k++) {
      num += (k - kmid) * S[k]!;
      den += (k - kmid) * (k - kmid);
    }
    const lambdaPerTick = den > 0 ? num / den : 0;

    // Convert to per-minute using the MEDIAN tick interval (robust to bursts/gaps)
    const intervalMin = this.medianIntervalMin(times);
    const lambdaPerMin = intervalMin > 0 ? lambdaPerTick / intervalMin : lambdaPerTick;

    // Predictability horizon: time for error to double = ln(2) / λ
    const predictabilityHorizonMin = lambdaPerMin > 0 ? Math.LN2 / lambdaPerMin : Infinity;
    const confidence = Math.min(1, count / 100);

    return { lambda: lambdaPerMin, predictabilityHorizonMin, confidence };
  }

  /** Median inter-sample interval in minutes (fallback 0.5 = 30s ticks). */
  private medianIntervalMin(times: number[]): number {
    if (times.length < 2) return 0.5;
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const dt = (times[i]! - times[i - 1]!) / 1000 / 60;
      if (Number.isFinite(dt) && dt > 0) gaps.push(dt);
    }
    if (gaps.length === 0) return 0.5;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)]!;
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
    if (!Number.isFinite(avgInterval) || avgInterval <= 0) return [];

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
   * Classify the chaos regime based on the per-minute Lyapunov exponent and resonances.
   * Thresholds unchanged from pre-P7 — P7 experiment validated the NEW λ distribution
   * against them: RW/OU/trend ≈ 0.00 (predictable), sine ≈ 0.025 (edge via resonance),
   * Lorenz ≈ 0.18 (chaotic).
   */
  private classifyChaosRegime(lambdaPerMin: number, resonances: ResonanceFrequency[]): PlanckChaosResult['chaosRegime'] {
    if (lambdaPerMin < -0.01) return 'laminar';
    if (lambdaPerMin > 0.05) return 'chaotic';
    if (Math.abs(lambdaPerMin) <= 0.05 && resonances.length > 0 && resonances[0]!.strength > 0.3) {
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

    // Lyapunov (per minute)
    lines.push(`Lyapunov λ=${lyapunov.lambda.toFixed(4)}/min | Horizon=${lyapunov.predictabilityHorizonMin < 9999 ? lyapunov.predictabilityHorizonMin.toFixed(0) + 'min' : '∞'} | Conf=${(lyapunov.confidence * 100).toFixed(0)}%`);

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

  /** Get the last analysis result for a symbol (cached) */
  getLastResult(symbol: string): PlanckChaosResult | null {
    return this.getState(symbol).lastResult;
  }

  /** Get formatted context for agent injection for a symbol (cached) */
  getContextString(symbol: string): string {
    return this.getState(symbol).lastResult?.contextString ?? '';
  }
}