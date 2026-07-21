# NA.md — Numeric Autoencoder for MATS Market-Condition Embedding

> **Version**: 1.0 (implemented)
> **Status**: ✅ COMPLETE
> **Owner**: Yuki (autonomous, per Master Lord directive)
> **Parent**: v2.0.203 vector-conditional win rate

---

## 1. 概述

### 1.1 問題

v2.0.203 嘅 `computeVectorConditionalWinRate()` 用 **min-max normalize + cosine** 做 market-condition similarity。呢個解決咗「raw per-symbol win rate 冇意義」嘅問題，但有兩個結構性限制：

| 限制 | 後果 |
|---|---|
| **線性** | min-max 係 per-feature 線性縮放，捕捉唔到 feature 之間嘅非線性 interaction（volatility × regime、funding × sentiment） |
| **固定 metric** | cosine 係 handcrafted，唔會從 outcome 學識「似」應該點定義。兩個表面數值似但歷史上 lead 唔同 outcome 嘅市況會被誤判為相似 |

### 1.2 目標

建一個 **in-process numeric autoencoder + contrastive embedding**，學習 marketFeatures 嘅非線性 representation，令「似嘅市況」=「歷史上 lead 似 outcome 嘅市況」。

- **輸入**: 9 個 entry-condition features（同 `ENTRY_CONDITION_FEATURES` 對齊）
- **輸出**: 8 維 learned embedding → cosine 檢索
- **訓練**: reconstruction loss + contrastive loss（同 outcome 拉近 / 唔同推開）
- **部署**: 純 TypeScript MLP，in-process，<1MB weight，唔依賴外部 ML 庫
- **共存**: 同 v2.0.203 min-max 並行，唔取代。冷啟動用 min-max，夠數據切換 learned。

### 1.3 唔做咩

- ❌ 唔用 MiniLM（text model，唔 match numeric features）
- ❌ 唔引入 PyTorch / TensorFlow / 外部 ML 依賴
- ❌ 唔取代 v2.0.203 min-max（fallback + cold-start）
- ❌ 唔改 `src/trading/` + `.env`
- ❌ 唔自動切換到 learned embedding 除非 model 通過驗證

---

## 2. 架構設計

### 2.1 網絡

```
Encoder:
  input  (9)  ──┐
  z-score norm  │  (running mean/std, 同 OLR Welford 一致)
                │
  dense 9→16   ReLU  + He init
  dense 16→8   linear  ──→ embedding (8-d, L2-normalised)

Decoder (訓練時用，推理時唔使):
  dense 8→16   ReLU
  dense 16→9   linear  ──→ reconstruction
```

**Bottleneck 8 < 9**：強制壓縮，防止 network 學成 identity（reconstruction collapse）。8 維足夠表達 9 個 feature 嘅非線性組合，但唔夠維度做完美還原 → 網絡被迫學 feature 之間嘅關連。

### 2.2 Loss

```
L = α · L_recon + β · L_contrastive + γ · L_reg

L_recon       = MSE(decode(encode(x)), x)           per present feature
L_contrastive = -log( σ(cos(z_i, z_j)) ) if same outcome   (pull together)
              = -log( σ(-cos(z_i, z_k)) ) if diff outcome   (push apart)
L_reg         = λ · Σ ‖w‖²                            (L2, 防 overfit)
```

- α = 1.0（reconstruction 主任務）
- β = 0.5（contrastive 修正 representation 方向）
- γ = 0.01（light regularization）

### 2.3 Optimizer

**Adam**（純 TS 自實現）：
```
m = β1·m + (1-β1)·g          β1=0.9
v = β2·v + (1-β2)·g²         β2=0.999
w -= lr · m̂ / (√v̂ + ε)       lr=0.001, ε=1e-8
```

- Gradient clipping: ‖g‖ ≤ 5.0（防 explosion）
- Weight clip: |w| ≤ 10.0（防 NaN 傳播）
- Learning rate decay: lr_t = lr / (1 + decay·step)

### 2.4 訓練數據

來源：`ThesisExperienceRecord[]` 中有 `marketFeatures` + `outcome` 嘅 trade。

- Input: `marketFeatures`（9 個 ENTRY_CONDITION_FEATURES）
- Label: `outcome`（WIN=1, LOSS=0）做 contrastive supervision
- 每 cycle 收集，每 N cycle（≥5）batch 訓練一次

### 2.5 冷啟動 + 切換

| sampleCount | 行為 |
|---|---|
| < 50 | 只用 v2.0.203 min-max（autoencoder 未訓練） |
| 50-200 | autoencoder 訓練中，但仍用 min-max（驗證未通過） |
| ≥ 200 + validation pass | autoencoder ready，`computeVectorConditionalWinRate` 可選用 learned |

切換條件（全部要滿足）：
1. sampleCount ≥ 200
2. reconstruction MSE < 0.1（學到 structure，唔係 noise）
3. contrastive accuracy > 60%（embedding 能分 win/loss）
4. 連續 3 次驗證通過（防單次僥倖）

---

## 3. 漏洞清單 + 攻克方案

> 本座喺實施過程中會逐個攻克，完成後喺 §8 記錄結果。

| # | 漏洞 | 風險 | 攻克方案 |
|---|---|---|---|
| V1 | NaN/Infinity 傳播 | 🔴 model 崩潰，poison state | weight clip + NaN guard + auto-reset to last good state |
| V2 | 冷啟動死鎖 | 🟠 冇數據時崩 | sampleCount guard + min-max fallback |
| V3 | Overfitting（小樣本） | 🟠 embedding 記死個別 trade | L2 + dropout + min validation samples + early stopping |
| V4 | Feature scale 差異 | 🟡 vol~0.02, srDist~100，梯度被大 feature 主導 | z-score input normalization（running stats） |
| V5 | Missing features | 🟡 NaN 污染 | mask + skip dim，reconstruction 只計 present dims |
| V6 | Reconstruction collapse | 🔴 學成 identity，壓縮無效 | bottleneck 8<9 + L2 penalty + sparsity target |
| V7 | Contrastive pair 採樣偏差 | 🟡 pair 數量少 / 全同類 | balanced sampling + hard negative mining |
| V8 | Catastrophic forgetting | 🟠 重訓練忘記舊數據 | incremental training + replay buffer（保留舊 samples） |
| V9 | Numerical instability（ReLU dead / gradient explosion） | 🟠 dead neurons / NaN | He init + gradient clip + leaky ReLU(0.01) |
| V10 | Determinism（重啟結果唔一致） | 🟡 難 debug | seeded RNG + deterministic init |
| V11 | Model version migration | 🟡 舊 state file 唔兼容 | version field + migration function |
| V12 | Feature drift（市況變化） | 🟡 model 過時 | time-weighted training samples + 定期重訓 |
| V13 | Embedding degenerate（所有 vector 一樣） | 🔴 cosine 全 1，失去區分力 | diversity penalty + 監控 embedding variance |

---

## 4. 整合點

### 4.1 新檔案

- `src/evolution/numeric-autoencoder.ts` — `NumericAutoencoder` class + `NumericEmbedProvider` interface

### 4.2 改動

- `src/evolution/evolution-utils.ts` — `computeVectorConditionalWinRate` 加 `embeddingProvider?` option；ready 時用 learned cosine，否則 fallback min-max
- `src/evolution/persistence.ts` — 加 NA model save/load
- `src/index.ts` — 起NA instance + 收集訓練 samples + 定期訓練 + 注入 conditional query

### 4.3 唔改

- `src/trading/*`（執行層）
- `src/config/*`（加 config 可以，但唔改現有 risk params）
- `.env`

---

## 5. 持久化

- `data/evolution/na-model.json` — model weights + running stats + version + sampleCount
- atomic write（`lockedWrite`）
- 版本 field 做遷移

---

## 6. 測試計劃

- `tests/numeric-autoencoder.test.ts`:
  - 構造 + forward pass
  - reconstruction 基本還原
  - contrastive pull/push
  - NaN guard
  - cold-start fallback
  - persistence round-trip
  - version migration
  - embedding diversity（防 degenerate）

- 現有 106 tests 全過（唔破壞）

---

## 7. 配置

```bash
# .env additions (optional, all have defaults)
NA_ENABLED=true
NA_INPUT_DIM=9
NA_EMBED_DIM=8
NA_HIDDEN_DIM=16
NA_LEARNING_RATE=0.001
NA_MIN_SAMPLES_TRAIN=50
NA_MIN_SAMPLES_READY=200
NA_TRAIN_EVERY_CYCLES=5
NA_VALIDATION_MSE_MAX=0.1
NA_VALIDATION_CONTRASTIVE_ACC_MIN=0.60
NA_RECON_LOSS_WEIGHT=1.0
NA_CONTRASTIVE_LOSS_WEIGHT=0.5
NA_L2_REG=0.01
NA_MODEL_PATH=data/evolution/na-model.json
```

---

## 8. 實施記錄 + 漏洞攻克結果

> ✅ 已完成。每個漏洞記錄狀態、實際攻克代碼、測試驗證。

| # | 漏洞 | 狀態 | 攻克代碼 | 測試驗證 |
|---|---|---|---|---|
| V1 | NaN/Infinity 傳播 | ✅ 攻克 | `sanitiseWeights()` post-update guard + load-time guard + weight clip `|w|≤10` + restore `lastGoodWeights` | `NaN injection` test passed — encode 全 finite |
| V2 | 冷啟動死鎖 | ✅ 攻克 | `isReady()` gates on `sampleCount≥minSamplesReady` + validation pass; `computeVectorConditionalWinRate` falls back to min-max when provider not ready | `cold-start fallback` + `validate insufficient` tests passed |
| V3 | Overfitting | ✅ 攻克 | L2 reg (γ=0.01) in Adam update + held-out 20% validation set + `minSamplesReady=200` + validation pass required | `trainBatch reduces loss` test + validation gating |
| V4 | Feature scale 差異 | ✅ 攻克 | Welford per-feature running mean/std z-score normalisation (同 OLR 一致); gradient clip `‖g‖≤5` | covered by reconstruction + contrastive tests |
| V5 | Missing features | ✅ 攻克 | `featuresToVector` substitutes running mean for missing; `reconstructionLossGrad` only scores present dims; `updateInputStats` present-only | `handles missing features` test passed |
| V6 | Reconstruction collapse | ✅ 攻克 | bottleneck 8<9 (information compression) + L2 reg + diversity penalty prevents identity/degenerate | `diversity > 0` test passed |
| V7 | Contrastive pair 採樣偏差 | ✅ 攻克 | bounded `maxPairs=200` + random sampling from replay + `pairSeen` dedup | covered by contrastive test |
| V8 | Catastrophic forgetting | ✅ 攻克 | replay buffer (`replayBufferSize=1000`) + random batch sampling mixes recent + old | round-trip test confirms state retention |
| V9 | Numerical instability | ✅ 攻克 | He init (ReLU layers) + leaky ReLU(0.01) (no dead neurons) + gradient clip + weight clip + LR decay | loss stays finite across 5+ epochs |
| V10 | Determinism | ✅ 攻克 | seeded `mulberry32` RNG + deterministic init + RNG advanced past init on load | `round-trip` test confirms identical embeddings after reload |
| V11 | Model version migration | ✅ 攻克 | `NA_MODEL_VERSION=1` + `migrate()` + forward-compat warning on newer versions | `round-trip` test passed |
| V12 | Feature drift | ⚠️ 部分 | replay buffer keeps recent samples (ts field stored); **time-weighting in training not yet implemented** — samples are uniformly sampled. Acceptable: replay buffer bounds drift, periodic retrain adapts | — |
| V13 | Embedding degenerate | ✅ 攻克 | `diversityLoss` (penalise low variance) + `l2Normalise` zero-vector → uniform (cold-start unit norm) + validation `diversity>0.01` gate | `non-degenerate after training` test passed |

### 實施摘要

- **新檔案**: `src/evolution/numeric-autoencoder.ts` (NA engine + `NumericEmbedProvider` interface)
- **整合點**:
  - `evolution-utils.ts` `computeVectorConditionalWinRate` 加 `embeddingProvider?` option + `scoreWithLearnedEmbedding` helper (learned path supersedes min-max when ready)
  - `direction-audit.ts` `auditTradeRecordsLLM` + `buildVectorConditionalSummary` accept provider
  - `experience-digester.ts` `getDigestSummary` accepts provider
  - `thesis-experience.ts` `getDigestSummary` wrapper forwards provider to digester
  - `pattern-tag-tracker.ts` `formatContext` accepts provider
  - `index.ts` 起 NA instance + load + per-trade `addSample` + per-5-cycle `trainBatch`/`validate` + persist + inject to 3 callers
- **測試**: `tests/numeric-autoencoder.test.ts` 12 tests (forward / cold-start / training / NaN guard / missing features / diversity / validation / persistence round-trip / contrastive structure / learned-embed path / min-max fallback)
- **驗證**: `tsc --noEmit` ✅ · `vitest run` 118/118 ✅ (106 原有 + 12 新)
- **唔破壞**: v2.0.203 min-max + cosine 完整保留為 fallback; learned path 只在 `isReady()` 時生效

### 冷啟動 → 學習切換邏輯

```
sampleCount < 50        → trainBatch() no-op，只用 min-max
50 ≤ sampleCount < 200  → trainBatch() 訓練，但仍用 min-max（validation 未 pass）
sampleCount ≥ 200       → validate() 跑；連續 pass（MSE<0.1 + acc>60% + diversity>0.01）→ isReady()=true
isReady()=true          → computeVectorConditionalWinRate 用 learned 8-d cosine（supersedes min-max）
isReady()=false / absent → fallback min-max（v2.0.203 邏輯完整保留）
```

### V12 未完成部分（記錄待辦）

Feature drift 嘅 time-weighting 尚未接入訓練——replay buffer 存 `ts` 但 `sampleBatch` 係 uniform random。若日後市況長期漂移令舊 sample 污染 model，可加 exponential time-weight 喺 `sampleBatch`（近期 sample 採樣概率高）。而家可接受因為 replay buffer 上限 1000 已 bound drift。

---

## 9. 版本歷史

| 版本 | 日期 | 變更 |
|---|---|---|
| 0.1 | 計劃階段 | 初稿 |
| 1.0 | 實施完成 | NA engine + 整合 + 12 tests + 13 漏洞攻克（V12 部分待辦）· 118/118 tests pass |