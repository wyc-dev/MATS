# {MATS} — Multi-Agent Trading System

> **A self-evolving, multi-agent quantitative trading framework powered by the Hyper-Accelerated Cognition Protocol (HACP).**  
> Institutional-grade paper trading simulation across Hyperliquid markets.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![Code Style](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://prettier.io/)

---

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
- **Binance API Key** (free tier, read-only permissions sufficient)

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

> **Note:** `BINANCE_API_KEY` requires only read permissions for WebSocket market data — no trading permissions needed.  
> The system defaults to **Paper Trading mode** and will never use real funds.

### 6. Launch the System

```bash
npm start
```

On first launch, the system will:
1. Auto-detect the LLM provider (Ollama → NVIDIA NIM fallback)
2. Start the HACP decision cycle (every 60 seconds by default)
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
| **Regime Risk Guardian** | Market regime + Fear & Greed specialist | 0.25 | 0.25 |
| **News Reporter** | Multi-source news sentiment analyst | 0.40 | 0.20 |
| **Independent Risk Auditor** | 🚨 Final gatekeeper (absolute veto power) | 0.10 | 0.25 |
| **Skeptics** | 🤔 Logic auditor (cross-references all agents) | 0.30 | — |
| **Meta-Agent** | Strategic coordinator / debate chair | 0.45 | 0.35 |

Each agent operates with **independent temperature, weight, data sources, and reasoning models**, ensuring genuine opinion diversity and preventing groupthink.

### ⚡ HACP — Hyper-Accelerated Cognition Protocol

A structured multi-LLM debate protocol that replaces traditional single-model inference:

```
Phase 0:   Market Agent auto-selects trading pair + position reconciliation
Phase 1:   5 agents think in parallel (Promise.all with 15s timeout)
Phase 1.5: Skeptics logic audit (cross-reference, consistency check)
Phase 1.75: Meta-Agent final arbitration (incorporates Skeptics findings)
Phase 2:   Structured rapid debate (1-3 rounds, configurable)
Phase 3:   Weighted voting consensus (60% threshold)
Phase 4:   Risk Auditor final veto (absolute, non-overridable)
Phase 5:   Meta-Agent dynamic TP/SL adjustment
```

**Key properties:**
- **Graceful degradation**: Any error defaults to HOLD — the system never crashes into a bad trade
- **Deterministic fallback**: If LLM is unavailable, risk engine enforces conservative defaults
- **Total cycle budget**: 120s hard timeout, forced HOLD on expiry

### 🧬 Self-Evolution System

MATS continuously **evaluates, retires, mutates, and evolves** its own trading strategies:

- **Dual Memory System**: Short-term (100 entries) + long-term (1,000 entries) with automatic consolidation
- **Survival Fitness Function**: Capital preservation (35%) + return generation (20%) + consistency (15%) + risk management (15%) + adaptability (10%) + decision quality (5%)
- **Evolutionary Pressure Engine**: ±10% mutation per generation, automatic retirement below 0.2 fitness
- **Agent Outcome Tracking**: Per-agent, per-symbol historical performance records injected into agent context

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
│   Layer 2: Cognitive (TypeScript + LLM)                     │
│   • HACP protocol (parallel multi-model inference)           │
│   • 7-agent system + meta-agent arbitration                   │
│   • Structured debate + weighted voting consensus             │
│   • Self-evolution (meta-evolution)                           │
│   • LLM invoked only at critical decision points              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Layer 3: Execution (TypeScript Runtime)                     │
│   • Binance WebSocket real-time data feed (24/7)             │
│   • Hyperliquid REST (9 perpetual DEXs)                      │
│   • Risk engine (millisecond latency, no LLM dependency)     │
│   • Paper trading engine (leverage-aware P&L simulation)      │
│   • Real Trading Manager (exchange orders + local mirror)     │
│   • Position tracking & stop-loss/take-profit                 │
│   • Data pipeline & persistence                               │
│   • Observability & health checks                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
src/
├── index.ts                  # 🚀 Entry point — system lifecycle management (~950 LOC)
├── config/index.ts           # Zod-validated, type-safe configuration
├── types/index.ts            # Complete domain type definitions (~570 LOC)
│
├── agents/                   # 🤖 Multi-agent system
│   ├── base-agent.ts         # Abstract agent base class
│   ├── agents.ts             # Six sub-agents (~1,720 LOC)
│   ├── meta-agent.ts         # Meta-agent arbitration
│   └── agent-models.ts       # Per-agent model configuration
│
├── cognition/
│   └── hacp.ts               # ⚡ HACP protocol implementation (~907 LOC)
│
├── llm/                      # 🔌 LLM abstraction layer
│   ├── provider.ts           # Abstract interface
│   ├── nim-provider.ts       # NVIDIA NIM implementation
│   ├── ollama-provider.ts    # Ollama implementation
│   └── index.ts              # Provider factory (auto-detection)
│
├── trading/                  # 💹 Trading engine
│   ├── portfolio.ts          # Portfolio tracker (leverage-aware P&L)
│   ├── paper-engine.ts       # Paper trading simulation
│   ├── real-trading-manager.ts # Real trading orchestrator
│   ├── binance-real-engine.ts  # Binance real trading
│   └── hyperliquid-real-engine.ts # Hyperliquid real trading
│
├── risk/engine.ts            # 🛡️ Risk management engine
├── evolution/                # 🧬 Self-evolution system
│   ├── index.ts              # Evolution orchestrator (~420 LOC)
│   ├── trade-history.ts      # Trade history ledger
│   ├── agent-outcomes.ts     # Per-agent performance tracking
│   └── persistence.ts        # Durable state persistence
│
├── data/                     # 📊 Data pipeline
│   ├── binance-websocket.ts  # Binance WS + market state aggregation
│   └── hyperliquid-websocket.ts
│
├── market-agent/             # 🎯 Auto pair selection
├── backtest/                 # 📜 Historical backtesting engine
├── observability/logger.ts   # Structured logging (Winston)
└── api-server.ts             # REST + SSE API

ui/                           # 🖥️ React Web UI
├── src/
│   ├── App.tsx               # Main dashboard
│   ├── TradingViewChart.tsx  # TradingView chart integration
│   └── StarsBackground.tsx   # Dynamic starfield background
└── index.html
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

### Decision Cycle Tuning

```env
DECISION_INTERVAL_MS=60000     # 60s between decision cycles
HACP_MAX_DEBATE_ROUNDS=3       # Maximum debate rounds
HACP_CONSENSUS_THRESHOLD=0.60  # Consensus threshold (60%)
```

### Risk Parameters

```env
RISK_MAX_LEVERAGE=1.0          # Maximum leverage
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
