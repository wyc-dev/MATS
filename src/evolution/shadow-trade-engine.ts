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
import { normalizeSymbol } from '../trading/portfolio.ts';

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
  shadowType: 'blind' | 'aligned' | 'statistical' | 'qrl' | 'seeded';
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
  /** v2.0.870-sell-decay: decayed (24h exp) cumulative win counts — NOT raw lifetime.
   *  Old sample weight fades exp(-Δt/τ) so the gate reflects recent performance,
   *  not fossil all-time stats (root cause of the SELL death spiral). */
  longWins: number;
  longLosses: number;
  shortWins: number;
  shortLosses: number;
  /** v2.0.870-sell-decay: decayed net PnL% sum per side — the EV half of the
   *  shadow-gate (WR-only gates kill low-WR high-EV edges like SKHX sell). */
  longSumPnlPct: number;
  shortSumPnlPct: number;
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
  private recentResults: Array<{ id: string; symbol: string; side: 'buy' | 'sell'; outcome: 'win' | 'loss'; holdCycles: number; cycle: number; mfePct?: number; maePct?: number; shadowType?: 'blind' | 'aligned' | 'statistical' | 'qrl' | 'seeded'; exitReason?: 'sl_tp' | 'force_resolve' | 'evicted'; pnlPct?: number; volumeState?: 'thin' | 'normal' | 'strong' | 'unknown'; volumeRatio5m?: number }> = [];

  /**
   * v2.0.870-EMR: 持久化 per-symbol×side 累計統計——唔依賴 recentResults 緩衝區
   * （drainRecentResults feed OLR 後會清空緩衝區，統計會消失）。
   * key = `${normalizeSymbol(symbol)}|${side}`。backfill + live resolve 都更新。
   */
  /** v2.0.870-sell-decay: per-symbol×side decayed stats.
   *  lastUpdatedTs drives exp(-Δt/τ) fade (τ = SHADOW_STAT_DECAY_HOURS, default 24h).
   *  τ=0 → no decay (old behavior, env rollback). */
  private statsBySymbolSide = new Map<string, { wins: number; losses: number; totalPnlPct: number; lastUpdatedTs?: number }>();

  /** τ (hours) for shadow stat decay. env SHADOW_STAT_DECAY_HOURS; 0 = 唔衰減
   *  (回滾), invalid/negative → default 24h. */
  private static decayTauHours(): number {
    const raw = Number(process.env['SHADOW_STAT_DECAY_HOURS']);
    if (!Number.isFinite(raw) || raw < 0) return 24;
    return raw;
  }

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
   * v2.0.870-sell-decay Fix E: Open a SEEDED shadow (counter-side seeding).
   *
   * Root cause of the SELL death spiral: sell shadows only ever opened when the
   * LLM leaned sell → in a bull market that never happens → sell sample count
   * starves → OLR sell P(win) collapses → LLM never leans sell (loop).
   *
   * Seeding breaks the loop: when recent momentum is negative (or regime is not
   * trending-bull), the system PROACTIVELY opens a sell shadow so sell outcomes
   * accumulate in NORMAL conditions too, not just knife-catching crashes.
   *
   * shadowType='seeded' (full OLR weight, same as aligned/statistical — it
   * follows a real market-condition signal, not blind noise). Frequency-capped:
   * at most 1 seeded shadow per symbol per 24 cycles (≈96min at 4min/cycle).
   *
   * @param symbol      Symbol
   * @param entryPrice  Current price
   * @param side        Direction to seed ('sell' — future buy-seeding can reuse)
   * @param slPrice     SL price (above entry for sell)
   * @param tpPrice     TP price (below entry for sell)
   * @param cycle       Current cycle number
   * @param features    Feature snapshot at entry
   * @param seedReason  Diagnostic label (momentum/regime)
   */
  openSeededShadow(
    symbol: string,
    entryPrice: number,
    side: 'buy' | 'sell',
    slPrice: number,
    tpPrice: number,
    cycle: number,
    features: Record<string, number>,
    seedReason: string,
    /** v2.0.870-sell-seed-accel S1: cooldown cycles（跌勢 6 / 非跌勢 24）——
     *  跌勢期間 sell 樣本回流快 4 倍, 非跌勢保持保守。 */
    cooldownCycles: number = 24,
  ): void {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return;
    if (side !== 'buy' && side !== 'sell') return;
    const sym = symbol.toLowerCase();

    // Frequency cap: 1 seeded per symbol per cooldownCycles（防過度播種——用 openCycle
    // 判斷而唔係 status：一個 open 嘅 seeded 唔應該永久阻止新播種）
    const cool = Number.isFinite(cooldownCycles) && cooldownCycles >= 1 ? Math.floor(cooldownCycles) : 24;
    const recentSeeded = this.positions.some(
      p => p.symbol === sym && p.shadowType === 'seeded' && (cycle - p.openCycle) < cool,
    );
    if (recentSeeded) return;

    // Limits (share the same pool as other shadows)
    const symOpen = this.positions.filter(p => p.symbol === sym && p.status === 'open').length;
    if (symOpen >= SHADOW_CONFIG.maxOpenPerSymbol) return;
    const totalOpen = this.positions.filter(p => p.status === 'open').length;
    if (totalOpen >= SHADOW_CONFIG.maxTotalOpen) {
      if (!this.evictOldestBlindForRoom()) return;
    }

    const ts = Date.now();
    const id = `seed_${++this.idCounter}`;

    // Sell: SL above entry, TP below; Buy mirrored. Defaults if not provided.
    // ATTACK-HARDENING (v2.0.870-sell-decay-attack A4): NaN/Infinity SL/TP → default
    // （Infinity > 0 係 true，會開出 stopLossPrice=Infinity 污染 resolution）
    const safeSl = Number.isFinite(slPrice) && slPrice > 0 ? slPrice : 0;
    const safeTp = Number.isFinite(tpPrice) && tpPrice > 0 ? tpPrice : 0;
    const finalSL = safeSl > 0
      ? safeSl
      : entryPrice * (side === 'sell' ? 1 + SHADOW_CONFIG.defaultSLDistance : 1 - SHADOW_CONFIG.defaultSLDistance);
    const finalTP = safeTp > 0
      ? safeTp
      : entryPrice * (side === 'sell' ? 1 - SHADOW_CONFIG.defaultTPDistance : 1 + SHADOW_CONFIG.defaultTPDistance);

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
      shadowType: 'seeded',
    });

    log.debug(`[shadow] Opened SEEDED ${side.toUpperCase()} ${sym} at ${entryPrice.toFixed(2)} (SL=${finalSL.toFixed(2)}, TP=${finalTP.toFixed(2)}) — ${seedReason}`);
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
  /** P29-S2: tick 盲區修復——除咗 tick path(cycleHigh/Low),接受每 cycle
   *  嘅 5m 蠟燭路徑(candlePath),按每個倉位嘅 openTimestamp 窗選,
   *  取 ∪ 極值。非 active 市場(REST 每 cycle 1 tick)以前睇唔到 cycle 內
   *  嘅插針 → TP/SL 假未中;依家逐 5 分鐘全覆蓋。
   *  紀律:跨站支(t ≥ open-300s)納入;再早嘅蠟燭唔准用(無追溯);
   *  NaN/h<l/負價壞支跳過;同日穿雙邊維持 SL-first 保守規則。 */
  checkPositions(symbol: string, price: number, cycle: number, cycleHigh?: number, cycleLow?: number, currentFeatures?: Record<string, number>, candlePath?: Array<{ t: number; h: number; l: number }>): number {
    if (price <= 0) return 0;
    const sym = symbol.toLowerCase();
    let resolved = 0;
    const tickHi = cycleHigh != null && cycleHigh > 0 && Number.isFinite(cycleHigh) ? cycleHigh : price;
    const tickLo = cycleLow != null && cycleLow > 0 && Number.isFinite(cycleLow) ? cycleLow : price;

    for (const pos of this.positions) {
      if (pos.status !== 'open') continue;
      if (pos.symbol !== sym) continue;

      // P29-S2: 蠟燭窗口極值(每倉位獨立窗——唔准攞人哋倉位嘅時間窗)
      let hi = tickHi;
      let lo = tickLo;
      // 時鐘容差 5s——future 時間戳係污染,唔准用蠟燭
      if (candlePath && candlePath.length > 0 && Number.isFinite(pos.openTimestamp) && pos.openTimestamp > 0 && pos.openTimestamp <= Date.now() + 5_000) {
        const windowStart = pos.openTimestamp - 300_000; // 一支 5m 容差(straddle)
        for (const c of candlePath) {
          if (!c || c.t < windowStart) continue;
          if (!Number.isFinite(c.h) || !Number.isFinite(c.l)) continue;      // NaN 支
          if (c.h <= 0 || c.l <= 0) continue;                                 // 負/零價
          if (c.h < c.l) continue;                                             // h<l 壞支
          // C-3(attack):巨針盾——5m 極值偏離入場價 ±100%(翻倍/歸零)= 數據異常,
          // 跳過整支,連 highSinceOpen 都唔准污染(假 TP/SL 命中會教壞學習)
          if (pos.entryPrice > 0 && (c.h > pos.entryPrice * 2 || c.l < pos.entryPrice / 2)) continue;
          if (c.h > hi) hi = c.h;
          if (c.l < lo) lo = c.l;
        }
      }

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

        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome: pos.status, holdCycles, cycle, mfePct: pos.mfePct, maePct: pos.maePct, shadowType: pos.shadowType, exitReason: 'force_resolve', pnlPct: Number.isFinite(pnl) ? pnl * 100 : 0, ...this.volumeTagsFromFeatures(pos.features) });
        if (this.recentResults.length > 100) this.recentResults.shift();
        // v2.0.870-EMR: force-resolve 更新持久化統計（pnl 小數，唔 ×100——同 backfill 一致）
        this.recordStat(sym, pos.side, pos.status, Number.isFinite(pnl) ? pnl : 0);
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

        this.recentResults.push({ id: pos.id, symbol: sym, side: pos.side, outcome, holdCycles, cycle, mfePct: pos.mfePct, maePct: pos.maePct, shadowType: pos.shadowType, exitReason: 'sl_tp', pnlPct: Number.isFinite(shadowPnlPct) ? shadowPnlPct * 100 : 0, ...this.volumeTagsFromFeatures(pos.features) });
        if (this.recentResults.length > 100) this.recentResults.shift();
        // v2.0.870-EMR: sl_tp resolve 更新持久化統計（shadowPnlPct 小數，唔 ×100——同 backfill 一致）
        this.recordStat(sym, pos.side, outcome, Number.isFinite(shadowPnlPct) ? shadowPnlPct : 0);

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
      const reasonStr = String(reason);
      if (reasonStr === '__proto__' || reasonStr === 'constructor' || reasonStr === 'prototype') continue;
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

  /** 記錄一筆 shadow 結果到持久化統計（backfill + live resolve 都調用）。
   *  pnlPct 統一為小數（0.0036 = 0.36%）——backfill(EXP 小數) 同 live(price delta 小數) 一致。 */
  /** v2.0.870-sell-decay: apply exp(-Δt/τ) to an existing stat cell before adding
   *  a new outcome — old samples fade out so WR/EV reflect the RECENT window.
   *  ATTACK-HARDENED: 未來 timestamp（> now+5min）視為最舊（4×τ 前衰減）——
   *  防止攻擊者以未來 ts 凍結 cell 令化石數據永久主導。 */
  private decayStatCell(s: { wins: number; losses: number; totalPnlPct: number; lastUpdatedTs?: number }): void {
    const tauH = ShadowTradeEngine.decayTauHours();
    const now = Date.now();
    if (tauH <= 0) { s.lastUpdatedTs = now; return; } // τ=0 → 唔衰減（回滾語義）
    const last = s.lastUpdatedTs;
    if (typeof last !== 'number' || !Number.isFinite(last) || last > now + 300_000) {
      // 冷啟動 / 污染(無效 / 未來 5min 以上) → 視為最舊（4×τ 前）——化石淡出
      const f = Math.exp(-4);
      s.wins *= f;
      s.losses *= f;
      s.totalPnlPct *= f;
      s.lastUpdatedTs = now;
      return;
    }
    const dt = Math.max(0, now - last);
    const f = Math.exp(-dt / (tauH * 3_600_000));
    s.wins *= f;
    s.losses *= f;
    s.totalPnlPct *= f;
    s.lastUpdatedTs = now;
  }

  /** 記錄一筆 shadow 結果到持久化統計（backfill + live resolve 都調用）。
   *  pnlPct 統一為小數（0.0036 = 0.36%）——backfill(EXP 小數) 同 live(price delta 小數) 一致。
   *  v2.0.870-sell-decay: 記錄前先 exp 衰減舊計數——stats 永遠係「近期加權」而唔係 lifetime 化石。 */
  private recordStat(symbol: string, side: 'buy' | 'sell', outcome: 'win' | 'loss', pnlPct: number): void {
    const norm = normalizeSymbol(symbol).toLowerCase();
    // 攻擊硬化：空 symbol / 垃圾 side → 唔記錄（避免 key 污染）
    if (norm.length === 0 || (side !== 'buy' && side !== 'sell')) return;
    const key = `${norm}|${side}`;
    const s = this.statsBySymbolSide.get(key) ?? { wins: 0, losses: 0, totalPnlPct: 0 };
    this.decayStatCell(s);
    if (outcome === 'win') s.wins += 1; else s.losses += 1;
    s.totalPnlPct += Number.isFinite(pnlPct) ? pnlPct : 0;
    this.statsBySymbolSide.set(key, s);
  }

  /**
   * v2.0.870-EMR: per-symbol×side shadow 統計（exploration 質量控制用）。
   * 讀持久化累計統計——唔受 recentResults 緩衝區 drain 影響。
   */
  getSymbolSideStats(symbol: string): {
    buy: { n: number; winRate: number; avgPnlPct: number };
    sell: { n: number; winRate: number; avgPnlPct: number };
  } {
    const norm = normalizeSymbol(symbol).toLowerCase();
    const out: Record<string, { n: number; winRate: number; avgPnlPct: number }> = {};
    for (const side of ['buy', 'sell'] as const) {
      const s = this.statsBySymbolSide.get(`${norm}|${side}`);
      if (s && s.wins + s.losses > 0) {
        const n = s.wins + s.losses;
        out[side] = { n, winRate: s.wins / n, avgPnlPct: n > 0 ? s.totalPnlPct / n : 0 };
      }
    }
    return {
      buy: out['buy'] ?? { n: 0, winRate: 0, avgPnlPct: 0 },
      sell: out['sell'] ?? { n: 0, winRate: 0, avgPnlPct: 0 },
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
        // v2.0.869-P2(主神 刁鑽攻擊):side/outcome 異常防禦(undefined/null/大寫)
        // + symbol 控制字符 sanitize(防 prompt 注入)
        const sideStr = typeof r.side === 'string' ? r.side.toUpperCase() : '?';
        const outcomeStr = typeof r.outcome === 'string' ? r.outcome.toUpperCase() : '?';
        const symStr = String(r.symbol ?? '?').replace(/[\x00-\x1F]/g, '').slice(0, 24);
        const icon = r.outcome === 'win' ? '✅' : '❌';
        parts.push(`  ${icon} ${sideStr} ${symStr} — ${outcomeStr} (${r.holdCycles} cycles)`);
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
          parts.push(`${String(s.symbol ?? '?').replace(/[\x00-\x1F]/g, '').slice(0, 24)}: avg MFE=${(s.avgMfePct * 100).toFixed(1)}% avg MAE=${(s.avgMaePct * 100).toFixed(1)}%`);
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

  /** P29-S1: 由 entry features 提取入場時量標籤(持久化到 recentResults)。
   *  冇量維度(歷史/舊版)→ 'unknown'(唔准假扮 normal,否則污染正常桶)。 */
  private volumeTagsFromFeatures(f: Record<string, number> | undefined): { volumeState?: 'thin' | 'normal' | 'strong' | 'unknown'; volumeRatio5m?: number } {
    if (!f) return { volumeState: 'unknown' };
    // V-1(attack):中性預設 1.0/1.0 唔代表有量數據——必須 volumeData=1 先算真量
    if (f['volumeData'] !== 1) return { volumeState: 'unknown' };
    // V-3(attack):ratio clamp——1e9 級異常值唔准持久化/入學習維度
    const raw = Number.isFinite(f['volumeRatio5m']) ? f['volumeRatio5m'] : undefined;
    const vr = raw !== undefined ? Math.min(Math.max(raw, 0), 100) : undefined;
    const state = f['volumeThin'] === 1 ? 'thin' : f['volumeStrong'] === 1 ? 'strong' : 'normal';
    return { volumeState: state, volumeRatio5m: vr };
  }

  /** P29-S3: 量條件勝率——主神親眼睇「放量入場 vs 縮量入場」邊個有 edge。 */
  getVolumeConditionedStats(): Record<'thin' | 'normal' | 'strong' | 'unknown', { resolved: number; wins: number; winRate: number; avgPnlPct: number }> {
    const mk = () => ({ resolved: 0, wins: 0, winRate: 0, avgPnlPct: 0, _pnlSum: 0 });
    const buckets = { thin: mk(), normal: mk(), strong: mk(), unknown: mk() };
    for (const r of this.recentResults) {
      if (!r || typeof r !== 'object') continue;
      // V-3a(attack):白名單——污改過嘅 volumeState('__proto__'/'constructor')歸 unknown,
      // 唔准撞上 Object.prototype 屬性令統計 NaN
      const vs = r.volumeState === 'thin' || r.volumeState === 'normal' || r.volumeState === 'strong' ? r.volumeState : 'unknown';
      const b = buckets[vs];
      b.resolved++;
      if (r.outcome === 'win') b.wins++;
      if (Number.isFinite(r.pnlPct)) b._pnlSum += r.pnlPct as number;
    }
    const out: Record<string, { resolved: number; wins: number; winRate: number; avgPnlPct: number }> = {};
    for (const [k, b] of Object.entries(buckets)) {
      out[k] = {
        resolved: b.resolved, wins: b.wins,
        winRate: b.resolved > 0 ? b.wins / b.resolved : 0,
        avgPnlPct: b.resolved > 0 ? b._pnlSum / b.resolved : 0,
      };
    }
    return out as any;
  }

  /** v2.0.870-P69: EXP backfill 完成 flag——restart 唔重複 feed */
  private backfillDone = false;

  /** v2.0.870-P69: 有冇做過 EXP backfill */
  isBackfillDone(): boolean { return this.backfillDone; }

  /**
   * v2.0.870-P69: EXP history backfill——shadow 只靠 live(每 cycle 開 shadow,
   * 等 SL/TP hit 或者 12 cycles force-resolve),低波動市場好耐先 resolve,
   * 導致 0W/0L 冷啟動。用 EXP trades 嘅 outcome 做 cold-start 近似:
   * WIN → TP-before-SL(win),LOSS → SL-before-TP(loss)。
   * 只 feed 一次(backfillDone guard);cap 100(同 live resolve 一致)。
   */
  backfillFromExpRecords(records: Array<{ symbol: string; side: string; outcome: 'win' | 'loss'; holdCycles: number; pnlPct: number }>): number {
    if (this.backfillDone) return 0;
    this.backfillDone = true;
    let fed = 0;
    for (const rec of records) {
      if (!rec.outcome || !rec.symbol) continue;
      const sym = rec.symbol.toLowerCase(); // 同 openShadowTrades 一致(全細階)
      this.recentResults.push({
        id: `backfill-${fed}`,
        symbol: sym,
        side: rec.side === 'buy' ? 'buy' : 'sell',
        outcome: rec.outcome,
        holdCycles: rec.holdCycles,
        cycle: 0,
        shadowType: 'aligned',
        exitReason: 'sl_tp',
        pnlPct: rec.pnlPct,
      });
      // v2.0.870-EMR: backfill 同時更新持久化統計（唔依賴緩衝區）
      this.recordStat(sym, rec.side === 'buy' ? 'buy' : 'sell', rec.outcome, rec.pnlPct);
      fed++;
    }
    if (this.recentResults.length > 100) this.recentResults = this.recentResults.slice(-100);
    log.info(`[shadow] EXP backfill fed ${fed} records (cold-start W/L stats)`);
    return fed;
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
        s = { symbol: sym, totalOpened: 0, openCount: 0, longWins: 0, longLosses: 0, shortWins: 0, shortLosses: 0, longSumPnlPct: 0, shortSumPnlPct: 0, longWinRate: 0, shortWinRate: 0, avgHoldCycles: 0, avgMfePct: 0, avgMaePct: 0 };
        symbolMap.set(sym, s);
      }
      return s;
    };

    // 1. Open positions (count as open, not win/loss)
    for (const pos of this.positions) {
      if (pos.status !== 'open') continue;
      const s = getOrCreate(pos.symbol);
      s.totalOpened++;
      s.openCount++;
    }

    // 2. Resolved positions still in memory — v2.0.870-sell-decay: 只貢獻 avg 指標
    //    （holdCycles/mfe/mae）。win/loss 由持久化 decayed statsBySymbolSide 負責
    //    （step 4）——避免雙重計算 + 令 WR 反映近期而唔係記憶體殘留。
    for (const pos of this.positions) {
      if (pos.status === 'open') continue;
      const s = getOrCreate(pos.symbol);
      const holdCycles = (pos.resolvedCycle ?? pos.openCycle) - pos.openCycle;
      s.totalOpened++;
      s.avgHoldCycles = (s.avgHoldCycles * (s.totalOpened - 1) + holdCycles) / s.totalOpened;
      if (pos.mfePct !== undefined) s.avgMfePct = (s.avgMfePct * (s.totalOpened - 1) + pos.mfePct) / s.totalOpened;
      if (pos.maePct !== undefined) s.avgMaePct = (s.avgMaePct * (s.totalOpened - 1) + pos.maePct) / s.totalOpened;
    }

    // 3. Recent results (survives restart) — avg-only, same rationale as step 2
    for (const r of this.recentResults) {
      // v2.0.869-P2(主神 刁鑽攻擊):null/非物件樣本 skip——唔 crash
      if (!r || typeof r !== 'object') continue;
      const s = getOrCreate(r.symbol);
      s.totalOpened++;
      s.avgHoldCycles = (s.avgHoldCycles * (s.totalOpened - 1) + r.holdCycles) / s.totalOpened;
      if (r.mfePct !== undefined) s.avgMfePct = (s.avgMfePct * (s.totalOpened - 1) + r.mfePct) / s.totalOpened;
      if (r.maePct !== undefined) s.avgMaePct = (s.avgMaePct * (s.totalOpened - 1) + r.maePct) / s.totalOpened;
    }

    // 4. v2.0.870-sell-decay: DECAYED persistent stats — the authoritative win/loss
    //    source. Old all-time counts fade exp(-Δt/τ) so WR here reflects the recent
    //    window. This also FIXES the architectural hole where getStats() returned
    //    all zeros when positions/recentResults were drained (gate saw no data).
    //    ATTACK-HARDENING: 值 cap——1e308 污染值會令 wilson NaN / EV Infinity,
    //    gate 被免疫。真實上限: n ≤ ~1e5, |EV| ≤ ~1e4%.
    for (const [key, cell] of this.statsBySymbolSide) {
      const sep = key.indexOf('|');
      if (sep <= 0 || sep === key.length - 1) continue;
      const stats = getOrCreate(key.slice(0, sep));
      const rawWins = Number.isFinite(cell.wins) ? cell.wins : 0;
      const rawLosses = Number.isFinite(cell.losses) ? cell.losses : 0;
      const rawPnl = Number.isFinite(cell.totalPnlPct) ? cell.totalPnlPct : 0;
      const wins = Math.min(Math.max(rawWins, 0), 1e6);
      const losses = Math.min(Math.max(rawLosses, 0), 1e6);
      const sumPnl = Math.abs(rawPnl) > 1e4 ? 0 : rawPnl;
      if (key.slice(sep + 1) === 'buy') {
        stats.longWins = Math.round(wins * 10000) / 10000;
        stats.longLosses = Math.round(losses * 10000) / 10000;
        stats.longSumPnlPct = Math.round(sumPnl * 10000) / 10000;
      } else if (key.slice(sep + 1) === 'sell') {
        stats.shortWins = Math.round(wins * 10000) / 10000;
        stats.shortLosses = Math.round(losses * 10000) / 10000;
        stats.shortSumPnlPct = Math.round(sumPnl * 10000) / 10000;
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
    shadowType: 'blind' | 'aligned' | 'statistical' | 'qrl' | 'seeded';
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
      // v2.0.870-EMR: 持久化累計統計（唔依賴緩衝區）
      statsBySymbolSide: Object.fromEntries(this.statsBySymbolSide),
      // v2.0.870-EMR: backfillDone 持久化——重啟後唔重複 backfill（避免統計 double count）
      backfillDone: this.backfillDone,
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
      // v2.0.870-EMR: 載入持久化累計統計（防污染：只收合法 key/value）
      if (data.statsBySymbolSide && typeof data.statsBySymbolSide === 'object') {
        this.statsBySymbolSide = new Map();
        for (const [k, v] of Object.entries(data.statsBySymbolSide as Record<string, unknown>)) {
          // 攻擊硬化：key 必須係「非空 symbol|buy/sell」——'|buy'、'__proto__|buy'、無 '|' 全部過濾
          if (typeof k !== 'string') continue;
          const sep = k.indexOf('|');
          if (sep <= 0 || sep === k.length - 1) continue; // 空 symbol 或空 side
          const symPart = k.slice(0, sep);
          const sidePart = k.slice(sep + 1);
          if (symPart === '__proto__' || symPart === 'constructor' || symPart === 'prototype') continue;
          if (sidePart !== 'buy' && sidePart !== 'sell') continue;
          const s = v as { wins?: unknown; losses?: unknown; totalPnlPct?: unknown; lastUpdatedTs?: unknown };
          const wins = Number.isFinite(s.wins) ? (s.wins as number) : 0;
          const losses = Number.isFinite(s.losses) ? (s.losses as number) : 0;
          const totalPnlPct = Number.isFinite(s.totalPnlPct) ? (s.totalPnlPct as number) : 0;
          const lastUpdatedTs = Number.isFinite(s.lastUpdatedTs) ? (s.lastUpdatedTs as number) : undefined;
          if (wins >= 0 && losses >= 0) {
            // ATTACK-HARDENING (v2.0.870-sell-decay-attack): 值 cap——1e308 級
            // 污染值會令 wilson NaN / EV Infinity, gate 被免疫。真實上限:
            // n ≤ ~1e5（16k cycles × 每 cycle 幾個 shadow）; EV ≤ ~1e4%。
            const capWins = Math.min(wins, 1e6);
            const capLosses = Math.min(losses, 1e6);
            const capPnl = Math.abs(totalPnlPct) > 1e4 ? 0 : totalPnlPct; // 污染 EV 當 0
            if (lastUpdatedTs === undefined || !Number.isFinite(lastUpdatedTs) || lastUpdatedTs > Date.now() + 300_000) {
              // v2.0.870-sell-decay migration/attack: 舊格式（lifetime 累計,無時間戳）
              // 或未來 ts（凍結攻擊）→ 一次過衰減至「4 個 τ 前」狀態——化石統計唔可以
              // 繼續支配 gate。τ=0 時唔衰減（回滾）。
              const tauH = ShadowTradeEngine.decayTauHours();
              if (tauH > 0) {
                const f = Math.exp(-4); // 4×τ 前
                const legacyKey = `${k.slice(0, sep).toLowerCase()}|${sidePart}`;
                this.statsBySymbolSide.set(legacyKey, { wins: capWins * f, losses: capLosses * f, totalPnlPct: capPnl * f, lastUpdatedTs: Date.now() });
              } else {
                const legacyKey = `${k.slice(0, sep).toLowerCase()}|${sidePart}`;
                this.statsBySymbolSide.set(legacyKey, { wins: capWins, losses: capLosses, totalPnlPct: capPnl, lastUpdatedTs: Date.now() });
              }
            } else {
              // ATTACK-HARDENING: key 細階化（'BTC|buy' → 'btc|buy'）——recordStat
              // 用 normalizeSymbol().toLowerCase(),load 都必須一致,否則 gate 統計 miss。
              const normKey = `${k.slice(0, sep).toLowerCase()}|${sidePart}`;
              this.statsBySymbolSide.set(normKey, { wins: capWins, losses: capLosses, totalPnlPct: capPnl, lastUpdatedTs });
            }
          }
        }
      }
      // v2.0.870-EMR: 載入 backfillDone——重啟後唔重複 backfill
      if (typeof data.backfillDone === 'boolean') {
        this.backfillDone = data.backfillDone;
      }
      log.info(`Shadow trades loaded: ${this.positions.length} open, ${this.recentResults.length} recent results, ${this.statsBySymbolSide.size} stat cells`);
    } catch {
      log.warn('[shadow load] Failed to parse data, starting fresh');
    }
  }
}