# 720upgrade.md — MATS v2.0.720 Upgrade Plan

> **作者**: YC Wong · **建立日期**: 2026-07-20
> **來源**: See.md §6.1 P0-A（premature_sl 回流）
> **狀態**: 待實施

---

## P0-A：修 `premature_sl` Dead Code（回流精細 exitType 去 RIL）

### 問題

`CloseReasonAggregator`（`reason-analytics.ts:367`）有段邏輯標記 `premature_sl` / `thesis_invalidated` / `manual_close` 且 WR < 0.3 → ⚠️「premature closes cost X」。

但 `recordClose()`（`thesis-experience.ts:517`）寫入嘅 `exitType` 係**粗分類**：

```
'sl_tp' | 'consensus' | 'manual' | 'thesis_invalidation' | 'reconciliation' | 'exchange_closed'
```

（嚟自 `ThesisExperienceRecord.exitType`，`types/index.ts:528`）

而 `premature_sl` / `correct_sl` 呢類**精細分類只存在 `LessonStatement.exitType`**（`types/index.ts:621`），由 A2A digester（`experience-digester.ts:233` heuristic）或 LLM 生成。

→ `recordClose` 永遠唔會寫入 `'premature_sl'`，所以 `CloseReasonAggregator` 嗰段 premature 警告**永遠唔會觸發**。真正嘅「SL 太早 vs 方向真錯」判斷只發生喺 A2A digester 層，**冇回流去 RIL**。

### 影響

Meta-Agent 嘅 Confidence Calibration（「如果 losses 係 premature_sl → confidence UP，方向可能啱」）喺 RIL 層攞唔到正確數據。

### 目標

讓 Meta-Agent 嘅 Confidence Calibration 喺 RIL 層攞到「SL 太早 vs 方向真錯」嘅正確數據。

---

### 改造步驟

#### Step 1：擴充 `ThesisExperienceRecord.exitType` union

**檔案**：`src/types/index.ts:528`

```ts
// 現有
export type ExitType = 'sl_tp' | 'consensus' | 'manual' | 'thesis_invalidation' | 'reconciliation' | 'exchange_closed';

// 改為（加精細分類）
export type ExitType =
  | 'sl_tp' | 'consensus' | 'manual' | 'thesis_invalidation' | 'reconciliation' | 'exchange_closed'
  | 'premature_sl' | 'premature_tp' | 'correct_sl' | 'correct_tp';
```

> 注意：`LessonStatement.exitType`（`types/index.ts:621`）已經有 `premature_sl | premature_tp | correct_sl | correct_tp | thesis_invalidated`，兩者要對齊。

#### Step 2：`recordClose()` 接收 digester 結論

**檔案**：`src/evolution/thesis-experience.ts:472-541`

- `RecordCloseInput`（`thesis-experience.ts:175`）加 `lessonExitType?: LessonStatement['exitType']` 欄位
- 喺 `recordClose()` 內，如果 `input.lessonExitType` 有值，寫入 `record.exitType`（覆蓋粗分類）
- 如果冇（digester 未跑/失敗），fallback 用現有 `input.exitType` 粗分類

#### Step 3：digester 結果回流時機

**檔案**：`src/evolution/thesis-experience.ts:531` + `src/evolution/experience-digester.ts:472`

- `recordClose()` 已經喺末尾 call `void this.digester.addRecord(record)`（`thesis-experience.ts:531`）
- 改為：digester 生成 `LessonStatement` 後，將 `exitType` 寫回 `record.exitType` 並 `appendRecordToDisk` 更新（或下次 `recordClose` 時一併寫）
- 簡化方案：digester 嘅 `validateLesson()`（`experience-digester.ts:209`）已經 derive 咗 `exitType`，直接喺 `addRecord` 完成後 callback 更新 record

#### Step 4：`CloseReasonAggregator` 無需改

**檔案**：`src/evolution/reason-analytics.ts:330, 367`

- 改完 Step 1-3 後，`aggregate()`（`reason-analytics.ts:330`）讀到嘅 `exitType` 會包含 `premature_sl`，:367 嗰段警告自然觸發

#### Step 5：測試

- 加 `tests/thesis-experience.test.ts` case：模擬 `recordClose` 帶 `lessonExitType='premature_sl'` → 斷言 `record.exitType === 'premature_sl'` → `CloseReasonAggregator.aggregate()` 包含 premature 警告
- 加 `tests/evolution-memory.test.ts` case：驗證 `correct_sl` vs `premature_sl` 喺 RIL pattern map 顯示唔同 confidence 調整

---

### 驗證 gate

`tsc --noEmit` + `npm test` 必須通過（沿用 System Engineer 安全網）

---

### 涉及檔案一覽

| 檔案 | 改動 |
|:-----|:-----|
| `src/types/index.ts:528` | 擴充 `ExitType` union（加 `premature_sl` / `premature_tp` / `correct_sl` / `correct_tp`） |
| `src/evolution/thesis-experience.ts:175` | `RecordCloseInput` 加 `lessonExitType?` 欄位 |
| `src/evolution/thesis-experience.ts:472-541` | `recordClose()` 用 `lessonExitType` 覆蓋粗分類 |
| `src/evolution/thesis-experience.ts:531` | digester `addRecord` callback 回流 `exitType` |
| `src/evolution/experience-digester.ts:472` | `addRecord()` 完成後 callback 更新 record |
| `src/evolution/reason-analytics.ts:330,367` | **無需改**（自然觸發） |
| `tests/thesis-experience.test.ts` | 加 premature_sl 回流測試 |
| `tests/evolution-memory.test.ts` | 加 correct_sl vs premature_sl RIL 測試 |

---

## P0-B：Critical Bug 修復（C1 + C2 + C3）

> **來源**：學習引擎深度代碼審查（2026-07-20）
> **狀態**：待實施

### C1：MFE/MAE 特徵被靜默丟棄（OLR）

**問題**：`index.ts:2244-2257` 將 `mfePct` / `maePct` / `mfeToPnlRatio` 加入 features object，但 `olr-engine.ts:288` `contextToVector` 只 map `FEATURE_NAMES`（8 個），呢 3 個從未進入模型。v2.0.152 comment 聲稱已加但實際冇。MFE/MAE 係最強嘅 win/loss 預測因子。

**改動**：`FEATURE_NAMES` 加 `mfePct` / `maePct` / `mfeToPnlRatio`，shadow trade 亦計算呢 3 個值。

### C2：Agent-outcomes backfill 污染

**問題**：`agent-outcomes.ts:102-110`：一個倉位平倉時，**所有** agent 嘅 record（包括 HOLD 嘅）都標記為 win/loss。Agent A 話 HOLD，Agent B 話 BUY，BUY 輸咗 → Agent A 嘅 HOLD 都被標 LOSS。靜默污染每個 agent 嘅 win rate → 傳入 `agent-evolution.ts` 嘅 voting weight。

**改動**：`backfillOutcome` 只 backfill `recommendedAction !== 'hold'` 且方向匹配嘅 record。

### C3：Direction audit 完全冇接線

**問題**：`direction-audit.ts` 寫好咗 LLM audit（detect 連續方向錯誤、SL 太窄等），`index.ts:53` import 咗但從未 call。零成本嘅 free win——audit signal 已經存在，只係冇 route 入決策 pipeline。

**改動**：每 2 cycle call 一次 `auditTradeRecordsLLM`，cache `AuditResult`，critical incident 匹配 candidate symbol+direction 時 override HOLD。

---

## P1-P3：High-Impact 改進（H1-H8，待跟進）

> **狀態**：待實施（已記錄，等 P0 完成後跟進）
> **最後更新**：2026-07-20 — 代碼驗證 + ROI 修正（原方案 6/8 被推翻）

### 修正後 ROI 排序

| 排名 | 項目 | 修正方案 | Effort (LOC) | ROI | 做嘅順序 |
|:----:|:-----|:---------|:----------:|:---:|:--------:|
| 1 | **H2** | 5-bin calibration map（唔係 Platt） | ~50 | **High** | 🥇 第一 |
| 2 | **H4** | Wilson 只用於 FAST_APPROVE gates（唔係全部） | ~25 | **Medium-High** | 🥈 第二 |
| 3 | **H5** | Threshold 0.3（唔係 0.5） | ~1 | **Medium-High** | 🥉 第三 |
| 4 | **H3** | Hard filter by regime+vol band（唔係 blend cosine） | ~25 | **Medium-High** | 第四 |
| 5 | **H7** | Close-learning 用 consensus.confidence（修復 train/test mismatch） | ~3 | **Medium** | 第五 |
| 6 | **H8** | Soft weighting 1.2×/0.8×（唔係 hard filter） | ~10 | **Medium-High** | 第六 |
| 7 | **H6** | Gate Wilson + boost positionSizePct（唔係 convictionThreshold） | ~15 | **Medium** | 第七 |
| 8 | **H1** | 加 regime feature（唔係 interactions） | ~20 | **Medium-Low** | 第八或跳過 |

---

### H1：OLR 冇 feature interactions（純 linear）

**位置**：`olr-engine.ts`

**原方案**：加 3-5 個 continuous interaction features（`volatility×sentiment`、`fundingRate×sentiment`、`srDistance×volumeRatio`）

**❌ 原方案問題**：
- `FEATURE_NAMES` 已經 11 個（v2.0.720 加咗 MFE/MAE），總記錄 ~101 筆，每 symbol per-side ~30-50 筆
- 11 features 需要 ~110 samples 先穩定 → **已經 under-sampled**
- 加 3 個 interaction = 14 features → 需要 ~140 samples → 更差
- Polynomial 28 個 = 39 features → 需要 ~390 → **完全不可行**（L2=0.001 太弱救唔到）

**✅ 修正方案**：加 `regime` 做 feature（1 個 ordinal 或 4 個 one-hot）
- Regime 已經計好咗（`trending_bull` / `mean_reverting` / `high_vol` / `chaotic`）
- Captures 80% interaction value（trending vs mean-reverting 係最大嘅 interaction effect）
- 只加 1-4 個 feature，唔會 overfit
- ~15-30 LOC

**ROI**：Medium-Low（OLR 只係眾多 channel 之一，改善一個 channel → 2-5% 決策改善）

---

### H2：OLR 冇 calibration（raw sigmoid 當 pWin）

**位置**：`olr-engine.ts:query()`

**原方案**：online Platt scaler（2-param `σ(a×logit+b)` via online SGD）

**❌ 原方案問題**：
- ~30-50 samples per side → 2-param Platt fit 會 noisy
- 需要跨 symbol pool 或等好耐先有足夠 pairs

**✅ 修正方案**：5-bin calibration map（binned empirical calibration）
- 每個 bin 需要 ~5-10 samples → 25-50 total 就夠
- Falls back to identity when bins < 5 samples（零風險）
- `OLRModel` 加 `calibrationBins: Array<{lo, hi, calibrated, count}>`
- `query()` 返 calibrated pWin 而唔係 raw sigmoid
- Agent prompt 嘅硬 threshold（`>60% / <40%`）+ fusion layer 嘅 threshold（`>0.50 / <0.40`）直接受益
- ~50 LOC

**ROI**：**High** — 最高 ROI，直接 sharpen 所有下游 threshold。應該第一個做。

---

### H3：marketFeatures 存咗但 matching 從未用

**位置**：`thesis-experience.ts:519` + `checkThesisHistory()`

**原方案**：blend condition cosine 入 similarity（weight 0.3-0.5）

**❌ 原方案問題**：
- `marketFeatures` 7-dim，scale 差異極大：`srDistanceBps` ~0-500 vs `fundingRate` ~0.0001
- **Raw cosine 被 `srDistanceBps` 完全 dominate**——normalization 係 mandatory
- Blend 方案會 break 8+ 個 tests（test records 冇 `marketFeatures`）
- Magic weight 0.3-0.5 需要 tuning

**✅ 修正方案**：Hard filter by regime + volatility band
- Matching loop 入面，先 filter 掉 regime 唔同 + volatility 差太遠嘅 records
- 再喺 filtered set 入面做 text similarity（現有邏輯唔變）
- 如果冇 record pass filter → fallback 到現有行為（零 regression）
- 自然處理 scale 問題（per-feature threshold，唔需要 normalize）
- ~25 LOC，**零 test break**

**ROI**：Medium-High（safe，no test churn）

---

### H4：wilsonScore 存在但 raw winRate 用喺決策

**位置**：`evolution-utils.ts:8`（已實現但 EXP/RIL/digester 冇用）

**原方案**：replace 全部 raw winRate 為 wilsonScore

**❌ 原方案問題**：
- `wilsonScore` **已經用咗**喺 `pattern-tag-tracker.ts` 同 `trade-pattern-classifier.ts`（RIL pattern systems）
- Full replacement 太保守：Wilson LB for 5/5 = 0.48 → agent weight multiplier 從 ×1.1 跌到 ×0.58（崩潰）
- FAST_APPROVE gate：5/5 = Wilson 0.48 < 0.6 → **永遠唔觸發**

**✅ 修正方案**：Hybrid——Wilson 用於 gates，raw 用於 continuous weights
- `thesis-experience.ts:605`：`wilsonScore(best.wins, best.count) >= classWinThreshold`（FAST_APPROVE gate）
- `thesis-experience.ts:752`：`wilsonScore(wins, total) >= winProbThreshold`（similarity pWin gate）
- Leave `agent-evolution.ts:95`、`em-clustering.ts:302`、`index.ts:253` as raw winRate
- ~15-25 LOC + ~8-10 test fixture updates

**ROI**：Medium-High（精準打擊小樣本 overconfidence，唔影響 continuous weights）

---

### H5：Pattern classifier 方向 threshold = 0

**位置**：`index.ts:4772`：`if (buyWr > 0 || sellWr > 0)`

**原方案**：改為 `Math.max(buyWr, sellWr) > 0.5 && Math.abs(buyWr - sellWr) > 0.1`

**❌ 原方案問題**：
- `adjustedWinRate` **已經係 Wilson-scored**（`trade-pattern-classifier.ts:403`）
- Wilson LB for 5/5 = 0.48 < 0.5 → 即使完美記錄都唔通過 → pattern classifier 永遠唔觸發 → fall through to EM

**✅ 修正方案**：Threshold 0.3（唔係 0.5）
- Wilson LB 0.3 對應 ~5/8 = 62.5% raw WR（合理）
- 加 `Math.abs(buyWr - sellWr) > 0.1` 防止邊緣差異驅動方向
- `if (Math.max(buyWr, sellWr) > 0.3 && Math.abs(buyWr - sellWr) > 0.1)`
- ~1 LOC

**ROI**：Medium-High（極小改動，消除 noise-driven 方向）

---

### H6：Shadow soft gate static threshold + 冇 symmetric boost

**位置**：`index.ts:5550`

**原方案**：`wilsonLowerBound < 0.30 && total >= 20` + boost `convictionThreshold *= 0.8`

**❌ 原方案問題**：
- Boost `convictionThreshold *= 0.8` 會同 adaptive filter interaction → 可能 create feedback loop（更多 trade → 更多 shadow → 更多 boost → 更多 trade）

**✅ 修正方案**：Gate 用 Wilson（正確），boost 改為 `positionSizePct *= 1.2`
- Gate：`wilsonScore(shadowWins, shadowTotal) < 0.30 && shadowTotal >= 20` → HOLD
- Boost：`wilsonScore(shadowWins, shadowTotal) > 0.65 && shadowTotal >= 20` → `positionSizePct *= 1.2`
- Boost size 唔 touch conviction threshold → 冇 feedback loop
- 需要加 `import { wilsonScore } from './evolution/evolution-utils.ts'`
- ~15 LOC

**ROI**：Medium（用埋 shadow positive tail，冇 feedback loop risk）

---

### H7：signalAgreement 係死 feature

**位置**：`index.ts:2217`（close-learning 用 0.5）vs `index.ts:5370,6185`（query 用 consensus.confidence）

**原方案**：計算實際 agent agreement ratio，或移除

**❌ 原方案問題**：
- **唔係全部 0.5**！有 6 個 call sites 用 `result.consensus.confidence`
- 但 close-learning（training）用 0.5，query 時有真值 → **train/test mismatch**（比完全 dead 更差）
- 計算 agent agreement 太複雜，移除要 migrate model

**✅ 修正方案**：Close-learning 時用 `result.consensus.confidence`（同 query 一致）
- 只改 1 個 call site（`index.ts:2217`）：`const signalAgreement = 0.5` → 用最近 cycle 嘅 consensus confidence
- Shadow features 用 0.5 係合理嘅（shadow 冇 consensus）
- ~3 LOC

**ROI**：Medium（修復 train/test mismatch，極小改動）

---

### H8：assetCategory 喺 matching/clustering 唔 filter

**位置**：`thesis-experience.ts:700`（pWin path）、`reason-analytics.ts:413`（SimilarTradeRetriever）、`PatternClusterManager`

**原方案**：加 hard filter

**❌ 原方案問題**：
- 5 個 categories，~101 筆 → ~20 筆/category
- Hard filter 太激進——如果某 category 只有 2 筆，matching 返空 → fallback 到 PASS_OPEN_DIRECTLY（等於冇學習）

**✅ 修正方案**：Soft weighting——same-category matches 得 1.2× weight，cross-category 得 0.8× weight
- 喺 pWin 計算入面，`totalW` 同 `winW` 都乘 category weight
- 唔係 hard filter，永遠有 matches
- Delta check 已經有 same-cat 邏輯，呢個係 pWin path 嘅補充
- ~10 LOC

**ROI**：Medium-High（safe，漸進，消除跨 asset pollution）