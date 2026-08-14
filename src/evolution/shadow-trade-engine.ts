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
  /** v2.0.834: Shadow type — 'blind' (old behavior, both directions) or
   *  'aligned' (follows LLM consensus direction with factor tagging).
   *  Aligned shadows learn "what happens when the LLM says go this way but
   *  conviction gate blocked the trade" — the distribution the system
   *  actually needs for decision calibration. Blind shadows are cold-start
   *  priors only (weight=0.1 in OLR).
   *  v2.0.846 Phase 1a: 'statistical' = pure-statistics A/B shadow. Follows a
   *  direction computed ONLY from statistical components (OLR P(win) +
   *  First-Passage + Combo WR + Causal uplift), with NO LLM. Used to compare
   *  whether the LLM debate actually adds edge vs pure statistics. */
  shadowType: 'blind' | 'aligned' | 'statistical' | 'qrl';
  /** v2.0.861: Q-RL signal snapshot for 'qrl' shadows (audit + uplift analysis). */
  qrlSignal?: {
    spread: number;
    buyQ: number;
    sellQ: number;
  };
  /** v2.0.834: Factor tagging for aligned shadows. The consensus direction
   *  the LLM chose, plus which agent + signal drove that direction.
   *  Undefined for blind shadows. */
  factorTag?: {
    consensusAction: string;
    consensusConfidence: number;
    weightedDirection: 'buy' | 'sell';
    weightedScore: number;
    primaryDriver: { agent: string; weight: number; action: string };
    agentVotes: Array<{ agent: string; weight: number; action: string }>;
  };
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
  /**
   * v2.0.759: Max cycles before a shadow trade is force-resolved even if SL/TP
   * was not hit. In low-volatility regimes, shadow trades can remain open for
   * many cycles without resolution, causing the OLR model to receive no new
   * training data while the feature space drifts. This leads to stale model
   * weights and systematic P(win) miscalibration.
   *
   * Set to 12 cycles (60 minutes at 5-min cycles) — long enough for most
   * trades to resolve naturally, but short enough to prevent stale data
   * accumulation. The force-resolved outcome is recorded with a reduced
   * learning weight (0.3× normal) to prevent stale data from dominating
   * the model.
   */
  maxAgeCycles: 12,
  /**
   * v2.0.759: Learning weight multiplier for force-resolved shadow trades.
   * Force-resolved outcomes are less reliable than natural SL/TP hits because
   * they use the current price rather than a true barrier touch. A reduced
   * weight prevents these less-reliable labels from dominating the OLR model.
   */
  staleLearningWeight: 0.3,
} as const;

// ─── v2.0.861: Shadow pool priority eviction config ─────────────────────
// True-statistical shadows (aligned / statistical / qrl) are worth MORE than
// blind cold-start priors (0.1× weight). Blind shadows open BOTH sides every
// cycle with 2%/5% SL/TP that rarely hit in low-vol regimes — they monopolise
// the 60-slot pool for 12 cycles (maxAgeCycles) and starve the A/B arms. When
// a higher-value shadow needs room, evict the OLDEST unevicted blind.
// Env-tunable, independently disableable (SHADOW_EVICT_BLIND=false → v2.0.860
// behaviour, zero behavioural change).
function parseEvictBoolEnv(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return def;
}
function parseEvictNumEnv(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
const shadowEvictConfig = {
  enabled: parseEvictBoolEnv(process.env['SHADOW_EVICT_BLIND'], true),
  // Per-call cap — evict at most this many blinds per open attempt (conservative:
  // one frees one slot; the rest retry next cycle). Clamped [1, 5].
  maxPerCall: Math.max(1, Math.min(5, Math.floor(parseEvictNumEnv(process.env['SHADOW_EVICT_MAX_PER_CALL'], 1)))),
} as const;

/** v2.0.861: Total blind evictions (observability + tests). Per-instance so
 *  each engine's count is independently testable (module-level would leak
 *  across tests / engine instances). */

// ─── Shadow Trade Engine ───

export class ShadowTradeEngine {
  /** All shadow positions (open + recently resolved) */
  private positions: ShadowPosition[] = [];
  /** Monotonic ID counter */
  private idCounter = 0;
  /** Reference to OLR engine for feeding outcomes */
  private olrEngine: OLREngine;
  /** v2.0.861: blind evictions performed by THIS instance (observability). */
  private shadowEvictCount = 0;

  /** v2.0.861: Priority eviction — when the shadow pool is FULL, make room for
   *  a higher-value true-statistical shadow (aligned/statistical/qrl) by
   *  evicting the OLDEST open blind position that has NOT yet touched its
   *  SL/TP barrier.
   *
   *  Why blind: blind shadows are 0.1× cold-start priors (lowest learning
   *  value). They open BOTH sides every cycle with default 2%/5% SL/TP that
   *  rarely resolve in low-vol regimes — a full 60-slot pool of unevicted
   *  blinds starves the statistical A/B arms (v2.0.846 statistical, v2.0.861
   *  qrl) AND the aligned arm (Q-RL's only live feed, v2.0.855), crippling
   *  the very experiments that measure real edge.
   *
   *  Why OLDEST: closest to maxAgeCycles force-resolve → least remaining
   *  learning value.
   *
   *  Why only non-barrier-hit blinds: a blind whose SL/TP was touched is
   *  about to resolve naturally → checkPositions will feed OLR with a real
   *  outcome — do NOT discard a resolvable sample.
   *
   *  Eviction = DISCARD: the victim is spliced out of the array (checkPositions
   *  can never double-process it), NOT recorded in recentResults, NOT fed to
   *  OLR. Fewer samples, never polluted samples — the safe direction.
   *
   *  @returns true if at least one blind was evicted (caller may open).
   */
  private evictOldestBlindForRoom(): boolean {
    if (!shadowEvictConfig.enabled) return false;
    const openCount = this.positions.filter(p => p.status === 'open').length;
    if (openCount < SHADOW_CONFIG.maxTotalOpen) return false;

    // Candidates: open blinds that have NOT touched SL or TP yet.
    const candidates = this.positions.filter(p => {
      if (p.status !== 'open' || p.shadowType !== 'blind') return false;
      if (p.side === 'buy') {
        if (p.lowSinceOpen <= p.stopLossPrice) return false;
        if (p.highSinceOpen >= p.takeProfitPrice) return false;
      } else {
        if (p.highSinceOpen >= p.stopLossPrice) return false;
        if (p.lowSinceOpen <= p.takeProfitPrice) return false;
      }
      return true;
    });
    if (candidates.length === 0) return false;

    // Oldest first — closest to force-resolve, lowest remaining value.
    candidates.sort((a, b) => a.openTimestamp - b.openTimestamp);
    const maxEvict = Math.max(1, shadowEvictConfig.maxPerCall);
    let evicted = 0;
    for (const victim of candidates) {
      if (evicted >= maxEvict) break;
      const idx = this.positions.indexOf(victim);
      if (idx < 0) continue;
      this.positions.splice(idx, 1);
      this.shadowEvictCount++;
      evicted++;
      log.info(`[shadow] EVICT blind ${victim.side.toUpperCase()} ${victim.symbol} (age=${Math.round((Date.now() - victim.openTimestamp) / 60000)}min, opened cycle ${victim.openCycle}) — made room for higher-value shadow (total evicts=${this.shadowEvictCount})`);
    }
    return evicted > 0;
  }

  /** v2.0.861: Total blind evictions (observability + tests). */
  getShadowEvictCount(): number {
    return this.shadowEvictCount;
  }
  /** Recently resolved trades (for agent context + stats).
   *  v2.0.178: Added mfePct/maePct to recentResults so getStats() can compute
   *  MAE/MFE averages from historical results, not just current positions.
   *  v2.0.869-P2(主神 Shadow 升級):加 exitReason + pnlPct——學「邊個離場原因有 edge」
   *  +「贏幾多/蝕幾多」——cap 50 → 100(主神要求「最近 100 個」) */
  private recentResults: Array<{ id: string; symbol: string; side: 'buy' | 'sell'; outcome: 'win' | 'loss'; holdCycles: number; cycle: number; mfePct?: number; maePct?: number; shadowType?: 'blind' | 'aligned' | 'statistical' | 'qrl'; exitReason?: 'sl_tp' | 'force_resolve' | 'evicted'; pnlPct?: number }> = [];

  constructor(olrEngine: OLREngine) {
    this.olrEngine = olrEngine;
  }

  /**
   * Open shadow positions for the given symbol in BOTH directions.
   * Called every cycle for the active symbol.
   *
   * Opens both LONG and SHORT shadow positions each cycle so that OLR
   * receives training data for both directions. This is necessary for
   * the system to learn which direction has an edge under current
   * conditions. The OLR model is designed to handle contradictory
   * training data — it learns P(win | direction, features) separately
   * for each side via the side parameter in feedTrade().
   *
   * @param symbol       Symbol name
   * @param entryPrice   Current price
   * @param slPriceLong  SL price for LONG (from S/R) — if null, use default distance
   * @param tpPriceLong  TP price for LONG (from S/R) — if null, use default distance
   * @param slPriceShort SL price for SHORT (from S/R) — if null, use default distance
   * @param tpPriceShort TP price for SHORT (from S/R) — if null, use default distance
   * @param cycle        Current cycle number
   * @param features     Feature snapshot at entry time
   * @param thesisDirection  Ignored — both directions are always opened
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
    thesisDirection: 'buy' | 'sell' | null = null,
    srProvider?: { getZones: (symbol: string, price: number) => { support: number; resistance: number } | null },
  ): void {
    // v2.0.834: Guard against NaN/Infinity — same fix as openAlignedShadow.
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;

    // Check limits
    const sym = symbol.toLowerCase();
    const symOpen = this.positions.filter(p => p.symbol === sym && p.status === 'open').length;
    if (symOpen >= SHADOW_CONFIG.maxOpenPerSymbol) return;
    const totalOpen = this.positions.filter(p => p.status === 'open').length;
    if (totalOpen >= SHADOW_CONFIG.maxTotalOpen) return;

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
      shadowType: 'blind',
    });
    log.debug(`[shadow] Opened BLIND LONG ${sym} at ${entryPrice.toFixed(2)} (SL=${longSL.toFixed(2)}, TP=${longTP.toFixed(2)})`);

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
      shadowType: 'blind',
    });
    log.debug(`[shadow] Opened BLIND SHORT ${sym} at ${entryPrice.toFixed(2)} (SL=${shortSL.toFixed(2)}, TP=${shortTP.toFixed(2)})`);

    // Prune old resolved positions (keep all open + last 100 resolved).
    // O(n) single-pass (L3 fix) — the previous indexOf-based filter was O(n²).
    if (this.positions.length > 200) {
      const open = this.positions.filter(p => p.status === 'open');
      const resolved = this.positions.filter(p => p.status !== 'open');
      this.positions = [...open, ...resolved.slice(-100)];
    }
  }

  /**
   * v2.0.846 Phase 1a: Open a PURE-STATISTICS A/B shadow.
   *
   * Unlike `openAlignedShadow` (follows the LLM consensus direction), this opens
   * a shadow in a direction computed ONLY from statistical components — the same
   * ones the system uses but WITHOUT any LLM reasoning. By running both paths on
   * the same symbol/cycle with the same SL/TP, we can compare whether the LLM
   * debate actually adds edge over pure statistics (Phase 1a A/B test).
   *
   * The direction is passed in from the caller (which computes it from OLR P(win)
   * + First-Passage + Combo WR + Causal uplift). This method only persists the
   * shadow tagged `shadowType: 'statistical'` so the resolution loop can route it
   * to OLR at full weight and the attribution store can credit it separately.
   *
   * @param symbol      Symbol
   * @param entryPrice  Current price
   * @param side        Statistical direction ('buy' | 'sell')
   * @param slPrice     Stop-loss price (above for sell, below for buy)
   * @param tpPrice     Take-profit price (below for sell, above for buy)
   * @param cycle       Current cycle number
   * @param features    Feature snapshot at entry
   * @param statScore   Aggregate statistical conviction (for diagnostics)
   */
  openStatisticalShadow(
    symbol: string,
    entryPrice: number,
    side: 'buy' | 'sell',
    slPrice: number,
    tpPrice: number,
    cycle: number,
    features: Record<string, number>,
    statScore: number,
  ): void {
    // Guard against NaN/Infinity — same as openAlignedShadow.
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
    if (!Number.isFinite(statScore)) statScore = 0;
    const sym = symbol.toLowerCase();

    // Don't open if we already have a statistical shadow for this symbol+side+cycle.
    const existing = this.positions.find(
      p => p.symbol === sym && p.status === 'open' && p.side === side && p.shadowType === 'statistical' && p.openCycle === cycle,
    );
    if (existing) return;

    // Check limits (statistical shadows share the same pool).
    const symOpen = this.positions.filter(p => p.symbol === sym && p.status === 'open').length;
    if (symOpen >= SHADOW_CONFIG.maxOpenPerSymbol) return;
    const totalOpen = this.positions.filter(p => p.status === 'open').length;
    if (totalOpen >= SHADOW_CONFIG.maxTotalOpen) {
      // v2.0.861: priority eviction — a true-statistical shadow outranks the
      // oldest unevicted blind cold-start prior (0.1×). Evict → open.
      if (!this.evictOldestBlindForRoom()) return;
    }

    const ts = Date.now();
    const id = `stat_${++this.idCounter}`;

    const sl = slPrice > 0 ? slPrice : entryPrice * (1 - SHADOW_CONFIG.defaultSLDistance);
    const tp = tpPrice > 0 ? tpPrice : entryPrice * (1 + SHADOW_CONFIG.defaultTPDistance);
    const finalSL = side === 'sell' && slPrice > 0 ? slPrice : (side === 'sell' ? entryPrice * (1 + SHADOW_CONFIG.defaultSLDistance) : sl);
    const finalTP = side === 'sell' && tpPrice > 0 ? tpPrice : (side === 'sell' ? entryPrice * (1 - SHADOW_CONFIG.defaultTPDistance) : tp);

    this.positions.push({
      id,
      symbol: sym,
      side,
      entryPrice,
      stopLossPrice: finalSL,
      takeProfitPrice: finalTP,
      openCycle: cycle,
      openTimestamp: ts,
      features: { ...features },
      status: 'open',
      slNarrowed: false,
      originalSL: finalSL,
      originalTP: finalTP,
      highSinceOpen: entryPrice,
      lowSinceOpen: entryPrice,
      mfePct: 0,
      maePct: 0,
      shadowType: 'statistical',
    });

    log.debug(
      `[shadow] Opened STATISTICAL ${side.toUpperCase()} ${sym} at ${entryPrice.toFixed(2)} ` +
      `(SL=${finalSL.toFixed(2)}, TP=${finalTP.toFixed(2)}) — statScore=${statScore.toFixed(3)}`,
    );
  }

  /**
   * v2.0.861 Phase 1.5: Open a shadow in the direction the Q-RL EXPECTANCY
   * oracle picks (regime-conditioned, sample-guarded). This is the A/B
   * control arm against the LLM-aligned shadow: same SL/TP structure, same
   * cycle, different direction source. Its eventual PnL (via causal-reasoner
   * paired uplift) tells us whether the Q-RL direction signal ADDS edge over
   * the LLM debate — WITHOUT any live risk. OLR routing: 'shadow' (full
   * weight, same as statistical — it follows a real statistical signal, not
   * blind noise).
   *
   * @param qrlSignal  Spread + per-side Q snapshot for audit/uplift analysis.
   */
  openQRLShadow(
    symbol: string,
    entryPrice: number,
    side: 'buy' | 'sell',
    slPrice: number,
    tpPrice: number,
    cycle: number,
    features: Record<string, number>,
    qrlSignal?: { spread: number; buyQ: number; sellQ: number },
  ): void {
    // Guard against NaN/Infinity — same as openAlignedShadow.
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
    const sym = symbol.toLowerCase();

    // Don't open if we already have a Q-RL shadow for this symbol+side+cycle.
    const existing = this.positions.find(
      p => p.symbol === sym && p.status === 'open' && p.side === side && p.shadowType === 'qrl' && p.openCycle === cycle,
    );
    if (existing) return;

    // Check limits (Q-RL shadows share the same pool).
    const symOpen = this.positions.filter(p => p.symbol === sym && p.status === 'open').length;
    if (symOpen >= SHADOW_CONFIG.maxOpenPerSymbol) return;
    const totalOpen = this.positions.filter(p => p.status === 'open').length;
    if (totalOpen >= SHADOW_CONFIG.maxTotalOpen) {
      // v2.0.861: priority eviction — the Q-RL expectancy A/B arm outranks the
      // oldest unevicted blind cold-start prior. Evict → open.
      if (!this.evictOldestBlindForRoom()) return;
    }

    const ts = Date.now();
    const id = `qrl_${++this.idCounter}`;

    const sl = slPrice > 0 ? slPrice : entryPrice * (1 - SHADOW_CONFIG.defaultSLDistance);
    const tp = tpPrice > 0 ? tpPrice : entryPrice * (1 + SHADOW_CONFIG.defaultTPDistance);
    const finalSL = side === 'sell' && slPrice > 0 ? slPrice : (side === 'sell' ? entryPrice * (1 + SHADOW_CONFIG.defaultSLDistance) : sl);
    const finalTP = side === 'sell' && tpPrice > 0 ? tpPrice : (side === 'sell' ? entryPrice * (1 - SHADOW_CONFIG.defaultTPDistance) : tp);

    this.positions.push({
      id,
      symbol: sym,
      side,
      entryPrice,
      stopLossPrice: finalSL,
      takeProfitPrice: finalTP,
      openCycle: cycle,
      openTimestamp: ts,
      features: { ...features },
      status: 'open',
      slNarrowed: false,
      originalSL: finalSL,
      originalTP: finalTP,
      highSinceOpen: entryPrice,
      lowSinceOpen: entryPrice,
      mfePct: 0,
      maePct: 0,
      shadowType: 'qrl',
      qrlSignal: qrlSignal && Number.isFinite(qrlSignal.spread) ? {
        spread: qrlSignal.spread,
        buyQ: Number.isFinite(qrlSignal.buyQ) ? qrlSignal.buyQ : 0,
        sellQ: Number.isFinite(qrlSignal.sellQ) ? qrlSignal.sellQ : 0,
      } : undefined,
    });

    log.info(
      `[shadow] Opened QRL ${side.toUpperCase()} ${sym} at ${entryPrice.toFixed(2)} ` +
      `(SL=${finalSL.toFixed(2)}, TP=${finalTP.toFixed(2)}) — spread=${qrlSignal ? (qrlSignal.spread * 100).toFixed(2) + 'pp' : 'n/a'} (Phase 1.5 A/B)`,      
    );
  }

  /** Dedup check for Q-RL shadows (Phase 1.5). */
  hasQRLShadow(symbol: string, side: 'buy' | 'sell', cycle: number): boolean {
    const sym = symbol.toLowerCase();
    return this.positions.some(
      p => p.symbol === sym && p.status === 'open' && p.side === side && p.shadowType === 'qrl' && p.openCycle === cycle,
    );
  }

  /**
   * v2.0.834: Open a Factor-Tagged Aligned Shadow position.
   *
   * Unlike `openShadowTrades` (blind — opens both directions regardless of
   * LLM), this method opens a shadow trade in the direction the LLM consensus
   * leaned toward, but ONLY when the conviction gate blocked the trade (or
   * when consensus was HOLD but sub-agent weighted direction had a lean).
   *
   * This solves the fundamental distribution-shift problem: blind shadows
   * learn "what happens if you blindly bet in any condition", but the system
   * needs "what happens when the LLM says go this way under these conditions".
   * Aligned shadows learn the correct conditional distribution.
   *
   * Factor tagging records which agent + signal drove the shadow direction.
   * This metadata is NOT added to OLR features (avoiding dimension explosion
   * + overfitting on a linear model). Instead, it's passed to the RP Edge
   * Store's MiniLM embedding, enabling non-linear "similar market condition +
   * similar agent signal combination → historical outcome" queries.
   *
   * @param symbol           Symbol name
   * @param entryPrice       Current price
   * @param side             Direction to shadow (the weighted lean direction)
   * @param slPrice          Stop-loss price (from computeSmartSLTP)
   * @param tpPrice          Take-profit price (from computeSmartSLTP)
   * @param cycle            Current cycle number
   * @param features         Feature snapshot at entry time
   * @param consensusAction  The raw HACP consensus action ('buy'/'sell'/'hold')
   * @param consensusConfidence  The HACP consensus confidence (0-1)
   * @param weightedDirection The sub-agent weighted lean direction
   * @param weightedScore    Net weighted score (buyWeight - sellWeight)
   * @param primaryDriver    The agent with highest weight × matching direction
   * @param agentVotes       All sub-agent votes for factor analysis
   */
  openAlignedShadow(
    symbol: string,
    entryPrice: number,
    side: 'buy' | 'sell',
    slPrice: number,
    tpPrice: number,
    cycle: number,
    features: Record<string, number>,
    consensusAction: string,
    consensusConfidence: number,
    weightedDirection: 'buy' | 'sell',
    weightedScore: number,
    primaryDriver: { agent: string; weight: number; action: string },
    agentVotes: Array<{ agent: string; weight: number; action: string }>,
  ): void {
    // v2.0.834: Guard against NaN/Infinity entry price — `<= 0` does NOT
    // catch NaN (NaN <= 0 === false) or Infinity (Infinity <= 0 === false).
    // These would propagate into SL/TP calculations and corrupt OLR training.
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
    const sym = symbol.toLowerCase();

    // Don't open if we already have an aligned shadow for this symbol+side+cycle
    const existing = this.positions.find(
      p => p.symbol === sym && p.status === 'open' && p.side === side && p.shadowType === 'aligned' && p.openCycle === cycle,
    );
    if (existing) return;

    // Check limits (aligned shadows count toward the same pool).
    const symOpen = this.positions.filter(p => p.symbol === sym && p.status === 'open').length;
    if (symOpen >= SHADOW_CONFIG.maxOpenPerSymbol) return;
    // v2.0.861: aligned shadows previously had NO global total cap — only
    // per-symbol. With LLM leans this rarely matters, but it is a latent
    // unbounded-growth vector (a burst of lean cycles could exceed the pool
    // forever since aligned shadows never self-evict). Enforce the shared cap
    // with priority eviction: aligned (Q-RL's only live feed, v2.0.855)
    // outranks the oldest unevicted blind cold-start prior.
    const totalOpen = this.positions.filter(p => p.status === 'open').length;
    if (totalOpen >= SHADOW_CONFIG.maxTotalOpen) {
      if (!this.evictOldestBlindForRoom()) return;
    }
    const ts = Date.now();
    const id = `aligned_${++this.idCounter}`;

    // Calculate SL/TP — use provided Smart SL/TP, fall back to defaults
    const sl = slPrice > 0 ? slPrice : entryPrice * (1 - SHADOW_CONFIG.defaultSLDistance);
    const tp = tpPrice > 0 ? tpPrice : entryPrice * (1 + SHADOW_CONFIG.defaultTPDistance);
    // For SELL, SL is above and TP is below
    const finalSL = side === 'sell' && slPrice > 0 ? slPrice : (side === 'sell' ? entryPrice * (1 + SHADOW_CONFIG.defaultSLDistance) : sl);
    const finalTP = side === 'sell' && tpPrice > 0 ? tpPrice : (side === 'sell' ? entryPrice * (1 - SHADOW_CONFIG.defaultTPDistance) : tp);

    this.positions.push({
      id,
      symbol: sym,
      side,
      entryPrice,
      stopLossPrice: finalSL,
      takeProfitPrice: finalTP,
      openCycle: cycle,
      openTimestamp: ts,
      features: { ...features },
      status: 'open',
      slNarrowed: false,
      originalSL: finalSL,
      originalTP: finalTP,
      highSinceOpen: entryPrice,
      lowSinceOpen: entryPrice,
      mfePct: 0,
      maePct: 0,
      shadowType: 'aligned',
      factorTag: {
        consensusAction,
        consensusConfidence,
        weightedDirection,
        weightedScore,
        primaryDriver,
        agentVotes,
      },
    });

    log.info(
      `[shadow] Opened ALIGNED ${side.toUpperCase()} ${sym} at ${entryPrice.toFixed(2)} ` +
      `(SL=${finalSL.toFixed(2)}, TP=${finalTP.toFixed(2)}) — consensus=${consensusAction} ` +
      `conf=${(consensusConfidence * 100).toFixed(0)}% driver=${primaryDriver.agent}(${primaryDriver.action}) ` +
      `netWeight=${weightedScore.toFixed(2)}`,
    );
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
      // v2.0.219: FIXED — was using maxHoldCycles=50 (4+ hours) instead of
      // maxAgeCycles=12 (60 min). Also was NOT feeding OLR (continue skipped
      // feedTrade). Now feeds OLR with staleLearningWeight so the label signal
      // is retained but weighted lower than natural SL/TP resolution.
      if (!outcome && cycle - pos.openCycle >= SHADOW_CONFIG.maxAgeCycles) {
        const pnl = pos.side === 'buy'
          ? (price - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - price) / pos.entryPrice;
        pos.status = pnl >= 0 ? 'win' : 'loss';
        pos.resolvedCycle = cycle;
        pos.exitPrice = price;
        const holdCycles = cycle - pos.openCycle;
        const outcomeNum: 1 | 0 = pos.status === 'win' ? 1 : 0;

        // v2.0.219: Feed stale-resolved trades to OLR with reduced weight.
        // The label (pnl direction at the age cutoff) is still a meaningful
        // signal — it tells OLR "given these conditions, the trade didn't
        // resolve quickly, and the current direction is X." This is better
        // than discarding the sample entirely (old behavior).
        //
        // We use the staleLearningWeight (0.3) to reduce the gradient
        // contribution, so stale labels don't dominate natural SL/TP outcomes.
        const trainingFeaturesStale: Record<string, number> = {};
        const allKeys = new Set([...Object.keys(pos.features), ...Object.keys(currentFeatures ?? {})]);
        for (const key of allKeys) {
          const entryVal = pos.features[key] ?? 0;
          const resolutionVal = currentFeatures?.[key] ?? entryVal;
          trainingFeaturesStale[key] = 0.3 * entryVal + 0.7 * resolutionVal;
        }
        trainingFeaturesStale['mfePct'] = pos.mfePct ?? 0;
        trainingFeaturesStale['maePct'] = pos.maePct ?? 0;
        const stalePnlPct = pos.side === 'buy'
          ? (price - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - price) / pos.entryPrice;
        trainingFeaturesStale['mfeToPnlRatio'] = (pos.mfePct ?? 0) > 0
          ? ((pos.mfePct ?? 0) - stalePnlPct) / (pos.mfePct ?? 0)
          : 0;

        try {
          // v2.0.834: Aligned shadows use 'shadow' source; blind use 'shadow_blind'.
          // v2.0.846: Statistical shadows (pure-statistics A/B) also use full-weight
          // 'shadow' — they follow a real statistical signal, not blind noise.
          const staleSource = pos.shadowType === 'blind' ? 'shadow_blind' : 'shadow';
          this.olrEngine.feedTrade(
            sym, trainingFeaturesStale, outcomeNum, pos.side, staleSource, cycle,
            false, undefined, SHADOW_CONFIG.staleLearningWeight,
          );
          log.info(`[shadow] Force-resolved ${pos.id} (${pos.side} ${sym}, type=${pos.shadowType}) after ${holdCycles} cycles — pnl=${(pnl * 100).toFixed(2)}% → OLR fed (source=${staleSource}, stale weight=${SHADOW_CONFIG.staleLearningWeight})`);
        } catch (err) {
          log.warn(`[shadow] OLR feedTrade (stale) failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome: pos.status, holdCycles, cycle, mfePct: pos.mfePct, maePct: pos.maePct, shadowType: pos.shadowType, exitReason: 'force_resolve', pnlPct: Number.isFinite(pnl) ? pnl * 100 : 0 });
        if (this.recentResults.length > 100) this.recentResults.shift();
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
        //
        // v2.0.181: Weighted training — combine entry and resolution features
        // with a recency bias. The resolution features get higher weight (0.7)
        // because they represent the market conditions that actually caused the
        // outcome. Entry features get lower weight (0.3) to retain some signal
        // about the initial conditions. This prevents the OLR from learning
        // spurious correlations from stale features while still preserving
        // information about the full trade lifecycle.
        const trainingFeatures: Record<string, number> = {};
        const entryWeight = 0.3;
        const resolutionWeight = 0.7;
        const allKeys = new Set([...Object.keys(pos.features), ...Object.keys(currentFeatures ?? {})]);
        for (const key of allKeys) {
          const entryVal = pos.features[key] ?? 0;
          const resolutionVal = currentFeatures?.[key] ?? entryVal;
          trainingFeatures[key] = entryWeight * entryVal + resolutionWeight * resolutionVal;
        }
        // v2.0.720: Add MFE/MAE features to training features so OLR can learn
        // from shadow trade exit quality. These are only known at resolution
        // time (not entry), so they bypass the entry/resolution blend.
        trainingFeatures['mfePct'] = pos.mfePct ?? 0;
        trainingFeatures['maePct'] = pos.maePct ?? 0;
        const shadowPnlPct = pos.side === 'buy'
          ? (exitPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - exitPrice) / pos.entryPrice;
        trainingFeatures['mfeToPnlRatio'] = (pos.mfePct ?? 0) > 0
          ? ((pos.mfePct ?? 0) - shadowPnlPct) / (pos.mfePct ?? 0)
          : 0;
        // v2.0.202: Log the feature composition for debugging — helps verify
        // that resolution-time features are actually being used and not just
        // falling back to stale entry features.
        if (currentFeatures) {
          const resolutionKeys = Object.keys(currentFeatures);
          const overlapKeys = allKeys.size > 0 ? Array.from(allKeys).filter(k => currentFeatures[k] !== undefined && pos.features[k] !== undefined).length : 0;
          log.debug(`[shadow] OLR training features: ${allKeys.size} total keys, ${resolutionKeys.length} from resolution, ${overlapKeys} overlapping — resolution weight=${resolutionWeight}`);
        }

        try {
          // v2.0.834: Aligned shadows feed OLR at full weight (source='shadow');
          // blind shadows feed at reduced weight (source='shadow_blind', 0.1×).
          // v2.0.846: Statistical shadows (pure-statistics A/B) also full-weight.
          const source = pos.shadowType === 'blind' ? 'shadow_blind' : 'shadow';
          this.olrEngine.feedTrade(sym, trainingFeatures, outcomeNum, pos.side, source, cycle);
          log.info(`[shadow] ${outcome.toUpperCase()} ${pos.side.toUpperCase()} ${sym} held ${holdCycles} cycles (entry=${pos.entryPrice.toFixed(2)} exit=${exitPrice.toFixed(2)}, slNarrowed=${pos.slNarrowed}, type=${pos.shadowType}) → OLR fed (source=${source})`);
        } catch (err) {
          log.warn(`[shadow] OLR feedTrade failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome, holdCycles, cycle, mfePct: pos.mfePct, maePct: pos.maePct, shadowType: pos.shadowType, exitReason: 'sl_tp', pnlPct: Number.isFinite(shadowPnlPct) ? shadowPnlPct * 100 : 0 });
        if (this.recentResults.length > 100) this.recentResults.shift();

        resolved++;
      }
    }

    return resolved;
  }

  /**
   * v2.0.869-P2(主神 Shadow 升級):最近 N 個 shadow trade 盈虧統計
   *  bySide(學「邊個 side 有 edge」)+ byExitReason(學「邊個離場原因有 edge」)
   */
  getRecentPerformance(n = 100): {
    n: number;
    winRate: number;
    totalPnlPct: number;
    avgPnlPct: number;
    bySide: Record<string, { n: number; winRate: number; avgPnlPct: number }>;
    byExitReason: Record<string, { n: number; winRate: number; avgPnlPct: number }>;
  } {
    const recent = this.recentResults.slice(-Math.max(1, Math.min(200, n)));
    // v2.0.869-P2(主神 刁鑽攻擊):防禦——null/非物件樣本 skip + __proto__ key 防污染
    const valid = recent.filter((r): r is NonNullable<typeof r> => !!r && typeof r === 'object');
    const wins = valid.filter(r => r.outcome === 'win').length;
    const totalPnl = valid.reduce((a, r) => a + (Number.isFinite(r.pnlPct) ? (r.pnlPct as number) : 0), 0);
    const bySide: Record<string, { n: number; winRate: number; avgPnlPct: number }> = {};
    const byExitReason: Record<string, { n: number; winRate: number; avgPnlPct: number }> = {};
    for (const side of ['buy', 'sell'] as const) {
      const arr = valid.filter(r => r.side === side);
      if (arr.length > 0) {
        const sideWins = arr.filter(r => r.outcome === 'win').length;
        bySide[side] = {
          n: arr.length,
          winRate: sideWins / arr.length,
          avgPnlPct: arr.reduce((a, r) => a + (Number.isFinite(r.pnlPct) ? (r.pnlPct as number) : 0), 0) / arr.length,
        };
      }
    }
    for (const r of valid) {
      const reason = r.exitReason ?? 'unknown';
      // v2.0.869-P2(主神 刁鑽攻擊):__proto__/constructor/prototype key 防污染
      if (reason === '__proto__' || reason === 'constructor' || reason === 'prototype') continue;
      byExitReason[reason] ??= { n: 0, winRate: 0, avgPnlPct: 0 };
      byExitReason[reason]!.n++;
      byExitReason[reason]!.avgPnlPct += Number.isFinite(r.pnlPct) ? (r.pnlPct as number) : 0;
    }
    for (const k of Object.keys(byExitReason)) {
      byExitReason[k]!.avgPnlPct /= Math.max(1, byExitReason[k]!.n);
      byExitReason[k]!.winRate = valid.filter(r => (r.exitReason ?? 'unknown') === k && r.outcome === 'win').length / Math.max(1, byExitReason[k]!.n);
    }
    return {
      n: valid.length,
      winRate: valid.length > 0 ? wins / valid.length : 0,
      totalPnlPct: totalPnl,
      avgPnlPct: valid.length > 0 ? totalPnl / valid.length : 0,
      bySide,
      byExitReason,
    };
  }

  /** v2.0.869-P2(主神 Shadow 升級):buy/sell 分別統計——學「邊個 side 有 edge」 */
  getSideStats(): { buy: { n: number; winRate: number; avgPnlPct: number }; sell: { n: number; winRate: number; avgPnlPct: number } } {
    const perf = this.getRecentPerformance(100);
    return {
      buy: perf.bySide['buy'] ?? { n: 0, winRate: 0, avgPnlPct: 0 },
      sell: perf.bySide['sell'] ?? { n: 0, winRate: 0, avgPnlPct: 0 },
    };
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
        // v2.0.869-P2(主神 刁鑽攻擊):null/非物件樣本 skip——唔 crash
        if (!r || typeof r !== 'object') continue;
        const icon = r.outcome === 'win' ? '✅' : '❌';
        parts.push(`  ${icon} ${r.side.toUpperCase()} ${r.symbol} — ${r.outcome.toUpperCase()} (${r.holdCycles} cycles)`);
      }

      // Aggregate win rates
      const longResults = this.recentResults.filter(r => !!r && typeof r === 'object' && r.side === 'buy');
      const shortResults = this.recentResults.filter(r => !!r && typeof r === 'object' && r.side === 'sell');
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

      // v2.0.869-P2(主神 Shadow 升級):最近 100 個盈虧統計——bySide + byExitReason
      // 學「邊個 side 有 edge」+「邊個離場原因有 edge」——注入 Meta-Agent
      const perf = this.getRecentPerformance(100);
      if (perf.n >= 5) {
        parts.push(`Recent ${perf.n} shadow trades: WR=${(perf.winRate * 100).toFixed(0)}% avgPnl=${perf.avgPnlPct >= 0 ? '+' : ''}${perf.avgPnlPct.toFixed(2)}% total=${perf.totalPnlPct >= 0 ? '+' : ''}${perf.totalPnlPct.toFixed(2)}%`);
        for (const side of ['buy', 'sell'] as const) {
          const s = perf.bySide[side];
          if (s && s.n >= 3) {
            parts.push(`  ${side.toUpperCase()}: n=${s.n} WR=${(s.winRate * 100).toFixed(0)}% avgPnl=${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(2)}%`);
          }
        }
        for (const [reason, s] of Object.entries(perf.byExitReason)) {
          if (s.n >= 3) {
            parts.push(`  exit=${reason}: n=${s.n} WR=${(s.winRate * 100).toFixed(0)}% avgPnl=${s.avgPnlPct >= 0 ? '+' : ''}${s.avgPnlPct.toFixed(2)}%`);
          }
        }
      }
    } else {
      parts.push('  (no shadow trades resolved yet)');
    }

    return {
      contextString: parts.join('\n'),
      openCount,
      // v2.0.869-P2(主神 刁鑽攻擊):null/非物件樣本 skip——唔 crash
      recentResults: recent.filter((r): r is NonNullable<typeof r> => !!r && typeof r === 'object').map(r => ({ symbol: r.symbol, side: r.side, outcome: r.outcome, holdCycles: r.holdCycles })),
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
      // v2.0.869-P2(主神 刁鑽攻擊):null/非物件樣本 skip——唔 crash
      if (!r || typeof r !== 'object') continue;
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
   * v2.0.219: Drain recently-resolved shadow trades for advanced learning
   * system feeding (replay buffer, temporal attention, cross-symbol, world
   * model). Returns results accumulated since the last call and clears the
   * internal buffer — so callers only process each resolution once.
   *
   * Includes the training features that were fed to OLR (entry/resolution
   * blend) so downstream systems train on the same feature distribution.
   */
  drainRecentResults(): Array<{
    id: string; symbol: string; side: 'buy' | 'sell';
    outcome: 'win' | 'loss'; holdCycles: number; cycle: number;
    mfePct: number; maePct: number; pnlPct: number;
    shadowType: 'blind' | 'aligned' | 'statistical' | 'qrl';
  }> {
    if (this.recentResults.length === 0) return [];
    const drained = this.recentResults.map(r => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      outcome: r.outcome,
      holdCycles: r.holdCycles,
      cycle: r.cycle,
      mfePct: r.mfePct ?? 0,
      maePct: r.maePct ?? 0,
      // Approximate pnlPct from outcome + MFE/MAE (exact entry/exit not stored
      // in recentResults, but outcome direction is the key signal)
      pnlPct: r.outcome === 'win' ? Math.max(r.mfePct ?? 0, 0.001) : -Math.max(r.maePct ?? 0, 0.001),
      shadowType: r.shadowType ?? 'blind',
    }));
    this.recentResults = [];
    return drained;
  }

  /**
   * v2.0.834: Check if an aligned shadow was already opened for this symbol
   * in the given cycle. Used to skip redundant blind shadows when an aligned
   * shadow already covers the LLM-chosen direction.
   */
  hasAlignedShadow(symbol: string, cycle: number): boolean {
    const sym = symbol.toLowerCase();
    return this.positions.some(
      p => p.symbol === sym && p.status === 'open' && p.shadowType === 'aligned' && p.openCycle === cycle,
    );
  }

  /**
   * v2.0.846 Phase 1a: Check if a statistical A/B shadow is already open for
   * this symbol+side+cycle. Prevents duplicate statistical shadows per cycle.
   */
  hasStatisticalShadow(symbol: string, side: 'buy' | 'sell', cycle: number): boolean {
    const sym = symbol.toLowerCase();
    return this.positions.some(
      p => p.symbol === sym && p.status === 'open' && p.side === side && p.shadowType === 'statistical' && p.openCycle === cycle,
    );
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