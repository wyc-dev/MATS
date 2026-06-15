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
  /** Track active connections to avoid ephemeral port exhaustion */
  private activeRequests = 0;
  private readonly maxConcurrentRequests = 2;

  constructor() {
    this.baseUrl = config.ollama.baseUrl;
    this.defaultModel = config.ollama.modelDefault;
  }

  /** Wait until we're under the concurrent request limit */
  private async acquireSlot(): Promise<void> {
    while (this.activeRequests >= this.maxConcurrentRequests) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    }
    this.activeRequests++;
  }

  private releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
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
    const startTime = performance.now();
    const model = request.model ?? this.defaultModel;
    const maxRetries = 2;

    // Acquire concurrency slot to avoid ephemeral port exhaustion
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
            throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
          }
          if (attempt >= maxRetries) {
            throw err;
          }
          log.warn(`Ollama request failed on attempt ${attempt}, will retry: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.releaseSlot();
    }

    throw new Error('Empty response from Ollama after retries');
  }
}