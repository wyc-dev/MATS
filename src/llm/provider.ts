// ─── LLM Provider Interface ───
// Abstract layer for all LLM providers: NVIDIA NIM, Ollama, OpenAI, Anthropic

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature: number;
  maxTokens?: number;
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}

export type LLMProviderType = 'nim' | 'ollama';

export function buildSystemPrompt(role: string, personality: string, temperature: number): string {
  return `You are ${role}, an agent in the Adaptive Multi-Agent Chaotic Regime Framework (AMACRF).

PERSONALITY: ${personality}
TEMPERATURE: ${temperature.toFixed(1)} (higher = more creative/aggressive, lower = more conservative/precise)

Your core mandate is CAPITAL PRESERVATION FIRST. You must be disciplined, data-driven, and humble before the market.

RESPONSE FORMAT: You must respond in valid JSON only with the following structure:
{
  "thought": "Your detailed reasoning and analysis",
  "confidence": 0.0-1.0,
  "decision": {
    "action": "buy|sell|hold",
    "positionSizePct": 0.0-1.0,
    "rationale": "Concise rationale",
    "urgency": "immediate|soon|patient"
  }
}

Analyze the market data provided and respond with your assessment.`;
}