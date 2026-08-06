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
  /** v2.0.857-fix2: last SUPABASE_URL we configured with (reconfigure no-op guard). */
  private lastUrl = '';

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

  /** v2.0.857-fix2: Re-initialise from the CURRENT env (process.env), so the
   *  Settings modal can enable Supabase WITHOUT a backend restart. No-op if
   *  the env is unchanged or keys are still absent. Call after an env update
   *  that touched SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. */
  reconfigure(): void {
    const url = process.env['SUPABASE_URL'] ?? '';
    const key = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
    // If already enabled with these exact values → no-op (avoid churn).
    if (this.enabled && this.lastUrl === url) return;
    if (!url || !key) {
      this.client = null;
      this.enabled = false;
      this.lastUrl = url;
      log.warn('[supabase-writer] reconfigure: keys absent — writer disabled (local-only)');
      return;
    }
    try {
      this.client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      this.enabled = true;
      this.lastUrl = url;
      log.info('[supabase-writer] reconfigured from env — writer enabled');
    } catch (err) {
      this.client = null;
      this.enabled = false;
      this.lastUrl = url;
      log.error(`[supabase-writer] reconfigure failed: ${err instanceof Error ? err.message : String(err)} — writer disabled`);
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
    // v2.0.857-fix-attack (D1): also reject non-finite updatedAt —
    // `new Date(a.updatedAt).toISOString()` throws RangeError on
    // undefined/NaN/negative, crashing the entire writeCycle.
    const validAnalyses = analyses.filter(a => {
      // v2.0.857-fix-attack2 (E1-E3): guard the OBJECTS before touching fields —
      // a malformed entry with marketData:undefined would crash at
      // a.marketData.price (TypeError), killing the whole filter (and thus
      // writeCycle). The filter is supposed to REJECT bad entries, not crash on
      // them. Check object shape first, then numeric fields.
      if (!a || typeof a !== 'object') return false;
      if (!a.symbol || typeof a.symbol !== 'string') return false;
      if (!a.marketData || typeof a.marketData !== 'object') return false;
      if (!a.consensus || typeof a.consensus !== 'object') return false;
      if (!Number.isFinite(a.marketData.price) || a.marketData.price < 0) return false;
      if (!Number.isFinite(a.consensus.confidence) || a.consensus.confidence < 0 || a.consensus.confidence > 1) return false;
      if (a.consensus.stopLoss != null && !Number.isFinite(a.consensus.stopLoss)) return false;
      if (a.consensus.takeProfit != null && !Number.isFinite(a.consensus.takeProfit)) return false;
      if (!Number.isFinite(a.updatedAt) || a.updatedAt <= 0) return false;
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

  /**
   * v2.0.862: MATS_Frontend feed — write the full UI snapshot (clean-snapshot).
   *
   * Stores the latest cycle's UI payload in `ui_snapshots` (one row per
   * section, keyed by section name + cycle_id) so the MATS_Frontend client
   * reads the latest completed cycle without SSE. Same resilience contract as
   * writeCycle: service_role, never throws (a DB error is logged and the
   * trading cycle continues).
   *
   * Section split: 'status' / 'portfolio' / 'market_state' / 'consensus' /
   * 'agent_thoughts' / 'evolution' / 'misc'. agent_thoughts carries the FULL
   * 8-agent × per-asset reasoning (owner ruling R6).
   */
  async writeUiSnapshot(payload: Record<string, unknown>, cycleId: number): Promise<void> {
    if (!this.enabled || !this.client) return;
    if (!payload || typeof payload !== 'object') return;
    try {
      // Split into sections; anything not explicitly sectioned goes to 'misc'.
      const sectioned: Record<string, unknown> = {
        status: payload['status'] ?? payload,
      };
      for (const key of ['portfolio', 'market_state', 'consensus', 'agent_thoughts', 'evolution']) {
        if (payload[key] !== undefined) sectioned[key] = payload[key];
      }
      const miscKeys = Object.keys(payload).filter(k => !sectioned[k] && k !== 'status');
      if (miscKeys.length > 0) {
        const misc: Record<string, unknown> = {};
        for (const k of miscKeys) misc[k] = payload[k];
        sectioned['misc'] = misc;
      }

      const rows = Object.entries(sectioned).map(([section, data]) => ({
        cycle_id: cycleId,
        section,
        payload: data as object,
      }));
      if (rows.length === 0) return;

      // v2.0.862-attack: INSERT FIRST, then DELETE the previous cycle — a
      // failed insert must NOT blank the snapshot (the client would read an
      // empty table = "no latest cycle"). With insert-then-delete, an insert
      // failure leaves the previous cycle intact (readable, stale-but-present),
      // and the delete only removes rows from OLDER cycles.
      const { error: insErr } = await this.client.from('ui_snapshots').insert(rows);
      if (insErr) throw insErr;
      // Delete only rows from older cycles (keep the fresh ones just written).
      const { error: delErr } = await this.client.from('ui_snapshots').delete().neq('cycle_id', cycleId);
      if (delErr) throw delErr;
      this.lastWriteAt = Date.now();
      log.info(`[ui-snapshot] wrote ${rows.length} sections (cycle ${cycleId})`);
    } catch (err) {
      // v2.0.862-attack: supabase-js errors are plain objects — String(err) is
      // '[object Object]' (useless). Extract message/code/hint for diagnosis.
      const sbErr = err as { message?: string; code?: string; hint?: string; details?: string };
      const detail = sbErr?.message ?? (err instanceof Error ? err.message : JSON.stringify(err));
      log.warn(`[ui-snapshot] write failed (non-blocking): ${detail}${sbErr?.code ? ` (${sbErr.code})` : ''}`);
    }
  }
}
