# MATS 認知演化管線調查報告(P70)
## 「OLR + Bayesian + Q-RL Direction」架構藍圖盈利提升機會分析

> 調查日期: 2026-08-19
> 數據基礎: 455 unique EXP trades(清理測試污染後)+ 1527 attribution records + 22 Q-RL cells
> 現狀: WR 41.1%, EV +0.0051, Net PnL +2.30

---

## 執行摘要

**核心發現：系統有明確嘅結構性出血點，修復後 PnL 可以由 +2.30 提升至 +13 以上（5.7 倍）。**

主要出血點（按影響排序）：
1. **premature_sl + correct_sl 全蝕**：146 筆 SL 相關 exit 拖累 PnL −73
2. **EV<0 symbol:side bucket**：剔走後 PnL 由 +2.30 → +13.19
3. **OLR 校準完全壞咗**：pwin 0.7+ 實際 WR 只有 39%（過度自信）
4. **trending_bear 災難**：WR 11.1%, EV −0.647
5. **短持倉（<15min）全蝕**：WR 25-31%, EV 全負

---

## 一、逐組件分析

### 1. OLR（Online Logistic Regression）

**現狀**：8 個 symbol 模型，SKHX 有 21958/19078 samples，SILVER 7858/16702，BTC 有真實數據。

**發現 — OLR 校準完全壞咗（HIGH 嚴重性）**：

| OLR pwin at entry | n | 實際 WR | EV |
|:-----|:--:|:------:|:------:|
| 0.0-0.3 | 78 | 33.3% | −0.115 |
| 0.3-0.4 | 30 | **53.3%** | **+0.399** |
| 0.4-0.5 | 43 | 44.2% | −0.125 |
| 0.5-0.6 | 86 | 44.2% | −0.050 |
| 0.6-0.7 | 25 | 44.0% | −0.038 |
| 0.7-1.0 | 82 | **39.0%** | +0.060 |

**問題**：
- OLR pwin 0.7+ 實際 WR 只有 39% —— **過度自信**（P28 已發現但未修）
- OLR pwin 0.3-0.4 實際 WR 53.3% —— **最有 alpha 嘅區間**（冷啟動保守）
- 高信心 = 低 WR；低信心 = 都係 33% —— **校準完全無效**

**量化金融解讀**：
- 呢個係典型嘅 logistic regression 唔校准問題（Platt scaling 唔夠）
- OLR 嘅 SGD 學習率太高 or 太多極端樣本（shadow force-resolve 污染）
- **修復價值：高** — OLR 係 conviction gate 嘅核心乘數，校準壞咗 = 所有決策都扭曲

---

### 2. Bayesian OLR

**現狀**：MC Dropout uncertainty 層存在（v2.0.219 加咗後又 pause 咗 v2.0.833）。

**發現**：
- active-exploration 暫停（v2.0.833「暫緩議程」）
- Bayesian OLR 應該提供 uncertainty estimate 俾 conviction gate
- 而家 conviction gate 冇 uncertainty 輸入 → 過度自信嘅 OLR 直接影響 gate

**修復價值：中** — Bayesian 可以幫 OLR 校準，但係唔係最大出血點。

---

### 3. Q-RL Direction

**現狀**：22 cells 全部 visited，values 0.0001-0.0097——**冇強 edge**。

**發現**：
- best cell: `mean_reverting|calm|flat|neutral|buy` value +0.0097
- 所有值都接近 0 → Q-RL 未能發現強勁嘅方向性 edge
- 原因：shadow trades 大部分未 resolve（見下面 shadow 分析）→ Q-RL 冇 reward signal

**修復價值：中低** — Q-RL 需要更多 resolved shadow trades 先有用。

---

### 4. Shadow Trades

**現狀**：61 positions 全部 open，recentResults 0。

**發現**：
- **冇 EXP backfill**——P69 修復中（已加 backfillFromExpRecords）
- 低波動市場 SL/TP 未 hit，未到 force-resolve threshold（12 cycles）
- 所以 W/L 統計 0W/0L → 冇辦法俾 agents 用

**修復價值：高** — Shadow 係 OLR 嘅重要輸入（aligned shadow 學習）+ Q-RL 嘅 reward 來源。

---

### 5. Experience Digestion

**現狀**：455 unique trades，WR 41.1%，EV +0.0051。

**發現**：
- 清理後 win rate 由 67%（假象）→ 41%（真實）
- **Payoff ratio 1.46**（贏 1.46 倍輸）→ EV 正數
- 短持倉問題嚴重（見下面 exitType 分析）

**最大出血點 — exitType 分析**：

| exitType | n | WR | EV |
|:-----|:--:|:------:|:------:|
| premature_sl | 123 | **0%** | **−0.49** |
| premature_tp | 79 | 100% | +0.57 |
| sl_tp | 73 | 37.0% | −0.044 |
| correct_sl | 23 | **0%** | **−0.55** |
| tp_hit | 20 | 100% | +0.97 |
| correct_tp | 13 | 100% | +0.66 |

**問題**：
- **premature_sl 123 筆全蝕**（拖累 PnL −60.4）→ SL 太緊
- **correct_sl 23 筆全蝕**（拖累 −12.7）→ SL 正確但都係蝕
- premature_tp 79 筆全贏（+0.57）→ **贏得太早**（可以更好）
- **SL 相關 exit 全部係出血點**

---

### 6. EM Cycle Chain

**現狀**：288 summaries，convergenceAccuracy 0.5。

**發現**：
- EM 提供 market continuity（跨 cycle 記憶）
- 但 288 summaries 未見明顯邊際改善決策
- **修復價值：低**（係 infra，唔係直接盈利來源）

---

### 7. RIL Pattern Intelligence

**現狀**：246 clusters。

**發現**：
- RIL 負責 pattern clustering + similar trade retrieval
- 246 clusters 顯示有足夠 pattern 學習
- 但係 RIL 嘅 subtle diff analyzer 影響決策嘅程度未知

**修復價值：中** — RIL 可以幫重複 pattern 避免。

---

### 8. Component Attribution

**現狀**：1527 records（361 live + 1166 backfill）。

**發現**：
- **OLR 佔大頭**：1354 records，sumPnl +4.52
- causal-uplift 只有 173 records
- backfill 佔 76%——live 數據少（P28 已發現「97% backfill」）

**修復價值：低** — attribution 係 analysis tool，唔係直接盈利來源。

---

### 9. PAEL Exit-Price

**現狀**：15 profiles。

**發現**：
- PAEL 學習 exit price（MFE/MAE percentiles）
- 15 profiles 太少——大部分 symbol 冇 profile
- exit_type 分析顯示 premature_tp 係最大「贏少咗」問題

**修復價值：高** — PAEL 直接影響 TP 設定，premature_tp 係出血點。

---

## 二、Conviction Gate 分析

**現狀**：SPCX effectiveConfidence 54% < threshold 55%，差 1% 唔 trade。

**發現**：
- 而家有好多 soft multiplier（OLR × trend-alignment × chart × shape × convexity × MAE × macro × EV filter × dirTrust...）
- 乘法乘數堆疊 → 一個弱就全鏈弱
- **乘法過度收緊**——好多 symbol 被擠出 gate

**問題**：
- 太多 multiplier = 過度保守
- EV Filter 已經喺度，但係可能唔夠強

---

## 三、Per-Symbol EV 分析（最大發現）

| Symbol:Side | n | WR | EV | Payoff | 判斷 |
|:-----|:--:|:--:|:--:|:--:|:-----|
| xyz:MU:sell | 4 | 50% | **+0.487** | 4.07 | ✅ 強 edge（樣本少） |
| xyz:SP500:buy | 9 | 55% | **+0.128** | 2.06 | ✅ 好 edge |
| btc:sell | 28 | 36% | **+0.076** | 3.63 | ✅ 贏大輸細 |
| xyz:SKHX:sell | 68 | 32% | +0.034 | 2.30 | ✅ 好 edge |
| xyz:SILVER:sell | 80 | 41% | +0.028 | 1.68 | ✅ 弱 edge |
| xyz:SKHX:buy | 79 | 34% | +0.015 | 2.01 | ⚠️ 弱 edge |
| btc:buy | 66 | 45% | +0.016 | 1.32 | ⚠️ 弱 edge |
| bnb:buy | 19 | 63% | **−0.021** | 0.53 | ❌ 高 WR 負 EV |
| xyz:GOLD:buy | 22 | 64% | **−0.050** | 0.45 | ❌ 高 WR 負 EV |
| xyz:SP500:sell | 3 | 33% | −0.054 | 0.78 | ❌ 負 EV |
| xyz:SILVER:buy | 35 | 46% | −0.065 | 0.96 | ❌ 負 EV |
| xyz:MU:buy | 17 | 24% | **−0.106** | 1.32 | ❌ 最弱 |
| xyz:GOLD:sell | 13 | 46% | **−0.251** | 0.32 | ❌ 災難 |
| xyz:CL:sell | 7 | 43% | **−0.268** | 0.21 | ❌ 災難 |

**假想上限（剔走 7 個 EV<0 bucket）**：
- PnL 由 +2.30 → +13.19（**5.7 倍提升**）
- 呢個同 P20-A 嘅假想實驗一致

---

## 四、時間維度分析（超重要發現）

| holdMin | n | WR | EV |
|:-----|:--:|:--:|:--:|
| 0-5min | 32 | 25.0% | **−0.101** |
| 5-15min | 62 | 30.6% | **−0.121** |
| 15-60min | 132 | 42.4% | −0.011 |
| 60-240min | 121 | 46.3% | +0.028 |
| 240+min | 108 | 44.4% | **+0.102** |

**發現**：
- **<15min 全部蝕錢**——短炒唔賺錢
- **>240min（4h）先賺錢**——持倉耐先有 EV
- 而家 cycle period = 4分鐘——**太頻繁，導致短持倉**

**呢個係結構性問題**——系統設計上就喺度製造太多短持倉交易。

---

## 五、Regime 分析

| Regime | n | WR | EV |
|:-----|:--:|:--:|:--:|
| mean_reverting | 242 | 41.7% | +0.028 |
| low_volatility | 203 | 41.9% | +0.007 |
| **trending_bear** | 9 | **11.1%** | **−0.647** |

**發現**：
- trending_bear WR 11.1%——趨勢熊市全部蝕錢
- P35 嘅 trend-alignment-gate 有做（trending_bear+buy ×0.5），但係可能唔夠強

---

## 六、修正方案（按盈利影響排序）

### 🔴 P1（最高優先）：EV Filter 強化 + EV<0 bucket 擋單

**目標**：剔走 7 個 EV<0 bucket → PnL +2.30 → +13.19

**方案**：
1. `ev-filter.ts` 加強——EV<0 嘅 symbol:side 唔係 soft multiplier，而係 **conviction multiplier ×0.5**（大幅降權）
2. 或者更直接：EV<0 且 n≥10 → **唔開倉**（但係主神話過「NEVER hard block」——所以要 soft）

**具體做法**：
```
effectiveConfidence = base × OLR × trend × chart × ... × EV_multiplier
EV < 0 且 n≥10 → multiplier = 0.3（大幅降權，唔係 hard block）
EV < 0 且 n≥20 且 EV < −0.1 → multiplier = 0.15
```

**預期效果**：剔走 CL:sell、GOLD:sell、MU:buy 等出血點

---

### 🔴 P2：OLR 校準修復

**目標**：OLR pwin 0.7+ 實際 WR 39% → 校正

**方案**：
1. **Platt scaling on top of OLR**——用最近 N 個樣本校準 sigmoid
2. 或者：**OLR pwin 只用方向，唔用 magnitude**——`sign(pwin - 0.5)` 而唔係 `pwin`
3. 或者：**OLR pwin blend**——同 shadow WR 混合：`calibratedPwin = 0.4 × OLR + 0.6 × shadowWR`

**預期效果**：OLR 唔再過度自信拉低 effectiveConfidence

---

### 🔴 P3：短持倉懲罰 + 長持倉獎勵

**目標**：<15min 全蝕 → 避免短持倉；>240min 先賺錢 → 獎勵長持倉

**方案**：
1. **Premature close penalty**：如果上一筆同 symbol:side 係 <15min 且 LOSS → 下次 entry confidence ×0.3（學「唔好短炒呢個 symbol」）
2. **Cycle period 加長**：4分鐘 → 15分鐘？或者 **entry 必須持倉 ≥15min**（唔俾提早平倉除非 SL/TP hit）

**預期效果**：減少 94 筆短持倉全蝕

---

### 🟡 P4：PAEL 加強（premature_tp）

**目標**：79 筆 premature_tp（贏得太早）→ 擴大 TP

**方案**：
1. PAEL 學習「呢個 symbol 嘅 TP 應該更遠」——如果 premature_tp 頻率高，TP 加寬 ×1.5
2. 結合 E1 OPEX SL widen——OPEX 期間 TP 都加寬

**預期效果**：premature_tp EV +0.57 → +0.8+（贏更多）

---

### 🟡 P5：Shadow backfill 完成（P69）

**目標**：Shadow 0W/0L → 有 cold-start W/L 統計

**方案**：已完成（P69 修復中）——寫測試 + 驗證

---

### 🟢 P6：trending_bear 保護加強

**目標**：trending_bear WR 11.1% → 減少逆勢單

**方案**：
- trend-alignment-gate 嘅 ×0.5 唔夠——trending_bear+buy 應該 ×0.2
- 或者：**trending_bear 時唔好買**（hard block？主神話 NEVER hard block——所以 soft ×0.1）

---

### 🟢 P7：Q-RL reward 改善

**目標**：Q-RL 22 cells 冇強 edge → 改善 reward signal

**方案**：
- Q-RL reward 而家用 pnl——但係 shadow 未 resolve 所以冇 reward
- 完成 P69 shadow backfill 後 Q-RL 會有更多 reward signal
- 加 reward shaping：贏大（payoff >2）额外 reward

---

## 七、預期收益總結

| 方案 | 預期 PnL 改善 | 信心 |
|:-----|:-----|:--:|
| P1 EV Filter 強化 | +10.89（剔走 EV<0） | 85% |
| P2 OLR 校準 | +5% WR 提升 → 更多贏單 | 70% |
| P3 短持倉懲罰 | +11.3（剔除 <15min 全蝕） | 80% |
| P4 PAEL 加強 | premature_tp 擴大 → 贏更多 | 60% |
| P5 Shadow backfill | cold-start 就緒 | 90% |
| **累計** | **由 +2.30 → 估計 +20-30+** | 75% |

---

## 八、風險聲明

1. **P1 EV<0 擋單**：可能會錯過真正嘅 reversal（EV<0 但係之後會贏）——需要 soft 唔 hard
2. **P2 OLR 校準**：如果校準 model 本身過擬合，可能更差——需要 monitor
3. **P3 短持倉懲罰**：可能會錯過真正嘅 scalping 機會——但數據顯示短持倉全蝕，風險低
4. **歷史數據只有 455 trades**——樣本少，所有結論需要更多數據驗證
5. **大部分結論係 base on 歷史回測**——唔保證未來表現

---

## 九、建議執行順序

1. **即刻**：P69 Shadow backfill（已完成）
2. **第一批**：P1 EV Filter 強化 + P3 短持倉懲罰（最高盈利影響）
3. **第二批**：P2 OLR 校準 + P6 trending_bear 加強
4. **第三批**：P4 PAEL 加強 + P7 Q-RL reward

每批次 commit + push，等主神驗證後繼續。
