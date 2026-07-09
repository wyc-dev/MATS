# {MATS} — Multi Agent Trading System

> **作者**: YC Wong · **版本**: 2.0.135
> **核心哲學**: 資本保存為絕對第一優先，但必須在安全前提下持續創造盈利
> **代碼量**: ~25,000 行 TypeScript（嚴格模式，零類型錯誤）+ React UI

---

## 概述

**MATS**（Multi Agent Trading System）是一個具備自我演化能力的多智能體量化交易系統。核心決策引擎為 **HACP（Hyper-Accelerated Cognition Protocol）**——結構化多 LLM 辯論協議。在 **Hyperliquid（9 perpetual DEXs, 416 assets）** 市場上進行機構級 Paper Trading 模擬及 Real Trading。

### 核心設計原則

| 原則 | 說明 |
|:-----|:-----|
| **資本保存第一** | 所有決策以生存為前提，利潤為次要。任何錯誤預設 HOLD，永遠不倒 |
| **理據驅動** | Meta-Agent 必須提供 entryThesis（`[1h:..] [1d:..]`）才可開倉；Skeptics 絕對否決權 |
| **暗黑心理學** | Meta-Agent 質疑數據是否大戶操縱；Skeptics 驗證 Meta-Agent 自身是否被偏誤 |
| **極限推理** | 冇倉位必須 BUY/SELL（極度不確定先 HOLD）；有倉位 thesis 失效（強制）+ ≥2 其他條件先 CLOSE |
| **自我演化** | OLR + Shadow Trading + First-Passage + EM Cycle Chain + GA + Pattern DB，從每筆交易學習 |
| **唔靠過去 P&L** | 過去 drawdown/losses 唔係拒絕交易嘅理由——OLR 持續學習，市況不斷變化 |
| **多資產單循環** | 所有交易市場單一 HACP 循環分析；無持倉市場以 isTradingMarket=true 注入 |
| **生產級標準** | 完整型別（Zod 驗證）、結構化日誌（Winston）、優雅關閉、指數退避重連 |

---

## 三層架構

```
┌──────────────────────────────────────────────────────────────┐
│   Layer 1: 戰略層 (PI Agent)                                  │
│   • 啟動/停止系統 · 績效審查 & 參數調整 · 人工干預入口         │
├──────────────────────────────────────────────────────────────┤
│   Layer 2: 認知層 (TypeScript + Ollama)                       │
│   • HACP 多模型平行推理（僅關鍵決策點觸發 LLM）                 │
│   • 8 智能體 + Meta-Agent 仲裁 + Skeptics 邏輯審查             │
│   • Entry Thesis System + 暗黑心理學 + 結構化辯論 + 加權投票    │
│   • Self-Evolution（OLR + Shadow + First-Passage + EM + GA）   │
│   • SystemGuard（5 層系統級保護）                               │
├──────────────────────────────────────────────────────────────┤
│   Layer 3: 執行層 (TypeScript Runtime)                         │
│   • Hyperliquid WebSocket（l2Book + trades + userFills）+ REST  │
│   • 風險引擎（毫秒級，無需 LLM）· Paper/Real Trading Manager    │
│   • 倉位追蹤 & SL/TP（每個 price update 自動檢查）              │
│   • Position Reconciliation（偵測 exchange 已平倉 → 同步）      │
│   • 數據管道 & 持久化 & 可觀測性                                │
└──────────────────────────────────────────────────────────────┘
```

---

## 專案結構

```
src/
├── agents/                  # 8 agents + Meta-Agent
│   ├── base-agent.ts        # LLM call + retry + confidence
│   ├── meta-agent.ts        # 仲裁 + entryThesis 生成
│   ├── skeptics.ts          # 邏輯審查 + thesis 驗證（Phase 0.5/1.5/1.8）
│   └── agents.ts            # 5 sub-agents
├── cognition/
│   ├── hacp.ts              # HACP 協議（Phase 0-5）
│   └── a2a-utils.ts         # A2A 信號交換
├── llm/                     # LLM 抽象層（provider + circuit breaker + concurrency 4）
├── trading/                 # portfolio · paper-engine · real-trading-manager · cost-model
├── risk/                    # 風險引擎 + correlation-budget
├── system-guard/            # 5 層保護閘門
├── evolution/               # 自我演化（見下方專節）
├── analysis/                # sentiment · S/R · ATR · planck-chaos · options · news
├── market-agent/            # 自動 pair 選擇（9 DEX, 416 assets, 類別過濾）
├── data/                    # Hyperliquid + Binance WebSocket
├── api-server.ts            # REST + SSE (:3456) + static UI
└── index.ts                 # 系統 orchestrator（決策循環）
ui/                          # React + Vite dashboard (:5173)
data/evolution/              # olr-state · shadow-state · patterns · GA state
tests/                       # vitest（41 tests）
```

---

## 八智能體系統

| # | Agent | 溫度 | 權重 | 角色描述 |
|:-:|:------|:----:|:----:|:---------|
| 1 | **Market Agent** | — | — | 自動選取最高 24h 交易量 pair。9 個 HL DEX，416 assets，按類別過濾（Indices/Stocks/Commodities/FX）。HACP 週期前執行，阻塞其餘 Agent。 |
| 2 | **Fractal Momentum Sentinel** | 0.85 | 0.10 | 多時間框架碎形自相似模式檢測。趨勢加速早期信號。極端逆向，中間趨勢追隨。 |
| 3 | **On-Chain Whisperer** | 0.50 | 0.10 | 類別感知鏈上分析。Crypto: mempool/flows/supply。TradFi: DXY/COT/商品/COT 持倉。5 分鐘緩存。 |
| 4 | **OLR & Sentiment Analyst** | 0.25 | 0.10 | OLR P(win) per side + First-Passage path-risk + Fear & Greed。RR-aware：P(win) 對 breakevenP 計 edge。PRIMARY factor。 |
| 5 | **News Reporter** | 0.40 | 0.10 | 隱性策略師新聞動機分析。為派發製造的「利好」= 看跌；為收集製造的 FUD = 看漇。 |
| 6 | **Independent Risk Auditor** | 0.10 | 0.25 | **advisory-only（不可 veto）**。TP/SL/size 建議 + 硬性代碼限制（震盪市減倉、loss-streak 漸進減倉、虧損冷卻期）。近期 10 trade 模式分析。 |
| 7 | **Skeptics** | 0.30 | 0.00 | 邏輯審計員 + 壓力測試員。**Approve-First**——預設 APPROVE，只係喺搵到具體會導致輸錢嘅 material flaw 時先 REJECT。Phase 1.5 審查 5 sub-agents；Phase 1.8 驗證 entryThesis；Phase 0.5 每循環重新驗證持倉 thesis → 失效即強制平倉。 |
| 8 | **Meta-Agent** | 0.45 | 0.00 | 仲裁主席。偵探模式——積極從事實推理蛛絲馬跡嘗試開倉，絕不歪曲事實。生成 entryThesis。權重 0.00（理據系統控制，唔靠投票）。HOLD 時必須提供 holdReason。 |

> **權重說明**：Meta-Agent + Skeptics 權重 0.00 — 佢哋透過 thesis 系統控制決策，唔參與投票。5 個 sub-agent 加權投票，consensus threshold 60%（由 Evolution 動態調整）。

---

## HACP 高速認知協議

每 **300 秒**（`DECISION_INTERVAL_MS`）觸發一次決策循環。

```
PHASE 0   Market Agent auto-select + Position Reconciliation
          • 選取最高 volume pair · real mode 同步 exchange 倉位
PHASE 0.5 Skeptics 入場理據重新驗證（每個持倉）
          • thesis 失效（catalyst spent / structure broken / direction contradicted）→ 強制平倉
PHASE 1   平行思考（5 sub-agents, 60s deadline race, staggered 6s）
          • Promise.all 收集所有思路
PHASE 1.5 Skeptics 邏輯審查（逐一審查 5 sub-agent 決策 + 跨 Agent 交叉對比）
          • 參考每個 Agent 歷史 track record · Approve-First
PHASE 1.75 Meta-Agent 仲裁（接收 Skeptics 結果後做最終判斷）
          • 生成 entryThesis / holdReason / closePosition
PHASE 1.8 Skeptics 驗證 Meta-Agent entryThesis（強而有力、數據驅動、暗黑心理學、事實扭曲）
          • 拒絕即 HOLD
PHASE 2-4 結構化辯論（1-3 rounds，unanimous 可跳過）
PHASE 5   加權投票共識（60% threshold，動態調整）+ 執行
```

**時間預算**：Phase 1 平行 ~60s · Skeptics ~10s · Meta-Agent ~10s · 辯論 ~30s · 120s hard timeout → HOLD。

**共識閾值動態調整**：idle（連續 HOLD）→ 降閾值鼓勵交易；loss streak → 降閾值但配合減倉；regime=chaotic → 升閾值。

---

## 🆕 v2.0.135 — OLR + Shadow Trading + First-Passage + Cold-Start Backfill

> 取代 v2.0.122 嘅 RBC（Range-Based Clustering）。RBC 嘅 growing-hyperrectangle 設計有 box-saturation 致命缺陷（boxes 只擴張唔收縮 → 最終所有 dimensions overlap → 永久 NO_EDGE）。新系統改為 per-symbol/per-side logistic regression，從真實 path-risk 結果學習 P(win)。

### 架構總覽

```
每個 cycle (5 min):
  1. Shadow Trade Engine → 為每個 trading market 開模擬 LONG + SHORT（S/R-aligned SL/TP）
  2. First-Passage（即時）→ P(TP before SL) from σ + drift + SL/TP distances（覆蓋 cycle 1）
  3. OLR Engine → query P(win) per side from shadow + paper + real + backfill outcomes
  4. Cold-Start Backfill（首次 cycle, non-blocking）→ 歷史 HL candles replay 入 OLR
  5. buildOLRBlock() → 注入完整 OLR + First-Passage + edge 數據到 OLR & Sentiment Analyst + Meta-Agent
```

### 三層組件

**Layer 1 — OLR (`olr-engine.ts`)**
- Per-symbol, per-side online logistic regression · Welford z-score normalization
- **每個 feature 獨立計數**（`welfordCount[]` + `welfordMask`）——缺失 feature 返回中性 z=0，唔污染模型
- SGD online updates，source-weighted：real=4, paper=2, shadow=1, **backfill=0.3**
- `backfill` 從 SGD decay 排除：`liveSamples = nSamples − backfillSamples`
- Cold/stale/warm detection（`newestSampleTs`）：stale（>6h）→ `resetSymbol()` + 重新 backfill
- confidence: high(≥50) / medium(≥20) / low(<20) samples

**Layer 1b — Shadow Trading (`shadow-trade-engine.ts`)**
- 每個 cycle 為每個 trading market 開模擬 LONG + SHORT
- S/R-aligned SL/TP（self-contained pivot detector + ATR fallback）
- **Multi-candle hold**：向前掃描最多 `maxHoldCandles`（20），第一根觸及 SL/TP 即 resolve；未 resolve 嘅 skip（唔偽造 label）
- 學 TP-before-SL（真實可盈利性），唔係 5 分鐘價格方向

**Layer 1c — First-Passage (`first-passage.ts`)**
- 即時 P(TP before SL)，from σ（log-returns std）+ ν（log-drift EWMA）+ per-side SL/TP
- Cox & Miller (1965) first-passage formula for GBM：
  - LONG: P = (e^(2νa/σ²)−1) / (e^(2νa/σ²)−e^(−2νb/σ²))
  - SHORT: P = (1−e^(−2νa'/σ²)) / (e^(2νb'/σ²)−e^(−2νa'/σ²))
  - zero-drift limit = a/(a+b) = breakevenP
- **RR-aware**：P(win) 對 breakevenP 計 edge（唔係 flat threshold）；per-side LONG + SHORT SL/TP
- vol < 0.1% → 返回 50%（no edge, confidence=low）

**Cold-Start Backfill (`olr-backfill.ts`)**
- 首次 cycle per market：replay 186 歷史 HL M5 candles 入 OLR 作 `backfill` source
- **Non-blocking**（`void ... .catch()`）：交易 loop 繼續；first-passage 覆蓋 cycle 1，OLR cycle 2 起可用
- Idempotent：已 warm（≥20 samples）嘅 market skip

### Agent Cognition 完整整合（v2.0.135）

`buildOLRBlock()` 共享 helper（`index.ts`）為每個 symbol（active / 持倉 / 交易市場）注入完整 evolution 數據：
- OLR BUY/SELL P(win) + nSamples + **完整 source breakdown（shadow/paper/real/backfill）** + confidence
- BUY + SELL feature contributions（邊個 feature 驅動概率）
- Recent outcomes（source + cyclesAgo + [SL narrowed]）
- First-Passage LONG/SHORT P + **breakevenP + edge pp** + drift + vol + **per-side SL/TP** + confidence
- **現成決策信號**：`OLR EDGE vs breakeven: BUY +Xpp (FAVOR BUY) | SELL +Ypp (FAVOR SELL)`

Meta-Agent OLR prompt 已從 stale RBC 文檔重寫為 RR-aware edge 仲裁：edge > +10pp → favor；< −5pp → against；low confidence → defer to sub-agents。

---

## 🆕 v2.0.139 — News Reporter v2 Institutional Narrative Decoder + A+B + L3 + Critical Bug Fixes

> Master Lord doctrine: financial news is a WEAPON, not information. Institutions already know the situation >=24-48h before retail sees headlines and actively DRIVE narratives to induce retail to take the losing side. The News Reporter must decode this institutional intent — and its read must be DECISIVE.

### News Reporter v2 — Institutional Narrative Decoder

**Layer 1 — Price-News Timing data enrichment** (`news-sentiment.ts` + `index.ts`):
- `PriceNewsTiming` + `computePriceNewsTiming()`: from the SAME asset's 1h candle closes + headline pubDates, computes 1h/4h/24h/3d price changes, `movedBeforeNews` (front-run tell: did price move >2% in the hint direction before the news cluster?), `headlineCadence`, `sourceClustering`, `dominantAngle`.
- `fetchTimingCandlesForSymbol()`: fetches 80 1h candles (3.3d) via the same routing as the UI chart proxy (Binance for USDT/USD, HL candleSnapshot for bare/colon symbols) + 5-min cache. Uses the ORIGINAL allSymbols (xyz: prefix preserved) so HL gets the correct coin name.
- `formatPriceNewsTiming()` appends a `PRICE-NEWS TIMING` block to the agent context.

**Layer 2 — Prompt upgrade** (`agents.ts` NewsReporter, weight 0.10 -> 0.20):
- 5-part Institutional Narrative Decoder framework: (A) Information-Asymmetry Prior, (B) Price-News Timing Matrix (7 rows -> NET signal; no pre-news move + low cadence = treat face-value, preventing over-attribution), (C) 6-bucket Motive Taxonomy (front-run / accumulation-FUD / distribution-hype / narrative-pivot / decoy-smoke / genuine paradigm shift), (D) Power-Map (which institution + their position + what they need retail to do), (E) Net Institutional-Adjusted Signal (confidence cap 0.40 without price confirmation; 0.65-0.85 with pre-news move + coordinated cadence).

**Layer 3 — Meta-Agent decisive weighting** (`meta-agent.ts`):
- When News Reporter flags an ENGINEERED institutional play WITH price-news timing confirmation, the Meta-Agent MAY override a HOLD-lean sub-agent majority + uses CONFIDENCE PASSTHROUGH (per-symbol confidence pulled toward News Reporter's confidence, not drowned to the ~0.35 sub-agent average).
- GUARDRAIL: decisive override requires BOTH a named engineered motive AND timing confirmation (no naked-motive over-empowerment).

### A+B — Meta-Agent self-censoring + OLR weighting

- **A**: removed pre-emptive self-censoring (the Meta-Agent was told the conviction-gate threshold + instructed to HOLD below it -> self-fulfilling paralysis). Now emits honest conviction; the gate filters independently.
- **B**: OLR edge weighted by `magnitude x confidence-label` (not raw sample count). A +58pp high-confidence edge is no longer discarded during cold-start.

### BTC wallet trailing-zero fix

`quantity.toFixed(szDecimals)` produced trailing zeros (0.000997 -> "0.00100"); HL normalizes numeric strings before re-msgpacking for signature verification -> hash mismatch -> ECDSA recovery yields garbage -> "User or API Wallet <random> does not exist". Fix: `stripTrailingZeros()` on all signed numeric fields (regular size, SL/TP trigger sizes, `formatPrice`).

### 3 critical bug fixes (from first real trades)

1. **Leverage config authoritative** (`index.ts:3545`): the per-symbol consensus used `psc.leverage ?? config.leverage` — the agent LLM's leverage output (5x) overrode the Market Agent config (10x). Config is now AUTHORITATIVE; agent LLM leverage output ignored.
2. **Closed-fill display leverage** (`index.ts:5268`): closed HL fills fell back to a HARDCODED 10x (cachedExchangePositions no longer has the closed position). Added `lastKnownLeverage` cache (updated whenever cachedExchangePositions refreshes); closed-fill leverage now uses the REAL leverage, not a default that masked the actual 5x.
3. **SL/TP REST-lag race** (`hyperliquid-real-engine.ts` adjustPosition): after a fill, HL REST `getPositions()` lags 2-5s (WS confirms within ~50ms). adjustPosition relied on REST -> "Position not found" -> 3 retries failed -> safety-close (which also failed). The position was left UNPROTECTED on the open cycle. Fix: adjustPosition accepts an optional `knownPosition` (qty/side/entry from the caller's fill data); when REST doesn't find the position, it falls back to knownPosition to place SL/TP immediately. Caller (`real-trading-manager`) passes the known fill data.

### EXP 向量理據記憶 (v2.0.138, carried forward)

`thesis-experience.ts` + `embeddings.ts` (transformers.js MiniLM 384-d, in-process). Phase 1.8a `checkThesisHistory` gates entries by thesis-combo historical win-rate; Skeptics history probability gate. Cold-start (no history) = direct open. PnL=0 excluded. Asymmetric similarity. Enabled via `EXP_ENABLED=true`.

### Placeholder entryThesis gate + live Mark price refresh

- **Placeholder thesis gate**: `isThesisPlaceholder` broadened to catch theses containing n/a/hold inside the `[tf: ...]` format (e.g. "[1h: N/A — hold] [1d: N/A — hold]") — strips timeframe labels + punctuation + placeholder words; if no real content remains, it's a placeholder. The per-symbol consensus path BLOCKS BUY/SELL with a placeholder entryThesis (a trade without a real entry reason is invalid).
- **Live Mark price refresh**: `refreshPositionMarkPrices()` called at the start of every `pushToAPI()` — updates each real position's currentPrice from the live `marketState` price (tries the position symbol, then the base symbol without xyz: prefix). Previously the mirror currentPrice was only updated from HL `getPositions()` (which returns entryPx — never updated) or fills, so the UI Mark was stuck at the Entry price.

### v2.0.139 共識閘 + Evolution cleanup

- Consensus threshold 0.70 -> 0.50 (floor 0.49); the evolution override (intended to lower it to ~0.5) was vestigial (empty strategies) so the real gate was 70-85% blocking nearly all entries.
- `getPortfolioSummary` uses `currentDrawdownPct` (recovers) not `maxDrawdownPct` (high-water mark, permanently conservative).
- Removed EvolutionStats UI + global aggregate stats injection into agent context (caused over-conservatism); kept OLR section.

---

## Entry Thesis System + Skeptics

**Entry Thesis（v2.0.80）**：Meta-Agent 開倉時必須提供 `entryThesis = "[1h: <短線原因>] [1d: <中線原因>]"`。Skeptics Phase 1.8 驗證：強而有力、數據驅動、暗黑心理學審查（大戶操縱？）、事實扭曲檢查。拒絕即 HOLD。

**Thesis 重新驗證（v2.0.80 Phase 0.5）**：每循環 Skeptics 重新驗證所有持倉嘅 entryThesis。失效條件：catalyst 已耗、結構破壞、方向 contradicted、1h timeframe 過期。失效 → 強制平倉。

**v2.0.137 Thesis 凍結（Root Cause B fix）**：`entryThesis` 喺開倉時凍結為「原始理據」，之後**永不覆寫**。`PortfolioTracker.setEntryThesis()` 改為 set-if-absent（只喺倉位冇 thesis 時先填入，例如由 HL re-import 嘅倉位），並拒絕 placeholder（`'N/A'`/`'Not applicable'`/空字串）。之前 index.ts 每循環用最新 Meta-Agent thesis 無條件覆寫 entryThesis，令 Skeptics re-validate 嘅「原始 thesis」變成**移動目標**（不斷被改寫，有時被覆寫成 `'N/A'`→自動失效→6-15 分鐘內強制平倉，造成交易太密＋勝率低）。而家 re-validate 針對嘅係開倉時凍結嘅原始理據。Live 每循環 reasoning 改存 `holdReason`（唔被 re-validate，可自由更新）。

**平倉規則（v2.0.103）**：CLOSE 必須 thesis 失效（強制）+ ≥2 其他條件（trend 改變 / ≥2 agents recommend CLOSE / 虧損無恢復 thesis / regime 唔適合 / 新資訊 contradicts）。Thesis 仍有效 → HOLD，無例外。

**Skeptics Approve-First（v2.0.110）**：預設 APPROVE，只係喺搵到具體、會導致輸錢嘅 material flaw 時先 REJECT。唔因「low confidence」「could be manipulation」等弱理由 reject。Error fallback = APPROVE。

---

## 風險管理引擎

| 關注點 | 嚴重性 | 觸發 | 緩解 |
|:-------|:------:|:-----|:-----|
| 回撤 ≥ 20% | 🔴 | 平倉所有 | 保持現金 |
| 日虧損 ≥ 5% | 🔴 | 當日禁止新交易 | — |
| 倉位 > 20% | 🟠 | 降至 20% | hard clamp |
| 波動率 > 3% | 🟠 | 倉位減半 | 止損放寬 |
| 相關性曝險 > 30% | 🟡 | 對沖或減倉 | — |

**倉位計算**：
```
volatilityFactor = vol > 3% ? 0.5 : vol > 2% ? 0.75 : 1.0
confidenceFactor = 0.5 + (confidence × 0.5)    # [0,1] → [0.5,1.0], 單次應用
riskPct = maxPositionSizePct × volatilityFactor × confidenceFactor
quantity = (equity × riskPct) / (entryPrice × priceRisk)
```

**TP/SL 三層安全（v2.0.7）**：no-widen + not-too-tight（SL ≥ 1%, TP ≥ 1.5%）+ min-gap + max-narrow-step。

**累計 Margin 上限 20%**：所有持倉 margin 總和 ≤ 20% balance（基於 margin 而非 notional，防止槓桿名義值觸發錯誤縮倉）。

---

## Paper Trading 模擬層

- 槓桿感知 P&L：notional-based 雙邊手續費扣除
- 每個 price update 自動檢查 SL/TP
- Position Reconciliation：偵測 exchange 已平倉 → 同步 local mirror
- Real Trading Manager：HL exchange 下單 + 本地 mirror（phantom agent signing via `@noble/curves`）
- Real mode：drawdown/dailyPnl 從 paper portfolio 無意義 → 用 0（real 風險由 HL margin/liquidation + SL/TP trigger 管理）
- **v2.0.136 Mirror thesis 持久化**：`forceMirror=true`（real trade 成交後嘅本地 mirror）同時 bypass `canTrade()` **同** `riskEngine.assessTrade()`（之前只 bypass 前者，後者喺 paper drawdown  20% 時拒絕 mirror → 無 thesis 倉位 → reimport 丟失 Reason）。mirror 建立後即時標 `agentId='hyperliquid-real'` 並持久化到 `portfolio-state.json`。`syncExchangePositions` 走 in-place update 路徑保留 `entryThesis` / `holdReason` / S/R-aligned SL/TP（重啟後亦由持久化 mirror 恢復），而唔係 close+reimport 換成無 thesis 嘅 `importExchangePosition`。Portfolio UI 嘅「Reason」由是跨多個 cycle 持續顯示直至平倉。
- **v2.0.136 placeOrder 價格源**：real engine `placeOrder()` 以 LIVE `l2Book`（best bid/ask）做 aggressive price 主源（bid*0.995 / ask*1.005 保證穿價），`allMids` REST 做 fallback。HL l2Book/allMids API **case-sensitive** — 必須用 canonical `asset.name`（如 `'BTC'`）而唔係 lowercase `order.symbol`（`'btc'`），否則返 null/0 → 用 decision price → SELL 唔穿 best bid → "could not immediately match"。

---

## 其他子系統

### EM Cycle Chain (`cycle-summary.ts`)
Meta-Agent 每循環蒸餾結構化 `CycleSummary`（E-step）；previous summaries 注入下循環 context（M-step）。Skeptics cross-check insight vs 實際價格（convergence audit）。Tiered memory：hot(12) + warm(288) + cold(48 epochs ≈ 48 days)。

### Trade Pattern Classifier (`trade-pattern-classifier.ts`)
監督式 KNN pattern DB。8D feature space + regime（categorical）。Wilson score 95% confidence lower bound（防止小樣本 overfitting）。Time-weighted win/loss（half-life 7 days）。`queryEntry()`（新倉）+ `queryPosition()`（持倉）。

### Sigmoid·GA Sentiment Engine (`sentiment-engine.ts`)
GA 演化 sigmoid 函數將 raw sentiment score → 0-1 conviction。Volume ratio + sentiment + conviction 注入 OLR features。

### S/R Zone Detection (`support-resistance.ts`)
SNR-based 支撐阻力區間。輸出 nearestSupport/Resistance + distanceBps。用於 SL/TP 定位 + OLR `srDistanceBps` feature + First-Passage SL/TP distances。

### SystemGuard（5 層）
| Guard | 功能 |
|:------|:-----|
| A — Calendar | 經濟日曆事件（高波動時段降倉） |
| B — Drawdown | 回撤 ≥ 20% → 平倉所有 |
| C — Data Freshness | 數據過時 → HOLD |
| D — Agent Track | Agent 響應追蹤（circuit breaker 3 failures → 30s fail-fast） |
| E — Liquidity | 流動性不足 → veto |

### LLM 抽象層 (`llm/`)
Provider interface + Ollama provider（circuit breaker + concurrency 4 + 指數退避）。支援 local + Pro cloud models。`OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:cloud`。

### 數據管道 (`data/`)
Hyperliquid WebSocket（l2Book + trades + activeAssetCtx + clearinghouseState + userFills）+ REST fallback。Binance WebSocket（輔助）。Global HL rate limiter（single queue, 429 retry）。WS infinite reconnect + REST polling backoff。

### 永續儲存 (`persistence.ts`)
`lockedWrite()` atomic write（v2.0.1）。State files: `olr-state.json` · `shadow-state.json` · `trade-patterns.json` · `evolution-state.json` · `portfolio-state.json` · `market-agent-config.json` · `debate-history.json`。

---

## 配置與環境變數

```bash
# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:cloud

# Hyperliquid (optional, real trading)
HYPERLIQUID_WALLET_ADDRESS=
HYPERLIQUID_PRIVATE_KEY=             # ⚠️ RADIOACTIVE — 永不 commit

# Paper Trading
PAPER_INITIAL_BALANCE=1000
PAPER_MAX_POSITION_SIZE_PCT=0.20
PAPER_MAX_DRAWDOWN_PCT=0.20
PAPER_DAILY_LOSS_LIMIT_PCT=0.05

# Risk
RISK_MAX_LEVERAGE=1.0
RISK_STOP_LOSS_PCT=0.02
RISK_TAKE_PROFIT_PCT=0.05
RISK_TRAILING_STOP_PCT=0.015

# HACP
HACP_PARALLEL_THINKING_TIMEOUT_MS=15000
HACP_MAX_DEBATE_ROUNDS=1
HACP_CONSENSUS_THRESHOLD=0.60
HACP_TOTAL_TIMEOUT_MS=120000
HACP_STAGGER_DELAY_MS=6000

# System
DECISION_INTERVAL_MS=300000           # 5 min
API_PORT=3456
LOG_LEVEL=info
```

所有環境變數啟動時經 **Zod schema** 驗證。失敗 → 立即退出 + 詳細錯誤訊息。

---

## 技術棧

| Category | Technology |
|:---------|:-----------|
| Language | TypeScript 5.6（嚴格模式，`noPropertyAccessFromIndexSignature`，零類型錯誤） |
| Runtime | Node.js 22+ |
| LLM | Ollama（local + Pro cloud）/ OpenAI-compatible |
| Market Data | Hyperliquid WebSocket + REST（9 perpetual DEXs） |
| Frontend | React 18 + Vite + TradingView Chart |
| Config | Zod schema validation |
| Logging | Winston（structured + file rotation） |
| Testing | vitest（41 tests） |
| Crypto | `@noble/curves`（HL phantom agent signing） |

---

## v2.0.138 — EXP 向量理據記憶（Skeptics Phase 1.8a 歷史機率閘）

**功能**：每筆已平倉 trade 嘅 rationale 組合 embed 成向量，存入 `data/exp/trades.jsonl`（inline vectors）+ `data/EXP.md`（人讀）。Meta-Agent 開倉時 Skeptics Phase 1.8a 用 set-to-set combination similarity（非對稱平均最佳匹配）搵最接近嘅歷史組合，算 similarity-weighted P(win)：
- 冇記錄 / 邊界 / delta 無歷史 → `PASS_OPEN_DIRECTLY`（直出開倉，跳過 1.8b）
- 歷史偏贏 → `FAST_APPROVE`（跳過 1.8b）
- 輸錢組合 + delta 同類別正面 / 跨類別正面+額外理據 → `APPROVE_WITH_NOTE`
- delta 負面 + 進一步風險因素 → `REVERSE_DIRECTION`（反向開倉，帶 Skeptics contrarian thesis）
- 輸錢組合無 delta / 跨類別無額外 / 負面無風險 / 反向被 direction 限制 → `REJECT`→HOLD
- EXP 出錯 / 被關 → 退返 1.8b 主觀強度檢查（fallback）

**Embedding**：`@xenova/transformers` + `all-MiniLM-L6-v2`（22MB ONNX、384-dim、in-process、CPU）。啟動時 warmup 預載。唔用 30B+ 本地模型。

**跨資產類別 + 多 delta 衝突**：`assetCategory()` 分類 crypto/commodity/equity/forex；delta 正面歷史若跨類別要 Skeptics 再搵一個理據；多 delta 衝突時揀 winRate 距 0.5 最遠（最極端）嗰邊決策，衝突 delta 組合記入 EXP 作未來參考。

**自癒（§8.6）**：1.8a fallback 時 `diagnoseError` → `skepticsAttemptRepair`（重載 embed / salvage 重建索引 / heuristic split）→ 修復成功重跑 1.8a（recursion guard 1 次）→ 記錄 incident 到 `data/exp/incidents.jsonl` + EXP.md 摘要。

**紅線不變**：EXP 只能 REJECT→HOLD 或放行 thesis gate，**永不 bypass** conviction / frequency / risk / direction / SL-TP。所有失敗安全 fallback。`config.exp.enabled` 預設 `false`（dormant，不影響現有行為）；主神批准後 `EXP_ENABLED=true` 啟用。

**檔案**：新 `src/evolution/embeddings.ts`（EmbedProvider + Transformers.js + Mock + 向量數學）、`src/evolution/thesis-experience.ts`（核心：extract/record/check/delta/reverse/repair）、`scripts/reindex-exp.ts`（換模型時重 embed）。改 `src/types/index.ts`（ThesisExperienceRecord/ExpVerdict/ExpCheckResult/ExpFallbackIncident + TradeRecord.entryThesis）、`src/config/index.ts`（exp block）、`src/trading/portfolio.ts`（close 時 capture `pos.entryThesis`→`trade.entryThesis`）、`src/index.ts`（實例化 + startup load/warmup + close hook）、`src/cognition/hacp.ts`（Phase 1.8a + `overrideMetaDecision` helper）。24 新測試（總 77）。tsc clean。

**v1 限制（v2 待辦）**：(1) REVERSE conviction 係 in-place override 用原 meta confidence，未做 Meta-Agent 重出 conviction 嘅 full re-HACP（option b）；(2) close hook `decisionOrigin` 暫固定 `meta-agent`，reverse 倉位嘅 `skeptics-reverse` origin 偵測需 open 時 tag position。

Blueprint：`/Users/y.c./Downloads/EXP_core_plan.md`（556 行，15 項定奪 + §8.6 自癘）。

---

## v2.0.137 — Thesis 凍結（Root Cause B：修復交易太密＋勝率低）

**症狀**：real trade 全部被 thesis invalidation 6-15 分鐘內強制平倉（唔係 SL/TP），PnL 接近零，open→invalidate→close→再 open churn loop。

**根因 B（本輪修復）**：`setEntryThesis()` 無條件覆寫 → 每循環最新 Meta-Agent thesis 取代原始理據 → Skeptics Phase 0.5 re-validate 一個移動目標 → 有時被覆寫成 `'N/A'`/空 → 自動失效 → 強制平倉。

**修復**：`setEntryThesis` → set-if-absent + 拒絕 placeholder（`isThesisPlaceholder()` helper）。原始開倉理據凍結至平倉；re-import 倉位用 best-available HACP thesis 填入後同樣凍結。`holdReason` 保留為 live 每循環 reasoning（唔被 re-validate）。

**根因 A/D 保留**：re-validation prompt 進取性 + 短 cooldown 係有意設計（緊急應對特殊情況），唔改。

5 個 regression tests（總 53）。tsc clean。

---

## v2.0.136 — 執行漏洞修復 + UI 持倉標籤修正

本輪修復咗 7 個阻塞真實交易同 UI 顯示嘅漏洞：

| # | Bug | 根因 | 修復 |
|:--|:----|:----|:----|
| 1 | `normalizeDecision()` 丟棄 `entryThesis` | decision-utils 回傳物件漏 entryThesis | 保留 entryThesis / srSupport / srResistance |
| 2 | `buildConsensus()` 硬編碼 `symbol:'BTCUSDT'` | hacp.ts 寫死 | 改用 Meta-Agent marketTicker 真實 symbol + perSymbolConsensus fallback |
| 3 | 主決策路徑唔設 `entryPrice` | index.ts decisionWithSR 漏 entryPrice | `entryPrice: combinedState.price ?? marketPrice` |
| 4 | BTC SELL 「could not immediately match」 | l2Book/allMids case-sensitive，傳 lowercase 'btc' 返 null → price=0 → 用 decision price 唔穿 bid | 改用 `asset.name`（'BTC'）+ l2Book best bid/ask 主源 |
| 5 | Portfolio「Reason」只 show 1st cycle | `paperEngine.executeDecision` 嘅 `riskEngine.assessTrade()` 喺 paper drawdown  20% 時拒絕 mirror（`forceMirror=true` 只 bypass 咗 `canTrade()` 嘜 bypass 呢個）→ 無 thesis mirror 被建立 → 下個 cycle `syncExchangePositions` reimport HL 倉位（無 thesis） | `forceMirror=true` 同時 bypass `assessTrade()`（同 canTrade 一致）→ mirror 帶 entryThesis 建立並持久化到 `portfolio-state.json` + 即時 tag `agentId='hyperliquid-real'` → in-place update 保留 thesis |
| 6 | HACP Debate MU/SILVER 閃「● position」↔「(market)」 | UI trust `psc.hasPosition`（metaAgentArbitration 盲設 true，含注入 trading markets） | UI 改用 `data.portfolio.positions` 實際持倉做 source of truth |
| 7 | `adjustPositions()` 對注入 trading market placeholder 產生 SL/TP validation 噪音 | 對 qty=0 placeholder 調 LLM 調 SL/TP → 必失敗 retry-error spam | skip `quantity===0 || isTradingMarket===true` |
| 8 | Portfolio「Reason」連第 1 個 cycle 都空（trading market 倉位） | `buildConsensus` 嘅 `positions[]` 迴圈 push 咗 `rationale` + `holdReason` 但漏咗 `entryThesis`（marketTicker / singleDec 兩條路徑都有 push）→ trading market 嘅 psc.entryThesis=undefined → mirror 無 thesis | `positions[]` 迴圈補回 `if (pos.entryThesis) posEntry.theses.push(pos.entryThesis)` + perSymbolConsensus sync 每個 cycle 重設 → 既有倉位即時攞返 thesis |

**v2.0.136 Bug 5/8 詳情**：Portfolio「Reason」消失有兩個疊加根因——(a) `paperEngine` 嘅 `riskEngine.assessTrade()` 喺 paper drawdown \u001e 20% 時拒絕 mirror（`forceMirror` 只 bypass `canTrade` 嘜 bypass 呢個）→ 無 thesis mirror → reimport 丟失；(b) 即便 mirror 建立，trading market 嘅 `positions[]` 迴圈漏 push `entryThesis` → psc 無 thesis → mirror 一開始就空。兩者皆已修。每個 cycle `perSymbolConsensus` sync 重設 thesis（主神要求：有新 reason 就 update）。

**紅線守護**：本座冇降低 conviction threshold、冇改變 SL/TP 最小距離 floor（1%/1.5%/2% 百分比隨價格自動縮放，SILVER 實倉 SL 1.6%/TP 3.2% 未被 floor 阻擋）、冇觸碰槓桿/私鑰/交易模式。

---

## 啟動

```bash
npm run dev    # concurrently: tsx watch (API :3456) + vite (UI :5173)
```
Dashboard: **http://localhost:5173/** · API: **http://localhost:3456/api/status**

UI 開發模式由 Vite serve（:5173），`/api` proxy → :3456。Prod 模式（`tsx src/index.ts` + `ui/dist` built）:3456 同時 serve API + static UI。