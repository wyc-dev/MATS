// ─── Trade Pattern Classifier ───
// Records entry + exit context for every trade, matches against historical patterns,
// and injects position-aware win-rate insights into agent context.
//
// Two query modes:
//   queryEntry()  — "Should I open a new LONG/SHORT in current conditions?"
//   queryPosition() — "I'm in a LONG at $X entered in conditions Y, current is Z — should I hold/close?"
//
// Production design:
//   - Every public method: independent try/catch → fail-open
//   - Bounded memory: max 1000 patterns, oldest dropped first
//   - Query cache: TTL 300s, invalidated on >1% price move or new outcome
//   - Persistence: atomic write + schema validation
//   - Pro fallback log: every error logged with context, never silent

import { createLogger } from '../observability/logger.ts';
import type { MarketRegime, AgentRole } from '../types/index.ts';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { EMClusteringEngine, type EMQueryResult } from './em-clustering.ts';

const log = createLogger({ phase: 'pattern_classifier' });

// ─── Config ───

const CONFIG = {
  maxPatterns: 1000,
  queryCacheTTL: 300_000,          // 5 min = 1 cycle
  cacheInvalidationPct: 1.0,       // price move % to bust cache
  minPatternsForQuery: 5,
  minSimilarForReport: 3,
  similarityThreshold: 0.50,
  maxContextPatterns: 5,
  persistPath: 'data/evolution/trade-patterns.json',
} as const;

// ─── Types ───

export interface TradePatternContext {
  regime: MarketRegime;
  regimeConfidence: number;
  /** 24h volatility (normalized, e.g. 0.05 = 5% daily range / price) */
  volatility: number;
  /** Trend strength 0-1 */
  trendStrength: number;
  /** Distance to nearest S/R in bps (+ = above support, - = below resistance) */
  srDistanceBps: number;
  /** Order book imbalance -1..1 */
  obImbalance: number;
  /** Annualized funding rate (decimal) */
  fundingRate: number;
  /** Current volume / 24h avg volume */
  volumeRatio: number;
  /** Agent signal agreement 0-1 */
  signalAgreement: number;
  /** Position size as % of balance 0-1 */
  positionSizePct: number;
  /** Leverage 1-10 */
  leverage: number;
  /** Sigmoid·GA sentiment -1..+1 (forward-looking emotion signal) */
  sentiment: number;
  /** Sigmoid·GA conviction 0-1 */
  sentimentConviction: number;
  /** Funding rate acceleration -1..+1 (positive = funding rising, bearish for longs) */
  fundingRateAccel: number;
}

export interface TradePatternRecord {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  /** Context snapshot at trade OPEN */
  entryContext: TradePatternContext;
  /** Context snapshot at trade CLOSE */
  exitContext: TradePatternContext;
  outcome: 'win' | 'loss' | 'pending';
  pnlPct: number;
  holdDuration: number;       // cycles held
  metaInsight: string;        // Meta-Agent's insight at entry
  agentDecisions: Array<{ role: AgentRole; action: string; confidence: number }>;
}

// ─── Query Results ───

export interface EntryQueryResult {
  /** How many historical entries match current conditions */
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Wilson score adjusted win rate — penalises small sample sizes (95% confidence lower bound) */
  adjustedWinRate: number;
  /** Top similar entries (best win + worst loss) */
  bestWin: { pnlPct: number; similarity: number; context: TradePatternContext; metaInsight: string } | null;
  worstLoss: { pnlPct: number; similarity: number; context: TradePatternContext; metaInsight: string } | null;
  /** Win rate broken down by regime */
  regimeBreakdown: Array<{ regime: MarketRegime; wins: number; losses: number; winRate: number }>;
  warnings: string[];
  /** GMM EM clustering assessment (unsupervised pattern discovery) */
  emAssessment: EMQueryResult;
}

export interface PositionQueryResult {
  /** How many historical trades had similar entry→current transitions */
  totalMatches: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Wilson score adjusted win rate — penalises small sample sizes */
  adjustedWinRate: number;
  /** Entry context (what the user provided) */
  entryContext: TradePatternContext;
  /** Current context */
  currentContext: TradePatternContext;
  /** Context delta (entry → current) */
  contextDelta: string;
  /** Top similar transitions */
  bestWin: { pnlPct: number; similarity: number; entryContext: TradePatternContext; exitContext: TradePatternContext; metaInsight: string } | null;
  worstLoss: { pnlPct: number; similarity: number; entryContext: TradePatternContext; exitContext: TradePatternContext; metaInsight: string } | null;
  /** Conditional: when a specific feature changed in a specific way, what was the win rate? */
  conditionalInsights: Array<{ condition: string; wins: number; losses: number; winRate: number }>;
  warnings: string[];
}

// ─── Defaults ───

function defaultContext(): TradePatternContext {
  return {
    regime: 'unknown', regimeConfidence: 0.5, volatility: 0,
    trendStrength: 0.5, srDistanceBps: 0, obImbalance: 0,
    fundingRate: 0, volumeRatio: 1, signalAgreement: 0.5,
    positionSizePct: 0, leverage: 1,
    sentiment: 0, sentimentConviction: 0.5,
    fundingRateAccel: 0,
  };
}

// ─── Feature Weights ───

interface FeatureDef {
  key: keyof TradePatternContext;
  weight: number;
  threshold: number; // diff / threshold → 0-1 normalized
}

const NUMERICAL_FEATURES: FeatureDef[] = [
  { key: 'volatility', weight: 0.18, threshold: 0.05 },
  { key: 'trendStrength', weight: 0.12, threshold: 0.30 },
  { key: 'srDistanceBps', weight: 0.12, threshold: 50 },
  { key: 'obImbalance', weight: 0.12, threshold: 0.30 },
  { key: 'sentiment', weight: 0.12, threshold: 0.30 },   // Sigmoid·GA forward-looking signal
  { key: 'signalAgreement', weight: 0.07, threshold: 0.30 },
  { key: 'fundingRate', weight: 0.06, threshold: 0.001 },
  { key: 'fundingRateAccel', weight: 0.08, threshold: 0.30 },
  { key: 'volumeRatio', weight: 0.06, threshold: 0.50 },
  { key: 'positionSizePct', weight: 0.04, threshold: 0.10 },
  { key: 'sentimentConviction', weight: 0.03, threshold: 0.30 },
];

// ─── Manager ───

/** Wilson score interval lower bound (95% confidence).
 *  Penalises small sample sizes — 3/5 = 60% becomes ~25%, 30/50 = 60% stays ~47%.
 *  This prevents overfitting on tiny match counts. */
function wilsonScore(wins: number, total: number): number {
  if (total === 0) return 0;
  const p = wins / total;
  const z = 1.96; // 95% confidence
  const denominator = 1 + z * z / total;
  const centre = p + z * z / (2 * total);
  const adjusted = (centre - z * Math.sqrt(centre * (1 - centre) / total + z * z / (4 * total * total))) / denominator;
  return Math.max(0, adjusted);
}

export class TradePatternClassifier {
  private patterns: TradePatternRecord[] = [];
  private queryCache: Map<string, { result: EntryQueryResult | PositionQueryResult; cachedAt: number; priceAtCache: number }> = new Map();
  private lastPrice: Record<string, number> = {};
  private dirty = false;
  /** GMM EM clustering engine for unsupervised pattern discovery */
  readonly em: EMClusteringEngine = new EMClusteringEngine();

  // ─── Lifecycle ───

  load(): void {
    try {
      const data = readFileSync(CONFIG.persistPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.patterns = parsed.slice(-CONFIG.maxPatterns);
        log.info(`Loaded ${this.patterns.length} trade patterns from ${CONFIG.persistPath}`);
      } else {
        log.warn(`[load] Invalid pattern data — starting fresh`);
        this.patterns = [];
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[load] No existing patterns or load failed: ${msg} — starting fresh`);
      this.patterns = [];
    }

    // Load EM model from companion file
    try {
      const emPath = CONFIG.persistPath.replace('.json', '-em.json');
      const emData = readFileSync(emPath, 'utf-8');
      this.em.load(emData);
      log.info(`Loaded EM model from ${emPath}`);
    } catch {
      log.info('[load] No existing EM model — will train from scratch');
    }

    // Feed all existing closed trades into EM (cold-start seed)
    const meaningful = this.patterns.filter(p => p.outcome !== 'pending' && Math.abs(p.pnlPct) >= 0.005);
    for (const p of meaningful) {
      const outcome: 1 | 0 = p.outcome === 'win' ? 1 : 0;
      this.em.feedTrade(p.entryContext as unknown as Record<string, number>, outcome);
    }
    if (meaningful.length >= 20) {
      this.em.refit();
      log.info(`[load] EM refit from ${meaningful.length} historical trades`);
    } else {
      log.info(`[load] EM queued ${meaningful.length} trades (need 20+ for refit)`);
    }
  }

  persist(): void {
    try {
      const tmp = CONFIG.persistPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.patterns, null, 2), 'utf-8');
      renameSync(tmp, CONFIG.persistPath);
      this.dirty = false;
      log.info(`Persisted ${this.patterns.length} trade patterns`);

      // Persist EM model separately
      const emTmp = CONFIG.persistPath.replace('.json', '-em.json') + '.tmp';
      const emFinal = CONFIG.persistPath.replace('.json', '-em.json');
      writeFileSync(emTmp, this.em.save(), 'utf-8');
      renameSync(emTmp, emFinal);
      log.info(`Persisted EM model (${this.em.getModel()?.clusters.length ?? 0} clusters)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[persist] Failed to save patterns: ${msg}`);
    }
  }

  // ─── Record Keeping ───

  /**
   * Snapshot context when a trade OPENS.
   * Stores entry context + side + price. Outcome is 'pending' until backfill.
   */
  snapshotContext(
    id: string,
    symbol: string,
    side: 'buy' | 'sell',
    entryPrice: number,
    context: Partial<TradePatternContext>,
    metaInsight: string,
    agentDecisions: Array<{ role: AgentRole; action: string; confidence: number }>,
  ): void {
    try {
      const fullCtx: TradePatternContext = { ...defaultContext(), ...context };
      this.patterns.push({
        id, symbol, side,
        entryTimestamp: Date.now(),
        exitTimestamp: 0,
        entryPrice,
        exitPrice: 0,
        entryContext: fullCtx,
        exitContext: defaultContext(),
        outcome: 'pending',
        pnlPct: 0,
        holdDuration: 0,
        metaInsight,
        agentDecisions,
      });
      this.lastPrice[symbol] = entryPrice;
      if (this.patterns.length > CONFIG.maxPatterns) {
        this.patterns.splice(0, this.patterns.length - CONFIG.maxPatterns);
      }
      this.dirty = true;
      log.info(`[snapshot] Opened ${side.toUpperCase()} #${id} ${symbol} @ $${entryPrice.toFixed(2)} | regime=${fullCtx.regime} vol=${(fullCtx.volatility * 100).toFixed(2)}% sr=${fullCtx.srDistanceBps}bps`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[snapshot] Failed: ${msg}`);
    }
  }

  /**
   * Backfill outcome when a trade CLOSES.
   * Records exit context, exit price, PnL, hold duration.
   */
  backfillOutcome(
    id: string,
    exitPrice: number,
    exitContext: Partial<TradePatternContext>,
    pnlPct: number,
    holdDuration: number,
  ): void {
    try {
      const pattern = this.patterns.find(p => p.id === id);
      if (!pattern) { log.warn(`[backfill] Trade #${id} not found`); return; }
      if (pattern.outcome !== 'pending') { log.warn(`[backfill] Trade #${id} already ${pattern.outcome}`); return; }

      pattern.exitTimestamp = Date.now();
      pattern.exitPrice = exitPrice;
      pattern.exitContext = { ...defaultContext(), ...exitContext };
      pattern.outcome = pnlPct > 0 ? 'win' : 'loss';
      pattern.pnlPct = pnlPct;
      pattern.holdDuration = holdDuration;
      this.dirty = true;
      this.queryCache.clear(); // bust all caches

      // Feed into EM clustering engine
      const absPnl = Math.abs(pnlPct);
      if (absPnl >= 0.005) {
        const outcome: 1 | 0 = pattern.outcome === 'win' ? 1 : 0;
        this.em.feedTrade(pattern.entryContext as unknown as Record<string, number>, outcome);
        this.em.maybeRefit();
        log.info(`[em] Fed trade #${id} (${pattern.outcome}, ${(pnlPct*100).toFixed(2)}%) → EM`);
      }

      log.info(`[backfill] Closed ${pattern.side.toUpperCase()} #${id}: ${pattern.outcome} (${(pnlPct * 100).toFixed(2)}%) over ${holdDuration} cycles | entry: ${pattern.entryContext.regime}→exit: ${pattern.exitContext.regime}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[backfill] Failed: ${msg}`);
    }
  }

  // ─── Query: Entry (for NEW positions) ───

  /**
   * Query: "Should I open a new {side} position in current conditions?"
   * Matches against entry contexts of past closed trades with same side.
   */
  queryEntry(
    currentContext: Partial<TradePatternContext>,
    symbol: string,
    side: 'buy' | 'sell',
    currentPrice: number,
  ): EntryQueryResult {
    const empty: EntryQueryResult = {
      totalMatches: 0, wins: 0, losses: 0, winRate: 0, adjustedWinRate: 0,
      bestWin: null, worstLoss: null,
      regimeBreakdown: [], warnings: [],
      emAssessment: this.em.query(currentContext as Record<string, number>),
    };

    try {
      const cacheKey = `entry:${symbol}:${side}:${currentContext.regime ?? 'unknown'}`;
      const cached = this.queryCache.get(cacheKey);
      if (cached) {
        const age = Date.now() - cached.cachedAt;
        const priceDelta = this.lastPrice[symbol] ? Math.abs(currentPrice - this.lastPrice[symbol]) / this.lastPrice[symbol] * 100 : 999;
        if (age < CONFIG.queryCacheTTL && priceDelta < CONFIG.cacheInvalidationPct) {
          return cached.result as EntryQueryResult;
        }
        this.queryCache.delete(cacheKey);
      }

      // BUY/SELL share the same pattern pool:
      //   - A losing BUY means SELL would have won (invert outcome)
      //   - A winning BUY means SELL would have lost (invert outcome)
      //   - Real SELL trades count directly for SELL query
      //   - Any trade with |PnL%| < 0.5% is noise — skip it entirely
      const MIN_PNL_PCT = 0.005; // 0.5% minimum to be considered meaningful
      const allClosed = this.patterns.filter(p => p.outcome !== 'pending' && p.symbol === symbol);
      const meaningful = allClosed.filter(p => Math.abs(p.pnlPct) >= MIN_PNL_PCT);
      if (meaningful.length < CONFIG.minPatternsForQuery) {
        return { ...empty, warnings: [`Only ${meaningful.length} meaningful closed trades for ${symbol} (need ${CONFIG.minPatternsForQuery}, |PnL| >= 0.5%)`] };
      }

      const queryCtx: TradePatternContext = { ...defaultContext(), ...currentContext };
      const scored = meaningful.map(p => ({
        pattern: p,
        similarity: this.computeSimilarity(queryCtx, p.entryContext),
      }));
      const matches = scored.filter(s => s.similarity >= CONFIG.similarityThreshold);

      // For each match, determine effective outcome for the requested side
      let wins = 0, losses = 0;
      const effectiveWins: typeof matches = [];
      const effectiveLosses: typeof matches = [];
      for (const m of matches) {
        const tradeWon = m.pattern.outcome === 'win';
        if (m.pattern.side === side) {
          // Same side: outcome is directly applicable
          if (tradeWon) { wins++; effectiveWins.push(m); }
          else { losses++; effectiveLosses.push(m); }
        } else {
          // Opposite side: outcome is inverted
          if (tradeWon) { losses++; effectiveLosses.push(m); }  // BUY win → SELL would lose
          else { wins++; effectiveWins.push(m); }                // BUY loss → SELL would win
        }
      }
      const total = wins + losses;
      const winRate = total > 0 ? wins / total : 0;
      const adjustedWinRate = wilsonScore(wins, total);

      // Best win / worst loss (using effective outcome considering inversion)
      const sortedWins = [...effectiveWins].sort((a, b) => b.similarity - a.similarity);
      const sortedLosses = [...effectiveLosses].sort((a, b) => b.similarity - a.similarity);
      const bestWin = sortedWins[0] ?? null;
      const worstLoss = sortedLosses[0] ?? null;

      // Regime breakdown (using effective outcome)
      const rMap = new Map<MarketRegime, { w: number; l: number }>();
      for (const m of matches) {
        const r = m.pattern.entryContext.regime;
        const e = rMap.get(r) ?? { w: 0, l: 0 };
        const tradeWon = m.pattern.outcome === 'win';
        const effectiveWin = m.pattern.side === side ? tradeWon : !tradeWon;
        if (effectiveWin) e.w++; else e.l++;
        rMap.set(r, e);
      }
      const regimeBreakdown = Array.from(rMap.entries()).map(([regime, c]) => ({
        regime, wins: c.w, losses: c.l,
        winRate: (c.w + c.l) > 0 ? c.w / (c.w + c.l) : 0,
      }));

      const warnings: string[] = [];
      if (total < CONFIG.minSimilarForReport) warnings.push(`Only ${total} similar ${side.toUpperCase()} entries — low confidence`);
      if (adjustedWinRate < 0.4 && total >= CONFIG.minSimilarForReport) warnings.push(`⚠️ Low adjusted win rate (${(adjustedWinRate * 100).toFixed(0)}%) for similar ${side.toUpperCase()} entries — STRONG bias against this trade`);
      if (adjustedWinRate > 0.6 && total >= CONFIG.minSimilarForReport) warnings.push(`⭐ Good adjusted win rate (${(adjustedWinRate * 100).toFixed(0)}%) for similar ${side.toUpperCase()} entries — favorable setup`);

      const result: EntryQueryResult = {
        totalMatches: total, wins, losses, winRate, adjustedWinRate,
        bestWin: bestWin ? {
          pnlPct: bestWin.pattern.pnlPct,
          similarity: bestWin.similarity,
          context: bestWin.pattern.entryContext,
          metaInsight: bestWin.pattern.metaInsight,
        } : null,
        worstLoss: worstLoss ? {
          pnlPct: worstLoss.pattern.pnlPct,
          similarity: worstLoss.similarity,
          context: worstLoss.pattern.entryContext,
          metaInsight: worstLoss.pattern.metaInsight,
        } : null,
        regimeBreakdown,
        warnings,
        emAssessment: this.em.query(currentContext as Record<string, number>),
      };

      this.queryCache.set(cacheKey, { result, cachedAt: Date.now(), priceAtCache: currentPrice });
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[queryEntry] Failed: ${msg}`);
      return empty;
    }
  }

  // ─── Query: Position Management (for EXISTING positions) ───

  /**
   * Query: "I'm in a {side} position entered at conditions X, current conditions are Y — what should I do?"
   * Matches against (entryContext, exitContext) pairs from past trades with same side.
   * Also computes conditional insights: "when feature F changed by >T, what was the win rate?"
   */
  queryPosition(
    entryContext: TradePatternContext,
    currentContext: Partial<TradePatternContext>,
    symbol: string,
    side: 'buy' | 'sell',
    currentPrice: number,
  ): PositionQueryResult {
    const empty: PositionQueryResult = {
      totalMatches: 0, wins: 0, losses: 0, winRate: 0, adjustedWinRate: 0,
      entryContext, currentContext: { ...defaultContext(), ...currentContext },
      contextDelta: '', bestWin: null, worstLoss: null,
      conditionalInsights: [], warnings: [],
    };

    try {
      const fullCurrent: TradePatternContext = { ...defaultContext(), ...currentContext };
      const cacheKey = `pos:${symbol}:${side}:${entryContext.regime}:${fullCurrent.regime}`;
      const cached = this.queryCache.get(cacheKey);
      if (cached) {
        const age = Date.now() - cached.cachedAt;
        const priceDelta = this.lastPrice[symbol] ? Math.abs(currentPrice - this.lastPrice[symbol]) / this.lastPrice[symbol] * 100 : 999;
        if (age < CONFIG.queryCacheTTL && priceDelta < CONFIG.cacheInvalidationPct) {
          return cached.result as PositionQueryResult;
        }
        this.queryCache.delete(cacheKey);
      }

      const closed = this.patterns.filter(p => p.outcome !== 'pending' && p.symbol === symbol && p.side === side);
      if (closed.length < CONFIG.minPatternsForQuery) {
        return { ...empty, warnings: [`Only ${closed.length} closed ${side.toUpperCase()} trades for ${symbol}`] };
      }

      // For each closed trade, compute transition similarity:
      // How similar is (entryContext → fullCurrent) to (past.entryContext → past.exitContext)?
      const scored = closed.map(p => ({
        pattern: p,
        similarity: this.computeTransitionSimilarity(entryContext, fullCurrent, p.entryContext, p.exitContext),
      }));
      const matches = scored.filter(s => s.similarity >= CONFIG.similarityThreshold);
      const wins = matches.filter(m => m.pattern.outcome === 'win').length;
      const losses = matches.filter(m => m.pattern.outcome === 'loss').length;
      const total = matches.length;
      const winRate = total > 0 ? wins / total : 0;
      const adjustedWinRate = wilsonScore(wins, total);

      // Context delta string
      const contextDelta = this.formatContextDelta(entryContext, fullCurrent);

      // Best / worst
      const sorted = [...matches].sort((a, b) => b.similarity - a.similarity);
      const bestWin = sorted.find(m => m.pattern.outcome === 'win') ?? null;
      const worstLoss = sorted.find(m => m.pattern.outcome === 'loss') ?? null;

      // Conditional insights: when specific features changed significantly
      const conditionalInsights = this.computeConditionalInsights(entryContext, fullCurrent, closed);

      const warnings: string[] = [];
      if (total < CONFIG.minSimilarForReport) warnings.push(`Only ${total} similar transitions — low confidence`);
      if (adjustedWinRate < 0.4 && total >= CONFIG.minSimilarForReport) warnings.push(`⚠️ Low adjusted win rate (${(adjustedWinRate * 100).toFixed(0)}%) for similar transitions — consider closing`);
      if (adjustedWinRate > 0.6 && total >= CONFIG.minSimilarForReport) warnings.push(`⭐ Good adjusted win rate (${(adjustedWinRate * 100).toFixed(0)}%) for similar transitions — strong hold signal`);

      const result: PositionQueryResult = {
        totalMatches: total, wins, losses, winRate, adjustedWinRate,
        entryContext, currentContext: fullCurrent,
        contextDelta,
        bestWin: bestWin ? {
          pnlPct: bestWin.pattern.pnlPct,
          similarity: bestWin.similarity,
          entryContext: bestWin.pattern.entryContext,
          exitContext: bestWin.pattern.exitContext,
          metaInsight: bestWin.pattern.metaInsight,
        } : null,
        worstLoss: worstLoss ? {
          pnlPct: worstLoss.pattern.pnlPct,
          similarity: worstLoss.similarity,
          entryContext: worstLoss.pattern.entryContext,
          exitContext: worstLoss.pattern.exitContext,
          metaInsight: worstLoss.pattern.metaInsight,
        } : null,
        conditionalInsights,
        warnings,
      };

      this.queryCache.set(cacheKey, { result, cachedAt: Date.now(), priceAtCache: currentPrice });
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[queryPosition] Failed: ${msg}`);
      return empty;
    }
  }

  // ─── Context Injection ───

  /**
   * Format entry query result for agent context (new position decision).
   * Returns empty string if no meaningful patterns.
   */
  formatEntryContext(result: EntryQueryResult, side: 'buy' | 'sell'): string {
    try {
      if (result.totalMatches < CONFIG.minSimilarForReport) return '';

      const lines: string[] = [];
      lines.push(`=== ${side.toUpperCase()} ENTRY PATTERN INSIGHTS ===`);
      lines.push(`Opening ${side.toUpperCase()} in current conditions matches ${result.totalMatches} historical trades:`);
      lines.push(`  ✅ ${result.wins} wins (${(result.winRate * 100).toFixed(0)}% win rate)`);
      lines.push(`  ❌ ${result.losses} losses`);
      lines.push('');

      if (result.bestWin) {
        const c = result.bestWin.context;
        lines.push(`Best similar win (${(result.bestWin.similarity * 100).toFixed(0)}% match):`);
        lines.push(`  ${c.regime} | Vol ${(c.volatility * 100).toFixed(1)}% | S/R ${c.srDistanceBps > 0 ? '+' : ''}${c.srDistanceBps}bps | OB ${(c.obImbalance * 100).toFixed(0)}%`);
        lines.push(`  → +${(result.bestWin.pnlPct * 100).toFixed(2)}%`);
        if (result.bestWin.metaInsight) lines.push(`  Insight: "${result.bestWin.metaInsight.slice(0, 80)}"`);
        lines.push('');
      }
      if (result.worstLoss) {
        const c = result.worstLoss.context;
        lines.push(`Worst similar loss (${(result.worstLoss.similarity * 100).toFixed(0)}% match):`);
        lines.push(`  ${c.regime} | Vol ${(c.volatility * 100).toFixed(1)}% | S/R ${c.srDistanceBps > 0 ? '+' : ''}${c.srDistanceBps}bps | OB ${(c.obImbalance * 100).toFixed(0)}%`);
        lines.push(`  → ${(result.worstLoss.pnlPct * 100).toFixed(2)}%`);
        if (result.worstLoss.metaInsight) lines.push(`  Insight: "${result.worstLoss.metaInsight.slice(0, 80)}"`);
        lines.push('');
      }

      if (result.regimeBreakdown.length > 1) {
        lines.push('Win rate by regime:');
        for (const rb of result.regimeBreakdown) {
          const icon = rb.winRate > 0.6 ? '🟢' : rb.winRate > 0.4 ? '🟡' : '🔴';
          lines.push(`  ${icon} ${rb.regime}: ${rb.wins}/${rb.wins + rb.losses} (${(rb.winRate * 100).toFixed(0)}%)`);
        }
        lines.push('');
      }

      for (const w of result.warnings) lines.push(`  ${w}`);
      lines.push('');
      // EM clustering assessment (unsupervised win/loss pattern discovery)
      const em = result.emAssessment;
      lines.push(`EM Cluster: #${em.dominantCluster} (${(em.responsibilities[em.dominantCluster] ?? 0) * 100 > 50 ? (em.responsibilities[em.dominantCluster]! * 100).toFixed(0) : '<50'}% assignment)`);
      lines.push(`  Weighted win rate: ${(em.weightedWinRate * 100).toFixed(0)}% (cluster-weighted expectation)`);
      if (em.weightedWinRate > 0.6) lines.push(`  🟢 EM favours this trade`);
      else if (em.weightedWinRate < 0.4) lines.push(`  🔴 EM disfavours this trade`);
      lines.push('---');
      return lines.join('\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[formatEntryContext] Failed: ${msg}`);
      return '';
    }
  }

  /**
   * Format position query result for agent context (existing position management).
   * Shows entry context, current context, delta, and historical transition outcomes.
   */
  formatPositionContext(
    result: PositionQueryResult,
    side: 'buy' | 'sell',
    entryPrice: number,
    currentPrice: number,
    currentPnlPct: number,
    holdDuration: number,
  ): string {
    try {
      if (result.totalMatches < CONFIG.minSimilarForReport) return '';

      const lines: string[] = [];
      const pnlIcon = currentPnlPct >= 0 ? '🟢' : '🔴';
      lines.push(`=== ${side.toUpperCase()} POSITION PATTERN INSIGHTS ===`);
      lines.push(`${pnlIcon} ${side.toUpperCase()} @ $${entryPrice.toFixed(2)} → $${currentPrice.toFixed(2)} | PnL: ${(currentPnlPct * 100).toFixed(2)}% | Held: ${holdDuration} cycles`);
      lines.push('');

      // Entry vs current context
      const e = result.entryContext;
      const c = result.currentContext;
      lines.push(`Entry: ${e.regime} | Vol ${(e.volatility * 100).toFixed(1)}% | S/R ${e.srDistanceBps > 0 ? '+' : ''}${e.srDistanceBps}bps | OB ${(e.obImbalance * 100).toFixed(0)}%`);
      lines.push(`Now:   ${c.regime} | Vol ${(c.volatility * 100).toFixed(1)}% | S/R ${c.srDistanceBps > 0 ? '+' : ''}${c.srDistanceBps}bps | OB ${(c.obImbalance * 100).toFixed(0)}%`);
      lines.push(`Delta: ${result.contextDelta}`);
      lines.push('');

      // Transition outcomes
      lines.push(`Similar entry→current transitions: ${result.totalMatches} matches`);
      lines.push(`  ✅ ${result.wins} held to profit (${(result.winRate * 100).toFixed(0)}% win rate)`);
      lines.push(`  ❌ ${result.losses} held to loss`);
      lines.push('');

      if (result.bestWin) {
        lines.push(`Best similar transition (${(result.bestWin.similarity * 100).toFixed(0)}% match):`);
        lines.push(`  Entry: ${result.bestWin.entryContext.regime} | Exit: ${result.bestWin.exitContext.regime}`);
        lines.push(`  → +${(result.bestWin.pnlPct * 100).toFixed(2)}%`);
        if (result.bestWin.metaInsight) lines.push(`  Entry insight: "${result.bestWin.metaInsight.slice(0, 80)}"`);
        lines.push('');
      }
      if (result.worstLoss) {
        lines.push(`Worst similar transition (${(result.worstLoss.similarity * 100).toFixed(0)}% match):`);
        lines.push(`  Entry: ${result.worstLoss.entryContext.regime} | Exit: ${result.worstLoss.exitContext.regime}`);
        lines.push(`  → ${(result.worstLoss.pnlPct * 100).toFixed(2)}%`);
        if (result.worstLoss.metaInsight) lines.push(`  Entry insight: "${result.worstLoss.metaInsight.slice(0, 80)}"`);
        lines.push('');
      }

      // Conditional insights
      for (const ci of result.conditionalInsights) {
        const icon = ci.winRate > 0.6 ? '🟢' : ci.winRate > 0.4 ? '🟡' : '🔴';
        lines.push(`  ${icon} ${ci.condition}: ${ci.wins}/${ci.wins + ci.losses} (${(ci.winRate * 100).toFixed(0)}%)`);
      }
      if (result.conditionalInsights.length > 0) lines.push('');

      for (const w of result.warnings) lines.push(`  ${w}`);
      lines.push('---');
      return lines.join('\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[formatPositionContext] Failed: ${msg}`);
      return '';
    }
  }

  // ─── Similarity Engines ───

  /** Similarity between two single contexts (for entry matching) */
  private computeSimilarity(a: TradePatternContext, b: TradePatternContext): number {
    try {
      const regimeScore = a.regime === b.regime ? 1.0 : 0.25;
      let numScore = 0, totalW = 0;
      for (const f of NUMERICAL_FEATURES) {
        const diff = Math.abs((a[f.key] as number) - (b[f.key] as number));
        numScore += (1 - Math.min(1, diff / f.threshold)) * f.weight;
        totalW += f.weight;
      }
      return regimeScore * 0.40 + (totalW > 0 ? numScore / totalW : 0) * 0.60;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[computeSimilarity] Failed: ${msg}`);
      return 0;
    }
  }

  /**
   * Transition similarity: how similar is (entryA → currentA) to (entryB → exitB)?
   * Combines entry similarity + exit similarity + direction-of-change similarity.
   */
  private computeTransitionSimilarity(
    entryA: TradePatternContext, currentA: TradePatternContext,
    entryB: TradePatternContext, exitB: TradePatternContext,
  ): number {
    try {
      // Entry similarity: 40%
      const entrySim = this.computeSimilarity(entryA, entryB);

      // Exit similarity: 40% (currentA vs exitB)
      const exitSim = this.computeSimilarity(currentA, exitB);

      // Direction-of-change similarity: 20%
      // Did the same features move in the same direction?
      let dirScore = 0;
      const dirFeatures: Array<keyof TradePatternContext> = ['volatility', 'srDistanceBps', 'obImbalance', 'signalAgreement'];
      let dirCount = 0;
      for (const k of dirFeatures) {
        const dA = (currentA[k] as number) - (entryA[k] as number);
        const dB = (exitB[k] as number) - (entryB[k] as number);
        // Same sign = same direction of change
        if (dA * dB >= 0) dirScore += 1;
        dirCount++;
      }
      const dirSim = dirCount > 0 ? dirScore / dirCount : 0.5;

      return entrySim * 0.40 + exitSim * 0.40 + dirSim * 0.20;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[computeTransitionSimilarity] Failed: ${msg}`);
      return 0;
    }
  }

  // ─── Context Delta Formatting ───

  private formatContextDelta(entry: TradePatternContext, current: TradePatternContext): string {
    try {
      const parts: string[] = [];
      const volDelta = (current.volatility - entry.volatility) * 100;
      if (Math.abs(volDelta) > 0.5) parts.push(`Vol ${volDelta > 0 ? '+' : ''}${volDelta.toFixed(1)}% ${volDelta > 0 ? '↑' : '↓'}`);
      const srDelta = current.srDistanceBps - entry.srDistanceBps;
      if (Math.abs(srDelta) > 10) parts.push(`S/R ${srDelta > 0 ? '+' : ''}${srDelta}bps ${srDelta > 0 ? '↑' : '↓'}`);
      const obDelta = (current.obImbalance - entry.obImbalance) * 100;
      if (Math.abs(obDelta) > 10) parts.push(`OB ${obDelta > 0 ? '+' : ''}${obDelta.toFixed(0)}% ${obDelta > 0 ? '↑' : '↓'}`);
      if (current.regime !== entry.regime) parts.push(`Regime: ${entry.regime} → ${current.regime}`);
      return parts.length > 0 ? parts.join(' | ') : 'No significant change';
    } catch { return 'Delta unavailable'; }
  }

  // ─── Conditional Insights ───

  /**
   * Compute conditional win rates: when specific features changed in specific ways,
   * what was the outcome? E.g. "When vol increased >2% after entry: 1/5 wins (20%)"
   */
  private computeConditionalInsights(
    entry: TradePatternContext,
    current: TradePatternContext,
    closedPatterns: TradePatternRecord[],
  ): Array<{ condition: string; wins: number; losses: number; winRate: number }> {
    try {
      const insights: Array<{ condition: string; wins: number; losses: number; winRate: number }> = [];

      // Condition 1: Regime shift
      if (current.regime !== entry.regime) {
        const shifted = closedPatterns.filter(p =>
          p.entryContext.regime === entry.regime && p.exitContext.regime === current.regime
        );
        if (shifted.length >= CONFIG.minSimilarForReport) {
          const w = shifted.filter(p => p.outcome === 'win').length;
          const l = shifted.filter(p => p.outcome === 'loss').length;
          insights.push({ condition: `Regime shift ${entry.regime} → ${current.regime}`, wins: w, losses: l, winRate: (w + l) > 0 ? w / (w + l) : 0 });
        }
      }

      // Condition 2: Volatility spike
      const volDelta = current.volatility - entry.volatility;
      if (volDelta > 0.02) {
        const spiked = closedPatterns.filter(p =>
          p.entryContext.regime === entry.regime &&
          (p.exitContext.volatility - p.entryContext.volatility) > 0.02
        );
        if (spiked.length >= CONFIG.minSimilarForReport) {
          const w = spiked.filter(p => p.outcome === 'win').length;
          const l = spiked.filter(p => p.outcome === 'loss').length;
          insights.push({ condition: `Vol spike >2% after entry`, wins: w, losses: l, winRate: (w + l) > 0 ? w / (w + l) : 0 });
        }
      }

      // Condition 3: S/R approach (price moved close to S/R)
      const srDelta = Math.abs(current.srDistanceBps) - Math.abs(entry.srDistanceBps);
      if (srDelta < -20) {
        const approached = closedPatterns.filter(p =>
          p.entryContext.regime === entry.regime &&
          (Math.abs(p.exitContext.srDistanceBps) - Math.abs(p.entryContext.srDistanceBps)) < -20
        );
        if (approached.length >= CONFIG.minSimilarForReport) {
          const w = approached.filter(p => p.outcome === 'win').length;
          const l = approached.filter(p => p.outcome === 'loss').length;
          insights.push({ condition: `Price approached S/R by >20bps`, wins: w, losses: l, winRate: (w + l) > 0 ? w / (w + l) : 0 });
        }
      }

      return insights;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[computeConditionalInsights] Failed: ${msg}`);
      return [];
    }
  }

  // ─── Stats ───

  getStats(): { totalPatterns: number; closedTrades: number; wins: number; losses: number; cacheEntries: number } {
    try {
      const closed = this.patterns.filter(p => p.outcome !== 'pending');
      return {
        totalPatterns: this.patterns.length,
        closedTrades: closed.length,
        wins: closed.filter(p => p.outcome === 'win').length,
        losses: closed.filter(p => p.outcome === 'loss').length,
        cacheEntries: this.queryCache.size,
      };
    } catch {
      return { totalPatterns: 0, closedTrades: 0, wins: 0, losses: 0, cacheEntries: 0 };
    }
  }

  getAllPatterns(): TradePatternRecord[] {
    return this.patterns;
  }
}
