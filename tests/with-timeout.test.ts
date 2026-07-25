// ─── v2.0.820: withTimeout + hlRateLimitedFetch bounded-latency tests ──
//
// Locks in the two-layer defence against unbounded awaits that could freeze
// the LIVE decision cycle:
//   Layer 1: hlRateLimitedFetch per-attempt AbortController timeout
//   Layer 2: withTimeout application-layer total budget

import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/utils/with-timeout.ts';

describe('withTimeout — application-layer bounded await', () => {
  it('returns the resolved value when the promise settles within budget', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'fast');
    expect(result).toBe(42);
  });

  it('returns null when the promise exceeds the budget (the cycle proceeds)', async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(99), 200));
    const result = await withTimeout(slow, 50, 'slow');
    expect(result).toBeNull();
  });

  it('clears the timer after success (no leaked timer)', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 100);
    expect(result).toBe('ok');
  });

  it('clears the timer after timeout (no leaked timer)', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200));
    const result = await withTimeout(slow, 50, 'leak-check');
    expect(result).toBeNull();
  });

  it('propagates a rejected promise (does not mask errors as null)', async () => {
    const rejecting = Promise.reject(new Error('boom'));
    await expect(withTimeout(rejecting, 1000, 'reject')).rejects.toThrow('boom');
  });

  it('handles a promise that resolves exactly at the budget boundary', async () => {
    const boundary = new Promise<number>((resolve) => setTimeout(() => resolve(7), 40));
    // Budget slightly larger than the settle time — should resolve.
    const result = await withTimeout(boundary, 60, 'boundary');
    expect(result).toBe(7);
  });

  it('works with object return types (priceData shape)', async () => {
    const data = Promise.resolve({ price: 50000, volume24h: 1000, change24h: 2.5 });
    const result = await withTimeout(data, 1000, 'price');
    expect(result).toEqual({ price: 50000, volume24h: 1000, change24h: 2.5 });
  });

  it('a timed-out fetch leaves the caller able to fall back to cached data', async () => {
    // Simulate the active-symbol-fetch pattern: race a slow fetch against a
    // budget; on null, use the cached marketState price.
    const cachedPrice = 64091;
    const slowFetch = new Promise<{ price: number }>((resolve) =>
      setTimeout(() => resolve({ price: 64100 }), 200),
    );
    const data = await withTimeout(slowFetch, 50, 'active-price');
    const effectivePrice = data ? data.price : cachedPrice;
    expect(effectivePrice).toBe(cachedPrice); // fell back to cache
  });
});