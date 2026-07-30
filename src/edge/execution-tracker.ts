// ─── Execution Quality Tracker (Task 1B) ──────────────────────────────
//
// v2.0.833: Records the REALISED friction of every trade — slippage between
// the HACP decision price and the actual fill price, plus the funding cost
// accumulated over the hold. These two gaps are the difference between
// "theoretical PnL" (what OLR currently learns on) and "realisable PnL"
// (what the user actually keeps).
//
// Why this matters:
//   OLR's feedTrade() receives a binary win/loss outcome derived from
//   theoretical PnL (entry → SL/TP trigger). But a trade that theoretically
//   returned +0.3% may have lost 0.1% after slippage + funding — so OLR
//   learns the WRONG label and its P(win) predictions are miscalibrated.
//   This tracker calibrates the label: realisedPnl = theoretical - friction.
//
// Integration:
//   1. recordFill() is called on every trade close (paper + real) with the
//      signal price, fill price, hold time, and funding cost.
//   2. calibratePnlLabel() is called before OLR feedTrade() to convert
//      theoretical PnL into realisable PnL.
//   3. After the app launches (Task 4), the same tracker ingests user fills
//      from Supabase — 1000 users × N trades massively accelerates the
//      per-symbol friction estimate.
//
// Cold-start: below execMinSamples (default 20) per (symbol, side),
// calibratePnlLabel() returns the theoretical PnL unchanged (no harm).

import { createLogger } from '../observability/logger.ts';
import { safeNum } from '../evolution/evolution-utils.ts';
import { edgeConfig } from './edge-config.ts';

const log = createLogger({ phase: 'edge-exec-tracker' });

/** A single realised execution sample. */
export interface ExecutionSample {
  symbol: string;
  side: 'buy' | 'sell';
  /** Price at HACP decision time (the signal price). */
  signalPrice: number;
  /** Actual fill price from the exchange / paper engine. */
  fillPrice: number;
  /** Slippage in bps: (fill - signal) / signal × 10000, signed so that
   *  positive = entered at a WORSE price (paid more to buy / got less to sell). */
  slippageBps: number;
  /** Funding cost as % of notional accumulated over the hold (signed:
   *  positive = paid funding, negative = received funding). */
  fundingCostPct: number;
  holdMinutes: number;
  /** Theoretical PnL % the trade would have made with zero friction. */
  theoreticalPnlPct: number;
  /** Realised PnL % after subtracting slippage + funding. */
  realizedPnlPct: number;
  ts: number;
}

interface SideStats {
  samples: number;
  avgSlippageBps: number;
  avgFundingPctPerHour: number;
  // running sums for O(1) update
  sumSlippageBps: number;
  sumFundingPctPerHour: number;
  // ring buffer of recent samples for percentile / display
  recent: ExecutionSample[];
}

/** Compute slippage so that positive always means "worse than signal".
 *  For a BUY, a higher fill = worse (paid more). For a SELL, a lower fill =
 *  worse (received less). */
export function computeSlippageBps(
  side: 'buy' | 'sell',
  signalPrice: number,
  fillPrice: number,
): number {
  if (!Number.isFinite(signalPrice) || signalPrice <= 0 || !Number.isFinite(fillPrice)) return 0;
  const raw = side === 'buy'
    ? (fillPrice - signalPrice) / signalPrice
    : (signalPrice - fillPrice) / signalPrice;
  return Math.round(raw * 10_000 * 100) / 100; // bps, 2dp
}

/**
 * Execution Quality Tracker — per (symbol, side) rolling statistics on
 * realised slippage + funding cost. Thread-safe for single-cycle use
 * (Node is single-threaded; no mutex needed).
 */
export class ExecutionTracker {
  private stats = new Map<string, SideStats>();

  /** Record a closed trade's execution friction. Idempotent by ts — calling
   *  twice with the same ts is a no-op (guards against double-close paths). */
  recordFill(input: {
    symbol: string;
    side: 'buy' | 'sell';
    signalPrice: number;
    fillPrice: number;
    fundingCostPct: number;
    holdMinutes: number;
    theoreticalPnlPct: number;
    ts?: number;
  }): void {
    const sym = input.symbol.toLowerCase();
    const key = `${sym}|${input.side}`;
    const ts = input.ts ?? Date.now();
    const slippageBps = computeSlippageBps(input.side, safeNum(input.signalPrice, 0), safeNum(input.fillPrice, 0));
    const holdMinutes = Math.max(0, safeNum(input.holdMinutes, 0));
    const fundingPct = safeNum(input.fundingCostPct, 0);
    // funding per hour normalised; guard divide-by-zero on sub-minute holds.
    const fundingPerHour = holdMinutes > 0 ? (fundingPct / holdMinutes) * 60 : 0;
    const theoretical = safeNum(input.theoreticalPnlPct, 0);
    // realised = theoretical minus the friction that worked against us.
    // slippage is in bps; convert to a PnL % drag (positive slippage = cost).
    const slippageDragPct = (slippageBps / 10_000) * 100;
    const realized = theoretical - slippageDragPct - fundingPct;

    const sample: ExecutionSample = {
      symbol: input.symbol,
      side: input.side,
      signalPrice: safeNum(input.signalPrice, 0),
      fillPrice: safeNum(input.fillPrice, 0),
      slippageBps,
      fundingCostPct: fundingPct,
      holdMinutes,
      theoreticalPnlPct: theoretical,
      realizedPnlPct: realized,
      ts,
    };

    let s = this.stats.get(key);
    if (!s) {
      s = {
        samples: 0, avgSlippageBps: 0, avgFundingPctPerHour: 0,
        sumSlippageBps: 0, sumFundingPctPerHour: 0, recent: [],
      };
      this.stats.set(key, s);
    }
    // de-dup by ts (double-close paths are common in this codebase).
    if (s.recent.some((r) => r.ts === ts)) return;
    s.samples++;
    s.sumSlippageBps += slippageBps;
    s.sumFundingPctPerHour += fundingPerHour;
    s.avgSlippageBps = s.sumSlippageBps / s.samples;
    s.avgFundingPctPerHour = s.sumFundingPctPerHour / s.samples;
    s.recent.push(sample);
    if (s.recent.length > edgeConfig.execLookback) s.recent.shift();
  }

  /** Calibrate a theoretical PnL % into a realisable PnL %.
   *  Below execMinSamples, returns the theoretical value unchanged (cold-start
   *  safe — do not let small-sample noise flip win/loss labels). */
  calibratePnlLabel(
    symbol: string,
    side: 'buy' | 'sell',
    theoreticalPnlPct: number,
    holdMinutes = 60,
  ): number {
    const s = this.stats.get(`${symbol.toLowerCase()}|${side}`);
    if (!s || s.samples < edgeConfig.execMinSamples) return theoreticalPnlPct;
    const slippageDragPct = (s.avgSlippageBps / 10_000) * 100;
    const fundingDragPct = s.avgFundingPctPerHour * (holdMinutes / 60);
    return theoreticalPnlPct - slippageDragPct - fundingDragPct;
  }

  /** Snapshot stats for the Edge Report's executionGap field.
 *  Returns the BOUNDED recent sample count (ring-buffer length), not the
 *  cumulative counter, so callers cannot be fooled by a 100k-sample
 *  counter into thinking the estimate is high-confidence when the
 *  rolling window only sees the last `execLookback` samples. */
  getStats(symbol: string, side: 'buy' | 'sell'): {
    avgSlippageBps: number;
    avgFundingPctPerHour: number;
    samples: number;
  } {
    const s = this.stats.get(`${symbol.toLowerCase()}|${side}`);
    if (!s) return { avgSlippageBps: 0, avgFundingPctPerHour: 0, samples: 0 };
    // Report the bounded window length so a DoS attacker (or a long-running
    // system) cannot inflate the reported sample count without bound.
    return {
      avgSlippageBps: s.avgSlippageBps,
      avgFundingPctPerHour: s.avgFundingPctPerHour,
      samples: s.recent.length,
    };
  }

  /** Serialise for persistence (atomic write by caller). */
  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, s] of this.stats) {
      out[key] = {
        samples: s.samples,
        avgSlippageBps: s.avgSlippageBps,
        avgFundingPctPerHour: s.avgFundingPctPerHour,
        sumSlippageBps: s.sumSlippageBps,
        sumFundingPctPerHour: s.sumFundingPctPerHour,
        recent: s.recent,
      };
    }
    return out;
  }

  /** Restore from persisted state. Tolerates missing/partial/corrupt data. */
  load(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const obj = data as Record<string, Record<string, unknown>>;
    for (const [key, val] of Object.entries(obj)) {
      if (!val || typeof val !== 'object') continue;
      const v = val;
      const samples = safeNum(v['samples'] as number, 0);
      if (samples <= 0) continue;
      const recent = Array.isArray(v['recent']) ? (v['recent'] as ExecutionSample[]) : [];
      this.stats.set(key, {
        samples,
        avgSlippageBps: safeNum(v['avgSlippageBps'] as number, 0),
        avgFundingPctPerHour: safeNum(v['avgFundingPctPerHour'] as number, 0),
        sumSlippageBps: safeNum(v['sumSlippageBps'] as number, 0),
        sumFundingPctPerHour: safeNum(v['sumFundingPctPerHour'] as number, 0),
        recent,
      });
    }
    log.info(`[exec-tracker] loaded ${this.stats.size} (symbol,side) entries`);
  }

  /** Reset — used by tests. */
  reset(): void {
    this.stats.clear();
  }
}