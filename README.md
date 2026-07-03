# {MATS} — Multi-Agent Trading System

> **A self-evolving, multi-agent quantitative trading framework powered by the Hyper-Accelerated Cognition Protocol (HACP).**  
> Institutional-grade trading across Hyperliquid perpetual markets — crypto perps, stocks, indices, and RWA synthetic equities, with an integrated Options Data Layer for equities trading.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.0.108-blueviolet)](ARCHITECTURE.md)

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
| **Fractal Momentum Sentinel** | Fractal pattern & trend analyst | 0.85 | 0.10 |
| **On-Chain Whisperer** | On-chain data & macro analyst | 0.50 | 0.10 |
| **RBC & Sentiment Analyst** | RBC clusters + Fear & Greed specialist | 0.25 | 0.10 |
| **News Reporter** | Shadow Strategist news motive analyzer | 0.40 | 0.10 |
| **Independent Risk Auditor** | Risk limits + regime-aware TP/SL (advisory-only, cannot veto) | 0.10 | 0.25 |
| **Skeptics** | Logic auditor + **absolute veto on new positions** (thesis validation + dark psychology audit + close decision validation) | 0.30 | — |
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
9. **3-5 sentences minimum** reasoning per symbol — no truncation, no silence

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
- Skeptics cross-check insight vs actual price (convergence audit)
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

- **Skeptics absolute veto** over new positions — thesis must be strong, specific, data-driven, and free from manipulation blind spots
- **Risk Auditor advisory-only** — cannot block trades, only suggests TP/SL/size adjustments; hardcoded safety layers (choppy market 50% cut, loss-streak graduated reduction) retained
- **Graceful degradation**: every error path defaults to HOLD
- **Notional-based double-sided fee deduction** — HL taker fee (0.04%) charged on leveraged notional; paper PnL reflects real cost
- **Configurable max portion** — user-configurable max % of balance for all positions combined (10%-50%)
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

---

## Commercial Licensing

**Pantha AI Labs** holds a perpetual, irrevocable commercial license to use, modify, and distribute MATS. This license is governed by a separate agreement between YC Wong and Pantha AI Labs, and is independent of the Apache 2.0 open-source license.

For all other use, MATS is open source under the **Apache License 2.0**.

If you require a commercial license — for example, for proprietary extensions, redistribution without open-source obligations, or enterprise support — please contact YC Wong.

---

## Changelog

### v2.0.108 — Fix Trading Markets Not Analyzed + EADDRINUSE Recovery

- **EADDRINUSE recovery** (v2.0.108): API Server detected port 3456 already in use → silently failed → UI could never send trading markets to backend. Now handles `EADDRINUSE` by killing the old process and retrying.
- **Immediate cycle on market change** (v2.0.108): When UI sends trading markets via POST, an immediate decision cycle is triggered (1.5s delay). Previously the first cycle ran before UI connected, and the 300s interval meant waiting 5 minutes for the next cycle — so agents only analyzed the auto-selected symbol, not the user's trading markets.
- **Rate limiter exhaustion fix** (v2.0.107): v2.0.106 `selectFilterProfile()` called `fetchPriceForSymbol` for each trading market BEFORE the injection code, exhausting the HL rate limiter. Injection then failed for xyz: symbols → markets skipped. Fixed by using `autoDetectProfile` (no API call) for initial assignment, and re-evaluating profiles using cached `marketState` data.
- **Double-fetch elimination** (v2.0.107): Prices fetched in `buildMarketDescription` are now cached and reused in the injection code, avoiding double-fetching and rate limiter exhaustion.
- **Injection never skips** (v2.0.107): Even if `fetchPriceForSymbol` fails for a trading market, the market is still injected with `price=0` + `marketState` fallback. Previously the `continue` on error caused markets to be silently dropped.

### v2.0.106 — Per-Asset Adaptive Noise Filter + Market Agent Judgment

- **Per-asset filter profiles** (v2.0.106): Market Agent selects one of 7 filter profiles for each asset based on its real market data (volatility, liquidity, volume, 24h change). Each profile defines different EMA alpha ranges, sigmoid k ranges, conviction gate bounds, and trade frequency limits. Profiles: `high_vol_crypto` (BTC/ETH), `low_vol_crypto` (stablecoins), `high_vol_alt` (meme coins), `dex_perp` (xyz: assets), `forex_index` (EURUSD/SP500), `commodity` (gold/oil), `default`.
- **Per-asset AdaptiveNoiseFilter** (v2.0.106): Each asset gets its own independent filter instance with separate channel states (price, OB imbalance, volume, funding, spread, momentum, large trades, fear/greed, volatility). Filter adapts per-cycle based on: market volatility (high vol → more smoothing), recent trade performance (losses → more smoothing), trade frequency (over-trading → raise conviction gate), and SNR (low signal-to-noise → more smoothing).
- **Meta-Agent filter awareness** (v2.0.106): Meta-Agent receives per-asset SNR data, conviction gates, and throttle status in its context. It must factor this into every decision: SNR < 30% → prefer HOLD, SNR 30-50% → reduce position size, throttled → HOLD. Meta-Agent prompt includes detailed instructions for interpreting filter data.
- **Trade frequency throttle** (v2.0.106): Each asset has its own trade frequency limit (e.g. BTC: 3 trades per 10 cycles, meme coins: 2 trades per 15 cycles). When limit is reached, new entries for that asset are blocked — prevents over-trading on noise.
- **Conviction gate** (v2.0.106): Each asset has its own adaptive conviction threshold. Consensus confidence below the gate → trade blocked. Gate adapts: over-trading → raise gate, under-trading + winning → lower gate, losing → raise gate.

### v2.0.104 — Multi-Symbol Single-Cycle + Trading Market Injection

- **Trading market injection** (v2.0.104): Non-position trading markets are now injected into `currentPositions` with `isTradingMarket=true` and `quantity=0`. Agents see ALL trading markets in `positions[]` and output BUY/SELL/HOLD for each in a single HACP cycle. Full market context (price, trend, regime, RBC, S/R) is generated for each trading market and appended to `marketDesc`. The `MultiSymbolDecision.positions[]` now serves dual purpose: open position management (CLOSE/HOLD) AND trading market analysis (BUY/SELL/HOLD). Agent prompts updated to explain the distinction. HACP thesis validation checks `quantity > 0` to distinguish real positions from trading markets.
- **Thesis-mandatory close** (v2.0.103): Closing a position now REQUIRES entry thesis invalidation as a MANDATORY condition, plus ≥2 of the other 5 conditions. If the thesis is still valid → HOLD, no exceptions. This prevents panic-closing on short-term price noise. Meta-Agent prompt, Skeptics close validation, and reasoning chain all updated to enforce this.
- **Multi-symbol single-cycle** (v2.0.103): Reverted the v2.0.100 sub-cycle approach (separate HACP cycle per market). ALL trading markets are now analyzed in ONE HACP cycle. Entry decisions for trading markets are executed via the `perSymbolConsensus` loop.

### v2.0.92–v2.0.94 — Extreme Reasoning + RBC/S/R for All Positions + Bug Fixes

- **Extreme reasoning** (v2.0.93, updated v2.0.103): No position → MUST decide BUY/SELL (HOLD only when ALL 6 signals absent). Has position → MUST decide CLOSE/HOLD. CLOSE requires thesis invalidated (MANDATORY) + ≥2 of 5 other conditions. HOLD is the default. Even with no data, reason from first principles. 3-5 sentences minimum per symbol.
- **RBC + S/R for all open positions** (v2.0.92): Previously only generated for the active symbol. Now every open position gets RBC edge assessment + S/R zones in agent context.
- **Phase 1.8 skip for existing positions** (v2.0.94): Thesis validation skipped if symbol already has a position — marketTicker BUY/SELL for a symbol with an existing position is NOT a new entry.
- **Legacy close on Meta-Agent decision** (v2.0.94): Legacy positions (no entryThesis) now close when Meta-Agent decides CLOSE, not just when ≥2 sub-agents vote close.
- **UI: Meta-Agent reasoning always expanded** (v2.0.94): holdReason/entryThesis no longer truncated to 2 lines.

### v2.0.79–v2.0.91 — Entry Thesis System + Dark Psychology + Skeptics Absolute Veto

The most significant cognitive architecture upgrade. Meta-Agent operates as a detective — every cycle it aggressively reasons from sub-agent data to find subtle trade edges ("蛛絲馬跡"), but must NEVER distort facts. When it finds an edge, it generates an `entryThesis` explaining why price will reach TP within 1h and 1d. **Skeptics has absolute veto power** over new positions — validates thesis for strength, specificity, data consistency, dark psychology (whale manipulation?), and fact distortion.

- **Phase 0.5**: Re-validates open position theses each cycle with fresh market data → invalidated → force-close
- **Phase 1.8**: Validates Meta-Agent's entryThesis before trade is allowed
- **Phase 4.8**: Final hard gate — BUY/SELL without valid+validated thesis → BLOCK
- **Meta-Agent weight → 0.00** (thesis system controls, not voting)
- **Sub-agent weights → 0.10** (data-gathering role, confidence is reference for Skeptics)
- **Risk Auditor → advisory-only** (cannot veto, only suggests TP/SL/size adjustments)
- **`holdReason`** required for HOLD decisions — displayed in UI
- **Dark Psychology**: Meta-Agent must question whether data is whale manipulation
- **Close validation** (v2.0.90): Closing thesis-backed positions also goes through Meta-Agent → Skeptics validation
- **Legacy positions** (v2.0.91): Positions without entryThesis (pre-v2.0.80) use sub-agent majority vote for closing
- **Sub-agent BUY/SELL signals** (v2.0.85): Meta-Agent must pay special attention when sub-agents output directional signals
- **Active position management** (v2.0.87): Meta-Agent must actively evaluate closing positions every cycle
- **No backward-looking blocking** (v2.0.88): Past drawdown/losses are NOT valid reasons to reject trades — RBC learns, market changes
- **UI improvements**: Per-symbol rationale with independent expand/collapse, dynamic confidence bar colors (HSL gradient), removed obsolete Temp/Weight/Decisions display

### v2.0.78 — Configurable Max Portion + Real Trading Margin Check

`maxPortionPct` (10%-50%) replaces hardcoded 20% cumulative margin cap. UI slider in Market Agent panel. Enforced in both paper engine AND real trading manager.

### v2.0.76–v2.0.77 — Global HL Rate Limiter + WS Infinite Reconnect

Global rate limiter replaces 6+ scattered per-module limiters with one queue (200ms gap = 5 req/s). WS reconnect retries forever (backoff caps at 60s). REST polling exponential backoff (30s → 5min cap).

### v2.0.69–v2.0.75 — SL/TP UI + Symbol Debounce + S/R DEX Fix + News Reporter Rewrite

SL/TP UI display fix, symbol selection debounce, S/R + ATR candle fetch fix for DEX 1-8, News Reporter rewrite (Google News RSS + GDELT + Bing News, multi-symbol, hidden strategist persona), UI masonry layout.

### v2.0.58–v2.0.68 — Options Data Layer + Options-aware Evolution

Options Data Layer connecting to Massive.com/Polygon.io. Regime → Playbook mapping. Options-aware evolution (`OptionsStrategyParameters` + `SurvivalFitness.optionsAlpha`). Plan detection + dynamic vote weight.

### v2.0.32–v2.0.57 — HL Real Trading Fixes + SL/TP Safety + Position Management

HL signing rewrite (phantom agent EIP-712), xyz DEX asset index offset, SL/TP direction fixes, phantom close fix (8 code paths), paper balance inflation fix, S/R-based SL/TP, pro algo firm SL/TP (fill-first + retry + safety-close), HL SL/TP close detection, stale real position cleanup, real trade persistence, consensus directional agreement fix, learning decay, MAX_POSITION_PCT removal, drawdown high-water mark fix, manual market selection, SL/TP HL bidirectional sync, PnL leverage inflation fix, SL/TP retry loop + slower narrowing, SL/TP max narrowing step, error trade filter, per-symbol consensus SL/TP direction validation.

### v2.0.10–v2.0.31 — Math Audit + LLM Resilience + Evolution + HL WS + Real Trading

Math audit (13 numerical fixes), LLM resilience (circuit breaker + deadline race), Risk Auditor regime-aware TP/SL, evolution enhancement (directional mutation + agent-level evolution + regime-aware strategy), HL WS user-level subscriptions, real-trade UI balance, notional-based fee deduction, unrealized PnL includes entry fee, TradingView TP/SL live update, fitness breakdown fix, dailyPnl auto-reset, SL/TP close learning hook, loss cooldown + LLM review, LLM pattern tag tracking, legacy position management, manual close button, multi-DEX balance + positions.

### v2.0.0–v2.0.9 — Foundation + RBC + Pattern Classifier + SystemGuard

Multi-agent system, HACP protocol, Ollama integration, Binance WS, risk engine, paper trading, dual memory, survival fitness, evolutionary pressure, Sigmoid·GA sentiment engine, S/R zone detection, RBC engine (layered decay + time-weighted centroid), trade pattern classifier (Wilson score), EM cycle chain, backtest engine, loop engineering, real trading interface, TradingView chart, agent model selector, live progress, Fear & Greed index, leverage 2-10x, cumulative position cap, atomic write, schema validation.

See [ARCHITECTURE.md](ARCHITECTURE.md) for full details on each fix.

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
