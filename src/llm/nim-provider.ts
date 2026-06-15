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

  constructor() {
    this.baseUrl = config.nim.baseUrl;
    this.apiKey = config.nim.apiKey ?? '';
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
        throw new Error(`NIM request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }
}