// ─── Pattern Tag Tracker (v2.0.28) ───
// Records LLM-identified chart pattern tags for every trade and tracks
// win/loss outcomes per tag+direction. This lets the system learn which
// patterns (as identified by the LLM agents) have the highest win rates
// for BUY vs SELL, and injects that knowledge back into agent context.
//
// Design principles:
//   - Every public method: independent try/catch → fail-open
//   - Bounded memory: max 500 tag records, oldest dropped first
//   - Persistence: atomic write + schema validation
//   - Query: Wilson score lower bound to penalise small samples

import { createLogger } from '../observability/logger.ts';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { wilsonScore, computeVectorConditionalWinRate, formatVectorConditional } from './evolution-utils.ts';
import type { NumericEmbedProvider } from './numeric-autoencoder.ts';

const log = createLogger({ phase: 'pattern_tag_tracker' });

const CONFIG = {
  maxRecords: 500,
  persistPath: 'data/evolution/pattern-tags.json',
  minSamplesForReport: 3,
} as const;

// ─── Types ───

export interface PatternTagRecord {
  id: string;
  /** The pattern tag assigned by the LLM (e.g. "momentum_breakout") */
  tag: string;
  /** Trade direction: buy or sell */
  side: 'buy' | 'sell';
  /** Trading symbol */
  symbol: string;
  /** Cycle number when trade was opened */
  cycleNumber: number;
  /** Timestamp when trade was opened */
  entryTimestamp: number;
  /** Outcome: win, loss, or pending */
  outcome: 'win' | 'loss' | 'pending';
  /** PnL percentage (filled on close) */
  pnlPct: number;
  /** Which agent identified this pattern */
  agentRole: string;
  /** v2.0.203: Market conditions at entry time. Enables vector-conditional
   *  win rate (win rate of similar MARKET CONDITIONS, not raw per-tag counts).
   *  Optional for backward compat with older persisted records. */
  marketFeatures?: Record<string, number>;
}

export interface PatternTagStats {
  tag: string;
  side: 'buy' | 'sell';
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Wilson score lower bound (95% confidence) — penalises small samples */
  adjustedWinRate: number;
  avgPnlPct: number;
}

export interface PatternTagSummary {
  /** Per tag+direction stats, sorted by sample count descending */
  stats: PatternTagStats[];
  /** Total records tracked */
  totalRecords: number;
  /** Unique tags seen */
  uniqueTags: number;
}

// v2.0.174: wilsonScore extracted to evolution-utils.ts

// ─── Tracker ───

export class PatternTagTracker {
  private records: PatternTagRecord[] = [];
  private dirty = false;

  // ─── Lifecycle ───

  load(): void {
    try {
      const data = readFileSync(CONFIG.persistPath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.records = parsed.slice(-CONFIG.maxRecords);
        log.info(`Loaded ${this.records.length} pattern tag records from ${CONFIG.persistPath}`);
      } else {
        log.warn(`[load] Invalid data — starting fresh`);
        this.records = [];
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.info(`[load] No existing pattern tags or load failed: ${msg} — starting fresh`);
      this.records = [];
    }
  }

  persist(): void {
    if (!this.dirty) return;
    try {
      const tmp = CONFIG.persistPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf-8');
      renameSync(tmp, CONFIG.persistPath);
      this.dirty = false;
      log.info(`Persisted ${this.records.length} pattern tag records`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[persist] Failed: ${msg}`);
    }
  }

  // ─── Recording ───

  /**
   * Record a pattern tag when a trade OPENS.
   * The outcome is 'pending' until backfillOutcome is called on close.
   *
   * v2.0.203: `marketFeatures` captures entry-time market conditions so the
   * tag's win rate can later be conditioned on similar market states, not
   * just raw per-tag counts. Optional — older callers still work.
   */
  recordEntry(
    id: string,
    tag: string,
    side: 'buy' | 'sell',
    symbol: string,
    cycleNumber: number,
    agentRole: string,
    marketFeatures?: Record<string, number>,
  ): void {
    try {
      // Sanitize tag: lowercase, snake_case, max 80 chars
      const cleanTag = tag.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 80);
      if (!cleanTag || cleanTag === 'none' || cleanTag === 'n_a' || cleanTag === 'null') return;

      this.records.push({
        id,
        tag: cleanTag,
        side,
        symbol,
        cycleNumber,
        entryTimestamp: Date.now(),
        outcome: 'pending',
        pnlPct: 0,
        agentRole,
        marketFeatures: marketFeatures ? { ...marketFeatures } : undefined,
      });

      // Bound memory
      if (this.records.length > CONFIG.maxRecords) {
        this.records.splice(0, this.records.length - CONFIG.maxRecords);
      }
      this.dirty = true;
      log.info(`[record] ${side.toUpperCase()} ${symbol} tag="${cleanTag}" (by ${agentRole})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[record] Failed: ${msg}`);
    }
  }

  /**
   * Backfill the outcome when a trade CLOSES.
   * Matches by trade id; if not found, tries symbol+side+pending+recent.
   */
  backfillOutcome(id: string, pnlPct: number): void {
    try {
      // Try exact id match first
      let record = this.records.find(r => r.id === id && r.outcome === 'pending');

      // Fallback: match by pending status + most recent for this symbol+side
      if (!record) {
        const pending = this.records
          .filter(r => r.outcome === 'pending')
          .sort((a, b) => b.entryTimestamp - a.entryTimestamp);
        record = pending.find(r => r.id === id);
        if (!record) {
          // Last resort: just get the most recent pending record
          record = pending[0] ?? undefined;
        }
      }

      if (!record) {
        log.warn(`[backfill] No pending pattern tag record for id=${id}`);
        return;
      }

      record.outcome = pnlPct > 0 ? 'win' : 'loss';
      record.pnlPct = pnlPct;
      this.dirty = true;
      log.info(
        `[backfill] tag="${record.tag}" ${record.side.toUpperCase()} ${record.symbol}: ${record.outcome} (${(pnlPct * 100).toFixed(2)}%)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[backfill] Failed: ${msg}`);
    }
  }

  // ─── Querying ───

  /**
   * Get win/loss stats for a specific tag+direction.
   * Returns null if insufficient data.
   */
  getTagStats(tag: string, side: 'buy' | 'sell'): PatternTagStats | null {
    try {
      const cleanTag = tag.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
      const matching = this.records.filter(
        r => r.tag === cleanTag && r.side === side && r.outcome !== 'pending',
      );
      if (matching.length === 0) return null;

      const wins = matching.filter(r => r.outcome === 'win').length;
      const losses = matching.filter(r => r.outcome === 'loss').length;
      const total = wins + losses;
      const winRate = total > 0 ? wins / total : 0;
      const avgPnl = total > 0 ? matching.reduce((s, r) => s + r.pnlPct, 0) / total : 0;

      return {
        tag: cleanTag,
        side,
        total,
        wins,
        losses,
        winRate,
        adjustedWinRate: wilsonScore(wins, total),
        avgPnlPct: avgPnl,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get all tag stats, sorted by total samples descending.
   */
  getSummary(): PatternTagSummary {
    try {
      const tagSideMap = new Map<string, PatternTagStats>();

      for (const r of this.records) {
        if (r.outcome === 'pending') continue;
        const key = `${r.tag}:${r.side}`;
        const existing = tagSideMap.get(key);
        if (existing) {
          existing.total++;
          if (r.outcome === 'win') existing.wins++;
          else existing.losses++;
          existing.avgPnlPct = (existing.avgPnlPct * (existing.total - 1) + r.pnlPct) / existing.total;
          existing.winRate = existing.wins / existing.total;
          existing.adjustedWinRate = wilsonScore(existing.wins, existing.total);
        } else {
          const wins = r.outcome === 'win' ? 1 : 0;
          const losses = r.outcome === 'loss' ? 1 : 0;
          tagSideMap.set(key, {
            tag: r.tag,
            side: r.side,
            total: 1,
            wins,
            losses,
            winRate: wins / 1,
            adjustedWinRate: wilsonScore(wins, 1),
            avgPnlPct: r.pnlPct,
          });
        }
      }

      const stats = [...tagSideMap.values()].sort((a, b) => b.total - a.total);
      const uniqueTags = new Set(this.records.map(r => r.tag)).size;

      return {
        stats,
        totalRecords: this.records.length,
        uniqueTags,
      };
    } catch {
      return { stats: [], totalRecords: 0, uniqueTags: 0 };
    }
  }

  /**
   * Format pattern tag insights for agent context injection.
   * Shows top tags with their win rates for BUY and SELL, so agents
   * can see which patterns historically work best in each direction.
   *
   * Only includes tags with enough samples (≥ minSamplesForReport).
   */
  formatContext(maxTags: number = 8, embeddingProvider?: NumericEmbedProvider): string {
    try {
      const summary = this.getSummary();
      const reportable = summary.stats.filter(s => s.total >= CONFIG.minSamplesForReport);

      if (reportable.length === 0) return '';

      const lines: string[] = ['=== PATTERN TAG WIN RATES (LLM-identified patterns) ==='];

      // Group by tag, show both sides
      const tagMap = new Map<string, { buy?: PatternTagStats; sell?: PatternTagStats }>();
      for (const s of reportable) {
        const entry = tagMap.get(s.tag) ?? {};
        if (s.side === 'buy') entry.buy = s;
        else entry.sell = s;
        tagMap.set(s.tag, entry);
      }

      // Sort tags by total samples (buy+sell) descending
      const sortedTags = [...tagMap.entries()]
        .map(([tag, data]) => ({
          tag,
          total: (data.buy?.total ?? 0) + (data.sell?.total ?? 0),
          data,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, maxTags);

      for (const { tag, data } of sortedTags) {
        const parts: string[] = [];
        if (data.buy) {
          const icon = data.buy.adjustedWinRate > 0.6 ? '🟢' : data.buy.adjustedWinRate > 0.4 ? '🟡' : '🔴';
          parts.push(`${icon} BUY: ${data.buy.wins}/${data.buy.total} (${(data.buy.winRate * 100).toFixed(0)}%, adj ${(data.buy.adjustedWinRate * 100).toFixed(0)}%)`);
        }
        if (data.sell) {
          const icon = data.sell.adjustedWinRate > 0.6 ? '🟢' : data.sell.adjustedWinRate > 0.4 ? '🟡' : '🔴';
          parts.push(`${icon} SELL: ${data.sell.wins}/${data.sell.total} (${(data.sell.winRate * 100).toFixed(0)}%, adj ${(data.sell.adjustedWinRate * 100).toFixed(0)}%)`);
        }
        if (parts.length > 0) {
          lines.push(`  ${tag}: ${parts.join(' | ')}`);
          // v2.0.203: Append vector-conditional win rate for each side that has
          // a recent record with marketFeatures. This is the TRUE edge signal —
          // raw per-tag WR conflates trades under different market conditions.
          for (const side of ['buy', 'sell'] as const) {
            const latestWithFeatures = this.records
              .filter(r => r.tag === tag && r.side === side && r.outcome !== 'pending' && r.marketFeatures)
              .sort((a, b) => b.entryTimestamp - a.entryTimestamp)[0];
            if (!latestWithFeatures) continue;
            // NOTE: PatternTagRecord has no `exitType` field, so system-decision
            // closes (thesis_invalidation) cannot be excluded here — the
            // record schema would need extending to carry the close mechanism.
            // Follow-up if this per-tag conditional WR should be market-clean.
            const result = computeVectorConditionalWinRate(
              latestWithFeatures.marketFeatures!,
              this.records.map(r => ({ marketFeatures: r.marketFeatures, outcome: r.outcome, symbol: r.symbol, side: r.side, pnl: r.pnlPct })),
              { side, minSamples: 3, threshold: 0.80, topN: 20, embeddingProvider },
            );
            if (result.confidence !== 'none') {
              lines.push(`    ${side.toUpperCase()} conditional: ${formatVectorConditional(result, '').trim()}`);
            }
          }
        }
      }

      lines.push('---');
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Get the best historical win rate for a given tag+direction.
   * Useful for quick lookups during decision-making.
   */
  getWinRate(tag: string, side: 'buy' | 'sell'): number | null {
    const stats = this.getTagStats(tag, side);
    return stats ? stats.adjustedWinRate : null;
  }

  /**
   * Get stats for the API/UI.
   */
  getStats(): { totalRecords: number; pending: number; closed: number; uniqueTags: number } {
    const pending = this.records.filter(r => r.outcome === 'pending').length;
    const closed = this.records.filter(r => r.outcome !== 'pending').length;
    const uniqueTags = new Set(this.records.map(r => r.tag)).size;
    return { totalRecords: this.records.length, pending, closed, uniqueTags };
  }
}