# MATS 進化計劃 — 從 RL-Assisted 到 Self-Aware Agent

> **作者**: GitHub Copilot · **日期**: 2026-08-01
> **前提**: v2.0.836 — Q-RL Alpha Discovery + DCS v2 + Edge Validation 已完成
> **範圍**: 三個可實施嘅進化方向，每個都有理論基礎 + 具體代碼整合點 + 預期效果

---

## 0. 現狀診斷：你已經有乜嘢，欠乜嘢

### 已有（v2.0.836）

| 組件 | 文件 | 作用 | 評估 |
|:---|:---|:---|:---|
| **Q-RL Table** | `src/evolution/q-rl-table.ts` | 270-cell Q-table，ε-greedy exploration，EWMA Q-value，Wilson LB，bootstrap p-value，BH-FDR | tabular RL，非 function approximation |
| **DCS v2** | `src/edge/dcs-calculator.ts` | 5 維連續 confidence score，時間衰減，Edge 交叉驗證，近期表現 | discovery-level confidence，唔係 system-level |
| **OLR Engine** | `src/evolution/olr-engine.ts` | P(win) 預測 + 5-bin calibration map | 已有 prediction→outcome calibration，但只用喺 OLR 內部 |
| **Convergence Accuracy** | `src/evolution/cycle-summary.ts:355` | EMA 追蹤 Meta-Agent insight direction 是否正確 | 只追蹤「方向對唔對」，唔追蹤「 conviction 校準唔校準」 |
| **Insight Accuracy** | `src/evolution/cycle-summary.ts:577` | EMA 追蹤 retrieved insight 嘅預測準確度 | 只影響 retrieval weighting，唔影響 conviction |
| **Direction Audit** | `src/evolution/direction-audit.ts:230` | vector-conditional WR vs actual outcome | LLM 審計用，唔自動 feedback 入決策 |
| **Edge Report** | `src/edge/edge-calculator.ts` | 5 維 evidence → edgeScore [0,1] | 風險中性，唔分 profile |

### 欠缺

| 缺口 | 影響 | 難度 |
|:---|:---|:---|
| **System-level calibration** | 系統唔知道自己嘅 P(win) 預測整體準唔準 | 低 — 數據已有 |
| **Q-RL 只做 random exploration** | 探索浪費喺已知差嘅 cell，未知 cell 冇人去探索 | 中 — 改 selectAction |
| **Q-RL 唔影響 real trade** | 只透過 shadow → discovery → prompt injection 間接影響 | 中 — 要改架構 |
| **無 multi-step planning** | 每 cycle myopic，無 lookahead | 高 — 要改 HACP |
| **無 counterfactual** | 唔知道「如果冇交易會點」 | 高 — 要 uplift model |

---

## 1. 元認知（Meta-Cognition）：系統知道自己幾準

### 1.1 問題定義

而家系統每個 cycle 都會 output 一個 conviction（0-1）同一個 P(win)（0-1）。但系統唔知道：

- 「我預測 70% P(win) 嘅時候，實際贏率係咪真係 70%？」
- 「我喺 high-vol regime 嘅預測準唔准？」
- 「我嘅 conviction 係咪過度自信？」

**如果系統知道自己嘅 calibration 係差嘅（例如預測 70% 但實際只有 55%），佢可以自動調整 conviction，令決策更保守。**

### 1.2 理論基礎

#### Brier Score

Brier score 係衡量 probabilistic prediction 準確度嘅標準 metric：

$$
\text{Brier} = \frac{1}{N} \sum_{i=1}^{N} (f_i - o_i)^2
$$

其中 $f_i$ = 預測嘅 P(win)，$o_i$ = 實際 outcome（1=win, 0=loss）。

- Brier = 0 → 完美預測
- Brier = 0.25 → 等於永遠預測 50%（隨機猜）
- Brier = 1 → 完全錯誤

#### Reliability Diagram + Calibration Error

將預測分 bin（0-20%, 20-40%, ..., 80-100%），每個 bin 計算實際 win rate。

```
預測 bin    | 預測中位數 | 實際 win rate | 差距 (calibration error)
0.0-0.2     | 0.10       | 0.15          | +0.05 (under-confident)
0.2-0.4     | 0.30       | 0.22          | -0.08 (over-confident)
0.4-0.6     | 0.50       | 0.48          | -0.02 (well-calibrated)
0.6-0.8     | 0.70       | 0.55          | -0.15 (嚴重 over-confident) ← 問題
0.8-1.0     | 0.90       | 0.61          | -0.29 (極度 over-confident) ← 大問題
```

**Expected Calibration Error (ECE)** = 加權平均差距：

$$
\text{ECE} = \sum_{b=1}^{B} \frac{n_b}{N} |acc(b) - conf(b)|
$$

ECE = 0 → 完美校準。ECE > 0.15 → 系統嘅 conviction 不可信。

### 1.3 現有基礎（唔使由零開始）

你已經有兩個 calibration 相關組件：

1. **OLR Engine 5-bin calibration**（`olr-engine.ts:108`）：
   ```typescript
   calibrationBins?: Array<{ lo: number; hi: number; wins: number; losses: number }>;
   ```
   已經追蹤 raw P(win) → empirical WR 嘅 mapping。但只用喺 OLR 內部，唔影響 conviction。

2. **Convergence Accuracy**（`cycle-summary.ts:355`）：
   ```typescript
   updateConvergence(actualDirection: 'up' | 'down' | 'flat'): number
   ```
   已經追蹤「方向對唔對」。但唔追蹤「P(win) 準唔準」。

### 1.4 具體實施方案

#### 新增：`src/evolution/meta-calibrator.ts`

```typescript
/**
 * Meta-Cognitive Calibrator — tracks system-level prediction accuracy.
 *
 * Records (predictedPWin, conviction, regime, actualOutcome) per trade,
 * then computes:
 *   1. Brier score (overall + per-regime)
 *   2. ECE (Expected Calibration Error)
 *   3. Per-bin calibration map (同 OLR 一樣，但 system-level)
 *   4. Confidence adjustment factor → 注入 HACP
 *
 * Integration:
 *   - onTradeClose(predictedPWin, conviction, regime, outcome)
 *   - getCalibrationBlock() → 注入 HACP prompt（同 Q-RL discovery block 同級）
 *   - getConfidenceAdjustment(regime) → Meta-Agent 用嚟 auto-correct conviction
 */

interface CalibrationSample {
  predictedPWin: number;     // HACP consensus P(win)
  conviction: number;         // Meta-Agent conviction
  regime: string;             // entry-time regime
  outcome: 0 | 1;             // actual win/loss
  ts: number;
}

export class MetaCalibrator {
  private samples: CalibrationSample[] = [];
  private readonly MAX_SAMPLES = 500;

  // ── Per-regime Brier score (EMA, half-life 100 trades) ──
  private regimeBrier: Map<string, number> = new Map();
  private regimeSampleCount: Map<string, number> = new Map();

  // ── 10-bin calibration map (finer than OLR's 5-bin) ──
  private bins: Array<{ lo: number; hi: number; wins: number; losses: number }> = [];

  constructor() {
    for (let i = 0; i < 10; i++) {
      this.bins.push({ lo: i / 10, hi: (i + 1) / 10, wins: 0, losses: 0 });
    }
  }

  /**
   * Record a completed trade. Called from onPositionClosedLearning.
   * @param predictedPWin  HACP consensus P(win) at entry time
   * @param conviction     Meta-Agent conviction at entry time
   * @param regime         Entry-time regime
   * @param outcome        1=win, 0=loss
   */
  recordTrade(predictedPWin: number, conviction: number, regime: string, outcome: 0 | 1): void {
    if (!Number.isFinite(predictedPWin) || !Number.isFinite(conviction)) return;
    const sample: CalibrationSample = {
      predictedPWin: Math.max(0, Math.min(1, predictedPWin)),
      conviction: Math.max(0, Math.min(1, conviction)),
      regime,
      outcome,
      ts: Date.now(),
    };
    this.samples.push(sample);
    if (this.samples.length > this.MAX_SAMPLES) this.samples.shift();

    // Update 10-bin calibration map (using predictedPWin)
    const binIdx = Math.min(9, Math.floor(sample.predictedPWin * 10));
    const bin = this.bins[binIdx];
    if (bin) {
      if (outcome === 1) bin.wins++;
      else bin.losses++;
    }

    // Update per-regime Brier score (EMA)
    const brierContribution = Math.pow(sample.predictedPWin - outcome, 2);
    const prevBrier = this.regimeBrier.get(regime) ?? 0.25;
    const count = this.regimeSampleCount.get(regime) ?? 0;
    const alpha = 1 / (1 + count); // diminishing update
    const newBrier = (1 - alpha) * prevBrier + alpha * brierContribution;
    this.regimeBrier.set(regime, newBrier);
    this.regimeSampleCount.set(regime, count + 1);
  }

  /**
   * Compute Expected Calibration Error (ECE).
   * ECE = Σ (n_b / N) × |acc(b) - conf(b)|
   */
  getECE(): number {
    const N = this.samples.length;
    if (N < 20) return 0; // not enough data
    let ece = 0;
    for (const bin of this.bins) {
      const total = bin.wins + bin.losses;
      if (total < 5) continue; // skip bins with insufficient data
      const acc = bin.wins / total;
      const conf = (bin.lo + bin.hi) / 2; // bin midpoint = avg predicted P(win)
      ece += (total / N) * Math.abs(acc - conf);
    }
    return ece;
  }

  /**
   * Get overall Brier score (lower = better, 0 = perfect, 0.25 = random).
   */
  getOverallBrier(): number {
    if (this.samples.length < 20) return 0.25;
    const sum = this.samples.reduce((s, x) => s + Math.pow(x.predictedPWin - x.outcome, 2), 0);
    return sum / this.samples.length;
  }

  /**
   * Get per-regime Brier score.
   * Returns Map<regime, { brier, samples }>
   */
  getRegimeBrier(): Map<string, { brier: number; samples: number }> {
    const out = new Map<string, { brier: number; samples: number }>();
    for (const [regime, brier] of this.regimeBrier) {
      out.set(regime, { brier, samples: this.regimeSampleCount.get(regime) ?? 0 });
    }
    return out;
  }

  /**
   * Confidence adjustment factor for a given regime.
   * If system is over-confident in this regime (predicted > actual),
   * returns factor < 1.0 to dampen conviction.
   * If under-confident, returns > 1.0.
   * If insufficient data, returns 1.0 (no adjustment).
   *
   * @param regime  Current market regime
   * @returns adjustment factor [0.5, 1.5]
   */
  getConfidenceAdjustment(regime: string): number {
    const regimeBrier = this.regimeBrier.get(regime) ?? 0.25;
    const count = this.regimeSampleCount.get(regime) ?? 0;
    if (count < 20) return 1.0; // insufficient data → no adjustment

    // Brier = 0.25 → random → no adjustment
    // Brier < 0.20 → well-calibrated → minimal adjustment
    // Brier > 0.25 → worse than random → significant dampening
    const brierRatio = regimeBrier / 0.25; // 1.0 = random, <1 = good, >1 = bad
    const adjustment = Math.max(0.5, Math.min(1.5, 1.0 / brierRatio));
    return adjustment;
  }

  /**
   * Format calibration block for HACP prompt injection.
   * Meta-Agent sees this and can self-correct.
   */
  getCalibrationBlock(): string {
    if (this.samples.length < 20) {
      return '=== META-CALIBRATION ===\nInsufficient data for calibration assessment.\n---';
    }
    const brier = this.getOverallBrier();
    const ece = this.getECE();
    const lines: string[] = [
      '=== META-CALIBRATION (System Self-Awareness) ===',
      `📊 Overall Brier: ${brier.toFixed(4)} (0=perfect, 0.25=random, >0.25=worse-than-random)`,
      `📊 ECE: ${ece.toFixed(4)} (0=perfectly calibrated, >0.15=significant miscalibration)`,
      `📊 Sample size: ${this.samples.length} trades`,
    ];

    // Per-regime breakdown
    const regimeBrier = this.getRegimeBrier();
    const sortedRegimes = [...regimeBrier.entries()].sort((a, b) => b[1].brier - a[1].brier);
    if (sortedRegimes.length > 0) {
      lines.push('');
      lines.push('Per-regime prediction accuracy (Brier, lower=better):');
      for (const [regime, { brier: rBrier, samples }] of sortedRegimes.slice(0, 5)) {
        const status = rBrier < 0.20 ? '✅' : rBrier < 0.25 ? '⚠️' : '❌';
        lines.push(`  ${status} ${regime}: ${rBrier.toFixed(4)} (${samples} trades)`);
      }
    }

    // Calibration bins
    lines.push('');
    lines.push('Calibration map (predicted P(win) → actual win rate):');
    for (const bin of this.bins) {
      const total = bin.wins + bin.losses;
      if (total < 5) continue;
      const actualWR = bin.wins / total;
      const predictedMid = (bin.lo + bin.hi) / 2;
      const gap = actualWR - predictedMid;
      const status = Math.abs(gap) < 0.05 ? '✅' : gap < 0 ? '📉 over-confident' : '📈 under-confident';
      lines.push(`  [${(bin.lo * 100).toFixed(0)}-${(bin.hi * 100).toFixed(0)}%] → actual ${(actualWR * 100).toFixed(0)}% (n=${total}) ${status}`);
    }

    // Self-correction advice
    if (ece > 0.15) {
      lines.push('');
      lines.push(`⚠️ MISCALIBRATION DETECTED (ECE=${ece.toFixed(2)}). Your conviction is not reliable.`);
      lines.push(`   If you predict 70% P(win) but actual is 55%, you are OVER-CONFIDENT.`);
      lines.push(`   REDUCE your conviction by ~${((1 - this.getConfidenceAdjustment('default')) * 100).toFixed(0)}% this cycle.`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  // ── Persistence ──
  save(): Record<string, unknown> {
    return {
      samples: this.samples.slice(-100), // keep last 100 for reload
      bins: this.bins.map(b => ({ ...b })),
      regimeBrier: Object.fromEntries(this.regimeBrier),
      regimeSampleCount: Object.fromEntries(this.regimeSampleCount),
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const savedSamples = s['samples'] as CalibrationSample[] | undefined;
    if (Array.isArray(savedSamples)) this.samples = savedSamples;
    const savedBins = s['bins'] as Array<{ lo: number; hi: number; wins: number; losses: number }> | undefined;
    if (Array.isArray(savedBins)) this.bins = savedBins;
    const savedBrier = s['regimeBrier'] as Record<string, number> | undefined;
    if (savedBrier) this.regimeBrier = new Map(Object.entries(savedBrier));
    const savedCount = s['regimeSampleCount'] as Record<string, number> | undefined;
    if (savedCount) this.regimeSampleCount = new Map(Object.entries(savedCount));
  }
}
```

### 1.5 整合點

| 改動點 | 文件 | 代碼 |
|:---|:---|:---|
| **Init** | `src/index.ts` | `this.metaCalibrator = new MetaCalibrator()` + load from `data/meta-calibration.json` |
| **Trade close** | `src/index.ts` `onPositionClosedLearning` | `this.metaCalibrator.recordTrade(predictedPWin, conviction, regime, isWin ? 1 : 0)` |
| **HACP injection** | `src/index.ts` pre-cycle | `this.hacpEngine.setMetaCalibrationBlock(this.metaCalibrator.getCalibrationBlock())` |
| **HACP** | `src/cognition/hacp.ts` | 新增 `setMetaCalibrationBlock(block)` + 拼入 `rilEnhancedMarketDesc` |
| **Persistence** | `src/index.ts` shutdown | save `data/meta-calibration.json` (atomic) |

### 1.6 點解可以提高勝率

**核心機制**：如果系統知道自己喺某個 regime 嘅 Brier score 係 0.30（差過隨機），Meta-Agent 見到 `❌ trending_bear: 0.30 (45 trades)` 之後，會自動降低喺 trending_bear regime 嘅 conviction。

**具體例子**：

```
冇 meta-calibration:
  Meta-Agent: "I see 70% consensus + 65% P(win) → conviction 0.72 → TRADE"
  實際: trending_bear regime 嘅 P(win) 預測長期只有 55% 準確度
  結果: 0.72 conviction 但實際只有 55% P(win) → 交易但應該 HOLD

有 meta-calibration:
  Meta-Agent 見到: "❌ trending_bear: Brier=0.30, ECE=0.18, over-confident"
  Meta-Agent: "I see 70% consensus + 65% P(win), BUT my calibration in trending_bear
              is bad (Brier 0.30). I should reduce conviction to 0.72 × 0.7 = 0.50 → HOLD"
  結果: 自動降權 → 避免一個 statistically 唔可靠嘅交易
```

**預期效果**：ECE > 0.15 嘅 regime 自動降權 → 減少 false positive → 提高 overall win rate 2-5%。

**數據要求**：最少 20 個已 close 嘅 trade（而家 5-min cycle ≈ 200 trade/月，即 3 日有足夠數據）。

### 1.7 攻擊測試計劃

| 測試 | 方法 | 通過條件 |
|:---|:---|:---|
| 冷啟動 | < 20 trades → getCalibrationBlock() 返回 "insufficient" | 唔 crash，唔影響決策 |
| NaN P(win) | recordTrade(NaN, 0.7, 'range', 1) | 唔 crash，skip |
| 全勝 | 50 trades 全勝 → Brier ≈ 0 | Brier < 0.05 |
| 全敗 | 50 trades 全敗 → Brier ≈ 1 | Brier > 0.9 |
| Per-regime 分化 | trending_bull 全勝 + trending_bear 全敗 | regime Brier 明顯唔同 |
| ECE 計算 | 預測全 0.9 但實際 0.5 → ECE = 0.4 | ECE > 0.15 觸發 warning |
| Confidence adjustment | Brier = 0.35 → adjustment = 0.71 | conviction 降 29% |
| 持久化 | save + load + 數據保留 | bins + regimeBrier 一致 |

---

## 2. Active Exploration：唔係 random，係 targeted

### 2.1 問題定義

而家 Q-RL 用 ε-greedy：`Math.random() < epsilon` 就 explore。但 exploration 係 **random**——佢唔知道邊個 cell 最值得 explore。

**具體浪費**：

```
Q-table 現狀（假設 100 cycles 後）：

Cell: trend_up | normal | up | positive | buy
  Q = 0.008, visits = 45, Wilson LB = 0.62 → 已經 confirmed
  → 再 explore 呢個 cell = 浪費（已知好）

Cell: trend_up | volatile | up | positive | buy
  Q = 0.0, visits = 0 → 完全未知
  → random exploration 唔一定去到呢個 cell

Cell: range | calm | flat | neutral | sell
  Q = -0.003, visits = 12, Wilson LB = 0.35 → 可能差
  → 再 explore 呢個 cell = 浪費（已知差）
```

Random exploration 會：
1. 重複 visit 已知好/差嘅 cell（浪費 sample budget）
2. 唔去探索真正未知嘅 cell
3. 270 cell × random → 要好耐先每個 cell 都有足夠 visits

### 2.2 理論基礎

#### UCB1 (Upper Confidence Bound)

UCB1 係 active exploration 嘅經典演算法。核心思想：揀「上界信心最高」嘅 action，而唔係揀「mean Q-value 最高」嘅 action。

$$
\text{UCB1}(a) = Q(a) + c \sqrt{\frac{\ln N}{n_a}}
$$

其中：
- $Q(a)$ = action $a$ 嘅平均 reward（exploitation term）
- $c$ = exploration constant（通常 $c = \sqrt{2}$）
- $N$ = total visits across all actions
- $n_a$ = visits to action $a$（exploration term）

**關鍵特性**：
- $n_a$ 細（少 visit）→ exploration term 大 → 優先 explore 未知 cell
- $n_a$ 大（多 visit）→ exploration term 細 → 靠 Q-value exploit
- 自然 balance：先 explore，後 exploit，唔需要手動 decay ε

#### Thompson Sampling（更強嘅替代）

Thompson Sampling 用 Bayesian posterior 而唔係 UCB bound。對每個 cell 維護一個 Beta posterior：

$$
\text{Beta}(\alpha, \beta) \quad \text{where} \quad \alpha = \text{wins} + 1, \quad \beta = \text{losses} + 1
$$

每個 cycle，從每個 cell 嘅 Beta posterior **sample** 一個值，揀最高嘅。

**優勢 over UCB1**：
- 自然處理不確定性（posterior 寬 = 不確定 = sample 分散 = 更可能被揀中）
- 唔需要手動調 exploration constant
- 實證上比 UCB1 更高效（empirical regret bound 更低）

**Thompson Sampling regret bound**：

$$
\text{Regret}(T) = O\left(\sum_{a \neq a^*} \frac{\log T}{\Delta_a}\right)
$$

其中 $\Delta_a$ = 最優 action 同 action $a$ 嘅 gap。比 ε-greedy 嘅 $O(T)$ regret 好好多。

### 2.3 具體實施方案

#### 改動 `selectAction()` — 從 ε-greedy 到 UCB1 + Thompson Sampling hybrid

```typescript
// ─── 新增 config ───
export interface QRLConfig {
  // ... 現有 ...
  /** v2.1: Exploration strategy */
  explorationStrategy: 'epsilon-greedy' | 'ucb1' | 'thompson';
  /** v2.1: UCB1 exploration constant (c). sqrt(2) ≈ 1.41 */
  ucbExplorationConstant: number;
  /** v2.1: Minimum visits before UCB kicks in (cold-start safety) */
  ucbMinTotalVisits: number;
}

const DEFAULT_CONFIG: QRLConfig = {
  // ... 現有 ...
  explorationStrategy: 'thompson',     // 預設用 Thompson
  ucbExplorationConstant: 1.41,        // sqrt(2)
  ucbMinTotalVisits: 10,
};
```

#### 新 `selectAction()` — 支援三種策略

```typescript
/**
 * Select an action. Strategy determined by config.explorationStrategy.
 *
 * - epsilon-greedy: random explore with probability ε (current behavior)
 * - ucb1: pick action with highest Q(a) + c√(ln N / n_a)
 * - thompson: sample from Beta(wins+1, losses+1) per action, pick highest
 *
 * All strategies are cold-start safe: if both actions have 0 visits,
 * follow LLM (identical to current behavior).
 */
selectAction(
  llmAction: 'buy' | 'sell',
  features: Record<string, number>,
): 'buy' | 'sell' {
  this.totalCycles++;

  if (!features || typeof features !== 'object') return llmAction;

  const buyKey = this.makeKey(features, 'buy');
  const sellKey = this.makeKey(features, 'sell');
  const qBuy = this.values[buyKey] ?? 0;
  const qSell = this.values[sellKey] ?? 0;
  const visitsBuy = this.visits[buyKey] ?? 0;
  const visitsSell = this.visits[sellKey] ?? 0;

  // Cold-start: both Q=0 → follow LLM
  if (visitsBuy === 0 && visitsSell === 0) return llmAction;

  const strategy = this.config.explorationStrategy;

  if (strategy === 'ucb1') {
    return this.selectUCB1(llmAction, buyKey, sellKey, qBuy, qSell, visitsBuy, visitsSell);
  }
  if (strategy === 'thompson') {
    return this.selectThompson(llmAction, buyKey, sellKey, visitsBuy, visitsSell);
  }

  // Default: epsilon-greedy (existing behavior)
  const epsilon = this.currentEpsilon();
  if (Math.random() < epsilon) {
    return qBuy > qSell ? 'buy' : 'sell';
  }
  return llmAction;
}

/**
 * UCB1 action selection.
 * Pick the action with highest upper confidence bound:
 *   UCB1(a) = Q(a) + c × √(ln(N) / n_a)
 *
 * If n_a = 0, the exploration term is Infinity → always pick unvisited first.
 */
private selectUCB1(
  llmAction: 'buy' | 'sell',
  buyKey: string,
  sellKey: string,
  qBuy: number,
  qSell: number,
  visitsBuy: number,
  visitsSell: number,
): 'buy' | 'sell' {
  const N = visitsBuy + visitsSell;
  if (N < this.config.ucbMinTotalVisits) {
    // Not enough total visits → follow LLM (cold-start safety)
    return llmAction;
  }

  const c = this.config.ucbExplorationConstant;
  const lnN = Math.log(N + 1);

  // UCB1 for buy
  const ucbBuy = visitsBuy === 0
    ? Infinity  // unvisited → always explore first
    : qBuy + c * Math.sqrt(lnN / visitsBuy);

  // UCB1 for sell
  const ucbSell = visitsSell === 0
    ? Infinity
    : qSell + c * Math.sqrt(lnN / visitsSell);

  // Pick higher UCB
  const selected = ucbBuy >= ucbSell ? 'buy' : 'sell';

  log.debug(`[q-rl] UCB1: Q_buy=${qBuy.toFixed(4)} (n=${visitsBuy}, UCB=${ucbBuy === Infinity ? '∞' : ucbBuy.toFixed(4)}), Q_sell=${qSell.toFixed(4)} (n=${visitsSell}, UCB=${ucbSell === Infinity ? '∞' : ucbSell.toFixed(4)}) → ${selected}`);

  return selected;
}

/**
 * Thompson Sampling action selection.
 * For each action, maintain Beta(wins+1, losses+1) posterior.
 * Sample from each posterior, pick the higher sample.
 *
 * Beta sampling via gamma distribution:
 *   Beta(α, β) ~ Gamma(α) / (Gamma(α) + Gamma(β))
 * Or use the simpler Marsaglia-Tsang method for direct Beta sampling.
 */
private selectThompson(
  llmAction: 'buy' | 'sell',
  buyKey: string,
  sellKey: string,
  visitsBuy: number,
  visitsSell: number,
): 'buy' | 'sell' {
  // Get wins/losses for each action from rewardHistory
  const buyRewards = this.rewardHistory[buyKey] ?? [];
  const sellRewards = this.rewardHistory[sellKey] ?? [];

  const buyWins = buyRewards.filter(r => r > 0).length;
  const buyLosses = buyRewards.length - buyWins;
  const sellWins = sellRewards.filter(r => r > 0).length;
  const sellLosses = sellRewards.length - sellWins;

  // Beta(α, β) where α = wins + 1, β = losses + 1 (Bayesian prior = Beta(1,1) = uniform)
  const sampleBuy = this.sampleBeta(buyWins + 1, buyLosses + 1);
  const sampleSell = this.sampleBeta(sellWins + 1, sellLosses + 1);

  const selected = sampleBuy >= sampleSell ? 'buy' : 'sell';

  log.debug(`[q-rl] Thompson: buy=Beta(${buyWins + 1},${buyLosses + 1})→${sampleBuy.toFixed(4)}, sell=Beta(${sellWins + 1},${sellLosses + 1})→${sampleSell.toFixed(4)} → ${selected}`);

  return selected;
}

/**
 * Sample from Beta(α, β) distribution using the gamma ratio method.
 * Beta(α, β) = Gamma(α) / (Gamma(α) + Gamma(β))
 *
 * Uses Marsaglia-Tsang gamma sampling (accurate + fast, no external library).
 */
private sampleBeta(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0.5; // safety
  const x = this.sampleGamma(alpha);
  const y = this.sampleGamma(beta);
  const sum = x + y;
  if (sum === 0 || !Number.isFinite(sum)) return 0.5;
  return Math.max(0, Math.min(1, x / sum));
}

/**
 * Marsaglia-Tsang gamma sampling.
 * For shape parameter α: generate Gamma(α, 1).
 */
private sampleGamma(shape: number): number {
  if (shape < 1) {
    // For α < 1, use the boost trick: Gamma(α) = Gamma(α+1) × U^(1/α)
    const u = Math.random();
    if (u === 0) return 0;
    return this.sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }

  // Marsaglia-Tsang for α ≥ 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 100; i++) { // max 100 attempts
    let x: number;
    let v: number;
    do {
      x = this.standardNormal();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // fallback (should rarely reach here)
}

/** Box-Muller standard normal. */
private standardNormal(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  if (u1 === 0) return 0;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
```

### 2.4 整合點

| 改動點 | 文件 | 代碼 |
|:---|:---|:---|
| **Config** | `src/evolution/q-rl-table.ts` `QRLConfig` | 加 `explorationStrategy`, `ucbExplorationConstant`, `ucbMinTotalVisits` |
| **selectAction** | `src/evolution/q-rl-table.ts` | 改做三路分叉：ε-greedy / UCB1 / Thompson |
| **Config env** | `.env` | `QRL_EXPLORATION_STRATEGY=thompson` |
| **Persistence** | save/load | 新 config 欄位要 persist |

### 2.5 點解可以提高勝率

**核心機制**：Thompson Sampling 會優先探索 visits=0 嘅 cell，而唔係 random explore 已知 cell。

**具體對比（270-cell Q-table，500 cycles）**：

| 策略 | Cells visited ≥ 10 | Cells visited ≥ 30 | Discovery speed | 浪費 samples |
|:---|:---|:---|:---|:---|
| ε-greedy (current) | ~80-100 | ~20-30 | 慢（random 分散） | ~40% 去 已知 cell |
| UCB1 | ~150-180 | ~40-60 | 快（targeted） | <10% |
| Thompson | ~180-210 | ~60-80 | 最快（Bayesian optimal） | <5% |

**預期效果**：
- Discovery 達 n≥30 confirmed 嘅時間從 2-3 個月 → 2-3 週
- 每個 cell 更快達到 statistical power
- 更少浪費 sample budget 喺已知好/差嘅 cell

### 2.6 為乜嘢用 Thompson 而唔係 UCB1

| 特性 | ε-greedy | UCB1 | Thompson |
|:---|:---|:---|:---|
| Exploration 方式 | Random | Upper bound | Posterior sample |
| 需要調參 | ε + decay schedule | c constant | 冇（自動） |
| Cold-start 安全 | ✅ (Q=0 → LLM) | ✅ (N < min → LLM) | ✅ (Beta(1,1) = uniform → 50/50) |
| 計算成本 | O(1) | O(1) | O(1) per sample |
| Regret bound | O(T) | O(log T) | O(log T) (empirical 更低) |
| 處理不確定性 | 冇 | Bound-based | 自然 (posterior 寬度) |
| 適合 financial | 差（myopic） | 好 | 最好（Bayesian = 處理 noise） |

Thompson Sampling 喺 financial RL 嘅優勢：market data 本身有大量 noise，Thompson 嘅 Bayesian posterior 自然吸收 noise（wide posterior = 高不確定性 = 系統唔會 over-commit）。UCB1 嘅 bound 係 frequentist，對 outlier 更敏感。

### 2.7 攻擊測試計劃

| 測試 | 方法 | 通過條件 |
|:---|:---|:---|
| Cold-start | 兩個 action visits=0 → follow LLM | 唔 crash |
| 全 visited | 兩個 action 都有 30+ visits | Thompson sample 唔 crash |
| Beta(1,1) | visits=0 → Beta(1,1) sample = uniform [0,1] | sample 喺 [0,1] 內 |
| 單邊全勝 | buy: 30 wins 0 losses → Beta(31,1) sample 高 | buy sample > sell sample（大部分時間） |
| 單邊全敗 | buy: 0 wins 30 losses → Beta(1,31) sample 低 | sell sample > buy sample（大部分時間） |
| Gamma 邊界 | shape=0.5, 1, 100 → sampleGamma | finite, positive |
| Sample 範圍 | 1000 次 sampleBeta(5, 5) → mean ≈ 0.5 | mean 喺 [0.45, 0.55] |
| UCB1 Infinity | visits=0 → UCB=Infinity → 先揀 | unvisited 優先 |
| UCB1 decay | visits=100 vs visits=10 → UCB 探索項唔同 | high-visit 探索項 < low-visit |
| 切換 | config 改 strategy → 行為改變 | 三種策略都可以切換 |
| 持久化 | save + load config → strategy 保留 | load 後 strategy 正確 |

---

## 3. 進化路線圖

### Phase 1（1 週）：Meta-Cognitive Calibrator

| Day | 工作 | Gate |
|:---|:---|:---|
| 1 | `src/evolution/meta-calibrator.ts` — Brier + ECE + 10-bin + per-regime | tsc + unit test |
| 2 | Thompson Sampling 改動 `q-rl-table.ts` `selectAction()` | tsc + unit test |
| 3 | 整合 index.ts — recordTrade on close + calibration block injection | tsc |
| 4 | HACP `setMetaCalibrationBlock()` + prompt 拼接 | tsc |
| 5 | 攻擊測試：NaN, cold-start, 全勝全敗, per-regime, 持久化 | 20/20 pass |
| 6 | 攻擊測試：Thompson sampling, Beta 邊界, UCB1 infinity, 切換 | 20/20 pass |
| 7 | 文檔更新 + git commit | tsc clean |

### Phase 2（2 週）：Long-Horizon Planning

| Day | 工作 | Gate |
|:---|:---|:---|
| 1-3 | `src/cognition/multi-step-planner.ts` — 3-step lookahead plan generator | tsc + test |
| 4-5 | HACP integration — plan 注入 Meta-Agent prompt + plan outcome tracking | tsc + test |
| 6-7 | Plan outcome validator — 對比 plan vs actual，feedback 入 calibrator | tsc + test |
| 8-9 | Attack tests — plan collision, stale plan, plan cancellation | 15/15 pass |
| 10 | 文檔 + commit | tsc clean |

### Phase 3（2 週）：Counterfactual Reasoning

| Day | 工作 | Gate |
|:---|:---|:---|
| 1-3 | `src/evolution/counterfactual-estimator.ts` — uplift model (what if we didn't trade) | tsc + test |
| 4-5 | Shadow trade enhancement — paired shadow (one trades, one holds) | tsc + test |
| 6-7 | Counterfactual PnL estimation + feedback loop | tsc + test |
| 8-9 | Attack tests — look-ahead bias, survivorship bias | 15/15 pass |
| 10 | 文檔 + commit | tsc clean |

### Phase 4（3 週）：Self-Modifying Strategy

| Day | 工作 | Gate |
|:---|:---|:---|
| 1-5 | `src/evolution/strategy-synthesizer.ts` — Meta-Agent generates strategy code | tsc + test |
| 6-8 | Strategy validation — backtest + paper trade before activation | tsc + test |
| 9-12 | Hot-reload — atomic strategy swap without restart | tsc + test |
| 13-15 | Attack tests — malicious code injection, infinite loop, memory leak | 20/20 pass |
| 16-18 | 文檔 + commit | tsc clean |
| 19-21 | Buffer | — |

---

## 4. 驗證計劃

| 驗證項目 | 方法 | 成功標準 |
|:---|:---|:---|
| **Meta-calibration 提高勝率** | A/B test — 100 cycle with vs without calibration block | calibrated win rate > uncalibrated by ≥ 2% |
| **ECE 下降** | 100 cycle 後 ECE 從初始 ~0.20 下降到 < 0.12 | ECE < 0.15 after 100 trades |
| **Thompson 探索效率** | 500 cycle 後比較 cell visit 分布 | Thompson visited cells ≥ 180, ε-greedy ≤ 120 |
| **Discovery 加速** | Thompson vs ε-greedy 達 n≥30 confirmed 嘅 cycle 數 | Thompson < ε-greedy × 0.5 |
| **Calibration block 唔 crash** | ECE = 0 + Brier = 0.25 + 1000 samples | 唔 crash，正常 output |
| **Thompson 唔 crash** | 0 visits + 1 visit + 1000 visits | 唔 crash，sample 喺 [0,1] |

---

## 5. 風險與緩解

| 風險 | 緩解 |
|:---|:---|
| Meta-calibrator 數據太少 → 調整反向 | 最少 20 trade 先啟用 adjustment，否則 factor = 1.0 |
| Thompson sampling 過度探索 | 限制只喺 shadow trade 做 exploration，real trade 仍然跟 HACP |
| Calibration block 令 Meta-Agent 太保守 | ECE < 0.15 時唔 inject warning，只 inject stats |
| Gamma sampling 數值不穩定 | 100 次 retry limit + fallback = shape parameter |
| Per-regime Brier 樣本唔夠 | 每個 regime 最少 20 sample 先計算，否則 return 0.25（neutral） |
| 探索策略切換破壞現有行為 | 預設仍然係 ε-greedy，要顯式 config 先切換 |

---

## 6. 設計原則

1. **所有進化都係 optional** — 唔啟用 = 而家行為（向後兼容）
2. **Shadow trade 先探索** — Q-RL exploration 只影響 shadow，唔直接影響 real trade
3. **Calibration 係 reference data** — Meta-Agent 見到但可以忽略（同 RIL/news sentiment 哲學一致）
4. **Bayesian > frequentist** — Thompson Sampling 處理 financial noise 比較好
5. **最少 20 sample 先啟用** — 避免小樣本 overfitting
6. **Brier = 標準 metric** — 唔發明新 metric，用公認嘅 calibration 標準
7. **分層 confidence** — cell-level (DCS) + system-level (Meta-Calibrator) + regime-level (per-regime Brier)
8. **不確定性量化** — 系統知道自己唔知道幾多（ECE + Brier + posterior width）

---

## 7. Self-Improving：系統自動改自己嘅行為

### 7.1 問題定義

而家系統嘅「改善」全部係人手嘅：

- 人手寫 code 改 conviction gate threshold
- 人手寫 code 改 SL/TP scaling
- 人手寫 code 改 Q-RL config（exploration strategy、thresholds）
- 人手揀 feature set（regimeOrdinal, volatility, momentum, funding...）
- 人手揀 binning strategy（5 regime × 3 vol × 3 mom × 3 funding）

**Self-improving 嘅定義**：系統可以根據自己嘅歷史表現，**自動調整自己嘅 hyper-parameters**，唔需要人手改 code。

### 7.2 理論基礎

#### Bayesian Hyperparameter Optimization

傳統 hyperparameter tuning 係 grid search 或 random search。Bayesian optimization 用 Gaussian Process surrogate model 去建模「hyperparameter → performance」嘅 mapping，然後用 acquisition function（Expected Improvement / UCB）去揀下一個試嘅 hyperparameter。

$$
\text{EI}(x) = \mathbb{E}[\max(f(x) - f^*, 0)]
$$

其中 $f(x)$ = GP posterior 預測嘅 performance，$f^*$ = 目前最佳 performance。

#### Bandit-based Auto-tuning

對於離散嘅 config 選擇（例如 `explorationStrategy: 'epsilon-greedy' | 'ucb1' | 'thompson'`），可以用 multi-armed bandit 去自動揀邊個 config 表現最好。每個 config 係一個 arm，reward = 實際 trade performance。

呢個同 Thompson Sampling 一脈相承——只不過而家 arm 唔係 buy/sell action，而係 config 選擇。

#### Meta-Gradient Descent

對於連續嘅 hyperparameters（例如 conviction gate threshold、SL cap、TP cap），可以用 meta-gradient descent。系統計算「如果呢個 parameter 再調高少少，過去 100 筆 trade 嘅總 PnL 會唔會更好？」然後朝更好嘅方向微調。

$$
\theta_{t+1} = \theta_t + \eta \cdot \frac{\partial \text{PnL}}{\partial \theta}
$$

呢個係 MAML (Model-Agnostic Meta-Learning) 嘅簡化版——唔係學 model weights，而係學 hyperparameters。

### 7.3 具體實施方案

#### 新增：`src/evolution/self-improver.ts`

```typescript
// ─── Self-Improver (v2.0.838) ──────────────────────────────────────
//
// System automatically tunes its own hyperparameters based on observed
// performance. Uses bandit-based selection for discrete configs and
// EMA-based gradient for continuous parameters.
//
// Design:
//   1. Discrete config bandit: which exploration strategy performs best?
//   2. Continuous parameter tuning: SL/TP caps, conviction thresholds
//   3. Feature importance ranking: which features actually predict PnL?
//   4. Binning strategy: is 5×3×3×3×2 optimal, or should we re-bin?
//
// All changes are:
//   - Bounded (never exceed safe limits)
//   - Gradual (EMA update, not sudden jumps)
//   - Logged (every adjustment is auditable)
//   - Reversible (can roll back to previous config)
//   - Fire-and-forget (runs at cycle end, never blocks)

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'self-improver' });

// ─── Types ───

interface PerformanceWindow {
  cycle: number;
  pnlPct: number;
  winRate: number;
  brier: number;
  ece: number;
  configSnapshot: Record<string, unknown>;
}

interface ContinuousParam {
  name: string;
  currentValue: number;
  minValue: number;
  maxValue: number;
  stepSize: number;
  // EMA of "did increasing this parameter improve PnL?"
  gradientEMA: number;
  // History of (value, pnlPct) pairs for gradient estimation
  history: Array<{ value: number; pnlPct: number; cycle: number }>;
}

interface ConfigArm {
  configKey: string;
  configValue: string;
  trials: number;
  cumulativePnlPct: number;
  // Beta posterior for Thompson Sampling of configs
  alpha: number; // "good" count (pnlPct > 0)
  beta: number;  // "bad" count (pnlPct <= 0)
}

// ─── Self-Improver ───

export class SelfImprover {
  private performanceHistory: PerformanceWindow[] = [];
  private readonly MAX_HISTORY = 200;

  // Discrete config bandit arms
  private configArms: Map<string, ConfigArm[]> = new Map();

  // Continuous parameters to tune
  private continuousParams: Map<string, ContinuousParam> = new Map();

  // ── Config bandit arms (discrete choices) ──

  private static readonly CONFIG_CHOICES: Record<string, string[]> = {
    'explorationStrategy': ['epsilon-greedy', 'ucb1', 'thompson'],
  };

  // ── Continuous parameter bounds (safe limits) ──

  private static readonly CONTINUOUS_BOUNDS: Array<{
    name: string;
    min: number;
    max: number;
    step: number;
    initial: number;
  }> = [
    { name: 'convictionGateThreshold', min: 0.40, max: 0.60, step: 0.01, initial: 0.50 },
    { name: 'aggressiveSlCap', min: 0.05, max: 0.09, step: 0.005, initial: 0.07 },
    { name: 'conservativeSlCap', min: 0.02, max: 0.04, step: 0.005, initial: 0.03 },
    { name: 'dcsTimeDecayHalfLife', min: 100, max: 400, step: 25, initial: 200 },
  ];

  constructor() {
    // Initialize config arms
    for (const [key, choices] of Object.entries(SelfImprover.CONFIG_CHOICES)) {
      const arms: ConfigArm[] = choices.map(v => ({
        configKey: key,
        configValue: v,
        trials: 0,
        cumulativePnlPct: 0,
        alpha: 1, // Beta(1,1) = uniform prior
        beta: 1,
      }));
      this.configArms.set(key, arms);
    }

    // Initialize continuous params
    for (const bound of SelfImprover.CONTINUOUS_BOUNDS) {
      this.continuousParams.set(bound.name, {
        name: bound.name,
        currentValue: bound.initial,
        minValue: bound.min,
        maxValue: bound.max,
        stepSize: bound.step,
        gradientEMA: 0,
        history: [],
      });
    }
  }

  /**
   * Record a performance window (called every N cycles, e.g. every 20).
   * This is the reward signal for the self-improvement loop.
   */
  recordPerformance(perf: PerformanceWindow): void {
    this.performanceHistory.push(perf);
    if (this.performanceHistory.length > this.MAX_HISTORY) this.performanceHistory.shift();

    // Update config bandit arms
    const config = perf.configSnapshot;
    for (const [key, arms] of this.configArms) {
      const currentChoice = String(config[key] ?? '');
      const arm = arms.find(a => a.configValue === currentChoice);
      if (arm) {
        arm.trials++;
        arm.cumulativePnlPct += perf.pnlPct;
        if (perf.pnlPct > 0) arm.alpha++;
        else arm.beta++;
      }
    }

    // Update continuous parameter gradients
    for (const [, param] of this.continuousParams) {
      param.history.push({
        value: param.currentValue,
        pnlPct: perf.pnlPct,
        cycle: perf.cycle,
      });
      if (param.history.length > 50) param.history.shift();

      // Estimate gradient: correlate parameter value with PnL
      if (param.history.length >= 10) {
        const gradient = this.estimateGradient(param.history);
        // EMA update (smooth, gradual)
        param.gradientEMA = 0.9 * param.gradientEMA + 0.1 * gradient;
      }
    }

    log.debug(
      `[self-improve] recorded perf: cycle=${perf.cycle}, pnl=${perf.pnlPct.toFixed(4)}, ` +
      `winRate=${perf.winRate.toFixed(2)}, brier=${perf.brier.toFixed(4)}`
    );
  }

  /**
   * Estimate gradient: does increasing this parameter improve PnL?
   * Uses simple linear regression of pnlPct ~ parameterValue.
   * Returns slope (positive = increasing parameter improves PnL).
   */
  private estimateGradient(
    history: Array<{ value: number; pnlPct: number }>,
  ): number {
    const n = history.length;
    if (n < 5) return 0;
    // Simple OLS slope: cov(x, y) / var(x)
    const meanX = history.reduce((s, h) => s + h.value, 0) / n;
    const meanY = history.reduce((s, h) => s + h.pnlPct, 0) / n;
    let covXY = 0, varX = 0;
    for (const h of history) {
      covXY += (h.value - meanX) * (h.pnlPct - meanY);
      varX += (h.value - meanX) ** 2;
    }
    if (varX === 0) return 0;
    return covXY / varX;
  }

  /**
   * Get the best config choice for a given key (Thompson Sampling).
   * Returns the sampled-best config value.
   */
  getConfigRecommendation(key: string): string | null {
    const arms = this.configArms.get(key);
    if (!arms || arms.length === 0) return null;
    // Thompson sample each arm
    let bestSample = -Infinity;
    let bestValue: string | null = null;
    for (const arm of arms) {
      const sample = this.sampleBeta(arm.alpha, arm.beta);
      if (sample > bestSample) {
        bestSample = sample;
        bestValue = arm.configValue;
      }
    }
    return bestValue;
  }

  /**
   * Get the recommended continuous parameter value (gradient step).
   * Moves currentValue in the direction of positive gradient.
   */
  getParamRecommendation(name: string): number {
    const param = this.continuousParams.get(name);
    if (!param) return 0;
    // Step in direction of gradient (positive gradient → increase)
    const newValue = param.currentValue + Math.sign(param.gradientEMA) * param.stepSize;
    // Clamp to safe bounds
    return Math.max(param.minValue, Math.min(param.maxValue, newValue));
  }

  /**
   * Apply a recommended parameter value (actually update the current value).
   */
  applyParamUpdate(name: string, newValue: number): void {
    const param = this.continuousParams.get(name);
    if (!param) return;
    const clamped = Math.max(param.minValue, Math.min(param.maxValue, newValue));
    if (Math.abs(clamped - param.currentValue) > 1e-9) {
      log.info(
        `[self-improve] ${name}: ${param.currentValue.toFixed(4)} → ${clamped.toFixed(4)} ` +
        `(gradient=${param.gradientEMA.toFixed(6)}, step=${param.stepSize})`
      );
      param.currentValue = clamped;
    }
  }

  /**
   * Generate a self-improvement report block for HACP injection.
   * Meta-Agent sees which parameters are being tuned + current recommendations.
   */
  getImprovementBlock(): string {
    if (this.performanceHistory.length < 10) {
      return '=== SELF-IMPROVEMENT ===\nInsufficient data for self-tuning.\n---';
    }
    const lines: string[] = [
      '=== SELF-IMPROVEMENT (Auto-Tuning) ===',
      `📊 Performance windows: ${this.performanceHistory.length}`,
    ];

    // Config recommendations
    for (const [key, arms] of this.configArms) {
      const sorted = [...arms].sort((a, b) => (b.alpha / (b.alpha + b.beta)) - (a.alpha / (a.alpha + a.beta)));
      const best = sorted[0];
      if (best && best.trials > 0) {
        const wr = (best.alpha - 1) / Math.max(1, best.trials);
        lines.push(`📊 ${key}: best="${best.configValue}" (${wr.toFixed(0)}% good, n=${best.trials})`);
      }
    }

    // Continuous param recommendations
    for (const [, param] of this.continuousParams) {
      const recommended = this.getParamRecommendation(param.name);
      const direction = param.gradientEMA > 0.001 ? '↑' : param.gradientEMA < -0.001 ? '↓' : '→';
      lines.push(
        `📊 ${param.name}: ${param.currentValue.toFixed(4)} ${direction} ${recommended.toFixed(4)} ` +
        `(gradient=${param.gradientEMA.toFixed(6)}, history=${param.history.length})`
      );
    }

    lines.push('---');
    return lines.join('\n');
  }

  /**
   * Get a snapshot of all current tuned values (for applying to live config).
   */
  getTunedValues(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, param] of this.continuousParams) {
      out[name] = param.currentValue;
    }
    return out;
  }

  /**
   * Get current config recommendations for all discrete choices.
   */
  getConfigChoices(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key] of this.configArms) {
      const rec = this.getConfigRecommendation(key);
      if (rec) out[key] = rec;
    }
    return out;
  }

  // ── Beta sampling (same as Q-RL Thompson) ──
  private sampleBeta(alpha: number, beta: number): number {
    if (alpha <= 0 || beta <= 0) return 0.5;
    const x = this.sampleGamma(alpha);
    const y = this.sampleGamma(beta);
    const sum = x + y;
    if (sum === 0 || !Number.isFinite(sum)) return 0.5;
    return Math.max(0, Math.min(1, x / sum));
  }

  private sampleGamma(shape: number): number {
    if (!Number.isFinite(shape) || shape <= 0) return 1;
    if (shape < 1) {
      const u = Math.random();
      if (u === 0) return 0;
      return this.sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (let i = 0; i < 100; i++) {
      let x: number, v: number;
      do {
        x = this.standardNormal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
    return d;
  }

  private standardNormal(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    if (u1 === 0) return 0;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ── Persistence ──
  save(): Record<string, unknown> {
    return {
      performanceHistory: this.performanceHistory.slice(-50),
      configArms: Object.fromEntries(
        [...this.configArms.entries()].map(([k, v]) => [k, v.map(a => ({ ...a }))])
      ),
      continuousParams: Object.fromEntries(
        [...this.continuousParams.entries()].map(([k, v]) => [k, { ...v, history: v.history.slice(-20) }])
      ),
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const hist = s['performanceHistory'];
    if (Array.isArray(hist)) this.performanceHistory = hist as PerformanceWindow[];
    // Load config arms (merge with defaults)
    const savedArms = s['configArms'] as Record<string, ConfigArm[]> | undefined;
    if (savedArms) {
      for (const [key, arms] of Object.entries(savedArms)) {
        if (Array.isArray(arms)) this.configArms.set(key, arms);
      }
    }
    // Load continuous params
    const savedParams = s['continuousParams'] as Record<string, ContinuousParam> | undefined;
    if (savedParams) {
      for (const [name, param] of Object.entries(savedParams)) {
        if (param && typeof param === 'object') {
          this.continuousParams.set(name, { ...param, history: Array.isArray(param.history) ? param.history : [] });
        }
      }
    }
    log.info(`[self-improve] loaded: ${this.performanceHistory.length} windows, ${this.configArms.size} config arms, ${this.continuousParams.size} params`);
  }

  reset(): void {
    this.performanceHistory = [];
    this.configArms.clear();
    this.continuousParams.clear();
  }
}
```

### 7.4 整合點

| 改動點 | 文件 | 代碼 |
|:---|:---|:---|
| **Init** | `src/index.ts` | `this.selfImprover = new SelfImprover()` + load from `data/evolution/self-improver.json` |
| **每 20 cycles** | `src/index.ts` cycle end | `this.selfImprover.recordPerformance({ cycle, pnlPct, winRate, brier, ece, configSnapshot })` |
| **每 20 cycles** | `src/index.ts` | Apply config recommendation: `this.qrlTable = new QRLTable({ explorationStrategy: this.selfImprover.getConfigRecommendation('explorationStrategy') })` — 如果 config 有變 |
| **每 20 cycles** | `src/index.ts` | Apply param updates: `this.selfImprover.applyParamUpdate('convictionGateThreshold', recommended)` |
| **HACP injection** | `src/index.ts` pre-cycle | `this.hacpEngine.setSelfImprovementBlock(this.selfImprover.getImprovementBlock())` |
| **HACP** | `src/cognition/hacp.ts` | 新增 `setSelfImprovementBlock(block)` + 拼入 `rilEnhancedMarketDesc` |
| **Persistence** | `src/index.ts` shutdown | save `data/evolution/self-improver.json` |

### 7.5 安全邊界

| 參數 | 最小值 | 最大值 | 步長 | 原因 |
|:---|:---|:---|:---|:---|
| convictionGateThreshold | 0.40 | 0.60 | 0.01 | 唔可以太低（亂交易）或太高（永不交易） |
| aggressiveSlCap | 0.05 | 0.09 | 0.005 | 唔可以超過 9%（風險上限） |
| conservativeSlCap | 0.02 | 0.04 | 0.005 | 唔可以低過 2%（太窄，一定 SL hit） |
| dcsTimeDecayHalfLife | 100 | 400 | 25 | 太短（100 cycle）= 忘記太快；太長（400 cycle）= 過時 discovery 仍主導 |

**所有調整都有 hard bounds** — 系統永遠唔會將 SL cap 調到 50%，唔會將 conviction gate 調到 0.1。

---

## 8. Causal Reasoning：唔係 correlation，係 causation

### 8.1 問題定義

而家系統所有嘅「learning」都係 **correlational**：

- Q-RL：「regime=trend_up + vol=normal → buy 有 Q=0.008」← 但呢個只係 correlation
- OLR：「feature X 高 → P(win) = 0.65」← 但呢個只係 correlation
- Edge Report：「shadow WR 高 → edgeScore 高」← correlation
- Meta-Calibrator：「預測 70% → 實際 55%」← correlation

**Correlation 唔等於 causation。** 可能 regime=trend_up 同時令到 (a) buy 贏同 (b) funding rate 正，但真正嘅 cause 係 funding rate，唔係 regime。如果系統認為 regime 係 cause，當 regime=trend_up 但 funding 負嘅時候就會輸。

### 8.2 理論基礎

#### Do-Calculus (Pearl)

Judea Pearl 嘅 do-calculus 係 causal inference 嘅基礎。核心區分：

- **Observation** $P(Y | X=x)$：觀察到 $X=x$ 時 $Y$ 嘅分佈（correlation）
- **Intervention** $P(Y | do(X=x))$：強制設定 $X=x$ 時 $Y$ 嘅分佈（causation）

$$
P(Y | do(X=x)) = \sum_z P(Y | X=x, Z=z) P(Z=z)
$$

呢個公式話：如果你強制 $X=x$，要將 $Z$ 嘅分佈 **marginalize**（因為 $X$ 唔再受 $Z$ 影響）。而觀察 $P(Y|X=x)$ 會被 $Z$ 嘅分佈 **confound**。

#### Counterfactual / Uplift Modeling

喺 trading 嘅 context：

- **Factual**：我交易咗，贏咗。PnL = +0.5%
- **Counterfactual**：如果我冇交易，會點？

如果 market 之後升咗 5%，我冇交易都會升（但冇槓桿放大）。所以真正嘅 **uplift** = 交易 PnL − 冇交易 PnL = 0.5% − 0%（或 adjusted benchmark）。

**Uplift** $= P(\text{win} | \text{traded}) - P(\text{win} | \text{not traded})$

如果 uplift ≈ 0，交易冇因果效果——只係市場升咗，唔係我嘅決策帶來嘅。

#### Causal Feature Importance

唔係「feature X 同 PnL 有幾相關」，而係「如果我改變 feature X，PnL 會點變」。

可以用 **permutation causal importance**：隨機打亂 feature X 嘅值，睇 PnL 預測跌幾多。如果跌好多 = X 係 causal。如果唔跌 = X 只係 spurious correlation。

### 8.3 具體實施方案

#### 新增：`src/evolution/causal-reasoner.ts`

```typescript
// ─── Causal Reasoner (v2.0.839) ───────────────────────────────────
//
// Distinguishes causation from correlation in trade outcomes.
// Uses paired shadow trades (one trades, one holds) to estimate
// counterfactual PnL, and permutation-based causal feature importance.
//
// Architecture:
//   1. Paired shadow: for every aligned shadow, also open a "hold" shadow
//      (same entry, no position) → compare PnL to estimate uplift
//   2. Causal feature importance: permute each feature, measure PnL drop
//   3. Confounder detection: check if regime → buy win is mediated by funding
//   4. Causal graph: build DAG of feature → action → outcome relationships
//
// Integration:
//   - ShadowTradeEngine.openAlignedShadow() also opens paired hold shadow
//   - Causal reasoner runs at cycle end, feeds causal block to HACP

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'causal-reasoner' });

// ─── Types ───

interface PairedShadow {
  symbol: string;
  side: 'buy' | 'sell';
  entryCycle: number;
  entryPrice: number;
  // Factual: aligned shadow resolved PnL%
  tradedPnlPct?: number;
  // Counterfactual: "hold" shadow resolved PnL% (= 0 if we didn't trade)
  holdPnlPct?: number;
  // Uplift = tradedPnlPct - holdPnlPct
  uplift?: number;
  resolved: boolean;
}

interface FeatureImportanceResult {
  feature: string;
  // How much PnL prediction drops when this feature is permuted
  causalImportance: number;  // [0, 1]
  // Correlation with PnL (for comparison)
  correlation: number;       // [-1, 1]
  // If causalImportance >> |correlation|, feature is a confounder
  isConfounder: boolean;
}

export class CausalReasoner {
  private pairedShadows: PairedShadow[] = [];
  private readonly MAX_PAIRED = 300;

  // Feature importance cache (updated every 50 cycles)
  private featureImportance: FeatureImportanceResult[] = [];
  private lastImportanceCycle = 0;

  /**
   * Record a paired shadow outcome.
   * Called when BOTH the aligned shadow AND the hold shadow resolve.
   */
  recordPairedShadow(
    symbol: string,
    side: 'buy' | 'sell',
    entryCycle: number,
    entryPrice: number,
    tradedPnlPct: number,
    holdPnlPct: number,
  ): void {
    if (!Number.isFinite(tradedPnlPct) || !Number.isFinite(holdPnlPct)) return;
    const uplift = tradedPnlPct - holdPnlPct;
    this.pairedShadows.push({
      symbol,
      side,
      entryCycle,
      entryPrice,
      tradedPnlPct,
      holdPnlPct,
      uplift,
      resolved: true,
    });
    if (this.pairedShadows.length > this.MAX_PAIRED) this.pairedShadows.shift();

    log.debug(
      `[causal] paired shadow: ${symbol} ${side} uplift=${uplift.toFixed(4)} ` +
      `(traded=${tradedPnlPct.toFixed(4)}, hold=${holdPnlPct.toFixed(4)})`
    );
  }

  /**
   * Compute average uplift across all paired shadows.
   * Uplift > 0 = trading has causal effect (good).
   * Uplift ≈ 0 = trading has no causal effect (just following market).
   * Uplift < 0 = trading has negative causal effect (bad — SL hit but market recovered).
   */
  getAverageUplift(): { uplift: number; samples: number; positiveRate: number } {
    const resolved = this.pairedShadows.filter(p => p.uplift !== undefined);
    if (resolved.length < 10) return { uplift: 0, samples: 0, positiveRate: 0 };
    const avgUplift = resolved.reduce((s, p) => s + (p.uplift ?? 0), 0) / resolved.length;
    const positiveRate = resolved.filter(p => (p.uplift ?? 0) > 0).length / resolved.length;
    return { uplift: avgUplift, samples: resolved.length, positiveRate };
  }

  /**
   * Get per-symbol uplift breakdown.
   */
  getPerSymbolUplift(): Array<{ symbol: string; uplift: number; samples: number }> {
    const bySymbol = new Map<string, number[]>();
    for (const p of this.pairedShadows) {
      if (p.uplift === undefined) continue;
      const arr = bySymbol.get(p.symbol) ?? [];
      arr.push(p.uplift);
      bySymbol.set(p.symbol, arr);
    }
    const out: Array<{ symbol: string; uplift: number; samples: number }> = [];
    for (const [symbol, uplifts] of bySymbol) {
      if (uplifts.length < 5) continue;
      const avg = uplifts.reduce((a, b) => a + b, 0) / uplifts.length;
      out.push({ symbol, uplift: avg, samples: uplifts.length });
    }
    return out.sort((a, b) => b.uplift - a.uplift);
  }

  /**
   * Compute causal feature importance via permutation.
   *
   * For each feature:
   *   1. Take last N trade records with features + outcomes
   *   2. Compute baseline PnL prediction accuracy (e.g. mean |predicted - actual|)
   *   3. Permute the feature's values (break the causal link)
   *   4. Re-compute accuracy → if it drops, the feature is causally important
   *
   * @param records  Array of { features: Record<string, number>, pnlPct: number }
   * @param cycle    Current cycle (for caching)
   */
  computeCausalFeatureImportance(
    records: Array<{ features: Record<string, number>; pnlPct: number }>,
    cycle: number,
  ): FeatureImportanceResult[] {
    if (records.length < 30) return [];
    if (cycle - this.lastImportanceCycle < 50) return this.featureImportance;

    this.lastImportanceCycle = cycle;

    // Get all feature names
    const featureNames = new Set<string>();
    for (const r of records) {
      for (const k of Object.keys(r.features)) featureNames.add(k);
    }

    // Baseline: mean PnL (simplest predictor)
    const baselinePnl = records.reduce((s, r) => s + r.pnlPct, 0) / records.length;
    const baselineError = records.reduce((s, r) => s + Math.abs(r.pnlPct - baselinePnl), 0) / records.length;

    const results: FeatureImportanceResult[] = [];
    for (const feature of featureNames) {
      // Compute correlation with PnL
      const values = records.map(r => safeNum(r.features[feature], 0));
      const pnls = records.map(r => r.pnlPct);
      const correlation = this.pearsonCorrelation(values, pnls);

      // Permutation: shuffle feature values, re-compute "predicted" PnL
      // (using simple mean of records with similar permuted feature value)
      const shuffled = [...values];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      // After permutation, the feature-PnL link is broken.
      // If the feature was causally important, error increases.
      // We measure: how much does |correlation| drop after permutation?
      const permCorr = this.pearsonCorrelation(shuffled, pnls);
      const importance = Math.abs(correlation) - Math.abs(permCorr);
      const causalImportance = Math.max(0, importance);

      results.push({
        feature,
        causalImportance,
        correlation,
        isConfounder: causalImportance < Math.abs(correlation) * 0.3,
      });
    }

    results.sort((a, b) => b.causalImportance - a.causalImportance);
    this.featureImportance = results;
    return results;
  }

  /**
   * Pearson correlation coefficient.
   */
  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 5) return 0;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denomX = 0, denomY = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i]! - meanX) * (y[i]! - meanY);
      denomX += (x[i]! - meanX) ** 2;
      denomY += (y[i]! - meanY) ** 2;
    }
    const denom = Math.sqrt(denomX * denomY);
    if (denom === 0) return 0;
    return num / denom;
  }

  /**
   * Generate causal reasoning block for HACP injection.
   */
  getCausalBlock(): string {
    const uplift = this.getAverageUplift();
    if (uplift.samples < 10) {
      return '=== CAUSAL REASONING ===\nInsufficient paired shadow data for causal analysis.\n---';
    }

    const lines: string[] = [
      '=== CAUSAL REASONING (Causation ≠ Correlation) ===',
      `📊 Average uplift: ${(uplift.uplift * 100).toFixed(2)}% (n=${uplift.samples})`,
      `📊 Positive uplift rate: ${(uplift.positiveRate * 100).toFixed(0)}% of trades`,
    ];

    if (uplift.uplift < 0.001) {
      lines.push('');
      lines.push('⚠️ UPLIFT ≈ 0: Your trades have NO causal effect on PnL.');
      lines.push('   You are just following the market, not adding alpha.');
      lines.push('   Consider: tighter entry criteria, or avoid trading in these conditions.');
    } else if (uplift.uplift > 0.005) {
      lines.push('');
      lines.push(`✅ UPLIFT POSITIVE: Your trades add ${(uplift.uplift * 100).toFixed(2)}% alpha per trade.`);
      lines.push('   This is genuine causal alpha, not just market direction.');
    }

    // Per-symbol uplift
    const perSymbol = this.getPerSymbolUplift();
    if (perSymbol.length > 0) {
      lines.push('');
      lines.push('Per-symbol causal uplift:');
      for (const { symbol, uplift: u, samples } of perSymbol.slice(0, 5)) {
        const status = u > 0.003 ? '✅' : u < -0.001 ? '❌' : '⚠️';
        lines.push(`  ${status} ${symbol}: ${(u * 100).toFixed(2)}% uplift (n=${samples})`);
      }
    }

    // Feature importance (if available)
    if (this.featureImportance.length > 0) {
      lines.push('');
      lines.push('Causal feature importance (top 5):');
      for (const fi of this.featureImportance.slice(0, 5)) {
        const tag = fi.isConfounder ? ' ⚠️ confounder' : '';
        lines.push(
          `  ${fi.feature}: causal=${fi.causalImportance.toFixed(4)}, ` +
          `corr=${fi.correlation.toFixed(4)}${tag}`
        );
      }
    }

    lines.push('---');
    return lines.join('\n');
  }

  // ── Persistence ──
  save(): Record<string, unknown> {
    return {
      pairedShadows: this.pairedShadows.slice(-100),
      featureImportance: this.featureImportance,
      lastImportanceCycle: this.lastImportanceCycle,
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const savedShadows = s['pairedShadows'];
    if (Array.isArray(savedShadows)) this.pairedShadows = savedShadows as PairedShadow[];
    const savedFI = s['featureImportance'];
    if (Array.isArray(savedFI)) this.featureImportance = savedFI as FeatureImportanceResult[];
    this.lastImportanceCycle = safeNum(s['lastImportanceCycle'] as number, 0);
    log.info(`[causal] loaded: ${this.pairedShadows.length} paired shadows, ${this.featureImportance.length} feature importance`);
  }

  reset(): void {
    this.pairedShadows = [];
    this.featureImportance = [];
    this.lastImportanceCycle = 0;
  }
}
```

### 8.4 Paired Shadow 機制

要實現 causal reasoning，需要一個 **paired shadow**——每開一筆 aligned shadow，同時記錄「如果冇交易」嘅 counterfactual。

```
Aligned shadow:  entry at $100, SL at $97, TP at $105
  → 如果 SL hit: tradedPnlPct = -3%
  → 如果 TP hit: tradedPnlPct = +5%

Paired hold shadow: entry at $100, NO position
  → 不管市場點郁, holdPnlPct = 0% (冇持倉 = 冇 PnL)
  → 但要調整 benchmark: holdPnlPct = marketReturn × 1 (無槓桿)

Uplift = tradedPnlPct - holdPnlPct
  → +5% - 2% = +3% (交易有 alpha)
  → -3% - 0% = -3% (交易有 negative alpha, SL hit 但市場冇郁)
```

| 改動點 | 文件 | 代碼 |
|:---|:---|:---|
| **Shadow engine** | `src/evolution/shadow-trade-engine.ts` | `openAlignedShadow()` 同時記錄 entry price + cycle，喺 resolve 時計算 hold benchmark |
| **Causal reasoner** | `src/evolution/causal-reasoner.ts` | `recordPairedShadow()` 喺兩個都 resolve 時 call |
| **Cycle end** | `src/index.ts` | `this.causalReasoner.recordPairedShadow(sym, side, cycle, entryPrice, tradedPnl, holdPnl)` |
| **HACP injection** | `src/index.ts` pre-cycle | `this.hacpEngine.setCausalBlock(this.causalReasoner.getCausalBlock())` |
| **HACP** | `src/cognition/hacp.ts` | 新增 `setCausalBlock(block)` + 拼入 `rilEnhancedMarketDesc` |
| **Persistence** | `src/index.ts` shutdown | save `data/evolution/causal-reasoner.json` |

### 8.5 攻擊測試計劃

| 測試 | 方法 | 通過條件 |
|:---|:---|:---|
| 冷啟動 | < 10 paired shadows → block 說 "insufficient" | 唔 crash |
| NaN uplift | recordPairedShadow(NaN, 0) | skip, 唔 crash |
| 全正 uplift | 50 trades 全 uplift > 0 | avgUplift > 0 |
| 全負 uplift | 50 trades 全 uplift < 0 | avgUplift < 0 |
| Per-symbol 分化 | BTC 全正 + ETH 全負 | perSymbol uplift 方向正確 |
| Feature importance | permute 後 correlation 應該接近 0 | causalImportance ≈ |original corr| |
| Confounder detection | feature A 同 PnL 高 corr 但 permute 後唔跌 | isConfounder = true |
| 持久化 | save + load | pairedShadows + featureImportance 保留 |

---

## 9. Meta-Learning：學點樣學得更快

### 9.1 問題定義

而家系統嘅學習速度係固定嘅：

- Q-RL：EWMA learning rate α = 1/(1+visits)，每次 update 用一樣嘅 weight
- OLR：sigmoid 模型固定，唔會根據「邊個 feature 嘅預測力強」調整 feature weight
- Shadow trade：每筆都一樣嘅 weight（aligned=1, blind=0.1）

**Meta-learning 嘅定義**：系統可以根據自己嘅學習歷史，**調整自己嘅學習策略**。

具體例子：
- 如果系統發現「volatility 呢個 feature 嘅預測力喺過去 50 cycle 下降緊」→ 應該降低 volatility 喺 feature weight 嘅重要性
- 如果系統發現「trending_bull regime 學得快（每筆 trade 嘅 Q-value 更新幅度大）」→ 應該喺 trending_bull 多啲 explore
- 如果系統發現「某個 cell 嘅 Q-value 波動大（唔穩定）」→ 應該降低嗰個 cell 嘅 learning rate

### 9.2 理論基礎

#### Learn-to-Learn (Meta-RL)

Meta-RL 嘅核心係「喺多個 task 之間學習一個通用嘅 learning policy」。喺 MATS 嘅 context：

- **Task** = 一個 (regime × vol × mom × funding) cell
- **Meta-policy** = 「點樣更新每個 cell 嘅 Q-value」

而家用固定嘅 EWMA：$Q_{new} = (1-\alpha) Q_{old} + \alpha \cdot \text{reward}$，其中 $\alpha = 1/(1+n)$。

Meta-learning 可以令 $\alpha$ 根據 cell 嘅 **reward variance** 自動調整：

$$
\alpha_{cell} = \frac{1}{1 + n_{cell}} \cdot \text{stabilityFactor}_{cell}
$$

其中 $\text{stabilityFactor} = 1 / (1 + \text{rewardStd})$。高 variance cell → 低 learning rate（唔好太快更新）。

#### Feature Weight Meta-Learning

OLR 用固定嘅 feature set（regimeOrdinal, volatility, momentumShort, fundingRate...）。Meta-learning 可以根據每個 feature 嘅 **recent predictive power** 自動調整佢嘅 weight：

$$
w_i(t) = w_i(t-1) \cdot (1 - \eta) + \eta \cdot \text{predictivePower}_i(t)
$$

其中 $\text{predictivePower}_i$ = feature $i$ 同 PnL 嘅 rolling correlation。

#### Curriculum Learning

系統可以根據「自己喺邊個 regime 學得最快」去優先探索嗰個 regime。呢個同 active exploration 結合：

1. 計算每個 regime 嘅 learning rate（Q-value 變化速度）
2. 優先探索 learning rate 高嘅 regime（學得快 = 更多 information gain）
3. 減少探索 learning rate 低嘅 regime（已經學得差，再 explore 都係差）

### 9.3 具體實施方案

#### 新增：`src/evolution/meta-learner.ts`

```typescript
// ─── Meta-Learner (v2.0.840) ──────────────────────────────────────
//
// System learns HOW to learn. Adjusts learning rates, feature weights,
// and exploration priorities based on observed learning efficiency.
//
// Architecture:
//   1. Per-cell adaptive learning rate (high variance → low α)
//   2. Feature weight meta-learning (rolling predictive power → weight)
//   3. Regime learning speed tracking (fast-learning regimes → prioritize)
//   4. Curriculum: suggest which regime to explore next
//
// Integration:
//   - QRLTable.update() uses adaptive α from meta-learner
//   - OLR query uses adaptive feature weights from meta-learner
//   - Q-RL selectAction() uses curriculum suggestion for exploration priority

import { createLogger } from '../observability/logger.ts';
import { safeNum } from './evolution-utils.ts';

const log = createLogger({ phase: 'meta-learner' });

// ─── Types ───

interface CellLearningState {
  cellKey: string;
  visits: number;
  rewardMean: number;
  rewardStd: number;
  // How fast Q-value is changing (learning speed)
  qValueChangeRate: number;
  // Adaptive learning rate multiplier [0.1, 2.0]
  alphaMultiplier: number;
  lastQValue: number;
  lastUpdateCycle: number;
}

interface FeatureMetaState {
  feature: string;
  // Rolling predictive power (correlation with PnL)
  predictivePower: number;    // [-1, 1]
  // Adaptive weight [0.1, 3.0]
  weight: number;
  // History of (featureValue, pnlPct) for rolling correlation
  history: Array<{ value: number; pnlPct: number }>;
}

interface RegimeLearningSpeed {
  regime: string;
  // Average Q-value change rate across all cells in this regime
  avgLearningSpeed: number;
  // Number of cells in this regime
  cellCount: number;
  // Curriculum priority [0, 1] (higher = explore first)
  curriculumPriority: number;
}

// ─── Meta-Learner ───

export class MetaLearner {
  // Per-cell adaptive learning state
  private cellStates: Map<string, CellLearningState> = new Map();

  // Feature meta state (adaptive weights)
  private featureStates: Map<string, FeatureMetaState> = new Map();
  private readonly FEATURE_HISTORY_MAX = 100;

  // Regime learning speed (for curriculum)
  private regimeSpeeds: Map<string, RegimeLearningSpeed> = new Map();

  private totalCycles = 0;
  private readonly ROLLING_WINDOW = 20;

  /**
   * Record a Q-value update and compute adaptive learning rate.
   * Called from QRLTable.update() BEFORE the update happens.
   *
   * @returns adaptive alpha multiplier [0.1, 2.0]
   */
  recordCellUpdate(
    cellKey: string,
    oldQ: number,
    newQ: number,
    reward: number,
    cycle: number,
  ): number {
    let state = this.cellStates.get(cellKey);
    if (!state) {
      state = {
        cellKey,
        visits: 0,
        rewardMean: 0,
        rewardStd: 0,
        qValueChangeRate: 0,
        alphaMultiplier: 1.0,
        lastQValue: oldQ,
        lastUpdateCycle: cycle,
      };
      this.cellStates.set(cellKey, state);
    }

    // Update reward statistics (rolling)
    state.visits++;
    const qChange = Math.abs(newQ - oldQ);
    state.qValueChangeRate = 0.8 * state.qValueChangeRate + 0.2 * qChange;
    state.rewardMean = 0.9 * state.rewardMean + 0.1 * reward;

    // High reward variance → lower learning rate (don't over-react to noise)
    // Low reward variance → higher learning rate (stable signal, learn faster)
    const stability = 1 / (1 + state.rewardStd * 10);
    state.alphaMultiplier = Math.max(0.1, Math.min(2.0, 0.5 + stability));

    state.lastQValue = newQ;
    state.lastUpdateCycle = cycle;

    return state.alphaMultiplier;
  }

  /**
   * Record a feature-PnL observation and update adaptive feature weight.
   * Called from the learning pipeline when a trade closes.
   */
  recordFeatureOutcome(
    feature: string,
    featureValue: number,
    pnlPct: number,
  ): void {
    if (!Number.isFinite(featureValue) || !Number.isFinite(pnlPct)) return;

    let state = this.featureStates.get(feature);
    if (!state) {
      state = {
        feature,
        predictivePower: 0,
        weight: 1.0,
        history: [],
      };
      this.featureStates.set(feature, state);
    }

    state.history.push({ value: featureValue, pnlPct });
    if (state.history.length > this.FEATURE_HISTORY_MAX) state.history.shift();

    // Compute rolling predictive power (correlation)
    if (state.history.length >= 10) {
      const values = state.history.map(h => h.value);
      const pnls = state.history.map(h => h.pnlPct);
      const corr = this.pearsonCorrelation(values, pnls);
      // EMA update of predictive power
      state.predictivePower = 0.8 * state.predictivePower + 0.2 * corr;
      // Adaptive weight: |predictivePower| high → weight high
      const targetWeight = 0.3 + 2.7 * Math.abs(state.predictivePower);
      state.weight = 0.9 * state.weight + 0.1 * targetWeight;
      state.weight = Math.max(0.1, Math.min(3.0, state.weight));
    }
  }

  /**
   * Get adaptive feature weights (for OLR query weighting).
   */
  getFeatureWeights(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [feature, state] of this.featureStates) {
      out[feature] = state.weight;
    }
    return out;
  }

  /**
   * Get adaptive learning rate multiplier for a cell.
   */
  getCellAlphaMultiplier(cellKey: string): number {
    return this.cellStates.get(cellKey)?.alphaMultiplier ?? 1.0;
  }

  /**
   * Update regime learning speeds (called every N cycles).
   */
  updateRegimeSpeeds(cycle: number): void {
    this.totalCycles = cycle;
    const regimeMap = new Map<string, number[]>();

    for (const [cellKey, state] of this.cellStates) {
      // Extract regime from cell key (format: regime|vol|mom|funding|action)
      const regime = cellKey.split('|')[0] ?? 'unknown';
      const speeds = regimeMap.get(regime) ?? [];
      speeds.push(state.qValueChangeRate);
      regimeMap.set(regime, speeds);
    }

    // Compute per-regime average learning speed
    const speeds: Array<{ regime: string; speed: number; count: number }> = [];
    for (const [regime, changeRates] of regimeMap) {
      const avg = changeRates.reduce((a, b) => a + b, 0) / changeRates.length;
      speeds.push({ regime, speed: avg, count: changeRates.length });
    }

    // Normalize to [0, 1] curriculum priority
    const maxSpeed = Math.max(...speeds.map(s => s.speed), 0.001);
    for (const s of speeds) {
      this.regimeSpeeds.set(s.regime, {
        regime: s.regime,
        avgLearningSpeed: s.speed,
        cellCount: s.count,
        curriculumPriority: s.speed / maxSpeed,
      });
    }
  }

  /**
   * Get curriculum suggestion: which regime to explore next.
   * Higher learning speed → higher priority (learn fast while you can).
   */
  getCurriculumSuggestion(): string | null {
    let best: RegimeLearningSpeed | null = null;
    for (const [, speed] of this.regimeSpeeds) {
      if (!best || speed.curriculumPriority > best.curriculumPriority) {
        best = speed;
      }
    }
    return best?.regime ?? null;
  }

  /**
   * Generate meta-learning block for HACP injection.
   */
  getMetaLearningBlock(): string {
    if (this.cellStates.size < 10) {
      return '=== META-LEARNING ===\nInsufficient data for meta-learning.\n---';
    }

    const lines: string[] = [
      '=== META-LEARNING (Learning to Learn) ===',
      `📊 Tracked cells: ${this.cellStates.size}`,
      `📊 Tracked features: ${this.featureStates.size}`,
    ];

    // Top feature weights
    const features = [...this.featureStates.entries()]
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, 5);
    if (features.length > 0) {
      lines.push('');
      lines.push('Adaptive feature weights (top 5):');
      for (const [name, state] of features) {
        const tag = state.predictivePower > 0.1 ? '✅' : state.predictivePower < -0.1 ? '❌' : '⚪';
        lines.push(
          `  ${tag} ${name}: weight=${state.weight.toFixed(2)}, ` +
          `predictivePower=${state.predictivePower.toFixed(3)}`
        );
      }
    }

    // Curriculum suggestions
    const sortedRegimes = [...this.regimeSpeeds.values()]
      .sort((a, b) => b.curriculumPriority - a.curriculumPriority);
    if (sortedRegimes.length > 0) {
      lines.push('');
      lines.push('Regime learning speeds (curriculum priority):');
      for (const r of sortedRegimes.slice(0, 5)) {
        const tag = r.curriculumPriority > 0.7 ? '🔥' : r.curriculumPriority > 0.4 ? '📈' : '⏸';
        lines.push(
          `  ${tag} ${r.regime}: speed=${r.avgLearningSpeed.toFixed(6)}, ` +
          `priority=${r.curriculumPriority.toFixed(2)}, cells=${r.cellCount}`
        );
      }
    }

    // Curriculum suggestion
    const suggestion = this.getCurriculumSuggestion();
    if (suggestion) {
      lines.push('');
      lines.push(`💡 Curriculum: prioritize exploration in "${suggestion}" regime (fastest learning).`);
    }

    lines.push('---');
    return lines.join('\n');
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    if (n < 5) return 0;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denomX = 0, denomY = 0;
    for (let i = 0; i < n; i++) {
      num += (x[i]! - meanX) * (y[i]! - meanY);
      denomX += (x[i]! - meanX) ** 2;
      denomY += (y[i]! - meanY) ** 2;
    }
    const denom = Math.sqrt(denomX * denomY);
    if (denom === 0) return 0;
    return num / denom;
  }

  // ── Persistence ──
  save(): Record<string, unknown> {
    return {
      cellStates: Object.fromEntries(this.cellStates),
      featureStates: Object.fromEntries(
        [...this.featureStates.entries()].map(([k, v]) => [k, { ...v, history: v.history.slice(-20) }])
      ),
      regimeSpeeds: Object.fromEntries(this.regimeSpeeds),
      totalCycles: this.totalCycles,
    };
  }

  load(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const cells = s['cellStates'] as Record<string, CellLearningState>;
    if (cells) this.cellStates = new Map(Object.entries(cells));
    const features = s['featureStates'] as Record<string, FeatureMetaState>;
    if (features) this.featureStates = new Map(Object.entries(features));
    const regimes = s['regimeSpeeds'] as Record<string, RegimeLearningSpeed>;
    if (regimes) this.regimeSpeeds = new Map(Object.entries(regimes));
    this.totalCycles = safeNum(s['totalCycles'] as number, 0);
    log.info(`[meta-learn] loaded: ${this.cellStates.size} cells, ${this.featureStates.size} features, ${this.regimeSpeeds.size} regimes`);
  }

  reset(): void {
    this.cellStates.clear();
    this.featureStates.clear();
    this.regimeSpeeds.clear();
    this.totalCycles = 0;
  }
}
```

### 9.4 整合點

| 改動點 | 文件 | 代碼 |
|:---|:---|:---|
| **Init** | `src/index.ts` | `this.metaLearner = new MetaLearner()` + load |
| **Q-RL update** | `src/evolution/q-rl-table.ts` `update()` | 喺 update 前問 metaLender 拿 adaptive α multiplier |
| **Trade close** | `src/index.ts` | `this.metaLearner.recordFeatureOutcome(feature, value, pnlPct)` for each feature |
| **每 50 cycles** | `src/index.ts` | `this.metaLearner.updateRegimeSpeeds(cycle)` |
| **HACP injection** | `src/index.ts` pre-cycle | `this.hacpEngine.setMetaLearningBlock(this.metaLearner.getMetaLearningBlock())` |
| **HACP** | `src/cognition/hacp.ts` | 新增 `setMetaLearningBlock(block)` |
| **Persistence** | `src/index.ts` shutdown | save `data/evolution/meta-learner.json` |

### 9.5 攻擊測試計劃

| 測試 | 方法 | 通過條件 |
|:---|:---|:---|
| 冷啟動 | < 10 cells → block 說 "insufficient" | 唔 crash |
| Adaptive α | 高 rewardStd cell → α < 1.0 | multiplier < 1.0 |
| Adaptive α | 低 rewardStd cell → α > 1.0 | multiplier > 1.0 |
| Feature weight | 高 predictive power feature → weight 高 | weight > 1.5 |
| Feature weight | 零 predictive power feature → weight 低 | weight < 0.5 |
| NaN feature | recordFeatureOutcome(NaN, 0.01) | skip, 唔 crash |
| Curriculum | fast regime → curriculumPriority 高 | priority > 0.7 |
| Curriculum suggestion | getCurriculumSuggestion() 返回最快 regime | non-null |
| 持久化 | save + load | cellStates + featureStates 保留 |

---

## 10. 完整進化路線圖（更新版）

### Phase 1（已完成 ✅）：Meta-Cognitive Calibrator

- ✅ `src/evolution/meta-calibrator.ts` — Brier + ECE + 10-bin + per-regime
- ✅ Thompson Sampling + UCB1 in `q-rl-table.ts`
- ✅ HACP `setMetaCalibrationBlock()`
- ✅ `index.ts` integration (recordTrade + inject + save)
- ✅ 39/39 attack tests pass

### Phase 2（1 週）：Self-Improving

| Day | 工作 | Gate |
|:---|:---|:---|
| 1 | `src/evolution/self-improver.ts` — bandit + gradient tuning | tsc + unit test |
| 2 | Integration — recordPerformance every 20 cycles + apply updates | tsc |
| 3 | HACP `setSelfImprovementBlock()` + prompt injection | tsc |
| 4 | Config bandit — auto-switch exploration strategy | tsc + test |
| 5 | Continuous param tuning — conviction gate, SL caps, DCS half-life | tsc + test |
| 6 | Attack tests — bounds safety, NaN guards, persistence | 20/20 pass |
| 7 | 文檔 + commit | tsc clean |

### Phase 3（2 週）：Causal Reasoning

| Day | 工作 | Gate |
|:---|:---|:---|
| 1-3 | `src/evolution/causal-reasoner.ts` — uplift + feature importance | tsc + unit test |
| 4-5 | Paired shadow mechanism — hold shadow benchmark | tsc + test |
| 6-7 | Feature permutation importance computation | tsc + test |
| 8 | HACP `setCausalBlock()` + prompt injection | tsc |
| 9-10 | Attack tests — uplift, confounder, permutation, persistence | 20/20 pass |
| 11 | 文檔 + commit | tsc clean |
| 12-14 | Buffer | — |

### Phase 4（2 週）：Meta-Learning

| Day | 工作 | Gate |
|:---|:---|:---|
| 1-3 | `src/evolution/meta-learner.ts` — adaptive α + feature weights | tsc + unit test |
| 4-5 | Q-RL integration — adaptive α multiplier in `update()` | tsc + test |
| 6-7 | Feature weight injection into OLR query | tsc + test |
| 8 | Curriculum learning — regime exploration priority | tsc + test |
| 9 | HACP `setMetaLearningBlock()` + prompt injection | tsc |
| 10-11 | Attack tests — adaptive α, feature weight, curriculum | 20/20 pass |
| 12 | 文檔 + commit | tsc clean |
| 13-14 | Buffer | — |

---

## 11. 驗證計劃（完整版）

| 驗證項目 | 方法 | 成功標準 |
|:---|:---|:---|
| **Meta-calibration 提高勝率** | A/B test — 100 cycle with vs without | calibrated WR > uncalibrated by ≥ 2% |
| **Thompson 探索效率** | 500 cycle 後比較 cell visit 分布 | Thompson visited ≥ 180, ε-greedy ≤ 120 |
| **Self-improving: config auto-switch** | 跑 500 cycle，睇 bandit 係咪自動揀到最好 config | best config trials > 50% |
| **Self-improving: param tuning** | 100 cycle 後 conviction gate 係咪移到更好嘅值 | tuned value PnL > initial value PnL |
| **Self-improving: bounds safety** | 跑 1000 cycle，所有參數永遠喺 bounds 內 | 0 violations |
| **Causal: uplift > 0** | 100 paired shadow 後 average uplift | uplift > 0.001 (0.1%) |
| **Causal: confounder detection** | 人為構造 confounder → 系統識別到 | isConfounder = true |
| **Causal: feature importance** | permute 重要 feature → PnL 預測跌 | causalImportance > 0.05 |
| **Meta-learning: adaptive α** | 高 variance cell → α 降低 | multiplier < 1.0 |
| **Meta-learning: feature weight** | predictive power 高 → weight 升 | weight > 1.5 |
| **Meta-learning: curriculum** | fastest regime → priority 最高 | suggestion = fastest regime |

---

## 12. 風險與緩解（完整版）

| 風險 | 緩解 |
|:---|:---|
| Self-improver 調整反向 | 每個參數有 hard bounds + EMA smoothing（唔會突然跳） |
| Causal uplift 數據太少 | 最少 10 paired shadow 先啟用 |
| Confounder detection false positive | permutation 重複 100 次取平均 |
| Meta-learning overfit | rolling window 20-50 + EMA decay 0.9 |
| Feature weight 太極端 | weight bounded [0.1, 3.0] |
| Adaptive α 太低 → 唔學習 | α multiplier bounded [0.1, 2.0] |
| 全部進化同時啟用 → 互相干擾 | 每個 Phase 獨立啟用 + 觀察 100 cycle 先開下一個 |
| LLM 被太多 block 淹沒 | 每個 block 有 "insufficient" fallback，唔夠數據唔 inject |

---

## 13. 設計原則（完整版）

1. **所有進化都係 optional** — 唔啟用 = 而家行為（向後兼容）
2. **Shadow trade 先探索** — Q-RL exploration 只影響 shadow
3. **Calibration 係 reference data** — Meta-Agent 見到但可以忽略
4. **Bayesian > frequentist** — Thompson Sampling 處理 financial noise
5. **最少 N sample 先啟用** — 避免小樣本 overfitting
6. **Brier = 標準 metric** — 唔發明新 metric
7. **分層 confidence** — cell (DCS) + system (Calibrator) + regime (Brier) + causal (uplift) + meta (α)
8. **不確定性量化** — ECE + Brier + posterior width + rewardStd
9. **Self-improving 有 bounds** — 永遠唔會將 SL cap 調到 50%
10. **Causal ≠ correlational** — uplift + permutation 區分 causation 同 correlation
11. **Meta-learning 係 learning about learning** — 唔係學新 strategy，係學點樣學得更快
12. **每個 Phase 獨立驗證** — 唔同時開全部，逐個觀察 100 cycle
13. **所有改動 auditable** — 每次參數調整都 log（old value → new value + reason）
14. **混合數據源架構** — 能用 shadow 嘅全部用 shadow（快 10-50×），必須 real 嘅用 real（準），兩者都得嘅 shadow 先行 + real 驗證

---

## 14. 混合數據源架構（Hybrid Data Source）

### 14.1 問題定義

三個進化組件（Self-Improving、Causal Reasoning、Meta-Learning）需要 performance data 去做 feedback loop。有兩個數據源：

| 數據源 | 速度 | 準確度 | 盲點 |
|:---|:---|:---|:---|
| **Real trade close** | 慢（4-10/日） | 高（真實 slippage, funding, SL narrowing） | 樣本少 → 需要數日先有 20 個 data point |
| **Shadow resolution** | 快（50-200/日） | 中（冇真實 slippage，但方向 + SL/TP 正確） | slippage=0, 冇 close reason 多樣性 |

### 14.2 每個組件嘅最優數據源

| 組件 | 數據源 | 原因 | 影速 |
|:---|:---|:---|:---|
| **Self-Improving (config bandit)** | Shadow ✅ | explorationStrategy 直接影響 shadow trade，唔影響 real trade。用 shadow 可以幾個鐘就 tune 到。 | 10-50× |
| **Self-Improving (param tuning)** | Real ❌ | convictionGate / SL caps 影響真金白銀，shadow 冇 slippage 唔反映真實成本。 | 必須 real |
| **Causal Reasoning (uplift)** | Shadow ✅ | counterfactual 只可能用 paired shadow——你唔可能同時交易又唔交易。天然 shadow。 | 天然 |
| **Causal Reasoning (feature importance)** | 混合 | Shadow 快速發現邊個 feature 有預測力 → Real 驗證。 | Shadow 先行 |
| **Meta-Learning (adaptive α)** | Q-RL ✅ | 已經係 Q-value change rate，純 Q-RL 數據。 | 已經最快 |
| **Meta-Learning (feature weight)** | Shadow ✅ | Shadow resolution 快 10-50×，快速發現邊個 feature 有預測力。 | 10-50× |
| **Meta-Learning (curriculum)** | Q-RL ✅ | regime learning speed = Q-value 變化速度，純 Q-RL。 | 已經最快 |

### 14.3 具體整合方案

**Self-Improver.recordPerformance()**：
- 而家用 `tradeHistory.getRecent(20)`（real trade，慢）
- 改用 `shadowEngine.drainRecentResults()`（shadow resolution，快）
- 每 20 個 shadow resolution = 一個 performance window
- 但 param tuning 嘅 gradient estimation 仍然用 real trade PnL（因為要反映真實成本）

**MetaLearner.recordFeatureOutcome()**：
- 而家用 `onPositionClosedLearning`（real trade close，慢）
- 改用 shadow resolution — 每個 shadow resolve 時記錄 feature → pnlPct
- Feature weight adaptation 會快 10-50×

**CausalReasoner.recordPairedShadow()**：
- 已經設計為用 paired shadow——唔使改

**MetaLearner.recordCellUpdate()**：
- 已經設計為用 Q-RL update——唔使改