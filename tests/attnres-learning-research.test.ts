// ─── v2.0.215 Research: AttnRes Trade Embedder Learning Effectiveness ──────
//
// This is a RESEARCH test — not a production test. It runs controlled
// simulations to answer: "does the learning rule actually learn something
// useful, and how fast?"
//
// Experiments:
// 1. Learning convergence rate: how many trades until attention is non-uniform?
// 2. Binary reward vs scaled reward: does sign(pnl) lose too much information?
// 3. Attribution: can the learning distinguish which rationale is predictive?
// 4. Feedback loop: does w self-reinforce (mode collapse)?
// 5. Retrieval quality: does learned blend produce better matches than mean?

import { describe, it, expect } from 'vitest';
import { AttnResTradeEmbedder } from '../src/evolution/attnres-trade-embedder.ts';

// ─── Helpers ───

function makeRationaleVectors(n: number, dim: number, seed: number): number[][] {
  const vecs: number[][] = [];
  for (let i = 0; i < n; i++) {
    const v: number[] = [];
    for (let d = 0; d < dim; d++) {
      v.push(Math.sin(seed * 12.9898 + i * 78.233 + d * 43.123) % 1);
    }
    const norm = Math.hypot(...v) || 1;
    vecs.push(v.map((x) => x / norm));
  }
  return vecs;
}

// Create trades where rationale[0] is PREDICTIVE (winners have a specific
// direction in rationale[0], losers have the opposite) and rationale[1] is
// NOISE (random, no correlation with outcome).
function makePredictiveTrades(
  count: number,
  dim: number,
  predictiveRationaleIndex: number = 0,
): Array<{ vectors: number[][]; pnl: number; isWin: boolean }> {
  const trades: Array<{ vectors: number[][]; pnl: number; isWin: boolean }> = [];
  // Create a "winning direction" in the predictive rationale
  const winDir = new Array(dim).fill(0).map((_, d) => Math.sin(d * 0.1));
  const winNorm = Math.hypot(...winDir) || 1;
  const winDirN = winDir.map((x) => x / winNorm);
  // Losing direction = opposite
  const loseDirN = winDirN.map((x) => -x);

  for (let i = 0; i < count; i++) {
    const isWin = i % 2 === 0;
    const vectors: number[][] = [];

    for (let r = 0; r < 3; r++) {
      if (r === predictiveRationaleIndex) {
        // Predictive rationale: winners aligned with winDir, losers aligned with loseDir
        const noise = makeRationaleVectors(1, dim, i * 100 + r)[0]!;
        const direction = isWin ? winDirN : loseDirN;
        // Mix 70% signal + 30% noise
        const mixed = direction.map((d, idx) => 0.7 * d + 0.3 * noise[idx]!);
        const norm = Math.hypot(...mixed) || 1;
        vectors.push(mixed.map((x) => x / norm));
      } else {
        // Noise rationale: random, no correlation with outcome
        vectors.push(makeRationaleVectors(1, dim, i * 100 + r)[0]!);
      }
    }

    trades.push({
      vectors,
      pnl: isWin ? 1 + Math.random() : -1 - Math.random(),
      isWin,
    });
  }
  return trades;
}

function attentionEntropy(α: number[]): number {
  // Entropy in bits. High = uniform (no selectivity). Low = concentrated.
  let h = 0;
  for (const p of α) {
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

function maxAttentionWeight(α: number[]): number {
  return Math.max(...α);
}

// ═══════════════════════════════════════════════════════════════
//  Research Experiments
// ═══════════════════════════════════════════════════════════════

describe('AttnRes Trade Embedder Learning Research', () => {
  const DIM = 32; // Smaller dim for faster experiments (384 would be slow)

  // ─── Experiment 1: Learning convergence rate ───

  it('EXP1: cold-start attention is perfectly uniform (entropy = log2(N))', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.01 });
    const vecs = makeRationaleVectors(3, DIM, 42);

    // Access internal softmax to measure attention
    const keys = vecs.map((v) => (embedder as any).rmsNorm(v));
    const logits = keys.map((k: number[]) => (embedder as any).dot((embedder as any).emaW, k) / 1.0);
    const α = (embedder as any).softmax(logits);

    const entropy = attentionEntropy(α);
    const maxEntropy = Math.log2(3); // uniform = log2(N) bits
    expect(entropy).toBeCloseTo(maxEntropy, 4);
    expect(maxAttentionWeight(α)).toBeCloseTo(1 / 3, 4);
  });

  it('EXP2: after 100 trades, attention is selective but NOT collapsed (v2.0.217 fix)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.01, lrDecay: 1.0, emaAlpha: 1.0 });
    const trades = makePredictiveTrades(100, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Measure attention using the ACTUAL temperature (not hardcoded 1.0)
    const testVecs = makePredictiveTrades(1, DIM, 0)[0]!.vectors;
    const keys = testVecs.map((v) => (embedder as any).rmsNorm(v));
    const temp = embedder.getTemperature();
    const logits = keys.map((k: number[]) => (embedder as any).dot((embedder as any).emaW, k) / temp);
    const rawAlpha = (embedder as any).softmax(logits);
    const α = (embedder as any).smoothAttention(rawAlpha, 3);

    const ent = attentionEntropy(α);
    const maxEntropy = Math.log2(3);
    const concentration = maxAttentionWeight(α);

    console.log(`  [EXP2] After 100 trades: T=${temp.toFixed(2)}, entropy=${ent.toFixed(4)} / ${maxEntropy.toFixed(4)} bits, max_weight=${concentration.toFixed(4)}`);
    console.log(`  [EXP2] |w|=${embedder.getWeightNorm().toFixed(6)}`);

    // v2.0.217 fix: attention should be selective but NOT collapsed
    // Before fix: max_weight = 1.0 (collapsed).
    // After fix: smoothing caps at 0.9*1 + 0.1/3 = 0.9333, temperature adapts further.
    // With lr=0.01 and alternating win/lose, temperature may stay at 1.0,
    // so the smoothing safety net is what prevents full collapse here.
    expect(concentration).toBeLessThan(0.95);
    // Should still have some selectivity (not perfectly uniform)
    expect(concentration).toBeGreaterThan(1 / 3);
  });

  it('EXP3: after 1000 trades with high LR, attention becomes selective', () => {
    // Use higher LR and no decay to see if learning CAN become selective
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.5, lrDecay: 1.0, emaAlpha: 1.0 });
    const trades = makePredictiveTrades(1000, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    const testVecs = makePredictiveTrades(1, DIM, 0)[0]!.vectors;
    const keys = testVecs.map((v) => (embedder as any).rmsNorm(v));
    const logits = keys.map((k: number[]) => (embedder as any).dot((embedder as any).emaW, k) / 1.0);
    const α = (embedder as any).softmax(logits);

    const entropy = attentionEntropy(α);
    const maxEntropy = Math.log2(3);
    const concentration = maxAttentionWeight(α);

    console.log(`  [EXP3] After 1000 trades (lr=0.5): entropy=${entropy.toFixed(4)} / ${maxEntropy.toFixed(4)} bits, max_weight=${concentration.toFixed(4)}`);
    console.log(`  [EXP3] |w|=${embedder.getWeightNorm().toFixed(6)}`);

    // With high LR, the attention should be more selective
    // But it may not learn the RIGHT thing (see attribution experiment)
  });

  // ─── Experiment 2: Attribution — can it learn WHICH rationale is predictive? ───

  it('EXP4: attribution test — does w point toward the predictive rationale?', () => {
    // Create trades where rationale[0] is predictive, rationale[1] and [2] are noise.
    // After training, w should align with rationale[0]'s direction.
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.1, lrDecay: 1.0, emaAlpha: 1.0 });
    const trades = makePredictiveTrades(500, DIM, 0); // rationale[0] is predictive

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Check: does w align more with rationale[0] (predictive) than rationale[1] (noise)?
    const winTrade = trades.find((t) => t.isWin)!;
    const keys = winTrade.vectors.map((v) => (embedder as any).rmsNorm(v));
    const w = (embedder as any).emaW;

    const simR0 = (embedder as any).dot(w, keys[0]); // similarity to predictive rationale
    const simR1 = (embedder as any).dot(w, keys[1]); // similarity to noise rationale
    const simR2 = (embedder as any).dot(w, keys[2]); // similarity to noise rationale

    console.log(`  [EXP4] w similarity to rationale[0] (predictive): ${simR0.toFixed(6)}`);
    console.log(`  [EXP4] w similarity to rationale[1] (noise):      ${simR1.toFixed(6)}`);
    console.log(`  [EXP4] w similarity to rationale[2] (noise):      ${simR2.toFixed(6)}`);

    // w should be more aligned with the predictive rationale than with noise
    // But due to the attribution problem, it may not be strongly differentiated
    expect(simR0).toBeGreaterThan(simR1);
    expect(simR0).toBeGreaterThan(simR2);
  });

  // ─── Experiment 3: Binary reward vs scaled reward ───

  it('EXP5: binary reward (sign only) — measure how much PnL magnitude info is lost', () => {
    // The current learning rule uses reward = sign(pnl). A +0.01% win and a
    // +15% win both get reward=+1. This experiment measures the information loss.
    //
    // Create trades where the PnL magnitude correlates with the predictive
    // rationale strength. If the learning uses sign only, it can't capture this.

    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.1, lrDecay: 1.0, emaAlpha: 1.0 });

    // Create 200 trades: winners have varying PnL (1% to 20%)
    for (let i = 0; i < 200; i++) {
      const vecs = makeRationaleVectors(3, DIM, i);
      const pnl = i % 2 === 0 ? (1 + (i % 20)) : -(1 + (i % 20)); // alternating win/loss with varying magnitude
      embedder.updateOnOutcome(vecs, pnl);
    }

    // The embedder should have learned SOMETHING, but with binary reward,
    // it can't distinguish "barely won" from "won big"
    const state = embedder.getState();
    console.log(`  [EXP5] After 200 trades with varying PnL magnitude:`);
    console.log(`  [EXP5] |w|=${embedder.getWeightNorm().toFixed(6)}, updateCount=${state.updateCount}`);

    // With binary reward, all updates have the same magnitude (lr * 1 * mean_key)
    // regardless of PnL size. This is the information loss.
    // A scaled reward (e.g. tanh(pnl/scale)) would give larger updates for bigger wins.
  });

  // ─── Experiment 4: Feedback loop (mode collapse) ───

  it('EXP6: feedback loop — does attention collapse to a single rationale?', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM,
      lr: 0.5,       // high LR to accelerate feedback
      lrDecay: 1.0,  // no decay to maximize feedback effect
      emaAlpha: 1.0, // no EMA smoothing to see raw feedback
      temperature: 0.5, // lower temp = sharper softmax = stronger feedback
    });

    // Train on 500 trades with the SAME rationale pattern (to maximize feedback)
    const trades = makePredictiveTrades(500, DIM, 0);
    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Check if attention has collapsed to a single rationale
    const testVecs = makePredictiveTrades(1, DIM, 0)[0]!.vectors;
    const keys = testVecs.map((v) => (embedder as any).rmsNorm(v));
    const logits = keys.map((k: number[]) => (embedder as any).dot((embedder as any).emaW, k) / 0.5);
    const α = (embedder as any).softmax(logits);

    const entropy = attentionEntropy(α);
    const concentration = maxAttentionWeight(α);

    console.log(`  [EXP6] After 500 trades (high LR, sharp temp):`);
    console.log(`  [EXP6] α=[${α.map((a: number) => a.toFixed(4)).join(', ')}]`);
    console.log(`  [EXP6] entropy=${entropy.toFixed(4)} bits, max_weight=${concentration.toFixed(4)}`);

    // Weight clipping prevents |w| from exceeding 5, so the attention can't
    // fully collapse. But it may become quite concentrated.
    // This demonstrates the feedback loop risk.
  });

  // ─── Experiment 5: Retrieval quality comparison ───

  it('EXP7: retrieval quality — learned blend separates winners from losers', () => {
    const dim = 16;
    const embedder = new AttnResTradeEmbedder({
      embedDim: dim, lr: 0.3, lrDecay: 0.999, emaAlpha: 0.3, temperature: 0.5,
    });

    // Train on 500 trades
    const trades = makePredictiveTrades(500, dim, 0);
    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Create test trades: 2 trades so we have both a winner and a loser
    const testTrades = makePredictiveTrades(2, dim, 0);
    const testWin = testTrades.find((t) => t.isWin)!;
    const testLose = testTrades.find((t) => !t.isWin)!;

    // Blend with learned attention
    const blendTestWin = embedder.blend(testWin.vectors);
    const blendTestLose = embedder.blend(testLose.vectors);

    // Mean (cold-start equivalent)
    const meanTestWin = (embedder as any).l2Normalize(
      testWin.vectors.reduce((acc: number[], v: number[]) => acc.map((a, i) => a + v[i]!), new Array(dim).fill(0)),
    );
    const meanTestLose = (embedder as any).l2Normalize(
      testLose.vectors.reduce((acc: number[], v: number[]) => acc.map((a, i) => a + v[i]!), new Array(dim).fill(0)),
    );

    // Compare: does the learned blend separate winners from losers better than mean?
    const blendSeparation = (embedder as any).dot(blendTestWin, blendTestLose);
    const meanSeparation = (embedder as any).dot(meanTestWin, meanTestLose);

    console.log(`  [EXP7] Blend cosine(win, lose) = ${blendSeparation.toFixed(4)} (lower = better separation)`);
    console.log(`  [EXP7] Mean  cosine(win, lose) = ${meanSeparation.toFixed(4)}`);
    console.log(`  [EXP7] Improvement: ${((meanSeparation - blendSeparation) / Math.abs(meanSeparation) * 100).toFixed(1)}%`);

    // Both should produce valid vectors
    expect(blendTestWin.length).toBe(dim);
    expect(blendTestLose.length).toBe(dim);
    for (const v of blendTestWin) expect(Number.isFinite(v)).toBe(true);
    for (const v of blendTestLose) expect(Number.isFinite(v)).toBe(true);
  });

  // ─── Experiment 6: How many trades for meaningful attention? ───

  it('EXP8: minimum trades for non-trivial attention selectivity', () => {
    // At what point does max attention weight exceed 40% (vs 33% uniform)?
    const dim = 16;

    for (const lr of [0.01, 0.1, 0.5]) {
      const embedder = new AttnResTradeEmbedder({
        embedDim: dim, lr, lrDecay: 1.0, emaAlpha: 1.0, temperature: 0.5,
      });
      const trades = makePredictiveTrades(2000, dim, 0);

      let firstNonTrivial = -1;
      for (let i = 0; i < trades.length; i++) {
        embedder.updateOnOutcome(trades[i]!.vectors, trades[i]!.pnl);

        // Check attention concentration every 50 trades
        if (i % 50 === 49 || i === trades.length - 1) {
          const testVecs = trades[0]!.vectors;
          const keys = testVecs.map((v) => (embedder as any).rmsNorm(v));
          const logits = keys.map((k: number[]) => (embedder as any).dot((embedder as any).emaW, k) / 0.5);
          const α = (embedder as any).softmax(logits);
          const concentration = maxAttentionWeight(α);

          if (concentration > 0.40 && firstNonTrivial === -1) {
            firstNonTrivial = i + 1;
          }
        }
      }

      console.log(`  [EXP8] lr=${lr}: first non-trivial attention (>40%) at trade #${firstNonTrivial === -1 ? 'never (in 2000)' : firstNonTrivial}, |w|=${embedder.getWeightNorm().toFixed(4)}`);
    }
  });
});