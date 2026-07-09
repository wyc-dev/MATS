# MATS — The First Self-Evolving AI Trading Brain

**8 AI agents debate every trade. A Skeptics agent vetoes bad ones. The system evolves its own strategy — no manual tuning.**

MATS is a multi-agent cognitive trading system: 8 specialized agents think in parallel, debate through the HACP protocol, and reach weighted consensus. A dedicated Skeptics agent stress-tests every position before execution. The system self-evolves via online logistic regression (OLR) + shadow trading + first-passage path-risk + EM cycle chains + genetic algorithms — it learns from every trade and adapts its own parameters.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-2.0.140-blueviolet)](ARCHITECTURE.md)
[![GitHub stars](https://img.shields.io/github/stars/wyc-dev/MATS?style=social)](https://github.com/wyc-dev/MATS)

🌐 [mats.trading](https://mats.trading/) · 💬 [Discord](https://discord.gg/mats) (coming soon) · ⭐ [Star on GitHub](https://github.com/wyc-dev/MATS)

---

## 📸 See It In Action

<a href="https://github.com/wyc-dev/MATS/blob/main/docs/dashboard.mp4" target="_blank" title="Click to play the full 27s demo">
  <img src="docs/dashboard.gif" alt="MATS Dashboard demo — 8 AI agents debate every trade in real time" width="100%">
</a>

*10-second loop. [Click for the full 27s demo video](https://github.com/wyc-dev/MATS/blob/main/docs/dashboard.mp4) — real-time HACP debate, Skeptics validation, weighted consensus, live TP/SL on TradingView, self-evolution metrics.*

### Backtest equity curve — coming soon

> 📈 Backtest results being generated. ⭐ Star + watch the repo to be notified when the equity curve lands.

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

- **🧠 Entry Thesis System** — every trade needs a validated `[1h: ...] [1d: ...]` rationale. Meta-Agent generates it; Skeptics stress-tests it. No thesis → no trade.
- **🛡️ Skeptics veto** — an AI stress-tests every position's logic, data consistency, and dark-psychology (whale manipulation?) before execution. Approve-first: rejects only on concrete money-losing flaws.
- **🧬 Self-evolving** — OLR learns P(win) per side from shadow + paper + real trade outcomes. First-Passage gives instant path-risk. GA mutates strategy parameters by weakest fitness dimension. EM cycle chain carries insights across cycles.
- **⚡ HACP protocol** — 5 sub-agents think in parallel (staggered, 60s deadline race), Skeptics audits, Meta-Agent arbitrates, weighted voting consensus. 120s hard timeout → HOLD on expiry.
- **💰 Capital preservation first** — every error path defaults to HOLD. SystemGuard (5 layers). Notional-based fees. SL/TP hard safety layers. Configurable max portion + drawdown + daily-loss limits.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│   Layer 1: Strategic (PI Agent)                              │
│   • System start/stop · performance review · manual override  │
├──────────────────────────────────────────────────────────────┤
│   Layer 2: Cognitive (TypeScript + LLM)                      │
│   • HACP protocol (parallel multi-model inference)            │
│   • 8-agent system + Meta-Agent arbitration                   │
│   • Entry Thesis System (Meta-Agent → Skeptics validation)    │
│   • Self-evolution (OLR + Shadow + First-Passage + EM + GA)   │
│   • SystemGuard (5-layer protection)                          │
├──────────────────────────────────────────────────────────────┤
│   Layer 3: Execution (TypeScript Runtime)                     │
│   • Hyperliquid WebSocket + REST (9 perpetual DEXs)           │
│   • Risk engine (millisecond, no LLM)                         │
│   • Paper trading (leverage-aware P&L) + Real Trading Manager │
│   • Position tracking & SL/TP · persistence · observability   │
└──────────────────────────────────────────────────────────────┘
```

→ Full architecture in [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Project Structure

```
src/
├── agents/                             # 🧠 8 agents + Meta-Agent
│   ├── base-agent.ts                   # Base agent (LLM call + retry + confidence)
│   ├── meta-agent.ts                   # Meta-Agent (arbitration + entryThesis)
│   ├── skeptics.ts                     # Skeptics (logic audit + thesis validation)
│   └── agents.ts                       # 5 sub-agents (Fractal/OnChain/OLR/News/Risk)
├── cognition/                          # 🧠 Inter-agent cognition
│   ├── hacp.ts                         # HACP protocol (Phase 0-5 + thesis gates)
│   ├── a2a-utils.ts                    # A2A inter-agent signal exchange
│   └── A2A-PROTOCOL.md
├── llm/                                # 🔌 LLM abstraction (provider + circuit breaker)
├── trading/                            # 💹 Portfolio · paper/real engines · cost model
├── risk/                               # 🛡️ Risk engine + correlation budget
├── system-guard/                       # 🛡️ SystemGuard (calendar/drawdown/freshness/track/liquidity)
├── evolution/                          # 🧬 Self-evolution + EXP vector thesis memory
│   ├── index.ts                        # GA orchestrator (directional mutation)
│   ├── olr-engine.ts                   # OLR (Online Logistic Regression, per-symbol/side)
│   ├── shadow-trade-engine.ts          # Shadow trades (simulated TP-before-SL)
│   ├── first-passage.ts                # First-Passage P(TP before SL) — Cox & Miller GBM
│   ├── olr-backfill.ts                 # Cold-start backfill from historical HL candles
│   ├── embeddings.ts                   # v2.0.138: Transformers.js MiniLM 384-d vectors (in-process)
│   ├── thesis-experience.ts            # v2.0.138: EXP thesis-combo historical win-rate gate (Phase 1.8a)
│   ├── experience-digester.ts          # v2.0.140: A2A Experience Digester (LLM lesson → embed → cluster → classify)
│   ├── trade-pattern-classifier.ts     # Supervised KNN pattern DB (Wilson score)
│   ├── cycle-summary.ts                # EM Cycle Summary Manager (tiered memory)
│   ├── agent-outcomes.ts               # Per-agent performance tracking
│   └── agent-evolution.ts              # Dynamic voting weights by regime win rate
├── analysis/                           # 📊 Sentiment · S/R · ATR · Planck-Chaos · options · news
├── market-agent/                       # 🎯 Auto pair selection (9 HL DEXs, 416 assets)
├── data/                               # 📡 Hyperliquid + Binance WebSocket feeds
├── api-server.ts                       # 🌐 REST + SSE (port 3456) + static UI
└── index.ts                            # 🚀 System orchestrator (decision cycle)

ui/                                     # 🖥️ React + Vite dashboard (:5173)
data/evolution/                         # 💾 olr-state · shadow-state · patterns · GA state
tests/                                  # ✅ vitest (94 tests, 5 test files)
```

---

## Self-Evolution System (v2.0.135) + EXP Vector Thesis Memory (v2.0.138)

**EXP Vector Thesis Memory (v2.0.138)** (`thesis-experience.ts` + `embeddings.ts`): Every closed trade's rationale combination is embedded into a vector (transformers.js MiniLM 384-d, in-process) and stored in `data/exp/trades.jsonl`. On new entries, Skeptics Phase 1.8a `checkThesisHistory` finds the closest historical combination via asymmetric set-to-set similarity and computes a similarity-weighted P(win): no history → direct open; winning combo → fast-approve; losing combo + confirming delta → approve-with-note; losing combo + contradicting delta → reverse-direction; no delta → reject→HOLD. Cold-start dormant until `EXP_ENABLED=true`. PnL=0 excluded. Self-healing fallback to subjective 1.8b on error.

**Layer 1 — OLR** (`olr-engine.ts`): Per-symbol, per-side online logistic regression with Welford z-score normalization. Learns P(win) from shadow + paper + real + backfill outcomes (TP-before-SL). Source-weighted (real=4, paper=2, shadow=1, backfill=0.3; backfill excluded from decay). Per-feature Welford counts so missing features return neutral z=0. Confidence: high(≥50)/medium(≥20)/low.

**Layer 1b — Shadow Trading** (`shadow-trade-engine.ts`): Opens simulated LONG + SHORT every cycle with S/R-aligned SL/TP. Multi-candle hold: scans forward up to 20 candles, resolves on first SL/TP hit; unresolved skipped (no fabricated labels). Feeds outcomes to OLR.

**Layer 1c — First-Passage** (`first-passage.ts`): Instant P(TP before SL) from volatility (σ of log-returns) + log-drift (ν) + per-side S/R SL/TP distances. Cox & Miller (1965) GBM formula. RR-aware: compares to breakeven P = a/(a+b), not 50%. Returns 50% when vol too low.

**Cold-Start Backfill** (`olr-backfill.ts`): First cycle per market replays 186 historical HL M5 candles into OLR. Non-blocking; idempotent (skips warm markets ≥20 samples).

**Layer 2 — EM Cycle Chain** (`cycle-summary.ts`): Meta-Agent distills each cycle → structured summary; previous summaries feed next cycle. Tiered memory: hot(12) + warm(288) + cold(48 epochs).

**Layer 3 — GA + Pattern DB**: Survival Fitness (Profit Efficiency 35% + Return 25% + Capital Preservation 20% + Win Quality 10% + Consistency 5% + Adaptability 5%). Directional mutation toward weakest dimension. KNN pattern DB with Wilson-score 95% confidence lower bound + time-weighted win/loss (half-life 7 days).

---

## 8-Agent System

| # | Agent | Temp | Weight | Role |
|:-:|:------|:----:|:------:|:-----|
| 1 | **Market Agent** | — | — | Auto-selects highest-volume pair across 9 HL DEXs / 416 assets, by category. Blocks cycle until selected. |
| 2 | **Fractal Momentum Sentinel** | 0.85 | 0.10 | Multi-timeframe fractal breakout detection. Early trend acceleration. |
| 3 | **On-Chain Whisperer** | 0.50 | 0.10 | Category-aware on-chain: crypto (mempool, flows, supply) + TradFi (DXY, COT, commodities). |
| 4 | **OLR & Sentiment Analyst** | 0.25 | 0.10 | OLR P(win) per side + First-Passage path-risk + Fear & Greed. RR-aware edge vs breakeven. |
| 5 | **News Reporter** | 0.40 | 0.20 | **Institutional Narrative Decoder (v2.0.139)**. 5-part framework: information-asymmetry prior, price-news timing matrix, 6-bucket motive taxonomy, power-map, net institutional-adjusted signal. L3 Meta-Agent decisive override when named motive + price confirmation. Weight 0.10→0.20. |
| 6 | **Independent Risk Auditor** | 0.10 | 0.25 | Advisory-only (no veto). TP/SL/size suggestions + hard-coded loss-streak/choppy-market limits. |
| 7 | **Skeptics** | 0.30 | 0.00 | Logic auditor + thesis stress-tester. Approve-first; rejects only on concrete flaws. Validates entryThesis (Phase 1.8) + re-validates held positions (Phase 0.5). |
| 8 | **Meta-Agent** | 0.45 | 0.00 | Arbitration chairman. Detective mode — reasons from facts to find edges, never distorts. Generates entryThesis. Weight 0.00 (thesis system controls, not voting). |

---

## Risk Management

| Parameter | Default | Description |
|:----------|:-------:|:------------|
| Max position | 20% | Single trade cap of equity (hard clamp) |
| Max drawdown | 20% | Halt all trading above this |
| Daily loss limit | 5% | No new trades rest of day |
| Max leverage | 10x | Market Agent sets per-asset; Meta-Agent tunes 1-10x by risk/confidence |
| Stop loss | 2% | Per trade (un-leveraged) |
| Take profit | 5% | Per trade (un-leveraged) |
| Trailing stop | 1.5% | Activates in profit |
| Cumulative margin | 20% | All positions' margin ≤ 20% balance |

SL/TP three-layer safety: no-widen + not-too-tight (SL ≥ 1%, TP ≥ 1.5%) + min-gap + max-narrow-step.

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
```

### Per-Symbol Direction Restrictions
Restrict a symbol to BUY-only or SELL-only via API or `data/evolution/market-agent-config.json`. Useful for commodities with macro headwinds (short-only) or bull-market indices (buy-only).

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
| **Testing** | vitest (94 tests, 5 test files) |
| **Codebase** | ~42,000 LOC TypeScript + React UI |

---

## Changelog

### v2.0.140 — A2A Experience Digester + Premature Close Prevention + Volatility Fix

**A2A Experience Digester** — every closed trade is LLM-digested into a structured `LessonStatement` (OBS + ASSESS + rootCause + exitType + lesson), embedded into a condensed vector, and clustered into `ExperienceClass`. New candidate theses are classified against class centroids → verdict. The `digestTrade` LLM prompt forces 5-layer root cause diagnosis. `getDigestSummary()` produces a 7-layer structured digest injected into agent prompts. `expActions` action log wired through HACP → API → UI.

**Premature Close Prevention** — the system's biggest recurring problem is NOT tight SL/TP, it's Meta-Agent + Skeptics initiating manual closes that ignore the actual price structure. Three gatekeeper prompts rewritten with mandatory checks (price level breached? SL/TP hit? position ≥15min? digest shows premature history? direction still correct?). Skeptics defaults → VALID/BLOCK (when in doubt, keep open).

**Volatility calculation fix** — `MarketStateAggregator.calcVolatility()` was using mean of |arithmetic returns| (underestimates ~20%), causing ALL regimes to classify as `low_volatility`. Fixed to std of log returns.

**Visual Experience Digestion UI** — fully visual: W/L bar, exit quality bars, class cards with win-rate bars + exit-type badges, per-symbol table with PnL color coding, volatility anomaly banner, root cause diagnosis. No raw text dump.

**17 new tests** (total 94). `tsc --noEmit` clean. UI build clean.

### v2.0.139 — News Reporter v2 Institutional Narrative Decoder + Real-Trading Hardening + Live Mark Price

**News Reporter v2** — financial news is a WEAPON, not information. 3-layer upgrade:
- **L1 data enrichment**: `PriceNewsTiming` (1h/4h/24h/3d price changes, `movedBeforeNews` front-run tell, headline cadence, source clustering, dominant angle) from 80 1h candles via same-asset routing + 5-min cache.
- **L2 prompt upgrade**: 5-part Institutional Narrative Decoder (information-asymmetry prior, price-news timing matrix, 6-bucket motive taxonomy, power-map, net signal). Weight 0.10→0.20.
- **L3 Meta-Agent decisive weighting**: engineered-play detection with price confirmation may override HOLD-lean majority; guardrail requires both named motive AND timing confirmation.

**A+B conviction fixes**:
- **A**: removed Meta-Agent self-censoring (was told the gate threshold + instructed to HOLD below it → self-fulfilling paralysis). Now emits honest conviction; gate filters independently.
- **B**: OLR edge weighted by `magnitude × confidence-label` (not raw sample count). +58pp high-confidence edges no longer discarded during cold-start.

**BTC wallet trailing-zero fix**: `quantity.toFixed(szDecimals)` produced trailing zeros → HL normalizes before signature re-hash → mismatch → ECDSA recovery yields garbage wallet → "User or API Wallet does not exist". Fix: `stripTrailingZeros()` on all signed numeric fields.

**3 critical bug fixes (from first real trades)**:
1. **Leverage config authoritative** — agent LLM's 5x was overriding Market Agent's 10x. Config is now the single source of truth.
2. **Closed-fill display leverage** — hardcoded `?? 10` masked the real 5x. Added `lastKnownLeverage` cache.
3. **SL/TP REST-lag race** — after a fill, HL REST lags 2-5s; `adjustPosition` now accepts `knownPosition` from the caller's fill data to place SL/TP on the open cycle.

**Consensus gate + Evolution cleanup**: threshold 0.70→0.50 (floor 0.49); `getPortfolioSummary` uses `currentDrawdownPct` (recovers) not `maxDrawdownPct` (high-water mark); removed EvolutionStats UI + global aggregate injection (caused over-conservatism).

**Placeholder thesis gate + live Mark price**: broadened `isThesisPlaceholder` to catch `[1h: N/A — hold]`-style placeholders (BLOCK BUY/SELL). Fixed UI Mark=Entry by introducing `cachedPriceMap` (live prices per cycle) + `refreshPositionMarkPrices()` (async, on-demand fetch for late-imported positions) + `serializePortfolio` fallback using cached live price.

### v2.0.138 — EXP Vector Thesis Memory (Skeptics Phase 1.8a Historical Probability Gate)

Every closed trade's rationale combination is embedded (transformers.js MiniLM 384-d, in-process) and stored. On new entries, Skeptics Phase 1.8a `checkThesisHistory` gates by thesis-combo historical win-rate: no history → direct open; winning combo → fast-approve; losing + contradicting delta → reverse-direction; no delta → reject→HOLD. Cold-start dormant until `EXP_ENABLED=true`. Self-healing fallback to 1.8b. 24 new tests (total 77). Files: `src/evolution/embeddings.ts`, `src/evolution/thesis-experience.ts`, `scripts/reindex-exp.ts`.

### v2.0.137 — Thesis Freeze (Root Cause B: fix over-trading + low win rate)

`setEntryThesis()` → set-if-absent. The original opening rationale is now FROZEN until close; previously each cycle's latest Meta-Agent thesis overwrote it → Skeptics re-validated a moving target → sometimes overwritten to `'N/A'` → auto-invalidated → forced close 6-15 min later → churn loop. `holdReason` remains live per-cycle reasoning (not re-validated). 5 regression tests.

### v2.0.136 — Execution Bug Fixes + UI Position Label Fixes

7 bugs blocking real trading + UI display: `normalizeDecision()` dropping `entryThesis`; `buildConsensus()` hardcoded `BTCUSDT`; missing `entryPrice`; BTC SELL "could not immediately match" (l2Book case-sensitivity — use canonical `asset.name` not lowercase); Portfolio "Reason" vanishing after 1st cycle (`forceMirror` now bypasses `assessTrade()` too); HACP debate position badge flicker (UI uses actual portfolio, not `hasPosition`); SL/TP validation spam on qty=0 placeholders.

### v2.0.135 — OLR + Shadow + First-Passage Production Hardening + Cold-Start Backfill + Full Agent Cognition Integration

- **First-passage math fixes**: C1 (LONG/SHORT formula swap), C2 (raw μ → log-drift ν), M4 (per-side SHORT SL/TP). Cox & Miller GBM scale-function derivation.
- **OLR hardening**: per-feature Welford counts (missing features → neutral z=0), backfill source (weight 0.3, decay-excluded), cold/stale/warm detection, NaN guards.
- **Shadow trading**: multi-candle hold (≤20, no fabricated labels), S/R-aligned SL/TP via pivot detector + ATR fallback.
- **Cold-start backfill**: non-blocking replay of 186 historical HL candles into OLR. Idempotent. Live-verified: 945 samples / 3 markets / ~1s.
- **Full agent cognition integration**: shared `buildOLRBlock()` helper injects complete OLR + First-Passage + edge data to OLR & Sentiment Analyst AND Meta-Agent (active symbol + all positions + all trading markets). Meta-Agent OLR prompt rewritten from stale RBC docs to RR-aware edge arbitration. Source breakdown exposed for all symbols in API.
- **UI**: Agent Cognition legend RBC → OLR; Evolution panel breakeven-aware first-passage + source-breakdown row; deleted dead `RBCVisualizer.tsx`.
- **Tests**: 41 passing. `tsc --noEmit` clean. UI build clean.

→ Full history in `git log`.

---

## Community

- 🌐 **Homepage**: [mats.trading](https://mats.trading/)
- 💬 **Discord**: [coming soon — star + watch to be notified](https://github.com/wyc-dev/MATS)
- 🐦 **Twitter**: [@MATS_trading](https://twitter.com/) (coming soon)
- 🤝 **Contributing**: PRs welcome! Fork → branch → PR. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system overview.

## Roadmap

- **Backtest visualization** — equity curve + trade markers in the dashboard UI
- **More exchanges** — Binance Futures, OKX, additional perp DEXs
- **Decision audit UI** — gate-by-gate HACP decision flow visualization
- **Real trading hardening** — position reconciliation, funding cost tracking, multi-DEX balance
- **Multi-model ensemble** — per-agent model routing across Ollama / cloud providers

---

## Commercial Licensing

**Pantha AI Labs** holds a perpetual, irrevocable commercial license. For all other use, MATS is open source under **Apache License 2.0**. Contact YC Wong for commercial licensing.

## License

[Apache License 2.0](LICENSE) · Copyright (c) 2026 YC Wong