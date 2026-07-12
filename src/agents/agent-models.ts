// ─── Agent Model Configuration ───
// Per-agent model overrides — allows UI to change which model each agent uses

import { config } from '../config/index.ts';
import type { AgentRole } from '../types/index.ts';

export interface AgentModelConfig {
  role: AgentRole;
  model: string;
  label: string;
}

// Available model definitions
export interface ModelDefinition {
  id: string;
  label: string;
  provider: 'nim' | 'ollama';
  category: 'fast' | 'default' | 'strong';
}

// All available models across providers
export const AVAILABLE_MODELS: ModelDefinition[] = [
  // NVIDIA NIM models
  { id: 'nvidia/llama-3.1-nemotron-8b-instruct', label: 'Nemotron 8B (Fast)', provider: 'nim', category: 'fast' },
  { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', provider: 'nim', category: 'default' },
  { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (Strong)', provider: 'nim', category: 'strong' },
  { id: 'mistralai/mistral-large', label: 'Mistral Large', provider: 'nim', category: 'default' },
  { id: 'google/gemma-2-27b-it', label: 'Gemma 2 27B', provider: 'nim', category: 'default' },
  // Ollama models
  { id: 'kimi-k2.6:cloud', label: 'Kimi K2.6 (Cloud)', provider: 'ollama', category: 'default' },
  { id: 'deepseek-v4-flash:cloud', label: 'DeepSeek V4 Flash', provider: 'ollama', category: 'fast' },
  { id: 'deepseek-v4-pro:cloud', label: 'DeepSeek V4 Pro', provider: 'ollama', category: 'strong' },
  { id: 'qwen3.5:397b-cloud', label: 'Qwen 3.5 397B Cloud', provider: 'ollama', category: 'strong' },
  { id: 'qwen3-coder:30b', label: 'Qwen 3 Coder 30B', provider: 'ollama', category: 'fast' },
  { id: 'kimi-k2.5:cloud', label: 'Kimi K2.5 (Cloud)', provider: 'ollama', category: 'default' },
  { id: 'gemma4:31b-cloud', label: 'Gemma 4 31B Cloud', provider: 'ollama', category: 'default' },
  { id: 'glm-5:cloud', label: 'GLM-5 (Cloud)', provider: 'ollama', category: 'default' },
  { id: 'glm-5.2:cloud', label: 'GLM-5.2 (Cloud)', provider: 'ollama', category: 'default' },
];

// Default model mapping per agent role — provider-aware (lazy)
let defaultModelMap: Record<AgentRole, string> | null = null;

function getDefaultModelMap(): Record<AgentRole, string> {
  if (defaultModelMap) return defaultModelMap;

  // Ollama is the only provider
  defaultModelMap = {
    // Sub-agents use glm-5.2:cloud — balanced speed/capability for parallel inference
    // Meta-agent uses deepseek-v4-flash:cloud — faster for arbitration/synthesis
    // Risk Auditor uses deepseek-v4-flash:cloud — fast + analytical for risk veto decisions
    // Regime guardian uses 2048 maxTokens (set in agents.ts) for verbose JSON
    fractal_momentum_sentinel: 'glm-5.2:cloud',
    onchain_whisperer: 'glm-5.2:cloud',
    rbc_sentiment_analyst: 'glm-5.2:cloud',
    independent_risk_auditor: 'deepseek-v4-flash:cloud',
    meta_agent: 'deepseek-v4-flash:cloud',
    // v2.0.76: News Reporter uses DeepSeek V4 Flash — cold, analytical, fast.
    // The Shadow Strategist mandate (source/motive/conspiracy analysis) demands
    // sharp reasoning without hype-chasing; Flash keeps the 8-agent parallel
    // Phase 1 within budget.
    news_reporter: 'deepseek-v4-flash:cloud',
    skeptics: 'deepseek-v4-flash:cloud',
    market_agent: 'glm-5.2:cloud',
  };
  return defaultModelMap;
}

// In-memory per-agent model overrides (mutable at runtime)
const agentModelOverrides = new Map<AgentRole, string>();

/** Get the effective model for an agent — override or default */
export function getAgentModel(role: AgentRole): string {
  return agentModelOverrides.get(role) ?? getDefaultModelMap()[role] ?? config.ollama.modelDefault;
}

/** Set a per-agent model override */
export function setAgentModel(role: AgentRole, modelId: string): boolean {
  const valid = AVAILABLE_MODELS.some(m => m.id === modelId);
  if (!valid) return false;
  agentModelOverrides.set(role, modelId);
  return true;
}

/** Reset an agent to its default model */
export function resetAgentModel(role: AgentRole): void {
  agentModelOverrides.delete(role);
}

/** Get all current agent model assignments */
export function getAllAgentModels(): AgentModelConfig[] {
  const roles: AgentRole[] = [
    'fractal_momentum_sentinel',
    'onchain_whisperer',
    'rbc_sentiment_analyst',
    'independent_risk_auditor',
    'meta_agent',
    'market_agent',
    'news_reporter',
    'skeptics',
  ];
  return roles.map(role => {
    const model = getAgentModel(role);
    const def = AVAILABLE_MODELS.find(m => m.id === model);
    return {
      role,
      model,
      label: def?.label ?? model,
    };
  });
}

/** Get available models, optionally filtered by provider */
export function getAvailableModels(provider?: 'nim' | 'ollama'): ModelDefinition[] {
  if (provider) return AVAILABLE_MODELS.filter(m => m.provider === provider);
  return [...AVAILABLE_MODELS];
}

/**
 * v2.0.121: Get dynamically available models based on Ollama plan + actual
 * installed models from /api/tags. This replaces the static AVAILABLE_MODELS
 * list for the UI model dropdown.
 *
 * Logic:
 * - Free plan: only show models that are actually installed locally (from /api/tags)
 *   + kimi-k2.6:cloud (the one free cloud model). If user has local models
 *   like glm-5.2 installed, they'll appear.
 * - Pro/Max plan: show all AVAILABLE_MODELS (cloud models accessible)
 * - None: show empty list (Ollama not connected)
 */
export async function getDynamicAvailableModels(ollamaPlan: string, ollamaBaseUrl: string): Promise<ModelDefinition[]> {
  if (ollamaPlan === 'None') {
    return [];
  }

  if (ollamaPlan === 'Free') {
    // For Free plan, query /api/tags to see what's actually installed
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok) {
        const tagsData = await response.json() as { models?: Array<{ name: string }> };
        const installedNames = tagsData.models?.map(m => m.name) ?? [];

        // Build model list from actually installed models
        const dynamicModels: ModelDefinition[] = [];

        // Always include kimi-k2.6:cloud (the free cloud model)
        const kimiDef = AVAILABLE_MODELS.find(m => m.id === 'kimi-k2.6:cloud');
        if (kimiDef) dynamicModels.push(kimiDef);

        // Add any locally installed models that aren't cloud-only
        for (const name of installedNames) {
          // Skip if already in the list
          if (dynamicModels.some(m => m.id === name)) continue;
          // Skip cloud models that aren't kimi-k2.6 (Free plan can't use other cloud models)
          if (name.includes(':cloud') && name !== 'kimi-k2.6:cloud') continue;
          // Find in AVAILABLE_MODELS or create a dynamic entry
          const existing = AVAILABLE_MODELS.find(m => m.id === name);
          if (existing) {
            dynamicModels.push(existing);
          } else {
            // Locally installed model not in our static list — add it
            dynamicModels.push({
              id: name,
              label: name.replace(/:cloud$/, ' (Cloud)').replace(/-/g, ' '),
              provider: 'ollama',
              category: 'default',
            });
          }
        }

        return dynamicModels;
      }
    } catch { /* fall through to static list */ }
    // Fallback: just kimi-k2.6:cloud
    return AVAILABLE_MODELS.filter(m => m.id === 'kimi-k2.6:cloud');
  }

  // Pro/Max: show all models, but also check /api/tags for any locally
  // installed models not in our static list
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${ollamaBaseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      const tagsData = await response.json() as { models?: Array<{ name: string }> };
      const installedNames = tagsData.models?.map(m => m.name) ?? [];

      const dynamicModels = [...AVAILABLE_MODELS];
      for (const name of installedNames) {
        if (dynamicModels.some(m => m.id === name)) continue;
        dynamicModels.push({
          id: name,
          label: name.replace(/:cloud$/, ' (Cloud)').replace(/-/g, ' '),
          provider: 'ollama',
          category: 'default',
        });
      }
      return dynamicModels;
    }
  } catch { /* fall through to static list */ }

  return [...AVAILABLE_MODELS];
}
