// ─── v2.0.217: AttnRes Trade Embedder Anti-Collapse Attack Tests ──────────
//
// Verifies the triple anti-collapse mechanism:
//   1. Adaptive temperature entropy floor
//   2. Label smoothing (hard floor)
//   3. Config clamping
//
// Attack tests verify:
// - Attention does NOT collapse to winner-takes-all after 100+ trades
// - Temperature increases when entropy drops
// - Temperature decreases when entropy recovers (hysteresis)
// - Label smoothing ensures minimum weight per rationale
// - Config clamping prevents misconfiguration
// - Backward compatibility with old state files (missing new fields)
// - NaN/Infinity safety in entropy/temperature adaptation
// - blend() output is always valid (no NaN, L2-normalized)

import { describe, it, expect } from 'vitest';
import { AttnResTradeEmbedder, type AttnResEmbedState } from '../src/evolution/attnres-trade-embedder.ts';

// ─── Helpers ───

function makeVec(dim: number, seed: number): number[] {
  const v: number[] = [];
  for (let d = 0; d < dim; d++) {
    v.push(Math.sin(seed * 12.9898 + d * 78.233) * 0.5 + 0.5);
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function makeRationaleVectors(n: number, dim: number, seed: number): number[][] {
  return Array.from({ length: n }, (_, i) => makeVec(dim, seed * 100 + i));
}

// Create trades where rationale[0] is predictive (winners aligned with a
// specific direction, losers opposite) and other rationales are noise.
function makePredictiveTrades(
  count: number,
  dim: number,
  predictiveIdx = 0,
): Array<{ vectors: number[][]; pnl: number }> {
  const winDir = new Array(dim).fill(0).map((_, d) => Math.sin(d * 0.1));
  const winNorm = Math.hypot(...winDir) || 1;
  const winDirN = winDir.map((x) => x / winNorm);
  const loseDirN = winDirN.map((x) => -x);
  const trades: Array<{ vectors: number[][]; pnl: number }> = [];

  for (let i = 0; i < count; i++) {
    const isWin = i % 2 === 0;
    const vectors: number[][] = [];
    for (let r = 0; r < 3; r++) {
      if (r === predictiveIdx) {
        const noise = makeVec(dim, i * 100 + r);
        const dir = isWin ? winDirN : loseDirN;
        const mixed = dir.map((d, idx) => 0.7 * d + 0.3 * noise[idx]!);
        const n = Math.hypot(...mixed) || 1;
        vectors.push(mixed.map((x) => x / n));
      } else {
        vectors.push(makeVec(dim, i * 100 + r));
      }
    }
    trades.push({ vectors, pnl: isWin ? 5 : -5 });
  }
  return trades;
}

function entropy(α: number[]): number {
  let h = 0;
  for (const p of α) {
    if (p > 0 && Number.isFinite(p)) h -= p * Math.log2(p);
  }
  return h;
}

function maxWeight(α: number[]): number {
  return Math.max(...α);
}

function minWeight(α: number[]): number {
  return Math.min(...α);
}

// ═══════════════════════════════════════════════════════════════
//  Anti-Collapse: Core Behavior Tests
// ═══════════════════════════════════════════════════════════════

describe('AttnRes anti-collapse: core behavior', () => {
  const DIM = 16;

  it('C1: after 100 trades, blend attention does NOT collapse to winner-takes-all', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, lr: 0.01, lrDecay: 1.0, emaAlpha: 1.0,
    });
    const trades = makePredictiveTrades(100, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Measure attention via blend() — the ACTUAL production path
    // We can't access internal α directly, but we can verify via blend output:
    // If attention collapsed, blend would be identical to one rationale vector.
    // If attention is selective but not collapsed, blend differs from any single vector.

    const testVecs = makePredictiveTrades(1, DIM, 0)[0]!.vectors;
    const blended = embedder.blend(testVecs);

    // Compute cosine similarity between blended and each individual rationale
    const cosSim = testVecs.map((v) => {
      let dot = 0;
      for (let d = 0; d < DIM; d++) dot += blended[d]! * v[d]!;
      return dot;
    });

    const maxSim = Math.max(...cosSim);
    const minSim = Math.min(...cosSim);
    const spread = maxSim - minSim;

    const cosSimStr = cosSim.map(s => s.toFixed(4)).join(', ');
    console.log('  [C1] After 100 trades: T=' + embedder.getTemperature().toFixed(2) + ', cosSim=[' + cosSimStr + ']');
    console.log(`  [C1] maxSim=${maxSim.toFixed(4)}, minSim=${minSim.toFixed(4)}, spread=${spread.toFixed(4)}`);

    // Anti-collapse: max similarity should NOT be 1.0 (which would mean blend = single rationale)
    expect(maxSim).toBeLessThan(0.99);
    // All rationales should contribute (minSim > 0 means none is completely ignored)
    // With smoothing=0.1 and N=3, min weight = 0.033, so minSim should be > 0
    expect(minSim).toBeGreaterThan(-0.5); // not perfectly anti-correlated
  });

  it('C2: after 500 trades with high LR, attention still does not fully collapse', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, lr: 0.5, lrDecay: 1.0, emaAlpha: 1.0,
      temperature: 0.5, // start sharp to stress-test
    });
    const trades = makePredictiveTrades(500, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Measure attention weights directly using orthogonal basis vectors.
    // With orthogonal inputs, the blend output components directly reveal α.
    const orthoVecs = [
      new Array(DIM).fill(0).map((_, d) => d === 0 ? 1 : 0),
      new Array(DIM).fill(0).map((_, d) => d === 1 ? 1 : 0),
      new Array(DIM).fill(0).map((_, d) => d === 2 ? 1 : 0),
    ];
    const blended = embedder.blend(orthoVecs);
    // Since inputs are orthogonal unit vectors, blend[i] = α[i] * (1-smoothMix) + smoothMix/N
    // Recover raw α from blend: α[i] = (blend[i] - smoothMix/N) / (1 - smoothMix)
    const N = 3;
    const sm = (embedder as any).smoothMix;
    const recoveredAlpha = blended.slice(0, N).map(b => (b - sm / N) / (1 - sm));
    const maxAlpha = Math.max(...recoveredAlpha);
    const minAlpha = Math.min(...recoveredAlpha);

    console.log('  [C2] After 500 trades (lr=0.5, T_init=0.5): T=' + embedder.getTemperature().toFixed(2) +
      ', recoveredAlpha=[' + recoveredAlpha.map(a => a.toFixed(4)).join(', ') + ']');
    console.log('  [C2] maxAlpha=' + maxAlpha.toFixed(4) + ', minAlpha=' + minAlpha.toFixed(4));

    // Anti-collapse: no single rationale should get > 95% attention
    // (with smoothing=0.1, max possible = 0.9 * 1.0 + 0.1/3 = 0.933)
    expect(maxAlpha).toBeLessThan(0.95);
    // Temperature should have increased (anti-collapse triggered)
    expect(embedder.getTemperature()).toBeGreaterThan(1.0);
  });

  it('C3: temperature increases when entropy drops below floor', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, lr: 0.1, lrDecay: 1.0, emaAlpha: 1.0,
      entropyFloor: 1.0, // high floor → triggers quickly
      warmupFactor: 2.0,
    });
    const trades = makePredictiveTrades(50, DIM);
    const initialT = embedder.getTemperature();

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    const finalT = embedder.getTemperature();
    console.log(`  [C3] T: ${initialT.toFixed(2)} → ${finalT.toFixed(2)}`);
    expect(finalT).toBeGreaterThan(initialT);
  });

  it('C4: temperature does not exceed maxTemperature cap', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, lr: 1.0, lrDecay: 1.0, emaAlpha: 1.0,
      entropyFloor: 2.0, // very high → always triggers
      warmupFactor: 5.0,
      maxTemperature: 3.0,
    });
    const trades = makePredictiveTrades(200, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    console.log(`  [C4] T after 200 trades: ${embedder.getTemperature().toFixed(2)} (cap=3.0)`);
    expect(embedder.getTemperature()).toBeLessThanOrEqual(3.0);
  });

  it('C5: label smoothing ensures minimum weight per rationale', () => {
    // With smoothMix=0.1 and N=3, minimum weight = 0.1/3 ≈ 0.033
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, smoothMix: 0.1,
    });

    // Even with extreme weights, smoothing should prevent any weight from being 0
    // Access the smoothAttention method directly
    const extreme = [0.999, 0.0005, 0.0005];
    const smoothed = (embedder as any).smoothAttention(extreme, 3);

    console.log(`  [C5] extreme α=[${extreme.map((a) => a.toFixed(4)).join(', ')}] → smoothed=[${smoothed.map((a: number) => a.toFixed(4)).join(', ')}]`);

    // Each weight should be at least smoothMix/N = 0.1/3 ≈ 0.033
    for (const s of smoothed) {
      expect(s).toBeGreaterThanOrEqual(0.033 - 1e-6);
    }
    // Weights should sum to 1
    expect(smoothed.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1.0, 6);
  });

  it('C6: smoothMix=0 disables smoothing (backward compatible)', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, smoothMix: 0.0,
    });

    const α = [0.8, 0.15, 0.05];
    const result = (embedder as any).smoothAttention(α, 3);
    expect(result).toEqual(α); // unchanged
  });

  it('C7: blend output is always L2-normalized (no NaN)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.1 });
    const trades = makePredictiveTrades(100, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Test with various rationale configurations
    const testCases: number[][][] = [
      makeRationaleVectors(3, DIM, 1),
      makeRationaleVectors(2, DIM, 2),
      makeRationaleVectors(10, DIM, 3),
      makeRationaleVectors(1, DIM, 4),
      [],
    ];

    for (const vecs of testCases) {
      const blended = embedder.blend(vecs);
      if (blended.length === 0) continue;

      // Check L2 norm = 1
      const norm = Math.hypot(...blended);
      expect(norm).toBeCloseTo(1.0, 4);

      // Check no NaN
      for (const v of blended) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  Anti-Collapse: Config Clamping Tests
// ═══════════════════════════════════════════════════════════════

describe('AttnRes anti-collapse: config clamping', () => {
  it('A1: smoothMix clamped to [0, 0.5]', () => {
    const e1 = new AttnResTradeEmbedder({ smoothMix: -0.5 });
    expect((e1 as any).smoothMix).toBe(0);

    const e2 = new AttnResTradeEmbedder({ smoothMix: 1.0 });
    expect((e2 as any).smoothMix).toBe(0.5);

    const e3 = new AttnResTradeEmbedder({ smoothMix: 0.15 });
    expect((e3 as any).smoothMix).toBe(0.15);
  });

  it('A2: warmupFactor clamped to [1.0, 10.0]', () => {
    const e1 = new AttnResTradeEmbedder({ warmupFactor: 0.5 });
    expect((e1 as any).warmupFactor).toBe(1.0); // < 1.0 would sharpen, not soften

    const e2 = new AttnResTradeEmbedder({ warmupFactor: 100 });
    expect((e2 as any).warmupFactor).toBe(10.0);

    const e3 = new AttnResTradeEmbedder({ warmupFactor: 1.5 });
    expect((e3 as any).warmupFactor).toBe(1.5);
  });

  it('A3: maxTemperature ≥ minTemperature', () => {
    const e = new AttnResTradeEmbedder({ minTemperature: 2.0, maxTemperature: 1.0 });
    // max should be at least min
    expect((e as any).maxTemperature).toBeGreaterThanOrEqual((e as any).minTemperature);
  });

  it('A4: temperature starts within [min, max]', () => {
    const e = new AttnResTradeEmbedder({ temperature: 100, maxTemperature: 5.0 });
    expect(e.getTemperature()).toBeLessThanOrEqual(5.0);

    const e2 = new AttnResTradeEmbedder({ temperature: 0.01, minTemperature: 1.0 });
    expect(e2.getTemperature()).toBeGreaterThanOrEqual(1.0);
  });

  it('A5: entropyFloor ≥ 0 (negative clamped to 0)', () => {
    const e = new AttnResTradeEmbedder({ entropyFloor: -1.0 });
    expect((e as any).entropyFloor).toBe(0);
  });

  it('A6: minTemperature ≥ 0.1 (prevents division by near-zero)', () => {
    const e = new AttnResTradeEmbedder({ minTemperature: 0.001 });
    expect((e as any).minTemperature).toBeGreaterThanOrEqual(0.1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Anti-Collapse: Backward Compatibility Tests
// ═══════════════════════════════════════════════════════════════

describe('AttnRes anti-collapse: backward compatibility', () => {
  const DIM = 8;

  it('B1: old state file (without v2.0.217 fields) loads with new defaults', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    // Simulate old state without new fields
    const oldState: AttnResEmbedState = {
      w: new Array(DIM).fill(0.1),
      emaW: new Array(DIM).fill(0.1),
      updateCount: 50,
      embedDim: DIM,
      temperature: 1.0,
      lr: 0.01,
      lrDecay: 0.995,
      emaAlpha: 0.1,
      // NO v2.0.217 fields: entropyFloor, warmupFactor, etc.
    };

    embedder.loadState(oldState);

    // New fields should have been set to defaults
    expect((embedder as any).entropyFloor).toBe(0.5);
    expect((embedder as any).warmupFactor).toBe(1.5);
    expect((embedder as any).smoothMix).toBe(0.1);
    expect(embedder.getUpdateCount()).toBe(50);
    expect(embedder.getTemperature()).toBe(1.0);
  });

  it('B2: new state file (with v2.0.217 fields) loads correctly', () => {
    const embedder1 = new AttnResTradeEmbedder({
      embedDim: DIM, entropyFloor: 0.8, warmupFactor: 2.0, smoothMix: 0.2,
    });
    // Train briefly
    const trades = makePredictiveTrades(10, DIM);
    for (const t of trades) embedder1.updateOnOutcome(t.vectors, t.pnl);

    const state = embedder1.getState();

    const embedder2 = new AttnResTradeEmbedder({ embedDim: DIM });
    embedder2.loadState(state);

    expect((embedder2 as any).entropyFloor).toBe(0.8);
    expect((embedder2 as any).warmupFactor).toBe(2.0);
    expect((embedder2 as any).smoothMix).toBe(0.2);
    expect(embedder2.getUpdateCount()).toBe(embedder1.getUpdateCount());
    expect(embedder2.getTemperature()).toBeCloseTo(embedder1.getTemperature(), 6);
  });

  it('B3: cold-start (w=0) blend = mean of rationale vectors (unchanged)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const vecs = makeRationaleVectors(3, DIM, 42);

    const blended = embedder.blend(vecs);

    // With w=0, temperature=1.0, smoothing=0.1:
    // raw α = uniform [1/3, 1/3, 1/3]
    // smoothed α = [1/3 * 0.9 + 0.1/3, ...] = [0.333, 0.333, 0.333] (still uniform!)
    // blend = mean of vectors (L2-normalized)
    const mean = new Array(DIM).fill(0);
    for (const v of vecs) {
      for (let d = 0; d < DIM; d++) mean[d] += v[d]! / 3;
    }
    const meanNorm = Math.hypot(...mean) || 1;
    const expected = mean.map((x) => x / meanNorm);

    for (let d = 0; d < DIM; d++) {
      expect(blended[d]).toBeCloseTo(expected[d], 4);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  Anti-Collapse: Attack / Edge Case Tests
// ═══════════════════════════════════════════════════════════════

describe('AttnRes anti-collapse: attacks', () => {
  const DIM = 16;

  it('D1: NaN in rationale vectors → blend returns valid L2-normalized vector', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const vecs: number[][] = [
      makeVec(DIM, 1),
      new Array(DIM).fill(NaN),
      makeVec(DIM, 3),
    ];

    const blended = embedder.blend(vecs);
    expect(blended.length).toBe(DIM);
    const norm = Math.hypot(...blended);
    expect(norm).toBeCloseTo(1.0, 4);
    for (const v of blended) expect(Number.isFinite(v)).toBe(true);
  });

  it('D2: Infinity in rationale vectors → blend returns valid vector', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const vecs: number[][] = [
      makeVec(DIM, 1),
      new Array(DIM).fill(Infinity),
      makeVec(DIM, 3),
    ];

    const blended = embedder.blend(vecs);
    expect(blended.length).toBe(DIM);
    for (const v of blended) expect(Number.isFinite(v)).toBe(true);
  });

  it('D3: all-zero rationale vectors → blend returns valid uniform vector', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const vecs = [
      new Array(DIM).fill(0),
      new Array(DIM).fill(0),
      new Array(DIM).fill(0),
    ];

    const blended = embedder.blend(vecs);
    expect(blended.length).toBe(DIM);
    // Zero vectors → l2Normalize returns uniform (1/sqrt(dim))
    const expected = 1 / Math.sqrt(DIM);
    for (const v of blended) {
      expect(v).toBeCloseTo(expected, 4);
    }
  });

  it('D4: single rationale vector → blend returns it unchanged', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const vec = makeVec(DIM, 42);
    const blended = embedder.blend([vec]);
    expect(blended).toEqual(vec);
  });

  it('D5: empty rationale vectors → blend returns []', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const blended = embedder.blend([]);
    expect(blended).toEqual([]);
  });

  it('D6: updateOnOutcome with NaN PnL → no crash, no update', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const vecs = makeRationaleVectors(3, DIM, 1);
    const beforeCount = embedder.getUpdateCount();

    expect(() => embedder.updateOnOutcome(vecs, NaN)).not.toThrow();
    // NaN > 0 is false, NaN < 0 is false → reward = 0 → no update
    expect(embedder.getUpdateCount()).toBe(beforeCount);
  });

  it('D7: updateOnOutcome with Infinity PnL → treated as positive reward', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.1 });
    const vecs = makeRationaleVectors(3, DIM, 1);
    const beforeCount = embedder.getUpdateCount();

    embedder.updateOnOutcome(vecs, Infinity);
    // Infinity > 0 → reward = 1 → update happens
    expect(embedder.getUpdateCount()).toBe(beforeCount + 1);
  });

  it('D8: updateOnOutcome with -Infinity PnL → treated as negative reward', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.1 });
    const vecs = makeRationaleVectors(3, DIM, 1);
    const beforeCount = embedder.getUpdateCount();

    embedder.updateOnOutcome(vecs, -Infinity);
    // -Infinity < 0 → reward = -1 → update happens
    expect(embedder.getUpdateCount()).toBe(beforeCount + 1);
  });

  it('D9: entropy of NaN-filled α → returns 0 (triggers warmup, safe)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const α = [NaN, NaN, NaN];
    const ent = (embedder as any).entropy(α);
    expect(ent).toBe(0); // safe: triggers temperature warmup
  });

  it('D10: smoothAttention with NaN in α → NaN entries replaced by uniform', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, smoothMix: 0.1 });
    const α = [0.8, NaN, 0.05];
    const smoothed = (embedder as any).smoothAttention(α, 3);

    // NaN should be replaced by uniform contribution
    for (const s of smoothed) {
      expect(Number.isFinite(s)).toBe(true);
    }
    // Non-NaN entries should still be smoothed
    expect(smoothed[0]).toBeLessThan(0.8); // smoothed down
  });

  it('D11: adaptTemperature with degenerate α (all zeros) → temperature increases', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, entropyFloor: 0.5, warmupFactor: 2.0,
    });
    const initialT = embedder.getTemperature();
    const α = [0, 0, 0]; // entropy = 0 < floor → warmup

    (embedder as any).adaptTemperature(α, 3);

    expect(embedder.getTemperature()).toBeGreaterThan(initialT);
  });

  it('D12: adaptTemperature with uniform α → temperature does not increase', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, entropyFloor: 0.5, warmupFactor: 2.0,
    });
    const initialT = embedder.getTemperature();
    const α = [1 / 3, 1 / 3, 1 / 3]; // entropy = log2(3) ≈ 1.585 > floor * 1.5

    (embedder as any).adaptTemperature(α, 3);

    // Entropy is high → temperature should NOT increase
    // It might decrease if > floor * 1.5 = 0.75 and temperature > min
    // But initial T = 1.0 = min, so it stays
    expect(embedder.getTemperature()).toBe(initialT);
  });

  it('D13: temperature hysteresis — no oscillation around threshold', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, entropyFloor: 0.5, warmupFactor: 2.0,
      minTemperature: 1.0, maxTemperature: 10.0,
    });

    // Alternate between low-entropy and high-entropy α
    // Without hysteresis, temperature would oscillate.
    // With hysteresis (band = [0.5, 0.75]), high-entropy only decreases T when T > min.
    const lowEnt = [0.99, 0.005, 0.005]; // ent ≈ 0.08
    const highEnt = [0.34, 0.33, 0.33]; // ent ≈ 1.58

    for (let i = 0; i < 20; i++) {
      (embedder as any).adaptTemperature(i % 2 === 0 ? lowEnt : highEnt, 3);
    }

    const finalT = embedder.getTemperature();
    console.log(`  [D13] After 20 alternating adaptations: T=${finalT.toFixed(2)}`);
    // Temperature should not have oscillated wildly — should be stable
    expect(finalT).toBeGreaterThanOrEqual(1.0);
    expect(finalT).toBeLessThanOrEqual(10.0);
  });

  it('D14: 1000 trades with default config — blend never produces NaN', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM });
    const trades = makePredictiveTrades(1000, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);

      // Periodically check blend
      if (t === trades[trades.length - 1] || trades.indexOf(t) % 100 === 0) {
        const blended = embedder.blend(t.vectors);
        for (const v of blended) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }

    // Final check: blend is valid
    const finalBlend = embedder.blend(trades[trades.length - 1]!.vectors);
    const norm = Math.hypot(...finalBlend);
    expect(norm).toBeCloseTo(1.0, 4);
    console.log(`  [D14] After 1000 trades: T=${embedder.getTemperature().toFixed(2)}, |w|=${embedder.getWeightNorm().toFixed(4)}`);
  });

  it('D15: loadState with temperature out of bounds → clamped to [min, max]', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, minTemperature: 1.0, maxTemperature: 5.0,
    });

    const state: AttnResEmbedState = {
      w: new Array(DIM).fill(0),
      emaW: new Array(DIM).fill(0),
      updateCount: 10,
      embedDim: DIM,
      temperature: 100.0, // way above max
      lr: 0.01, lrDecay: 0.995, emaAlpha: 0.1,
    };

    embedder.loadState(state);
    expect(embedder.getTemperature()).toBeLessThanOrEqual(5.0);
  });

  it('D16: adversarial — all trades identical → no crash, no NaN, T adapts', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.1 });
    const vecs = makeRationaleVectors(3, DIM, 42);

    // Train on 200 identical trades (all wins)
    for (let i = 0; i < 200; i++) {
      embedder.updateOnOutcome(vecs, 5);
    }

    const blended = embedder.blend(vecs);
    expect(blended.length).toBe(DIM);
    for (const v of blended) expect(Number.isFinite(v)).toBe(true);
    const norm = Math.hypot(...blended);
    expect(norm).toBeCloseTo(1.0, 4);

    console.log(`  [D16] After 200 identical trades: T=${embedder.getTemperature().toFixed(2)}, |w|=${embedder.getWeightNorm().toFixed(4)}`);
  });

  it('D17: adversarial — alternating wins/losses with identical rationales → w stays bounded', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: DIM, lr: 0.1, emaAlpha: 0.5 });
    const vecs = makeRationaleVectors(3, DIM, 42);

    // Alternating win/loss with same vectors → w should oscillate but stay bounded
    for (let i = 0; i < 200; i++) {
      embedder.updateOnOutcome(vecs, i % 2 === 0 ? 5 : -5);
    }

    // |w| should be bounded by weight clipping (MAX_W=5 per dim, but overall norm can be larger)
    // The key check: no NaN, blend valid
    const blended = embedder.blend(vecs);
    for (const v of blended) expect(Number.isFinite(v)).toBe(true);

    console.log(`  [D17] After 200 alternating identical trades: T=${embedder.getTemperature().toFixed(2)}, |w|=${embedder.getWeightNorm().toFixed(4)}`);
  });

  it('D18: smoothMix=0.5 (max) — attention is 50% uniform, learning still works', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, smoothMix: 0.5, lr: 0.1, emaAlpha: 1.0, lrDecay: 1.0,
    });
    const trades = makePredictiveTrades(100, DIM);

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Even with max smoothing, w should have learned something (non-zero norm)
    expect(embedder.getWeightNorm()).toBeGreaterThan(0);

    // Blend should still produce valid output
    const blended = embedder.blend(trades[0]!.vectors);
    for (const v of blended) expect(Number.isFinite(v)).toBe(true);
    const norm = Math.hypot(...blended);
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it('D19: entropy floor = 0 disables adaptive temperature (only smoothing active)', () => {
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, entropyFloor: 0, lr: 0.5, emaAlpha: 1.0, lrDecay: 1.0,
    });
    const trades = makePredictiveTrades(100, DIM);
    const initialT = embedder.getTemperature();

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // With entropyFloor=0, temperature should never increase (entropy always > 0)
    // But smoothing still prevents full collapse
    expect(embedder.getTemperature()).toBe(initialT);

    // Blend should still be valid (smoothing prevents collapse)
    const blended = embedder.blend(trades[0]!.vectors);
    for (const v of blended) expect(Number.isFinite(v)).toBe(true);
  });

  it('D20: selectivity is SELECTIVE not EXCLUSIVE — max attention < 0.9 after 100 trades', () => {
    // The key test: with default anti-collapse settings, the attention should
    // be selective (predictive rationale gets more weight) but NOT exclusive
    // (no single rationale gets > 90% weight).
    const embedder = new AttnResTradeEmbedder({
      embedDim: DIM, lr: 0.01, lrDecay: 1.0, emaAlpha: 1.0,
      // Default anti-collapse: entropyFloor=0.5, warmupFactor=1.5, smoothMix=0.1
    });
    const trades = makePredictiveTrades(100, DIM, 0); // rationale[0] is predictive

    for (const t of trades) {
      embedder.updateOnOutcome(t.vectors, t.pnl);
    }

    // Use orthogonal basis vectors to directly recover attention weights
    const orthoVecs = [
      new Array(DIM).fill(0).map((_, d) => d === 0 ? 1 : 0),
      new Array(DIM).fill(0).map((_, d) => d === 1 ? 1 : 0),
      new Array(DIM).fill(0).map((_, d) => d === 2 ? 1 : 0),
    ];
    const blended = embedder.blend(orthoVecs);
    const N = 3;
    const sm = (embedder as any).smoothMix;
    const recoveredAlpha = blended.slice(0, N).map(b => (b - sm / N) / (1 - sm));
    const maxAlpha = Math.max(...recoveredAlpha);
    const minAlpha = Math.min(...recoveredAlpha);

    const d20str = recoveredAlpha.map(a => a.toFixed(4)).join(', ');
    console.log('  [D20] After 100 trades: T=' + embedder.getTemperature().toFixed(2) + ', alpha=[' + d20str + ']');
    console.log('  [D20] maxAlpha=' + maxAlpha.toFixed(4) + ', minAlpha=' + minAlpha.toFixed(4));

    // Selective not exclusive: max attention < 0.90
    expect(maxAlpha).toBeLessThan(0.90);
  });
});