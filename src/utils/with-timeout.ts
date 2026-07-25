// ─── withTimeout — application-layer bounded-await utility ──────────────
//
// Race a promise against a hard timeout. Returns the resolved value, or
// `null` if the timeout fires first. The underlying promise is NOT cancelled
// (Node has no general promise cancellation) — it continues to settle in the
// background, which is acceptable because:
//   1. The HL rate limiter (`hlRateLimitedFetch`) gates each retry attempt,
//      so background retries are paced, not a tight spin.
//   2. A genuinely hung fetch is rare; when it happens the per-attempt
//      AbortController in `hlRateLimitedFetch` (Layer 1) bounds each attempt
//      to 15s, so the background work self-terminates within ~75s worst case.
//   3. The abandoned promise is GC'd once it settles.
//
// Usage:
//   const data = await withTimeout(fetchPriceForSymbol(sym), 10_000, 'active-price');
//   if (!data) { /* fall back to cached marketState price */ }
//
// This is the application-layer guard. The foundational guard
// (per-attempt AbortController timeout) lives in `hlRateLimitedFetch`.

/**
 * Race `promise` against a `ms` millisecond timeout.
 * @returns The resolved value, or `null` on timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label?: string,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      if (label) {
        // Best-effort log via console — avoid importing the logger here to
        // keep this utility dependency-free (usable from any module).
        console.warn(`[withTimeout] "${label}" exceeded ${ms}ms budget — returning null`);
      }
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}