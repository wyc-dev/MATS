# MATS — The First Self-Evolving AI Trading Brain

**8 AI agents debate every trade. A Skeptics agent vetoes bad ones. The system evolves its own strategy — no manual tuning.**

Single-LLM trading bots hallucinate. They lack oversight, have no risk governance, and cannot adapt to changing markets. MATS solves this with a multi-agent cognitive architecture: 8 specialized agents think in parallel, debate through the HACP protocol, and reach weighted consensus. A dedicated Skeptics agent stress-tests every position before execution. The system self-evolves via genetic algorithms + range-based clustering + EM cycle chains — it learns from every trade and adapts its own parameters.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.0.131-blueviolet)](ARCHITECTURE.md)
[![GitHub stars](https://img.shields.io/github/stars/wyc-dev/MATS?style=social)](https://github.com/wyc-dev/MATS)

🌐 [mats.trading](https://mats.trading/) · 💬 [Discord](https://discord.gg/mats) (coming soon) · ⭐ [Star on GitHub](https://github.com/wyc-dev/MATS)

---

## 📸 See It In Action

<!-- TODO: add docs/demo.gif — dashboard + HACP debate + TradingView chart -->
![MATS Dashboard](docs/demo.gif)
*Dashboard: real-time HACP debate transcripts, agent reasoning, TradingView chart with live SL/TP lines, evolution metrics.*

<!-- TODO: add docs/backtest-curve.png — equity curve from backtest -->
![Backtest Equity Curve](docs/backtest-curve.png)
*Backtest: equity curve showing self-evolving strategy performance over historical data.*

<!-- TODO: add docs/skeptics-veto.png — Skeptics rejecting a trade -->
![Skeptics Veto](docs/skeptics-veto.png)
*Skeptics agent rejecting a trade — the cool factor. Every BUY/SELL must survive stress-testing.*

> Images coming — ⭐ star and watch the repo to be notified when added.

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
git clone https://github.com/wyc-dev/MATS.git
cd MATS
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

## Why MATS is Different

| | Single-LLM Bots | MATS |
|:--|:--|:--|
| **Decision making** | One model, one opinion | 8 agents debate in parallel, weighted consensus |
| **Risk governance** | Trust the LLM | Skeptics agent stress-tests every trade before execution |
| **Adaptation** | Static parameters | Self-evolving: GA + RBC + EM cycle chain, no manual tuning |
| **Reasoning** | Black box | Every trade requires a validated entry thesis (1h catalyst + 1d driver) |
| **Failure mode** | Crashes into bad trades | Every error path defaults to HOLD — capital preservation first |

### 🧠 Entry Thesis System — every trade needs a validated thesis

Meta-Agent must articulate why price will reach TP within 1h (short-term catalyst) and 1d (medium-term driver), referencing specific sub-agent data. Skeptics validates the thesis for strength, specificity, data consistency, and dark psychology (whale manipulation?). No thesis = no trade.

### 🛡️ Skeptics veto — AI stress-tests every position before execution

A dedicated agent with approve-first design: validates every BUY/SELL thesis, only rejects on a specific, material flaw that would cause a loss. Each cycle, re-validates all open position theses against fresh market data — if invalidated, force-closes.

### 🧬 Self-evolving — GA + RBC + EM cycle chain, no manual tuning

Three evolution mechanisms: (1) RBC (Range-Based Clustering) — growing hyperrectangles learn win/loss market conditions per symbol. (2) EM Cycle Chain — Meta-Agent distills each cycle into a structured summary, previous summaries feed into next cycle. (3) GA — survival fitness drives directional mutation of strategy parameters.

### ⚡ HACP protocol — 8 agents parallel debate, 60s deadline race

Hyper-Accelerated Cognition Protocol: 5 sub-agents think in parallel (staggered, 60s deadline race), Skeptics audits logic, Meta-Agent arbitrates, structured debate (1-3 rounds), weighted voting consensus (60% threshold, dynamically adjusted by Evolution). 120s hard timeout — forced HOLD on expiry.

### 💰 Capital preservation first — every error path defaults to HOLD

Graceful degradation: any error defaults to HOLD. Circuit breaker (3 failures → 30s fail-fast). Notional-based double-sided fee deduction. Configurable max portion. SL/TP hard safety layers (no-widen, not-too-tight, min-gap, max-narrow-step).

---

## System Highlights

### 🧠 Multi-Agent Consensus Engine

MATS does not rely on a single AI model. Instead, **eight specialized agents think in parallel and engage in structured debate** to reach consensus:

| Agent | Role | Temperature | Weight |
|:------|:-----|:-----------:|:------:|
| **Market Agent** | Auto-selects trading pair, sets position size & leverage | — | — |
| **Fractal Momentum Sentinel** | Fractal pattern & trend analyst | 0.85 | 0.10 |
| **On-Chain Whisperer** | On-chain data & macro analyst | 0.50 | 0.10 |
| **RBC & Sentiment Analyst** | RBC clusters + Fear & Greed specialist | 0.25 | 0.10 |
| **News Reporter** | Shadow Strategist news motive analyzer | 0.40 | 0.10 |
| **Independent Risk Auditor** | Risk limits + regime-aware TP/SL (advisory-only, cannot veto) | 0.10 | 0.25 |
| **Skeptics** | Logic auditor + **stress-tester for new positions** (approve-first: validates thesis, only rejects on specific material flaw that would cause a loss) | 0.30 | — |
| **Meta-Agent** | Detective — aggressively reasons from facts to find trade edges; generates entryThesis (1h+1d rationale); weight 0.00 (thesis system controls, not voting) | 0.45 | 0.00 |

Each agent operates with **independent temperature, weight, data sources, and reasoning models**, ensuring genuine opinion diversity and preventing groupthink.

### ⚡ HACP — Hyper-Accelerated Cognition Protocol

A structured multi-LLM debate protocol that replaces traditional single-model inference:

```
Phase 0:    Market Agent auto-selects trading pair + position reconciliation
Phase 0.5:  Skeptics re-validates each open position's entryThesis against fresh market data → invalidated → force-close
Phase 1:    5 agents think in parallel (staggered, with 60s deadline race)
Phase 1.5:  Skeptics logic audit + EM convergence cross-cycle check
Phase 1.75: Meta-Agent final arbitration (incorporates Skeptics findings)
Phase 1.8:  Skeptics validates Meta-Agent's entryThesis for BUY/SELL (skipped if symbol already has a position) → rejected → HOLD override
Phase 2:    Structured rapid debate (1-3 rounds, configurable)
Phase 3:    Weighted voting consensus (60% threshold, dynamically adjusted by Evolution)
Phase 4:    Risk Auditor advisory check (non-blocking, TP/SL/size adjustments only)
Phase 4.5:  Market Agent hard constraints override (enforces position size & leverage)
Phase 4.8:  Entry Thesis Hard Gate — final check: BUY/SELL without valid+validated entryThesis → BLOCK
Phase 5:    Meta-Agent dynamic TP/SL adjustment + per-position consensus execution
```

**Key properties:**
- **Graceful degradation**: Any error defaults to HOLD — the system never crashes into a bad trade
- **Deterministic fallback**: If LLM is unavailable, risk engine enforces conservative defaults
- **Total cycle budget**: 120s hard timeout, forced HOLD on expiry
- **LLM resilience**: Circuit breaker (3 failures → 30s fail-fast), slot acquisition timeout (8s), HACP deadline race (60s per agent → graceful HOLD), tiered LLM timeout (think 45s, debate/audit 30s)

### 🎯 Entry Thesis System + Extreme Reasoning (v2.0.80+)

The core cognitive architecture — every new position requires a strong, validated rationale, and every symbol gets a directional judgment every cycle:

**No position → MUST decide BUY or SELL** (HOLD only when ALL six signals absent: RBC + S/R + sentiment + momentum + news + regime). Even a 51% lean is enough to act. Even with no data, reason from first principles (price level, round numbers, regime, fees).

**Has position → MUST decide CLOSE or HOLD** (CLOSE if ≥3 of 6 conditions true: thesis invalidated + trend changed + ≥2 agents close + losing money + regime unsuitable + contradicting news. HOLD if 0-2 conditions true).

1. **Meta-Agent generates `entryThesis`** — explains why price will reach TP within 1h (short-term catalyst) and 1d (medium-term driver), referencing specific sub-agent data
2. **Skeptics validates** — checks for strength, specificity, data consistency, dark psychology (whale manipulation?), and fact distortion
3. **Phase 4.8 Hard Gate** — any BUY/SELL without a valid+validated thesis is blocked, regardless of consensus path
4. **Phase 0.5 Re-validation** — each cycle, Skeptics re-validates every open position's thesis against fresh market data; if invalidated, force-close
5. **`holdReason`** — HOLD decisions must explain which conditions are true and why they are insufficient to act (displayed in UI, always expanded for Meta-Agent)
6. **Dark Psychology** — Meta-Agent must question whether sub-agent data is genuine market signal or whale/institutional manipulation
7. **Close validation** — closing a thesis-backed position goes through Meta-Agent → Skeptics validation (v2.0.90); thesis MUST be invalidated (mandatory) + ≥2 other conditions (v2.0.103); legacy positions close on Meta-Agent CLOSE decision or ≥2 sub-agent votes (v2.0.94)
8. **RBC + S/R for ALL positions** — context generated for every open position, not just the active symbol (v2.0.92)
9. **Multi-symbol single-cycle** — ALL trading markets analyzed in ONE HACP cycle. Non-position markets injected as `isTradingMarket` entries in `positions[]` with full market context (price, RBC, S/R). Agents output BUY/SELL/HOLD for all markets simultaneously (v2.0.104)
10. **Per-asset adaptive noise filter** — Market Agent selects a `FilterProfile` for each asset (7 profiles: high_vol_crypto, low_vol_crypto, high_vol_alt, dex_perp, forex_index, commodity, default). Each asset gets its own `AdaptiveNoiseFilter` with independent EMA alpha, sigmoid k, conviction gate, and trade frequency throttle. Filter adapts per-cycle based on volatility, win rate, SNR, and trade frequency. Meta-Agent receives per-asset SNR data and must factor it into every decision (v2.0.106)
11. **3-5 sentences minimum** reasoning per symbol — no truncation, no silence

### 🧬 Self-Evolution System (RBC + EM Cycle Chain)

MATS has **two self-evolution mechanisms**:

**Layer 1 — RBC (Range-Based Clustering)** (`rbc-clustering.ts`):
- Growing hyperrectangles per symbol (winBox + lossBox), ranges expand with decay
- 8 feature dimensions: volatility, srDistanceBps, obImbalance, sentiment, signalAgreement, fundingRate, volumeRatio, sentimentConviction
- Layered decay (global + confidence-scaled), time-weighted centroid (half-life 50 cycles)
- Edge score = discriminative dims / total dims → verdict: favorable/unfavorable/no_edge
- Per-symbol persistent memory (rbc-state.json, atomic write)

**Layer 2 — EM Cycle Chain** (`cycle-summary.ts`):
- Meta-Agent distills each cycle into a structured `CycleSummary` (E-step)
- Previous summaries feed into next cycle's agent context (M-step)
- Skeptics cross-checks insight vs actual price (convergence audit)
- Tiered memory: hot(12) + warm(288) + cold(48 epochs, ~48 days)

**Evolutionary Pressure Engine:**
- Survival Fitness: Profit Efficiency 35% + Return 25% + Capital Preservation 20% + Win Quality 10% + Consistency 5% + Adaptability 5%
- **Directional mutation** — `mutate()` guides parameter changes toward fixing the weakest fitness dimension
- **Agent-level evolution** — dynamically adjusts each agent's voting weight by per-regime win rate
- **Regime-aware strategy selection** — scores `fitness × regimeWeight/maxRegimeWeight`
- Dual-trigger: loss-triggered (immediate) or scheduled (every 3 trades)
- 1-gen incubation: child evaluated after 1 cycle — faster adaptation

### 🧬 Trade Pattern Classifier

A supervised KNN pattern database that answers "in current conditions, has this setup won before?":

- **Two query modes**: `queryEntry()` for new positions, `queryPosition()` for held positions
- **8D feature space** + regime (categorical)
- **Wilson score**: 95% confidence lower bound — prevents overfitting on small samples
- **Time-weighted win/loss** (half-life 7 days) — old regime data naturally fades out

### 🧠 Sigmoid·GA Sentiment Engine

A genetic algorithm that evolves sigmoid-based sentiment functions to model market emotion:

- 5 signal channels: Whale Presence, Institutional Flow, Microstructure Tension, Momentum Bias, Fear/Greed Echo
- GA population of 20 chromosomes, evolved every HACP cycle
- Raw inputs: order book, volume acceleration, funding rate delta + acceleration, spread, price acceleration, large trades, F&G index, volatility regime

### 📊 Options Data Layer

An integrated options market data layer for Stocks/Indices/Commodities trading:

- **Data source**: Massive.com (Polygon.io compatible) REST API for option chain snapshots
- **Extracted metrics**: IV Rank, implied volatility, put/call OI ratio, gamma regime, max pain, skew, implied move %, event risk
- **Regime → Playbook mapping**: 5 deterministic playbooks (Premium Sell, Directional Credit, Defined-Risk Debit, Stand Aside, Buy Convexity)
- **Deterministic veto**: `vetoNewPositions=true` overrides HACP consensus → HOLD
- **Dynamic voting weight**: scales with plan tier (free=0.10, starter=0.25, advanced=0.30)
- **Options-aware evolution**: `OptionsStrategyParameters` (7 evolving params) + `SurvivalFitness.optionsAlpha`

### 🛡️ Capital Preservation First

```
Capital preservation is the absolute first priority —
profit generation must occur within safety constraints.
```

- **Skeptics stress-tester** over new positions — thesis must survive stress-testing; only rejected if a specific, material flaw is found that would cause a loss. Approve-first design (v2.0.110): previously "reject by default" caused the system to stop trading for days
- **Risk Auditor advisory-only** — cannot block trades, only suggests TP/SL/size adjustments; hardcoded safety layers (choppy market 50% cut, loss-streak graduated reduction) retained
- **Graceful degradation**: every error path defaults to HOLD
- **Notional-based double-sided fee deduction** — HL taker fee (0.04%) charged on leveraged notional; paper PnL reflects real cost
- **Configurable max portion** — user-configurable max % of balance for all positions combined (10%-100%)
- **SL/TP hard safety layers** — no-widen, not-too-tight (SL ≥1%, TP ≥1.5% from price), min-gap (2%), max-narrow-step (0.5%/cycle)
- Production-grade standards: strict TypeScript, structured logging, exponential backoff reconnection

### 🔌 LLM Abstraction Layer

Swap LLM providers without modifying a single line of code:

| Provider | Configuration | Characteristics |
|:---------|:-------------|:----------------|
| **Ollama** (default) | `OLLAMA_BASE_URL` | Local, free, no API key required |
| Custom OpenAI-compatible | Implement `LLMProvider` interface | Any service with an OpenAI-compatible API |

The provider factory auto-detects availability: Ollama → Error.

> 💡 **Recommended**: Upgrade to **Ollama Pro** plan for cloud model access (e.g. `deepseek-v4-flash:cloud`, `kimi-k2.6:cloud`, `glm-5.2:cloud`) — faster inference, no local GPU required, and supports concurrent requests from 8 agents.

Ollama has a **circuit breaker** (3 consecutive failures → 30s fail-fast), **slot leak protection** (slots held >90s auto-reclaimed), and **concurrency 4** to handle 8 agents' staggered thinking.

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
│   • 8-agent system + Meta-Agent arbitration                  │
│   • Entry Thesis System (Meta-Agent → Skeptics validation)   │
│   • Dark Psychology data interrogation                       │
│   • Structured debate + weighted voting consensus            │
│   • Self-evolution (RBC + EM Cycle Chain + GA + Pattern DB)  │
│   • SystemGuard (5-layer protection)                         │
│   • LLM invoked only at critical decision points             │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   Layer 3: Execution (TypeScript Runtime)                    │
│   • Hyperliquid WebSocket + REST (9 perpetual DEXs)          │
│   • HL WS user-level subscriptions (real-time position/fill) │
│   • Options Data Layer (IV/Greeks/OI/Max Pain)               │
│   • Market Agent auto-selects trading pair                   │
│   • Risk engine (millisecond latency, no LLM dependency)     │
│   • Paper trading engine (leverage-aware P&L simulation)     │
│   • Notional-based double-sided fee deduction                │
│   • Real Trading Manager (exchange orders + local mirror)    │
│   • Global HL rate limiter (single queue, 429 retry)         │
│   • WS infinite reconnect + REST polling backoff             │
│   • Configurable max portion (paper + real)                  │
│   • Position tracking & stop-loss/take-profit                │
│   • Data pipeline & persistence                              │
│   • Observability & health checks                            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
src/                                        # ~25,000 LOC total
├── index.ts                                # 🚀 Entry point — system lifecycle
├── api-server.ts                           # REST + SSE API server
├── config/index.ts                         # Zod-validated configuration
├── types/index.ts                          # Domain type definitions
│
├── agents/                                 # 🤖 Multi-agent system
│   ├── base-agent.ts                        # Abstract agent base class
│   ├── agents.ts                            # Sub-agents + Skeptics (thesis validation + close validation)
│   ├── meta-agent.ts                       # Meta-Agent (detective mode + entryThesis + holdReason)
│   └── agent-models.ts                      # Per-agent model configuration
│
├── cognition/                              # 🧠 Inter-agent cognition
│   ├── hacp.ts                             # ⚡ HACP protocol (Phase 0-5 + 0.5/1.8/4.8 thesis gates)
│   ├── a2a-utils.ts                         # A2A inter-agent signal exchange
│   └── A2A-PROTOCOL.md                      # A2A protocol specification
│
├── llm/                                    # 🔌 LLM abstraction layer
│   ├── provider.ts                          # Abstract interface
│   ├── ollama-provider.ts                   # Ollama provider (circuit breaker + concurrency 4)
│   └── index.ts                            # Provider factory
│
├── trading/                                # 💹 Trading engine
│   ├── portfolio.ts                         # Portfolio tracker (entryThesis persistence)
│   ├── paper-engine.ts                     # Paper trading simulation
│   ├── cost-model.ts                        # HL transaction cost model
│   ├── execution-tracker.ts                 # Slippage/fee tracking
│   ├── decision-utils.ts                    # Decision normalization
│   ├── real-trading-manager.ts              # Real trading orchestrator
│   ├── hyperliquid-real-engine.ts           # HL real trading engine (phantom agent signing)
│   └── binance-real-engine.ts               # Binance real trading engine
│
├── risk/                                   # 🛡️ Risk management
│   ├── engine.ts                            # Multi-layer risk engine
│   └── correlation-budget.ts               # Cross-pair correlation budget
│
├── system-guard/                           # 🛡️ SystemGuard — 5 guards
│   ├── index.ts                            # Calendar / drawdown / data freshness / agent track / liquidity
│   └── types.ts                            # Guard type definitions
│
├── evolution/                              # 🧬 Evolution + RBC + pattern classifier
│   ├── index.ts                            # Evolution orchestrator (directional mutation)
│   ├── trade-history.ts                    # Trade history ledger
│   ├── agent-outcomes.ts                   # Per-agent performance tracking
│   ├── agent-evolution.ts                  # Agent Evolution Engine (dynamic voting weights)
│   ├── persistence.ts                      # Durable state persistence
│   ├── trade-pattern-classifier.ts         # Supervised KNN pattern DB
│   ├── rbc-clustering.ts                   # RBC Engine (layered decay + time-weighted centroid)
│   ├── cycle-summary.ts                    # EM Cycle Summary Manager
│   ├── em-clustering.ts                    # EM clustering engine
│   └── pattern-tag-tracker.ts              # Pattern tag frequency tracker
│
├── analysis/                               # 📊 Signal processing
│   ├── sentiment-engine.ts                 # Sigmoid·GA sentiment engine
│   ├── sigmoid-ga.ts                       # GA-evolved sigmoid functions
│   ├── support-resistance.ts               # S/R zone detection
│   ├── planck-chaos.ts                     # Planck-Chaos Resonance module
│   ├── options-data.ts                     # Options Data Layer
│   ├── atr.ts                              # ATR-based volatility-adaptive SL/TP
│   └── news-sentiment.ts                   # News sentiment (Google News RSS + GDELT + Bing News)
│
├── market-agent/                           # 🎯 Auto pair selection
│   ├── index.ts                            # Market Agent
│   └── hl-rate-limiter.ts                  # HL REST rate limiter (legacy)
│
├── data/                                   # 📡 WebSocket data feeds
│   ├── hyperliquid-websocket.ts            # HL WS (user-level subscriptions)
│   ├── binance-websocket.ts                # Binance WS
│   └── multi-exchange-ws.ts                # Multi-exchange WS manager
│
├── backtest/index.ts                       # 📜 Historical backtesting engine
├── observability/logger.ts                 # Structured logging (Winston)
└── utils/
    ├── shutdown.ts                          # Graceful shutdown handler
    └── hl-global-limiter.ts                # Global HL rate limiter

ui/                                        # 🖥️ React Web UI (pantha_mats design system)
├── src/
│   ├── App.tsx                             # Main dashboard
│   ├── RBCVisualizer.tsx                   # RBC dimension visualizer
│   ├── TradingViewChart.tsx                # TradingView chart (live TP/SL update)
│   ├── StarsBackground.tsx                 # Dynamic starfield background
│   ├── types.ts                            # UI type definitions
│   ├── main.tsx                            # React entry point
│   └── index.css                           # pantha_mats design system
└── index.html

scripts/                                   # 🛠 Utilities
├── loop-engineering.sh                     # Loop engineering runner
├── loop-engineering-deep.sh                # Deep session runner
├── loop-engineering-memory.md              # Known issues / checklist
├── backfill-patterns.mjs                   # Import portfolio trades into pattern DB
└── reset-rbc-symbol.ts                     # Reset RBC state for a single symbol

data/                                      # 💾 Runtime persistence
└── evolution/
    ├── trade-patterns.json                 # Pattern DB
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

When a wallet address is configured, the HL WebSocket subscribes to user-level feeds (`clearinghouseState` + `userFills`) for real-time position + fill sync — no REST polling delay. In real mode the UI shows the actual HL account balance/equity (not the local mirror).

### Decision Cycle Tuning

```env
DECISION_INTERVAL_MS=300000    # 5min between decision cycles
HACP_MAX_DEBATE_ROUNDS=3       # Maximum debate rounds
HACP_CONSENSUS_THRESHOLD=0.60  # Consensus threshold (60%, dynamically adjusted by Evolution)
```

### Risk Parameters

```env
RISK_MAX_LEVERAGE=10.0         # Maximum leverage (Market Agent controls actual)
RISK_STOP_LOSS_PCT=0.02        # Default stop-loss (2%)
RISK_TAKE_PROFIT_PCT=0.05      # Default take-profit (5%)
```

### Per-Symbol Direction Restrictions (v2.0.122)

Restrict a symbol to only one direction (BUY or SELL). Useful for assets that should only be shorted (e.g. commodities with macro headwinds) or only bought (e.g. indices in a bull market). Configured via API or directly in `data/evolution/market-agent-config.json`:

```json
{
  "directionRestrictions": {
    "xyz:SILVER": "sell",
    "btc": "buy"
  }
}
```

Or via API:

```bash
curl -X POST http://localhost:3456/api/market-agent/direction-restrictions \
  -H 'Content-Type: application/json' \
  -d '{"restrictions": {"xyz:SILVER": "sell"}}'
```

When a direction is restricted, the opposite direction is blocked at execution time (overridden to HOLD with `[DIRECTION RESTRICT]` rationale). Agents also see the restrictions in their market context so they don't waste output on blocked directions. Existing positions can still be closed regardless of restriction.

---

## Community

- 🌐 **Homepage**: [mats.trading](https://mats.trading/)
- 💬 **Discord**: [Coming soon — star + watch to be notified](https://github.com/wyc-dev/MATS)
- 🐦 **Twitter**: [@MATS_trading](https://twitter.com/) (coming soon)
- 🤝 **Contributing**: PRs welcome! Fork → branch → PR. See [ARCHITECTURE.md](ARCHITECTURE.md) for system overview.

---

## Roadmap

- **A2A Protocol v1.1** — inter-agent signal exchange with structured handoffs
- **More exchanges** — Binance Futures, OKX, additional perp DEXs
- **Real trading hardening** — additional safety layers, position reconciliation, funding cost tracking
- **Decision audit UI** — visualize gate-by-gate decision flow in the dashboard
- **Backtest visualization** — equity curve + trade markers in the UI

---

## Changelog

### v2.0.131 — Margin Check Uses Total Equity + Max Portion 100% + Price Fallback

- **Margin check fix**: Cumulative margin check now uses total equity instead of free balance. Free balance is reduced by existing position margin, so comparing against free balance blocked all new trades when an existing position used most of the margin.
- **Max portion 100%**: Clamp raised from 50% to 100% in API, MarketAgent, and RealTradingManager.
- **Manual trade price fallback**: Re-fetch using Market Agent's selected symbol when first price fetch fails.

### v2.0.130 — Meta-Agent Override for Active Symbol + adjustPositions for ALL

- **Active symbol override**: Meta-Agent's `marketTicker` decision overrides majority vote for the active symbol (same as trading markets). Previously, 6 sub-agent HOLDs drowned out Meta-Agent's SELL.
- **adjustPositions for ALL**: Now adjusts all open positions, not just the primary symbol. SILVER's SL/TP finally goes through the HACP LLM loop.

### v2.0.129 — Not-Too-Tight SL/TP Constraint

- **Min distance**: SL ≥ 1% from current price, TP ≥ 1.5%. Prevents noise stop-outs from over-tightening.

→ **Full changelog in [CHANGELOG.md](CHANGELOG.md)**

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
| **LLM** | Ollama (local + Pro cloud models) / OpenAI-compatible |
| **Market Data** | Hyperliquid WebSocket (l2Book + trades + activeAssetCtx + clearinghouseState + userFills) + REST fallback |
| **Options Data** | Massive.com / Polygon.io REST API (IV, Greeks, OI, Max Pain, Event Risk) |
| **Frontend** | React 18 + Vite + TradingView Chart (live TP/SL update) |
| **Config Validation** | Zod schema |
| **Logging** | Winston (structured + file rotation) |
| **Codebase** | ~25,000 LOC TypeScript + React UI |

---

## License

[Apache License 2.0](LICENSE)

Copyright (c) 2026 YC Wong

Pantha AI Labs holds a perpetual commercial license under a separate agreement.