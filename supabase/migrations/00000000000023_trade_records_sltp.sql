-- v2.0.873-P0-4: SL/TP 價持久化——buildTradeRow 新增 SL/TP 字段同步上雲
-- 背景:realTrades 0/292 有 SL(白名單漏咗),離場研究(SL-aware replay)樽頸。
--      buildTradeRow 已加 original/final stop_loss + take_profit + sl_narrowed。
-- 遷移:ALTER TABLE 加 column(若不存在——idempotent)

alter table public.trade_records
  add column if not exists original_stop_loss_price numeric,
  add column if not exists final_stop_loss_price numeric,
  add column if not exists original_take_profit_price numeric,
  add column if not exists final_take_profit_price numeric,
  add column if not exists sl_narrowed boolean;
