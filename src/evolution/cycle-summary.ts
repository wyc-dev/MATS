// ─── CycleSummary Manager ───
// Manages the EM loop's bridge — stores, formats, and tracks convergence
// of the Meta-Agent's distilled key insights across cycles.
//
// E-step: Meta-Agent produces CycleSummary after arbitration
// M-step: This manager feeds previous summaries into next cycle's context
// Convergence: Skeptics cross-check keyInsight vs actual price action

import { createLogger } from '../observability/logger.ts';
import type {
  CycleSummary,
  EMState,
  PrimarySignal,
  CycleDelta,
  LatentStateConfidence,
  CycleConvergence,
} from '../types/index.ts';

const log = createLogger({ phase: 'em_cycle' });

// ─── Config — Tiered Memory Strategy ───
//
// Hot tier (last 12 cycles, ~1hr):    Always kept in full detail
// Warm tier (last 288 cycles, ~24hr):  Pruned by importance when over limit
// Cold tier (>24hr):                   Compacted into epoch aggregates
// Total max memory: ~450 summaries + ~50 epochs = ~500 entries
// Context injection: always only last 3 (token-efficient)

const CONFIG = {
  /** Hot tier: always keep last N cycles in full detail */
  hotRetentionCount: 12,
  /** Warm tier: max summaries before importance pruning */
  warmMaxCount: 288, // ~24hr at 5min/cycle
  /** Cold tier: max epochs after compaction */
  coldMaxCount: 48,  // ~48 days at 24hr/epoch
  /** How many previous summaries to inject into agent context */
  contextInjectCount: 3,
  /** Convergence accuracy decay half-life (cycles) */
  accuracyHalfLife: 20,
  /** Compaction ratio: N warm summaries → 1 cold epoch */
  compactionRatio: 12, // 1 epoch per hour
  /** How often to check compaction (cycles) */
  compactionInterval: 24, // check every 2 hours
} as const;

// ─── Compacted Epoch (cold tier) ───

interface CompactedEpoch {
  type: 'epoch';
  /** Range of cycles covered */
  startCycle: number;
  endCycle: number;
  /** Number of original summaries in this epoch */
  count: number;
  /** Aggregated stats */
  avgRegimeConfidence: number;
  avgTrendConfidence: number;
  avgDataQuality: number;
  /** Dominant signal name (mode) */
  dominantSignal: string;
  /** Average signal value */
  signalValueAvg: number;
  /** Convergence accuracy within this period */
  convergenceAccuracy: number;
  /** How many anomalies detected */
  anomalyCount: number;
  /** Timestamp range */
  startTimestamp: number;
  endTimestamp: number;
  /** Key insights from this epoch (keep best 2) */
  representativeInsights: string[];
}

// ─── Utility: mode of an array (most frequent item) ───

function modeOf(arr: string[]): string {
  const freq = new Map<string, number>();
  for (const item of arr) {
    freq.set(item, (freq.get(item) ?? 0) + 1);
  }
  let best = arr[0] ?? 'unknown';
  let bestCount = 0;
  for (const [item, count] of freq) {
    if (count > bestCount) { best = item; bestCount = count; }
  }
  return best;
}

// ─── Defaults ───

function defaultPrimarySignal(): PrimarySignal {
  return { name: 'none', value: 0, direction: 'neutral' };
}

function defaultDelta(): CycleDelta {
  return { exists: false, metric: 'none', from: null, to: null, significance: 'none' };
}

function defaultLatentState(): LatentStateConfidence {
  return { regimeConfidence: 0.5, trendConfidence: 0.5, dataQuality: 0.5, anomalyDetected: false };
}

function defaultConvergence(): CycleConvergence {
  return { agentAgreement: 0.5, skepticsApproved: true, metaOverride: false };
}

// ─── Manager ───

export class CycleSummaryManager {
  /** Hot + warm summaries (full detail) */
  private summaries: CycleSummary[] = [];
  /** Cold epochs (compacted aggregates) */
  private epochs: CompactedEpoch[] = [];
  private convergenceAccuracy = 0.5;
  private convergenceChecks = 0;
  /** Track compaction schedule */
  private cyclesSinceCompaction = 0;

  /** Load from persisted EMState */
  load(state: EMState): void {
    this.summaries = state.summaries ?? [];
    this.convergenceAccuracy = state.convergenceAccuracy ?? 0.5;
    this.convergenceChecks = state.convergenceChecks ?? 0;
    log.info(`CycleSummaryManager loaded: ${this.summaries.length} summaries, ${this.epochs.length} epochs, accuracy ${(this.convergenceAccuracy * 100).toFixed(1)}%`);
  }

  /** Get serializable state for persistence */
  getState(): EMState {
    // Only persist hot tier + important warm summaries + epochs
    const hotCount = Math.min(CONFIG.hotRetentionCount, this.summaries.length);
    const warmStart = this.summaries.length - hotCount;
    // Keep hot (always) + best warm summaries up to warmMaxCount
    const keepCount = Math.min(CONFIG.warmMaxCount, this.summaries.length);
    const keepFrom = Math.max(0, this.summaries.length - keepCount);
    return {
      summaries: this.summaries.slice(keepFrom),
      convergenceAccuracy: this.convergenceAccuracy,
      convergenceChecks: this.convergenceChecks,
    };
  }

  /** Push a new CycleSummary — adds to chain, auto-prunes when full */
  push(summary: CycleSummary): void {
    if (!summary.keyInsight || summary.keyInsight.trim().length === 0) {
      log.warn(`[push] Empty keyInsight for cycle ${summary.cycleNumber} — skipping`);
      return;
    }
    this.summaries.push(summary);

    // Check compaction threshold: when warm tier exceeds limit, compact oldest into epochs
    this.cyclesSinceCompaction++;
    if (this.cyclesSinceCompaction >= CONFIG.compactionInterval && this.summaries.length > CONFIG.warmMaxCount) {
      this.compactOldest();
      this.cyclesSinceCompaction = 0;
    } else if (this.summaries.length > CONFIG.warmMaxCount + CONFIG.hotRetentionCount) {
      // Emergency prune: just drop lowest-importance from warm zone
      this.pruneByImportance();
    }

    log.info(`Cycle #${summary.cycleNumber} | mem:${this.summaries.length}sm+${this.epochs.length}ep | insight: "${summary.keyInsight.slice(0, 60)}..." | signal: ${summary.primarySignal.name}=${summary.primarySignal.value} (${summary.primarySignal.direction}) | delta: ${summary.delta.exists ? summary.delta.metric + ' ' + summary.delta.significance : 'none'} | conf: ${(summary.latentState.regimeConfidence * 100).toFixed(0)}%`);
  }

  /** Get the last N summaries (from hot + warm tiers) */
  getLast(n: number): CycleSummary[] {
    return this.summaries.slice(-Math.min(n, this.summaries.length));
  }

  /** Get summaries + epochs for broad-range queries */
  getAll(): { summaries: CycleSummary[]; epochs: CompactedEpoch[] } {
    return { summaries: this.summaries, epochs: this.epochs };
  }

  /** Get the most recent summary (null if empty) */
  getLatest(): CycleSummary | null {
    return this.summaries.length > 0 ? this.summaries[this.summaries.length - 1]! : null;
  }

  /** Total summaries tracked */
  get length(): number {
    return this.summaries.length;
  }

  /** Total epochs tracked */
  get epochCount(): number {
    return this.epochs.length;
  }

  // ─── Tiered Pruning ───

  /**
   * Compute importance score for a summary.
   * Higher = more worth keeping.
   */
  private computeImportance(s: CycleSummary): number {
    let score = 10; // base
    // Anomalies are highly informative
    if (s.latentState.anomalyDetected) score += 30;
    // Contested cycles (Skeptics disagreed)
    if (!s.convergence.skepticsApproved) score += 20;
    // Regime transitions / high delta significance
    if (s.delta.significance === 'high') score += 20;
    // Meta-agent had to override
    if (s.convergence.metaOverride) score += 15;
    // Low agreement = interesting
    if (s.convergence.agentAgreement < 0.3) score += 10;
    // High data quality = more reliable
    score += s.latentState.dataQuality * 10;
    // Strong directional signal = more informative
    if (s.primarySignal.direction !== 'neutral') score += 5;
    // Recency bonus (linear: last 50 cycles get up to +10)
    return score;
  }

  /**
   * Prune warm zone: keep hot (always) + best warm by importance.
   */
  private pruneByImportance(): void {
    if (this.summaries.length <= CONFIG.warmMaxCount) return;

    // Keep hot zone intact
    const hotCount = Math.min(CONFIG.hotRetentionCount, this.summaries.length);
    const hotStart = this.summaries.length - hotCount;
    const hot: CycleSummary[] = this.summaries.slice(hotStart);
    const warm: CycleSummary[] = this.summaries.slice(0, hotStart);

    // Score warm summaries, keep top (warmMaxCount - hotRetentionCount)
    const scored = warm.map(s => ({ summary: s, score: this.computeImportance(s) }));
    scored.sort((a, b) => b.score - a.score);

    const keepWarmCount = Math.max(0, CONFIG.warmMaxCount - hotCount);
    const pruned = scored.slice(0, keepWarmCount).map(s => s.summary);
    pruned.sort((a, b) => a.cycleNumber - b.cycleNumber);

    this.summaries = [...pruned, ...hot];
    log.info(`[prune] Warm zone: ${warm.length} → ${pruned.length} (kept top ${keepWarmCount} by importance)`);
  }

  /**
   * Compact the oldest warm summaries into a single epoch.
   * Moves oldest `compactionRatio` summaries out of warm into cold epoch storage.
   */
  private compactOldest(): void {
    const hotCount = Math.min(CONFIG.hotRetentionCount, this.summaries.length);
    const hotStart = this.summaries.length - hotCount;
    const hot = this.summaries.slice(hotStart);
    const warm = this.summaries.slice(0, hotStart);

    if (warm.length < CONFIG.compactionRatio) return;

    // Take oldest `compactionRatio` summaries and compact into epoch
    const compactBatch = warm.splice(0, CONFIG.compactionRatio);

    const epoch: CompactedEpoch = {
      type: 'epoch',
      startCycle: compactBatch[0]!.cycleNumber,
      endCycle: compactBatch[compactBatch.length - 1]!.cycleNumber,
      count: compactBatch.length,
      avgRegimeConfidence: compactBatch.reduce((s, c) => s + c.latentState.regimeConfidence, 0) / compactBatch.length,
      avgTrendConfidence: compactBatch.reduce((s, c) => s + c.latentState.trendConfidence, 0) / compactBatch.length,
      avgDataQuality: compactBatch.reduce((s, c) => s + c.latentState.dataQuality, 0) / compactBatch.length,
      dominantSignal: modeOf(compactBatch.map(c => c.primarySignal.name)),
      signalValueAvg: compactBatch.reduce((s, c) => s + c.primarySignal.value, 0) / compactBatch.length,
      convergenceAccuracy: compactBatch.filter(c => c.convergence.skepticsApproved).length / compactBatch.length,
      anomalyCount: compactBatch.filter(c => c.latentState.anomalyDetected).length,
      startTimestamp: compactBatch[0]!.timestamp,
      endTimestamp: compactBatch[compactBatch.length - 1]!.timestamp,
      representativeInsights: compactBatch
        .sort((a, b) => this.computeImportance(b) - this.computeImportance(a))
        .slice(0, 2)
        .map(s => s.keyInsight),
    };

    this.epochs.push(epoch);
    if (this.epochs.length > CONFIG.coldMaxCount) {
      this.epochs.splice(0, this.epochs.length - CONFIG.coldMaxCount);
    }

    this.summaries = [...warm, ...hot];
    log.info(`[compact] Cycles ${epoch.startCycle}-${epoch.endCycle} → epoch (${compactBatch.length} summaries, signal=${epoch.dominantSignal}, accuracy=${(epoch.convergenceAccuracy * 100).toFixed(0)}%)`);
  }

  /** Format last N summaries for agent context injection (M-step immediate) */
  formatForContext(count: number = CONFIG.contextInjectCount): string {
    const recent = this.getLast(count);
    if (recent.length === 0) return '';

    const lines: string[] = [];
    lines.push('=== EM CYCLE CHAIN (Last ' + recent.length + ' cycles) ===');
    lines.push('The Meta-Agent\'s distilled key insights from recent cycles.');
    lines.push('Use this to maintain continuity — reference the previous insight when forming your own.\n');

    for (const s of recent) {
      const date = new Date(s.timestamp).toISOString().replace('T', ' ').slice(0, 19);
      const arrow = s.primarySignal.direction === 'bullish' ? '🟢' : s.primarySignal.direction === 'bearish' ? '🔴' : '⚪';
      lines.push(`  Cycle #${s.cycleNumber} [${date}]`);
      lines.push(`    Insight: "${s.keyInsight}"`);
      lines.push(`    Signal: ${arrow} ${s.primarySignal.name}=${s.primarySignal.value.toFixed(4)}`);
      if (s.delta.exists && s.delta.significance !== 'none') {
        const d = s.delta;
        const dArrow = d.significance === 'high' ? '⚠️' : '→';
        lines.push(`    Delta: ${dArrow} ${d.metric}: ${d.from?.toFixed(4) ?? 'N/A'} → ${d.to?.toFixed(4) ?? 'N/A'} (${d.significance})`);
      }
      lines.push(`    Regime: ${(s.latentState.regimeConfidence * 100).toFixed(0)}% | Trend: ${(s.latentState.trendConfidence * 100).toFixed(0)}% | Agreement: ${(s.convergence.agentAgreement * 100).toFixed(0)}% | Quality: ${(s.latentState.dataQuality * 100).toFixed(0)}%`);
      lines.push('');
    }

    if (this.convergenceChecks > 0) {
      lines.push(`  Convergence accuracy (last ${this.convergenceChecks} checks): ${(this.convergenceAccuracy * 100).toFixed(1)}%`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  /** Format as a compact single-line string for debug logging */
  formatCompact(): string {
    const latest = this.getLatest();
    if (!latest) return 'no summaries';
    return `[#${latest.cycleNumber}] "${latest.keyInsight.slice(0, 40)}..." | ${latest.primarySignal.name}=${latest.primarySignal.value.toFixed(2)} (${latest.primarySignal.direction}) | conf:${(latest.latentState.regimeConfidence * 100).toFixed(0)}% | acc:${(this.convergenceAccuracy * 100).toFixed(0)}% | mem:${this.summaries.length}sm+${this.epochs.length}ep`;
  }

  // ─── Convergence Tracking (M-step) ───

  /**
   * Update convergence accuracy based on whether the previous cycle's
   * keyInsight was consistent with actual price direction.
   * Called at the END of each cycle when we know the outcome.
   *
   * @param actualDirection - actual price direction since last cycle
   * @returns accuracy after update
   */
  updateConvergence(actualDirection: 'up' | 'down' | 'flat'): number {
    const prev = this.summaries[this.summaries.length - 2]; // the one BEFORE current
    if (!prev) return this.convergenceAccuracy;

    // Determine if insight predicted the direction correctly
    let correct = false;
    if (actualDirection === 'flat') {
      // Flat market — neutral insight is correct
      correct = prev.primarySignal.direction === 'neutral';
    } else if (actualDirection === 'up') {
      correct = prev.primarySignal.direction === 'bullish';
    } else {
      correct = prev.primarySignal.direction === 'bearish';
    }

    this.convergenceChecks++;
    // Exponential moving update: recent checks weighted more
    const decay = Math.pow(0.5, 1 / CONFIG.accuracyHalfLife);
    this.convergenceAccuracy = this.convergenceAccuracy * decay + (correct ? 1 : 0) * (1 - decay);

    if (this.convergenceChecks % 5 === 0) {
      log.info(`Convergence accuracy: ${(this.convergenceAccuracy * 100).toFixed(1)}% after ${this.convergenceChecks} checks (last: ${correct ? '✅' : '❌'})`);
    }

    return this.convergenceAccuracy;
  }

  /**
   * Get convergence trend description for Skeptics audit context.
   */
  getConvergenceTrend(): { accuracy: number; checks: number; trend: 'improving' | 'stable' | 'declining'; warnings: string[] } {
    const warnings: string[] = [];

    if (this.convergenceAccuracy < 0.3 && this.convergenceChecks >= 5) {
      warnings.push(`⚠️ Low convergence accuracy (${(this.convergenceAccuracy * 100).toFixed(0)}%) — Meta-Agent's keyInsight may be unreliable`);
    }

    // Simple trend: compare recent accuracy vs long-term
    const recent = this.getLast(10);
    if (recent.length >= 6) {
      const recentHits = recent.filter(s => s.convergence.skepticsApproved).length;
      const recentRate = recentHits / recent.length;
      if (recentRate < 0.4 && recent.length >= 10) {
        warnings.push(`⚠️ Skeptics approving only ${(recentRate * 100).toFixed(0)}% of recent cycles — agent consensus quality declining`);
      }
    }

    const trend: 'improving' | 'stable' | 'declining' =
      this.convergenceAccuracy > 0.6 ? 'improving' :
      this.convergenceAccuracy > 0.35 ? 'stable' : 'declining';

    return {
      accuracy: this.convergenceAccuracy,
      checks: this.convergenceChecks,
      trend,
      warnings,
    };
  }

  // ─── Factory: Build CycleSummary from Meta-Agent output ───

  /**
   * Build a CycleSummary from the Meta-Agent's arbitration result.
   * This is the E-step output — the compressed latent state.
   *
   * @param cycleNumber  — current cycle number
   * @param metaThought  — Meta-Agent's thought text
   * @param metaConfidence — Meta-Agent's overall confidence
   * @param metaDecision — Meta-Agent's final decision
   * @param prevSummary  — previous cycle's summary (for delta calculation)
   * @param skepticsApproved — whether Skeptics approved this cycle
   * @param regimeConfidence — current regime confidence (from HMM or agent)
   */
  static buildSummary(
    cycleNumber: number,
    metaThought: string,
    metaConfidence: number,
    metaDecision: { action: string; positionSizePct: number; rationale: string },
    prevSummary: CycleSummary | null,
    skepticsApproved: boolean,
    agentAgreement: number,
    regimeConfidence: number,
    trendConfidence: number,
  ): CycleSummary {
    // Extract key insight from the first substantive sentence of meta thought
    const keyInsight = extractKeyInsight(metaThought, metaDecision);

    // Determine primary signal from decision + thought context
    const primarySignal = extractPrimarySignal(metaThought, metaDecision);

    // Calculate delta vs previous cycle
    const delta = computeDelta(primarySignal, prevSummary);

    // Estimate data quality from confidence + agreement
    const dataQuality = Math.min(1, (metaConfidence * 0.4 + agentAgreement * 0.3 + (skepticsApproved ? 0.3 : 0)));

    // Anomaly detection: decision contradicts regime confidence
    const anomalyDetected = detectAnomaly(metaDecision, regimeConfidence, metaConfidence);

    return {
      cycleNumber,
      timestamp: Date.now(),
      keyInsight,
      primarySignal,
      delta,
      latentState: {
        regimeConfidence,
        trendConfidence,
        dataQuality: Math.round(dataQuality * 100) / 100,
        anomalyDetected,
      },
      convergence: {
        agentAgreement: Math.round(agentAgreement * 100) / 100,
        skepticsApproved,
        metaOverride: metaDecision.action !== 'hold' && agentAgreement < 0.4,
      },
    };
  }
}

// ─── Extraction Helpers ───

function extractKeyInsight(thought: string, decision: { action: string; positionSizePct: number; rationale: string }): string {
  // First try: extract the first substantive sentence (not "I think", "Based on", etc.)
  const cleaned = thought
    .replace(/^(I\s+(think|believe|see|observe)\s+(that\s+)?)/i, '')
    .replace(/^(Based\s+on\s+my\s+analysis[.,])/i, '')
    .trim();

  // Take the first sentence up to ~120 chars
  const match = cleaned.match(/^([^.!?\n]{10,120}[.!?])/);
  if (match) return match[1]!.trim();

  // Fallback: use rationale
  if (decision.rationale && decision.rationale.length > 10) {
    return decision.rationale.split(/[.!?]/)[0]!.trim() + '.';
  }

  // Last fallback: describe the decision
  const actionLabel = decision.action === 'buy' ? 'Bullish' : decision.action === 'sell' ? 'Bearish' : 'Neutral';
  return `${actionLabel} stance with ${(decision.positionSizePct * 100).toFixed(1)}% conviction.`;
}

function extractPrimarySignal(
  thought: string,
  decision: { action: string; positionSizePct: number; rationale: string },
): PrimarySignal {
  // Look for signal keywords in thought + rationale
  const text = (thought + ' ' + decision.rationale).toLowerCase();
  const direction = decision.action === 'buy' ? 'bullish' : decision.action === 'sell' ? 'bearish' : 'neutral';

  const signalPatterns: Array<{ name: string; keywords: string[] }> = [
    { name: 'momentum', keywords: ['momentum', 'trend', 'breakout', 'acceleration'] },
    { name: 'whale_flow', keywords: ['whale', 'large_trade', 'institutional', 'flow'] },
    { name: 'OB_imbalance', keywords: ['order_book', 'imbalance', 'depth', 'liquidity'] },
    { name: 'volatility', keywords: ['volatility', 'vol', 'spike', 'compression'] },
    { name: 'volume', keywords: ['volume', 'accumulation', 'distribution'] },
    { name: 'news_sentiment', keywords: ['news', 'sentiment', 'fear', 'greed', 'fng'] },
    { name: 'regime', keywords: ['regime', 'regime_shift', 'transition'] },
    { name: 'S/R_level', keywords: ['support', 'resistance', 'snr', 'sr_zone', 'key_level'] },
    { name: 'funding', keywords: ['funding', 'basis', 'carry'] },
  ];

  for (const pattern of signalPatterns) {
    if (pattern.keywords.some(k => text.includes(k))) {
      return { name: pattern.name, value: direction === 'bullish' ? 0.6 : direction === 'bearish' ? -0.4 : 0, direction };
    }
  }

  // Default: infer from decision
  return {
    name: 'meta_signal',
    value: direction === 'bullish' ? 0.5 : direction === 'bearish' ? -0.5 : 0,
    direction,
  };
}

function computeDelta(current: PrimarySignal, prev: CycleSummary | null): CycleDelta {
  if (!prev || prev.primarySignal.name !== current.name) {
    return { exists: false, metric: 'none', from: null, to: null, significance: 'none' };
  }

  const diff = Math.abs(current.value - prev.primarySignal.value);
  let significance: CycleDelta['significance'] = 'none';
  if (diff > 0.5) significance = 'high';
  else if (diff > 0.2) significance = 'medium';
  else if (diff > 0.05) significance = 'low';

  return {
    exists: significance !== 'none',
    metric: current.name,
    from: Math.round(prev.primarySignal.value * 10000) / 10000,
    to: Math.round(current.value * 10000) / 10000,
    significance,
  };
}

function detectAnomaly(
  decision: { action: string; positionSizePct: number },
  regimeConfidence: number,
  metaConfidence: number,
): boolean {
  // Anomaly: low regime confidence + aggressive position = warning
  if (regimeConfidence < 0.3 && decision.positionSizePct > 0.05 && decision.action !== 'hold') return true;
  // Anomaly: very low meta-confidence + any action
  if (metaConfidence < 0.15) return true;
  // Anomaly: aggressive action with very low agreement
  return false;
}

// ─── Skeptics Convergence Audit Helpers ───

/**
 * Build Skeptics convergence audit context from summary chain.
 * This helps Skeptics cross-check the Meta-Agent's consistency.
 */
export function buildConvergenceAuditContext(
  summaries: CycleSummary[],
  recentPriceChanges: Array<'up' | 'down' | 'flat'>,
): string {
  if (summaries.length < 2) return '';

  const lines: string[] = [];
  lines.push('=== EM CONVERGENCE AUDIT ===');
  lines.push('Cross-checking Meta-Agent\'s past keyInsights against actual price movement.\n');

  let correctCount = 0;
  let totalChecks = 0;

  for (let i = 0; i < Math.min(summaries.length - 1, recentPriceChanges.length); i++) {
    const summary = summaries[summaries.length - 2 - i]!;
    const actual = recentPriceChanges[recentPriceChanges.length - 1 - i];

    const predicted = summary.primarySignal.direction;
    let consistent = false;
    if (actual === 'flat') consistent = predicted === 'neutral';
    else if (actual === 'up') consistent = predicted === 'bullish';
    else consistent = predicted === 'bearish';

    if (consistent) correctCount++;
    totalChecks++;

    const icon = consistent ? '✅' : '❌';
    lines.push(`  ${icon} Cycle #${summary.cycleNumber}: insight="${summary.keyInsight.slice(0, 50)}..." predicted=${predicted} actual=${actual}`);
  }

  const accuracy = totalChecks > 0 ? (correctCount / totalChecks * 100).toFixed(0) : 'N/A';
  lines.push(`\n  Convergence: ${correctCount}/${totalChecks} consistent (${accuracy}%)`);

  if (totalChecks >= 3 && correctCount / totalChecks < 0.3) {
    lines.push('  ⚠️ Significant divergence detected — Meta-Agent\'s signal direction has been consistently wrong.');
    lines.push('  Recommendation: Skeptics should cross-check all agent signals more aggressively.');
  }

  lines.push('---');
  return lines.join('\n');
}