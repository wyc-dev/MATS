# K.md — Attention Residuals (AttnRes) Transfer to MATS

> Synthesized from Kimi K3 / arXiv 2603.15031 (Moonshot AI, 2026).
> MATS analog: K3 layer-depth ≡ MATS cycle-history depth.
> Version: v2.0.212 (K-series). Status: design + implementation + attack-tested.
> All 7 transfers implemented. 179/179 tests pass.

## 0. AttnRes Mechanism (from arXiv 2603.15031 — Full Paper)

### 0.1 Core Equation

Standard residuals: `h_l = h_{l-1} + f_{l-1}(h_{l-1})` — fixed unit weights,
uncontrolled hidden-state growth O(L), progressive dilution of each layer's
contribution.

AttnRes replaces fixed accumulation with **softmax attention over depth**:

```
α_{i→l} = softmax_i[ exp(w_l · RMSNorm(k_i)) ]     (Eq. 2)
h_l     = Σ_{i=0}^{l-1} α_{i→l} · v_i               (Eq. 4)
```

where:
- `v_0 = h_1` (token embedding — **persistent source**)
- `v_i = f_i(h_i)` for i ≥ 1 (layer i output)
- `k_i = v_i` (keys = values = layer outputs)
- `q_l = w_l` (pseudo-query: **learned parameter**, NOT projected from h)
- `w_l` **zero-initialized** → initial α uniform → starts as equal-weight
  average = standard residual (prevents training volatility, verified empirically)
- **RMSNorm inside exp** prevents layers with large-magnitude outputs from
  dominating attention weights

### 0.2 Block AttnRes (§3.2)

Partition L layers → N blocks of S = L/N layers:
- **Intra-block**: standard residual sum `b_n = Σ_{j∈B_n} f_j(h_j)` (Eq. 5)
- **Inter-block**: softmax attention over N block summaries `b_0, ..., b_{N-1}`
  + token embedding `b_0 = h_1` (Eq. 6)
- Memory: O(Ld) → O(Nd), computation: O(L²) → O(N²)
- N = L recovers Full AttnRes; N = 1 reduces to standard residual
- **N ≈ 8 recovers most of the gain** across model scales (Fig. 6)
- Block boundaries define dispatch granularity for two-phase inference

### 0.3 Sequence-Depth Duality (§6.1 — Theoretical Motivation)

Residual connections over depth ≡ RNN recurrence over time. Both compress all
prior information into a single state:
- RNN: `h_t = f(h_{t-1}, x_t)` — compresses over **time**
- Residual: `h_l = h_{l-1} + f_{l-1}(h_{l-1})` — compresses over **depth**

Transformer replaced temporal recurrence with sequence self-attention.
AttnRes replaces depth-wise recurrence with **depth-wise softmax attention** —
the same linear→softmax transition that proved transformative over sequences.

**Structured matrix view (§6.2)**: the depth mixing matrix M (where M_{i→l} is
the weight layer l assigns to layer i's output) reveals:
- Standard residual: all-ones lower-triangular (rank 1, depth-wise linear attention)
- Highway: 1-semiseparable with input-dependent gates
- mHC: m-semiseparable with matrix-valued state (depth-wise linear attention)
- **Full AttnRes: dense, rank-L (depth-wise softmax attention)**
- Block AttnRes: rank between N and N+S

### 0.4 Ablation Findings (Table 4 — Exact Numbers)

| Design choice | Variant | Loss (16-layer) | Finding |
|---|---|---|---|
| Baseline (PreNorm) | — | 1.766 | reference |
| DenseFormer [36] | static scalar coefficients | 1.767 | no gain — input-independent weights insufficient |
| mHC [59] | m parallel streams + learned mixing | 1.747 | input-dependent but recurrence-bound |
| **Full AttnRes** | softmax over all layers | **1.737** | best — content-dependent selection |
| **Block AttnRes (S=4)** | 8 blocks | **1.746** | near-Full at O(Nd) memory |
| Input-dependent query | project q from h | 1.731 | slightly better but costs d×d projection + sequential access |
| Input-independent mixing | remove query/key | 1.749 | worse — no content dependence |
| sigmoid (vs softmax) | replace softmax | 1.741 | worse — no competitive normalization |
| Multi-head (H=16) | per-channel depth aggregation | 1.752 | worse — depth mixture is monolithic |
| RMSNorm removed | raw keys | 1.750 (block) | worse — magnitude domination |
| SWA (W=8) | sliding window 8 + embedding | 1.764 | much worse — distant layers matter more than many nearby |

**Key takeaways**:
- **softmax > sigmoid**: competitive normalization forces sharper selection
- **single-head > multi-head**: "when a layer's output is relevant, it is relevant as a whole"
- **RMSNorm on keys critical**: prevents magnitude domination (especially for Block)
- **Pseudo-query input-decoupled**: learned param, not MLP(h) — enables batched compute
- **Zero-init mandatory**: uniform start = standard residual, prevents training volatility
- **Distant layers matter**: SWA (recent 8 only) = 1.764 vs Block AttnRes = 1.746 —
  selectively accessing distant layers is more important than attending to many nearby

### 0.5 Training Dynamics (§5.2)

- **PreNorm dilution solved**: baseline output magnitudes grow monotonically O(L);
  Block AttnRes confines growth within blocks (bounded periodic pattern)
- **Gradient distribution**: baseline has disproportionately large gradients in
  earliest layers; AttnRes softmax weights introduce competition → substantially
  more uniform gradient distribution
- **Architecture shift**: AttnRes shifts optimal dmodel/Lb from 60 → 45 (Fig. 7) —
  favors **deeper, narrower** models under fixed compute. AttnRes exploits
  additional depth more effectively.

### 0.6 Learned Patterns (Fig. 8 — Verified)

1. **Preserved locality**: each layer attends most to immediate predecessor
   (diagonal dominance) — the primary information pathway remains local
2. **Learned skip connections**: off-diagonal concentrations emerge (e.g., layer 4
   attending to early sources, layers 15-16 reaching back)
3. **Embedding persistence**: source 0 (h₁) retains non-trivial weight throughout,
   especially in **pre-attention layers** — the entry representation is
   continuously referenced
4. **Layer specialization**: pre-attention inputs maintain **broader receptive
   fields** (attention routes information across layers); pre-MLP inputs show
   **sharper diagonal reliance** (MLPs operate locally on recent representations)
5. **Block preserves structure**: diagonal dominance, embedding persistence, and
   layer specialization all transfer from Full to Block — block compression acts
   as implicit regularization

### 0.7 Infrastructure (§4 — Brief, Less Relevant to MATS)

- **Cross-stage caching**: eliminates redundant block transmissions under pipeline
  parallelism (V× improvement in peak communication)
- **Two-phase computation**: Phase 1 batches inter-block attention for all S layers
  in a block (amortizes memory access); Phase 2 sequential intra-block + online
  softmax merge. Per-layer I/O: O(Ld) → O((S+N)d)
- **Memory-efficient prefilling**: sequence-shard block representations across TP devices
- **Training overhead < 4%, inference latency overhead < 2%**

### 0.8 Scaling Laws (§5.1)

- Block AttnRes: L = 1.870 × C^{-0.058} vs Baseline: L = 1.891 × C^{-0.057}
- At 5.6 PFLOP/s-days: Block AttnRes 1.692 vs Baseline 1.714 = **1.25× compute advantage**
- Gap between Full and Block narrows with scale (0.001 at largest size)
- 48B model (27 blocks, 9 AttnRes blocks + embedding = 10 sources): improves on
  all 16 downstream benchmarks, especially GPQA-Diamond (+7.5), Math (+3.6),
  HumanEval (+3.1)

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

**Reward-weighted key direction** (Peters & Schaal 2008 reward-weighted
regression, adapted for deterministic attention):
```
mean_key = Σ α_i · key_i               (attention-weighted key direction)
w ← w + lr · r · mean_key               (then EMA + clip)
```

**Why NOT REINFORCE**: the score-function gradient `Σα_i·(key_i − mean_key)`
is **identically zero** for a deterministic softmax blend — because
`mean_key = Σα·key` and `Σα = 1`, so `Σα·(key−mean) = mean − mean = 0`.
K3 uses backprop so doesn't hit this; MATS uses outcome-based gradient.
The reward-weighted key direction directly associates the attention-weighted
key direction with the outcome: win → w shifts toward the blend direction
that won; loss → away.

**v2.0.212 (#7)**: two pseudo-queries with different reward shaping:
- `wDecision`: reward = trade PnL (always update on non-noise outcomes)
- `wExecution`: reward = SL/TP survival (only on closeReason='sl_tp':
  SL hit → negative, TP hit → positive, manual/thesis → skip)

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
- **IMPLEMENTED v2.0.212** (not Phase 2 — full dual pseudo-query).
- Two pseudo-queries per symbol:
  - `wDecision` — broad receptive field (base recency prior 0.5), used for
    conditional WR + Meta-Agent thesis context (analogous to K3 pre-attention
    layers — broad receptive field across all depths).
  - `wExecution` — sharp/recent-biased (recency prior × 2.0 = 1.0), used for
    SL/TP survival context (analogous to K3 pre-MLP layers — sharp diagonal
    dominance, attending to immediate predecessor).
- Both learned via reward-weighted key direction (same mechanism, different
  reward):
  - `wDecision` reward = trade PnL (did the thesis play out?). Updates on
    every non-noise trade outcome.
  - `wExecution` reward = SL/TP placement quality. Updates ONLY on
    closeReason='sl_tp': SL hit (loss) → negative; TP hit (win) → positive.
    manual/thesis_invalidation/consensus → skip (can't judge SL/TP).
- `retrieveBlend(symbol, mode)` selects w + recency prior by mode.
- `recordEntry` captures BOTH mode blends at entry (each w updates from its
   own entry-time attention snapshot).
- Execution-lens context block injected into hacp Skeptics context: shows
  recent regime through SL/TP survival lens so Meta-Agent can calibrate
  conviction / SL adequacy against learned stop-out patterns.
- Separate temperature + update counter per mode (may collapse/flocculate
  independently).
- Backward compat: old single-w state migrates to wDecision + wExecution on
  load (both = old w).

---

## 4. Architecture

```
src/evolution/cycle-history-retrieval.ts   (NEW, ~650 lines, v2.0.211+v2.0.212)
  CycleHistoryRetriever
    - per-symbol: CycleHistoryState { entryFeatures, cycles[80],
        wDecision, wExecution, pendingEntry, featMean/M2/count, ... }
    - retrieveBlend(symbol, mode='decision'|'execution') → BlendedRepresentation
    - recordEntry(symbol, side, entryFeatures) — captures BOTH mode blends
    - updateOnOutcome(symbol, side, pnlPct, closeReason?) — dual reward
    - updateW() — shared core: reward-weighted key direction
    - persist() / load()  (data/evolution/cycle-history.json, atomic)
    - Block AttnRes (#2): 8 blocks of 10 cycles, intra-block mean, inter-block softmax
    - RMSNorm keys (#3) with per-feature Welford z-score (#11.2 adaptation)
    - Fixed recency prior (#11.1 — breaks REINFORCE deadlock)
    - Entropy floor + temperature warmup (per-mode)
  RMSNorm helper (shared)
  softmax helper (shared)
  entropy helper

src/evolution/evolution-utils.ts           (MODIFIED, v2.0.211)
  - computeVectorConditionalWinRate: add rmsNormKeys option (#3)
  - add softmaxWeightedWinRate helper (#4) — optional weighted WR
  - add rmsNormFeatures helper — z-score + RMSNorm for retrieval keys
  - both opt-in, default behavior unchanged (cold-start safe)

src/index.ts                                (MODIFIED, v2.0.211+v2.0.212)
  - instantiate CycleHistoryRetriever
  - every cycle: pushCycle (after lastCycleShadowContexts)
  - executeTrade: recordEntry (entry-time features + both mode blends)
  - recordClose: updateOnOutcome(sym, side, pnlPct, closeReason)
  - checkConditionalWRGate: use retrieveBlend(sym, 'decision') + #3/#4
  - hacp candidate provider: use retrieveBlend(sym, 'decision')
  - wire retriever into hacp (setCycleHistoryRetriever)
  - persist every cycle + in saveEvolutionState

src/cognition/hacp.ts                       (MODIFIED, v2.0.211+v2.0.212)
  - setCycleHistoryRetriever
  - Phase 1.8b + Meta-Agent context: use h_blend as candidate features
  - inject ATTENTION-RESIDUAL BLEND block (alpha distribution explanation)
  - inject EXECUTION REGIME LENS block (#7 — wExecution blend context)

tests/cycle-history-retrieval.test.ts       (NEW, 40 tests)
  - cold-start, retrieval, online learning, block memory, #7 specialization

tests/attack-cycle-history.test.ts          (NEW, 21 tests)
  - Q7.1-Q7.5: numerical, state, cold-start, concurrency, injection attacks
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

- v2.0.213 (#7 execution lens in SL/TP): computeATRSLTP now uses execution-mode
  AttnRes blend as PRIMARY SL/TP signal. wExecution (trained on stop-out
  outcomes) provides stop-out-aware adverse momentum + volatility scaling +
  entropy confidence. Falls back to ATR + raw momentum when wExecution
  untrained (cold-start). Module-level provider pattern — no trading-manager
  changes. SL cap widened to 6% / TP cap to 10% for exec lens (vs 5%/8% raw).
  15 new tests in tests/execution-lens-sltp.test.ts.

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
---

## 12. MATS → AttnRes Transfer Mapping (Full Explanation)

> This section maps each AttnRes technique from the paper to the specific MATS
> component it upgraded, explaining WHAT was transferred, WHY it fits, and HOW
> it was adapted.

### 12.1 The Core Analogy: K3 Depth ≡ MATS Cycle History

| K3 (arXiv 2603.15031) | MATS |
|---|---|
| Layer `l` processes a token through depth | Cycle `N` processes a symbol through time |
| Layer output `v_i = f_i(h_i)` | Cycle snapshot = market features at cycle i |
| Token embedding `v_0 = h_1` (persistent) | **Entry-time market features** (persistent across cycles) |
| Pseudo-query `w_l` (learned, zero-init) | Per-symbol learned retrieval query (zero-init) |
| Next layer input `h_l = Σ α·v_i` | Conditional WR candidate `h_blend = Σ α·block_summary` |
| PreNorm dilution (depth O(L) growth) | Single-snapshot bottleneck (entry regime lost) |

**The problem AttnRes solves in K3**: standard residuals compress all prior
layer outputs into a single state `h_{l-1}` — layer `l` can only see the
compressed sum, not individual earlier outputs. Deep layers lose access to
early representations.

**The analogous problem in MATS**: `computeVectorConditionalWinRate` used the
**current cycle's snapshot** as the candidate. Entry-time market regime was
lost (discarded after entry). Cycle history was not retained — only
`lastCycleShadowContexts` (a single current snapshot per symbol). The system
couldn't selectively retrieve relevant historical periods.

### 12.2 Technique → MATS Upgrade Map

| # | Paper Technique (§) | Paper Finding | MATS Component Upgraded | MATS Adaptation |
|---|---|---|---|---|
| **#1** | Full AttnRes (§3.1) — softmax attention over all preceding layer outputs | Replaces fixed residual accumulation with learned, content-dependent selection. Each layer selectively retrieves relevant earlier representations. | `cycle-history-retrieval.ts` `retrieveBlend()` — conditional WR candidate changes from current snapshot → softmax-weighted blend over 80-cycle history + entry-time state | Candidate = `Σ α_i · block_summary_i + α_entry · entryFeatures`. Entry-time regime retains persistent weight (K3 embedding persistence, Fig 8 source 0). |
| **#2** | Block AttnRes (§3.2) — partition L layers → N≈8 blocks | O(Ld)→O(Nd) memory. N≈8 recovers most gain (Fig. 6). S=2,4,8 near-optimal; S=16,32 degrade to baseline. | 80-cycle history → 8 blocks of 10 cycles. Intra-block: mean of cycle features. Inter-block: softmax attention over 8 block summaries + entry state. | Block size 10 cycles ≈ 50min matches MATS regime persistence (~hours). Tunable via config. **MATS-specific constraint**: block size must match regime-persistence timescale (§11.3). |
| **#3** | RMSNorm on keys (§3.1, ablation §5.3) | Prevents large-magnitude layers from dominating softmax. Removing RMSNorm: Full 1.743, Block 1.750 (both worse). Critical for Block (magnitude differences accumulate over more layers). | `evolution-utils.ts` `rmsNormKeys: true` option in `computeVectorConditionalWinRate` + `rmsNorm()` in `cycle-history-retrieval.ts` | **MATS-specific addition**: per-feature Welford z-score BEFORE RMSNorm (§11.2). K3 layer outputs are already comparable scale; MATS raw features span 50-900 (srDistanceBps) vs 0.1-0.8 (volatility). Without z-score, RMSNorm is dominated by the large-magnitude feature. |
| **#4** | Softmax mixture (§5.3 ablation) | softmax > sigmoid (1.741 vs 1.737). Competitive normalization forces sharper selection. | `evolution-utils.ts` `softmaxWeightedWR: true` — win rate changes from equal-weight argmax top-N → `Σ softmax(sim/τ)·[win]` | High-similarity records weight more. Temperature τ=0.1 controls sharpness. **Opt-in**: default equal-weight preserved for backward compat. |
| **#5** | Zero-init pseudo-query (§5.1) | w_l zero-init → initial α uniform → starts as equal-weight average = standard residual. Prevents training volatility. "All pseudo-query vectors must be initialized to zero." | wDecision + wExecution both zero-init → initial blend = recency-weighted mean of history ≈ current snapshot | **Cold-start safe by construction**: at deploy time with w=0, conditional WR results are within epsilon of current behavior. Selectivity is EARNED through observed trade outcomes. |
| **#6** | Single-head depth mixture (§5.3 ablation) | Multi-head (H=16) hurts: 1.752 vs 1.746. "When a layer's output is relevant, it is relevant as a whole." Depth mixture is monolithic. | Design constraint: do NOT split cycle-history retrieval into momentum-head + regime-head. Single pseudo-query retrieves the entire cycle representation. | Applied as a design principle, not a separate module. The single wDecision/wExecution retrieves all 11 features as a whole. |
| **#7** | Pre-attention vs pre-MLP specialization (§5.4.2, Fig. 8) | Pre-attention layers: broader receptive field (attend across many depths). Pre-MLP layers: sharper diagonal (attend to immediate predecessor). Different layer types benefit from different receptive fields. | **Dual pseudo-query**: wDecision (broad, base recency 0.5) for conditional WR + thesis; wExecution (sharp, recency × 2.0) for SL/TP survival context. | **Different reward shaping**: wDecision trained on trade PnL (thesis played out?); wExecution trained on SL/TP stop-out (SL hit → negative, TP hit → positive, only closeReason='sl_tp'). **v2.0.213**: wExecution blend used as PRIMARY signal in `computeATRSLTP` — directly controls SL/TP placement. |

### 12.3 Techniques NOT Transferred (and Why)

| Paper Technique | Why Not Transferred to MATS |
|---|---|
| **Cross-stage caching (§4.1)** | MATS has no pipeline parallelism — single-process, in-memory. No cross-stage communication to optimize. |
| **Two-phase computation (§4.2)** | MATS has 8 blocks (not 128 layers). Phase 1 batching saves nothing at this scale — sequential attention over 8 sources is already O(1). |
| **Memory-efficient prefilling (§4.2)** | MATS has no long-context prefilling — cycle history is a fixed 80-cycle rolling window, not a growing sequence. |
| **Input-dependent query (§5.3)** | Paper: input-dependent query (project from h) = 1.731 vs input-independent = 1.737, but costs d×d projection + sequential access. MATS: no backprop, so the d×d projection can't be learned. Our pseudo-query is input-independent (learned param updated via reward-weighted key direction). |
| **KDA/MLA hybrid attention** | These are Kimi Linear's sequence-level attention mechanisms, not depth-level. MATS doesn't process sequences through layers — it processes market features through cycles. Not applicable. |
| **Muon optimizer / WSD schedule** | These are pre-training infrastructure for 48B models. MATS uses Adam (self-implemented) for NA and reward-weighted key direction for AttnRes. Different optimization regime. |

### 12.4 MATS-Specific Adaptations (Not in the Paper)

These are modifications MATS had to make because the paper's context (LLM
pre-training with backprop) differs from MATS's context (online trading with
outcome-driven learning):

| Adaptation | Paper Assumption | MATS Reality | Solution |
|---|---|---|---|
| **Reward-weighted key direction** (§11.4) | w_l learned via backprop through the LLM | MATS has no backprop — learning is outcome-driven (trade result → update) | `w += lr · reward · mean_key` (Peters & Schaal 2008). NOT REINFORCE — score-function gradient `Σα·(key−mean)` is identically zero for deterministic softmax. |
| **Fixed recency prior** (§11.1) | w_l zero-init → uniform α → backprop breaks the symmetry | w=0 → uniform α → reward-weighted key direction gradient = 0 (mean_key = 0 when keys cancel) | Added fixed `recencyPrior·(−age)` to logits. w=0 still produces a recency-biased (non-uniform) policy → gradient non-zero. Mirrors K3's locality observation (diagonal dominance). |
| **Per-feature Welford z-score** (§11.2) | K3 layer outputs are already comparable scale (hidden space) | MATS raw features span vastly different magnitudes (srDistanceBps 50-900 vs volatility 0.1-0.8) | `keys = rmsNorm(zScore(values))` — Welford running mean/std per feature, THEN RMSNorm. Puts all features on comparable scale before direction extraction. |
| **Dual reward shaping** (#7) | K3 has one objective (next-token prediction loss) | MATS has two objectives: thesis quality (PnL) and SL/TP placement quality (stop-out avoidance) | Two pseudo-queries with different reward schedules: wDecision (PnL, all trades) vs wExecution (SL/TP stop-out, only closeReason='sl_tp'). |
| **Execution-lens SL/TP** (v2.0.213) | K3's AttnRes output feeds into the next layer — it's an intermediate representation | MATS's wExecution blend can directly control SL/TP placement (a concrete action, not just a representation) | `computeATRSLTP` uses wExecution blend as PRIMARY signal: execAdverseMomentum + volatility scaling + entropy confidence. Falls back to ATR when untrained. |
| **Block size = regime persistence** (§11.3) | K3 block size is a compute/memory trade-off | MATS block size must match regime-persistence timescale (intra-block mean is meaningless if block spans a regime change) | Default: 10 cycles ≈ 50min. Tunable via config. Documented as a design constraint. |
| **Entropy confidence damping** | Not in paper (K3 uses backprop to learn optimal attention sharpness) | MATS wExecution may be uncertain (high entropy = no clear pattern learned) | If entropy > 2.0 bits, dampen execution-lens SL widening by 50%. Low entropy = confident pattern → trust the widening. |
