// ─── Supabase Analysis Writer ──────────────────────────────────────────
//
// v2.0.822: Writes the per-asset analysis matrix to the `asset_analyses`
// Supabase table each cycle. The backend NEVER places orders in analysis
// mode — it computes the consensus, expands it into a 3×3 recommendation
// matrix, and writes one row per asset. The app reads the row matching the
// user's risk profile + current position.
//
// Write pattern (per the BACKEND_CONTRACT):
//   • Each cycle: DELETE all rows, then INSERT the fresh batch. This keeps
//     the table a clean snapshot of the latest cycle (the owner's spec:
//     "每一次可以清空原有嘅資料先至再update新嘅資產分析上去").
//   • Uses the service_role key (RLS bypass) — NEVER shipped to the client.
//   • Resilient: if Supabase is not configured or unreachable, logs a warning
//     and returns — the trading cycle is NOT blocked by a DB outage.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../observability/logger.ts';
import type { AssetAnalysis } from '../types/index.ts';

const log = createLogger({ phase: 'analysis-writer' });

const TABLE = 'asset_analyses';

export class SupabaseAnalysisWriter {
  private client: SupabaseClient | null = null;
  private enabled = false;
  private lastWriteAt = 0;
  private lastWriteCount = 0;

  /** Initialise from env. No-op (disabled) if the keys are absent — the
   *  system runs in local-only mode and just logs the analyses. */
  constructor() {
    const url = process.env['SUPABASE_URL'] ?? '';
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
    if (!url || !key) {
      log.warn('Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — analysis writer disabled (local-only mode)');
      return;
    }
    try {
      this.client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      this.enabled = true;
      log.info('Supabase analysis writer enabled');
    } catch (err) {
      log.error(`Failed to init Supabase client: ${err instanceof Error ? err.message : String(err)} — writer disabled`);
    }
  }

  get isEnabled(): boolean { return this.enabled; }

  /** Clear the table + write a fresh batch of analysis rows. Idempotent per
   *  cycle (DELETE then INSERT). Never throws — a DB error is logged and the
   *  cycle continues (the analyses are still computed locally).
   *
   *  v2.0.823: Retry up to 3 times with exponential backoff (500ms, 1s, 2s)
   *  before giving up. A transient network error or Supabase rate limit
   *  should not cause the analysis to be lost for that cycle. */
  async writeCycle(analyses: AssetAnalysis[]): Promise<void> {
    if (!this.enabled || !this.client) {
      // Local-only mode: just log a summary so the operator sees the output.
      if (analyses.length > 0) {
        log.info(`[local-only] Cycle #${analyses[0]!.cycleId} analysis: ${analyses.length} assets — ${analyses.map(a => `${a.symbol}:${a.consensus.action}`).join(', ')}`);
      }
      return;
    }
    if (analyses.length === 0) {
      log.info('No analyses to write this cycle — skipping');
      return;
    }

    // v2.0.823: Validate analyses before writing — reject NaN/Infinity in
    // numeric fields that would corrupt the DB or crash the client.
    const validAnalyses = analyses.filter(a => {
      if (!a.symbol || typeof a.symbol !== 'string') return false;
      if (!Number.isFinite(a.marketData.price) || a.marketData.price < 0) return false;
      if (!Number.isFinite(a.consensus.confidence) || a.consensus.confidence < 0 || a.consensus.confidence > 1) return false;
      if (a.consensus.stopLoss != null && !Number.isFinite(a.consensus.stopLoss)) return false;
      if (a.consensus.takeProfit != null && !Number.isFinite(a.consensus.takeProfit)) return false;
      return true;
    });
    if (validAnalyses.length < analyses.length) {
      log.warn(`Filtered ${analyses.length - validAnalyses.length} invalid analyses (NaN/Infinity fields)`);
    }
    if (validAnalyses.length === 0) {
      log.warn('All analyses invalid — skipping write');
      return;
    }

    const MAX_RETRIES = 3;
    const BACKOFF_MS = [500, 1000, 2000];

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // 1. Clear the previous cycle's rows (clean-snapshot semantics).
        const { error: delErr } = await (this.client as any)
          .from(TABLE)
          .delete()
          .gte('cycle_id', 0);
        if (delErr) throw delErr;

        // 2. Insert the fresh batch.
        const rows = validAnalyses.map(a => ({
          symbol: a.symbol,
          cycle_id: a.cycleId,
          updated_at: new Date(a.updatedAt).toISOString(),
          market_data: a.marketData,
          consensus: a.consensus,
          matrix: a.matrix,
          metadata: a.metadata,
        }));
        const { error: insErr } = await (this.client as any).from(TABLE).insert(rows);
        if (insErr) throw insErr;

        this.lastWriteAt = Date.now();
        this.lastWriteCount = validAnalyses.length;
        if (attempt > 0) {
          log.info(`Wrote ${validAnalyses.length} asset analyses to Supabase (cycle #${validAnalyses[0]!.cycleId}) — succeeded on retry ${attempt + 1}`);
        } else {
          log.info(`Wrote ${validAnalyses.length} asset analyses to Supabase (cycle #${validAnalyses[0]!.cycleId})`);
        }
        return; // Success — exit retry loop.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES - 1) {
          log.warn(`Supabase write attempt ${attempt + 1}/${MAX_RETRIES} failed: ${msg} — retrying in ${BACKOFF_MS[attempt]}ms`);
          await new Promise(resolve => setTimeout(resolve, BACKOFF_MS[attempt]!));
        } else {
          log.error(`Supabase write failed after ${MAX_RETRIES} attempts (non-fatal — cycle continues): ${msg}`);
        }
      }
    }
  }
}