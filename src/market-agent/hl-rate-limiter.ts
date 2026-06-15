// ─── HL Rate Limiter (token-bucket) ───
// Hyperliquid REST endpoint has generous limits but we need to throttle
// our parallel calls. One token per request, refills at N tokens per second.

const HL_RATE_LIMIT = 8;  // max tokens
const HL_REFILL_MS = 3000;  // refill one token every 3 seconds (≈ 20 req/min)

export class HLRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;

  constructor(maxTokens = HL_RATE_LIMIT, refillIntervalMs = HL_REFILL_MS) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.maxTokens = maxTokens;
    this.refillIntervalMs = refillIntervalMs;
  }

  /** Wait until a token is available, then consume it */
  async acquire(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      const waitMs = this.refillIntervalMs;
      await new Promise(r => setTimeout(r, waitMs));
      this.refill();
    }
    this.tokens--;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillIntervalMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }
}