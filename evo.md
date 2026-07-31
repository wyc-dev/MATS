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