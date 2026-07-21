// ─── RIL — Reason Intelligence Layer (v2.0.767) ───
// Provides Meta-Agent with structured reference data about what entry/close
// patterns historically win and lose. Three data sources:
//
//   1. PatternClusterManager — greedy clustering of entry rationale texts
//      (MiniLM embeddings + cosine similarity) → per-pattern WR/PnL
//      v2.0.767: Added periodic rebuild (every 12 cycles) to keep clusters fresh.
//      Added lastRebuildCycle counter to avoid rebuilding every cycle.
//      Added rebuildPromise for non-blocking background rebuild.
//   2. CloseReasonAggregator — pure math GROUP BY exitType+decisionOrigin
//      → per-close-reason WR/PnL
//   3. SimilarTradeRetriever + SubtleDiffAnalyzer — top-N similar past trades
//      + LLM analysis of subtle differences vs current proposal
//
// These are supplemented by the existing EXP verdict (kept as reference, not gate)
// and A2A Digester digest (kept as supplementary LLM analysis).
//
// Core philosophy: provide DATA for Meta-Agent to REASON with, not GATES to obey.

import { config } from '../config/index.ts';
import { rootLogger } from '../observability/logger.ts';
import { cosine, combinationSimilarity, type EmbedProvider } from './embeddings.ts';
import { computeVectorConditionalWinRate, ENTRY_CONDITION_FEATURES } from './evolution-utils.ts';
import type { AttnResTradeEmbedder } from './attnres-trade-embedder.ts';

import type {
  ThesisExperienceRecord,
  ReasonPatternCluster,
  CloseReasonStat,
  SimilarTradeResult,
  RILConfig,
} from '../types/index.ts';

const log = rootLogger;

// ═══════════════════════════════════════════════════════════════
//  PatternClusterManager
// ═══════════════════════════════════════════════════════════════

/**
 * Greedy clustering of entry rationale texts by cosine similarity.
 * Each cluster represents a semantically similar entry pattern (e.g.
 * "S/R bounce + volume confirmation") with aggregate win/loss stats.
 *
 * Algorithm: for each rationale text, find nearest existing cluster centroid.
 * If cosine >= threshold, add to cluster (running-mean centroid update).
 * Otherwise, create new cluster.
 *
 * O(n × k) where n = number of rationales, k = number of clusters.
 * For 1000 trades × ~3 rationales each × ~50 clusters = ~150k cosine comparisons — trivial.
 *
 * v2.0.767: Added periodic rebuild support. The rebuild() method is called from
 * the main decision cycle every N cycles (e.g., every 12 cycles = 1 hour).
 * A background promise (rebuildPromise) prevents blocking the decision cycle.
 * The lastRebuildCycle counter ensures we don't rebuild every cycle.
 */
export class PatternClusterManager {
  private clusters: ReasonPatternCluster[] = [];
  private readonly cfg: RILConfig;
  private readonly embed: EmbedProvider;
  private built = false;
  /** v2.0.215: Optional AttnRes trade embedder for learned rationale blending. */
  private attnResEmbedder: AttnResTradeEmbedder | null = null;
  /** v2.0.767: Track the last cycle when a full rebuild was triggered. */
  private lastRebuildCycle = -1;
  /** v2.0.767: Background rebuild promise to avoid blocking the decision cycle. */
  private rebuildPromise: Promise<void> | null = null;
  /** v2.0.767: How many decision cycles between full rebuilds. Default 12 = ~1 hour. */
  private readonly rebuildInterval: number;

  constructor(embed: EmbedProvider, cfg?: Partial<RILConfig>) {
    this.embed = embed;
    this.cfg = {
      enabled: config.ril.enabled,
      clusterThreshold: config.ril.clusterThreshold,
      minClusterSize: config.ril.minClusterSize,
      maxPatternsDisplay: config.ril.maxPatternsDisplay,
      similarTradeCount: config.ril.similarTradeCount,
      subtleDiffEnabled: config.ril.subtleDiffEnabled,
      rebuildOnStartup: config.ril.rebuildOnStartup,
      maxClusters: config.ril.maxClusters,
      ...cfg,
    };
    // v2.0.767: Default rebuild interval = 12 cycles (configurable via cfg.rebuildInterval)
    this.rebuildInterval = (cfg as any)?.rebuildInterval ?? 12;
  }

  isBuilt(): boolean {
    return this.built;
  }

  clusterCount(): number {
    return this.clusters.length;
  }

  /** v2.0.215: Inject AttnRes trade embedder for learned rationale blending. */
  setAttnResTradeEmbedder(e: AttnResTradeEmbedder | null): void {
    this.attnResEmbedder = e;
  }

  /** v2.0.215: Get the AttnRes embedder (for index.ts to call updateOnOutcome). */
  getAttnResTradeEmbedder(): AttnResTradeEmbedder | null {
    return this.attnResEmbedder;
  }

  // ─── Full rebuild from all records (startup) ───

  async rebuild(records: ThesisExperienceRecord[]): Promise<void> {
    this.clusters = [];
    if (!this.cfg.enabled || records.length === 0) {
      this.built = true;
      return;
    }

    let added = 0;
    let skipped = 0;
    for (const rec of records) {
      if (rec.rationaleVectors.length === 0) {
        skipped++;
        continue;
      }

      // v2.0.215: AttnRes blend path — when embedder is present, blend all
      // rationale vectors into a single trade representation and assign to one
      // cluster. This replaces the per-rationale approach with a learned blend.
      // Cold-start safe: w=0 → uniform → mean ≈ current behavior.
      if (this.attnResEmbedder) {
        const blended = this.attnResEmbedder.blend(rec.rationaleVectors);
        if (blended.length > 0) {
          const rationale = rec.rationales[0] ?? `trade-${rec.id}`;
          this.assignToCluster(rec, rationale, blended);
          added++;
        }
        continue;
      }

      // Default path: per-rationale clustering (backward compatible)
      for (let i = 0; i < rec.rationaleVectors.length; i++) {
        const vec = rec.rationaleVectors[i]!;
        if (vec.length === 0) continue;
        const rationale = rec.rationales[i] ?? `rationale-${i}`;
        this.assignToCluster(rec, rationale, vec);
        added++;
      }
    }

    // Prune to maxClusters (keep largest)
    if (this.clusters.length > this.cfg.maxClusters) {
      this.clusters.sort((a, b) => b.count - a.count);
      this.clusters = this.clusters.slice(0, this.cfg.maxClusters);
    }

    // Sort by count desc for display
    this.clusters.sort((a, b) => b.count - a.count);

    this.built = true;
    log.info(`[RIL] rebuilt ${this.clusters.length} pattern clusters from ${added} rationales (${skipped} skipped, ${records.length} records)`);
  }

  // ─── Incremental: add one closed trade ───

  async addTrade(rec: ThesisExperienceRecord): Promise<void> {
    if (!this.cfg.enabled || !this.built) return;
    if (rec.rationaleVectors.length === 0) return;

    // v2.0.215: AttnRes blend path
    if (this.attnResEmbedder) {
      const blended = this.attnResEmbedder.blend(rec.rationaleVectors);
      if (blended.length > 0) {
        const rationale = rec.rationales[0] ?? `trade-${rec.id}`;
        this.assignToCluster(rec, rationale, blended);
      }
      return;
    }

    // Default path: per-rationale clustering (backward compatible)
    for (let i = 0; i < rec.rationaleVectors.length; i++) {
      const vec = rec.rationaleVectors[i]!;
      if (vec.length === 0) continue;
      const rationale = rec.rationales[i] ?? `rationale-${i}`;
      this.assignToCluster(rec, rationale, vec);
    }
  }

  // ─── v2.0.767: Periodic rebuild trigger ───

  /**
   * Called from the main decision cycle every N cycles.
   * Triggers a background rebuild if enough cycles have passed since the last one.
   * Returns immediately — the rebuild runs asynchronously and does not block.
   *
   * @param records - All closed trade records (for full reclustering)
   * @param currentCycle - The current decision cycle number
   */
  triggerPeriodicRebuild(records: ThesisExperienceRecord[], currentCycle: number): void {
    if (!this.cfg.enabled) return;
    if (currentCycle - this.lastRebuildCycle < this.rebuildInterval) return;
    // If a rebuild is already in progress, don't start another
    if (this.rebuildPromise !== null) return;

    this.lastRebuildCycle = currentCycle;
    log.info(`[RIL] triggering periodic cluster rebuild at cycle ${currentCycle}`);

    // Fire-and-forget: rebuild in background, catch errors silently
    this.rebuildPromise = this.rebuild(records).catch((err) => {
      log.warn(`[RIL] periodic rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      this.rebuildPromise = null;
    });
  }

  // ─── Internal: assign a rationale vector to nearest cluster ───

  private assignToCluster(rec: ThesisExperienceRecord, rationale: string, vec: number[]): void {
    let best: ReasonPatternCluster | null = null;
    let bestSim = -Infinity;

    for (const c of this.clusters) {
      const sim = cosine(vec, c.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }

    if (best && bestSim >= this.cfg.clusterThreshold) {
      this.addToCluster(best, rec, vec);
    } else {
      this.createCluster(rec, rationale, vec);
    }
  }

  private createCluster(rec: ThesisExperienceRecord, name: string, vec: number[]): void {
    const outcome = rec.outcome;
    this.clusters.push({
      id: `ril-cluster-${rec.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      centroid: vec,
      count: 1,
      wins: outcome === 'WIN' ? 1 : 0,
      losses: outcome === 'LOSS' ? 1 : 0,
      netPnl: rec.pnl,
      winRate: outcome === 'WIN' ? 1 : 0,
      avgHoldMin: rec.holdMin,
      symbols: [rec.symbol],
      sides: [rec.side],
      // v2.0.176: Per-direction tracking
      buyWins: rec.side === 'buy' && outcome === 'WIN' ? 1 : 0,
      buyLosses: rec.side === 'buy' && outcome === 'LOSS' ? 1 : 0,
      sellWins: rec.side === 'sell' && outcome === 'WIN' ? 1 : 0,
      sellLosses: rec.side === 'sell' && outcome === 'LOSS' ? 1 : 0,
      memberIds: [rec.id],
      exitTypeBreakdown: {},
      ts: rec.ts,
      // v2.0.214: Store per-member market data for conditional WR
      memberMarketData: [{
        marketFeatures: rec.marketFeatures,
        outcome: outcome ?? 'LOSS',
        symbol: rec.symbol,
        side: rec.side,
        pnl: rec.pnl,
      }],
    });
  }

  private addToCluster(c: ReasonPatternCluster, rec: ThesisExperienceRecord, vec: number[]): void {
    const n = c.count;
    // Running-mean centroid: new = (old * n + vec) / (n + 1), then L2-normalise
    const dim = vec.length;
    const sum: number[] = [];
    for (let i = 0; i < dim; i++) {
      sum[i] = (c.centroid[i] ?? 0) * n + (vec[i] ?? 0);
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += sum[i]! * sum[i]!;
    norm = Math.sqrt(norm) || 1;
    c.centroid = sum.map((v) => v / norm);

    c.count = n + 1;
    if (rec.outcome === 'WIN') c.wins++;
    else c.losses++;
    c.netPnl += rec.pnl;
    c.winRate = c.wins / c.count;
    c.avgHoldMin = (c.avgHoldMin * n + rec.holdMin) / c.count;

    if (!c.symbols.includes(rec.symbol)) c.symbols.push(rec.symbol);
    if (!c.sides.includes(rec.side)) c.sides.push(rec.side);
    // v2.0.176: Per-direction tracking
    if (rec.side === 'buy') {
      if (rec.outcome === 'WIN') c.buyWins++;
      else c.buyLosses++;
    } else {
      if (rec.outcome === 'WIN') c.sellWins++;
      else c.sellLosses++;
    }
    if (!c.memberIds.includes(rec.id)) c.memberIds.push(rec.id);
    c.ts = Math.max(c.ts, rec.ts);

    // v2.0.214: Append per-member market data for conditional WR computation.
    // Guard against undefined (clusters created before v2.0.214).
    if (!c.memberMarketData) c.memberMarketData = [];
    c.memberMarketData.push({
      marketFeatures: rec.marketFeatures,
      outcome: rec.outcome ?? 'LOSS',
      symbol: rec.symbol,
      side: rec.side,
      pnl: rec.pnl,
    });

    // Update exit type breakdown
    const exitKey = `${rec.decisionOrigin ?? 'unknown'}__${(rec as any).exitType ?? 'unknown'}`;
    if (!c.exitTypeBreakdown[exitKey]) {
      c.exitTypeBreakdown[exitKey] = { wins: 0, losses: 0, pnl: 0 };
    }
    const eb = c.exitTypeBreakdown[exitKey]!;
    if (rec.outcome === 'WIN') eb.wins++;
    else eb.losses++;
    eb.pnl += rec.pnl;

    // Update cluster name if this rationale is closer to centroid than current name
    // (lazy: only check periodically — every 10 additions)
    if (c.count % 10 === 0) {
      // Find the member rationale closest to centroid
      // (We don't store all member vectors, so we approximate by keeping the
      //  original name. The name is a reasonable approximation.)
    }
  }

  // ─── Get pattern map for agent context ───

  /**
   * Formats the entry pattern performance map for agent context injection.
   *
   * v2.0.214: When `currentFeatures` is provided, each cluster also shows a
   * conditional win rate — the WR of cluster members whose market features
   * are similar to the current market state. This is computed via
   * `computeVectorConditionalWinRate` within each cluster's memberMarketData.
   *
   * Falls back to raw WR only when:
   * - `currentFeatures` is not provided (backward compatible)
   * - cluster has no `memberMarketData` (created before v2.0.214)
   * - cluster has < 3 members with market features (insufficient for conditional WR)
   * - conditional WR returns confidence='none'
   *
   * @param totalTrades - Total closed trade count (for header)
   * @param currentFeatures - Current market features for conditional WR (optional)
   * @param side - Filter conditional WR by direction (optional, e.g. 'buy' or 'sell')
   */
  getPatternMap(
    totalTrades: number,
    currentFeatures?: Record<string, number>,
    side?: 'buy' | 'sell',
  ): string {
    if (!this.built || this.clusters.length === 0) return '';

    const lines: string[] = [];
    lines.push(`=== ENTRY PATTERN PERFORMANCE (from ${totalTrades} closed trades) ===`);

    // Filter to clusters with >= minClusterSize, sort by count desc
    const display = this.clusters
      .filter((c) => c.count >= this.cfg.minClusterSize)
      .slice(0, this.cfg.maxPatternsDisplay);

    if (display.length === 0) {
      lines.push('(insufficient data — fewer than ' + this.cfg.minClusterSize + ' trades per pattern)');
      lines.push('---');
      return lines.join('\n');
    }

    // v2.0.214: Pre-compute conditional WR for each cluster if currentFeatures provided.
    const condMap = new Map<string, { wr: number; sampleSize: number; confidence: string } | null>();
    if (currentFeatures && Object.keys(currentFeatures).length > 0) {
      for (const c of display) {
        const cond = this.computeClusterConditionalWR(c, currentFeatures, side);
        condMap.set(c.id, cond);
      }
    }

    for (const c of display) {
      const icon = c.winRate >= 0.6 ? '🟢' : c.winRate <= 0.4 ? '🔴' : '🟡';
      const pnlStr = c.netPnl >= 0 ? '+' + c.netPnl.toFixed(2) : c.netPnl.toFixed(2);
      const name = c.name.length > 50 ? c.name.slice(0, 50) + '…' : c.name;
      // v2.0.176: Show per-direction win rates when both directions exist
      const buyTotal = c.buyWins + c.buyLosses;
      const sellTotal = c.sellWins + c.sellLosses;
      let dirStr = '';
      if (buyTotal > 0 && sellTotal > 0) {
        const buyWR = buyTotal > 0 ? (c.buyWins / buyTotal * 100).toFixed(0) : '0';
        const sellWR = sellTotal > 0 ? (c.sellWins / sellTotal * 100).toFixed(0) : '0';
        dirStr = ` [BUY ${buyWR}% (W${c.buyWins} L${c.buyLosses}) | SELL ${sellWR}% (W${c.sellWins} L${c.sellLosses})]`;
      }

      // v2.0.214: Show conditional WR alongside raw WR when available
      const cond = condMap.get(c.id);
      let condStr = '';
      if (cond && cond.confidence !== 'none') {
        const condIcon = cond.wr >= 0.6 ? '▲' : cond.wr <= 0.4 ? '▼' : '◆';
        condStr = ` | ${condIcon} cond ${(cond.wr * 100).toFixed(0)}% (${cond.sampleSize} sim, ${cond.confidence})`;
      }

      lines.push(
        `${icon} ${name.padEnd(52)} W${c.wins} L${c.losses}  ${pnlStr}  (${(c.winRate * 100).toFixed(0)}%, ${c.count}t, avg ${c.avgHoldMin.toFixed(0)}min)${dirStr}${condStr}`,
      );
    }

    lines.push('---');
    return lines.join('\n');
  }

  /**
   * v2.0.214: Compute conditional win rate within a single pattern cluster.
   * Uses `computeVectorConditionalWinRate` on the cluster's memberMarketData,
   * filtered by the current market features. Falls back to null when:
   * - cluster has no memberMarketData
   * - fewer than 3 members with market features
   * - conditional WR returns confidence='none'
   *
   * This is the RIL analog of the AttnRes conditional WR — instead of asking
   * "what is the win rate of ALL similar market conditions?", we ask "what is
   * the win rate of THIS pattern in similar market conditions?" The pattern
   * narrows the population to semantically similar trades, then the market
   * features narrow it further to conditionally similar trades.
   */
  private computeClusterConditionalWR(
    cluster: ReasonPatternCluster,
    currentFeatures: Record<string, number>,
    side?: 'buy' | 'sell',
  ): { wr: number; sampleSize: number; confidence: string } | null {
    if (!cluster.memberMarketData || cluster.memberMarketData.length === 0) return null;

    // Filter to members that have marketFeatures
    const membersWithFeatures = cluster.memberMarketData.filter(
      (m) => m.marketFeatures && Object.keys(m.marketFeatures).length > 0,
    );
    if (membersWithFeatures.length < 3) return null; // insufficient for conditional WR

    try {
      const result = computeVectorConditionalWinRate(
        currentFeatures,
        membersWithFeatures,
        {
          featureNames: ENTRY_CONDITION_FEATURES,
          side,
          minSamples: 3,
          threshold: 0.80,
          topN: 20,
          softmaxWeightedWR: true,
          softmaxTemperature: 0.1,
        },
      );
      if (result.confidence === 'none') return null;
      return {
        wr: result.conditionalWinRate,
        sampleSize: result.sampleSize,
        confidence: result.confidence,
      };
    } catch {
      return null; // fail-open: fall back to raw WR
    }
  }

  /** Find the pattern cluster most similar to a set of rationale vectors. */
  findMatchingPattern(rationaleVectors: number[][]): { cluster: ReasonPatternCluster | null; similarity: number } {
    if (!this.built || this.clusters.length === 0 || rationaleVectors.length === 0) {
      return { cluster: null, similarity: 0 };
    }
    let best: ReasonPatternCluster | null = null;
    let bestSim = -Infinity;
    for (const c of this.clusters) {
      const sim = combinationSimilarity(rationaleVectors, [c.centroid], 'asymmetric');
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    return { cluster: best, similarity: bestSim };
  }

  /** Expose clusters for testing / UI. */
  getClusters(): ReasonPatternCluster[] {
    return [...this.clusters];
  }
}

// ═══════════════════════════════════════════════════════════════
//  CloseReasonAggregator
// ═══════════════════════════════════════════════════════════════

/**
 * Pure-math aggregation of close reasons. Groups closed trades by exitType +
 * decisionOrigin and computes WR, PnL, count, avg hold.
 *
 * No LLM, no vectors — just GROUP BY + AVG + COUNT.
 */
export class CloseReasonAggregator {
  aggregate(records: ThesisExperienceRecord[]): CloseReasonStat[] {
    if (records.length === 0) return [];

    const groups = new Map<string, {
      count: number; wins: number; losses: number;
      netPnl: number; totalHold: number;
    }>();

    for (const r of records) {
      // v2.0.143: Use the exitType field stored on the record (sl_tp, consensus,
      // manual, thesis_invalidation, reconciliation, exchange_closed).
      // Fall back to 'unknown' for old records that predate the exitType field.
      const exitType = r.exitType ?? 'unknown';
      const origin = r.decisionOrigin ?? 'unknown';
      const key = `${exitType}__${origin}`;

      let g = groups.get(key);
      if (!g) {
        g = { count: 0, wins: 0, losses: 0, netPnl: 0, totalHold: 0 };
        groups.set(key, g);
      }
      g.count++;
      if (r.outcome === 'WIN') g.wins++;
      else g.losses++;
      g.netPnl += r.pnl;
      g.totalHold += r.holdMin;
    }

    const stats: CloseReasonStat[] = [];
    for (const [key, g] of groups) {
      const [exitType, decisionOrigin] = key.split('__') as [string, string];
      stats.push({
        exitType,
        decisionOrigin,
        count: g.count,
        wins: g.wins,
        losses: g.losses,
        netPnl: g.netPnl,
        winRate: g.count > 0 ? g.wins / g.count : 0,
        avgHoldMin: g.count > 0 ? g.totalHold / g.count : 0,
        avgPnlPerTrade: g.count > 0 ? g.netPnl / g.count : 0,
      });
    }

    // Sort by count desc
    stats.sort((a, b) => b.count - a.count);
    return stats;
  }

  formatBlock(records: ThesisExperienceRecord[]): string {
    const stats = this.aggregate(records);
    if (stats.length === 0) return '';

    const lines: string[] = [];
    lines.push(`=== CLOSE REASON PERFORMANCE (from ${records.length} closed trades) ===`);

    for (const s of stats) {
      const icon = s.winRate >= 0.6 ? '✅' : s.winRate <= 0.3 ? '🔴' : '🟡';
      const pnlStr = s.netPnl >= 0 ? '+' + s.netPnl.toFixed(2) : s.netPnl.toFixed(2);
      const label = `${s.exitType} (${s.decisionOrigin})`;
      lines.push(
        `${icon} ${label.padEnd(35)} W${s.wins} L${s.losses}  ${pnlStr}  (${(s.winRate * 100).toFixed(0)}%, avg ${s.avgHoldMin.toFixed(0)}min)`,
      );
    }

    // Add summary insights
    const prematureLosses = stats.filter(
      (s) => (s.exitType === 'premature_sl' || s.exitType === 'thesis_invalidated' || s.exitType === 'manual_close') && s.winRate < 0.3,
    );
    if (prematureLosses.length > 0) {
      const totalPrematurePnl = prematureLosses.reduce((sum, s) => sum + s.netPnl, 0);
      const totalPrematureCount = prematureLosses.reduce((sum, s) => sum + s.count, 0);
      lines.push('');
      lines.push(`  ⚠️ Premature closes cost ${totalPrematurePnl.toFixed(2)} across ${totalPrematureCount} trades. Set SL at REAL S/R levels.`);
    }

    const goodCloses = stats.filter((s) => s.exitType === 'correct_tp' && s.winRate >= 0.8);
    if (goodCloses.length > 0) {
      lines.push(`  ✅ Letting TP at S/R work is profitable. Do NOT close manually before TP.`);
    }

    lines.push('---');
    return lines.join('\n');
  }
}

// ─── v2.0.214: Softmax-weighted aggregate for SimilarTradeRetriever ────────
//
// K.md #4 transfer to RIL: instead of equal-weight win rate (each similar
// trade = 1/N), weight each trade by softmax(similarity / temperature) so
// high-similarity trades contribute more. K3 ablation: softmax > sigmoid
// (competitive normalization forces sharper selection).
//
// Numerically stable (max-subtraction). Handles NaN/Infinity in similarity
// by clamping to finite range. Returns 0.5 WR for empty input.

/**
 * @param similar - Array of { similarity, isWin, pnl } objects
 * @param temperature - Softmax temperature (default 0.1). Lower = sharper.
 *   Clamped to minimum 1e-4 to prevent division by zero.
 * @returns weightedWR, weightedAvgPnl, rawWR, rawAvgPnl, maxWeight
 */
export function softmaxWeightedSimilarAggregate(
  similar: Array<{ similarity: number; isWin: boolean; pnl: number }>,
  temperature: number = 0.1,
): { weightedWR: number; weightedAvgPnl: number; rawWR: number; rawAvgPnl: number; maxWeight: number } {
  const n = similar.length;
  if (n === 0) {
    return { weightedWR: 0.5, weightedAvgPnl: 0, rawWR: 0.5, rawAvgPnl: 0, maxWeight: 0 };
  }
  if (n === 1) {
    const wr = similar[0]!.isWin ? 1 : 0;
    return { weightedWR: wr, weightedAvgPnl: similar[0]!.pnl, rawWR: wr, rawAvgPnl: similar[0]!.pnl, maxWeight: 1 };
  }

  // Clamp temperature to prevent division by zero. Use abs() so negative
  // temperatures are treated as positive (negative τ inverts the weighting,
  // which is meaningless for similarity-based retrieval).
  const tau = Math.max(Math.abs(temperature), 1e-4);

  // Compute logits. No clamping needed — max-subtraction below ensures
  // numerical stability (exp(l - max) is always ≤ 1, underflow to 0 is safe).
  // Non-finite sims: NaN -> 0 (neutral), Infinity -> 1 (max sim),
  // -Infinity -> -1 (min sim). Assumes similarity in [-1, 1] (cosine range).
  const logits = similar.map((s) => {
    let sim = s.similarity;
    if (!Number.isFinite(sim)) {
      if (sim === Infinity) sim = 1;
      else if (sim === -Infinity) sim = -1;
      else sim = 0; // NaN
    }
    return sim / tau;
  });

  // Numerically stable softmax (max-subtraction)
  let maxLogit = -Infinity;
  for (const l of logits) if (l > maxLogit) maxLogit = l;
  if (!Number.isFinite(maxLogit)) maxLogit = 0;

  let sumExp = 0;
  const exps = logits.map((l) => {
    const e = Math.exp(l - maxLogit);
    sumExp += e;
    return e;
  });

  if (sumExp <= 0 || !Number.isFinite(sumExp)) {
    // Degenerate: all logits overflow or all NaN. Fall back to equal weight.
    const rawWins = similar.filter((s) => s.isWin).length;
    const rawWR = rawWins / n;
    const rawAvgPnl = similar.reduce((sum, s) => sum + s.pnl, 0) / n;
    return { weightedWR: rawWR, weightedAvgPnl: rawAvgPnl, rawWR, rawAvgPnl, maxWeight: 1 / n };
  }

  // Weighted WR + PnL
  let weightedWR = 0;
  let weightedAvgPnl = 0;
  let maxWeight = 0;
  for (let i = 0; i < n; i++) {
    const w = exps[i]! / sumExp;
    if (w > maxWeight) maxWeight = w;
    if (similar[i]!.isWin) weightedWR += w;
    weightedAvgPnl += w * similar[i]!.pnl;
  }

  // Raw stats for comparison
  const rawWins = similar.filter((s) => s.isWin).length;
  const rawWR = rawWins / n;
  const rawAvgPnl = similar.reduce((sum, s) => sum + s.pnl, 0) / n;

  return {
    weightedWR: Math.max(0, Math.min(1, weightedWR)),
    weightedAvgPnl,
    rawWR,
    rawAvgPnl,
    maxWeight,
  };
}

// ═══════════════════════════════════════════════════════════════
//  SimilarTradeRetriever
// ═══════════════════════════════════════════════════════════════

/**
 * Retrieves the top-N most similar past trades to a candidate proposal,
 * using combinationSimilarity on rationale vectors.
 */
export class SimilarTradeRetriever {
  /** v2.0.215: Optional AttnRes trade embedder for learned rationale blending. */
  private attnResEmbedder: AttnResTradeEmbedder | null = null;

  /** v2.0.215: Inject AttnRes embedder. When set, findSimilar blends rationale
   *  vectors via learned softmax attention instead of combinationSimilarity. */
  setAttnResTradeEmbedder(e: AttnResTradeEmbedder | null): void {
    this.attnResEmbedder = e;
  }

  /** v2.0.215: Get the AttnRes embedder (for index.ts to access). */
  getAttnResTradeEmbedder(): AttnResTradeEmbedder | null {
    return this.attnResEmbedder;
  }
  findSimilar(
    candidateVectors: number[][],
    records: ThesisExperienceRecord[],
    topN: number = 5,
    excludeIds?: Set<string>,
    /** v2.0.176: Filter by direction — a SELL candidate should only match
     *  historical SELL trades, not BUY trades. Without this, BUY wins inflate
     *  the similar-trade win rate and mislead Skeptics into approving bad SELLs. */
    side?: 'buy' | 'sell',
  ): SimilarTradeResult[] {
    if (candidateVectors.length === 0 || records.length === 0) return [];

    const scored: SimilarTradeResult[] = [];

    // v2.0.215: AttnRes blend path — blend candidate + historical rationale
    // vectors via learned softmax attention, then cosine compare blended vectors.
    // Cold-start safe: w=0 → uniform → mean ≈ combinationSimilarity behavior.
    if (this.attnResEmbedder) {
      const candBlended = this.attnResEmbedder.blend(candidateVectors);
      if (candBlended.length === 0) return [];
      for (const rec of records) {
        if (excludeIds?.has(rec.id)) continue;
        if (rec.rationaleVectors.length === 0) continue;
        if (side && rec.side !== side) continue;
        const histBlended = this.attnResEmbedder.blend(rec.rationaleVectors);
        if (histBlended.length === 0) continue;
        const sim = cosine(candBlended, histBlended);
        if (sim > 0) {
          scored.push({ trade: rec, similarity: sim });
        }
      }
    } else {
      // Default path: combinationSimilarity (backward compatible)
      for (const rec of records) {
        if (excludeIds?.has(rec.id)) continue;
        if (rec.rationaleVectors.length === 0) continue;
        if (side && rec.side !== side) continue;
        const sim = combinationSimilarity(candidateVectors, rec.rationaleVectors, 'asymmetric');
        if (sim > 0) {
          scored.push({ trade: rec, similarity: sim });
        }
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topN);
  }

  formatBlock(similar: SimilarTradeResult[], proposalSide: string, proposalSymbol: string): string {
    if (similar.length === 0) return '';

    const lines: string[] = [];
    lines.push(`=== SIMILAR TRADES TO YOUR PROPOSED ${proposalSide.toUpperCase()} ${proposalSymbol} ===`);

    for (let i = 0; i < similar.length; i++) {
      const s = similar[i]!;
      const icon = s.trade.outcome === 'WIN' ? '✅' : '❌';
      const simPct = (s.similarity * 100).toFixed(0);
      const pnlStr = s.trade.pnl >= 0 ? '+' + s.trade.pnl.toFixed(3) : s.trade.pnl.toFixed(3);
      const thesis = s.trade.entryThesis.length > 80
        ? s.trade.entryThesis.slice(0, 80) + '…'
        : s.trade.entryThesis;
      lines.push(
        `  #${i + 1}: ${s.trade.side.toUpperCase()} ${s.trade.symbol} (${simPct}%) ${icon} ${pnlStr} (${s.trade.holdMin}min) — "${thesis}"`,
      );
    }

    // v2.0.214: Softmax-weighted aggregate stats (K.md #4 transfer to RIL).
    // High-similarity trades weight more than low-similarity ones.
    // Shows both raw (equal-weight) and sim-weighted for comparison.
    const agg = softmaxWeightedSimilarAggregate(
      similar.map((s) => ({ similarity: s.similarity, isWin: s.trade.outcome === 'WIN', pnl: s.trade.pnl })),
    );
    const wins = similar.filter((s) => s.trade.outcome === 'WIN').length;
    const losses = similar.length - wins;
    const rawWRPct = (agg.rawWR * 100).toFixed(0);
    const weightedWRPct = (agg.weightedWR * 100).toFixed(0);
    const rawAvgPnlStr = agg.rawAvgPnl >= 0 ? '+' + agg.rawAvgPnl.toFixed(3) : agg.rawAvgPnl.toFixed(3);
    const weightedAvgPnlStr = agg.weightedAvgPnl >= 0 ? '+' + agg.weightedAvgPnl.toFixed(3) : agg.weightedAvgPnl.toFixed(3);

    // Show both metrics when they differ significantly (otherwise just raw)
    const wrDiff = Math.abs(agg.weightedWR - agg.rawWR);
    if (wrDiff > 0.05) {
      lines.push(`  → Similar trades: ${wins}/${similar.length} won (${rawWRPct}% raw, ${weightedWRPct}% sim-weighted), avg ${rawAvgPnlStr} raw / ${weightedAvgPnlStr} sim-weighted`);
    } else {
      lines.push(`  → Similar trades: ${wins}/${similar.length} won (${rawWRPct}%), avg ${rawAvgPnlStr}`);
    }

    lines.push('---');
    return lines.join('\n');
  }
}

// ═══════════════════════════════════════════════════════════════
//  SubtleDiffAnalyzer
// ═══════════════════════════════════════════════════════════════

/**
 * Analyzes subtle differences between a current proposal and its most similar
 * past trades. Uses 1 LLM call per cycle (not per trade).
 */
export class SubtleDiffAnalyzer {
  private readonly cfg: RILConfig;

  constructor(cfg?: Partial<RILConfig>) {
    this.cfg = {
      enabled: config.ril.enabled,
      clusterThreshold: config.ril.clusterThreshold,
      minClusterSize: config.ril.minClusterSize,
      maxPatternsDisplay: config.ril.maxPatternsDisplay,
      similarTradeCount: config.ril.similarTradeCount,
      subtleDiffEnabled: config.ril.subtleDiffEnabled,
      rebuildOnStartup: config.ril.rebuildOnStartup,
      maxClusters: config.ril.maxClusters,
      ...cfg,
    };
  }

  /**
   * Analyze subtle differences between the current proposal and similar past trades.
   * @param proposalThesis - The current entry thesis
   * @param proposalSide - buy/sell
   * @param proposalSymbol - e.g. BTC
   * @param similarTrades - Top-N similar past trades
   * @param llmChat - LLM chat function
   * @returns Analysis text, or empty string if disabled or no similar trades
   */
  async analyze(
    proposalThesis: string,
    proposalSide: string,
    proposalSymbol: string,
    similarTrades: SimilarTradeResult[],
    llmChat: (messages: Array<{ role: string; content: string }>, opts?: { temperature?: number; timeoutMs?: number }) => Promise<string>,
  ): Promise<string> {
    if (!this.cfg.subtleDiffEnabled || similarTrades.length === 0) return '';

    try {
      const winners = similarTrades.filter((s) => s.trade.outcome === 'WIN').slice(0, 3);
      const losers = similarTrades.filter((s) => s.trade.outcome === 'LOSS').slice(0, 2);

      const similarBlock = similarTrades.map((s, i) => {
        const tag = s.trade.outcome === 'WIN' ? 'WON' : 'LOSS';
        return `  #${i + 1}: ${s.trade.side.toUpperCase()} ${s.trade.symbol} (sim ${(s.similarity * 100).toFixed(0)}%) — ${tag} ${s.trade.pnl >= 0 ? '+' : ''}${s.trade.pnl.toFixed(3)} — thesis: "${s.trade.entryThesis.slice(0, 120)}"`;
      }).join('\n');

      const prompt = `Proposed: ${proposalSide.toUpperCase()} ${proposalSymbol}
Thesis: "${proposalThesis}"

Similar past trades:
${similarBlock}

Analyze the SUBTLE DIFFERENCES between the proposed trade and the past winners/losers.
Focus on: volume, RSI, regime, macro backdrop, price level relative to S/R, market structure.

Answer in 2-3 sentences:
1. What do the winners have in common that the losers don't?
2. What is DIFFERENT this time vs the winners? Do these differences matter?
3. Is the proposed trade more like the winners or the losers?`;

      const response = await llmChat([
        {
          role: 'system',
          content: 'You analyze subtle differences between a proposed trade and its most similar historical trades. Be concise and specific. Focus on concrete differences (volume, RSI, regime, S/R proximity), not generic statements.',
        },
        { role: 'user', content: prompt },
      ], { temperature: 0, timeoutMs: 25_000 });

      const analysis = response.trim();
      if (analysis.length < 10) return '';

      const lines: string[] = [];
      lines.push('=== SUBTLE DIFFERENCES ANALYSIS ===');
      lines.push(analysis);
      lines.push('---');
      return lines.join('\n');
    } catch (err) {
      log.warn(`[RIL] SubtleDiffAnalyzer failed: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  formatAnalyticsBlock — combines all 4 blocks
// ═══════════════════════════════════════════════════════════════

/**
 * Formats the complete analytics block for agent context injection.
 * Combines up to 4 data sources:
 *   1. RIL Entry Pattern Map (primary structured data)
 *   2. RIL Close Reason Stats (primary structured data)
 *   3. RIL Similar Trades + Subtle Differences (primary retrieval + LLM)
 *   4. EXP Verdict (kept as reference, not gate)
 *   5. A2A Digester Digest (kept as supplementary LLM analysis)
 */
export function formatAnalyticsBlock(params: {
  patternMap: string;
  closeReasonBlock: string;
  similarTradesBlock: string;
  subtleDiffBlock: string;
  expVerdictBlock: string;
  digesterDigest: string;
}): string {
  const blocks: string[] = [];

  if (params.patternMap) blocks.push(params.patternMap);
  if (params.closeReasonBlock) blocks.push(params.closeReasonBlock);
  if (params.similarTradesBlock) blocks.push(params.similarTradesBlock);
  if (params.subtleDiffBlock) blocks.push(params.subtleDiffBlock);
  if (params.expVerdictBlock) blocks.push(params.expVerdictBlock);
  if (params.digesterDigest) blocks.push(params.digesterDigest);

  if (blocks.length === 0) return '';

  return '\n' + blocks.join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════════════
//  EXP Verdict formatter (kept as reference, not gate)
// ═══════════════════════════════════════════════════════════════

/**
 * Formats the EXP checkThesisHistory verdict as a reference block for Meta-Agent.
 * This is NOT a gate — Meta-Agent sees the verdict but makes its own decision.
 */
export function formatExpVerdictBlock(
  verdict: string,
  pWin?: number,
  reason?: string,
  olrPWin?: number,
  shadowWR?: number,
): string {
  const lines: string[] = [];
  lines.push('=== EXP VERDICT (reference — not a gate) ===');

  const icon = verdict === 'FAST_APPROVE' ? '🟢' :
    verdict === 'REJECT' ? '🔴' :
    verdict === 'REVERSE_DIRECTION' ? '🟠' : '⚪';
  lines.push(`  ${icon} Verdict: ${verdict}`);
  if (pWin !== undefined) lines.push(`  Historical P(win): ${(pWin * 100).toFixed(0)}%`);
  if (reason) lines.push(`  Reason: ${reason}`);

  // Dual-Channel Fusion info
  if (olrPWin !== undefined || shadowWR !== undefined) {
    const parts: string[] = [];
    if (olrPWin !== undefined) parts.push(`OLR P(win)=${(olrPWin * 100).toFixed(0)}%`);
    if (shadowWR !== undefined) parts.push(`Shadow WR=${(shadowWR * 100).toFixed(0)}%`);
    lines.push(`  Fusion: ${parts.join(', ')}`);
  }

  lines.push('  → This is REFERENCE data. Meta-Agent makes the final decision.');
  lines.push('---');
  return lines.join('\n');
}
