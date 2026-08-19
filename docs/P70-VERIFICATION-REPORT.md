# MATS P70 反事實回測驗證報告
## 「OLR + Bayesian + Q-RL Direction」架構盈利提升——驗證後修正方案

> 日期: 2026-08-19
> 數據基礎: 455 unique EXP trades（清理測試污染後）
> 基準: WR 41.1%, EV +0.0051, Net PnL +2.30

---

## 一、反事實回測結果（實測驗證）

每個方案用現有 455 trades 做反事實回測（如果我哋當初咁做，PnL 會係幾多）：

| 方案 | 保留 | 剔走 | PnL 效果 | 保留 WR | 判斷 |
|:-----|:--:|:--:|:---------|:--:|:-----|
| **P1 EV<0 bucket 剔走** | 339 | 116 | **+473%**（+2.30→+13.19） | 38.6% | ✅ 強烈推薦 |
| **P2 OLR pwin≥0.7 剔走** | 373 | 82 | **−212%**（+2.30→−2.58） | 41.6% | ❌ **唔做**（高信心反而賺錢） |
| **P3 <15min 短持倉剔走** | 361 | 94 | **+467%**（+2.30→+13.05） | 44.3% | ✅ 強烈推薦 |
| **P6 trending_bear 剔走** | 446 | 9 | **+253%**（+2.30→+8.13） | 41.7% | ✅ 推薦 |
| **P1+P3+P6 組合** | 257 | 198 | **+912%**（+2.30→+23.31） | 42.0% | ✅ 最強 |

---

## 二、關鍵發現（驗證後修正）

### ✅ 確認有效（數據支持）

#### P1: EV Filter 強化（剔走 EV<0 bucket）

**理據**：7 個 symbol:side bucket EV<0，拖 PnL −10.89：
- CL:sell EV −0.268 | GOLD:sell EV −0.251 | MU:buy EV −0.106 | SILVER:buy EV −0.065 | SP500:sell EV −0.054 | GOLD:buy EV −0.051 | bnb:buy EV −0.021

**驗證**：剔走後 PnL +473%（+2.30 → +13.19）

**實施方式**：
- EV<0 且 n≥10 → conviction multiplier ×0.3（soft，唔 hard block）
- EV<−0.1 且 n≥20 → conviction multiplier ×0.15（更強降權）
- 用 Wilson LB 保守估計（唔係點估計）

---

#### P3: 短持倉懲罰（<15min 全蝕）

**理據**：短持倉全部蝕錢：
- 0-5min: WR 25.0%, EV −0.101
- 5-15min: WR 30.6%, EV −0.121

**驗證**：剔走後 PnL +467%（+2.30 → +13.05）

**實施方式**（**唔係 hard block 短持倉**，而係）：
1. **Premature close penalty**：如果上一筆同 symbol:side 係 <15min 且 LOSS → 下次 entry confidence ×0.3
2. **Minimum hold enforcement**：entry 後 15min 內唔俾手動平倉（除非 SL/TP hit）
3. **Cycle period**：維持 4min——但係 entry 必須「呢個 symbol 上一次 <15min 且 LOSS」先 block

**主神原則**：「NEVER hard block」——所以用 soft multiplier。

---

#### P6: trending_bear 保護加強

**理據**：trending_bear WR 11.1%，EV −0.647——趨勢熊市全部蝕錢

**驗證**：剔走後 PnL +253%

**實施方式**：
- trending_bear + buy → conviction multiplier ×0.1（而家 ×0.5 唔夠）
- trending_bear + sell → 保持 ×1.2（順勢）

---

### ⚠️ 驗證推翻原假設

#### P2: OLR 校準——方向完全錯

**原假設**：「OLR pwin 0.7+ 過度自信，實際 WR 只有 39%」→ 應該降權

**實測**：**OLR pwin≥0.7 嘅 trades 反而係最賺錢嘅**：
- WR 39.0%（唔高），但係 **EV +0.0596**（正數）
- premature_tp 19 筆全贏 +20.98
- 240+min WR 61.5%，EV +0.5734

**真正問題唔係 OLR 高信心，而係：**
- **premature_sl 全蝕**（39 筆 −21.3）——SL 太緊
- **5-15min 短持倉全蝕**（13 筆 −0.42）——時間太短

**修正後 P2 方案**：唔係降權 OLR 高信心，而係：
- **OLR 高信心 + 短持倉 + SL 太緊 = 危險組合**
- OLR 高信心 + 長持倉 + SL 夠寬 = 最賺錢組合

---

### ❌ 確認無效

#### P2 原方案（OLR pwin≥0.7 降權）：**唔做**
- 實測 PnL −212%——剔走咗賺錢嘅 trades
- OLR 高信心 trades 嘅 EV 係 +0.06（正數），剔走反而蝕

---

## 三、修正後完整方案

### 🔴 第一優先（盈利影響最大）

**P1: EV Filter 強化 — EV<0 bucket 降權**

```
位置: src/analysis/ 或者 src/index.ts conviction gate
邏輯:
  EV_bucket = per symbol:side 實績 EV
  if EV_bucket < 0 且 n≥10:
    confidenceMultiplier *= 0.3  (soft,唔 hard block)
  if EV_bucket < −0.1 且 n≥20:
    confidenceMultiplier *= 0.15

驗證: PnL +473%
```

---

**P3: 短持倉懲罰 — <15min 且 LOSS 嘅 symbol 降權**

```
位置: src/evolution/ 或者 src/index.ts
邏輯:
  同一 symbol:side,如果上一筆 holdMin<15 且 LOSS:
    下次 entry confidence *= 0.3
  學「唔好短炒呢個 symbol」

驗證: PnL +467%
```

---

### 🟡 第二優先

**P6: trending_bear 保護加強**

```
位置: trend-alignment-gate.ts
邏輯:
  trending_bear + buy: multiplier ×0.5 → ×0.1
  trending_bear + sell: ×1.2 保持

驗證: PnL +253%
```

---

### 🟢 第三優先

**P2 修正版: OLR 高信心 + SL 寬度匹配**

```
位置: smart-sltp.ts / trading-manager.ts
邏輯:
  OLR pwin≥0.7 且 預期持倉<15min → SL 加寬 ×2(避免 premature_sl)
  或者:OLR pwin≥0.7 → 提示 agents「用闊 SL,唔好急於平倉」

理據:OLR 高信心 + 短持倉全蝕,如果 SL 夠寬/持倉夠耐,呢啲 trades 會更賺錢
```

---

## 四、累計預期效果

| 方案 | 單獨效果 | 組合效果 |
|:-----|:---------|:---------|
| P1 EV Filter | +473% | ┐ |
| P3 短持倉懲罰 | +467% | ├─ **P1+P3+P6 = +912%** |
| P6 trending_bear | +253% | ┘ |

**保守估計**：組合效果可能冇 912% 咁高（有重疊），但係 **+500%+ 係合理預期**。

---

## 五、風險聲明

1. **歷史回測唔保證未來**——455 trades 樣本有限
2. **EV<0 bucket 可能會逆轉**——如果市場變化，今日嘅 EV<0 bucket 聽日可能係 EV>0
3. **短持倉懲罰可能錯過 scalping**——如果未來有真係要短炒嘅機會
4. **trending_bear 保護可能錯過反彈**——如果 market 轉向
5. **組合效果有重疊**——P1+P3+P6 有共同 trades，實際效果可能低過相加

---

## 六、建議執行順序

**Phase 1（即刻）**：
- 完成 P69 shadow backfill（已做）
- P1 EV Filter 強化
- P3 短持倉懲罰

**Phase 2**：
- P6 trending_bear 加強
- P2 修正版（OLR + SL 寬度匹配）

**Phase 3（觀察）**：
- 觀察 1-2 日,如果 PnL 改善,繼續
- 如果冇改善,回滾

---

## 七、測試計劃

每個方案都要有紅先測試：

1. **P1**: EV<0 bucket 降權測試——mock EV filter,確認降權生效
2. **P3**: 短持倉懲罰測試——mock 上一筆 <15min LOSS,確認降權
3. **P6**: trending_bear 降權測試——確認 ×0.1 生效

全部測試過先好 commit。
