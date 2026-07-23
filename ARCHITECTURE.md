# {MATS} — Multi Agent Trading System

> **作者**: YC Wong · **版本**: 2.0.219
> **核心哲學**: 資本保存為絕對第一優先，但必須在安全前提下持續創造盈利
> **代碼量**: ~58,000 行 TypeScript（嚴格模式，零類型錯誤）+ React UI

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
| **自我演化** | 22 層認知演化管線 — OLR + Shadow Trading + First-Passage + EM Cycle Chain + GA + RIL + NA + AttnRes + Combo WR Gate + P(win)×Consensus Discount + 7 advanced systems v2.0.219 + Close-Context Learning v2.0.226，從每筆交易學習 |
| **唔靠過去 P&L** | 過去 drawdown/losses 唔係拒絕交易嘅理由——OLR 持續學習，市況不斷變化 |
| **多資產單循環** | 所有交易市場單一 HACP 循環分析；無持倉市場以 isTradingMarket=true 注入 |
| **生產級標準** | 完整型別（Zod 驗證）、結構化日誌（Winston）、優雅關閉、指數退避重連 |

---

## 三層架構

```
┌──────────────────────────────────────────────────────────────┐
│   Layer 1: 戰略層 (PI Agent + Terminal Agent)                  │
│   • Terminal Agent：用戶自然語言偏好 → Root Command Prompt      │
│   • 啟動/停止系統 · 績效審查 & 參數調整 · 人工干預入口         │
├──────────────────────────────────────────────────────────────┤
│   Layer 2: 認知層 (TypeScript + Ollama)                       │
│   • HACP 多模型平行推理（僅關鍵決策點觸發 LLM）                 │
│   • Terminal Agent Cycle 前置規則檢查 + 後置決策核實             │
│   • 6 智能體 + Meta-Agent 仲裁 + Skeptics 邏輯審查             │
│   • Entry Thesis System + 暗黑心理學 + 結構化辯論 + 加權投票    │
│   • Self-Evolution（OLR + Shadow + First-Passage + EM + GA）   │
│   • RIL Reason Intelligence Layer（pattern clustering + close   │
│   │  reason stats + similar trade retrieval + subtle diff LLM） │
│   • Numeric Autoencoder（learned market-condition embedding）   │
│   • AttnRes Cycle-History Retrieval（K3 transfer, dual pseudo-  │
│   │  query: wDecision + wExecution, v2.0.211-v2.0.212）          │
│   • Anti-Pattern Tracker（failure lesson clustering）           │
│   • Conditional WR Soft Gate（code-level conviction penalty）    │
│   • Combo WR Gate（symbol×side×regime WR, Wilson LB, v2.0.221） │
│   • OLR P(win)×Consensus Discount（multiplicative, v2.0.224）   │
│   • Replay Buffer（PER, mini-batch retrain, v2.0.219）         │
│   • Bayesian OLR（MC Dropout uncertainty, v2.0.219）          │
│   • Temporal Attention（cross-trade regime learning, v2.0.219）│
│   • Cross-Symbol Backbone（shared+residual transfer, v2.0.219）│
│   • Reward Shaping（5-component risk-adjusted reward, v2.0.219）│
│   • Active Exploration（UCB + info gain + annealing, v2.0.219） │
│   • World Model（latent dynamics + rollout planning, v2.0.219）│
│   • Close-Context Learning（closeReason+slNarrowed 加權, v2.0.226）│
│   • Trade Incident Panel（MAE/MFE + exitThesis + post-review）  │
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
├── trading/                 # portfolio · paper-engine · trading-manager · hyperliquid-engine · position-utils · cost-model
│   │   v2.0.172: real-trading-manager → trading-manager, hyperliquid-real-engine → hyperliquid-engine
│   │   v2.0.173: position-utils.ts 共享 helper（computeSLTP, recomputePnL, trackMAEMFE）
│   │   v2.0.143: executeTrade() / closeTrade() 統一路由
├── risk/                    # 風險引擎 + correlation-budget
├── system-guard/            # 5 層保護閘門
├── evolution/               # 自我演化（22 層認知演化管線：OLR + Shadow + First-Passage + EM + GA + RIL + EXP + NA + AttnRes + Anti-Pattern + Combo WR + P(win) Discount + 7 advanced systems v2.0.219 + Close-Context Learning v2.0.226）
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
│   ├── bayesian-olr.ts     # Bayesian OLR wrapper（MC Dropout uncertainty, v2.0.219）
│   ├── temporal-attention.ts # Temporal Attention（cross-trade regime learning, v2.0.219）
│   ├── cross-symbol-backbone.ts # Cross-Symbol shared+residual（transfer learning, v2.0.219）
│   ├── reward-shaping.ts   # Reward Shaping（5-component risk-adjusted, v2.0.219）
│   ├── active-exploration.ts # Active Exploration（UCB + info gain, v2.0.219）
│   ├── world-model.ts     # World Model（latent dynamics + rollout, v2.0.219）
│   ├── reason-analytics.ts  # RIL（per-direction win rates + direction-filtered similar trades v2.0.176）
│   ├── evolution-utils.ts   # 共享 utils（safeNum v2.0.218, wilsonScore, computeVectorConditionalWinRate + rmsNormKeys + softmaxWeightedWR v2.0.211）
│   ├── direction-audit.ts   # LLM 交易記錄審計（v2.0.180）
│   └── system-engineer.ts   # 自主代碼工程師 Agent（v2.0.182）
├── analysis/                # sentiment · S/R · ATR（momentum-adaptive SL v2.0.207 #C）· planck-chaos · options · news
├── market-agent/            # 自動 pair 選擇（9 DEX, 416 assets, 類別過濾）
├── data/                    # Hyperliquid + Binance WebSocket
├── api-server.ts            # REST + SSE (:3456) + static UI
└── index.ts                 # 系統 orchestrator（決策循環）
ui/                          # React + Vite dashboard (:5173)
data/evolution/              # olr-state · shadow-state · patterns · GA state · em-state · na-model · cycle-history · anti-patterns
tests/                       # vitest（179 tests，9 test files）
```

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
| 0 | **Terminal Agent** | 0.30 | — | 用戶自然語言偏好入口。接受交易偏好指令 → LLM 整合 → Root Command Prompt。Cycle 開始前檢查規則（時間/條件/資產），不符合即 abort cycle。Meta-Agent 決策後核實是否符合 Root Command Prompt。預設 DeepSeek V4 Flash。 |
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

MATS 嘅核心競爭力係 **22 層認知演化管線**——每筆交易結果都會餵回 22 個獨立學習系統，系統唔係固定規則，而係一個會進化嘅認知引擎。以下逐層詳述：

### OLR — Online Logistic Regression（`olr-engine.ts`）

Per-symbol, per-side online logistic regression 從 shadow + paper + real + backfill 嘅 TP-before-SL 結果學習 P(win)。每個 feature 獨立計數，缺失 feature 返回中性 z=0。Source-weighted SGD updates（real=4, paper=2, shadow=1, backfill=0.3）。Confidence: high(≥50) / medium(≥20) / low(<20) samples。

**v2.0.143 來源追蹤**：每個 OLR model 記錄 `shadowSamples` / `paperSamples` / `realSamples` 三個獨立計數器。Agent context 顯示數據構成：`BUY P(win)=60% (30 samples, medium | shadow=15 paper=10 real=5)`。如果 model 主要由 shadow samples 訓練（固定 SL/TP），agent 可降低信任度。

### Shadow Trading（`shadow-trade-engine.ts`）

每個 cycle 為每個 trading market 開模擬 LONG + SHORT，S/R-aligned SL/TP。Intra-cycle high/low 追蹤（正確判定 TP-before-SL）。學 TP-before-SL（真實可盈利性），唔係 5 分鐘價格方向。

**v2.0.143 改進**：
- **MAE/MFE path-risk 追蹤**：每筆 shadow trade 記錄 Maximum Adverse/Favorable Excursion。Agent context 顯示 `avg MFE=3.2% avg MAE=1.8%`，讓 agent 看到「trades 平均先賺 3% 再虧到 SL」= 方向對但 exit timing 有問題。
- **Per-symbol funding rate**：非 active symbol 不再用 active symbol 的 funding rate，改用 per-symbol HL WS mark price cache。
- **Shadow soft gate**：當 shadow samples ≥ 10 且 win rate < 25%，override 為 HOLD（方向根本性錯誤）。
- **OLR 來源標記**：shadow outcomes 餵入 OLR 時標記 `source='shadow'`，不再與 paper/real 混在一起無法區分。

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

**TP/SL 設定於入場時，入場後永不修改（v2.0.225）**：ATR（1.5×）或 S/R 計算，入場後不再收窄。Trailing stop、MFE giveback、TP narrowing、per-symbol consensus SL/TP 全部停用——入場後收窄導致提前止蝕 + UI/交易所 SL desync。兩層退出保護：(1) 初始 SL/TP 交易所層面觸發，(2) LLM thesis invalidation（Skeptics Phase 0.5 強制平倉）。Portfolio 安全層：no-widen + not-too-tight（SL ≥ 1%, TP ≥ 1.5%）+ min-gap 2%。

**累計 Margin 上限 20%**：所有持倉 margin 總和 ≤ 20% balance（基於 margin 而非 notional）。

---

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

**Advanced learning PnL 縮放**：`feedAdvancedLearning` 嘅 `pnl` + `pnlPct` 乘以 `learningWeight`。AttnRes reward-weighted regression、temporal attention、cross-symbol backbone、world model 都按權重學習。

---

## Paper Trading 模擬層

- 槓桿感知 P&L：notional-based 雙邊手續費扣除
- 每個 price update 自動檢查 SL/TP + 追蹤 MAE/MFE（部位價值 = margin + unrealized PnL）
- Position Reconciliation：偵測 exchange 已平倉 → 同步 local mirror
- Real Trading Manager：HL exchange 下單 + 本地 mirror（phantom agent signing via `@noble/curves`）
- **v2.0.143 統一交易路由**：`executeTrade()` 按 tradeMode 路由 — paper 直接走 paperEngine，real 走 realTradingManager。`closeTrade()` 按 agentId 路由 — paper 走 portfolio.closePosition()，real 走 realTradingManager.closePosition()。不再所有交易都經過 RealTradingManager。
- **v2.0.143 entryThesis 修復**：執行成功後才調用 `setEntryThesis()`，確保 thesis 在 position 存在時才寫入。syncExchangePositions 的 close+reimport 路徑保留 entryThesis + MAE/MFE。
- placeOrder 價格源：LIVE `l2Book`（best bid/ask）做 aggressive price 主源，`allMids` REST 做 fallback

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
`lockedWrite()` atomic write。State files: `olr-state.json` · `shadow-state.json` · `trade-patterns.json` · `evolution-state.json` · `portfolio-state.json` · `market-agent-config.json` · `debate-history.json` · `em-state.json` · `na-model.json` · `cycle-history.json` · `anti-patterns.json` · `root-command-prompt.json` · `loop-engineering-memory.json` · `exp-embeddings.json`。

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
| Testing | vitest（179 tests，9 test files） |
| Crypto | `@noble/curves`（HL phantom agent signing） |
| Vector Embedding | Transformers.js MiniLM L6 v2（384-dim, in-process, CPU） |
| Pattern Clustering | Greedy cosine clustering（RIL Reason Intelligence Layer） |

---

## 啟動

```bash
npm run engineer    # 自主進化模式：交易 + System Engineer 自主修復 + 修復後自動重啟
```
Dashboard: **http://localhost:5173/** · API: **http://localhost:3456/api/status**

`npm run engineer` 是唯一支援的生產啟動模式。流程：
1. `engineer-loop.sh` 啟動 `tsx src/index.ts`（`SYSTEM_ENGINEER_ENABLED=true`）
2. 交易系統正常運行，每 2 個 cycle（cycle period ≥ 5 min 時）觸發 System Engineer
3. System Engineer 審查交易記錄 + 源代碼 → 生成修復 → `tsc --noEmit` + `npm test` 驗證
4. 全部通過 → git commit → `process.exit(42)` → `engineer-loop.sh` 偵測 exit code 42 → 重啟進程
5. 任何失敗 → 自動 rollback（恢復原始文件）→ 繼續運行
6. 重啟後加載新代碼 → 繼續交易 → 2 個 cycle 後再檢查 → 循環

**安全設計**：
- System Engineer 只可修改 `src/evolution/` + `src/cognition/` + `src/analysis/` + `src/agents/` + `tests/`
- 禁止觸碰 `src/trading/`（下單/SL/TP/簽名）+ `src/config/`（風險設置）+ `src/index.ts` + `.env`
- tsc + test 安全網：任何失敗 → 自動 rollback，不會應用未驗證的代碼
- 重啟期間持倉由 HL 交易所的 SL/TP trigger orders 保護，不依賴本地進程

---

> 完整版本歷史請見 [CHANGELOG.md](CHANGELOG.md)。


## System Engineer Update
Added `applyLossStreakGateToDecision()` method to MATSSystem class that calls the existing `checkLossStreakGate()` method in the decision cycle. This is the missing injection point — the guard existed but was never invoked. The new method is called for the active symbol's final decision and for each per-symbol consensus entry decision, blocking BUY/SELL when the loss streak or systematic loser threshold is exceeded.


## System Engineer Update
LossStreakTracker now has three layers: (1) SOFT gate at 3 consecutive losses in same regime → +50% conviction penalty. (2) HARD gate at 5 consecutive losses in any regime → block for 12 cycles. (3) SYSTEMATIC LOSER gate at >= 10 trades with WR < 35% → block until WR recovers above 40%. The HARD and SYSTEMATIC LOSER gates are checked BEFORE the SOFT gate returns, so they take priority. The SOFT gate no longer returns early, allowing the HARD gate to be reached.


## System Engineer Update
The OLR query() method now applies applyConfidencePenalty() to the calibrated pWin before returning it to agents. The effective sample size (excluding backfill) is used for the penalty calculation, preventing backfill samples from inflating the sample count and bypassing the penalty. This ensures agents see calibrated probabilities that reflect true model uncertainty, preventing extreme P(win) values (0% or 100%) from overriding safety gates.


## System Engineer Update
The OLR engine's query() method now applies a three-layer safety net: (1) existing Bayesian confidence penalty for low-sample models, (2) NEW inverse-sample-count confidence penalty applied to ALL queries regardless of sample count, which scales the pull toward 0.5 with the inverse of effective sample size, and (3) NEW hard clamp that prevents sigmoid saturation to exactly 0% or 100%. The clamp ranges are [0.05, 0.95] for models with <50 samples and [0.01, 0.99] for models with >=50 samples. This ensures that even well-trained models with 100+ samples cannot output extreme values that override safety gates, while preserving the model's signal when it has strong evidence.


## System Engineer Update
The query() method now accepts an optional 5th parameter `currentFeatures: Record<string, number> | undefined`. When provided, these fresh market features are used for the sigmoid computation (logit → pWin) instead of the features passed to query(). The currentFeatures are NOT fed into Welford normalization or SGD training — those still use the original features from feedTrade(). This ensures the model trains on the features that were actually present at trade entry, but predicts using the features that reflect current market conditions. The shadow trade engine's getStats() method should pass current cycle features when computing P(win) for the active symbol.


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
