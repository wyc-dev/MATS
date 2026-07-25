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
   *  cycle continues (the analyses are still computed locally). */
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
    try {
      // 1. Clear the previous cycle's rows (clean-snapshot semantics).
      // Delete all rows (clean-snapshot semantics). PostgREST DELETE requires
      // a filter; gte on cycle_id >= 0 matches every row. Cast to any because
      // the `asset_analyses` table isn't in the generated Supabase types yet.
      const { error: delErr } = await (this.client as any)
        .from(TABLE)
        .delete()
        .gte('cycle_id', 0);
      if (delErr) throw delErr;

      // 2. Insert the fresh batch.
      const rows = analyses.map(a => ({
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
      this.lastWriteCount = analyses.length;
      log.info(`Wrote ${analyses.length} asset analyses to Supabase (cycle #${analyses[0]!.cycleId})`);
    } catch (err) {
      log.error(`Supabase write failed (non-fatal — cycle continues): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}