-- 00000000000021_asset_analyses_edge_report.sql
-- v2.0.869-P9: asset_analyses 加 edge_report 列(頂層 edge 報告)。
--
-- 背景:buildAssetAnalysis 一直計算 edgeReport(Edge Validation Layer 嘅
-- 5-component edgeScore + recommendation),但 writeCycle 從未寫入 Supabase
-- (只寫 symbol/cycle_id/updated_at/market_data/consensus/matrix/metadata)。
-- frontend 嘅 AssetAnalysisRow type 有 edgeReport?(頂層),但永遠讀唔到。
--
-- 修正:加 edge_report jsonb 列(可空——冇 edge 數據時 null)。
-- matrix cell 嘅 edge 仍然喺 matrix.moderate[state].edge(向後兼容)。

alter table public.asset_analyses
  add column if not exists edge_report jsonb;

comment on column public.asset_analyses.edge_report is
  'Risk-neutral edge report (Edge Validation Layer 5-component edgeScore + recommendation). Written each cycle by the MATS backend; null when no edge data. Also embedded per-cell at matrix.moderate[state].edge.';
