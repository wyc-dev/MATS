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
// v2.0.42: Import normalizeSymbol for consistent symbol casing with portfolio.
import { normalizeSymbol } from '../trading/portfolio.ts';

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
    // v2.0.104: Trading markets without positions are shown differently
    if (p.isTradingMarket) {
      return `  ${p.symbol} | TRADING MARKET (no position) | Price:$${p.currentPrice.toFixed(2)} | Lev:${p.leverage}x${p.exchange ? ` | ${p.exchange}` : ''}`;
    }
    const pnl = p.unrealizedPnlPct >= 0 ? '+' : '';
    return `  ${p.symbol} | ${p.side.toUpperCase()} | Qty:${p.quantity.toFixed(4)} | Entry:$${p.averageEntryPrice.toFixed(2)} | Mark:$${p.currentPrice.toFixed(2)} | PnL:${pnl}${(p.unrealizedPnlPct * 100).toFixed(2)}% | SL:${p.stopLossPrice ? '$'+p.stopLossPrice.toFixed(2) : 'NONE'} | TP:${p.takeProfitPrice ? '$'+p.takeProfitPrice.toFixed(2) : 'NONE'} | Lev:${p.leverage}x${p.exchange ? ` | ${p.exchange}` : ''}`;
  }).join('\n');
}

// v2.0.870-P18-attack2 (G1): decision 層級識別 key——backward-scan / 截斷修復
// 只接受含決策語義嘅物件。P18 改用 decision-first schema 後,完整但被孤立嘅
// marketTicker/positions 物件冇 'thought' key,舊 filter 會將佢 reject 晒——
// 截斷喺尾段時完整決策全丟。依家 filter 認所有 decision 層面 key。
const DECISION_KEYS = ['"marketTicker"', '"positions"', '"decision"', '"thought"', '"approved"', '"valid"'] as const;
const hasDecisionSemantics = (s: string): boolean => DECISION_KEYS.some(k => s.includes(k));

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
    this.maxTokens = cfg.maxTokens ?? 3072; // v2.0.870-P18: 1024→3072 — 舊預算裝唔落 5-symbol JSON + per-symbol rationale,結構性截斷 → parse fallback → 全 HOLD(機會失血)
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

  /** Build the per-agent JSON format instruction — agents override to customize.
   *  v2.0.870-P18: decision-first(決策排最前,thought 排最尾)——maxTokens 截斷時
   *  決策 JSON 仍然完整,只有尾段分析被切;omit-null + rationale 上限令 output
   *  token 降 30-50%,截斷風險同步下降。 */
  protected getOutputFormatInstruction(): string {
    return `You MUST respond with ONLY valid JSON (no markdown fences, no prose). DECISIONS FIRST — "thought" goes LAST.
{
  "marketTicker": {
    "symbol": "${this.marketSymbol}",
    "action": "buy|sell|hold",
    "confidence": 0.0-1.0,
    "patternTag": "snake_case label ≤40 chars (e.g. momentum_breakout, range_bound, support_bounce)",
    "rationale": "≤2 sentences, cite actual numbers",
    "holdReason": "REQUIRED when action=hold — ≤2 sentences: what data conflicts / what is ambiguous. Empty holdReason = failure.",
    "entryThesis": "REQUIRED when action=buy|sell — \"[1h: why TP within 1h] [1d: why TP within 1d]\" with actual numbers",
    "positionSizePct": 0.0-0.20,  // buy/sell only
    "leverage": 1-10,             // buy/sell only
    "closePosition": false
  },
  "positions": [
    {
      "symbol": "POSITION_SYMBOL",
      "action": "buy|sell|hold|close",
      "confidence": 0.0-1.0,
      "closePosition": true|false,
      "closeUrgency": "immediate|soon|patient",   // close only
      "positionSizePct": 0.0-0.20,                // buy/sell (new entry on TRADING MARKET) only
      "leverage": 1-10,                           // buy/sell only
      "suggestedStopLoss": PRICE,                 // only when adjusting SL
      "suggestedTakeProfit": PRICE,               // only when adjusting TP
      "patternTag": "snake_case ≤40 chars",
      "rationale": "≤2 sentences, cite actual numbers",
      "entryThesis": "required for buy/sell on TRADING MARKET (no position)",
      "holdReason": "REQUIRED when action=hold"
    }
  ],
  "overallConfidence": 0.0-1.0,
  "thought": "≤3 sentences, final synthesis — placed AFTER all decisions"
}

RULES:
- "marketTicker" = your view on the currently selected (primary) trading pair.
- Each "positions" entry = one symbol, BOTH open positions (Qty>0: hold/close) AND trading markets without position (Qty=0, marked "TRADING MARKET": buy|sell = open, hold = no action).
- OMIT inapplicable fields entirely (never write null for unused fields) — hold decisions need only: symbol, action, confidence, closePosition, patternTag, rationale, holdReason.
- "closeUrgency" only with closePosition=true; "suggestedStopLoss/TakeProfit" only when you want SL/TP adjusted.
- "rationale" is REQUIRED for EVERY symbol entry (1-2 short sentences, cite the data).
- "holdReason" is REQUIRED whenever action is "hold" — specific conflict, not the word \"uncertain\".
- "confidence" (per symbol) may differ from "overallConfidence" (all decisions combined).
- PER-ASSET NOISE FILTER (context: \"=== PER-ASSET NOISE FILTER STATUS ===\"): SNR<30% → lower confidence; SNR>60% → clean signal; frequency THROTTLED → HOLD.`;
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
        // v2.0.143: Increased from 45s to 90s — cloud models (DeepSeek V4 Flash)
        // sometimes take 50-70s for complex multi-symbol analysis with news
        // context. 45s was too tight, causing frequent timeout fallbacks.
        // The HACP Phase 1 deadline race (60s) catches overflow, but we
        // also raised that to 90s to match (see hacp.ts).
        timeoutMs: 90_000,
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
            // v2.0.28: Forward patternTag from LLM output to decision metadata
            ...(parsed.multiSymbolDecision.marketTicker.patternTag
              ? { patternTag: parsed.multiSymbolDecision.marketTicker.patternTag }
              : {}),
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
      const rawError = err instanceof Error ? err.message : String(err);
      this.logger.error(`Agent think() failed: ${rawError}`);

      // v2.0.143: Digest the error into a user-friendly reason instead of
      // dumping the raw error log. Categorize common failure modes so the
      // UI can show a concise, actionable reason alongside the ⚠️ Fallback badge.
      const digestError = (error: string): string => {
        const e = error.toLowerCase();
        if (e.includes('timeout') || e.includes('timed out')) {
          return 'LLM response timeout — the model took too long to respond. The system will retry next cycle.';
        }
        if (e.includes('connection') || e.includes('econnrefused') || e.includes('fetch failed')) {
          return 'Connection to LLM provider failed — check if Ollama is running. Using cached data from last successful cycle.';
        }
        if (e.includes('rate limit') || e.includes('429') || e.includes('too many requests')) {
          return 'LLM rate limit hit — too many requests. The system will back off and retry next cycle.';
        }
        if (e.includes('model') && (e.includes('not found') || e.includes('not available'))) {
          return `LLM model not available — check if the assigned model is pulled in Ollama. Using fallback HOLD for safety.`;
        }
        if (e.includes('json') || e.includes('parse') || e.includes('syntax')) {
          return 'LLM returned malformed response — could not parse the output. The system will retry next cycle.';
        }
        if (e.includes('context length') || e.includes('token limit') || e.includes('too long')) {
          return 'Input context too long for the model — the market description was too large. The system will truncate and retry.';
        }
        // Generic: show first 100 chars of error as a concise reason
        return `LLM call failed: ${error.slice(0, 100)}${error.length > 100 ? '...' : ''}`;
      };

      const digestedReason = digestError(rawError);

      return {
        agentId: this.identity.id,
        agentRole: this.identity.role,
        thought: `${digestedReason} Defaulting to HOLD for capital preservation.`,
        confidence: 0.0,
        timestamp: Date.now(),
        metadata: { error: rawError, fallback: true, digestedReason },
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

      // v2.0.42: Use normalizeSymbol for consistent symbol casing.
      const marketTicker = normalizePerSymbolDecision(marketRaw, normalizeSymbol(this.marketSymbol));
      const positions: PerSymbolDecision[] = posSymbols.map(sym => {
        const normSym = normalizeSymbol(sym);
        const found = positionsRaw.find((p: any) => {
          if (!p?.symbol) return false;
          return normalizeSymbol(p.symbol) === normSym;
        });
        return normalizePerSymbolDecision(found, normSym);
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
                if (hasDecisionSemantics(sub)) {
                  this.logger.debug(`Found valid JSON by scanning backwards (${sub.length} chars)`);
                  return sub;
                }
              } catch { /* not valid */ }
              scanEnd = candidate.lastIndexOf('}', scanEnd - 1);
            }
            // v2.0.870-P18-attack2 (G1): 通用截斷修復——nested braces 令上面全部
            // 路徑失效時,由尾部向前搵最後完整值邊界,按未閉合 stack 補回 closers。
            const repaired = this.repairTruncatedJSON(candidate);
            if (repaired !== null && hasDecisionSemantics(repaired)) {
              this.logger.info(`🔧 Recovered truncated JSON (${repaired.length} chars)`);
              return repaired;
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
        // v2.0.870-P18-attack2 (G1): suffix 表走唔通 → 通用截斷修復
        const repaired = this.repairTruncatedJSON(candidate);
        if (repaired !== null && hasDecisionSemantics(repaired)) {
          this.logger.info(`🔧 Recovered truncated JSON (${repaired.length} chars)`);
          return repaired;
        }
      }
      this.logger.warn('No JSON object found in response: ' + trimmed.slice(0, 200));
      return trimmed;
    }
  }

  /**
   * v2.0.870-P18-attack2 (G1): 通用截斷 JSON 修復。
   *
   * 演算法:single-pass 掃描,追蹤字串狀態 + 未閉合 `{`/`[` stack;
   * 於每個「完整值邊界」(`,` 或 `}`/`]` 收合後)記錄安全切點連同當刻 stack 快照。
   * 由最後切點向前逐個嘗試:prefix + stack closers → JSON.parse——第一個成功者勝。
   * 截斷喺字串中途時,prefix 永遠落喺字串之外嘅切點,唔會產生 unbalanced quote。
   *
   * 成本:O(n × parse)worst case,bounded by MAX_ATTEMPTS=300 個切點;
   * LLM JSON ≤ 幾十 KB,parse failure 路徑先有成本。
   * 任何例外/超時 → null(調用方 fallback → parse fallback → 安全 HOLD)。
   */
  protected repairTruncatedJSON(raw: string): string | null {
    try {
      interface Cut { pos: number; stackSnapshot: string; inStack: boolean }
      const cuts: Cut[] = [];
      let stack: string[] = [];
      let inString = false;
      let escaped = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]!;
        if (inString) {
          if (escaped) { escaped = false; continue; }
          if (ch === '\\') { escaped = true; continue; }
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') { stack.push(ch); continue; }
        if (ch === '}' || ch === ']') {
          stack.pop();
          // 切點 = 該 closer 之後(stack 快照 = pop 後嘅 stack)
          cuts.push({ pos: i + 1, stackSnapshot: stack.join(''), inStack: false });
          continue;
        }
        if (ch === ',') {
          // 切點 = comma 之前(exclusive)——prefix 自動甩掉 trailing comma
          cuts.push({ pos: i, stackSnapshot: stack.join(''), inStack: false });
        }
      }
      const closersOf = (snap: string): string =>
        [...snap].reverse().map(o => (o === '{' ? '}' : ']')).join('');
      const tryParse = (s: string): string | null => {
        try { JSON.parse(s); return s; } catch { return null; }
      };
      // 候選 0:整段 + closers(處理尾段係完整值但欠 closers,或截斷喺字串尾)
      const snap0 = stack.join('');
      if (!inString) {
        const c0 = tryParse(raw.replace(/,\s*$/, '') + closersOf(snap0));
        if (c0) return c0;
      } else {
        // 字串中途截斷:補引號再補 closers(數值中途截斷已由候選 0 嘅 parse fail 排除)
        const c0s = tryParse(raw + '"' + closersOf(snap0));
        if (c0s) return c0s;
      }
      // 候選 1+:由最後切點向前
      const MAX_ATTEMPTS = 300;
      for (let k = cuts.length - 1, attempts = 0; k >= 0 && attempts < MAX_ATTEMPTS; k--, attempts++) {
        const { pos, stackSnapshot } = cuts[k]!;
        const repaired = raw.slice(0, pos).replace(/,\s*$/, '') + closersOf(stackSnapshot);
        const ok = tryParse(repaired);
        if (ok) return ok;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Resolve the LLM model name for this agent — respects per-agent overrides */
  resolveModel(): string {
    // Check for per-agent model override first
    const override = getAgentModel(this.identity.role);
    if (override) return override;

    // Ollama is the only provider — use the default model
    return config.ollama.modelDefault;
  }

  private buildDebatePrompt(
    phase: 'argument' | 'attack' | 'synthesis',
    target?: AgentThought
  ): string {
    // v2.0.146: All debate statements MUST name the asset being analyzed.
    // Without this, agents produce generic statements that don't specify
    // which symbol they're arguing about, making the debate useless for
    // per-symbol consensus.
    switch (phase) {
      case 'argument':
        return '\n**A2A FORMAT**: State your strongest argument using A2A keywords. Use one of: "ASSESS: [type] [state] [confidence]", "OBS: [keyword] [metric]", "PROP: [action] [size]% [urgency]". Keep to 1-2 sentences max. **CRITICAL: You MUST name the specific asset/symbol you are analyzing (e.g. BTC, xyz:SILVER) in your argument. Generic arguments without naming the asset are useless.** Respond with ONLY valid JSON. No ellipsis (...) or placeholders.** Respond: {"content":"[ASSET_NAME]: Your strongest argument here","confidence":0.75}';
      case 'attack': {
        const t = target?.thought ?? 'N/A';
        const c = target?.confidence?.toFixed(2) ?? '?';
        return `\n**A2A FORMAT**: Attack weakest point using keywords. Respond with "DIS: [level] [reason] | evidence" or "CONCERN: [type] [severity] [trigger]". Target thought: "${t}" (conf: ${c}). **CRITICAL: You MUST name the specific asset/symbol you are attacking about. Generic attacks without naming the asset are useless.** Respond with ONLY valid JSON. No ellipsis (...) or placeholders.** Respond: {"content":"[ASSET_NAME]: Your attack argument here","confidence":0.65}`;
      }
      case 'synthesis':
        return '\n**A2A FORMAT**: Synthesize debate using minimal keywords. Format: "CONSENSUS: [action] [confidence] | FINAL_PROP: [action] [size]% [urgency]". Focus on data, not opinion. **CRITICAL: You MUST name the specific asset/symbol in your synthesis. If multiple assets were debated, address each one explicitly. Generic synthesis without naming assets is useless.** Respond with ONLY valid JSON. No ellipsis (...) or placeholders.** Respond: {"content":"[ASSET_NAME]: Your synthesis here","confidence":0.80}';
    }
  }
}