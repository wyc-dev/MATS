// ─── Agent Model Configuration ───
// Per-agent model overrides — allows UI to change which model each agent uses

import { config } from '../config/index.ts';
import { getActiveProviderType } from '../llm/index.ts';
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
];

// Default model mapping per agent role — provider-aware (lazy)
let defaultModelMap: Record<AgentRole, string> | null = null;

function getDefaultModelMap(): Record<AgentRole, string> {
  if (defaultModelMap) return defaultModelMap;

  let provider: string;
  try { provider = getActiveProviderType(); } catch { provider = 'nim'; }

  if (provider === 'ollama') {
    defaultModelMap = {
      // Sub-agents use kimi-k2.6:cloud — balanced speed/capability for parallel inference
      // Meta-agent uses deepseek-v4-flash:cloud — faster for arbitration/synthesis
      // Regime guardian uses 2048 maxTokens (set in agents.ts) for verbose JSON
      fractal_momentum_sentinel: 'kimi-k2.6:cloud',
      onchain_whisperer: 'kimi-k2.6:cloud',
      regime_risk_guardian: 'kimi-k2.6:cloud',
      independent_risk_auditor: 'kimi-k2.6:cloud',
      meta_agent: 'deepseek-v4-flash:cloud',
      news_reporter: 'kimi-k2.6:cloud',
      skeptics: 'deepseek-v4-flash:cloud',
      market_agent: 'kimi-k2.6:cloud',
    };
  } else {
    defaultModelMap = {
      fractal_momentum_sentinel: config.nim.models.fast,
      onchain_whisperer: config.nim.models.default,
      regime_risk_guardian: config.nim.models.default,
      independent_risk_auditor: config.nim.models.default,
      meta_agent: config.nim.models.strong,
      news_reporter: config.nim.models.default,
      skeptics: config.nim.models.fast,
      market_agent: config.nim.models.default,
    };
  }
  return defaultModelMap;
}

// In-memory per-agent model overrides (mutable at runtime)
const agentModelOverrides = new Map<AgentRole, string>();

/** Get the effective model for an agent — override or default */
export function getAgentModel(role: AgentRole): string {
  return agentModelOverrides.get(role) ?? getDefaultModelMap()[role] ?? config.nim.models.default;
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
    'regime_risk_guardian',
    'independent_risk_auditor',
    'meta_agent',
    'market_agent',
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
