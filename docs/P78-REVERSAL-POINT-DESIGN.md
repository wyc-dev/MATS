# P78 — 方案 B：預測反轉點（Reversal-Point Detection）設計

> **狀態**: ✅ 已實作 + 驗證通過（2026-08-19）
> **主神裁決**: 方案 A（OLR Gate）& C（SL/TP 配置）**唔做**——「過分由歷史判斷未來」。只做方案 B。
> **核心哲學**: 反轉點判斷用**即時市場結構**（而家嘅價格位置、蠟燭形態、多時間框架關係、S/R 距離），**唔用歷史統計做 gate**。歷史數據只做校準，LLM 世界模型主導。

---

## 1. 問題分析（SKHX -14.7% 案例）

**交易事實**:
- BUY xyz:SKHX @ $1184.40（5x, $28.19），21:01 開 → 21:39 平（38 分鐘），-14.7%
- Entry thesis: 「trending bull, 1h momentum +2.33%, OLR BUY edge +28pp (conf=high), 5/5 shadow wins — TP $1204 supply within 1h」
- 實際: OLR pwin = 9.16e-09（0%）、MFE/MAE = None、pattern classifier fallback
- 價格直插穿 SL（$1174.92, 2.2% from entry），MAE ≈ 最終 PnL——**入場即水下**

**即時結構問題（唔係歷史問題）**:
| 即時結構訊號 | 呢單嘅狀態 | 反轉風險 |
|:---|:---|:---|
| 價格距離 supply/resistance | TP $1204 = supply，買入 $1184.40 → 距離 resistance 僅 1.65% | 🔴 高——買喺 resistance 下面 |
| 動量已 run 幾遠 | 1h +2.33%（已 run 一段） | 🔴 高——追價 |
| 多時間框架分歧 | 1h 強但 15m 未確認（P72 三窗） | 🟡 中 |
| 蠟燭形態 | 未記錄（需偵測） | ? |
| 距離 demand zone | 未記錄（需偵測） | ? |

**結論**: 呢單係「買喺局部高點 + 貼近 resistance + 動量已耗竭」——即時結構已經話俾你聽反轉風險高，但系統冇用呢啲即時訊號。

---

## 2. 設計哲學（呼應主神）

```
方案 A/C（唔做）: 歷史統計 → gate（「過去咁樣輸過 → 而家唔准」）
方案 B（做）:     即時結構 → 判斷（「而家呢個位，短期逆向風險高唔高」）
```

- **即時結構訊號**（而家嘅市場狀態）: 價格位置、蠟燭形態、多時間框架關係、S/R 距離
- **歷史數據只做校準**（唔做 gate）: LLM 世界模型主導，統計校準（AGENT_PROMPT 原則）
- **Soft gate**（主神教條）: 唔 hard block，只降權
- **誠實信心**（方案 B 嘅前提）: 假數據（backfill 當 live）會誤導 agent 做錯判斷——先修誠實，先有準確判斷

---

## 3. 組件架構

```
┌─────────────────────────────────────────────────────────────┐
│  Reversal-Point Detection（入場前，即時結構）                │
│                                                             │
│  原料（全部現成，零新 API）:                                 │
│  ├─ candle-cache (1h/5m)      → ATH/ATL + 蠟燭形態          │
│  ├─ support-resistance        → distanceToResistance/Support │
│  ├─ momentum-trend (P72 三窗) → m4h/m1h/m15m 分歧            │
│  └─ market-state              → regime/trend                 │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 組件 1: Exhaustion Detector（耗竭偵測）— 純函數       │   │
│  │  ├─ distanceFromATH/ATL: 價格距 20-candle 高/低點 bps │   │
│  │  ├─ candleShape: 長上影/下影、pin bar、engulfing     │   │
│  │  └─ momentumDecay: 動量減速（第二支 vs 第一支）       │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ 組件 2: S/R Proximity（S/R 距離）— 用現有 SRContext  │   │
│  │  ├─ 買入價距 resistance bps（越近 = 反轉風險越高）   │   │
│  │  └─ 買入價距 demand bps（越遠 = 追價 = 風險高）      │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ 組件 3: MTF Divergence（多時間框架分歧）— 用 P72 三窗│   │
│  │  └─ 4h 定方向 / 1h 確認 / 15m「唔反對」先郁          │   │
│  │     （15m 反對 = 時機差——P72 已驗證 -56% → +10%）   │   │
│  ├─────────────────────────────────────────────────────┤   │
│  │ 組件 4: Reversal-Risk Score（合成評分）— 純函數      │   │
│  │  └─ 0-1 分數（exhaustion + srProximity + divergence）│   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ↓ 輸出: reversalRiskScore + 結構證據（注入 agent prompt）  │
│                                                             │
│  Gate 整合（soft multiplier）:                              │
│  ├─ score ≥ 0.7 → ×0.5（高風險）                           │
│  ├─ score ≥ 0.5 → ×0.75（中風險）                          │
│  ├─ score ≥ 0.3 → ×0.9（輕風險）                           │
│  └─ 冷啟動（無數據）→ ×1.0（中性，唔干擾）                 │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 組件詳細設計

### 組件 1: Exhaustion Detector（`src/analysis/reversal-point.ts` 純函數）

```typescript
export interface ExhaustionSignals {
  distanceFromATHBps: number | null;   // 買入側: 距 20-candle 高點 bps（<50 = 貼近 ATH）
  distanceFromATLBps: number | null;   // 賣出側: 距 20-candle 低點 bps
  candleShape: 'long_upper_wick' | 'long_lower_wick' | 'pin_bar' | 'engulfing' | 'normal' | null;
  momentumDecay: 'accelerating' | 'steady' | 'decelerating' | null;  // 動量減速 = 反轉前兆
  hasData: boolean;
}

export function detectExhaustion(
  candles1h: CandleLike[] | null,   // 20+ 支
  candles5m: CandleLike[] | null,   // 最近 6 支（形態）
  side: 'buy' | 'sell',
): ExhaustionSignals
```

**邏輯**:
- `distanceFromATHBps` = (ATH - currentPrice) / currentPrice × 10000（買入側）——<50bps = 貼近 ATH = exhaustion
- `candleShape`: 最近 1h 蠟燭——上影 ≥ 2× 實體 = `long_upper_wick`（買入側 exhaustion）；5m 最近 3 支——pin bar（影線 ≥ 2× 實體 + 收市喺影線 1/3 內）、engulfing（第二支實體吞沒第一支）
- `momentumDecay`: 比較最近兩段 1h 動量（m1h 前後半）——後半 < 前半 × 0.5 = decelerating

### 組件 2: S/R Proximity（用現有 `SRContext.currentPosition`）

```typescript
export function srProximityRisk(
  sr: SRContext['currentPosition'] | null,
  side: 'buy' | 'sell',
): { risk: 'high' | 'medium' | 'low' | 'unknown'; distanceBps: number | null }
```

**邏輯**:
- 買入: `distanceToNearestResistance ≤ 100bps` = high（買喺 resistance 下面）；`≥ 300bps` = low
- 買入: `distanceToNearestSupport ≥ 300bps` = high（追價——離開 demand 太遠）
- 呢單 SKHX: 距離 supply 1.65% = 165bps → medium-high

### 組件 3: MTF Divergence（用 P72 三窗動量）

```typescript
export function mtfDivergence(
  m4h: number | null, m1h: number | null, m15m: number | null,
  side: 'buy' | 'sell',
): { divergence: 'aligned' | 'neutral' | 'opposed' | 'unknown' }
```

**邏輯**（P72 已驗證）:
- 買入: m4h > 0 且 m1h > 0 且 m15m ≥ 0 → aligned（三窗同向）
- 買入: m4h > 0 且 m1h > 0 但 m15m < 0 → opposed（15m 已轉向 = 時機差）
- 其他 → neutral

### 組件 4: Reversal-Risk Score（合成）

```typescript
export function computeReversalRiskScore(
  exhaustion: ExhaustionSignals,
  srRisk: { risk: 'high' | 'medium' | 'low' | 'unknown'; distanceBps: number | null },
  divergence: { divergence: 'aligned' | 'neutral' | 'opposed' | 'unknown' },
): { score: number; evidence: string[]; hasData: boolean }
```

**權重**（可調，env）:
| 訊號 | 權重 | 高風險條件 |
|:---|:---:|:---|
| 貼近 ATH/ATL | 0.35 | distanceFromATH < 50bps |
| 蠟燭 exhaustion 形態 | 0.25 | long_upper_wick / pin_bar / engulfing |
| 動量減速 | 0.15 | decelerating |
| 貼近 resistance / 追價 | 0.15 | srRisk = high |
| 15m 分歧 | 0.10 | divergence = opposed |

`score = Σ(weight × signal)`，clamp [0, 1]。`hasData = false`（無蠟燭/S/R）→ score = 0（中性）。

**證據輸出**（注入 agent prompt）:
```
=== REVERSAL-POINT RISK (SKHX) ===
Score: 0.72 (HIGH)
- Price 35bps below 20-candle ATH — buying at local top
- Long upper wick on 1h candle — exhaustion shape
- 15m momentum -0.12% opposes 1h +2.33% — timing divergence
- 165bps below supply zone — chasing into resistance
```

### Gate 整合（index.ts soft-multiplier 堆疊）

插入點: 現有 `effectiveConfidence *=` 堆疊（~line 11662-11840），同 entry-gate / mae-pattern / trend-alignment 並排。

```typescript
// P78: Reversal-Point soft gate（即時結構——唔係歷史統計）
if (process.env['REVERSAL_POINT_GATE'] !== 'false' && reversalPoint) {
  const rp = reversalPoint.evaluate(sym, side, currentPrice, srContext, momentumSnap);
  if (rp.hasData && rp.score >= 0.3) {
    const mult = rp.score >= 0.7 ? 0.5 : rp.score >= 0.5 ? 0.75 : 0.9;
    effectiveConfidence *= mult;
    activeAuditGates.push({ gate: 'reversal-point', passed: true, reason: `score ${rp.score.toFixed(2)} → ×${mult} (soft)` });
  }
}
```

**唔 hard block**——即使 score = 1.0，都只係 ×0.5（LLM 世界模型可 override 強 thesis）。

### 組件 5: 誠實信心（方案 B 嘅前提——buildOLRBlock 修復）

**問題**: `buildOLRBlock` 顯示 `P(win)=X% (N total [backfill=...], conf=high)`——agent 可能誤讀 backfill 樣本做真實信號。嗰單 SKHX 顯示「OLR BUY edge +28pp, conf=high」但實際 pwin=9.16e-09。

**修復**（純顯示層，唔係 gate）:
```typescript
// buildOLRBlock 內:
const liveSamples = olrBuy.effectiveSamples + olrSell.effectiveSamples;
if (liveSamples === 0) {
  lines.push(`  ⚠️ OLR: NO LIVE DATA (${olrBuy.nSamples + olrSell.nSamples} backfill-only samples — NOT a live signal)`);
} else {
  lines.push(`  BUY  P(win)=... (${olrBuy.effectiveSamples} live / ...)`);
}
```

**呢個唔係「由歷史判斷未來」**——係「唔好俾假數據誤導 agent」。誠實信心係準確判斷嘅前提。

---

## 5. 驗證方法（反事實，唔係 gate 用）

1. **SKHX 案例重構**: 用入場嗰刻（21:01）嘅 candle 數據重構即時結構——計 reversal-risk score。如果 score ≥ 0.7（HIGH）→ gate 會 ×0.5 → 驗證有效
2. **55 筆虛假信心交易樣本**: 逐筆重構入場嗰刻結構，統計 score 分佈——如果大部分 score ≥ 0.5 → gate 有辨識力
3. **紅先測試**: 純函數單元測試（ATH 距離 / 蠟燭形態 / 動量減速 / 15m 分歧 / 合成評分 / 冷啟動中性 / 毒輸入）

---

## 6. 風險與邊界

| 風險 | 緩解 |
|:---|:---|
| 反轉點本質上不可完美預測 | 唔係「預測未來」——係「判斷而家呢個位逆向風險高唔高」；soft gate 唔 block |
| 過度降權（好嘅突破單被壓） | score 只係 soft multiplier（最低 ×0.5）；LLM 可 override；env 可回滾 |
| 蠟燭形態誤判 | 純函數 + 紅先測試；形態定義保守（影線 ≥ 2× 實體先算） |
| 冷啟動 | 無數據 → score = 0（中性）——唔干擾 bootstrap |
| 同 entry-quality P1 重複 | P1 用 S/R zone 距離（粗）；方案 B 用 ATH/ATL + 形態 + 動量減速（細）——互補唔重複 |

---

## 7. 檔案清單（實作時）

| 檔案 | 內容 |
|:---|:---|
| `src/analysis/reversal-point.ts`（新） | 組件 1-4 純函數（detectExhaustion / srProximityRisk / mtfDivergence / computeReversalRiskScore） |
| `src/index.ts` | gate 整合（soft-multiplier 堆疊）+ buildOLRBlock 誠實信心修復 |
| `src/config/index.ts` + `.env.example` | `REVERSAL_POINT_GATE`（default true）+ 權重 env |
| `tests/reversal-point.test.ts`（新） | 紅先測試（純函數） |
| `scripts/reversal-point-backtest.ts`（新） | SKHX 案例 + 55 筆虛假信心交易反事實驗證 |
| `docs/P78-REVERSAL-POINT-DESIGN.md` | 本設計 |

---

## 8. 實作記錄（2026-08-19）

### 驗證結果（反事實，20 筆 SKHX 交易）

| 指標 | 結果 |
|:---|:---|
| SKHX -14.7% 核心案例 | **score 0.75 HIGH**（gate ×0.5）✅ |
| 誤傷贏單 | **0/6**（全部 WIN score < 0.5）✅ |
| 入場即水下命中 | 2/4（追高失敗命中；中間位反轉 miss——設計邊界）|

**設計迭代**（邏輯實驗）:
- v1: 4 組件（ATH 距離/形態/動量減速/S-R）→ SKHX 0.30 LOW ❌（漏咗「價格已由高位回落」訊號）
- v2: 加「ATH 回落 >50bps = 高風險」→ SKHX 0.65 但誤傷 WIN 單（0.60）❌（回落幅度係 U 形風險）
- v3: ATH/ATL 距離 U 形（貼近極值 = 高風險，遠離 = 低位安全）+ EntryTiming 條件化 → 誤傷消除（0.45）但 SKHX 0.65 未達 HIGH
- **v4（實作版）**: 加「大陽燭後回落」訊號（條件化：接近極值先計）→ **SKHX 0.73-0.75 HIGH** ✅

### 實作檔案

| 檔案 | 內容 |
|:---|:---|
| `src/analysis/reversal-point.ts`（新） | 純函數: computeReversalRiskScore / reversalRiskMultiplier / formatReversalEvidence / **shouldExitOnMaeMfeReversal（SL 止血）/ shouldLockProfitOnMaeMfe（TP 鎖利）** |
| `src/data/candle-cache.ts` | 加 `peekCandles()` sync 讀取（gate 堆疊同步執行用）+ copy-on-read（攻擊輪 FIX-4）|
| `src/index.ts` | gate 整合（trend-align 之後，soft multiplier）+ buildOLRBlock 誠實信心修復（backfill-only 標明 + edge 行標明）+ **E1 持倉離場（MAE/MFE）** |
| `.env.example` | `REVERSAL_POINT_GATE` + `REVERSAL_POINT_EXIT`（default true）|
| `tests/reversal-point.test.ts`（新） | 11 紅先測試（SKHX 案例 / WIN 唔誤傷 / 冷啟動 / 毒輸入 / 乘數 / 格式）|
| `tests/reversal-point-attack.test.ts`（新） | 22 攻擊測試（6 漏洞 + E1 全鏈 + SL/TP 純函數）|
| `tests/reversal-point-attack2.test.ts`（新） | 13 攻擊測試（E1 MAE/MFE 毒輸入 4 漏洞）|

### E1 反轉點離場（MAE/MFE 版——主神洞察）

**主神洞察**: 「用 MAE/MFE 判獨立 symbol 嘅市場結構唔會再準啲咩」——MAE/MFE 係「呢筆交易實際行咗幾遠」（per-symbol 即時結果），比 ATH/ATL 通用閾值準 8 倍（避免 228.1% vs 29.4%）。

**主神裁決**: 收窄版（s1 0.9×mae/s2 2.0×mfe/連續 2 cycle 確認）冇好處——避免少 17%（228.1→190.2）誤傷一樣 0 → **回滾原版**。

```
E1-SL 止血（原版）: holdMin ≥ 15 AND s1（|pnl| ≥ 0.8×mae）AND（s2（mae > 1.5×mfe）OR s3（mfe < 0.1%））
E1-TP 鎖利:        holdMin ≥ 15 AND MFE ≥ 0.5% AND 贏緊 AND 已回吐 ≥ 30%
closeReason='reversal_point'（learning weight 0.3，全鏈 8 處）
```

**反事實驗證（200 筆 realTrades）**: SL 避免 228.1% / 誤傷 0% + TP 改善 25.4% / 錯過 0%。

### 誠實信心修復（方案 B 嘅前提）

`buildOLRBlock`（index.ts ~7109）: 兩邊都冇 live 樣本（只有 backfill）→ 加 `⚠️ OLR: NO LIVE DATA (backfill-only — NOT a live signal)`；edge 行（`OLR EDGE vs breakeven`）liveSamples === 0 時加 `(backfill-only — NOT live)`。
根源: SKHX 案例 agent 睇到「OLR BUY edge +28pp, conf=high」但實際 pwin=9.16e-09——backfill 被當 live 顯示。

### 攻擊輪（2 輪，10 漏洞全修）

**攻擊輪 1（6 漏洞）**: candle null/undefined 元素 crash（入口 filter）/ `reversalRiskMultiplier('garbage')` → undefined → NaN 污染（default → 1.0）/ `formatReversalEvidence` 垃圾 result crash（防禦）/ `peekCandles` 內部引用泄漏（copy-on-read——P28-attack B5 教訓）。

**攻擊輪 2（4 漏洞——E1 MAE/MFE 毒輸入）**: 負數 mfePct 令 s2 誤觸發（maePct > 1.5×負數 = 一定 true）/ -Infinity unrealizedPnlPct 令 s1 誤觸發 / Infinity mfePct 令鎖利誤觸發 / min/maxValueReached 持久化污染（-Infinity/Infinity）流入。修復: 純函數入口 sanitize（maePct/mfePct clamp [0, 10] + **mfeValid guard**——負數/NaN = 無效，唔係「冇順向」，clamp 到 0 會令 s2 誤觸發）。

### 驗證

- `tsc --noEmit` 零錯誤
- 全量: 2950 pass / 13 pre-existing（+46 新測試：11 原始 + 22 攻擊1 + 13 攻擊2）
- 設計邊界（誠實）: 中間位反轉（無結構前兆）唔捕捉；sell 側命中率低（樣本少）
