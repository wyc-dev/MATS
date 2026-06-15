# 🔗 A2A Protocol — Agent-to-Agent Communication

> **Minimal, Token-Efficient Inter-Agent Language**
> 
> Version 1.0 | Effective 2026-05-28

---

## Objective

Enable ultra-concise agent-to-agent communication using **keywords + adjectives + critical data** instead of full sentences. Reduces token overhead ~60-70% while maintaining semantic clarity.

---

## Core Principles

1. **Keyword-First**: Lead every statement with action/observation keyword
2. **Adjective Modifiers**: Use max 1-2 qualifiers per statement
3. **Data-Centric**: Only include numeric data that changes decisions
4. **Context Implicit**: No redundant framing; agents assume full market context
5. **Decision-Clear**: Every statement must have a clear `intent` or `concern`

---

## Supported Message Types

### 1. OBSERVATION (Data-Driven Signal)

**Format:**
```
OBS: [keyword] [adjective] [critical_data]
```

**Examples:**
- `OBS: HMM_TRANSITION bullish P(state1→state2)=0.78`
- `OBS: ARCH_VOL elevated σ_24h=2.8%, forecast=3.1%`
- `OBS: EARNING_VOL spike BTC earnings_beta=0.34`
- `OBS: ORDERBOOK imbalanced bid/ask=1.8:1`
- `OBS: VOLUME weak last_5m_vol=-15% vs avg`

---

### 2. ASSESSMENT (Regime/Risk/Momentum Determination)

**Format:**
```
ASSESS: [regime|risk|momentum] [state] [confidence]
```

**Examples:**
- `ASSESS: regime trending_bull conf=0.82`
- `ASSESS: regime chaotic conf=0.45 → HOLD`
- `ASSESS: risk elevated max_dd=18.2%, daily_loss=-4.1%`
- `ASSESS: risk critical veto_required=true`
- `ASSESS: momentum exhausted RSI=89, bearish_div=true`

---

### 3. PROPOSAL (Action Recommendation)

**Format:**
```
PROP: [action] [size_pct] [urgency] | [brief_rationale]
```

**Actions:** `BUY | SELL | HOLD`
**Size:** `0-100%` of allocated risk budget
**Urgency:** `immediate | soon | patient | none`

**Examples:**
- `PROP: BUY 5.0% immediate | momentum breakout + regime aligned`
- `PROP: SELL 3.0% soon | earnings volatility spike, reduce exposure`
- `PROP: HOLD 0% patient | regime uncertain, wait for clarity`
- `PROP: HOLD 0% immediate | drawdown=20%, trading halted`

---

### 4. CONCERN (Risk/Structural Alert)

**Format:**
```
CONCERN: [risk_type] [severity] [trigger_condition]
```

**Severity:** 🟢 `low | 🟡 medium | 🟠 high | 🔴 critical`

**Examples:**
- `CONCERN: correlation high 🟡 all_signals_bearish, no_hedge`
- `CONCERN: regime_mismatch 🟠 HMM_state != chart_pattern`
- `CONCERN: veto_threshold 🔴 position_9.8% + stop_loss_2.1%`
- `CONCERN: earnings_shock 🟠 IV_spike=+45%, vol_forecast=4.2%`

---

### 5. QUESTION (Request for Specific Analysis)

**Format:**
```
Q: [agent_target] [specific_question] [metric_to_focus]
```

**Examples:**
- `Q: @OnChainWhisperer volume_trend? orderbook_imbalance_ratio`
- `Q: @FractalSentinel earning_impact? momentum_decay_post_earning`
- `Q: @RegimeGuardian HMM_state? state_persistence_probability`

---

### 6. AGREEMENT / DISAGREEMENT (Debate Response)

**Format:**
```
AGR: [level] [reason_keyword] | brief_note
DIS: [level] [reason_keyword] | counter_argument
```

**Agreement Levels:** `FULL (100%) | PARTIAL (50-99%) | WEAK (<50%)`

**Examples:**
- `AGR: FULL momentum_evidence | same_fractal_pattern_detected_3TF`
- `DIS: PARTIAL regime_classification | HMM_confidence_only_0.45`
- `DIS: FULL veto_required | position_sizing_11%_exceeds_limit`

---

## Debate Round Structure (Optimized)

### Round 1: Argument

**Agent speaks:**
```
ASSESS: [regime|momentum|risk] [state] [confidence]
PROP: [action] [size] [urgency] | [reason_keyword]
```

**Total tokens: ~15-25** (vs ~100+ in full sentences)

---

### Round 2: Attack / Reinforce

**Attack weak point (if disagreeing):**
```
DIS: [level] [weak_point_keyword] | [evidence]
CONCERN: [type] [severity] [specific_issue]
```

**Reinforce own point (if supporting):**
```
AGR: PARTIAL [strongest_evidence_keyword]
OBS: [supporting_data] [metric]
```

**Total tokens: ~20-30**

---

### Round 3: Synthesis

**All agents summarize:**
```
CONSENSUS: [action] [confidence_weighted_avg]
RESIDUAL_CONCERN: [if any] [severity]
FINAL_PROP: [action] [size] [urgency]
```

**Total tokens: ~25-35**

---

## Example Full Debate (HMM + Earnings Vol Focus)

### Initial Thoughts:

**Regime Risk Guardian (HMM-powered):**
```
OBS: HMM_TRANSITION state_2→3 P=0.76, mean_reversion_signal
ASSESS: regime trending_bull conf=0.71
CONCERN: regime_uncertainty 🟡 transition_probability_not_dominant
PROP: BUY 3.0% soon | favorable_transition_with_caution
```

**Fractal Momentum Sentinel (Earnings Vol-aware):**
```
OBS: EARNING_VOL spike BTC_beta=0.28, implied_vol+22%
OBS: MOMENTUM breakout 4h_fractal above_resistance
DIS: PARTIAL regime_confidence | earnings_vol_adds_chaos
PROP: BUY 5.0% immediate | momentum_strong, but size_down_for_vol
```

**On-Chain Whisperer:**
```
OBS: ORDERBOOK strengthening bid_vol_surge +35%, whale_buying
AGR: FULL momentum_evidence
PROP: BUY 4.0% immediate | on_chain_confirms_narrative
```

**Consensus Engine:**
```
CONSENSUS: BUY confidence=0.76 (weighted)
FINAL_PROP: BUY 4.0% immediate
```

**Risk Auditor (Final Gate):**
```
ASSESS: risk acceptable position_4% < limit_10%
CONCERN: earnings_vol 🟡 stop_loss_placement_critical
PROP: BUY 4.0% immediate | veto_not_required
```

---

## Keyword Glossary

### Regime Keywords
- `trending_bull | trending_bear | ranging | mean_revert | breakout`
- `accumulation | distribution | chaotic | low_vol | high_vol`
- `HMM_state1 | HMM_state2 | HMM_state3` (Hidden Markov states)

### Observation Keywords
- `MOMENTUM | VOLATILITY | VOLUME | ORDERBOOK | FLOW`
- `HMM_TRANSITION | ARCH_VOL | EARNING_VOL`
- `FRACTAL | BREAKOUT | EXHAUSTION | DIVERGENCE`

### Risk Keywords
- `POSITION | LEVERAGE | CORRELATION | REGIME_MISMATCH`
- `EARNING_SHOCK | VOL_SPIKE | DRAWDOWN | DAILY_LOSS`

### Sentiment Keywords
- `bullish | bearish | neutral | uncertain | chaotic`
- `strong | weak | exhausted | stretched | oversold`

---

## Token Budget by Phase

| Phase | Format | Typical Tokens |
|:-----|:--------|:--------------|
| Observation | `OBS: ... data` | 10-15 |
| Assessment | `ASSESS: ... conf` | 12-18 |
| Proposal | `PROP: BUY 5% immediate` | 8-12 |
| Concern | `CONCERN: ... severity` | 10-15 |
| Debate Response | `AGR/DIS: ... reason` | 15-20 |

**Total debate round: ~50-80 tokens** (vs 200+ in natural language)

---

## Rules of Conduct

1. ✅ **DO:** Be specific with metrics (actual numbers, not vague)
2. ✅ **DO:** Use standard keywords — enables consistent parsing
3. ✅ **DO:** Lead with confidence/severity whenever possible
4. ✅ **DO:** Prioritize data over opinion
5. ❌ **DON'T:** Use full sentences unless absolutely unavoidable
6. ❌ **DON'T:** Repeat data already stated by other agents
7. ❌ **DON'T:** Qualify observations with unnecessary disclaimers
8. ❌ **DON'T:** Propose actions without clear urgency level

---

## System Integration

### HACP Engine Parsing

```typescript
// Pseudo-code: Parser recognizes A2A tokens
if (message.startsWith('OBS:')) parseObservation(message);
if (message.startsWith('ASSESS:')) parseAssessment(message);
if (message.startsWith('PROP:')) parseProposal(message);
if (message.startsWith('CONCERN:')) parseConcern(message);
if (message.startsWith('Q:')) routeQuestion(message);
if (message.startsWith('AGR:') || message.startsWith('DIS:')) parseDebateVote(message);
```

### Backward Compatibility

- A2A messages can be embedded in JSON `"content"` fields
- LLM outputs parsed for keyword signatures
- Fallback to full JSON parsing if A2A format fails

---

## Evolution & Versioning

- **v1.0** (2026-05-28): Initial spec with HMM + Earnings Vol support
- **v1.1** (planned): Add macro event keywords (`FOMC | JOBS | CPI`)
- **v2.0** (planned): Hierarchical consensus (meta-agent can override low-conf agents)

---

## 📚 Reference

**Associated Agents:**
- [Regime Risk Guardian (HMM-Enhanced)](../agents/agents.ts)
- [Fractal Momentum Sentinel (Earnings Vol-Aware)](../agents/agents.ts)
- [HACP Engine (Parser Integration)](../cognition/hacp.ts)
- [Base Agent (Debate Integration)](../agents/base-agent.ts)

---

*Last Updated: 2026-05-28*
*By: YC Wong / AMACRF Team*
