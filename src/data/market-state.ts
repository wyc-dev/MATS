// ─── Market State Aggregator ───
// v2.0.869(主神 binance-websocket 剷除):從 binance-websocket.ts 搬出——
// BinanceWebSocketManager 冇用(HL-only mode)——MarketStateAggregator 保留(regime/volatility 判斷)

import { createLogger } from '../observability/logger.ts';
import type { Ticker, MarketRegime, Trend } from '../types/index.ts';

const log = createLogger({ phase: 'data', agent: 'fractal_momentum_sentinel' });

export interface AggregatedMarketState {
  primarySymbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  trend: Trend;
  volatility: number;
  regime: MarketRegime;
  orderBookImbalance: number;
  updatedAt: number;
}

/**
 * Dynamic regime threshold calibrator.
 * Tracks the actual distribution of detected regimes over a rolling window.
 * When any single regime dominates >80% of recent observations, the calibrator
 * widens that regime's threshold boundaries so the classifier distributes
 * more evenly across adjacent regimes.
 */
export class RegimeCalibrator {
  private history: string[] = [];
  private readonly maxHistory = 500;
  /** Current adjusted thresholds (multiples of the default threshold) */
  private volHighThreshold = 0.03;    // default
  private volLowThreshold = 0.003;    // default
  private trendThreshold = 0.5;       // default 24h change %
  private readonly minDistribution = 0.4;  // aim for at least 40% non-dominant
  private consecutiveDominantCount = 0;
  lastAdjustment: string = 'default';

  /** Feed one regime observation and auto-adjust if needed. Returns new thresholds */
  observe(regime: string): { volHigh: number; volLow: number; trend: number } {
    this.history.push(regime);
    if (this.history.length > this.maxHistory) this.history.shift();
    if (this.history.length < 50) return this.getThresholds(); // not enough data

    // Count distribution
    const counts = new Map<string, number>();
    for (const r of this.history) counts.set(r, (counts.get(r) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const dominant = sorted[0];
    if (!dominant) return this.getThresholds();
    const dominantPct = dominant[1] / this.history.length;

    if (dominantPct > 0.80) {
      this.consecutiveDominantCount++;
      // Widen the dominant regime's boundary to push observations into neighbours
      if (dominant[0] === 'mean_reverting') {
        // Widen trending/vol thresholds so less data falls into mean_reverting
        this.trendThreshold *= 0.90;      // easier to trigger bullish/bearish
        this.volHighThreshold *= 1.05;     // easier to trigger high_vol
        this.volLowThreshold *= 0.95;      // easier to trigger low_vol
      } else if (dominant[0] === 'low_volatility' || dominant[0] === 'high_volatility') {
        // Tighten the vol boundary
        const factor = dominant[0] === 'low_volatility' ? 0.90 : 1.10;
        this.volLowThreshold *= factor;
        this.volHighThreshold *= factor;
      } else if (dominant[0] === 'trending_bull' || dominant[0] === 'trending_bear') {
        // Require stronger trend
        this.trendThreshold *= 1.10;
      }
      // Clamp to prevent runaway
      this.volHighThreshold = Math.max(0.008, Math.min(0.10, this.volHighThreshold));
      this.volLowThreshold = Math.max(0.0005, Math.min(0.01, this.volLowThreshold));
      this.trendThreshold = Math.max(0.1, Math.min(2.0, this.trendThreshold));
      this.lastAdjustment = `widened ${dominant[0]} boundary (dominated ${(dominantPct*100).toFixed(1)}% of ${this.history.length} obs)`;
    } else {
      this.consecutiveDominantCount = 0;
    }

    return this.getThresholds();
  }

  getThresholds(): { volHigh: number; volLow: number; trend: number } {
    return { volHigh: this.volHighThreshold, volLow: this.volLowThreshold, trend: this.trendThreshold };
  }

  getCalibrationSummary(): string {
    const t = this.getThresholds();
    return `RegimeCalibrator: mean_reverting=${t.trend}% trend threshold, high_vol>${(t.volHigh*100).toFixed(2)}%, low_vol<${(t.volLow*100).toFixed(2)}%. ${this.lastAdjustment !== 'default' ? `Last: ${this.lastAdjustment}` : 'No adjustment yet.'}`;
  }
}

export class MarketStateAggregator {
  private priceHistory: Map<string, number[]> = new Map();
  /** v2.0.820: Parallel timestamp store for calcVolatility — lets us compute
   *  the ACTUAL history time span instead of assuming 100ms/tick. The previous
   *  hardcoded 0.1s assumption understated σ by ~30× when ticks arrived slower
   *  (e.g. REST-polled non-active markets at 1 tick/4min), permanently
   *  classifying every calm symbol as low_volatility and tripping the vol-gate. */
  private priceHistoryTs: Map<string, number[]> = new Map();
  private readonly historySize = 100;
  private tickers: Map<string, Ticker> = new Map();
  private orderBookImbalance = 0;
  readonly calibrator = new RegimeCalibrator();
  /** v2.0.869(主神 市況判斷調查):per symbol threshold(LLM 判斷 + 校準)
   *  貴金屬/指數正常波動 0.03-0.3%——global threshold 0.3% 誤判低波動 */
  private symbolThresholds: Map<string, { volLow: number; volHigh: number; trend: number }> = new Map();

  /** v2.0.869:設定 per symbol threshold(LLM 判斷 + 校準後)——calcRegime 用 */
  setSymbolThreshold(symbol: string, volLow: number, volHigh: number, trend: number): void {
    const sym = String(symbol ?? '').toLowerCase();
    if (!sym || !Number.isFinite(volLow) || !Number.isFinite(volHigh) || volLow <= 0 || volLow >= volHigh) return;
    this.symbolThresholds.set(sym, { volLow, volHigh, trend: Number.isFinite(trend) ? Math.max(0.1, Math.min(2.0, trend)) : 0.5 });
  }

  update(ticker: Ticker): void {
    // Normalize symbol to lowercase for case-insensitive matching.
    // HL WebSocket sends "BTC", Market Agent may use "btc" — both must land in the same bucket.
    const sym = ticker.symbol.toLowerCase();
    this.tickers.set(sym, ticker);
    if (!this.priceHistory.has(sym)) {
      this.priceHistory.set(sym, []);
      this.priceHistoryTs.set(sym, []);
    }
    const history = this.priceHistory.get(sym)!;
    const tsHistory = this.priceHistoryTs.get(sym)!;
    // v2.0.820: Use the ticker's own timestamp when available, else Date.now().
    // This keeps the time span accurate for both WS ticks (fast) and REST
    // backfills (slow, ~1 per cycle) — critical for correct σ scaling.
    let ts = ticker.timestamp ?? Date.now();
    // De-duplicate identical consecutive ticks (REST backfill often returns
    // the same price multiple times — would deflate σ with zero log-returns).
    const lastTs = tsHistory[tsHistory.length - 1];
    if (lastTs !== undefined && ts <= lastTs) {
      // Out-of-order / duplicate timestamp — bump to lastTs + 1ms to preserve order.
      ts = lastTs + 1;
    }
    history.push(ticker.price);
    tsHistory.push(ts);
    if (history.length > this.historySize) {
      history.shift();
      tsHistory.shift();
    }
  }

  /** Get per-symbol price history (for drift estimation). Returns copy of array. */
  getPriceHistory(symbol: string): number[] {
    const sym = symbol.toLowerCase();
    return [...(this.priceHistory.get(sym) ?? [])];
  }

  /** Get the high/low of the recent price-history window for a symbol.
   *  Used by the Shadow Trade Engine to resolve TP/SL on the actual
   *  intra-window path (H1 fix) rather than on the cycle close alone.
   *  Returns {high: price, low: price}; falls back to 0 when no history. */
  getHighLow(symbol: string): { high: number; low: number } {
    const sym = symbol.toLowerCase();
    const history = this.priceHistory.get(sym);
    if (!history || history.length === 0) return { high: 0, low: 0 };
    let high = -Infinity;
    let low = Infinity;
    for (const p of history) {
      if (!Number.isFinite(p)) continue;
      if (p > high) high = p;
      if (p < low) low = p;
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)) return { high: 0, low: 0 };
    return { high, low };
  }

  /** Update order book imbalance from depth callbacks */
  updateDepth(bids: Array<{price: number; qty: number}>, asks: Array<{price: number; qty: number}>): void {
    let bidVol = 0, askVol = 0;
    for (const b of bids) bidVol += b.price * b.qty;
    for (const a of asks) askVol += a.price * a.qty;
    const total = bidVol + askVol;
    this.orderBookImbalance = total > 0 ? (bidVol - askVol) / total : 0;
  }

  getState(symbol: string): AggregatedMarketState {
    // Normalize to lowercase — matches update()'s normalisation
    const sym = symbol.toLowerCase();
    const ticker = this.tickers.get(sym);
    const history = this.priceHistory.get(sym) ?? [];
    const tsHistory = this.priceHistoryTs.get(sym) ?? [];

    const volatility = this.calcVolatility(history, tsHistory);
    const trend = this.calcTrend(ticker, volatility);
    // v2.0.869(主神 市況判斷調查):per symbol regime——用 LLM 判斷嘅 threshold
    // (貴金屬/指數正常波動 0.03-0.3%——global threshold 0.3% 誤判低波動)
    const regime = this.calcRegimeForSymbol(sym, trend, volatility);

    // Feed the observation to the calibrator (auto-adjusts thresholds if >80% dominant)
    this.calibrator.observe(regime);

    return {
      primarySymbol: symbol,
      price: ticker?.price ?? 0,
      change24h: ticker?.priceChangePercent ?? 0,
      volume24h: ticker?.volume ?? 0,
      trend,
      volatility,
      regime,
      orderBookImbalance: this.orderBookImbalance,
      updatedAt: ticker?.timestamp ?? Date.now(),
    };
  }

  /** v2.0.820: Compute per-cycle volatility (σ) from tick log-returns,
   *  scaled by the ACTUAL history time span (not a hardcoded 0.1s/tick).
   *
   *  Root cause of the v2.0.820 fix: the previous scaling assumed ~100 ticks
   *  over ~10s (100ms/tick WS feed) and multiplied tick σ by √(300/10)≈5.5
   *  to estimate a 5-min cycle σ. But non-active trading markets are REST-
   *  polled at ~1 tick/4min, so 100 ticks span ~400min — the real history
   *  duration is 2400× longer than assumed, and the correct scaling factor is
   *  √(300/24000)≈0.11, not 5.5. The 50× error meant every calm symbol
   *  reported vol ~30× too low → permanent vol-gate + permanent
   *  low_volatility regime classification.
   *
   *  The fix uses the actual first→last timestamp span. When timestamps are
   *  unavailable (legacy callers), it falls back to the old 0.1s assumption
   *  so behaviour is preserved for any path that hasn't been migrated.
   *
   *  @param prices  Recent tick prices (oldest → newest).
   *  @param ts      Parallel timestamp array (ms epochs). Optional for compat.
   *  @returns Per-cycle σ (fraction, e.g. 0.003 = 0.3%). 0 when < 3 prices. */
  private calcVolatility(prices: number[], ts?: number[]): number {
    if (prices.length < 3) return 0;
    // v2.0.140: Use std of log returns (true σ) — same algorithm as
    // first-passage.ts estimateVolatility().
    const logReturns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1]!;
      const curr = prices[i]!;
      if (prev > 0 && curr > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
        logReturns.push(Math.log(curr / prev));
      }
    }
    if (logReturns.length < 2) return 0;
    const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
    const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
    const tickSigma = Math.sqrt(Math.max(variance, 0));
    if (!Number.isFinite(tickSigma)) return 0;

    // v2.0.820: Correct diffusion scaling uses tickInterval, NOT historyDuration.
    // sigma_cycle = sigma_tick * sqrt(cycleDuration / tickInterval)
    // where tickInterval = historyDuration / (n-1) is the avg seconds between
    // consecutive ticks. Using historyDuration directly understates by sqrt(n-1)
    // (~10x for a 100-tick window) which would push every market below the
    // vol-gate threshold. The original v2.0.764 bug had the same shape.
    const cycleDurationSec = 300;
    let tickIntervalSec: number;
    if (ts && ts.length === prices.length && ts.length >= 2) {
      const spanMs = (ts[ts.length - 1] ?? 0) - (ts[0] ?? 0);
      const spanSec = Math.max(1, spanMs / 1000);
      tickIntervalSec = spanSec / Math.max(1, prices.length - 1);
    } else {
      // Fallback: old 0.1s/tick assumption (preserves behaviour for unmigrated
      // callers that pass prices without timestamps).
      tickIntervalSec = 0.1;
    }
    // v2.0.820: Defensive floor — real exchange WS ticks are >=50ms apart.
    // Sub-50ms intervals are almost certainly burst/dedup artifacts (e.g. 100
    // same-ms ticks deduped to +1ms each → 0.001s interval → 547x scaleFactor
    // → false high_volatility). Floor at 0.05s bounds the inflation while
    // preserving accuracy for the fastest real feeds (HL markPrice ~50-200ms).
    tickIntervalSec = Math.max(0.05, tickIntervalSec);
    const scaleFactor = Math.sqrt(cycleDurationSec / tickIntervalSec);
    const cycleSigma = tickSigma * scaleFactor;
    // Sanity: cap at 100% (a 5-min σ > 100% is a data error, not a market).
    return Math.min(cycleSigma, 1.0);
  }

  private calcTrend(ticker: Ticker | undefined, volatility: number): Trend {
    if (!ticker) return 'sideways';
    const pct = ticker.priceChangePercent;
    const t = this.calibrator.getThresholds();
    if (Math.abs(pct) < t.trend) return 'sideways';
    if (volatility > 0.02) return 'volatile';
    return pct > 0 ? 'bullish' : 'bearish';
  }

  private calcRegime(trend: Trend, volatility: number): MarketRegime {
    const t = this.calibrator.getThresholds();
    if (volatility > t.volHigh) return 'high_volatility';
    if (volatility < t.volLow) return 'low_volatility';
    if (trend === 'bullish') return 'trending_bull';
    if (trend === 'bearish') return 'trending_bear';
    if (trend === 'volatile') return 'chaotic';
    return 'mean_reverting';
  }

  /** v2.0.869(主神 市況判斷調查):per symbol regime 判斷——用 LLM 判斷嘅 threshold
   *  (貴金屬/指數正常波動 0.03-0.3%——global threshold 0.3% 誤判低波動)
   *  冇 per symbol threshold → fallback 默認 calcRegime */
  calcRegimeForSymbol(symbol: string, trend: Trend, volatility: number): MarketRegime {
    const sym = String(symbol ?? '').toLowerCase();
    const st = this.symbolThresholds.get(sym);
    if (!st) return this.calcRegime(trend, volatility);
    if (volatility > st.volHigh) return 'high_volatility';
    if (volatility < st.volLow) return 'low_volatility';
    if (trend === 'bullish') return 'trending_bull';
    if (trend === 'bearish') return 'trending_bear';
    if (trend === 'volatile') return 'chaotic';
    return 'mean_reverting';
  }

  /**
   * v2.0.115: Get a short-term price trend summary for agent context.
   * Returns the price change over the last N ticks, direction, and momentum.
   * This helps agents see "BTC has been rising for the last 20 ticks" instead
   * of just seeing the current price in isolation.
   */
  getRecentPriceTrend(symbol: string, lookback = 20): { direction: 'up' | 'down' | 'flat'; pctChange: number; startPrice: number; endPrice: number; ticks: number } | null {
    const sym = symbol.toLowerCase();
    const history = this.priceHistory.get(sym);
    if (!history || history.length < 5) return null;
    const start = Math.max(0, history.length - lookback);
    const startPrice = history[start]!;
    const endPrice = history[history.length - 1]!;
    const pctChange = startPrice > 0 ? ((endPrice - startPrice) / startPrice) * 100 : 0;
    const direction: 'up' | 'down' | 'flat' = pctChange > 0.1 ? 'up' : pctChange < -0.1 ? 'down' : 'flat';
    return { direction, pctChange, startPrice, endPrice, ticks: history.length - start };
  }
}
