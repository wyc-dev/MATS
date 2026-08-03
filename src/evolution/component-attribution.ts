// ─── Component Attribution Store (v2.0.844) ──────────────────────────
//
// PURPOSE
//   Give MATS the ability to answer "which learning component actually
//   adds edge?" — the single biggest blind spot of a 15+ component stack.
//   Each component's decision-time signal is recorded against the eventual
//   trade outcome, so per-component expectancy / contribution / cleanliness
//   can be computed. Without attribution, adding any new component is a
//   bet; with it, we know whether to invest in or prune each one.
//
// DESIGN
//   Append-only store (never mutates decisions). Each record is one
//   (component × trade) observation:
//     contribution = signal × sign(pnlPct)   // proxy credit assignment
//     standaloneExpectancy = signal-aligned PnL proxy
//     labelCleanliness  = how much the outcome label was polluted by
//                         premature / tight-SL / thesis distortion
//
//   Proxy credit assignment is deliberately simple: a component's
//   directional signal (0..1) that agrees with the final outcome earns
//   positive contribution. Full Shapley-style credit assignment is
//   intractable at this scale and unnecessary for pruning decisions.
//
//   Cold-start safe: components with < MIN_SAMPLES return neutral stats
//   (expectancy 0, contribution 0) so nothing is pruned prematurely.
//
// SAFETY
//   - Pure append: writeOnce semantics; a tradeId+componentId is idempotent
//   - Bounded: ring buffer capped at MAX_RECORDS (rolling eviction)
//   - Never blocks the trading cycle (synchronous, no I/O; persistence is
//     delegated to the caller's atomic save, matching codebase conventions)
//   - All numeric guards via Number.isFinite

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'component-attribution' });

// ─── Types ───

export type ComponentId =
  | 'olr'
  | 'shadow'
  | 'first-passage'
  | 'attnres'
  | 'combo-wr'
  | 'causal-uplift'
  | 'meta-calibrator'
  | 'self-improver'
  | 'meta-learner'
  | 'q-rl'
  | 'llm-debate'
  | 'edge-report'
  | 'other';

export interface ComponentAttribution {
  componentId: ComponentId;
  tradeId: string;
  symbol: string;
  side: 'buy' | 'sell';
  cycleId: number;
  /** Directional signal the component emitted at decision time in [0,1].
   *  0.5 = neutral, > 0.5 = bullish, < 0.5 = bearish (for a 'buy' decision).
   *  For 'sell', the signal is inverted so 1.0 always means "agrees with trade". */
  signal: number;
  /** Normalised agreement of signal with the actual trade direction in [0,1]. */
  agreement: number;
  /** PnL % of the resolved trade (used for standalone expectancy). */
  pnlPct: number;
  /** Proxy contribution in [-1, 1] = (agreement - 0.5) * 2 * sign(pnlPct). */
  contribution: number;
  /** Label cleanliness in [0,1]. 1.0 = clean, < 1.0 = polluted by close context. */
  labelCleanliness: number;
  /** Current regime at decision time (for per-regime attribution). */
  regime: string;
  /** Risk profile active at decision time (aggressive/moderate/conservative). */
  riskProfile: string;
  timestamp: number;
}

export interface ComponentStats {
  componentId: ComponentId;
  samples: number;
  /** Mean PnL% across trades where this component emitted a confident signal. */
  expectancy: number;
  /** Mean contribution in [-1, 1]. > 0 = net positive edge. */
  contribution: number;
  /** Fraction of trades where contribution > 0. */
  positiveRate: number;
  /** Mean label cleanliness in [0,1]. */
  cleanliness: number;
  /** Per-regime breakdown for this component. */
  byRegime: Array<{ regime: string; expectancy: number; samples: number }>;
}

// ─── Constants ───

const MAX_RECORDS = 10_000;         // matches sample-cap lift (edgeConfig)
const MIN_SAMPLES = 10;             // below this → neutral stats (cold-start safe)
const CONFIDENT_SIGNAL = 0.6;       // |agreement| threshold for "confident signal"

// ─── Component Attribution Store ───

export class ComponentAttributionStore {
  private records: ComponentAttribution[] = [];
  /** Idempotency guard: key = `${tradeId}|${componentId}`. */
  private seenKeys: Set<string> = new Set();

  /**
   * Record one component's contribution to a resolved trade.
   * Idempotent per (tradeId, componentId) — a double-close path cannot
   * double-count the same component for the same trade.
   *
   * @param input  Attribution data for one (component × trade) observation.
   *               `signal` is expected in raw directional space: for 'buy',
   *               0.5 = neutral, >0.5 bullish; for 'sell' it is inverted
   *               automatically so 1.0 always means "agrees with the trade".
   */
  recordAttribution(input: Omit<ComponentAttribution, 'contribution' | 'agreement'>): void {
    // Numeric guards — never let NaN poison the store.
    if (!Number.isFinite(input.signal) || !Number.isFinite(input.pnlPct)) return;
    if (!Number.isFinite(input.labelCleanliness)) input.labelCleanliness = 1.0;
    if (typeof input.tradeId !== 'string' || input.tradeId.length === 0) return;
    if (typeof input.componentId !== 'string' || input.componentId.length === 0) return;
    // v2.0.845: Guard against undefined/null symbol from legacy/corrupt records.
    // normalizeSymbol() would crash on undefined; here we sanitize to '' so
    // per-symbol lookups are safe ('' never matches a real symbol).
    if (typeof input.symbol !== 'string') input.symbol = '';
    if (typeof input.regime !== 'string' || input.regime.length === 0) input.regime = 'unknown';

    // Clamp signal to [0,1] — a malformed 2.5 would otherwise skew stats.
    const signal = Math.max(0, Math.min(1, input.signal));

    // Invert for 'sell' so agreement ∈ [0,1] always means "agrees with trade".
    // buy:  signal 1.0 = max agree with buy.  sell: signal 0.0 = max agree with sell.
    const agreement = input.side === 'sell' ? 1 - signal : signal;

    // Proxy contribution: positive when the component's direction agreed with
    // the outcome's sign (i.e. the component was "right").
    const pnlSign = Math.sign(input.pnlPct);
    const contribution = (agreement - 0.5) * 2 * pnlSign; // [-1, 1]

    // Idempotency: same (tradeId, componentId) recorded twice → skip second.
    const key = `${input.tradeId}|${input.componentId}`;
    if (this.seenKeys.has(key)) return;
    this.seenKeys.add(key);

    this.records.push({
      componentId: input.componentId,
      tradeId: input.tradeId,
      symbol: input.symbol,
      side: input.side,
      cycleId: input.cycleId,
      signal,
      agreement,
      pnlPct: input.pnlPct,
      contribution,
      labelCleanliness: Math.max(0, Math.min(1, input.labelCleanliness)),
      regime: input.regime,
      riskProfile: input.riskProfile,
      timestamp: input.timestamp,
    });

    // Rolling cap — keep most recent (matches ring-buffer pattern elsewhere).
    if (this.records.length > MAX_RECORDS) {
      const evicted = this.records.shift();
      // Purge evicted keys so a re-trade of the same id can be recorded again.
      if (evicted) this.seenKeys.delete(`${evicted.tradeId}|${evicted.componentId}`);
    }
  }

  /**
   * Per-component attribution stats. Cold-start safe: components with
   * fewer than MIN_SAMPLES return neutral stats (expectancy 0, contribution 0,
   * cleanliness 1.0) so they are never prematurely pruned.
   */
  getComponentStats(componentId: ComponentId): ComponentStats {
    const comp = this.records.filter(r => r.componentId === componentId);
    const stats = this.computeStats(componentId, comp);
    return stats;
  }

  /**
   * Aggregate attribution stats for ALL components. Used by the dashboard
   * to rank which components add edge and which are dead weight.
   */
  getAllStats(): ComponentStats[] {
    const byComp = new Map<ComponentId, ComponentAttribution[]>();
    for (const r of this.records) {
      const arr = byComp.get(r.componentId) ?? [];
      arr.push(r);
      byComp.set(r.componentId, arr);
    }
    const out: ComponentStats[] = [];
    for (const [id, recs] of byComp) {
      out.push(this.computeStats(id, recs));
    }
    // Sort by contribution descending — dead weight sinks to the bottom.
    return out.sort((a, b) => b.contribution - a.contribution);
  }

  /** Total number of attribution records (for API status). */
  size(): number {
    return this.records.length;
  }

  /** Distinct components tracked. */
  componentCount(): number {
    return new Set(this.records.map(r => r.componentId)).size;
  }

  // ── Persistence (matches codebase: caller does atomic write) ──
  save(): Record<string, unknown> {
    return {
      records: this.records.map(r => ({ ...r })),
      seenKeys: Array.from(this.seenKeys),
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const recs = s['records'];
    if (Array.isArray(recs)) {
      // Sanitize on load — corrupted / non-finite / wrong-shape records dropped.
      this.records = [];
      this.seenKeys = new Set();
      for (const raw of recs) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (typeof r['tradeId'] !== 'string' || typeof r['componentId'] !== 'string') continue;
        const pnl = safeNum(r['pnlPct'] as number, 0);
        const signal = safeNum(r['signal'] as number, 0.5);
        const cleanliness = safeNum(r['labelCleanliness'] as number, 1.0);
        this.records.push({
          componentId: r['componentId'] as ComponentId,
          tradeId: r['tradeId'] as string,
          symbol: typeof r['symbol'] === 'string' ? r['symbol'] : '',
          side: r['side'] === 'sell' ? 'sell' : 'buy',
          cycleId: typeof r['cycleId'] === 'number' ? r['cycleId'] : 0,
          signal,
          agreement: safeNum(r['agreement'] as number, 0.5),
          pnlPct: pnl,
          contribution: safeNum(r['contribution'] as number, 0),
          labelCleanliness: Math.max(0, Math.min(1, cleanliness)),
          regime: typeof r['regime'] === 'string' ? r['regime'] : 'unknown',
          riskProfile: typeof r['riskProfile'] === 'string' ? r['riskProfile'] : 'moderate',
          timestamp: typeof r['timestamp'] === 'number' ? r['timestamp'] : Date.now(),
        });
        this.seenKeys.add(`${r['tradeId'] as string}|${r['componentId'] as string}`);
      }
      // Bounded after load too.
      if (this.records.length > MAX_RECORDS) {
        // v2.0.845: Trim and purge evicted seenKeys so a re-trade of an
        // evicted id can be recorded again (matches recordAttribution).
        const evictedCount = this.records.length - MAX_RECORDS;
        const evicted = this.records.slice(0, evictedCount);
        this.records = this.records.slice(-MAX_RECORDS);
        for (const e of evicted) {
          this.seenKeys.delete(`${e.tradeId}|${e.componentId}`);
        }
      }
      log.info(`[attribution] loaded ${this.records.length} attribution records`);
    }
  }

  reset(): void {
    this.records = [];
    this.seenKeys = new Set();
  }

  // ── Internal ──

  private computeStats(
    componentId: ComponentId,
    recs: ComponentAttribution[],
  ): ComponentStats {
    if (recs.length < MIN_SAMPLES) {
      return {
        componentId,
        samples: recs.length,
        expectancy: 0,
        contribution: 0,
        positiveRate: 0,
        cleanliness: 1.0,
        byRegime: [],
      };
    }

    // Only count "confident signal" trades for expectancy — a neutral 0.5
    // signal contributed nothing, so it should not count toward the
    // component's expected value.
    const confident = recs.filter(r => Math.abs(r.agreement - 0.5) >= (CONFIDENT_SIGNAL - 0.5));
    const expectancy = confident.length > 0
      ? confident.reduce((s, r) => s + r.pnlPct, 0) / confident.length
      : 0;
    const contribution = recs.reduce((s, r) => s + r.contribution, 0) / recs.length;
    const positiveRate = recs.filter(r => r.contribution > 0).length / recs.length;
    const cleanliness = recs.reduce((s, r) => s + r.labelCleanliness, 0) / recs.length;

    // Per-regime breakdown.
    const byRegimeMap = new Map<string, number[]>();
    for (const r of recs) {
      if (Math.abs(r.agreement - 0.5) < (CONFIDENT_SIGNAL - 0.5)) continue;
      const arr = byRegimeMap.get(r.regime) ?? [];
      arr.push(r.pnlPct);
      byRegimeMap.set(r.regime, arr);
    }
    const byRegime: Array<{ regime: string; expectancy: number; samples: number }> = [];
    for (const [regime, pnls] of byRegimeMap) {
      if (pnls.length < 5) continue; // per-regime needs its own sample floor
      byRegime.push({
        regime,
        expectancy: pnls.reduce((a, b) => a + b, 0) / pnls.length,
        samples: pnls.length,
      });
    }

    return {
      componentId,
      samples: recs.length,
      expectancy,
      contribution,
      positiveRate,
      cleanliness,
      byRegime: byRegime.sort((a, b) => b.expectancy - a.expectancy),
    };
  }
}
