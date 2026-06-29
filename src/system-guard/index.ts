// ─── SystemGuard ───
// 5 層系統級保護閘門，在每個 decision cycle 開始前調用。
// 每個 guard 獨立 try/catch — 錯誤不 cascade，永遠 fallback log。

import { createLogger } from '../observability/logger.ts';
import type { GuardParams, GuardResult, GuardReport } from './types.ts';

const log = createLogger({ phase: 'system-guard' });

// ─── Economic Calendar — FOMC + CPI + NFP 2026 ───
// Source: Federal Reserve + BLS annual schedules
// FOMC meetings typically span 2 days; decisions announced on Day 2 at ~14:00 ET
const FOMC_2026_DATES: Array<{ start: string; end: string; label: string }> = [
  { start: '2026-01-27', end: '2026-01-28', label: 'FOMC January' },
  { start: '2026-03-17', end: '2026-03-18', label: 'FOMC March' },
  { start: '2026-05-05', end: '2026-05-06', label: 'FOMC May' },
  { start: '2026-06-16', end: '2026-06-17', label: 'FOMC June' },
  { start: '2026-07-28', end: '2026-07-29', label: 'FOMC July' },
  { start: '2026-09-15', end: '2026-09-16', label: 'FOMC September' },
  { start: '2026-11-03', end: '2026-11-04', label: 'FOMC November' },
  { start: '2026-12-08', end: '2026-12-09', label: 'FOMC December' },
];

// NFP / CPI approximate monthly patterns
// NFP: first Friday of each month @ 08:30 ET
// CPI: ~10th-15th of each month @ 08:30 ET
// For simplicity: hardcode the months, compute exact day at runtime
const eventMonths = {
  nfp: { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], label: 'NFP' as const, hourET: 8, minET: 30, dayOfWeek: 5, weekOrdinal: 'first' as const },
  cpi: { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], label: 'CPI' as const, hourET: 8, minET: 30, dayOfMonth: null as number | null, // approximate — exact dates vary
  },
};

/** Check if `date` falls within N hours of any known economic event */
function getEconomicEventBlackoutWindow(): { active: boolean; eventName: string; hoursUntilRelease: number } | null {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const BLACKOUT_HOURS = 4; // No new positions 4 hours before/after major events
    const BLACKOUT_MS = BLACKOUT_HOURS * 3_600_000;

    // Normalize today to YYYY-MM-DD for FOMC date matching
    const todayStr = now.toISOString().slice(0, 10);
    const todayMs = new Date(todayStr).getTime();

    // Check FOMC meeting windows (decision day = end date)
    for (const meeting of FOMC_2026_DATES) {
      const decisionDay = new Date(meeting.end + 'T18:00:00Z'); // ~14:00 ET = 18:00 UTC
      const decisionMs = decisionDay.getTime();
      const diff = nowMs - decisionMs;
      // Block 4h before decision until 2h after (volatility + initial reaction)
      if (diff >= -BLACKOUT_MS && diff <= 2 * 3_600_000) {
        const hoursUntil = diff < 0
          ? Math.round(-diff / 3_600_000)
          : Math.round(diff / 3_600_000);
        return {
          active: diff < 0, // Before decision: block. After: warning
          eventName: meeting.label,
          hoursUntilRelease: hoursUntil,
        };
      }
    }

    // Check NFP (first Friday of each month)
    for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const firstDay = new Date(2026, m - 1, 1);
      const firstFriday = new Date(firstDay);
      // Find first Friday: day 0 = Sunday, 5 = Friday
      while (firstFriday.getUTCDay() !== 5) {
        firstFriday.setUTCDate(firstFriday.getUTCDate() + 1);
      }
      firstFriday.setUTCHours(12, 30, 0, 0); // 08:30 ET = 12:30 UTC
      const nfpMs = firstFriday.getTime();
      const diff = nowMs - nfpMs;
      if (diff >= -BLACKOUT_MS && diff <= 2 * 3_600_000) {
        const hoursUntil = diff < 0 ? Math.round(-diff / 3_600_000) : Math.round(diff / 3_600_000);
        return {
          active: diff < 0,
          eventName: `NFP ${months[m - 1] ?? ''}`,
          hoursUntilRelease: hoursUntil,
        };
      }
    }

    return null;
  } catch (err) {
    log.error(`[economic-calendar] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return null; // Fail open — don't block on error
  }
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── Drawdown Circuit Breaker Thresholds ───
const DD_THRESHOLDS = [
  { threshold: 0.15, action: 'block_cycle' as const,    label: 'Max Drawdown >15%' },
  { threshold: 0.10, action: 'block_new_position' as const, label: 'Max Drawdown >10%' },
  { threshold: 0.07, action: 'reduce_size' as const,    label: 'Max Drawdown >7%' },
  { threshold: 0.05, action: 'reduce_leverage' as const, label: 'Max Drawdown >5%' },
];

const DAILY_LOSS_THRESHOLD = 0.05; // 5% daily loss → block for rest of day

// ─── Data Freshness Thresholds ───
const STALE_WS_MS = 5_000;     // WS book older than 5s → stale
const STALE_REST_MS = 60_000;  // REST data older than 60s → stale

// ─── Liquidity Check ───
const MAX_SLIPPAGE_PCT = 0.002; // 0.2% max acceptable slippage

// ═══════════════════════════════════════════
// SystemGuard
// ═══════════════════════════════════════════

export class SystemGuard {
  private readonly logger = createLogger({ phase: 'system-guard' });

  /**
   * Run all 5 guards. Each guard is independent — errors never cascade.
   * Returns a GuardReport with blocked status + context modifications.
   */
  check(params: GuardParams): GuardReport {
    try {
      const results: GuardResult[] = [];

      // Run all guards — each has its own try/catch
      results.push(this.guardDrawdown(params));
      results.push(this.guardEconomicCalendar());
      results.push(this.guardDataFreshness(params));
      results.push(this.guardAgentTrack(params));

      return {
        blocked: results.some(r => !r.allowed && r.action === 'block_cycle'),
        results,
        contextLines: this.buildContextLines(results),
      };
    } catch (err) {
      this.logger.error(`[system-guard] CRITICAL: SystemGuard.check() itself threw: ${err instanceof Error ? err.message : String(err)}`);
      return {
        blocked: false, // Fail open on catastrophic error
        results: [{ allowed: true, severity: 'error', reason: `SystemGuard error: ${err}`, guardName: 'system-guard', action: 'warn_only' }],
        contextLines: [],
      };
    }
  }

  /**
   * Run liquidity guard SEPARATELY (it's async because it MAY make REST calls).
   * Kept separate from check() so sync guards aren't blocked by a network call.
   */
  async checkLiquidity(params: GuardParams): Promise<GuardResult> {
    try {
      return this.guardLiquidity(params);
    } catch (err) {
      this.logger.error(`[liquidity-guard] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true, severity: 'error', reason: `Liquidity check error: ${err}`, guardName: 'liquidity', action: 'warn_only' };
    }
  }

  // ── Individual Guards ──

  /**
   * Guard B: Drawdown Circuit Breaker
   * Checks portfolio drawdown + daily loss.
   * Internal data only — never throws.
   */
  private guardDrawdown(p: GuardParams): GuardResult {
    try {
      // v2.0.42: Use CURRENT drawdown, not historical max.
      // maxDrawdownPct is a high-water mark that only increases — using it
      // meant trading was permanently blocked after a drawdown spike,
      // even after equity fully recovered. currentDrawdownPct decreases
      // when equity recovers, so trading resumes once drawdown drops.
      const dd = p.currentDrawdownPct;

      for (const level of DD_THRESHOLDS) {
        if (dd >= level.threshold) {
          // Check daily loss as well (v2.0.23: only on actual loss, not profit)
          const dailyLossPct = (p.dailyPnl < 0 && p.balance > 0) ? Math.abs(p.dailyPnl) / p.balance : 0;
          if (dailyLossPct >= DAILY_LOSS_THRESHOLD && level.action === 'block_cycle') {
            return {
              allowed: false,
              severity: 'critical',
              reason: `🛑 Daily loss ${(dailyLossPct * 100).toFixed(1)}% exceeds ${(DAILY_LOSS_THRESHOLD * 100)}% limit + drawdown ${(dd * 100).toFixed(1)}% exceeds ${(level.threshold * 100)}%`,
              guardName: 'drawdown',
              action: 'block_cycle',
            };
          }
          return {
            allowed: level.action !== 'block_cycle',
            severity: level.action === 'block_cycle' ? 'critical' : dd >= 0.07 ? 'error' : 'warn',
            reason: `Drawdown ${(dd * 100).toFixed(1)}% ≥ ${(level.threshold * 100)}% → ${level.label}`,
            guardName: 'drawdown',
            action: level.action,
          };
        }
      }

      // Also check daily loss alone (even if drawdown is fine)
      // v2.0.23: only block on actual loss (dailyPnl < 0), not on accumulated profit
      const dailyLossPct = (p.dailyPnl < 0 && p.balance > 0) ? Math.abs(p.dailyPnl) / p.balance : 0;
      if (dailyLossPct >= DAILY_LOSS_THRESHOLD) {
        return {
          allowed: false,
          severity: 'error',
          reason: `🛑 Daily loss ${(dailyLossPct * 100).toFixed(1)}% exceeds ${(DAILY_LOSS_THRESHOLD * 100)}% limit — blocking new positions for rest of day`,
          guardName: 'drawdown',
          action: 'block_new_position',
        };
      }

      return { allowed: true, severity: 'info', reason: 'Drawdown within safe range', guardName: 'drawdown', action: 'warn_only' };
    } catch (err) {
      this.logger.error(`[drawdown-guard] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true, severity: 'error', reason: `Guard error: ${err}`, guardName: 'drawdown', action: 'warn_only' };
    }
  }

  /**
   * Guard A: Economic Calendar Blackout
   * Blocks new positions around FOMC, NFP, CPI.
   */
  private guardEconomicCalendar(): GuardResult {
    try {
      const event = getEconomicEventBlackoutWindow();
      if (!event) {
        return { allowed: true, severity: 'info', reason: 'No economic event in blackout window', guardName: 'economic_calendar', action: 'warn_only' };
      }

      if (event.active) {
        return {
          allowed: false,
          severity: 'critical',
          reason: `🛑 ${event.eventName} in ${event.hoursUntilRelease}h — blocking new positions (blackout window)`,
          guardName: 'economic_calendar',
          action: 'block_new_position',
        };
      }

      return {
        allowed: true,
        severity: 'warn',
        reason: `⚠️ ${event.eventName} released ${event.hoursUntilRelease}h ago — increased volatility expected`,
        guardName: 'economic_calendar',
        action: 'warn_only',
      };
    } catch (err) {
      this.logger.error(`[economic-calendar-guard] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true, severity: 'error', reason: `Guard error: ${err}`, guardName: 'economic_calendar', action: 'warn_only' };
    }
  }

  /**
   * Guard C: Data Freshness Scoring
   * Checks WS + REST data staleness and returns a confidence multiplier.
   */
  private guardDataFreshness(p: GuardParams): GuardResult {
    try {
      const now = Date.now();
      let stalenessLevel: 'fresh' | 'stale' | 'critical' = 'fresh';
      const staleSignals: string[] = [];

      // Check WS data
      if (p.lastBookTimestamp > 0) {
        const wsAge = now - p.lastBookTimestamp;
        if (wsAge > STALE_WS_MS * 6) {
          stalenessLevel = 'critical';
          staleSignals.push(`WS book ${(wsAge / 1000).toFixed(0)}s old`);
        } else if (wsAge > STALE_WS_MS) {
          stalenessLevel = 'stale';
          staleSignals.push(`WS book ${(wsAge / 1000).toFixed(0)}s old`);
        }
      } else {
        stalenessLevel = 'stale';
        staleSignals.push('WS book never received');
      }

      // Check REST data
      if (p.lastFetchTime > 0) {
        const restAge = now - p.lastFetchTime;
        if (restAge > STALE_REST_MS * 3) {
          stalenessLevel = 'critical';
          staleSignals.push(`REST fetch ${(restAge / 1000).toFixed(0)}s ago`);
        } else if (restAge > STALE_REST_MS) {
          if (stalenessLevel === 'fresh') stalenessLevel = 'stale';
          staleSignals.push(`REST fetch ${(restAge / 1000).toFixed(0)}s ago`);
        }
      }

      if (stalenessLevel === 'critical') {
        return {
          allowed: false,
          severity: 'critical',
          reason: `🛑 Data critically stale: ${staleSignals.join('; ')}. Blocking cycle.`,
          guardName: 'data_freshness',
          action: 'block_cycle',
        };
      }

      if (stalenessLevel === 'stale') {
        return {
          allowed: true,
          severity: 'warn',
          reason: `⚠️ Data stale: ${staleSignals.join('; ')}. Agents will receive freshness warning.`,
          guardName: 'data_freshness',
          action: 'reduce_size',
        };
      }

      return { allowed: true, severity: 'info', reason: 'Data fresh', guardName: 'data_freshness', action: 'warn_only' };
    } catch (err) {
      this.logger.error(`[data-freshness-guard] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true, severity: 'error', reason: `Guard error: ${err}`, guardName: 'data_freshness', action: 'warn_only' };
    }
  }

  /**
   * Guard D: Agent Track Record
   * Flags agents with poor session performance for Skeptics.
   */
  private guardAgentTrack(p: GuardParams): GuardResult {
    try {
      const entries = Object.entries(p.agentWinRates);
      if (entries.length === 0) {
        return { allowed: true, severity: 'info', reason: 'No agent track data yet (cold start)', guardName: 'agent_track', action: 'warn_only' };
      }

      const underperformers = entries
        .filter(([_, winRate]) => winRate < 0.30 && winRate >= 0) // 0 = no trades yet, skip those
        .map(([agentId, winRate]) => `${agentId}(${(winRate * 100).toFixed(0)}%)`);

      if (underperformers.length > 0) {
        return {
          allowed: true, // Don't block, but warn
          severity: 'warn',
          reason: `⚠️ Underperforming agents this session: ${underperformers.join(', ')}. Skeptics will scrutinize more.`,
          guardName: 'agent_track',
          action: 'warn_only',
        };
      }

      return { allowed: true, severity: 'info', reason: 'All agents performing adequately', guardName: 'agent_track', action: 'warn_only' };
    } catch (err) {
      this.logger.error(`[agent-track-guard] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true, severity: 'error', reason: `Guard error: ${err}`, guardName: 'agent_track', action: 'warn_only' };
    }
  }

  /**
   * Guard E: Liquidity Check (Execution Feasibility)
   * Checks if proposed position can be filled within acceptable slippage.
   * Uses WS order book depth for active symbol.
   */
  private guardLiquidity(p: GuardParams): GuardResult {
    try {
      if (!p.orderBookDepth || p.orderBookDepth.length === 0) {
        return { allowed: true, severity: 'warn', reason: 'No order book data — liquidity check skipped', guardName: 'liquidity', action: 'warn_only' };
      }

      if (p.proposedPositionUsd <= 0) {
        return { allowed: true, severity: 'info', reason: 'No position proposed — liquidity check N/A', guardName: 'liquidity', action: 'warn_only' };
      }

      // Sort bids descending, asks ascending
      const bids = [...p.orderBookDepth].sort((a, b) => b.price - a.price);
      const asks = [...p.orderBookDepth].sort((a, b) => a.price - b.price);

      // Calculate cumulative depth within slippage range
      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 0;
      const midPrice = (bestBid + bestAsk) / 2;
      if (midPrice <= 0) {
        return { allowed: true, severity: 'warn', reason: 'Cannot determine mid price — liquidity check skipped', guardName: 'liquidity', action: 'warn_only' };
      }

      const maxSlippagePrice = midPrice * MAX_SLIPPAGE_PCT;
      let cumulativeNotional = 0;

      // Sum notional from ask side (for buys) within slippage
      for (const ask of asks) {
        if (ask.price > midPrice + maxSlippagePrice) break;
        cumulativeNotional += ask.price * ask.size;
      }

      // Also check bid side (for sells)
      for (const bid of bids) {
        if (bid.price < midPrice - maxSlippagePrice) break;
        cumulativeNotional += bid.price * bid.size;
      }

      const positionWithLeverage = p.proposedPositionUsd; // already in USD notional

      if (positionWithLeverage > cumulativeNotional) {
        const fillablePct = cumulativeNotional / positionWithLeverage;
        if (fillablePct < 0.3) {
          return {
            allowed: false,
            severity: 'error',
            reason: `🛑 Position ${p.proposedPositionUsd.toFixed(0)} USD exceeds available depth ${cumulativeNotional.toFixed(0)} USD within ${(MAX_SLIPPAGE_PCT * 100).toFixed(1)}% slippage (can fill only ${(fillablePct * 100).toFixed(0)}%). Reduce size or increase slippage tolerance.`,
            guardName: 'liquidity',
            action: 'block_cycle',
          };
        }
        return {
          allowed: true,
          severity: 'warn',
          reason: `⚠️ Position ${p.proposedPositionUsd.toFixed(0)} USD partially exceeds depth ${cumulativeNotional.toFixed(0)} USD — expect higher slippage. Consider reducing size.`,
          guardName: 'liquidity',
          action: 'reduce_size',
        };
      }

      return { allowed: true, severity: 'info', reason: `Liquidity sufficient: $${cumulativeNotional.toFixed(0)} depth within ${(MAX_SLIPPAGE_PCT * 100).toFixed(1)}% slippage`, guardName: 'liquidity', action: 'warn_only' };
    } catch (err) {
      this.logger.error(`[liquidity-guard] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true, severity: 'error', reason: `Guard error: ${err}`, guardName: 'liquidity', action: 'warn_only' };
    }
  }

  /** Build context lines from all guard results to inject into agent prompts */
  private buildContextLines(results: GuardResult[]): string[] {
    try {
      const lines: string[] = [];
      let hasDrawdownBlock = false;
      let hasStaleData = false;
      let hasCalendarEvent = false;
      let hasUnderperformers = false;

      for (const r of results) {
        if (r.guardName === 'drawdown' && !r.allowed) {
          hasDrawdownBlock = true;
          lines.push(`⚠️ SYSTEM GUARD [${r.guardName}]: ${r.reason}`);
        }
        if (r.guardName === 'data_freshness' && r.severity === 'warn') {
          hasStaleData = true;
          lines.push(`⚠️ SYSTEM GUARD [${r.guardName}]: ${r.reason}`);
        }
        if (r.guardName === 'economic_calendar' && r.severity === 'warn') {
          hasCalendarEvent = true;
          lines.push(`⚠️ SYSTEM GUARD [${r.guardName}]: ${r.reason}`);
        }
        if (r.guardName === 'agent_track' && r.severity === 'warn') {
          hasUnderperformers = true;
          lines.push(`⚠️ SYSTEM GUARD [${r.guardName}]: ${r.reason}`);
        }
      }

      // Inject constraint modifications based on guard results
      if (hasDrawdownBlock) {
        lines.push('=== SYSTEM-IMPOSED CONSTRAINTS ===');
        lines.push('- maxLeverage=3x (reduced due to drawdown)');
        lines.push('- maxPositionSize=0.05 (reduced to 5% due to drawdown)');
        lines.push('- minConfidenceForTrade=0.60 (raised due to drawdown)');
        lines.push('=== END SYSTEM CONSTRAINTS ===');
      }
      if (hasStaleData) {
        lines.push('⚠️ NOTE: Market data may be stale. Reduce position sizes and confidence accordingly.');
      }
      if (hasCalendarEvent) {
        lines.push('⚠️ NOTE: Major economic event nearby. Expect elevated volatility and reduced liquidity.');
      }
      if (hasUnderperformers) {
        lines.push('⚠️ NOTE: Some agents have poor session track records. Skeptics should scrutinize them more.');
      }

      return lines;
    } catch (err) {
      this.logger.error(`[build-context-lines] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Get guard names that have active restrictions (for logging).
   */
  getActiveRestrictions(report: GuardReport): string[] {
    try {
      return report.results
        .filter(r => !r.allowed || r.severity === 'warn')
        .map(r => `[${r.guardName}] ${r.reason.slice(0, 100)}`);
    } catch {
      return [];
    }
  }

  /**
   * Get overall health summary string.
   */
  getHealthSummary(report: GuardReport): string {
    try {
      const blocked = report.results.filter(r => !r.allowed);
      const warnings = report.results.filter(r => r.severity === 'warn');
      const info = report.results.filter(r => r.severity === 'info');

      const parts: string[] = [];
      if (blocked.length > 0) parts.push(`🚫 ${blocked.length} blocked`);
      if (warnings.length > 0) parts.push(`⚠️ ${warnings.length} warnings`);
      if (info.length > 0) parts.push(`✅ ${info.length} passed`);
      return parts.join(' | ') || '✅ All clear';
    } catch {
      return '? Health summary unavailable';
    }
  }
}