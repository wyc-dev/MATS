// ─── LLM Provider Factory ───
// Auto-detects and selects best available LLM provider

import { rootLogger } from '../observability/logger.ts';
import type { LLMProvider, LLMProviderType } from './provider.ts';
import { OllamaProvider } from './ollama-provider.ts';

const log = rootLogger;

export type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from './provider.ts';
export { buildSystemPrompt } from './provider.ts';

let activeProvider: LLMProvider | null = null;
let activeType: LLMProviderType | null = null;

export function getActiveProvider(): LLMProvider {
  if (!activeProvider) {
    throw new Error('LLM provider not initialized. Call initializeLLM() first.');
  }
  return activeProvider;
}

export function getActiveProviderType(): LLMProviderType {
  if (!activeType) {
    throw new Error('LLM provider not initialized.');
  }
  return activeType;
}

export async function initializeLLM(_preferred?: LLMProviderType): Promise<{
  provider: LLMProvider;
  type: LLMProviderType;
}> {
  const ollama = new OllamaProvider();
  log.info('Checking Ollama availability...');
  if (await ollama.isAvailable()) {
    activeProvider = ollama;
    activeType = 'ollama';
    log.info('✓ Ollama selected as active LLM provider.');
    return { provider: ollama, type: 'ollama' };
  }
  log.warn('✗ Ollama not available.');

  throw new Error(
    'No LLM provider available. Ensure Ollama is running locally or Ollama Pro cloud models are configured.'
  );
}