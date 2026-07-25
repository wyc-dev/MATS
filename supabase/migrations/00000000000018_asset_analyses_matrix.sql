-- 00000000000018_asset_analyses_matrix.sql
-- v2.0.822: Per-asset analysis matrix table.
--
-- Architecture: the MATS backend computes a consensus decision per asset each
-- cycle, expands it into a 3×3 recommendation matrix (risk profile × position
-- state), and writes ONE row per asset here. The client (mats_app) reads the
-- row for a symbol, picks the cell matching the user's risk profile + current
-- position, and renders the recommendation.
--
-- Unlike `ai_analyses` (per-user), this table is PER-ASSET and UNIVERSAL — the
-- analysis is the same for all users of a given risk profile. The user's
-- position state + risk profile determine which matrix cell they read.
--
-- Write pattern: each cycle the backend DELETEs all rows then INSERTs the fresh
-- batch (clean-snapshot semantics — the owner's spec: "每一次可以清空原有嘅資料
-- 先至再update新嘅資產分析上去"). The backend writes via service_role (RLS
-- bypass); the client reads via anon.

create table if not exists public.asset_analyses (
  symbol      text primary key,           -- one row per asset, upserted each cycle
  cycle_id    bigint not null,           -- backend cycle number
  updated_at  timestamptz not null default now(),
  market_data jsonb not null default '{}'::jsonb,  -- { price, volatility, regime, change24h, volume24h }
  consensus   jsonb not null default '{}'::jsonb,  -- { action, confidence, thesis, pwin, agentsAligned, agentsTotal }
  matrix      jsonb not null default '{}'::jsonb,  -- 3×3: { aggressive|moderate|conservative: { long|short|flat: { action, conviction, rationale, calibrated } } }
  metadata    jsonb not null default '{}'::jsonb
);

-- Index for the client's "fetch latest by symbol" query (though PK lookup
-- already covers single-symbol reads; this helps any range scans).
create index if not exists idx_asset_analyses_cycle
  on public.asset_analyses (cycle_id);

-- RLS: the analysis is universal market data (not user-private), so any
-- authenticated client can read it. The backend writes via service_role
-- (bypasses RLS). No client INSERT/UPDATE/DELETE.
alter table public.asset_analyses enable row level security;

-- Public read: any client (anon or authenticated) can read the analyses.
-- They are universal market intelligence, not user-private data.
create policy "read asset analyses"
  on public.asset_analyses for select
  using (true);

-- No INSERT/UPDATE/DELETE policies: the client cannot mutate this table.
-- The backend writes via the service_role key (RLS bypass).

comment on table public.asset_analyses is
  'Per-asset analysis matrix (3 risk profiles × 3 position states). Written each cycle by the MATS backend via service_role; read by the client. Clean-snapshot: cleared + rewritten every cycle.';