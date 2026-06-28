# {MATS} — Multi-Agent Trading System

> **A self-evolving, multi-agent quantitative trading framework powered by the Hyper-Accelerated Cognition Protocol (HACP).**  
> Institutional-grade paper trading simulation across Hyperliquid perpetual markets.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.0.41--dev-blueviolet)](ARCHITECTURE.md)

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

> 💡 **Recommended**: Upgrade to **Ollama Pro** for cloud model access (`deepseek-v4-flash:cloud`, `kimi-k2.6:cloud`, `glm-5.2:cloud`) — faster inference, no local GPU required, supports 8 agents' concurrent requests.

The system defaults to **Paper Trading mode** and will never use real funds.

### 6. Launch the System

```bash
npm start
```

On first launch, the system will:
1. Auto-detect the LLM provider (Ollama)
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
| Custom OpenAI-compatible | Implement `LLMProvider` interface | Any service with an OpenAI-compatible API |

The provider factory auto-detects availability: Ollama → Error.

> 💡 **Recommended**: Upgrade to **Ollama Pro** plan for cloud model access (e.g. `deepseek-v4-flash:cloud`, `kimi-k2.6:cloud`, `glm-5.2:cloud`) — faster inference, no local GPU required, and supports concurrent requests from 8 agents.

🆕 v2.0.12: Ollama has a **circuit breaker** — 3 consecutive failures open the breaker for 30s (fail-fast instead of each agent waiting the full timeout). Ollama also has **slot leak protection** (v2.0.20): slots held >90s are auto-reclaimed, and concurrency is 4 (raised from 2) to handle 8 agents' staggered thinking.

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
src/                                        # 24,502 LOC total
├── index.ts                                # 🚀 Entry point — system lifecycle (3,124 LOC)
├── api-server.ts                           # REST + SSE API server (783 LOC)
├── config/index.ts                         # Zod-validated, type-safe configuration (129 LOC)
├── types/index.ts                          # Complete domain type definitions (773 LOC — srSupport/srResistance for S/R-based SL/TP)
│
├── agents/                                 # 🤖 Multi-agent system
│   ├── base-agent.ts                        # Abstract agent base class (425 LOC)
│   ├── agents.ts                            # Six sub-agents (1,358 LOC — on-chain dedup normalizeSym)
│   ├── meta-agent.ts                       # Meta-agent arbitration (120 LOC)
│   └── agent-models.ts                      # Per-agent model configuration (112 LOC)
│
├── cognition/                              # 🧠 Inter-agent cognition
│   ├── hacp.ts                             # ⚡ HACP protocol (1,610 LOC — deadline race + tiered timeout + dynamic weights)
│   ├── a2a-utils.ts                         # A2A inter-agent signal exchange (355 LOC)
│   └── A2A-PROTOCOL.md                      # A2A protocol specification
│
├── llm/                                    # 🔌 LLM abstraction layer
│   ├── provider.ts                          # Abstract interface (57 LOC)
│   ├── ollama-provider.ts                   # Ollama provider (332 LOC — circuit breaker + concurrency 4 + slot leak protection)
│   ├── nim-provider.ts                     # NVIDIA NIM provider
│   └── index.ts                            # Provider factory (auto-detection, 46 LOC)
│
├── trading/                                # 💹 Trading engine
│   ├── portfolio.ts                         # Portfolio tracker (858 LOC — closePosition defensive guard + recalculateEquity excludes real + exchange UI callback)
│   ├── paper-engine.ts                     # Paper trading simulation (347 LOC — HL $10 min notional floor)
│   ├── cost-model.ts                        # HL transaction cost model (91 LOC — taker 0.04%, notional-based)
│   ├── execution-tracker.ts                 # Slippage/fee tracking (211 LOC)
│   ├── decision-utils.ts                    # Decision normalization (150 LOC)
│   ├── real-trading-manager.ts              # Real trading orchestrator (932 LOC — pro algo firm SL/TP: fill-first + retry + safety-close + S/R-based SL/TP + openedAt sync)
│   ├── hyperliquid-real-engine.ts           # HL real trading engine (1,149 LOC — phantom agent signing + formatPrice + multi-DEX + adjustPosition false-success fix + fill matching by coin+side+price)
│   └── binance-real-engine.ts               # Binance real trading engine (440 LOC)
│
├── risk/                                   # 🛡️ Risk management
│   ├── engine.ts                            # Multi-layer risk engine (204 LOC)
│   └── correlation-budget.ts               # Cross-pair correlation budget (299 LOC)
│
├── system-guard/                           # 🛡️ SystemGuard — 5 guards (540 LOC)
│   ├── index.ts                            # Calendar / drawdown / data freshness / agent track record / liquidity
│   └── types.ts                            # Guard type definitions (42 LOC)
│
├── evolution/                              # 🧬 Evolution + RBC + pattern classifier
│   ├── index.ts                            # Evolution orchestrator (791 LOC — directional mutation + regime-aware strategy)
│   ├── trade-history.ts                    # Trade history ledger (466 LOC — recent trade pattern analysis)
│   ├── agent-outcomes.ts                   # Per-agent performance tracking (173 LOC)
│   ├── agent-evolution.ts                  # Agent Evolution Engine (150 LOC — dynamic voting weights)
│   ├── persistence.ts                      # Durable state persistence (565 LOC)
│   ├── trade-pattern-classifier.ts         # Supervised KNN pattern DB (831 LOC)
│   ├── rbc-clustering.ts                   # RBC Engine (645 LOC — layered decay + time-weighted centroid)
│   ├── cycle-summary.ts                    # EM Cycle Summary Manager (587 LOC)
│   ├── em-clustering.ts                    # EM clustering engine (660 LOC)
│   └── pattern-tag-tracker.ts              # Pattern tag frequency tracker (358 LOC)
│
├── analysis/                               # 📊 Signal processing
│   ├── sentiment-engine.ts                 # Sigmoid·GA sentiment engine (279 LOC — adaptive velocity/acceleration)
│   ├── sigmoid-ga.ts                       # GA-evolved sigmoid functions (393 LOC — blend weight normalization)
│   ├── support-resistance.ts               # S/R zone detection (724 LOC — recency weighting + volume scaling; synthetic symbol aware)
│   └── planck-chaos.ts                     # 🆕 v2.0.33 Planck-Chaos Resonance module (400 LOC — Lyapunov exponent + resonance detection + amplitude windows + chaos regime classification + direction bias)
│
├── market-agent/                           # 🎯 Auto pair selection + position size/leverage
│   ├── index.ts                            # Market Agent (879 LOC)
│   └── hl-rate-limiter.ts                  # HL REST rate limiter (40 LOC)
│
├── data/                                   # 📡 WebSocket data feeds
│   ├── hyperliquid-websocket.ts            # HL WS (817 LOC — user-level subscriptions + real-time position/fill sync)
│   ├── binance-websocket.ts                # Binance WS (555 LOC)
│   └── multi-exchange-ws.ts                # Multi-exchange WS manager (364 LOC)
│
├── backtest/index.ts                       # 📜 Historical backtesting engine (555 LOC — annualized regime slope)
├── observability/logger.ts                 # Structured logging (Winston, 78 LOC)
└── utils/shutdown.ts                       # Graceful shutdown handler (77 LOC)

ui/                                        # 🖥️ React Web UI (pantha_mats design system)
├── src/
│   ├── App.tsx                             # Main dashboard (1,888 LOC — REAL/PAPER labels + manual close + HL balance)
│   ├── RBCVisualizer.tsx                   # RBC dimension visualizer (180 LOC)
│   ├── TradingViewChart.tsx                # TradingView chart (342 LOC — live TP/SL update)
│   ├── StarsBackground.tsx                 # Dynamic starfield background (114 LOC)
│   ├── types.ts                            # UI type definitions (430 LOC — nullable PnL/drawdown + hl-fill status)
│   ├── main.tsx                            # React entry point (10 LOC)
│   └── index.css                           # pantha_mats design system (2,358 LOC)
└── index.html

scripts/                                   # 🛠 Utilities
├── loop-engineering.sh                     # Loop engineering runner (bash + jq + python3)
├── loop-engineering-deep.sh                # Deep session runner
├── loop-engineering-memory.md              # Known issues / checklist
├── backfill-patterns.mjs                   # Import portfolio trades into pattern DB
└── reset-rbc-symbol.ts                     # Reset RBC state for a single symbol

data/                                      # 💾 Runtime persistence
└── evolution/
    ├── trade-patterns.json                 # Pattern DB (1000 max)
    ├── trade-patterns-em.json               # EM cluster assignments
    ├── rbc-state.json                       # RBC state (winBox, lossBox per symbol)
    ├── evolution-state.json                 # GA population + memory + strategies
    └── portfolio-state.json                 # Portfolio snapshot
```

---

## Advanced Configuration

### Ollama Pro Plan (Recommended)

For best performance, upgrade to **Ollama Pro** to access cloud-hosted models (e.g. `deepseek-v4-flash:cloud`, `kimi-k2.6:cloud`, `glm-5.2:cloud`). Cloud models offer faster inference, higher concurrency, and no local GPU requirement — ideal for running 8 agents in parallel.

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_DEFAULT=deepseek-v4-flash:cloud
```

### Hyperliquid Real Trading

```env
HYPERLIQUID_WALLET_ADDRESS=0x...
HYPERLIQUID_PRIVATE_KEY=...
```

The system defaults to **paper trading** — switch to real mode via the UI Market Agent panel (no env var needed).

🆕 v2.0.16: When a wallet address is configured, the HL WebSocket subscribes to user-level feeds (`clearinghouseState` + `userFills`) for real-time position + fill sync — no REST polling delay. The UI Portfolio module + Trade Records panel show the actual Hyperliquid positions + recent 10 fills.

🆕 v2.0.17: In real mode the UI shows the actual HL account balance/equity (not the local mirror). Total PnL + Drawdown display `--` (paper-trade concepts); Win Rate/Trades stay local (paper + real mixed).

🆕 v2.0.30: Manual close position button (✕) on each position row with confirm dialog. `closeReason='manual'` tag lets agents know it was NOT a system decision. Real-mode positions synced every cycle.

🆕 v2.0.31: Multi-DEX support — `getBalance()` + `getPositions()` query both DEX 0 (crypto perps) + DEX 'xyz' (TradFi perps) + spot clearinghouse. Exchange positions (e.g. user-opened SPCX on HL UI) are imported into local mirror with default SL/TP so agents can manage them. UI position table shows Paper/Real mode label. `getRecentFills` fixed to include `startTime` (HL API requires it).

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

## Changelog (v2.0.10 → v2.0.41)

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
| **v2.0.19** | Unrealized PnL includes entry fee (not $0.00 at open); real-trade positions module syncs HL positions; Trade Records syncs HL recent fills (`hl-fill` status) |
| **v2.0.20** | TradingView TP/SL live update (JSON dependency, only cycle=0 lines); Ollama concurrency 2→4, slot timeout 15s→8s, slot leak protection (>90s reclaim) |
| **v2.0.21** | Market Agent chart shows only the current position marker (no historical sell arrows) |
| **v2.0.22–v2.0.26** | Fitness breakdown fix (adaptability + consistency), dailyPnl auto-reset, SL/TP close instant UI update, SL/TP close learning hook (7 mechanisms), loss cooldown + LLM review |
| **v2.0.27** | Enriched cooldown LLM review with per-trade loss details; Risk Auditor → deepseek-v4-flash:cloud |
| **v2.0.28** | LLM pattern tag tracking — agents label chart patterns, system tracks win rates per tag+direction (PatternTagTracker + Wilson score) |
| **v2.0.29** | Legacy position management — positions from previous trade mode continue to be managed until naturally closed |
| **v2.0.30** | Manual close position button (✕ + confirm); closeReason tracking ('manual'/'sl_tp'/'consensus'/etc); real-mode per-cycle position sync; Paper/Real UI labels |
| **v2.0.31** | Multi-DEX balance + positions (DEX 0 + xyz + spot); exchange position import into local mirror with default SL/TP; getRecentFills startTime fix; NIM/Binance config cleanup; WS stale book detection |
| **v2.0.32** | HL signing rewrite (phantom agent EIP-712 + msgpack + recovery bit); xyz DEX asset index offset (110000); `updateLeverage()` before order placement (fixes 40x→10x); SL/TP direction fix for short positions (stale local mirror → immediate trigger); `syncExchangePositions()` removes stale exchange mirrors + closes paper mirror properly on side/qty/entry change (produces trade record, not silent removal); `syncSLTP()` validates HL position side + entry + manages SL/TP per coin+closeSide (allows simultaneous long+short); `placeOrder()` only returns success on `filled` (not `resting`); UI filters stale positions in real mode; REAL/PAPER label based on `agentId` only; `getOpenOrders()` parses `limitPx` + `reduceOnly`; `PERP_DEX_NAMES` fix (`dex: 0` → `''` — HL API rejects number); `formatPrice()` price-magnitude-based decimals (BTC=0, ETH=1, SPCX=2, SOL=3, ATOM=4, DOGE=6) strips trailing zeros; `updatePosition()` skips `checkPositionExits()` for `agentId='hyperliquid-real'` (exchange SL/TP managed natively by HL trigger orders); `cancelOrderWithAsset()` uses correct per-coin asset index (not positions[0]); reconciliation closes on HL before local close; `syncSLTP()` hasSL/hasTP uses rounded price comparison (tolerance < 1, not < 0.01) |
| **v2.0.33** | Regime-aware direction signals (mean-revert vs trend-following based on `combinedState.regime`); Planck-Chaos Resonance module (`src/analysis/planck-chaos.ts`) — Lyapunov exponent estimation, resonance frequency detection (autocorrelation), amplitude window prediction (diffusion model √(2Dt)), chaos regime classification, direction bias from cycle phase; Planck-Chaos is Priority -1 (highest) in exploration direction chain; Meta-Agent + Fractal Momentum prompts updated with chaos theory; new pattern tags (planck_resonance_strong, chaotic_divergence, diffusion_accumulation, cycle_phase_bottom/top, edge_of_chaos); removed trend filter Layer 2 that caused systematic buy-high-sell-low (13.3% win rate → anti-correlated); exploration SL/TP widened from 1%/2% to 2%/5% |
| **v2.0.34** | Phantom close fix — 8 code paths that closed real HL positions locally without closing on HL (reconcilePositions API-failure guard, engine.closePosition false-success fix, syncExchangePositions stale fill matching, agent vote/consensus/flip routed through realTradingManager, manual close fix, defensive guard in closePosition() that redirects real positions to closeExchangePosition()); Paper balance/equity inflation fix — recalculateEquity() excludes real positions, closePosition() defensive guard prevents margin inflation, portfolio-state reconstructed ($2060→$1278.95); Premature close fix — close thresholds use raw PnL% (unleveraged) instead of leveraged unrealizedPnlPct; S/R-based SL/TP — uses nearestSupport/nearestResistance from S/R engine instead of fixed percentages, with 0.5-5% hard constraints + risk:reward ≥ 1; Pro algo firm SL/TP — fill-first (actual fill price not decision price), 3x retry with 1s delay, safety-close if SL/TP placement fails (unprotected 10x = too dangerous), adjustPosition() false-success fix; openedAt sync — match HL fills by coin+side+price tolerance (200 fills), preserve existing timestamp when no match; on-chain dedup — normalizeSym() strips USDT/USD + xyz: prefix + lowercase (BTCUSDT/btc/xyz:SPCX all dedup); instant UI update — onExchangeClosedUICb callback fires pushToAPI + refreshHLFills immediately after close |
| **v2.0.35** | HL SL/TP close detection — 3 bugs fixed: (1) WS `onFills` handler now detects closing fills via HL `dir` field (`Close Long`/`Close Short`) and immediately calls `closeExchangePosition()` with actual HL fill price + closedPnl — previously only did `softUpdatePosition()` so the local mirror stayed open forever with no trade record or learning; (2) `syncExchangePositions()` safety check now fetches recent fills to verify genuine closes vs API failure when `exMap.size === 0` (previously skipped close entirely when the last position was closed); (3) `closeExchangePosition()` now stores trade records in `closedRealTrades[]` (capped 200) and `pushToAPI()` includes them in UI Trade Records; WS `onPositions` backup detects positions that disappeared from HL clearinghouseState |
| **v2.0.36** | Minimum 1% SL/TP gap constraint — Meta-Agent `adjustPositions()` had no minimum gap, LLM would over-narrow SL/TP to < 1% as price approached target, causing noise stop-outs that cut profits short. Added 1% minimum gap check in `hacp.ts` (after LLM returns new SL/TP, handles 3 cases: both new, only SL new vs existing TP, only TP new vs existing SL) + hard safety layer in `portfolio.ts` `adjustPosition()` (rejects if effective SL/TP gap < 1% of current price) |
| **v2.0.37** | Stale real position cleanup in paper mode — 3 bugs fixed: (1) Paper-mode legacy sync only processed positions in `legacyPositionModes` — orphaned real positions (`agentId='hyperliquid-real'` but NOT in `legacyPositionModes`, e.g. after system restart) were never cleaned up. Now processes ALL real positions with 3 cases: closing fill found → close with HL PnL, position > 1h old with no HL position → close (assume closed), position not in HL `getPositions()` → close; (2) Paper-mode reconciliation didn't filter out `agentId='hyperliquid-real'` positions — they were kept if < 12h old, causing perpetual `syncSLTP` + `closePosition` errors. Now explicitly excludes them; (3) `syncExchangePositions` 'uncertain' case (no closing fill found) just warned and skipped — stale positions stayed forever. Now closes positions older than 1h |
| **v2.0.38** | Real trade persistence — `closedRealTrades` was in-memory only, lost on every restart. Now `PortfolioSnapshot` has `realTrades` field, `savePortfolio()` accepts 3rd param, constructor loads from disk, `persistPortfolio()` passes `closedRealTrades`, `onPositionClosedLearning` persists immediately after close. Paper stats unaffected (separate storage) |
| **v2.0.39** | Consensus directional agreement fix — `calcWeightedConsensus()` used `Math.abs(agreementScore)` per-vote, meaning BUY (+1) and SELL (-1) both added positive weight. Threshold measured conviction not direction. 5 agents confidently voting BUY passed even if RBC said UNFAVORABLE. Fixed: removed per-vote `Math.abs()`, uses directional agreement. Split (half BUY half SELL) produces ~0 — won't pass threshold. Final `Math.abs(total)` preserves SELL consensus |
| **v2.0.40** | Learning decay — Agent Outcomes `getAgentPerformance()` now only uses recent 50 records (was all 10,000). Pattern Classifier `queryEntry()` + `queryPosition()` use time-weighted win/loss (`0.5^(age/7days)` half-life). Old regime data naturally fades out. `wilsonScore()` hardened with `total <= 0` guard + `p` clamping |
| **v2.0.41** | MAX_POSITION_PCT removed (Market Agent controls size via Phase 4.5 override — was redundant); Evolution `signalThreshold` now DETERMINISTICALLY overrides HACP consensus threshold (was just informational text — now agents need stronger directional agreement when Evolution says "be pickier"); Planck-Chaos `directionBias` removed (redundant with regime-aware direction chain — Lyapunov + amplitude windows + resonance retained as informational); mandatory `⚠️ MAINTENANCE NOTE` comments added to all modified functions instructing future agents to update comments when changing enforcement chains |

See [ARCHITECTURE.md](ARCHITECTURE.md) § B.13–B.41 for full details on each fix.

---

## Tech Stack

| Category | Technology |
|:---------|:-----------|
| **Language** | TypeScript 5.6 (strict mode, zero type errors) |
| **Runtime** | Node.js 22+ |
| **LLM** | Ollama (local + Pro cloud models) / OpenAI-compatible |
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
