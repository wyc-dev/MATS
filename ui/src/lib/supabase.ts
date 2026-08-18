// ─── v2.0.822: Supabase client for the MATS backend UI ──────────────────
//
// Reads the per-asset analysis matrix from the `asset_analyses` table.
// Uses the ANON key (public read — RLS allows SELECT for everyone; the
// analysis is universal market intelligence, not user-private data).
//
// The backend writes via service_role (RLS bypass); this UI only reads.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env['VITE_SUPABASE_URL'] ?? '';
const anonKey = import.meta.env['VITE_SUPABASE_ANON_KEY'] ?? '';

export const supabase: SupabaseClient | null = url && anonKey
  ? createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export const supabaseEnabled = supabase !== null;

/** Shape of a row in `asset_analyses` (matches the backend's AssetAnalysis). */
export interface AssetAnalysisRow {
  symbol: string;
  cycle_id: number;
  updated_at: string;
  market_data: {
    price: number;
    volatility: number;
    regime: string;
    change24h: number;
    volume24h: number;
    // v2.0.870-P26: 本機蠟燭動量(新行有;舊行冇 → UI fallback 去 change24h)
    momentum4h?: number;
    momentum1h?: number;
    momentum15m?: number;
    volumeRatio5m?: number;
    volumeState?: string;
  };
  consensus: {
    action: string;
    confidence: number;
    thesis: string;
    pwin: number;
    agentsAligned: number;
    agentsTotal: number;
  };
  // v2.0.857: aggressive/conservative risk profiles REMOVED — only moderate
  // exists. Field kept optional for backward-compat with pre-v2.0.857 rows
  // that may still carry aggressive/conservative keys; new rows have only
  // moderate. The UI reads matrix.moderate[state].
  matrix: {
    moderate: Record<'long' | 'short' | 'flat', MatrixCellRow>;
    aggressive?: Record<'long' | 'short' | 'flat', MatrixCellRow>;
    conservative?: Record<'long' | 'short' | 'flat', MatrixCellRow>;
  };
  metadata: Record<string, unknown>;
}

export interface MatrixCellRow {
  action: 'buy' | 'sell' | 'hold' | 'close' | 'flip';
  conviction: number;
  rationale: string;
  calibrated: boolean;
}

/** Fetch all asset analyses from Supabase (the latest cycle snapshot).
 *  Returns an empty array if Supabase is not configured or the query fails. */
export async function fetchAssetAnalyses(): Promise<AssetAnalysisRow[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('asset_analyses')
      .select('*')
      .order('symbol', { ascending: true });
    if (error) {
      console.warn('[supabase] fetchAssetAnalyses error:', error.message);
      return [];
    }
    return (data ?? []) as AssetAnalysisRow[];
  } catch (err) {
    console.warn('[supabase] fetchAssetAnalyses exception:', err);
    return [];
  }
}