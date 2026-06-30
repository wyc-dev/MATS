// ─── Global HL Rate Limiter ───
// Single shared rate limiter for ALL Hyperliquid REST API calls.
// Prevents 429 errors by enforcing a minimum gap between requests
// across every module that hits api.hyperliquid.xyz/info or /exchange.
//
// Usage:
//   import { hlRateLimitedFetch } from './hl-global-limiter.ts';
//   const res = await hlRateLimitedFetch(url, options);
//
// This replaces the scattered per-module rate limiters (MarketAgent.hlLimiter,
// the candle-proxy's lastHLCall gap, the bgLimiters in fetchTopPairs, etc.)
// with ONE global queue. No module can exceed the global budget.

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'hl-limiter' });

// HL's REST API allows ~20 req/s per IP, but sustained bursts trigger 429.
// We use a conservative 5 req/s global budget (200ms gap) to stay well under
// the limit while keeping latency low.
const MIN_GAP_MS = 200;
const MAX_RETRIES = 5;

let lastCallTime = 0;
let queue: Array<() => void> = [];
let processing = false;

/** Acquire a slot — resolves when it's this caller's turn. */
async function acquire(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lastCallTime + MIN_GAP_MS - now);
  if (wait === 0 && !processing && queue.length === 0) {
    // Fast path — no queue, gap already elapsed
    lastCallTime = now;
    return;
  }
  // Slow path — queue up
  return new Promise<void>((resolve) => {
    queue.push(resolve);
    void processQueue();
  });
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const now = Date.now();
    const wait = Math.max(0, lastCallTime + MIN_GAP_MS - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCallTime = Date.now();
    const resolve = queue.shift()!;
    resolve();
  }
  processing = false;
}

/**
 * Rate-limited fetch for Hyperliquid API.
 * Enforces a global minimum gap between all HL requests across all modules.
 * Retries on 429 with exponential backoff.
 */
export async function hlRateLimitedFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await acquire();
    const res = await fetch(url, options);
    if (res.status !== 429) return res;

    const delay = Math.min(1000 * 2 ** attempt, 8000);
    log.warn(`HL 429 for ${url.split('/').pop() ?? url}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
    await new Promise(r => setTimeout(r, delay));
  }
  throw new Error(`Hyperliquid API 429 after ${MAX_RETRIES} retries`);
}

/**
 * Rate-limited fetch that returns parsed JSON.
 * Convenience wrapper for the common pattern: fetch → json.
 */
export async function hlRateLimitedFetchJson<T>(
  url: string,
  body: unknown,
): Promise<T> {
  const res = await hlRateLimitedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}