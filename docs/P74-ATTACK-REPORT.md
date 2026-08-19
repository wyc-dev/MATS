# MATS P74 攻擊輪修正方案 + 盈利提升

> 日期: 2026-08-19
> 攻擊範圍: P71(EV Filter)+P72(三窗動量)+P73(bStocks 同步)+P68-fix(防護)
> 發現: 8 攻 2 中,全部修復

---

## 攻擊結果

| # | 攻擊 | 結果 | 修復 |
|---|------|:--:|------|
| **V1a** | Infinity EV → 應該 boost 但 cap 住 | 釘(中性) | — |
| **V1b** | **-Infinity EV → 中性放行(錯)**——極端負應該係災難桶 | **命中** | `-Infinity → 0.15` |
| V1c | -0(負零)→ 1.0(中性) | 釘 | — |
| V1d | 極負 EV(-999%) → floor 0.15 | 釘 | — |
| V1e | NaN EV → 1.0(安全) | 釘 | — |
| **V2a** | **m15m=-Infinity → 放行(錯)**——極端反對應該阻 | **命中** | `rawM15m` 判斷,唔經 fin() |
| V2b | m15m=Infinity → 唔 crash | 釘 | — |
| V2c | m15m=1e308 → 唔 crash | 釘 | — |
| V2d | 全部窗口 0 → sideways | 釘 | — |
| V3a-c | bStock 同步邊界(空/垃圾/負數) | 釘 | — |

---

## 漏洞細節

### V1b: -Infinity EV 中性放行

**問題**: `evToMultiplier(-Infinity, 50)` 返回 1.0——因為 `!Number.isFinite(-Infinity)` = true,被 guard 擋咗,返回 1.0。

**後果**: 極端負 EV(全部 trades 蝕)被當做「無效」放行,冇降權——EV<0 bucket 會繼續蝕錢。

**修復**: 加 `-Infinity → 0.15`(災難桶),唔准中性放行。

### V2a: m15m=-Infinity 唔阻

**問題**: `classifyMomentumTrend` 開頭用 `fin()` 殺晒所有非 finite 值(-Infinity → null),然後 `m15Opposes` 判斷 null → 唔阻。

**後果**: 15m 極端反對(-Infinity)被當做「冇數據」放行,錯過極端反對嘅時機。

**修復**: 保留 `rawM15m`(未經 fin() 嘅原始值),極端反對判斷用 raw 值。

---

## 盈利提升(量化金融分析師思路)

基於 P70 調查 + P71-P73 落地,我嘅建議:

### 1. EV<0 bucket 係最大出血點(已修 P71)
- 7 個 EV<0 bucket 拖 PnL -10.89,剔除後 +473%
- 加強降權(×0.15/×0.30)係正確嘅——唔會永久 block 但係會降權

### 2. 短持倉係第二出血點(已修 P71)
- <15min WR 25-31%,全部蝕錢 -10.75
- 安全版(4 防線)係正確嘅——soft 降權 + 衰減 + 邊界豁免

### 3. 反轉檢測(已驗證 P72)
- 4h+1h+15m 唔阻 係正確嘅——SKHX PnL -56% → +10%

### 4. 下一步建議(未做)
- **PAEL premature_tp 擴大 TP**(P4)——驗證顯示 +13.04 PnL
- **OLR 校準**(P2)——高信心 + SL 太緊係出血點,但要小心驗證

---

## 驗證結果

20 攻擊測試全綠 + tsc clean。修復已落地。
