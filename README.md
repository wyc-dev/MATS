# MATS — The First Self-Evolving AI Trading Brain

**Terminal Agent + 6 AI agents debate every trade. A Skeptics agent vetoes bad ones. The system evolves its own strategy — no manual tuning.**

MATS is a multi-agent cognitive trading system: Terminal Agent enforces user-defined trading rules via Root Command Prompt, 6 specialized agents think in parallel, debate through the HACP protocol, and reach weighted consensus. A dedicated Skeptics agent stress-tests every position against historical experience data. The system self-evolves via online logistic regression (OLR) + shadow trading + first-passage path-risk + EM cycle chains + genetic algorithms + **RIL (Reason Intelligence Layer)** — it learns from every trade and adapts its own parameters.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/wyc-dev/MATS?style=social)](https://github.com/wyc-dev/MATS)

🌐 [mats.trading](https://mats.trading/) · 💬 [Discord](https://discord.gg/mats) (coming soon) · ⭐ [Star on GitHub](https://github.com/wyc-dev/MATS)

---

## 📸 See It In Action

<a href="https://github.com/wyc-dev/MATS/blob/main/docs/dashboard.mp4" target="_blank" title="Click to play the full 16s demo">
  <img src="docs/dashboard.gif" alt="MATS Dashboard demo — 8 AI agents debate every trade in real time" width="100%">
</a>

*8-second loop. [Click for the full 16s demo video](https://github.com/wyc-dev/MATS/blob/main/docs/dashboard.mp4) — real-time HACP debate, Skeptics validation, weighted consensus, live TP/SL on TradingView, self-evolution metrics.*

---

## Quick Start (Ollama)

### Prerequisites
- Node.js 22+, npm
- [Ollama](https://ollama.com) running locally (or Pro plan for cloud models)

### 1. Install Ollama & Pull a Model
```bash
# macOS: brew install ollama  |  Linux: curl -fsSL https://ollama.com/install.sh | sh
ollama serve
ollama pull deepseek-v4-flash   # primary model used by sub-agents
```

### 2. Clone & Install
```bash
git clone https://github.com/wyc-dev/MATS.git
cd MATS && npm install
cd ui && npm install && cd ..
```

### 3. Configure Environment
```bash
cp .env.example .env
# Edit .env — key vars:
#   OLLAMA_BASE_URL=http://localhost:11434
#   OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:cloud
#   DECISION_INTERVAL_MS=300000   # 5-min cycles
#   API_PORT=3456
#   HYPERLIQUID_WALLET_ADDRESS=   # optional, for real trading
#   HYPERLIQUID_PRIVATE_KEY=      # optional, RADIOACTIVE — never commit
```

### 4. Launch
```bash
npm run dev    # concurrently: tsx watch (API :3456) + vite (UI :5173)
```
Open **http://localhost:5173/** for the dashboard. The API server runs on :3456.

---

## Why MATS is Different

- **🧠 Terminal Agent + Root Command Prompt** — users type natural language trading preferences (e.g. "only trade on Monday GMT"). LLM integrates them into a Root Command Prompt. Before each cycle, rules are checked — if a rule fails, the entire cycle is aborted (no token cost). After Meta-Agent decides, Terminal Agent verifies the decision matches user preferences.
- **🧠 Entry Thesis System** — every trade needs a validated `[1h: ...] [1d: ...]` rationale. Meta-Agent generates it; Skeptics stress-tests it. No thesis → no trade.
- **🛡️ Skeptics veto** — an AI stress-tests every position's logic, data consistency, and dark-psychology (whale manipulation?) before execution. Approve-first: rejects only on concrete money-losing flaws.
- **🧬 Self-evolving** — OLR learns P(win) per side from shadow + paper + real trade outcomes. First-Passage gives instant path-risk. GA mutates strategy parameters by weakest fitness dimension. EM cycle chain carries insights across cycles. RIL clusters entry rationales by historical win rate.
- **⚡ HACP protocol** — Terminal Agent checks rules → 5 sub-agents think in parallel (staggered, 60s deadline race), Skeptics audits, Meta-Agent arbitrates, weighted voting consensus, Terminal Agent verifies. 120s hard timeout → HOLD on expiry.
- **💰 Capital preservation first** — every error path defaults to HOLD. SystemGuard (5 layers). Notional-based fees. SL/TP hard safety layers. Configurable max portion + drawdown + daily-loss limits.
- **⚙️ Trading Setup** — UI config panel for trade mode, cycle period (1-10m), position size, max portion, leverage, asset type, and market selection. Separate from Root Command Prompt (behavioral rules only).

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│   Layer 1: Strategic (Terminal Agent)                        │
│   • User preferences → Root Command Prompt                   │
│   • Pre-cycle rule check + post-cycle decision verification  │
├──────────────────────────────────────────────────────────────┤
│   Layer 2: Cognitive (TypeScript + LLM)                      │
│   • HACP protocol (parallel multi-model inference)            │
│   • 6-agent system + Meta-Agent arbitration + Skeptics gate   │
│   • Entry Thesis System + dark psychology + weighted voting   │
│   • Self-evolution (OLR + Shadow + First-Passage + EM + GA)   │
│   • RIL Reason Intelligence (pattern clustering + similar     │
│     trade retrieval + subtle diff LLM analysis)               │
│   • Trade Incident Panel (MAE/MFE + exitThesis + post-review) │
├──────────────────────────────────────────────────────────────┤
│   Layer 3: Execution (TypeScript Runtime)                     │
│   • Hyperliquid WebSocket + REST (9 perpetual DEXs)           │
│   • Risk engine (millisecond, no LLM)                         │
│   • Paper/Real trading with unified execute/close routing     │
│   • Position tracking & SL/TP · persistence · observability   │
└──────────────────────────────────────────────────────────────┘
```

→ Full architecture in [ARCHITECTURE.md](ARCHITECTURE.md)

---

## System Components

### Agent System

| # | Agent | Role |
|:-:|:------|:-----|
| 0 | **Terminal Agent** | User natural language preferences → Root Command Prompt. Pre-cycle rule check (abort if rule fails) + post-cycle decision verification. |
| — | **Trading Setup** | UI config panel (not an LLM agent). Trade mode, cycle period, position size, leverage, asset type, market selection. |
| 1 | **Fractal Momentum Sentinel** | Multi-timeframe fractal breakout detection. Early trend acceleration signals. |
| 2 | **On-Chain Whisperer** | Category-aware on-chain analysis: crypto (mempool, flows, supply) + TradFi (DXY, COT, commodities). |
| 3 | **OLR & Sentiment Analyst** | OLR P(win) per side + First-Passage path-risk + Fear & Greed sentiment. RR-aware edge vs breakeven. |
| 4 | **News Reporter** | Institutional Narrative Decoder. 5-part framework: information-asymmetry, price-news timing, motive taxonomy, power-map, net institutional signal. |
| 5 | **Independent Risk Auditor** | Advisory-only (no veto). TP/SL/size suggestions + hard-coded loss-streak/choppy-market limits. |
| 6 | **Skeptics** | Logic auditor + thesis stress-tester. Approve-first; rejects only on concrete flaws. Validates entryThesis + re-validates held positions each cycle. |
| 7 | **Meta-Agent** | Arbitration chairman. Detective mode. Generates entryThesis. Uses Confidence Calibration Framework. Weight 0.00 (thesis system controls, not voting). |

> All agents have user-selectable model dropdowns in the UI.

### HACP Protocol

Each cycle (1-10 min, user-configurable): Terminal Agent checks rules → 5 sub-agents think in parallel (60s deadline) → Skeptics audits → Meta-Agent arbitrates with RIL reference data → Skeptics validates entryThesis → structured debate → weighted voting consensus → Terminal Agent verifies. 120s hard timeout → HOLD.

### Self-Evolution System

| Component | File | What it does |
|:----------|:-----|:-------------|
| **OLR** | `olr-engine.ts` | Per-symbol, per-side online logistic regression. Learns P(win) from shadow + paper + real trade outcomes (TP-before-SL). Tracks per-source sample counts (shadow/paper/real) so agents know data composition. |
| **Shadow Trading** | `shadow-trade-engine.ts` | Opens simulated LONG + SHORT every cycle with fixed S/R SL/TP. Tracks intra-cycle high/low for correct TP-before-SL resolution. Records MAE/MFE path-risk per trade. Feeds outcomes to OLR with source='shadow'. |
| **First-Passage** | `first-passage.ts` | Instant P(TP before SL) from volatility (σ) + log-drift (ν) + SL/TP distances. Cox & Miller GBM formula. RR-aware: compares to breakeven P, not 50%. |
| **EM Cycle Chain** | `cycle-summary.ts` | Meta-Agent distills each cycle into a key insight. Previous insights injected into next cycle's context. Semantic retrieval of similar historical cycles. Tiered memory: hot(12) + warm(288) + cold(48 epochs). |
| **Cold-Start Backfill** | `olr-backfill.ts` | First cycle per market replays 186 historical HL M5 candles into OLR. Non-blocking, idempotent. |
| **GA + Pattern DB** | `sigmoid-ga.ts` + `trade-pattern-classifier.ts` | GA evolves sigmoid sentiment function by weakest fitness dimension. KNN pattern DB with Wilson-score confidence + time-weighted win/loss. |

### RIL — Reason Intelligence Layer

| Component | What it does |
|:----------|:-------------|
| **PatternClusterManager** | Greedy cosine clustering of entry rationale texts (MiniLM 384-d). Shows per-pattern win rate + PnL. Incrementally updated on every trade close. |
| **CloseReasonAggregator** | Groups closed trades by exit type (SL/TP, consensus, manual, thesis invalidation) × decision origin. Shows per-close-reason win rate + avg PnL. |
| **SimilarTradeRetriever** | Finds top-N most similar historical trades to a candidate thesis using cosine similarity on rationale vectors. Injected before Skeptics validation. |
| **SubtleDiffAnalyzer** | 1 LLM call per cycle. Compares candidate trade vs similar historical winners/losers. Identifies subtle differences (volume, RSI, regime, S/R proximity). |
| **EXP checkThesisHistory** | Candidate thesis → extract rationales → embed → cosine similarity vs all historical records → similarity-weighted P(win) → PASS/REJECT/REVERSE verdict. Dual-Channel Fusion with OLR + shadow win rate. |
| **Experience Digester** | LLM digests each trade into a lesson statement → embed → cluster into lesson classes. Classifies candidates against winning/losing lesson classes. |

### Trade Incident Panel

Replaces the old Positions table + Trade Records with a unified card-based view. Each trade (paper + real, open + closed) is a card showing:

- **Summary**: Symbol, side, status, PAPER/REAL tag, PnL
- **Entry/Exit Price**: With SL/TP levels
- **Min/Max Value Reached**: MAE/MFE — position value (margin + unrealized PnL) at its worst/best
- **Entry Thesis**: Meta-Agent's frozen rationale at open
- **Exit Thesis**: Close rationale with SL/TP narrowing analysis (original vs final SL/TP comparison)
- **Post-Review**: LLM auto-generated post-trade review analysing how more profit could have been made or less loss incurred

### Risk Management

| Parameter | Default | Description |
|:----------|:-------:|:------------|
| Max position | 20% | Single trade cap of equity (hard clamp) |
| Max drawdown | 20% | Halt all trading above this |
| Daily loss limit | 5% | No new trades rest of day |
| Max leverage | 10x | Market Agent sets per-asset; Meta-Agent tunes 1-10x |
| Stop loss | 2% | Per trade (un-leveraged) |
| Take profit | 5% | Per trade (un-leveraged) |
| Cumulative margin | 20% | All positions' margin ≤ 20% balance |

SL/TP three-layer safety: no-widen + not-too-tight (SL ≥ 1%, TP ≥ 1.5%) + min-gap + max-narrow-step. Original SL/TP recorded at open for exit-thesis narrowing detection.

---

## Configuration

```bash
# .env essentials (validated by Zod schema on startup)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:cloud
DECISION_INTERVAL_MS=300000          # 5-min cycles
API_PORT=3456
PAPER_INITIAL_BALANCE=1000
PAPER_MAX_POSITION_SIZE_PCT=0.20
PAPER_MAX_DRAWDOWN_PCT=0.20
RISK_STOP_LOSS_PCT=0.02
RISK_TAKE_PROFIT_PCT=0.05
HACP_CONSENSUS_THRESHOLD=0.60
HACP_TOTAL_TIMEOUT_MS=120000
# Real trading (optional):
HYPERLIQUID_WALLET_ADDRESS=
HYPERLIQUID_PRIVATE_KEY=             # RADIOACTIVE — never commit
# RIL:
RIL_ENABLED=true
RIL_SIMILAR_TRADE_COUNT=5
RIL_SUBTLE_DIFF_ENABLED=true
```

### Per-Symbol Direction Restrictions
Restrict a symbol to BUY-only or SELL-only via API or `data/evolution/market-agent-config.json`.

---

## Tech Stack

| Category | Technology |
|:---------|:-----------|
| **Language** | TypeScript 5.6 (strict mode, zero type errors) |
| **Runtime** | Node.js 22+ |
| **LLM** | Ollama (local + Pro cloud) / OpenAI-compatible |
| **Market Data** | Hyperliquid WebSocket (l2Book + trades + userFills) + REST fallback |
| **Frontend** | React 18 + Vite + TradingView Chart |
| **Config** | Zod schema validation |
| **Logging** | Winston (structured + file rotation) |
| **Testing** | vitest |
| **Crypto** | `@noble/curves` (HL phantom agent signing) |
| **Vector Embedding** | Transformers.js MiniLM L6 v2 (384-dim, in-process, CPU) |

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

---

## Community

- 🌐 **Homepage**: [mats.trading](https://mats.trading/)
- 💬 **Discord**: [coming soon — star + watch to be notified](https://github.com/wyc-dev/MATS)
- 🤝 **Contributing**: PRs welcome! Fork → branch → PR. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system overview.

## Roadmap

- **Backtest visualization** — equity curve + trade markers in the dashboard UI
- **More exchanges** — Binance Futures, OKX, additional perp DEXs
- **Decision audit UI** — gate-by-gate HACP decision flow visualization
- **Multi-model ensemble** — per-agent model routing across Ollama / cloud providers

---

## Commercial Licensing

**Pantha AI Labs** holds a perpetual, irrevocable commercial license. For all other use, MATS is open source under **Apache License 2.0**. Contact YC Wong for commercial licensing.

## License

[Apache License 2.0](LICENSE) · Copyright (c) 2026 YC Wong
