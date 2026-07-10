# Changelog

All notable changes to MATS are documented here. See [ARCHITECTURE.md](ARCHITECTURE.md) for full technical details.

---

## v2.0.140 — A2A Experience Digester + Dual-Channel Fusion + Premature Close Prevention + Volatility Fix + 6 Bug Fixes

**A2A Experience Digester** — every closed trade is LLM-digested into a structured `LessonStatement` (OBS + ASSESS + rootCause + exitType + lesson), embedded into a condensed vector, and clustered into `ExperienceClass`. New candidate theses are classified against class centroids → verdict. The `digestTrade` LLM prompt forces 5-layer root cause diagnosis. `getDigestSummary()` produces a 7-layer structured digest injected into agent prompts. `expActions` action log wired through HACP → API → UI.

**Dual-Channel Classification Fusion** — the semantic channel (MiniLM) learns from real/paper closed trades, which are polluted by premature closes. The statistical channel (OLR + Shadow) uses fixed SL/TP outcomes not affected by premature closes. Fusion rules: semantic REJECT + statistical WIN → override to PASS (premature close, not bad direction); semantic APPROVE + statistical LOSE → caution to PASS (overfitted class). Implemented via `CheckThesisInput.olrPWin` + `shadowWinRate` + `setFusionDataCallback()` in HACP.

**Premature Close Prevention** — the system's biggest recurring problem is NOT tight SL/TP, it's Meta-Agent + Skeptics initiating manual closes that ignore the actual price structure. Three gatekeeper prompts rewritten with mandatory checks (price level breached? SL/TP hit? position ≥15min? digest shows premature history? direction still correct?). Skeptics defaults → VALID/BLOCK (when in doubt, keep open).

**Volatility calculation fix** — `MarketStateAggregator.calcVolatility()` was using mean of |arithmetic returns| (underestimates ~20%), causing ALL regimes to classify as `low_volatility`. Fixed to std of log returns.

**6 critical bug fixes**:
1. Active-symbol conviction gate used diluted overall confidence (same bug as v2.0.132 but never fixed for active-symbol path)
2. OLR backfill passed lowercase 'btc' to HL candleSnapshot (case-sensitive API) → BTC never backfilled → no OLR model
3. Shadow trade `maxTotalOpen` 30 too small for 4+ trading markets → 4th symbol got 0 shadows → raised to 60
4. `isThesisPlaceholder()` missed 'closing position' and 'no entry' (3+ letter words passed the check) → positions opened with placeholder theses
5. `holdReason` not on Position interface (set via `as any` cast) → added to backend + UI types
6. `parseDigest()` read line 0 (header) instead of line 1 (stats) → `parsed.total` always 0 → MiniLM Pipeline showed 0 trades

**Visual Experience Digestion UI** — MiniLM Neural Pipeline (4-stage sci-fi flow + neural grid), Dual-Channel Fusion banner, 4-card stats grid, W/L bar, exit quality bars, class cards with win-rate bars + exit-type badges, per-symbol table with PnL color coding, volatility anomaly banner, root cause diagnosis. No raw text dump.

**17 new tests** (total 94). `tsc --noEmit` clean. UI build clean.

---

## v2.0.139 — News Reporter v2 Institutional Narrative Decoder + Real-Trading Hardening + Live Mark Price

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

---

## v2.0.138 — EXP Vector Thesis Memory (Skeptics Phase 1.8a Historical Probability Gate)

Every closed trade's rationale combination is embedded (transformers.js MiniLM 384-d, in-process) and stored. On new entries, Skeptics Phase 1.8a `checkThesisHistory` gates by thesis-combo historical win-rate: no history → direct open; winning combo → fast-approve; losing + contradicting delta → reverse-direction; no delta → reject→HOLD. Cold-start dormant until `EXP_ENABLED=true`. Self-healing fallback to 1.8b. 24 new tests (total 77). Files: `src/evolution/embeddings.ts`, `src/evolution/thesis-experience.ts`, `scripts/reindex-exp.ts`.

---

## v2.0.137 — Thesis Freeze (Root Cause B: fix over-trading + low win rate)

`setEntryThesis()` → set-if-absent. The original opening rationale is now FROZEN until close; previously each cycle's latest Meta-Agent thesis overwrote it → Skeptics re-validated a moving target → sometimes overwritten to `'N/A'` → auto-invalidated → forced close 6-15 min later → churn loop. `holdReason` remains live per-cycle reasoning (not re-validated). 5 regression tests.

---

## v2.0.136 — Execution Bug Fixes + UI Position Label Fixes

7 bugs blocking real trading + UI display: `normalizeDecision()` dropping `entryThesis`; `buildConsensus()` hardcoded `BTCUSDT`; missing `entryPrice`; BTC SELL "could not immediately match" (l2Book case-sensitivity — use canonical `asset.name` not lowercase); Portfolio "Reason" vanishing after 1st cycle (`forceMirror` now bypasses `assessTrade()` too); HACP debate position badge flicker (UI uses actual portfolio, not `hasPosition`); SL/TP validation spam on qty=0 placeholders.

---

## v2.0.135 — OLR + Shadow + First-Passage Production Hardening + Cold-Start Backfill + Full Agent Cognition Integration

- **First-passage math fixes**: C1 (LONG/SHORT formula swap), C2 (raw μ → log-drift ν), M4 (per-side SHORT SL/TP). Cox & Miller GBM scale-function derivation.
- **OLR hardening**: per-feature Welford counts (missing features → neutral z=0), backfill source (weight 0.3, decay-excluded), cold/stale/warm detection, NaN guards.
- **Shadow trading**: multi-candle hold (≤20, no fabricated labels), S/R-aligned SL/TP via pivot detector + ATR fallback.
- **Cold-start backfill**: non-blocking replay of 186 historical HL candles into OLR. Idempotent. Live-verified: 945 samples / 3 markets / ~1s.
- **Full agent cognition integration**: shared `buildOLRBlock()` helper injects complete OLR + First-Passage + edge data to OLR & Sentiment Analyst AND Meta-Agent (active symbol + all positions + all trading markets). Meta-Agent OLR prompt rewritten from stale RBC docs to RR-aware edge arbitration. Source breakdown exposed for all symbols in API.
- **UI**: Agent Cognition legend RBC → OLR; Evolution panel breakeven-aware first-passage + source-breakdown row; deleted dead `RBCVisualizer.tsx`.
- **Tests**: 41 passing. `tsc --noEmit` clean. UI build clean.

---

## v2.0.131 — Margin Check Uses Total Equity + Max Portion 100% + Price Fallback

- **Margin check fix** (v2.0.131): Cumulative margin check now uses `exBal.total` (total equity) instead of `exBal.free` (free balance). Free balance is reduced by existing position margin, so comparing total margin against `free * maxPortion` blocked all new trades when an existing position used most of the margin. With SILVER using $47 of $60 equity, free was $13 → 50% of $13 = $6.50 < $47 existing → all new trades blocked.
- **Max portion 100%** (v2.0.131): Max portion clamp raised from 50% to 100% in API server, MarketAgent, and RealTradingManager. Allows users to set higher when existing positions use most of the margin.
- **Manual trade price fallback** (v2.0.131): If `fetchPriceForSymbol` fails and `marketState` returns 0, re-fetch using Market Agent's selected symbol (which has a live WS price feed). Fixes "No price available for btc" error.

## v2.0.130 — Meta-Agent Override for Active Symbol + adjustPositions for ALL

- **Active symbol override** (v2.0.130): `buildConsensus()` now uses Meta-Agent's `marketTicker` decision for the `finalDecision` (active symbol) when there's no open position. Previously, the legacy majority vote drowned out Meta-Agent's SELL — 6 sub-agent HOLDs vs 1 Meta-Agent SELL → HOLD. Now Meta-Agent's BUY/SELL overrides the majority, same as the v2.0.125 override for trading markets. Also forwards Meta-Agent's thesis + confidence.
- **adjustPositions for ALL positions** (v2.0.130): `adjustPositions()` now adjusts ALL open positions, not just the primary symbol. Previously, SILVER's SL/TP never went through the HACP LLM adjustment loop — only sub-agent averages via per-symbol consensus. Now all positions get Meta-Agent LLM adjustment with full market context.

## v2.0.129 — Not-Too-Tight SL/TP Constraint

- **Not-too-tight** (v2.0.129): `portfolio.ts adjustPosition()` now enforces minimum distance from current price: SL ≥ 1%, TP ≥ 1.5%. Previously, SL could be tightened to 0.39% of current price, which would trigger on normal market noise. `hacp.ts` already enforced this in the LLM retry loop, but per-symbol consensus + manual paths bypass HACP — this hard safety layer catches all callers.

## v2.0.128 — Decision Audit Log

- **Decision audit** (v2.0.128): Every Meta-Agent BUY/SELL decision is now recorded with gate-by-gate results (direction-restrict, conviction-gate, frequency-throttle, execution — passed/blocked + reason). Exposed via API `decisionAudit[]` (last 20 entries). Log line: `📋 [audit] Cycle N SELL symbol conf=X% executed=Y gates=[...]`. Lets users periodically check whether Meta-Agent's decisions are being executed or blocked by which gate.

## v2.0.127 — Paper Engine Drawdown Gate Blocked Real Trade Mirror (ROOT CAUSE)

- **forceMirror** (v2.0.127): `paperEngine.executeDecision()` accepts `forceMirror` param. When `true` (from `RealTradingManager` for a trade that ALREADY executed on HL), `canTrade()` is bypassed. Previously, paper drawdown 21.74% (threshold 20%) blocked the mirror → positions existed on HL but NOT in local portfolio → UI showed "No Open Positions". This was the REAL reason the system hadn't opened a position in 4 days — even when trades executed on HL, the mirror was blocked by the paper drawdown gate.
- **Manual trade API** (v2.0.127): `POST /api/positions/manual-trade` — bypasses conviction gate + thesis validation. Used to force a trade that the system's gates blocked. Checks direction restrictions + existing positions (flip support). Clears pending thesis on success.

## v2.0.126 — Two More Gates Blocking Trading Market Entries

- **Unanimous HOLD fast-path fix** (v2.0.126): Fast-path now checks Meta-Agent's `multiSymbolDecision` for trading market BUY/SELL before triggering. Previously triggered when Meta-Agent had per-symbol SELL for a trading market but overall `decision.action` was HOLD → skipped debate → returned early.
- **Conviction gate confidence fix** (v2.0.126): When Meta-Agent overrides a trading market's action, use Meta-Agent's confidence instead of sub-agent average. The sub-agent average (~33%) was always below the threshold (~52%), so even when the override worked, the conviction gate blocked the trade.

## v2.0.125 — Meta-Agent Decision Authoritative for Trading Markets

- **Trading market override** (v2.0.125): `buildConsensus()` now uses Meta-Agent's per-symbol decision for trading markets (no open position), overriding the sub-agent majority. Meta-Agent is the arbitrator — its SELL/BUY for a trading market should execute, not be drowned out by sub-agent HOLDs. Sub-agents are data-gatherers, not decision-makers. `currentPositions` passed to all 4 `buildConsensus()` call sites.

## v2.0.124 — Persist Trading Markets for First Cycle

- **Trading markets persistence** (v2.0.124): `tradingMarkets` added to `MarketAgentConfig`, persisted to `data/evolution/market-agent-config.json`. Loaded on startup so the first cycle has the correct markets instead of falling back to auto-select with only `selectedSymbol` (1 market). Saved whenever the UI POSTs new markets.

## v2.0.123 — Ollama 500/Timeout No Longer Auto-Pauses System

- **Ollama plan detection fix** (v2.0.123): `authValid` defaults to `true` when Ollama `/api/tags` is reachable. Only an explicit 401 flips `authValid` to false (actually signed out). 500/429/503/timeout leave `authValid` at its default — transient errors are not auth failures. Ping timeout raised 5s → 15s.
- **UI auto-pause fix** (v2.0.123): UI requires 2 consecutive `None` plan readings before auto-pausing. A single transient `None` (Ollama busy/overloaded) no longer pauses the system. `nonePlanCountRef` tracks consecutive None readings; resets on any non-None reading.

## v2.0.122 — Pending Thesis Persistence + Per-Symbol Direction Restrictions

- **Pending thesis persistence** (v2.0.122): When Meta-Agent outputs BUY/SELL with an `entryThesis` but the trade doesn't execute (blocked by conviction gate, liquidity, direction restriction, etc.), the thesis is now stored as "pending" and injected into the next cycle's market description as `=== PENDING ENTRY THESES ===`. Meta-Agent sees its prior reasoning and either re-affirms or updates it. Skeptics re-validates each cycle. Cleared when a position actually opens (position has its own thesis) or is manually closed. Also applies to multi-symbol trading market entries that were blocked. Exposed via API in `marketAgent.pendingTheses[]`.
- **Per-symbol direction restrictions** (v2.0.122): New `directionRestrictions` field on `MarketAgentConfig` maps normalized symbol → allowed direction (`'buy' | 'sell'`). When a symbol is restricted, only the specified direction can execute; the opposite direction is blocked at both the active symbol path and the multi-symbol trading market entry path. Persisted to `data/evolution/market-agent-config.json` (gitignored). Exposed via `POST /api/market-agent/direction-restrictions` (body: `{ "restrictions": { "xyz:SILVER": "sell" } }`). Included in agent context via `getMarketDescription()` so agents don't waste output on blocked directions. SILVER restricted to SELL-only in local config.

## v2.0.115 — Trend-Following Incentives + Short-Term Price Trend Injection + Mobile UI + Infinite POST Loop Fix

- **Trend-following incentives** (v2.0.115): Rewrote agent prompts to prioritize trend-following. Fractal Momentum: "MISSING a trending move is as bad as taking a bad trade". RBC: NO_EDGE is NEUTRAL not BEARISH. Meta-Agent: TREND DIRECTION is first in reasoning chain; confirmed uptrend + one confirming signal = sufficient for entry; HOLD requires 8 signals absent (added "no clear trend"). "MISSING a 5% trending move is a FAILURE, not prudence".
- **Short-term price trend injection** (v2.0.115): New `getRecentPriceTrend()` method calculates price change over last 20 ticks. Injected into market description: `Short-term Trend: ↑ UP +3.2% over last 20 ticks ($58,000 → $59,856)`. Agents can now see multi-cycle price direction, not just the current price.
- **Infinite POST loop fix** (v2.0.111–v2.0.114): Removed backend→UI trading markets merge effect (root cause of infinite loop). Backend `setTradingMarketsHandler` 3s throttle (multi-tab dedup). UI POST effect 500ms debounce. Backend JSON.stringify dedup guard.
- **Mobile UI overhaul** (v2.0.113): Exchange dropdown removed (fixed to Hyperliquid), label → "Asset Type". Pause/Run cycle buttons merged into one toggle. Shutdown button now confirms. `@media (max-width: 768px)`: Market Agent controls stack vertically. Slider min-width 100px. Chart col width 100%.
- **TradingView chart resize** (v2.0.114): Added `ResizeObserver` to catch container width changes from flex layout (row→column on mobile) that don't trigger window resize events.

## v2.0.110 — Skeptics Approve-First + Noise Trading Reduction + Multi-Market Drift Correction

- **Skeptics Approve-First** (v2.0.110): Rewrote `validateEntryThesis()` prompt from "ABSOLUTE GATEKEEPER, reject by default" to "risk manager, approve by default, only reject on specific material flaw that would cause a loss". Explicitly lists what is NOT a rejection reason (low confidence, could-be manipulation, vague 1h reason, low RBC samples, news could be FUD, sideways market). Error fallback changed from REJECT to APPROVE. This fixed the issue where the system didn't trade for 2 consecutive days because Skeptics rejected every thesis.
- **Decision interval 60s → 300s** (v2.0.103): Reduced decision cycle frequency from 1 minute to 5 minutes. 1-minute price changes are microstructure noise, not signal. RBC hypothetical training also throttled to every 5 cycles (25min samples instead of 1min noise).
- **Skeptics thesis rejection UI** (v2.0.105): Full rejection rationale now stored in `metadata.thesisRejections[]` and displayed per-symbol in the Skeptics UI card with expand/collapse toggle.
- **Multi-market drift correction** (v2.0.106–v2.0.108): UI force re-POSTs trading markets when backend has fewer markets than UI. Auto-select fallback appends instead of overwrites. Post-cycle drift check triggers immediate cycle when markets changed mid-cycle. Fixed the issue where backend lost trading markets (e.g. had 1 instead of 3) but UI kept showing 3 pills without re-syncing.

## v2.0.109 — News Reporter Priority + Global Breaking News Cross-Asset Analysis

- **News Reporter priority** (v2.0.109): Meta-Agent prompt updated to treat News Reporter's BUY/SELL signals as HIGH-PRIORITY. News catalysts (ETF launches, regulatory changes, earnings, geopolitical events) drive price action faster than lagging technical indicators. When News Reporter says BUY and RBC says SELL, Meta-Agent must investigate whether RBC reflects stale pre-catalyst positioning. News catalyst is now FIRST in the reasoning chain.
- **Global breaking news** (v2.0.109): Meta-Agent now receives TOP 10 international breaking headlines (Google News RSS + Bing News RSS) every cycle. Meta-Agent must analyze cross-asset correlations: Fed rate decisions → ALL assets, geopolitical conflict → oil/gold/risk assets, AI/semiconductor news → SK Hynix/tech, inflation data → gold/silver/FX. Includes a cross-asset correlation guide. Meta-Agent must reference global news in reasoning for EVERY symbol.
- **Sub-agent directional signals** (v2.0.109): News Reporter added to the list of 5 data-gathering agents (was 4). Meta-Agent must acknowledge News Reporter's BUY/SELL signals and explain why they're insufficient if deciding HOLD.

## v2.0.108 — Fix Trading Markets Not Analyzed + EADDRINUSE Recovery

- **EADDRINUSE recovery** (v2.0.108): API Server detected port 3456 already in use → silently failed → UI could never send trading markets to backend. Now handles `EADDRINUSE` by killing the old process and retrying.
- **Immediate cycle on market change** (v2.0.108): When UI sends trading markets via POST, an immediate decision cycle is triggered (1.5s delay). Previously the first cycle ran before UI connected, and the 300s interval meant waiting 5 minutes for the next cycle — so agents only analyzed the auto-selected symbol, not the user's trading markets.
- **Rate limiter exhaustion fix** (v2.0.107): v2.0.106 `selectFilterProfile()` called `fetchPriceForSymbol` for each trading market BEFORE the injection code, exhausting the HL rate limiter. Injection then failed for xyz: symbols → markets skipped. Fixed by using `autoDetectProfile` (no API call) for initial assignment, and re-evaluating profiles using cached `marketState` data.
- **Double-fetch elimination** (v2.0.107): Prices fetched in `buildMarketDescription` are now cached and reused in the injection code, avoiding double-fetching and rate limiter exhaustion.
- **Injection never skips** (v2.0.107): Even if `fetchPriceForSymbol` fails for a trading market, the market is still injected with `price=0` + `marketState` fallback. Previously the `continue` on error caused markets to be silently dropped.

## v2.0.106 — Per-Asset Adaptive Noise Filter + Market Agent Judgment

- **Per-asset filter profiles** (v2.0.106): Market Agent selects one of 7 filter profiles for each asset based on its real market data (volatility, liquidity, volume, 24h change). Each profile defines different EMA alpha ranges, sigmoid k ranges, conviction gate bounds, and trade frequency limits. Profiles: `high_vol_crypto` (BTC/ETH), `low_vol_crypto` (stablecoins), `high_vol_alt` (meme coins), `dex_perp` (xyz: assets), `forex_index` (EURUSD/SP500), `commodity` (gold/oil), `default`.
- **Per-asset AdaptiveNoiseFilter** (v2.0.106): Each asset gets its own independent filter instance with separate channel states (price, OB imbalance, volume, funding, spread, momentum, large trades, fear/greed, volatility). Filter adapts per-cycle based on: market volatility (high vol → more smoothing), recent trade performance (losses → more smoothing), trade frequency (over-trading → raise conviction gate), and SNR (low signal-to-noise → more smoothing).
- **Meta-Agent filter awareness** (v2.0.106): Meta-Agent receives per-asset SNR data, conviction gates, and throttle status in its context. It must factor this into every decision: SNR < 30% → prefer HOLD, SNR 30-50% → reduce position size, throttled → HOLD. Meta-Agent prompt includes detailed instructions for interpreting filter data.
- **Trade frequency throttle** (v2.0.106): Each asset has its own trade frequency limit (e.g. BTC: 3 trades per 10 cycles, meme coins: 2 trades per 15 cycles). When limit is reached, new entries for that asset are blocked — prevents over-trading on noise.
- **Conviction gate** (v2.0.106): Each asset has its own adaptive conviction threshold. Consensus confidence below the gate → trade blocked. Gate adapts: over-trading → raise gate, under-trading + winning → lower gate, losing → raise gate.

## v2.0.104 — Multi-Symbol Single-Cycle + Trading Market Injection

- **Trading market injection** (v2.0.104): Non-position trading markets are now injected into `currentPositions` with `isTradingMarket=true` and `quantity=0`. Agents see ALL trading markets in `positions[]` and output BUY/SELL/HOLD for each in a single HACP cycle. Full market context (price, trend, regime, RBC, S/R) is generated for each trading market and appended to `marketDesc`. The `MultiSymbolDecision.positions[]` now serves dual purpose: open position management (CLOSE/HOLD) AND trading market analysis (BUY/SELL/HOLD). Agent prompts updated to explain the distinction. HACP thesis validation checks `quantity > 0` to distinguish real positions from trading markets.
- **Thesis-mandatory close** (v2.0.103): Closing a position now REQUIRES entry thesis invalidation as a MANDATORY condition, plus ≥2 of the other 5 conditions. If the thesis is still valid → HOLD, no exceptions. This prevents panic-closing on short-term price noise. Meta-Agent prompt, Skeptics close validation, and reasoning chain all updated to enforce this.
- **Multi-symbol single-cycle** (v2.0.103): Reverted the v2.0.100 sub-cycle approach (separate HACP cycle per market). ALL trading markets are now analyzed in ONE HACP cycle. Entry decisions for trading markets are executed via the `perSymbolConsensus` loop.

## v2.0.92–v2.0.94 — Extreme Reasoning + RBC/S/R for All Positions + Bug Fixes

- **Extreme reasoning** (v2.0.93, updated v2.0.103): No position → MUST decide BUY/SELL (HOLD only when ALL 6 signals absent). Has position → MUST decide CLOSE/HOLD. CLOSE requires thesis invalidated (MANDATORY) + ≥2 of 5 other conditions. HOLD is the default. Even with no data, reason from first principles. 3-5 sentences minimum per symbol.
- **RBC + S/R for all open positions** (v2.0.92): Previously only generated for the active symbol. Now every open position gets RBC edge assessment + S/R zones in agent context.
- **Phase 1.8 skip for existing positions** (v2.0.94): Thesis validation skipped if symbol already has a position — marketTicker BUY/SELL for a symbol with an existing position is NOT a new entry.
- **Legacy close on Meta-Agent decision** (v2.0.94): Legacy positions (no entryThesis) now close when Meta-Agent decides CLOSE, not just when ≥2 sub-agents vote close.
- **UI: Meta-Agent reasoning always expanded** (v2.0.94): holdReason/entryThesis no longer truncated to 2 lines.

## v2.0.79–v2.0.91 — Entry Thesis System + Dark Psychology + Skeptics Absolute Veto

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

## v2.0.78 — Configurable Max Portion + Real Trading Margin Check

`maxPortionPct` (10%-50%) replaces hardcoded 20% cumulative margin cap. UI slider in Market Agent panel. Enforced in both paper engine AND real trading manager.

## v2.0.76–v2.0.77 — Global HL Rate Limiter + WS Infinite Reconnect

Global rate limiter replaces 6+ scattered per-module limiters with one queue (200ms gap = 5 req/s). WS reconnect retries forever (backoff caps at 60s). REST polling exponential backoff (30s → 5min cap).

## v2.0.69–v2.0.75 — SL/TP UI + Symbol Debounce + S/R DEX Fix + News Reporter Rewrite

SL/TP UI display fix, symbol selection debounce, S/R + ATR candle fetch fix for DEX 1-8, News Reporter rewrite (Google News RSS + GDELT + Bing News, multi-symbol, hidden strategist persona), UI masonry layout.

## v2.0.58–v2.0.68 — Options Data Layer + Options-aware Evolution

Options Data Layer connecting to Massive.com/Polygon.io. Regime → Playbook mapping. Options-aware evolution (`OptionsStrategyParameters` + `SurvivalFitness.optionsAlpha`). Plan detection + dynamic vote weight.

## v2.0.32–v2.0.57 — HL Real Trading Fixes + SL/TP Safety + Position Management

HL signing rewrite (phantom agent EIP-712), xyz DEX asset index offset, SL/TP direction fixes, phantom close fix (8 code paths), paper balance inflation fix, S/R-based SL/TP, pro algo firm SL/TP (fill-first + retry + safety-close), HL SL/TP close detection, stale real position cleanup, real trade persistence, consensus directional agreement fix, learning decay, MAX_POSITION_PCT removal, drawdown high-water mark fix, manual market selection, SL/TP HL bidirectional sync, PnL leverage inflation fix, SL/TP retry loop + slower narrowing, SL/TP max narrowing step, error trade filter, per-symbol consensus SL/TP direction validation.

## v2.0.10–v2.0.31 — Math Audit + LLM Resilience + Evolution + HL WS + Real Trading

Math audit (13 numerical fixes), LLM resilience (circuit breaker + deadline race), Risk Auditor regime-aware TP/SL, evolution enhancement (directional mutation + agent-level evolution + regime-aware strategy), HL WS user-level subscriptions, real-trade UI balance, notional-based fee deduction, unrealized PnL includes entry fee, TradingView TP/SL live update, fitness breakdown fix, dailyPnl auto-reset, SL/TP close learning hook, loss cooldown + LLM review, LLM pattern tag tracking, legacy position management, manual close button, multi-DEX balance + positions.

## v2.0.0–v2.0.9 — Foundation + RBC + Pattern Classifier + SystemGuard

Multi-agent system, HACP protocol, Ollama integration, Binance WS, risk engine, paper trading, dual memory, survival fitness, evolutionary pressure, Sigmoid·GA sentiment engine, S/R zone detection, RBC engine (layered decay + time-weighted centroid), trade pattern classifier (Wilson score), EM cycle chain, backtest engine, loop engineering, real trading interface, TradingView chart, agent model selector, live progress, Fear & Greed index, leverage 2-10x, cumulative position cap, atomic write, schema validation.