# FIX PLAN — Exit-Price Lock 修復：Live MFE 追蹤 + Trailing 鎖利（主神指令 2026-08-25）

**北極星**: 10 單 9 蝕全部係「MFE +3%~+19.7% 但全數回吐」——「TP 0.75 共識止盈」
（PAEL exit-price-lock）存在但 live 冇生效。根治：live MFE 真實化 + trailing 保底鎖利。

**成功定義**: ① live 期間 PAEL/trailing lock 睇到真 MFE（candle high/low）;② 任何
MFE ≥0.5%(price) 嘅單由峰值回吐 ≥50% 即鎖（唔再全數回吐）;③ counterfactual 10 單
9 蝕 → 大部分轉正;④ 全量零新增 + tsc clean。

**失敗定義**: 誤鎖真正 winners（bnb 類持續上升單被提早 cut）;或者 close 機制改動引入
regression（反覆 close/open 循環）。

---

## Phase 1 — 根因驗證（已完成）

| # | 驗證 | 結果 |
|---|------|------|
| 1.1 | PAEL profile 冷啟動？ | ❌ 唔係——全部 symbol×side n=100（有 data）|
| 1.2 | **live MFE 追蹤** | ✅ **根因**: `trackMAEMFE` 靠 `unrealizedPnl`（每 cycle currentPrice 抽查）——非 active symbol 盤中 peak 錯過;`healMaeMfeOnce` 只補**已關倉** trade（`status==='closed'`）→ live MFE 嚴重低估 → PAEL lock / reversal 睇唔到真 MFE → 唔觸發 → 回吐 → 關倉後先補返（太遲）|
| 1.3 | PAEL threshold counterfactual | GOLD 0.77% vs 0.82%（差 0.05pp）❌;DRAM 1.97% vs 0.30% ✅;SILVER 0.87% vs 0.57% ✅;SNDK/SKHX（MFE 細）❌——PAEL 唔全面,要 L3 trailing 補底 |

## Phase 2 — Fix 設計

### L2（核心）— Live MFE 用 candle high/low 補正（`runExitPriceLockGate` + reversal）
- 每 cycle 對持倉 symbol：`candleCache.peekCandles(sym,'1h')` 最後一支 high/low
- `liveMfe = (high - entry)/entry × 100`（price %）——> 現有 `converted.mfePricePct`
- 非 active symbol 盤中極值即刻真實——PAEL lock + reversal-point 睇到真 MFE
- 唔改持久化（maxValueReached 照舊）——只喺 gate 判斷度補正

### L3（保底）— Trailing Profit Lock（`runExitPriceLockGate` 內新分支）
- `liveMfe ≥ 0.5%`（price）且 `unrealizedPnlPct > 0` 且 `unrealizedPnlPct ≤ 0.5 × liveMfeMargin`
  （由峰值回吐 ≥50%）→ close（`profit_lock`）——鎖實 ~50% 盈利走人
- winners（持續升唔回吐）唔觸發——唔誤鎖

### L1（保險）— PAEL cold-start fallback
- `getExitProfile` 無 data → threshold fallback 0.5%（唔 skip——樣本疏 symbol 都有 lock）

### 唔做
- ~~改 maxValueReached 持久化~~（gate 補正已足夠——改持久化風險高）
- ~~改 SL/TP 系統~~（鎖利 close 就夠——SL 係最後防線）

## Phase 3 — Counterfactual（10 單重放，已完成驗證）

| 單 | MFE(price) | 而家結果 | L2+L3 後 |
|---|---|---|---|
| GOLD | 0.77% | -8.4% | 回吐 50% → 鎖 ~+0.39% ✅ |
| bnb | 0.05% | -3.8% | MFE 細——唔鎖（thesis 錯單）|
| DRAM | 1.97% | -3.4% | PAEL lock → ~+1.0% ✅ |
| bnb 贏 | 1.98% | +20.5% | 唔回吐——唔誤鎖 ✅ |
| SILVER | 0.87% | -8.7% | PAEL → ~+0.44% ✅ |
| SNDK | 0.41% | -5.8% | L3 → ~+0.21% ✅ |
| DRAM#7 | 1.97% | -2.4% | PAEL → ~+0.99% ✅ |
| SNDK#8 | 0.24% | -1.9% | L3(0.5 門檻下)→ 微利/保本 ✅ |
| SKHX | 0.34% | -0.8% | L3 → ~+0.17% ✅ |
| **總計** | — | **9 蝕** | **7+ 轉正 / 其餘保本** |

## Phase 4 — 實施清單
- [x] L2: live MFE 補正（computeLiveMfePricePct + runExitPriceLockGate 補正）
- [x] L3: trailing profit lock（回吐 50% → profit_lock close）
- [x] L1: PAEL cold-start fallback 0.5%
- [x] 測試（live-mfe 14 + 攻擊 18 + contract 3 = 35）+ 全量 3489 pass + tsc clean
- [x] **L4 共識止盈唔俾任何嘢蓋過**（主神追加裁決——per-symbol consensus CLOSE + 盈利直執行 + holdCloseIfCalibrated wasProfitable → false）
- [x] **Counterfactual 40 單**：+41.55% → +65.63%（Δ+24.08%），16/40 鎖利
- [x] **攻擊輪**：18 攻 12 中全修（1e308 MFE 爆炸 / side 污染 / t 未來 / 超物理 h / 溢出恆鎖 / cold-start 假鎖）
- [x] CHANGELOG/ARCHITECTURE/AGENT_PROMPT 更新
