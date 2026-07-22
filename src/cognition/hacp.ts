// ─── Hyper-Accelerated Cognition Protocol (HACP) ───
// The core intelligence engine — parallel thinking, structured debate, fast consensus

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { getActiveProvider } from '../llm/index.ts';
import { config } from '../config/index.ts';
import { parseA2ASignal, formatA2ASignal } from './a2a-utils.ts';
import { normalizeDecision } from '../trading/decision-utils.ts';
// v2.0.42: Import normalizeSymbol for consistent symbol casing in adjustPositions.
import { normalizeSymbol } from '../trading/portfolio.ts';
import type { TradeHistory } from '../evolution/trade-history.ts';
import type { AgentEvolutionEngine } from '../evolution/agent-evolution.ts';
import type {
  AgentThought,
  ConsensusResult,
  DebateRound,
  DebateStatement,
  MarketState,
  MarketRegime,
  TradingDecision,
  MultiSymbolDecision,
  PerSymbolDecision,
  PerSymbolConsensus,
  Vote,
  CycleProgress,
  AgentProgress,
  AgentRole,
  PositionAdjustment,
  PositionContext,
  CycleSummary,
  UUID,
} from '../types/index.ts';
import type { BaseAgent } from '../agents/base-agent.ts';
import type { IndependentRiskAuditor, SkepticsAgent, SkepticsReview } from '../agents/agents.ts';
import { getAgentModel } from '../agents/agent-models.ts';
import { buildConvergenceAuditContext } from '../evolution/cycle-summary.ts';
import type { ThesisExperience } from '../evolution/thesis-experience.ts';
import { SimilarTradeRetriever, SubtleDiffAnalyzer } from '../evolution/reason-analytics.ts';
import type { NumericEmbedProvider } from '../evolution/numeric-autoencoder.ts';
import { computeVectorConditionalWinRate, formatVectorConditional } from '../evolution/evolution-utils.ts';
import type { AntiPatternTracker } from '../evolution/anti-pattern-tracker.ts';

const log = createLogger({ phase: 'hacp' });

// clampPositionSize() replaced by centralized normalizeDecision() in src/trading/decision-utils.ts

export interface HACPResult {
  consensus: ConsensusResult;
  allThoughts: AgentThought[];
  debateRounds: DebateRound[];
  durationMs: number;
  /** Position adjustments (TP/SL) for existing positions, if any */
  positionAdjustments?: PositionAdjustment[];
  /** E-step: Meta-Agent's distilled summary for EM loop (if built) */
  cycleSummary?: CycleSummary;
  /** v2.0.80: Symbols whose entry thesis was invalidated by Skeptics this
   *  cycle. index.ts force-closes these positions. */
  thesisInvalidatedSymbols?: string[];
  /** v2.0.140: EXP action log for this cycle — what EXP decided per symbol. */
  expActions?: ExpAction[];
}

/** v2.0.140: A single EXP decision record for the UI action log. */
export interface ExpAction {
  symbol: string;
  side: 'buy' | 'sell';
  verdict: string;
  reason: string;
  cycle: number;
  ts: number;
}

export type HACPProgressCallback = (progress: CycleProgress) => void;

export class HACPEngine {
  private readonly metaAgent: BaseAgent;
  private readonly riskAuditor: IndependentRiskAuditor;
  private readonly skeptics: SkepticsAgent;
  private readonly subAgents: BaseAgent[];
  private readonly maxRounds: number;
  private consensusThreshold: number;
  private readonly totalTimeoutMs: number;
  private onProgress: HACPProgressCallback | null = null;
  /** Dynamic threshold tracking */
  private cyclesWithoutTrade = 0;
  private consecutiveLosses = 0;
  /** Trade history for recent-pattern analysis (choppy-market detection).
   *  Injected so the Risk Auditor can assess whether recent buy/sell churn
   *  is losing money — a signal to avoid new entries / widen TP/SL. */
  private tradeHistory: TradeHistory | null = null;
  /** Agent evolution engine for regime-aware dynamic voting weights (v2.0.15).
   *  When injected, consensus votes use dynamic weights instead of the
   *  agents' hardcoded base weights. */
  private agentEvolution: AgentEvolutionEngine | null = null;
  /** Current market regime — set each cycle so dynamic weights + regime-aware
   *  strategy selection use the active regime. */
  private currentRegime: MarketRegime = 'unknown';
  /** v2.0.26: Loss cooldown — after ANY loss, the next cycle's new entries
   *  are blocked (cooldown). The Risk Auditor LLM reviews the loss during
   *  the cooldown cycle and decides whether to resume trading or extend the
   *  cooldown. This replaces the old hardcoded ≥3 VETO with a smarter
   *  "pause + LLM review" approach. */
  private cooldownUntilCycle: number = 0;
  /** The LLM's review verdict from the last cooldown cycle. When the LLM
   *  says "resume", this is set to true; when it says "extend", false. */
  private cooldownResumeAllowed: boolean = true;
  /** v2.0.26: Current cycle number — set by executeDecisionCycle() so the
   *  cooldown logic knows which cycle we're in. */
  private totalCycles: number = 0;
  /** v2.0.140: EXP action log for this cycle. */
  private expActions: ExpAction[] = [];

  /**
   * v2.0.61: Options-derived vote override for Stocks/Indices.
   *
   * When set, this vote is injected into runConsensusVote() with the HIGHEST
   * weight among all agents. This gives the Options Data Layer (Regime →
   * Playbook) the dominant voice in consensus when trading Stocks/Indices.
   *
   * The vote is cleared after each cycle so it doesn't persist to the next.
   * Set via setOptionsVote() before executeDecisionCycle().
   */
  private optionsVote: Vote | null = null;

  constructor(
    metaAgent: BaseAgent,
    riskAuditor: IndependentRiskAuditor,
    skepticsAgent: SkepticsAgent,
    subAgents: BaseAgent[]
  ) {
    this.metaAgent = metaAgent;
    this.riskAuditor = riskAuditor;
    this.skeptics = skepticsAgent;
    this.subAgents = subAgents;
    this.maxRounds = config.hacp.maxDebateRounds;
    this.consensusThreshold = config.hacp.consensusThreshold;
    this.totalTimeoutMs = config.hacp.totalTimeoutMs;
  }

  /** Inject trade history for Risk Auditor recent-pattern analysis. */
  setTradeHistory(th: TradeHistory): void {
    this.tradeHistory = th;
  }

  /**
   * v2.0.61: Set the Options Data Layer vote for the next cycle.
   *
   * When asset type is Stocks/Indices, the Options Data Layer (Regime →
   * Playbook) gets the HIGHEST voting weight in consensus. This ensures
   * options-derived signals (IV Rank, Gamma regime, Put/Call ratio, Event
   * Risk) dominate the trading decision — as they should for equities.
   *
   * The vote is consumed (cleared) after each cycle.
   *
   * @param action    'buy' | 'sell' | 'hold' — the playbook's directional bias
   * @param confidence 0.0-1.0 — how strongly the options data supports this
   * @param weight    Voting weight (should be ≥ max agent weight = 0.10)
   * @param rationale  Human-readable reason from the playbook
   */
  setOptionsVote(action: 'buy' | 'sell' | 'hold', confidence: number, weight: number, rationale: string): void {
    this.optionsVote = {
      agentId: 'options-data-layer' as UUID,
      agentRole: 'options_data_layer' as AgentRole,
      weight,
      decision: {
        action,
        symbol: '',
        positionSizePct: 0,
        rationale: `[OPTIONS] ${rationale}`,
        urgency: 'immediate',
      },
      confidence,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // v2.0.139: Consensus threshold is now purely config-driven + adjusted by
  // adjustThreshold() (loss-streak / idle / regime). The v2.0.41 Evolution
  // signalThreshold override has been REMOVED — the EvolutionaryPressureEngine
  // no longer has deterministic control over the consensus gate (its strategy
  // pool was empty, getStrategyParameters() threw every cycle, and the override
  // never actually applied; the effective threshold was always config + adjust).
  // This dead feedback loop (global-aggregate fitness → signalThreshold) is gone.
  // ═══════════════════════════════════════════════════════════════
  private getEffectiveConsensusThreshold(): number {
    return this.consensusThreshold;
  }

  /** Inject the agent evolution engine for regime-aware dynamic weights. */
  setAgentEvolution(ae: AgentEvolutionEngine): void {
    this.agentEvolution = ae;
  }

  /** v2.0.138: EXP thesis-experience memory (Skeptics Phase 1.8a). Optional — when
   *  injected AND config.exp.enabled, Phase 1.8 runs the history-probability gate
   *  before the subjective 1.8b strength check. DISABLED/ERRORED → fall back to 1.8b. */
  private expMemory: ThesisExperience | null = null;
  setExpMemory(exp: ThesisExperience): void {
    this.expMemory = exp;
  }

  /** v2.0.140: Dual-Channel Fusion — callback to fetch OLR P(win) + shadow win rate
   *  for a symbol+side. Injected by index.ts so HACP can pass statistical channel
   *  data to checkThesisHistory() without a direct dependency on OLR/shadow engines. */
  private fusionDataCallback: ((symbol: string, side: 'buy' | 'sell') => { olrPWin?: number; shadowWinRate?: number }) | null = null;
  setFusionDataCallback(cb: (symbol: string, side: 'buy' | 'sell') => { olrPWin?: number; shadowWinRate?: number }): void {
    this.fusionDataCallback = cb;
  }

  /** v2.0.204: Numeric embedding provider (NumericAutoencoder) — enables the
   *  vector-conditional win-rate block injected into Skeptics Phase 1.8b so the
   *  thesis validator sees "historically similar MARKET CONDITIONS win rate"
   *  (learned non-linear embedding, cross-symbol, same side) alongside the
   *  RIL similar-trades block. Injected by index.ts. */
  private naEmbeddingProvider: NumericEmbedProvider | null = null;
  setNaEmbeddingProvider(p: NumericEmbedProvider): void {
    this.naEmbeddingProvider = p;
  }
  /** v2.0.204: Candidate market-features provider — returns the current cycle's
   *  entry-condition features so the Phase 1.8b conditional-WR block can query
   *  the numeric autoencoder for similar historical market conditions. Injected
   *  by index.ts (returns the active symbol's current marketFeatures). */
  private naCandidateFeaturesProvider: (() => Record<string, number> | null) | null = null;
  setNaCandidateFeaturesProvider(cb: () => Record<string, number> | null): void {
    this.naCandidateFeaturesProvider = cb;
  }
  /** v2.0.207 (#F): Anti-pattern tracker — matches candidate against known
   *  failure clusters so Skeptics sees "you have lost this way N times before". */
  private antiPatternTracker: AntiPatternTracker | null = null;
  setAntiPatternTracker(t: AntiPatternTracker | null): void { this.antiPatternTracker = t; }

  /** v2.0.212 (#7): Cycle-history retriever for execution-lens context.
   *  Provides the execution-mode AttnRes blend (sharp/recent-biased) so
   *  Skeptics/Meta-Agent can calibrate SL/TP adequacy against the learned
   *  stop-out regime patterns. */
  private cycleHistoryRetriever: { retrieveBlend: (sym: string, mode: 'decision' | 'execution') => { hBlend: Record<string, number>; blended: boolean; explanation: string; entropy: number } } | null = null;
  setCycleHistoryRetriever(r: typeof this.cycleHistoryRetriever): void { this.cycleHistoryRetriever = r; }

  /** v2.0.143: RIL SimilarTradeRetriever — finds top-N most similar historical
   *  trades to a candidate thesis. Injected by index.ts so HACP can produce
   *  a "SIMILAR TRADES" context block for the Meta-Agent. */
  private similarTradeRetriever: SimilarTradeRetriever | null = null;
  setSimilarTradeRetriever(r: SimilarTradeRetriever): void {
    this.similarTradeRetriever = r;
  }

  /** v2.0.143: RIL SubtleDiffAnalyzer — 1 LLM call per cycle to analyse subtle
   *  differences between a candidate trade and its most similar past trades.
   *  Injected by index.ts so HACP can produce a "SUBTLE DIFFERENCES" context block. */
  private subtleDiffAnalyzer: SubtleDiffAnalyzer | null = null;
  setSubtleDiffAnalyzer(a: SubtleDiffAnalyzer): void {
    this.subtleDiffAnalyzer = a;
  }

  /** v2.0.143: LLM chat function for SubtleDiffAnalyzer. Injected by index.ts
   *  so HACP can make LLM calls without a direct dependency on the LLM provider. */
  private llmChatFn: ((messages: Array<{ role: string; content: string }>, opts?: { temperature?: number; timeoutMs?: number }) => Promise<string>) | null = null;
  setLLMChatFn(fn: (messages: Array<{ role: string; content: string }>, opts?: { temperature?: number; timeoutMs?: number }) => Promise<string>): void {
    this.llmChatFn = fn;
  }

  /** v2.0.138: Override the Meta-Agent thought's decision (action / thesis / rationale).
   *  Used by EXP Phase 1.8a for REJECT (→HOLD) and REVERSE_DIRECTION (→opposite side).
   *  Preserves the multiSymbolDecision + decision metadata shape that downstream
   *  consensus / conviction / risk gates expect. */
  private overrideMetaDecision(
    allThoughts: AgentThought[],
    metaSymbol: string,
    metaMultiDec: MultiSymbolDecision | undefined,
    opts: { action: 'buy' | 'sell' | 'hold'; rationale: string; entryThesis?: string; confidence?: number; tag: string },
  ): void {
    const lastIdx = allThoughts.length - 1;
    const base = allThoughts[lastIdx]!;
    const prevMulti = (base.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined) ?? metaMultiDec ?? {
      marketTicker: { symbol: metaSymbol, action: 'hold' as const, positionSizePct: 0, leverage: 1, closePosition: false, rationale: opts.rationale },
      positions: [],
    };
    const prevTick = prevMulti.marketTicker;
    const prevDec = (base.metadata?.['decision'] as TradingDecision | undefined) ?? ({} as Partial<TradingDecision>);
    const positionSizePct = opts.action === 'hold' ? 0 : (prevDec.positionSizePct ?? prevTick.positionSizePct ?? 0);
    const leverage = prevDec.leverage ?? prevTick.leverage ?? 1;
    const newDec: TradingDecision = {
      ...prevDec,
      symbol: prevDec.symbol ?? metaSymbol,
      urgency: prevDec.urgency ?? 'soon',
      action: opts.action,
      positionSizePct,
      leverage,
      rationale: opts.rationale,
      ...(opts.entryThesis !== undefined ? { entryThesis: opts.entryThesis } : {}),
    };
    allThoughts[lastIdx] = {
      ...base,
      thought: `[${opts.tag}] ${base.thought}`,
      confidence: opts.confidence ?? base.confidence,
      metadata: {
        ...base.metadata,
        multiSymbolDecision: {
          ...prevMulti,
          marketTicker: {
            ...prevTick,
            action: opts.action,
            positionSizePct,
            leverage,
            rationale: opts.rationale,
            ...(opts.entryThesis !== undefined ? { entryThesis: opts.entryThesis } : {}),
          },
        },
        decision: newDec,
      },
    };
  }

  /** v2.0.90: Expose Skeptics for close decision validation from index.ts */
  getSkeptics(): SkepticsAgent {
    return this.skeptics;
  }

  /**
   * v2.0.26: Trigger a loss cooldown after any losing trade.
   * Sets cooldownUntilCycle to the next cycle, blocking new entries for
   * 1 cycle while the Risk Auditor LLM reviews the loss. The LLM's
   * verdict (resume vs extend) is read from cooldownResumeAllowed.
   */
  triggerLossCooldown(currentCycle: number): void {
    this.cooldownUntilCycle = currentCycle + 2; // next cycle + 1 for review
    this.cooldownResumeAllowed = false; // default: don't resume until LLM says so
    log.warn(`🧊 Loss cooldown triggered: new entries blocked until cycle ${this.cooldownUntilCycle} (current=${currentCycle})`);
  }

  /** Check if a loss cooldown is currently active. */
  isCooldownActive(currentCycle: number): boolean {
    return currentCycle < this.cooldownUntilCycle;
  }

  /** Allow the Risk Auditor LLM to resume trading after cooldown review. */
  resumeFromCooldown(): void {
    this.cooldownUntilCycle = 0;
    this.cooldownResumeAllowed = true;
    log.info('✅ Loss cooldown lifted — Risk Auditor approved resuming trading');
  }

  /** Register a callback for real-time progress updates */
  setProgressCallback(cb: HACPProgressCallback): void {
    this.onProgress = cb;
  }

  private emitProgress(phase: CycleProgress['phase'], agentProgress: AgentProgress[], round?: number): void {
    if (this.onProgress) {
      this.onProgress({
        phase,
        round,
        totalRounds: this.maxRounds,
        agentProgress,
        startTime: Date.now(),
      });
    }
  }

  private makeAgentProgressList(): AgentProgress[] {
    const allAgents: { role: AgentRole; name: string }[] = [
      ...this.subAgents.map(a => ({ role: a.identity.role, name: a.identity.name })),
      { role: 'skeptics', name: 'Skeptics' },
      { role: this.metaAgent.identity.role, name: this.metaAgent.identity.name },
      { role: this.riskAuditor.identity.role, name: this.riskAuditor.identity.name },
    ];
    return allAgents.map(a => ({
      agentRole: a.role,
      status: 'waiting' as const,
    }));
  }

  /**
   * Race an agent's think() against a deadline. If the agent exceeds the
   * window (LLM timeout, circuit breaker open, network stall during HL WS
   * reconnect), return a graceful HOLD thought instead of letting the caller
   * block for the full LLM timeout. This keeps HACP cycles responsive: a
   * single degraded agent degrades to HOLD rather than stalling all phases.
   *
   * The underlying agent.think() promise is NOT cancelled (JS has no native
   * cancellation), but it is orphaned — its result is discarded if it arrives
   * after the deadline. The agent's own LLM timeout (120s) still applies as a
   * backstop, so orphaned promises eventually settle and free resources.
   */
  private async raceAgentThink(
    agent: BaseAgent,
    marketStateDesc: string,
    portfolioDesc: string,
    posCtx: PositionContext[],
    deadlineMs: number,
  ): Promise<AgentThought> {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`agent think() exceeded ${deadlineMs}ms deadline`));
      }, deadlineMs);
    });

    try {
      const result = await Promise.race([
        agent.think(marketStateDesc, portfolioDesc, posCtx),
        timeoutPromise,
      ]);
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`⚠️ ${agent.identity.name} think() missed deadline after ${elapsed}ms: ${msg} — graceful HOLD`);
      return {
        agentId: agent.identity.id,
        agentRole: agent.identity.role,
        thought: `DEADLINE MISS (${elapsed}ms): ${msg}. Defaulting to HOLD for capital preservation.`,
        confidence: 0,
        timestamp: Date.now(),
        metadata: {
          latency: elapsed,
          model: 'deadline-fallback',
          multiSymbolDecision: {
            marketTicker: {
              action: 'hold',
              symbol: '',
              positionSizePct: 0,
              leverage: 1,
              rationale: `Agent think() deadline miss (${elapsed}ms) — HOLD fallback`,
              urgency: 'patient',
            },
            positions: [],
          },
          decision: {
            action: 'hold',
            symbol: '',
            positionSizePct: 0,
            leverage: 1,
            rationale: `Agent think() deadline miss — HOLD fallback`,
            urgency: 'patient',
          } as TradingDecision,
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Get current dynamic consensus threshold value (config base + adjustThreshold
   * loss-streak/idle/regime adjustments).
   */
  getCurrentThreshold(): number {
    return this.getEffectiveConsensusThreshold();
  }

  /**
   * Dynamically adjust the consensus threshold based on market conditions.
   * Adjusts this.consensusThreshold (the config base): lowers on idle cycles
   * (encourage trades), raises on consecutive losses (capital protection),
   * regime-aware. Clamped to [0.49, 0.85]. This is the SOLE threshold path —
   * the v2.0.41 Evolution override was removed in v2.0.139.
   */
  adjustThreshold(currentRegime?: string, hadRealTrade?: boolean, wasProfitable?: boolean): void {
    const initial = config.hacp.consensusThreshold;

    // Track cycles without a real trade
    if (!hadRealTrade) {
      this.cyclesWithoutTrade++;
    } else {
      this.cyclesWithoutTrade = 0;
      if (wasProfitable) {
        this.consecutiveLosses = 0;
      } else {
        this.consecutiveLosses++;
      }
    }

    let adj = 0;

    // No trade decay: lower threshold slowly to encourage taking shots
    if (this.cyclesWithoutTrade > 0) {
      adj -= Math.min(this.cyclesWithoutTrade * 0.02, 0.25);
    }

    // Consecutive losses: raise threshold
    if (this.consecutiveLosses >= 2) {
      adj += Math.min(this.consecutiveLosses * 0.05, 0.15);
    }

    // Regime-aware
    if (currentRegime === 'high_volatility' || currentRegime === 'breakout') {
      adj -= 0.05; // Opportunity! lower barrier
    } else if (currentRegime === 'chaotic' || currentRegime === 'unknown') {
      adj += 0.10; // Danger! raise barrier
    }

    // v2.0.139: floor 0.49 (don't let consensus gate drop below the intended
    // ~49-53% band even on long idle — keeps capital-protection floor).
    const newThreshold = Math.max(0.49, Math.min(0.85, initial + adj));
    if (Math.abs(newThreshold - this.consensusThreshold) > 0.005) {
      log.info(`Consensus threshold: ${(this.consensusThreshold * 100).toFixed(0)}% → ${(newThreshold * 100).toFixed(0)}% (idle=${this.cyclesWithoutTrade}, lossStreak=${this.consecutiveLosses}, regime=${currentRegime ?? '?'})`);
    }
    this.consensusThreshold = newThreshold;
  }

  async executeDecisionCycle(
    marketStateDesc: string,
    portfolioDesc: string,
    /** Current positions AND trading markets for analysis.
     *  v2.0.104: Includes both real open positions (quantity > 0) and
     *  trading markets without positions (quantity = 0, isTradingMarket = true).
     *  Agents output decisions for ALL entries in a single cycle. */
    currentPositions?: Array<{ id: string; symbol: string; side: string; entryPrice: number; currentPrice: number; stopLoss?: number; takeProfit?: number; leverage?: number; quantity?: number; exchange?: string; entryThesis?: string; isTradingMarket?: boolean }>,
    /** Previous cycle summary chain — injected into Meta-Agent context for EM continuity */
    emContext?: string,
    /** Cycle summaries for Skeptics convergence audit */
    recentSummaries?: CycleSummary[],
    /** Market Agent constraints: position size fraction and leverage */
    marketAgentConstraints?: { positionSizePct: number; leverage: number },
    /** v2.0.26: current cycle number — used by the loss cooldown logic */
    cycleNumber?: number,
    /** v2.0.80: Function to fetch fresh price for a symbol — used by Skeptics
     *  to re-validate open position theses with current market data.
     *  Returns null if price unavailable (Skeptics will use stale price). */
    fetchPriceForSymbol?: (symbol: string) => Promise<number | null>,
  ): Promise<HACPResult> {
    const startTime = performance.now();
    const allThoughts: AgentThought[] = [];
    const debateRounds: DebateRound[] = [];
    const deadline = Date.now() + this.totalTimeoutMs;

    // v2.0.26: track the current cycle number for cooldown logic
    if (cycleNumber !== undefined) {
      this.totalCycles = cycleNumber;
    }
    // v2.0.140: clear EXP action log for this cycle
    this.expActions = [];

    // Extract the current regime from the market description so dynamic
    // agent weights + regime-aware strategy selection use the active regime.
    const regimeMatch = marketStateDesc.match(/Regime:\s*(\w+)/i);
    if (regimeMatch?.[1]) {
      this.currentRegime = regimeMatch[1].toLowerCase() as MarketRegime;
    }
    // Update agent dynamic weights for the current regime (v2.0.15).
    // This reads per-agent win rates from AgentOutcomeTracker and EMA-smooths
    // the multipliers so consensus votes reflect each agent's recent performance.
    if (this.agentEvolution) {
      // v2.0.206 (#8): Pass current market features so agent multipliers use
      // conditional WR (performance in similar conditions) instead of raw WR.
      this.agentEvolution.updateWeights(this.currentRegime, this.naCandidateFeaturesProvider?.() ?? undefined);
    }

    // Inject Market Agent constraints into the market description
    let constrainedMarketDesc = marketStateDesc;
    if (marketAgentConstraints) {
      const sizePct = (marketAgentConstraints.positionSizePct * 100).toFixed(1);
      constrainedMarketDesc += `\n\n=== MARKET AGENT HARD CONSTRAINTS ===\n`;
      constrainedMarketDesc += `These are NON-NEGOTIABLE limits set by the Market Agent. You MUST respect them.\n`;
      constrainedMarketDesc += `Max Position Size: ${sizePct}% of portfolio equity (${marketAgentConstraints.positionSizePct * 100}% hard cap)\n`;
      constrainedMarketDesc += `If your proposed trade exceeds these limits, REDUCE to fit within them.\n`;
      constrainedMarketDesc += `If you cannot make a profitable trade within these limits, choose HOLD.\n`;
    }

    // Convert positions → PositionContext[]
    const posCtx: PositionContext[] = (currentPositions ?? []).map(p => {
      const qty = p.quantity ?? 0;
      const lev = p.leverage ?? 1;
      let pnl: number;
      let pnlPct: number;
      if (p.side === 'buy') {
        pnl = (p.currentPrice - p.entryPrice) * qty * lev;
        pnlPct = p.entryPrice > 0 ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * lev : 0;
      } else {
        pnl = (p.entryPrice - p.currentPrice) * qty * lev;
        pnlPct = p.entryPrice > 0 ? ((p.entryPrice - p.currentPrice) / p.entryPrice) * lev : 0;
      }
      return {
        id: p.id,
        symbol: p.symbol,
        side: (p.side as 'buy' | 'sell'),
        quantity: qty,
        averageEntryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        unrealizedPnl: pnl,
        unrealizedPnlPct: pnlPct,
        stopLossPrice: p.stopLoss,
        takeProfitPrice: p.takeProfit,
        leverage: lev,
        exchange: p.exchange ?? 'hyperliquid',
        // v2.0.80: Forward entryThesis for Skeptics re-validation
        entryThesis: p.entryThesis,
        // v2.0.104: Forward isTradingMarket flag for agent context
        isTradingMarket: p.isTradingMarket,
      };
    });

    log.info('🚀 HACP cycle started', {
      agents: this.subAgents.length + 2,
      maxRounds: this.maxRounds,
      deadline: new Date(deadline).toISOString(),
      positions: posCtx.length,
    });

    // Emit initial progress
    this.emitProgress('thinking', this.makeAgentProgressList());

    // ═══════════════════════════════════════════════════
    // PHASE 0.5: Open Position Thesis Re-Validation (v2.0.80)
    // Skeptics re-validates each open position's entry thesis against
    // current market data. If a thesis is invalidated, the position is
    // flagged for force-close. This runs BEFORE agents think so agents
    // see the validation results in their context.
    // ═══════════════════════════════════════════════════

    /** v2.0.80: Symbols whose entry thesis has been invalidated by Skeptics.
     *  These are force-closed in index.ts via the consensus result. */
    const thesisInvalidatedSymbols = new Set<string>();

    if (posCtx.length > 0 && fetchPriceForSymbol) {
      const positionsWithThesis = posCtx
        .filter(p => p.entryThesis && p.entryThesis.trim().length > 0)
        .map(p => ({
          symbol: p.symbol,
          side: p.side,
          entryPrice: p.averageEntryPrice,
          currentPrice: p.currentPrice,
          stopLoss: p.stopLossPrice,
          takeProfit: p.takeProfitPrice,
          leverage: p.leverage,
          entryThesis: p.entryThesis,
        }));

      if (positionsWithThesis.length > 0) {
        log.info(`Phase 0.5: Re-validating entry theses for ${positionsWithThesis.length} open position(s)...`);
        try {
          const thesisResults = await this.skeptics.validateOpenPositionTheses(
            positionsWithThesis,
            marketStateDesc,
            fetchPriceForSymbol,
          );
          for (const [symbol, result] of thesisResults) {
            if (!result.valid) {
              thesisInvalidatedSymbols.add(symbol);
              log.warn(`🚫 Thesis INVALIDATED for ${symbol}: ${result.rationale} — flagging for force-close`);
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Phase 0.5 thesis re-validation failed: ${msg}. Continuing without thesis validation.`);
        }
      }
    }

    // ═══════════════════════════════════════════════════
    // PHASE 1: Parallel Thinking (all agents think simultaneously)
    // ═══════════════════════════════════════════════════

    log.info('Phase 1: Parallel Thinking — all agents analyzing market...');

    // Staggered calls to avoid overloading Ollama
    const staggerDelayMs = config.hacp.staggerDelayMs;

    // Per-agent deadline: each agent must finish within the remaining HACP
    // budget, leaving room for subsequent phases (debate, consensus, risk).
    // We cap the per-agent thinking window at 60s so a single slow/timed-out
    // agent (e.g. Ollama during a WS reconnect storm) cannot block the whole
    // cycle for 120s. Agents that miss the deadline get a graceful HOLD.
    // v2.0.143: Increased from 60s to 90s to match the per-agent LLM timeout
    // (90s). Cloud models sometimes take 50-70s for complex multi-symbol
    // analysis. 60s deadline was causing premature timeout fallbacks.
    const phase1DeadlineMs = 90_000;

    const thinkingPromises = this.subAgents.map(async (agent, idx) => {
      if (idx > 0) {
        const delay = idx * staggerDelayMs;
        log.debug(`Staggered call: ${agent.identity.name} will start in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Emit: this agent is now thinking
      const progress = this.makeAgentProgressList();
      const progIdx = progress.findIndex(p => p.agentRole === agent.identity.role);
      if (progIdx >= 0) {
        progress[progIdx]!.status = 'thinking';
        progress[progIdx]!.startedAt = Date.now();
      }
      this.emitProgress('thinking', progress);

      // Race the agent think() against a deadline. If the agent exceeds the
      // window (LLM timeout, circuit breaker, network stall), return a graceful
      // HOLD instead of letting Promise.all wait for the full 120s timeout.
      const result = await this.raceAgentThink(agent, marketStateDesc, portfolioDesc, posCtx, phase1DeadlineMs);

      // Emit: this agent finished thinking
      const progress2 = this.makeAgentProgressList();
      const progIdx2 = progress2.findIndex(p => p.agentRole === agent.identity.role);
      if (progIdx2 >= 0) {
        progress2[progIdx2]!.status = 'done';
        progress2[progIdx2]!.thought = result.thought;
        progress2[progIdx2]!.confidence = result.confidence;
        progress2[progIdx2]!.decision = result.metadata?.['decision'] as TradingDecision | undefined;
        progress2[progIdx2]!.latencyMs = result.metadata?.['latency'] as number | undefined;
        progress2[progIdx2]!.completedAt = Date.now();
      }
      this.emitProgress('thinking', progress2);

      return result;
    });

    const agentResults = await Promise.all(thinkingPromises);
    allThoughts.push(...agentResults);

    // ── Risk Auditor Phase 1 assessment ──
    log.info('Risk Auditor providing preliminary Phase 1 assessment...');
    const riskProg = this.makeAgentProgressList();
    const rIdx = riskProg.findIndex(p => p.agentRole === 'independent_risk_auditor');
    if (rIdx >= 0) { riskProg[rIdx]!.status = 'thinking'; riskProg[rIdx]!.startedAt = Date.now(); }
    this.emitProgress('thinking', riskProg);
    const riskThought = await this.riskAuditor.think(marketStateDesc, portfolioDesc, posCtx);
    const riskProg2 = this.makeAgentProgressList();
    const rIdx2 = riskProg2.findIndex(p => p.agentRole === 'independent_risk_auditor');
    if (rIdx2 >= 0) { riskProg2[rIdx2]!.status = 'done'; riskProg2[rIdx2]!.thought = riskThought.thought; riskProg2[rIdx2]!.confidence = riskThought.confidence; riskProg2[rIdx2]!.decision = riskThought.metadata?.['decision'] as TradingDecision | undefined; riskProg2[rIdx2]!.completedAt = Date.now(); }
    this.emitProgress('thinking', riskProg2);
    allThoughts.push(riskThought);

    log.info(`Phase 1 complete — ${allThoughts.length} thoughts generated.`, {
      confidences: allThoughts.map((t) => `${t.agentRole.slice(0, 12)}:${t.confidence.toFixed(2)}`),
    });

    // ═══════════════════════════════════════════════════
    // PHASE 1.5: Skeptics Review — challenges 5 sub-agents
    // (Meta-Agent has NOT thought yet — it will receive Skeptics' findings)
    // ═══════════════════════════════════════════════════

    log.info('🤔 Skeptics reviewing agent decisions for logical consistency...');
    let skepticsOverridden = false;
    let skepticsReviews: SkepticsReview[] = [];
    try {
      const emitProg = this.makeAgentProgressList();
      const skIdx = emitProg.findIndex(p => p.agentRole === 'skeptics');
      if (skIdx >= 0) emitProg[skIdx]!.status = 'thinking';
      this.emitProgress('auditing', emitProg);

      // Build convergence audit context for Skeptics (EM cross-cycle check)
      const convergenceCtx = recentSummaries && recentSummaries.length >= 2
        ? buildConvergenceAuditContext(recentSummaries, ['up', 'down', 'flat'])  // simplified: just patterns
        : '';
      const skepticsContext = convergenceCtx
        ? `${marketStateDesc}\n${convergenceCtx}`
        : marketStateDesc;
      skepticsReviews = await this.skeptics.review(allThoughts, skepticsContext, portfolioDesc, marketStateDesc);

      // Build skeptics own thought summary — per-symbol breakdown
      const approvedCount = skepticsReviews.filter(r => r.approved).length;
      const modifiedCount = skepticsReviews.filter(r => !r.approved).length;

      // Collect all symbols audited across all reviews
      const auditedSymbols = new Set<string>();
      for (const r of skepticsReviews) {
        if (r.originalDecision?.marketTicker?.symbol) auditedSymbols.add(r.originalDecision.marketTicker.symbol);
        if (r.originalDecision?.positions?.length) {
          for (const p of r.originalDecision.positions) {
            if (p.symbol) auditedSymbols.add(p.symbol);
          }
        }
      }

      // Build per-symbol audit summary
      const perSymbolLines: string[] = [];
      for (const sym of auditedSymbols) {
        const symReviews = skepticsReviews.filter(r => {
          const hasInTicker = r.originalDecision?.marketTicker?.symbol === sym;
          const hasInPositions = r.originalDecision?.positions?.some(p => p.symbol === sym);
          return hasInTicker || hasInPositions;
        });
        const symApproved = symReviews.filter(r => r.approved).length;
        const symModified = symReviews.filter(r => !r.approved).length;
        const modDetails = symReviews.filter(r => !r.approved).map(r => `[${r.agentRole}] ${r.skepticismRationale.slice(0, 100)}`).join(' | ');
        perSymbolLines.push(`  ${sym}: ${symApproved} approved, ${symModified} modified${modDetails ? ` — ${modDetails}` : ''}`);
      }

      const skepticsThoughtText = skepticsReviews.length > 0
        ? `Reviewed ${skepticsReviews.length} agents across ${auditedSymbols.size} symbol(s):\n${perSymbolLines.join('\n')}${modifiedCount > 0 ? `\nOverall: ${approvedCount} approved, ${modifiedCount} modified.` : '\nNo logical inconsistencies detected.'}`
        : 'Skeptics review completed — no agents to review.';

      // Build per-symbol audit metadata for UI
      const perSymbolAudit = Array.from(auditedSymbols).map(sym => {
        const symReviews = skepticsReviews.filter(r => {
          const hasInTicker = r.originalDecision?.marketTicker?.symbol === sym;
          const hasInPositions = r.originalDecision?.positions?.some(p => p.symbol === sym);
          return hasInTicker || hasInPositions;
        });
        return {
          symbol: sym,
          approved: symReviews.filter(r => r.approved).length,
          modified: symReviews.filter(r => !r.approved).length,
          details: symReviews.filter(r => !r.approved).map(r => `[${r.agentRole}] ${r.skepticismRationale.slice(0, 80)}`),
        };
      });

      // Push skeptics thought into allThoughts
      const skepticsThought: AgentThought = {
        agentId: uuidv4(),
        agentRole: 'skeptics',
        thought: skepticsThoughtText,
        confidence: modifiedCount === 0 ? 1.0 : 0.6,
        timestamp: Date.now(),
        metadata: {
          decision: { action: 'hold', symbol: 'UNKNOWN', positionSizePct: 0, leverage: 1, rationale: 'Skeptics do not trade; they audit.', urgency: 'patient' } as TradingDecision,
          skepticsReviews,
          perSymbolAudit,
          model: getAgentModel('skeptics'),
          latency: Math.round(performance.now() - startTime),
        },
      };
      allThoughts.push(skepticsThought);

      // Emit done progress for skeptics
      const skProgDone = this.makeAgentProgressList();
      const skDoneIdx = skProgDone.findIndex(p => p.agentRole === 'skeptics');
      if (skDoneIdx >= 0) {
        skProgDone[skDoneIdx]!.status = 'done';
        skProgDone[skDoneIdx]!.thought = skepticsThoughtText;
        skProgDone[skDoneIdx]!.confidence = modifiedCount === 0 ? 1.0 : 0.6;
        skProgDone[skDoneIdx]!.completedAt = Date.now();
      }
      this.emitProgress('auditing', skProgDone);

      // Apply skeptics modifications to allThoughts
      for (const review of skepticsReviews) {
        if (!review.approved && review.modifiedDecision) {
          skepticsOverridden = true;
          const targetIdx = allThoughts.findIndex(t => t.agentRole === review.agentRole);
          if (targetIdx >= 0) {
            const orig = allThoughts[targetIdx]!;
            allThoughts[targetIdx] = {
              ...orig,
              thought: `[Skeptics Modified] ${orig.thought}`,
              confidence: review.modifiedConfidence ?? orig.confidence * 0.8,
              metadata: {
                ...orig.metadata,
                multiSymbolDecision: review.modifiedDecision,
                decision: {
                  action: review.modifiedDecision.marketTicker.action,
                  symbol: review.modifiedDecision.marketTicker.symbol,
                  positionSizePct: review.modifiedDecision.marketTicker.positionSizePct,
                  leverage: review.modifiedDecision.marketTicker.leverage,
                  rationale: `[Skeptics] ${review.modifiedDecision.marketTicker.rationale}`,
                  urgency: 'patient',
                } as TradingDecision,
              },
            };
            log.warn(`⚠️ Skeptics modified ${review.agentRole}: ${review.skepticismRationale.slice(0, 120)}`);
          }
        }
      }

      if (skepticsOverridden) {
        log.warn(`🚩 Skeptics overrode ${skepticsReviews.filter(r => !r.approved).length} agent(s)`);
      } else {
        log.info('✅ All agents approved by Skeptics.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Skeptics review failed: ${msg}. Continuing without modifications.`);
    }

    // Build a skeptics context string for Meta-Agent
    const skepticsContextStr = skepticsReviews.length > 0
      ? `\n\n=== Skeptics Review Results ===\n${skepticsReviews.map(r =>
          `[${r.agentRole}] ${r.approved ? '✅ APPROVED' : '⚠️ MODIFIED'}: ${r.skepticismRationale}`
        ).join('\n')}`
      : '';

    // ═══════════════════════════════════════════════════
    // PHASE 1.75: Meta-Agent thinks AFTER Skeptics review
    // (receives both original agent thoughts + Skeptics modifications)
    // ═══════════════════════════════════════════════════

    log.info('Meta-Agent thinking with broader context (incl. Skeptics review)...');
    const metaProgress = this.makeAgentProgressList();
    const metaIdx = metaProgress.findIndex(p => p.agentRole === 'meta_agent');
    if (metaIdx >= 0) { metaProgress[metaIdx]!.status = 'thinking'; metaProgress[metaIdx]!.startedAt = Date.now(); }
    this.emitProgress('thinking', metaProgress);

    // v2.0.207 (#G): Inject vector-conditional WR into Meta-Agent thesis GENERATION
    // (not just Skeptics validation). Meta-Agent sees "in YOUR market conditions,
    // BUY conditional WR = X%, SELL conditional WR = Y%" BEFORE it writes the
    // thesis — so weak-edge directions are discouraged at generation time, not
    // just vetoed downstream. Falls back to min-max when NA not ready.
    let metaConditionalWRBlock = '';
    if (this.naEmbeddingProvider && this.naCandidateFeaturesProvider && this.expMemory) {
      try {
        const candidateFeatures = this.naCandidateFeaturesProvider();
        if (candidateFeatures && Object.keys(candidateFeatures).length > 0) {
          const records = this.expMemory.getRecords();
          // Provide BOTH directions so Meta-Agent can calibrate conviction pre-thesis.
          const sides: Array<'buy' | 'sell'> = ['buy', 'sell'];
          const blocks: string[] = [];
          for (const side of sides) {
            const cond = computeVectorConditionalWinRate(
              candidateFeatures,
              records,
              { side, minSamples: 3, threshold: 0.75, topN: 20, embeddingProvider: this.naEmbeddingProvider ?? undefined },
            );
            if (cond.confidence !== 'none') {
              blocks.push(`  ${side.toUpperCase()}: ${(cond.conditionalWinRate * 100).toFixed(0)}% (n=${cond.sampleSize}, ${cond.confidence}) — ${cond.explanation}`);
            } else if (cond.sampleSize > 0) {
              blocks.push(`  ${side.toUpperCase()}: ${cond.explanation}`);
            }
          }
          if (blocks.length > 0) {
            metaConditionalWRBlock = `\n=== CONDITIONAL WIN RATE (your market conditions, for thesis generation) ===\n${blocks.join('\n')}\nUse this to CALIBRATE conviction: high conditional WR → strong thesis OK; low conditional WR → require stronger justification or HOLD.\n---`;
          }
        }
      } catch (err) {
        log.warn(`[NA #G] Meta-Agent conditional WR block failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Build enhanced market context that includes skeptics findings + EM chain + conditional WR
    const enhancedMetaContext = `${marketStateDesc}${skepticsContextStr}${emContext ? `\n${emContext}` : ''}${metaConditionalWRBlock}`;
    const metaThought = await this.metaAgent.think(enhancedMetaContext, portfolioDesc, posCtx);

    const metaProg2 = this.makeAgentProgressList();
    const metaIdx2 = metaProg2.findIndex(p => p.agentRole === 'meta_agent');
    if (metaIdx2 >= 0) { metaProg2[metaIdx2]!.status = 'done'; metaProg2[metaIdx2]!.thought = metaThought.thought; metaProg2[metaIdx2]!.confidence = metaThought.confidence; metaProg2[metaIdx2]!.decision = metaThought.metadata?.['decision'] as TradingDecision | undefined; metaProg2[metaIdx2]!.completedAt = Date.now(); }
    this.emitProgress('thinking', metaProg2);
    allThoughts.push(metaThought);

    // Attach skeptics review data to meta-thought's metadata for downstream use
    if (skepticsReviews.length > 0) {
      allThoughts[allThoughts.length - 1] = {
        ...allThoughts[allThoughts.length - 1]!,
        metadata: {
          ...allThoughts[allThoughts.length - 1]!.metadata,
          skepticsReviews,
          skepticsOverridden,
        },
      };
    }

    // ═══════════════════════════════════════════════════
    // PHASE 1.8: Entry Thesis Validation (v2.0.80)
    // If Meta-Agent decided BUY or SELL, Skeptics must validate the
    // entryThesis before the trade is allowed to proceed. If the thesis
    // is rejected, the Meta-Agent's decision is overridden to HOLD.
    // v2.0.94: Skip thesis validation if the symbol already has an open position —
    // the marketTicker decision for a symbol with an existing position is NOT a new
    // entry, it's the Meta-Agent's directional view. Position management (CLOSE/HOLD)
    // is handled via the positions[] array, not via marketTicker BUY/SELL.
    // ═══════════════════════════════════════════════════

    const metaDecision = metaThought.metadata?.['decision'] as TradingDecision | undefined;
    const metaMultiDec = metaThought.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
    const metaAction = metaDecision?.action ?? metaMultiDec?.marketTicker.action ?? 'hold';
    const metaThesis = metaDecision?.entryThesis ?? metaMultiDec?.marketTicker.entryThesis;
    const metaSymbol = metaDecision?.symbol ?? metaMultiDec?.marketTicker.symbol ?? '';

    // v2.0.210 (Fix 3): Thesis-action consistency check. If the Meta-Agent
    // outputs BUY/SELL but the thesis says "no entry" / "N/A" / "no signal" /
    // "insufficient data" / "hold", the decision is self-contradictory (audit
    // found "thesis says N/A — no entry, yet a trade was opened"). Override to
    // HOLD + log so the system doesn't act on a thesis that doesn't support
    // the action. This is a data-quality gate, not a directional veto.
    if ((metaAction === 'buy' || metaAction === 'sell') && metaThesis) {
      const t = metaThesis.toLowerCase();
      const contradictionPatterns = [
        /\bno entry\b/, /\bn\/a\b/, /\bno signal\b/, /\binsufficient data\b/,
        /\bno clear (direction|signal|edge)\b/, /\bunable to determine\b/,
        /\bno actionable\b/, /\bnothing to (do|trade)\b/,
      ];
      const contradicted = contradictionPatterns.some(re => re.test(t));
      if (contradicted) {
        log.warn(`🚫 [thesis-consistency] Meta-Agent output ${metaAction.toUpperCase()} ${metaSymbol} but thesis says no-entry/N/A — overriding to HOLD. Thesis: "${metaThesis.slice(0, 100)}"`);
        // Override the decision action to HOLD in-place.
        if (metaDecision) { (metaDecision as any).action = 'hold'; }
        if (metaMultiDec) { (metaMultiDec.marketTicker as any).action = 'hold'; }
      }
    }

    // v2.0.94: Check if this symbol already has an open position.
    // IMPORTANT: Check currentPositions (the RAW parameter, before active-symbol
    // filtering) — not posCtx (which has the active symbol removed). Otherwise
    // BTC (which is both activeSymbol AND has a position) would be treated as a
    // new entry and its thesis would be validated/rejected by Skeptics.
    // v2.0.104: Trading markets (quantity=0, isTradingMarket=true) are NOT
    // existing positions — they should go through thesis validation.
    const hasExistingPosition = (currentPositions ?? []).some(p =>
      normalizeSymbol(p.symbol) === normalizeSymbol(metaSymbol) && (p.quantity ?? 0) > 0
    );

    // v2.0.138 Phase 1.8a: EXP thesis-history probability gate.
    // Runs BEFORE the subjective 1.8b strength check when expMemory is injected
    // and config.exp.enabled. Verdicts:
    //   PASS_OPEN_DIRECTLY / FAST_APPROVE / APPROVE_WITH_NOTE → skip 1.8b, proceed
    //   REVERSE_DIRECTION → override decision to reversed side + contrarian thesis, proceed
    //   REJECT → override to HOLD
    //   EXP_DISABLED / EXP_ERRORED → fall back to 1.8b (expThesisGated stays false)
    let expThesisGated = false;
    if (this.expMemory && this.expMemory.getCfg().enabled
        && (metaAction === 'buy' || metaAction === 'sell') && metaThesis && !hasExistingPosition) {
      try {
        // v2.0.140: Dual-Channel Fusion — fetch OLR P(win) + shadow win rate
        // for this symbol+side and pass to checkThesisHistory. The fusion layer
        // cross-references the semantic verdict against the statistical channels.
        let fusionData: { olrPWin?: number; shadowWinRate?: number } = {};
        if (this.fusionDataCallback) {
          try {
            fusionData = this.fusionDataCallback(metaSymbol, metaAction);
          } catch { /* non-critical — fusion is supplementary */ }
        }
        const expResult = await this.expMemory.checkThesisHistory({
          thesis: metaThesis, symbol: metaSymbol, side: metaAction, marketCtx: marketStateDesc,
          ...fusionData,
          // v2.0.721: Pass regime for condition-based matching (H3).
          // Filters historical matches to same-regime records with fallback.
          regime: this.currentRegime,
        });
        const v = expResult.verdict;
        const expAction: ExpAction = {
          symbol: metaSymbol, side: metaAction, verdict: v,
          reason: expResult.reason ?? '', cycle: this.totalCycles, ts: Date.now(),
        };
        if (v === 'PASS_OPEN_DIRECTLY' || v === 'FAST_APPROVE' || v === 'APPROVE_WITH_NOTE') {
          log.info(`[EXP 1.8a] ${v} ${metaAction.toUpperCase()} ${metaSymbol} — skip 1.8b${expResult.reason ? ' (' + expResult.reason + ')' : ''}`);
          expThesisGated = true;
        } else if (v === 'REVERSE_DIRECTION' && expResult.reversedSide && expResult.reversedThesis) {
          log.info(`[EXP 1.8a] REVERSE_DIRECTION ${metaAction.toUpperCase()}→${expResult.reversedSide.toUpperCase()} ${metaSymbol} — ${expResult.reason ?? ''}`);
          this.overrideMetaDecision(allThoughts, metaSymbol, metaMultiDec, {
            action: expResult.reversedSide, rationale: `[EXP REVERSE] ${expResult.reason ?? ''}`,
            entryThesis: expResult.reversedThesis, tag: 'EXP-REVERSE',
          });
          expThesisGated = true;
        } else if (v === 'REJECT') {
          log.warn(`[EXP 1.8a] REJECT ${metaAction.toUpperCase()} ${metaSymbol} — ${expResult.reason ?? ''} → HOLD`);
          this.overrideMetaDecision(allThoughts, metaSymbol, metaMultiDec, {
            action: 'hold', rationale: `[EXP REJECT] ${expResult.reason ?? 'EXP history reject'}`,
            confidence: 0.1, tag: 'EXP-REJECT',
          });
          expThesisGated = true;
        } else {
          // EXP_DISABLED / EXP_ERRORED → fall back to 1.8b
          log.info(`[EXP 1.8a] ${v} ${metaAction.toUpperCase()} ${metaSymbol} — falling back to 1.8b strength check${expResult.error ? ' (' + expResult.error + ')' : ''}`);
        }
        this.expActions.push(expAction);
      } catch (err) {
        log.warn(`[EXP 1.8a] error — falling back to 1.8b: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // v2.0.143: RIL Similar Trades + Subtle Differences injection.
    // After EXP checkThesisHistory has computed candidate vectors, use them
    // to find the top-N most similar historical trades. Then, if SubtleDiffAnalyzer
    // is wired, make 1 LLM call to analyse subtle differences between the
    // candidate and the similar winners/losers. Both blocks are appended to
    // marketStateDesc so Skeptics sees them during thesis validation (Phase 1.8b).
    let rilSimilarTradesBlock = '';
    let rilSubtleDiffBlock = '';
    if (this.similarTradeRetriever && this.expMemory && (metaAction === 'buy' || metaAction === 'sell') && metaThesis && !hasExistingPosition) {
      try {
        const candVectors = this.expMemory.getLastCandidateVectors();
        if (candVectors.length > 0) {
          const records = this.expMemory.getRecords();
          // v2.0.176: Pass metaAction as side filter — SELL candidates should
          // only match historical SELL trades, not BUY wins.
          const similar = this.similarTradeRetriever.findSimilar(candVectors, records, 5, undefined, metaAction);
          rilSimilarTradesBlock = this.similarTradeRetriever.formatBlock(similar, metaAction, metaSymbol);

          if (this.subtleDiffAnalyzer && this.llmChatFn && similar.length > 0) {
            try {
              rilSubtleDiffBlock = await this.subtleDiffAnalyzer.analyze(
                metaThesis, metaAction, metaSymbol, similar, this.llmChatFn,
              );
            } catch (err) {
              log.warn(`[RIL] SubtleDiffAnalyzer failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      } catch (err) {
        log.warn(`[RIL] SimilarTradeRetriever failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // v2.0.204: Vector-conditional win-rate block (learned market-condition embedding).
    // Queries the NumericAutoencoder for the win rate of historically similar
    // MARKET CONDITIONS (cross-symbol, same side) and appends it to the Skeptics
    // 1.8b context. This is the TRUE edge signal — "similar market states won X%"
    // — not raw per-symbol WR. Falls back to min-max + cosine when the autoencoder
    // is absent/not ready (cold-start). Supersedes the false "ignoring learning
    // data" diagnosis that raw per-symbol WR produced.
    let naConditionalBlock = '';
    if (this.naEmbeddingProvider && this.naCandidateFeaturesProvider && this.expMemory && (metaAction === 'buy' || metaAction === 'sell') && !hasExistingPosition) {
      try {
        const candidateFeatures = this.naCandidateFeaturesProvider();
        if (candidateFeatures && Object.keys(candidateFeatures).length > 0) {
          const records = this.expMemory.getRecords();
          const cond = computeVectorConditionalWinRate(
            candidateFeatures,
            records,
            { side: metaAction, minSamples: 3, threshold: 0.80, topN: 20, embeddingProvider: this.naEmbeddingProvider ?? undefined },
          );
          if (cond.confidence !== 'none') {
            naConditionalBlock = `\n=== VECTOR-CONDITIONAL WIN RATE (similar market conditions, ${metaAction.toUpperCase()}) ===\n${formatVectorConditional(cond, '  conditional')}\nInterpretation: HIGH conditional WR + you reject = you are blocking a real edge (exit-timing issue, not direction). LOW conditional WR + thesis weak = genuine learning failure, reject is correct.\n---`;
          } else if (cond.sampleSize > 0) {
            naConditionalBlock = `\n=== VECTOR-CONDITIONAL WIN RATE ===\n  ${cond.explanation}\n---`;
          }
        }
      } catch (err) {
        log.warn(`[NA 1.8b] conditional WR block failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Append RIL + NA blocks to the market context used by Skeptics thesis validation
    // v2.0.207 (#E): Failure-lesson retrieval — find the most similar HISTORICAL
    // LOSSES (by rationale + market conditions) and inject their distilled lessons
    // so Skeptics sees "the last time we tried something like this in conditions
    // like this, we lost because {rootCause}". This is the core of "learn from
    // mistakes" — per-candidate, not aggregate stats.
    let failureLessonBlock = '';
    if (this.expMemory && this.naCandidateFeaturesProvider && (metaAction === 'buy' || metaAction === 'sell') && metaThesis && !hasExistingPosition) {
      try {
        const cf = this.naCandidateFeaturesProvider();
        if (cf && Object.keys(cf).length > 0) {
          const lessons = await this.expMemory.retrieveSimilarFailureLessons(
            cf, metaThesis, 3, this.naEmbeddingProvider ?? undefined,
          );
          if (lessons.length > 0) {
            const lines = lessons.map(l =>
              `  • [${(l.similarity * 100).toFixed(0)}% match, ${l.symbol} ${l.side.toUpperCase()} ${l.outcome}] ${l.lesson}${l.rootCause ? ` (rootCause: ${l.rootCause})` : ''}`,
            );
            failureLessonBlock = `\n=== ⚠️ MOST SIMILAR HISTORICAL FAILURES (learn from these) ===\n${lines.join('\n')}\nIf this candidate resembles the above failures, you MUST explain how it differs — or REJECT. Repeating the same anti-pattern is the #1 cause of the 11-trade losing streak.\n---`;
          }
        }
      } catch (err) {
        log.warn(`[EXP #E] failure-lesson block failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // v2.0.207 (#F): Anti-pattern match — does this candidate resemble a
    // KNOWN failure cluster? If so, Skeptics sees "you have lost this way N
    // times before, avg -X%" — the strongest possible "learn from mistakes" signal.
    let antiPatternBlock = '';
    if (this.antiPatternTracker && (metaAction === 'buy' || metaAction === 'sell') && metaThesis && !hasExistingPosition) {
      try {
        const matches = await this.antiPatternTracker.matchCandidate(metaThesis, 3);
        antiPatternBlock = this.antiPatternTracker.formatBlock(matches);
      } catch (err) {
        log.warn(`[anti-pattern #F] matchCandidate failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // v2.0.207 (#B): Momentum-aware dark-psychology block. When short-term
    // momentum is strong (|momentumShort| > 2%), inject a MANDATORY warning so
    // Skeptics' dark-psychology check is NOT lightweight — it must articulate
    // specific evidence why a counter-momentum trade won't be stopped out.
    let momentumWarningBlock = '';
    if (this.naCandidateFeaturesProvider) {
      try {
        const cf = this.naCandidateFeaturesProvider();
        const momShort = cf?.['momentumShort'];
        if (momShort !== undefined && Math.abs(momShort) > 0.02) {
          const dir = momShort > 0 ? 'UP' : 'DOWN';
          const against = momShort > 0 ? 'SELL' : 'BUY';
          momentumWarningBlock = `\n=== ⚠️ SHORT-TERM MOMENTUM ALERT (dark-psychology MANDATORY) ===\n  Price moved ${(Math.abs(momShort) * 100).toFixed(1)}% ${dir} over the last 5 cycles — the market is being PUSHED in one direction.\n  A ${against} here is a COUNTER-MOMENTUM trade. Before approving, you MUST articulate SPECIFIC evidence why this push will reverse (e.g. on-chain distribution, funding extreme, resistance level being sold into) — "could reverse" is NOT sufficient. If you cannot articulate a specific reversal catalyst, REJECT ${against}.\n  This is NOT lightweight: counter-momentum trades have historically been the #1 stop-out pattern.\n---`;
        }
      } catch { /* non-critical */ }
    }
    // v2.0.211 (K.md #1): AttnRes blend context — explain the h_blend
    // candidate so Skeptics/Meta-Agent understand the candidate is a
    // softmax blend over cycle history + entry-time state (not a single
    // snapshot). This teaches the LLM that conditional WR is conditioned on
    // a trajectory-aware representation.
    let attnResBlock = '';
    if (this.naCandidateFeaturesProvider) {
      try {
        const cf = this.naCandidateFeaturesProvider();
        if (cf && (metaAction === 'buy' || metaAction === 'sell') && !hasExistingPosition) {
          // The provider already returns h_blend (wired in index.ts); we add
          // an explanatory note so the LLM knows the candidate is blended.
          attnResBlock = `\n=== ATTENTION-RESIDUAL BLEND (K.md #1) ===\n  The market-condition candidate for conditional WR is a softmax-weighted blend over recent cycle history + entry-time state (AttnRes transfer from Kimi K3). Entry-time regime retains persistent weight. When conditional WR references 'similar market conditions', it means conditions similar to this BLENDED trajectory, not a single snapshot.\n---`;
        }
      } catch { /* non-critical */ }
    }

    // v2.0.212 (#7): Execution-lens context — the execution-mode AttnRes blend
    // (sharp/recent-biased, wExecution trained on SL/TP stop-out outcomes).
    // Shows Skeptics/Meta-Agent the recent regime through the SL/TP survival
    // lens: if wExecution has learned that this regime pattern precedes stop-
    // outs, the blend highlights that pattern so conviction can be calibrated.
    let executionLensBlock = '';
    if (this.cycleHistoryRetriever && (metaAction === 'buy' || metaAction === 'sell') && !hasExistingPosition) {
      try {
        const execBlend = this.cycleHistoryRetriever.retrieveBlend(normalizeSymbol(metaSymbol), 'execution');
        if (execBlend.blended) {
          const execMomentum = execBlend.hBlend['momentumShort'] ?? 0;
          const execVol = execBlend.hBlend['volatility'] ?? 0;
          executionLensBlock = `\n=== EXECUTION REGIME LENS (K.md #7) ===\n  Recent regime through the SL/TP survival lens (sharp/recent-biased AttnRes, trained on stop-out outcomes):\n    volatility=${execVol.toFixed(3)}, momentumShort=${(execMomentum * 100).toFixed(2)}%, entropy=${execBlend.entropy.toFixed(2)} bits\n  If this regime pattern historically precedes stop-outs, consider widening SL or lowering conviction. This lens is EARNED through trade outcomes (cold-start = current snapshot).\n---`;
        }
      } catch { /* non-critical */ }
    }
    const rilEnhancedMarketDesc = `${marketStateDesc}${rilSimilarTradesBlock ? `\n${rilSimilarTradesBlock}` : ''}${rilSubtleDiffBlock ? `\n${rilSubtleDiffBlock}` : ''}${naConditionalBlock}${failureLessonBlock}${antiPatternBlock}${momentumWarningBlock}${attnResBlock}${executionLensBlock}`;

    if ((metaAction === 'buy' || metaAction === 'sell') && metaThesis && !hasExistingPosition && !expThesisGated) {
      log.info(`Phase 1.8: Skeptics validating entry thesis for ${metaAction.toUpperCase()} ${metaSymbol}...`);
      const thesisResult = await this.skeptics.validateEntryThesis(
        metaThesis,
        metaAction,
        metaSymbol,
        rilEnhancedMarketDesc,
        allThoughts,
      );
      if (!thesisResult.approved) {
        log.warn(`🚫 Entry thesis REJECTED by Skeptics: ${thesisResult.rationale} — overriding ${metaAction.toUpperCase()} → HOLD`);
        // Override Meta-Agent's decision to HOLD
        const lastIdx = allThoughts.length - 1;
        allThoughts[lastIdx] = {
          ...allThoughts[lastIdx]!,
          thought: `[THESIS REJECTED] ${allThoughts[lastIdx]!.thought}`,
          confidence: 0.1,
          metadata: {
            ...allThoughts[lastIdx]!.metadata,
            multiSymbolDecision: {
              ...(allThoughts[lastIdx]!.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined) ?? metaMultiDec ?? {
                marketTicker: { symbol: metaSymbol, action: 'hold' as const, positionSizePct: 0, leverage: 1, closePosition: false, rationale: 'Thesis rejected' },
                positions: [],
              },
              marketTicker: {
                ...((allThoughts[lastIdx]!.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined)?.marketTicker ?? metaMultiDec?.marketTicker ?? { symbol: metaSymbol, action: 'hold' as const, positionSizePct: 0, leverage: 1, closePosition: false, rationale: '' }),
                action: 'hold' as const,
                positionSizePct: 0,
                leverage: 1,
                rationale: `[THESIS REJECTED] ${thesisResult.rationale}`,
              },
            },
            decision: {
              ...(allThoughts[lastIdx]!.metadata?.['decision'] as TradingDecision | undefined) ?? {},
              action: 'hold' as const,
              positionSizePct: 0,
              leverage: 1,
              rationale: `[THESIS REJECTED] ${thesisResult.rationale}`,
            } as TradingDecision,
          },
        };
        // Also store the full rejection rationale in the Skeptics thought metadata
        // so the UI can display it per-symbol in the Skeptics card.
        const skepticsThoughtIdx = allThoughts.findIndex(t => t.agentRole === 'skeptics');
        if (skepticsThoughtIdx >= 0) {
          const existingRejections = (allThoughts[skepticsThoughtIdx]!.metadata?.['thesisRejections'] as Array<{ symbol: string; action: string; rationale: string }>) ?? [];
          allThoughts[skepticsThoughtIdx] = {
            ...allThoughts[skepticsThoughtIdx]!,
            metadata: {
              ...allThoughts[skepticsThoughtIdx]!.metadata,
              thesisRejections: [
                ...existingRejections,
                { symbol: metaSymbol, action: metaAction, rationale: thesisResult.rationale },
              ],
            },
          };
        }
      } else {
        log.info(`✅ Entry thesis approved by Skeptics for ${metaAction.toUpperCase()} ${metaSymbol}`);
      }
    } else if ((metaAction === 'buy' || metaAction === 'sell') && !metaThesis) {
      // Meta-Agent wants to trade but provided no thesis — block it
      log.warn(`🚫 Meta-Agent ${metaAction.toUpperCase()} ${metaSymbol} has NO entry thesis — overriding → HOLD`);
      const lastIdx = allThoughts.length - 1;
      allThoughts[lastIdx] = {
        ...allThoughts[lastIdx]!,
        thought: `[NO THESIS] ${allThoughts[lastIdx]!.thought}`,
        confidence: 0.1,
        metadata: {
          ...allThoughts[lastIdx]!.metadata,
          multiSymbolDecision: {
            ...(allThoughts[lastIdx]!.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined) ?? metaMultiDec ?? {
              marketTicker: { symbol: metaSymbol, action: 'hold' as const, positionSizePct: 0, leverage: 1, closePosition: false, rationale: 'No thesis provided' },
              positions: [],
            },
            marketTicker: {
              ...((allThoughts[lastIdx]!.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined)?.marketTicker ?? metaMultiDec?.marketTicker ?? { symbol: metaSymbol, action: 'hold' as const, positionSizePct: 0, leverage: 1, closePosition: false, rationale: '' }),
              action: 'hold' as const,
              positionSizePct: 0,
              leverage: 1,
              rationale: '[NO THESIS] Meta-Agent must provide entryThesis for BUY/SELL decisions.',
            },
          },
          decision: {
            ...(allThoughts[lastIdx]!.metadata?.['decision'] as TradingDecision | undefined) ?? {},
            action: 'hold' as const,
            positionSizePct: 0,
            leverage: 1,
            rationale: '[NO THESIS] Meta-Agent must provide entryThesis for BUY/SELL decisions.',
          } as TradingDecision,
        },
      };
    }

    // Check if we have enough information for immediate consensus
    const allHold = allThoughts.every((t) => {
      const decision = t.metadata?.['decision'] as TradingDecision | undefined;
      return decision?.action === 'hold';
    });

    const highConviction = allThoughts.filter((t) => t.confidence > 0.7).length;
    const strongDisagreement = allThoughts.some((t) => t.confidence < 0.2);

    // Skip debate if all agents agree on HOLD with high conviction
    // Now includes all 5 agents (3 sub-agents + meta-agent + risk auditor)
    // v2.0.126: Do NOT skip if Meta-Agent has a BUY/SELL for any trading market
    // in its multiSymbolDecision. The overall decision.action may be HOLD (the
    // active symbol), but Meta-Agent may have SELL for a trading market (e.g.
    // SILVER). Skipping debate would still call buildConsensus (which has the
    // v2.0.125 override), but the fast-path returns early without debate,
    // which is fine — the override works in buildConsensus. However, we must
    // NOT skip if Meta-Agent has a directional call that needs Skeptics
    // validation (Phase 1.8 thesis gate runs in the normal path).
    const metaHasTradingMarketSignal = allThoughts.some(t => {
      if (t.agentRole !== 'meta_agent') return false;
      const msd = t.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
      if (!msd) return false;
      const tradingSyms = new Set((currentPositions ?? [])
        .filter(p => (p.quantity ?? 0) === 0 || p.isTradingMarket === true)
        .map(p => normalizeSymbol(p.symbol)));
      // Check marketTicker
      if (tradingSyms.has(normalizeSymbol(msd.marketTicker.symbol)) &&
          (msd.marketTicker.action === 'buy' || msd.marketTicker.action === 'sell')) return true;
      // Check positions
      return msd.positions.some(p =>
        tradingSyms.has(normalizeSymbol(p.symbol)) &&
        (p.action === 'buy' || p.action === 'sell'));
    });
    if (allHold && highConviction >= allThoughts.length - 1 && !metaHasTradingMarketSignal) {
      log.info('Skipping debate: unanimous HOLD with high conviction.');
      const consensus = this.buildConsensus(allThoughts, [], true, false, undefined, currentPositions);
      const adjustments = await this.adjustPositions(constrainedMarketDesc, currentPositions);
      return {
        consensus,
        allThoughts,
        debateRounds: [],
        durationMs: Math.round(performance.now() - startTime),
        positionAdjustments: adjustments,
        thesisInvalidatedSymbols: Array.from(thesisInvalidatedSymbols),
        expActions: this.expActions,
      };
    }

    // ═══════════════════════════════════════════════════
    // PHASE 2: Structured Rapid Debate (up to 3 rounds)
    // ═══════════════════════════════════════════════════

    let currentContext = this.buildDebateContext(allThoughts);
    let consensusReached = false;
    let finalConsensus: ConsensusResult | null = null;

    for (let round = 1; round <= this.maxRounds; round++) {
      if (Date.now() > deadline) {
        log.warn(`HACP deadline exceeded at round ${round}. Forcing consensus.`);
        break;
      }

      log.info(`Phase 2 — Debate Round ${round}/${this.maxRounds}`);

      const roundStatements: DebateStatement[] = [];

      // Track A2A token savings
      let a2aParsedCount = 0;

      // Round 1: Arguments (strongest point)
      // Round 2: Attack/Reinforce
      // Round 3: Synthesis

      let phase: 'argument' | 'attack' | 'synthesis';

      if (round === 1) {
        phase = 'argument';
      } else if (round < this.maxRounds) {
        phase = 'attack';
      } else {
        phase = 'synthesis';
      }

      // In parallel, each agent generates their statement
      const statementPromises = this.subAgents.map(async (agent, idx) => {
        const targetThought = phase === 'attack'
          ? this.findWeakestThought(idx, allThoughts)
          : undefined;

        // Emit: agent debating
        const debateProg = this.makeAgentProgressList();
        const dIdx = debateProg.findIndex(p => p.agentRole === agent.identity.role);
        if (dIdx >= 0) {
          debateProg[dIdx]!.status = 'thinking';
          debateProg[dIdx]!.startedAt = Date.now();
        }
        this.emitProgress('debating', debateProg, round);

        try {
          const result = await agent.generateDebateStatement(
            phase,
            currentContext,
            targetThought
          );

          // Emit: agent done debating
          const debateProg2 = this.makeAgentProgressList();
          const dIdx2 = debateProg2.findIndex(p => p.agentRole === agent.identity.role);
          if (dIdx2 >= 0) {
            debateProg2[dIdx2]!.status = 'done';
            debateProg2[dIdx2]!.thought = result.content;
            debateProg2[dIdx2]!.confidence = result.confidence;
            debateProg2[dIdx2]!.completedAt = Date.now();
          }
          this.emitProgress('debating', debateProg2, round);

          return {
            agentId: agent.identity.id,
            agentRole: agent.identity.role,
            content: result.content,
            targetAgentId: targetThought?.agentId,
            confidence: result.confidence,
            type: phase === 'argument'
              ? 'argument' as const
              : phase === 'attack'
                ? 'attack' as const
                : 'synthesis' as const,
          };
        } catch {
          return {
            agentId: agent.identity.id,
            agentRole: agent.identity.role,
            content: `[${agent.identity.name}] Round ${round} input unavailable.`,
            confidence: 0.2,
            type: phase === 'argument'
              ? 'argument' as const
              : phase === 'attack'
                ? 'attack' as const
                : 'synthesis' as const,
          } as DebateStatement;
        }
      });

      const statements = await Promise.all(statementPromises);
      roundStatements.push(...statements);

      // Attempt A2A parsing on each statement for structured insights
      for (const stmt of roundStatements) {
        const a2a = parseA2ASignal(stmt.content);
        if (a2a) {
          a2aParsedCount++;
          log.debug(`A2A signal [${a2a.type}]: ${formatA2ASignal(a2a)}`);
        }
      }

      if (a2aParsedCount > 0) {
        log.info(`A2A: ${a2aParsedCount}/${roundStatements.length} statements parsed as structured signals`);
      }

      const debateRound: DebateRound = {
        roundNumber: round,
        phase,
        statements: roundStatements,
        timestamp: Date.now(),
      };
      debateRounds.push(debateRound);

      // After Round 1 (argument): if all agents agree on same action, skip attack/synthesis
      if (round === 1) {
        const actions = allThoughts
          .filter(t => t.agentRole !== 'meta_agent' && t.agentRole !== 'market_agent' && t.agentRole !== 'skeptics' && t.agentRole !== 'independent_risk_auditor')
          .map(t => {
            const d = t.metadata?.['decision'] as TradingDecision | undefined;
            return d?.action ?? 'hold';
          });
        const uniqueActions = new Set(actions);
        if (uniqueActions.size === 1 && actions.length >= 3) {
          log.info(`Unanimous action "${actions[0]}" after Round 1 — skipping attack/synthesis rounds (saved ${this.maxRounds - 1} rounds)`);
          const voteResults = await this.runConsensusVote(allThoughts);
          consensusReached = true;
          finalConsensus = this.buildConsensus(allThoughts, debateRounds, true, false, voteResults, currentPositions);
          break;
        }
      }

      // Check for consensus after each round
      if (round >= 2) {
        const voteResults = await this.runConsensusVote(allThoughts);
        const weightedScore = this.calcWeightedConsensus(voteResults);

        // v2.0.41: Use effective threshold (Evolution signalThreshold override
        // or config default + adjustThreshold loss-streak adjustment)
        const effectiveThreshold = this.getEffectiveConsensusThreshold();
        if (weightedScore >= effectiveThreshold) {
          log.info(`Consensus reached at round ${round} (weighted: ${weightedScore.toFixed(3)}, threshold: ${effectiveThreshold.toFixed(3)})`);
          consensusReached = true;
          finalConsensus = this.buildConsensus(
            allThoughts,
            debateRounds,
            true,
            false,
            voteResults,
            currentPositions,
          );
          break;
        }

        if (strongDisagreement && round >= 2) {
          // Check if debate is polarizing — may need meta-agent arbitration
          const polarizing = this.detectPolarization(voteResults);
          if (polarizing) {
            log.info('Debate polarizing — invoking meta-agent arbitration.');
            finalConsensus = await this.metaAgentArbitration(
              allThoughts,
              debateRounds,
              voteResults
            );
            consensusReached = true;
            break;
          }
        }
      }

      // Update context for next round
      currentContext += `\n\n--- Round ${round} Results ---\n`;
      for (const st of roundStatements) {
        currentContext += `[${st.agentRole}] (${st.confidence.toFixed(2)}): ${st.content}\n`;
      }
    }

    // ═══════════════════════════════════════════════════
    // PHASE 3: Consensus & Conclusion Lock
    // ═══════════════════════════════════════════════════

    // Emit voting phase
    this.emitProgress('voting', this.makeAgentProgressList());

    if (!finalConsensus) {
      if (!consensusReached) {
        log.info('No consensus reached — meta-agent performing final arbitration.');
        finalConsensus = await this.metaAgentArbitration(
          allThoughts,
          debateRounds,
          null
        );
      } else {
        finalConsensus = this.buildConsensus(allThoughts, debateRounds, true, false, undefined, currentPositions);
      }
    }

    // ═══════════════════════════════════════════════════
    // PHASE 4: Risk Auditor Final Veto Check
    // ═══════════════════════════════════════════════════

    // Emit audit phase
    const auditProg = this.makeAgentProgressList();
    const auditIdx = auditProg.findIndex(p => p.agentRole === 'independent_risk_auditor');
    if (auditIdx >= 0) {
      auditProg[auditIdx]!.status = 'thinking';
      auditProg[auditIdx]!.startedAt = Date.now();
    }
    this.emitProgress('auditing', auditProg);

    const riskAudit = await this.riskAuditorAudit(finalConsensus.decision);

    // Emit audit done
    const auditProg2 = this.makeAgentProgressList();
    const auditIdx2 = auditProg2.findIndex(p => p.agentRole === 'independent_risk_auditor');
    if (auditIdx2 >= 0) {
      auditProg2[auditIdx2]!.status = 'done';
      auditProg2[auditIdx2]!.completedAt = Date.now();
      auditProg2[auditIdx2]!.thought = riskAudit.veto ? `VETO: ${riskAudit.reason}` : 'Approved — no concerns.';
    }
    this.emitProgress('auditing', auditProg2);
    if (riskAudit.veto) {
      // v2.0.82: Risk Auditor veto is now ADVISORY ONLY — it cannot block trades.
      // The Meta-Agent + Skeptics thesis system is the sole gatekeeper for
      // new entries. Risk Auditor's veto is logged as a warning but does not
      // override the decision. TP/SL/size adjustments below are still applied.
      log.warn(`⚠️ Risk Auditor ADVISORY veto (non-blocking): ${riskAudit.reason}`);
    } else if (
      !riskAudit.veto &&
      (riskAudit.adjustedStopLossPct !== undefined ||
       riskAudit.adjustedTakeProfitPct !== undefined ||
       riskAudit.adjustedPositionSizePct !== undefined)
    ) {
      // Risk Auditor recommended TP/SL/size adjustments based on the recent
      // trade pattern (e.g. choppy market → narrow TP/SL to range edges +
      // reduce size; trending market → widen TP to let profits run).
      // Apply them to the final consensus decision so the execution layer
      // honours the new levels.
      const origSL = finalConsensus.decision.stopLossPct;
      const origTP = finalConsensus.decision.takeProfitPct;
      const origSize = finalConsensus.decision.positionSizePct;
      if (riskAudit.adjustedStopLossPct !== undefined) {
        finalConsensus.decision.stopLossPct = riskAudit.adjustedStopLossPct;
      }
      if (riskAudit.adjustedTakeProfitPct !== undefined) {
        finalConsensus.decision.takeProfitPct = riskAudit.adjustedTakeProfitPct;
      }
      if (riskAudit.adjustedPositionSizePct !== undefined) {
        // v2.0.41: No MAX_POSITION_PCT clamp — Market Agent controls size.
        // Risk Auditor can reduce but Phase 4.5 will override to Market Agent's value.
        finalConsensus.decision.positionSizePct = Math.max(0, riskAudit.adjustedPositionSizePct);
      }
      log.info(`🔧 Risk Auditor adjusted: SL ${origSL ? (origSL * 100).toFixed(1) + '%' : 'none'} → ${finalConsensus.decision.stopLossPct ? (finalConsensus.decision.stopLossPct * 100).toFixed(1) + '%' : 'none'}, TP ${origTP ? (origTP * 100).toFixed(1) + '%' : 'none'} → ${finalConsensus.decision.takeProfitPct ? (finalConsensus.decision.takeProfitPct * 100).toFixed(1) + '%' : 'none'}, size ${(origSize * 100).toFixed(1)}% → ${(finalConsensus.decision.positionSizePct * 100).toFixed(1)}% (${riskAudit.reason})`);
    }

    // ═══════════════════════════════════════════════════
    // PHASE 4.5: Enforce Market Agent Hard Constraints
    // ═══════════════════════════════════════════════════

    if (marketAgentConstraints && !riskAudit.veto) {
      const targetSize = marketAgentConstraints.positionSizePct;
      const targetLev = marketAgentConstraints.leverage;
      const origSize = finalConsensus.decision.positionSizePct;
      const origLev = finalConsensus.decision.leverage ?? 1;

      // Only override position size if the decision is BUY or SELL (not HOLD)
      if (finalConsensus.decision.action !== 'hold') {
        if (finalConsensus.decision.positionSizePct !== targetSize) {
          finalConsensus.decision.positionSizePct = targetSize;
          log.warn(`Market Agent constraint: position size overridden ${(origSize * 100).toFixed(1)}% → ${(targetSize * 100).toFixed(1)}%`);
        }
        if ((finalConsensus.decision.leverage ?? 1) !== targetLev) {
          finalConsensus.decision.leverage = targetLev;
          log.warn(`Market Agent constraint: leverage overridden ${origLev}x → ${targetLev}x`);
        }
      }
    }

    // ═══════════════════════════════════════════════════
    // PHASE 4.8: Entry Thesis Hard Gate (v2.0.80)
    // FINAL enforcement — regardless of which consensus path was taken
    // (buildConsensus majority, metaAgentArbitration, or unanimous fast-path),
    // if the final decision is BUY or SELL it MUST have a valid entryThesis.
    // Without a thesis, the trade is blocked. This catches:
    //   - Sub-agent majority overriding Meta-Agent's HOLD (buildConsensus)
    //   - metaAgentArbitration producing a new BUY/SELL without thesis
    //   - Unanimous fast-path skipping Phase 1.8 thesis validation
    // ═══════════════════════════════════════════════════

    if (finalConsensus.decision.action === 'buy' || finalConsensus.decision.action === 'sell') {
      // v2.0.95: Skip thesis gate if the symbol already has an open position.
      // Check currentPositions (raw parameter, before active-symbol filtering).
      // v2.0.104: Trading markets (quantity=0) are NOT existing positions.
      const activeSymForGate = finalConsensus.decision.symbol;
      const hasExistingPositionForGate = (currentPositions ?? []).some(p =>
        normalizeSymbol(p.symbol) === normalizeSymbol(activeSymForGate) && (p.quantity ?? 0) > 0
      );
      if (!hasExistingPositionForGate) {
      // Check the decision itself
      const decisionThesis = finalConsensus.decision.entryThesis;
      // Also check perSymbolConsensus for the active symbol.
      // v2.0.136: Reconcile quote-suffix mismatch (decision.symbol 'btcusdt' vs
      // psc.symbol 'btc') by stripping common quote suffixes before comparing.
      const activeSym = finalConsensus.decision.symbol;
      const baseSym = (s: string) => normalizeSymbol(s).replace(/(usdt|usdc|busd|usd)$/, '');
      const pscThesis = finalConsensus.perSymbolConsensus.find(
        psc => baseSym(psc.symbol) === baseSym(activeSym),
      )?.entryThesis;
      const effectiveThesis = decisionThesis ?? pscThesis;

      if (!effectiveThesis || effectiveThesis.trim().length === 0) {
        log.warn(`🚫 [THESIS GATE] ${finalConsensus.decision.action.toUpperCase()} ${activeSym} has NO entry thesis — BLOCKING trade (overriding → HOLD)`);
        finalConsensus.decision = {
          ...finalConsensus.decision,
          action: 'hold',
          positionSizePct: 0,
          leverage: 1,
          rationale: `[THESIS GATE] No entry thesis provided — trade blocked. Meta-Agent must articulate why price reaches TP within 1h and 1d. Original: ${finalConsensus.decision.rationale}`,
        };
        finalConsensus.confidence = 0.0;
      } else {
        // Thesis exists — but was it validated by Skeptics in Phase 1.8?
        // If Phase 1.8 rejected it, the Meta-Agent thought was already overridden
        // to HOLD. But metaAgentArbitration or buildConsensus majority could
        // have resurrected a BUY/SELL. We need to validate here as a fallback.
        // Check if the thesis was already validated (Phase 1.8 ran for this thesis)
        const metaThought = allThoughts.find(t => t.agentRole === 'meta_agent');
        const wasValidated = metaThought?.thought?.includes('[THESIS REJECTED]') === false
          && metaThought?.thought?.includes('[NO THESIS]') === false
          && metaThought?.metadata?.['decision'] !== undefined;

        if (!wasValidated) {
          // Thesis exists but wasn't validated by Phase 1.8 (e.g. came from
          // metaAgentArbitration or buildConsensus). Validate now.
          log.info(`Phase 4.8: Validating unvalidated thesis for ${finalConsensus.decision.action.toUpperCase()} ${activeSym}...`);
          const thesisResult = await this.skeptics.validateEntryThesis(
            effectiveThesis,
            finalConsensus.decision.action,
            activeSym,
            marketStateDesc,
            allThoughts,
          );
          if (!thesisResult.approved) {
            log.warn(`🚫 [THESIS GATE] Skeptics REJECTED thesis for ${finalConsensus.decision.action.toUpperCase()} ${activeSym}: ${thesisResult.rationale} — BLOCKING trade`);
            finalConsensus.decision = {
              ...finalConsensus.decision,
              action: 'hold',
              positionSizePct: 0,
              leverage: 1,
              rationale: `[THESIS GATE] Skeptics rejected thesis: ${thesisResult.rationale}. Original: ${finalConsensus.decision.rationale}`,
            };
            finalConsensus.confidence = 0.0;
          } else {
            // Thesis validated — ensure it's on the decision for downstream storage
            if (!finalConsensus.decision.entryThesis) {
              finalConsensus.decision.entryThesis = effectiveThesis;
            }
            log.info(`✅ [THESIS GATE] Thesis validated for ${finalConsensus.decision.action.toUpperCase()} ${activeSym}`);
          }
        } else {
          // Thesis was already validated in Phase 1.8 — ensure it's on the decision
          if (!finalConsensus.decision.entryThesis) {
            finalConsensus.decision.entryThesis = effectiveThesis;
          }
        }
      }
      } // end if (!hasExistingPositionForGate)
    }

    // ═══════════════════════════════════════════════════
    // PHASE 5: Meta-Agent Position Adjustment (TP/SL)
    // ═══════════════════════════════════════════════════

    let positionAdjustments: PositionAdjustment[] | undefined;
    if (currentPositions && currentPositions.length > 0) {
      positionAdjustments = await this.adjustPositions(constrainedMarketDesc, currentPositions);
      if (positionAdjustments.length > 0) {
        log.info(`📐 Position adjustments: ${positionAdjustments.length} positions updated`);
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    log.info('✅ HACP cycle complete', {
      decision: finalConsensus.decision.action.toUpperCase(),
      confidence: finalConsensus.confidence.toFixed(2),
      roundsUsed: debateRounds.length,
      durationMs,
      vetoed: riskAudit.veto,
      adjustments: positionAdjustments?.length ?? 0,
    });

    return {
      consensus: finalConsensus,
      allThoughts,
      debateRounds,
      durationMs,
      positionAdjustments,
      thesisInvalidatedSymbols: Array.from(thesisInvalidatedSymbols),
      expActions: this.expActions,
    };
  }

  /**
   * Meta-agent reviews open positions and suggests TP/SL adjustments
   * based on current market conditions.
   * Only adjusts positions whose symbol matches the primary trading symbol
   * (avoids cross-symbol mispricing, e.g. using xyz:CL context for BTC).
   */
  private async adjustPositions(
    _marketStateDesc: string,
    positions?: Array<{ id: string; symbol: string; side: string; entryPrice: number; currentPrice: number; stopLoss?: number; takeProfit?: number; leverage?: number; quantity?: number; isTradingMarket?: boolean; minValueReached?: number; maxValueReached?: number }>
  ): Promise<PositionAdjustment[]> {
    // v2.0.225: DISABLED trailing stop (#2) + MFE giveback (#3) + TP narrowing.
    // Owner directive: initial SL/TP (#1) + manual close is sufficient.
    // Post-entry SL narrowing caused premature stop-outs (most SKHX SELL
    // losses hit SL at 0.27-1.72% distance — too tight for normal volatility).
    // Also caused UI/Hyperliquid SL desync (narrowed SL couldn't be pushed
    // to exchange when price already past it → exchange keeps original SL).
    //
    // This method now returns [] (NO SL/TP modifications). Auto-close on
    // adverse conditions is handled deterministically in index.ts via
    // OLR edge-collapse + severe adverse momentum checks.
    //
    // The LLM-based thesis invalidation (Phase 0.5, Skeptics
    // validateOpenPositionTheses) is PRESERVED — it catches fundamental
    // thesis breakdown (regime change, catalyst invalidation) that the
    // user wants as the "MATS 認為好唔對路 → 即時平倉" mechanism.
    if (!positions || positions.length === 0) return [];
    return [];
  }

  private buildDebateContext(thoughts: AgentThought[]): string {
    let ctx = '=== Agent Thoughts Summary ===\n';
    for (const t of thoughts) {
      const decision = (t.metadata?.['decision'] as TradingDecision) ?? { action: 'hold', symbol: 'UNKNOWN' };
      ctx += `\n[${t.agentRole}] (conf: ${t.confidence.toFixed(2)}, decision: ${decision.action.toUpperCase()}, size: ${((decision.positionSizePct ?? 0) * 100).toFixed(1)}%)`;
      // v2.0.146: Include per-symbol decisions so debate agents know WHICH
      // asset each statement refers to. Without this, debate statements are
      // generic and don't name the asset being analyzed.
      const msd = t.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
      if (msd) {
        const allDecisions = [msd.marketTicker, ...msd.positions];
        ctx += `\n  Per-symbol decisions:`;
        for (const d of allDecisions) {
          ctx += `\n    ${d.symbol}: ${d.action.toUpperCase()} (${((d.confidence ?? 0) * 100).toFixed(0)}%) — ${d.rationale.slice(0, 120)}`;
        }
      }
      ctx += `\n  ${t.thought.slice(0, 150)}...\n`;
    }
    return ctx;
  }

  private findWeakestThought(
    currentIdx: number,
    thoughts: AgentThought[]
  ): AgentThought | undefined {
    const others = thoughts.filter((_, i) => i !== currentIdx);
    // Pick the one with lowest confidence
    others.sort((a, b) => a.confidence - b.confidence);
    return others[0];
  }

  private detectPolarization(votes: Vote[]): boolean {
    const confidences = votes.map((v) => v.confidence);
    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const variance = confidences.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / confidences.length;
    return variance > 0.15; // High variance = polarized
  }

  private async runConsensusVote(
    thoughts: AgentThought[]
  ): Promise<Vote[]> {
    const votes: Vote[] = [];

    for (const agent of [...this.subAgents, this.metaAgent]) {
      const agentThought = thoughts.find((t) => t.agentId === agent.identity.id);
      const decision = (agentThought?.metadata?.['decision'] as TradingDecision) ?? {
        action: 'hold',
        symbol: 'UNKNOWN',
        positionSizePct: 0,
        rationale: 'Vote fallback.',
        urgency: 'patient',
      };

      const voteResult = await agent.vote([decision]);
      // v2.0.15: use regime-aware dynamic weight when the agent evolution
      // engine is injected; otherwise fall back to the hardcoded base weight.
      const weight = this.agentEvolution
        ? this.agentEvolution.getDynamicWeight(agent.identity.role, this.currentRegime)
        : agent.identity.weight;
      votes.push({
        agentId: agent.identity.id,
        agentRole: agent.identity.role,
        weight,
        decision: voteResult.decision,
        confidence: voteResult.confidence,
      });
    }

    // v2.0.61: Inject Options Data Layer vote for Stocks/Indices.
    // This vote has the HIGHEST weight, giving options-derived signals
    // dominant influence in the consensus when trading equities.
    if (this.optionsVote) {
      votes.push(this.optionsVote);
      log.info(`📊 [options-vote] Injected: ${this.optionsVote.decision.action.toUpperCase()} weight=${this.optionsVote.weight} conf=${this.optionsVote.confidence.toFixed(2)}`);
      // Consume the vote — it's per-cycle, not persistent
      this.optionsVote = null;
    }

    return votes;
  }

  private calcWeightedConsensus(votes: Vote[]): number {
    // v2.0.38 FIX: Directional agreement — NOT Math.abs().
    // Previously used Math.abs(agreementScore) which meant BUY and SELL votes
    // both added positive weight. The threshold measured conviction (how
    // confident agents are) not directional agreement (do agents agree on
    // the SAME direction). 5 agents confidently voting BUY passed the
    // threshold even if OLR showed no edge, because the threshold only
    // checked "are agents confident" not "do agents agree on direction".
    //
    // Now: weightedSum = sum(weight * confidence * decisionValue)
    //   BUY = +1, SELL = -1, HOLD = 0
    // The score ranges from -1 (all SELL) to +1 (all BUY).
    // A score near 0 means agents are split (half BUY, half SELL) —
    // this will NOT pass the threshold even if all agents are confident.
    // The threshold now truly measures "do agents agree on one direction?"
    let totalWeight = 0;
    let weightedSum = 0;

    for (const vote of votes) {
      const decisionValue = vote.decision.action === 'buy' ? 1
        : vote.decision.action === 'sell' ? -1
        : 0;
      const agreementScore = vote.confidence * decisionValue;
      weightedSum += vote.weight * agreementScore;
      totalWeight += vote.weight;
    }

    // Return absolute value so both strong BUY and strong SELL consensus
    // can pass the threshold — but a split (half BUY half SELL) will NOT.
    // Without abs(), a strong SELL consensus would return negative and
    // never pass a positive threshold — which would block all SELL trades.
    return totalWeight > 0 ? Math.abs(weightedSum / totalWeight) : 0;
  }

  private buildConsensus(
    thoughts: AgentThought[],
    rounds: DebateRound[],
    reached: boolean,
    deadlock: boolean,
    existingVotes?: Vote[],
    /** v2.0.125: Current positions + trading markets. Used to determine which
     *  symbols are trading markets (no open position) — for those, Meta-Agent's
     *  per-symbol decision is authoritative (not sub-agent majority vote). */
    currentPositions?: Array<{ symbol: string; quantity?: number; isTradingMarket?: boolean }>,
  ): ConsensusResult {
    // ─── Per-Symbol Consensus ───
    // Extract per-symbol decisions from each agent's multiSymbolDecision metadata.
    // Each agent produces decisions for: market ticker + all open positions.
    // We aggregate across agents to find the consensus for EACH symbol.
    const perSymbolMap = new Map<string, { actions: string[]; confidences: number[]; closeFlags: boolean[]; sls: number[]; tps: number[]; sizes: number[]; levers: number[]; rationales: string[]; theses: string[]; holdReasons: string[] }>();

    for (const t of thoughts) {
      const multiDec = t.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
      if (!multiDec) {
        // Fallback: single legacy decision
        const singleDec = t.metadata?.['decision'] as TradingDecision | undefined;
        if (singleDec) {
          // 🐛 FIX: Skip agents that don't trade (Skeptics) — their fallback
          // decision has symbol='UNKNOWN' which pollutes per-symbol consensus
          // with a meaningless "UNKNOWN(market) HOLD 60%" entry in the UI.
          if (singleDec.symbol === 'UNKNOWN') continue;
          const sym = singleDec.symbol.includes(':') ? singleDec.symbol : singleDec.symbol.toLowerCase();
          if (!perSymbolMap.has(sym)) perSymbolMap.set(sym, { actions: [], confidences: [], closeFlags: [], sls: [], tps: [], sizes: [], levers: [], rationales: [], theses: [], holdReasons: [] });
          const entry = perSymbolMap.get(sym)!;
          entry.actions.push(singleDec.action);
          entry.confidences.push(t.confidence);
          entry.closeFlags.push(false);
          entry.sls.push(singleDec.stopLossPct ?? 0);
          entry.tps.push(singleDec.takeProfitPct ?? 0);
          entry.sizes.push(singleDec.positionSizePct);
          entry.levers.push(singleDec.leverage ?? 1);
          entry.rationales.push(singleDec.rationale);
          // v2.0.80: Forward entryThesis from TradingDecision
          if (singleDec.entryThesis) entry.theses.push(singleDec.entryThesis);
        }
        continue;
      }

      // Market ticker decision
      const mt = multiDec.marketTicker;
      const mtSym = mt.symbol.includes(':') ? mt.symbol : mt.symbol.toLowerCase();
      if (!perSymbolMap.has(mtSym)) perSymbolMap.set(mtSym, { actions: [], confidences: [], closeFlags: [], sls: [], tps: [], sizes: [], levers: [], rationales: [], theses: [], holdReasons: [] });
      const mtEntry = perSymbolMap.get(mtSym)!;
      mtEntry.actions.push(mt.action);
      mtEntry.confidences.push(t.confidence);
      mtEntry.closeFlags.push(mt.closePosition);
      mtEntry.sls.push(mt.suggestedStopLoss ?? 0);
      mtEntry.tps.push(mt.suggestedTakeProfit ?? 0);
      mtEntry.sizes.push(mt.positionSizePct);
      mtEntry.levers.push(mt.leverage);
      mtEntry.rationales.push(mt.rationale);
      // v2.0.80: Forward entryThesis — Meta-Agent's thesis is authoritative
      if (mt.entryThesis) mtEntry.theses.push(mt.entryThesis);
      // v2.0.81: Forward holdReason — Meta-Agent's HOLD explanation
      if (mt.holdReason) mtEntry.holdReasons.push(mt.holdReason);

      // Open position decisions
      for (const pos of multiDec.positions) {
        const posSym = pos.symbol.includes(':') ? pos.symbol : pos.symbol.toLowerCase();
        if (!perSymbolMap.has(posSym)) perSymbolMap.set(posSym, { actions: [], confidences: [], closeFlags: [], sls: [], tps: [], sizes: [], levers: [], rationales: [], theses: [], holdReasons: [] });
        const posEntry = perSymbolMap.get(posSym)!;
        posEntry.actions.push(pos.action);
        posEntry.confidences.push(t.confidence);
        posEntry.closeFlags.push(pos.closePosition);
        posEntry.sls.push(pos.suggestedStopLoss ?? 0);
        posEntry.tps.push(pos.suggestedTakeProfit ?? 0);
        posEntry.sizes.push(pos.positionSizePct);
        posEntry.levers.push(pos.leverage);
        posEntry.rationales.push(pos.rationale);
        // v2.0.136: Forward entryThesis for position decisions. Previously this
        // positions[] loop pushed rationale + holdReason but NOT entryThesis —
        // unlike the marketTicker path (line ~1895) and singleDec path (line
        // ~1876) which both push it. So trading-market positions (e.g. xyz:MU
        // when it's a non-active trading market, whose decision lives in
        // multiDec.positions[]) lost their entryThesis → psc.entryThesis was
        // undefined → the real-trade mirror was created with no thesis → the
        // Portfolio UI "Reason" was empty from cycle 1. Add the missing push.
        if (pos.entryThesis) posEntry.theses.push(pos.entryThesis);
        // v2.0.81: Forward holdReason for position decisions
        if (pos.holdReason) posEntry.holdReasons.push(pos.holdReason);
      }
    }

    // Compute per-symbol consensus
    // v2.0.125: For trading markets (no open position), Meta-Agent's decision
    // is authoritative — not the sub-agent majority vote. Sub-agents are
    // data-gatherers; Meta-Agent is the arbitrator. When Meta-Agent says SELL
    // for a trading market but sub-agents say HOLD, the majority vote produces
    // HOLD, which blocks the trade. Meta-Agent's per-symbol decision must
    // override for trading markets.
    const tradingMarketSymbols = new Set<string>(
      (currentPositions ?? [])
        .filter(p => (p.quantity ?? 0) === 0 || p.isTradingMarket === true)
        .map(p => normalizeSymbol(p.symbol))
    );

    // Extract Meta-Agent's per-symbol decisions for override
    const metaPerSymbol = new Map<string, PerSymbolDecision>();
    const metaThought = thoughts.find(t => t.agentRole === 'meta_agent');
    if (metaThought) {
      const metaMulti = metaThought.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
      if (metaMulti) {
        metaPerSymbol.set(normalizeSymbol(metaMulti.marketTicker.symbol), metaMulti.marketTicker);
        for (const pos of metaMulti.positions) {
          metaPerSymbol.set(normalizeSymbol(pos.symbol), pos);
        }
      }
    }

    const perSymbolConsensus: PerSymbolConsensus[] = [];
    for (const [sym, data] of perSymbolMap) {
      const n = data.actions.length;
      if (n === 0) continue;

      const buyCount = data.actions.filter(a => a === 'buy').length;
      const sellCount = data.actions.filter(a => a === 'sell').length;
      const holdCount = data.actions.filter(a => a === 'hold').length;
      const closeCount = data.actions.filter(a => a === 'close').length;

      // Majority action: close > buy > sell > hold
      const majorityAction: 'buy' | 'sell' | 'hold' | 'close' =
        closeCount > buyCount && closeCount > sellCount && closeCount > holdCount ? 'close'
        : buyCount > sellCount && buyCount > holdCount ? 'buy'
        : sellCount > buyCount && sellCount > holdCount ? 'sell'
        : 'hold';

      // v2.0.125: For trading markets (no open position), Meta-Agent's decision
      // overrides the sub-agent majority. Meta-Agent is the arbitrator — its
      // SELL/BUY for a trading market should execute, not be drowned out by
      // sub-agent HOLDs. Sub-agents are data-gatherers, not decision-makers.
      let finalAction = majorityAction;
      let finalRationale = `Majority: ${majorityAction.toUpperCase()} (${buyCount}B/${sellCount}S/${holdCount}H/${closeCount}C). Avg conf: ${(data.confidences.reduce((s, c) => s + c, 0) / n * 100).toFixed(0)}%`;
      let finalSize = data.sizes.reduce((s, v) => s + v, 0) / n;
      let finalLev = Math.round(data.levers.reduce((s, v) => s + v, 0) / n);
      if (tradingMarketSymbols.has(sym) && metaPerSymbol.has(sym)) {
        const metaDec = metaPerSymbol.get(sym)!;
        if (metaDec.action === 'buy' || metaDec.action === 'sell') {
          finalAction = metaDec.action;
          finalRationale = `Meta-Agent: ${metaDec.action.toUpperCase()} ${sym} (trading market — Meta-Agent authoritative). Sub-agent majority: ${majorityAction.toUpperCase()} (${buyCount}B/${sellCount}S/${holdCount}H). ${metaDec.rationale ?? ''}`;
          finalSize = metaDec.positionSizePct;
          finalLev = metaDec.leverage;
          log.info(`📊 [v2.0.125] Trading market ${sym}: Meta-Agent override ${majorityAction.toUpperCase()} → ${finalAction.toUpperCase()} (sub-agents: ${buyCount}B/${sellCount}S/${holdCount}H)`);
        }
      }

      const avgConfidence = data.confidences.reduce((s, c) => s + c, 0) / n;
      // v2.0.126: When Meta-Agent overrides a trading market's action, use
      // Meta-Agent's confidence instead of the sub-agent average. The sub-agent
      // average (~33%) is always below the conviction gate threshold (~52%),
      // so even when Meta-Agent's SELL override works, the conviction gate
      // blocks the trade because psc.confidence is the average. Meta-Agent's
      // own confidence (typically 35-50%) should be used for trading markets
      // where it made the authoritative call.
      let finalConfidence = avgConfidence;
      if (tradingMarketSymbols.has(sym) && metaPerSymbol.has(sym)) {
        const metaDec = metaPerSymbol.get(sym)!;
        if (metaDec.action === 'buy' || metaDec.action === 'sell') {
          // v2.0.132: Use per-symbol confidence from Meta-Agent's
          // multiSymbolDecision, not the overall metaThought.confidence.
          // Meta-Agent may be 55% confident overall (because other symbols
          // are HOLD) but 60% confident for this specific symbol. The
          // per-symbol confidence is the correct value for the conviction
          // gate — using the overall confidence unfairly lowers it.
          if (metaDec.confidence !== undefined && metaDec.confidence > 0) {
            finalConfidence = metaDec.confidence;
          } else {
            const metaThought = thoughts.find(t => t.agentRole === 'meta_agent');
            if (metaThought) {
              finalConfidence = metaThought.confidence;
            }
          }
        }
      }
      const closeMajority = data.closeFlags.filter(c => c).length > n / 2;
      const avgSl = data.sls.filter(s => s > 0).reduce((s, v) => s + v, 0) / Math.max(1, data.sls.filter(s => s > 0).length);
      const avgTp = data.tps.filter(s => s > 0).reduce((s, v) => s + v, 0) / Math.max(1, data.tps.filter(s => s > 0).length);

      perSymbolConsensus.push({
        symbol: sym,
        action: finalAction,
        confidence: finalConfidence,
        hasPosition: false, // ⚠️ UNRELIABLE — consumers MUST check portfolio directly (see index.ts per-symbol consensus loop)
        closePosition: closeMajority,
        suggestedStopLoss: avgSl > 0 ? avgSl : undefined,
        suggestedTakeProfit: avgTp > 0 ? avgTp : undefined,
        positionSizePct: finalSize,
        leverage: finalLev,
        rationale: finalRationale,
        // v2.0.80: Use the first (Meta-Agent's) thesis if available
        entryThesis: data.theses.length > 0 ? data.theses[0] : undefined,
        // v2.0.81: Use the first (Meta-Agent's) holdReason if available
        holdReason: data.holdReasons.length > 0 ? data.holdReasons[0] : undefined,
      });
    }

    // Aggregate decisions from thoughts (legacy single-decision path)
    const decisions = thoughts
      .map((t) => ({
        action: ((t.metadata?.['decision'] as TradingDecision)?.action ?? 'hold') as 'buy' | 'sell' | 'hold',
        agentId: t.agentId,
        agentRole: t.agentRole,
        confidence: t.confidence,
      }));

    // Default to HOLD if uncertain
    const buyCount = decisions.filter((d) => d.action === 'buy').length;
    const sellCount = decisions.filter((d) => d.action === 'sell').length;
    const holdCount = decisions.filter((d) => d.action === 'hold').length;

    const majorityAction: 'buy' | 'sell' | 'hold' =
      buyCount > sellCount && buyCount > holdCount ? 'buy'
        : sellCount > buyCount && sellCount > holdCount ? 'sell'
        : 'hold';

    const avgConfidence = decisions.reduce((s, d) => s + d.confidence, 0) / decisions.length;

    // v2.0.130: Meta-Agent override for the active symbol (marketTicker).
    // The finalDecision uses the legacy majority vote, which drowns out
    // Meta-Agent's SELL when sub-agents say HOLD. But Meta-Agent is the
    // arbitrator — when it says BUY/SELL for the marketTicker (active symbol
    // with no open position), its decision should override the majority,
    // same as the v2.0.125 override for trading markets.
    let finalDecisionAction = majorityAction;
    let finalDecisionSize = majorityAction === 'hold' ? 0 : 0.10;
    let finalDecisionLev = 10;
    let finalDecisionRationale = `Majority decision: ${majorityAction.toUpperCase()} (${buyCount}B/${sellCount}S/${holdCount}H). Avg confidence: ${avgConfidence.toFixed(2)}. Rounds: ${rounds.length}.`;
    let finalDecisionThesis: string | undefined = undefined;
    let metaOverridden = false;
    // v2.0.136: Decision symbol = the active market ticker symbol, NOT a
    // hardcoded 'BTCUSDT'. Previously this was always 'BTCUSDT', which:
    //   (a) broke execution for any non-BTC active symbol, AND
    //   (b) broke the Phase 4.8 thesis gate's perSymbolConsensus fallback
    //       lookup (decision.symbol 'btcusdt' never matched psc.symbol 'btc').
    // Derive from the Meta-Agent's marketTicker (authoritative), with a
    // fallback to the first perSymbolConsensus symbol, then 'BTCUSDT'.
    let finalDecisionSymbol = 'BTCUSDT';
    // v2.0.139: Capture the per-symbol marketTicker conviction so the
    // conviction gate sees the SAME value the Meta-Agent stated for THIS
    // symbol — not the top-level metaThought.confidence (which is a blend
    // across all symbols including HOLDs and unfairly lowers the active
    // symbol's gate confidence). This mirrors the v2.0.132 fix already
    // applied to the trading-market perSymbolConsensus path (L2078).
    let metaTickerConfidence: number | undefined;
    const metaThoughtForDecision = thoughts.find(t => t.agentRole === 'meta_agent');
    if (metaThoughtForDecision) {
      const metaMs = metaThoughtForDecision.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
      if (metaMs) {
        const mtSym = normalizeSymbol(metaMs.marketTicker.symbol);
        if (metaMs.marketTicker.symbol) finalDecisionSymbol = metaMs.marketTicker.symbol;
        // Check if the marketTicker symbol has no open position (trading market
        // or active symbol without position). If so, Meta-Agent's decision is
        // authoritative.
        const hasOpenPos = (currentPositions ?? []).some(p =>
          normalizeSymbol(p.symbol) === mtSym && (p.quantity ?? 0) > 0
        );
        if (!hasOpenPos && (metaMs.marketTicker.action === 'buy' || metaMs.marketTicker.action === 'sell')) {
          finalDecisionAction = metaMs.marketTicker.action;
          finalDecisionSize = metaMs.marketTicker.positionSizePct;
          finalDecisionLev = metaMs.marketTicker.leverage;
          finalDecisionThesis = metaMs.marketTicker.entryThesis;
          finalDecisionRationale = `Meta-Agent: ${metaMs.marketTicker.action.toUpperCase()} ${metaMs.marketTicker.symbol} (marketTicker — Meta-Agent authoritative). Sub-agent majority: ${majorityAction.toUpperCase()} (${buyCount}B/${sellCount}S/${holdCount}H). ${metaMs.marketTicker.rationale ?? ''}`;
          metaOverridden = true;
          metaTickerConfidence = metaMs.marketTicker.confidence;
          log.info(`📊 [v2.0.130] Active symbol ${metaMs.marketTicker.symbol}: Meta-Agent override ${majorityAction.toUpperCase()} → ${finalDecisionAction.toUpperCase()} (sub-agents: ${buyCount}B/${sellCount}S/${holdCount}H)`);
        }
      }
    }
    // Fallback: if Meta-Agent had no marketTicker symbol, use the first
    // perSymbolConsensus symbol (the active market ticker is always first).
    if (finalDecisionSymbol === 'BTCUSDT' && perSymbolConsensus.length > 0) {
      finalDecisionSymbol = perSymbolConsensus[0]!.symbol;
    }

    return {
      decision: normalizeDecision({
        action: finalDecisionAction,
        symbol: finalDecisionSymbol,
        positionSizePct: finalDecisionSize,
        leverage: finalDecisionLev,
        rationale: finalDecisionRationale,
        urgency: 'soon',
        ...(finalDecisionThesis ? { entryThesis: finalDecisionThesis } : {}),
      }),
      perSymbolConsensus,
      // v2.0.139: Use per-symbol marketTicker conviction (not top-level
      // metaThought.confidence) when Meta-Agent overrides the active symbol —
      // same fix as v2.0.132 for trading markets. The Meta-Agent may be 55%
      // confident overall (other symbols are HOLD) but 65% for the active
      // symbol. The conviction gate must see the per-symbol value.
      confidence: metaOverridden ? (metaTickerConfidence ?? metaThoughtForDecision?.confidence ?? avgConfidence) : avgConfidence,
      reasoning: this.buildReasoning(thoughts, rounds),
      votes: existingVotes ?? [],
      roundsUsed: rounds.length,
      deadlockResolved: deadlock,
      metaAgentOverridden: metaOverridden,
      timestamp: Date.now(),
    };
  }

  private async metaAgentArbitration(
    thoughts: AgentThought[],
    rounds: DebateRound[],
    votes: Vote[] | null
  ): Promise<ConsensusResult> {
    // Meta-agent makes final decision
    log.info('Meta-Agent performing final arbitration...');

    const context = this.buildDebateContext(thoughts);
    const metaDecision = await this.metaAgent.think(
      `Meta-Agent Arbitration Required.\n\n${context}`,
      'Final arbitration context.'
    );

    const decision = normalizeDecision((metaDecision.metadata?.['decision'] as TradingDecision | undefined) ?? undefined);

    // Extract per-symbol consensus from meta-agent's multiSymbolDecision
    const metaMultiDec = metaDecision.metadata?.['multiSymbolDecision'] as MultiSymbolDecision | undefined;
    const perSymbolConsensus: PerSymbolConsensus[] = [];
    if (metaMultiDec) {
      const addSym = (psd: import('../types/index.ts').PerSymbolDecision, hasPos: boolean) => {
        perSymbolConsensus.push({
          symbol: normalizeSymbol(psd.symbol),
          action: psd.action,
          confidence: metaDecision.confidence,
          hasPosition: hasPos,
          closePosition: psd.closePosition,
          suggestedStopLoss: psd.suggestedStopLoss,
          suggestedTakeProfit: psd.suggestedTakeProfit,
          positionSizePct: psd.positionSizePct,
          leverage: psd.leverage,
          rationale: psd.rationale,
          // v2.0.80: Forward entryThesis from Meta-Agent's per-symbol decision
          entryThesis: psd.entryThesis,
          // v2.0.81: Forward holdReason from Meta-Agent's per-symbol decision
          holdReason: psd.holdReason,
        });
      };
      addSym(metaMultiDec.marketTicker, false);
      for (const pos of metaMultiDec.positions) {
        addSym(pos, true);
      }
    }

    const result: ConsensusResult = {
      decision,
      perSymbolConsensus,
      confidence: metaDecision.confidence,
      reasoning: `Meta-Agent Final Arbitration:\n${metaDecision.thought}\n\nDebate Summary: ${rounds.length} rounds conducted.`,
      votes: votes ?? [],
      roundsUsed: rounds.length,
      deadlockResolved: true,
      metaAgentOverridden: true,
      timestamp: Date.now(),
    };

    log.info(`Meta-Agent arbitration complete: ${decision.action.toUpperCase()} (conf: ${metaDecision.confidence.toFixed(2)})`);
    return result;
  }

  private async riskAuditorAudit(
    decision: TradingDecision
  ): Promise<{ veto: boolean; reason: string; adjustedPrice?: number; adjustedStopLossPct?: number; adjustedTakeProfitPct?: number; adjustedPositionSizePct?: number }> {
    try {
      // Build recent-trade-pattern context for choppy-market detection.
      // This lets the Risk Auditor see if recent buy/sell churn is losing
      // money and adjust its veto / TP-SL-size guidance accordingly.
      const analysis = this.tradeHistory
        ? this.tradeHistory.getRecentTradeAnalysis(10)
        : null;
      const tradePattern = analysis
        ? analysis.summary
        : '=== RECENT TRADE PATTERN (last 10) ===\n(no trade history available)';

      // v2.0.27: Build per-trade loss review context for the LLM.
      // When cooldown is active, the LLM needs to see WHICH trades lost
      // money and WHY — not just aggregate stats. This lets it make a
      // meaningful resumeTrading decision.
      const cooldownActive = this.isCooldownActive(this.totalCycles);
      const lossReview = (cooldownActive && this.tradeHistory)
        ? this.tradeHistory.getLossReviewContext(5)
        : '';

      // Independent risk audit via LLM
      const provider = getActiveProvider();
      const cooldownPromptSection = cooldownActive
        ? `${lossReview}\n\n⚠️ LOSS COOLDOWN ACTIVE: A recent trade lost money. You are reviewing during the cooldown cycle.\n` +
          `Analyze EACH loss above: Was the direction wrong? Was the entry timing bad? Was the market choppy? Were the agent signals conflicting?\n` +
          `Then decide:\n` +
          `  - If market conditions have changed and it's safe to resume → set "resumeTrading": true\n` +
          `  - If the market is still unfavorable → set "resumeTrading": false (extend cooldown)\n` +
          `Respond with valid JSON only:\n` +
          `{"veto":false,"reason":"your loss analysis","resumeTrading":false,"adjustedPositionSizePct":null,"adjustedStopLossPct":null,"adjustedTakeProfitPct":null}`
        : `Respond with valid JSON only:\n{"veto":false,"reason":"","adjustedPositionSizePct":null,"adjustedStopLossPct":null,"adjustedTakeProfitPct":null}`;

      const response = await provider.chat({
        messages: [
          {
            role: 'system',
            content: this.riskAuditor.getSystemPrompt(),
          },
          {
            role: 'user',
            content: `Audit this trading decision:\n${JSON.stringify(decision, null, 2)}\n\n${tradePattern}\n\n${cooldownPromptSection}\n\nIf the recent trade pattern shows a choppy/whipsaw market (frequent reversals + net losses), strongly consider vetoing new entries OR narrowing TP/SL to the range edges + reducing position size (choppy markets have low win rates — smaller size limits per-trade loss). If profitable/trending, you may widen TP to let profits run. Set adjusted* fields only if you want to override the decision.`,
          },
        ],
        temperature: 0.05,
        model: this.riskAuditor.resolveModel(),
        // Risk audit is a focused veto check — cap at 30s so a stalled
        // provider cannot block the HACP cycle past its deadline.
        timeoutMs: 30_000,
      });

      const parsed = JSON.parse(response.content) as {
        veto: boolean;
        reason: string;
        resumeTrading?: boolean;
        adjustedPositionSizePct?: number | null;
        adjustedStopLossPct?: number | null;
        adjustedTakeProfitPct?: number | null;
      };

      // v2.0.26: If the LLM says "resumeTrading": true during cooldown,
      // lift the cooldown so the next cycle can trade normally.
      if (parsed.resumeTrading === true && this.isCooldownActive(this.totalCycles)) {
        this.resumeFromCooldown();
      }

      // v2.0.41: Removed MAX_POSITION_PCT veto — Market Agent controls size.
      // Phase 4.5 will override positionSizePct to Market Agent's value.
      // Risk Auditor can still reduce size (choppy 50% cut, loss streak reduction).

      // ── Hardcoded choppy-market 50% position size reduction ──
      // When the recent trade pattern is choppy (frequent reversals + net
      // losses), deterministically cut the position size to 50% of the
      // decision's size. This is a fixed rule (not LLM-discretionary) so the
      // reduction is guaranteed whenever choppy conditions are detected.
      // The paper engine floors the final notional to HL's $10 minimum, so
      // this never produces an untradeable tiny order.
      let adjustedPositionSizePct = parsed.adjustedPositionSizePct ?? undefined;
      let reason = parsed.reason ?? 'No concerns.';
      if (analysis?.isChoppy && decision.action !== 'hold' && decision.positionSizePct > 0) {
        const reduced = decision.positionSizePct * 0.5;
        // Only apply the hardcoded cut if the LLM didn't already reduce
        // further (avoid overriding a more conservative LLM suggestion).
        if (adjustedPositionSizePct === undefined || adjustedPositionSizePct > reduced) {
          adjustedPositionSizePct = reduced;
          reason = `Choppy market detected (reversalRate=${(analysis.reversalRate * 100).toFixed(0)}%, netPnl=${(analysis.netPnlPct * 100).toFixed(2)}%) — hardcoded 50% position size reduction. ${reason}`;
          log.info(`🔧 Choppy-market hardcoded size cut: ${(decision.positionSizePct * 100).toFixed(1)}% → ${(reduced * 100).toFixed(1)}%`);
        }
      }

      // ── v2.0.26: Loss cooldown — pause + LLM review ──
      // After ANY loss (streak ≥1), the system enters a cooldown: the next
      // cycle's new entries are blocked, giving the Risk Auditor LLM time to
      // review WHY the loss happened and decide whether to resume trading
      // or extend the cooldown. This replaces the old hardcoded ≥3 VETO with
      // a smarter "pause one cycle, let the LLM review" approach.
      //
      // The cooldown is tracked via cooldownUntilCycle (set by
      // onPositionClosedLearning when a loss is detected). During cooldown,
      // new entries are VETO'd but existing positions are still managed
      // (SL/TP adjustment allowed). The LLM's review verdict
      // (cooldownResumeAllowed) determines whether trading resumes after the
      // cooldown cycle.
      if (
        this.totalCycles < this.cooldownUntilCycle &&
        decision.action !== 'hold' &&
        decision.positionSizePct > 0
      ) {
        const remaining = this.cooldownUntilCycle - this.totalCycles;
        // v2.0.82: Cooldown veto is now ADVISORY ONLY — logged but non-blocking.
        // The Meta-Agent + Skeptics thesis system decides whether to trade.
        log.warn(`⚠️ Loss cooldown active (${remaining} cycle(s) remaining) — ADVISORY only, non-blocking. Risk Auditor reviewing.`);
        return {
          veto: true,
          reason: `Loss cooldown advisory: a recent trade lost money. Pausing recommended for ${remaining} cycle(s). Non-blocking — Meta-Agent thesis system decides.`,
          adjustedStopLossPct: parsed.adjustedStopLossPct ?? undefined,
          adjustedTakeProfitPct: parsed.adjustedTakeProfitPct ?? undefined,
          adjustedPositionSizePct: undefined,
        };
      }

      // ── v2.0.26: Loss-streak graduated size reduction ──
      // Even outside cooldown, reduce size proportionally to the loss
      // streak — the more consecutive losses, the smaller the position.
      // This is NOT a VETO; it lets the LLM's own verdict stand while
      // adding a deterministic safety layer.
      if (
        analysis &&
        analysis.currentLossStreak >= 1 &&
        decision.action !== 'hold' &&
        decision.positionSizePct > 0
      ) {
        // streak 1 → 75%, 2 → 50%, 3+ → 25%
        const sizeMultiplier = Math.max(0.25, 1 - analysis.currentLossStreak * 0.25);
        const reduced = decision.positionSizePct * sizeMultiplier;
        if (adjustedPositionSizePct === undefined || adjustedPositionSizePct > reduced) {
          adjustedPositionSizePct = reduced;
          reason = `Loss streak: ${analysis.currentLossStreak} consecutive losses — size reduced to ${(sizeMultiplier * 100).toFixed(0)}%. ${reason}`;
          log.info(`🔧 Loss-streak size reduction: ${(decision.positionSizePct * 100).toFixed(1)}% → ${(reduced * 100).toFixed(1)}% (streak=${analysis.currentLossStreak})`);
        }
      }

      return {
        veto: parsed.veto ?? false,
        reason,
        adjustedStopLossPct: parsed.adjustedStopLossPct ?? undefined,
        adjustedTakeProfitPct: parsed.adjustedTakeProfitPct ?? undefined,
        adjustedPositionSizePct,
      };
    } catch {
      // On error, be conservative — allow trade (Market Agent controls size)
      return {
        veto: false,
        reason: 'Risk audit LLM unavailable. Allowing trade — Market Agent controls position size.',
      };
    }
  }

  private buildReasoning(
    thoughts: AgentThought[],
    rounds: DebateRound[]
  ): string {
    let reasoning = `HACP Decision Cycle\n`;
    reasoning += `Agents: ${thoughts.length}\n`;
    reasoning += `Debate Rounds: ${rounds.length}\n\n`;

    reasoning += '=== Agent Positions ===\n';
    for (const t of thoughts) {
      const d = (t.metadata?.['decision'] as TradingDecision) ?? { action: 'hold', symbol: 'UNKNOWN' };
      reasoning += `[${t.agentRole}] ${d.action.toUpperCase()} (${(t.confidence * 100).toFixed(0)}%)\n`;
      reasoning += `  ${t.thought.slice(0, 100)}...\n`;
    }

    return reasoning;
  }
}