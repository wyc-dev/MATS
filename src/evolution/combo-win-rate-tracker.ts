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
  // v2.0.862 (方案 A): per-trade pnlPct ring buffer (cap 50) — computes the
  // MEDIAN (distribution centre). avg is skewed by outliers; median is the
  // robust centre. A combo with median<0 but avg>0 is a SKEW trap (top-N
  // winners carrying the EV) — fragile, must not be treated as a real edge.
  pnlPcts?: number[];
  // v2.0.862 (方案 D): time-decayed EWMA of pnlPct (half-life 500 cycles ≈
  // 2 days at 5min/cycle). Edge rotates with regime; old trades must fade
  // instead of weighting equally forever. ewmaLastCycle = last update cycle.
  ewmaPnlPct?: number;
  ewmaLastCycle?: number;
}

export interface ComboWRResult {
  wr: number;           // raw win rate (wins / total)
  count: number;        // total trades in this combo
  wilsonLB: number;     // Wilson score lower bound (confidence-adjusted)
  netPnl: number;
  avgPnlPct: number;
  confidence: 'none' | 'low' | 'medium' | 'high';
  /** v2.0.862 (方案 A): median per-trade pnlPct — robust EV centre. */
  medianPnlPct: number;
  /** v2.0.862 (方案 D): time-decayed EWMA pnlPct — recent trades weighted more. */
  ewmaPnlPct: number;
  /** v2.0.870-P16-attack2 (F3): 最後更新 cycle——bypass 新鮮度檢查用
   *  (EWMA 只喺 write 時衰減,休眠 combo 嘅陳舊強 edge 唔應該喺新 regime 豁免)。 */
  lastCycle: number;
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
/** v2.0.870-P16-attack2 (F1): load 嗰時 wins/losses 嘅整數上限——
 *  真實 combo 歷史最多幾百至幾千 trades;超大值 = 通脹注入。 */
const MAX_COMBO_SAMPLES = 50000;

/** 將持久化嘅 wins/losses 矯正為 finite 非負整數(污染 → 0) */
function sanitizeComboCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(MAX_COMBO_SAMPLES, Math.max(0, Math.floor(v)))
    : 0;
}
const HIGH_CONF_SAMPLES = 8; // Above this → confidence='high'
const SEVERE_WR = 0.25;       // WR below this with enough samples → 0.50 penalty
const MODERATE_WR = 0.35;    // WR below this with enough samples → 0.30 penalty
const MILD_WR = 0.45;        // WR below this with enough samples → 0.15 penalty

// v2.0.862 (方案 A+D): median ring cap + EWMA half-life
const MEDIAN_RING_CAP = 50;        // per-combo pnlPct buffer (median sample size)
const EWMA_HALF_LIFE_CYCLES = 120; // 主神裁決: 10 個鐘衰減（5min/cycle）——短炒用（原 500 ≈ 2 日太慢）

// ── v2.0.819: WINNER-FIRST combo blend factor ───────────────────────────
// Stricter than the penalty tiers: a combo may only OVERRIDE the OLR P(win)
// multiplicative discount when the evidence is overwhelming. This implements
// the owner's WINNER-FIRST directive (“先搵贏嘅 pattern … NEVER hard block …
// Profit maximization is #1 priority”) inside the Plan G conviction gate.
//   pwinBlendFactor = max(olrBlendFactor, comboBlendFactor)
// so a statistically strong winner lifts the blend floor even when OLR
// (trained mostly on stale paper data) reports a low P(win).
const BOOST_MIN_SAMPLES = 20;   // need solid evidence to override OLR
const BOOST_WILSON_LB = 0.55;   // Wilson 95% LB ≥ 55% = confident winner
const PWIN_FLOOR = 0.3;          // mirror DTC pwinFloor (never kills completely)

/** v2.0.819: Result of the WINNER-FIRST combo blend lookup. */
export interface ComboBlendResult {
  /** pwinFloor + (1 - pwinFloor) × wilsonLB — drop-in replacement for the
   *  OLR pwinBlendFactor when it is higher. */
  blendFactor: number;
  wr: number;
  wilsonLB: number;
  count: number;
  netPnl: number;
  reason: string;
}

/** v2.0.862 (方案 A): median of an array — robust distribution centre.
 *  Empty → 0; single → that value. Pure, testable.
 *  v2.0.862-ev-attack (V1): non-array (poisoned load) → 0, never crash. */
function medianOf(values: number[] | unknown): number {
  if (!Array.isArray(values)) return 0;
  const clean = (values as number[]).filter(v => Number.isFinite(v));
  if (clean.length === 0) return 0;
  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

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

    // v2.0.862 (方案 A): pnlPct ring buffer → median (robust EV centre).
    stats.pnlPcts = stats.pnlPcts ?? [];
    stats.pnlPcts.push(safePnlPct);
    if (stats.pnlPcts.length > MEDIAN_RING_CAP) stats.pnlPcts.shift();

    // v2.0.862 (方案 D): time-decayed EWMA — old trades fade (half-life 500
    // cycles ≈ 2 days at 5min/cycle). First sample seeds the EWMA directly.
    // v2.0.862-ev-attack (V3/V4): guard every input — NaN cycle / poisoned
    // ewma fields would produce NaN EWMA. Non-finite → treat as first sample.
    const safeCycle = Number.isFinite(cycle) ? cycle : (stats.ewmaLastCycle ?? 0);
    const firstOrPoisoned = !Number.isFinite(stats.ewmaPnlPct) || !Number.isFinite(stats.ewmaLastCycle);
    if (firstOrPoisoned) {
      stats.ewmaPnlPct = safePnlPct;
    } else {
      const delta = Math.max(0, safeCycle - (stats.ewmaLastCycle ?? safeCycle));
      // 主神裁決: half-life 120 cycles（10 個鐘）——真 half-life 公式
      // decay = 0.5^(delta/120) = exp(-delta×ln2/120)——120 cycles 後舊樣本影響 50%
      // （舊 code 用 exp(-delta/120) 係 e-folding——120 cycles 後影響 36.8%——唔係 half-life）
      const decay = Math.exp(-delta * Math.LN2 / EWMA_HALF_LIFE_CYCLES);
      stats.ewmaPnlPct = (stats.ewmaPnlPct ?? 0) * decay + safePnlPct * (1 - decay);
    }
    stats.ewmaLastCycle = safeCycle;
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
      return { wr: 0.5, count: 0, wilsonLB: 0.5, netPnl: 0, avgPnlPct: 0, confidence: 'none', medianPnlPct: 0, ewmaPnlPct: 0, lastCycle: 0 };
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
      // v2.0.862 (方案 A+D): median (robust centre) + time-decayed EWMA
      medianPnlPct: medianOf(stats.pnlPcts ?? []),
      ewmaPnlPct: Number.isFinite(stats.ewmaPnlPct) ? (stats.ewmaPnlPct ?? 0) : 0,
      // v2.0.870-P16-attack2 (F3): 暴露 lastCycle 畀 bypass 新鮮度檢查
      lastCycle: Number.isFinite(stats.lastCycle) ? stats.lastCycle : 0,
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
    // 主神指示: avgEwmaPnlPct（avgPnlPct 同 ewmaPnlPct 整合）——正 → 唔降權、負 → 降權。
    // 量化金融: avgPnlPct 反映整體（等權——被舊數據污染）；ewmaPnlPct 反映最近
    // （時間衰減 half-life 120 cycles ≈ 10 個鐘——短炒用）。整合 = 0.5/0.5——
    // 兩者平衡——「整體正但最近轉負」（btc|buy avg +0.94% ewma -8.31%）→ 降權（最近市場轉負）；
    // 「整體負但最近轉正」（cl|sell avg -2.92% ewma +0.00%）→ 唔降權（最近市場轉正）。
    // 舊邏輯用 Wilson LB（WR 下界）——誤傷 7 個「低 WR 高回報」組合（實驗 A 確認）。
    // A2: 拒絕污染值——avg/ewma 超出合理範圍（±100%）→ 當冇數據（fallback 另一指標）。
    // 1e308 污染值唔應該令 avgEwma 極正/極負（誤降權/誤加權）——clamp 唔夠（-100% 仍然極端）。
    const avgPnl = Number.isFinite(r.avgPnlPct) && Math.abs(r.avgPnlPct) <= 1 ? r.avgPnlPct : undefined;
    const ewmaPnl = Number.isFinite(r.ewmaPnlPct) && Math.abs(r.ewmaPnlPct) <= 1 ? r.ewmaPnlPct : undefined;
    // 整合——兩者都有 → 0.5/0.5；一個污染 → 用另一個；兩個都污染 → 0（中性）
    const avgEwmaPnlPct = avgPnl !== undefined && ewmaPnl !== undefined
      ? 0.5 * avgPnl + 0.5 * ewmaPnl
      : avgPnl !== undefined ? avgPnl
      : ewmaPnl !== undefined ? ewmaPnl
      : 0;
    if (avgEwmaPnlPct < -0.005 && r.count >= 5) {
      return {
        blocked: false,
        convictionPenalty: 0.50,
        reason: `Combo ${side.toUpperCase()} ${symbol} ${regime}: avgEwmaPnl ${(avgEwmaPnlPct * 100).toFixed(2)}% (avg ${((avgPnl ?? 0) * 100).toFixed(2)}% / ewma ${((ewmaPnl ?? 0) * 100).toFixed(2)}%, n=${r.count}, WR ${(r.wr * 100).toFixed(0)}%) — 負期望值（最近市場轉負）。Conviction +50% (extremely strong signal required, NOT blocked).`,
        comboWR: r.wr,
        comboCount: r.count,
      };
    }
    if (avgEwmaPnlPct < -0.002 && r.count >= 5) {
      return {
        blocked: false,
        convictionPenalty: 0.30,
        reason: `Combo ${side.toUpperCase()} ${symbol} ${regime}: avgEwmaPnl ${(avgEwmaPnlPct * 100).toFixed(2)}% (avg ${((avgPnl ?? 0) * 100).toFixed(2)}% / ewma ${((ewmaPnl ?? 0) * 100).toFixed(2)}%, n=${r.count}, WR ${(r.wr * 100).toFixed(0)}%) — 負期望值。Conviction +30%.`,
        comboWR: r.wr,
        comboCount: r.count,
      };
    }
    if (avgEwmaPnlPct < 0 && r.count >= 5) {
      return {
        blocked: false,
        convictionPenalty: 0.15,
        reason: `Combo ${side.toUpperCase()} ${symbol} ${regime}: avgEwmaPnl ${(avgEwmaPnlPct * 100).toFixed(2)}% (avg ${((avgPnl ?? 0) * 100).toFixed(2)}% / ewma ${((ewmaPnl ?? 0) * 100).toFixed(2)}%, n=${r.count}, WR ${(r.wr * 100).toFixed(0)}%) — 輕微負期望值。Conviction +15%.`,
        comboWR: r.wr,
        comboCount: r.count,
      };
    }
    return { blocked: false, convictionPenalty: 0, reason: '', comboWR: r.wr, comboCount: r.count };
  }

  // ── WINNER-FIRST blend factor (v2.0.819) ───────────────────────────

  /**
   * v2.0.819: WINNER-FIRST — return a combo-derived blend factor that can
   * OVERRIDE the OLR P(win) multiplicative discount in the Plan G conviction
   * gate. The owner directive states: “先搵贏嘅 pattern，搵唔到贏嘅先至考慮
   * 會唔會輸 … NEVER hard block … Profit maximization is #1 priority.”
   *
   * Before this fix, the combo WR tracker could only PENALISE losers
   * (convictionPenalty > 0 → penaltyFactor < 1). It could never BOOST a
   * winner. Meanwhile OLR P(win) (trained mostly on 15,532 stale paper
   * samples) held a unilateral multiplicative veto: P(win)=13% → blendFactor
   * 0.39 → even 100% consensus < 45% threshold → permanent HOLD. BTC sat
   * untraded for 4 days despite a 77% WR (556W/164L, +$375) buy/low_vol
   * combo because the winner signal was mathematically unable to override
   * the OLR veto.
   *
   * This method returns a blend factor built from the combo's Wilson 95%
   * lower bound, usable as `pwinBlendFactor = max(olrBlend, comboBlend)`.
   * Stricter gates than the penalty path (n ≥ 20, Wilson LB ≥ 0.55) ensure
   * only statistically confident winners can override OLR — a 3/4 combo
   * cannot.
   *
   * Returns null when the combo is unknown, has insufficient samples, or is
   * not a confident winner — leaving the OLR blend factor untouched.
   */
  getComboBlendFactor(symbol: string, side: 'buy' | 'sell', regime: string): ComboBlendResult | null {
    const r = this.getComboWR(symbol, side, regime);
    // Need solid evidence — small samples must NOT override the OLR model.
    if (r.count < BOOST_MIN_SAMPLES) return null;
    // Wilson 95% lower bound is the conservative bar (accounts for sample
    // size — 556/720 → LB ~0.77, while 6/8 → LB ~0.40 even at 75% raw WR).
    if (r.wilsonLB < BOOST_WILSON_LB) return null;
    // Only trust medium/high confidence buckets (excludes the 'low' bucket).
    if (r.confidence === 'none' || r.confidence === 'low') return null;
    const blendFactor = PWIN_FLOOR + (1 - PWIN_FLOOR) * r.wilsonLB;
    return {
      blendFactor,
      wr: r.wr,
      wilsonLB: r.wilsonLB,
      count: r.count,
      netPnl: r.netPnl,
      reason: `WINNER-FIRST combo: ${side.toUpperCase()} ${symbol} ${regime} = ${(r.wr * 100).toFixed(0)}% WR (Wilson LB ${(r.wilsonLB * 100).toFixed(0)}%, n=${r.count}, net ${r.netPnl >= 0 ? '+' : ''}${r.netPnl.toFixed(2)}) → blendFactor ${blendFactor.toFixed(3)} overrides OLR`,
    };
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
        const cleaned = new Map<string, ComboStats>();
        for (const [key, raw] of Object.entries(obj.combos)) {
          const st = raw as ComboStats;
          // v2.0.862-ev-attack (V1/V2/V3): sanitize new fields on load —
          // pnlPcts must be a bounded array of finite numbers; ewma fields
          // must be finite (or cleared so the next trade seeds fresh).
          if (Array.isArray(st.pnlPcts)) {
            st.pnlPcts = st.pnlPcts
              .filter(v => typeof v === 'number' && Number.isFinite(v))
              .slice(-MEDIAN_RING_CAP);
          } else {
            st.pnlPcts = undefined;
          }
          if (!Number.isFinite(st.ewmaPnlPct)) st.ewmaPnlPct = undefined;
          if (!Number.isFinite(st.ewmaLastCycle)) st.ewmaLastCycle = undefined;
          // v2.0.870-P16-attack2 (F1): wins/losses/netPnl/pnlPctSum/lastCycle
          // sanitize——持久化污染(1e999→Infinity、負數、小數、字串)曾令
          // wilsonLB=NaN / count=Infinity;更嚴重嘅係通脹 wins 直接買到 P16
          // edge hard-bypass(完全豁免所有 penalty)。全部矯正為
          // finite 非負整數,cap MAX_COMBO_SAMPLES;無效 entry → drop。
          st.wins = sanitizeComboCount(st.wins);
          st.losses = sanitizeComboCount(st.losses);
          st.netPnl = Number.isFinite(st.netPnl) ? st.netPnl : 0;
          st.pnlPctSum = Number.isFinite(st.pnlPctSum) ? st.pnlPctSum : 0;
          st.lastCycle = Number.isFinite(st.lastCycle) ? Math.max(0, Math.floor(st.lastCycle)) : 0;
          if (st.wins + st.losses === 0) continue;
          cleaned.set(key, st);
        }
        this.combos = cleaned;
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