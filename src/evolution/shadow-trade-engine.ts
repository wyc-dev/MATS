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
  /** v2.0.143: Maximum Favorable Excursion — best unrealized PnL (as fraction
   *  of entry price) reached during the shadow trade's lifetime.
   *  For LONG: (highSinceOpen - entryPrice) / entryPrice
   *  For SHORT: (entryPrice - lowSinceOpen) / entryPrice
   *  Used to detect "TP was close but not hit" — if MFE was 4.5% but TP was
   *  at 5%, the trade nearly won but the SL was hit first. This is valuable
   *  path-risk information that a binary win/loss label loses. */
  mfePct: number;
  /** v2.0.143: Maximum Adverse Excursion — worst unrealized PnL (as fraction
   *  of entry price) reached during the shadow trade's lifetime.
   *  For LONG: (entryPrice - lowSinceOpen) / entryPrice
   *  For SHORT: (highSinceOpen - entryPrice) / entryPrice
   *  Used to detect "SL was nearly avoided" — if MAE was 1.9% but SL was at
   *  2%, the trade nearly survived the dip and could have reached TP. */
  maePct: number;
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
  /** v2.0.143: Average MFE across all resolved trades (how far trades
   *  went in favor before resolving). High MFE + low win rate = trades
   *  give back gains (exit timing problem). */
  avgMfePct: number;
  /** v2.0.143: Average MAE across all resolved trades (how far trades
   *  went against before resolving). Low MAE + high win rate = clean
   *  entries. High MAE = poor entry timing. */
  avgMaePct: number;
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
  maxTotalOpen: 60,
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
  /** Recently resolved trades (for agent context + stats).
   *  v2.0.178: Added mfePct/maePct to recentResults so getStats() can compute
   *  MAE/MFE averages from historical results, not just current positions. */
  private recentResults: Array<{ id: string; symbol: string; side: 'buy' | 'sell'; outcome: 'win' | 'loss'; holdCycles: number; cycle: number; mfePct?: number; maePct?: number }> = [];

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
   * @param srProvider   Optional S/R zone provider to fetch fresh zones each cycle
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
    srProvider?: { getZones: (symbol: string, price: number) => { support: number; resistance: number } | null },
  ): void {
    if (entryPrice <= 0) return;

    // Check limits
    const symOpen = this.positions.filter(p => p.symbol === symbol.toLowerCase() && p.status === 'open').length;
    if (symOpen >= SHADOW_CONFIG.maxOpenPerSymbol) return;
    const totalOpen = this.positions.filter(p => p.status === 'open').length;
    if (totalOpen >= SHADOW_CONFIG.maxTotalOpen) return;

    const sym = symbol.toLowerCase();
    const ts = Date.now();

    // v2.0.183: Fetch fresh S/R zones each cycle to avoid stale levels.
    // If srProvider is available, use it to get the latest support/resistance
    // for the current price. This ensures shadow trades reflect current market
    // structure, producing cleaner training labels for OLR.
    let freshSLPriceLong = slPriceLong;
    let freshTPPriceLong = tpPriceLong;
    let freshSLPriceShort = slPriceShort;
    let freshTPPriceShort = tpPriceShort;
    if (srProvider) {
      try {
        const zones = srProvider.getZones(sym, entryPrice);
        if (zones) {
          // For LONG: SL at support (below), TP at resistance (above)
          freshSLPriceLong = zones.support;
          freshTPPriceLong = zones.resistance;
          // For SHORT: SL at resistance (above), TP at support (below)
          freshSLPriceShort = zones.resistance;
          freshTPPriceShort = zones.support;
          log.debug(`[shadow] Fresh S/R zones for ${sym}: support=${zones.support.toFixed(2)}, resistance=${zones.resistance.toFixed(2)}`);
        }
      } catch (err) {
        log.warn(`[shadow] Failed to fetch fresh S/R zones: ${err instanceof Error ? err.message : String(err)}`);
        // Fall back to provided levels (may be stale, but better than nothing)
      }
    }

    // Calculate SL/TP prices using fresh levels if available, else provided levels, else defaults
    const longSL = freshSLPriceLong && freshSLPriceLong > 0 ? freshSLPriceLong : entryPrice * (1 - SHADOW_CONFIG.defaultSLDistance);
    const longTP = freshTPPriceLong && freshTPPriceLong > 0 ? freshTPPriceLong : entryPrice * (1 + SHADOW_CONFIG.defaultTPDistance);
    const shortSL = freshSLPriceShort && freshSLPriceShort > 0 ? freshSLPriceShort : entryPrice * (1 + SHADOW_CONFIG.defaultSLDistance);
    const shortTP = freshTPPriceShort && freshTPPriceShort > 0 ? freshTPPriceShort : entryPrice * (1 - SHADOW_CONFIG.defaultTPDistance);

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
      mfePct: 0,
      maePct: 0,
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
      mfePct: 0,
      maePct: 0,
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
   * @param currentFeatures  Fresh feature vector at resolution time (optional).
   *                         If provided, used for OLR training instead of the
   *                         stale entry-time features. This ensures the OLR
   *                         learns P(win | current market conditions), which is
   *                         the correct mapping for predicting trade outcomes.
   * @returns Number of positions resolved this call
   */
  checkPositions(symbol: string, price: number, cycle: number, cycleHigh?: number, cycleLow?: number, currentFeatures?: Record<string, number>): number {
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

      // v2.0.143: Update MAE/MFE from path extremes.
      // MFE = best unrealized PnL (how far the trade went in our favor).
      // MAE = worst unrealized PnL (how far the trade went against us).
      if (pos.side === 'buy') {
        pos.mfePct = (pos.highSinceOpen - pos.entryPrice) / pos.entryPrice;
        pos.maePct = (pos.entryPrice - pos.lowSinceOpen) / pos.entryPrice;
      } else {
        pos.mfePct = (pos.entryPrice - pos.lowSinceOpen) / pos.entryPrice;
        pos.maePct = (pos.highSinceOpen - pos.entryPrice) / pos.entryPrice;
      }

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
        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome: pos.status, holdCycles: cycle - pos.openCycle, cycle, mfePct: pos.mfePct, maePct: pos.maePct });
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

        // v2.0.202: Use resolution-time features for OLR training instead of
        // entry-time features. The OLR model predicts P(win | current market
        // conditions), so training on stale entry features teaches the wrong
        // mapping. If currentFeatures is provided, use it; otherwise fall back
        // to entry features (better than nothing, but suboptimal).
        const trainingFeatures = currentFeatures ?? pos.features;

        try {
          this.olrEngine.feedTrade(sym, trainingFeatures, outcomeNum, pos.side, 'shadow', cycle);
          log.info(`[shadow] ${outcome.toUpperCase()} ${pos.side.toUpperCase()} ${sym} held ${holdCycles} cycles (entry=${pos.entryPrice.toFixed(2)} exit=${exitPrice.toFixed(2)}, slNarrowed=${pos.slNarrowed}) → OLR fed with ${currentFeatures ? 'resolution-time' : 'entry-time'} features`);
        } catch (err) {
          log.warn(`[shadow] OLR feedTrade failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome, holdCycles, cycle, mfePct: pos.mfePct, maePct: pos.maePct });
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

      // v2.0.143: Include MAE/MFE path-risk stats so agents can see not just
      // win/loss but HOW trades resolved — e.g. "trades go up 3% then reverse
      // to SL" means exit timing is the problem, not the direction.
      const allStats = this.getStats();
      for (const s of allStats) {
        const totalResolved = s.longWins + s.longLosses + s.shortWins + s.shortLosses;
        if (totalResolved >= 5) {
          parts.push(`${s.symbol}: avg MFE=${(s.avgMfePct * 100).toFixed(1)}% avg MAE=${(s.avgMaePct * 100).toFixed(1)}%`);
        }
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

    // v2.0.178: Process positions and recentResults separately to correctly
    // distinguish open vs resolved, and avoid double-counting.
    const getOrCreate = (sym: string): ShadowTradeStats => {
      let s = symbolMap.get(sym);
      if (!s) {
        s = { symbol: sym, totalOpened: 0, openCount: 0, longWins: 0, longLosses: 0, shortWins: 0, shortLosses: 0, longWinRate: 0, shortWinRate: 0, avgHoldCycles: 0, avgMfePct: 0, avgMaePct: 0 };
        symbolMap.set(sym, s);
      }
      return s;
    };
    const applyResolved = (stats: ShadowTradeStats, side: 'buy' | 'sell', outcome: 'win' | 'loss', holdCycles: number, mfePct?: number, maePct?: number) => {
      stats.totalOpened++;
      stats.avgHoldCycles = (stats.avgHoldCycles * (stats.totalOpened - 1) + holdCycles) / stats.totalOpened;
      if (mfePct !== undefined) stats.avgMfePct = (stats.avgMfePct * (stats.totalOpened - 1) + mfePct) / stats.totalOpened;
      if (maePct !== undefined) stats.avgMaePct = (stats.avgMaePct * (stats.totalOpened - 1) + maePct) / stats.totalOpened;
      if (side === 'buy') { if (outcome === 'win') stats.longWins++; else stats.longLosses++; }
      else { if (outcome === 'win') stats.shortWins++; else stats.shortLosses++; }
    };

    // 1. Open positions (count as open, not win/loss)
    for (const pos of this.positions) {
      if (pos.status !== 'open') continue;
      const s = getOrCreate(pos.symbol);
      s.totalOpened++;
      s.openCount++;
    }

    // 2. Resolved positions still in memory
    for (const pos of this.positions) {
      if (pos.status === 'open') continue;
      const s = getOrCreate(pos.symbol);
      applyResolved(s, pos.side, pos.status, (pos.resolvedCycle ?? pos.openCycle) - pos.openCycle, pos.mfePct, pos.maePct);
    }

    // 3. Recent results (survives restart) — skip if already counted in positions
    for (const r of this.recentResults) {
      if (this.positions.some(p => p.id === r.id && p.status !== 'open')) continue;
      const s = getOrCreate(r.symbol);
      applyResolved(s, r.side, r.outcome, r.holdCycles, r.mfePct, r.maePct);
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
   * v2.0.135: Prune shadow positions (open + recent) for symbols no longer in
   * the active trading set. Stale shadows for delisted symbols never get
   * checked (checkPositions only runs for current trading markets) so they
   * would permanently occupy the maxTotalOpen cap and block new shadows from
   * opening for current markets. Returns the number of pruned positions.
   */
  pruneStaleSymbols(keepSymbols: string[]): number {
    const keep = new Set(keepSymbols.map(s => s.toLowerCase()));
    const before = this.positions.length;
    this.positions = this.positions.filter(p => keep.has(p.symbol));
    // Also prune recent results for delisted symbols (keeps the scoreboard clean)
    this.recentResults = this.recentResults.filter(r => keep.has(r.symbol));
    const pruned = before - this.positions.length;
    if (pruned > 0) log.info(`[shadow-trade] Pruned ${pruned} stale positions for delisted symbols (${this.positions.length} remaining)`);
    return pruned;
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
          // v2.0.143: Backfill MAE/MFE for positions persisted before the path-risk fix.
          mfePct: p.mfePct ?? 0,
          maePct: p.maePct ?? 0,
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