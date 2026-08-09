-- v2.0.868: Trade Records — 正確表結構(supabase-trade-writer 專用)
-- 背景:舊 trades 表係 mats_app 早期手動建(direction/buy_price/sell_price/
--       sell_time/buy_time/source_id)——同 supabase-trade-writer 期望結構
--       (trade_id/symbol/side/entry_price/exit_price/pnl_pct)完全唔 match
--       → select('trade_id') 報 42703 column does not exist → 每次寫入失敗
-- 修正:新表 trade_records(唔郁舊 trades 表——歷史數據安全)
--       trade_id unique constraint → upsert idempotent(重複 close 事件唔重複 row)

create table if not exists public.trade_records (
  id bigint generated always as identity primary key,
  trade_id text unique not null,          -- close 事件 uuid(TG dedup + upsert key)
  symbol text not null,
  side text not null,                     -- buy | sell
  mode text not null default 'real',      -- real | paper
  entry_price numeric,
  exit_price numeric,
  quantity numeric,
  leverage numeric,
  investment numeric,
  pnl numeric,
  pnl_pct numeric,
  opened_at bigint,                       -- epoch ms
  closed_at bigint,                       -- epoch ms
  close_reason text,
  entry_thesis text,
  exit_thesis text,
  post_review text,
  min_value_reached numeric,
  max_value_reached numeric,
  agent_id text,
  created_at timestamptz not null default now()
);

create index if not exists trade_records_symbol_idx on public.trade_records (symbol);
create index if not exists trade_records_closed_at_idx on public.trade_records (closed_at desc);
create index if not exists trade_records_mode_idx on public.trade_records (mode);

alter table public.trade_records enable row level security;
-- service_role(後端)自動 bypass RLS;如 mats_app 用 anon 讀需加 policy
create policy if not exists "trade_records_read" on public.trade_records
  for select using (true);
