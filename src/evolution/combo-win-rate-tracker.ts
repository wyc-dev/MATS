// ─── v2.0.221: Combo Win Rate Tracker ──────────────────────────────
//
// Tracks win rate per (symbol × side × regime) combination — the granularity
// that PatternClusterManager (text-rationale clustering) and OLR (continuous
// feature sigmoid) cannot express. The SKHX investigation revealed:
//
//   SKHX BUY  + mean_reverting = 29% WR  (5W/12L, net -0.107)
//   SKHX SELL + low_volatility = 12% WR  (1W/7L,  net -0.140)
//   SKHX BUY  + any regime @ 16:00      =  0% WR  (0W/6L)
//
// These combinations were invisible to the system because:
// 1. PatternCluster clusters by rationale TEXT similarity, not structural combo
// 2. OLR uses continuous features (volatility, regimeOrdinal) but never
//    discretises into "SKHX BUY mean_reverting" buckets
// 3. AntiPatternTracker only had 3 ingested losses (0 clusters) because 130/138
//    losses had no LLM-generated lesson
//
// This module provides:
//   - trackTrade(symbol, side, regime, outcome, pnl)         → increment combo stats
//   - getComboWR(symbol, side, regime)                      → { wr, count, netPnl, confidence }
//   - getComboBlock(symbol, side?, regime?)                  → formatted text for agent context
//   - checkComboGate(symbol, side, regime)                  → soft conviction penalty
//   - autoGenerateLesson(symbol, side, regime, hour, ...)   → structural lesson text
//
// Production-grade design:
// - Wilson score lower bound for confidence (avoids 0/2 = 0% overreaction)
// - Min 3 samples before a combo is "trusted"
// - Soft filtering only — never hard-blocks (owner directive P1)
// - Combo WR < 25% with n ≥ 5 → conviction penalty 0.50 (was 0.35)
// - Combo WR < 35% with n ≥ 5 → conviction penalty 0.30
// - Persisted to disk (combo-win-rates.json) for restart survival
// - Backward compatible: unknown combos return neutral (no penalty)
//
// Integration:
// - trackTrade() called from feedAdvancedLearning() and close-learning path
// - getComboBlock() injected into marketDesc (Meta-Agent sees it pre-cycle)
// - checkComboGate() called alongside checkConditionalWRGate() in agent gate
// - autoGenerateLesson() feeds AntiPatternTracker when LLM lesson is missing

import { wilsonScore } from './evolution-utils.ts';

export interface ComboKey {
  symbol: string;       // normalized: lowercase prefix, e.g. "xyz:skhx"
  side: 'buy' | 'sell';
  regime: string;       // e.g. "mean_reverting", "low_volatility"
}

export interface ComboStats {
  wins: number;
  losses: number;
  netPnl: number;
  // Running sum of PnL % for avg computation
  pnlPctSum: number;
  // Last-updated cycle (for staleness detection)
  lastCycle: number;
}

export interface ComboWRResult {
  wr: number;           // raw win rate (wins / total)
  count: number;        // total trades in this combo
  wilsonLB: number;     // Wilson score lower bound (confidence-adjusted)
  netPnl: number;
  avgPnlPct: number;
  confidence: 'none' | 'low' | 'medium' | 'high';
}

export interface ComboGateResult {
  blocked: boolean;     // always false — soft filter only
  convictionPenalty: number;
  reason: string;
  comboWR: number;
  comboCount: number;
}

interface PersistShape {
  combos: Record<string, ComboStats>;
  ingestedIds: string[];
  savedAt: number;
}

/** v2.0.221 Fix: Sanitize numeric inputs — NaN/Infinity poison downstream stats. */
function safeNum(val: number, fallback: number): number {
  if (val === undefined || val === null || !Number.isFinite(val)) return fallback;
  return val;
}

const MIN_SAMPLES = 3;       // Below this → confidence='none', no penalty
const HIGH_CONF_SAMPLES = 8; // Above this → confidence='high'
const SEVERE_WR = 0.25;       // WR below this with enough samples → 0.50 penalty
const MODERATE_WR = 0.35;    // WR below this with enough samples → 0.30 penalty
const MILD_WR = 0.45;        // WR below this with enough samples → 0.15 penalty

function comboKeyToString(symbol: string, side: string, regime: string): string {
  return `${symbol}|${side}|${regime}`;
}

export class ComboWinRateTracker {
  private combos = new Map<string, ComboStats>();
  /** v2.0.221 Fix (attack-fix): Dedup set — prevents double-counting when
   *  close-learning + backfill both call trackTrade for the same trade. */
  private ingestedIds = new Set<string>();
  private dirty = false;
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = `${dataDir}/evolution/combo-win-rates.json`;
  }

  // ─── Core tracking ─────────────────────────────────────────────

  /**
   * Record a trade outcome for a (symbol, side, regime) combination.
   * Idempotent per trade ID — duplicate calls for the same tradeId are ignored.
   * v2.0.221 attack-fix: Sanitizes NaN/Infinity PnL to prevent poisoning.
   */
  trackTrade(
    symbol: string,
    side: 'buy' | 'sell',
    regime: string,
    outcome: 'WIN' | 'LOSS',
    pnl: number,
    pnlPct: number,
    cycle: number,
    tradeId?: string, // v2.0.221 attack-fix: dedup
  ): void {
    // Dedup: if tradeId provided and already ingested, skip.
    if (tradeId && this.ingestedIds.has(tradeId)) return;
    if (tradeId) this.ingestedIds.add(tradeId);
    // Sanitize inputs (attack-fix: NaN/Infinity guard)
    const safePnl = safeNum(pnl, 0);
    const safePnlPct = safeNum(pnlPct, 0);
    const sym = symbol.toLowerCase();
    const key = comboKeyToString(sym, side, regime || 'unknown');
    let stats = this.combos.get(key);
    if (!stats) {
      stats = { wins: 0, losses: 0, netPnl: 0, pnlPctSum: 0, lastCycle: cycle };
      this.combos.set(key, stats);
    }
    if (outcome === 'WIN') stats.wins++;
    else stats.losses++;
    stats.netPnl += safePnl;
    stats.pnlPctSum += safePnlPct;
    stats.lastCycle = cycle;
    this.dirty = true;
  }

  /**
   * Get win rate for a specific combo. Returns neutral when combo is unknown
   * or has insufficient samples.
   */
  getComboWR(symbol: string, side: 'buy' | 'sell', regime: string): ComboWRResult {
    const sym = symbol.toLowerCase();
    const key = comboKeyToString(sym, side, regime || 'unknown');
    const stats = this.combos.get(key);
    if (!stats || stats.wins + stats.losses === 0) {
      return { wr: 0.5, count: 0, wilsonLB: 0.5, netPnl: 0, avgPnlPct: 0, confidence: 'none' };
    }
    const total = stats.wins + stats.losses;
    const wr = stats.wins / total;
    const wilsonLB = wilsonScore(stats.wins, total);
    const confidence: ComboWRResult['confidence'] =
      total >= HIGH_CONF_SAMPLES ? 'high' :
      total >= MIN_SAMPLES ? 'medium' : 'low';
    return {
      wr,
      count: total,
      wilsonLB,
      netPnl: stats.netPnl,
      avgPnlPct: total > 0 ? stats.pnlPctSum / total : 0,
      confidence,
    };
  }

  /**
   * Get ALL combos for a given symbol (all sides, all regimes).
   * Used for the pattern block injected into agent context.
   */
  getCombosForSymbol(symbol: string): { side: 'buy' | 'sell'; regime: string; result: ComboWRResult }[] {
    const sym = symbol.toLowerCase();
    const results: { side: 'buy' | 'sell'; regime: string; result: ComboWRResult }[] = [];
    for (const [key, stats] of this.combos) {
      const parts = key.split('|');
      const kSym = parts[0] ?? '';
      const kSide = parts[1] ?? 'buy';
      const kRegime = parts[2] ?? 'unknown';
      if (kSym !== sym) continue;
      const total = stats.wins + stats.losses;
      if (total === 0) continue;
      results.push({
        side: kSide as 'buy' | 'sell',
        regime: kRegime,
        result: this.getComboWR(symbol, kSide as 'buy' | 'sell', kRegime),
      });
    }
    // Sort by count descending (most-sampled first)
    results.sort((a, b) => b.result.count - a.result.count);
    return results;
  }

  // ─── Agent context formatting ──────────────────────────────────

  /**
   * Format a text block showing combo WR for the active symbol + optional
   * side/regime filter. Injected into marketDesc so Meta-Agent sees it BEFORE
   * generating a thesis. This is the key fix: Meta-Agent now sees "SKHX BUY
   * mean_reverting = 29% WR (5W/12L)" explicitly, not buried in a text cluster.
   *
   * Example output:
   * === COMBO WIN RATES for xyz:skhx (from 52 trades) ===
   * 🔴 BUY  mean_reverting   W5  L12  (29% WR, Wilson 21%, net -0.107) — AVOID
   * 🔴 SELL low_volatility   W1  L7   (12% WR, Wilson 9%,  net -0.140) — AVOID
   * 🟡 BUY  low_volatility   W4  L5   (44% WR, Wilson 26%, net +0.013)
   * 🟢 BUY  trending_bull    W3  L1   (75% WR, Wilson 45%, net +0.386)
   * ---
   * Interpretation: Combos marked 🔴 AVOID have statistically significant losing
   * patterns. If your thesis matches a 🔴 combo, you need very strong conviction
   * or a different setup. Combos with < 3 trades are not shown.
   */
  getComboBlock(symbol: string, filterSide?: 'buy' | 'sell', filterRegime?: string): string {
    const combos = this.getCombosForSymbol(symbol);
    if (combos.length === 0) return '';

    let filtered = combos;
    if (filterSide) filtered = filtered.filter(c => c.side === filterSide);
    if (filterRegime) filtered = filtered.filter(c => c.regime === filterRegime);

    const display = filtered.filter(c => c.result.count >= MIN_SAMPLES);
    if (display.length === 0) return '';

    const lines: string[] = [];
    const totalCount = combos.reduce((s, c) => s + c.result.count, 0);
    lines.push(`=== COMBO WIN RATES for ${symbol} (from ${totalCount} trades) ===`);

    for (const c of display) {
      const r = c.result;
      const icon = r.wilsonLB >= 0.55 ? '🟢' : r.wilsonLB <= 0.35 ? '🔴' : '🟡';
      const pnlStr = r.netPnl >= 0 ? `+${r.netPnl.toFixed(3)}` : r.netPnl.toFixed(3);
      const avoidTag = r.wilsonLB <= 0.30 && r.confidence !== 'low' ? ' — AVOID' : '';
      const confTag = r.confidence === 'high' ? '★' : r.confidence === 'medium' ? '' : '?';
      lines.push(
        `${icon} ${c.side.toUpperCase().padEnd(4)} ${c.regime.padEnd(18)} W${(r.count * r.wr).toFixed(0)}  L${(r.count * (1 - r.wr)).toFixed(0)}  ` +
        `(${(r.wr * 100).toFixed(0)}% WR, Wilson ${(r.wilsonLB * 100).toFixed(0)}%, net ${pnlStr})${avoidTag}${confTag}`,
      );
    }
    lines.push('---');
    lines.push('Interpretation: 🔴 AVOID combos have statistically significant losing patterns (Wilson LB ≤30%).');
    lines.push('If your thesis matches a 🔴 combo, you need very strong conviction or a different setup.');
    return lines.join('\n');
  }

  // ─── Soft gate (conviction penalty) ────────────────────────────

  /**
   * Check if a (symbol, side, regime) combo has a historically losing pattern
   * and return a soft conviction penalty. NEVER blocks — only increases the
   * conviction threshold required for the agent to act (owner directive P1).
   *
   * Penalty tiers (production-calibrated):
   *   WR < 25% & n ≥ 5  → 0.50  (was 0.35 — the SKHX investigation showed 0.35
   *                                 was insufficient: SKHX SELL low_vol at 12%
   *                                 WR still passed the 60% consensus gate)
   *   WR < 35% & n ≥ 5  → 0.30
   *   WR < 45% & n ≥ 5  → 0.15
   *   n < 5             → no penalty (insufficient data, avoid overreaction)
   *
   * Uses Wilson lower bound to avoid 0/2 = 0% overreaction.
   */
  checkComboGate(symbol: string, side: 'buy' | 'sell', regime: string): ComboGateResult {
    const r = this.getComboWR(symbol, side, regime);
    if (r.count < MIN_SAMPLES || r.confidence === 'none') {
      return { blocked: false, convictionPenalty: 0, reason: '', comboWR: r.wr, comboCount: r.count };
    }
    // Use Wilson LB for gate decision (more conservative than raw WR)
    const lb = r.wilsonLB;
    if (lb < 0.30 && r.count >= 5) {
      return {
        blocked: false,
        convictionPenalty: 0.50,
        reason: `Combo ${side.toUpperCase()} ${symbol} ${regime}: ${(r.wr * 100).toFixed(0)}% WR (Wilson LB ${(lb * 100).toFixed(0)}%, n=${r.count}, net ${r.netPnl.toFixed(3)}) — this combo loses ${((1 - r.wr) * 100).toFixed(0)}% of the time. Conviction +50% (extremely strong signal required, NOT blocked).`,
        comboWR: r.wr,
        comboCount: r.count,
      };
    }
    if (lb < 0.40 && r.count >= 5) {
      return {
        blocked: false,
        convictionPenalty: 0.30,
        reason: `Combo ${side.toUpperCase()} ${symbol} ${regime}: ${(r.wr * 100).toFixed(0)}% WR (Wilson LB ${(lb * 100).toFixed(0)}%, n=${r.count}) — losing pattern. Conviction +30%.`,
        comboWR: r.wr,
        comboCount: r.count,
      };
    }
    if (lb < 0.48 && r.count >= 5) {
      return {
        blocked: false,
        convictionPenalty: 0.15,
        reason: `Combo ${side.toUpperCase()} ${symbol} ${regime}: ${(r.wr * 100).toFixed(0)}% WR (Wilson LB ${(lb * 100).toFixed(0)}%, n=${r.count}) — slightly unfavourable. Conviction +15%.`,
        comboWR: r.wr,
        comboCount: r.count,
      };
    }
    return { blocked: false, convictionPenalty: 0, reason: '', comboWR: r.wr, comboCount: r.count };
  }

  // ─── Structural lesson auto-generation ────────────────────────

  /**
   * Auto-generate a structural lesson for a loss that has no LLM-generated
   * lesson. This feeds the AntiPatternTracker so it can cluster ALL losses
   * (not just the ~6% that have LLM lessons). The structural lesson encodes
   * the trade's key features in a consistent, embeddable format:
   *
   *   "SKHX BUY in mean_reverting regime, held 42min, closed by SL —
   *    structural failure: low-vol mean-reversion BUY with tight SL at 15:00"
   *
   * This is deterministic and requires no LLM call — cold-start safe.
   */
  static autoGenerateLesson(params: {
    symbol: string;
    side: 'buy' | 'sell';
    regime: string;
    holdMin: number;
    closeReason: string | null;
    pnlPct: number;
    hourOfDay?: number;
  }): string {
    const { symbol, side, regime, holdMin, closeReason, pnlPct, hourOfDay } = params;
    const symShort = symbol.includes(':') ? symbol.split(':')[1]! : symbol;
    const parts: string[] = [];
    parts.push(`${symShort} ${side.toUpperCase()} in ${regime} regime`);
    if (hourOfDay !== undefined) {
      parts.push(`at ${hourOfDay}:00`);
    }
    parts.push(`held ${Math.round(holdMin)}min`);
    if (closeReason) {
      parts.push(`closed by ${closeReason}`);
    }
    const pnlStr = pnlPct >= 0 ? `+${(pnlPct * 100).toFixed(2)}%` : `${(pnlPct * 100).toFixed(2)}%`;
    parts.push(`${pnlStr} PnL`);
    const structural = `structural failure: ${regime} ${side.toUpperCase()} held ${Math.round(holdMin)}min`;
    return `${parts.join(', ')} — ${structural}`;
  }

  // ─── Persistence ───────────────────────────────────────────────

  isDirty(): boolean { return this.dirty; }

  save(): string {
    const obj: PersistShape = {
      combos: Object.fromEntries(this.combos),
      ingestedIds: [...this.ingestedIds],
      savedAt: Date.now(),
    };
    this.dirty = false;
    return JSON.stringify(obj);
  }

  load(json: string): void {
    try {
      const obj = JSON.parse(json) as PersistShape;
      if (obj && obj.combos) {
        this.combos = new Map(Object.entries(obj.combos));
      }
      if (obj && obj.ingestedIds) {
        this.ingestedIds = new Set(obj.ingestedIds);
      }
    } catch {
      // cold start — empty
    }
  }

  getFilePath(): string { return this.filePath; }

  /** Total combos tracked (for UI / stats) */
  getComboCount(): number { return this.combos.size; }

  /** Total trades tracked across all combos (for UI) */
  getTotalTrades(): number {
    let total = 0;
    for (const stats of this.combos.values()) {
      total += stats.wins + stats.losses;
    }
    return total;
  }

  /** Get all stats for UI display */
  getStats(): { comboCount: number; totalTrades: number; worstCombos: { symbol: string; side: string; regime: string; wr: number; count: number; netPnl: number }[] } {
    const all: { symbol: string; side: string; regime: string; wr: number; count: number; netPnl: number }[] = [];
    for (const [key, stats] of this.combos) {
      const parts = key.split('|');
      const sym = parts[0] ?? '';
      const side = parts[1] ?? 'buy';
      const regime = parts[2] ?? 'unknown';
      const total = stats.wins + stats.losses;
      if (total < MIN_SAMPLES) continue;
      all.push({
        symbol: sym,
        side,
        regime,
        wr: total > 0 ? stats.wins / total : 0,
        count: total,
        netPnl: stats.netPnl,
      });
    }
    // Worst combos by Wilson LB (ascending)
    all.sort((a, b) => (a.wr) - (b.wr));
    return {
      comboCount: this.combos.size,
      totalTrades: this.getTotalTrades(),
      worstCombos: all.slice(0, 10),
    };
  }
}