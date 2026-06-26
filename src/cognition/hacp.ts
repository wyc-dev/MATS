// ─── Hyper-Accelerated Cognition Protocol (HACP) ───
// The core intelligence engine — parallel thinking, structured debate, fast consensus

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { getActiveProvider } from '../llm/index.ts';
import { config } from '../config/index.ts';
import { parseA2ASignal, formatA2ASignal } from './a2a-utils.ts';
import { normalizeDecision, MAX_POSITION_PCT } from '../trading/decision-utils.ts';
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
  PerSymbolConsensus,
  Vote,
  CycleProgress,
  AgentProgress,
  AgentRole,
  PositionAdjustment,
  PositionContext,
  CycleSummary,
} from '../types/index.ts';
import type { BaseAgent } from '../agents/base-agent.ts';
import type { IndependentRiskAuditor, SkepticsAgent, SkepticsReview } from '../agents/agents.ts';
import { buildConvergenceAuditContext } from '../evolution/cycle-summary.ts';

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

  /** Inject the agent evolution engine for regime-aware dynamic weights. */
  setAgentEvolution(ae: AgentEvolutionEngine): void {
    this.agentEvolution = ae;
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
   * Get current dynamic consensus threshold value
   */
  getCurrentThreshold(): number {
    return this.consensusThreshold;
  }

  /**
   * Dynamically adjust consensus threshold based on market conditions:
   * - No trade for a while → lower threshold to encourage action
   * - Consecutive losses → raise threshold to be more conservative
   * - High vol regime → lower threshold (opportunity)
   * - Chaotic regime → raise threshold (caution)
   *
   * Called externally from MATSSystem.runDecisionCycle() after each cycle,
   * where we have full context (regime, trade outcome).
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

    const newThreshold = Math.max(0.40, Math.min(0.85, initial + adj));
    if (Math.abs(newThreshold - this.consensusThreshold) > 0.005) {
      log.info(`Consensus threshold: ${(this.consensusThreshold * 100).toFixed(0)}% → ${(newThreshold * 100).toFixed(0)}% (idle=${this.cyclesWithoutTrade}, lossStreak=${this.consecutiveLosses}, regime=${currentRegime ?? '?'})`);
    }
    this.consensusThreshold = newThreshold;
  }

  async executeDecisionCycle(
    marketStateDesc: string,
    portfolioDesc: string,
    /** Current open positions for TP/SL adjustment */
    currentPositions?: Array<{ id: string; symbol: string; side: string; entryPrice: number; currentPrice: number; stopLoss?: number; takeProfit?: number; leverage?: number; quantity?: number; exchange?: string }>,
    /** Previous cycle summary chain — injected into Meta-Agent context for EM continuity */
    emContext?: string,
    /** Cycle summaries for Skeptics convergence audit */
    recentSummaries?: CycleSummary[],
    /** Market Agent constraints: position size fraction and leverage */
    marketAgentConstraints?: { positionSizePct: number; leverage: number },
    /** v2.0.26: current cycle number — used by the loss cooldown logic */
    cycleNumber?: number,
  ): Promise<HACPResult> {
    const startTime = performance.now();
    const allThoughts: AgentThought[] = [];
    const debateRounds: DebateRound[] = [];
    const deadline = Date.now() + this.totalTimeoutMs;

    // v2.0.26: track the current cycle number for cooldown logic
    if (cycleNumber !== undefined) {
      this.totalCycles = cycleNumber;
    }

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
      this.agentEvolution.updateWeights(this.currentRegime);
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
    const phase1DeadlineMs = 60_000;

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

      // Build skeptics own thought summary
      const approvedCount = skepticsReviews.filter(r => r.approved).length;
      const modifiedCount = skepticsReviews.filter(r => !r.approved).length;
      const skepticsThoughtText = skepticsReviews.length > 0
        ? `Reviewed ${skepticsReviews.length} agents: ${approvedCount} approved, ${modifiedCount} modified. ${modifiedCount > 0 ? skepticsReviews.filter(r => !r.approved).map(r => `[${r.agentRole}] ${r.skepticismRationale.slice(0, 120)}`).join(' | ') : 'No logical inconsistencies detected.'}`
        : 'Skeptics review completed — no agents to review.';

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

    // Build enhanced market context that includes skeptics findings + EM chain
    const enhancedMetaContext = `${marketStateDesc}${skepticsContextStr}${emContext ? `\n${emContext}` : ''}`;
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

    // Check if we have enough information for immediate consensus
    const allHold = allThoughts.every((t) => {
      const decision = t.metadata?.['decision'] as TradingDecision | undefined;
      return decision?.action === 'hold';
    });

    const highConviction = allThoughts.filter((t) => t.confidence > 0.7).length;
    const strongDisagreement = allThoughts.some((t) => t.confidence < 0.2);

    // Skip debate if all agents agree on HOLD with high conviction
    // Now includes all 5 agents (3 sub-agents + meta-agent + risk auditor)
    if (allHold && highConviction >= allThoughts.length - 1) {
      log.info('Skipping debate: unanimous HOLD with high conviction.');
      const consensus = this.buildConsensus(allThoughts, [], true, false);
      const adjustments = await this.adjustPositions(constrainedMarketDesc, currentPositions);
      return {
        consensus,
        allThoughts,
        debateRounds: [],
        durationMs: Math.round(performance.now() - startTime),
        positionAdjustments: adjustments,
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
          finalConsensus = this.buildConsensus(allThoughts, debateRounds, true, false, voteResults);
          break;
        }
      }

      // Check for consensus after each round
      if (round >= 2) {
        const voteResults = await this.runConsensusVote(allThoughts);
        const weightedScore = this.calcWeightedConsensus(voteResults);

        if (weightedScore >= this.consensusThreshold) {
          log.info(`Consensus reached at round ${round} (weighted: ${weightedScore.toFixed(3)})`);
          consensusReached = true;
          finalConsensus = this.buildConsensus(
            allThoughts,
            debateRounds,
            true,
            false,
            voteResults
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
        finalConsensus = this.buildConsensus(allThoughts, debateRounds, true, false);
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
      log.warn('🚨 Independent Risk Auditor VETOED the decision!');
      finalConsensus.decision = {
        action: 'hold',
        symbol: finalConsensus.decision.symbol,
        positionSizePct: 0,
        leverage: 1,
        rationale: `Risk Auditor VETO: ${riskAudit.reason}. Capital preservation override.`,
        urgency: 'immediate',
      };
      finalConsensus.metaAgentOverridden = true;
      finalConsensus.confidence = 0.0;
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
        // Clamp to the hard max — Risk Auditor can reduce but not exceed the cap.
        finalConsensus.decision.positionSizePct = Math.min(
          Math.max(0, riskAudit.adjustedPositionSizePct),
          MAX_POSITION_PCT,
        );
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

      // Override position size to Market Agent's target (not just clamp)
      if (finalConsensus.decision.positionSizePct !== targetSize) {
        finalConsensus.decision.positionSizePct = targetSize;
        log.warn(`Market Agent constraint: position size overridden ${(origSize * 100).toFixed(1)}% → ${(targetSize * 100).toFixed(1)}%`);
      }
      // Override leverage to Market Agent's target
      if ((finalConsensus.decision.leverage ?? 1) !== targetLev) {
        finalConsensus.decision.leverage = targetLev;
        log.warn(`Market Agent constraint: leverage overridden ${origLev}x → ${targetLev}x`);
      }
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
    };
  }

  /**
   * Meta-agent reviews open positions and suggests TP/SL adjustments
   * based on current market conditions.
   * Only adjusts positions whose symbol matches the primary trading symbol
   * (avoids cross-symbol mispricing, e.g. using xyz:CL context for BTC).
   */
  private async adjustPositions(
    marketStateDesc: string,
    positions?: Array<{ id: string; symbol: string; side: string; entryPrice: number; currentPrice: number; stopLoss?: number; takeProfit?: number; leverage?: number }>
  ): Promise<PositionAdjustment[]> {
    if (!positions || positions.length === 0) return [];

    const adjustments: PositionAdjustment[] = [];

    // Extract the primary trading symbol from the market description
    const primaryMatch = marketStateDesc.match(/Selected Symbol:\s*(\S+)/i)
      ?? marketStateDesc.match(/Symbol:\s*(\S+)/i);
    // v2.0.32: Case-insensitive comparison for colon-prefixed symbols
    const primarySymbol = primaryMatch?.[1];

    for (const pos of positions) {
      // Only adjust positions that match the primary trading symbol
      // to avoid applying the wrong market context to a different instrument
      if (primarySymbol && pos.symbol.toLowerCase() !== primarySymbol.toLowerCase()) {
        log.debug(`Skipping adjustment for ${pos.symbol} — not the primary symbol ${primarySymbol}`);
        continue;
      }
      try {
        const lev = pos.leverage ?? 1;
        const isLong = pos.side === 'buy';
        const unrealizedPnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * (isLong ? 1 : -1);

        // Inject recent trade pattern so Meta-Agent can regime-aware adjust
        // TP/SL (choppy → narrow to range edges; trending → widen TP to let
        // profits run). Same analysis the Risk Auditor uses.
        const tradePattern = this.tradeHistory
          ? this.tradeHistory.getRecentTradeAnalysis(10).summary
          : '=== RECENT TRADE PATTERN (last 10) ===\n(no trade history available)';

        const provider = getActiveProvider();
        const response = await provider.chat({
          messages: [
            {
              role: 'system',
              content: `You are the Meta-Agent adjusting position parameters.

Current market:
${marketStateDesc}

${tradePattern}

Position: ${pos.side.toUpperCase()} ${pos.symbol}
Entry: $${pos.entryPrice.toFixed(2)}
Current: $${pos.currentPrice.toFixed(2)}
Leverage: ${lev}x
Current SL: ${pos.stopLoss ? `$${pos.stopLoss.toFixed(2)}` : 'NONE'}
Current TP: ${pos.takeProfit ? `$${pos.takeProfit.toFixed(2)}` : 'NONE'}
Unrealized PnL: ${(unrealizedPnlPct * 100).toFixed(2)}%

The market context above contains "=== S/R Zones ===" with key Support (Demand) and Resistance (Supply) levels from historical candles.
USE THESE S/R LEVELS to set TP and SL — they are more reliable than arbitrary percentages.

The "=== RECENT TRADE PATTERN (last 10) ===" section shows whether the market is currently choppy/whipsaw or trending.
ADJUST TP/SL BASED ON THE REGIME:

- ⚠️ CHOPPY/WHIPSAW MARKET (frequent reversals + net losses): NARROW TP to the opposite range edge
  (mean-reversion target — choppy markets do not travel far, so a wide TP will never hit). NARROW SL
  to just outside the recent range (if the range breaks, the regime has changed — stop out immediately).
  Do NOT widen SL — a wider SL in a choppy market just means a bigger loss when the range breaks.
- ✅ TRENDING MARKET (recent trades profitable, low reversal rate): WIDEN TP to let profits run.
  Use a wider ATR-based SL to avoid premature stops. Trail SL in the profit direction only.

CRITICAL RULES — FOLLOW EXACTLY:

1. SL for LONG (buy): can ONLY move UP (increase). NEVER move SL down.
   SL for SHORT (sell): can ONLY move DOWN (decrease). NEVER move SL up.
   If price moved in our favor, trail SL closer to lock profit.
   If price moved against us, LEAVE SL UNCHANGED — do not widen.

2. TP: set TP at the nearest S/R level on the profit side.
   For LONG: TP = nearest Resistance (Supply) level above current price.
   For SHORT: TP = nearest Support (Demand) level below current price.
   If no S/R level is available, use 2x SL distance as fallback.
   If unrealized PnL is POSITIVE, tighten TP toward current price to lock profit.
   TP must always be on the PROFIT side of entry (above entry for long, below for short).

3. SL: set SL just BEYOND the nearest S/R level on the loss side.
   For LONG: SL just below nearest Support (Demand) below current price.
   For SHORT: SL just above nearest Resistance (Supply) above current price.
   If no S/R level is available, use 1-2% from current price as fallback.
   NEVER set SL further from current price than it already is.
   NEVER set TP further from current price than it already is.

4. SL distance from current price: 1-2% max (with ${lev}x leverage = ${lev * 1}-${lev * 2}% loss).
   TP distance from current price: at least 2x SL distance.

Output ONLY valid JSON:
{"adjust":true,"newStopLoss":66000,"newTakeProfit":64000,"rationale":"Tightening TP as price approaches target, trailing SL to lock in profit."}`,
            },
            {
              role: 'user',
              content: 'Review this position and suggest TP/SL adjustments following the rules exactly, taking the recent trade pattern into account.',
            },
          ],
          temperature: 0.2,
          model: this.metaAgent.resolveModel(),
          // Position adjustment is a focused single-position call — cap at 30s
          // so a stalled provider cannot block the HACP cycle past its deadline.
          timeoutMs: 30_000,
        });

        const jsonStr = (() => {
          const trimmed = response.content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
          const start = trimmed.indexOf('{');
          const end = trimmed.lastIndexOf('}');
          if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
          return trimmed;
        })();
        const parsed = JSON.parse(jsonStr) as {
          adjust: boolean;
          newStopLoss?: number;
          newTakeProfit?: number;
          rationale: string;
        };

        if (parsed.adjust && (parsed.newStopLoss || parsed.newTakeProfit)) {
          // ── Hard safety layer: enforce SL direction rules ──
          let finalSL = parsed.newStopLoss;
          let finalTP = parsed.newTakeProfit;

          // ── CRITICAL: Validate TP direction ──
          // TP for LONG must be ABOVE entry price (profit side)
          // TP for SHORT must be BELOW entry price (profit side)
          if (finalTP !== undefined) {
            const tpValid = isLong ? finalTP > pos.entryPrice : finalTP < pos.entryPrice;
            if (!tpValid) {
              log.warn(`🚫 TP safety: ${isLong ? 'LONG' : 'SHORT'} TP $${finalTP} on wrong side of entry $${pos.entryPrice}. Rejecting.`);
              finalTP = undefined;
            }
          }

          // ── CRITICAL: Validate SL direction ──
          // SL for LONG must be BELOW entry price (loss side)
          // SL for SHORT must be ABOVE entry price (loss side)
          if (finalSL !== undefined) {
            const slValid = isLong ? finalSL < pos.entryPrice : finalSL > pos.entryPrice;
            if (!slValid) {
              log.warn(`🚫 SL safety: ${isLong ? 'LONG' : 'SHORT'} SL $${finalSL} on wrong side of entry $${pos.entryPrice}. Rejecting.`);
              finalSL = undefined;
            }
          }

          // SL for long: can only go UP (increase). Clamp to [oldSL or entry, +inf)
          if (isLong && finalSL !== undefined) {
            const oldSL = pos.stopLoss ?? (pos.entryPrice * 0.95);
            const minSL = Math.max(oldSL, pos.entryPrice * 0.95); // never below 95% of entry
            if (finalSL < minSL) finalSL = minSL; // enforce no widening
            // Also ensure SL is not above current price (would be pointless)
            if (finalSL > pos.currentPrice) finalSL = pos.currentPrice * 0.98;
          }

          // SL for short: can only go DOWN (decrease). Clamp to (-inf, oldSL or entry]
          if (!isLong && finalSL !== undefined) {
            const oldSL = pos.stopLoss ?? (pos.entryPrice * 1.05);
            const maxSL = Math.min(oldSL, pos.entryPrice * 1.05); // never above 105% of entry
            if (finalSL > maxSL) finalSL = maxSL; // enforce no widening
            if (finalSL < pos.currentPrice) finalSL = pos.currentPrice * 1.02;
          }

          // TP: if positive PnL, tighten toward price. Never widen.
          // Also validate TP is on the correct side of entry (defence-in-depth).
          if (finalTP !== undefined) {
            if (isLong) {
              // TP must be above entry for longs
              if (finalTP <= pos.entryPrice) {
                log.warn(`🚫 TP safety (2nd layer): LONG TP $${finalTP} <= entry $${pos.entryPrice}. Rejecting.`);
                finalTP = undefined;
              } else if (unrealizedPnlPct > 0) {
                const oldTP = pos.takeProfit;
                if (oldTP !== undefined && finalTP > oldTP) finalTP = oldTP; // never widen
                if (finalTP < pos.currentPrice * 1.005) finalTP = pos.currentPrice * 1.005; // min 0.5% above
              }
            } else {
              // TP must be below entry for shorts
              if (finalTP >= pos.entryPrice) {
                log.warn(`🚫 TP safety (2nd layer): SHORT TP $${finalTP} >= entry $${pos.entryPrice}. Rejecting.`);
                finalTP = undefined;
              } else if (unrealizedPnlPct > 0) {
                const oldTP = pos.takeProfit;
                if (oldTP !== undefined && finalTP < oldTP) finalTP = oldTP; // never widen
                if (finalTP > pos.currentPrice * 0.995) finalTP = pos.currentPrice * 0.995; // max 0.5% below
              }
            }
          }

          // v2.0.36: Minimum SL/TP gap constraint — if the gap between SL
          // and TP is less than 1% of current price, reject the adjustment.
          // Over-narrowing causes noise stop-outs + premature TP hits,
          // cutting profits short. The LLM tends to aggressively tighten
          // both SL and TP as price approaches target, leaving almost no
          // room for normal market volatility.
          if (finalSL !== undefined && finalTP !== undefined) {
            const sltpGap = Math.abs(finalTP - finalSL);
            const gapPct = sltpGap / pos.currentPrice;
            if (gapPct < 0.01) {
              log.warn(`🚫 SL/TP gap safety: ${pos.symbol} gap=$${sltpGap.toFixed(2)} (${(gapPct * 100).toFixed(2)}%) < 1% minimum — rejecting adjustment to prevent noise stop-out`);
              finalSL = undefined;
              finalTP = undefined;
            }
          } else if (finalSL !== undefined && pos.takeProfit !== undefined) {
            // Only SL is being adjusted — check against existing TP
            const sltpGap = Math.abs(pos.takeProfit - finalSL);
            const gapPct = sltpGap / pos.currentPrice;
            if (gapPct < 0.01) {
              log.warn(`🚫 SL/TP gap safety: ${pos.symbol} SL=$${finalSL.toFixed(2)} too close to existing TP=$${pos.takeProfit.toFixed(2)} (gap ${(gapPct * 100).toFixed(2)}% < 1%) — rejecting SL adjustment`);
              finalSL = undefined;
            }
          } else if (finalTP !== undefined && pos.stopLoss !== undefined) {
            // Only TP is being adjusted — check against existing SL
            const sltpGap = Math.abs(finalTP - pos.stopLoss);
            const gapPct = sltpGap / pos.currentPrice;
            if (gapPct < 0.01) {
              log.warn(`🚫 SL/TP gap safety: ${pos.symbol} TP=$${finalTP.toFixed(2)} too close to existing SL=$${pos.stopLoss.toFixed(2)} (gap ${(gapPct * 100).toFixed(2)}% < 1%) — rejecting TP adjustment`);
              finalTP = undefined;
            }
          }

          // Only push if at least one value changed (both could be undefined after validation)
          if (finalSL !== undefined || finalTP !== undefined) {
            adjustments.push({
              positionId: pos.id,
              symbol: pos.symbol,
              newStopLoss: finalSL as number | undefined,
              newTakeProfit: finalTP as number | undefined,
              rationale: parsed.rationale,
              confidence: 0.7,
            });
            log.info(`📐 Position ${pos.id.slice(0, 8)} adjusted: SL=${finalSL?.toFixed(2) ?? 'unchanged'} TP=${finalTP?.toFixed(2) ?? 'unchanged'}`);
          } else {
            log.warn(`📐 Position ${pos.id.slice(0, 8)}: both SL and TP rejected by safety layer — no adjustment applied.`);
          }
        }
      } catch (err) {
        log.warn(`Position adjustment failed for ${pos.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return adjustments;
  }

  private buildDebateContext(thoughts: AgentThought[]): string {
    let ctx = '=== Agent Thoughts Summary ===\n';
    for (const t of thoughts) {
      const decision = (t.metadata?.['decision'] as TradingDecision) ?? { action: 'hold', symbol: 'UNKNOWN' };
      ctx += `\n[${t.agentRole}] (conf: ${t.confidence.toFixed(2)}, decision: ${decision.action.toUpperCase()}, size: ${((decision.positionSizePct ?? 0) * 100).toFixed(1)}%)`;
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

    return votes;
  }

  private calcWeightedConsensus(votes: Vote[]): number {
    // Weighted score: sum(weight * confidence * decisionValue) / sum(weight)
    // decisionValue: buy=1, hold=0, sell=-1
    let totalWeight = 0;
    let weightedSum = 0;

    for (const vote of votes) {
      const decisionValue = vote.decision.action === 'buy' ? 1
        : vote.decision.action === 'sell' ? -1
        : 0;
      const agreementScore = vote.confidence * decisionValue;
      weightedSum += vote.weight * Math.abs(agreementScore);
      totalWeight += vote.weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  private buildConsensus(
    thoughts: AgentThought[],
    rounds: DebateRound[],
    reached: boolean,
    deadlock: boolean,
    existingVotes?: Vote[]
  ): ConsensusResult {
    // ─── Per-Symbol Consensus ───
    // Extract per-symbol decisions from each agent's multiSymbolDecision metadata.
    // Each agent produces decisions for: market ticker + all open positions.
    // We aggregate across agents to find the consensus for EACH symbol.
    const perSymbolMap = new Map<string, { actions: string[]; confidences: number[]; closeFlags: boolean[]; sls: number[]; tps: number[]; sizes: number[]; levers: number[]; rationales: string[] }>();

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
          if (!perSymbolMap.has(sym)) perSymbolMap.set(sym, { actions: [], confidences: [], closeFlags: [], sls: [], tps: [], sizes: [], levers: [], rationales: [] });
          const entry = perSymbolMap.get(sym)!;
          entry.actions.push(singleDec.action);
          entry.confidences.push(t.confidence);
          entry.closeFlags.push(false);
          entry.sls.push(singleDec.stopLossPct ?? 0);
          entry.tps.push(singleDec.takeProfitPct ?? 0);
          entry.sizes.push(singleDec.positionSizePct);
          entry.levers.push(singleDec.leverage ?? 1);
          entry.rationales.push(singleDec.rationale);
        }
        continue;
      }

      // Market ticker decision
      const mt = multiDec.marketTicker;
      const mtSym = mt.symbol.includes(':') ? mt.symbol : mt.symbol.toLowerCase();
      if (!perSymbolMap.has(mtSym)) perSymbolMap.set(mtSym, { actions: [], confidences: [], closeFlags: [], sls: [], tps: [], sizes: [], levers: [], rationales: [] });
      const mtEntry = perSymbolMap.get(mtSym)!;
      mtEntry.actions.push(mt.action);
      mtEntry.confidences.push(t.confidence);
      mtEntry.closeFlags.push(mt.closePosition);
      mtEntry.sls.push(mt.suggestedStopLoss ?? 0);
      mtEntry.tps.push(mt.suggestedTakeProfit ?? 0);
      mtEntry.sizes.push(mt.positionSizePct);
      mtEntry.levers.push(mt.leverage);
      mtEntry.rationales.push(mt.rationale);

      // Open position decisions
      for (const pos of multiDec.positions) {
        const posSym = pos.symbol.includes(':') ? pos.symbol : pos.symbol.toLowerCase();
        if (!perSymbolMap.has(posSym)) perSymbolMap.set(posSym, { actions: [], confidences: [], closeFlags: [], sls: [], tps: [], sizes: [], levers: [], rationales: [] });
        const posEntry = perSymbolMap.get(posSym)!;
        posEntry.actions.push(pos.action);
        posEntry.confidences.push(t.confidence);
        posEntry.closeFlags.push(pos.closePosition);
        posEntry.sls.push(pos.suggestedStopLoss ?? 0);
        posEntry.tps.push(pos.suggestedTakeProfit ?? 0);
        posEntry.sizes.push(pos.positionSizePct);
        posEntry.levers.push(pos.leverage);
        posEntry.rationales.push(pos.rationale);
      }
    }

    // Compute per-symbol consensus
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

      const avgConfidence = data.confidences.reduce((s, c) => s + c, 0) / n;
      const closeMajority = data.closeFlags.filter(c => c).length > n / 2;
      const avgSl = data.sls.filter(s => s > 0).reduce((s, v) => s + v, 0) / Math.max(1, data.sls.filter(s => s > 0).length);
      const avgTp = data.tps.filter(s => s > 0).reduce((s, v) => s + v, 0) / Math.max(1, data.tps.filter(s => s > 0).length);
      const avgSize = data.sizes.reduce((s, v) => s + v, 0) / n;
      const avgLev = data.levers.reduce((s, v) => s + v, 0) / n;

      perSymbolConsensus.push({
        symbol: sym,
        action: majorityAction,
        confidence: avgConfidence,
        hasPosition: false, // ⚠️ UNRELIABLE — consumers MUST check portfolio directly (see index.ts per-symbol consensus loop)
        closePosition: closeMajority,
        suggestedStopLoss: avgSl > 0 ? avgSl : undefined,
        suggestedTakeProfit: avgTp > 0 ? avgTp : undefined,
        positionSizePct: avgSize,
        leverage: Math.round(avgLev),
        rationale: `Majority: ${majorityAction.toUpperCase()} (${buyCount}B/${sellCount}S/${holdCount}H/${closeCount}C). Avg conf: ${(avgConfidence * 100).toFixed(0)}%`,
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

    return {
      decision: normalizeDecision({
        action: majorityAction,
        symbol: 'BTCUSDT',
        positionSizePct: majorityAction === 'hold' ? 0 : 0.10,
        leverage: 10,
        rationale: `Majority decision: ${majorityAction.toUpperCase()} (${buyCount}B/${sellCount}S/${holdCount}H). Avg confidence: ${avgConfidence.toFixed(2)}. Rounds: ${rounds.length}.`,
        urgency: 'soon',
      }),
      perSymbolConsensus,
      confidence: avgConfidence,
      reasoning: this.buildReasoning(thoughts, rounds),
      votes: existingVotes ?? [],
      roundsUsed: rounds.length,
      deadlockResolved: deadlock,
      metaAgentOverridden: false,
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
          symbol: psd.symbol.toLowerCase(),
          action: psd.action,
          confidence: metaDecision.confidence,
          hasPosition: hasPos,
          closePosition: psd.closePosition,
          suggestedStopLoss: psd.suggestedStopLoss,
          suggestedTakeProfit: psd.suggestedTakeProfit,
          positionSizePct: psd.positionSizePct,
          leverage: psd.leverage,
          rationale: psd.rationale,
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

      // Hard overrides: enforce absolute risk limits (aligned with clamp)
      if (decision.positionSizePct > MAX_POSITION_PCT) {
        return {
          veto: true,
          reason: `Position size ${(decision.positionSizePct * 100).toFixed(1)}% exceeds hard limit of ${(MAX_POSITION_PCT * 100).toFixed(1)}%. VETO.`,
        };
      }

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
        log.warn(`🚨 Loss cooldown active (${remaining} cycle(s) remaining) — blocking new entry. Risk Auditor will review this cycle.`);
        return {
          veto: true,
          reason: `Loss cooldown: a recent trade lost money. Pausing new entries for ${remaining} cycle(s) while the Risk Auditor reviews. Existing positions are still managed.`,
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
      // On error, be conservative but respect Market Agent limits
      return {
        veto: decision.positionSizePct > MAX_POSITION_PCT,
        reason: 'Risk audit LLM unavailable. Conservative veto only if position exceeds absolute max (20%).',
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