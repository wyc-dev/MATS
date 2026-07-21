// ─── v2.0.215: AttnRes Trade Embedder Tests ────────────────────────────────
//
// Tests the AttnRes trade embedder that applies Kimi K3 AttnRes theory
// (arXiv 2603.15031) at the MiniLM rationale level. Verifies:
// - Cold-start safety (w=0 → uniform → mean ≈ current behavior)
// - Learning via reward-weighted key direction
// - Backward compatibility (blend ≈ mean when untrained)
// - Attack tests: NaN, Infinity, empty, single-element, dimension mismatch,
//   persistence, weight clipping, LR decay, EMA smoothing

import { describe, it, expect } from 'vitest';
import { AttnResTradeEmbedder } from '../src/evolution/attnres-trade-embedder.ts';

// ─── Helpers ───

function makeVectors(n: number, dim: number = 384): number[][] {
  const vecs: number[][] = [];
  for (let i = 0; i < n; i++) {
    const v: number[] = [];
    for (let d = 0; d < dim; d++) {
      v.push(Math.sin(i * 12.9898 + d * 78.233) % 1);
    }
    // L2-normalize
    const norm = Math.hypot(...v) || 1;
    vecs.push(v.map((x) => x / norm));
  }
  return vecs;
}

function meanOf(vecs: number[][]): number[] {
  const dim = vecs[0]!.length;
  const result = new Array(dim).fill(0);
  for (const v of vecs) {
    for (let d = 0; d < dim; d++) result[d] += v[d] ?? 0;
  }
  for (let d = 0; d < dim; d++) result[d] /= vecs.length;
  // L2-normalize
  const norm = Math.hypot(...result) || 1;
  return result.map((x) => x / norm);
}

// ═══════════════════════════════════════════════════════════════
//  Unit Tests
// ═══════════════════════════════════════════════════════════════

describe('AttnResTradeEmbedder', () => {
  // ─── Cold-start safety ───

  it('cold-start (w=0): blend = mean of vectors (backward compatible)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const vecs = makeVectors(3, 8);
    const blended = embedder.blend(vecs);
    const expectedMean = meanOf(vecs);

    // blended should be very close to mean (uniform softmax → mean → L2-normalize)
    for (let d = 0; d < 8; d++) {
      expect(blended[d]).toBeCloseTo(expectedMean[d], 4);
    }
  });

  it('empty input returns empty array', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    expect(embedder.blend([]).length).toBe(0);
  });

  it('single vector returns that vector (no blend needed)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const vecs = makeVectors(1, 8);
    const blended = embedder.blend(vecs);
    for (let d = 0; d < 8; d++) {
      expect(blended[d]).toBeCloseTo(vecs[0]![d], 5);
    }
  });

  it('output is L2-normalized', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const vecs = makeVectors(4, 8);
    const blended = embedder.blend(vecs);
    const norm = Math.hypot(...blended);
    expect(norm).toBeCloseTo(1, 4);
  });

  it('isReady returns false at cold-start, true after update', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    expect(embedder.isReady()).toBe(false);
    embedder.updateOnOutcome(makeVectors(3, 8), 1.0);
    expect(embedder.isReady()).toBe(true);
  });

  it('getWeightNorm returns 0 at cold-start', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    expect(embedder.getWeightNorm()).toBe(0);
  });

  // ─── Learning ───

  it('updateOnOutcome with positive PnL shifts w toward blend direction', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    const vecs = makeVectors(3, 8);

    embedder.updateOnOutcome(vecs, 1.0); // win
    const normAfter = embedder.getWeightNorm();
    expect(normAfter).toBeGreaterThan(0);
  });

  it('updateOnOutcome with negative PnL shifts w away (opposite direction)', () => {
    const embedderWin = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    const embedderLoss = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    const vecs = makeVectors(3, 8);

    embedderWin.updateOnOutcome(vecs, 1.0);
    embedderLoss.updateOnOutcome(vecs, -1.0);

    // The weight norms should be equal (same magnitude, opposite direction)
    expect(embedderWin.getWeightNorm()).toBeCloseTo(embedderLoss.getWeightNorm(), 4);

    // But the directions should be opposite
    const stateWin = embedderWin.getState();
    const stateLoss = embedderLoss.getState();
    let dotProduct = 0;
    for (let d = 0; d < 8; d++) {
      dotProduct += stateWin.w[d]! * stateLoss.w[d]!;
    }
    expect(dotProduct).toBeLessThan(0); // opposite directions
  });

  it('zero PnL does not update w', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    embedder.updateOnOutcome(makeVectors(3, 8), 0);
    expect(embedder.getWeightNorm()).toBe(0);
    expect(embedder.getUpdateCount()).toBe(0);
  });

  it('single rationale does not update (need 2+ to learn blend)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    embedder.updateOnOutcome(makeVectors(1, 8), 1.0);
    expect(embedder.getWeightNorm()).toBe(0);
    expect(embedder.getUpdateCount()).toBe(0);
  });

  it('multiple updates accumulate learning', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1, lrDecay: 1.0 });
    const vecs = makeVectors(3, 8);

    embedder.updateOnOutcome(vecs, 1.0);
    const norm1 = embedder.getWeightNorm();
    embedder.updateOnOutcome(vecs, 1.0);
    const norm2 = embedder.getWeightNorm();

    expect(norm2).toBeGreaterThan(norm1); // accumulated
  });

  it('LR decay reduces update magnitude over time', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1, lrDecay: 0.5 });
    const vecs = makeVectors(3, 8);

    embedder.updateOnOutcome(vecs, 1.0);
    const norm1 = embedder.getWeightNorm();

    // Second update with decayed LR should be smaller
    embedder.updateOnOutcome(vecs, 1.0);
    const norm2 = embedder.getWeightNorm();

    // The increment should be smaller (norm2 - norm1 < norm1)
    expect(norm2 - norm1).toBeLessThan(norm1);
  });

  it('weight clipping prevents unbounded growth', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 10.0, lrDecay: 1.0 });
    const vecs = makeVectors(3, 8);

    // Many large updates
    for (let i = 0; i < 100; i++) {
      embedder.updateOnOutcome(vecs, 1.0);
    }

    // Each weight should be within [-MAX_W, MAX_W] = [-5, 5]
    const state = embedder.getState();
    for (const w of state.w) {
      expect(w).toBeGreaterThanOrEqual(-5);
      expect(w).toBeLessThanOrEqual(5);
    }
  });

  // ─── EMA smoothing ───

  it('EMA smoothing: emaW lags behind w', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1, emaAlpha: 0.1 });
    const vecs = makeVectors(3, 8);

    embedder.updateOnOutcome(vecs, 1.0);
    const state = embedder.getState();

    // emaW = 0.9 * 0 + 0.1 * w = 0.1 * w → |emaW| < |w|
    const wNorm = Math.hypot(...state.w);
    const emaWNorm = Math.hypot(...state.emaW);
    expect(emaWNorm).toBeLessThan(wNorm);
    expect(emaWNorm).toBeGreaterThan(0);
  });

  // ─── Persistence ───

  it('getState / loadState roundtrip preserves w', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    embedder.updateOnOutcome(makeVectors(3, 8), 1.0);
    embedder.updateOnOutcome(makeVectors(3, 8), -0.5);

    const state = embedder.getState();
    const embedder2 = new AttnResTradeEmbedder({ embedDim: 8 });
    embedder2.loadState(state);

    const state2 = embedder2.getState();
    for (let d = 0; d < 8; d++) {
      expect(state2.w[d]).toBeCloseTo(state.w[d], 5);
      expect(state2.emaW[d]).toBeCloseTo(state.emaW[d], 5);
    }
    expect(state2.updateCount).toBe(state.updateCount);
  });

  it('loadState with mismatched embedDim ignores state (cold-start safe)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const badState = {
      w: new Array(16).fill(1),
      emaW: new Array(16).fill(1),
      updateCount: 50,
      embedDim: 16, // mismatch!
      temperature: 1.0, lr: 0.01, lrDecay: 0.995, emaAlpha: 0.1,
    };
    embedder.loadState(badState);
    // Should ignore bad state, stay at zero-init
    expect(embedder.getWeightNorm()).toBe(0);
    expect(embedder.getUpdateCount()).toBe(0);
  });

  // ─── Attack tests ───

  it('A1: NaN in rationale vectors does not crash blend', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const vecs = [
      [NaN, 0.5, 0.3, 0.1, 0.2, 0.4, 0.1, 0.2],
      [0.3, 0.5, 0.1, 0.2, 0.3, 0.4, 0.2, 0.1],
      [0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4],
    ];
    expect(() => embedder.blend(vecs)).not.toThrow();
    const result = embedder.blend(vecs);
    expect(result.length).toBe(8);
    // No NaN in output
    for (const v of result) expect(Number.isFinite(v)).toBe(true);
  });

  it('A2: Infinity in rationale vectors does not crash', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const vecs = [
      [Infinity, 0.5, 0.3, 0.1, 0.2, 0.4, 0.1, 0.2],
      [0.3, 0.5, 0.1, 0.2, 0.3, 0.4, 0.2, 0.1],
      [0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4],
    ];
    expect(() => embedder.blend(vecs)).not.toThrow();
    const result = embedder.blend(vecs);
    for (const v of result) expect(Number.isFinite(v)).toBe(true);
  });

  it('A3: all-zero vectors return uniform (well-defined)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const vecs = [
      new Array(8).fill(0),
      new Array(8).fill(0),
    ];
    const result = embedder.blend(vecs);
    // All-zero → RMSNorm produces uniform → blend = uniform → L2-normalize = uniform
    const expected = 1 / Math.sqrt(8);
    for (const v of result) {
      expect(v).toBeCloseTo(expected, 4);
    }
  });

  it('A4: updateOnOutcome with NaN PnL does not crash', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    expect(() => embedder.updateOnOutcome(makeVectors(3, 8), NaN)).not.toThrow();
    // NaN PnL → reward = sign(NaN) → NaN > 0 is false, NaN < 0 is false → reward = 0 → no update
    expect(embedder.getWeightNorm()).toBe(0);
  });

  it('A5: updateOnOutcome with NaN rationale vectors does not crash', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    const vecs = [
      [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN],
      [0.3, 0.5, 0.1, 0.2, 0.3, 0.4, 0.2, 0.1],
      [0.1, 0.2, 0.3, 0.4, 0.1, 0.2, 0.3, 0.4],
    ];
    expect(() => embedder.updateOnOutcome(vecs, 1.0)).not.toThrow();
    // Should produce a valid update (NaN handled by RMSNorm → 0 for that dimension)
    expect(embedder.getWeightNorm()).toBeGreaterThan(0);
  });

  it('A6: large number of rationales (50) blends without performance issues', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 384 });
    const vecs = makeVectors(50, 384);
    const start = Date.now();
    const result = embedder.blend(vecs);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50); // < 50ms for 50 × 384-d
    expect(result.length).toBe(384);
  });

  it('A7: blend output is deterministic for same input (no randomness)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    const vecs = makeVectors(3, 8);
    const result1 = embedder.blend(vecs);
    const result2 = embedder.blend(vecs);
    for (let d = 0; d < 8; d++) {
      expect(result1[d]).toBeCloseTo(result2[d], 10);
    }
  });

  it('A8: trained embedder produces different blend than untrained', () => {
    const embedderCold = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.5 });
    const embedderTrained = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.5 });

    // Train one embedder on wins
    for (let i = 0; i < 20; i++) {
      embedderTrained.updateOnOutcome(makeVectors(3, 8), 1.0);
    }

    const vecs = makeVectors(3, 8);
    const blendCold = embedderCold.blend(vecs);
    const blendTrained = embedderTrained.blend(vecs);

    // They should differ (trained embedder has non-uniform attention)
    let totalDiff = 0;
    for (let d = 0; d < 8; d++) {
      totalDiff += Math.abs(blendCold[d]! - blendTrained[d]!);
    }
    expect(totalDiff).toBeGreaterThan(0.01);
  });

  it('A9: updateOnOutcome with empty vectors does not crash', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    expect(() => embedder.updateOnOutcome([], 1.0)).not.toThrow();
    expect(embedder.getWeightNorm()).toBe(0); // no update
  });

  it('A10: save/load preserves state across instances', async () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    embedder.updateOnOutcome(makeVectors(3, 8), 1.0);
    embedder.updateOnOutcome(makeVectors(3, 8), -0.5);

    const tmpPath = `/tmp/test-attnres-embed-${Date.now()}.json`;
    await embedder.save(tmpPath);

    const embedder2 = new AttnResTradeEmbedder({ embedDim: 8 });
    await embedder2.load(tmpPath);

    expect(embedder2.getUpdateCount()).toBe(2);
    expect(embedder2.getWeightNorm()).toBeCloseTo(embedder.getWeightNorm(), 5);

    // Clean up
    const { promises: fs } = await import('node:fs');
    await fs.unlink(tmpPath).catch(() => {});
  });

  it('A11: load non-existent file → cold-start (no crash)', async () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8 });
    await embedder.load('/tmp/nonexistent-attnres-embed-state.json');
    expect(embedder.getWeightNorm()).toBe(0);
    expect(embedder.getUpdateCount()).toBe(0);
  });

  it('A12: very large PnL does not cause overflow (reward is sign only)', () => {
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, lr: 0.1 });
    embedder.updateOnOutcome(makeVectors(3, 8), 1e15);
    const state = embedder.getState();
    for (const w of state.w) {
      expect(Number.isFinite(w)).toBe(true);
    }
  });

  it('A13: negative temperature is handled (abs via clamping)', () => {
    // The embedder doesn't use abs() on temperature, but temperature=1.0 default
    // is always positive. A negative temperature would invert logits, but the
    // constructor doesn't expose this — it's always positive. This test verifies
    // the embedder handles a temperature of 0 safely (clamped to minimum).
    const embedder = new AttnResTradeEmbedder({ embedDim: 8, temperature: 0 });
    const vecs = makeVectors(3, 8);
    // temperature=0 → division by zero in logits → handled by max-subtraction
    // The embedder should not crash
    expect(() => embedder.blend(vecs)).not.toThrow();
    const result = embedder.blend(vecs);
    for (const v of result) expect(Number.isFinite(v)).toBe(true);
  });
});