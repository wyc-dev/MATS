# TA_PROMPT — Terminal Agent Cycle Injection & Execution

> The Root Command Prompt is not just text — it contains executable rules. This document defines how each rule is interpreted, validated, and enforced at cycle start.

## Execution Principle

Every rule in the Root Command Prompt is a **hard gate**. Before any HACP cycle begins, the system must evaluate ALL rules against current real-world conditions. If ANY rule fails the check, the entire cycle is **aborted immediately** — no agent thinking, no LLM calls, no debate. This saves token cost and respects user intent.

## Rule Evaluation Flow

```
Cycle triggered (timer or manual)
    ↓
Step 1: Load Root Command Prompt from backend memory
    ↓
Step 2: If empty → skip all checks, proceed with normal HACP cycle
    ↓
Step 3: Parse each rule (line starting with "- ")
    ↓
Step 4: For each rule, determine rule type and evaluate:
    ├── Time-based rule → check current time in specified timezone
    ├── Asset-based rule → check if selected markets match allowed assets
    ├── Direction-based rule → check if allowed directions match
    ├── Risk-based rule → check position size / leverage limits
    ├── Condition-based rule → web search / data check (e.g. "no trade during FOMC")
    └── Unknown rule → log warning, skip (don't block cycle on unknown rules)
    ↓
Step 5: If ANY rule blocks → abort cycle, log reason, notify user (Telegram if configured)
    ↓
Step 6: If ALL rules pass → inject directive into cycle context, proceed with HACP
```

## Rule Types & Evaluation Methods

### 1. Time-Based Rules
**Pattern**: "Only trade on [day/time/range] in [timezone]"

**Evaluation**:
- Get current UTC time → convert to specified timezone
- Check if current time falls within the allowed window
- Uses `Intl.DateTimeFormat` with `timeZone` option for conversion
- No web search needed — pure local computation

**Example**:
- Rule: `- Only open new positions on Monday 00:00–23:59 GMT.`
- Check: `new Date()` → format in GMT → is it Monday? is it within 00:00–23:59?
- Fail (abort cycle): Sunday 23:00 GMT → "Outside allowed trading window: Monday 00:00–23:59 GMT. Current: Sunday 23:00 GMT."

### 2. Asset-Based Rules
**Pattern**: "Only trade [assets]" or "Exclude [assets]"

**Evaluation**:
- Compare selected trading markets against allowed/excluded list
- Uses `normalizeSymbol()` for case-insensitive matching

**Example**:
- Rule: `- Only trade BTC and ETH.`
- Check: tradingMarkets = [btc, xyz:SILVER] → xyz:SILVER not in [BTC, ETH]
- Fail: "xyz:SILVER is not in allowed assets: BTC, ETH."

### 3. Direction-Based Rules
**Pattern**: "Only [BUY/SELL] on [asset]"

**Evaluation**:
- Check if proposed trade direction matches allowed direction
- Integrates with existing `directionRestrictions` mechanism

### 4. Risk-Based Rules
**Pattern**: "Max position size [X]%" or "Max leverage [X]x"

**Evaluation**:
- These are **config-level settings** managed by Trading Setup (Preference panel), NOT by Root Command Prompt.
- If user types a risk parameter in Trading Preference Input (e.g. "set leverage to 15x", "position size 20%"), the Terminal Agent must **intercept and reject** — tell the user to adjust it in Trading Setup instead.
- Root Command Prompt only contains **behavioral/style directives** (e.g. "be more aggressive", "prefer tight SL"), not raw config values.
- This separation prevents conflict between config UI controls and prompt-based instructions.

### 5. Condition-Based Rules (requires external data)
**Pattern**: "No trade during [event]" or "Only trade when [condition]"

**Evaluation**:
- Web search or API check to verify condition
- Examples: "No trade during FOMC", "Only trade when VIX < 20"
- If check fails or is inconclusive → default to BLOCK (safety-first)
- Log the check result for audit

### 6. Unknown Rules
- Log warning: `Unknown rule type: "{rule text}" — skipping evaluation`
- Do NOT block the cycle on unknown rules (avoid false positives)
- Surface in Side Guide for user clarification

## Injection (after all rules pass)

Root Command Prompt is the **highest authority** in the system. It does NOT modify any agent's original system prompt — instead, it is injected as an **additional dynamic directive** that each agent receives alongside its existing prompt. This allows the user to adjust agent decision style, risk appetite, trading bias, and behavioral preferences without altering the core agent architecture.

### Dynamic Per-Agent Injection

Each agent in Phase 1 (Parallel Thinking) receives the Root Command Prompt as an appended directive in their user message context. The agent's original system prompt (personality, role, output format) remains untouched. The Root Command Prompt acts as a **style modifier** and **behavioral constraint** layered on top.

**What Root Command Prompt can adjust:**
- Decision style (e.g. "be more aggressive on BUY signals", "prefer HOLD in uncertain conditions")
- Trading bias (e.g. "favor commodities over crypto", "avoid shorting on bullish news")
- Behavioral rules (e.g. "only trade on Monday GMT", "no new positions during FOMC")
- Execution preferences (e.g. "always use tight SL", "widen TP in trending markets")

**What Root Command Prompt CANNOT do:**
- Replace or modify any agent's system prompt
- Change the HACP protocol flow (Phase 0-5 sequence)
- Remove the Skeptics gatekeeper
- Disable risk engine checks
- Alter the consensus/voting mechanism
- **Modify config values** (position size, leverage, max portion, cycle period, trade mode, asset type) — these are controlled by Trading Setup in the Preference panel. If user attempts to set these via Trading Preference Input, Terminal Agent must reject and direct user to Trading Setup.

### Injection Template

```
=== TERMINAL AGENT DIRECTIVE ===
User-defined trading rules (Root Command Prompt):
{ONE_SINGLE_PROMPT}

These rules are the HIGHEST AUTHORITY — they override agent opinions and config defaults.
They do NOT modify your system prompt or role. Apply them as behavioral constraints and style modifiers on top of your existing analysis.
- If a rule restricts trading (e.g. "only trade on Monday"), factor it into your decision.
- If a rule adjusts style (e.g. "be more aggressive"), shift your confidence threshold accordingly.
- If a rule conflicts with your analysis, the user rule wins.
- Do NOT debate or question these rules. Apply them.
=== END TERMINAL AGENT DIRECTIVE ===
```

### Injection Points

1. **Cycle start (Phase 1)** — appended to each agent's user message context. All 6 agents see the directive before forming their opinion. This shapes their analysis style and decision bias from the start.

2. **Meta-Agent decision (before final arbitration)** — appended to Meta-Agent's arbitration context. Meta-Agent must check user rules before producing the final consensus. This is the final enforcement point.

3. **Skeptics review (Phase 1.5)** — Skeptics see the directive when reviewing agent decisions. Skeptics should NOT reject an agent for following a user rule (e.g. if user says "be aggressive" and an agent outputs BUY with lower confidence, Skeptics should approve, not reject for "overconfidence").

## Abort Behavior

When a rule blocks the cycle:
1. **Log**: `Terminal Agent: Cycle aborted — {rule} failed check: {reason}`
2. **Skip HACP entirely**: no Phase 1, no agents, no LLM calls, no debate
3. **Notify user** (if Telegram configured): send message with abort reason
4. **Update UI**: show abort reason in cycle progress / status
5. **Wait for next cycle**: timer continues, next cycle will re-evaluate rules

## Persistence & Backend Access

- Frontend stores Root Command Prompt in `localStorage` (`amacrf:terminalSinglePrompt`)
- Frontend POSTs prompt to backend on every update (via existing `/api/terminal-agent/input` response)
- Backend stores in memory (`this.terminalSinglePrompt: string`)
- Backend evaluates rules at cycle start before any HACP phase

## Rule Parsing (LLM-assisted, one-time per update)

When Root Command Prompt is updated (user submits new input), the backend LLM call already produces the structured prompt. The rules are plain text lines starting with `- `. No additional LLM call needed for parsing — simple string split + pattern matching.

## Hard Constraints (never overridden by user rules)

- SL/TP placement on every position (system safety, non-negotiable)
- Conviction gate threshold (system-level)
- Direction restrictions (`marketAgent.directionRestrictions` — set via Trading Setup)
- Config values (position size, leverage, max portion, cycle period, trade mode, asset type) — managed exclusively by Trading Setup in the Preference panel

**Config vs Root Command Prompt separation**:
- **Trading Setup (Preference panel)** = hard config: position size, leverage, max portion, cycle period, trade mode, asset type. These are UI controls with direct backend wiring.
- **Root Command Prompt (Terminal Agent)** = behavioral directives: decision style, trading bias, time/condition rules, execution preferences. These influence how agents think and decide, not what the system config is.
- If user types a config-level instruction in Trading Preference Input (e.g. "set leverage to 15x"), Terminal Agent LLM must reject it and respond: "Leverage is a config setting — please adjust it in Trading Setup above. Root Command Prompt only accepts behavioral trading preferences."
- This prevents dual-source conflicts where both Trading Setup and Root Command Prompt try to control the same parameter.