# {MATS} — Multi-Agent Trading System

> **A self-evolving, multi-agent quantitative trading framework powered by the Hyper-Accelerated Cognition Protocol (HACP).**  
> Institutional-grade paper trading simulation across Hyperliquid perpetual markets.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.0.5--dev-blueviolet)](ARCHITECTURE.md)

## Table of Contents

- [Quick Start (Ollama)](#quick-start-ollama)
- [System Highlights](#system-highlights)
- [Architecture Overview](#architecture-overview)
- [Project Structure](#project-structure)
- [Advanced Configuration](#advanced-configuration)
- [Commercial Licensing](#commercial-licensing)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## Quick Start (Ollama)

### Prerequisites

- **Node.js 22+**
- **Ollama** (local LLM runtime — free, no API key required)

### 1. Install Ollama

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh
```

### 2. Pull a Model

MATS requires a model with strong reasoning capabilities. **DeepSeek** series is recommended:

```bash
# Primary model (used by sub-agents)
ollama pull deepseek-v4-flash:cloud

# Alternative compatible models
ollama pull qwen2.5:32b
ollama pull llama-3.3-70b-instruct
```

### 3. Start Ollama

```bash
ollama serve
```

Verify the service is running:

```bash
curl http://localhost:11434/api/tags
# Expected: JSON response listing available models
```

### 4. Clone & Install

```bash
git clone https://github.com/your-username/amacrf.git
cd amacrf
npm install
cd ui && npm install && cd ..
```

### 5. Configure Environment

```bash
cp .env.example .env
```

At minimum, set the following in `.env`:

```env
# ─── Ollama (local LLM) ───
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:cloud
```

The system defaults to **Paper Trading mode** and will never use real funds.

### 6. Launch the System

```bash
npm start
```

On first launch, the system will:
1. Auto-detect the LLM provider (Ollama → NVIDIA NIM fallback)
2. Start the HACP decision cycle (every 5 minutes by default)
3. Serve the Web UI at `http://localhost:3456`

### 7. Access the Dashboard

Open **http://localhost:3456** in your browser to see:

- 📊 **Real-time dashboard** — system status, open positions, P&L
- 🗣️ **HACP debate transcripts** — every agent's reasoning and deliberation
- 🧬 **Evolution metrics** — strategy fitness, memory utilization, GA progress
- 📈 **TradingView chart** — price action with technical analysis

---

## System Highlights

### 🧠 Multi-Agent Consensus Engine

MATS does not rely on a single AI model. Instead, **seven specialized agents think in parallel and engage in structured debate** to reach consensus:

| Agent | Role | Temperature | Weight |
|:------|:-----|:-----------:|:------:|
| **Fractal Momentum Sentinel** | Fractal pattern & trend analyst | 0.85 | 0.25 |
| **On-Chain Whisperer** | On-chain data & macro analyst | 0.50 | 0.25 |
| **RBC & Sentiment Analyst** | RBC clusters + Fear & Greed specialist | 0.25 | 0.25 |
| **News Reporter** | Multi-source news sentiment analyst | 0.40 | 0.20 |
| **Independent Risk Auditor** | 🚨 Final gatekeeper (absolute veto power) | 0.10 | 0.25 |
| **Skeptics** | 🤔 Logic auditor (cross-references all agents) | 0.30 | — |
| **Meta-Agent** | Strategic coordinator / debate chair | 0.45 | 0.35 |

Each agent operates with **independent temperature, weight, data sources, and reasoning models**, ensuring genuine opinion diversity and preventing groupthink.

### ⚡ HACP — Hyper-Accelerated Cognition Protocol

A structured multi-LLM debate protocol that replaces traditional single-model inference:

```
Phase 0:   Market Agent auto-selects trading pair + position reconciliation
Phase 1:   5 agents think in parallel (staggered, with 15s timeout)
Phase 1.5: Skeptics logic audit + EM convergence cross-cycle check
Phase 1.75: Meta-Agent final arbitration (incorporates Skeptics findings)
Phase 2:   Structured rapid debate (1-3 rounds, configurable)
Phase 3:   Weighted voting consensus (60% threshold, dynamic adjustment)
Phase 4:   Risk Auditor final veto (absolute, non-overridable)
Phase 5:   Meta-Agent dynamic TP/SL adjustment
```

**Key properties:**
- **Graceful degradation**: Any error defaults to HOLD — the system never crashes into a bad trade
- **Deterministic fallback**: If LLM is unavailable, risk engine enforces conservative defaults
- **Total cycle budget**: 120s hard timeout, forced HOLD on expiry

### 🧬 EM Self-Evolution System (Dual-Layer)

MATS has **two EM layers** that discover what makes trades profitable:

**Layer 1 — EM Cycle Chain** (`cycle-summary.ts`):
- Meta-Agent distills each cycle into a structured `CycleSummary` (E-step)
- Previous summaries feed into next cycle's agent context (M-step)
- Skeptics cross-check insight vs actual price (convergence audit)
- Tiered memory: hot(12) + warm(288) + cold(48 epochs, ~48 days)

**Layer 2 — RBC (Range-Based Clustering)** (`rbc-clustering.ts`):
- Growing hyperrectangles per symbol (winBox + lossBox), ranges only expand never contract
- 9 feature dimensions: direction, volatility, srDistanceBps, obImbalance, sentiment, signalAgreement, fundingRate, volumeRatio, sentimentConviction
- Edge score = discriminative dims / total dims → verdict: favorable/unfavorable/no_edge
- Per-symbol persistent memory (rbc-state.json, atomic write)
- Hypothetical training: compares price change between cycles, feeds directional/flat samples

**Evolutionary Pressure Engine:**
- Survival Fitness: capital preservation 35% + return 20% + consistency 15% + risk 15% + adaptability 10% + quality 5%
- ±10% mutation per generation, automatic retirement below 0.2 fitness
- Agent Outcome Tracking: per-agent, per-symbol track record

### 🧬 Trade Pattern Classifier

A supervised KNN pattern database that answers "in current conditions, has this setup won before?":

- **Two query modes**: `queryEntry()` for new positions, `queryPosition()` for held positions
- **9D feature space**: volatility, srDistanceBps, obImbalance, sentiment, signalAgreement, fundingRate, volumeRatio, sentimentConviction + regime (categorical)
- **Wilson score**: 95% confidence lower bound — prevents overfitting on small samples
- **BUY/SELL shared pool**: outcome inverted for opposite side (BUY loss = SELL win)
- **Noise filter**: |PnL| < 0.5% skipped (fee-level noise)
- **Direction priority chain**: KNN → RBC → Sentiment → Funding → OB → Regime

### 🧠 Sigmoid·GA Sentiment Engine

A genetic algorithm that evolves sigmoid-based sentiment functions to model market emotion:

- 5 signal channels: Whale Presence, Institutional Flow, Microstructure Tension, Momentum Bias, Fear/Greed Echo
- GA population of 20 chromosomes, evolved every HACP cycle
- Fitness: Sharpe × 0.5 + WinRate × 0.3 + Drawdown × 0.2
- Raw inputs: order book, volume acceleration, funding rate delta + acceleration, spread, price acceleration, large trades, F&G index, volatility regime

### 🛡️ Capital Preservation First

```
Capital preservation is the absolute first priority —
profit generation must occur within safety constraints.
```

- Independent Risk Auditor holds **absolute veto power** over any decision
- All decisions prioritize survival; profit is a secondary objective
- **Graceful degradation**: every error path defaults to HOLD
- Production-grade standards: strict TypeScript, structured logging, exponential backoff reconnection

### 🔌 LLM Abstraction Layer

Swap LLM providers without modifying a single line of code:

| Provider | Configuration | Characteristics |
|:---------|:-------------|:----------------|
| **Ollama** (default) | `OLLAMA_BASE_URL` | Local, free, no API key required |
| **NVIDIA NIM** | `NIM_API_KEY` | Cloud API, supports Llama/DeepSeek |
| Custom OpenAI-compatible | Implement `LLMProvider` interface | Any service with an OpenAI-compatible API |

The provider factory auto-detects availability: NIM → Ollama → Error.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   Layer 1: Strategic (PI Agent + SKILL.md)                   │
│   • System start / stop                                      │
│   • Performance review & parameter tuning                    │
│   • Manual intervention interface                            │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Layer 2: Cognitive (TypeScript + LLM)                      │
│   • HACP protocol (parallel multi-model inference)           │
│   • 7-agent system + meta-agent arbitration                  │
│   • Structured debate + weighted voting consensus            │
│   • Dual-layer EM self-evolution (Cycle Chain + GMM)         │
│   • LLM invoked only at critical decision points             │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Layer 3: Execution (TypeScript Runtime)                    │
│   • Hyperliquid WebSocket + REST (9 perpetual DEXs)          │
│   • Market Agent auto-selects trading pair                   │
│   • Risk engine (millisecond latency, no LLM dependency)     │
│   • Paper trading engine (leverage-aware P&L simulation)     │
│   • Real Trading Manager (exchange orders + local mirror)    │
│   • Position tracking & stop-loss/take-profit                │
│   • Data pipeline & persistence                              │
│   • Observability & health checks (6 guards)                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
src/
├── index.ts                  # 🚀 Entry point — system lifecycle (~1050 LOC)
├── config/index.ts           # Zod-validated, type-safe configuration
├── types/index.ts            # Complete domain type definitions (~650 LOC)
│
├── agents/                   # 🤖 Multi-agent system
│   ├── base-agent.ts         # Abstract agent base class
│   ├── agents.ts             # Six sub-agents (~1720 LOC)
│   ├── meta-agent.ts         # Meta-agent arbitration
│   └── agent-models.ts       # Per-agent model configuration
│
├── cognition/
│   ├── hacp.ts               # ⚡ HACP protocol implementation (~950 LOC)
│   └── a2a-utils.ts          # A2A inter-agent signal exchange
│
├── llm/                      # 🔌 LLM abstraction layer
│   ├── provider.ts           # Abstract interface
│   ├── nim-provider.ts       # NVIDIA NIM implementation
│   ├── ollama-provider.ts    # Ollama implementation
│   └── index.ts              # Provider factory (auto-detection)
│
├── trading/                  # 💹 Trading engine
│   ├── portfolio.ts          # Portfolio tracker (leverage-aware P&L, trade lifecycle)
│   ├── paper-engine.ts       # Paper trading simulation
│   ├── real-trading-manager.ts # Real trading orchestrator
│   └── hyperliquid-real-engine.ts # Hyperliquid real trading
│
├── risk/                     # 🛡️ Risk management
│   ├── engine.ts             # Multi-layer risk engine
│   └── correlation-budget.ts # Cross-pair correlation budget
│
├── system-guard/             # 🛡️ SystemGuard (6 guards)
│
├── evolution/                # 🧬 Dual-layer EM evolution + pattern classifier
│   ├── index.ts              # Evolution orchestrator (~420 LOC)
│   ├── trade-history.ts      # Trade history ledger
│   ├── agent-outcomes.ts     # Per-agent performance tracking
│   ├── persistence.ts        # Durable state persistence
│   ├── trade-pattern-classifier.ts # 🧬 Supervised KNN pattern DB (v2.0.5)
│   ├── em-clustering.ts      # 🧬 GMM EM clustering engine (v2.0.5)
│   └── cycle-summary.ts      # 🧬 EM Cycle Summary Manager (v2.0.2)
│
├── analysis/                 # 📊 Signal processing
│   ├── sentiment-engine.ts   # Sigmoid·GA sentiment engine
│   ├── sigmoid-ga.ts         # GA-evolved sigmoid functions
│   └── support-resistance.ts # SNR zone detection
│
├── market-agent/             # 🎯 Auto pair selection + position size/leverage
├── backtest/                 # 📜 Historical backtesting engine
├── observability/logger.ts   # Structured logging (Winston)
├── api-server.ts             # REST + SSE API (~950 LOC)
└── utils/shutdown.ts         # Graceful shutdown handler

ui/                           # 🖥️ React Web UI (pantha_mats design system)
├── src/
│   ├── App.tsx               # Main dashboard (collapsible rounds, badges)
│   ├── TradingViewChart.tsx  # TradingView chart integration
│   ├── StarsBackground.tsx   # Dynamic starfield background
│   └── types.ts              # UI type definitions
└── index.html

scripts/                      # 🛠 One-time utilities
├── loop-engineering.sh       # Loop engineering runner
├── loop-engineering-deep.sh  # Deep session runner
├── loop-engineering-memory.md # Known issues / checklist
└── backfill-patterns.mjs     # Import portfolio trades into pattern DB

data/                         # 💾 Runtime persistence
└── evolution/
    ├── trade-patterns.json   # Pattern DB (1000 max)
    ├── rbc-state.json        # RBC state (winBox, lossBox per symbol)
    ├── evolution-state.json  # GA population + memory + strategies
    └── portfolio-state.json  # Portfolio snapshot
```

---

## Advanced Configuration

### Using NVIDIA NIM (Cloud LLM)

If you have an NVIDIA NIM API key, set it in `.env`:

```env
NIM_API_KEY=nvapi-xxxxxxxxxxxx
NIM_BASE_URL=https://integrate.api.nvidia.com/v1
```

The system auto-detects NIM and prioritizes it, with Ollama as fallback.

### Hyperliquid Real Trading

```env
HYPERLIQUID_WALLET_ADDRESS=0x...
HYPERLIQUID_PRIVATE_KEY=...
```

The system defaults to **paper trading** — set `TRADE_MODE=real` in `.env` to enable live trading.

### Decision Cycle Tuning

```env
DECISION_INTERVAL_MS=300000    # 5min between decision cycles
HACP_MAX_DEBATE_ROUNDS=3       # Maximum debate rounds
HACP_CONSENSUS_THRESHOLD=0.60  # Consensus threshold (60%, dynamically adjusted)
```

### Risk Parameters

```env
RISK_MAX_LEVERAGE=10.0         # Maximum leverage (Market Agent controls actual)
RISK_STOP_LOSS_PCT=0.02        # Default stop-loss (2%)
RISK_TAKE_PROFIT_PCT=0.05      # Default take-profit (5%)
RISK_VETO_THRESHOLD=0.85       # Risk auditor veto threshold
```

---

## Commercial Licensing

**Pantha AI Labs** holds a perpetual, irrevocable commercial license to use, modify, and distribute MATS. This license is governed by a separate agreement between YC Wong and Pantha AI Labs, and is independent of the Apache 2.0 open-source license.

For all other use, MATS is open source under the **Apache License 2.0**.

If you require a commercial license — for example, for proprietary extensions, redistribution without open-source obligations, or enterprise support — please contact YC Wong.

---

## Tech Stack

| Category | Technology |
|:---------|:-----------|
| **Language** | TypeScript 5.6 (strict mode, zero type errors) |
| **Runtime** | Node.js 22+ |
| **LLM** | Ollama / NVIDIA NIM / OpenAI-compatible |
| **Market Data** | Binance WebSocket / Hyperliquid REST |
| **Frontend** | React 18 + Vite + TradingView Chart |
| **Config Validation** | Zod schema |
| **Logging** | Winston (structured + file rotation) |
| **Codebase** | ~14,000+ LOC TypeScript + React UI |

---

## License

[Apache License 2.0](LICENSE)

Copyright (c) 2026 YC Wong

Pantha AI Labs holds a perpetual commercial license under a separate agreement.
