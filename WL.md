# WL — Reason Intelligence Layer（RIL）方案計劃

> 目標：令 Meta-Agent 有效地知道：
> 1. 邊啲開倉理由最賺錢
> 2. 邊啲平倉理由最賺錢
> 3. 邊啲開倉理由最大機會蝕錢
> 4. 邊啲平倉理由最大機會蝕錢

---

## 核心哲學

**俾 Meta-Agent 數據去 reason，唔係幫佢 decide。**

三個系統（EXP / EM Cycle / A2A Digester）都用 LLM + vectors 去「理解」交易經驗，但結果係 complexity 高、utility 低。根本原因：用 LLM 去分析「邊啲 reason 賺錢」係錯誤嘅工具——呢個係 counting + clustering problem，唔係 NLP problem。

但主神指出：**counting 唔可以取代 reasoning**，因為每次事件都係獨立事件，微細分別先係關鍵。所以正確做法係：

- **Counting + Clustering** → 提供 reference data（過去發生過咩）
- **LLM Reasoning** → 分析 subtle differences（今次有咩唔同）
- **Meta-Agent 自主決定** → 結合 reference + reasoning 做判斷

---

## 一、架構總覽

```
                    ┌─────────────────────────────────────┐
                    │        Meta-Agent Prompt             │
                    │  ┌───────────────────────────────┐   │
                    │  │ Block 1: ENTRY PATTERN MAP    │   │
                    │  │ Block 2: CLOSE REASON STATS   │   │
                    │  │ Block 3: SIMILAR TRADES +     │   │
                    │  │          SUBTLE DIFFERENCES    │   │
                    │  └───────────────────────────────┘   │
                    └──────────┬──────────────────────────┘
                               │ injects
                    ┌──────────▼──────────────────────────┐
                    │     Reason Intelligence Layer        │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │ PatternClusterManager         │   │
                    │  │  • greedy cluster by cosine   │   │
                    │  │  • running-mean centroid     │   │
                    │  │  • per-cluster WR/PnL/count  │   │
                    │  │  • per-cluster exit breakdown │   │
                    │  └──────────────────────────────┘   │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │ CloseReasonAggregator        │   │
                    │  │  • GROUP BY exitType+origin  │   │
                    │  │  • pure math, no LLM        │   │
                    │  └──────────────────────────────┘   │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │ SimilarTradeRetriever        │   │
                    │  │  • top-5 by cosine sim       │   │
                    │  │  • shared elements analysis  │   │
                    │  └──────────────────────────────┘   │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │ SubtleDiffAnalyzer (LLM)     │   │
                    │  │  • 1 LLM call per cycle      │   │
                    │  │  • "what's different vs      │   │
                    │  │    past winners/losers"      │   │
                    │  └──────────────────────────────┘   │
                    └──────────────────────────────────────┘
```

---

## 二、檔案變更清單

### 新檔案（1 個）

**`src/evolution/reason-analytics.ts`**（~350 lines）

```
class PatternClusterManager:
  - rebuildClusters(trades, embed)     // startup: cluster all past rationales
  - addTrade(trade, embed)             // incremental: add one closed trade
  - getPatternMap()                     // → structured pattern stats
  - findSimilar(trade, embed, topN=5)  // → top-N similar trades + similarity

class CloseReasonAggregator:
  - aggregate(trades)                   // → per exitType+origin stats
  - formatBlock(stats)                  // → structured string

class SubtleDiffAnalyzer:
  - analyze(currentThesis, similarTrades, llm)  // → subtle differences text

function formatAnalyticsBlock(patternMap, closeStats, similarTrades, diffAnalysis):
  // → 3-block structured string for Meta-Agent injection
```

### 修改檔案（3 個）

**`src/types/index.ts`**（+~30 lines）
```typescript
interface PatternCluster {
  id: string;
  name: string;           // e.g. "S/R bounce + volume confirmation"
  centroid: number[];
  count: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  avgHoldMin: number;
  symbols: string[];
  sides: string[];
  memberIds: string[];
  exitTypeBreakdown: Record<string, { wins: number; losses: number; pnl: number }>;
}

interface CloseReasonStat {
  exitType: string;
  decisionOrigin: string;
  count: number;
  wins: number;
  losses: number;
  netPnl: number;
  winRate: number;
  avgHoldMin: number;
}

interface SimilarTradeInfo {
  trade: ThesisExperienceRecord;
  similarity: number;
}
```

**`src/index.ts`**（+~40 lines）
- Startup: init ReasonAnalytics, rebuild clusters from tradeHistory
- Each cycle: call `formatAnalyticsBlock()` → inject into agent context
- On close: call `addTrade()` for incremental cluster update

**`src/agents/meta-agent.ts`**（prompt changes, +~20 lines）
- Add instruction to system prompt:
  ```
  You receive three experience blocks each cycle:
  1. ENTRY PATTERN MAP — historical WR/PnL per pattern
  2. CLOSE REASON STATS — historical WR/PnL per close reason
  3. SIMILAR TRADES + DIFFERENCES — past trades similar to your proposal
  
  Use these as REFERENCE, not TRUTH. Past performance does not guarantee
  future results. The subtle differences between current and past setups
  are what matter — reason about them explicitly in your thesis.
  ```

### 移除檔案（2 個）

| 檔案 | 行數 | 原因 |
|:-----|:----:|:-----|
| `src/evolution/thesis-experience.ts` | ~500 | Gate/delta/reverse logic 被取代；保留 `extractRationales()` 搬去 `reason-analytics.ts` |
| `src/evolution/experience-digester.ts` | ~400 | LLM digestion + clustering 被取代 |

### 保留但簡化（1 個）

**`src/evolution/embeddings.ts`** — 保留 `embed()` + `cosine()`，移除 unused functions

### 保留不變（1 個）

**`src/evolution/cycle-summary.ts`** — 保留 cycle chain（市場連續性有用），只移除 insight vector retrieval 部分

---

## 三、核心演算法細節

### 3.1 Pattern Clustering（greedy）

```
Threshold θ = 0.75（cosine similarity，可配置）

Startup (rebuildClusters):
  for each closed trade in tradeHistory:
    for each rationale in trade.rationales:
      vec = embed(rationale)
      best = find nearest cluster centroid (cosine)
      if best.sim >= θ:
        add to best cluster (update centroid, stats)
      else:
        create new cluster (centroid = vec, count = 1)

Incremental (addTrade):
  same logic, but only for the new trade's rationales
  O(k) where k = number of clusters (~20-50 for 1000 trades)

Centroid update:
  newCentroid = (oldCentroid * count + vec) / (count + 1)
  L2-normalize

Cluster naming:
  Find member rationale closest to centroid → use as name
  Update every 10 new members
```

### 3.2 Close Reason Aggregation（純數學）

```
GROUP BY exitType + decisionOrigin:
  for each closed trade:
    key = `${trade.exitType}__${trade.decisionOrigin}`
    stats[key].count++
    stats[key].wins += (trade.pnl > 0 ? 1 : 0)
    stats[key].losses += (trade.pnl <= 0 ? 1 : 0)
    stats[key].netPnl += trade.pnl
    stats[key].avgHoldMin += trade.holdMin

  After loop:
    stats[key].winRate = stats[key].wins / stats[key].count
    stats[key].avgHoldMin /= stats[key].count
```

### 3.3 Similar Trade Retrieval

```
Input: current proposal's rationale embeddings
For each closed trade:
  sim = combinationSimilarity(proposalVecs, trade.rationaleVectors)
  Keep top-5 by sim

Output: top-5 trades with similarity scores
```

### 3.4 Subtle Differences Analysis（1 LLM call per cycle）

```
LLM Prompt:
  System: "You analyze subtle differences between a proposed trade and
  its most similar historical trades. Identify what's DIFFERENT this time
  vs past winners and past losers. Focus on: volume, RSI, regime, macro
  backdrop, price level relative to S/R."

  User: "Proposed: BUY BTC at 67k, thesis: 'S/R bounce + volume'
  
  Similar past trades:
  #1: BUY BTC (sim 87%) — WON +0.45 — thesis: 'S/R bounce at 67k, volume spike'
  #2: BUY BTC (sim 82%) — WON +0.32 — thesis: 'Support retest at 66.5k'
  #3: BUY BTC (sim 79%) — LOSS -0.12 — thesis: 'Bounce from 66.8k, low volume'
  
  Current differences vs past winners:
  - Volume: 15% lower than avg winning trade
  - RSI: 65 vs avg 45 for winners
  - Regime: trending (same as winners)
  
  Current similarities vs past loser #3:
  - Both have lower volume than avg
  - But current regime is trending, #3 was ranging

  Analyze: do the differences matter? Would they change the outcome?"
```

---

## 四、Injection Format（每個 cycle 3 個 block）

```
=== ENTRY PATTERN PERFORMANCE (from 47 closed trades) ===
S/R bounce + volume confirmation:     W8  L2   +1.24  (80%, 10t, avg 34min)
Trend continuation (momentum):        W5  L3   +0.67  (62%, 8t, avg 52min)
Macro tailwind (Fed/rates):           W4  L2   +0.45  (67%, 6t, avg 45min)
FUD-driven news sell:                 W1  L6   -0.89  (14%, 7t, avg 5min) 🔴
Mean reversion (overbought):          W2  L4   -0.32  (33%, 6t, avg 12min) 🟡
Breakout (no volume confirm):         W1  L5   -0.55  (17%, 6t, avg 8min) 🔴

=== CLOSE REASON PERFORMANCE (from 47 closed trades) ===
correct_tp (TP at S/R):               W6  L0   +1.80  (100%, avg 42min) ✅
correct_sl (SL at S/R, wrong dir):    W0  L4   -0.55  (0%, avg 18min)
premature_sl (SL too tight):          W0  L3   -0.32  (0%, avg 4min) 🔴
thesis_invalidated (Skeptics):        W2  L8   -1.10  (20%, avg 6min) 🔴🔴
premature_tp (TP too early):          W3  L2   +0.15  (60%, avg 5min) 🟡
manual_close (Meta-Agent):            W1  L5   -0.78  (17%, avg 7min) 🔴

=== SIMILAR TRADES + SUBTLE DIFFERENCES ===
Top-5 similar to your proposed BUY BTC (S/R bounce + volume):
  #1: BUY BTC (87%) — WON +0.45 — "S/R bounce at 67k, volume spike"
  #2: BUY BTC (82%) — WON +0.32 — "Support retest at 66.5k"
  #3: BUY BTC (79%) — LOSS -0.12 — "Bounce from 66.8k, low volume" ⚠️
  #4: BUY SILVER (74%) — WON +0.28 — "S/R bounce, commodity"
  #5: BUY BTC (71%) — WON +0.18 — "Bounce at 65k"

Subtle differences vs past winners:
  • Volume: 15% lower (⚠️ similar to loser #3)
  • RSI: 65 vs avg 45 (less oversold bounce)
  • Regime: trending (same as winners, different from #3's ranging)
  → Volume concern but regime supports. Consider half size + wider SL.
```

---

## 五、實施步驟

| Step | 檔案 | 工作量 | 風險 |
|:----|:-----|:------|:----|
| 1 | `src/types/index.ts` — 加新 types | ~30 lines | 低 |
| 2 | `src/evolution/reason-analytics.ts` — PatternClusterManager | ~150 lines | 中（clustering threshold 要 tune） |
| 3 | `src/evolution/reason-analytics.ts` — CloseReasonAggregator | ~50 lines | 低（純數學） |
| 4 | `src/evolution/reason-analytics.ts` — SimilarTradeRetriever | ~50 lines | 低（重用現有 cosine） |
| 5 | `src/evolution/reason-analytics.ts` — SubtleDiffAnalyzer | ~50 lines | 中（prompt 要 tune） |
| 6 | `src/evolution/reason-analytics.ts` — formatAnalyticsBlock | ~50 lines | 低 |
| 7 | `src/index.ts` — init + inject | ~40 lines | 低 |
| 8 | `src/agents/meta-agent.ts` — prompt changes | ~20 lines | 低 |
| 9 | 移除 `thesis-experience.ts` gate logic | ~-500 lines | 中（要確認冇其他 caller） |
| 10 | 移除 `experience-digester.ts` | ~-400 lines | 中（要確認冇其他 caller） |
| 11 | 簡化 `embeddings.ts` | ~-50 lines | 低 |
| 12 | Tests | ~100 lines | 低 |

**總計：+350 lines / -950 lines / 淨減 ~600 lines**

---

## 六、Config

```typescript
// src/config/index.ts
reasonAnalytics: {
  enabled: true,
  clusterThreshold: 0.75,        // cosine sim threshold for greedy clustering
  minClusterSize: 3,             // minimum trades per cluster for display
  maxPatternsDisplay: 10,        // max patterns in entry pattern map
  similarTradeCount: 5,          // top-N similar trades to retrieve
  subtleDiffEnabled: true,       // enable LLM subtle differences analysis
  rebuildOnStartup: true,        // rebuild clusters from tradeHistory on start
}
```

---

## 八、Prompt 設計——極限運用參考數據

Reference data 只係原材料，**點樣用先係關鍵**。Skeptics 同 Meta-Agent 嘅 prompt 要重新設計，令佢哋可以極限運用呢啲數據做出最趨利避蝕嘅最優判斷。

### 已修改嘅檔案

| 檔案 | 改動 |
|:-----|:-----|
| `src/agents/meta-agent.ts` | 取代舊 EXPERIENCE DIGEST section → 新 EXPERIENCE REFERENCE DATA section（3 blocks + decision matrix）|
| `src/agents/agents.ts` | Skeptics system prompt 加入 EXPERIENCE REFERENCE AUDIT section（pattern cross-ref + close reason audit + similar trade audit）|

### 8.1 Meta-Agent Prompt（開倉決策）

```
You receive THREE structured data blocks each cycle. These are your PRIMARY reference
for understanding what entry/close patterns historically win and lose. You MUST use
them to make the OPTIMAL decision — maximising profit, minimising loss.

BLOCK 1: ENTRY PATTERN PERFORMANCE
  - HIGH WR (>=60%): pattern works, BUT check subtle differences
  - LOW WR (<=40%): MUST explain why different or HOLD
  - NEW pattern: enter with caution (50% size, wider SL)

BLOCK 2: CLOSE REASON PERFORMANCE
  - Premature closes major loss? Set SL at REAL S/R, commit 15min hold
  - thesis_invalidated high loss? Deepen thesis with concrete levels
  - manual_close low WR? STOP closing manually, trust SL/TP

BLOCK 3: SIMILAR TRADES + SUBTLE DIFFERENCES
  - Minor differences + winning pattern -> ENTER standard
  - Concerning differences -> REDUCED size, WIDER SL
  - Major differences + losing pattern -> HOLD

COMBINED OPTIMAL DECISION MATRIX:
  WIN + confirm + align -> ENTER standard
  WIN but concerning -> 50% size, 2x SL
  LOSE + no explanation -> HOLD
  LOSE + strong reason -> 25% size, wide SL
```

### 8.2 Skeptics Prompt（邏輯審查）

```
BLOCK 1: ENTRY PATTERN PERFORMANCE
  - HIGH WR: check Meta-Agent addressed differences
  - LOW WR + weak explanation -> REJECT with data reference
  - LOW WR + not addressed -> REJECT

BLOCK 2: CLOSE REASON PERFORMANCE
  - Premature close prone? Verify SL at REAL S/R
  - thesis_invalidated high loss? Check thesis has concrete levels

BLOCK 3: SIMILAR TRADES + SUBTLE DIFFERENCES
  - Resembles losers? Challenge for critical difference
  - Resembles winners? Check for missed differences

OPTIMAL CHALLENGE:
  - All pass -> APPROVE
  - Concrete concern -> REJECT with data reference
  - Uncertain -> APPROVE with note
```

### 8.3 兩者協同效應

```
Meta-Agent:  "Pattern X has 80% WR. Similar trades confirm. BUT volume is
              15% lower this time. I'll enter with 50% size and wider SL."

Skeptics:    "Meta-Agent correctly identified the pattern and the volume
              difference. SL is at S/R level (not arbitrary). APPROVE with
              note: monitor volume on next candle."

→ Result: Enter with adjusted parameters. Data-backed, risk-aware.
```

vs

```
Meta-Agent:  "Pattern Y has 14% WR. But I think this time is different."

Skeptics:    "Pattern Y has 14% WR (7 trades). Meta-Agent's explanation
              for 'why different' is vague — no concrete data. REJECT:
              'FUD-driven news sell has 14% WR. Insufficient reason to
              believe this time will differ.'"

→ Result: HOLD. Prevented a likely losing trade.
```

---

## 九、與現有系統嘅關係

```
                    BEFORE                          AFTER
                    ──────                          ─────
Entry analysis:   EXP gate (binary)          →   Pattern map + similar trades (reference)
Close analysis:   Digester text digest       →   Structured close reason stats
Decision:         EXP decides for Meta-Agent →   Meta-Agent decides with data
LLM cost:         ~3 calls per close         →   1 call per cycle (subtle diff)
                   (digest + embed + class)       (zero per close)
Vector usage:     EXP + Digester + EM Cycle  →   Pattern clustering + retrieval only
```
