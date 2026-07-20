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

| # | 問題 | 位置 | 預計準確度提升 | 改動規模 |
|---|------|------|:------------:|:--------:|
| **H1** | OLR 冇 feature interactions（純 linear） | `olr-engine.ts` | +5-20% | 中（加 3-5 個 interaction feature：`volatility×sentiment`、`fundingRate×sentiment`、`srDistance×volumeRatio`） |
| **H2** | OLR 冇 calibration（raw sigmoid 當 pWin） | `olr-engine.ts:query()` | 決策質素大幅提升 | 中（加 online Platt scaler：track `(predictedPWin, actualOutcome)` pairs，fit `σ(a×logit+b)` via online SGD） |
| **H3** | `marketFeatures` 存咗但 matching 從未用 | `thesis-experience.ts:519` + `checkThesisHistory()` | 消除最大 EXP accuracy leak | 中（改 `combinationSimilarity` 加 condition cosine，weight 0.3-0.5） |
| **H4** | `wilsonScore` 存在但全部用 raw `winRate` | `evolution-utils.ts:8` unused by EXP/RIL/digester | 消除小樣本 overconfidence | 小（replace 全部 `winRate` 為 `wilsonScore`，gate FAST_APPROVE on Wilson > 0.5） |
| **H5** | Pattern classifier 方向 threshold = 0 | `index.ts:4730`：`buyWr > 0 \|\| sellWr > 0` | 消除 noise-driven 方向 | 極小（改為 `Math.max(buyWr, sellWr) > 0.5 && Math.abs(buyWr - sellWr) > 0.1`） |
| **H6** | Shadow soft gate static threshold + 冇 symmetric boost | `index.ts:5550` | 用埋 shadow positive tail | 小（改用 `wilsonLowerBound < 0.30 && total >= 20`；加 boost：`wilsonLowerBound > 0.65` → `convictionThreshold *= 0.8`） |
| **H7** | `signalAgreement` 係死 feature（永遠 0.5） | `index.ts:2205, 3364, 3445` | 1-3%（或移除） | 小（計算實際 agent agreement ratio，或移除） |
| **H8** | `assetCategory` 喺 matching/clustering 唔 filter | `thesis-experience.ts:700`、`reason-analytics.ts:413`、`PatternClusterManager` | 消除跨 asset pollution | 小（加 filter） |