// ─── Ollama Provider ───
// Local Ollama integration as backup LLM provider

import { config } from '../config/index.ts';
import { rootLogger } from '../observability/logger.ts';
import type { LLMProvider, LLMRequest, LLMResponse } from './provider.ts';

const log = rootLogger;

// Default model mapping by temperature
const TEMP_MODEL_MAP: Array<[number, string]> = [
  [0.0, 'deepseek-v4-flash:cloud'],
  [1.0, 'deepseek-v4-flash:cloud'],
];

function suggestModel(temperature: number): string {
  return config.ollama.modelDefault;
}

interface OllamaMessage {
  role: string;
  content: string;
  /** Cloud models (deepseek-v4-flash:cloud, kimi-k2.6:cloud) put reasoning here */
  thinking?: string;
  /** Some cloud variants use response instead of content */
  response?: string;
}

interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'Ollama';
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private available = false;
  /** Track active connections to avoid ephemeral port exhaustion.
   *  v2.0.20: raised from 2 to 4 — with 8 agents thinking in parallel (staggered),
   *  2 slots caused chronic 'slot acquisition timed out' errors whenever two
   *  requests ran long. Ollama's local HTTP server handles 4 concurrent
   *  requests comfortably on typical hardware. */
  private activeRequests = 0;
  private readonly maxConcurrentRequests = 4;

  // ── Circuit breaker ──
  // When Ollama repeatedly times out (e.g. during HL WS reconnect storms that
  // starve the local event loop, or when the local Ollama daemon is overloaded),
  // we trip the breaker so subsequent calls fail-fast instead of each waiting
  // the full 120s. This keeps HACP cycles responsive and lets the caller
  // degrade gracefully to HOLD.
  private consecutiveFailures = 0;
  private breakerOpenedAt = 0;
  /** Number of consecutive failures before the breaker opens (fail-fast). */
  private static readonly BREAKER_THRESHOLD = 3;
  /** How long the breaker stays open before allowing a half-open probe. */
  private static readonly BREAKER_OPEN_MS = 30_000;
  /** Max time to wait for a concurrency slot before failing fast.
   *  v2.0.20: reduced from 15s to 8s — with 4 slots now available, an 8s wait
   *  is enough headroom; failing faster lets the HACP deadline race degrade
   *  the agent to HOLD instead of piling up waiting requests. */
  private static readonly SLOT_ACQUIRE_TIMEOUT_MS = 8_000;

  constructor() {
    this.baseUrl = config.ollama.baseUrl;
    this.defaultModel = config.ollama.modelDefault;
  }

  /** True when the circuit breaker is open (fail-fast mode). */
  private isBreakerOpen(): boolean {
    if (this.consecutiveFailures < OllamaProvider.BREAKER_THRESHOLD) return false;
    const elapsed = Date.now() - this.breakerOpenedAt;
    if (elapsed >= OllamaProvider.BREAKER_OPEN_MS) {
      // Half-open: allow one probe through to test recovery
      log.info(`Ollama circuit breaker half-open after ${elapsed}ms — probing`);
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      log.info(`Ollama circuit breaker closed — recovered after ${this.consecutiveFailures} failures`);
    }
    this.consecutiveFailures = 0;
    this.breakerOpenedAt = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === OllamaProvider.BREAKER_THRESHOLD) {
      this.breakerOpenedAt = Date.now();
      log.warn(`Ollama circuit breaker OPENED after ${this.consecutiveFailures} consecutive failures — fail-fast for ${OllamaProvider.BREAKER_OPEN_MS}ms`);
    }
  }

  /** Wait until we're under the concurrent request limit, or fail fast after
   *  SLOT_ACQUIRE_TIMEOUT_MS. This prevents unbounded busy-wait when all slots
   *  are occupied by slow/timed-out requests.
   *  v2.0.20: before waiting, reclaim any slots held by requests that have
   *  exceeded their own timeout + a grace buffer — this guards against slot
   *  leaks where a fetch hung without the AbortController firing (rare but
   *  possible on network stalls), which would permanently occupy a slot. */
  private async acquireSlot(): Promise<void> {
    // Reclaim leaked slots: if activeRequests > 0 but the oldest slot was
    // acquired more than (requestTimeout + 60s) ago, it's almost certainly
    // leaked (the request should have timed out by now). Decrement to recover.
    this.reclaimLeakedSlots();

    const deadline = Date.now() + OllamaProvider.SLOT_ACQUIRE_TIMEOUT_MS;
    while (this.activeRequests >= this.maxConcurrentRequests) {
      if (Date.now() >= deadline) {
        throw new Error(`Ollama slot acquisition timed out after ${OllamaProvider.SLOT_ACQUIRE_TIMEOUT_MS}ms (all ${this.maxConcurrentRequests} slots busy)`);
      }
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      // Re-check for leaked slots periodically while waiting.
      this.reclaimLeakedSlots();
    }
    this.activeRequests++;
    this.slotAcquiredAt.push(Date.now());
  }

  /** Timestamps of when each active slot was acquired (for leak detection). */
  private slotAcquiredAt: number[] = [];
  /** A slot held longer than this is considered leaked and reclaimed. */
  private static readonly SLOT_LEAK_MS = 90_000; // 90s (45s timeout + 45s grace)

  private reclaimLeakedSlots(): void {
    const now = Date.now();
    let reclaimed = 0;
    while (this.slotAcquiredAt.length > 0 && (now - this.slotAcquiredAt[0]!) > OllamaProvider.SLOT_LEAK_MS) {
      this.slotAcquiredAt.shift();
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      reclaimed++;
    }
    if (reclaimed > 0) {
      log.warn(`Ollama reclaimed ${reclaimed} leaked slot(s) (held > ${OllamaProvider.SLOT_LEAK_MS}ms)`);
    }
  }

  private releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    // Pop the oldest acquired timestamp (FIFO — first acquired is first released).
    if (this.slotAcquiredAt.length > 0) this.slotAcquiredAt.shift();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.available = response.ok;
      return this.available;
    } catch {
      this.available = false;
      log.warn('Ollama is not available locally. Will not use as backup.');
      return false;
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    // Circuit breaker: fail fast when Ollama is in a known-bad state.
    // This prevents every agent from waiting the full 120s timeout during
    // a degraded period (e.g. HL WS reconnect storm starving the event loop,
    // or local Ollama daemon overload).
    if (this.isBreakerOpen()) {
      throw new Error(`Ollama circuit breaker open — failing fast (recovering in ${Math.max(0, OllamaProvider.BREAKER_OPEN_MS - (Date.now() - this.breakerOpenedAt))}ms)`);
    }

    const startTime = performance.now();
    const model = request.model ?? this.defaultModel;
    const maxRetries = 2;

    // Acquire concurrency slot to avoid ephemeral port exhaustion.
    // acquireSlot() now fails fast after SLOT_ACQUIRE_TIMEOUT_MS instead of
    // busy-waiting indefinitely behind slow requests.
    await this.acquireSlot();

    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const body = {
          model,
          messages: request.messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          // Disable thinking for cloud models (deepseek-v4-flash:cloud, kimi-k2.6:cloud)
          // so they output JSON directly without chain-of-thought reasoning.
          think: false,
          options: {
            temperature: request.temperature,
            num_ctx: 8192,
          },
          stream: false,
        };

        log.debug(`Ollama chat: model=${model} think=false temp=${request.temperature}`);

        const controller = new AbortController();
        const timeoutMs = request.timeoutMs ?? 30_000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          if (attempt > 0) {
            // Add jitter to retry backoff to avoid thundering herd
            const jitter = Math.random() * 2000;
            log.info(`Retrying Ollama request (attempt ${attempt}/${maxRetries})...`);
            await new Promise(r => setTimeout(r, 1000 * attempt + jitter));
          }

        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'unknown');
          throw new Error(`Ollama API error ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as Record<string, unknown>;
        const latencyMs = Math.round(performance.now() - startTime);

        // ── Content extraction ──
        // With think:false, cloud models output JSON directly in message.content.
        // Fallback to thinking/reasoning only if content is empty.
        const d = data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const msg = d.message as Record<string, unknown> | undefined;
        const m = msg as any; // eslint-disable-line @typescript-eslint/no-explicit-any

        let content: string = (m?.content as string) ?? '';

        if (!content) {
          content = (m?.response as string) ?? '';
        }

        if (!content) {
          content = (data as any).response as string ?? '';
        }

        if (!content) {
          const thinking = (m?.thinking as string) ?? (m?.reasoning as string) ?? '';
          if (thinking) {
            const jsonStart = thinking.lastIndexOf('{');
            const jsonEnd = thinking.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd > jsonStart) {
              content = thinking.slice(jsonStart, jsonEnd + 1);
            } else {
              const mdJsonMatch = thinking.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
              if (mdJsonMatch?.[1]) {
                content = mdJsonMatch[1];
              } else {
                content = thinking;
              }
            }
            log.warn(`Ollama content empty; extracted from thinking (${content.length} chars)`);
          }
        }

        if (!content) {
          log.warn('Ollama returned empty content; raw keys: ' + Object.keys(data).join(', '));
          log.warn('  Message keys: ' + Object.keys(msg ?? {}).join(', '));
        }

        // Check for truncation
        const doneReason = (data as any).done_reason ?? (data as any).done ?? true;
        if (content && (doneReason === 'length' || doneReason === 'max_tokens')) {
          log.warn(`Ollama response truncated (done_reason=${doneReason}). Consider increasing maxTokens.`);
        }

        if (!content && attempt < maxRetries) {
          log.warn('Empty response, will retry...');
          continue;
        }

        if (!content) {
          throw new Error('Empty response from Ollama');
        }

        // Successful response — reset the circuit breaker.
        this.recordSuccess();
        return {
          content,
          model: (data as any).model as string ?? 'unknown',
          usage: (data as any).prompt_eval_count != null
            ? {
                promptTokens: (data as any).prompt_eval_count as number,
                completionTokens: (data as any).eval_count as number ?? 0,
                totalTokens: ((data as any).prompt_eval_count as number ?? 0) + ((data as any).eval_count as number ?? 0),
              }
            : undefined,
          latencyMs,
        };
        } catch (err) {
          clearTimeout(timeout);
          if (err instanceof DOMException && err.name === 'AbortError') {
            // Timeout — record as a circuit-breaker failure so repeated timeouts
            // trip the breaker and stop further 120s waits.
            this.recordFailure();
            throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
          }
          if (attempt >= maxRetries) {
            this.recordFailure();
            throw err;
          }
          log.warn(`Ollama request failed on attempt ${attempt}, will retry: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.releaseSlot();
    }

    this.recordFailure();
    throw new Error('Empty response from Ollama after retries');
  }
}