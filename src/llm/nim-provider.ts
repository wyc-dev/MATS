// ─── NVIDIA NIM Provider ───
// Production-grade NVIDIA NIM integration via OpenAI-compatible REST API

import { config } from '../config/index.ts';
import { rootLogger } from '../observability/logger.ts';
import type { LLMProvider, LLMRequest, LLMResponse } from './provider.ts';

const log = rootLogger;

interface NIMChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class NIMProvider implements LLMProvider {
  readonly name = 'NVIDIA NIM';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private available = false;
  private warmedUpModels = new Set<string>();

  // ── Circuit breaker ──
  // Same rationale as OllamaProvider: repeated timeouts (e.g. during HL WS
  // reconnect storms or NIM API degradation) trip the breaker so subsequent
  // calls fail fast instead of each waiting the full 120s.
  private consecutiveFailures = 0;
  private breakerOpenedAt = 0;
  private static readonly BREAKER_THRESHOLD = 3;
  private static readonly BREAKER_OPEN_MS = 30_000;

  constructor() {
    this.baseUrl = config.nim.baseUrl;
    this.apiKey = config.nim.apiKey ?? '';
  }

  /** True when the circuit breaker is open (fail-fast mode). */
  private isBreakerOpen(): boolean {
    if (this.consecutiveFailures < NIMProvider.BREAKER_THRESHOLD) return false;
    const elapsed = Date.now() - this.breakerOpenedAt;
    if (elapsed >= NIMProvider.BREAKER_OPEN_MS) {
      log.info(`NIM circuit breaker half-open after ${elapsed}ms — probing`);
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0) {
      log.info(`NIM circuit breaker closed — recovered after ${this.consecutiveFailures} failures`);
    }
    this.consecutiveFailures = 0;
    this.breakerOpenedAt = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures === NIMProvider.BREAKER_THRESHOLD) {
      this.breakerOpenedAt = Date.now();
      log.warn(`NIM circuit breaker OPENED after ${this.consecutiveFailures} consecutive failures — fail-fast for ${NIMProvider.BREAKER_OPEN_MS}ms`);
    }
  }

  /**
   * Pre-warm specific model to avoid cold start delays
   * Makes a dummy call to load the model into memory
   */
  async warmUpModel(model: string): Promise<boolean> {
    if (this.warmedUpModels.has(model)) {
      return true; // Already warmed up
    }

    try {
      log.info(`Pre-warming model: ${model}...`);
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a test assistant.' },
            { role: 'user', content: 'Reply with one word: READY' },
          ],
          temperature: 0.1,
          max_tokens: 10,
          stream: false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        this.warmedUpModels.add(model);
        log.info(`✓ Model ${model} warmed up successfully.`);
        return true;
      } else {
        log.warn(`⚠ Model ${model} warm-up failed: ${response.status}`);
        return false;
      }
    } catch (err) {
      log.warn(`⚠ Model ${model} warm-up failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return false;
    }
  }

  /**
   * Warm up all commonly used models
   * Call this during system initialization
   */
  async warmUpAllModels(): Promise<void> {
    const modelsToWarm = [
      config.nim.models.default,
      config.nim.models.fast,
      config.nim.models.strong,
    ];

    log.info('Pre-warming all NIM models...');
    
    // Sequential warm-up to avoid overwhelming the API
    for (const model of modelsToWarm) {
      await this.warmUpModel(model);
      // Small delay between warm-ups
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    log.info(`✓ All models warmed up: ${Array.from(this.warmedUpModels).join(', ')}`);
  }

  async isAvailable(): Promise<boolean> {
    // If no API key, NIM is not available
    if (!this.apiKey) {
      log.debug('NIM API key not configured. Skipping NIM availability check.');
      this.available = false;
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.available = response.ok;
      return this.available;
    } catch {
      this.available = false;
      log.warn('NVIDIA NIM is not available. Check your API key and network.');
      return false;
    }
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    // Circuit breaker: fail fast when NIM is in a known-bad state.
    if (this.isBreakerOpen()) {
      throw new Error(`NIM circuit breaker open — failing fast (recovering in ${Math.max(0, NIMProvider.BREAKER_OPEN_MS - (Date.now() - this.breakerOpenedAt))}ms)`);
    }

    const startTime = performance.now();
    const model = request.model ?? config.nim.models.default;

    const body = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: request.temperature,
      max_tokens: request.maxTokens ?? 4096,
      stream: false,
    };

    const controller = new AbortController();
    // 大幅增加 timeout 到 120 秒（120000ms）
    const timeoutMs = request.timeoutMs ?? 120_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      log.debug(`NIM call: ${model} (timeout: ${timeoutMs}ms, warm=${this.warmedUpModels.has(model) ? 'yes' : 'no'})`);
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`NIM API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as NIMChatResponse;
      const latencyMs = Math.round(performance.now() - startTime);

      const content = data.choices[0]?.message?.content ?? '';
      if (!content) {
        throw new Error('Empty response from NIM');
      }

      this.recordSuccess();
      return {
        content,
        model: data.model,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
        latencyMs,
      };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.recordFailure();
        throw new Error(`NIM request timed out after ${timeoutMs}ms`);
      }
      this.recordFailure();
      throw err;
    }
  }
}