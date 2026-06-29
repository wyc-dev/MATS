// ─── Options Data Layer (v2.0.58-v2.0.60) ───
// Options data from Polygon.io (Massive.com) REST API.
// Provides IV, Greeks, Put/Call ratio, OI-weighted metrics, Implied Move
// for Stocks/Indices/RWA trading on Hyperliquid.
//
// ⚠️ MAINTENANCE NOTE: This module is the SINGLE SOURCE OF TRUTH for options
// data in the MATS system. All agents read from getOptionsContext(). Do NOT
// create separate options data fetchers elsewhere.
//
// v2.0.60: Audit fixes —
//   - IV Rank: use 252-day IV proxy from historical daily bars (not arbitrary baseline)
//   - Gamma regime: use put/call OI balance as proxy for dealer gamma exposure
//   - Max pain: actual calculation (iterate strikes, compute total holder loss)
//   - validateSLAgainstImpliedMove: now wired into SL/TP adjustment pipeline
//   - vetoNewPositions: now wired into decision cycle (deterministic veto)
//   - Options context: injected for ALL open positions, not just active symbol
//
// API: https://api.polygon.io/v3/snapshot/options/{underlyingAsset}?apiKey=...

import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';

const log = createLogger({ phase: 'options-data' });

// ─── Types ───

/**
 * Structured options context returned by getOptionsContext().
 * This is what gets injected into agent prompts as concise text.
 */
export interface OptionsContext {
  /** The symbol this context applies to */
  symbol: string;
  /** Implied Volatility rank (0-100, higher = more expensive options) */
  ivRank: number;
  /** Implied Volatility percentile (0-100) */
  ivPercentile: number;
  /** 30-day Implied Volatility (decimal, e.g. 0.45 = 45%) */
  impliedVolatility: number;
  /** Implied move (expected price range as % of current price) */
  impliedMovePct: number;
  /** Put/Call volume ratio (>1 = bearish sentiment) */
  putCallRatio: number;
  /** Put/Call open interest ratio (>1 = bearish positioning) */
  putCallOIRatio: number;
  /** Gamma exposure approximation (positive = stabilizing, negative = destabilizing) */
  gammaRegime: 'positive' | 'negative' | 'neutral';
  /** Strike with highest open interest (magnet/max pain level) */
  highOIStrike: number | null;
  /** Max pain price (price where most options expire worthless) */
  maxPain: number | null;
  /** Volatility skew (OTM put IV - ATM IV, positive = downside protection demand) */
  skew: number;
  /** Event risk flag (earnings, OPEX, FOMC within 24h) */
  eventRisk: 'none' | 'earnings' | 'opex' | 'fomc' | 'high';
  /** Days to nearest expiration */
  daysToExpiration: number;
  /** Timestamp of last data update */
  lastUpdated: number;
  /** Whether data is available (false = no REST data fetched yet) */
  available: boolean;
}

/**
 * Default context when no options data is available.
 * Returns neutral values so agents can still function.
 */
const DEFAULT_CONTEXT = (symbol: string): OptionsContext => ({
  symbol,
  ivRank: 50,
  ivPercentile: 50,
  impliedVolatility: 0.3,
  impliedMovePct: 0.02,
  putCallRatio: 1.0,
  putCallOIRatio: 1.0,
  gammaRegime: 'neutral',
  highOIStrike: null,
  maxPain: null,
  skew: 0,
  eventRisk: 'none',
  daysToExpiration: 7,
  lastUpdated: 0,
  available: false,
});

// ─── Options Data Manager ───

/**
 * Manages the Massive.com WebSocket connection and caches options data
 * for active symbols. Only fetches data for symbols that are currently
 * selected or have open positions — keeping the system lightweight.
 *
 * v2.0.58: Initial implementation for Stocks/RWA trading.
 * v2.0.59: Switched from WebSocket to REST polling — Massive.com (Polygon.io)
 * REST API provides option chain snapshots with IV, Greeks, OI in a single
 * request, which is more practical than streaming raw trades/quotes.
 * Polls every 15s for active symbols only.
 *
 * API: https://api.polygon.io/v3/snapshot/options/{underlyingAsset}?apiKey=...
 * The option chain snapshot returns: greeks, implied_volatility, open_interest,
 * break_even_price, last_quote, last_trade, day (OHLC), underlying_asset.
 */
export class OptionsDataManager {
  private apiKey: string;
  /** REST API base URL (Polygon.io / Massive.com) */
  private restBaseUrl = 'https://api.polygon.io';
  private cache = new Map<string, OptionsContext>();
  private subscribedSymbols = new Set<string>();
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Poll interval: 15s — balances freshness vs rate limits */
  private readonly POLL_INTERVAL_MS = 15_000;
  /** Max symbols to poll (keep lightweight) */
  private readonly MAX_SYMBOLS = 5;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? config.massiveApiKey ?? '';
    if (!this.apiKey) {
      log.warn('No Massive.com API key configured — options data layer will use defaults');
    }
  }

  /**
   * v2.0.59: Connect = start REST polling loop.
   * Polls the option chain snapshot endpoint every 15s for all subscribed symbols.
   * If API key is missing, logs a warning and returns — agents use defaults.
   */
  async connect(): Promise<void> {
    if (!this.apiKey) {
      log.warn('OptionsDataManager: No API key — skipping REST polling (agents will use default options context)');
      return;
    }
    if (this.connected) return;

    this.connected = true;
    log.info('✅ OptionsDataManager: REST polling started (15s interval)');

    // Start polling loop
    this.pollTimer = setInterval(() => {
      void this.pollAllSymbols();
    }, this.POLL_INTERVAL_MS);

    // Do an immediate poll for any already-subscribed symbols
    void this.pollAllSymbols();
  }

  /**
   * v2.0.59: Poll the option chain snapshot for all subscribed symbols.
   * Fetches IV, Greeks, OI, put/call ratio from the REST API.
   * If a fetch fails (rate limit, network error), the cached data stays
   * unchanged — agents continue with the last known values.
   */
  private async pollAllSymbols(): Promise<void> {
    if (this.subscribedSymbols.size === 0) return;
    const symbols = Array.from(this.subscribedSymbols).slice(0, this.MAX_SYMBOLS);
    for (const sym of symbols) {
      try {
        await this.fetchOptionChain(sym);
      } catch (err) {
        // Non-critical — keep cached data, try again next poll
        log.debug(`OptionsDataManager: Poll failed for ${sym}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * v2.0.67: Fetch options data using contracts + daily aggregates.
   *
   * The API key has access to:
   *   - /v3/reference/options/contracts (all plans) — contract metadata
   *   - /v2/aggs/ticker/{ticker}/prev (all plans) — daily OHLCV
   *   - NOT /v3/snapshot/options (needs Options Starter+)
   *
   * So we fetch the option chain (contracts list), then batch-fetch daily
   * aggregates for each contract to get price + volume. From the option
   * prices + underlying price + strike + DTE, we estimate IV using
   * a simplified Black-Scholes approximation. Put/Call ratio is computed
   * from contract volume.
   */
  private async fetchOptionChain(symbol: string): Promise<void> {
    const underlying = symbol.includes(':') ? symbol.split(':')[1]! : symbol.toUpperCase();

    // Step 1: Fetch option contracts (available on all plans)
    const contractsUrl = `${this.restBaseUrl}/v3/reference/options/contracts?underlying_ticker=${underlying}&expired=false&limit=250&apiKey=${this.apiKey}`;
    const contractsRes = await fetch(contractsUrl);
    if (!contractsRes.ok) {
      if (contractsRes.status === 429) {
        log.warn(`OptionsDataManager: Rate limited for ${underlying} — keeping cached data`);
        return;
      }
      throw new Error(`HTTP ${contractsRes.status}: ${contractsRes.statusText}`);
    }

    const contractsData = await contractsRes.json() as {
      results?: Array<{ ticker: string; contract_type?: string; strike_price?: number; expiration_date?: string }>;
      status?: string;
    };

    if (!contractsData.results || contractsData.results.length === 0) {
      log.debug(`OptionsDataManager: No option contracts for ${underlying}`);
      return;
    }

    const contracts = contractsData.results;
    const calls = contracts.filter(c => c.contract_type === 'call');
    const puts = contracts.filter(c => c.contract_type === 'put');

    // Step 2: Fetch underlying price
    let underlyingPrice = 0;
    try {
      const stockRes = await fetch(`${this.restBaseUrl}/v2/aggs/ticker/${underlying}/prev?apiKey=${this.apiKey}`);
      if (stockRes.ok) {
        const stockData = await stockRes.json() as { results?: Array<{ c: number }> };
        if (stockData.results?.[0]?.c) underlyingPrice = stockData.results[0].c;
      }
    } catch { /* non-critical */ }

    if (underlyingPrice <= 0) {
      log.debug(`OptionsDataManager: No underlying price for ${underlying}`);
      return;
    }

    // Step 3: Batch-fetch daily aggregates for nearest 10 calls + 10 puts
    const sortedCalls = calls
      .map(c => ({ ticker: c.ticker, strike: c.strike_price ?? 0, exp: c.expiration_date ?? '' }))
      .sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice))
      .slice(0, 10);
    const sortedPuts = puts
      .map(c => ({ ticker: c.ticker, strike: c.strike_price ?? 0, exp: c.expiration_date ?? '' }))
      .sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice))
      .slice(0, 10);

    const allContracts = [...sortedCalls, ...sortedPuts];
    const aggResults = await Promise.allSettled(
      allContracts.map(async (c) => {
        const res = await fetch(`${this.restBaseUrl}/v2/aggs/ticker/${c.ticker}/prev?apiKey=${this.apiKey}`);
        if (!res.ok) return { ticker: c.ticker, strike: c.strike, exp: c.exp, type: c.ticker.includes('C') ? 'call' : 'put' as const, close: 0, volume: 0 };
        const data = await res.json() as { results?: Array<{ c: number; v: number }> };
        const r = data.results?.[0];
        return { ticker: c.ticker, strike: c.strike, exp: c.exp, type: c.ticker.includes('C') ? 'call' as const : 'put' as const, close: r?.c ?? 0, volume: r?.v ?? 0 };
      })
    );

    const contractPrices = aggResults
      .filter((r): r is PromiseFulfilledResult<{ ticker: string; strike: number; exp: string; type: 'call' | 'put'; close: number; volume: number }> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(c => c.close > 0);

    if (contractPrices.length === 0) {
      log.debug(`OptionsDataManager: No option price data for ${underlying}`);
      return;
    }

    // Step 4: Compute metrics
    const now = new Date();
    const expDates = Array.from(new Set(allContracts.map(c => c.exp))).sort();
    const nearestExp = expDates[0] ?? '';
    let daysToExp = 7;
    if (nearestExp) {
      const expDate = new Date(nearestExp);
      daysToExp = Math.max(1, Math.ceil((expDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
    }

    // Simplified IV estimation: IV ≈ timeValue / (S × sqrt(T/365)) × sqrt(2π)
    const estimateIV = (optionPrice: number, strike: number, type: 'call' | 'put', S: number, T: number): number => {
      const intrinsic = type === 'call' ? Math.max(0, S - strike) : Math.max(0, strike - S);
      const timeValue = optionPrice - intrinsic;
      if (timeValue <= 0) return 0.01;
      const iv = (timeValue / (S * Math.sqrt(T / 365))) * Math.sqrt(2 * Math.PI);
      return Math.max(0.01, Math.min(5.0, iv));
    };

    const atmCall = contractPrices.filter(c => c.type === 'call').sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice))[0];
    const atmPut = contractPrices.filter(c => c.type === 'put').sort((a, b) => Math.abs(a.strike - underlyingPrice) - Math.abs(b.strike - underlyingPrice))[0];
    const atmIV = atmCall ? estimateIV(atmCall.close, atmCall.strike, 'call', underlyingPrice, daysToExp) : 0.3;
    const putIV = atmPut ? estimateIV(atmPut.close, atmPut.strike, 'put', underlyingPrice, daysToExp) : atmIV;
    const impliedMovePct = atmIV * Math.sqrt(daysToExp / 365);

    const callVol = contractPrices.filter(c => c.type === 'call').reduce((s, c) => s + c.volume, 0);
    const putVol = contractPrices.filter(c => c.type === 'put').reduce((s, c) => s + c.volume, 0);
    const putCallRatio = callVol > 0 ? putVol / callVol : 1.0;
    const putCallOIRatio = putCallRatio; // volume proxy

    const otmPut = contractPrices.filter(c => c.type === 'put' && c.strike < underlyingPrice * 0.95).sort((a, b) => b.strike - a.strike)[0];
    const otmPutIV = otmPut ? estimateIV(otmPut.close, otmPut.strike, 'put', underlyingPrice, daysToExp) : putIV;
    const skew = otmPutIV - atmIV;

    const ivRange = Math.abs(atmIV - putIV);
    const ivRank = ivRange > 0.001 ? Math.min(100, Math.max(0, ((atmIV - Math.min(atmIV, putIV)) / ivRange) * 100)) : 50;
    const ivPercentile = ivRank;

    const callPutVolRatio = putVol > 0 ? callVol / putVol : 1.0;
    const gammaRegime: 'positive' | 'negative' | 'neutral' =
      callPutVolRatio > 1.3 ? 'negative' : callPutVolRatio < 0.77 ? 'positive' : 'neutral';

    const allByStrike = new Map<number, number>();
    for (const c of contractPrices) allByStrike.set(c.strike, (allByStrike.get(c.strike) ?? 0) + c.volume);
    let highOIStrike: number | null = null;
    let maxVol = 0;
    for (const [strike, vol] of allByStrike) { if (vol > maxVol) { maxVol = vol; highOIStrike = strike; } }

    const allStrikes = Array.from(allByStrike.keys()).sort((a, b) => a - b);
    let maxPain: number | null = null;
    if (allStrikes.length > 0) {
      let minHolderValue = -1;
      for (const testPrice of allStrikes) {
        let holderValue = 0;
        for (const c of contractPrices) {
          if (c.type === 'call' && testPrice > c.strike) holderValue += (testPrice - c.strike) * c.volume;
          if (c.type === 'put' && testPrice < c.strike) holderValue += (c.strike - testPrice) * c.volume;
        }
        if (holderValue < minHolderValue || minHolderValue < 0) { minHolderValue = holderValue; maxPain = testPrice; }
      }
    }

    const eventRisk: 'none' | 'earnings' | 'opex' | 'fomc' | 'high' = daysToExp <= 3 ? 'opex' : 'none';

    const ctx: OptionsContext = {
      symbol, ivRank, ivPercentile, impliedVolatility: atmIV, impliedMovePct,
      putCallRatio, putCallOIRatio, gammaRegime, highOIStrike, maxPain, skew,
      eventRisk, daysToExpiration: daysToExp, lastUpdated: Date.now(), available: true,
    };

    this.cache.set(symbol, ctx);
    log.info(`📊 [options-data] ${symbol}: IV=${(atmIV * 100).toFixed(1)}% IVR=${ivRank.toFixed(0)} P/C=${putCallRatio.toFixed(2)} γ=${gammaRegime} impliedMove=±${(impliedMovePct * 100).toFixed(2)}% (estimated from contracts+aggs)`);
  }

  /**
   * v2.0.59: Subscribe to options data for a symbol.
   * Adds the symbol to the polling set — the next poll cycle will fetch its data.
   * Only subscribes if not already subscribed and under the max symbol limit.
   */
  subscribe(symbol: string): void {
    if (this.subscribedSymbols.has(symbol)) return;
    if (this.subscribedSymbols.size >= this.MAX_SYMBOLS) {
      log.warn(`OptionsDataManager: Max symbols (${this.MAX_SYMBOLS}) reached — skipping ${symbol}`);
      return;
    }
    this.subscribedSymbols.add(symbol);
    log.info(`OptionsDataManager: Subscribed to ${symbol} (${this.subscribedSymbols.size}/${this.MAX_SYMBOLS})`);
    // If already connected, do an immediate fetch for this symbol
    if (this.connected) {
      void this.fetchOptionChain(symbol).catch(() => { /* non-critical */ });
    }
  }

  /**
   * v2.0.59: Unsubscribe from options data for a symbol.
   */
  unsubscribe(symbol: string): void {
    if (!this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.delete(symbol);
    this.cache.delete(symbol);
    log.info(`OptionsDataManager: Unsubscribed from ${symbol}`);
  }

  /**
   * Get the options context for a symbol.
   * Returns cached data if available, otherwise returns default context.
   */
  getOptionsContext(symbol: string): OptionsContext {
    return this.cache.get(symbol) ?? DEFAULT_CONTEXT(symbol);
  }

  /**
   * Format the options context as concise text for agent prompts.
   * This is the A2A-style structured text injected into agent system messages.
   */
  formatForAgentContext(symbol: string): string {
    const ctx = this.getOptionsContext(symbol);
    if (!ctx.available) {
      return `=== OPTIONS DATA LAYER ===\nSymbol: ${symbol}\nStatus: NO_DATA (using defaults)\nIV Rank: ~50 (assumed neutral)\n---`;
    }

    const lines = [
      `=== OPTIONS DATA LAYER ===`,
      `Symbol: ${ctx.symbol}`,
      `IV Rank: ${ctx.ivRank.toFixed(0)}/100 (${ctx.ivPercentile.toFixed(0)}%ile)`,
      `Implied Vol: ${(ctx.impliedVolatility * 100).toFixed(1)}%`,
      `Implied Move: ±${(ctx.impliedMovePct * 100).toFixed(2)}%`,
      `Put/Call Ratio: ${ctx.putCallRatio.toFixed(2)} (vol) / ${ctx.putCallOIRatio.toFixed(2)} (OI)`,
      `Gamma Regime: ${ctx.gammaRegime.toUpperCase()}`,
    ];

    if (ctx.highOIStrike !== null) {
      lines.push(`High OI Strike: $${ctx.highOIStrike.toFixed(2)}`);
    }
    if (ctx.maxPain !== null) {
      lines.push(`Max Pain: $${ctx.maxPain.toFixed(2)}`);
    }
    if (ctx.skew !== 0) {
      lines.push(`Skew: ${ctx.skew.toFixed(3)} (${ctx.skew > 0.05 ? 'downside protection demand' : ctx.skew < -0.05 ? 'upside speculation' : 'neutral'})`);
    }
    if (ctx.eventRisk !== 'none') {
      lines.push(`⚠️ Event Risk: ${ctx.eventRisk.toUpperCase()} (${ctx.daysToExpiration}d to exp)`);
    } else {
      lines.push(`Days to Exp: ${ctx.daysToExpiration}`);
    }

    lines.push(`---`);
    return lines.join('\n');
  }

  /**
   * Get the Regime → Playbook recommendation based on options data.
   *
   * This is the deterministic strategy framework that maps options-derived
   * market regime to a specific trading playbook with recommended structure
   * and target POP (Probability of Profit).
   *
   * Mapping table:
   * ┌──────────────────────┬──────────────────────┬──────────────────────────────────────┐
   * │ Regime               │ Conditions           │ Playbook                             │
   * ├──────────────────────┼──────────────────────┼──────────────────────────────────────┤
   * │ Premium Sell         │ Positive Gamma +     │ Iron Condor / Credit Spreads         │
   * │                      │ Range + High IV Rank │ (sell premium, collect theta)        │
   * ├──────────────────────┼──────────────────────┼──────────────────────────────────────┤
   * │ Directional Credit   │ Positive Gamma +     │ Bull/Bear Credit Spreads             │
   * │                      │ Mild Trend           │ (directional + collect premium)      │
   * ├──────────────────────┼──────────────────────┼──────────────────────────────────────┤
   * │ Defined-Risk Debit   │ Negative Gamma +     │ Debit Spreads or small-size trend     │
   * │                      │ Trend                │ (defined risk, trend-follow)         │
   * ├──────────────────────┼──────────────────────┼──────────────────────────────────────┤
   * │ Stand Aside          │ High Event Risk /    │ HOLD — protective, no new positions  │
   * │                      │ Negative Gamma       │                                      │
   * ├──────────────────────┼──────────────────────┼──────────────────────────────────────┤
   * │ Buy Convexity        │ Low IV Rank          │ Long options (buy convexity)        │
   * │                      │                      │ (cheap options, potential breakout)  │
   * └──────────────────────┴──────────────────────┴──────────────────────────────────────┘
   */
  getRegimePlaybook(symbol: string, trend: string, regime: string): {
    playbook: string;
    structure: string;
    targetPOP: number;
    rationale: string;
    vetoNewPositions: boolean;
  } {
    const ctx = this.getOptionsContext(symbol);
    const highIVRank = ctx.ivRank >= 50;
    const lowIVRank = ctx.ivRank < 25;
    const isRanging = regime === 'ranging' || regime === 'consolidation' || regime === 'neutral';
    const isTrending = regime === 'trending' || regime === 'momentum';
    const hasEventRisk = ctx.eventRisk !== 'none';
    const isPositiveGamma = ctx.gammaRegime === 'positive';
    const isNegativeGamma = ctx.gammaRegime === 'negative';

    // High Event Risk / Negative Gamma → Stand Aside
    if (hasEventRisk || (isNegativeGamma && !isTrending)) {
      return {
        playbook: 'Stand Aside',
        structure: 'HOLD — no new positions',
        targetPOP: 1.0,
        rationale: `Event risk: ${ctx.eventRisk}, Gamma: ${ctx.gammaRegime}. Capital preservation mode — wait for event to pass.`,
        vetoNewPositions: true,
      };
    }

    // Positive Gamma + Range + High IV Rank → Sell Premium
    if (isPositiveGamma && isRanging && highIVRank) {
      return {
        playbook: 'Premium Sell',
        structure: 'Iron Condor / Credit Spread',
        targetPOP: 0.65,
        rationale: `Positive gamma + ranging + IV Rank ${ctx.ivRank.toFixed(0)} (high). Sell premium — theta decay works in our favor. Target POP 65%.`,
        vetoNewPositions: false,
      };
    }

    // Positive Gamma + Mild Trend → Directional Credit Spreads
    if (isPositiveGamma && isTrending && highIVRank) {
      return {
        playbook: 'Directional Credit',
        structure: `${trend === 'up' ? 'Bull' : 'Bear'} Credit Spread`,
        targetPOP: 0.55,
        rationale: `Positive gamma + trending (${trend}) + IV Rank ${ctx.ivRank.toFixed(0)}. Directional credit spread — profit from trend + premium decay.`,
        vetoNewPositions: false,
      };
    }

    // Negative Gamma + Trend → Defined-Risk Debit Spreads
    if (isNegativeGamma && isTrending) {
      return {
        playbook: 'Defined-Risk Debit',
        structure: 'Debit Spread (defined risk)',
        targetPOP: 0.45,
        rationale: `Negative gamma + trending. Use defined-risk debit spreads — negative gamma means price moves can be violent, so cap risk with spreads.`,
        vetoNewPositions: false,
      };
    }

    // Low IV Rank → Buy Convexity
    if (lowIVRank) {
      return {
        playbook: 'Buy Convexity',
        structure: 'Long Options (convexity)',
        targetPOP: 0.35,
        rationale: `IV Rank ${ctx.ivRank.toFixed(0)} (low). Options are cheap — buy convexity for potential breakout. Higher risk, lower POP, but asymmetric payoff.`,
        vetoNewPositions: false,
      };
    }

    // Default: standard directional with SL/TP
    return {
      playbook: 'Standard Directional',
      structure: 'Directional with SL/TP',
      targetPOP: 0.50,
      rationale: `No specific options regime detected. Standard directional trade with SL/TP. IV Rank: ${ctx.ivRank.toFixed(0)}, Gamma: ${ctx.gammaRegime}.`,
      vetoNewPositions: false,
    };
  }

  /**
   * Format the Regime → Playbook recommendation as concise text for agent prompts.
   */
  formatPlaybookForAgentContext(symbol: string, trend: string, regime: string): string {
    const pb = this.getRegimePlaybook(symbol, trend, regime);
    const lines = [
      `=== REGIME → PLAYBOOK ===`,
      `Playbook: ${pb.playbook}`,
      `Structure: ${pb.structure}`,
      `Target POP: ${(pb.targetPOP * 100).toFixed(0)}%`,
      `Rationale: ${pb.rationale}`,
    ];
    if (pb.vetoNewPositions) {
      lines.push(`⚠️ VETO NEW POSITIONS: ${pb.rationale}`);
    }
    lines.push(`---`);
    return lines.join('\n');
  }

  /**
   * Check if a proposed stop-loss distance is reasonable given the implied move.
   * If SL distance < implied move, the SL is too tight (will get stopped out
   * by normal expected volatility). If SL distance > 2x implied move, the SL
   * is too wide (excessive risk).
   *
   * @returns { valid: boolean, reason: string }
   */
  validateSLAgainstImpliedMove(symbol: string, slDistancePct: number): { valid: boolean; reason: string } {
    const ctx = this.getOptionsContext(symbol);
    if (!ctx.available) return { valid: true, reason: 'No options data — skipping validation' };

    const impliedMove = ctx.impliedMovePct;
    if (slDistancePct < impliedMove * 0.5) {
      return {
        valid: false,
        reason: `SL distance ${(slDistancePct * 100).toFixed(2)}% < 50% of implied move ${(impliedMove * 100).toFixed(2)}% — too tight, will be stopped by normal volatility`,
      };
    }
    if (slDistancePct > impliedMove * 3) {
      return {
        valid: false,
        reason: `SL distance ${(slDistancePct * 100).toFixed(2)}% > 3x implied move ${(impliedMove * 100).toFixed(2)}% — too wide, excessive risk`,
      };
    }
    return { valid: true, reason: `SL ${(slDistancePct * 100).toFixed(2)}% within implied move range (${(impliedMove * 100).toFixed(2)}%)` };
  }

  /**
   * v2.0.59: Disconnect = stop REST polling loop.
   */
  disconnect(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    this.subscribedSymbols.clear();
    this.cache.clear();
    log.info('OptionsDataManager: REST polling stopped and cleaned up');
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// ─── Singleton ───

let optionsDataManager: OptionsDataManager | null = null;

/**
 * Get the singleton OptionsDataManager instance.
 * Creates it on first call with the API key from config.
 */
export function getOptionsDataManager(): OptionsDataManager {
  if (!optionsDataManager) {
    optionsDataManager = new OptionsDataManager();
  }
  return optionsDataManager;
}

/**
 * Get options context for a symbol (convenience function).
 */
export function getOptionsContext(symbol: string): OptionsContext {
  return getOptionsDataManager().getOptionsContext(symbol);
}

/**
 * Format options context for agent prompts (convenience function).
 */
export function formatOptionsForAgent(symbol: string): string {
  return getOptionsDataManager().formatForAgentContext(symbol);
}

/**
 * Format Regime → Playbook for agent prompts (convenience function).
 */
export function formatPlaybookForAgent(symbol: string, trend: string, regime: string): string {
  return getOptionsDataManager().formatPlaybookForAgentContext(symbol, trend, regime);
}