// ─── Base Agent (v1.9.2 — Multi-Symbol) ───
// Abstract foundation for all sub-agents with LLM integration, lifecycle, and logging.
// Each agent now evaluates ALL trading pairs every cycle:
//   1) The market ticker (buy/sell/hold)
//   2) Each open position (close/hold + SL/TP adjustments)

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { getActiveProvider } from '../llm/index.ts';
import { config } from '../config/index.ts';
import { getAgentModel } from './agent-models.ts';
import type {
  AgentIdentity,
  AgentRole,
  AgentThought,
  TradingDecision,
  AgentStatus,
  MultiSymbolDecision,
  PerSymbolDecision,
  PositionContext,
} from '../types/index.ts';
import { normalizePerSymbolDecision } from '../trading/decision-utils.ts';

export interface BaseAgentConfig {
  role: AgentRole;
  name: string;
  temperature: number;
  weight: number;
  modelPreference: 'fast' | 'default' | 'strong';
  personality: string;
  /** Max tokens for LLM response. Higher values reduce JSON truncation risk. */
  maxTokens?: number;
}

/** Position summary string injected into agent context */
function buildPositionsContext(positions: PositionContext[]): string {
  if (positions.length === 0) return 'No open positions.';
  return positions.map(p => {
    const pnl = p.unrealizedPnlPct >= 0 ? '+' : '';
    return `  ${p.symbol} | ${p.side.toUpperCase()} | Qty:${p.quantity.toFixed(4)} | Entry:$${p.averageEntryPrice.toFixed(2)} | Mark:$${p.currentPrice.toFixed(2)} | PnL:${pnl}${(p.unrealizedPnlPct * 100).toFixed(2)}% | SL:${p.stopLossPrice ? '$'+p.stopLossPrice.toFixed(2) : 'NONE'} | TP:${p.takeProfitPrice ? '$'+p.takeProfitPrice.toFixed(2) : 'NONE'} | Lev:${p.leverage}x${p.exchange ? ` | ${p.exchange}` : ''}`;
  }).join('\n');
}

export abstract class BaseAgent {
  readonly identity: AgentIdentity;
  readonly personality: string;
  protected readonly logger: ReturnType<typeof createLogger>;
  protected status: AgentStatus['state'] = 'idle';
  protected decisionsGenerated = 0;
  protected totalConfidence = 0;
  protected lastThoughtTimestamp = 0;

  protected readonly maxTokens: number;

  /** Current positions context for this cycle */
  protected currentPositions: PositionContext[] = [];
  /** The actively selected market ticker symbol */
  protected marketSymbol: string = 'BTCUSDT';

  constructor(cfg: BaseAgentConfig) {
    this.identity = {
      id: uuidv4(),
      role: cfg.role,
      name: cfg.name,
      temperature: cfg.temperature,
      weight: cfg.weight,
      modelPreference: cfg.modelPreference,
    };
    this.personality = cfg.personality;
    this.maxTokens = cfg.maxTokens ?? 1024;
    this.logger = createLogger({ agent: cfg.role, phase: 'thinking' });
  }

  getStatus(): AgentStatus {
    return {
      agentId: this.identity.id,
      role: this.identity.role,
      lastThoughtTimestamp: this.lastThoughtTimestamp,
      decisionsGenerated: this.decisionsGenerated,
      averageConfidence:
        this.decisionsGenerated > 0
          ? this.totalConfidence / this.decisionsGenerated
          : 0,
      state: this.status,
    };
  }

  abstract getSystemPrompt(): string;

  /** Build the per-agent JSON format instruction — agents override to customize */
  protected getOutputFormatInstruction(): string {
    return `You MUST respond with ONLY valid JSON. Output a JSON object with:
{
  "thought": "...your analysis...",
  "overallConfidence": 0.0-1.0,
  "marketTicker": {
    "symbol": "${this.marketSymbol}",
    "action": "buy|sell|hold",
    "positionSizePct": 0.0-0.20,
    "leverage": 1-10,
    "closePosition": false,
    "rationale": "..."
  },
  "positions": [
    {
      "symbol": "POSITION_SYMBOL",
      "action": "hold|close",
      "closePosition": true|false,
      "closeUrgency": "immediate|soon|patient",
      "suggestedStopLoss": PRICE_OR_NULL,
      "suggestedTakeProfit": PRICE_OR_NULL,
      "rationale": "..."
    }
  ]
}

RULES:
- "marketTicker" = your view on the currently selected trading pair
- Each entry in "positions" = your view on one open position
- For positions: action "hold" = keep open, action "close" = close immediately
- Set "closePosition": true + "closeUrgency" when you want to exit
- Set suggestedStopLoss/suggestedTakeProfit to adjust SL/TP levels (or omit/null to leave unchanged)
- "overallConfidence" = how confident you are in ALL your decisions combined`;
  }

  async think(
    marketState: string,
    portfolioSnapshot: string,
    positions?: PositionContext[],
  ): Promise<AgentThought> {
    this.status = 'thinking';
    this.lastThoughtTimestamp = Date.now();

    if (positions) this.currentPositions = positions;
    // Extract market symbol from market state
    const symMatch = marketState.match(/Selected Symbol:\s*(\S+)/i) ?? marketState.match(/Symbol:\s*(\S+)/i);
    if (symMatch?.[1]) this.marketSymbol = symMatch[1];

    try {
      const provider = getActiveProvider();
      const systemPrompt = this.getSystemPrompt();
      const posCtx = buildPositionsContext(this.currentPositions);

      const response = await provider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: `Market:\n${marketState}\n\nPortfolio Overview:\n${portfolioSnapshot}\n\nOpen Positions:\n${posCtx}\n\n${this.getOutputFormatInstruction()}`,
          },
        ],
        temperature: this.identity.temperature,
        model: this.resolveModel(),
        // Tiered timeout: 45s for the LLM call, leaving a 15s buffer under the
        // HACP Phase 1 deadline race (60s). Previously 120s, which meant a
        // single stalled agent (e.g. Ollama during HL WS reconnect) blocked
        // the entire HACP cycle for 2 minutes. The HACP deadline race now
        // catches any overflow and degrades to a graceful HOLD.
        timeoutMs: 45_000,
      });

      const parsed = this.parseMultiSymbolResponse(response.content);

      const thought: AgentThought = {
        agentId: this.identity.id,
        agentRole: this.identity.role,
        thought: parsed.thought,
        confidence: parsed.overallConfidence,
        timestamp: Date.now(),
        metadata: {
          latency: response.latencyMs,
          model: response.model,
          multiSymbolDecision: parsed.multiSymbolDecision,
          decision: {
            action: parsed.multiSymbolDecision.marketTicker.action,
            symbol: parsed.multiSymbolDecision.marketTicker.symbol,
            positionSizePct: parsed.multiSymbolDecision.marketTicker.positionSizePct,
            leverage: parsed.multiSymbolDecision.marketTicker.leverage,
            rationale: parsed.multiSymbolDecision.marketTicker.rationale,
            urgency: 'patient',
          } as TradingDecision,
        },
      };

      this.decisionsGenerated++;
      this.totalConfidence += parsed.overallConfidence;
      this.status = 'idle';

      this.logger.debug('Agent multi-symbol thought', {
        confidence: parsed.overallConfidence,
        tickerAction: parsed.multiSymbolDecision.marketTicker.action,
        positionCount: parsed.multiSymbolDecision.positions.length,
        latency: response.latencyMs,
      });

      return thought;
    } catch (err) {
      this.status = 'error';
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent think() failed: ${errorMsg}`);

      return {
        agentId: this.identity.id,
        agentRole: this.identity.role,
        thought: `ERROR: ${errorMsg}. Defaulting to HOLD for capital preservation.`,
        confidence: 0.0,
        timestamp: Date.now(),
        metadata: { error: errorMsg, fallback: true },
      };
    }
  }

  /** Parse LLM response into a multi-symbol decision */
  protected parseMultiSymbolResponse(content: string): {
    thought: string;
    overallConfidence: number;
    multiSymbolDecision: MultiSymbolDecision;
  } {
    try {
      const jsonStr = this.extractJSON(content);
      const parsed = JSON.parse(jsonStr);

      const thought = parsed.thought ?? content.slice(0, 300);
      const overallConfidence = typeof parsed.overallConfidence === 'number' ? parsed.overallConfidence : 0.5;

      // Build position symbols from context
      const posSymbols = this.currentPositions.map(p => p.symbol);

      const marketRaw = parsed.marketTicker as Partial<PerSymbolDecision> | undefined;
      const positionsRaw = (parsed.positions ?? []) as Partial<PerSymbolDecision>[];

      const marketTicker = normalizePerSymbolDecision(marketRaw, this.marketSymbol);
      const positions: PerSymbolDecision[] = posSymbols.map(sym => {
        const found = positionsRaw.find((p: any) => p?.symbol?.toUpperCase() === sym.toUpperCase());
        return normalizePerSymbolDecision(found, sym);
      });

      return {
        thought,
        overallConfidence,
        multiSymbolDecision: { marketTicker, positions },
      };
    } catch {
      // Fallback: safe HOLD for everything
      const posSymbols = this.currentPositions.map(p => p.symbol);
      return {
        thought: `PARSE FALLBACK: ${content.slice(0, 200)}`,
        overallConfidence: 0.0,
        multiSymbolDecision: {
          marketTicker: normalizePerSymbolDecision(undefined, this.marketSymbol),
          positions: posSymbols.map(sym => normalizePerSymbolDecision(undefined, sym)),
        },
      };
    }
  }

  /** Legacy parseResponse — kept for backward compat, delegates to new parser */
  protected parseResponse(content: string): {
    thought: string;
    confidence: number;
    decision: TradingDecision;
  } {
    const result = this.parseMultiSymbolResponse(content);
    return {
      thought: result.thought,
      confidence: result.overallConfidence,
      decision: {
        action: result.multiSymbolDecision.marketTicker.action,
        symbol: result.multiSymbolDecision.marketTicker.symbol,
        positionSizePct: result.multiSymbolDecision.marketTicker.positionSizePct,
        leverage: result.multiSymbolDecision.marketTicker.leverage,
        rationale: result.multiSymbolDecision.marketTicker.rationale,
        urgency: 'patient',
      },
    };
  }

  /** Generate a debate statement (argument/attack/synthesis) */
  async generateDebateStatement(
    phase: 'argument' | 'attack' | 'synthesis',
    context: string,
    targetThought?: AgentThought
  ): Promise<{ content: string; confidence: number }> {
    try {
      const provider = getActiveProvider();
      const phasePrompt = this.buildDebatePrompt(phase, targetThought);

      const response = await provider.chat({
        messages: [
          { role: 'system', content: this.getSystemPrompt() },
          {
            role: 'user',
            content: `Debate Phase - ${phase.toUpperCase()}:\n\nContext:\n${context}\n${phasePrompt}`,
          },
        ],
        temperature: this.identity.temperature * 0.8,
        model: this.resolveModel(),
        // Debate rounds are shorter than full think(); cap at 30s so a stalled
        // provider cannot drag the debate phase past the HACP deadline.
        timeoutMs: 30_000,
      });

      const jsonStr = this.extractJSON(response.content);
      const parsed = JSON.parse(jsonStr) as {
        content: string;
        confidence: number;
      };

      return {
        content: parsed.content ?? 'No argument provided.',
        confidence: parsed.confidence ?? 0.5,
      };
    } catch {
      return {
        content: `[${this.identity.name}] Analysis inconclusive. Maintaining current assessment.`,
        confidence: this.identity.role === 'independent_risk_auditor' ? 0.0 : 0.3,
      };
    }
  }

  /** Vote on decisions — default implementation */
  async vote(
    decisions: TradingDecision[]
  ): Promise<{ decision: TradingDecision; confidence: number }> {
    const hold = decisions.find((d) => d.action === 'hold');
    if (hold) return { decision: hold, confidence: 0.5 };
    return { decision: decisions[0]!, confidence: 0.3 };
  }

  /** Extract JSON object from text that may contain reasoning before/after it */
  protected extractJSON(text: string): string {
    // Try direct parse first
    const trimmed = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Find first { and last }
      const start = trimmed.indexOf('{');
      const end = trimmed.lastIndexOf('}');
      if (start !== -1 && end > start) {
        let candidate = trimmed.slice(start, end + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // Try to fix common issues
          try {
            const fixed = candidate
              .replace(/,\s*}/g, '}')
              .replace(/'/g, '"')
              .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
            JSON.parse(fixed);
            return fixed;
          } catch {
            // Try to find a valid JSON object by scanning backwards from the end
            let scanEnd = candidate.lastIndexOf('}');
            while (scanEnd > 0) {
              const scanStart = candidate.lastIndexOf('{', scanEnd);
              if (scanStart === -1) break;
              const sub = candidate.slice(scanStart, scanEnd + 1);
              try {
                JSON.parse(sub);
                if (sub.includes('"thought"') || sub.includes('"decision"')) {
                  this.logger.debug(`Found valid JSON by scanning backwards (${sub.length} chars)`);
                  return sub;
                }
              } catch { /* not valid */ }
              scanEnd = candidate.lastIndexOf('}', scanEnd - 1);
            }
            this.logger.warn('JSON extraction failed for: ' + candidate.slice(0, 200));
            return trimmed;
          }
        }
      }
      // No closing brace found — JSON may be truncated. Try to close it.
      if (start !== -1 && end === -1) {
        const candidate = trimmed.slice(start);
        // Try adding closing braces
        for (const suffix of ['}', '}}', '}]}']) {
          try {
            const closed = candidate + suffix;
            JSON.parse(closed);
            return closed;
          } catch { /* keep trying */ }
        }
      }
      this.logger.warn('No JSON object found in response: ' + trimmed.slice(0, 200));
      return trimmed;
    }
  }

  /** Resolve the LLM model name for this agent — respects per-agent overrides */
  resolveModel(): string {
    // Check for per-agent model override first
    const override = getAgentModel(this.identity.role);
    if (override) return override;

    // Fallback to preference-based default
    const provider = getActiveProvider();
    if (provider.name === 'Ollama') {
      return config.ollama.modelDefault;
    }
    const pref = this.identity.modelPreference;
    if (pref === 'fast') return config.nim.models.fast;
    if (pref === 'strong') return config.nim.models.strong;
    return config.nim.models.default;
  }

  private buildDebatePrompt(
    phase: 'argument' | 'attack' | 'synthesis',
    target?: AgentThought
  ): string {
    switch (phase) {
      case 'argument':
        return '\n**A2A FORMAT**: State your strongest argument using A2A keywords. Use one of: "ASSESS: [type] [state] [confidence]", "OBS: [keyword] [metric]", "PROP: [action] [size]% [urgency]". Keep to 1-2 sentences max. **CRITICAL: Respond with ONLY valid JSON. No ellipsis (...) or placeholders.** Respond: {"content":"Your strongest argument here","confidence":0.75}';
      case 'attack': {
        const t = target?.thought ?? 'N/A';
        const c = target?.confidence?.toFixed(2) ?? '?';
        return `\n**A2A FORMAT**: Attack weakest point using keywords. Respond with "DIS: [level] [reason] | evidence" or "CONCERN: [type] [severity] [trigger]". Target thought: "${t}" (conf: ${c}). **CRITICAL: Respond with ONLY valid JSON. No ellipsis (...) or placeholders.** Respond: {"content":"Your attack argument here","confidence":0.65}`;
      }
      case 'synthesis':
        return '\n**A2A FORMAT**: Synthesize debate using minimal keywords. Format: "CONSENSUS: [action] [confidence] | FINAL_PROP: [action] [size]% [urgency]". Focus on data, not opinion. **CRITICAL: Respond with ONLY valid JSON. No ellipsis (...) or placeholders.** Respond: {"content":"Your synthesis here","confidence":0.80}';
    }
  }
}