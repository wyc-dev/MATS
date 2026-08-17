// ─── Execution Tracker ───
// Tracks decision → fill quality for every trade.
// Measures: slippage (expected vs actual price), taker fees paid, latency.
// Provides: per-symbol stats, running averages, total cost reporting.
//
// In paper mode: expectedPrice = market price at decision time
//                  actualPrice    = market price at fill time (paper = instant, 0 slippage)
// In real mode:   expectedPrice = market price at decision time
//                  actualPrice    = exchange fill price from order result
//
// Even in paper mode, slippage CAN be estimated from order book depth
// for a realistic simulation (optional).

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { calculateTakerFee } from './cost-model.ts';
import fs from 'node:fs';
import { lockedWrite } from '../evolution/persistence.ts';
// P21-C: inline symbol-key normaliser(避免 import portfolio.ts 造成循環依賴)
const symKey = (s: string): string => (s ?? '').toUpperCase();

const log = createLogger({ phase: 'execution-tracker' });

// ─── Types ───

export interface ExecutionRecord {
  id: string;
  cycleNumber: number;
  symbol: string;
  side: 'buy' | 'sell';
  /** Expected price at decision time (from market data) */
  expectedPrice: number;
  /** Actual fill price */
  actualPrice: number;
  /** Slippage in basis points (1 bp = 0.01%) */
  slippageBps: number;
  /** Trade notional in USD (price × quantity × leverage) */
  notional: number;
  /** Taker fee paid in USD */
  takerFeeUsd: number;
  /** Estimated funding cost for holding period in USD (0 for new positions) */
  fundingCostUsd: number;
  /** Decision timestamp */
  decisionAt: number;
  /** Fill timestamp */
  filledAt: number;
  /** Was this a real exchange fill or paper simulated? */
  mode: 'paper' | 'real';
}

export interface ExecutionStats {
  totalTrades: number;
  totalNotional: number;
  avgSlippageBps: number;
  maxSlippageBps: number;
  totalFees: number;
  tradeCount: number;
}

// ─── Execution Tracker ───

/**
 * v2.0.870-P21-C: stop-exit slippage 記錄。
 *
 * 背景(8·18 SKHX 驗屍):edgeExecTracker 淨記開倉(avgSlip=0bps 假象),
 * stop-out 滑點(實測 −1.47% 滑穿收緊 SL)完全無人量度 → SL 幾何決策盲。
 * signedSlipBps = 計劃止蝕價 vs 實際成交價嘅**不利方向**距離:
 *   buy(多頭止蝕喺下方): (planned − fill)/planned ×1e4,正 = 滑穿蝕多咗
 *   sell(空頭止蝕喺上方): (fill − planned)/planned ×1e4
 * adverseBps = max(0, signed)——順滑(提早成交好過預期)記 0 adverse。
 */
export interface StopSlipSample { at: number; signedBps: number; adverseBps: number; mode: string }
export interface StopSlipStats { samples: number; avgAdverseBps: number; maxAdverseBps: number; ewmaAdverseBps: number; recent: StopSlipSample[] }

const STOP_SLIP_MIN_SAMPLES = 3;   // 冷啟動:少過 3 個唔返回估計(P21-B 唔郁)
const STOP_SLIP_RECENT_CAP = 20;
const STOP_SLIP_EWMA_ALPHA = 0.3;

/** v2.0.870-P21-B/P21-C: 模組級 estimator 注入(同 atr.ts 嘅 pendingExecutionLens pattern)。
 *  index.ts:tracker 實例建好後 set；trading-manager/smart-sltp 透過
 *  estimateStopSlippageBps() 讀——唔使 constructor 傳參穿過幾層。 */
type StopSlipEstimator = (symbol: string, side: 'buy' | 'sell') => number | null;
let stopSlipEstimator: StopSlipEstimator | null = null;
export function setStopSlipEstimator(fn: StopSlipEstimator | null): void { stopSlipEstimator = fn; }
export function estimateStopSlippageBps(symbol: string, side: 'buy' | 'sell'): number | null {
  try { return stopSlipEstimator?.(symbol, side) ?? null; } catch { return null; }
}

export class ExecutionTracker {
  private records: ExecutionRecord[] = [];
  private readonly maxRecords = 1_000;
  private readonly logger = log;

  // ── P21-C state ──
  private stopSlip = new Map<string, { samples: number; sumAdverse: number; maxAdverse: number; ewma: number; recent: StopSlipSample[] }>();
  private readonly stopSlipPath: string | null;

  constructor(stopSlipPath?: string) {
    this.stopSlipPath = stopSlipPath ?? null;
    if (this.stopSlipPath) this.loadStopSlip();
  }

  /** P21-C: 記錄一次止蝕觸發嘅執行滑點。 */
  recordStopExit(params: { symbol: string; side: 'buy' | 'sell'; plannedStopPrice: number; fillPrice: number; mode?: string; at?: number }): number | null {
    try {
      const planned = params.plannedStopPrice;
      const fill = params.fillPrice;
      if (!Number.isFinite(planned) || !Number.isFinite(fill) || planned <= 0 || fill <= 0) return null;
      const signedBps = params.side === 'buy'
        ? ((planned - fill) / planned) * 10_000
        : ((fill - planned) / planned) * 10_000;
      const adverseBps = Math.max(0, signedBps);
      const key = `${symKey(params.symbol)}|${params.side}`;
      const cur = this.stopSlip.get(key) ?? { samples: 0, sumAdverse: 0, maxAdverse: 0, ewma: 0, recent: [] };
      cur.samples += 1;
      cur.sumAdverse += adverseBps;
      cur.maxAdverse = Math.max(cur.maxAdverse, adverseBps);
      cur.ewma = cur.ewma === 0 ? adverseBps : STOP_SLIP_EWMA_ALPHA * adverseBps + (1 - STOP_SLIP_EWMA_ALPHA) * cur.ewma;
      cur.recent.push({ at: params.at ?? Date.now(), signedBps: Math.round(signedBps * 10) / 10, adverseBps: Math.round(adverseBps * 10) / 10, mode: params.mode ?? 'unknown' });
      if (cur.recent.length > STOP_SLIP_RECENT_CAP) cur.recent = cur.recent.slice(-STOP_SLIP_RECENT_CAP);
      this.stopSlip.set(key, cur);
      this.logger.info(`StopSlip[${key}]: planned=${planned.toFixed(2)} fill=${fill.toFixed(2)} adverse=${adverseBps.toFixed(1)}bps (n=${cur.samples})`);
      this.saveStopSlip();
      return adverseBps;
    } catch (err) {
      this.logger.error(`[execution-tracker.recordStopExit] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** P21-C: 估計 symbol:side 嘅不利止蝕滑點(bps)。樣本 <3 → null(cold-start no-op)。 */
  getStopSlippageEstimate(symbol: string, side: 'buy' | 'sell'): number | null {
    const cur = this.stopSlip.get(`${symKey(symbol)}|${side}`);
    if (!cur || cur.samples < STOP_SLIP_MIN_SAMPLES) return null;
    // 混合:EWMA(反應近期)+ 平均(穩定),取高者——滑點估計偏保守(寧闊唔窄)
    return Math.max(cur.ewma, cur.sumAdverse / cur.samples);
  }

  getStopSlipStats(): Record<string, StopSlipStats> {
    const out: Record<string, StopSlipStats> = {};
    for (const [key, v] of this.stopSlip) {
      out[key] = {
        samples: v.samples,
        avgAdverseBps: v.samples > 0 ? Math.round((v.sumAdverse / v.samples) * 10) / 10 : 0,
        maxAdverseBps: Math.round(v.maxAdverse * 10) / 10,
        ewmaAdverseBps: Math.round(v.ewma * 10) / 10,
        recent: [...v.recent],
      };
    }
    return out;
  }

  private saveStopSlip(): void {
    if (!this.stopSlipPath) return;
    try {
      const plain: Record<string, StopSlipStats> = {};
      for (const [k, v] of this.stopSlip) plain[k] = { samples: v.samples, avgAdverseBps: v.samples > 0 ? v.sumAdverse / v.samples : 0, maxAdverseBps: v.maxAdverse, ewmaAdverseBps: v.ewma, recent: v.recent };
      lockedWrite(this.stopSlipPath, JSON.stringify({ version: 1, savedAt: Date.now(), stopSlip: plain }));
    } catch (err) {
      this.logger.error(`[execution-tracker.saveStopSlip] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadStopSlip(): void {
    if (!this.stopSlipPath) return;
    try {
      if (!fs.existsSync(this.stopSlipPath)) return;
      const raw = JSON.parse(fs.readFileSync(this.stopSlipPath, 'utf-8')) as { stopSlip?: Record<string, StopSlipStats> };
      for (const [k, st] of Object.entries(raw.stopSlip ?? {})) {
        const samples = Math.max(0, Math.floor(st?.samples ?? 0));
        const recent = Array.isArray(st?.recent) ? st.recent.slice(-STOP_SLIP_RECENT_CAP).filter(r => Number.isFinite(r?.adverseBps)) : [];
        const sumAdverse = recent.length === samples && samples > 0
          ? (st.avgAdverseBps ?? 0) * samples
          : recent.reduce((a, r) => a + (r.adverseBps ?? 0), 0);
        if (samples <= 0 && recent.length === 0) continue;
        this.stopSlip.set(k, {
          samples: Math.max(samples, recent.length),
          sumAdverse,
          maxAdverse: Number.isFinite(st?.maxAdverseBps) ? st.maxAdverseBps : 0,
          ewma: Number.isFinite(st?.ewmaAdverseBps) ? st.ewmaAdverseBps : 0,
          recent,
        });
      }
      if (this.stopSlip.size > 0) this.logger.info(`✓ StopSlip loaded (${this.stopSlip.size} keys)`);
    } catch (err) {
      this.logger.error(`[execution-tracker.loadStopSlip] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Record a single execution (decision → fill) */
  record(params: {
    cycleNumber: number;
    symbol: string;
    side: 'buy' | 'sell';
    expectedPrice: number;
    actualPrice: number;
    notional: number;
    decisionAt: number;
    filledAt: number;
    mode: 'paper' | 'real';
    /** Pre-calculated funding cost (0 for new positions) */
    fundingCostUsd?: number;
  }): void {
    try {
      const slippageBps = this.calcSlippageBps(params.expectedPrice, params.actualPrice, params.side);
      const takerFeeUsd = calculateTakerFee(params.notional);
      const record: ExecutionRecord = {
        id: uuidv4(),
        cycleNumber: params.cycleNumber,
        symbol: params.symbol,
        side: params.side,
        expectedPrice: params.expectedPrice,
        actualPrice: params.actualPrice,
        slippageBps,
        notional: params.notional,
        takerFeeUsd,
        fundingCostUsd: params.fundingCostUsd ?? 0,
        decisionAt: params.decisionAt,
        filledAt: params.filledAt,
        mode: params.mode,
      };
      this.records.push(record);
      if (this.records.length > this.maxRecords) {
        this.records = this.records.slice(-this.maxRecords);
      }
      this.logger.info(`Exec[${params.symbol}]: ${params.side.toUpperCase()} @$${params.actualPrice.toFixed(2)} (exp: $${params.expectedPrice.toFixed(2)}, slip: ${slippageBps.toFixed(1)}bp, fee: $${takerFeeUsd.toFixed(2)})`);
    } catch (err) {
      this.logger.error(`[execution-tracker.record] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Estimate slippage from order book depth without actually trading.
   *  Used in paper mode to simulate realistic slippage.
   *  @returns slippage in basis points
   */
  estimateSlippageFromDepth(
    side: 'buy' | 'sell',
    notionalUsd: number,
    orderBookLevels: Array<{ price: number; size: number }>,
  ): number {
    try {
      if (!orderBookLevels || orderBookLevels.length === 0 || notionalUsd <= 0) return 0;

      let remaining = notionalUsd;
      let weightedPrice = 0;
      let totalFilled = 0;

      for (const level of orderBookLevels) {
        const levelNotional = level.price * level.size;
        if (remaining <= 0) break;
        const fill = Math.min(remaining, levelNotional);
        weightedPrice += level.price * (fill / levelNotional);
        totalFilled += fill / level.price;
        remaining -= fill;
      }

      if (totalFilled <= 0) return 0;

      const avgFillPrice = weightedPrice / (totalFilled > 0 ? 1 : 1);
      // Find mid price (average of first bid and ask)
      // For simplicity, use first level price as reference
      const refPrice = orderBookLevels[0]?.price ?? 0;
      if (refPrice <= 0) return 0;

      // Slippage = distance from mid to avg fill
      const slippagePct = Math.abs(avgFillPrice - refPrice) / refPrice;
      return slippagePct * 10_000; // Convert to bps
    } catch (err) {
      this.logger.error(`[estimateSlippageFromDepth] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** Get stats for a specific symbol (or all) */
  getStats(symbol?: string): ExecutionStats {
    try {
      let filtered = this.records;
      if (symbol) filtered = filtered.filter(r => r.symbol === symbol);

      if (filtered.length === 0) {
        return { totalTrades: 0, totalNotional: 0, avgSlippageBps: 0, maxSlippageBps: 0, totalFees: 0, tradeCount: 0 };
      }

      const avgSlippage = filtered.reduce((s, r) => s + r.slippageBps, 0) / filtered.length;

      return {
        totalTrades: filtered.length,
        totalNotional: filtered.reduce((s, r) => s + r.notional, 0),
        avgSlippageBps: avgSlippage,
        maxSlippageBps: Math.max(...filtered.map(r => r.slippageBps)),
        totalFees: filtered.reduce((s, r) => s + r.takerFeeUsd, 0),
        tradeCount: filtered.length,
      };
    } catch (err) {
      this.logger.error(`[execution-tracker.getStats] Failed: ${err instanceof Error ? err.message : String(err)}`);
      return { totalTrades: 0, totalNotional: 0, avgSlippageBps: 0, maxSlippageBps: 0, totalFees: 0, tradeCount: 0 };
    }
  }

  /** Get all records (for persistence/serialization) */
  getAllRecords(): ExecutionRecord[] {
    return [...this.records];
  }

  /** Calculate slippage in basis points between expected and actual price.
   *  Buy: positive slippage = actual > expected (bad for buyer)
   *  Sell: positive slippage = actual < expected (bad for seller)
   */
  private calcSlippageBps(expected: number, actual: number, side: 'buy' | 'sell'): number {
    try {
      if (expected <= 0 || actual <= 0) return 0;
      const pctChange = (actual - expected) / expected;
      // For buys: positive pctChange = worse price = positive slippage
      // For sells: negative pctChange = worse price = positive slippage  
      const signed = side === 'buy' ? pctChange : -pctChange;
      return Math.max(0, signed * 10_000); // bps, never negative
    } catch {
      return 0;
    }
  }

  /** Get a summary string for injection into agent context */
  getSummary(): string {
    try {
      const all = this.getStats();
      if (all.totalTrades === 0) return '=== Execution Quality ===\nNo trades executed yet.\n';
      return [
        '=== Execution Quality ===',
        `Trades: ${all.totalTrades}`,
        `Avg Slippage: ${all.avgSlippageBps.toFixed(1)} bps`,
        `Max Slippage: ${all.maxSlippageBps.toFixed(1)} bps`,
        `Total Fees Paid: $${all.totalFees.toFixed(2)}`,
        '==========================',
      ].join('\n');
    } catch {
      return 'Execution quality data unavailable.';
    }
  }
}