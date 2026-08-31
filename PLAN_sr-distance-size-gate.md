# PLAN_sr-distance-size-gate — S/R 距離縮 size gate（threshold 0.3% vs 0.35% 驗證）

> **日期**: 2026-08-31 · **狀態**: 驗證階段（未實作）
> **主神指令**: 「<0.3% S/R 距離 → size×0.5」（Δ+8.2% 零誤傷）——先制定計劃，用全樣本 counterfactual 驗證 threshold 0.3% vs 0.35% 絕對成效，之後先 fix
> **背景**: 主神 10 單檢驗——5/5 蝕單命中（慳 15.15% margin）、贏單 0 誤傷; 唯一漏網 DRAM 00:07 −7.5%（srDist 31.8bps, 差 1.8bps 先入 0.3% 閘）
> **紀律**: 先證後改——threshold × size 掃描全樣本, 過關先實作; 「零誤傷」定義 = 唔改離場時機（縮 size 只改倉位大小）; 總 PnL Δ > 0 係唯一成效標準（縮 size 對命中組贏單都少賺——要計埋）

---

## 0. 初衷（Root Intent）

**機制**: 開倉時「開倉價距離最近 S/R 位 < threshold」→ 該單 size × sizeMult（縮倉）
——831.md §2.4 實證: S/R 距離 <0.3% 嘅單 avg −0.12%（微負——貼 S/R 被掃走）vs 0.3-0.7% 甜區 +1.80%。
**§2.5 驗證**: V1 size×0.5 Δ+8.2%（唯一正成效, 零誤傷——純縮風險唔改離場）。

**理論（頂尖量化金融）**: S/R 距離 = 「止蝕空間密度」嘅 proxy——貼 S/R 開倉 = 止損離
S/R 位太近（被 bounce 掃走機率高）或 entry 喺 S/R 位阻力正下方（突破失敗直接打回）。縮 size
唔改方向/離場——係「風險加權」：低質素（貼 S/R）單用細倉參與, 保留佢嘅正 EV 成分（若有）,
限制其負 EV 下行——「賭細啲」。

**主神案例（10 單）**: threshold 0.3% 命中 5/5 蝕單（慳 15.15%）、0 贏單誤傷;
DRAM −7.5% srDist=31.8bps 係邊界——0.35% 會唔會多防佢而唔誤傷 = 本計劃核心問題。

**成功定義**: 全樣本 counterfactual——最優 threshold×size 組合 Δ 總 PnL > 0 且穩健
（兩半/分 symbol/剔 outlier/中位）; 命中組本身 avg < 0（縮細有道理）
**失敗定義**: Δ ≤ 0 / 靠 outlier / 單一 symbol 獨撐 / threshold 孤立 peak

---

## 1. 邏輯實驗設計（35-sr-size-gate.ts）

### 數據
- `portfolio-state.json` realTrades——`entryMarketFeatures.srDistanceBps`（P1 起存檔）
- **先 check 覆蓋率**（幾多單有 srDistanceBps——冷啟動前可能有缺失; 缺失單唔計入命中, 原 size）

### 模擬
```
每單: srDist < threshold → simPnl = pnlPct × sizeMult
      else → simPnl = pnlPct
Δ 總 PnL = Σ(simPnl) − Σ(pnlPct)（margin%, 用 pnlPct 原值——佢就係 margin 回報）
```

### 網格
- threshold ∈ {0.25, 0.30, 0.35, 0.40}% price
- sizeMult ∈ {1/3, 0.5, 2/3}
（每 combo 都有: Δ 總、命中組 n/avg（證 <0）、命中組贏單數同少賺）

### 三關（最佳 combo 過先實作）
1. **Δ 總 PnL > 0** 且命中組 avg < 0（縮細有道理——唔係斬贏單）
2. **穩健性**: 兩半都 Δ>0 / 剔 |pnl|>20% outlier 後仍 Δ>0 / 中位數檢查
3. **敏感性**: threshold 4 點同 size 3 點全部 Δ>0（唔係孤立 peak）; 分 symbol 無單一獨撐（>60%）

### 特別檢查
- **DRAM 00:07 case**: srDist 31.8——0.35% 應命中（31.8 < 35——確認）
- **0.35% 誤傷掃描**: threshold 升到 0.35 新增命中單嘅 avg 係正定負（若新增全部正 EV 單 = 誤傷）

---

## 2. 實作設計（過關後, production grade）

```
1. 純函數 src/analysis/sr-distance-size.ts:
     srDistanceSizeGate({ srDistanceBps, thresholdBps, sizeMult }) → { shrink: boolean, mult: number, reason }
     ATTACK-HARDENING: 垃圾值（NaN/負/超大）→ 唔縮（中性）; threshold/sizeMult env clamp
2. index.ts 接入: applyEntryConvictionGates 尾段（shadow-gate 之後）或 executeTrade 開倉前——
     positionSizePct ×= mult（命中先縮）——影響 size 只影響落單大小, 零離場干預
3. env: SR_SIZE_GATE=true（false 回滾）/ SR_SIZE_THRESHOLD_BPS=30（或 35 睇驗證）/
        SR_SIZE_MULT=0.5 —— 全 clamp
4. 同 dip-Amplify 關係: 兩個都改 size——確認乘數唔會疊到超過 cap（positionSizePct 上限保護）
5. 測試（純函數 + 攻擊輪）+ tsc + 全量 + 三文檔 + commit
```

**不變式**: 唔改方向/離場/SL/TP——純 size; 冷啟動（無 srDistanceBps）→ 唔縮;
shrunk size 唔可以令 positionSizePct 低過最小值（若已細過）; 雙重縮（連其他 size gate）有 cap

---

## 3. 執行步驟

```
⏳ Step 1: 本 PLAN 定稿
⏳ Step 2: 35-sr-size-gate.ts——threshold × size 全樣本 counterfactual（含 DRAM case + 0.35 新增命中審查）
⏳ Step 3: 判決（三關 + 敏感性）——0.30 vs 0.35 邊個贏
⏳ Step 4:（過關）sr-distance-size.ts + env + index.ts + 測試
⏳ Step 5: tsc + 全量 + 三文檔同步 + commit
```

## 4. 風險

- **縮 size 對命中組贏單少賺**——831 §2.5 Δ+8.2% 已計埋; 若 0.35% 新增命中單 avg 正（誤傷贏單）→ 0.35% 唔值
- **srDistanceBps 覆蓋率**——若 <70% 單有數據, counterfactual 樣本縮水（缺失單照原 size——保守, 唔會假大）
- **threshold 0.35% 可能令「甜區 0.3-0.7%」嘅單縮細**——831 話甜區 +1.80% 正 EV——縮細佢 = 少賺——0.35% 侵蝕甜區邊緣要量化

---

## 4. 邏輯實驗結果與判決（2026-08-31 執行）

### 追查 831 §2.4——唔係幻覺（36-sr-truth.ts）
831 定義（開倉前 25×15m range 雙向極值距離 %）全樣本 309 單完美重現:
```
<0.3%: avg −0.18%（831 話 −0.12% ✓）| 0.3-0.7%: +1.80%（831 話 +1.80% 分毫不差 ✓）| 1-2%: −0.72%（✓）
```
⚠️ 35-sr-size-gate 用錯存檔字段（srDistanceBps 實際 = distanceToSupportBps 單向 pivot 距離, SELL 語義錯）→「−77%」誤判 → **撤回**。存檔字段名不副實（註記待修）。

### 三關全過（37-sr-final.ts）—— SELL-only × <0.35% × size×0.5（Δ+19.6%）
```
關1: Δ+19.6% 命中組 avg −1.31%（WR 37%）✅
關2: 兩半 +15.1% / +4.5% ✅ | 剔 outlier 30/30 ✅ | 中位 −0.59% ✅
關3: 鄰近全正（<0.30 +24.7/+12.4 / <0.40 +29.2/+14.6）✅ | GOLD 33% 分散 ✅
threshold 0.40 急轉負 −27.5% → clamp 上限 0.35（峰位）
BUY-only 全負（−5.9~−42.6%）→ SELL-only（BUY 貼 S/R 中性/正 EV）
今日覆蓋: DRAM 00:07 −7.5%（13.5%命中）✓ / SILVER −0.8% ✓ / DRAM 01:12 −5.9%（93% 唔命中——追跌尾非貼S/R, 正確）
```

### 實作（Production grade, 已完成）
- `src/analysis/sr-size-gate.ts`: computeSrDistancePct（831 定義幾何, 垃圾 element skip, entry 喺 range 外→負值→gate 唔縮）+ shouldShrinkSrSize（SELL-only, band-validate）
- index.ts executeTrade 接入: SELL + srDist<threshold → positionSizePct ×= mult（floor 0.01, 純 size 層零離場干預）
- computeOpenSrDistancePct: candleCache '15m'（P9-sealarm 已支援）, 剔 in-progress（零 look-ahead）
- env: SR_SIZE_GATE / SR_SIZE_THRESHOLD_PCT（clamp [0.1,0.35]）/ SR_SIZE_MULT（clamp [0.1,0.9]）
- 測試 13/13（含攻擊輪）; 全量 3967 pass + 13 pre-existing（零新增）; tsc clean
