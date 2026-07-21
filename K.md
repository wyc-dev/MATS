# K.md — Attention Residuals (AttnRes) Transfer to MATS

> Synthesized from Kimi K3 / arXiv 2603.15031 (Moonshot AI, 2026).
> MATS analog: K3 layer-depth ≡ MATS cycle-history depth.
> Version: v2.0.211 (K-series). Status: design + implementation.

---

## 0. AttnRes Mechanism (Confirmed from Paper)

**Core**: each layer `l` has a learned pseudo-query `w_l ∈ R^d` (zero-init →
start = uniform average = standard residual). Input to layer `l` is a
softmax-weighted mixture over ALL preceding layer outputs + the embedding:

```
α_{i→l} = softmax_i[ exp(w_l · RMSNorm(v_i)) ]
h_l     = Σ α_{i→l} · v_i
```

- `v_0 = h_1` (entry embedding — retains persistent weight throughout)
- `v_i = f_i(h_i)` (layer i output)
- **RMSNorm on keys is critical** (prevents large-magnitude layers dominating)
- **softmax > sigmoid** (competitive normalization forces sharper selection)
- **pseudo-query is input-decoupled** (learned param, not MLP(h)) — enables batched compute
- **single-head > multi-head** (depth mixture is monolithic)
- **Block AttnRes**: partition L layers → N≈8 blocks; intra-block standard
  residual sum, inter-block attention over block summaries. Memory O(Ld)→O(Nd).

**Learned patterns (Fig 8)**: locality dominant (diagonal), off-diagonal skip
connections emerge, **embedding persists** (source 0 retains weight), pre-attention
layers broader receptive field than pre-MLP.

**Training dynamics**: solves PreNorm dilution — bounded output magnitudes,
uniform gradient distribution. Shifts optimal architecture toward deeper/narrower.

---

## 1. MATS "Depth" = Cycle History Depth

K3 layers process a token through depth. MATS processes a symbol through
**cycles** (5-min cadence). The analog:

| K3 | MATS |
|---|---|
| layer l | cycle N |
| layer output v_i | cycle i market-feature snapshot |
| embedding v_0 (h_1) | **entry-time market features** (persistent) |
| pseudo-query w_l | learned per-symbol retrieval query |
| next layer input h_l | blended representation fed to conditional WR |

**Current MATS gap**: `computeVectorConditionalWinRate` uses the **current
snapshot** as the candidate. Entry-time regime is lost. Cycle history is not
retained (only `lastCycleShadowContexts` — a single current snapshot per symbol).

**AttnRes transfer**: the candidate for conditional WR becomes a
**softmax-weighted blend over cycle history + entry-time state**, with a
learned pseudo-query deciding which historical periods are most relevant
for the current decision. Entry-time state retains persistent weight
(embedding persistence — directly addresses the lost-entry-regime gap).

---

## 2. Online Pseudo-Query Learning Mechanism

K3 learns `w_l` via backprop pretraining. MATS has no backprop loop — learning
is **outcome-driven** (trade result → update). Design: **policy-gradient
attention update** (contextual-bandit formulation).

### 2.1 Retrieval (every conditional WR computation)

For symbol `s` with history `H_s = [(v_0, t_0), ...]` (v_0 = entry-time,
v_1.. = past cycle features, v_{N-1} = current):

```
keys   = [RMSNorm(v_i) for i in 0..N-1]      // per-key RMSNorm
logits = [dot(w, keys[i]) for i in 0..N-1]
α      = softmax(logits)                       // temperature = 1 (K3-consistent)
h_blend= Σ α_i · v_i                           // in original feature space
```

`h_blend` replaces the current snapshot as the conditional-WR candidate.

### 2.2 Learning (after trade close)

At entry time, record: `α_entry` (attention distribution), `v_i_entry`
(history snapshots used), `h_blend_entry`.

At close, outcome reward: `r = sign(pnl) · min(1, |pnlPct| / 0.05)` ∈ [-1, +1].

**Score-function gradient** (softmax policy gradient):
```
∇_w log α_i = α_i · (key_i − Σ_j α_j · key_j)   = α_i · (key_i − mean_key)
w ← w + lr · r · Σ_i α_i · (key_i − mean_key)
```

Intuition: win → reinforce the attention direction that produced h_blend;
loss → push away. This is the standard REINFORCE estimator for a softmax
policy, with trade outcome as reward.

### 2.3 Stability guards

- **Zero-init w=0** → softmax uniform → h_blend = mean of history ≈ current
  behavior (cold-start safe; identical to current snapshot when history is
  short and recent cycles dominate).
- **EMA smoothing**: `w ← (1-β)w + β·w_new`, β=0.1 (slow, stable).
- **Weight clip**: `|w_j| ≤ 5` (matches NA weight clip).
- **NaN guard**: non-finite w → reset to last good (matches NA V1).
- **Entropy floor**: if `H(α) < 0.5` (collapsed distribution), inject
  temperature warmup `logits *= 1.3` next cycle to prevent attention collapse
  onto a single source (K3 ablation: softmax competition good, collapse bad).
- **History floor**: < 3 cycles → return current snapshot unchanged (no blend).
- **LR decay**: `lr = baseLR / (1 + 0.01·updateCount)` (prevents late-stage
  oscillation, mirrors NA LR decay).

### 2.4 Why this is correct

- The blended `h_blend` is a **context representation**, not a layer input.
  Its purpose: give conditional WR a richer candidate than a single snapshot
  — one that selectively retrieves relevant historical periods + retains
  entry-time regime (embedding persistence).
- Policy gradient is the right tool: we cannot differentiate through the LLM
  decision pipeline, but we CAN observe outcome and update the attention
  query to favour blendings that preceded wins.
- Zero-init guarantees no behavior change at deploy time — the system must
  *earn* selectivity through observed outcomes.

---

## 3. The 7 Transfers

### 🥇 #1 Cycle-History Selective Retrieval (CORE)
- New module `src/evolution/cycle-history-retrieval.ts`
- `CycleHistoryRetriever`: per-symbol rolling history (N=80 cycles ~7h) +
  entry-time features (persistent) + learned pseudo-query w.
- `retrieveBlend(symbol) → { h_blend, alphaDist, sources }`
- `recordEntry(symbol, side, h_blend, alphaDist, vs)` — snapshot at entry
- `updateOnOutcome(symbol, side, pnlPct)` — policy-gradient w update
- Wiring: conditional WR gate + hacp Phase 1.8b use h_blend as candidate.

### 🥈 #2 Block AttnRes for Cycle History Memory
- Partition 80-cycle history → 8 blocks of 10 cycles.
- Intra-block: mean of cycle features (block summary).
- Inter-block: softmax attention over 8 block summaries + entry state.
- Memory: O(80·d) → O(8·d) per symbol.
- `h_blend = Σ α_block · blockSummary + α_entry · entryFeatures`

### 🥉 #3 RMSNorm on Retrieval Keys
- `computeVectorConditionalWinRate`: when scoring records, RMSNorm each
  record's feature vector before cosine — competition on direction not
  magnitude (high-volatility periods no longer dominate similarity).
- Cycle-history retrieval keys already RMSNorm'd (#1).
- Backward compatible: min-max path retained as fallback when RMSNorm
  produces zero vectors (degenerate).

### #4 Softmax Mixture over History Records
- Current: matched records contribute equally to win rate (argmax top-N).
- New: win rate = `Σ softmax(sim_i / τ) · [outcome_i == win]`, temperature τ
  controls sharpness. High-similarity records weight more.
- Competitive normalization (K3 ablation: softmax > sigmoid).

### #5 Zero-Init Pseudo-Query (Cold-Start Guarantee)
- w=0 → uniform softmax → h_blend = mean(history) ≈ current snapshot when
  recent cycles dominate. No behavior change until outcomes teach selectivity.
- This is a property of #1, not a separate module — listed for design completeness.

### #6 Single-Head Depth Mixture (Design Constraint)
- Do NOT split cycle-history retrieval into momentum-head + regime-head.
- Single pseudo-query retrieves the entire historical cycle representation.
- K3 ablation: multi-head depth aggregation hurt performance — "when a
  layer's output is relevant, it is relevant as a whole."

### #7 Pre-Decision vs Pre-Execution Specialization
- Two pseudo-queries per symbol:
  - `w_decision` — broad receptive field, used for conditional WR +
    Meta-Agent thesis context (analogous to K3 pre-attention layers).
  - `w_execution` — sharp/recent-biased, used for SL/TP momentum context
    (analogous to K3 pre-MLP layers).
- Both learned via the same policy-gradient mechanism but with different
  reward shaping: w_decision rewards on trade outcome; w_execution rewards
  on whether SL/TP placement avoided stop-out.
- Phase 2 refinement — initial implementation uses a single w with a
  recency bias term for execution contexts.

---

## 4. Architecture

```
src/evolution/cycle-history-retrieval.ts   (NEW, ~500 lines)
  CycleHistoryRetriever
    - per-symbol: CycleHistoryStore { entryFeatures, blocks[8], w, wEMA, ... }
    - retrieveBlend(symbol) → BlendedRepresentation
    - recordEntry(symbol, side, blend, alphaDist, sources)
    - updateOnOutcome(symbol, side, pnlPct)
    - persist() / load()  (data/evolution/cycle-history.json)
  RMSNorm helper (shared)
  softmaxMixture helper (shared)

src/evolution/evolution-utils.ts           (MODIFY)
  - computeVectorConditionalWinRate: add rmsNormKeys option (#3)
  - add softmaxMixtureWinRate helper (#4) — optional weighted WR
  - both opt-in, default behavior unchanged (cold-start safe)

src/index.ts                                (MODIFY)
  - instantiate CycleHistoryRetriever
  - every cycle: push current features into history (after lastCycleShadowContexts)
  - executeTrade: recordEntry (snapshot blend + alpha + sources)
  - recordClose: updateOnOutcome (policy gradient)
  - checkConditionalWRGate: use retrieveBlend instead of current snapshot
  - wire retriever into hacp (setCycleHistoryRetriever)

src/cognition/hacp.ts                       (MODIFY)
  - setCycleHistoryRetriever
  - Phase 1.8b + Meta-Agent context: use h_blend as candidate features
  - inject ATTNRES BLEND block (alpha distribution explanation)

tests/cycle-history-retrieval.test.ts       (NEW)
  - cold-start, retrieval, online learning, block memory, attacks
```

---

## 5. Cold-Start Safety Matrix

| Condition | Behavior | Matches current? |
|---|---|---|
| history < 3 cycles | return current snapshot | ✅ identical |
| w = 0 (initial) | h_blend = mean(history) | ≈ current (recent dominates) |
| NA not ready | min-max path unchanged | ✅ identical |
| features missing | skipped dims (existing behavior) | ✅ identical |
| retriever not wired | current snapshot used | ✅ identical |

**Invariant**: at deploy time with w=0 and short history, conditional WR
results are within epsilon of current behavior. Selectivity is *earned*.

---

## 6. Attack Surface (pre-implementation)

| Attack | Vector | Defence |
|---|---|---|
| NaN features | volatility=Infinity | RMSNorm guard, skip non-finite |
| Zero vector keys | all features 0 | RMSNorm → uniform unit vector |
| History overflow | 10^6 cycles | rolling window, block compaction |
| w explosion | adversarial outcomes | clip ±5, EMA, LR decay |
| Attention collapse | α → one-hot | entropy floor, temperature warmup |
| Dimension mismatch | features change | inputDim guard (reset w) |
| Concurrent update | parallel closes | synchronous update, no async on w |
| Persist corruption | bad JSON | try/catch reset to fresh |
| Entry-close mismatch | close without entry | guard: skip update if no entry record |
| PnL=0 noise | flat outcome | reward threshold: |pnlPct| < 0.001 → skip |

---

## 7. Implementation Order

1. `cycle-history-retrieval.ts` (core module + tests)
2. `evolution-utils.ts` (#3 RMSNorm keys + #4 softmax mixture)
3. `index.ts` wiring (history push, entry record, outcome update, gate)
4. `hacp.ts` injection (blend candidate + AttnRes context block)
5. Attack harness → fixes
6. K.md update with attack results

---

## 8. Relation to Existing MATS Evolution Stack

| Module | Role | AttnRes interaction |
|---|---|---|
| OLR (olr-engine) | P(win) logistic regression | unaffected — uses its own features |
| NA (numeric-autoencoder) | learned market-condition embedding | **complementary**: NA embeds single snapshots; AttnRes blends across time. h_blend can be NA-embedded for conditional WR. |
| EXP (thesis-experience) | rationale-text similarity | orthogonal — text channel |
| Anti-pattern-tracker | failure-lesson clustering | orthogonal — lesson channel |
| Conditional WR (evolution-utils) | P(win | similar market) | **primary integration point**: candidate changes from snapshot → h_blend |
| Conditional WR gate (index.ts) | soft conviction penalty | uses h_blend as candidate |

**Key insight**: AttnRes does NOT replace NA. NA learns "what makes a snapshot
similar (outcome-aware)". AttnRes learns "which historical periods to attend
to right now". h_blend (AttnRes output) is fed INTO the NA embedding path —
NA embeds the blended representation. The two are composable:
`conditional_WR(h_blend → NA.embed → cosine vs history)`.

---

## 9. Version History

- v2.0.212 (#7): Pre-Decision vs Pre-Execution Specialization implemented.
  - Two pseudo-queries per symbol: wDecision (broad, PnL reward) + wExecution
    (sharp/recent-biased, SL/TP stop-out reward).
  - retrieveBlend(mode) selects w + recency prior by mode.
  - wExecution reward: SL hit (loss+sl_tp) → negative; TP hit (win+sl_tp) →
    positive; manual/thesis/consensus → skip.
  - Execution-lens context block injected into hacp Skeptics context.
  - 10 new #7 tests (40 total in cycle-history-retrieval.test.ts).
  - Attack results: see §10

---

## 10. Attack Testing Results + Fixes (v2.0.211)

Attack harness: `tests/attack-cycle-history.test.ts` (21 tests across 5 vectors).
All 169 tests pass (148 existing + 21 attack).

### 10.1 Vulnerabilities found + fixed during implementation

These were discovered DURING development (before the attack harness) and fixed
in the core module — the harness then verified the fixes hold.

| # | Vulnerability | Root cause | Fix |
|---|---|---|---|
| V1 | **REINFORCE deadlock** — w=0 → uniform α → policy gradient Σα(key−mean)=0 identically → w never updates | Score-function gradient of softmax is zero at uniform policy (mathematical identity, not a bug). K3 uses backprop so doesn't hit this; MATS uses outcome-based gradient. | **Fixed**: added fixed recency prior to logits (`logits = w·key + recencyPrior·(−age)`). w=0 still produces a recency-biased (non-uniform) policy → gradient non-zero. Mirrors K3's locality observation (diagonal dominance). |
| V2 | **Feature-scale collapse** — RMSNorm dominated by large-magnitude feature (srDistanceBps 50-900 vs volatility 0.1-0.8) → all keys same direction → grad≈0 | Raw MATS features span vastly different magnitudes; K3 layer outputs are already comparable scale (hidden space). | **Fixed**: per-feature Welford z-score BEFORE RMSNorm (`keys = rmsNorm(zScore(values))`). Puts all features on comparable scale; RMSNorm then extracts true direction. |
| V3 | **Block-mean smoothing** — block summary (mean of cycle features) smooths intra-block regime variation → different blocks collapse to same direction | Block AttnRes (#2) uses mean; if block spans a regime change, the mean is an unphysical "average regime". | **Design constraint documented (§11)**: block size must match regime-persistence timescale. Default historySize=80, numBlocks=8 → blockSize=10 cycles ≈ 50min. Acceptable for MATS regime persistence (~hours). Tunable via config. |
| V4 | **Null/non-object features injection** — `Object.entries(null)` throws, relying on try/catch swallow | pushCycle/recordEntry accepted any input. | **Fixed**: explicit `if (!features || typeof features !== 'object') return` guard at entry of both methods. |

### 10.2 Attack harness results (Q7.1–Q7.5)

| Vector | Tests | Result |
|---|---|---|
| Q7.1 Numerical (NaN/Infinity/overflow) | 6 | ✅ all pass — NaN sanitised, Infinity bounded, overflow softmax sums to 1 |
| Q7.2 State (empty/huge/dimension-mismatch) | 5 | ✅ all pass — empty→snapshot, huge→capped, dim-mismatch→graceful |
| Q7.3 Cold-start (no-entry/immediate-close/first-trade) | 3 | ✅ all pass — guards fire, retriever stable |
| Q7.4 Concurrency (synchronous update) | 1 | ✅ pass — pendingEntry consumed atomically, second update no-op |
| Q7.5 Injection (malformed/null/adversarial) | 6 | ✅ all pass — string→0, null→guard, adversarial→bounded, NaN-sim→fallback |

### 10.3 Remaining attack surface (accepted risks)

- **Persistence corruption**: `load()` try/catch resets to fresh on bad JSON (no last-good restore for cycle-history yet — NA has last-good; adding for CHR is a Phase 2 hardening).
- **W adversarial drift**: 50 alternating win/loss updates keep w bounded ±5 (verified Q7.5). EMA β=0.1 + LR decay provide damping. Accepted: no formal convergence proof.
- **Recency prior rigidity**: recencyPrior=0.5 is fixed. If regime persistence is very long (>80 cycles), the prior may over-weight recent blocks. Tunable via config; auto-tuning is Phase 2.

---

## 11. Design Insights from Implementation (K.md addendum)

Three insights emerged during implementation that refine the original design:

### 11.1 REINFORCE deadlock → fixed recency prior
The original design (§2.2) proposed standard REINFORCE policy gradient. Implementation
revealed this is **identically zero** at uniform policy (w=0). The fix — a fixed
recency prior in the logits — both breaks the deadlock AND mirrors K3's empirical
locality observation (Fig 8: layers attend most to immediate predecessor). The
recency prior is the MATS analog of K3's learned diagonal dominance, but
pre-seeded so cold-start isn't stuck.

### 11.2 Feature-scale → z-score before RMSNorm
K3's RMSNorm-on-keys works because layer outputs are in a comparable hidden scale.
MATS's raw features are NOT (bps vs ratios). The implementation requires
**per-feature Welford z-score before RMSNorm**. This is a MATS-specific addition
not in the original K3 paper — a transfer adaptation, not a direct copy.

### 11.3 Block-mean smoothing → block size = regime persistence timescale
Block AttnRes (#2) uses mean of cycle features per block. If a block spans a
regime change, the mean is an unphysical "average regime" that collapses
directions. **Block size must match the regime-persistence timescale** so each
block holds ~one regime. Default: blockSize=10 cycles ≈ 50min. For MATS where
regimes persist ~hours, this is safe. If MATS regime frequency increases,
reduce numBlocks or historySize to keep blockSize ≈ regime period.

### 11.4 Reward-weighted key direction (not REINFORCE)
The online update is `w += lr · reward · mean_key` (reward-weighted regression,
Peters & Schaal 2008), NOT `w += lr · reward · Σα(key−mean)` (REINFORCE). The
latter is identically zero for deterministic attention. The former directly
associates the attention-weighted key direction with the outcome: win → w shifts
toward the blend direction that won; loss → away. This is the correct
outcome-driven learning rule for a deterministic softmax blend.