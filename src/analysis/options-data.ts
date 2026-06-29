// ─── Options Data Layer (v2.0.58) ───
// Real-time options data from Massive.com WebSocket feeds.
// Provides IV Rank, Skew, Implied Move, GEX, Put/Call ratio, High-OI strikes
// for Stocks/RWA trading on Hyperliquid.
//
// ⚠️ MAINTENANCE NOTE: This module is the SINGLE SOURCE OF TRUTH for options
// data in the MATS system. All agents read from getOptionsContext(). Do NOT
// create separate options data fetchers elsewhere.
//
// Massive.com WS docs: https://massive.com/docs/websocket/options/overview

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
  /** Whether data is available (false = no WS connection or no data) */
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
 */
export class OptionsDataManager {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private wsUrl = 'wss://ws.massive.com/v1/options';
  private cache = new Map<string, OptionsContext>();
  private subscribedSymbols = new Set<string>();
  private connected = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY_MS = 5_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? config.massiveApiKey ?? '';
    if (!this.apiKey) {
      log.warn('No Massive.com API key configured — options data layer will use defaults');
    }
  }

  /**
   * Connect to Massive.com WebSocket.
   * Subscribes to options feeds for all symbols in subscribedSymbols.
   */
  async connect(): Promise<void> {
    if (!this.apiKey) {
      log.warn('OptionsDataManager: No API key — skipping WS connection');
      return;
    }
    if (this.connected) return;

    try {
      log.info('OptionsDataManager: Connecting to Massive.com WS...');
      this.ws = new WebSocket(`${this.wsUrl}?api_key=${this.apiKey}`);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        log.info('✅ OptionsDataManager: Connected to Massive.com WS');
        // Subscribe to all pending symbols
        for (const sym of this.subscribedSymbols) {
          this.sendSubscription(sym);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.handleMessage(data);
        } catch {
          // Non-JSON message (heartbeat, etc.) — ignore
        }
      };

      this.ws.onerror = (err) => {
        log.error(`OptionsDataManager: WS error: ${err}`);
      };

      this.ws.onclose = () => {
        this.connected = false;
        log.warn('OptionsDataManager: WS disconnected');
        this.scheduleReconnect();
      };
    } catch (err) {
      log.error(`OptionsDataManager: Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      log.error(`OptionsDataManager: Max reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
      return;
    }
    this.reconnectAttempts++;
    const delay = this.RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    log.info(`OptionsDataManager: Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /**
   * Send a subscription message for a symbol.
   * Subscribes to: quotes, trades, greeks, IV, open interest, volume.
   */
  private sendSubscription(symbol: string): void {
    if (!this.ws || !this.connected) return;
    const msg = {
      action: 'subscribe',
      channel: 'options',
      symbol,
      feeds: ['quotes', 'trades', 'greeks', 'iv', 'open_interest', 'volume', 'unusual_flow'],
    };
    this.ws.send(JSON.stringify(msg));
    log.info(`OptionsDataManager: Subscribed to ${symbol}`);
  }

  /**
   * Send an unsubscription message for a symbol.
   */
  private sendUnsubscription(symbol: string): void {
    if (!this.ws || !this.connected) return;
    const msg = { action: 'unsubscribe', channel: 'options', symbol };
    this.ws.send(JSON.stringify(msg));
    log.info(`OptionsDataManager: Unsubscribed from ${symbol}`);
  }

  /**
   * Handle incoming WS message — update cache with new data.
   */
  private handleMessage(data: any): void {
    if (!data || !data.symbol) return;
    const sym = data.symbol as string;
    const existing = this.cache.get(sym) ?? DEFAULT_CONTEXT(sym);

    // Update fields based on message type
    const updated: OptionsContext = {
      ...existing,
      symbol: sym,
      lastUpdated: Date.now(),
      available: true,
    };

    if (data.iv !== undefined) updated.impliedVolatility = data.iv;
    if (data.ivRank !== undefined) updated.ivRank = data.ivRank;
    if (data.ivPercentile !== undefined) updated.ivPercentile = data.ivPercentile;
    if (data.impliedMove !== undefined) updated.impliedMovePct = data.impliedMove;
    if (data.putCallRatio !== undefined) updated.putCallRatio = data.putCallRatio;
    if (data.putCallOIRatio !== undefined) updated.putCallOIRatio = data.putCallOIRatio;
    if (data.gammaRegime !== undefined) updated.gammaRegime = data.gammaRegime;
    if (data.highOIStrike !== undefined) updated.highOIStrike = data.highOIStrike;
    if (data.maxPain !== undefined) updated.maxPain = data.maxPain;
    if (data.skew !== undefined) updated.skew = data.skew;
    if (data.eventRisk !== undefined) updated.eventRisk = data.eventRisk;
    if (data.daysToExpiration !== undefined) updated.daysToExpiration = data.daysToExpiration;

    this.cache.set(sym, updated);
  }

  /**
   * Subscribe to options data for a symbol.
   * Only subscribes if not already subscribed.
   */
  subscribe(symbol: string): void {
    if (this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.add(symbol);
    if (this.connected) {
      this.sendSubscription(symbol);
    }
  }

  /**
   * Unsubscribe from options data for a symbol.
   */
  unsubscribe(symbol: string): void {
    if (!this.subscribedSymbols.has(symbol)) return;
    this.subscribedSymbols.delete(symbol);
    this.cache.delete(symbol);
    if (this.connected) {
      this.sendUnsubscription(symbol);
    }
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
   * Disconnect and clean up.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.subscribedSymbols.clear();
    this.cache.clear();
    log.info('OptionsDataManager: Disconnected and cleaned up');
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