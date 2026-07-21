# Terminal Agent — Complete Specification

> The Terminal Agent is the user's natural language interface to MATS. It has TWO layers:
> **Layer 1 (Dialogue)**: accepts trading preferences, clarifies ambiguity via LLM, and maintains a Root Command Prompt.
> **Layer 2 (Enforcement)**: evaluates the Root Command Prompt as hard gates at cycle start, injects it into agent context, and verifies final decisions against it.

---

## 1. North Star

```
🌍 ROOT INTENT: Terminal Agent is the user's natural language interface to MATS.
   It accepts trading preferences, clarifies ambiguity via LLM dialogue, and
   maintains a "Root Command Prompt" — a consolidated instruction set that
   guides the trading system's behavior.
🎯 SUCCESS: User types a preference → LLM asks clarifying questions until fully
   specified → confirmed instruction is written to Root Command Prompt → prompt
   is persisted, evaluated at cycle start, and injected into all agent context.
🚫 FAILURE: Ambiguous instructions written to Root Command Prompt without
   clarification. LLM inventing rules the user didn't state. User input lost
   or corrupted during integration. Rules not enforced at cycle start.
⏳ TIME BOUNDARY: Each LLM call must complete within 30s. User dialogue should
   resolve in ≤3 rounds of clarification.
🔒 NON-NEGOTIABLES: Never write incomplete/ambiguous rules to Root Command
   Prompt. Never invent trading rules. Never expose private keys or wallet
   addresses in prompts. Always persist prompt to disk + localStorage.
```

---

## 2. Architecture — Two-Layer Design

### Layer 1: Dialogue (Root Command Prompt Creation)

```
User Input (textarea)
    ↓ Submit (Enter or ✓ button)
POST /api/terminal-agent/input { input, currentPrompt }
    ↓
Backend: getActiveProvider().chat() with DeepSeek V4 Flash
    ↓ System prompt: integrate or clarify (see §3)
    ↓
Response: { success, prompt } — updated Root Command Prompt (with Side Guide)
    ↓
Frontend: split by "---" separator
    ├── Root Command Prompt section → actionable trading rules
    └── Side Guide section → clarification questions (? prefix) or meta-observations
    ↓
Persist to localStorage (amacrf:terminalSinglePrompt) + backend disk
```

### Layer 2: Enforcement (Cycle Execution)

```
Cycle triggered (timer or manual)
    ↓
Step 1: Load Root Command Prompt from backend memory
    ↓
Step 2: If empty → skip all checks, proceed with normal HACP cycle
    ↓
Step 3: Parse each rule (line starting with "- ")
    ↓
Step 4: For each rule, determine rule type and evaluate (see §4):
    ├── Time-based rule → check current time in specified timezone
    ├── Asset-based rule → check if selected markets match allowed assets
    ├── Direction-based rule → check if allowed directions match
    ├── Risk-based rule → parse risk preference → override minConfidence
    ├── Condition-based rule → injected as soft rule into agent context
    └── Unknown rule → log warning, skip (don't block cycle on unknown rules)
    ↓
Step 5: If ANY hard rule fails → abort cycle, log reason, skip HACP entirely
    ↓
Step 6: If ALL rules pass → inject directive into cycle context, proceed with HACP
    ↓
Step 7: After Meta-Agent decision (Phase 6) → verify decision against rules
    ↓
Step 8: If decision violates a direction/asset rule → override to HOLD
```

---

## 3. LLM System Prompt Rules (Dialogue Layer)

The LLM system prompt is defined inline in `src/index.ts` `setTerminalAgentInputHandler`.

### Ground Truth Rule
Before responding to user input, the LLM MUST first check the current system state: trade mode, open positions, recent trades, and existing Root Command Prompt. NEVER guess — always base response on real data.

### Critical Rules
1. NEVER write ambiguous or incomplete instructions to Root Command Prompt.
2. If input lacks specificity → ask clarification questions in Side Guide. Leave Root Command Prompt empty.
3. If input is a response to previous clarification and now fully specifies → write to Root Command Prompt.
4. Integrate new complete instructions into existing prompt — merge, refine, deduplicate.
5. Newer instructions override contradictory older ones.
6. Preserve all valid prior instructions not contradicted.
7. Do NOT invent trading rules the user hasn't stated.
8. No JSON, no markdown fences, no commentary outside the two sections.

### Config Rejection
Root Command Prompt only accepts BEHAVIORAL directives. If user input involves config-level settings, REJECT and direct to Trading Setup:
- Position size, leverage, max portion, cycle period, trade mode, asset type

### Content Filter
- NEVER write UI state notes, system status descriptions, or meta-commentary to Root Command Prompt.
- ONLY write lines starting with "- " containing concrete, actionable trading rules.
- Non-trading input (questions, UI feedback) → respond in Side Guide only.

### Output Format
Two sections separated by a line containing only `---`:

1. **Root Command Prompt**: Concrete trading rules, each on its own line starting with `- `. Empty if pending clarification.
2. **Side Guide**: Below `---`. Either:
   - Clarification questions prefixed with `? ` (SHORT, DIRECT, one per line)
   - OR config rejection notices
   - OR confirmation if everything is clear
   - OR response to non-trading input

### Auto-Condense
If Root Command Prompt exceeds 300 chars, the system auto-condenses via a second LLM call. If still too long after condensing, truncates + notifies user in Side Guide.

---

## 4. Rule Types & Evaluation (Enforcement Layer)

### 4.1 Time-Based Rules
**Pattern**: "Only trade on [day/time/range] in [timezone]"

**Evaluation** (hard gate — aborts cycle on failure):
- Get current UTC time → convert to specified timezone via `Intl.DateTimeFormat`
- Check if current time falls within the allowed window
- No web search needed — pure local computation
- Supported: day-of-week, time range (HH:MM-HH:MM), before/after HH:MM
- Timezones: GMT, UTC, HKT, ET, EST, PST, JST, CST

**Example**: `- Only open new positions on Monday 00:00–23:59 GMT.`
→ Sunday 23:00 GMT → FAIL: "Outside allowed trading window"

### 4.2 Asset-Based Rules
**Pattern**: "Only trade [assets]" or "Exclude [assets]"

**Evaluation** (hard gate — aborts cycle on failure):
- Compare selected trading markets against allowed/excluded list
- Uses `normalizeSymbol()` for case-insensitive matching

**Example**: `- Only trade BTC and ETH.`
→ tradingMarkets = [btc, xyz:SILVER] → FAIL: "xyz:SILVER not in allowed assets"

### 4.3 Direction-Based Rules
**Pattern**: "Only [BUY/SELL]" or "No [BUY/SELL]" or "No short/long"

**Evaluation** (soft at cycle start, HARD at Phase 6):
- At cycle start: injected into agent context as directive (agents self-regulate)
- At Phase 6 (`verifyDecisionAgainstRootPrompt`): hard check — if decision violates direction rule, override to HOLD

### 4.4 Risk-Based Rules
**Pattern**: "be more aggressive" / "保守" / "balanced"

**Evaluation** (soft override):
- Parsed by `parseRiskPreference()` → maps to `minConfidenceForTrade`:
  - Aggressive: "激進" "aggressive" "高風險" "bold" → 0.20
  - Conservative: "保守" "conservative" "謹慎" "defensive" → 0.60
  - Balanced: "平衡" "balanced" "moderate" → 0.40
- Overrides evolution engine's default conviction threshold
- Config-level settings (position size %, leverage ×) are NOT accepted — rejected at dialogue layer

### 4.5 Condition-Based Rules
**Pattern**: "No trade during [event]" or "Only trade when [condition]"

**Evaluation** (soft rule — injected into agent context):
- Injected as directive text; agents read and self-regulate
- Not a hard gate (would require external API/web search per cycle)

### 4.6 Unknown Rules
- Log warning: `Unknown rule type: "{rule text}" — skipping evaluation`
- Do NOT block the cycle on unknown rules
- Surface in Side Guide for user clarification

---

## 5. Injection (After All Hard Rules Pass)

Root Command Prompt is the **highest authority** in the system. It does NOT modify any agent's system prompt — it is injected as an **additional dynamic directive**.

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
1. **Cycle start (Phase 1)** — appended to each agent's user message context. All 6 agents see the directive before forming their opinion.
2. **Meta-Agent decision (before final arbitration)** — appended to Meta-Agent's arbitration context. Final enforcement point.
3. **Skeptics review (Phase 1.5)** — Skeptics see the directive when reviewing agent decisions. Skeptics should NOT reject an agent for following a user rule.
4. **Market description (Phase 1 context)** — `=== ROOT COMMAND PROMPT (USER DIRECTIVES) ===` block appended to market state description.

### What Root Command Prompt CAN Adjust
- Decision style (aggressive, conservative, balanced)
- Trading bias (favor commodities, avoid shorting on bullish news)
- Behavioral rules (only trade on Monday, no new positions during FOMC)
- Execution preferences (tight SL, widen TP in trending markets)

### What Root Command Prompt CANNOT Do
- Replace or modify any agent's system prompt
- Change the HACP protocol flow (Phase 0-5 sequence)
- Remove the Skeptics gatekeeper
- Disable risk engine checks
- Alter the consensus/voting mechanism
- Modify config values (position size, leverage, max portion, cycle period, trade mode, asset type) — controlled by Trading Setup

---

## 6. Abort Behavior

When a hard rule blocks the cycle:
1. **Log**: `Terminal Agent: Cycle aborted — {rule} failed check: {reason}`
2. **Skip HACP entirely**: no Phase 1, no agents, no LLM calls, no debate
3. **Wait for next cycle**: timer continues, next cycle re-evaluates rules

When Phase 6 decision verification fails:
1. **Override**: decision changed to HOLD
2. **Log**: `Root Command Prompt directive violated: "{rule}" — {action} blocked`
3. **Continue cycle**: other symbols still execute normally

---

## 7. Persistence & Config Separation

### Persistence
- Frontend: `localStorage` key `amacrf:terminalSinglePrompt` — survives page reloads
- Backend: `this.rootCommandPrompt` in-memory + `data/evolution/root-command-prompt.json` on disk
- Backend restart: `loadRootCommandPrompt()` restores from disk
- Frontend reconnect: `POST /api/terminal-agent/sync-prompt` syncs localStorage → backend

### Config vs Root Command Prompt Separation
| Control | Managed by | Examples |
|---------|-----------|----------|
| **Trading Setup (Preference panel)** | UI controls with direct backend wiring | position size, leverage, max portion, cycle period, trade mode, asset type |
| **Root Command Prompt (Terminal Agent)** | LLM dialogue → behavioral directives | decision style, trading bias, time/condition rules, execution preferences |

If user types a config-level instruction in Trading Preference Input (e.g. "set leverage to 15x"), Terminal Agent LLM rejects it: "Leverage is a config setting — please adjust it in Trading Setup above."

### Hard Constraints (never overridden by user rules)
- SL/TP placement on every position (system safety, non-negotiable)
- Conviction gate threshold (system-level, but risk preference can adjust)
- Direction restrictions (`marketAgent.directionRestrictions` — set via Trading Setup)
- Config values (managed exclusively by Trading Setup)

---

## 8. File Map

```
ui/src/App.tsx
  └── TerminalAgentCard (~line 497) — UI component
      ├── User input textarea + Submit/Reset buttons
      ├── Root Command Prompt display (split by "---")
      ├── Side Guide display (clarification questions or meta)
      └── localStorage persistence (amacrf:terminalSinglePrompt)

src/api-server.ts
  └── POST /api/terminal-agent/input — LLM dialogue endpoint
  └── POST /api/terminal-agent/sync-prompt — frontend → backend sync
  └── setTerminalAgentInputHandler — callback registration
  └── setTerminalAgentSyncPromptHandler — callback registration

src/index.ts
  └── setTerminalAgentInputHandler (~line 1288) — LLM call with DeepSeek V4 Flash
      ├── System prompt: integrate or clarify (see §3)
      ├── model: getAgentModel('terminal_agent')
      ├── temperature: 0.3, timeoutMs: 30_000
      ├── Auto-condense if > 300 chars (second LLM call, temp 0.2)
      └── Persist to disk via persistRootCommandPrompt()
  └── checkRootCommandPromptRules (~line 3168) — hard gate evaluation at cycle start
      ├── Time-based: day-of-week, time range, before/after (timezone-aware)
      ├── Asset-based: include/exclude list matching
      ├── Direction-based: soft at cycle start (injected into context)
      └── Condition-based: soft (injected into context)
  └── verifyDecisionAgainstRootPrompt (~line 3324) — Phase 6 hard enforcement
      ├── Direction rules: BUY/SELL blocked → override to HOLD
      └── Asset exclusion: blocked → override to HOLD
  └── parseRiskPreference (~line 3390) — risk preference → minConfidenceForTrade
  └── loadRootCommandPrompt / persistRootCommandPrompt — disk persistence

src/agents/agent-models.ts
  └── terminal_agent: 'deepseek-v4-flash:cloud' (default model)

ui/src/types.ts
  └── AGENT_META['terminal_agent'] — name, color, description
  └── AGENT_ROLES — includes 'terminal_agent'

src/types/index.ts
  └── AgentRole type includes 'terminal_agent'
```

---

## 9. Conventions

- **Logging**: `log.info(...)` / `log.warn(...)` / `log.error(...)`. Never `console.log`.
- **Error handling**: Every LLM call has `try/catch` with user-facing error message.
- **Processing state**: `processing` boolean — disables textarea + shows "Processing..." while LLM is working.
- **Persistence**: `localStorage` key `amacrf:terminalSinglePrompt` + backend disk `data/evolution/root-command-prompt.json`.
- **Reset**: Requires confirmation ("Clear prompt?" → ✓ Yes / ✗ No) before clearing.
- **Copy**: 📋 Copy button copies only the Root Command Prompt section (not Side Guide).
- **Types are law**: strict TypeScript, no `any`, no `@ts-ignore`.
- **Test**: `npx tsc --noEmit` + `npx vitest run` must pass after every change.

---

## 10. When Adding New Features

1. **State the purpose** — what does this feature do for the user's trading workflow?
2. **Read before write** — check existing TerminalAgentCard, api-server endpoint, index.ts handler.
3. **Minimal change** — touch only what must change. No drive-by refactors.
4. **Error paths** — what if LLM fails? What if backend is down? What if localStorage is full?
5. **Persist** — any state that should survive page reload goes to localStorage + disk.
6. **Types are law** — strict TypeScript, no `any`, no `@ts-ignore`.
7. **Test** — `npx tsc --noEmit` + `npx vitest run` must pass after every change.