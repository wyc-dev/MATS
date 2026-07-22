# MATS — The First Self-Evolving AI Trading Brain

**9 AI agents debate every trade. A Skeptics agent vetoes bad ones. A System Engineer agent autonomously fixes its own bugs. The system learns from every trade outcome — not just whether it won or lost, but WHY it won or lost, under WHAT market conditions, and feeds that back into the next decision.**

A dedicated Skeptics agent stress-tests every position against historical experience data. The system self-evolves via a **22-layer cognitive evolution pipeline**: online logistic regression (OLR) → shadow trading → first-passage path-risk → EM cycle chains → genetic algorithms → RIL pattern clustering → **Numeric Autoencoder** (learned non-linear market embedding) → **AttnRes cycle-history retrieval** (Kimi K3 attention residual transfer) → **dual pseudo-query specialization** (decision vs execution) → **anti-pattern memory** (failure lesson clustering) → **conditional WR soft gate** (code-level enforcement) → **combo WR gate** (symbol×side×regime Wilson LB) → **OLR P(win) × consensus discount** (multiplicative confidence scaling) → **execution-lens SL/TP** (stop-out-trained direct SL/TP control) → **experience replay buffer** (prioritized mini-batch retrain) → **Bayesian OLR** (MC Dropout uncertainty quantification) → **temporal attention** (cross-trade regime learning) → **cross-symbol shared backbone** (transfer learning) → **reward shaping** (5-component risk-adjusted reward) → **active exploration** (UCB + information gain) → **world model** (latent dynamics + rollout planning) → **close-context-aware learning** (closeReason + slNarrowed weighted learning).

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/wyc-dev/MATS?style=social)](https://github.com/wyc-dev/MATS)

🌐 [mats.trading](https://mats.trading/) · 💬 [Discord](https://discord.gg/mats) (coming soon) · ⭐ [Star on GitHub](https://github.com/wyc-dev/MATS)

---

## 📸 See It In Action

<a href="https://github.com/wyc-dev/MATS/blob/main/docs/dashboard.mp4" target="_blank" title="Click to play the full 16s demo">
  <img src="docs/dashboard.gif" alt=" MATS Dashboard demo — 8 AI agents debate every trade in real time" width="100%">
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
npm run engineer    # Autonomous mode: trading + System Engineer self-repair + auto-restart on code fix
```
Open **http://localhost:5173/** for the dashboard. The API server runs on :3456.

`npm run engineer` runs MATS with the System Engineer agent enabled. Every 2 cycles (when cycle period ≥ 5 min), the System Engineer examines trade records + source code, detects learning system bugs, and autonomously fixes them. The fix is validated via `tsc --noEmit` + `npm test` — if either fails, the change is automatically rolled back. If both pass, the fix is committed and the process restarts to load the new code. This is the only supported production launch mode.

---

## Why MATS is Different

- **🤖 Terminal Agent + Root Command Prompt** — users type natural language trading preferences (e.g., "only trade on Monday GMT"). LLM integrates them into a Root Command Prompt. Before each cycle, rules are checked — if a rule fails, the entire cycle is aborted (no token cost). After the Meta-Agent decides, the Terminal Agent verifies that the decision matches user preferences.
- **🧠 Entry Thesis System** — every trade needs a validated `[1h: ...] [1d: ...]` rationale. Meta-Agent generates it; Skeptics stress-test it.  No thesis → no trade.
- **🛡️ Skeptics veto** — an AI stress-tests every position's logic, data consistency, and dark-psychology (whale manipulation?) before execution. Approve-first: rejects only on concrete money-losing flaws. Dark-psychology check escalates from LIGHTWEIGHT to **MANDATORY** when |momentum| > 2% — must articulate a specific reversal catalyst or reject.
- **🧬 21-Layer Cognitive Evolution** — the system doesn't just learn win/loss counts. It learns **which market conditions** precede wins, **which regime patterns** precede stop-outs, **which historical cycles** are most relevant right now, and **what the next market state will look like** — through a stack of learned representations (see below).
- **🔬 Numeric Autoencoder** — a pure-TypeScript MLP (11→16→8 encoder + contrastive loss) learns a non-linear embedding of market conditions. "Similar market conditions" is no longer handcrafted min-max cosine — it's a learned representation where "similar" means "historically led to similar outcomes." Cold-start safe: min-max fallback until 200+ samples + validation pass.
- **🌀 AttnRes Cycle-History Retrieval** — transferred from Kimi K3's Attention Residuals (arXiv 2603.15031). The conditional win-rate candidate is no longer a single current snapshot — it's a **softmax-weighted blend over 80 cycles of history + entry-time state**, with a learned pseudo-query deciding which historical periods matter most right now. Entry-time regime retains persistent weight (K3 embedding persistence). Block AttnRes compresses 80 cycles → 8 blocks for O(Nd) memory.
- **⚔️ Dual Pseudo-Query Specialization** — two learned queries per symbol, inspired by K3's pre-attention vs pre-MLP layer specialization: **wDecision** (broad receptive field, trained on trade PnL) for conditional win-rate + thesis context; **wExecution** (sharp/recent-biased, trained on SL/TP stop-out outcomes) for SL/TP survival context.
- **🎯 Execution-Lens SL/TP** — `computeATRSLTP` uses the execution-mode AttnRes blend as the **PRIMARY** SL/TP signal. wExecution has learned which regime patterns precede stop-outs — when the current regime matches, SL widens automatically (up to 6%), with volatility scaling + entropy confidence damping. Falls back to ATR + raw momentum when wExecution is untrained (cold-start).
- **🚨 Anti-Pattern Memory** — failed trade lessons are clustered (cosine 0.78) into anti-pattern classes. When a new candidate matches a known failure cluster, Skeptics sees: "Anti-pattern #3 [78% match]: counter-momentum SELL stop-out — 6 losses, avg -7.2%." Repeating a known failure pattern is worse than a novel loss.
- **🔒 Conditional WR Soft Gate** — code-level conviction penalty: if the conditional win-rate (learned embedding + AttnRes blend) is < 20%, conviction is penalized +35%. This runs even if the LLM ignores the prompt — **the code enforces what the prompt suggests**.
- **🎯 Combo WR Gate** (v2.0.221) — tracks (symbol × side × regime) win rate with Wilson score lower bound. Injects PRE-thesis warning into Meta-Agent. WR<25% → +50% conviction penalty. Stacks with conditional WR + loss-streak gates.
- **🔢 OLR P(win) × Consensus Discount** (v2.0.224) — multiplicative confidence discount: `effectiveConfidence = consensus × (0.3 + 0.7 × P(win))`. P(win)=29% × 90% consensus = 45% → HOLD. Fixes the gap where overconfident agents bypassed the additive threshold raise. Cold-start safe (no OLR data → no discount).
- **🧠 Direction-aware learning** — all learning systems filter by direction: SELL candidates only match SELL history, BUY only matches BUY. Per-direction win rates tracked everywhere. Counter-momentum trades require a specific named catalyst — "could reverse" is not enough.
- **⚡ HACP protocol** — Terminal Agent checks rules → 5 sub-agents think in parallel (staggered, 60s deadline race), Skeptics audits, Meta-Agent arbitrates, weighted voting consensus, Terminal Agent verifies. 120s hard timeout → HOLD.
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
│   • HACP protocol (parallel multi-model inference)           │
│   • 6-agent system + Meta-Agent arbitration + Skeptics gate  │
│   • Entry Thesis System + dark psychology + weighted voting  │
│   • Self-evolution (22-layer cognitive evolution pipeline)   │
│   • Numeric Autoencoder (learned market-condition embedding) │
│   • AttnRes cycle-history retrieval (K3 dual pseudo-query)   │
│   • Anti-pattern memory (failure lesson clustering)          │
│   • Conditional WR soft gate (code-level enforcement)        │
│   • Combo WR gate (symbol×side×regime Wilson LB, v2.0.221)   │
│   • OLR P(win)×consensus discount (multiplicative, v2.0.224) │
│   • Execution-lens SL/TP (stop-out-trained direct control)   │
│   • Replay buffer (PER mini-batch retrain, v2.0.219)         │
│   • Bayesian OLR (MC Dropout uncertainty, v2.0.219)          │
│   • Temporal attention (cross-trade regime, v2.0.219)        │
│   • Cross-symbol backbone (shared+residual, v2.0.219)        │
│   • Reward shaping (5-component risk-adjusted, v2.0.219)     │
│   • Active exploration (UCB + info gain, v2.0.219)           │
│   • World model (latent dynamics + rollout, v2.0.219)        │
│   • RIL Reason Intelligence (pattern clustering + similar    │
│     trade retrieval + subtle diff LLM analysis)              │
│   • Trade Incident Panel (MAE/MFE + exitThesis + post-review)│
├──────────────────────────────────────────────────────────────┤
│   Layer 3: Execution (TypeScript Runtime)                    │
│   • Hyperliquid WebSocket + REST (9 perpetual DEXs)          │
│   • Risk engine (millisecond, no LLM)                        │
│   • Paper/Real trading with unified execute/close routing    │
│   • Position tracking & SL/TP · persistence · observability  │
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
| 8 | **System Engineer** | Autonomous code engineer. Every 2 cycles: audits trade records + source code, detects learning system bugs, auto-fixes with tsc+test safety net. Reads SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md. Can modify src/evolution/ + src/cognition/ + src/analysis/ + src/agents/ + tests/. Forbidden: src/trading/ + src/config/. Default GLM-5.2. |

> All agents have user-selectable model dropdowns in the UI.

### HACP Protocol

Each cycle (1-10 min, user-configurable): Terminal Agent checks rules → 5 sub-agents think in parallel (60s deadline) → Skeptics audits → Meta-Agent arbitrates with RIL reference data → Skeptics validates entryThesis → structured debate → weighted voting consensus → Terminal Agent verifies. 120s hard timeout → HOLD.

### Self-Evolution System

| Component | File | What it does |
|:----------|:-----|:-------------|
| **OLR** | `olr-engine.ts` | Per-symbol, per-side online logistic regression. 15 features (12 base + 2 momentum + 1 hourOfDay). Learns P(win) from shadow + paper + real trade outcomes (TP-before-SL). Source-weighted SGD (real=4, paper=2, shadow=1). Confidence penalty for low-sample models. |
| **Shadow Trading** | `shadow-trade-engine.ts` | Opens simulated LONG + SHORT every cycle with fixed S/R SL/TP. Tracks intra-cycle high/low for correct TP-before-SL resolution. Records MAE/MFE path-risk per trade. Feeds outcomes to OLR with source='shadow'. |
| **First-Passage** | `first-passage.ts` | Instant P(TP before SL) from volatility (σ) + log-drift (ν) + SL/TP distances. Cox & Miller GBM formula. RR-aware: compares to breakeven P, not 50%. Also provides `computeMomentum()` for 5-cycle short-term momentum. |
| **Numeric Autoencoder** | `numeric-autoencoder.ts` | Pure-TypeScript MLP (11→16→8 encoder + 8→16→11 decoder). Learns non-linear market-condition embedding via reconstruction loss + contrastive loss + diversity penalty (pairwise repulsion anti-collapse, v2.0.223). Adam optimizer (self-implemented), gradient clip, weight clip, LR decay, seeded RNG, replay buffer (persisted v2.0.222), time-weighted sampling (30-day half-life). Cold-start safe: min-max cosine fallback until 200+ samples + validation pass (MSE<1.5, acc>55%, diversity>0.01). trainEpochs(50) with early stop after backfill (v2.0.223). |
| **AttnRes Cycle-History** | `cycle-history-retrieval.ts` | Kimi K3 Attention Residuals transfer (arXiv 2603.15031). K3 layer-depth ≡ MATS cycle-history depth. Conditional WR candidate = softmax-weighted blend over 80-cycle history + entry-time state (persistent). Block AttnRes: 8 blocks of 10 cycles, intra-block mean, inter-block softmax attention. Per-feature Welford z-score + RMSNorm keys. Online learning via reward-weighted key direction (Peters & Schaal 2008) — NOT REINFORCE (identically zero for deterministic softmax). Fixed recency prior breaks uniform-policy deadlock. |
| **Dual Pseudo-Query** | `cycle-history-retrieval.ts` | Two learned queries per symbol (K3 pre-attention vs pre-MLP): **wDecision** (broad, base recency 0.5, PnL reward) for conditional WR + thesis; **wExecution** (sharp, recency × 2.0, SL/TP stop-out reward) for SL/TP survival. wExecution only updates on closeReason='sl_tp' (SL hit → negative, TP hit → positive). Separate temperature + update counter per mode. Backward compat: old single-w state migrates on load. |
| **Execution-Lens SL/TP** | `analysis/atr.ts` | `computeATRSLTP` uses wExecution blend as **PRIMARY** SL/TP signal: (1) execAdverseMomentum from hBlend.momentumShort, (2) volatility scaling when exec vol > 1.5× ATR-implied, (3) entropy confidence damping. Falls back to ATR + raw momentum when wExecution untrained. SL cap 6% / TP cap 10% for exec lens (vs 5%/8% raw). Module-level provider — no trading-manager changes. |
| **Anti-Pattern Tracker** | `anti-pattern-tracker.ts` | Clusters failed trade LessonStatements (cosine 0.78, min 2 members). `matchCandidate(thesis)` returns matching classes + count + avgPnl. Skeptics sees: "you've lost this way N times before." Persisted to `anti-patterns.json`. |
| **Conditional WR Gate** | `index.ts` | Code-level conviction penalty: condWR < 20% → +35%, < 30% → +25%, < 40% → +15%. Uses AttnRes h_blend + NA embedding + RMSNorm keys + softmax mixture. Soft gate (penalty, never hard block). minSamples=5 guard. |
| **Combo WR Gate** | `combo-win-rate-tracker.ts` | Tracks (symbol × side × regime) win rate with Wilson score lower bound. Injects PRE-thesis block into Meta-Agent: "🔴 BUY mean_reverting W5 L7 (42% WR, Wilson 19%) — AVOID". Soft gate: WR<25% & n≥5 → +50% penalty; <35% → +30%; <45% → +15%. Stacks with loss-streak + conditional WR gates. Auto-generates structural lessons for losses without LLM text (v2.0.221). |
| **OLR P(win) × Consensus Discount** | `index.ts` | Multiplicative confidence discount: `effectiveConfidence = consensus × blendFactor`, `blendFactor = 0.3 + 0.7 × P(win)` when OLR has data, `1.0` cold-start. P(win)=29% × 90% consensus = 45% → HOLD. Fixes the detection/implementation gap where overconfident agents bypassed the additive threshold raise (v2.0.224). |
| **EM Cycle Chain** | `cycle-summary.ts` | Meta-Agent distills each cycle into a key insight. Previous insights injected into next cycle's context. Dual-channel retrieval (text cosine 50% + NA market-condition cosine 50%). Tiered memory: hot(12) + warm(288) + cold(48 epochs). |
| **Cold-Start Backfill** | `olr-backfill.ts` | First cycle per market replays 186 historical HL M5 candles into OLR. Non-blocking, idempotent. |
| **GA + Pattern DB** | `sigmoid-ga.ts` + `trade-pattern-classifier.ts` | GA evolves sigmoid sentiment function by weakest fitness dimension. KNN pattern DB with Wilson-score confidence + time-weighted win/loss. Uses NA learned cosine when ready (falls back to handcrafted weighted-diff). |
| **EXP** | `thesis-experience.ts` | Vector thesis memory. Direction-filtered (SELL only matches SELL). `recordClose` stores market conditions + OLR/shadow predictions + LLM-distilled LessonStatement (rootCause + lesson + categories). `retrieveSimilarFailureLessons()` — dual-channel (text + NA market-condition) retrieval of most similar LOSSES, injected into Skeptics. |
| **Experience Digester** | `experience-digester.ts` | LLM digests each trade into a LessonStatement (rootCause + lesson + categories). Lesson persists to ThesisExperienceRecord. `classifyCandidate` uses per-direction winRate. |
| **Trade Audit** | `direction-audit.ts` | LLM-powered trade record audit. Every 2 cycles. Uses vector-conditional win rate (not raw per-symbol WR). Known-fixed issues list prevents repeat diagnosis. |
| **System Engineer** | `system-engineer.ts` | Autonomous LLM code engineer. Every 2 cycles: reads SystemEngineer.md + ARCHITECTURE.md + CHANGELOG.md + trade records + source code, generates fix, applies it, runs tsc+test, auto-rollbacks on failure, auto-commits on success. |
| **Replay Buffer** | `replay-buffer.ts` | v2.0.219: Prioritized Experience Replay (Schaul et al. 2015). Ring buffer (capacity 5000) stores all trade records. `replayEpoch()` samples mini-batch via PER (`p_i = priority_i^α / Σ`) and re-feeds OLR with IS weights correcting bias. Breaks temporal correlation between sequential trades — improves sample efficiency 3-5×. Cold-start guard (< 10 samples → no-op). |
| **Bayesian OLR** | `bayesian-olr.ts` | v2.0.219: MC Dropout uncertainty estimation (Gal & Ghahramani 2016). N=30 forward passes with feature dropout → mean, std, 90% CI. Epistemic uncertainty [0,1] distinguishes "50% because genuinely uncertain" vs "50% because well-calibrated." Cold-start safe (< minSamples → point estimate). Seeded RNG for reproducibility. |
| **Temporal Attention** | `temporal-attention.ts` | v2.0.219: Learns regime transitions by attending ACROSS trades (unlike AttnRes which attends within a single trade's rationales). Pseudo-query w (zero-init) attends over 50-trade sequence. Anti-collapse: adaptive temperature + label smoothing (mirrors v2.0.217). Reward-weighted regression. Learns "after 3 losses in low-vol, next trade likely fails." |
| **Cross-Symbol Backbone** | `cross-symbol-backbone.ts` | v2.0.219: Multi-task learning — `w_symbol = w_shared + δ_symbol`. Shared backbone learns general patterns from ALL symbols; per-symbol residuals learn symbol-specific deviations. Cold-start symbols (e.g. SKHX with 5 samples) use shared backbone only (transfer learning from well-sampled symbols like CL with 138). Falls back to OLR when shared untrained. |
| **Reward Shaping** | `reward-shaping.ts` | v2.0.219: 5-component shaped reward replaces binary sign(pnl): PnL magnitude (40%) + drawdown penalty (20%) + Sharpe component (15%) + hold-time penalty (10%) + recovery bonus (15%). Bounded [-1,1]. Rolling Sharpe from PnL history. Feeds AttnRes/CHR/temporal-attention with risk-adjusted reward instead of raw win/loss. |
| **Active Exploration** | `active-exploration.ts` | v2.0.219: UCB exploration — `score = pWin + c·sqrt(ln(N_total)/N_symbol)`. Information-gain bonus when Bayesian uncertainty high. Annealing: exploration decays as system matures. Soft gating (never hard-blocks — preserves user operation space). Under-sampled symbols get exploration boost. |
| **World Model** | `world-model.ts` | v2.0.219: Lightweight Dreamer-style latent dynamics. 14→8-d encoder (tanh bounded) + transition model (predict next latent from current + action) + reward predictor (predict pWin). Rollout N steps forward for "latent imagination" planning — simulate entry decisions without actually trading. Cold-start safe (< 50 samples → 0.5 defaults). |
| **Close-Context Learning** | `index.ts` computeLearningWeight + `portfolio.ts` | v2.0.226: How a position is closed is an important factor in the loss. `computeLearningWeight(closeReason, slNarrowed, isWin)` scales learning by close context: wins=1.0, real SL hit=1.0, tight-SL loss (SL narrowed post-entry)=0.3, thesis invalidation=0.3, manual=0.5, consensus=0.5. OLR `feedTrade` receives `slNarrowed`+`weightMultiplier` to scale gradient. Combo WR skips execution-caused losses (weight<0.5). TradeRecord captures `originalStopLossPrice`/`finalStopLossPrice`/`slNarrowed`. Prevents tight-SL losses from contaminating learning with "these market conditions→loss" when the entry was fine. |

### Cognitive Evolution Pipeline

The system's learning stack evolved through 12 versions, each addressing a structural limitation of the previous:

```
 v2.0.203  Raw WR → Vector-Conditional WR (min-max + cosine, cross-symbol, same side)
     ↓     "SILVER BUY 0W/1L" doesn't mean BUY is wrong — different market conditions
 v2.0.204  Min-max → Numeric Autoencoder (learned non-linear 11→16→8 embedding)
     ↓     Linear min-max can't capture volatility × regime × funding interactions
 v2.0.205  Uniform sampling → Time-weighted (30-day half-life) + Skeptics conditional block
     ↓     Old samples pollute model; Skeptics couldn't see conditional WR
 v2.0.206  Single similarity → Unified NA cosine across classifier + EM + agent weights
     ↓     Multiple similarity metrics disagreed; agent weights used raw WR
 v2.0.207  6 upgrades fixing 11-trade losing streak:
           #B dark-psych MANDATORY on |momentum|>2% + #C momentum-adaptive SL
           + #D momentum features + #E lesson persistence + #F anti-pattern clustering
           + #G conditional WR in thesis generation
     ↓     Counter-momentum SELL, SL too narrow, lessons not persisted, no anti-pattern memory
 v2.0.208  Meta-Agent DEEP LEARNING CONTEXT (5 learned-context blocks as first-class signals)
     ↓     LLM couldn't see learned signals; treated them as footnotes
 v2.0.209  Prompt-only → Code-level conditional WR soft gate (conviction penalty)
     ↓     LLM ignored prompt-level learning blocks; code enforces what prompt suggests
 v2.0.210  3 audit fixes: olrPWinAtEntry cache + TP R:R≥1.6 + thesis-action consistency
     ↓     Thesis contradicted action; TP too narrow; audit repeat-diagnosed fixed issues
 v2.0.211  AttnRes 7 transfers from Kimi K3 (cycle-history selective retrieval + block
           AttnRes + RMSNorm keys + softmax mixture + zero-init cold-start + single-head)
     ↓     Conditional WR used single current snapshot; entry-time regime lost
 v2.0.212  #7 Dual pseudo-query (wDecision broad + wExecution sharp, different reward)
     ↓     Single query couldn't serve both decision (broad) and execution (sharp)
 v2.0.213  Execution lens as PRIMARY computeATRSLTP signal (stop-out-trained SL/TP)
           Full circle: wExecution learns from stop-outs → directly controls SL/TP
 v2.0.218  NaN sanitization — safeNum() catches NaN/±Infinity (?? only catches
           null/undefined). 102 real trades → 0 OLR samples for BTC (fixed)
           + backfillFromExpRecords() replays 191 EXP records through all systems
 v2.0.219  7 advanced systems: replay buffer (PER) + Bayesian OLR (MC Dropout) +
           temporal attention (cross-trade) + cross-symbol backbone (transfer) +
           reward shaping (5-component) + active exploration (UCB) + world model
           (latent rollout). Shadow trade engine fix (maxAgeCycles 50→12, stale
           trades now fed to OLR). 397 tests total.
```

**Key design principles:**
- **Cold-start safe everywhere**: every learned path has a deterministic fallback (NA → min-max, AttnRes → current snapshot, anti-pattern → no block, wExecution → ATR). The system never degrades below baseline on first deploy.
- **Selectivity is EARNED**: zero-init pseudo-queries start as uniform/recency-weighted. The system must trade and observe outcomes to learn which historical patterns matter. No unearned assumptions.
- **Code enforces what prompt suggests**: the conditional WR soft gate runs at code level — even if the LLM completely ignores the DEEP LEARNING CONTEXT prompt, conviction is still penalized. Belt and suspenders.
- **Outcome-driven, not gradient-driven**: MATS has no backprop loop. All learning is from trade outcomes (win/loss + PnL + closeReason). The reward-weighted key direction update (Peters & Schaal 2008) is the correct rule for deterministic attention — REINFORCE is identically zero.
- **Close-context-aware learning (v2.0.226)**: How a position is closed is an important factor in the loss. `computeLearningWeight(closeReason, slNarrowed, isWin)` scales learning by close context: wins = 1.0, real SL hit = 1.0, tight-SL loss (SL narrowed post-entry) = 0.3, thesis invalidation = 0.3, manual close = 0.5, consensus close = 0.5. OLR `feedTrade` receives `slNarrowed` + `weightMultiplier` to scale gradient updates. Combo WR skips execution-caused losses (weight < 0.5). This prevents tight-SL losses from contaminating the learning systems with "these market conditions → loss" when the entry was actually fine.

→ Full evolution map in [NA.md](NA.md) · AttnRes design in [K.md](K.md)

### RIL — Reason Intelligence Layer

| Component | What it does |
|:----------|:-------------|
| **PatternClusterManager** | Greedy cosine clustering of entry rationale texts (MiniLM 384-d). Shows per-pattern win rate + PnL. Incrementally updated on every trade close. |
| **CloseReasonAggregator** | Groups closed trades by exit type (SL/TP, consensus, manual, thesis invalidation) × decision origin. Shows per-close-reason win rate + avg PnL. |
| **SimilarTradeRetriever** | Finds top-N most similar historical trades to a candidate thesis using cosine similarity on rationale vectors. **Direction-filtered** (v2.0.176) — SELL candidates only match SELL history. Injected before Skeptics validation. |
| **SubtleDiffAnalyzer** | 1 LLM call per cycle. Compares candidate trade vs similar historical winners/losers. Identifies subtle differences (volume, RSI, regime, S/R proximity). |
| **EXP checkThesisHistory** | Candidate thesis → extract rationales → embed → cosine similarity vs **same-direction** historical records → similarity-weighted P(win) → PASS/REJECT/REVERSE verdict. Dual-Channel Fusion with OLR + shadow win rate. Direction-filtered (v2.0.175). |
| **Experience Digester** | LLM digests each trade into a lesson statement → embed → cluster into lesson classes. Classifies candidates against winning/losing lesson classes using **per-direction winRate** (v2.0.176). |

### Trade Incident Panel

Replaces the old Positions table + Trade Records with a unified card-based view. Each trade (paper + real, open + closed) is a card showing:

- **Summary**: Symbol, side, status, PAPER/REAL tag, PnL
- **Entry/Exit Price**: With SL/TP levels
- **Min/Max Value Reached**: MAE/MFE — position value (margin + unrealized PnL) at its worst/best
- **Entry Thesis**: Meta-Agent's frozen rationale at open
- **Exit Thesis**: Close rationale (v2.0.225: SL/TP no longer narrowed post-entry — exit thesis records close reason only, no narrowing analysis)
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

SL/TP set at entry via ATR (1.5×) / S/R levels, never modified post-entry (v2.0.225: trailing stop + MFE giveback + TP narrowing + per-symbol consensus SL/TP all DISABLED — post-entry narrowing caused premature stop-outs + UI/exchange SL desync). Two-layer exit protection: (1) initial SL/TP at exchange level, (2) LLM thesis invalidation (Skeptics Phase 0.5 force-close). Portfolio safety layer: no-widen + not-too-tight (SL ≥ 1%, TP ≥ 1.5%) + min-gap 2%. Original SL/TP recorded at open for exit-thesis analysis.

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
| **Testing** | vitest (397 tests, 17 test files) |
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

** MATS is open source under **Apache License 2.0**. Contact YC Wong for commercial licensing.

## License

[Apache License 2.0](LICENSE) · Copyright (c) 2026 YC Wong
