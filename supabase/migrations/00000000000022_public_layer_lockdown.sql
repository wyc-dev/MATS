-- ═══════════════════════════════════════════════════════════════════
-- 00000000000022_public_layer_lockdown.sql
-- v2.0.870-P34: 公開層最小化 —— ui_snapshots 私有化 + signals_lite 輕量視圖
--
-- 背景(主神私隱洞察):lite app 係公開用戶端,用戶永遠唔應該見到帳戶
-- 倉位/結餘。審計發現 ui_snapshots 帶 "ui_snapshots public read" policy
-- (任何 anon key 持有人讀到 status=結餘 + portfolio=倉位明細)——門已開。
-- 同時:thesis(LLM 推理文字)可公開,但 lite 版唔想嘥流量。
--
-- 三件事:
--   1. ui_snapshots 公開可讀 → 只限 authenticated(AgentMonitor/內部登入)
--   2. edge_report 列確保存在(21 未行都無所謂——IF NOT EXISTS 冚冚聲)
--   3. signals_lite 視圖——lite app 只讀呢個(thesis 剔除慳流量;
--      security_invoker 繼承 asset_analyses 嘅 public-read RLS)
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1. ui_snapshots:關門 ──────────────────────────────────────────
-- 舊政策:任何 anon key 持有人可以讀晒全部 sections(含 portfolio/status)
drop policy if exists "ui_snapshots public read" on public.ui_snapshots;

-- 新政策:只有 authenticated 用戶讀到(backend 寫入照舊經 service_role,
-- RLS bypass——唔受影響);公開 app 完全冇得掂。
create policy "ui_snapshots authenticated read"
  on public.ui_snapshots for select
  using (auth.role() = 'authenticated');

-- ─── 2. edge_report 列(視圖依賴;21 未行都得)───────────────────────
alter table public.asset_analyses
  add column if not exists edge_report jsonb;

-- ─── 3. signals_lite 視圖:公開 app 唯一讀取面 ──────────────────────
-- security_invoker = true:視圖以查詢者權限執行,繼承底表 asset_analyses
-- 嘅 RLS 政策("read asset analyses" = using(true),anon 可讀)——
-- 唔會意外放大權限。
create or replace view public.signals_lite
with (security_invoker = true)
as
select
  symbol,
  cycle_id,
  updated_at,
  market_data,                       -- 市場上下文(價/trend/regime/momentum/volume/σ)
  consensus - 'thesis' as consensus, -- 剔除 LLM 推理文字——lite 慳流量
  matrix,                            -- moderate.long/short/flat 三態 edge
  edge_report                        -- 風險中性 edge(可空)
from public.asset_analyses;

comment on view public.signals_lite is
  'Lite app signal feed: per-asset direction/confidence/edge 3-state/SL-TP/market context. thesis stripped to save traffic. Public read (inherits asset_analyses RLS).';
