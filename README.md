# {MATS} — Multi-Agent Trading System

> **A self-evolving, multi-agent quantitative trading framework powered by the Hyper-Accelerated Cognition Protocol (HACP).**  
> Institutional-grade paper trading simulation across Hyperliquid perpetual markets.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.0.21--dev-blueviolet)](ARCHITECTURE.md)

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

MATS does not rely on a single AI model. Instead, **eight specialized agents think in parallel and engage in structured debate** to reach consensus:

| Agent | Role | Temperature | Weight |
|:------|:-----|:-----------:|:------:|
| **Market Agent** | Auto-selects trading pair, sets position size & leverage | — | — |
| **Fractal Momentum Sentinel** | Fractal pattern & trend analyst | 0.85 | 0.25 |
| **On-Chain Whisperer** | On-chain data & macro analyst | 0.50 | 0.25 |
| **RBC & Sentiment Analyst** | RBC clusters + Fear & Greed specialist | 0.25 | 0.25 |
| **News Reporter** | Multi-source news sentiment analyst | 0.40 | 0.20 |
| **Independent Risk Auditor** | 🚨 Final gatekeeper (absolute veto power) + 🆕 v2.0.13 regime-aware TP/SL | 0.10 | 0.25 |
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
Phase 4.5: Market Agent hard constraints override (enforces position size & leverage)
Phase 5:   Meta-Agent dynamic TP/SL adjustment + per-position consensus execution
```

**Key properties:**
- **Graceful degradation**: Any error defaults to HOLD — the system never crashes into a bad trade
- **Deterministic fallback**: If LLM is unavailable, risk engine enforces conservative defaults
- **Total cycle budget**: 120s hard timeout, forced HOLD on expiry
- 🆕 v2.0.12: **LLM resilience** — circuit breaker (3 failures → 30s fail-fast), slot acquisition timeout (8s), HACP deadline race (60s per agent → graceful HOLD), tiered LLM timeout (think 45s, debate/audit 30s). Prevents a single stalled agent from blocking the whole cycle.
- 🆕 v2.0.13–v2.0.14: **Risk Auditor regime-aware TP/SL** — analyzes the last 10 trades' direction + PnL to detect choppy/whipsaw markets. Choppy → VETO new entries OR narrow TP/SL to range edges + hardcoded 50% position cut (HACP-enforced, not LLM-discretionary); loss streak ≥3 → 25%. Trending → widen TP to let profits run. Paper engine floors the final notional to HL's $10 minimum.

### 🧬 Self-Evolution System (RBC + EM Cycle Chain)

MATS has **two self-evolution mechanisms**:

**Layer 1 — RBC (Range-Based Clustering)** (`rbc-clustering.ts`):
- Growing hyperrectangles per symbol (winBox + lossBox), ranges expand with decay
- 8 feature dimensions: volatility, srDistanceBps, obImbalance, sentiment, signalAgreement, fundingRate, volumeRatio, sentimentConviction
- 🆕 v2.0.9: `applyDecay()` shrinks overlap regions toward centroids (10%/cycle) — prevents box saturation
- 🆕 v2.0.9: Multi-symbol training — trains active symbol + all open positions + all RBC symbols
- 🆕 v2.0.10: Only trains the active symbol (avoids proxy-price pollution of historical symbols)
- 🆕 v2.0.11: **Layered decay** — global decay on all dimensions (not just overlap), confidence-scaled rate (balanced win/loss → slow decay, imbalanced → fast), time-weighted centroid (half-life 50 cycles) so the shrink target tracks the recent regime
- Edge score = discriminative dims / total dims → verdict: favorable/unfavorable/no_edge
- Per-symbol persistent memory (rbc-state.json, atomic write)
- Hypothetical training: compares price change between cycles, feeds directional/flat samples
- 🆕 v2.0.11: `RBCQueryResult` includes `confidence` (0-1) + `effectiveSamples` — agents weight the verdict by confidence (low conf = weak hint, high conf = strong signal)

**Layer 2 — EM Cycle Chain** (`cycle-summary.ts`):
- Meta-Agent distills each cycle into a structured `CycleSummary` (E-step)
- Previous summaries feed into next cycle's agent context (M-step)
- Skeptics cross-check insight vs actual price (convergence audit)
- Tiered memory: hot(12) + warm(288) + cold(48 epochs, ~48 days)

**Evolutionary Pressure Engine (v2.0.8 — Dual-Trigger + 1-Gen Incubation):**
- Survival Fitness: Profit Efficiency 35% + Return 25% + Capital Preservation 20% + Win Quality 10% + Consistency 5% + Adaptability 5%
- 🆕 v2.0.15: **Directional mutation** — `mutate()` guides parameter changes toward fixing the weakest fitness dimension (breakdown < 0.4), not blind random ±10% noise. E.g. low `capitalPreservation` → raise `riskAversion`; low `adaptability` → lower `signalThreshold` + `confirmationRequired`. Residual noise preserved for exploration.
- 🆕 v2.0.15: **Agent-level evolution** — `AgentEvolutionEngine` dynamically adjusts each agent's voting weight by per-regime win rate: `dynamicWeight = baseWeight × clamp(0.5 + (winRate-0.5)×2, 0.5, 1.5)`, EMA-smoothed (alpha=0.3), requires ≥5 samples. High-performers gain influence, underperformers lose it. HACP consensus uses the dynamic weight.
- 🆕 v2.0.15: **Regime-aware strategy selection** — `getBestStrategyForRegime(regime)` scores `fitness × regimeWeight/maxRegimeWeight` so a trending_bull-tuned strategy isn't picked in a chaotic regime.
- ±10% mutation per generation, automatic retirement below 0.2 fitness
- Dual-trigger: loss-triggered (immediate) or scheduled (every 3 trades)
- 1-gen incubation: child evaluated after 1 cycle (not 3) — faster adaptation
- Agent Outcome Tracking: per-agent, per-symbol track record

### 🧬 Trade Pattern Classifier

A supervised KNN pattern database that answers "in current conditions, has this setup won before?":

- **Two query modes**: `queryEntry()` for new positions, `queryPosition()` for held positions
- **8D feature space**: volatility, srDistanceBps, obImbalance, sentiment, signalAgreement, fundingRate, volumeRatio, sentimentConviction + regime (categorical)
- **Wilson score**: 95% confidence lower bound — prevents overfitting on small samples
- **BUY/SELL shared pool**: outcome inverted for opposite side (BUY loss = SELL win)
- **Noise filter**: |PnL| < 0.5% skipped (fee-level noise)
- **Direction priority chain (v2.0.8)**: RBC → KNN → Sentiment → Velocity → S/R → Funding → OB → Regime/24h

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
- 🆕 v2.0.18: **Notional-based double-sided fee deduction** — HL taker fee (0.04%) is charged on the leveraged notional, not the margin. At 10x leverage a round-trip costs 0.8% of margin; at 100x it's 8%. Fees are deducted from `balance` on both open and close (plus `realizedPnl` on close) so paper PnL reflects the real cost — the system only learns strategies that are profitable AFTER fees.
- 🆕 v2.0.19: **Unrealized PnL includes entry fee** — opening a position immediately shows the paid entry fee as a negative unrealized PnL (not $0.00), so the UI reflects the real cost from the moment the position opens.

### 🔌 LLM Abstraction Layer

Swap LLM providers without modifying a single line of code:

| Provider | Configuration | Characteristics |
|:---------|:-------------|:----------------|
| **Ollama** (default) | `OLLAMA_BASE_URL` | Local, free, no API key required |
| **NVIDIA NIM** | `NIM_API_KEY` | Cloud API, supports Llama/DeepSeek |
| Custom OpenAI-compatible | Implement `LLMProvider` interface | Any service with an OpenAI-compatible API |

The provider factory auto-detects availability: NIM → Ollama → Error.

🆕 v2.0.12: Both providers have a **circuit breaker** — 3 consecutive failures open the breaker for 30s (fail-fast instead of each agent waiting the full timeout). Ollama also has **slot leak protection** (v2.0.20): slots held >90s are auto-reclaimed, and concurrency is 4 (raised from 2) to handle 8 agents' staggered thinking.

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
│   • 8-agent system + meta-agent arbitration                  │
│   • Structured debate + weighted voting consensus            │
│   • Self-evolution (RBC + EM Cycle Chain + GA + Pattern DB)  │
│   • SystemGuard (5-layer protection: calendar, drawdown,     │
│     data freshness, agent track record, liquidity)           │
│   • LLM invoked only at critical decision points             │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Layer 3: Execution (TypeScript Runtime)                    │
│   • Hyperliquid WebSocket + REST (9 perpetual DEXs)          │
│   • 🆕 v2.0.16: HL WS user-level subscriptions                │
│     (clearinghouseState + userFills — real-time position/fill │
│      sync, no REST polling)                                   │
│   • Market Agent auto-selects trading pair                   │
│   • Risk engine (millisecond latency, no LLM dependency)     │
│   • Paper trading engine (leverage-aware P&L simulation)     │
│   • 🆕 v2.0.18: Notional-based double-sided fee deduction    │
│   • Real Trading Manager (exchange orders + local mirror)    │
│   • 🆕 v2.0.16: Post-trade sync (renew mirror SL/TP + fill)   │
│   • 🆕 v2.0.17: Real-trade UI shows HL real balance/equity    │
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
├── index.ts                  # 🚀 Entry point — system lifecycle (~2031 LOC)
├── config/index.ts           # Zod-validated, type-safe configuration
├── types/index.ts            # Complete domain type definitions (~749 LOC)
│
├── agents/                   # 🤖 Multi-agent system
│   ├── base-agent.ts         # Abstract agent base class (~417 LOC)
│   ├── agents.ts             # Six sub-agents (~1306 LOC)
│   ├── meta-agent.ts         # Meta-agent arbitration (80 LOC)
│   └── agent-models.ts       # Per-agent model configuration (126 LOC)
│
├── cognition/
│   ├── hacp.ts               # ⚡ HACP protocol (v2.0.12 — deadline race + tiered timeout + v2.0.15 dynamic weights)
│   └── a2a-utils.ts          # A2A inter-agent signal exchange
│
├── llm/                      # 🔌 LLM abstraction layer
│   ├── provider.ts           # Abstract interface (57 LOC)
│   ├── nim-provider.ts       # NVIDIA NIM (v2.0.12 — circuit breaker)
│   ├── ollama-provider.ts    # Ollama (v2.0.12 — circuit breaker + v2.0.20 concurrency 4 + slot leak protection)
│   └── index.ts              # Provider factory (auto-detection, 65 LOC)
│
├── trading/                  # 💹 Trading engine
│   ├── portfolio.ts          # Portfolio tracker (v2.0.18 — notional fee + v2.0.19 entryFee in unrealizedPnl)
│   ├── paper-engine.ts       # Paper trading simulation (v2.0.14 — HL $10 min notional floor)
│   ├── cost-model.ts         # HL transaction cost model (taker 0.04%, notional-based)
│   ├── execution-tracker.ts  # Slippage/fee tracking
│   ├── decision-utils.ts     # Decision normalization
│   ├── real-trading-manager.ts # Real trading orchestrator (v2.0.16 — post-trade sync + SL/TP renew + getRecentFills)
│   └── hyperliquid-real-engine.ts # Hyperliquid real trading (v2.0.19 — getRecentFills)
│
├── risk/                     # 🛡️ Risk management
│   ├── engine.ts             # Multi-layer risk engine (201 LOC)
│   └── correlation-budget.ts # Cross-pair correlation budget
│
├── system-guard/             # 🛡️ SystemGuard (5 guards, ~497 LOC)
│
├── evolution/                # 🧬 Evolution + RBC + pattern classifier
│   ├── index.ts              # Evolution orchestrator (v2.0.15 — directional mutation + regime-aware strategy)
│   ├── trade-history.ts      # Trade history ledger (v2.0.13 — recent trade pattern analysis)
│   ├── agent-outcomes.ts     # Per-agent performance tracking
│   ├── agent-evolution.ts    # 🆕 v2.0.15 Agent Evolution Engine — dynamic voting weights
│   ├── persistence.ts        # Durable state persistence (~561 LOC)
│   ├── trade-pattern-classifier.ts # 🧬 Supervised KNN pattern DB
│   ├── rbc-clustering.ts     # 🧬 RBC Engine (v2.0.11 — layered decay + time-weighted centroid)
│   └── cycle-summary.ts      # 🧬 EM Cycle Summary Manager
│
├── analysis/                 # 📊 Signal processing
│   ├── sentiment-engine.ts   # Sigmoid·GA sentiment engine (v2.0.10 — adaptive velocity/acceleration)
│   ├── sigmoid-ga.ts         # GA-evolved sigmoid functions (v2.0.10 — blend weight normalization)
│   └── support-resistance.ts # SNR zone detection (v2.0.10 — recency weighting + volume scaling; synthetic symbol aware)
│
├── market-agent/             # 🎯 Auto pair selection + position size/leverage (~879 LOC)
├── backtest/                 # 📜 Historical backtesting engine (v2.0.10 — annualized regime slope)
├── observability/logger.ts   # Structured logging (Winston, 78 LOC)
├── api-server.ts             # REST + SSE API
└── utils/shutdown.ts         # Graceful shutdown handler

ui/                           # 🖥️ React Web UI (pantha_mats design system)
├── src/
│   ├── App.tsx               # Main dashboard (v2.0.21 — Market Agent chart shows only current position)
│   ├── RBCVisualizer.tsx     # RBC dimension visualizer
│   ├── TradingViewChart.tsx  # TradingView chart (v2.0.20 — live TP/SL update via JSON dependency)
│   ├── StarsBackground.tsx   # Dynamic starfield background
│   └── types.ts              # UI type definitions (v2.0.17 — nullable PnL/drawdown; v2.0.19 — hl-fill status)
└── index.html

scripts/                      # 🛠 Utilities
├── loop-engineering.sh       # Loop engineering runner (bash + jq + python3)
├── loop-engineering-deep.sh  # Deep session runner
├── loop-engineering-memory.md # Known issues / checklist
└── backfill-patterns.mjs     # Import portfolio trades into pattern DB

data/                         # 💾 Runtime persistence
└── evolution/
    ├── trade-patterns.json   # Pattern DB (1000 max)
    ├── trade-patterns-em.json # EM cluster assignments
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

🆕 v2.0.16: When a wallet address is configured, the HL WebSocket subscribes to user-level feeds (`clearinghouseState` + `userFills`) for real-time position + fill sync — no REST polling delay. The UI Portfolio module + Trade Records panel show the actual Hyperliquid positions + recent 5 fills.

🆕 v2.0.17: In real mode the UI shows the actual HL account balance/equity (not the local mirror). Total PnL + Drawdown display `--` (paper-trade concepts); Win Rate/Trades stay local (paper + real mixed).

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

## Changelog (v2.0.10 → v2.0.21)

| Version | Change |
|:--------|:-------|
| **v2.0.10** | Math Audit — 13 numerical/logic fixes (EM z-score normalization, logGaussian constant, BIC paramCount, risk confidence double-application, S/R volume weighting + recency, backtest regime slope, correlation budget equity-based, Sigmoid·GA blend normalization, sentiment adaptive scaling, RBC active-symbol-only training) |
| **v2.0.11** | RBC layered decay + time-weighted centroid — global decay on all dims (not just overlap), confidence-scaled rate, half-life 50 cycles; `RBCQueryResult` gains `confidence` + `effectiveSamples` |
| **v2.0.12** | LLM resilience — circuit breaker (3 failures → 30s fail-fast), slot acquisition timeout, HACP deadline race (60s per agent → graceful HOLD), tiered LLM timeout (think 45s, debate/audit 30s) |
| **v2.0.13–v2.0.14** | Risk Auditor regime-aware TP/SL — analyzes last 10 trades for choppy/whipsaw detection. Choppy → VETO or narrow TP/SL to range edges + hardcoded 50% position cut; trending → widen TP. Paper engine floors notional to HL $10 minimum |
| **v2.0.15** | Evolution enhancement — directional mutation (fitness-breakdown-guided), agent-level evolution (dynamic voting weights by per-regime win rate), regime-aware strategy selection |
| **v2.0.16** | HL WS user-level subscriptions (`clearinghouseState` + `userFills`) — real-time position/fill sync; post-trade mirror SL/TP renew + fill sync; UI main chart shows position markers + SL/TP |
| **v2.0.17** | Real-trade UI shows HL real balance/equity (not local mirror); Total PnL + Drawdown show `--` in real mode; Win Rate/Trades stay local (paper + real mixed) |
| **v2.0.18** | Notional-based double-sided fee deduction — HL taker fee charged on leveraged notional (10x → 0.8% of margin round-trip, 100x → 8%); deducted from `balance` on open + close |
| **v2.0.19** | Unrealized PnL includes entry fee (not $0.00 at open); real-trade positions module syncs HL positions; Trade Records syncs HL recent 5 fills (`hl-fill` status) |
| **v2.0.20** | TradingView TP/SL live update (JSON dependency, only cycle=0 lines); Ollama concurrency 2→4, slot timeout 15s→8s, slot leak protection (>90s reclaim) |
| **v2.0.21** | Market Agent chart shows only the current position marker (no historical sell arrows) |

See [ARCHITECTURE.md](ARCHITECTURE.md) § B.13–B.22 for full details on each fix.

---

## Tech Stack

| Category | Technology |
|:---------|:-----------|
| **Language** | TypeScript 5.6 (strict mode, zero type errors) |
| **Runtime** | Node.js 22+ |
| **LLM** | Ollama / NVIDIA NIM / OpenAI-compatible |
| **Market Data** | Hyperliquid WebSocket (l2Book + trades + activeAssetCtx + 🆕 v2.0.16 clearinghouseState + userFills) + REST fallback |
| **Frontend** | React 18 + Vite + TradingView Chart (🆕 v2.0.20 live TP/SL update) |
| **Config Validation** | Zod schema |
| **Logging** | Winston (structured + file rotation) |
| **Codebase** | ~19,000+ LOC TypeScript + React UI |

---

## License

[Apache License 2.0](LICENSE)

Copyright (c) 2026 YC Wong

Pantha AI Labs holds a perpetual commercial license under a separate agreement.
