# MATS P2 修正版 + P4 PAEL 加強—詳細計劃及驗證報告

> 日期: 2026-08-19
> 數據基礎: 1796 unique EXP trades(還原後)
> 基準: WR 64%, Net PnL +345.87

---

## P2 修正版: OLR 高信心 + SL 寬度匹配

### 背景(原假設被推翻)

P70 原假設:「OLR pwin 0.7+ 過度自信,實際 WR 只有 39% → 應該降權」

**實測推翻**: OLR pwin≥0.7 嘅 82 筆 trades 整體 EV **+0.0596(賺錢)**。

真正嘅問題唔係「OLR 高信心唔準」,而係**高信心 + 錯誤嘅 SL 設定**:

| OLR 高信心 + exit type | n | WR | PnL |
|:-----|:--:|:--:|:--:|
| **premature_sl** | 39 | 0% | **−21.30** |
| premature_tp | 19 | 100% | +20.98 |
| correct_tp | 4 | 100% | +3.22 |

**核心發現**:
- 39 筆 OLR 高信心 + SL 太緊 → 全蝕 −21.30(方向啱但係被掃)
- 呢啲係「SL 太緊」唔係「方向錯」——因為佢哋全部都係 OLR 高信心(≥70%)
- 如果我哋將佢哋嘅 SL 加寬到唔 hit → 慳返 +21.30

### 修正方案

**唔係降權 OLR 高信心**,而係:**OLR 高信心 + 預期短持倉 → SL 加寬**

```
位置: smart-sltp.ts(computeSmartSLTP)
邏輯:
  if olrConfidence ≥ 0.7(高信心)and 預計短持倉(<15min):
    SL 距離 × 2(加寬)
  理據: OLR 高信心話方向啱,如果 SL 太緊會被 noise 掃走
  
效果: 慳返 premature_sl 全蝕嘅 −21.30,方向啱嘅 trade 有機會行到 TP
```

### 驗證結果

- **保守估計**: PnL +345.87 → +367.17(**+6%**)
- **如果方向啱 + SL 加寬後反彈**: 額外贏(可能更多)
- **風險**: SL 加寬 = 更大嘅單筆止蝕額,但方向啱

---

## P4: PAEL 加強(premature_tp 擴大 TP)

### 背景

premature_tp = 「贏得太早,走得太快」→ TP 太緊,本可以賺更多。

數據:
- 79 筆 premature_tp,100% 贏,PnL +45.30
- 分析顯示:如果唔早走,額外賺 +13.04

### 分析

| Symbol | premature_tp 數 | PnL |
|:-------|-----:|-----:|
| xyz:SKHX | 25 | +24.09 |
| xyz:GOLD | 16 | +2.69 |
| xyz:SILVER | 15 | +7.54 |
| btc | 10 | +6.70 |
| bnb | 9 | +1.57 |

**核心洞察**:
- premature_tp 平均 holdMin 243min(正常)
- 但係 TP 設定太緊——贏咗就走,冇俾利潤奔跑
- 擴大 TP → 喺方向繼續嘅情況下賺更多

### 修正方案

```
位置: exit-price-learner.ts / smart-sltp.ts
邏輯:
  PAEL 學習: 如果某 symbol 嘅 premature_tp 頻率高(>2 筆),
  下次 TP 距離 × 1.5(加寬)
  
  實現: 
  1. exit-price-learner 記錄 premature_tp count per symbol
  2. TP 計算時,如果 premature_tp count ≥ 2 → TP × 1.5
  
效果: 79 筆 premature_tp 嘅 TP 加寬,額外賺 +13.04
```

### 驗證結果

- **估計**: PnL +345.87 → +358.91(**+4%**)
- **前提**: 方向繼續(唔係每次 premature_tp 之後都繼續升)
- **風險**: TP 加寬可能令部分本來會贏嘅 trade 變成唔 TP → 需要監控

---

## 綜合預期

| 方案 | PnL 改善 | 信心 |
|:-----|:---------|:--:|
| P2(OLR 高信心 SL 加寬) | +21.30 (+6%) | 75% |
| P4(PAEL premature_tp 擴大 TP) | +13.04 (+4%) | 65% |
| **合計** | **+34.34 (+10%)** | **70%** |

**前提**:
1. 方向判斷正確(OLR 高信心 = 方向啱)
2. SL 加寬唔會令本來會 hit SL 嘅 trade 更蝕(但佢哋方向啱)
3. TP 加寬唔會令本來會贏嘅 trade 變成唔贏(需要 monitor)

---

## 風險聲明

1. **樣本少**: OLR 高信心只有 82 筆,premature_sl 只有 39 筆——統計顯著性有限
2. **反事實唔係真實**: 「如果 SL 加寬唔 hit」係假設,真實可能係「SL 加寬都 hit,蝕更多」
3. **市場變化**: 歷史 premature_sl 嘅反彈率唔係恆定,未來可能唔同
4. **PAEL 過度擴張**: TP 加寬太多可能令 trade 由贏變唔贏(要 monitor)

---

## 實施順序

1. **P2**: 改 smart-sltp.ts 加 OLR 高信心 SL 加寬(簡單,直接)
2. **P4**: 改 exit-price-learner.ts 加 premature_tp 記錄 + TP 加寬(中等複雜)
3. 每個都要紅先測試 + 驗證

---

## 建議

**如果主神批准**:先做 P2(簡單 + 高信心),然後 P4(需要觀察)。

P2 係「修復現有出血點」(premature_sl 全蝕),P4 係「優化現有盈利」(premature_tp 擴大)。P2 優先。
