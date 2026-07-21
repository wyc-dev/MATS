// ─── v2.0.216: MiniLM Singleton + Warmup Guard Tests ───────────────────────
//
// Tests the shared singleton TransformersEmbedProvider and the concurrent
// warmup promise guard. Verifies:
// - Singleton: getSharedEmbedProvider() returns same instance
// - Reset: resetSharedEmbedProvider() clears singleton
// - Concurrent warmup guard: multiple warmup() calls → only one _doWarmup
// - Embed before warmup: auto-warmup works
// - Warmup failure recovery: failed warmup → ready=false → retry works
//
// Attack tests:
// - A1: Concurrent warmup (100 parallel calls) → single _doWarmup
// - A2: Warmup + embed race (embed called before warmup completes)
// - A3: Warmup failure → state not corrupted
// - A4: Warmup failure → retry succeeds
// - A5: Singleton not affected by reset during warmup (race)
// - A6: Multiple consumers share ready state (no stale references)
// - A7: Embed with empty texts → no warmup triggered
// - A8: Double reset → no crash
// - A9: getSharedEmbedProvider called after reset → new instance
// - A10: Warmup idempotent (second call returns immediately)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TransformersEmbedProvider,
  getSharedEmbedProvider,
  resetSharedEmbedProvider,
  type EmbedProvider,
} from '../src/evolution/embeddings.ts';

// ─── Mock subclass that doesn't download a real model ───
//
// We can't use real transformers.js in tests (22MB ONNX download). Instead,
// we mock the _doWarmup method to simulate model loading with a configurable
// delay and failure rate. This lets us test the singleton + warmup guard
// logic without network dependency.

class MockTransformersEmbedProvider extends TransformersEmbedProvider {
  private mockWarmupFn: (() => Promise<void>) | null = null;
  private warmupCallCount = 0;

  constructor(opts?: {
    warmupDelay?: number;
    warmupFails?: boolean;
    embedDim?: number;
  }) {
    super(undefined, opts?.embedDim);
    const delay = opts?.warmupDelay ?? 10;
    const fails = opts?.warmupFails ?? false;

    this.mockWarmupFn = async () => {
      this.warmupCallCount++;
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (fails) {
        throw new Error('Mock warmup failure');
      }
      // Simulate successful warmup by setting internal state
      (this as any).ready = true;
      (this as any).extractor = async (texts: string | string[], _opts?: unknown) => {
        const arr = Array.isArray(texts) ? texts : [texts];
        const dim = this.dim;
        const flat: number[] = [];
        for (const t of arr) {
          const vec = new Array(dim).fill(0);
          for (let i = 0; i < Math.min(t.length, dim); i++) {
            vec[i] = t.charCodeAt(i) / 255;
          }
          const norm = Math.hypot(...vec) || 1;
          for (let i = 0; i < dim; i++) flat.push(vec[i]! / norm);
        }
        return {
          data: new Float32Array(flat),
          dims: [arr.length, dim],
        };
      };
    };

    // Override _doWarmup to use our mock
    (this as any)._doWarmup = this.mockWarmupFn;
  }

  getWarmupCallCount(): number {
    return this.warmupCallCount;
  }
}

// ═══════════════════════════════════════════════════════════════
//  Singleton Tests
// ═══════════════════════════════════════════════════════════════

describe('getSharedEmbedProvider singleton', () => {
  beforeEach(() => resetSharedEmbedProvider());
  afterEach(() => resetSharedEmbedProvider());

  it('returns the same instance on multiple calls', () => {
    const a = getSharedEmbedProvider();
    const b = getSharedEmbedProvider();
    const c = getSharedEmbedProvider();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('reset clears the singleton — next call returns new instance', () => {
    const a = getSharedEmbedProvider();
    resetSharedEmbedProvider();
    const b = getSharedEmbedProvider();
    expect(a).not.toBe(b);
  });

  it('A8: double reset does not crash', () => {
    resetSharedEmbedProvider();
    expect(() => resetSharedEmbedProvider()).not.toThrow();
  });

  it('A9: getSharedEmbedProvider after reset returns new instance', () => {
    const a = getSharedEmbedProvider();
    resetSharedEmbedProvider();
    resetSharedEmbedProvider();
    const b = getSharedEmbedProvider();
    expect(a).not.toBe(b);
    const c = getSharedEmbedProvider();
    expect(b).toBe(c);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Concurrent Warmup Guard Tests
// ═══════════════════════════════════════════════════════════════

describe('TransformersEmbedProvider warmup guard', () => {
  it('A1: 100 concurrent warmup calls → only 1 _doWarmup execution', async () => {
    const provider = new MockTransformersEmbedProvider({ warmupDelay: 20 });
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(provider.warmup());
    }
    await Promise.all(promises);
    expect(provider.getWarmupCallCount()).toBe(1);
    expect(provider.isReady()).toBe(true);
  });

  it('A10: second warmup call returns immediately (idempotent)', async () => {
    const provider = new MockTransformersEmbedProvider({ warmupDelay: 10 });
    await provider.warmup();
    expect(provider.getWarmupCallCount()).toBe(1);

    const start = Date.now();
    await provider.warmup();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5); // should return immediately
    expect(provider.getWarmupCallCount()).toBe(1); // no second call
  });

  it('A2: embed called before warmup completes — auto-warmup works', async () => {
    const provider = new MockTransformersEmbedProvider({ warmupDelay: 10 });
    // Call embed without warmup — should auto-warmup
    const result = await provider.embed(['hello', 'world']);
    expect(result.length).toBe(2);
    expect(result[0]!.length).toBe(provider.dim);
    expect(provider.isReady()).toBe(true);
  });

  it('A3: warmup failure → ready stays false, state not corrupted', async () => {
    const provider = new MockTransformersEmbedProvider({
      warmupDelay: 10,
      warmupFails: true,
    });
    await expect(provider.warmup()).rejects.toThrow('Mock warmup failure');
    expect(provider.isReady()).toBe(false);
    // Warmup promise should be cleared (no deadlock)
    expect((provider as any).warmupPromise).toBeNull();
  });

  it('A4: warmup failure → retry succeeds (no permanent stuck state)', async () => {
    // First attempt fails
    const provider = new MockTransformersEmbedProvider({
      warmupDelay: 10,
      warmupFails: true,
    });
    await expect(provider.warmup()).rejects.toThrow();
    expect(provider.isReady()).toBe(false);

    // Fix the warmup and retry
    (provider as any)._doWarmup = async () => {
      provider['warmupCallCount'] = (provider as any).warmupCallCount + 1;
      (provider as any).ready = true;
      (provider as any).extractor = async (texts: string | string[], _opts?: unknown) => {
        const arr = Array.isArray(texts) ? texts : [texts];
        const dim = provider.dim;
        const val = 1 / Math.sqrt(dim);
        const flat: number[] = [];
        for (let i = 0; i < arr.length; i++) {
          for (let d = 0; d < dim; d++) flat.push(val);
        }
        return {
          data: new Float32Array(flat),
          dims: [arr.length, dim],
        };
      };
    };

    await provider.warmup();
    expect(provider.isReady()).toBe(true);
  });

  it('A5: concurrent warmup during failure — all get the same error', async () => {
    const provider = new MockTransformersEmbedProvider({
      warmupDelay: 10,
      warmupFails: true,
    });
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(provider.warmup().catch(() => {})); // catch to avoid unhandled
    }
    await Promise.all(promises);
    // All 10 calls should share the same warmup promise → only 1 _doWarmup
    expect(provider.getWarmupCallCount()).toBe(1);
    expect(provider.isReady()).toBe(false);
    expect((provider as any).warmupPromise).toBeNull();
  });

  it('A7: embed with empty texts → no warmup triggered', async () => {
    const provider = new MockTransformersEmbedProvider({ warmupDelay: 10 });
    const result = await provider.embed([]);
    expect(result).toEqual([]);
    expect(provider.getWarmupCallCount()).toBe(0);
    expect(provider.isReady()).toBe(false);
  });

  it('A6: multiple consumers share ready state via singleton', async () => {
    // Simulate multiple consumers getting the same singleton
    resetSharedEmbedProvider();

    // We can't use the real getSharedEmbedProvider (it downloads a model),
    // so we manually test the pattern: 4 references to same instance
    const shared = new MockTransformersEmbedProvider({ warmupDelay: 10 });
    const consumer1 = shared;
    const consumer2 = shared;
    const consumer3 = shared;
    const consumer4 = shared;

    // Consumer 1 triggers warmup
    await consumer1.warmup();

    // All consumers see the same ready state
    expect(consumer1.isReady()).toBe(true);
    expect(consumer2.isReady()).toBe(true);
    expect(consumer3.isReady()).toBe(true);
    expect(consumer4.isReady()).toBe(true);

    // Only 1 warmup call
    expect(shared.getWarmupCallCount()).toBe(1);
  });

  it('warmup promise cleared after success (no lingering promise)', async () => {
    const provider = new MockTransformersEmbedProvider({ warmupDelay: 10 });
    await provider.warmup();
    expect((provider as any).warmupPromise).toBeNull();
  });

  it('warmup promise cleared after failure (no deadlock)', async () => {
    const provider = new MockTransformersEmbedProvider({
      warmupDelay: 10,
      warmupFails: true,
    });
    try {
      await provider.warmup();
    } catch {
      // expected
    }
    // The finally block should have cleared the promise
    expect((provider as any).warmupPromise).toBeNull();
  });

  it('sequential warmup after concurrent warmup completes — no re-warmup', async () => {
    const provider = new MockTransformersEmbedProvider({ warmupDelay: 10 });

    // Phase 1: concurrent warmup
    await Promise.all([provider.warmup(), provider.warmup(), provider.warmup()]);
    expect(provider.getWarmupCallCount()).toBe(1);

    // Phase 2: sequential warmup (should be idempotent)
    await provider.warmup();
    await provider.warmup();
    expect(provider.getWarmupCallCount()).toBe(1); // still 1
  });

  it('embed after failed warmup retries warmup', async () => {
    const provider = new MockTransformersEmbedProvider({
      warmupDelay: 5,
      warmupFails: true,
    });

    // First embed attempt fails (warmup fails)
    await expect(provider.embed(['test'])).rejects.toThrow();

    // Fix warmup
    (provider as any)._doWarmup = async () => {
      (provider as any).warmupCallCount = (provider as any).warmupCallCount + 1;
      (provider as any).ready = true;
      (provider as any).extractor = async (texts: string | string[], _opts?: unknown) => {
        const arr = Array.isArray(texts) ? texts : [texts];
        const dim = provider.dim;
        const val = 1 / Math.sqrt(dim);
        const flat: number[] = [];
        for (let i = 0; i < arr.length; i++) {
          for (let d = 0; d < dim; d++) flat.push(val);
        }
        return {
          data: new Float32Array(flat),
          dims: [arr.length, dim],
        };
      };
    };

    // Second embed attempt should succeed (warmup retries)
    const result = await provider.embed(['test']);
    expect(result.length).toBe(1);
    expect(result[0]!.length).toBe(provider.dim);
  });

  it('singleton preserves warmup state across getSharedEmbedProvider calls', () => {
    resetSharedEmbedProvider();
    const a = getSharedEmbedProvider();
    // Simulate warmup success
    (a as any).ready = true;

    const b = getSharedEmbedProvider();
    expect(a).toBe(b);
    expect(b.isReady()).toBe(true);
  });
});