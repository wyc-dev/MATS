// ─── LLM Provider Factory ───
// Auto-detects and selects best available LLM provider

import { rootLogger } from '../observability/logger.ts';
import type { LLMProvider, LLMProviderType } from './provider.ts';
import { NIMProvider } from './nim-provider.ts';
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

export async function initializeLLM(preferred?: LLMProviderType): Promise<{
  provider: LLMProvider;
  type: LLMProviderType;
}> {
  // Try NIM first (or if preferred)
  if (!preferred || preferred === 'nim') {
    const nim = new NIMProvider();
    log.info('Checking NVIDIA NIM availability...');
    if (await nim.isAvailable()) {
      activeProvider = nim;
      activeType = 'nim';
      log.info('✓ NVIDIA NIM selected as active LLM provider.', {
        models: ['default', 'fast', 'strong'],
      });
      return { provider: nim, type: 'nim' };
    }
    log.warn('✗ NVIDIA NIM not available.');
  }

  // Fallback to Ollama (always try if NIM failed or not preferred)
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
    'No LLM provider available. Ensure NVIDIA NIM API key is valid or Ollama is running locally.'
  );
}