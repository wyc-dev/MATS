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
// v2.0.79: Increased from 200ms to 400ms gap (2.5 req/s) — 200ms was too
// aggressive when multiple modules fire simultaneously (S/R candles, balance,
// positions, fills, options data, market agent). The 429 retry storm was
// caused by too many requests in too short a window.
const MIN_GAP_MS = 400;
const MAX_RETRIES = 5;

let lastCallTime = 0;
let queue: Array<() => void> = [];
let processing = false;
// v2.0.79: Global cooldown after 429 — pauses ALL new requests for a
// short period so HL has time to recover. Without this, 429 retries
// compete with new requests, causing a cascade of 429s.
let cooldownUntil = 0;

/** Acquire a slot — resolves when it's this caller's turn. */
async function acquire(): Promise<void> {
  // If in cooldown, wait until it expires
  const cooldownRemaining = cooldownUntil - Date.now();
  if (cooldownRemaining > 0) {
    await new Promise(r => setTimeout(r, cooldownRemaining));
  }

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
    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      // Network-level error (DNS failure, connection refused, timeout).
      // Retry with backoff — the network may recover.
      const isDns = err instanceof Error && (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo'));
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      if (isDns && attempt < 2) {
        // First couple DNS failures — short backoff, might be transient
        log.warn(`HL fetch network error (DNS), retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      } else if (isDns) {
        // Sustained DNS failure — network is down. Don't spam logs.
        // Throw immediately so callers can handle it (REST polling backs off).
        throw err;
      } else {
        log.warn(`HL fetch error: ${err instanceof Error ? err.message : String(err)}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      }
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if (res.status !== 429) return res;

    // v2.0.79: Set global cooldown so all queued requests pause too
    const cooldownMs = Math.min(1000 * 2 ** attempt, 8000);
    cooldownUntil = Date.now() + cooldownMs;
    log.warn(`HL 429 for ${url.split('/').pop() ?? url}, retry ${attempt + 1}/${MAX_RETRIES} in ${cooldownMs}ms (global cooldown activated)`);
    await new Promise(r => setTimeout(r, cooldownMs));
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