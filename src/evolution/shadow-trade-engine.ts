// ─── Shadow Trade Engine ───
//
// Opens "shadow" (simulated) LONG + SHORT positions every cycle for the
// active symbol, using the same S/R-based SL/TP that real trades would use.
// Tracks these shadow positions until SL or TP is hit, then feeds the
// outcome (win/loss) into the OLR engine for learning.
//
// This replaces RBC's "hypothetical training" which learned 5-minute price
// direction — NOT trade profitability. Shadow trades learn the ACTUAL
// question: "Given these conditions, will TP be hit before SL?"
//
// Key difference from RBC hypothetical training:
//   RBC:  price up 0.1% → LONG=WIN (5-min direction)
//   Shadow: price hits TP before SL → LONG=WIN (actual trade outcome)
//
// The shadow engine also tracks path risk — if price reverses and hits
// SL before TP, that's a LOSS, even if the direction was eventually correct.
//
// Only opens shadow trades for the ACTIVE symbol (Market Agent's selected
// symbol) to ensure we have real per-cycle price observations.

import { createLogger } from '../observability/logger.ts';
import { OLREngine, FEATURE_NAMES } from './olr-engine.ts';

const log = createLogger({ phase: 'shadow-trade' });

// ─── Types ───

export interface ShadowPosition {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  openCycle: number;
  openTimestamp: number;
  /** Feature snapshot at entry time */
  features: Record<string, number>;
  /** Current status — 'open' until SL/TP hit */
  status: 'open' | 'win' | 'loss';
  /** Cycle when resolved (SL/TP hit) */
  resolvedCycle?: number;
  /** Exit price when resolved */
  exitPrice?: number;
  /** Whether SL/TP was narrowed from the original S/R-based values */
  slNarrowed: boolean;
  /** Original SL/TP at open (for tracking narrowing) */
  originalSL: number;
  originalTP: number;
  /** Highest price observed since the shadow position opened (intra-cycle
   *  high tracking — H1 fix: resolves TP/SL on the actual path, not just
   *  the cycle close price, which previously missed intra-cycle hits). */
  highSinceOpen: number;
  /** Lowest price observed since open */
  lowSinceOpen: number;
}

export interface ShadowTradeStats {
  symbol: string;
  totalOpened: number;
  openCount: number;
  longWins: number;
  longLosses: number;
  shortWins: number;
  shortLosses: number;
  longWinRate: number;
  shortWinRate: number;
  avgHoldCycles: number;
}

export interface ShadowTradeContext {
  /** Formatted context string for agent injection */
  contextString: string;
  /** Current open shadow positions count */
  openCount: number;
  /** Recently resolved shadow trades summary */
  recentResults: Array<{ symbol: string; side: string; outcome: 'win' | 'loss'; holdCycles: number }>;
}

// ─── Config ───

const SHADOW_CONFIG = {
  /** Max open shadow positions per symbol (prevent unbounded growth) */
  maxOpenPerSymbol: 10,
  /** Max total shadow positions across all symbols */
  maxTotalOpen: 30,
  /** Default SL distance if S/R not available (fraction of price) */
  defaultSLDistance: 0.02,
  /** Default TP distance if S/R not available (fraction of price) */
  defaultTPDistance: 0.05,
  /** Max cycles to hold a shadow position before force-resolving as "no edge" */
  maxHoldCycles: 50,
  /** How many recent results to include in agent context */
  contextRecentCount: 5,
} as const;

// ─── Shadow Trade Engine ───

export class ShadowTradeEngine {
  /** All shadow positions (open + recently resolved) */
  private positions: ShadowPosition[] = [];
  /** Monotonic ID counter */
  private idCounter = 0;
  /** Reference to OLR engine for feeding outcomes */
  private olrEngine: OLREngine;
  /** Recently resolved trades (for agent context + stats) */
  private recentResults: Array<{ id: string; symbol: string; side: 'buy' | 'sell'; outcome: 'win' | 'loss'; holdCycles: number; cycle: number }> = [];

  constructor(olrEngine: OLREngine) {
    this.olrEngine = olrEngine;
  }

  /**
   * Open a shadow LONG + SHORT for the given symbol.
   * Called every cycle for the active symbol.
   *
   * @param symbol       Symbol name
   * @param entryPrice   Current price
   * @param slPrice      SL price (from S/R) — if null, use default distance
   * @param tpPrice      TP price (from S/R) — if null, use default distance
   * @param cycle        Current cycle number
   * @param features     Feature snapshot at entry time
   */
  openShadowTrades(
    symbol: string,
    entryPrice: number,
    slPriceLong: number | null,
    tpPriceLong: number | null,
    slPriceShort: number | null,
    tpPriceShort: number | null,
    cycle: number,
    features: Record<string, number>,
  ): void {
    if (entryPrice <= 0) return;

    // Check limits
    const symOpen = this.positions.filter(p => p.symbol === symbol.toLowerCase() && p.status === 'open').length;
    if (symOpen >= SHADOW_CONFIG.maxOpenPerSymbol) return;
    const totalOpen = this.positions.filter(p => p.status === 'open').length;
    if (totalOpen >= SHADOW_CONFIG.maxTotalOpen) return;

    const sym = symbol.toLowerCase();
    const ts = Date.now();

    // Calculate SL/TP prices
    const longSL = slPriceLong && slPriceLong > 0 ? slPriceLong : entryPrice * (1 - SHADOW_CONFIG.defaultSLDistance);
    const longTP = tpPriceLong && tpPriceLong > 0 ? tpPriceLong : entryPrice * (1 + SHADOW_CONFIG.defaultTPDistance);
    const shortSL = slPriceShort && slPriceShort > 0 ? slPriceShort : entryPrice * (1 + SHADOW_CONFIG.defaultSLDistance);
    const shortTP = tpPriceShort && tpPriceShort > 0 ? tpPriceShort : entryPrice * (1 - SHADOW_CONFIG.defaultTPDistance);

    // Open shadow LONG
    const longId = `shadow_${++this.idCounter}`;
    this.positions.push({
      id: longId,
      symbol: sym,
      side: 'buy',
      entryPrice,
      stopLossPrice: longSL,
      takeProfitPrice: longTP,
      openCycle: cycle,
      openTimestamp: ts,
      features: { ...features },
      status: 'open',
      slNarrowed: false,
      originalSL: longSL,
      originalTP: longTP,
      highSinceOpen: entryPrice,
      lowSinceOpen: entryPrice,
    });

    // Open shadow SHORT
    const shortId = `shadow_${++this.idCounter}`;
    this.positions.push({
      id: shortId,
      symbol: sym,
      side: 'sell',
      entryPrice,
      stopLossPrice: shortSL,
      takeProfitPrice: shortTP,
      openCycle: cycle,
      openTimestamp: ts,
      features: { ...features },
      status: 'open',
      slNarrowed: false,
      originalSL: shortSL,
      originalTP: shortTP,
      highSinceOpen: entryPrice,
      lowSinceOpen: entryPrice,
    });

    // Prune old resolved positions (keep all open + last 100 resolved).
    // O(n) single-pass (L3 fix) — the previous indexOf-based filter was O(n²).
    if (this.positions.length > 200) {
      const open = this.positions.filter(p => p.status === 'open');
      const resolved = this.positions.filter(p => p.status !== 'open');
      this.positions = [...open, ...resolved.slice(-100)];
    }
  }

  /**
   * Check all open shadow positions against the current price AND the
   * intra-cycle high/low observed since the position opened.
   *
   * H1 fix: the previous implementation only compared the cycle CLOSE
   * price against SL/TP, so a price that touched TP then reverted to SL
   * within a cycle was misclassified (or left open indefinitely). Using
   * the high/low since open resolves the actual TP-before-SL outcome.
   *
   * When both SL and TP were touched intra-cycle, the position is
   * resolved as a LOSS (SL-first, conservative — path risk favours the
   * nearer barrier, and a real trade would have been stopped first).
   *
   * @param symbol     Symbol to check
   * @param price      Current cycle close price (fallback when no H/L)
   * @param cycle      Current cycle number
   * @param cycleHigh  Highest price observed this cycle (optional)
   * @param cycleLow   Lowest price observed this cycle (optional)
   * @returns Number of positions resolved this call
   */
  checkPositions(symbol: string, price: number, cycle: number, cycleHigh?: number, cycleLow?: number): number {
    if (price <= 0) return 0;
    const sym = symbol.toLowerCase();
    let resolved = 0;
    const hi = cycleHigh != null && cycleHigh > 0 ? cycleHigh : price;
    const lo = cycleLow != null && cycleLow > 0 ? cycleLow : price;

    for (const pos of this.positions) {
      if (pos.status !== 'open') continue;
      if (pos.symbol !== sym) continue;

      // Update intra-cycle extremes observed since open.
      pos.highSinceOpen = Math.max(pos.highSinceOpen, hi);
      pos.lowSinceOpen = Math.min(pos.lowSinceOpen, lo);

      let outcome: 'win' | 'loss' | null = null;
      let exitPrice = 0;

      if (pos.side === 'buy') {
        // LONG: SL below, TP above. Use path extremes — a real trade
        // would have been stopped/TP'd the moment the barrier was touched.
        const slHit = pos.lowSinceOpen <= pos.stopLossPrice;
        const tpHit = pos.highSinceOpen >= pos.takeProfitPrice;
        if (slHit && tpHit) {
          outcome = 'loss'; // both touched → conservative SL-first
          exitPrice = pos.stopLossPrice;
        } else if (slHit) {
          outcome = 'loss';
          exitPrice = pos.stopLossPrice;
        } else if (tpHit) {
          outcome = 'win';
          exitPrice = pos.takeProfitPrice;
        }
      } else {
        // SHORT: SL above, TP below.
        const slHit = pos.highSinceOpen >= pos.stopLossPrice;
        const tpHit = pos.lowSinceOpen <= pos.takeProfitPrice;
        if (slHit && tpHit) {
          outcome = 'loss';
          exitPrice = pos.stopLossPrice;
        } else if (slHit) {
          outcome = 'loss';
          exitPrice = pos.stopLossPrice;
        } else if (tpHit) {
          outcome = 'win';
          exitPrice = pos.takeProfitPrice;
        }
      }

      // Force-resolve if held too long (stale shadow trade).
      // M5 fix: a mark-to-current PnL label is NOT a TP-before-SL outcome
      // and would poison OLR's learning signal. We resolve the position
      // for stats/UI but DO NOT feed the fabricated label to OLR — better
      // to lose one training sample than teach the model noise.
      if (!outcome && cycle - pos.openCycle >= SHADOW_CONFIG.maxHoldCycles) {
        const pnl = pos.side === 'buy'
          ? (price - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - price) / pos.entryPrice;
        pos.status = pnl >= 0 ? 'win' : 'loss';
        pos.resolvedCycle = cycle;
        pos.exitPrice = price;
        log.info(`[shadow] Force-resolved ${pos.id} (${pos.side} ${sym}) after ${cycle - pos.openCycle} cycles — pnl=${(pnl * 100).toFixed(2)}% (NOT fed to OLR: stale label unreliable)`);
        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome: pos.status, holdCycles: cycle - pos.openCycle, cycle });
        if (this.recentResults.length > 50) this.recentResults.shift();
        resolved++;
        continue;
      }

      if (outcome) {
        pos.status = outcome;
        pos.resolvedCycle = cycle;
        pos.exitPrice = exitPrice;

        const holdCycles = cycle - pos.openCycle;
        const outcomeNum: 1 | 0 = outcome === 'win' ? 1 : 0;

        try {
          this.olrEngine.feedTrade(sym, pos.features, outcomeNum, pos.side, 'shadow', cycle, pos.slNarrowed);
          log.info(`[shadow] ${outcome.toUpperCase()} ${pos.side.toUpperCase()} ${sym} held ${holdCycles} cycles (entry=$${pos.entryPrice.toFixed(2)} exit=$${exitPrice.toFixed(2)}, slNarrowed=${pos.slNarrowed}) → OLR fed`);
        } catch (err) {
          log.warn(`[shadow] OLR feedTrade failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome, holdCycles, cycle });
        if (this.recentResults.length > 50) this.recentResults.shift();

        resolved++;
      }
    }

    return resolved;
  }

  /**
   * Build agent context string showing shadow trade results.
   */
  getContext(): ShadowTradeContext {
    const openCount = this.positions.filter(p => p.status === 'open').length;
    const recent = this.recentResults.slice(-SHADOW_CONFIG.contextRecentCount);

    const parts: string[] = [
      '=== SHADOW TRADE RESULTS ===',
      `Simulated trades tracking TP-before-SL outcomes (not just price direction).`,
      `Open: ${openCount} | Total resolved: ${this.recentResults.length}`,
    ];

    if (recent.length > 0) {
      parts.push('Recent outcomes:');
      for (const r of recent) {
        const icon = r.outcome === 'win' ? '✅' : '❌';
        parts.push(`  ${icon} ${r.side.toUpperCase()} ${r.symbol} — ${r.outcome.toUpperCase()} (${r.holdCycles} cycles)`);
      }

      // Aggregate win rates
      const longResults = this.recentResults.filter(r => r.side === 'buy');
      const shortResults = this.recentResults.filter(r => r.side === 'sell');
      const longWins = longResults.filter(r => r.outcome === 'win').length;
      const shortWins = shortResults.filter(r => r.outcome === 'win').length;
      if (longResults.length > 0) {
        parts.push(`LONG win rate: ${longWins}/${longResults.length} (${((longWins / longResults.length) * 100).toFixed(0)}%)`);
      }
      if (shortResults.length > 0) {
        parts.push(`SHORT win rate: ${shortWins}/${shortResults.length} (${((shortWins / shortResults.length) * 100).toFixed(0)}%)`);
      }
    } else {
      parts.push('  (no shadow trades resolved yet)');
    }

    return {
      contextString: parts.join('\n'),
      openCount,
      recentResults: recent.map(r => ({ symbol: r.symbol, side: r.side, outcome: r.outcome, holdCycles: r.holdCycles })),
    };
  }

  /**
   * Get per-symbol stats for UI.
   */
  getStats(): ShadowTradeStats[] {
    const symbolMap = new Map<string, ShadowTradeStats>();

    for (const pos of this.positions) {
      let stats = symbolMap.get(pos.symbol);
      if (!stats) {
        stats = {
          symbol: pos.symbol,
          totalOpened: 0,
          openCount: 0,
          longWins: 0,
          longLosses: 0,
          shortWins: 0,
          shortLosses: 0,
          longWinRate: 0,
          shortWinRate: 0,
          avgHoldCycles: 0,
        };
        symbolMap.set(pos.symbol, stats);
      }
      stats.totalOpened++;

      if (pos.status === 'open') {
        stats.openCount++;
      } else {
        const holdCycles = (pos.resolvedCycle ?? pos.openCycle) - pos.openCycle;
        stats.avgHoldCycles = (stats.avgHoldCycles * (stats.totalOpened - 1) + holdCycles) / stats.totalOpened;

        if (pos.side === 'buy') {
          if (pos.status === 'win') stats.longWins++;
          else stats.longLosses++;
        } else {
          if (pos.status === 'win') stats.shortWins++;
          else stats.shortLosses++;
        }
      }
    }

    for (const stats of symbolMap.values()) {
      const longTotal = stats.longWins + stats.longLosses;
      const shortTotal = stats.shortWins + stats.shortLosses;
      stats.longWinRate = longTotal > 0 ? stats.longWins / longTotal : 0;
      stats.shortWinRate = shortTotal > 0 ? stats.shortWins / shortTotal : 0;
    }

    return Array.from(symbolMap.values());
  }

  /**
   * Get all open shadow positions (for UI).
   */
  getOpenPositions(): ShadowPosition[] {
    return this.positions.filter(p => p.status === 'open');
  }

  /**
   * Save state for persistence.
   */
  save(): string {
    return JSON.stringify({
      positions: this.positions.filter(p => p.status === 'open'),
      recentResults: this.recentResults.slice(-50),
      idCounter: this.idCounter,
    });
  }

  /**
   * Load state from persistence.
   */
  load(json: string): void {
    try {
      const data = JSON.parse(json);
      if (data.positions) {
        this.positions = (data.positions as any[]).map(p => ({
          ...p,
          status: 'open' as const,
          // Backfill H/L fields for positions persisted before the H1 fix.
          highSinceOpen: p.highSinceOpen ?? p.entryPrice,
          lowSinceOpen: p.lowSinceOpen ?? p.entryPrice,
        }));
      }
      if (data.recentResults) {
        this.recentResults = data.recentResults;
      }
      if (data.idCounter) {
        this.idCounter = data.idCounter;
      }
      log.info(`Shadow trades loaded: ${this.positions.length} open, ${this.recentResults.length} recent results`);
    } catch {
      log.warn('[shadow load] Failed to parse data, starting fresh');
    }
  }
}