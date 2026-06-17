// ─── Evolution Persistence ───
// Saves/loads evolution state (trade history, memory, strategies) to/from disk.
// Ensures the system resumes exactly where it left off across restarts.
//
// 🔐 ATOMIC WRITE GUARANTEE:
// All save operations use write-to-temp + renameSync pattern.
// If the process crashes mid-write, the original file remains intact.
// Corrupted files on load fall back to defaults (never crash the system).

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../observability/logger.ts';
import type { MemoryEntry, EvolutionaryStrategy, Portfolio, ConsensusResult, AgentThought, DebateRound } from '../types/index.ts';
import type { TradeHistoryEntry } from './trade-history.ts';
import type { GAPopulation, TradeRecord } from '../types/index.ts';

const log = createLogger({ phase: 'persistence' });

const DATA_DIR = path.resolve(process.cwd(), 'data/evolution');

// ─── Write Lock (prevents concurrent writes that corrupt JSON) ───
const writeQueue: Promise<void>[] = [];

function lockedWrite(filePath: string, data: string): void {
  const prev = writeQueue.length > 0 ? writeQueue[writeQueue.length - 1]! : Promise.resolve();
  const next = prev.then(() => atomicWriteSync(filePath, data));
  writeQueue.push(next);
  // Prune completed promises to avoid unbounded growth
  if (writeQueue.length > 20) writeQueue.shift();
}

// ─── Atomic File Write ───
// Writes to .tmp first, then atomic rename to target.
// If process crashes mid-write, .tmp is discarded and original file is intact.
function atomicWriteSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, data, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ─── Minimal Schema Validator ───
// Simple type guards for loaded snapshots — no zod dependency needed here.
interface SchemaField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
}

function validateSnapshot(value: unknown, fields: Record<string, SchemaField>): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'root must be an object';
  const obj = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(fields)) {
    const v = obj[key];
    if (field.required && v === undefined) return `missing required field: ${key}`;
    if (v !== undefined) {
      if (field.type === 'array' && !Array.isArray(v)) return `${key} must be an array`;
      if (field.type === 'number' && typeof v !== 'number') return `${key} must be a number`;
      if (field.type === 'string' && typeof v !== 'string') return `${key} must be a string`;
      if (field.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v))) return `${key} must be an object`;
      if (field.type === 'boolean' && typeof v !== 'boolean') return `${key} must be a boolean`;
    }
  }
  return null;
}

// ─── Interfaces ───

interface EvolutionSnapshot {
  version: number;
  savedAt: string;
  tradeHistory: TradeHistoryEntry[];
  shortTermMemory: MemoryEntry[];
  longTermMemory: MemoryEntry[];
  strategies: EvolutionaryStrategy[];
  generation: number;
  /** Sigmoid·GA population (saved since v2.0.0) */
  gaPopulation?: GAPopulation;
}

/** JSON-safe version of Portfolio (Map → array) */
export interface PortfolioSnapshot {
  version: number;
  balance: number;
  initialBalance: number;
  totalEquity: number;
  totalPnl: number;
  totalPnlPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  peakEquity: number;
  dailyPnl: number;
  dailyLossLimit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  lastUpdated: number;
  /** Serialized positions (Map → array) */
  positions: Array<{
    id: string;
    symbol: string;
    side: 'buy' | 'sell';
    quantity: number;
    averageEntryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    realizedPnl: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    leverage: number;
    openedAt: number;
    updatedAt: number;
    agentId: string;
    exchange?: string;
  }>;
  /** Persisted trades (TradeRecord[]) */
  trades?: Array<{
    id: string;
    symbol: string;
    side: 'buy' | 'sell';
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    leverage: number;
    investment: number;
    pnl: number;
    pnlPct: number;
    openedAt: number;
    closedAt: number;
    agentId?: string;
    status?: 'open' | 'closed';
  }>;
}

interface DebateHistorySnapshot {
  version: number;
  savedAt: string;
  totalCycles: number;
  lastCycleDuration: number;
  consensus: ConsensusResult | null;
  debateRounds: DebateRound[];
  allThoughts: AgentThought[];
}

// ─── Helpers ───

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ─── Evolution State ───

const EVOLUTION_FIELDS: Record<string, SchemaField> = {
  version: { type: 'number', required: true },
  savedAt: { type: 'string', required: true },
  tradeHistory: { type: 'array', required: true },
  shortTermMemory: { type: 'array', required: false },
  longTermMemory: { type: 'array', required: false },
  strategies: { type: 'array', required: false },
  generation: { type: 'number', required: false },
};

/** Serialize all evolution state to disk (atomic write) */
export function saveEvolution(data: {
  tradeHistory: TradeHistoryEntry[];
  shortTermMemory: MemoryEntry[];
  longTermMemory: MemoryEntry[];
  strategies: EvolutionaryStrategy[];
  generation: number;
  gaPopulation?: GAPopulation;
}): boolean {
  try {
    ensureDir();
    const snapshot: EvolutionSnapshot = {
      version: 2,
      savedAt: new Date().toISOString(),
      tradeHistory: data.tradeHistory,
      shortTermMemory: data.shortTermMemory,
      longTermMemory: data.longTermMemory,
      strategies: data.strategies,
      generation: data.generation,
      gaPopulation: data.gaPopulation,
    };
    const filePath = path.join(DATA_DIR, 'evolution-state.json');
    lockedWrite(filePath, JSON.stringify(snapshot, null, 2));
    log.info(`Evolution state saved: ${data.tradeHistory.length} trades, ${data.shortTermMemory.length}ST/${data.longTermMemory.length}LT memories, ${data.strategies.length} strategies`);
    return true;
  } catch (err) {
    log.error(`Failed to save evolution state: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Load evolution state from disk. Returns null if no valid saved state exists. */
export function loadEvolution(): {
  tradeHistory: TradeHistoryEntry[];
  shortTermMemory: MemoryEntry[];
  longTermMemory: MemoryEntry[];
  strategies: EvolutionaryStrategy[];
  generation: number;
  gaPopulation?: GAPopulation;
} | null {
  try {
    const filePath = path.join(DATA_DIR, 'evolution-state.json');
    if (!fs.existsSync(filePath)) {
      log.info('No saved evolution state found — starting fresh');
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const snapshot = JSON.parse(raw) as EvolutionSnapshot;

    // 🛡️ Schema validation on load — reject corrupt files
    const schemaErr = validateSnapshot(snapshot, EVOLUTION_FIELDS);
    if (schemaErr) {
      log.warn(`Corrupt evolution state file (${schemaErr}) — ignoring`);
      return null;
    }

    log.info(`Evolution state loaded: ${snapshot.tradeHistory.length} trades, ${snapshot.shortTermMemory?.length ?? 0}ST/${snapshot.longTermMemory?.length ?? 0}LT memories, ${snapshot.strategies?.length ?? 0} strategies (Gen ${snapshot.generation ?? 1})`);
    return {
      tradeHistory: snapshot.tradeHistory ?? [],
      gaPopulation: snapshot.gaPopulation,
      shortTermMemory: snapshot.shortTermMemory ?? [],
      longTermMemory: snapshot.longTermMemory ?? [],
      strategies: snapshot.strategies ?? [],
      generation: snapshot.generation ?? 1,
    };
  } catch (err) {
    log.warn(`Failed to load evolution state: ${err instanceof Error ? err.message : String(err)} — starting fresh`);
    return null;
  }
}

// ─── Portfolio Persistence ───

const PORTFOLIO_FIELDS: Record<string, SchemaField> = {
  balance: { type: 'number', required: true },
  initialBalance: { type: 'number', required: true },
  totalEquity: { type: 'number', required: true },
  totalPnl: { type: 'number', required: true },
  totalPnlPct: { type: 'number', required: true },
  maxDrawdown: { type: 'number', required: false },
  maxDrawdownPct: { type: 'number', required: false },
  peakEquity: { type: 'number', required: false },
  dailyPnl: { type: 'number', required: false },
  dailyLossLimit: { type: 'number', required: false },
  tradeCount: { type: 'number', required: false },
  winCount: { type: 'number', required: false },
  lossCount: { type: 'number', required: false },
  lastUpdated: { type: 'number', required: false },
  positions: { type: 'array', required: false },
};

/** Serialize portfolio to JSON-safe format (atomic write) */
export function savePortfolio(portfolio: Readonly<Portfolio>, trades?: readonly TradeRecord[]
): boolean {
  try {
    ensureDir();
    const positions = Array.from(portfolio.positions.values()).map(p => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      averageEntryPrice: p.averageEntryPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnl,
      unrealizedPnlPct: p.unrealizedPnlPct,
      realizedPnl: p.realizedPnl,
      stopLossPrice: p.stopLossPrice,
      takeProfitPrice: p.takeProfitPrice,
      leverage: p.leverage,
      openedAt: p.openedAt,
      updatedAt: p.updatedAt,
      agentId: p.agentId,      exchange: (p as any).exchange,    }));

    const serializedTrades = trades ? Array.from(trades).map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      quantity: t.quantity,
      leverage: t.leverage,
      investment: t.investment,
      pnl: t.pnl,
      pnlPct: t.pnlPct,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      agentId: t.agentId,
      status: t.status,
    })) : undefined;

    const snapshot: PortfolioSnapshot = {
      version: 1,
      balance: portfolio.balance,
      initialBalance: portfolio.initialBalance,
      totalEquity: portfolio.totalEquity,
      totalPnl: portfolio.totalPnl,
      totalPnlPct: portfolio.totalPnlPct,
      maxDrawdown: portfolio.maxDrawdown,
      maxDrawdownPct: portfolio.maxDrawdownPct,
      peakEquity: portfolio.peakEquity,
      dailyPnl: portfolio.dailyPnl,
      dailyLossLimit: portfolio.dailyLossLimit,
      // tradeCount = total unique trades (closed + real open, no ghost duplicates).
      // IMPORTANT: winCount + lossCount already equals the number of closed trades.
      // Do NOT add positions.size — that inflates the count with phantom opens.
      tradeCount: portfolio.winCount + portfolio.lossCount,
      winCount: portfolio.winCount,
      lossCount: portfolio.lossCount,
      lastUpdated: portfolio.lastUpdated,
      positions,
      trades: serializedTrades,
    };

    const filePath = path.join(DATA_DIR, 'portfolio-state.json');
    lockedWrite(filePath, JSON.stringify(snapshot, null, 2));
    log.info(`Portfolio saved: balance=${portfolio.balance.toFixed(2)}, ${positions.length} positions`);
    return true;
  } catch (err) {
    log.error(`Failed to save portfolio: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Load portfolio from disk. Returns null if no valid saved state exists. */
export function loadPortfolio(): PortfolioSnapshot | null {
  try {
    const filePath = path.join(DATA_DIR, 'portfolio-state.json');
    if (!fs.existsSync(filePath)) {
      log.info('No saved portfolio found — starting fresh');
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const snapshot = JSON.parse(raw) as PortfolioSnapshot;

    // 🛡️ Schema validation on load
    const schemaErr = validateSnapshot(snapshot, PORTFOLIO_FIELDS);
    if (schemaErr) {
      log.warn(`Corrupt portfolio state file (${schemaErr}) — ignoring`);
      return null;
    }

    log.info(`Portfolio loaded: balance=${snapshot.balance.toFixed(2)}, version=${(snapshot as any).version ?? '?'}, ${snapshot.positions?.length ?? 0} positions`);
    return snapshot;
  } catch (err) {
    log.warn(`Failed to load portfolio: ${err instanceof Error ? err.message : String(err)} — starting fresh`);
    return null;
  }
}

/** Delete saved evolution state (for reset) */
export function clearEvolution(): boolean {
  try {
    const filePath = path.join(DATA_DIR, 'evolution-state.json');
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log.info('Evolution state cleared');
    }
    const tmpPath = filePath + '.tmp';
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
    return true;
  } catch (err) {
    log.error(`Failed to clear evolution state: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Backtest Result Persistence ───

interface BacktestResultSnapshot {
  version: number;
  savedAt: string;
  results: Array<{
    symbol: string;
    years: number;
    interval: string;
    candlesProcessed: number;
    finalReturnPct: number;
    maxDrawdownPct: number;
    sharpeRatio: number;
    winRate: number;
    totalTrades: number;
    buySignals: number;
    sellSignals: number;
    holdSignals: number;
    durationMs: number;
    completedAt: string;
  }>;
}

const BACKTEST_RESULT_FIELDS: Record<string, SchemaField> = {
  version: { type: 'number', required: true },
  savedAt: { type: 'string', required: false },
  results: { type: 'array', required: true },
};

/** Save backtest result to persistent history (atomic write) */
export function saveBacktestResult(result: {
  symbol: string;
  years: number;
  interval: string;
  candlesProcessed: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  totalTrades: number;
  buySignals: number;
  sellSignals: number;
  holdSignals: number;
  durationMs: number;
}): boolean {
  try {
    ensureDir();
    const filePath = path.join(DATA_DIR, 'backtest-results.json');

    // Load existing results
    let existing: BacktestResultSnapshot = { version: 1, savedAt: '', results: [] };
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        existing = JSON.parse(raw) as BacktestResultSnapshot;
      } catch { /* start fresh if corrupt */ }
    }

    existing.savedAt = new Date().toISOString();
    existing.results.push({
      ...result,
      completedAt: new Date().toISOString(),
    });

    // Keep last 50 results
    if (existing.results.length > 50) {
      existing.results = existing.results.slice(-50);
    }

    lockedWrite(filePath, JSON.stringify(existing, null, 2));
    log.info(`Backtest result saved: ${result.years}yr ${result.symbol} ${result.interval} (Sharpe=${result.sharpeRatio.toFixed(2)})`);
    return true;
  } catch (err) {
    log.error(`Failed to save backtest result: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Load all historical backtest results */
export function loadBacktestResults(): Array<{
  symbol: string;
  years: number;
  interval: string;
  candlesProcessed: number;
  finalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRate: number;
  totalTrades: number;
  buySignals: number;
  sellSignals: number;
  holdSignals: number;
  durationMs: number;
  completedAt: string;
}> {
  try {
    const filePath = path.join(DATA_DIR, 'backtest-results.json');
    if (!fs.existsSync(filePath)) return [];

    const raw = fs.readFileSync(filePath, 'utf-8');
    const snapshot = JSON.parse(raw) as BacktestResultSnapshot;

    const schemaErr = validateSnapshot(snapshot, BACKTEST_RESULT_FIELDS);
    if (schemaErr) {
      log.warn(`Corrupt backtest results file (${schemaErr}) — ignoring`);
      return [];
    }

    return snapshot.results ?? [];
  } catch (err) {
    log.warn(`Failed to load backtest results: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ─── Debate / HACP History Persistence ───

const DEBATE_FIELDS: Record<string, SchemaField> = {
  version: { type: 'number', required: true },
  savedAt: { type: 'string', required: false },
  totalCycles: { type: 'number', required: false },
  lastCycleDuration: { type: 'number', required: false },
  consensus: { type: 'object', required: false },
  debateRounds: { type: 'array', required: false },
  allThoughts: { type: 'array', required: false },
};

/** Save the latest HACP debate result so it survives restarts (atomic write) */
export function saveDebateHistory(data: {
  totalCycles: number;
  lastCycleDuration: number;
  consensus: ConsensusResult | null;
  debateRounds: DebateRound[];
  allThoughts: AgentThought[];
}): boolean {
  try {
    ensureDir();
    const snapshot: DebateHistorySnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      totalCycles: data.totalCycles,
      lastCycleDuration: data.lastCycleDuration,
      consensus: data.consensus,
      debateRounds: data.debateRounds,
      allThoughts: data.allThoughts,
    };
    const filePath = path.join(DATA_DIR, 'debate-history.json');
    lockedWrite(filePath, JSON.stringify(snapshot, null, 2));
    log.info(`Debate history saved: Cycle #${data.totalCycles}, ${data.debateRounds.length} rounds`);
    return true;
  } catch (err) {
    log.error(`Failed to save debate history: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Load the latest HACP debate result from disk */
export function loadDebateHistory(): {
  totalCycles: number;
  lastCycleDuration: number;
  consensus: ConsensusResult | null;
  debateRounds: DebateRound[];
  allThoughts: AgentThought[];
} | null {
  try {
    const filePath = path.join(DATA_DIR, 'debate-history.json');
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const snapshot = JSON.parse(raw) as DebateHistorySnapshot;

    // 🛡️ Schema validation
    const schemaErr = validateSnapshot(snapshot, DEBATE_FIELDS);
    if (schemaErr) {
      log.warn(`Corrupt debate history file (${schemaErr}) — ignoring`);
      return null;
    }

    log.info(`Debate history loaded: Cycle #${snapshot.totalCycles}, ${snapshot.debateRounds?.length ?? 0} rounds, ${snapshot.allThoughts?.length ?? 0} thoughts`);
    return {
      totalCycles: snapshot.totalCycles ?? 0,
      lastCycleDuration: snapshot.lastCycleDuration ?? 0,
      consensus: snapshot.consensus ?? null,
      debateRounds: snapshot.debateRounds ?? [],
      allThoughts: snapshot.allThoughts ?? [],
    };
  } catch (err) {
    log.warn(`Failed to load debate history: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}