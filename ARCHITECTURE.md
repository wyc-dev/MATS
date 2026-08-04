# {MATS} — Multi Agent Trading System（訊號運算後端）

> **作者**: YC Wong · **版本**: 2.0.855+
> **核心哲學**: 資本保存為絕對第一優先，但必須在安全前提下持續創造盈利
> **定位**: `mats_backend` 係 **`mats_app`（Expo React Native 客戶端）嘅訊號運算系統**——計算 HACP 共識 → 擴展成 3×3 風險矩陣 → 寫入 Supabase；客戶端按用戶選擇嘅風險等級讀取對應矩陣格並決定執行
> **代碼量**: ~63,000 行 TypeScript（嚴格模式，零類型錯誤）

---

## 概述

**MATS**（Multi Agent Trading System）係一個具備自我演化能力嘅多智能體量化訊號系統。核心決策引擎為 **HACP（Hyper-Accelerated Cognition Protocol）**——結構化多 LLM 辯論協議。在 **Hyperliquid（9 perpetual DEXs, 416 assets）** 市場上計算機構級交易訊號。

**架構定位（v2.0.822+）**：`mats_backend` 不再係獨立交易系統，而係 **`mats_app` 嘅訊號運算後端**。每個 cycle 後端計算 HACP 共識 → 擴展成 **3×3 Analysis Matrix**（風險等級 × 持倉狀態）→ 寫入 Supabase `asset_analyses` 表。客戶端（`mats_app`）讀取矩陣，按用戶喺客戶端選擇嘅風險等級（`high`/`mid`/`low` → `aggressive`/`moderate`/`conservative`）+ 當前持倉狀態（`long`/`short`/`flat`）揀選對應矩陣格，再由客戶端決定執行（paper/real）。

**風險等級由客戶端選擇**：後端運算所有三個風險等級嘅訊號，客戶端 UI（`mats_app` SettingsSheet）讓用戶選 `high`/`mid`/`low`。後端矩陣係 **universal**（per-asset，非 per-user）——所有同風險等級嘅用戶讀同一格。

### 核心設計原則

| 原則 | 說明 |
|:-----|:-----|
| **資本保存第一** | 所有決策以生存為前提，利潤為次要。任何錯誤預設 HOLD，永遠不倒 |
| **理據驅動** | Meta-Agent 必須提供 entryThesis（`[1h:..] [1d:..]`）才可開倉；Skeptics 絕對否決權 |
| **暗黑心理學** | Meta-Agent 質疑數據是否大戶操縱；Skeptics 驗證 Meta-Agent 自身是否被偏誤 |
| **極限推理** | 冇倉位必須 BUY/SELL（極度不確定先 HOLD）；有倉位 thesis 失效（強制）+ ≥2 其他條件先 CLOSE |
| **自我演化** | 認知演化管線（v2.0.855: 15 active + 1 Edge Validation + 1 Q-RL Alpha Discovery + 1 DCS v2 Risk Profile Differentiation + 1 Component Attribution）— OLR + Shadow Trading + First-Passage + EM Cycle Chain + GA + RIL + NA + AttnRes + Combo WR Gate + P(win)×Consensus Discount + Close-Context Learning v2.0.226 + Plan G Dynamic Threshold v2.0.227 + Edge Validation v2.0.833 + Q-RL Alpha Discovery v2.0.835 + DCS v2 v2.0.836 + Component Attribution v2.0.844，從每筆交易學習。v2.0.833 移除 4 個 0-inference 組件 + 暫停 active-exploration。v2.0.835 新增 Q-RL + Factor-Tagged Aligned Shadow。v2.0.836 新增 DCS v2 風險等級區別化（三個 profile 真正唔同決策）。v2.0.844-848 新增 Component Attribution + LLM-vs-Stats A/B shadow + Label Cleanliness（量度邊個組件真正加 edge）。v2.0.849-851 將 momentum/exec-lens/confidence SL widening 移植到 live computeSmartSLTP + 修復 TradeRecord.closeReason 資料缺失（RIL + trade-audit 可以分到「SL 太緊」定「thesis 錯」）。v2.0.853 修復 closeTrade dual-mode guard（dual 模式下所有平倉被靜默跳過）+ 3 個缺失 closeReason 標記 + tradingManager.closePosition 用滯後 WS 價格代替實際 HL fill + UI SSE 退避。**v2.0.855 學習管道修復**：aligned shadow 恆開（real-trade cycles 都開，Q-RL 不再餓死）+ shadow_blind OLR 計數器（v2.0.834 承諾但從未 implement）+ thesis-invalidation closeReason 全覆蓋。**v2.0.855-fix**：Q-RL EXP backfill（1072 筆歷史交易 populate Q-table，令 discoverPatterns 即刻有嘢掃）。**v2.0.855-attack**：7 個修復引入嘅漏洞全部修補（OLR counter 字符串/負數消毒、closeReason 白名單、aligned-shadow weightedDirection 用真 LLM lean）。**v2.0.855-attack2**：Q-RL binRegime 邊界同 regimeToOrdinal 完全錯位（6/7 regime 入錯桶，bull/bear 對調）已對齊 |
| **唔靠過去 P&L** | 過去 drawdown/losses 唔係拒絕交易嘅理由——OLR 持續學習，市況不斷變化 |
| **多資產單循環** | 所有交易市場單一 HACP 循環分析；無持倉市場以 isTradingMarket=true 注入 |
| **風險等級客戶端選擇** | 後端運算 3 個風險等級（aggressive/moderate/conservative）嘅訊號矩陣；客戶端按用戶選擇讀取對應格（v2.0.822）|
| **訊號與執行分離** | 後端計算訊號 + 寫入 Supabase；客戶端讀取 + 決定執行（paper/real）。`ANALYSIS_MODE` 控制後端是否同時執行 |
| **生產級標準** | 完整型別（Zod 驗證）、結構化日誌（Winston）、優雅關閉、指數退避重連 |

---

## 帳戶模型：Paper（模擬）vs Real（Hyperliquid 真實）⚠️ 前文後理

> **重要**：MATS 有兩套完全獨立嘅帳戶，數據來源唔同，**唔可以混淆**。診斷真實盈虧一定要用 Real 帳戶數據。

| 維度 | Paper 帳戶（模擬） | Real 帳戶（Hyperliquid 真實） |
|:-----|:------------------|:------------------------------|
| **金錢性質** | 虛擬餘額，唔係真錢 | 真實 USDC，HL 鏈上 |
| **初始值** | `config.paper.initialBalance`（`PAPER_INITIAL_BALANCE`, 預設 1000） | HL 錢包持有量（系統無記錄初始值，用 accountValue 睇現值） |
| **數據來源** | `PortfolioTracker`（portfolio.ts）本機計算 | HL API `clearinghouseState`（hyperliquid-engine.ts `getBalance()`） |
| **儲存位置** | `portfolio-state.json` 嘅 `balance` / `totalEquity` / `totalPnl` 欄位 | **唔儲存**——每次啟動重新 fetch（`cachedExchangeBalance`） |
| **變動機制** | Paper 開倉/平倉嘅 margin + fee 加減 | HL 真實撮合、funding、手續費 |
| **未實現 PnL** | 計入 paper `totalEquity`（僅 paper 倉位） | 已包含喺 HL `accountValue`（= free + marginUsed） |
| **已實現 PnL** | paper `totalPnl` | **冇單一數字**——要睇 HL 帳戶自己嘅 accounting |
| **UI 顯示** | Paper mode 先顯示 | Real mode：Genuine Balance / Equity 直接用 HL 值（`serializePortfolio` displayBalance/displayEquity） |

### 關鍵規則

1. **`portfolio-state.json` 嘅 balance 係 paper 值**——診斷真實盈虧用佢係錯嘅。真實盈虧睇 HL `accountValue`（UI「Genuine Balance」）。
2. **Real 倉位從不影響 paper balance/equity**——`recalculateEquity()` 只 loop `portfolio.positions`（paper），`realPositions` 完全唔計。呢個係設計（v2.0.72），唔係 bug。
3. **`realTrades`（closedRealTrades）只含已平倉交易**——未平倉嘅 4 倉位嘅盈利存喺 `realPositions.unrealizedPnl`，未入歷史記錄。
4. **HL `accountValue` 包含未實現 PnL**——`total = free + marginUsed`，所以佢反映「而家」嘅真實權益，包括開倉中嘅浮盈。
5. **Real 帳戶嘅初始值唔追蹤**——系統無記錄 HL 入金量；判斷盈虧要用 accountValue 同主神自己記得嘅入金量對比。

---

## 系統架構（訊號運算後端 + 客戶端執行）

```
┌──────────────────────────────────────────────────────────────┐
│   mats_app（Expo React Native 客戶端）— 執行 + 風險選擇         │
│   • 用戶喺 SettingsSheet 選擇風險等級（high/mid/low）           │
│   • useAssetAnalyses hook 讀取 Supabase asset_analyses 表       │
│   • useAutoTrade hook 按風險等級 + 持倉狀態揀矩陣格 → 執行      │
│   • Paper mode：寫入 Supabase positions 表（模擬）              │
│   • Real mode：Pro + PK stored → 簽名 + 提交 Hyperliquid        │
│   • 自託管：PK 存喺設備 SecureStorage，後端永不持有             │
│   • trade-bridge：HL WS 市場數據 + on-chain reconciliation      │
└──────────────────────────────────────────────────────────────┘
                            ↑ 讀取
                            │
┌──────────────────────────────────────────────────────────────┐
│   Supabase（asset_analyses 表 — universal per-asset 矩陣）      │
│   • 每個 cycle 後端 DELETE + INSERT 乾淨快照                    │
│   • 一行一 asset，含 3×3 matrix + consensus + marketData        │
│   • RLS：anon/authenticated 可讀；service_role 寫入             │
└──────────────────────────────────────────────────────────────┘
                            ↑ 寫入（service_role）
                            │
┌──────────────────────────────────────────────────────────────┐
│   mats_backend（本系統 — 訊號運算引擎）                         │
│                                                                │
│   Layer 1: 戰略層 (Terminal Agent)                              │
│   • Terminal Agent：用戶自然語言偏好 → Root Command Prompt      │
│   • Cycle 前置規則檢查 + 後置決策核實                           │
├──────────────────────────────────────────────────────────────┤
│   Layer 2: 認知層 (TypeScript + Ollama)                        │
│   • HACP 多模型平行推理（僅關鍵決策點觸發 LLM）                 │
│   • 6 智能體 + Meta-Agent 仲裁 + Skeptics 邏輯審查             │
│   • Entry Thesis System + 暗黑心理學 + 結構化辯論 + 加權投票    │
│   • 認知演化管線（v2.0.836: 15 active + Edge Validation + Q-RL Alpha Discovery + DCS v2；4 組件已移除）     │
│   • Plan G Dynamic Threshold [45-55%] + 乘法 Penalty 衰減       │
│   • SystemGuard（5 層系統級保護）                               │
├──────────────────────────────────────────────────────────────┤
│   Layer 3: 訊號輸出層 (Analysis Matrix Builder + Supabase)     │
│   • buildAssetAnalysis()：共識 → 3×3 矩陣（v2.0.822）           │
│   • SupabaseAnalysisWriter：每 cycle 寫入 asset_analyses 表     │
│   • ANALYSIS_MODE：true=僅訊號 / dual=訊號+執行 / false=僅執行  │
├──────────────────────────────────────────────────────────────┤
│   Layer 4: 執行層（dual mode 時啟用，TypeScript Runtime）       │
│   • Hyperliquid WebSocket（l2Book + trades + userFills）+ REST  │
│   • 風險引擎（毫秒級，無需 LLM）· Paper/Real Trading Manager    │
│   • 倉位追蹤 & SL/TP · Position Reconciliation                 │
│   • 數據管道 & 持久化 & 可觀測性                                │
└──────────────────────────────────────────────────────────────┘
```

**`ANALYSIS_MODE` 環境變數**（`src/index.ts` line ~152）：
- `'true'` — 僅計算訊號 + 寫入 Supabase，唔下單（純訊號後端模式）
- `'dual'` — 同時計算訊號 + 寫入 Supabase + 執行交易（paper/real）
- `'false'` — 僅執行交易，唔寫入 Supabase（legacy 獨立交易模式）

---

## 專案結構

```
src/
├── agents/                  # 8 agents + Meta-Agent（訊號運算用）
│   ├── base-agent.ts        # LLM call + retry + confidence
│   ├── meta-agent.ts        # 仲裁 + entryThesis 生成
│   ├── skeptics.ts          # 邏輯審查 + thesis 驗證（Phase 0.5/1.5/1.8）
│   └── agents.ts            # 5 sub-agents
├── cognition/
│   ├── hacp.ts              # HACP 協議（Phase 0-5）
│   └── a2a-utils.ts         # A2A 信號交換
├── llm/                     # LLM 抽象層（provider + circuit breaker + concurrency 4）
├── trading/                 # portfolio · paper-engine · trading-manager · hyperliquid-engine · position-utils · cost-model
│   │   v2.0.172: real-trading-manager → trading-manager, hyperliquid-real-engine → hyperliquid-engine
│   │   v2.0.173: position-utils.ts 共享 helper（computeSLTP, recomputePnL, trackMAEMFE）
│   │   v2.0.143: executeTrade() / closeTrade() 統一路由
├── risk/                    # 風險引擎 + correlation-budget
├── system-guard/            # 5 層保護閘門
├── evolution/               # 自我演化（認知演化管線：OLR + Shadow + First-Passage + EM + GA + RIL + EXP + NA + AttnRes + Anti-Pattern + Combo WR + P(win) Discount + Close-Context Learning v2.0.226 + Plan G v2.0.227 + Q-RL Alpha Discovery v2.0.835。v2.0.833 移除 temporal-attention/cross-symbol/reward-shaping/world-model；暫停 active-exploration）
│   ├── embeddings.ts        # Transformers.js MiniLM 384-d 向量（in-process, singleton v2.0.216）
│   ├── thesis-experience.ts # EXP 理據組合歷史勝率（方向過濾 + lesson persistence v2.0.207 #E）
│   ├── experience-digester.ts # A2A 經驗消化（per-direction winRate + LessonStatement v2.0.207）
│   ├── cycle-summary.ts     # EM Cycle Chain（market continuity, dual-channel v2.0.206 #6）
│   ├── numeric-autoencoder.ts # Numeric Autoencoder（11→16→8 learned embedding, v2.0.204+v2.0.223 anti-collapse）
│   ├── combo-win-rate-tracker.ts # (symbol×side×regime) WR tracker（Wilson LB, v2.0.221）
│   ├── cycle-history-retrieval.ts # AttnRes Cycle-History（dual pseudo-query, v2.0.211-v2.0.212）
│   ├── attnres-trade-embedder.ts # AttnRes trade embedder（anti-collapse v2.0.217）
│   ├── anti-pattern-tracker.ts # Anti-Pattern clustering（failure lessons, v2.0.207 #F）
│   ├── replay-buffer.ts     # Experience Replay Buffer（PER, mini-batch retrain, v2.0.219）
│   ├── bayesian-olr.ts     # Bayesian OLR wrapper（MC Dropout uncertainty, v2.0.219；paused w/ exploration v2.0.833）
│   ├── active-exploration.ts # Active Exploration（UCB + info gain, v2.0.219；PAUSED v2.0.833: ACTIVE_EXPLORATION_ENABLED=false）
│   ├── reason-analytics.ts  # RIL（per-direction win rates + direction-filtered similar trades v2.0.176）
│   ├── evolution-utils.ts   # 共享 utils（safeNum v2.0.218, wilsonScore, computeVectorConditionalWinRate + rmsNormKeys + softmaxWeightedWR v2.0.211）
│   ├── q-rl-table.ts       # Q-RL Alpha Discovery（270-cell Q-table, ε-greedy, BH-FDR, v2.0.835）
│   ├── ann-index.ts        # ANN Index for EXP（IVF + spherical k-means, 10k records, v2.0.843）
│   ├── meta-learner.ts     # Meta-Learner（adaptive α + asset-aware feature weights, v2.0.840+843）
│   ├── self-improver.ts    # Self-Improver（Thompson Sampling bandit + OLS gradient, v2.0.838）
│   ├── causal-reasoner.ts  # Causal Reasoner（paired shadow uplift + permutation importance, v2.0.839）
│   ├── meta-calibrator.ts  # Meta-Cognitive Calibrator（Brier score + ECE, per-regime, v2.0.837）
│   │   # v2.0.833 REMOVED (0 inference call sites): temporal-attention.ts, cross-symbol-backbone.ts, reward-shaping.ts, world-model.ts
│   ├── direction-audit.ts   # LLM 交易記錄審計（v2.0.180）
│   └── system-engineer.ts   # 自主代碼工程師 Agent（v2.0.182）
├── analysis/                # sentiment · S/R · ATR（momentum-adaptive SL v2.0.207 #C）· planck-chaos · options · news
├── market-agent/            # 自動 pair 選擇（9 DEX, 416 assets, 類別過濾）
├── data/                    # Hyperliquid + Binance WebSocket
├── services/                # v2.0.822: Analysis Matrix + Supabase writer
│   ├── analysis-matrix.ts   # buildAssetAnalysis()：共識 → 3×3 風險矩陣（v2.0.822）+ edgeReport 注入（v2.0.833）
│   └── supabase-writer.ts   # SupabaseAnalysisWriter：每 cycle 寫入 asset_analyses 表（v2.0.822+823）
├── edge/                    # v2.0.833: Edge Validation Layer（alpha 測謊機）+ v2.0.836 DCS v2
│   ├── edge-config.ts       # Zod env var：threshold + weight + sample cap 10000
│   ├── edge-calculator.ts   # Task 1A：5-component regime-weighted edgeScore
│   ├── execution-tracker.ts # Task 1B：slippage + funding → 可實現 PnL 校準
│   ├── stability-monitor.ts  # Task 1C：perturbation + cross-time 穩定性
│   ├── risk-profile-edge-store.ts # MiniLM 向量 DB：per-profile conditional edge
│   ├── backtest-validation.ts # Sharpe/Sortino/Calmar/PF/bootstrap/DSR/walk-forward
│   └── dcs-calculator.ts    # v2.0.836: DCS v2 連續 [0,1] Discovery Confidence Score
├── api-server.ts            # REST + SSE (:3456) + static UI（legacy）
└── index.ts                 # 系統 orchestrator（決策循環 + 矩陣寫入 ~line 6478）
ui/                          # Legacy React + Vite dashboard（已由 mats_app 取代）
data/evolution/              # olr-state · shadow-state · patterns · GA state · em-state · na-model · cycle-history · anti-patterns
tests/                       # vitest（609 core + 424 attack tests，gitignored）
supabase/migrations/         # 00000000000018_asset_analyses_matrix.sql（v2.0.822）
```

## Analysis Matrix + 風險設定架構（v2.0.822）

**核心設計**：後端每個 cycle 為每個 asset 計算一個 HACP 共識，然後擴展成 **3×3 推薦矩陣**，寫入 Supabase `asset_analyses` 表。客戶端讀取矩陣，按用戶選擇嘅風險等級 + 當前持倉狀態揀選對應格。

### 3×3 矩陣結構

```
              │  long（已持多）  │  short（已持空）  │  flat（無倉位）
─────────────┼────────────────┼─────────────────┼────────────────
aggressive   │  ×1.3 conviction │  ×1.3 conviction  │  ×1.3 conviction
moderate     │  baseline（已校準）│  baseline         │  baseline
conservative │  ×0.7 conviction │  ×0.7 conviction  │  ×0.7 conviction
```

**風險等級對應**（客戶端 `mats_app` `useAutoTrade.ts` `mapRiskProfile()`）：
| 客戶端 UI（SettingsSheet）| 後端矩陣 key | conviction 縮放 | 校準狀態 |
|:-------------------------|:------------|:----------------|:--------|
| `high` | `aggressive` | ×1.3（capped 1.0）| `calibrated: false`（待 owner 定義規則）|
| `mid` | `moderate` | ×1.0（baseline）| `calibrated: true`（live consensus）|
| `low` | `conservative` | ×0.7 | `calibrated: false`（待 owner 定義規則）|

**矩陣格 action**（`mapAction()` 按 rawAction + closePosition + posState 推導）：
| 持倉狀態 │ buy 共識 → │ sell 共識 → │ hold/close → │
|:--------|:-----------|:------------|:-------------|
| `flat` | `buy` | `sell` | `hold` |
| `long` | `hold` | `flip` | `hold`（或 `close` 若 closePosition）|
| `short` | `flip` | `hold` | `hold`（或 `close` 若 closePosition）|

**`moderate` = 已校準 baseline**：使用 live consensus 機制（conviction gate、OLR blend、combo WR override）。`aggressive` / `conservative` 係 placeholder——same action as moderate，conviction 縮放 ×1.3 / ×0.7，`calibrated: false` 直到 owner 定義精確規則。結構設計令規則可以直接 drop into `buildProfileCell()` 唔影響 consensus-mapping 邏輯。

### 寫入路徑（`src/index.ts` ~line 6478）

```
HACP consensus result
  ↓
for each symbol in (activeSymbol ∪ tradingMarkets ∪ pscList):
  ↓
  buildAssetAnalysis(symbol, psc, marketState, cycleId, pwin, agentsAligned, agentsTotal)
    ↓
    mapAction() → per (profile, posState) cell
    buildProfileCell() → conviction 縮放 + calibrated flag
    buildMatrix() → 3×3 AnalysisMatrix
    ↓
    AssetAnalysis { symbol, cycleId, marketData, consensus, matrix, metadata }
  ↓
analysisWriter.writeCycle(analyses[])
  ↓
SupabaseAnalysisWriter：DELETE all rows → INSERT fresh batch（clean-snapshot）
  ↓
asset_analyses 表（RLS：anon 可讀，service_role 寫入）
```

### 客戶端讀取路徑（`mats_app`）

```
useAssetAnalyses(cycleMinutes) → fetchAssetAnalyses() → Supabase asset_analyses
  ↓
useAutoTrade(analyses, settings, user, positions)
  ↓
  mapRiskProfile(settings.riskProfile)  // high→aggressive, mid→moderate, low→conservative
  inferPositionState(symbol, positions) // long/short/flat
  getRecommendedAction(analysis, riskProfile, posState) → matrix[profile][state]
  ↓
  action: buy/sell/hold/close/flip + conviction + rationale
  ↓
  Paper mode → 寫入 Supabase positions 表
  Real mode（Pro + PK）→ 簽名 + 提交 Hyperliquid
```

### Supabase 表結構（`supabase/migrations/00000000000018_asset_analyses_matrix.sql`）

```sql
create table public.asset_analyses (
  symbol      text primary key,           -- 一行一 asset
  cycle_id    bigint not null,
  updated_at  timestamptz not null default now(),
  market_data jsonb not null,  -- { price, volatility, regime, change24h, volume24h }
  consensus   jsonb not null,  -- { action, confidence, thesis, pwin, agentsAligned, agentsTotal, stopLoss, takeProfit, suggestedLeverage }
  matrix      jsonb not null,  -- 3×3: { aggressive|moderate|conservative: { long|short|flat: { action, conviction, rationale, calibrated } } }
  metadata    jsonb not null
);
-- RLS：anon/authenticated 可讀（universal market intelligence）；service_role 寫入
```

---

## 後端帳戶風險設定（v2.0.822+ — Backend Account Risk Profile）

**與客戶端風險等級嘅分別**：呢個係兩個獨立概念。
- **客戶端風險等級**（`mats_app` `TradingSettings.riskProfile`）：控制客戶端讀取矩陣嘅邊一格 + 客戶端執行策略。
- **後端帳戶風險設定**（`MarketAgentConfig.riskProfile`）：控制後端自己交易帳戶嘅 conviction 校準 + Plan G threshold 調整 + Meta-Agent prompt 行為。後端計算所有三個等級嘅矩陣，但佢自己執行交易時用呢個設定。

### 三段式風險等級

| 等級 | UI 顯示 | Threshold 倍率 | Conviction 校準 | 倉位大小傾向 | 平倉敏感度 |
|:-----|:--------|:--------------:|:----------------|:------------|:-----------|
| `aggressive` | Aggr | × 0.85（放鬆） | 不膨脹——gate 自動放鬆 | 偏大（上限） | 較慢（容忍 drawdown） |
| `moderate` | Mode | × 1.00（baseline） | 誠實輸出 | 分析支持嘅大小 | 標準（thesis 失效 + ≥2 條件） |
| `conservative` | Cons | × 1.15（收緊） | 不壓低——gate 自動收緊 | 偏小（留 headroom） | 較快（保護資本優先） |

### 三層執行機制

```
Layer 1: Prompt 層（Meta-Agent system prompt）
  ─ getMarketDescription() 注入 "Risk Profile: AGGRESSIVE/MODERATE/CONSERVATIVE" 行
  ─ 所有 7 個 agent 見到（5 sub-agents + Skeptics + Meta-Agent）
  ─ Meta-Agent system prompt 有完整 RISK PROFILE CALIBRATION 段落：
    • conviction 校準規則（不膨脹/不壓低——gate 調整）
    • position size 傾向（偏大/偏小）
    • entry bias（51% lean 足夠 / 要求清晰主導信號）
    • close sensitivity（較慢/較快）
    • SL/TP（更闊/更緊）
    • anti-pattern 權重（警告/強警告）
  ─ 核心原則：風險等級調整 RISK APPETITE，唔調整 ANALYTICAL RIGOR

Layer 2: Code 層（Plan G conviction gate，src/index.ts ~line 7960）
  ─ adjustedThreshold = clamp(effectiveThreshold × multiplier, 0.30, 0.70)
  ─ aggressive: × 0.85（放鬆——更多交易通過）
  ─ moderate:   × 1.00（baseline）
  ─ conservative: × 1.15（收緊——更少交易通過）
  ─ clamp [0.30, 0.70]：aggressive 唔可以低過 30%（唔會魯莽），conservative 唔可以高過 70%（唔會永久癱瘓）
  ─ 乘法唔加法：與 Plan G 嘅乘法模型一致，唔會重現加法死循環

Layer 3: Multi-symbol 路徑（src/index.ts ~line 7340）
  ─ 同樣嘅 multiplier 應用於 adaptive filter threshold
  ─ pscAdjustedThreshold = clamp(pscFilter.getConvictionThreshold() × multiplier, 0.30, 0.70)
  ─ 確保多符號入場都尊重風險等級
```

### API + 持久化

| 層 | 檔案/位置 | 說明 |
|:---|:---------|:-----|
| Type | `src/types/index.ts` `MarketAgentConfig.riskProfile` | `RiskProfile` type（`aggressive`/`moderate`/`conservative`）|
| Config | `src/market-agent/index.ts` | `setRiskProfile()` / `getRiskProfile()`，預設 `moderate` |
| Persistence | `src/evolution/persistence.ts` | `MarketAgentConfigSnapshot.riskProfile` + save + load（驗證 3 個值）|
| API | `POST /api/market-agent/risk-profile` | `{ profile: 'aggressive'|'moderate'|'conservative' }` |
| Callback | `src/index.ts` `setMarketAgentSetRiskProfileHandler` | `marketAgent.setRiskProfile()` + `pushToAPI()` |
| UI | `ui/src/App.tsx` ~line 1397 | 3-segment slider（Aggr/Mode/Cons）+ `ui/src/types.ts` |
| Agent context | `src/market-agent/index.ts` `getMarketDescription()` | 注入 `Risk Profile:` 行到所有 agent |
| Meta-Agent prompt | `src/agents/meta-agent.ts` `getSystemPrompt()` | `RISK PROFILE CALIBRATION` 段落 |

### 向後兼容

舊 `market-agent-config.json` 冇 `riskProfile` → load 時驗證失敗 → 唔載入 → `getRiskProfile()` 返回 `'moderate'`（安全預設）。唔會 crash，唔會丟失其他設定。

### System Engineer Agent（v2.0.201）

第 9 個 agent — 自主代碼工程師。每 2 個 cycle 運行一次。

### `runSystemEngineer()` 方法（v2.0.201 兩階段審計）

```
┌─────────────────────────────────────────────────────────────────────┐
│  runSystemEngineer(records: ThesisExperienceRecord[])               │
│                                                                     │
│  ┌─ 並發保護 ─────────────────────────────────────────────────────┐ │
│  │ if (engineerRunning) → skip（防止重疊運行）                      │ │
│  │ engineerRunning = true（module-level lock）                      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 載入上下文 ───────────────────────────────────────────────────┐ │
│  │ • SystemEngineer.md（操作手冊，截取前 2000 字）                   │ │
│  │ • ARCHITECTURE.md（系統架構，截取前 2000 字）                     │ │
│  │ • CHANGELOG.md（最近 3 個版本）                                   │ │
│  │ • loop-engineering-memory.md（已知 bug，截取前 1500 字）          │ │
│  │ • 最近 20 筆交易記錄摘要（side/symbol/outcome/pnl/hold/regime/   │ │
│  │   marketFeatures/olrPWin/shadowWinRate/entryThesis）              │ │
│  │ • Per-Symbol Direction Summary（BUY/SELL 各自勝率）               │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ Phase 1: 診斷（Diagnosis）────────────────────────────────────┐ │
│  │ • readFileSummaries()：10 個關鍵文件各取前 50 行 + test 文件列表  │ │
│  │ • LLM 收到：上下文 + 交易摘要 + 文件摘要 + Known Good Code 警告   │ │
│  │ • LLM 回傳 JSON：{ title, rootCause, affectedFile, diagnosis }   │ │
│  │ • 溫度 0.2 · timeout 60s · model = terminal_agent                │ │
│  │ • 無 actionable issue → return null                              │ │
│  │ • 失敗記憶檢查：同 file+title 1 小時內失敗過 → skip              │ │
│  │ • 範圍驗證：isFileAllowed() → 不在 ALLOWED_PREFIXES → REJECT     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ Phase 2: 精確修復（Exact Fix）────────────────────────────────┐ │
│  │ • 讀取目標文件完整內容（全部行數，不截斷）                        │ │
│  │ • LLM 收到：Phase 1 診斷結果 + 完整源代碼                        │ │
│  │ • LLM 回傳 JSON：{ proposedFix: { oldCode, newCode, reason },    │ │
│  │   testUpdate: { file, oldCode, newCode }, changelogEntry }       │ │
│  │ • 溫度 0.1（更精確）· timeout 60s                                │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ oldCode 匹配（三層防幻覺）─────────────────────────────────────┐ │
│  │ 1. 精確匹配：originalContent.includes(oldCode)                   │ │
│  │ 2. 模糊匹配（v2.0.201）：trim + collapse whitespace →            │ │
│  │    逐行 trimmed 比較找到精確位置 → 用文件實際文本替換 oldCode     │ │
│  │ 3. 全部失敗 → 標記 "hallucination detected" → return null        │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 應用修改 ─────────────────────────────────────────────────────┐ │
│  │ • writeFileSync(targetFile, newContent)                          │ │
│  │ • 如有 testUpdate → 同樣精確匹配 + 寫入測試文件                   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 安全網驗證 ───────────────────────────────────────────────────┐ │
│  │ 1. tsc --noEmit（timeout 30s）                                   │ │
│  │    → 失敗：捕獲 stdout/stderr 錯誤輸出（v2.0.199）                │ │
│  │ 2. npm test（timeout 60s，僅在 tsc 通過後運行）                   │ │
│  │    → 解析 vitest 摘要行 "Tests  X passed (Y)"（v2.0.201）         │ │
│  │    → 舊邏輯 !output.includes('failed') 會被 log 警告誤判          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 決策分支 ─────────────────────────────────────────────────────┐ │
│  │ tsc ✓ + test ✓ → SUCCESS:                                       │ │
│  │   • updateChangelog(changelogEntry)                              │ │
│  │   • updateArchitecture(architectureUpdate)（如有）                │ │
│  │   • git add -A && git commit                                     │ │
│  │   • appendRecommendation(result, true)                           │ │
│  │   • process.exit(42) → engineer-loop.sh 重啟進程                  │ │
│  │                                                                   │ │
│  │ tsc ✗ 或 test ✗ → ROLLBACK:                                     │ │
│  │   • 恢復原始文件內容（writeFileSync 原始內容）                     │ │
│  │   • 恢復原始測試文件內容                                          │ │
│  │   • failedFixes.set(key, timestamp) → 1 小時冷卻                 │ │
│  │   • appendRecommendation(result, false)                           │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ 鎖釋放 ───────────────────────────────────────────────────────┐ │
│  │ finally: engineerRunning = false（雙層 try/finally 保證釋放）    │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**關鍵設計決策**：

| 決策 | 原因 |
|:-----|:-----|
| **兩階段而非單階段** | 單階段只展示 150 行/文件，LLM 看不到 line 472 的 `recordClose` → 幻覺 oldCode。Phase 1 用 50 行摘要診斷，Phase 2 發送完整文件生成精確 oldCode |
| **模糊 oldCode 匹配** | LLM 常把縮排/空格弄錯但代碼正確。trim + collapse whitespace 後逐行 trimmed 比較，找到精確位置後用文件實際文本替換 |
| **vitest 摘要行解析** | 舊邏輯 `!output.includes('failed')` 被 log 警告（"digestTrade LLM failed"）誤判為測試失敗。改為解析 `Tests  X passed (Y)` 摘要行 |
| **失敗記憶 1h 冷卻** | 同一 file+title 修復失敗後 1 小時內不重試，避免無限循環 |
| **雙層 try/finally** | 外層 finally 保證 `engineerRunning = false` 即使 `process.exit(42)` 也能釋放鎖 |
| **溫度 Phase 1 = 0.2 / Phase 2 = 0.1** | 診斷需要些許創意，精確修復需要高度確定性 |

**可修改範圍**：`src/evolution/` + `src/cognition/` + `src/analysis/` + `src/agents/` + `tests/`
**禁止修改**：`src/trading/` + `src/config/` + `src/index.ts` + `.env` + `src/api-server.ts` + `src/data/`
**安全網**：tsc --noEmit + npm test 必須全部通過，否則自動 rollback
**模型**：GLM-5.2（預設）
**並發保護**：module-level `engineerRunning` lock，防止重疊運行
**失敗冷卻**：同一修復失敗後 1 小時內不重試（`FAILED_FIX_TTL_MS = 3600_000`）

---

## 智能體系統

| # | Agent | 溫度 | 權重 | 角色描述 |
|:-:|:------|:----:|:----:|:---------|
| 0 | **Terminal Agent** | 0.30 | — | 用戶自然語言偏好入口。接受交易偏好指令 → LLM 整合 → Root Command Prompt。Cycle 開始前檢查規則（時間/條件/資產），不符合即 abort cycle。Meta-Agent 決策後核實是否符合 Root Command Prompt。預設 DeepSeek V4 Flash。**註**：v2.0.822+ 風險等級（high/mid/low）改由客戶端 `mats_app` SettingsSheet 選擇，後端運算所有三個等級嘅矩陣。 |
| 1 | **Trading Setup** | — | — | 交易配置管理（非 LLM agent）。Trade Mode、Cycle Period（1-10m）、Position Size、Max Portion、Leverage、Asset Type、Available Pairs、Selected Market Pairs。UI 控件直接連接後端。 |
| 2 | **Fractal Momentum Sentinel** | 0.85 | 0.10 | 多時間框架碎形自相似模式檢測。趨勢加速早期信號。極端逆向，中間趨勢追隨。預設 Kimi K2.6。 |
| 3 | **On-Chain Whisperer** | 0.50 | 0.10 | 類別感知鏈上分析。Crypto: mempool/flows/supply。TradFi: DXY/COT/商品/COT 持倉。5 分鐘緩存。預設 Kimi K2.6。 |
| 4 | **OLR & Sentiment Analyst** | 0.25 | 0.10 | OLR P(win) per side + First-Passage path-risk + Fear & Greed。RR-aware：P(win) 對 breakevenP 計 edge。PRIMARY factor。預設 Kimi K2.6。 |
| 5 | **News Reporter** | 0.40 | 0.20 | **Institutional Narrative Decoder**。5 部分框架：信息不對稱先驗、價格-新聞時機矩陣、6 桶動機分類、權力圖、淨機構調整信號。L3 Meta-Agent 決定性權重。預設 DeepSeek V4 Flash。 |
| 6 | **Independent Risk Auditor** | 0.10 | 0.25 | **advisory-only（不可 veto）**。TP/SL/size 建議 + 硬性代碼限制。預設 DeepSeek V4 Flash。 |
| 7 | **Skeptics** | 0.30 | 0.00 | 邏輯審計員 + 壓力測試員。**Approve-First**。Phase 1.5 審查 5 sub-agents；Phase 1.8 驗證 entryThesis；Phase 0.5 每循環重新驗證持倉 thesis。預設 DeepSeek V4 Flash。 |
| 8 | **Meta-Agent** | 0.45 | 0.00 | 仲裁主席。偵探模式。生成 entryThesis。使用 Confidence Calibration Framework。權重 0.00（理據系統控制，唔靠投票）。預設 DeepSeek V4 Flash。 |
| 9 | **System Engineer** | 0.20 | — | 自主代碼工程師。每 2 個 cycle 審查交易記錄 + 源代碼，檢測學習系統漏洞，自動修復並通過 tsc+test 安全網。v2.0.201 兩階段審計：Phase 1 診斷（文件摘要 50 行 + 交易數據 → LLM 識別 file+issue），Phase 2 精確修復（完整文件內容 → LLM 生成 exact oldCode/newCode）。模糊 oldCode 匹配（trim + collapse whitespace）。vitest 摘要行解析測試結果。讀取 SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md。可修改 src/evolution/ + src/cognition/ + src/analysis/ + src/agents/ + tests/。禁止觸碰 src/trading/ + src/config/。預設 GLM-5.2。 |

> **權重說明**：Meta-Agent + Skeptics 權重 0.00 — 佢哋透過 thesis 系統控制決策，唔參與投票。5 個 sub-agent 加權投票，consensus threshold 50%（由 Evolution 動態調整，floor 0.49）。Terminal Agent 不參與投票，只做規則檢查 + 決策核實。System Engineer 不參與投票，只做代碼審查 + 自主修復。Trading Setup 不是 LLM agent，是 UI 配置管理。

---

## HACP 高速認知協議

每 **1-10 分鐘**（用戶可調整 Cycle Period）觸發一次決策循環。

```
PHASE -1  Terminal Agent 規則檢查（Cycle 開始前）
          • 載入 Root Command Prompt → 逐條評估規則（時間/條件/資產/方向）
          • 任一規則失敗 → abort cycle（不跑任何 agent，不花 token）
          • 全部通過 → 注入 Root Command Prompt directive 到所有 agent context
PHASE 0   Trading Setup 市場選擇 + Position Reconciliation
          • 選取最高 volume pair · real mode 同步 exchange 倉位
PHASE 0.5 Skeptics 入場理據重新驗證（每個持倉）
          • thesis 失效 → 強制平倉
PHASE 1   平行思考（5 sub-agents, 60s deadline race, staggered 6s）
          • 每個 agent 收到 Root Command Prompt directive（行為約束 + 風格調整）
PHASE 1.5 Skeptics 邏輯審查（逐一審查 5 sub-agent 決策）
          • 參考每個 Agent 歷史 track record · Approve-First
PHASE 1.75 Meta-Agent 仲裁
          • 生成 entryThesis / holdReason / closePosition
          • 接收 RIL reference data
          • 使用 Confidence Calibration Framework
PHASE 1.8 Skeptics 驗證 Meta-Agent entryThesis
          • 拒絕即 HOLD
PHASE 2-4 結構化辯論（1-3 rounds，unanimous 可跳過）
PHASE 5   加權投票共識（50% threshold，動態調整）+ 執行
PHASE 6   Terminal Agent 決策核實（Meta-Agent 決策後）
          • 核實決策是否符合 Root Command Prompt 要求
          • 核實是否符合用戶指定的交易風格
          • 不符合 → 覆蓋為 HOLD（不執行）
```

**Terminal Agent 雙重角色**：
1. **Cycle 前置**（Phase -1）：檢查 Root Command Prompt 規則，不符合 abort
2. **Cycle 後置**（Phase 6）：核實 Meta-Agent 決策是否符合用戶偏好

**Root Command Prompt**：用戶透過 Terminal Agent UI 輸入自然語言交易偏好，LLM（DeepSeek V4 Flash）整合成結構化指令。只接受行為指令（決策風格、交易偏好、時間規則），不接受 config 設定（position size、leverage 等由 Trading Setup 管理）。

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
    → v2.0.143：recordClose 後即時 addTrade() 更新 cluster（之前只在 startup rebuild）
  ─ CloseReasonAggregator：pure math GROUP BY exitType+origin
    → 每個 close reason 嘅 WR/PnL/count，injected 做 CLOSE REASON PERFORMANCE
    → v2.0.143：使用真實 exitType（sl_tp/consensus/manual/thesis_invalidation）而非 'unknown'
  ─ SimilarTradeRetriever：top-N similar trade retrieval by combination similarity
    → v2.0.143：在 EXP gate 後、Skeptics 驗證前注入 candidate 的相似歷史交易
  ─ SubtleDiffAnalyzer：1 LLM call per cycle for subtle differences analysis
    → v2.0.143：比較候選交易 vs 相似歷史贏家/輸家嘅微妙差異（volume/RSI/regime/S/R）

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

MATS 嘅核心競爭力係**認知演化管線**（v2.0.836: 23→15 active + 1 Edge Validation + 1 Q-RL Alpha Discovery + 1 DCS v2 Risk Profile Differentiation）——每筆交易結果都會餵回學習系統，系統唔係固定規則，而係一個會進化嘅認知引擎。v2.0.833 移除咗 4 個 0-inference 組件（temporal-attention / cross-symbol / reward-shaping / world-model）同暫停 active-exploration。v2.0.835 新增 Q-RL Alpha Discovery（首個可以發現新 alpha 嘅組件）+ Factor-Tagged Aligned Shadow。v2.0.836 新增 DCS v2 風險等級區別化（三個 profile 真正唔同決策——唔止 conviction 數字唔同，而係 entry acceptance、SL/TP 闊度、position size 都唔同）。以下逐層詳述：

### OLR — Online Logistic Regression（`olr-engine.ts`）

Per-symbol, per-side online logistic regression 從 shadow + paper + real + backfill 嘅 TP-before-SL 結果學習 P(win)。每個 feature 獨立計數，缺失 feature 返回中性 z=0。Source-weighted SGD updates（real=4, paper=2, shadow=1, backfill=0.3）。Confidence: high(≥50) / medium(≥20) / low(<20) samples。

**v2.0.143 來源追蹤**：每個 OLR model 記錄 `shadowSamples` / `paperSamples` / `realSamples` 三個獨立計數器。Agent context 顯示數據構成：`BUY P(win)=60% (30 samples, medium | shadow=15 paper=10 real=5)`。如果 model 主要由 shadow samples 訓練（固定 SL/TP），agent 可降低信任度。

### Shadow Trading（`shadow-trade-engine.ts`）

每個 cycle 為每個 trading market 開模擬 LONG + SHORT，S/R-aligned SL/TP。Intra-cycle high/low 追蹤（正確判定 TP-before-SL）。學 TP-before-SL（真實可盈利性），唔係 5 分鐘價格方向。

**完整結構（v2.0.855-audit）**：

| 元件 | 位置 | 作用 |
|:-----|:-----|:-----|
| `ShadowPosition` | interface | `side` / `entryPrice` / `stopLossPrice` / `takeProfitPrice` / `highSinceOpen` / `lowSinceOpen` / `mfePct` / `maePct` / `shadowType` / `factorTag` |
| `SHADOW_CONFIG` | constant | `maxOpenPerSymbol=10` / `maxTotalOpen=60` / `maxAgeCycles=12`(60min force-resolve) / `staleLearningWeight=0.3` |
| `openShadowTrades()` | blind | 每 cycle 為每個 trading market 開 LONG+SHORT 兩邊（cold-start prior，OLR weight 0.1×） |
| `openAlignedShadow()` | aligned | 跟 LLM 共識方向 + factor tag（v2.0.834）。v2.0.855：real-trade cycles 都開（counterfactual） |
| `openStatisticalShadow()` | statistical | 純統計方向（OLR+Combo WR+Causal），同 LLM 對照（v2.0.846 A/B） |
| `checkPositions()` | resolution | 用 `highSinceOpen`/`lowSinceOpen` 判定 SL/TP 命中（path-based，唔係 close price）→ feed OLR |
| `drainRecentResults()` | 學習出口 | index.ts 每次 cycle drain，feed OLR + Q-RL + MetaLearner + CausalReasoner |
| `pruneStaleSymbols()` | 維護 | 清理已移除 symbol 嘅 stale positions |

**index.ts 整合點（v2.0.855-audit）**：`checkPositions` 喺 active symbol + 每個 trading market 都跑（line ~6029/6049）；`drainRecentResults` 每 cycle feed 去 OLR/Q-RL（line ~6071）；shadow 開倉喺 multi-symbol loop（line ~6289）。**Shadow → OLR → Q-RL 係完整學習管道**。

**v2.0.143 改進**：
- **MAE/MFE path-risk 追蹤**：每筆 shadow trade 記錄 Maximum Adverse/Favorable Excursion。Agent context 顯示 `avg MFE=3.2% avg MAE=1.8%`，讓 agent 看到「trades 平均先賺 3% 再虧到 SL」= 方向對但 exit timing 有問題。
- **Per-symbol funding rate**：非 active symbol 不再用 active symbol 的 funding rate，改用 per-symbol HL WS mark price cache。
- **Shadow soft gate**：當 shadow samples ≥ 10 且 win rate < 25%，override 為 HOLD（方向根本性錯誤）。
- **OLR 來源標記**：shadow outcomes 餵入 OLR 時標記 `source='shadow'`，不再與 paper/real 混在一起無法區分。

**現有 A/B 基礎（可擴展做退出策略驗證）**：`shadowType: 'blind' | 'aligned' | 'statistical'` 已經係天然嘅 A/B 分組機制——同一市況開唔同策略嘅 shadow，比較 outcome。**退出策略 A/B（standard vs trailing）可以完全複用呢個機制**：喺 `ShadowPosition` 加 `exitStrategy` 字段，`checkPositions()` 按策略分支。

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

### Numeric Autoencoder（`numeric-autoencoder.ts`，v2.0.204+v2.0.222+v2.0.223）

純 TypeScript MLP（11→16→8 encoder + 8→16→11 decoder），學習 market-condition 嘅非線性 representation。Reconstruction loss + contrastive loss（同 outcome 拉近/唔同推開）+ diversity penalty。Adam optimizer（自實現）+ gradient clip + weight clip + LR decay + seeded RNG + replay buffer + time-weighted sampling（v2.0.205, 30-day half-life）。

**v2.0.222：Replay 持久化**。Replay buffer 存入 `NAModelState`，重啟後 `restoreReplay()` 處理腐敗/NaN/截斷等 edge cases，即時 re-validate。

**v2.0.223：訓練品質修復（4 個盲點）**。(1) Diversity collapse symmetry trap — variance-from-mean 梯度喺塌縮時=0，改用 pairwise repulsion + margin。(2) 線性層零初始化 → bottleneck 死亡，改用 small He init。(3) diversityLossWeight 0.01→0.1。(4) Validation thresholds 放寬：mse<1.5, acc≥55%。Backfill 後 trainEpochs(50) + early stop。

**冷啟動 → 學習切換**：sampleCount < 50 → min-max fallback；50-200 → 訓練中仍用 min-max；≥200 + validation pass（MSE<1.5, acc>55%, diversity>0.01）→ `isReady()=true` → learned 8-d cosine 取代 min-max。

**整合**：`computeVectorConditionalWinRate` 嘅 `embeddingProvider` option；`trade-pattern-classifier.ts` `computeSimilarity`；`cycle-summary.ts` dual-channel retrieval；`agent-evolution.ts` agent 權重。

### AttnRes Cycle-History Retrieval（`cycle-history-retrieval.ts`，v2.0.211-v2.0.212）

Kimi K3 Attention Residuals transfer（arXiv 2603.15031）。K3 layer-depth ≡ MATS cycle-history depth。

**核心**：conditional WR 嘅 candidate 從 current snapshot 變成 **softmax-weighted blend over cycle history + entry-time state**。Entry-time regime 持續保留權重（K3 embedding persistence — Fig 8）。

**Block AttnRes（#2）**：80-cycle history → 8 blocks of 10 cycles。Intra-block mean，inter-block softmax attention over block summaries + entry state。Memory O(80d)→O(8d)。

**RMSNorm keys（#3）**+ per-feature Welford z-score：解決 feature-scale collapse（srDistanceBps 50-900 vs volatility 0.1-0.8）。Competition on direction not magnitude。

**Softmax mixture（#4）**：win rate = Σ softmax(sim/τ)·[win]。High-similarity records weight more（K3: softmax > sigmoid）。

**Online learning**：reward-weighted key direction（Peters & Schaal 2008），NOT REINFORCE（後者喺 deterministic softmax blend 係 identically zero）。Fixed recency prior 打破 uniform-policy deadlock。

**#7 Pre-Decision vs Pre-Execution Specialization（v2.0.212）**：兩個 pseudo-query：
- **wDecision**（broad, base recency 0.5）→ conditional WR + Meta-Agent thesis。Reward = PnL。
- **wExecution**（sharp, recency × 2.0 = 1.0）→ SL/TP survival context。Reward = SL/TP 放置質量（SL hit → 負，TP hit → 正，僅 closeReason='sl_tp'）。
- Execution-lens block 注入 Skeptics context，顯示 recent regime through SL/TP survival lens。
- 冷啟動：兩個 w 都 zero-init → 分別用 recency prior 產生 broad vs sharp blend。Selectivity 係 EARNED through outcomes。

**攻擊測試**：21 tests（Q7.1-Q7.5：numerical/state/cold-start/concurrency/injection）全通過。4 個實施時發現嘅漏洞已修復（REINFORCE deadlock → recency prior；feature-scale collapse → z-score；block-mean smoothing → block size = regime timescale；null injection → explicit guard）。

### Anti-Pattern Tracker（`anti-pattern-tracker.ts`，v2.0.207 #F）

聚類失敗 LessonStatement（cosine 0.78, min 2 members）。`matchCandidate(thesis)` 返回 matching classes + count + avgPnl。Skeptics 見到 "你咁樣輸過 N 次，avg -X%"。持久化到 `anti-patterns.json`。

### Conditional WR Soft Gate（`index.ts`，v2.0.209）

Code-level conviction penalty：condWR < 20% → +35% conviction penalty；< 30% → +25%；< 40% → +15%。使用 AttnRes h_blend + NA embedding + RMSNorm keys + softmax mixture。minSamples=5 guard。軟門控（懲罰，永不 hard block）。

### Combo WR Gate（`index.ts`，v2.0.221）

三層 soft gate 疊加：`netPenalty = lossPenalty + condPenalty + comboPenalty`。ComboWinRateTracker 追蹤 (symbol × side × regime) 組合 WR，Wilson score lower bound 信心。WR<25% & n≥5 → 0.50 penalty；< 35% → 0.30；< 45% → 0.15。注入 Meta-Agent marketDesc PRE-thesis。永不 hard block。

### OLR P(win) × Consensus Confidence Multiplicative Discount（`index.ts`，v2.0.224）

**偵測→實施斷裂修復**。v2.0.224 之前：OLR 正確偵測到 29% P(win)，但信念懲罰只加高門檻（additive 50%→85%），90% agent 共識仍可跨過 → 仍然交易。修復後 OLR P(win) 直接折扣共識 confidence（multiplicative）：

```
effectiveConfidence = consensusConfidence × blendFactor
blendFactor = pwinFloor + (1 - pwinFloor) × P(win)   // OLR has data
blendFactor = 1.0                                     // cold-start
pwinFloor = 0.3
```

P(win)=29% × 90%共識 = 45% < 85% → HOLD ✓。雙重防禦：加法（加高門檻 catch 中等過度自信）+ 乘法（折扣 confidence catch 極端過度自信）。冷啟動安全：OLR confidence='low' 或 nSamples<10 → blendFactor=1.0（唔折扣）。

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

**TP/SL 設定於入場時，入場後永不修改（v2.0.225）**：入場後不再收窄。Trailing stop、MFE giveback、TP narrowing、per-symbol consensus SL/TP 全部停用——入場後收窄導致提前止蝕 + UI/交易所 SL desync。兩層退出保護：(1) 初始 SL/TP 交易所層面觸發，(2) LLM thesis invalidation（Skeptics Phase 0.5 強制平倉）。Portfolio 安全層：no-widen + not-too-tight（SL ≥ 1%, TP ≥ 1.5%）+ min-gap 2%。

**Smart SL/TP（v2.0.832）**：機構級 SL/TP 計算——優先級：S/R zones → 50-candle 頂底 → ATR floor。`computeSmartSLTP()`（`src/analysis/smart-sltp.ts`）取代舊嘅 ATR-first 邏輯。

```
SL 優先級：                          TP 優先級：
1. S/R support zone（最精準）         1. S/R resistance zone（最精準）
2. 50-candle ATL（次精準）            2. 50-candle ATH（次精準）
3. 1.5×ATR（fallback）               3. config default（fallback）
4. config default（最後）             4. config default（最後）

ATR 只用嚟防止 SL 太窄（SL ≥ 1.5×ATR），唔用嚟推 TP。
唔強制 R:R——如果 TP 近過 SL，照設。賺少都係賺。
S/R buffer 按強度加權：strong 0.2%, moderate 0.3%, weak 0.5%。
Per-profile caps（v2.0.836）：aggressive SL 7% / TP 15% / TP min 0.5%；
moderate SL 5% / TP 10% / TP min 0.3%；conservative SL 3% / TP 6% / TP min 0.2%。
```

**Leverage-Aware SL Floor（v2.0.852 fix #A）**：結構性 S/R SL 可以好貼 entry（例如 0.81%）。喺 10x 倉位，0.81% 逆向價格移動會抹走 ~8% margin——正常噪音就可以喺 thesis 兌現前止蝕（SILVER SELL 缺陷：entry $56.82, SL $57.28 = +0.81%，被例行噪音止蝕）。`computeSmartSLTP` 依家接受 `leverage` 參數，將 MINIMUM SL 距離按槓桿放大：`levFactor = 1.0 + (leverage - 1) × 0.15`（1x→1.0, 5x→1.6, 10x→2.35, 20x→3.85），`levFloorPct = min(0.05, max(slFloorPct, 0.01 × levFactor))`。只係 FLOOR——永遠唔會收窄結構性 SL，下游 momentum/exec-lens widening 仍然疊加。槓桿 clamp [1, 50]。

**MFE-Calibrated TP/SL（v2.0.852 fix #D）**：`computeSmartSLTP` 接受 `mfeCalibration`（由 `src/analysis/mfe-calibrator.ts` 從真實 1h/5m 蠟燭分佈計算，免疫被污染嘅 TradeRecord.MFE 欄位）：
1. TP target ← 中位數有利 1h extension ×0.8（現實盈利目標，唔係觸及唔到嘅 5× MFE）。只喺結構性 S/R TP 瞄得太遠時收窄（「TP 設太遠 → giveback」失敗）。
2. TP cap ← 90th-percentile extension（數據驅動上限，取代固定 10% 上限——只喺數據話價格好少行得更遠時生效；固定 cap 仍然係絕對 backstop）。
3. SL floor ← 95th-percentile adverse 5m excursion（噪音 floor，高槓桿倉位唔會被例行噪音止蝕）。
方向感知：BUY 用 `tpTargetLongPct`/`tpCapLongPct`/`slFloorLongPct`；SELL 用 `*ShortPct`。全部係 FLOOR/CEILING——唔會移除結構性 S/R 放置，只修正過度樂觀/過度緊嘅值。Caller 提供嘅值 clamp 到 sane bounds（tpTarget ∈ [0.003, 0.20], tpCap ∈ [0.005, 0.30], slFloor ∈ [0.005, 0.15]）。TP 永遠唔可以 cross SL（R:R ≥ 0，v2.0.852 attack fix #4）。

**Momentum + Execution-Lens + Confidence SL Widening（v2.0.849）**：呢啲保護原本只喺 dead code `computeATRSLTP`（trading-manager 從未 call），而家移植到 live `computeSmartSLTP`：

```
兩階段 pipeline（v2.0.849-fix）：
1. Confidence 設定 BASE ATR floor 乘數：
   P(win) > 0.8 → 2.5×ATR；< 0.5 → 1.2×ATR；否則 1.5×ATR
2. Momentum + Execution-Lens 之後作為無條件 hard floor（Math.max）：
   - Raw adverse momentum floor（v2.0.207 #C）：SL ≥ 2.5×adverseMomentum
   - Execution-lens adverse momentum（v2.0.213 #7）：stop-out-trained
   - Execution-lens vol scaling：vol > 1.5× implied → 加寬最多 +40%
   - High-entropy dampening：唔確定 lens → 收窄 50%
   所有 widening 都係 FLOOR（唔會窄過 ATR floor），再由 per-profile caps 封頂
   （aggressive 7% / moderate 5% / conservative 3%）
```

**語義不變式**（v2.0.849-fix）：低信心（P<0.5）淨係收窄 BASE ATR 乘數，**唔會剝奪** momentum/exec-lens 保護。BUY side momentum 方向已修正（`BUY adverse = max(0, -momentum)`，`SELL adverse = max(0, +momentum)`），OLR P(win) confidence 由 entryData payload 讀取（唔係 decision object）。

**累計 Margin 上限 20%**：所有持倉 margin 總和 ≤ 20% balance（基於 margin 而非 notional）。

---

## Entry-Time Data Pipeline（v2.0.819）

**核心洞察**：所有學習系統（OLR / EXP / Pattern Classifier / RIL / AttnRes）需要入場時嘅真實 market features + OLR P(win) + shadow WR，而唔係 close 時 recompute。v2.0.777-818 嘅 12 次 patch 嘗試全部失敗，根因係 `closePosition()` / `closeExchangePosition()` 重建 closed TradeRecord 時 **冇 copy** position 上面嘅 `entryMarketFeatures` / `entryOlrPWin` / `entryShadowWinRate` / `regime`——patch 設喺 position 上但 close 時靜默丟棄，導致 100% real trade 顯示 NO_OLR / NO_SHADOW / NO_MARKET_DATA。

**修復**：
- `Position` + `TradeRecord` interface 正式宣告 `entryMarketFeatures` / `entryOlrPWin` / `entryShadowWinRate` / `regime`（取代 `PatchedTradeRecord` duck-typing）。
- `openPosition(order, entryPrice, leverage, entryThesis, entryData?)` 同 `importExchangePosition(..., entryData?)` 喺 construction 時同步設定（Position object literal）。
- `closePosition` / `closeExchangePosition` 喺 closed TradeRecord **copy** 呢四個 field。
- `entryData` 由 `executeTrade` 從 precomputed features map 構建，threading through `paperEngine.executeDecision` → `executeOrder` → `openPosition`，同 `tradingManager.executeDecision` → `importExchangePosition`。
- Fallback `injectPrecomputedEntryFeatures` 保留 for sync/reimport 路徑，而家佢嘅 patch 亦會 flow through 到 TradeRecord。

## Close-Context-Aware Learning（v2.0.226）

**核心洞察**：點樣平倉 / 用乜嘢形式平倉係蝕錢嘅重要因素。之前所有學習系統只收到 binary win/loss，冇概念知道點解蝕。Tight-SL loss（SL 被 trailing stop 收窄後被正常波動觸發）被當成「呢個情況入市=蝕」，污染 OLR / AttnRes / Combo WR / Anti-Pattern。

**`computeLearningWeight(closeReason, slNarrowed, isWin)`** — 純函數，按平倉 context 計算學習權重 [0.3, 1.0]：

| 平倉情況 | 權重 | 原因 |
|:---------|:----:|:-----|
| 贏（任何方式） | 1.0 | 市場確認咗入場論點，正面信號唔應折扣 |
| SL 觸發 @ 原始闊 SL | 1.0 | 真正嘅市場 loss — 價格真正逆向論點 |
| SL 觸發 @ 被收窄 SL | 0.3 | 執行 loss — 入場可能冇問題，SL 太緊 |
| Thesis 無效 | 0.3 | 系統 LLM 決定，唔係純市場信號 |
| 手動平倉 | 0.5 | 用戶決定，部分市場信號 |
| 共識平倉 | 0.5 | Agent 投票，部分信號 |
| Reconciliation / Exchange closed | 1.0 | 極端市場事件 |

**TradeRecord 捕捉平倉 context**：`originalStopLossPrice`（入場時 SL）+ `finalStopLossPrice`（平倉時 SL）+ `slNarrowed`（兩者唔同=true）。兩條 close path（paper `closePosition` + real `closeExchangePosition`）都從 position 捕捉。

**OLR `feedTrade` 加權**：第 7 參 `slNarrowed` + 第 9 參 `weightMultiplier` 正確傳入。`srcWeight = sourceWeight × weightMultiplier`，梯度更新按權重縮放。Tight-SL loss 只貢獻 30% 梯度。

**Combo WR 跳過執行 loss**：`comboTracker.trackTrade()` 只喺 `isWin || learningWeight ≥ 0.5` 時調用。Tight-SL loss + thesis invalidation loss（weight=0.3）被排除，唔拖低 (symbol×side×regime) 嘅 combo WR。

**Advanced learning PnL 縮放**：`feedAdvancedLearning` 嘅 `pnl` + `pnlPct` 乘以 `learningWeight`。AttnRes reward-weighted regression 按 weight 學習。（v2.0.833: temporal attention / cross-symbol / world model 已移除，`feedAdvancedLearning` 而家只 feed replay buffer。）

## TradeRecord.closeReason 資料完整性（v2.0.851）

**背景**：v2.0.226 嘅 `computeLearningWeight(closeReason, ...)` 一直依賴 `trade.closeReason`，但 v2.0.851 之前每個 closed trade 持久化後 `closeReason` 都係 `undefined` — 三個環節斷裂：
1. `closePosition` / `closeExchangePosition` 建立 TradeRecord 時冇設 `closeReason`。
2. `onPositionClosedLearning` 計算咗本地 `closeReason` 但冇寫返 trade。
3. `savePortfolio` + restore path 序列化時冇存 `closeReason`/`exitType`。

**結果**：RIL CloseReasonAggregator、trade-audit、`computeLearningWeight` 全部睇到 `closeReason=undefined` → 每個平倉都 fallback 做 `'sl_tp'`。Tight-SL loss 被當 full-weight（應 0.3×），「premature SL」warning 永遠唔觸發，分唔到「SL 太緊」定「thesis 錯」。

**`inferCloseReason(side, exitPrice, stopLoss, takeProfit)`**（`portfolio.ts`）— 確定性推斷：
- exit 觸及/越過 SL 或 TP → `'sl_tp'`
- exit 喺 SL/TP 之間 或 冇設 SL/TP → `'reconciliation'`
- 非 finite exitPrice（NaN/Infinity/≤0）→ `'reconciliation'`（數據錯誤，唔應分類為 sl_tp）
- null/NaN/0 嘅 SL/TP 當無設

**完整數據流**：
```
closePosition / closeExchangePosition
  → inferCloseReason() 推斷 或 caller 顯式傳入（consensus/manual/reconciliation/thesis_invalidation）
  → trade.closeReason 設好
  → onPositionClosedLearning 寫回（thesis_invalidation override）
  → savePortfolio 持久化 closeReason + exitType
  → 重啟後 restore 還原
```

**Agent-driven close 顯式標記**（`index.ts`）：consensus close / per-symbol flip / active-symbol flip / legacy agent-vote 全部傳 `'consensus'`；manual close / close-all / manual flip 傳 `'manual'`；reconciliation close 傳 `'reconciliation'`。SL/TP 自動平倉傳 `'sl_tp'`。Thesis-invalidation 由 `thesisInvalidatedCloseSymbols` set 喺 `onPositionClosedLearning` override。

## closeTrade dual-mode guard + fill-price accuracy（v2.0.853）

**v2.0.853-fix1**：`closeTrade()` 嘅 analysis-mode guard 缺少 `!this.dualMode` 檢查。`ANALYSIS_MODE='dual'`（生產預設）時 `analysisMode=true` → `closeTrade()` 靜默返回 `true` 而唔平倉。所有平倉路徑（SL/TP、consensus、thesis-invalidation、manual、flip）全部斷裂。修復：加 `&& !this.dualMode`，與 `executeTrade()` 嘅 guard 一致。

**v2.0.853-fix2**：3 個 `closeTrade()` call site 缺少顯式 `closeReason`：close-all（Trade Mode 切換前）→ `'manual'`；manual flip（UI）→ `'manual'`；reconciliation close → `'reconciliation'`。同 v2.0.851-fix 同類 bug。

**v2.0.853-fix3+fix4**：`tradingManager.closePosition()` 用 `pos.currentPrice`（滯後 WS 價格）作為 `exitPrice`，傳 `undefined` 作為 `hlRealizedPnl`。修復：平倉後從 `getRecentFills()` 揾到實際成交 fill，用 `fill.price` + `fill.closedPnl`。Retry 2 次 × 500ms + `clearCaches()` bust fills cache。Fill fetch 失敗時 fallback 到 `pos.currentPrice`（同 pre-fix 行為一致）。

**v2.0.853-fix5**：UI SSE 重連加指數退避（2s → 4s → 8s → 15s capped），`ollama-plan` fetch 加 `res.ok` guard，`all-symbols` useEffect 加 `data` gate + dedup ref。防止後端 down 時 ECONNRESET/ECONNREFUSED spam。

**v2.0.853-fix6**：Fill-fetch retry 從 3×1s=3s 減到 2×500ms=1s，避免阻塞 decision cycle（阻塞期間其他倉位嘅 SL/TP 唔被監控）。

**v2.0.853-fix7**：`closeTrade()` 用 `symbol.includes(':') ? symbol : symbol.toLowerCase()` 而唔係 `normalizeSymbol()`。對於大寫前綴嘅 colon symbol（例如 `XYZ:SKHX`），返回原始 symbol 而唔係 normalized form（`xyz:SKHX`）。雖然所有下游方法都 call `normalizeSymbol` 所以唔會 crash，但 log 顯示唔一致嘅 symbol casing，且如果下游方法將來唔再 call `normalizeSymbol` 就會出 bug。修復：改用 `normalizeSymbol(symbol)`。

---

## Architecture 藍圖審計 — 5 個 loss/crash 向量修復（v2.0.854）

對照 ARCHITECTURE.md 藍圖與實際代碼嘅對抗審計，搵到並修復 **5 個真實生產 bug**（2 個 memory leak、2 個金融指標扭曲、1 個 garbage-order 向量）：

**v2.0.854-fix1：`computeSmartSLTP` 嘅 `safeDcs` 冇 clamp 到 [0,1]**（`smart-sltp.ts`）。舊代碼只 check `>= 0`，未 check `<= 1`。Untrusted DCS=5 → `slMultiplier=2.5`、`tpMultiplier=3.5`，喺 cap-clamping 前已經扭曲 SL/TP。`dcs-calculator.ts` 同 `analysis-matrix.ts` 都 clamp，呢個係不一致嗰個。修復：`safeDcs = Math.min(1, Math.max(0, safeDcs))`。

**v2.0.854-fix2：`recentlyClosedSyms` dedup map 無界 memory leak**（`portfolio.ts`）。Entry 只喺 `importExchangePosition`（dedup-bypass）時移除。長期運行每 `(symbol:entryPrice)` 累積一條。更嚴重：close 爆發時全部 key 都「fresh」，淨靠 expiry purge 永遠唔觸發。修復：size > 512 時 (a) purge 過期 key + (b) FIFO 逐出最舊——硬 bound。

**v2.0.854-fix3：`perSymbolIdleCycles` map 無界增長**（`dynamic-threshold.ts`）。Symbol 透過 `incrementIdleCycles(allKnownSymbols)` 加入但永不逐出。修復：idle 超過 `2 × PENALTY_DECAY_CYCLES`（60）就逐出——此時 penalty 已完全衰減，返回時喺 global-idle fallback 重新註冊。

**v2.0.854-fix4：real 倉位 `pnlPct` 用 full notional 而唔係 margin**（`portfolio.ts`）。`closeExchangePosition` 用 `margin = entryPrice × quantity`（冇 `/leverage`），而 `closePosition`（paper）同 `recalculateEquity` 用 `notional / lev`。10x real 倉位顯示 1/10 真實 margin return——令 consume `pnlPct` 嘅 OLR/EXP/RIL 低估 real-trade edge。修復：`margin = (entryPrice × quantity) / leverage`。

**v2.0.854-fix5：real-trade entry-price guard 漏咗 NaN/Infinity + position delete 用 raw symbol**（`trading-manager.ts` + `portfolio.ts`）。(A) `executeTrade` 嘅 `price <= 0` guard 對 NaN 失效（`NaN <= 0` = false）→ 腐敗 entry price 產生 `quantity=NaN` 到達交易所。修復：`!Number.isFinite(price) || price <= 0`。(B) `closePosition`/`closeExchangePosition` 用 raw `symbol` delete，而 position 存喺 `normalizeSymbol` 下——casing mismatch 留 ghost position + 重複 PnL。修復：三個 close path 都用 normalized symbol delete。(C) exchange fill price 可 NaN/0 → garbage SL/TP。修復：非 finite/≤0 時 fallback 已驗證 decision price，leverage clamp [1,50]。

**Attack tests**：`tests/v2.0.854-architecture-audit-fix.test.ts`（13 tests）——DCS clamp（dcs=5 ≡ dcs=1、負→0、NaN→0）、per-symbol eviction + 近期交易唔逐出、NaN/Infinity entry 拒絕、raw-casing caller 都正常 close、margin 上嘅 leveraged pnlPct、dedup map bounded ≤512。Regression：相關套件 111/111 通過，`tsc --noEmit` 零錯誤。

---

## Leverage division-by-zero + safeLeverage hardening（v2.0.854-attack — CRITICAL）

對 v2.0.854 修復嘅對抗攻擊搵到一個 **critical 資金污染 bug**——正正喺啱啱改嘅 code 度，加上成個系統性 division-by-zero 隱患。

### ATTACK-fix1：`leverage=0` / NaN → Infinity balance 永久污染（CRITICAL）

**漏洞**：`openPosition` 做 `margin = notional / leverage` 完全冇 guard。Caller 傳 `leverage=0` → `margin = notional/0 = Infinity` → `balance -= Infinity = -Infinity`，paper balance 永久損毀。同一類 bug 散佈喺 `closeExchangePosition`（v2.0.854-fix4）、`recomputePnL`、`trackMAEMFE`、`recalculateEquity`、`trading-manager` margin check、`hyperliquid-engine`——全部都做 `/ (leverage ?? 1)`，而 `0 ?? 1 === 0`（所以 `?? 1` fallback **永遠唔會 catch `0`**）。

**關鍵洞察**：`(x ?? 1)` 唔係 NaN/zero guard！佢只 catch `undefined`/`null`。`0 ?? 1 = 0`、`NaN ?? 1 = NaN`——啱啱係會搞壞 division 嘅值。

**修復**：新增 `safeLeverage()`（`position-utils.ts`），reject `0`、`NaN`、`Infinity`、負數、`>50`、非 number → fallback `1`。喺**存儲點**（`openPosition` + `importExchangePosition`）應用令所有下游自動安全，再加埋直接 call site：`closePosition`、`closeExchangePosition`、`recomputePnL`、`trackMAEMFE`、`recalculateEquity`、`trading-manager` margin cap check、`hyperliquid-engine`、4 個 `index.ts` margin calc。

### 防禦原則

```
margin = notional / safeLeverage(leverage)   // 永遠
never:   margin = notional / leverage         // 可 Infinity/NaN
never:   margin = notional / (leverage ?? 1)  // ?? 只 catch undefined/null，唔 catch 0/NaN
```

### 驗證（26 tests）

| 向量 | 結果 |
|:------|:------|
| `leverage=0` openPosition | ✅ balance 保持 finite（原本 `-Infinity`） |
| `leverage=0` closeExchangePosition | ✅ pnlPct finite（原本 Infinity） |
| `leverage=NaN/Infinity/負/>50` | ✅ → 1 |
| `leverage` Proxy getter-bomb | ✅ → 1，冇 throw |
| `leverage` string type | ✅ reject → 1 |
| DCS Proxy getter-bomb / `-0` / `"5"` | ✅ 正確 clamp |
| 1000 distinct symbol close | ✅ dedup map ≤512 |
| per-symbol idle eviction（1000 symbols）| ✅ 正確逐出 |
| raw-casing closePosition delete | ✅ 冇 ghost position |

**Tests**：`tests/v2.0.854-architecture-fix-attack.test.ts`（26 tests）+ `tests/v2.0.854-architecture-audit-fix.test.ts`（13 tests）。Regression：169 相關測試通過。`tsc --noEmit` 零錯誤。

---

## recomputePnL / trackMAEMFE / computeSLTP / recalculateEquity NaN 防禦（v2.0.854-attack3）

對 v2.0.854-attack2 嘅對抗攻擊搵到共享 helper 冇 defense-in-depth——`updatePosition`/`softUpdatePosition` 有 guard，但 helper 本身接受 NaN/Infinity/0/negative。

**ATTACK3-fix1：`recomputePnL` NaN currentPrice → NaN equity（CRITICAL）**。`recomputePnL(pos, NaN)` → `unrealizedPnl = NaN` → `recalculateEquity` 加 NaN → `totalEquity = NaN` → 整個 portfolio 崩潰。修復：`recomputePnL` 用 `safePrice(currentPrice)` sanitize。

**ATTACK3-fix2：`trackMAEMFE` NaN unrealizedPnl → NaN MAE/MFE**。腐敗 restore 載入 NaN `unrealizedPnl` → `posValue = NaN` → `minValueReached = NaN` → 學習系統食 NaN。修復：guard `Number.isFinite(unrealizedPnl)` + skip non-finite `posValue`。

**ATTACK3-fix3：`computeSLTP` NaN entry → NaN SL/TP → 無止損開倉**。`computeSLTP(NaN, 'buy')` → `sl = NaN` → 交易引擎收到 NaN 止損 = 無止損。修復：`computeSLTP` 用 `safePrice(entry)` sanitize。

**ATTACK3-fix4：`recalculateEquity` NaN unrealizedPnl → NaN totalEquity**。單一 NaN position 令 `totalEquity = NaN` → 所有下游 risk check（max drawdown、daily loss、position sizing）崩潰。修復：guard 每個 `unrealizedPnl` 用 `Number.isFinite`（→ 0 fallback）。

**Tests**：`tests/v2.0.854-attack3-recompute-equity.test.ts`（12 tests）。Regression：162 相關測試通過。`tsc --noEmit` 零錯誤。

---

## Plan G — 動態 Threshold [45-55%] + 乘法 Penalty 衰減（v2.0.227）

### 問題：Penalty 死循環

 conviction gate 有一個複合懲罰設計缺陷：
- **加法 threshold 提升**：3 個 penalty gate（loss-streak、conditional WR、combo WR）疊加到 threshold（50% + 30% = 80%）
- **乘法 confidence 折扣**：P(win) × consensus（65% × 0.685 = 44.5%）
- **結果**：44.5% vs 80% = 35.5pp 差距 → 數學上不可能交易 → 冇新交易 → penalty 永遠唔 reset → 永久 STUCK

SILVER SELL 實測被卡 6+ 小時就係呢個死循環。

### 解決方案：統一乘法模型

```
effectiveConfidence = consensus × pwinBlendFactor × penaltyFactor × boostFactor
dynamicThreshold = 50% + (totalScore × 0.5%)  →  [45%, 55%]

if effectiveConfidence ≥ dynamicThreshold → TRADE
if effectiveConfidence < dynamicThreshold → HOLD

// v2.0.819 WINNER-FIRST:
//   pwinBlendFactor = max(olrBlendFactor, comboBlendFactor)
//   comboBlendFactor = 0.3 + 0.7 × comboWilsonLB   (only when n ≥ 20 AND Wilson LB ≥ 0.55)
//   boostFactor = 1.0 + min(winnerBoost, 0.20)      (lossStreakTracker winner pattern)
```

### `DynamicThresholdCalculator`（`src/analysis/dynamic-threshold.ts`）

**5 因素 hysteresis 計分**（每個因素 [-2, +2] 分，hysteresis 防止邊界跳動）：

| 因素 | -2 分（放鬆） | 0 分（中性） | +2 分（收緊） | 樣本要求 |
|:-----|:-------------|:-------------|:-------------|:--------:|
| Rolling WR | ≥55% | 40-55% | <35% | ≥10 筆 |
| Idle cycles | ≥20 cycles | 5-20 cycles | <2 cycles | — |
| Drawdown | <3% | 3-10% | >15% | — |
| Rolling Sharpe | >1.5 | 0-1.0 | <-1.0 | ≥10 筆 |
| Regime | trending | normal/mr | chaotic | — |

- `totalScore = WR分 + Idle分 + Drawdown分 + Sharpe分 + Regime分`，capped at [-10, +10]
- `threshold = 50% + totalScore × 0.5%` → 數學保證 [45%, 55%]

**Penalty 衰減**：`penaltyFactor = 1.0 - min(decayedPenalty, 0.30)`，其中 `decayedPenalty = netPenalty × max(0, 1 - cyclesIdle/30)`。30 cycles idle（2.5 小時）後 penalty 完全歸零 → 系統自我恢復。

**P(win) blendFactor**（v2.0.224 保留 + v2.0.819 WINNER-FIRST 擴展）：`pwinBlendFactor = max(olrBlendFactor, comboBlendFactor)`。`olrBlendFactor = 0.3 + 0.7 × P(win)`，cold-start 時 = 1.0。`comboBlendFactor = 0.3 + 0.7 × comboWilsonLB`，僅當 combo (symbol×side×regime) 達 n ≥ 20 AND Wilson 95% LB ≥ 0.55 時先 applicable——令統計上強烈嘅 winner（例如 BTC buy/low_vol 77% WR, 556W/164L）可以 override OLR 嘅乘法否決。之前 combo WR 只可以 penalty 輸家，永遠唔可以 boost 贏家，導致 BTC 被 OLR P(win)=6.6% 否決 4 日。

**BoostFactor**（v2.0.819 WINNER-FIRST）：`boostFactor = 1.0 + min(winnerBoost, 0.20)`。`winnerBoost` 來自 lossStreakTracker 嘅 checkWinnerPattern（8–15%）。之前 boost 被編碼為負數 `_lossStreakPenalty` 並被 `Math.max(0, netPenalty)` 靜默裁剪為 0——WINNER-FIRST directive 從未到達閘門。

### 6 重公正保障

1. **多因素平衡** — 5 個因素各自獨立，每個最多 ±1%，冇單一因素可以主導
2. **對稱設計** — 好同差嘅影響力相同（±2 分對稱）
3. **樣本數要求** — WR + Sharpe 要 ≥10 筆先計分，唔夠 = 中性（0 分）
4. **Hysteresis** — 每個因素有 buffer zone，唔會因為 49.9% vs 50.1% 來回跳
5. **Hard cap** — totalScore capped [-10, +10] → threshold [45%, 55%]，數學保證
6. **事實驅動** — 全部用已發生嘅事實（WR = 已結算勝率、Idle = 計時器、Drawdown = 已實現回撤、Sharpe = 已計算、Regime = 已觀測）

### SILVER SELL 模擬

```
舊系統（死循環）：
  threshold = 50% + 30% penalty = 80%
  confidence = 65% × 0.685 = 44.5%
  44.5% < 80% → 差 35.5pp → HOLD（不可能）

Plan G（6 小時 idle 後）：
  WR=27% → +2 分, Idle=36 cycles → -2 分, Sharpe<0 → +1 分
  totalScore = +1 → threshold = 50.5%
  penalty 衰減到 0（36 > 30 cycles）→ penaltyFactor = 1.0

  P(win)=55% + consensus=65% → 44.5% < 50.5% → HOLD（接近，差 6pp）
  P(win)=79% + consensus=65% → 55.4% ≥ 50.5% → TRADE ✓
  consensus=75% + P(win)=55% → 51.4% ≥ 50.5% → TRADE ✓
  → 強信號永遠有路過，中等信號要更高共識先過 = 公正
```

### 設計原則

- **Penalty 乘法唔加法**：懲罰折扣 confidence（乘法），唔提升 threshold（加法）。消除雙重懲罰。
- **Idle 衰減打破死循環**：越耐冇交易，penalty 越細。30 cycles 後歸零。系統永遠可以自我恢復。
- **Threshold 動態但有 cap**：用實際表現驅動（WR、Idle、Drawdown、Sharpe、Regime），但 capped [45%, 55%]。表現好時放鬆（入多啲），表現差時收緊（保護），但永遠唔會卡死。
- **強信號永遠有路過**：P(win)=79% + consensus=65% = 55.4% ≥ 50.5% → 即使系統表現差，強信號仍然可以入場。

### 整合

- `DynamicThresholdCalculator` 喺 conviction gate（`index.ts` line ~6803）取代舊嘅 `convictionThreshold + lossStreakPenalty`（加法）路徑
- `_lossStreakPenalty`（loss + cond + combo 三 gate 嘅 net penalty）改為傳入 calculator 嘅 `netPenalty`，計算 `penaltyFactor`（乘法）
- HACP `getCyclesWithoutTrade()` 提供 idle cycle 數
- Portfolio `currentDrawdownPct` 提供 drawdown
- TradeHistory `getRecent(20)` 計算 rolling WR + Sharpe
- `combinedState.regime` 提供 regime

---

## Paper Trading 模擬層（dual/execution mode）

**註**：v2.0.822+ 訊號運算模式（`ANALYSIS_MODE=true`）下，後端唔執行交易——執行由客戶端 `mats_app` `useAutoTrade` hook 處理。以下僅適用於 `dual` 或 `false` 模式。

- 槓桿感知 P&L：notional-based 雙邊手續費扣除
- 每個 price update 自動檢查 SL/TP + 追蹤 MAE/MFE（部位價值 = margin + unrealized PnL）
- Position Reconciliation：偵測 exchange 已平倉 → 同步 local mirror
- Real Trading Manager：HL exchange 下單 + 本地 mirror（phantom agent signing via `@noble/curves`）
- **v2.0.143 統一交易路由**：`executeTrade()` 按 tradeMode 路由 — paper 直接走 paperEngine，real 走 realTradingManager。`closeTrade()` 按 agentId 路由 — paper 走 portfolio.closePosition()，real 走 tradingManager.closePosition()。不再所有交易都經過 RealTradingManager。v2.0.853: `closeTrade()` 嘅 analysis-mode guard 必須檢查 `!this.dualMode`（同 `executeTrade()` 一致），否則 dual 模式下所有平倉被靜默跳過。`tradingManager.closePosition()` 必須從 `getRecentFills()` 揾到實際 HL fill price + PnL，唔好用滯後 `pos.currentPrice`。
- **v2.0.143 entryThesis 修復**：執行成功後才調用 `setEntryThesis()`，確保 thesis 在 position 存在時才寫入。syncExchangePositions 的 close+reimport 路徑保留 entryThesis + MAE/MFE。
- placeOrder 價格源：LIVE `l2Book`（best bid/ask）做 aggressive price 主源，`allMids` REST 做 fallback

**客戶端執行路徑**（`mats_app` `useAutoTrade.ts`，訊號模式）：
- Paper mode：寫入 Supabase `positions` 表（模擬倉位）
- Real mode：Pro tier + PK stored → `HlRestClient` 簽名 + 提交 Hyperliquid
- SL/TP 從用戶 settings 應用；Max position % 強制；manual mode 永不執行
- One trade per symbol per cycle（dedup by cycleId）

---

## Trade Incident Panel

取代舊版 Positions table + Trade Records，統一顯示每筆交易（paper + real，open + closed）為可展開卡片。

**卡片欄位**：
| 欄位 | 說明 |
|:-----|:-----|
| Symbol / Side / Status | 基本資訊（BUY/SELL、OPEN/CLOSED、PAPER/REAL tag）|
| PnL | 已實現（closed）或未實現（open）盈虧 |
| Entry / Exit Price | 進出場價格 |
| Min/Max Value Reached | MAE/MFE — 部位價值的最低/最高點（margin + unrealized PnL）|
| Entry Thesis | Meta-Agent 的進場理據（凍結在開倉時）|
| Exit Thesis | 平倉理據（v2.0.225：SL/TP 不再收窄，只記錄平倉原因）|
| Post-Review | LLM 自動生成的賽後檢討（如何賺多啲/蝕少啲）|
| Leverage / Investment / Opened / Closed | 交易參數 |

**Exit Thesis**：平倉理據記錄平倉原因（SL 觸發 / TP 觸發 / thesis invalidation / 手動平倉）。v2.0.225 起 SL/TP 入場後不再收窄，不再有 narrowing 分析。

**Post-Review LLM**：每筆交易關閉後，fire-and-forget 調用 DeepSeek V4 Flash 生成 2-4 句賽後檢討，分析 MAE/MFE + entry/exit thesis + close reason，提出如何改善。

**持久化**：所有新欄位（entryThesis, exitThesis, postReview, minValueReached, maxValueReached, originalStopLossPrice, originalTakeProfitPrice）持久化到 `portfolio-state.json`，重啟不丟失。

---

## Edge Validation Layer（v2.0.833 — alpha 測謊機）

**核心定位**：Edge 系統唔係 alpha 嘅來源，係 alpha 嘅測謊機。佢唔會製造盈利，佢會令系統知道「有冇 edge、邊度有 edge」。盈利 = alpha × 執行 × 穩定性；Edge 層只量化 alpha + 強制穩定性。

**6 個組件**（`src/edge/`）：

| 組件 | 檔案 | 作用 |
|:-----|:-----|:-----|
| Edge Config | `edge-config.ts` | 所有 threshold + weight 經 Zod env var。Regime-aware 5-component 加權。Sample cap 10000。與 `src/config/` 分離（edge 控制訊號質量量度，risk 控制後端帳戶） |
| Edge Calculator (1A) | `edge-calculator.ts` | 5-component regime-weighted edgeScore：directionalEdge（shadow WR）+ learnedEdge（OLR 校準）+ comboEdge（Wilson LB）+ pathEdge（First-Passage）+ realizedEdge（WR×Sharpe）。Confidence label 按最少 sample。低 confidence 永遠唔可以 `trade`（最多 `caution`）。`Object.hasOwn` 防原型污染。`skipEdgeReport` 返回 `caution`（唔係 `skip`）—冷啟動唔可以 block |
| Execution Tracker (1B) | `execution-tracker.ts` | 記錄真實 slippage + funding per (symbol, side)。`calibratePnlLabel()` 將理論 PnL → 可實現 PnL。Cold-start passthrough（\u003c20 sample 唔校準）。Ring buffer bounded。Side-aware slippage（buy: fill\u003esignal=bad；sell: fill\u003csignal=bad） |
| Stability Monitor (1C) | `stability-monitor.ts` | ±5% perturbation test + cross-time consistency。Stability factor [0.5, 1.0] 乘 conviction。純數學，毫秒級 |
| Risk-Profile Edge Store | `risk-profile-edge-store.ts` | MiniLM 384-d 向量 DB。Ring buffer 10k。Brute-force cosine over (market + profile) embeddings。Per-profile conditional edge → 3 個 edgeScore per asset。Wilson LB + 30 日 time-decay。Cold-start neutral 0.5 |
| Backtest Validation | `backtest-validation.ts` | 計量金融標準：Sharpe / Sortino / Calmar / Profit Factor / Expectancy / Max Drawdown / Information Ratio vs buy-and-hold。統計顯著性：stationary bootstrap p-value（Politis & Romano 1994）+ Deflated Sharpe Ratio（Bailey & López de Prado 2014，修正 multiple testing）+ walk-forward 70/30 IS/OOS split |

**整合**：`buildAssetAnalysis()` 接受 `edgeReport`（風險中性）+ `profileEdges`（per-profile 條件化）。`MatrixCell.edge?` + `AssetAnalysis.edgeReport?` 加入 types。`skip` recommendation 強制 cell action = `hold`（client 唔執行無 edge 訊號）。`caution` 唔強制 hold（系統可以 bootstrap）。

**冷啟動安全**：零 sample → `edgeScore=0.5`（中性）+ `recommendation=caution`（唔係 skip）。全新系統可以交易去累積 sample。無知 ≠ 無 edge 嘅證據。

**安全修復（94 attack tests）**：原型污染（`Object.hasOwn`）、冷啟動死鎖（`skipEdgeReport=caution`）、confidence bypass（低 confidence 永遠唔 trade）、ExecutionTracker DoS（bounded `recent.length`）、store 原型污染（load 驗證）。

**v2.0.833 移除嘅組件**（training wired 但 0 inference call site，grep 證實）：

| 組件 | 移除原因 |
|:-----|:---------|
| `world-model.ts` | `addSample` 用 close-time features 同時做 current + next → identity transition model → 0 預測能力。`predict`/`rollout` 0 call |
| `reward-shaping.ts` | `shape()` 0 call。`learningWeight`（v2.0.226）已覆蓋關鍵 case（執行損失降權） |
| `cross-symbol-backbone.ts` | `query()` 0 call。OLR backfill 已解決 cold-start |
| `temporal-attention.ts` | `retrieve()` 0 call。同 AttnRes cycle-history 重疊，保留更成熟嘅 AttnRes |

**v2.0.833 暫停**：`active-exploration`（`ACTIVE_EXPLORATION_ENABLED=false`）。盲目 UCB 探索喺冇 edge 驗證下危險。等 Edge Report 證明 baseline 有 edge 先重啟。

**Sample cap 提升至 10000**：`trade-history` 5000→10000、`replay-buffer` 5000→10000、`pattern-tag` 500→5000、`shadow-recent` 50→200、`olr-recent` 20→100、`audit-recent` 20→100、`em-insight` 500→5000、`EXP_MAX_RECORDS` 1000→10000。全部經 `edgeConfig` env var。

---

## Q-RL Alpha Discovery（v2.0.835 — 首個可以發現新 alpha 嘅組件）

**核心定位**：Edge Validation Layer 係 alpha 嘅「測謊機」——量化現有 edge。Q-RL Alpha Discovery 係首個可以**發現新 alpha**嘅組件——透過 ε-greedy 探索，嘗試 LLM 唔會選擇嘅 action，從 Aligned Shadow 嘅 reward 學習。

### Q-RL Q-Table（`src/evolution/q-rl-table.ts`）

**270 cells** = 5 regime × 3 vol × 3 momentum × 3 funding × 2 action。每個 cell 儲存 Q-value（預期 PnL%）、visit count、reward history。

| 元件 | 說明 |
|:-----|:-----|
| ε-greedy 探索 | ε 由 1.0（100% 探索）線性衰減到 0.05，over 500 cycles。Cold-start（Q=0）→ follow LLM（同現有行為一致） |
| EWMA Q-value 更新 | `α = 1/(1+visits)` diminishing learning rate。`newQ = (1-α)×oldQ + α×reward` |
| Discovery 掃描 | 每 5 cycles 掃描 Q-table。Candidate: Q \u003e 0.2% + n ≥ 10。Probable: Q \u003e 0.3% + Wilson LB \u003e 50% + n ≥ 20。Confirmed: Q \u003e 0.5% + Wilson LB \u003e 55% + BH-FDR pass + n ≥ 30 |
| Stationary bootstrap p-value | Politis & Romano 1994，block size √n，H0-centered（v2.0.835 fix: center data under H0，否則全部相同 reward → p-value=1.0） |
| Benjamini-Hochberg FDR | 多重檢定修正。失敗嘅 confirmed → downgraded to probable |
| HACP 注入 | `qrlDiscoveryBlock` 注入 Meta-Agent prompt。Confirmed → conviction +5%，Probable → +2%，Candidate → note only |
| 持久化 | `q-rl-table.json`（atomic save/load），save 返回 deep copy（防 mutation） |

**Cold-start 安全**：所有 Q=0 → follow LLM（同現有行為完全一致）。冇 GPU，冇 backprop，冇神經網絡——純 TypeScript EWMA + Wilson score。

### Factor-Tagged Aligned Shadow（`src/evolution/shadow-trade-engine.ts`）

**問題**：Blind shadow 喺所有市場條件下開模擬倉，但真實交易只喺 LLM 選擇嘅條件下執行 → distribution shift → OLR 學習錯誤分佈。

**解決方案**：Aligned Shadow 跟隨 LLM 共識方向，帶 agent vote metadata（factor tagging）。

| 元件 | 說明 |
|:-----|:-----|
| `shadowType: 'blind' \| 'aligned'` | ShadowPosition 新增欄位 |
| `openAlignedShadow()` | 跟隨 LLM 共識方向，接受外部 SL/TP 參數 + agentVotes + primaryDriver |
| `hasAlignedShadow()` | Blind skip check（避免重複 shadow） |
| OLR source routing | `checkPositions` 按 `shadowType` 路由：aligned → 'shadow'（weight 1），blind → 'shadow_blind'（weight 0.1） |
| `buildEdgeText` factor tagging | agentVotes + primaryDriver 注入 MiniLM embedding text → factor-tagged queries |

**OLR source weights**：`shadow=1, shadow_blind=0.1, paper=2, real=4, backfill=0.1`。Blind shadow downweighted 10×（distribution shift）。

### 安全修復（v2.0.835: 20 vulnerabilities, 242 attack tests）

5 輪對抗測試發現並修復 20 個漏洞：

| 輪次 | 目標 | 測試數 | 漏洞 |
|:---|:---|:---:|:---:|
| Round 1 | Q-RL 基礎 | 52 | 2（null features crash, action case sensitivity） |
| Round 2 | Q-RL 深度 | +48 → 100 | 3（save reference leak, load config restore, bootstrap centering） |
| Round 3 | CHANGELOG 10 功能 | 142 | 8（NaN entryPrice, serialize leak, getter bomb, bootstrap centering, 等） |
| Round 4 | 創意/意想不到 | 113 | 3（MAX_VALUE overflow, serialize recent leak, Object.entries getter bomb） |
| Round 5 | Q-RL 創意 | 69 | 4（makeKey getter bomb, Proxy throw, getBestDiscovery getter） |
| **總計** | | **242** | **20** |

最嚴重嘅漏洞：
1. **Q-RL bootstrapPValue centering**（R2-3）——全部相同 reward → p-value=1.0 → confirmed discovery 永遠唔會發生 → Alpha Discovery 系統名存實亡
2. **smart-sltp.ts NaN entryPrice**（V1）——SL/TP 全部 NaN → 交易引擎收到 NaN 止損 = 無止損開倉
3. **Q-RL getter bomb**（Q1-Q4）——`makeKey` 嘅 `features['regimeOrdinal']` 觸發 getter → crash 整個 decision cycle

### 學習管道修復（v2.0.855 — 三條斷裂嘅血管重新接駁）

Adversarial audit（v2.0.855 系列）對照真實持久化狀態（`shadow-state.json`、`q-rl-table.json`、`olr-state.json`）發現三個疊加斷點令 Q-RL 由開局至今**永遠冇數據**（`values: {}` after 79 cycles）——而唔係「冷啟動安全」：

| 版本 | 修復 | 斷點 |
|:-----|:-----|:-----|
| v2.0.855 | Aligned shadow 恆開 | `if (didTradeExecute) continue;` 令 real-trade cycles（最多決策信號嘅 cycles）跳過 aligned shadow → Q-RL 唯一 live feed 餓死 |
| v2.0.855 | shadow_blind OLR 計數器 | v2.0.834 承諾「tracked separately」但 feedTrade 從未 increment → BTC long `shadowSamples=0` 而 54k paper samples 淹沒模型 |
| v2.0.855 | thesis-invalidation closeReason 全覆蓋 | 2 個 force-close call site 缺顯式 reason → 72/167 筆 real close 被誤標為 'sl_tp' |
| v2.0.855-fix | **Q-RL EXP backfill** | `backfillFromExpRecords()` 餵咗 OLR/NA/AttnRes/Cluster/CHR/Combo/MetaLearner/Causal/Attribution 但**從未餵 Q-RL** → 加 `qrlTable.update(features, side, pnlPct)`（1072/1674 筆有 marketFeatures） |
| v2.0.855-attack | 7 個修復引入嘅漏洞 | OLR counter `?? 0` 擋唔住字符串/負數；closeReason 空字符串/typo 穿透（`'' ?? x === ''`）令學習權重爆 3.3×；aligned-shadow weightedDirection 用咗 Q-RL 探索 action |
| v2.0.855-attack2 | **binRegime 對齊** | `binRegime()` 邊界同 `regimeToOrdinal()` **完全錯位**（6/7 regime 入錯桶，bull/bear 對調）→ 每個 Q-RL cell 標籤錯誤 |

**Q-RL 而家三通道完整**：live aligned shadow（修好）+ EXP backfill（新加）+ 正確 regime 分桶（修好）——`discoverPatterns()` 即刻有嘢掃，DCS 即刻有 discovery evidence。

---

## Self-Aware Evolution（v2.0.843-848 — Meta-Cognition + Self-Improving + Causal Reasoning + Meta-Learning + Component Attribution）

v2.0.842 新增三大進化組件 + 混合數據源架構。v2.0.843 新增 ANN index + asset-aware Meta-Learner + Skeptics evolution block fix。v2.0.844-848 新增 Component Attribution + LLM-vs-Stats A/B shadow + Label Cleanliness（見下方專節）。系統唔再只係從交易結果學習，而係知道自己幾準（元認知）、自動調整自己嘅 hyperparameters（自我改善）、區分因果同相關（因果推理）、學點樣學得更快（元學習）、量度邊個組件真正加 edge（歸因）。

### Meta-Cognitive Calibrator（`src/evolution/meta-calibrator.ts`，v2.0.837）

系統知道自己嘅 P(win) 預測整體準唔準。每筆 trade close 時記錄 `(predictedPWin, conviction, regime, outcome)`，計算 Brier score + ECE。Per-regime Brier 追蹤。`getCalibrationBlock()` → HACP `setMetaCalibrationBlock()` → 注入 `rilEnhancedMarketDesc`。

### Self-Improver（`src/evolution/self-improver.ts`，v2.0.838）

系統自動調整自己嘅 hyperparameters：Thompson Sampling bandit（`explorationStrategy`）+ OLS gradient（`convictionGateThreshold` [0.40, 0.60]、`aggressiveSlCap` [0.05, 0.09]、`conservativeSlCap` [0.02, 0.04]、`dcsTimeDecayHalfLife` [100, 400]）。Hard bounds 限制。`runTuningCycle()` apply all recommendations with audit logging。

### Causal Reasoner（`src/evolution/causal-reasoner.ts`，v2.0.839）

區分因果同相關。

**Paired shadow uplift**：每開一筆 aligned shadow，同時記錄「如果冇交易」嘅 counterfactual。

$$\text{Uplift} = \text{tradedPnl} - \text{holdPnl}$$

- Uplift > 0 = 交易有因果效果（有 alpha）
- Uplift ≈ 0 = 交易冇因果效果（只係跟市場）
- Uplift < 0 = 交易有負面因果效果（SL hit 但市場冇郁）

**Permutation causal feature importance**：打亂每個 feature 嘅值，睇 PnL 預測跌幾多。跌好多 = causal。唔跌 = spurious correlation。

**`recordAuditConfounder()`**：trade-audit 發現嘅 confounder 標記到 feature importance。

**HACP block**：uplift warning（≈0 = no alpha）+ feature importance + confounder detection。

### Meta-Learner（`src/evolution/meta-learner.ts`，v2.0.840+843）

系統學點樣學得更快。

| 機制 | 作用 | 範圍 | 數據源 |
|:---|:---|:---|:---|
| **Adaptive α** | 高 reward variance → 低 learning rate | [0.1, 2.0] × | Q-RL ✅ |
| **Feature weight** | 高 predictive power → 高 weight | [0.1, 3.0] | Shadow ✅ |
| **Curriculum** | Fast-learning regime → 優先探索 | [0, 1] priority | Q-RL ✅ |

**`recordAuditFeatureAdjustment()`**：trade-audit 發現 thesis 矛盾 → 降 thesis feature 嘅 predictive power → weight 自動降。

**v2.0.843 Asset-aware feature weighting**：3-level hierarchy（symbol → category → global）。每個 asset 學自己嘅 pattern（SILVER 可以學到「OB imbalance works for me」而唔俾 BTC 拖低）。`deriveAssetMetadata()` 分類：crypto（唔按 vol 拆分）、commodity、forex、equity、other。低 volume ≠ 唔可靠——每個 asset 有自己嘅 pattern，weight 來自數據唔來自 volume 假設。`getAssetAwareFeatureWeights()` 做 3-level blend，warmup at 30 samples。

### 混合數據源架構（Hybrid Data Source）

| 組件 | 數據源 | 原因 | 速度 |
|:---|:---|:---|:---|
| Self-Improving (config bandit) | Shadow ✅ | explorationStrategy 直接影響 shadow | 10-50× |
| Self-Improving (param tuning) | Real ❌ | convictionGate / SL caps 影響真金白銀 | 必須 real |
| Causal Reasoning (uplift) | Shadow ✅ | counterfactual 只可能用 paired shadow | 天然 |
| Meta-Learning (adaptive α) | Q-RL ✅ | 已經係 Q-value change rate | 已最快 |
| Meta-Learning (feature weight) | Shadow ✅ | Shadow resolution 快 10-50× | 10-50× |
| Meta-Learning (curriculum) | Q-RL ✅ | regime learning speed = Q-value 變化 | 已最快 |

### Trade-Audit → Evolution 路由（`feedAuditToEvolution()`）

Trade-audit LLM 每 2 個 cycle 發現 incidents，而家會路由到進化組件：

| Audit category | 灌入 | 效果 |
|:---|:---|:---|
| `direction-repetition-loss` | SelfImprover | 負 reward → bandit 降 config alpha |
| `low-conditional-win-rate-ignored` | SelfImprover | 負 reward → conviction gate push |
| `premature-exit-mfe-mismatch` | SelfImprover | SL cap push |
| `sl-too-tight-for-volatility` | SelfImprover | SL cap push |
| `overtrading` | SelfImprover | conviction gate push（降頻率） |
| `thesis-contradicts-action` | MetaLearner | thesis feature 降 predictive power |
| `thesis-quality-issue` | MetaLearner | thesis feature 降權 |
| `market-condition-pattern` | MetaLearner | regime feature 降權 |
| `data-quality-issue` | CausalReasoner | 標記為 confounder |
| `default` | SelfImprover | 弱負信號 |

**Severity weighting**：critical ×1.0，warning ×0.5，info ×0.25。

### Backfill 機制

`backfillFromExpRecords()` 喺系統重啟時讀取 1640 條 EXP 記錄（1038 條有 marketFeatures），灌入三個新組件：

| 組件 | Backfill 量 | 效果 |
|:---|:---|:---|
| MetaLearner | ~10K feature observations | adaptive feature weights 即時生效 |
| CausalReasoner | ~1038 paired shadows | uplift + feature importance 即時計算 |
| SelfImprover | ~50 performance windows | config bandit + param tuning 即時啟動 |
| ComponentAttribution (v2.0.848) | 全部 EXP records | 歸因 dashboard cold-start 唔空（Causal 除外——EXP 冇 per-symbol data） |

---

## Component Attribution + LLM-vs-Stats A/B（v2.0.844-848 — 邊個組件真正加 edge？）

Verification-first 基礎設施：系統唔再假設每個進化組件都有價值，而係量度每筆 trade 每個組件嘅實際 contribution。Attribution 係 cost-benefit 分析，唔係 prediction——佢答「邊個組件加 edge」，唔答「市場會唔會升」。

### Component Attribution Store（`src/evolution/component-attribution.ts`，v2.0.844）

| 元件 | 說明 |
|:-----|:-----|
| **Proxy credit assignment** | `contribution = (agreement − 0.5) × 2 × sign(pnlPct)`。組件同意咗贏錢嗰邊 → 正 credit |
| **Cold-start safe** | `< MIN_SAMPLES (10)` → neutral stats，永遠唔會過早 prune |
| **Idempotent** | per `(tradeId, componentId)`——backfill + live 唔會 double-count |
| **Bounded** | ring buffer MAX_RECORDS = 10k，rolling eviction |
| **Hardened (v2.0.845)** | sanitize undefined/null symbol + empty regime；load purge evicted seenKeys（無 stale-token leak） |
| **`getCleanlinessOverview(lookbackMs)`** | label-quality summary：per-regime clean/polluted rate，由 `computeLearningWeight` 推導（v2.0.846 Phase 1b） |
| **`getComponentStats()`/`getAllStats()`** | per-component expectancy、contribution、samples、confidence |
| **Persistence** | `component-attribution.json`（atomic save/load） |

**⚠️ 真實數據審計（v2.0.855-audit，`component-attribution.json`）**：

| 發現 | 數據 | 含義 |
|:-----|:-----|:-----|
| **97% 係 backfill** | 1026 records 中 992 係 cycleId=0（歷史 EXP backfill），得 34 筆 live | Attribution 統計主要反映歷史，唔係現時系統行為 |
| **Live OLR contribution 係負數** | 34 筆 live：`olr` contribution = **-4.586**（19 筆）；`causal-uplift` = -0.031（15 筆） | **OLR 信號喺真實交易上實際係「減低 edge」**，同文檔宣稱嘅「PRIMARY factor」相反——需要調查點解 |
| **Regime 極度集中** | low_volatility 891/1026 (87%)；mean_reverting 127；trending_bull 8 | 絕大多數學習發生喺單一 regime，其他 regime 樣本極少 |
| **OLR agreement 差異微弱** | 贏時 avg agreement 0.505 vs 蝕時 0.494（差 0.011） | OLR signal 嘅預測力好弱，接近 random |

**結論**：Component Attribution 框架存在，但**數據主體係 backfill（97%），live 樣本太少（34）且顯示 OLR 係負貢獻**。喺累積足夠 live 樣本之前，唔可以根據 attribution 數據做組件增刪決定——但佢指出一個需要調查嘅方向：**OLR 信號可能唔係淨加 edge**。

### ⚠️ 更深層發現（v2.0.856 audit）：兩個疊加嘅測量謬誤

**謬誤 1：signal contract bug——causal-uplift 對 SELL 信號被錯誤反轉（已修 v2.0.856）**

`recordAttribution()` 嘅契約係「signal > 0.5 = bullish, store 對 SELL 反轉」。但 causal-uplift caller 傳嘅係 direction-agnostic 嘅 `0.5+uplift`（uplift>0 = 呢筆 trade 有正 alpha，唔係市場向上）——對 SELL 交易被 store 反轉 → 正 alpha 記錄成負 contribution。**OLR caller 僥倖正確**（caller 反轉 `1-P(win|sell)` + store 再反轉 = 雙重反轉 cancel），但 causal 冇 caller 反轉 → 單次反轉錯。Live causal-uplift contribution = -0.031 主要就係來自呢個反轉（16 筆中 14 筆 SELL）。

**修復（v2.0.856）**：統一 signal 契約——caller 全部傳 raw bullish degree（>0.5 = 睇升），direction-agnostic 指標（causal uplift）必須由 caller 轉換：`buy → sig, sell → 1-sig`。更新 store 註解講清楚契約。11 個測試鎖定。

**謬誤 2：OLR 極端信號污染統計（未修，需進一步調查）**

OLR live attribution 記錄中 9/20 係極端 agreement（>0.9 或 <0.1，即 P(win) 99%+），而其中 5/9 係錯（overconfident）。Calibration bins 揭示根源：BTC long 65814 樣本中絕大多數集中喺 [0.6-0.8) bin（594W/208L，實際 WR 74%）——**OLR 成日輸出高 P(win)，而呢啲「高信心」預測喺真實交易時一半錯**。呢個係 selection bias：系統傾向喺 OLR 話高勝率時先開倉，但「高信心」唔保證「高準確」。

**對 Edge 審計嘅影響**：v2.0.856 前嘅 attribution 數據（尤其 causal SELL + OLR 極端信號）不可信。判讀組件 edge 應以 v2.0.856 後新累積嘅 live 記錄為準。可用 `npx tsx scripts/edge-audit.ts` 做唯讀審計。

### ⚠️ Attack 系列（v2.0.856-attack/attack2/attack3）：side/symbol 維度嘅 guard 補完

| 版本 | 漏洞 | 修復 |
|:-----|:-----|:-----|
| v2.0.856-attack | **V8 side 不對稱**：caller `=== 'buy'` vs store `=== 'sell'`——garbage side（'SELL' 大寫/undefined/'long'）令 caller 反轉而 store 唔反轉 → contribution 反轉。**V9** edge-audit 對 malformed records crash。**V10** store 存 raw garbage side | 加 `normalizeTradeSide()` helper（component-attribution.ts）——caller 同 store 共用，garbage → 'unknown' → 兩邊都唔反轉（中性，永不捏造方向）。12 測試 |
| v2.0.856-attack2 | **V11 side fabricate**：`trade.side === 'buy' ? 'buy' : 'sell'` 喺 8 個 call site 將 undefined/'BUY'/'long' 靜默當 sell → 污染 bySide 統計 + 方向標籤。**V12** uplift 未 sanitize（NaN/string）。**V13** boxed String 驗證安全 | `onPositionClosedLearning` 開頭統一 guard：side 唔 canonical → skip 成個 learning block（保護 8 個下游 consumer）。Attribution block skip unknown side。`ComponentAttribution.side` type 拓寬至 `'buy'\|'sell'\|'unknown'`。`safeNum(uplift)`。4 測試 |
| v2.0.856-attack3 | **E2/E3 symbol crash**：restore 路徑 `symbol: t.symbol` 無 runtime guard——undefined symbol + valid side 通過 side guard → `olrEngine.feedTrade(undefined)` → `undefined.toLowerCase()` TypeError crash | Guard 同時驗證 symbol：`safeSymbol = typeof trade.symbol === 'string' && trade.symbol.length > 0`。side 或 symbol 任何一個唔 valid → 完全隔離 corrupt record。4 測試 |

**核心防禦原則（v2.0.856-attack 系列）**：一個 corrupt trade record 而家係「完全隔離」——無論 side/symbol/uplift 邊個字段壞，統一 guard 都會 skip 成個 learning 記錄，唔會用錯誤方向/錯誤 symbol 污染任何 learning 系統，亦唔會 crash 到 `feedTrade`/`normalizeSymbol`。

### Phase 1a：LLM vs 純統計 A/B Shadow（`shadow-trade-engine.ts`，v2.0.846）

新 `shadowType: 'statistical'`——方向**淨**由統計組件（OLR P(win) + Combo WR + Causal uplift）計算嘅 shadow，`openStatisticalShadow()` + `hasStatisticalShadow()`（per symbol+side+cycle dedup）。

**點解**：Aligned shadow 跟 LLM 共識，blind shadow 跟 noise——但都冇對照組去隔離「LLM 共識本身」有冇加 edge。Statistical shadow 係同一個市場條件下嘅受控 A/B：LLM 驅動嘅 aligned shadow vs 純統計 shadow 對賭，隔離 LLM 嘅邊際價值。

**OLR source routing**：`statistical` → `'shadow'`（full weight，真實統計信號），`blind` → `'shadow_blind'`（0.1×）。

### Phase 2a：Causal-Grounded Entry Gate（`index.ts`，v2.0.844）

`computeCausalConvictionMultiplier()`——negative causal uplift → 乘法 conviction 折讓 `[0.5, 1.0]`。Soft gate，永遠唔 hard-block（owner P1）。只有 aligned shadow 顯示 positive causal alpha 先俾 full size。Cold-start safe（insufficient samples → 1.0）。

### Phase 2b：Meta-Calibrator → Dynamic Trust（`index.ts`，v2.0.844）

`computeCalibrationTrustMultiplier(regime)`——per-regime Brier：差過 random（Brier > 0.25）→ ×<1.0，良好校准（Brier < 0.20）→ ×>1.0。委託現有 `getConfidenceAdjustment()`。Clamped `[0.5, 1.5]`。insufficient data → 1.0。

### Attribution 錄製（`onPositionClosedLearning`）

- OLR signal（`entryOlrPWin`）+ Causal uplift signal → `componentAttribution.recordAttribution`
- Cleanliness 由 `computeLearningWeight`（close-context-aware）推導
- `normalizeSymbol` 對 undefined symbol 加 guard（legacy/corrupt trade records——之前係 crash vector）

### v2.0.847：Fix `computeStatisticalLean` cross-symbol contamination

**BUG**：`computeStatisticalLean` 無條件用 `this.lastFirstPassage`，但 first-passage 淨係為 active symbol 計算。Aligned-shadow A/B loop 為**所有** trading symbols 開 statistical shadow——所以非 active symbols 被餵咗 active symbol 嘅 path-risk 數據，污染咗 LLM-vs-stats 比較。

**FIX**：加 `isActive` guard——first-passage 淨係喺 symbol 係 active symbol 時先 contribution。非 active symbols 只用 OLR + Combo WR + Causal uplift。另外 guard undefined/empty symbol + non-object features。

### v2.0.848：Backfill Component Attribution

`backfillFromExpRecords()` 為每條 EXP record 餵 `componentAttribution.recordAttribution`——`attrFed` counter、OLR signal 由 `rec.olrPWinAtEntry`、cleanliness 由 `computeLearningWeight`、regime 由 `rec.regime`。每次 cold-start 執行，令 dashboard 唔空。Causal uplift 跳過（EXP 冇 per-symbol historical data——by design 冷啟動）。

### API 暴露（`advancedLearning`）+ UI

- API：`componentAttribution`（size / components / per-component stats）+ `labelCleanliness`（records / avgCleanliness / cleanRate / pollutedRate / byRegime）
- UI：`ComponentAttributionSection`，格式與 OLR/Experience/EM/RIL 對齊（`evo-section-header`/`evo-section-accent`/`evo-section-toggle`），systemsTotal 15 → 18

**驗證**：41/41 attack tests（`v2.0.844-attribution-attack.test.ts` + `v2.0.846-stat-shadow-attack.test.ts`），91/91 stat-shadow + attribution + evolution，`tsc --noEmit` zero errors。

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
Provider interface + Ollama provider（circuit breaker + concurrency 4 + 指數退避）。支援 local + Pro cloud models。`OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:0731-cloud`。

### 數據管道（`data/`）
Hyperliquid WebSocket（l2Book + trades + activeAssetCtx + clearinghouseState + userFills）+ REST fallback。Binance WebSocket（輔助）。Global HL rate limiter（single queue, 429 retry）。WS infinite reconnect + REST polling backoff。

### 永續儲存（`persistence.ts`）
`lockedWrite()` atomic write。State files: `olr-state.json` · `shadow-state.json` · `trade-patterns.json` · `evolution-state.json` · `portfolio-state.json` · `market-agent-config.json` · `debate-history.json` · `em-state.json` · `na-model.json` · `cycle-history.json` · `anti-patterns.json` · `root-command-prompt.json` · `loop-engineering-memory.json` · `exp-embeddings.json`。

---

## 配置與環境變數

```bash
# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:0731-cloud

# ═════════════════════════════════════════════════════════════
# ANALYSIS MODE — 訊號運算模式（v2.0.822+，核心架構開關）
# ═════════════════════════════════════════════════════════════
# 'true'  — 僅計算訊號 + 寫入 Supabase，唔下單（純訊號後端）
# 'dual'  — 訊號 + 執行（寫 Supabase + paper/real 交易）← 生產預設
# 'false' — 僅執行，唔寫 Supabase（legacy 獨立交易模式）
ANALYSIS_MODE=dual

# ═════════════════════════════════════════════════════════════
# SUPABASE — 訊號輸出目標（v2.0.822+）
# ═════════════════════════════════════════════════════════════
# 後端用 service_role 寫入 asset_analyses 表；客戶端用 anon key 讀取
# 缺少時 → analysis writer disabled（local-only mode，僅 log 輸出）
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=          # ⚠️ service_role — 永不 ship 到客戶端

# Hyperliquid (optional, real trading — dual/execution mode)
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

**`ANALYSIS_MODE` 行為矩陣**：
| 設定 | 訊號計算 | 寫入 Supabase | 執行交易 | 適用場景 |
|:-----|:--------:|:------------:|:--------:|:--------|
| `true` | ✓ | ✓ | ✗ | 純訊號後端（mats_app 客戶端執行）|
| `dual` | ✓ | ✓ | ✓ | 訊號 + 後端執行（生產預設）|
| `false` | ✓ | ✗ | ✓ | Legacy 獨立交易模式 |

---

## 技術棧

| Category | Technology |
|:---------|:-----------|
| Language | TypeScript 5.6（嚴格模式，`noPropertyAccessFromIndexSignature`，零類型錯誤） |
| Runtime | Node.js 22+ |
| LLM | Ollama（local + Pro cloud）/ OpenAI-compatible |
| Market Data | Hyperliquid WebSocket + REST（9 perpetual DEXs） |
| 訊號輸出 | Supabase `asset_analyses` 表（service_role 寫入，anon 讀取）|
| 客戶端 | **`mats_app`**（Expo React Native + Reanimated + Three.js）— 風險選擇 + 執行 |
| 客戶端錢包 | `mats_app` `src/wallet/`（自託管，SecureStorage，`@noble/curves` 簽名）|
| 客戶端數據 | `mats_app/trade-bridge`（HL WS 市場數據 + on-chain reconciliation，永不簽名）|
| Legacy UI | `ui/`（React 18 + Vite — 已由 mats_app 取代，保留作 local dashboard）|
| Config | Zod schema validation |
| Logging | Winston（structured + file rotation） |
| Testing | vitest（609 core + 424 attack tests，gitignored；4 attack suites: q-rl-attack, changelog-features-attack, creative-attacks, q-rl-creative-attacks）|
| Crypto | `@noble/curves`（HL phantom agent signing） |
| Vector Embedding | Transformers.js MiniLM L6 v2（384-dim, in-process, CPU） |
| Pattern Clustering | Greedy cosine clustering（RIL Reason Intelligence Layer） |

---

## 啟動

```bash
npm run engineer    # 自主進化模式：訊號運算 + System Engineer 自主修復 + 修復後自動重啟
npm run dev         # 開發模式：API :3456 + legacy UI :5173（concurrently）
```
API: **http://localhost:3456/api/status** · Legacy Dashboard: **http://localhost:5173/**

**訊號運算模式**（`ANALYSIS_MODE=true`，配合 `mats_app`）：
1. 後端每個 cycle 計算 HACP 共識 → 擴展成 3×3 矩陣 → 寫入 Supabase `asset_analyses`
2. 客戶端 `mats_app` 用戶選擇風險等級（high/mid/low）→ 讀取對應矩陣格 → 決定執行
3. 後端唔下單——純訊號輸出。執行由客戶端 `useAutoTrade` hook 處理

**Dual 模式**（`ANALYSIS_MODE=dual`，生產預設）：
1. 後端同時計算訊號 + 寫入 Supabase + 執行交易（paper/real）
2. 客戶端同時可讀取矩陣做手動/自動執行

**`npm run engineer` 自主進化模式**：
1. `engineer-loop.sh` 啟動 `tsx src/index.ts`（`SYSTEM_ENGINEER_ENABLED=true`）
2. 訊號系統正常運行，每 2 個 cycle（cycle period ≥ 5 min 時）觸發 System Engineer
3. System Engineer 審查交易記錄 + 源代碼 → 生成修復 → `tsc --noEmit` + `npm test` 驗證
4. 全部通過 → git commit → `process.exit(42)` → `engineer-loop.sh` 偵測 exit code 42 → 重啟進程
5. 任何失敗 → 自動 rollback（恢復原始文件）→ 繼續運行
6. 重啟後加載新代碼 → 繼續運算 → 2 個 cycle 後再檢查 → 循環

**安全設計**：
- System Engineer 只可修改 `src/evolution/` + `src/cognition/` + `src/analysis/` + `src/agents/` + `tests/`
- 禁止觸碰 `src/trading/`（下單/SL/TP/簽名）+ `src/config/`（風險設置）+ `src/index.ts` + `.env`
- tsc + test 安全網：任何失敗 → 自動 rollback，不會應用未驗證的代碼
- Dual/execution 模式時，重啟期間持倉由 HL 交易所的 SL/TP trigger orders 保護，不依賴本地進程

---

> 完整版本歷史請見 [CHANGELOG.md](CHANGELOG.md)。

---

## v2.0.227: Plan G — Dynamic Threshold [45-55%] + Multiplicative Penalty with Decay

### Problem: Death Spiral

The conviction gate had a compound punishment design:
- **Additive threshold raise**: 3 penalty gates (loss-streak, conditional WR, combo WR) added to the threshold (50% + 30% = 80%)
- **Multiplicative confidence discount**: P(win) × consensus (65% × 0.685 = 44.5%)
- **Result**: 44.5% vs 80% = 35.5pp gap → trading mathematically impossible → no new trades → penalty never resets → permanent STUCK

### Solution: Plan G — Unified Multiplicative Model

```
effectiveConfidence = consensus × pwinBlendFactor × penaltyFactor
dynamicThreshold     = 50% + (totalScore × 0.5%)  →  [45%, 55%]

if effectiveConfidence ≥ dynamicThreshold → TRADE
if effectiveConfidence < dynamicThreshold → HOLD
```

**5-factor dynamic threshold** (each factor [-2, +2] with hysteresis):
| Factor | -2 (relax) | 0 (neutral) | +2 (tighten) | Sample req |
|--------|-----------|-------------|-------------|------------|
| Rolling WR | ≥55% | 40-55% | <35% | ≥10 |
| Idle cycles | ≥20 | 5-20 | <2 | — |
| Drawdown | <3% | 3-10% | >15% | — |
| Rolling Sharpe | >1.5 | 0-1.0 | <-1.0 | ≥10 |
| Regime | trending | normal/mr | chaotic | — |

**Penalty decay**: `penaltyFactor = 1.0 - min(decayedPenalty, 0.30)` where `decayedPenalty = netPenalty × max(0, 1 - cyclesIdle/30)`. After 30 idle cycles (2.5h), penalty fully decays → system self-recovers.

**6 fairness guarantees**:
1. Multi-factor balance — no single factor dominates (each ±1%)
2. Symmetric design — good = bad influence
3. Sample-size requirement — WR/Sharpe need ≥10 trades, else neutral
4. Hysteresis — buffer zones prevent boundary oscillation
5. Hard cap — threshold [45%, 55%], mathematical guarantee
6. Fact-driven — all inputs are measured, settled outcomes

**SILVER SELL simulation**:
- Old system: threshold=80%, confidence=44.5% → gap=35.5pp → HOLD (impossible)
- Plan G (idle 36 cycles): threshold=50.5%, penaltyFactor=1.0 (decayed)
  - P(win)=55%, consensus=65% → 44.5% < 50.5% → HOLD (close, 6pp gap)
  - P(win)=79%, consensus=65% → 55.4% ≥ 50.5% → TRADE ✓ (strong signal always passes)

### Files
- `src/analysis/dynamic-threshold.ts` — DynamicThresholdCalculator (5-factor hysteresis + penalty decay)
- `src/index.ts` — Conviction gate replaced: additive → multiplicative + dynamic threshold
- `src/cognition/hacp.ts` — Added `getCyclesWithoutTrade()` getter
- `tests/dynamic-threshold-attack.test.ts` — 36 attack tests
