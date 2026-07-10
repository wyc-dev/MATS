# {MATS} — Multi Agent Trading System

> **作者**: YC Wong · **版本**: 2.0.141
> **核心哲學**: 資本保存為絕對第一優先，但必須在安全前提下持續創造盈利
> **代碼量**: ~42,600 行 TypeScript（嚴格模式，零類型錯誤）+ React UI

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
| **自我演化** | OLR + Shadow Trading + First-Passage + EM Cycle Chain + GA + Pattern DB + RIL，從每筆交易學習 |
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
│   • RIL Reason Intelligence Layer（pattern clustering + close reason stats）│
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
├── evolution/               # 自我演化（OLR + Shadow + First-Passage + EM + GA + RIL + EXP）
│   ├── embeddings.ts        # Transformers.js MiniLM 384-d 向量（in-process）
│   ├── thesis-experience.ts # EXP 理據組合歷史勝率（Phase 1.8a reference data）
│   ├── experience-digester.ts # A2A 經驗消化（LLM lesson → embed → cluster → classify，supplementary）
│   ├── cycle-summary.ts     # EM Cycle Chain（market continuity）
│   └── reason-analytics.ts  # RIL Reason Intelligence Layer（pattern clustering + close reason stats + similar trade retrieval）
├── analysis/                # sentiment · S/R · ATR · planck-chaos · options · news
├── market-agent/            # 自動 pair 選擇（9 DEX, 416 assets, 類別過濾）
├── data/                    # Hyperliquid + Binance WebSocket
├── api-server.ts            # REST + SSE (:3456) + static UI
└── index.ts                 # 系統 orchestrator（決策循環）
ui/                          # React + Vite dashboard (:5173)
data/evolution/              # olr-state · shadow-state · patterns · GA state · em-state
tests/                       # vitest（94 tests）
```

---

## 八智能體系統

| # | Agent | 溫度 | 權重 | 角色描述 |
|:-:|:------|:----:|:----:|:---------|
| 1 | **Market Agent** | — | — | 自動選取最高 24h 交易量 pair。9 個 HL DEX，416 assets，按類別過濾（Indices/Stocks/Commodities/FX）。HACP 週期前執行，阻塞其餘 Agent。 |
| 2 | **Fractal Momentum Sentinel** | 0.85 | 0.10 | 多時間框架碎形自相似模式檢測。趨勢加速早期信號。極端逆向，中間趨勢追隨。 |
| 3 | **On-Chain Whisperer** | 0.50 | 0.10 | 類別感知鏈上分析。Crypto: mempool/flows/supply。TradFi: DXY/COT/商品/COT 持倉。5 分鐘緩存。 |
| 4 | **OLR & Sentiment Analyst** | 0.25 | 0.10 | OLR P(win) per side + First-Passage path-risk + Fear & Greed。RR-aware：P(win) 對 breakevenP 計 edge。PRIMARY factor。 |
| 5 | **News Reporter** | 0.40 | 0.20 | **Institutional Narrative Decoder**。5 部分框架：信息不對稱先驗、價格-新聞時機矩陣、6 桶動機分類（front-run/accumulation-FUD/distribution-hype/narrative-pivot/decoy-smoke/paradigm shift）、權力圖、淨機構調整信號。L3 Meta-Agent 決定性權重（命名動機 + 時機確認時可覆蓋 HOLD 多數）。 |
| 6 | **Independent Risk Auditor** | 0.10 | 0.25 | **advisory-only（不可 veto）**。TP/SL/size 建議 + 硬性代碼限制（震盪市減倉、loss-streak 漸進減倉、虧損冷卻期）。近期 10 trade 模式分析。 |
| 7 | **Skeptics** | 0.30 | 0.00 | 邏輯審計員 + 壓力測試員。**Approve-First**——預設 APPROVE，只係喺搵到具體會導致輸錢嘅 material flaw 時先 REJECT。Phase 1.5 審查 5 sub-agents；Phase 1.8 驗證 entryThesis；Phase 0.5 每循環重新驗證持倉 thesis → 失效即強制平倉。使用 RIL reference data 做 data-backed audit。 |
| 8 | **Meta-Agent** | 0.45 | 0.00 | 仲裁主席。偵探模式——積極從事實推理蛛絲馬跡嘗試開倉，絕不歪曲事實。生成 entryThesis。使用 Confidence Calibration Framework：BASE WR → adjust for close context → adjust for subtle differences → FINAL confidence → decision。權重 0.00（理據系統控制，唔靠投票）。HOLD 時必須提供 holdReason。 |

> **權重說明**：Meta-Agent + Skeptics 權重 0.00 — 佢哋透過 thesis 系統控制決策，唔參與投票。5 個 sub-agent 加權投票，consensus threshold 50%（由 Evolution 動態調整，floor 0.49）。

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
          • 接收 RIL reference data（ENTRY PATTERN MAP + CLOSE REASON STATS + SIMILAR TRADES）
          • 使用 Confidence Calibration Framework 做最終決定
PHASE 1.8 Skeptics 驗證 Meta-Agent entryThesis（強而有力、數據驅動、暗黑心理學、事實扭曲）
          • 使用 RIL reference data 做 data-backed audit
          • 拒絕即 HOLD
PHASE 2-4 結構化辯論（1-3 rounds，unanimous 可跳過）
PHASE 5   加權投票共識（50% threshold，動態調整，floor 0.49）+ 執行
```

**時間預算**：Phase 1 平行 ~60s · Skeptics ~10s · Meta-Agent ~10s · 辯論 ~30s · 120s hard timeout → HOLD。

**共識閾值動態調整**：idle（連續 HOLD）→ 降閾值鼓勵交易；loss streak → 降閾值但配合減倉；regime=chaotic → 升閾值。

---

## Entry Thesis System + Skeptics

**Entry Thesis**：Meta-Agent 開倉時必須提供 `entryThesis = "[1h: <短線原因>] [1d: <中線原因>]"`。Skeptics Phase 1.8 驗證：強而有力、數據驅動、暗黑心理學審查（大戶操縱？）、事實扭曲檢查。拒絕即 HOLD。

**Thesis 凍結**：`entryThesis` 喺開倉時凍結為「原始理據」，之後永不覆寫。`holdReason` 保留為 live 每循環 reasoning（可自由更新）。

**Thesis 重新驗證（Phase 0.5）**：每循環 Skeptics 重新驗證所有持倉嘅 entryThesis。失效條件：catalyst 已耗、結構破壞、方向 contradicted、1h timeframe 過期。失效 → 強制平倉。

**平倉規則**：CLOSE 必須 thesis 失效（強制）+ ≥2 其他條件。Thesis 仍有效 → HOLD，無例外。

**提早平倉防護**：Meta-Agent CLOSE 決策前強制 5 重檢查：
1. PRICE LEVEL — 是否真正突破 S/R？
2. SL/TP CHECK — 是否已觸發？
3. TIME CHECK — 持倉 ≥15min？
4. EXPERIENCE DIGEST — 高 premature 率 → 格外保守
5. DIRECTION — OLR 仍支持 → HOLD

Skeptics 預設改為 VALID / BLOCK（when in doubt, keep open）。

**Skeptics Approve-First**：預設 APPROVE，只係喺搵到具體、會導致輸錢嘅 material flaw 時先 REJECT。唔因「low confidence」「could be manipulation」等弱理由 reject。Error fallback = APPROVE。

---

## RIL — Reason Intelligence Layer

> 核心哲學：**俾 Meta-Agent 數據去 reason，唔係幫佢 decide。**

RIL 提供三層結構化 reference data，令 Meta-Agent 可以極限運用歷史經驗做出最趨利避蝕嘅最優判斷。

### 三層參考數據

```
Layer 1: RIL（primary）— 結構化 reference data
  ─ PatternClusterManager：greedy cosine clustering of rationale texts（MiniLM 384-d）
    → 每個 entry pattern 嘅 WR/PnL/count，injected 做 ENTRY PATTERN PERFORMANCE
  ─ CloseReasonAggregator：pure math GROUP BY exitType+origin
    → 每個 close reason 嘅 WR/PnL/count，injected 做 CLOSE REASON PERFORMANCE
  ─ SimilarTradeRetriever：top-N similar trade retrieval by combination similarity
  ─ SubtleDiffAnalyzer：1 LLM call per cycle for subtle differences analysis

Layer 2: EXP（supplementary reference）— 向量相似度 reference
  ─ checkThesisHistory() 保留，但 inject 做 reference block，唔係 binary gate
  ─ Meta-Agent 見到 EXP verdict + Dual-Channel Fusion 結果，自己 decide

Layer 3: A2A Digester（supplementary reference）— LLM 角度 supplementary analysis
  ─ getDigestSummary() 保留，inject 做 supplementary text block
  ─ 提供 LLM-based root cause + exit quality analysis
```

### Confidence Calibration Framework

Meta-Agent 同 Skeptics 使用完整 confidence calibration framework：

```
Step 1: BASE confidence = pattern WR（from ENTRY PATTERN MAP）
Step 2: Adjust for close reason context（from CLOSE REASON STATS）
         ─ 如果 losses 係 premature → 方向可能啱，confidence UP
         ─ 如果 losses 係 correct_sl → 方向錯，confidence DOWN
Step 3: Adjust for subtle differences（from SIMILAR TRADES）
         ─ Count strengthening vs weakening factors
         ─ Net positive → confidence +5-15%
         ─ Net negative → confidence -5-15%
Step 4: FINAL confidence → decision

FINAL CONFIDENCE:
  >= 70% → ENTER standard size, SL at S/R, TP at S/R
  50-69% → ENTER reduced size (50-75%), wider SL (1.5-2x)
  30-49% → ENTER minimal (25%) OR HOLD
  < 30%  → HOLD
```

### 核心檔案

| 檔案 | 說明 |
|:-----|:-----|
| `src/evolution/reason-analytics.ts` | RIL core：PatternClusterManager + CloseReasonAggregator + SimilarTradeRetriever + SubtleDiffAnalyzer |
| `src/evolution/embeddings.ts` | Transformers.js MiniLM 384-d embedding provider + vector math |
| `src/evolution/thesis-experience.ts` | EXP vector memory（reference data source，非 gate） |
| `src/evolution/experience-digester.ts` | A2A LLM digestion（supplementary analysis） |

---

## 自我演化系統

### OLR — Online Logistic Regression（`olr-engine.ts`）

Per-symbol, per-side online logistic regression 從 shadow + paper + real + backfill 嘅 TP-before-SL 結果學習 P(win)。每個 feature 獨立計數，缺失 feature 返回中性 z=0。Source-weighted SGD updates（real=4, paper=2, shadow=1, backfill=0.3）。Confidence: high(≥50) / medium(≥20) / low(<20) samples。

### Shadow Trading（`shadow-trade-engine.ts`）

每個 cycle 為每個 trading market 開模擬 LONG + SHORT，S/R-aligned SL/TP。Multi-candle hold（max 20 candles），第一根觸及 SL/TP 即 resolve。學 TP-before-SL（真實可盈利性），唔係 5 分鐘價格方向。

### First-Passage Path Risk（`first-passage.ts`）

即時 P(TP before SL) from σ（log-returns std）+ ν（log-drift EWMA）+ per-side SL/TP distances。Cox & Miller (1965) GBM formula。RR-aware：P(win) 對 breakevenP 計 edge。

### Cold-Start Backfill（`olr-backfill.ts`）

首次 cycle per market：non-blocking replay 186 歷史 HL M5 candles 入 OLR 作 backfill source。Idempotent。

### EM Cycle Chain（`cycle-summary.ts`）

Meta-Agent 每循環蒸餾結構化 `CycleSummary`（E-step）；previous summaries 注入下循環 context（M-step）。Skeptics cross-check insight vs 實際價格（convergence audit）。Tiered memory：hot(12) + warm(288) + cold(48 epochs ≈ 48 days)。持久化到 `em-state.json`。

### Trade Pattern Classifier（`trade-pattern-classifier.ts`）

監督式 KNN pattern DB。8D feature space + regime（categorical）。Wilson score 95% confidence lower bound。Time-weighted win/loss（half-life 7 days）。

### Sigmoid·GA Sentiment Engine（`sentiment-engine.ts`）

GA 演化 sigmoid 函數將 raw sentiment score → 0-1 conviction。Volume ratio + sentiment + conviction 注入 OLR features。

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

**TP/SL 三層安全**：no-widen + not-too-tight（SL ≥ 1%, TP ≥ 1.5%）+ min-gap + max-narrow-step。

**累計 Margin 上限 20%**：所有持倉 margin 總和 ≤ 20% balance（基於 margin 而非 notional）。

---

## Paper Trading 模擬層

- 槓桿感知 P&L：notional-based 雙邊手續費扣除
- 每個 price update 自動檢查 SL/TP
- Position Reconciliation：偵測 exchange 已平倉 → 同步 local mirror
- Real Trading Manager：HL exchange 下單 + 本地 mirror（phantom agent signing via `@noble/curves`）
- Mirror thesis 持久化：`forceMirror=true` bypass `canTrade()` + `riskEngine.assessTrade()`，mirror 帶 entryThesis 持久化到 `portfolio-state.json`
- placeOrder 價格源：LIVE `l2Book`（best bid/ask）做 aggressive price 主源，`allMids` REST 做 fallback

---

## 其他子系統

### S/R Zone Detection（`support-resistance.ts`）
SNR-based 支撐阻力區間。輸出 nearestSupport/Resistance + distanceBps。用於 SL/TP 定位 + OLR `srDistanceBps` feature + First-Passage SL/TP distances。

### SystemGuard（5 層）
| Guard | 功能 |
|:------|:-----|
| A — Calendar | 經濟日曆事件（高波動時段降倉） |
| B — Drawdown | 回撤 ≥ 20% → 平倉所有 |
| C — Data Freshness | 數據過時 → HOLD |
| D — Agent Track | Agent 響應追蹤（circuit breaker 3 failures → 30s fail-fast） |
| E — Liquidity | 流動性不足 → veto |

### LLM 抽象層（`llm/`）
Provider interface + Ollama provider（circuit breaker + concurrency 4 + 指數退避）。支援 local + Pro cloud models。`OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:cloud`。

### 數據管道（`data/`）
Hyperliquid WebSocket（l2Book + trades + activeAssetCtx + clearinghouseState + userFills）+ REST fallback。Binance WebSocket（輔助）。Global HL rate limiter（single queue, 429 retry）。WS infinite reconnect + REST polling backoff。

### 永續儲存（`persistence.ts`）
`lockedWrite()` atomic write。State files: `olr-state.json` · `shadow-state.json` · `trade-patterns.json` · `evolution-state.json` · `portfolio-state.json` · `market-agent-config.json` · `debate-history.json` · `em-state.json`。

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
HACP_CONSENSUS_THRESHOLD=0.50
HACP_TOTAL_TIMEOUT_MS=120000
HACP_STAGGER_DELAY_MS=6000

# System
DECISION_INTERVAL_MS=300000           # 5 min
API_PORT=3456
LOG_LEVEL=info

# RIL (Reason Intelligence Layer)
RIL_ENABLED=true
RIL_CLUSTER_THRESHOLD=0.75
RIL_MIN_CLUSTER_SIZE=3
RIL_MAX_PATTERNS_DISPLAY=10
RIL_SIMILAR_TRADE_COUNT=5
RIL_SUBTLE_DIFF_ENABLED=true
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
| Testing | vitest（94 tests，5 test files） |
| Crypto | `@noble/curves`（HL phantom agent signing） |
| Vector Embedding | Transformers.js MiniLM L6 v2（384-dim, in-process, CPU） |
| Pattern Clustering | Greedy cosine clustering（RIL Reason Intelligence Layer） |

---

## 啟動

```bash
npm run dev    # concurrently: tsx watch (API :3456) + vite (UI :5173)
```
Dashboard: **http://localhost:5173/** · API: **http://localhost:3456/api/status**

UI 開發模式由 Vite serve（:5173），`/api` proxy → :3456。Prod 模式（`tsx src/index.ts` + `ui/dist` built）:3456 同時 serve API + static UI。

---

> 完整版本歷史請見 [CHANGELOG.md](CHANGELOG.md)。
