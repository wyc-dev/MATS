-- ═══════════════════════════════════════════════════════════════════
-- v2.0.862: MATS_Frontend 三張新表
--   ui_snapshots    — 公開上 cycle 運算結果(clean-snapshot,後端 service_role 每 cycle DELETE+INSERT)
--   user_risk_prefs — 用戶風險風格(客戶端調節,Q9/R1)
--   orders          — 落單記錄(paper + real 統一,per-user,參考 mats_app format Q16/R3)
-- RLS: ui_snapshots 公開可讀(universal market intelligence,同 asset_analyses);
--      user_risk_prefs / orders 只讀自己;寫入經 RPC / service_role(同 mats_app 模式)。
-- ═══════════════════════════════════════════════════════════════════

-- ─── ui_snapshots:公開上 cycle 運算結果 ─────────────────────────────
create table if not exists public.ui_snapshots (
  id bigint generated always as identity primary key,
  cycle_id bigint not null,
  section text not null,          -- 'status' | 'portfolio' | 'market_state' | 'consensus' | 'agent_thoughts' | 'evolution' | 'misc'
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ui_snapshots_cycle_section
  on public.ui_snapshots (cycle_id, section);

-- 公開可讀(同 asset_analyses 一致——universal market intelligence)
alter table public.ui_snapshots enable row level security;
create policy "ui_snapshots public read"
  on public.ui_snapshots for select using (true);
-- 寫入只經 service_role(無 INSERT/UPDATE/DELETE policy——client 唔可以改)

-- ─── user_risk_prefs:用戶風險風格(Q9/R1)─────────────────────────────
create table if not exists public.user_risk_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  risk_profile text not null default 'moderate'
    check (risk_profile in ('low', 'mid', 'high')),
  max_position_size_pct numeric(6,4) not null default 0.20
    check (max_position_size_pct > 0 and max_position_size_pct <= 1),
  max_portion numeric(6,4) not null default 1.0
    check (max_portion > 0 and max_portion <= 1),
  leverage numeric(6,2) not null default 1
    check (leverage > 0 and leverage <= 50),
  stop_loss_pct numeric(6,4) not null default 0.02,
  take_profit_pct numeric(6,4) not null default 0.05,
  updated_at timestamptz not null default now()
);

alter table public.user_risk_prefs enable row level security;
create policy "risk prefs select own"
  on public.user_risk_prefs for select using (auth.uid() = user_id);
-- 寫入經 RPC(同 mats_app 模式)——見下方 upsert_user_risk_prefs

create or replace function public.upsert_user_risk_prefs(
  p_risk_profile text,
  p_max_position_size_pct numeric,
  p_max_portion numeric,
  p_leverage numeric,
  p_stop_loss_pct numeric,
  p_take_profit_pct numeric
)
returns public.user_risk_prefs
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_risk_prefs (
    user_id, risk_profile, max_position_size_pct, max_portion,
    leverage, stop_loss_pct, take_profit_pct
  ) values (
    auth.uid(), p_risk_profile, p_max_position_size_pct, p_max_portion,
    p_leverage, p_stop_loss_pct, p_take_profit_pct
  )
  on conflict (user_id) do update set
    risk_profile = excluded.risk_profile,
    max_position_size_pct = excluded.max_position_size_pct,
    max_portion = excluded.max_portion,
    leverage = excluded.leverage,
    stop_loss_pct = excluded.stop_loss_pct,
    take_profit_pct = excluded.take_profit_pct,
    updated_at = now()
  returning *;
end $$;

-- ─── orders:落單記錄(paper + real 統一,參考 mats_app format R3)────────
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  direction text not null check (direction in ('LONG', 'SHORT')),
  order_type text not null default 'market',
  size numeric(20,8) not null check (size > 0),
  leverage numeric(6,2) not null default 1 check (leverage > 0 and leverage <= 50),
  stop_loss numeric(20,8),
  take_profit numeric(20,8),
  status text not null default 'pending'
    check (status in ('pending', 'filled', 'closed', 'cancelled', 'rejected')),
  -- 訊號追溯(signal_cycle = 後端 cycle_id,可對返 asset_analyses)
  signal_cycle bigint,
  signal_action text,
  signal_confidence numeric(6,4),
  -- paper vs real 標記(agentId 模式,同後端 tradeRecords)
  trade_mode text not null default 'paper' check (trade_mode in ('paper', 'real')),
  fill_price numeric(20,8),
  entry_price numeric(20,8),
  exit_price numeric(20,8),
  pnl numeric(20,8) not null default 0,
  pnl_pct numeric(10,4) not null default 0,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  meta jsonb
);

create index if not exists idx_orders_user_closed
  on public.orders (user_id, closed_at desc);
create index if not exists idx_orders_user_status
  on public.orders (user_id, status);

alter table public.orders enable row level security;
create policy "orders select own"
  on public.orders for select using (auth.uid() = user_id);
-- 寫入經 RPC / service_role——client 唔可以直改(同 mats_app)
