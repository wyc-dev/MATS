// ─── Risk-Profile-Conditional Edge Store (Task 1 §1.10) ────────────────
//
// v2.0.833: A MiniLM-backed vector store that answers
// "given this market condition + this risk profile, what was the realised
// win rate of the most similar historical trades?"
//
// Why this is NOT just a database query:
//   Edge is conditional on BOTH market state AND the trader's risk profile.
//   An aggressive user (short hold, wide SL) and a conservative user
//   (long hold, tight SL) trading the SAME signal in the SAME regime will
//   realise different PnL — the conservative user gets stopped out by
//   noise the aggressive user rides through. A pure (symbol × side × regime)
//   bucket cannot express this; we need a similarity search over a
//   combined (market + profile) vector.
//
// Why MiniLM (sentence embedding) instead of raw feature vectors:
//   MiniLM was trained on natural language, so we feed it a structured
//   text description. This lets "trending_bull + aggressive" sit close to
//   "trending_bull + moderate" (same regime, adjacent profiles) and far
//   from "chaotic + conservative" — a semantic neighbourhood that raw
//   numeric vectors do not encode. The 384-d embedding is the lookup key.
//
// Cold-start safe: below rpMinMatches, returns neutral 0.5. The blend in
// EdgeCalculator uses rpNeutralWeight (0.6) + rpProfileWeight (0.4) so the
// profile-specific signal only shifts the score when it has data.

import { createLogger } from '../observability/logger.ts';
import { safeNum, wilsonScore } from '../evolution/evolution-utils.ts';
import { cosine, type EmbedProvider } from '../evolution/embeddings.ts';
import { edgeConfig } from './edge-config.ts';
import type { RiskProfile } from '../types/index.ts';

const log = createLogger({ phase: 'edge-rp-store' });

/** One stored historical trade with its MiniLM embedding + outcome. */
export interface RiskProfileEdgeRecord {
  /** 384-d MiniLM embedding of the combined (market + profile) text. */
  embedding: number[];
  symbol: string;
  side: 'buy' | 'sell';
  riskProfile: RiskProfile;
  regime: string;
  /** Realised PnL % AFTER slippage + funding (from ExecutionTracker). */
  realizedPnlPct: number;
  outcome: 0 | 1;
  closeReason: string;
  holdMinutes: number;
  /** SL tolerance at entry (% of entry price). Captures profile behaviour. */
  slTolerancePct: number;
  ts: number;
}

export interface RiskProfileEdgeResult {
  /** Conditional edge [0,1] for this (market, profile) combination. */
  edgeScore: number;
  confidence: 'high' | 'medium' | 'low';
  samples: number;
}

/**
 * Risk-Profile Edge Store — a ring-buffer vector database keyed by MiniLM
 * embeddings of (market state + risk profile) text. Lookups are brute-force
 * cosine over the buffer (10k records × 384-d = ~15MB; sub-50ms in Node).
 * No external vector DB dependency — keeps the system self-contained.
 */
export class RiskProfileEdgeStore {
  private buffer: RiskProfileEdgeRecord[] = [];
  private embedProvider: EmbedProvider | null = null;

  /** Set the shared MiniLM provider. Called once at init (after warmup). */
  setEmbedProvider(p: EmbedProvider): void {
    this.embedProvider = p;
  }

  /** Record a closed trade. Embeds the combined text and appends to the
   *  ring buffer. Idempotent by ts. Safe to call before the provider is set
   *  (the record is stored without an embedding; it will not match queries
   *  until backfilled, but it is not lost). */
  async recordTrade(input: {
    marketFeatures: Record<string, number>;
    symbol: string;
    side: 'buy' | 'sell';
    riskProfile: RiskProfile;
    regime: string;
    realizedPnlPct: number;
    outcome: 0 | 1;
    closeReason: string;
    holdMinutes: number;
    slTolerancePct: number;
    ts?: number;
    /** v2.0.834: Factor tagging — agent vote summary for embedding */
    agentVotes?: Array<{ agent: string; weight: number; action: string }>;
    primaryDriver?: { agent: string; action: string };
  }): Promise<void> {
    const ts = input.ts ?? Date.now();
    // de-dup by ts + symbol + side
    if (this.buffer.some((r) => r.ts === ts && r.symbol === input.symbol && r.side === input.side)) return;

    let embedding: number[] = [];
    if (this.embedProvider) {
      try {
        const [vec] = await this.embedProvider.embed([buildEdgeText(input)]);
        embedding = vec ?? [];
      } catch (err) {
        log.warn(`[rp-store] embed failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.buffer.push({
      embedding,
      symbol: input.symbol,
      side: input.side,
      riskProfile: input.riskProfile,
      regime: input.regime,
      realizedPnlPct: safeNum(input.realizedPnlPct, 0),
      outcome: input.outcome,
      closeReason: input.closeReason,
      holdMinutes: safeNum(input.holdMinutes, 0),
      slTolerancePct: safeNum(input.slTolerancePct, 0),
      ts,
    });
    if (this.buffer.length > edgeConfig.rpStoreCap) this.buffer.shift();
  }

  /** Query the store for the conditional edge of a (market, profile) combo.
   *  Returns neutral 0.5 on cold-start / no matches — never hard-blocks.
   *  v2.0.834: Optional agentVotes + primaryDriver enable factor-tagged
   *  queries — "similar market condition + similar agent signal combination
   *  → historical outcome." */
  async query(input: {
    marketFeatures: Record<string, number>;
    symbol: string;
    side: 'buy' | 'sell';
    riskProfile: RiskProfile;
    regime: string;
    agentVotes?: Array<{ agent: string; weight: number; action: string }>;
    primaryDriver?: { agent: string; action: string };
  }): Promise<RiskProfileEdgeResult> {
    if (!this.embedProvider || this.buffer.length === 0) {
      return { edgeScore: 0.5, confidence: 'low', samples: 0 };
    }
    let queryVec: number[];
    try {
      const result = await this.embedProvider.embed([buildEdgeText(input)]);
      queryVec = result[0] ?? [];
    } catch (err) {
      log.warn(`[rp-store] query embed failed: ${err instanceof Error ? err.message : String(err)}`);
      return { edgeScore: 0.5, confidence: 'low', samples: 0 };
    }
    if (!queryVec || queryVec.length === 0) {
      return { edgeScore: 0.5, confidence: 'low', samples: 0 };
    }

    // Brute-force cosine over same-symbol + same-side records.
    const scored: Array<{ rec: RiskProfileEdgeRecord; sim: number }> = [];
    for (const rec of this.buffer) {
      if (rec.embedding.length === 0) continue;
      if (rec.symbol.toLowerCase() !== input.symbol.toLowerCase()) continue;
      if (rec.side !== input.side) continue;
      const sim = cosine(queryVec, rec.embedding);
      if (sim >= edgeConfig.rpMinSimilarity) scored.push({ rec, sim });
    }
    if (scored.length < edgeConfig.rpMinMatches) {
      return { edgeScore: 0.5, confidence: 'low', samples: scored.length };
    }

    // Top-K by similarity.
    scored.sort((a, b) => b.sim - a.sim);
    const top = scored.slice(0, edgeConfig.rpTopK);

    // Time-decayed weighted WR (30-day half-life). Recent trades count more.
    const now = Date.now();
    const halfLifeMs = edgeConfig.rpHalfLifeDays * 24 * 60 * 60 * 1000;
    let weightSum = 0;
    let weightedWins = 0;
    for (const { rec, sim } of top) {
      const age = Math.max(0, now - rec.ts);
      const timeWeight = Math.pow(0.5, age / halfLifeMs);
      // similarity weight (softmax-ish, scaled) × time weight
      const w = Math.exp(sim * 4) * timeWeight;
      weightSum += w;
      if (rec.outcome === 1) weightedWins += w;
    }
    const weightedWR = weightSum > 0 ? weightedWins / weightSum : 0.5;
    const wins = top.filter((s) => s.rec.outcome === 1).length;
    const wilsonLB = wilsonScore(wins, top.length);

    // Blend Wilson LB (statistical rigour) with time-decayed weighted WR
    // (recency bias). Both in [0,1].
    const edgeScore = 0.5 * wilsonLB + 0.5 * weightedWR;
    const confidence = top.length >= edgeConfig.confHighSamples
      ? 'high'
      : top.length >= edgeConfig.confMediumSamples ? 'medium' : 'low';
    return { edgeScore: clamp01(edgeScore), confidence, samples: top.length };
  }

  /** Serialise for persistence. Embeddings are large (384-d × N); we keep
   *  them because re-embedding 10k records on restart is expensive. */
  serialize(): RiskProfileEdgeRecord[] {
    // v2.0.835 security: deep copy to prevent external mutation of internal state
    return this.buffer.slice(-edgeConfig.rpStoreCap).map(r => ({
      ...r,
      embedding: Array.isArray(r.embedding) ? [...r.embedding] : [],
    }));
  }

  /** Restore from persisted state. Tolerates missing/partial embeddings. */
  load(records: unknown): void {
    if (!Array.isArray(records)) return;
    const valid: RiskProfileEdgeRecord[] = [];
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Partial<RiskProfileEdgeRecord>;
      if (typeof rec.symbol !== 'string') continue;
      if (rec.side !== 'buy' && rec.side !== 'sell') continue;
      if (rec.riskProfile !== 'aggressive' && rec.riskProfile !== 'moderate' && rec.riskProfile !== 'conservative') continue;
      valid.push({
        embedding: Array.isArray(rec.embedding) ? rec.embedding.filter((n) => Number.isFinite(n)) : [],
        symbol: rec.symbol,
        side: rec.side,
        riskProfile: rec.riskProfile,
        regime: typeof rec.regime === 'string' ? rec.regime : 'unknown',
        realizedPnlPct: safeNum(rec.realizedPnlPct, 0),
        outcome: rec.outcome === 1 ? 1 : 0,
        closeReason: typeof rec.closeReason === 'string' ? rec.closeReason : 'unknown',
        holdMinutes: safeNum(rec.holdMinutes, 0),
        slTolerancePct: safeNum(rec.slTolerancePct, 0),
        ts: safeNum(rec.ts, 0),
      });
    }
    this.buffer = valid.slice(-edgeConfig.rpStoreCap);
    log.info(`[rp-store] loaded ${this.buffer.length} records`);
  }

  /** Reset — used by tests. */
  reset(): void {
    this.buffer = [];
  }

  /** Current record count (for stats / display). */
  size(): number {
    return this.buffer.length;
  }
}

/** Build the structured text that MiniLM embeds. Combines market state +
 *  risk profile + hold/SL behaviour into one sentence so the embedding
 *  captures the JOINT semantics (not just market OR profile). */
export function buildEdgeText(input: {
  marketFeatures: Record<string, number>;
  symbol: string;
  side: 'buy' | 'sell';
  riskProfile: RiskProfile;
  regime: string;
  holdMinutes?: number;
  slTolerancePct?: number;
  /** v2.0.834: Factor tagging — agent vote summary for MiniLM embedding.
   *  When provided, the embedding captures the JOINT semantics of market
   *  condition + agent signal combination, enabling "similar market +
   *  similar agent combination → historical outcome" queries. */
  agentVotes?: Array<{ agent: string; weight: number; action: string }>;
  primaryDriver?: { agent: string; action: string };
}): string {
  // v2.0.835 security: guard against null/undefined marketFeatures
  const f = (input.marketFeatures && typeof input.marketFeatures === 'object')
    ? input.marketFeatures
    : {};
  const vol = safeNum(f['volatility'], 0).toFixed(4);
  const sr = safeNum(f['srDistanceBps'], 0).toFixed(0);
  const funding = safeNum(f['fundingRate'], 0).toFixed(5);
  const ob = safeNum(f['obImbalance'], 0).toFixed(2);
  const momShort = safeNum(f['momentumShort'], 0).toFixed(2);
  const momLong = safeNum(f['momentumLong'], 0).toFixed(2);
  const hold = input.holdMinutes !== undefined ? `, hold ${input.holdMinutes}min` : '';
  const sl = input.slTolerancePct !== undefined ? `, SL ${input.slTolerancePct.toFixed(1)}%` : '';
  // v2.0.834: Factor tagging — include agent vote summary in the embedding text
  // so MiniLM captures the agent signal combination semantics.
  const driver = input.primaryDriver ? `, driver ${input.primaryDriver.agent}(${input.primaryDriver.action})` : '';
  const votes = input.agentVotes && input.agentVotes.length > 0
    ? ', agents ' + input.agentVotes.map(v => `${v.agent}:${v.action}`).join('/')
    : '';
  return [
    `Symbol ${input.symbol}, side ${input.side}.`,
    `Regime ${input.regime}, vol ${vol}, S/R ${sr}bps, funding ${funding}, OB ${ob},`,
    `momentum short ${momShort} long ${momLong}.`,
    `Risk profile ${input.riskProfile}${hold}${sl}${driver}${votes}.`,
  ].join(' ');
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, safeNum(x, 0.5)));
}