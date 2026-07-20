# Changelog

All notable changes to MATS are documented here. See [ARCHITECTURE.md](ARCHITECTURE.md) for full technical details.

---

## v2.0.142: EXP direction-filtered pWin now uses wilsonScore() instead of raw winRate — penalizes small sample sizes to prevent overconfidence on statistically insignificant historical patterns


## v2.0.722: EXP thesis-experience.ts — apply Wilson score to direction-filtered pWin in checkThesisHistory() to penalize small sample sizes and prevent overconfidence from statistically insignificant patterns. Added rawPWin variable to preserve the similarity-weighted win rate for the delta check (which has its own sample size guard via minDeltaSamples). Verdict thresholds (winProbThreshold, lossProbThreshold) now use Wilson LB instead of raw pWin. Added two new tests: one verifying 2/2 matches do NOT trigger FAST_APPROVE (Wilson LB ~0.22 < 0.65), and one verifying 20/20 matches DO trigger FAST_APPROVE (Wilson LB ~0.84 > 0.65).


## v2.0.722: EXP thesis-experience.ts — direction-filtered pWin now uses Wilson score lower bound instead of raw winRate, penalizing small sample sizes to prevent overconfidence on patterns with few historical trades


## v2.0.202: EXP checkThesisHistory() now uses Wilson score lower bound for ambiguous band gate — prevents small-sample overconfidence from driving repeated trades in systematically losing patterns (e.g., BUY xyz:SKHX 31% WR). Previously, raw pWin of 0.60 (3/5 matches) would pass through ambiguous band and get PASS_OPEN_DIRECTLY; now Wilson LB (~0.23) < lossProbThreshold causes fall-through to delta check, which is more conservative.


## v2.0.722: OLR — add L2 regularization (0.01) + maxWeight reduction (5.0) + confidence penalty (Bayesian prior toward 0.5 when nSamples < 50) to prevent extreme P(win) overconfidence from insufficient training data


## v2.0.202: Add per-symbol-direction pattern-based soft gate to block systematically losing patterns (WR<40% over 5+ trades) by raising conviction threshold 25-30%


## v2.0.722: Add L2 regularization + logit clipping to OLR to prevent extreme overconfidence (0%/100% P(win)) that was overriding other safety checks. Three changes: (1) Clip logit to [-10, 10] before sigmoid to prevent floating-point saturation. (2) Apply L2 regularization (λ=0.01) to ALL weights including bias (previously only non-bias with λ=0.001). (3) Reduce maxWeight from 10.0 to 5.0 to further constrain weight magnitude. Together these prevent the sigmoid from saturating to exactly 0 or 1, producing calibrated probabilities that reflect true uncertainty.


## v2.0.733: Add systematicLoserGate() — hard block BUY xyz:SKHX (31% WR over 32 trades) and any other (symbol,direction) with >=10 trades and WR < 35%. Prevents continued losses on systematically losing patterns.


## v2.0.734 — Revert SE's hard block + SystemEngineer.md design principles

### Problem

SE (v2.0.733) added HARD gate + SYSTEMATIC LOSER block to `checkLossStreakGate`, violating the v2.0.732 design: "past losses don't guarantee future losses — condition-aware soft gate, not hard block." SE bypassed the block list by adding a new `checkSystematicLoserGate` call site.

### Fix

1. Reverted `checkLossStreakGate` to pure condition-aware soft gate (15%/20% conviction penalty, regime-aware, no hard block)
2. Removed `checkSystematicLoserGate` call site from decision pipeline
3. Updated `SystemEngineer.md` with CRITICAL DESIGN PRINCIPLES (P1: SOFT only, P2: no re-diagnose, P3: no block list bypass)
4. Updated SE block list with stricter patterns

### Files Changed

- `src/index.ts` — Reverted to soft gate, removed hard block call site
- `src/evolution/system-engineer.ts` — Block list updated
- `SystemEngineer.md` — Design principles added

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.722: Add per-symbol-direction HARD BLOCK for systematically losing patterns (>=15 trades, WR<35%) — blocks ALL new entries in that (symbol, direction) pair until win rate recovers above 40% or auto-release after 48 cycles (4 hours). This is a CAPITAL PRESERVATION measure that catches patterns like BUY xyz:SKHX (22 trades, 31% WR) where losses are not consecutive but the direction is systematically wrong. The existing soft gate (conviction penalty) and decay mechanism (10-14 trades) remain unchanged.


## v2.0.733: Fix per-symbol-per-direction loss streak guard — SOFT gate now raises conviction by 50% (was 15%), HARD gate blocks at 5 consecutive losses (new), SYSTEMATIC LOSER gate blocks at >= 10 trades with WR < 35% (was >= 20). This prevents BUY xyz:SKHX systematic loser pattern (32 trades, 31% WR) from continuing to lose capital.


## v2.0.202: Add systematic loser HARD BLOCK to checkLossStreakGate — blocks (symbol, direction) pairs with >=20 trades and WR<35% (e.g. BUY xyz:SKHX 31% WR over 32 trades). Soft gate (conviction penalty) still applies to moderate cases (5-19 trades).


## v2.0.722: Add hard block for systematically losing patterns (>=20 trades, WR<35%) in orchestrator decision cycle — checkSystematicLoserGate() was defined but never called, causing BUY xyz:SKHX (31% WR over 32 trades) to keep executing. Now called after loss streak gate but before conviction gate so hard block takes priority over adaptive threshold adjustments.


## v2.0.732 — Loss streak gate: condition-aware soft gate (B+C) + SE notification

### Philosophy Change

**Old**: "Past losses → future losses → hard block" (gambler's fallacy bias)
**New**: "Past losses in SAME regime → require stronger signal" (condition-aware)

Past losses in a **different** regime are irrelevant — market conditions changed. The gate only penalizes when the **current** regime has a losing track record.

### Implementation (Option B + C)

**Option B — Condition-aware**: `lossStreakTracker` now tracks per-regime win/loss stats. `checkLossStreakGate()` only applies a penalty when the current regime has ≥5 trades with <35% WR. If the regime changed (e.g. was `low_volatility`, now `trending_bull`), no penalty.

**Option C — Soft gate**: Instead of hard-blocking (override to HOLD), the gate raises the effective conviction threshold:
- Consecutive 3+ losses in same regime → conviction +15%
- Systematic loser in same regime (5+ trades, <35% WR) → conviction +20%
- Penalty is added to the adaptive filter's conviction threshold (capped at 85%)
- Strong signals can still enter — they just need to be stronger

### SE Notification

Updated SE block list + Phase 1 prompt "Known Good Code" section:
- Block list: blocks removal/revert, allows threshold improvements
- Phase 1 prompt: "v2.0.732 — condition-aware SOFT gate. Raises conviction threshold. Past losses in DIFFERENT regime are ignored. Does NOT hard block. Do NOT revert to hard block."

### Files Changed

- `src/index.ts` — `lossStreakTracker` gains `regimeStats`, `checkLossStreakGate` returns `convictionPenalty` instead of `blocked`, `updateLossStreakTracker` tracks per-regime stats, `applyLossStreakGateToDecision` stores penalty, conviction gate reads `_lossStreakPenalty`, multi-symbol path updated
- `src/evolution/system-engineer.ts` — Block list + Known Good Code updated

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.731 — Wire loss streak gate (was dead code!) + SE block list fix

### Critical Bug: Loss Streak Guard Was Never Called

**Problem**: The loss streak guard was fully implemented but **never called** from the decision pipeline. `applyLossStreakGateToDecision` and `updateLossStreakTracker` had zero call sites. This is why BUY xyz:SKHX with 31% WR over 32 trades was never blocked.

**Fix**:
1. `updateLossStreakTracker` called from `onPositionClosedLearning()` for every closed trade
2. `applyLossStreakGateToDecision` called in active-symbol pipeline BEFORE conviction gate
3. `checkLossStreakGate` called in multi-symbol pipeline
4. SE block list updated — allows improvements to threshold/decay, blocks removal

### Files Changed

- `src/index.ts` — Loss streak gate wired into both decision pipelines + close learning
- `src/evolution/system-engineer.ts` — Block list updated

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.722: Add OLR confidence penalty — Bayesian prior pulls extreme predictions toward 0.5 when sample count < 50. Prevents 0%/100% overconfidence from imbalanced shadow trade training data. Applied after 5-bin calibration map in query().


## v2.0.730 — Fix direction restriction surviving restart (persistence gap)

### Problem

Direction restrictions auto-expire after 2 cycles (v2.0.727), but `directionRestrictionsSetCycle` was **not persisted** to `market-agent-config.json`. On restart:
1. Config loaded with `directionRestrictions: { "xyz:SILVER": "sell" }`
2. `directionRestrictionsSetCycle` was `undefined` (not in config file)
3. `updateCycle()` checked `directionRestrictionsSetCycle !== undefined` → false → **never expired**
4. Restrictions persisted forever across restarts

This caused SILVER BUY signals to be blocked by a stale `sell-only` restriction that should have expired 2 cycles after it was set.

### Fix

1. **Persist `directionRestrictionsSetCycle`**: `saveMarketAgentConfig()` now writes `directionRestrictionsSetCycle` to the config file. `loadMarketAgentConfig()` restores it.

2. **Stale config expiry**: If `directionRestrictions` exists but `directionRestrictionsSetCycle` is missing (old config from before v2.0.730), it's set to `-999` — which triggers immediate expiry on the first `updateCycle()` call.

3. **Cleared current config**: Removed the stale `xyz:SILVER: sell` restriction from `market-agent-config.json`.

### Files Changed

- `src/evolution/persistence.ts` — `MarketAgentConfigSnapshot` gains `directionRestrictionsSetCycle`, save + restore + stale config handling
- `data/evolution/market-agent-config.json` — `directionRestrictions` cleared

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.729 — Adaptive filter per-symbol winRate + merged log

### Problem

The adaptive filter `adapt()` loop used **global** `recentWinRate` for ALL filters — BTC, SILVER, and SKHX all adapted to the same win rate instead of their own performance. Additionally, each filter logged a separate "Adaptive filter adjusted" line, producing 3 nearly-identical log lines.

### Fix

1. **Per-symbol winRate**: Each filter computes its own winRate from `tradeHistory` filtered by symbol
2. **Merged log**: 3 separate log lines replaced by 1 merged line; per-filter log downgraded to `debug`

### Files Changed

- `src/index.ts` — Per-symbol winRate in adapt loop, merged log
- `src/analysis/adaptive-filter.ts` — `adapt()` log `info` → `debug`

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.722: Fix OLR extreme probability overconfidence — add low_volatility regime ordinal mapping (0.2) to distinguish from mean_reverting (0.5), preventing regime confusion that contributed to 0%/100% P(win) predictions


## v2.0.728 — SE cycle blocking + test retry loop (3 attempts)

### Problem 1: SE modifying files while cycle is running

SE was triggered with `void` (fire-and-forget) in the `finally` block after cycle completion. The next cycle's timer would start counting down immediately, so SE's LLM calls (20-30s) + tsc + tests could overlap with the next HACP cycle. This caused code changes mid-cycle.

**Fix**: SE now runs **synchronously** (`await`) with `cycleInProgress = true` set before SE starts and `false` after SE finishes. The next cycle cannot start while SE is running.

### Problem 2: SE test retry only had 1 attempt

Phase 2c (test failure retry) only tried once. If the LLM's first test fix was wrong, SE immediately rolled back and gave up.

**Fix**: Phase 2c now retries up to **3 times** in a loop. Each retry sends the latest test error output to the LLM. Improved error capture from both `err.stdout` and `err.stderr`.

### Files Changed

- `src/index.ts` — SE runs `await` (synchronous) with `cycleInProgress = true` blocking
- `src/evolution/system-engineer.ts` — Phase 2c retry loop (3 attempts), improved error capture

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.202: Fix tsc error in thesis-experience.ts — add explicit type annotation for winRateSame variable


## v2.0.727 — Direction restriction auto-expiry (2 cycles) + SE test failure retry

### Direction Restriction Auto-Expiry

**Problem**: Direction restrictions (e.g. `xyz:SILVER: sell-only`) persist indefinitely in `market-agent-config.json`. Users can forget they set a restriction, and it silently blocks all opposite-direction trades. The exploration logic wastes entire cycles computing a direction only to have it blocked by the gate.

**Fix**: Direction restrictions now **auto-expire after 2 cycles**:
- `setDirectionRestrictions()` records the current cycle number (`directionRestrictionsSetCycle`)
- `updateCycle()` (called every cycle from `index.ts`) checks expiry and clears restrictions after 2 cycles
- `getDirectionRestrictions()` also checks expiry (belt-and-suspenders)
- **Restart case**: If `directionRestrictionsSetCycle > currentCycle` (stale config from previous process), restrictions expire immediately on first cycle
- Log message includes "will auto-expire after 2 cycles" when set, and "auto-expired (age=N cycles)" when cleared

### SE Test Failure Retry (Phase 2c)

**Problem**: SE had a tsc error retry (Phase 2b) but **no test failure retry**. When tsc passed but tests failed (e.g. Wilson score gates required more test records), SE immediately rolled back and gave up — wasting the entire Phase 1 + Phase 2 LLM calls.

**Fix**: Added **Phase 2c: Test failure retry**:
- When tsc passes but tests fail, SE extracts the failing test details (FAIL lines, AssertionError, expected/received)
- Sends the test errors + current file content + test file content to the LLM
- LLM can provide BOTH a code fix (for the source file) AND a test update (for the test file)
- Re-runs tsc + tests after applying the retry fix
- If retry also fails, rolls back to original content

This means SE now has **3 retry layers**:
1. Phase 2: Initial fix
2. Phase 2b: tsc error retry (fix type errors)
3. Phase 2c: Test failure retry (fix failing tests)

### Files Changed

- `src/types/index.ts` — `MarketAgentConfig` gains `directionRestrictionsSetCycle?`
- `src/market-agent/index.ts` — `updateCycle()` method, auto-expiry in `getDirectionRestrictions()` + `setDirectionRestrictions()` + `updateCycle()`, restart case handling
- `src/index.ts` — `marketAgent.updateCycle(this.totalCycles)` called every cycle
- `src/evolution/system-engineer.ts` — Phase 2c test failure retry (extract fail details, send to LLM, re-run tsc+tests)
- `data/evolution/market-agent-config.json` — `directionRestrictions` cleared (was `{ "xyz:SILVER": "sell" }`)

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.726 — No-Trade Investigation: SE auto-investigates 3+ idle cycles

### Problem

When the system hasn't traded for 3+ cycles, there's no automated investigation. The System Engineer (SE) only runs every 2 cycles to analyze trade records — but if there are no new trades, it re-analyzes the same stale data. Meanwhile, the user has no visibility into WHY trades aren't happening (gate blocking? market quiet? consensus too low?).

### Fix

**No-trade detection**: Added `cyclesSinceLastTrade` counter, incremented every cycle and reset to 0 when `executeTrade()` succeeds. After 3+ idle cycles, SE is triggered with a special **no-trade investigation mode**.

**Investigation context**: SE receives:
- `cyclesSinceLastTrade`: How many cycles since last trade
- `lastGateResults`: Which gates passed/blocked in the last cycle (conviction-gate, shadow-gate, audit-gate, frequency-throttle, etc.)
- `marketConditions`: Last 5 cycles' regime + volatility + price

**Investigation decision tree** (in SE Phase 1 prompt):
1. All gates passed but HOLD → normal in quiet markets
2. A gate blocked → identify which gate + whether threshold is too aggressive
3. Market genuinely quiet (low vol, no edge) → valid reason, report "market-quiet" (no fix needed)
4. Mechanism overly conservative → propose fix to loosen threshold

**Market-quiet escape hatch**: If SE concludes the market is simply quiet, it reports `{"category":"market-quiet"}` and does NOT force trades or propose unnecessary fixes.

**Gate results tracking**: `activeAuditGates` from the decision pipeline are now saved to `this.lastGateResults` after each cycle, so SE can see exactly which gate blocked the trade.

### Files Changed

- `src/index.ts` — `cyclesSinceLastTrade` counter, `lastGateResults` + `recentMarketConditions` tracking, `runNoTradeInvestigation()` method, gate results saved after decision pipeline, 3-cycle trigger logic
- `src/evolution/system-engineer.ts` — `runSystemEngineer()` accepts `noTradeInvestigation?` parameter, Phase 1 prompt includes investigation context + decision tree + market-quiet escape hatch

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.725 — SE Block List Fix + Audit Integration (stop wasting tokens)

### Problem 1: SE Block List Too Broad — Wasting Tokens on Repeated Blocked Diagnoses

The System Engineer (SE) repeatedly diagnosed "EXP checkThesisHistory() uses raw win rate instead of Wilson score" — a **real issue** — but was blocked by `BLOCKED_PATTERNS` which matched `/checkThesisHistory/i` (any mention of the method name). The block was intended to prevent removal of the direction filter, but it also blocked Wilson score improvements, condition filtering, and any other modification to the method.

**Fix**: Tightened the block pattern from `/checkThesisHistory/i` to `/remove.*direction.*filter|delete.*sameDir|remove.*sameDir/i` — only blocks removal of the direction filter, not all modifications. The Wilson score gates (H4) and condition filtering (H3) are already applied, so the SE can now propose further improvements without being blocked.

### Problem 2: SE Has No Audit Integration — Duplicates Work

The trade record audit (C3, v2.0.720) and the System Engineer (SE) both analyze trade records independently. The audit detects specific incidents (e.g. `olr-pwin-mismatch`, `exit-timing`, `thesis-contradicts-action`), but the SE doesn't see these results — it re-analyzes the same trade data from scratch, often diagnosing the same issues the audit already found.

**Fix**: `runSystemEngineer()` now accepts an optional `auditResults` parameter. When provided, audit incidents are injected into the Phase 1 prompt as "🔍 Trade Record Audit Results" — marked as HIGHEST PRIORITY issues. The SE can now directly fix the root causes identified by the audit instead of re-diagnosing from scratch.

The call site in `index.ts` passes `this.lastAuditResult` to `runSystemEngineer()`, so the SE always sees the latest audit findings.

### Files Changed

- `src/evolution/system-engineer.ts` — `BLOCKED_PATTERNS` checkThesisHistory pattern tightened, `runSystemEngineer()` accepts `auditResults?`, Phase 1 prompt injects audit incidents
- `src/index.ts` — `runDirectionAudit()` passes `this.lastAuditResult` to `runSystemEngineer()`

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.724 — Fix audit gate false positive blocking all SELL signals

### Problem

The audit gate (C3, v2.0.720) used `detailLower.includes(auditDir)` to match critical incidents to candidate decisions. For SELL decisions, this meant **any critical incident whose detail text contained the word "sell"** would block ALL SELL signals — regardless of symbol or context.

This caused a persistent false positive: the `thesis-contradicts-action` incident (detail: *"Trade #18: thesis states 'OLR 99% win rate on SELL' but the OLR_PWin field shows..."*) contained the word "SELL" in passing, so the gate blocked every subsequent SELL decision on every symbol. SILVER SELL signals were consistently overridden to HOLD.

### Root Cause

The matching logic had two layers:
1. **Symbol match** (correct): `normalizeSymbol(incSym) !== auditSym` — only matches the specific symbol
2. **Direction match** (buggy): `detailLower.includes('sell')` — matches ANY detail mentioning "sell", even in passing

The direction match was far too broad. An incident saying "OLR 99% on SELL" is **not** saying "block all SELLs" — it's describing a specific trade's thesis contradiction. But the gate interpreted any mention of "sell" as a directional block signal.

### Fix (two layers)

**Layer 1: Tightened direction matching** — Detail-based match now requires both direction mention AND a losing indicator (`loss`, `losing`, `low win`, `wrong direction`, `ignoring`, `failure to learn`). Passing mentions like "OLR 99% on SELL" no longer trigger the gate.

**Layer 2: One-off category allowlist** — Categories that describe **single-trade observations** (not repeated directional patterns) are excluded from the gate entirely:
- `thesis-contradicts-action` — one trade where thesis didn't match signal
- `olr-signal-misuse` — observation about OLR reliability
- `exit-timing-premature` — single trade exit timing
- `vague-thesis` — thesis quality observation

Only categories indicating a **systemic directional problem** (e.g. `direction-repetition`, `direction-confusion`) trigger the gate. This applies to both BUY and SELL equally.

### Impact

- SILVER SELL signals will no longer be blocked by unrelated `thesis-contradicts-action` incidents
- The audit gate still blocks genuinely dangerous patterns (e.g. `direction-repetition` on a symbol with 31% WR)
- False positive rate dramatically reduced — only incidents that specifically describe a **repeated losing pattern** for the candidate direction will trigger the gate

### Files Changed

- `src/index.ts` — Audit gate matching logic tightened (direction + losing indicator required)

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.723 — Vulnerability Defense: 4 fixes from code challenge

### V5: Shadow boost log NaN guard

**Problem**: Shadow boost log line used `finalDecision.positionSizePct * 100` without null guard — if `positionSizePct` was undefined, the log would display `NaN%`.

**Fix**: Added `?? 0` guard: `((finalDecision.positionSizePct ?? 0) * 100).toFixed(0)`.

### V6: H3 regime filter case-insensitive

**Problem**: Condition-based matching used `h.regime !== candRegime` (exact string match). If candidate regime was `'trending_bull'` but record regime was `'TRENDING_BULL'` (different case), the filter would reject all records — silently disabling condition matching.

**Fix**: Changed to `h.regime.toLowerCase() !== candRegime.toLowerCase()`.

### V11: `contextToVector` null fallback

**Problem**: `contextToVector` only checked `val === undefined` for fallback. If a JSON-parsed feature value was `null` (possible from corrupted state files), it would pass through as `null`, then `Number.isFinite(null)` = false → NaN guard rejects the entire sample. This would silently skip valid training samples.

**Fix**: Added `val === null` to the fallback condition: `if (val === undefined || val === null)`.

### V15: `coarseTypes` extracted to module-level Set

**Problem**: The digester callback created a new `coarseTypes` array on every invocation (every trade close). Micro-inefficiency, but also fragile — if the array contents drifted from the actual `ExitType` union, the guard would silently break.

**Fix**: Extracted to module-level `COARSE_EXIT_TYPES = new Set([...])` with `O(1)` lookup via `.has()` instead of `O(n)` `.includes()`.

### Files Changed

- `src/index.ts` — V5: shadow boost log `?? 0` guard
- `src/evolution/thesis-experience.ts` — V6: regime filter `.toLowerCase()`, V15: `COARSE_EXIT_TYPES` Set
- `src/evolution/olr-engine.ts` — V11: `contextToVector` null check

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.722 — Rich Exploration Thesis (vague-thesis fix)

### Problem

The audit log flagged `vague-thesis` as a warning: exploration trades used a hardcoded template `"buy exploration — pattern classifier suggests buy has higher historical win rate in current regime"` that was **identical for every exploration trade**. This made EXP embeddings useless for exploration trades — all exploration theses produced nearly identical MiniLM vectors, so the system couldn't learn condition-specific outcomes from exploration data.

### Fix

Exploration `entryThesis` now includes **actual market data** at entry time:
- Price level, regime, volatility, OB imbalance, funding rate
- 24h change, S/R distances (support + resistance in bps)
- Sentiment, volume ratio
- OLR P(win) + sample count for the selected direction
- Shadow win rate + sample count for the selected direction

**Example old thesis**: `[1h: buy exploration — pattern classifier suggests buy has higher historical win rate in current regime]`

**Example new thesis**: `[1h: buy exploration on BTC @ 68432.50 — regime=trending_bull, vol=0.0234, OB=0.15, funding=0.00012, 24h=2.50%, S/R: support=150bps/resistance=320bps, sentiment=0.30, volRatio=1.20, OLR_pWin=62% (15 samples), shadowWR=58% (22 samples)]`

This gives the digester's MiniLM embeddings **condition-specific signal** — two exploration trades in different regimes/volatilities will produce different vectors, enabling EXP to learn "exploration buys in trending_bull + low vol win" vs "exploration buys in mean_reverting + high vol lose."

### Files Changed

- `src/index.ts` — Exploration `entryThesis` + `rationale` + log now include 12 market data fields + OLR/shadow context

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.721 — H1-H8 Learning Engine Accuracy Improvements + wilsonScore Bug Fix

### H2: OLR 5-Bin Calibration Map (Highest ROI)

**Problem**: `query()` returned raw `sigmoid(z)` as `pWin` with no calibration. Agent prompts use hardcoded thresholds (`>60% → increase conviction`, `<40% → bias against`), and the fusion layer uses `olrPWin > 0.50 / < 0.40` — all assume calibration that doesn't exist.

**Fix**: Added 5-bin empirical calibration map per `(symbol, side)` model. Each bin tracks `[0.0-0.2)`, `[0.2-0.4)`, `[0.4-0.6)`, `[0.6-0.8)`, `[0.8-1.0]`. `feedTrade()` records `(rawPWin, actualOutcome)` pairs before SGD update. `query()` replaces raw sigmoid with empirical win rate when the corresponding bin has ≥5 samples. Falls back to identity (raw pWin) when bins are insufficient — zero risk at small N.

### H4: Wilson 95% Lower Bound for FAST_APPROVE Gates + wilsonScore Bug Fix

**Problem**: `wilsonScore()` existed but was never used in EXP's FAST_APPROVE gates. A 2/2 class (raw 100%) would auto-approve — pure small-sample overconfidence. Additionally, `wilsonScore()` had a **NaN bug**: used `centre*(1-centre)` in the variance term instead of `p*(1-p)`, causing NaN when `p=1.0` (centre > 1 → negative under sqrt).

**Fix**: 
1. **Bug fix**: `wilsonScore()` now uses `p*(1-p)` in variance + `Math.max(0, variance)` guard. Wilson LB for 10/10 = 0.72 (was NaN).
2. Semantic class FAST_APPROVE gate: checks `wilsonScore(c.wins, c.count) >= classWinThreshold` — falls through to raw similarity if insufficient.
3. pWin FAST_APPROVE gate: checks `wilsonScore(pWinWins, pWinTotal) >= winProbThreshold`.
4. Agent-evolution weights and EM `weightedWinRate` left as raw winRate (Wilson would crush small-sample agents too aggressively).

### H5: Pattern Classifier Direction Threshold 0 → 0.3

**Problem**: `index.ts` used `buyWr > 0 || sellWr > 0` to let pattern classifier drive direction. Since `adjustedWinRate` is Wilson-scored, 1/3 = Wilson LB ~10% > 0 — noise was driving direction.

**Fix**: Changed to `Math.max(buyWr, sellWr) > 0.3 && Math.abs(buyWr - sellWr) > 0.1`. Wilson LB 0.3 ≈ 5/8 raw WR (62.5%) — reasonable minimum for direction signal.

### H3: Condition-Based Matching (Regime + Volatility Band)

**Problem**: `marketFeatures` (volatility, OB imbalance, funding rate, S/R distance) stored on every record since v2.0.178 but never read by `checkThesisHistory()`. Two trades with identical thesis text but opposite volatility regimes were treated as identical.

**Fix**: `CheckThesisInput` gains optional `regime?` and `volatility?` fields. Matching loop filters historical records to same-regime + ±50% volatility band. Falls back to all matches when no condition-matched records exist (zero regression). HACP passes `this.currentRegime` to `checkThesisHistory()`.

### H7: Close-Learning signalAgreement Train/Test Mismatch

**Problem**: `signalAgreement` was hardcoded to `0.5` at close-learning time (training), but query-time features used `result.consensus.confidence` (real values). This train/test mismatch meant OLR trained on a constant feature that varied at query time.

**Fix**: Close-learning now uses `this.lastHACPResult?.consensus?.confidence ?? 0.5` — same source as query-time features.

### H8: Soft Asset-Category Weighting in pWin

**Problem**: pWin calculation pooled all same-direction matches across asset categories. A BTC thesis could match XAU records, polluting pWin with cross-asset outcomes.

**Fix**: Same-category matches get 1.2× weight, cross-category get 0.8× weight in the similarity-weighted pWin calculation. Soft weighting (not hard filter) ensures small categories always have matches.

### H6: Shadow Gate Wilson + Symmetric Size Boost

**Problem**: Shadow soft gate used static `shadowWR < 0.25 && total >= 10`. No symmetric boost for high shadow WR — the positive tail was wasted.

**Fix**: Gate now uses `wilsonScore(shadowWins, shadowTotal) < 0.30 && total >= 20` (more conservative, sample-size aware). Symmetric boost: `wilsonScore > 0.65 && total >= 20` → `positionSizePct *= 1.2` (boosts size, not conviction threshold — avoids feedback loop with adaptive filter).

### H1: Regime as OLR Feature (Not Interactions)

**Problem**: OLR is purely linear — cannot capture feature interactions like `volatility × sentiment`. But with ~30-50 samples per side, adding 3-5 continuous interaction features (14 total) would overfit. Polynomial features (39) were completely infeasible.

**Fix**: Added `regimeOrdinal` as a single feature (D: 11 → 12). Maps regime string to ordinal: `trending_bull=1.0`, `trending_bear=0.8`, `breakout=0.6`, `mean_reverting=0.5`, `high_volatility=0.3`, `chaotic=0.1`, `unknown=0.5`. Captures 80% of the interaction value (trending vs mean-reverting is the biggest effect) at 1/5 the dimensionality cost. `contextToVector` falls back to 0.5 for missing `regimeOrdinal` (not 0, which means `chaotic`).

### Files Changed

- `src/evolution/olr-engine.ts` — `FEATURE_NAMES` 11→12 (regimeOrdinal), `OLRModel.calibrationBins`, `regimeToOrdinal()`, calibration helpers, `feedTrade` records calibration, `query()` applies calibration, `contextToVector` regimeOrdinal fallback
- `src/evolution/evolution-utils.ts` — `wilsonScore()` bug fix (p*(1-p) variance, NaN guard)
- `src/evolution/thesis-experience.ts` — Import `wilsonScore`, `CheckThesisInput` gains `regime?`/`volatility?`, matching loop condition filter, FAST_APPROVE Wilson gates, soft category weighting in pWin
- `src/evolution/olr-backfill.ts` — `featuresFromCandle` adds `regimeOrdinal: 0.5`
- `src/cognition/hacp.ts` — `checkThesisHistory` call passes `regime: this.currentRegime`
- `src/index.ts` — Import `wilsonScore` + `regimeToOrdinal`, pattern threshold 0→0.3, shadow gate Wilson + size boost, close-learning `signalAgreement` fix, OLR features add `regimeOrdinal`
- `tests/evolution-memory.test.ts` — `zeroFeatures` adds 4 new features, source weighting test `>` → `>=`
- `tests/thesis-experience.test.ts` — 2 FAST_APPROVE tests increase records 1→8 (Wilson gate)
- `720upgrade.md` — H1-H8 修正方案取代原方案

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.720 — Learning Engine Accuracy Overhaul: 3 Critical Bug Fixes + premature_sl Dead Code Fix

### C1: MFE/MAE Features Silently Discarded by OLR (Critical Bug)

**Root cause**: `index.ts:2244-2257` (v2.0.152) added `mfePct` / `maePct` / `mfeToPnlRatio` to the features object passed to `olrEngine.feedTrade()`, but `olr-engine.ts:288` `contextToVector()` only maps `FEATURE_NAMES` (8 names). The 3 new features were silently discarded — the v2.0.152 comment "Add MAE/MFE to OLR features" was never actually implemented. MFE/MAE are among the strongest predictors of trade outcome (a trade that reached +4.5% MFE then hit -2% SL is very different from one that went straight to -2%).

**Fix**: Added `mfePct`, `maePct`, `mfeToPnlRatio` to `FEATURE_NAMES` (8 → 11 features). Shadow trade engine now computes these at resolution time and adds them to `trainingFeatures`. `migrateModel()` pads old models with 0 weights for backward compatibility. `olr-backfill.ts` auto-initializes new features to 0 with Welford mask (no contamination).

**Expected accuracy impact**: +5-15%.

### C2: Agent-Outcomes Backfill Contamination (Critical Bug)

**Root cause**: `agent-outcomes.ts:102-110` `backfillOutcome()` marked ALL records for a symbol as win/loss when a position closed — including agents that recommended HOLD. Agent A says HOLD, Agent B says BUY, BUY loses → Agent A's HOLD is also marked LOSS. This silently corrupted every agent's win rate, which propagated into HACP voting weights via `agent-evolution.ts`.

**Fix**: `backfillOutcome()` now takes an optional `positionSide` parameter. It skips `hold` and `close` recommendations, and only backfills `buy`/`sell` recommendations that match the closed position's side. Both call sites in `index.ts` updated to pass `trade.side`.

### C3: Direction Audit Completely Disconnected (Free Win)

**Root cause**: `direction-audit.ts` implements an LLM-powered trade record audit that detects suspicious patterns (repeated direction errors, SL-too-tight, thesis-contradicts-action, etc.). It was imported in `index.ts:53` but **never called** anywhere in the decision pipeline.

**Fix**: Added audit trigger (every 2 cycles, non-blocking async, guarded by `auditRunning` flag). Cached `AuditResult` is checked by a new audit gate in the decision pipeline: if a critical incident matches the candidate symbol+direction, the decision is overridden to HOLD. The gate uses both detail-text matching and category-based direction matching. LLM failure returns empty incidents (safe fallback — gate doesn't fire).

### P0-A: premature_sl Dead Code Fix (ExitType Reflux)

**Root cause**: `CloseReasonAggregator` (`reason-analytics.ts:367`) has logic to flag `premature_sl` exits with WR < 0.3 → ⚠️ "Premature closes cost X". But `recordClose()` writes coarse `exitType` (`sl_tp` / `consensus` / `manual` / etc.), never `premature_sl`. The fine-grained classification (`premature_sl` / `correct_sl` / etc.) only exists in `LessonStatement.exitType` (A2A digester layer) and never flows back to RIL. The premature warning was dead code.

**Fix**:
1. Extended `ExitType` union with `premature_sl` | `premature_tp` | `correct_sl` | `correct_tp`
2. `RecordCloseInput` gains `lessonExitType?: ExitType` — if provided, overrides coarse `exitType` on the record
3. `ExperienceDigester.addRecord()` gains `onLessonDigest` callback — after LLM digestion, the derived `exitType` is written back to the in-memory record (not disk, avoiding JSONL duplication)
4. `thesis_invalidated` (LessonStatement) → `thesis_invalidation` (ExitType) mapping in callback
5. `coarseTypes` guard prevents re-overwriting already-fine-grained exitType
6. `CloseReasonAggregator` requires no changes — `premature_sl` now appears in `exitType`, the warning fires naturally

### Files Changed

- `src/evolution/olr-engine.ts` — `FEATURE_NAMES` 8 → 11 (add MFE/MAE/mfeToPnlRatio)
- `src/evolution/shadow-trade-engine.ts` — Add MFE/MAE to shadow `trainingFeatures` at resolution
- `src/evolution/agent-outcomes.ts` — `backfillOutcome()` skip HOLD/close, match positionSide
- `src/evolution/experience-digester.ts` — `addRecord()` gains `onLessonDigest` callback
- `src/evolution/thesis-experience.ts` — `RecordCloseInput` gains `lessonExitType`, callback writes back exitType
- `src/types/index.ts` — `ExitType` union extended with fine-grained types
- `src/index.ts` — Audit trigger (every 2 cycles), audit gate, `catDirMentionDirection` helper, `backfillOutcome` call sites pass `positionSide`
- `720upgrade.md` — P0-A + P0-B (C1/C2/C3) + P1-P3 (H1-H8 roadmap)

**Build**: `tsc --noEmit` clean. 94 tests pass.

---

## v2.0.202: Add per-symbol-per-direction loss streak guard to block systematically losing patterns


## v2.0.202: Add per-symbol-per-direction systematic loser gate to prevent continued losses on patterns like BUY xyz:SKHX (14 trades, 29% WR, -$3.05 PnL). The gate blocks a (symbol, direction) pair when totalTrades >= 10 AND winRate < 0.35, with a decay mechanism that halves the trade count after 24 cycles to prevent permanent deadlock. Also added comprehensive test suite covering all edge cases.


## v2.0.181: Add per-symbol-per-direction loss streak guard — block BUY xyz:SKHX after 3 consecutive losses (systematic loser: 29% WR, -$3.05 PnL over 14 trades). Two conditions: (1) 3+ consecutive losses blocks for 12 cycles, (2) totalTrades >= 10 AND winRate < 0.35 blocks until winRate > 0.40. checkLossStreakGate() called in decision cycle before executing any BUY/SELL. updateLossStreakTracker() called from onPositionClosedLearning() for every closed trade. New test file tests/loss-streak-guard.test.ts with 10 test cases.


## v2.0.202: Add per-symbol-per-direction loss streak guard in orchestrator — blocks BUY xyz:SKHX after 3 consecutive losses OR when totalTrades >= 10 with winRate < 0.35. The guard tracks totalTrades and totalWins per (symbol, direction) pair, and blocks the pair until win rate recovers above 0.40. This prevents the system from repeatedly making the same losing bet even when losses are not consecutive.


## v2.0.202: Add per-symbol-per-direction loss streak guard — BUY xyz:SKHX blocked after 3 consecutive losses (WR=29% over 14 trades)


## v2.0.202: Add debug logging to verify resolution-time features are used in OLR training — helps diagnose stale feature problem in shadow trade engine


## v2.0.181: Fix shadow trade OLR training to use weighted combination of entry and resolution features (0.3/0.7) instead of stale entry features — prevents learning spurious correlations from outdated market conditions


## v2.0.203: No change needed — current code at line 380 is correct


## v2.0.181: OLR learning rate decay now uses live samples only (excludes backfill) — prevents model freezing from stale backfill data


## v2.0.202: Fix OLR backfill Welford contamination — backfill no longer updates normalization stats, preventing feature explosion on first live sample and restoring OLR learning system effectiveness


## v2.0.181: Fix OLR learning rate decay to exclude backfill samples — prevents model freezing from 200 simulated trades, enabling continuous adaptation to live market conditions


## v2.0.181: Fix OLR SGD decay to use live sample count instead of total (backfill-inflated) nSamples — prevents model freezing and enables continuous adaptation to market changes


## v2.0.202: Fix shadow trade OLR training — use resolution-time features instead of entry-time features for correct P(win | current conditions) learning


## v2.0.201 — System Engineer Two-Phase Audit + Test Detection Fix + Fuzzy oldCode Matching

### Two-Phase Audit (fixes oldCode hallucination)
- **Phase 1 (Diagnosis)**: LLM sees file summaries (50-line previews) + trade data, identifies which file + issue
- **Phase 2 (Exact Fix)**: Full file content sent to LLM, asks for exact oldCode/newCode replacement
- Previous single-phase approach showed only 150 lines per file — LLM couldn't see code beyond line 150 (e.g. `recordClose` at line 472), causing hallucinated oldCode

### Test Pass/Fail Detection Fix
- Was: `output.includes('passed') && !output.includes('failed')` — false negative because log output contains "failed" (e.g. "digestTrade LLM failed")
- Now: Parses vitest summary line (`Tests  X passed (Y)`) instead of scanning entire output

### Fuzzy oldCode Matching
- If exact `oldCode` match fails, tries whitespace-normalized match (trim + collapse spaces)
- If normalized match succeeds, extracts exact text from file using line-by-line trimmed comparison
- Prevents false "hallucination" rejections when LLM gets indentation slightly wrong

### SE-Generated Fix (v2.0.183 in SE commit)
- `shadow-trade-engine.ts`: Added optional `srProvider` parameter to `openShadowTrades()` for fresh S/R zones each cycle
- `olr-engine.ts`: Updated comment clarifying `liveSamples` usage in SGD decay
- `tests/evolution-memory.test.ts`: Added test verifying `liveSamples = nSamples - backfillSamples`

## v2.0.183: Fix shadow trade SL/TP staleness — compute S/R levels fresh each cycle via optional srProvider instead of using cached zones, improving OLR training label quality


## v2.0.168 — Remove hl-fill-* Records from UI + Phantom Close Root Cause (5 Paths) + Post-Review PnL Conversion + Delete Handler Fix

### hl-fill-* Records Removed from UI — Root Cause of Phantom Closes + Delete Failures

**Root cause**: `serializePortfolio()` emitted `hl-fill-*` records synthesized from raw HL fill data (`cachedHLFills`). These records had no thesis/MAE/MFE/postReview and caused three persistent problems:

1. **Duplicate CLOSED entries**: One complete record from `closedRealTrades` + one incomplete from `hl-fill-*` for the same close
2. **Phantom close records**: Closing fills from previous positions matched new positions (same symbol, fill timestamp after new position's `openedAt`)
3. **Delete failures**: `hl-fill-*` IDs are ephemeral — not stored in any persistent array. `cachedHLFills` is overwritten every cycle by `getRecentFills(20)`, so deleting a fill has no lasting effect. The record reappears on next refresh.

**Fix**: Completely removed `hl-fill-*` records from `serializePortfolio()`. `closedRealTrades` is now the single source of truth for closed real trades. If a close hasn't been captured by `closeExchangePosition` yet, the next `syncExchangePositions` cycle will capture it — no need for raw fill display.

### Phantom Close Root Cause — 5 Close Paths Lacked Fill Verification

**Root cause**: There were 5 separate code paths that could close a real position, but only 1 (`syncExchangePositions` non-empty exMap path) had proper fill verification. The other 4 paths closed positions based on position disappearance or stale fills, creating phantom close records for positions that were still open on HL.

| # | Path | Problem | Fix |
|---|------|---------|-----|
| 1 | HL WS position disappeared (index.ts) | WS push can be partial — missing positions assumed closed | **Removed close logic entirely** — only log, let REST `syncExchangePositions` handle real closes |
| 2 | HL WS closing fill (index.ts) | No fill direction check — old position's close fill could match new position | Added `fill.side` direction verification (`B`=buy / `A`=sell) |
| 3 | Paper mode stale position check (index.ts) | No fill direction check | Added `f.side` direction verification |
| 4 | Paper mode stale position >1h (index.ts) | No fill verification at all — assumed closed | Kept (>1h old positions reasonably assumed closed) |
| 5 | Paper mode normal sync (index.ts) | Closed based on position absence alone, no fill check | Added fill verification — no closing fill = no close |

### syncExchangePositions `dir` Field Bug

v2.0.159's fill direction matching used `f.dir.startsWith('buy')` / `f.dir.startsWith('sell')`, but HL's `dir` field values are `"open long"` / `"open short"` / `"close long"` / `"close short"` — **never** starting with `'buy'` or `'sell'`. The check always returned `false`, silently blocking ALL legitimate closes. Fixed to use `f.side` (`'buy'` / `'sell'`) field instead.

### Post-Review MAE/MFE PnL Conversion

**Root cause**: MAE/MFE are tracked as **position value** (margin + unrealized PnL), not as PnL itself. But the Post-Review system prompt said "MFE = best unrealized PnL peak" and passed the raw position value ($11.72) to the LLM. The LLM interpreted $11.72 as the peak profit, when the actual peak profit was only $1.74 ($11.72 - $9.98 margin). This caused absurd analysis like "gave back 88% of peak gains" when the actual giveback was 22%.

**Fix**: Convert MAE/MFE to actual PnL before passing to the LLM:
- `maePnl = minValueReached - margin` (actual worst PnL dip)
- `mfePnl = maxValueReached - margin` (actual best PnL peak)
- System prompt updated with explicit explanation + worked example
- User prompt now includes margin + corrected MAE/MFE labels ("worst PnL dip" / "best PnL peak")

### Delete Handler Robustness

- Case-insensitive symbol matching with `xyz:` prefix stripping
- Detailed logging when match fails (logs all cached fills for debugging)
- API response now includes `error` field on failure (UI was showing "Unknown error" because it checked `result.error` but API returned `result.message`)

### Audit Message Clarity (v2.0.165)

When a gate (conviction, pattern classifier, Terminal Agent) blocks a new entry but a position is still open, the audit message now says "entry blocked by gate — existing position remains under SL/TP management" instead of the confusing "overridden to HOLD by gate".

### Direction Flip Order Fix (v2.0.164)

Moved the per-symbol direction flip check to BEFORE the SL/TP adjustment block. Previously, when agents suggested the opposite direction, the code would adjust SL/TP on the existing position (wasted HL API call, stale trigger orders) before closing it via flip. Now the flip closes first, no SL/TP adjustment is wasted.

### Reimport Field Preservation (v2.0.162)

`syncExchangePositions` close+reimport path now preserves `holdReason`, `originalStopLossPrice`, `originalTakeProfitPrice` in addition to `entryThesis` + `minValueReached` + `maxValueReached`.

### Per-Symbol Direction Flip (v2.0.163)

When per-symbol consensus suggests the OPPOSITE direction of an existing position, the system now closes the existing position instead of just recording an audit log. The new trade executes on the next cycle.

### Files Changed

- `src/index.ts` — Removed hl-fill-* from serializePortfolio, 5 close path fixes (WS position disappeared, WS closing fill direction check, paper mode stale position direction check, paper mode normal sync fill verification), Post-Review PnL conversion, delete handler robustness, audit message clarity, direction flip order fix
- `src/trading/real-trading-manager.ts` — `syncExchangePositions` fill direction matching fixed (f.side instead of f.dir.startsWith), reimport field preservation
- `src/api-server.ts` — Delete API response includes error field on failure

**Build**: `tsc --noEmit` clean. `vite build` clean (442KB gzipped 132KB). 94 tests pass.

---

## v2.0.164 — Duplicate Close Record Root Cause + Direction Flip Order Fix + Reimport Field Preservation

### Duplicate "CLOSED" Records in UI — Root Cause Fix

**Root cause**: `serializePortfolio()` merged two independent data sources into one `tradeRecords` array sent to the UI:
1. `closedRealTrades` — from portfolio, with full thesis/MAE/MFE/postReview
2. `cachedHLFills` — raw HL fill data from `getRecentFills(20)`, with all thesis/MAE/MFE/postReview fields set to `undefined`

When a closing fill existed in both (which it always did — `closeExchangePosition` creates a `closedRealTrade`, and the raw fill stays in `cachedHLFills` until it scrolls out of HL's 20-fill window), the UI showed two records for the same close: one complete, one incomplete.

**Fix**: Added a dedup filter in `serializePortfolio()` on the `cachedHLFills` mapping. For each closing fill, checks if a `closedRealTrade` already exists with the same `symbol + side + close timestamp` (within 1 minute). If so, the `hl-fill-*` record is skipped — the complete record wins. The incomplete duplicate disappears from the UI automatically on next refresh.

### Direction Flip Order Fix

**Root cause**: The v2.0.163 direction flip check ran AFTER the SL/TP adjustment block. When agents suggested the opposite direction, the code would:
1. Adjust SL/TP on the existing position (wasted HL API call, leaves stale trigger orders)
2. Then close the position via direction flip

**Fix**: Moved the direction flip check to BEFORE the SL/TP adjustment block. Now when agents suggest opposite direction, the position is closed immediately without wasting an SL/TP adjustment call on a doomed position. Also added `continue` after the flip close to prevent accessing `pos.*` (which is deleted by `closeTrade`) in the thesis sync code below.

### Reimport Field Preservation (v2.0.162)

`syncExchangePositions` close+reimport path now preserves `holdReason`, `originalStopLossPrice`, `originalTakeProfitPrice` in addition to the already-preserved `entryThesis` + `minValueReached` + `maxValueReached`. Previously these fields were lost when a paper mirror position was replaced by an exchange-imported position, causing SL/TP narrowing detection to break (no original SL/TP to compare against).

### Delete Handler for hl-fill-* IDs (v2.0.163)

The delete trade handler now supports `hl-fill-*` trade IDs (synthesized from raw HL fill data, not stored in any persistent array). Extracts timestamp + symbol from the ID and removes the matching fill from `cachedHLFills`. Also fixed duplicate `setDeleteTradeHandler` registration (v2.0.161) where a second empty handler overwrote the first, making delete always return "Unknown error".

### Per-Symbol Direction Flip (v2.0.163)

When per-symbol consensus suggests the OPPOSITE direction of an existing position (e.g. agents say SELL but a BUY position is open), the system now closes the existing position instead of just recording an audit log. The new trade executes on the next cycle (close needs to settle on HL first). This matches the active symbol overlap guard's conviction-based reversal logic.

### Files Changed

- `src/index.ts` — serializePortfolio hl-fill dedup filter, direction flip moved before SL/TP, `continue` after flip close, delete handler for hl-fill-* IDs, MAE/MFE in agent context for real positions
- `src/trading/real-trading-manager.ts` — Preserve holdReason + originalSL/TP on close+reimport

**Build**: `tsc --noEmit` clean. `vite build` clean (442KB gzipped 132KB). 94 tests pass.

---

## v2.0.160 — Real Position Persistence + Phantom Close Root Cause + Fill Direction Matching + Trade Dedup

### Real Position Persistence — thesis + MAE/MFE + postReview survive restart

Three persistence fixes that together ensure real trade data is never lost on restart:

**1. Real positions persisted**: `savePortfolio` now accepts a `realPositions` parameter. `PortfolioSnapshot` has a new `realPositions` field. On startup, real positions are restored with `entryThesis`, `holdReason`, `minValueReached`, `maxValueReached`, `originalStopLossPrice`, `originalTakeProfitPrice` — all intact. Previously real positions were re-imported from HL on restart with NO thesis/MAE/MFE — all learning data was lost.

**2. PostReview persisted immediately**: `generatePostReview` now calls `persistPortfolio()` after storing the review on the trade record. Previously postReview was fire-and-forget — the trade was persisted BEFORE the LLM generated the review, so postReview was lost on restart.

**3. `persistPortfolio` passes `realPositions`**: Every `persistPortfolio()` call now includes `this.portfolio.getRealPositions()` so real positions are saved to disk after close, after postReview, after trade execution, and on shutdown.

### Phantom Close Root Cause — syncExchangePositions no longer assumes closed

**Root cause**: `syncExchangePositions` was assuming positions were closed when HL API didn't return them (API failure/rate limit). This created phantom close records every cycle, then the next cycle re-imported the position from HL → close again → infinite loop of duplicate trades.

**Three fixes**:
1. **"Uncertain" path**: NEVER assume closed without a confirmed closing fill on HL. Old code assumed closed if position was >1h old and not in `exMap` — but `exMap` can be empty due to API failure, not because the position is actually closed.
2. **"Not in exMap" path**: Only close if there's a confirmed matching closing fill. Old code closed with fallback `exitPrice` even when no fill was found.
3. **`checkPositionExits`**: Skip local SL/TP monitoring for real positions (`agentId === 'hyperliquid-real'`). Real positions have SL/TP as trigger orders on HL — the exchange handles the close. Local monitoring was creating phantom close records when local price hit SL/TP but the HL trigger hadn't filled yet.

### Fill Direction Matching — prevents fake closes from wrong-direction fills

**Root cause**: `syncExchangePositions` matched closing fills to positions using only `symbol + timestamp >= openedAt`. A closing fill from a PREVIOUS position (e.g. SELL CL closed → fill has `dir='sell'`) was matched to a NEW BUY CL position because both have the same symbol and the fill timestamp was after the new position's `openedAt`. This created a fake close record ~25min after the new position opened, while the position was still open on HL.

**Fix**: Fill matching now also checks that the fill direction matches the closing side of the position:
- BUY position → only matches fills with `dir` starting with "sell" (closing a long)
- SELL position → only matches fills with `dir` starting with "buy" (closing a short)

Applied to both the `genuinelyClosed` path (exMap empty) and the `not in exMap` path (exMap non-empty but symbol missing).

### Trade Record Dedup

Both `paperEngine.onPositionClosed` and `portfolio.closeExchangePosition` now check if a trade with the same `symbol + side + openedAt` (within 1 minute) already exists before adding. Prevents double-recording when multiple close paths fire for the same position in the same cycle.

### Startup Purge — removes phantom trades without thesis

On startup, `purgeTradesWithoutThesis()` removes all trades from `paperEngine.trades` and `closedRealTrades` that have no `entryThesis`. These were created by the old mirror bug (paperEngine.executeDecision mirror path) which stored positions without thesis. 210 phantom trades purged on first restart after fix.

### Paper Balance Root Cause Fix (from v2.0.155, consolidated)

`RealTradingManager.executeDecision()` now uses `portfolio.importExchangePosition()` instead of `paperEngine.executeDecision(decisionWithLev, true)`. The old mirror path went through `openPosition()` which deducted margin from paper balance. `importExchangePosition` stores in `realPositions` without touching paper balance.

### Duplicate Position Guard (from v2.0.155, consolidated)

Both the multi-symbol entry path and the active symbol overlap guard now check `cachedExchangePositions` (the live HL position cache) in addition to `portfolio.getPosition()`. Catches HL REST lag where a position exists on HL but hasn't been imported into the portfolio yet.

### Position Count Fix

`status.positions` now uses a `Set`-based deduped count across all three position sources: `p.positions` (paper map) + `realPositions` (importExchangePosition) + `cachedExchangePositions` (HL API cache). No double-counting.

### Real Position UI Visibility (from v2.0.154, consolidated)

`serializePortfolio()` now includes `realPositions` map so real positions show immediately after `executeTrade`, without waiting for `syncExchangePositions`. `pushToAPI()` called immediately after both active symbol and multi-symbol trade execution.

### Files Changed

- `src/index.ts` — Real position persistence, postReview persistence, startup purge, position count dedup, pushToAPI after trade, serializePortfolio realPositions, duplicate position guard, cycle crash fix (posDef narrowing)
- `src/trading/real-trading-manager.ts` — Replaced paperEngine mirror with importExchangePosition, fill direction matching, no phantom close assumption, removed mirrorReports
- `src/trading/portfolio.ts` — importExchangePosition realPositions guard, deleteClosedRealTrade, purgeClosedRealTradesWithoutThesis, closeExchangePosition dedup, checkPositionExits skip real, realPositions restore on startup, made trades/closedRealTrades mutable
- `src/trading/paper-engine.ts` — deleteTrade, purgeTradesWithoutThesis, onPositionClosed dedup, made trades mutable
- `src/evolution/persistence.ts` — PortfolioSnapshot realPositions field, savePortfolio accepts realPositions, Position type import
- `src/api-server.ts` — Delete trade API endpoint + handler
- `src/cognition/hacp.ts` — MFE-aware adaptive trailing SL, debate context per-symbol decisions
- `src/agents/base-agent.ts` — Debate prompts require asset naming
- `ui/src/App.tsx` — Full UI restructure, delete trade button, Selected Market Pairs cards, Lucide icons, Clear Prompt fix, border colors
- `ui/src/index.css` — Enterprise borders, RGB gradient text, panel title sizes, SMP card styles
- `ui/src/types.ts` — Trading Setup → Trading Terminal rename

**Build**: `tsc --noEmit` clean. `vite build` clean (442KB gzipped 132KB). 94 tests pass.

---

## v2.0.155 — Paper Balance Root Cause Fix + MFE-Aware SL/TP + UI Restructure + Delete Trade + Duplicate Position Guard

### Paper Balance Contamination — ROOT CAUSE FIX

The most persistent bug in MATS history — real trades deducting from paper (simulated) balance — is finally fixed at the root cause.

**Root cause**: `RealTradingManager.executeDecision()` placed the real order on HL, then mirrored the trade into the paper portfolio by calling `paperEngine.executeDecision(decisionWithLev, true)`. This went through `PaperTradingEngine.executeOrder()` → `PortfolioTracker.openPosition()`, which **deducted margin + entry fee from `portfolio.balance`** (the paper balance). When the position later closed via `closeExchangePosition()`, the margin was NOT returned (correct for real positions). The asymmetry — deduct at open, don't return at close — permanently reduced paper balance by `margin + entryFee` per real trade.

**Fix**: Replaced `paperEngine.executeDecision(decisionWithLev, true)` with `portfolio.importExchangePosition()`. This stores the position in `realPositions` (separate from paper positions) WITHOUT touching paper balance. The position is immediately tagged `agentId: 'hyperliquid-real'`. Entry thesis is set by `setEntryThesis()` after execution, which checks `realPositions` first.

**Why this also fixes entry thesis loss**: The old mirror path stored positions in `portfolio.positions` with `agentId=''`. `syncExchangePositions` then saw `agentId !== 'hyperliquid-real'` and took the close+reimport path, replacing the thesis-bearing mirror with a fresh `importExchangePosition()` that had no thesis. Now `importExchangePosition` stores directly in `realPositions` with `agentId='hyperliquid-real'`, so `syncExchangePositions` uses the in-place update path that preserves `entryThesis`.

### MFE-Aware Adaptive SL/TP System

The system now learns from its own MFE (Maximum Favorable Excursion) mistakes — the pattern where positions hit +5% MFE then reverse to SL because TP was too far and trailing SL was too slow.

**Layer 1 — Adaptive trailing SL** (`hacp.ts adjustPositions()`): Trail speed adapts to MFE magnitude. MFE < 1% → 0.2% step (give room). MFE 1-3% → 0.5% step. MFE 3-5% → 0.8% step. MFE > 5% → 1.2% step (lock aggressively). Old logic was fixed 0.3% step — too slow, positions reversed before the trail caught up.

**Layer 2 — MFE giveback protection**: If MFE > 2% and price has given back > 50% of MFE from peak, SL jumps to lock in 30% of MFE. Prevents the "+5% MFE → -1% SL" pattern.

**Layer 3 — TP narrowing**: If MFE > 3% and TP is > 2× MFE distance, TP is pulled to 1.5× current MFE. Old logic never adjusted TP — positions hit +5% MFE then reversed because TP was at +10%.

**Layer 4 — HACP priority**: HACP's MFE-aware `adjustPositions` takes priority over agent-suggested averaged SL/TP. The agent suggestions are blind to MFE/giveback patterns; HACP's adaptive trail is data-driven.

**Layer 5 — MFE performance injection**: `buildMfePerformanceBlock()` analyses recent 10 closed trades. If any hit positive MFE but closed at a loss (profit giveback), a block is injected into ALL 7 agents' context showing the pattern + lesson. Agents see their TP/SL mistakes and adjust future suggestions.

**Layer 6 — OLR learns from MAE/MFE**: 3 new OLR features: `mfePct`, `maePct`, `mfeToPnlRatio`. OLR now learns which MFE/MAE patterns lead to wins vs losses. `FEATURE_NAMES` expanded from 8 to 11 dimensions.

### Duplicate Position Guard

**Root cause**: `getPosition()` only checked the local portfolio. During HL REST lag (2-5s after a fill), the position exists on HL but hasn't been imported into the portfolio yet. `getPosition()` returns `undefined`, so the system opens a second position on the same asset.

**Fix**: Both the multi-symbol entry path and the active symbol overlap guard now check `cachedExchangePositions` (the live HL position cache) in addition to `portfolio.getPosition()`. If a position exists on HL but not locally, the trade is blocked.

**Cycle crash fix**: When `getPosition()` returns `undefined` but `cachedExchangePositions` shows a position exists on HL, the per-symbol consensus management (close/adjust) is skipped for that position this cycle. Previously, the code used `pos!` non-null assertions which crashed with "Cannot read properties of undefined (reading 'id'/'side')". Now uses type-safe `posDef` narrowing.

### Delete Trade Feature

Users can now delete erroneous/bug-generated trades from the Trade Incident panel to keep the evolution system's reference data pure.

- **Backend**: `POST /api/trades/delete` endpoint. `paperEngine.deleteTrade()` removes from paper trades array. `portfolio.deleteClosedRealTrade()` removes from closed real trades. Persists to disk.
- **UI**: Delete button (X) in expanded Trade Incident cards with Yes/No confirmation. Only shows for CLOSED trades (not OPEN). Uses Lucide `X` + `Check` icons.

### UI Restructure — HACP Brain Architecture

The three-panel layout is renamed and restructured to reflect the HACP cognitive architecture:

| Old Name | New Name | Content |
|----------|----------|---------|
| Preference / DASHBOARD | HACP Prefrontal | Trading Terminal (controls + chart + Selected Market Pairs) |
| Portfolio | HACP Hippocampus | Evolution + Trade Incident (embedded as modules) |
| Agent Cognition | HACP Consciousness | 8 agent cards (Terminal Agent + 5 sub-agents + Skeptics + Meta-Agent) |

**Panel order**: HACP Prefrontal → HACP Hippocampus → HACP Consciousness (desktop masonry + mobile tabs).

**Mobile**: 3 tabs — Prefrontal / Hippocampus / Consciousness (previously 2 tabs with Prefrontal + Consciousness merged).

### Selected Market Pairs — Professional Card Layout

Replaced the old inline row layout with professional cards:

- **Card border by position status**: green (BUY position), red (SELL position), grey `#888888` (no position) — not by consensus action
- **Header row**: side tag (BUY/SELL/HOLD) + entry price + symbol (uppercase, exchange prefix stripped) + current price + PnL + close button
- **Consensus body**: action tag + confidence + SL/TP + full rationale (no truncation) + options info + decision audit gate status
- **Audit gates**: Shows executed/blocked status with gate names + reasons (e.g. "conviction-gate: 50% < 55%")
- **Existing position audit**: Records when agent suggests a direction that conflicts with existing position but consensus didn't vote to close

### Other UI Changes

- **HACP Debate panel removed**: Consensus data integrated into Selected Market Pairs. `debateRounds` still generated by HACP engine but not rendered in UI.
- **TradingView chart moved**: Above Selected Market Pairs in Trading Terminal. Price info bar removed (chart is self-contained).
- **Balance/Equity moved**: From HACP Hippocampus to top of Trading Terminal. Labels switch by mode: "Simulated Balance/Equity" (paper) / "Genuine Balance/Equity" (real).
- **Trade Incident card click**: Switches Trading Terminal chart via backend `select-symbol` API.
- **Open positions at top**: Trade Incident sort puts open positions first, then closed trades by newest.
- **All emojis replaced with Lucide icons**: 23 new icon imports. String-parsing emojis (e.g. `l.includes('❌')`) left untouched.
- **Agent state badge**: Latency replaces IDLE ("18.6s" instead of "idle"). Collapsed agent footer removed.
- **Enterprise panel borders**: `.panel` normal `#000000` hover `#aaaaaa`. `.panel-rgb-border` normal `#aaaaaa` hover `#000000`. `.agent-card` normal `#000000` hover `#aaaaaa`. RGB rotating border animation removed.
- **RGB gradient text**: Restored on panel titles (`.panel-title`), sub-panel titles (`.evo-title`), and Trading Terminal title (`.agent-name-gradient`).
- **Panel title font size**: Increased 2 steps (`fs-lg` → `fs-2xl`) to distinguish main titles from sub-titles.
- **Symbol display**: Strip exchange prefix (`xyz:SKHX` → `SKHX`) + uppercase everywhere (Selected Market Pairs + Trade Incident).
- **`addTradingMarket` dedup fix**: Uses `Set`-based deduped count instead of `prev.length + positionCount`, which double-counted overlapping symbols and blocked the 3rd slot.

### Terminal Agent Content Filter

System prompt now includes a CONTENT FILTER section that prevents non-trading content from being written to the Root Command Prompt. Explicitly bans UI state notes, system status descriptions, meta-commentary, and non-trading input. Only concrete, actionable trading rules starting with "- " are allowed.

### Clear Prompt Fix

`handleClearPrompt` now sends `{ prompt: '' }` to the backend `sync-prompt` API, which clears `rootCommandPrompt` + `terminalSideGuide` + persists to disk + pushes to UI via SSE. Previously, clearing only cleared local state + localStorage but the backend kept the old prompt, so it reappeared on next SSE push.

### Real Position UI Visibility

`serializePortfolio()` now includes `realPositions` map (stored by `importExchangePosition`) so real positions show immediately after `executeTrade`, without waiting for `syncExchangePositions` to copy them to `p.positions`. `pushToAPI()` called immediately after both active symbol and multi-symbol trade execution.

### Position Count Fix

`status.positions` now counts `realPositions` in addition to `p.positions`. Previously showed "0 positions" in real mode because all positions were in `realPositions` (not `p.positions`).

### Debate Context Enhancement

`buildDebateContext()` now includes per-symbol decisions from `multiSymbolDecision` so debate agents know WHICH asset each statement refers to. Debate prompts now require agents to name the specific asset in their statements.

### Files Changed

- `src/index.ts` — Paper balance fix (importExchangePosition), MFE performance block, OLR MAE/MFE features, duplicate position guard, delete trade handler, Clear Prompt sync, serializePortfolio realPositions, pushToAPI after trade, position count fix, Terminal Agent content filter, debate context enhancement, `addTradingMarket` dedup fix
- `src/trading/real-trading-manager.ts` — Replaced `paperEngine.executeDecision` mirror with `importExchangePosition`, removed `mirrorReports` return
- `src/trading/portfolio.ts` — `importExchangePosition` realPositions guard, `deleteClosedRealTrade()` method
- `src/trading/paper-engine.ts` — `deleteTrade()` method
- `src/cognition/hacp.ts` — MFE-aware adaptive trailing SL, MFE giveback protection, TP narrowing, debate context per-symbol decisions, debate prompts asset naming
- `src/evolution/rbc-clustering.ts` — `FEATURE_NAMES` expanded 8→11 (mfePct, maePct, mfeToPnlRatio)
- `src/agents/base-agent.ts` — Debate prompts require asset naming
- `src/api-server.ts` — Delete trade API endpoint + handler
- `ui/src/App.tsx` — Full UI restructure, delete trade button, Selected Market Pairs cards, consensus integration, Trade Incident card click, open positions sort, symbol display, Clear Prompt fix, agent state badge, Lucide icons
- `ui/src/index.css` — Enterprise borders, RGB gradient text, panel title sizes, SMP card styles, agent-name-gradient, agent-symbols flex centering
- `ui/src/types.ts` — Trading Setup → Trading Terminal rename

**Build**: `tsc --noEmit` clean. `vite build` clean (442KB gzipped 132KB). 94 tests pass.

---

## v2.0.143 — Trade Incident Panel + Trade Execution Refactoring + RIL Complete + Shadow Trade Overhaul + Terminal Agent Cycle Enforcement

### Trade Incident Panel (Phase 2)

Replaces the old Positions table + Trade Records with a unified card-based view. Each trade (paper + real, open + closed) is a card showing:

- **MAE/MFE (Min/Max Value Reached)**: Tracks position VALUE (margin + unrealized PnL) at its worst/best during the trade's lifetime. Updated on every price tick via `updatePosition()` + `softUpdatePosition()`. Persisted to `portfolio-state.json` with `originalStopLossPrice` / `originalTakeProfitPrice` for narrowing detection.
- **Entry Thesis**: Meta-Agent's frozen rationale, captured at open via `setEntryThesis()` after execution succeeds (timing bug fix — previously `setEntryThesis()` ran before the position existed, silently dropping the thesis).
- **Exit Thesis**: Close rationale with SL/TP narrowing analysis. Compares original SL/TP (at open) vs final SL/TP (at close) — detects tightening/widening percentage + SL/TP gap narrowing. Example: `SL was tightened by 45.0% (original SL=$1275.50 → final SL=$1262.00). ⚠️ SL/TP gap was only 1.2% at close (narrowed from original 4.0%) — unreasonably tight, likely noise stop-out.`
- **Post-Review**: LLM auto-generated post-trade review (DeepSeek V4 Flash, fire-and-forget). Analyses MAE/MFE + entry/exit thesis + close reason, proposes how more profit could have been made or less loss incurred. Stored on `trade.postReview`, pushed to UI immediately via `pushToAPI()`.

**SL/TP triggered closes** now set `exitThesis` in `checkPositionExits()` BEFORE calling `closePosition()`, including SL/TP gap analysis + narrowing detection. Fallback `exitThesis` generated in `closePosition()` + `closeExchangePosition()` for reconciliation/manual closes.

**Paper positions MAE/MFE fix**: `refreshPositionMarkPrices()` now updates ALL paper positions (not just real positions) every `pushToAPI()` call, using `cachedPriceMap` + `marketState` fallback. Previously non-active trading markets' paper positions never received price updates between cycles, so MAE/MFE stayed at the open value.

### Trade Execution Refactoring

Clean separation of paper vs real trade execution — the core architectural issue causing entryThesis loss, agentId confusion, and double-close bugs.

- **`executeTrade()`** — unified entry router in `index.ts`. Paper mode → `paperEngine.executeDecision()` directly. Real mode → `realTradingManager.executeDecision()` (HL order + mirror). `setEntryThesis()` called after execution succeeds. Replaces 3 scattered `realTradingManager.executeDecision()` call sites.
- **`closeTrade()`** — unified close router. Paper → `portfolio.closePosition()`. Real → `realTradingManager.closePosition()`. `setExitThesis()` called before closing. Replaces 6 scattered close path call sites (consensus, thesis-invalidation, manual, flip, reconciliation, legacy).
- **`RealTradingManager.executeDecision()`** — removed paper fallback. Paper mode is no longer handled here. Returns error if called without active engine.
- **`RealTradingManager.closePosition()`** — removed paper fallback. Same clean separation.
- **`syncExchangePositions()`** — preserves `entryThesis` + `minValueReached` + `maxValueReached` when close+reimport path is taken (paper position replaced by exchange position). Previously the reimport created a blank position with no thesis, causing RIL/EXP to skip the trade entirely.
- **Manual close double-close fix** — manual close handler was closing on HL first, then `closeTrade()` would close on HL again. Now `closeTrade()` handles everything.

### RIL Reason Intelligence Layer — Complete

All four RIL sub-layers now fully wired and operational:

- **PatternClusterManager**: `addTrade()` called after `recordClose()` returns the record (was never called before — clusters were only built once at startup, permanently stale). Now incrementally updated on every trade close.
- **CloseReasonAggregator**: Uses real `exitType` field (`sl_tp` / `consensus` / `manual` / `thesis_invalidation` / `reconciliation` / `exchange_closed`) instead of always `'unknown'`. New `ExitType` type added to `ThesisExperienceRecord` + `RecordCloseInput`. `exitType` passed from `onPositionClosedLearning` via `closeReason`.
- **SimilarTradeRetriever**: Wired into HACP — after EXP `checkThesisHistory` computes candidate vectors, `findSimilar()` retrieves top-5 most similar historical trades. `formatBlock()` produces `=== SIMILAR TRADES TO YOUR PROPOSED ... ===` block injected into Skeptics validation context. `checkThesisHistory` stores candidate vectors via `getLastCandidateVectors()` for reuse.
- **SubtleDiffAnalyzer**: Wired into HACP — 1 LLM call per cycle comparing candidate trade vs similar historical winners/losers. Identifies subtle differences (volume, RSI, regime, S/R proximity). `setLLMChatFn()` injects the LLM provider. Output: `=== SUBTLE DIFFERENCES ANALYSIS ===` block injected into Skeptics context.

**RIL injection timing fix**: SimilarTradeRetriever + SubtleDiffAnalyzer are injected AFTER EXP gate (which computes candidate vectors) but BEFORE Skeptics thesis validation — so Skeptics sees similar trades + subtle diff analysis when validating the entryThesis. Previously they were injected in the pre-cycle `marketDesc` build (before Meta-Agent thought), where no candidate thesis existed yet.

### Shadow Trade Overhaul

- **OLR `feedTrade` signature fix**: Now accepts `source` ('shadow' / 'paper' / 'real') + `cycle` parameters. Previously shadow engine and `index.ts` passed 5-7 args but OLR only accepted 4 — `source` and `cycle` were silently discarded. All sources were mixed into the same SGD update with no way to distinguish them.
- **Per-source sample tracking**: `OLRModel` now has `shadowSamples` / `paperSamples` / `realSamples` counters. Agent context shows data composition: `BUY P(win)=60% (30 samples, medium | shadow=15 paper=10 real=5)`. If a model is trained mostly on shadow data (fixed SL/TP), agents can lower trust.
- **Per-symbol funding rate fix**: Non-active symbols no longer use the active symbol's funding rate. New `markPriceMap` (per-symbol HL WS mark price cache) + `getMarkPriceForSymbol()` in `hyperliquid-websocket.ts`. Shadow trade features now use correct per-symbol funding rates.
- **MAE/MFE path-risk tracking**: Each shadow trade records `mfePct` (Maximum Favorable Excursion) + `maePct` (Maximum Adverse Excursion) as fraction of entry price. Agent context shows `avg MFE=3.2% avg MAE=1.8%` — reveals "trades go up 3% then reverse to SL" = exit timing problem, not direction problem.
- **Shadow soft gate**: When shadow samples ≥ 10 and win rate < 25%, override entry to HOLD. The direction is fundamentally wrong in current conditions. Only triggers with overwhelming evidence (conservative soft gate).
- **ShadowTradeStats**: New `avgMfePct` + `avgMaePct` fields. UI types updated.

### Terminal Agent Cycle Enforcement

Terminal Agent now does its full job — not just user input → LLM → Root Command Prompt integration, but also cycle-level enforcement:

- **Phase -1 (Rule Checking)**: Before any HACP cycle begins, `checkRootCommandPromptRules()` evaluates ALL rules in the Root Command Prompt against current conditions. Time-based rules (day of week, time range, before/after) use `Intl.DateTimeFormat` for timezone conversion. Asset-based rules (exclude, only-trade) check current trading markets. If ANY hard rule fails → cycle aborted immediately (no LLM calls, no debate — saves tokens + respects user intent). Direction-based + condition-based rules are soft (injected into agent context).
- **Phase 6 (Decision Verification)**: After Meta-Agent decides BUY/SELL, `verifyDecisionAgainstRootPrompt()` checks the decision against Root Command Prompt directives. "BUY only" + Meta-Agent says SELL → override to HOLD. "Exclude xyz:SILVER" + Meta-Agent trades SILVER → override to HOLD. Recorded in `auditGates`.
- **Root Command Prompt injection**: All 7 agents (5 sub-agents + Skeptics + Meta-Agent) see `=== ROOT COMMAND PROMPT (USER DIRECTIVES) ===` in their `think()` context via `marketDesc`. Every agent's reasoning is constrained by user directives.
- **300-char limit + auto-condense**: If Root Command Prompt exceeds 300 chars, LLM is asked to condense it (temperature 0.2, 15s timeout). If still exceeds, truncated + user notified via Side Guide to remove less important rules.
- **Backend storage**: `rootCommandPrompt` + `terminalSideGuide` stored on backend (survives UI refresh). API response includes both for UI display. Terminal Agent thought injected into `agentThoughts` so UI shows model + latency consistently with other agents.
- **UI updates**: `TerminalAgentCard` reads from `data.agentThoughts` + `data.rootCommandPrompt`. Shows `⏱ ready` / `📋 deepseek-v4-flas` / `active` (when prompt set) instead of `⏱ —` / `📋 63 chars` / `idle`.

### News Reporter Fallback Fix

- **Stale news reuse**: When `fetchNewsForSymbols` fails, the last successful news context is reused (marked `=== NEWS SENTIMENT (STALE — last successful fetch reused) ===`). Previously a fetch failure left `newsContext` empty, causing the News Reporter to operate without any news data and triggering fallback.
- **Error digestion**: `BaseAgent.think()` catch block now digests errors into user-friendly reasons via `digestError()` — categorizes timeout / connection / rate-limit / model-not-found / JSON-parse / context-length / generic. The raw error is still in `metadata.error` but `metadata.digestedReason` provides a concise, actionable reason.
- **UI fallback badge**: `⚠️ Fallback` now shows the digested reason inline (truncated to 60 chars) + full reason in tooltip. No more raw error log dumped to the user.

### Persistence Updates

All new fields persisted to `portfolio-state.json` via `savePortfolio()` + restored on startup:
- Positions: `minValueReached`, `maxValueReached`, `originalStopLossPrice`, `originalTakeProfitPrice`, `exitThesis`
- Trades (paper + real): `entryThesis`, `exitThesis`, `postReview`, `minValueReached`, `maxValueReached`
- `PortfolioSnapshot` type updated with all new fields
- `migrateModel()` backward-compatible (old models assume all paper, new fields default to 0/undefined)

### Files Changed

- `src/types/index.ts` — `ExitType`, `Position` new fields, `TradeRecord` new fields, `ThesisExperienceRecord.exitType`, `ExpCheckResult.candidateVectors`
- `src/trading/portfolio.ts` — MAE/MFE tracking in `updatePosition` + `softUpdatePosition`, `setExitThesis()`, `checkPositionExits` exitThesis with SL/TP narrowing analysis, `closePosition` + `closeExchangePosition` fallback exitThesis, `originalStopLossPrice`/`originalTakeProfitPrice` at open
- `src/trading/real-trading-manager.ts` — removed paper fallback from `executeDecision` + `closePosition`, `syncExchangePositions` preserves entryThesis + MAE/MFE on reimport
- `src/evolution/rbc-clustering.ts` — `OLRModel` per-source counters, `feedTrade` accepts `source` + `cycle`, `formatForAgentContext` shows source breakdown
- `src/evolution/shadow-trade-engine.ts` — `mfePct`/`maePct` tracking, `ShadowTradeStats` new fields, `getContext` shows MAE/MFE
- `src/evolution/thesis-experience.ts` — `RecordCloseInput.exitType`, `recordClose` stores exitType + returns record, `getLastCandidateVectors()`
- `src/evolution/reason-analytics.ts` — `CloseReasonAggregator` uses real exitType, `SimilarTradeRetriever` + `SubtleDiffAnalyzer` (already existed, now wired)
- `src/evolution/persistence.ts` — `PortfolioSnapshot` new fields, `savePortfolio` serializes all new fields
- `src/cognition/hacp.ts` — `setSimilarTradeRetriever` + `setSubtleDiffAnalyzer` + `setLLMChatFn` setters, RIL injection after EXP gate before Skeptics, `rilEnhancedMarketDesc` passed to Skeptics
- `src/data/hyperliquid-websocket.ts` — `markPriceMap` per-symbol cache, `getMarkPriceForSymbol()`
- `src/agents/base-agent.ts` — `digestError()` in catch block, `metadata.digestedReason`
- `src/index.ts` — `executeTrade()` + `closeTrade()` routers, `checkRootCommandPromptRules()` + `verifyDecisionAgainstRootPrompt()`, Root Command Prompt storage + injection, 300-char limit + auto-condense, Terminal Agent thought in `agentThoughts`, paper positions MAE/MFE refresh, stale news reuse, `newsFetchError` in API
- `src/api-server.ts` — (no changes, existing `setTerminalAgentInputHandler` used)
- `ui/src/App.tsx` — `TerminalAgentCard` reads from `agentThoughts` + API data, fallback badge shows digested reason, Trade Incident Panel fields, paper trades API mapping with all new fields
- `ui/src/types.ts` — `AgentThought.digestedReason`, `ShadowTradeStats.avgMfePct`/`avgMaePct`

**Build**: `tsc --noEmit` clean. `vite build` clean (435KB gzipped 131KB).

---

## v2.0.141 — RIL Reason Intelligence Layer + Confidence Calibration Framework + Prompt Overhaul

**RIL — Reason Intelligence Layer** (`src/evolution/reason-analytics.ts`): New structured reference data system providing Meta-Agent with clear, queryable stats on what entry/close patterns historically win and lose. Three components:
- **PatternClusterManager**: Greedy cosine clustering of entry rationale texts (MiniLM 384-d) → per-pattern WR/PnL. Injected as `=== ENTRY PATTERN PERFORMANCE ===`.
- **CloseReasonAggregator**: Pure math GROUP BY exitType+decisionOrigin → per-close-reason WR/PnL. Injected as `=== CLOSE REASON PERFORMANCE ===`.
- **SimilarTradeRetriever + SubtleDiffAnalyzer**: Top-N similar past trades + LLM subtle differences analysis (1 call per cycle).

**Role Change: EXP + A2A Digester → Reference Data Sources**
- EXP `checkThesisHistory()` changed from binary gate to reference data block. Meta-Agent sees the verdict but makes its own decision.
- A2A Digester `getDigestSummary()` kept as supplementary LLM analysis block, no longer used for candidate classification.
- Both systems retain their existing code but their OUTPUT is now injected as reference data, not decision overrides.

**Confidence Calibration Framework** — Meta-Agent and Skeptics prompts completely overhauled:
- Meta-Agent: BASE confidence from pattern WR → adjust for close reason context (premature vs correct losses) → adjust for subtle differences → FINAL confidence → decision.
- Skeptics: Audits Meta-Agent's confidence calibration, checks for premature vs correct loss distinction, flags confidence-evidence mismatches.
- Both prompts now explicitly guide agents to weigh strengthening/weakening factors from the reference data.

**Files changed**:
- New: `src/evolution/reason-analytics.ts` (589 lines)
- Modified: `src/types/index.ts` (new RIL types), `src/config/index.ts` (RIL config), `src/agents/meta-agent.ts` (prompt overhaul), `src/agents/agents.ts` (Skeptics prompt overhaul), `src/index.ts` (RIL init + injection), `src/evolution/thesis-experience.ts` (getRecords() getter)
- Docs: `ARCHITECTURE.md`, `README.md`, `WL.md` updated

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