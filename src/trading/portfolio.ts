// ─── Portfolio Tracker ───
// Tracks portfolio state, positions, P&L, drawdown calculations

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import { loadPortfolio, type PortfolioSnapshot } from '../evolution/persistence.ts';
import { calculateTakerFee } from './cost-model.ts';
import type {
  Portfolio,
  Position,
  Order,
  TradeRecord,
  OrderSide,
  Ticker,
} from '../types/index.ts';

const log = createLogger({ phase: 'portfolio' });

/**
 * v2.0.31: Normalize symbol for portfolio Map key.
 * HL colon-prefixed symbols (xyz:SPCX) are case-sensitive — preserve original case.
 * Non-colon symbols (BTC, ETH) are lowercased for backward compatibility.
 */
// v2.0.42: Exported for use by decision-utils.ts + base-agent.ts + index.ts.
// All symbol normalization MUST go through this function to ensure consistent
// casing across the system. Colon-prefixed symbols (xyz:MU) normalize the
// prefix to lowercase (xyz:MU) while preserving the asset name case;
// non-colon symbols (BTC) are lowercased.
//
// v2.0.78 FIX: Previously, colon symbols preserved the original prefix case
// (XYZ:SP500 stayed XYZ:SP500). This caused hasPosition() to miss when the
// decision symbol was uppercased (activeSymbolUpper = 'XYZ:SP500') but the
// portfolio stored it as 'xyz:SP500'. Now the prefix is always lowercased.
//
// ⚠️ MAINTENANCE NOTE: If you change this function, you MUST update all
// callers: decision-utils.ts normalizeDecision(), base-agent.ts parseResponse(),
// index.ts overlap guard + onPositions + onFills handlers.
export function normalizeSymbol(symbol: string): string {
  if (symbol.includes(':')) {
    // Lowercase the prefix (before colon), preserve the asset name (after colon)
    const colonIdx = symbol.indexOf(':');
    return symbol.slice(0, colonIdx).toLowerCase() + symbol.slice(colonIdx);
  }
  return symbol.toLowerCase();
}

/**
 * v2.0.137: Detect placeholder entry-thesis strings that must NEVER be stored
 * on a position. The perSymbolConsensus sync (index.ts) forwards Meta-Agent's
 * per-cycle thesis, which can be 'N/A', 'Not applicable', 'none', or whitespace
 * when Meta-Agent didn't produce a real rationale for that symbol this cycle.
 * Storing such a placeholder would (a) wipe a frozen real thesis if the setter
 * ever allowed overwrite, and (b) make Skeptics Phase 0.5 auto-invalidate
 * ("entry thesis empty, no reasoning to evaluate") → premature force-close.
 */
export function isThesisPlaceholder(thesis: string | undefined | null): boolean {
  if (!thesis) return true;
  const t = thesis.trim().toLowerCase();
  if (t.length === 0) return true;
  if (t === 'n/a' || t === 'na' || t === 'not applicable' || t === 'none' || t === 'null' || t === '-') return true;
  // v2.0.139: catch placeholder-filled theses in the [1h: ...] [1d: ...] format
  // (e.g. "[1h: N/A — hold] [1d: N/A — hold]"). The Meta-Agent sometimes emits
  // this for a trade entry when it has no real timeframe rationale — it is NOT
  // a real entry reason. Strip timeframe labels, structural punctuation, and
  // placeholder words; if no real content (3+ letter word) remains, it's a
  // placeholder.
  const stripped = t
    .replace(/\[(1h|1d|4h|1w|1m|5m|15m)\s*:/g, ' ')
    .replace(/[\[\]():,.\-—_/\\]/g, ' ')
    .replace(/\b(n\/a|na|hold|none|null|not applicable|tbd|todo|closing|close|position|no trade|no position|no entry|entry|open|opening|skip)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return true;
  if (!/[a-z]{3,}/.test(stripped)) return true;
  return false;
}

/** Callback fired when a position is closed (SL/TP, reconciliation, or explicit close) */
export type OnPositionClosed = (trade: TradeRecord) => void;
/** Callback fired when a position is opened */
export type OnPositionOpened = (trade: TradeRecord) => void;

export class PortfolioTracker {
  private portfolio: Portfolio;
  /** Callback so PaperTradingEngine can capture trades from SL/TP closes */
  private onPositionClosedCb: OnPositionClosed | null = null;
  /** Callback so PaperTradingEngine can capture open trades */
  private onPositionOpenedCb: OnPositionOpened | null = null;
  /** v2.0.32: Separate callback for exchange position closes — triggers
   * learning WITHOUT adding to paperEngine.trades[] (real trades should
   * not appear in paper trade list). */
  private onExchangeClosedLearningCb: OnPositionClosed | null = null;
  /** v2.0.33: UI callback for exchange position closes — fires AFTER the
   * position is deleted + learning is triggered, so index.ts can immediately
   * call pushToAPI() + refresh cachedHLFills to update the UI without waiting
   * for the next cycle. */
  private onExchangeClosedUICb: (() => void) | null = null;
  /** v2.0.35: Closed real (exchange) trade records — stored separately from
   *  paperEngine.trades[] so the UI Trade Records panel can display real HL
   *  closes (SL/TP triggered on exchange) with accurate exit price + PnL.
   *  Previously closeExchangePosition() created a TradeRecord but it was only
   *  used for learning — never stored, so the UI never showed the close. */
  private readonly closedRealTrades: TradeRecord[] = [];
  /** v2.0.66: Dedup set — symbols that were recently closed via closeExchangePosition().
   *  Prevents duplicate trade records when reconciliation fires multiple times
   *  for the same position. TTL: 60 seconds (long enough to cover a full cycle). */
  private readonly recentlyClosedSyms: Map<string, number> = new Map();
  /** v2.0.71: Extended to 5min — syncExchangePositions re-imports positions
   *  within the same cycle after closeExchangePosition deletes them. */
  private readonly CLOSE_DEDUP_TTL_MS = 300_000;
  /** v2.0.72: COMPLETELY SEPARATE store for real (exchange) positions.
   *  Paper and real positions no longer share the same Map. This eliminates:
   *    - recalculateEquity needing to skip real positions (fragile)
   *    - syncExchangePositions re-importing after close → duplicate records
   *    - symbol casing mismatches between paper/real
   *  Real positions never touch paper balance/equity/stats. */
  private readonly realPositions: Map<string, Position> = new Map();
  /** Restored trades from disk (loaded in constructor) */
  readonly restoredTrades: TradeRecord[] = [];

  constructor() {
    const initialBalance = config.paper.initialBalance;

    // Try to restore portfolio from disk
    const saved = loadPortfolio();
    if (saved) {
      this.portfolio = {
        balance: saved.balance,
        initialBalance: saved.initialBalance,
        totalEquity: saved.totalEquity,
        positions: new Map(),
        totalPnl: saved.totalPnl,
        totalPnlPct: saved.totalPnlPct,
        maxDrawdown: saved.maxDrawdown,
        maxDrawdownPct: saved.maxDrawdownPct,
        // v2.0.42: currentDrawdownPct — restored from saved or default 0.
        // Old portfolio-state.json files won't have this field, so default to 0.
        // It will be recalculated on the first recalculateEquity() call.
        currentDrawdownPct: (saved as any).currentDrawdownPct ?? 0,
        peakEquity: saved.peakEquity,
        dailyPnl: saved.dailyPnl,
        dailyLossLimit: saved.dailyLossLimit,
        dailyPnlResetDate: saved.dailyPnlResetDate,
        tradeCount: saved.tradeCount,
        winCount: saved.winCount,
        lossCount: saved.lossCount,
        lastUpdated: saved.lastUpdated,
      };

      // Restore positions
      for (const p of saved.positions ?? []) {
        // 🐛 FIX: Guard against manually-edited portfolio-state.json where
        // positions may contain empty objects {} (user removed losing trades).
        // Skip entries without a valid symbol to prevent "Cannot read
        // properties of undefined (reading 'toLowerCase')".
        if (!p || !p.symbol) continue;
        const normSym = normalizeSymbol(p.symbol);
        const pos: Position = {
          id: p.id,
          symbol: normSym,
          side: p.side,
          quantity: p.quantity,
          averageEntryPrice: p.averageEntryPrice,
          currentPrice: p.currentPrice,
          unrealizedPnl: p.unrealizedPnl,
          unrealizedPnlPct: p.unrealizedPnlPct,
          realizedPnl: p.realizedPnl,
          stopLossPrice: p.stopLossPrice,
          takeProfitPrice: p.takeProfitPrice,
          leverage: p.leverage ?? 1,
          openedAt: p.openedAt,
          updatedAt: p.updatedAt,
          agentId: p.agentId,
          exchange: p.exchange,
          // v2.0.80: Restore entryThesis from saved state
          entryThesis: (p as any).entryThesis,
        };
        // v2.0.72: route real positions to realPositions, paper to portfolio.positions
        if (p.agentId === 'hyperliquid-real') {
          this.realPositions.set(normSym, pos);
        } else {
          this.portfolio.positions.set(normSym, pos);
        }
      }

      // Restore trades
      this.restoredTrades = (saved.trades ?? []).map(t => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side as 'buy' | 'sell',
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        quantity: t.quantity,
        leverage: t.leverage,
        investment: t.investment,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        agentId: t.agentId ?? '',
        status: (t as any).status ?? 'closed',
      }));

      // v2.0.38: Restore real (exchange) trades — these are HL SL/TP-triggered
      // closes + manual exchange closes. Stored separately from paper trades
      // so they survive restarts but don't pollute paper stats.
      const restoredRealTrades = (saved.realTrades ?? []).map(t => ({
        id: t.id,
        symbol: t.symbol,
        side: t.side as 'buy' | 'sell',
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        quantity: t.quantity,
        leverage: t.leverage,
        investment: t.investment,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        agentId: t.agentId ?? '',
        status: (t as any).status ?? 'closed',
      }));
      this.closedRealTrades.push(...restoredRealTrades);
      if (restoredRealTrades.length > 0) {
        log.info(`📋 Restored ${restoredRealTrades.length} real (exchange) trade records`);
      }

      log.info(`Portfolio restored: balance=${saved.balance.toFixed(2)}, ${saved.positions?.length ?? 0} positions, ${saved.tradeCount} trades, ${restoredRealTrades.length} real trades`);
    } else {
      this.portfolio = {
        balance: initialBalance,
        initialBalance: initialBalance,
        totalEquity: initialBalance,
        positions: new Map(),
        totalPnl: 0,
        totalPnlPct: 0,
        maxDrawdown: 0,
        maxDrawdownPct: 0,
        currentDrawdownPct: 0,
        peakEquity: initialBalance,
        dailyPnl: 0,
        dailyLossLimit: initialBalance * config.paper.dailyLossLimitPct,
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        lastUpdated: Date.now(),
      };
    }
  }

  /** Register a callback for position closes (used by PaperTradingEngine to capture SL/TP trades) */
  setOnPositionClosed(cb: OnPositionClosed): void {
    this.onPositionClosedCb = cb;
  }

  /** v2.0.32: Register a learning-only callback for exchange position closes.
   * Unlike setOnPositionClosed, this does NOT add the trade to paperEngine.trades[].
   * It only triggers learning mechanisms (RBC, pattern classifier, evolution, etc.). */
  setOnExchangeClosedLearning(cb: OnPositionClosed): void {
    this.onExchangeClosedLearningCb = cb;
  }

  /** v2.0.33: Register a UI-update callback for exchange position closes.
   * Fires after the position is deleted + learning is triggered, so the caller
   * can immediately update the UI (pushToAPI + refresh fills). */
  setOnExchangeClosedUI(cb: () => void): void {
    this.onExchangeClosedUICb = cb;
  }

  /** v2.0.35: Get closed real (exchange) trade records for UI display.
   * These are trades closed by HL SL/TP triggers or manual exchange closes —
   * stored separately from paperEngine.trades[] so they don't pollute paper
   * stats but still appear in the Trade Records panel. */
  getClosedRealTrades(): readonly TradeRecord[] {
    return this.closedRealTrades;
  }

  /** Register a callback for position opens (used by PaperTradingEngine to capture open trades) */
  setOnPositionOpened(cb: OnPositionOpened): void {
    this.onPositionOpenedCb = cb;
  }

  /** Get restored trades from disk (for PaperTradingEngine to consume) */
  getRestoredTrades(): readonly import('../types/index.ts').TradeRecord[] {
    return this.restoredTrades;
  }

  getPortfolio(): Readonly<Portfolio> {
    return this.portfolio;
  }

  /** Get portfolio data for persistence (serializable format) */
  getPortfolioSnapshot(): import('../evolution/persistence.ts').PortfolioSnapshot {
    // v2.0.72: persist both paper + real positions
    const positions = [
      ...Array.from(this.portfolio.positions.values()),
      ...Array.from(this.realPositions.values()),
    ].map(p => ({
      id: p.id,
      symbol: p.symbol,
      side: p.side as 'buy' | 'sell',
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
      agentId: p.agentId,
      exchange: p.exchange,
    }));

    return {
      version: 1,
      balance: this.portfolio.balance,
      initialBalance: this.portfolio.initialBalance,
      totalEquity: this.portfolio.totalEquity,
      totalPnl: this.portfolio.totalPnl,
      totalPnlPct: this.portfolio.totalPnlPct,
      maxDrawdown: this.portfolio.maxDrawdown,
      maxDrawdownPct: this.portfolio.maxDrawdownPct,
      currentDrawdownPct: this.portfolio.currentDrawdownPct,
      peakEquity: this.portfolio.peakEquity,
      dailyPnl: this.portfolio.dailyPnl,
      dailyLossLimit: this.portfolio.dailyLossLimit,
      tradeCount: this.portfolio.tradeCount,
      winCount: this.portfolio.winCount,
      lossCount: this.portfolio.lossCount,
      lastUpdated: this.portfolio.lastUpdated,
      positions,
    };
  }

  getEquity(): number {
    return this.portfolio.totalEquity;
  }

  hasPosition(symbol: string): boolean {
    const sym = normalizeSymbol(symbol);
    return this.portfolio.positions.has(sym) || this.realPositions.has(sym);
  }

  getPosition(symbol: string): Position | undefined {
    const sym = normalizeSymbol(symbol);
    return this.portfolio.positions.get(sym) ?? this.realPositions.get(sym);
  }

  /**
   * v2.0.32: Remove a position from the local portfolio WITHOUT recording
   * a trade or adjusting balance. Used by syncExchangePositions() when the
   * exchange position has fundamentally changed (side flip, qty change) and
   * the old mirror needs to be replaced with a fresh import.
   */
  removePosition(symbol: string): void {
    const sym = normalizeSymbol(symbol);
    const wasReal = this.realPositions.has(sym);
    this.realPositions.delete(sym);
    this.portfolio.positions.delete(sym);
    if (!wasReal) this.recalculateEquity();
  }

  /** Get all open symbols for reconciliation checks */
  getOpenSymbols(): string[] {
    // v2.0.72: include real positions
    return Array.from(new Set([
      ...this.portfolio.positions.keys(),
      ...this.realPositions.keys(),
    ]));
  }

  getPositionCount(): number {
    return this.portfolio.positions.size + this.realPositions.size;
  }

  /** v2.0.72: Get all real (exchange) positions — completely separate from paper. */
  getRealPositions(): Position[] {
    return Array.from(this.realPositions.values());
  }

  /** v2.0.72: Get all paper positions — completely separate from real. */
  getPaperPositions(): Position[] {
    return Array.from(this.portfolio.positions.values());
  }

  /**
   * v2.0.42: canTrade() uses CURRENT drawdown, not historical max.
   * maxDrawdownPct is a high-water mark that only increases — using it
   * here meant that once drawdown hit 27%, trading was permanently
   * blocked even after equity fully recovered.
   * currentDrawdownPct decreases when equity recovers, so trading
   * resumes once the drawdown drops below the threshold.
   *
   * v2.0.127: This check is BYPASSED when forceMirror=true is passed to
   * paperEngine.executeDecision(). Real trades that already executed on HL
   * must not be blocked by paper portfolio drawdown guards.
   *
   * Guards checked:
   *   1. currentDrawdownPct >= maxDrawdownPct (drawdown circuit breaker)
   *   2. dailyPnl < 0 AND dailyLossPct >= dailyLossLimitPct (daily loss limit)
   */
  canTrade(): { allowed: boolean; reason?: string } {
    // v2.0.23: auto-reset dailyPnl on calendar date change.
    this.checkDailyReset();

    // v2.0.42: canTrade() uses CURRENT drawdown, not historical max.
    // maxDrawdownPct is a high-water mark that only increases — using it
    // here meant that once drawdown hit 27%, trading was permanently
    // blocked even after equity fully recovered.
    // currentDrawdownPct decreases when equity recovers, so trading
    // resumes once the drawdown drops below the threshold.
    if (this.portfolio.currentDrawdownPct >= config.paper.maxDrawdownPct) {
      return {
        allowed: false,
        reason: `Current drawdown ${(this.portfolio.currentDrawdownPct * 100).toFixed(1)}% exceeded. Trading halted. (Historical max: ${(this.portfolio.maxDrawdownPct * 100).toFixed(1)}%)`,
      };
    }

    // v2.0.23 fix: only block on ACTUAL daily loss (dailyPnl < 0).
    // Previously used Math.abs(dailyPnl) which meant accumulated PROFIT
    // could also trigger the "daily loss limit" — nonsensical. Now only
    // a negative dailyPnl (real loss today) triggers the block.
    if (this.portfolio.dailyPnl < 0) {
      const dailyLossPct = Math.abs(this.portfolio.dailyPnl) / this.portfolio.totalEquity;
      if (dailyLossPct >= config.paper.dailyLossLimitPct) {
        return {
          allowed: false,
          reason: `Daily loss limit ${(dailyLossPct * 100).toFixed(1)}% reached. No more trades today.`,
        };
      }
    }

    return { allowed: true };
  }

  openPosition(order: Order, entryPrice: number, leverage = 1, entryThesis?: string): Position {
    const symbol = normalizeSymbol(order.symbol);
    const quantity = order.filledQuantity > 0 ? order.filledQuantity : order.quantity;
    const notional = quantity * entryPrice;
    // v2.0.63: Deduct MARGIN (notional / leverage), not full notional.
    // On Hyperliquid, a 10x leveraged position only requires 10% margin.
    // The old code deducted full notional, causing balance to drop 10x
    // faster than reality. closePosition() now returns margin (not notional).
    const margin = notional / leverage;

    // Deduct margin from balance.
    this.portfolio.balance -= margin;

    // ── v2.0.18: Deduct entry taker fee (notional-based) ──
    // HL taker fee = 0.04% of NOTIONAL (full position value).
    // v2.0.48: Notional = entryPrice × quantity (NOT × leverage).
    // Leverage only affects margin requirement, not fee basis.
    // At 10x leverage, notional = margin × 10, so fee = 0.04% of notional.
    // Deducting this from balance ensures paper PnL reflects the real cost
    // of entering a leveraged position, so the system only learns strategies
    // that are profitable AFTER fees.
    const entryNotional = notional; // notional = quantity * entryPrice = full position value
    const entryFee = calculateTakerFee(entryNotional);
    this.portfolio.balance -= entryFee;

    // Infer exchange from symbol format
    let exchange: string | undefined;
    if (symbol.includes(':')) {
      exchange = 'hyperliquid';
    } else if (symbol.endsWith('usdt') || symbol.endsWith('usd')) {
      exchange = 'binance';
    }

    // v2.0.19: unrealizedPnl starts at -entryFee so the UI shows the real
    // cost from the moment the position opens (previously $0.00 because
    // price hadn't moved yet, hiding the fee already paid).
    // v2.0.63: unrealizedPnlPct is relative to MARGIN (not notional) so it
    // reflects the actual return on capital at risk.
    const position: Position = {
      id: uuidv4(),
      symbol,
      side: order.side,
      quantity,
      averageEntryPrice: entryPrice,
      currentPrice: entryPrice,
      unrealizedPnl: -entryFee,
      unrealizedPnlPct: margin > 0 ? -entryFee / margin : 0,
      realizedPnl: 0,
      leverage,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      agentId: order.agentId,
      exchange,
      entryFee,
      // v2.0.80: Store Meta-Agent's entry thesis for Skeptics re-validation
      entryThesis,
    };

    // Set stop-loss and take-profit
    if (order.side === 'buy') {
      position.stopLossPrice = entryPrice * (1 - config.risk.stopLossPct);
      position.takeProfitPrice = entryPrice * (1 + config.risk.takeProfitPct);
    } else {
      position.stopLossPrice = entryPrice * (1 + config.risk.stopLossPct);
      position.takeProfitPrice = entryPrice * (1 - config.risk.takeProfitPct);
    }

    this.portfolio.positions.set(symbol, position);
    this.portfolio.lastUpdated = Date.now();
    this.recalculateEquity();

    // Record open trade
    const openTrade: TradeRecord = {
      id: uuidv4(),
      symbol,
      side: order.side,
      entryPrice,
      exitPrice: entryPrice,
      quantity,
      leverage,
      investment: margin,
      pnl: 0,
      pnlPct: 0,
      openedAt: position.openedAt,
      closedAt: position.openedAt,
      agentId: order.agentId,
      status: 'open',
    };
    if (this.onPositionOpenedCb) {
      this.onPositionOpenedCb(openTrade);
    }

    log.info(`Position opened: ${order.side.toUpperCase()} ${quantity.toFixed(6)} ${symbol} @ ${entryPrice}`, {
      cost: margin.toFixed(2),
      balance: this.portfolio.balance.toFixed(2),
    });

    return position;
  }

  updatePosition(symbol: string, currentPrice: number): void {
    const pos = this.portfolio.positions.get(symbol);
    if (!pos) return;

    pos.currentPrice = currentPrice;
    pos.updatedAt = Date.now();

    // v2.0.19: include the entry fee already paid so unrealized PnL reflects
    // the real cost from open. The exit fee (paid on close) is NOT included
    // here — it's deducted in closePosition() when the trade realises.
    //
    // v2.0.48: FIX — removed `* (pos.leverage ?? 1)` from PnL calculation.
    // v2.0.48: FIX — removed `* (pos.leverage ?? 1)` from PnL calculation.
    // PnL = priceDelta * quantity (NOT priceDelta * quantity * leverage).
    // Leverage affects margin (capital required to open), not PnL per
    // contract. With 10x leverage, a $786 price move on 0.00154 BTC =
    // $1.21 PnL (not $12.10). The old formula inflated PnL by leverage,
    // causing the UI to show $12.10 in paper mode while HL showed $1.21.
    // v2.0.63: unrealizedPnlPct is PnL / MARGIN (return on capital at risk),
    // not PnL / notional. At 10x leverage, a 1% price move = 10% return
    // on margin — this is the leveraged return the UI should show.
    const entryFee = pos.entryFee ?? 0;
    const margin = (pos.averageEntryPrice * pos.quantity) / (pos.leverage ?? 1);
    if (pos.side === 'buy') {
      pos.unrealizedPnl = (currentPrice - pos.averageEntryPrice) * pos.quantity - entryFee;
      pos.unrealizedPnlPct = margin > 0 ? ((currentPrice - pos.averageEntryPrice) * pos.quantity - entryFee) / margin : 0;
    } else {
      pos.unrealizedPnl = (pos.averageEntryPrice - currentPrice) * pos.quantity - entryFee;
      pos.unrealizedPnlPct = margin > 0 ? ((pos.averageEntryPrice - currentPrice) * pos.quantity - entryFee) / margin : 0;
    }

    // Recalculate total equity so it reflects latest unrealized PnL
    this.recalculateEquity();

    // v2.0.32: For exchange-imported positions (agentId='hyperliquid-real'),
    // do NOT trigger local SL/TP checks. The exchange manages SL/TP natively
    // via trigger orders. Local SL triggering would close the paper mirror
    // while the real HL position remains open — causing phantom trade records
    // and incorrect learning.
    if (pos.agentId === 'hyperliquid-real') return;

    // Check stop-loss / take-profit (paper positions only)
    this.checkPositionExits(pos);
  }

  /**
   * Update a position's price and PnL WITHOUT triggering SL/TP checks.
   * Used when syncing exchange positions — the exchange handles SL/TP
   * natively, and we must not auto-close the mirror prematurely.
   *
   * v2.0.48: Same PnL formula fix as updatePosition() — removed leverage
   * multiplier. PnL = priceDelta * quantity, not priceDelta * quantity * lev.
   */
  /**
   * v2.0.134: Set entry thesis on a position (real or paper).
   * v2.0.137 FREEZE: The entry thesis is the rationale that justified OPENING
   * the position, and Skeptics Phase 0.5 re-validates exactly this thesis each
   * cycle ("is the ORIGINAL reasoning still valid?"). Previously this setter
   * overwrote unconditionally every cycle from the perSymbolConsensus sync
   * (index.ts), so the "original" thesis being re-validated was actually a
   * MOVING TARGET — constantly replaced with Meta-Agent's latest re-statement
   * (sometimes 'N/A'/empty), which caused premature/erratic invalidation and
   * force-closes (positions closed within 6-15 min with near-zero PnL).
   *
   * Now the thesis is FROZEN at open: this setter only fills the thesis in
   * when the position has none yet (e.g. a position re-imported from HL via
   * importExchangePosition, which carries no thesis — there the best-available
   * HACP thesis is used). Once a real thesis is set (at openPosition, or here
   * on first fill), it is never overwritten for the lifetime of the position.
   *
   * The live per-cycle reasoning belongs in `holdReason` (setHoldReason),
   * which is NOT re-validated and may update freely.
   *
   * Candidate theses that are placeholders ('', whitespace, 'N/A',
   * 'Not applicable', 'none') are never stored — they would make Skeptics
   * auto-invalidate ("entry thesis empty, no reasoning") and force-close.
   *
   * @param symbol position symbol (normalised internally)
   * @param thesis candidate thesis; ignored if the position already has a
   *               frozen thesis, or if the candidate is a placeholder.
   */
  setEntryThesis(symbol: string, thesis: string): void {
    const sym = normalizeSymbol(symbol);
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(sym);
    if (!pos) return;
    // Already frozen — never overwrite the original entry rationale.
    if (pos.entryThesis && pos.entryThesis.trim().length > 0) return;
    // Only store a real thesis; reject placeholders that would trigger
    // spurious Skeptics invalidation ("empty thesis → no reasoning").
    if (isThesisPlaceholder(thesis)) return;
    pos.entryThesis = thesis.trim();
    pos.updatedAt = Date.now();
  }

  /** v2.0.134: Set hold reason on a position (real or paper). */
  setHoldReason(symbol: string, reason: string): void {
    const sym = normalizeSymbol(symbol);
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(sym);
    if (!pos) return;
    if (reason && reason.trim().length > 0) {
      pos.holdReason = reason.trim();
      pos.updatedAt = Date.now();
    }
  }

  softUpdatePosition(symbol: string, currentPrice: number): void {
    // v2.0.72: check real positions first, then paper
    const sym = normalizeSymbol(symbol);
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(symbol);
    if (!pos) return;

    pos.currentPrice = currentPrice;
    pos.updatedAt = Date.now();

    // v2.0.19: include the entry fee already paid (same as updatePosition).
    // v2.0.48: PnL = priceDelta * quantity (no leverage multiplier).
    // v2.0.63: unrealizedPnlPct = PnL / margin (leveraged return on capital).
    const entryFee = pos.entryFee ?? 0;
    const margin = (pos.averageEntryPrice * pos.quantity) / (pos.leverage ?? 1);
    if (pos.side === 'buy') {
      pos.unrealizedPnl = (currentPrice - pos.averageEntryPrice) * pos.quantity - entryFee;
      pos.unrealizedPnlPct = margin > 0 ? ((currentPrice - pos.averageEntryPrice) * pos.quantity - entryFee) / margin : 0;
    } else {
      pos.unrealizedPnl = (pos.averageEntryPrice - currentPrice) * pos.quantity - entryFee;
      pos.unrealizedPnlPct = margin > 0 ? ((pos.averageEntryPrice - currentPrice) * pos.quantity - entryFee) / margin : 0;
    }

    this.recalculateEquity();
  }

  /**
   * v2.0.31: Import an exchange position into the local portfolio as a mirror.
   * Unlike openPosition(), this does NOT deduct margin from balance — the
   * position was opened on the exchange, not in the paper portfolio.
   * Used by syncExchangePositions() when a position exists on HL but not locally.
   */
  importExchangePosition(
    symbol: string,
    side: 'buy' | 'sell',
    quantity: number,
    entryPrice: number,
    leverage: number,
    openedAt: number,
  ): void {
    // v2.0.31: Use normalizeSymbol for case-sensitive colon symbol support
    const sym = normalizeSymbol(symbol);

    // Don't import if already exists
    if (this.portfolio.positions.has(sym)) return;

    // v2.0.72: BLOCK re-import if this position was recently closed.
    // syncExchangePositions() runs every cycle and re-imports positions
    // that exist on HL. After closeExchangePosition() deletes the local
    // mirror, the next cycle re-imports it → close again → duplicate
    // trade records. Block re-import within CLOSE_DEDUP_TTL_MS.
    // v2.0.97: BUT if the position still exists on the exchange (HL), we MUST
    // re-import it — the local close may have failed on HL, leaving the position
    // orphaned (locally closed but still open on exchange). The dedup should only
    // block re-import if the position was ACTUALLY closed on the exchange.
    // Since importExchangePosition is only called when syncExchangePositions
    // confirms the position exists on HL, we can safely bypass the dedup here.
    const dedupKey = `${sym}:${entryPrice.toFixed(2)}`;
    const lastClose = this.recentlyClosedSyms.get(dedupKey);
    if (lastClose && (Date.now() - lastClose) < this.CLOSE_DEDUP_TTL_MS) {
      // v2.0.97: Position exists on HL (caller confirmed via getPositions()),
      // so the local close was either a paper-only close or the HL close failed.
      // Either way, the position is still open on HL and must be re-imported
      // so agents can manage it. Clear the dedup entry and proceed.
      log.info(`⏭️ importExchangePosition dedup bypassed: ${sym} @ $${entryPrice.toFixed(2)} was closed locally ${Date.now() - lastClose}ms ago but still exists on HL — re-importing`);
      this.recentlyClosedSyms.delete(dedupKey);
    }

    let exchange: string | undefined;
    if (sym.includes(':')) {
      exchange = 'hyperliquid';
    } else if (sym.endsWith('usdt') || sym.endsWith('usd')) {
      exchange = 'binance';
    }

    // v2.0.31: Set default SL/TP for imported exchange positions so the
    // local mirror has safety levels. The exchange may have its own SL/TP
    // (set via HL UI), but the local mirror needs them too for:
    //   - UI display (TradingView SL/TP lines)
    //   - Per-position close voting (agents see SL/TP in context)
    //   - Portfolio exit monitoring (checkPositionExits)
    // Default: SL = 2% from entry, TP = 5% from entry (aligned with risk config)
    const slPct = 0.02;
    const tpPct = 0.05;
    const stopLossPrice = side === 'buy'
      ? entryPrice * (1 - slPct)
      : entryPrice * (1 + slPct);
    const takeProfitPrice = side === 'buy'
      ? entryPrice * (1 + tpPct)
      : entryPrice * (1 - tpPct);

    const position: Position = {
      id: `hl-${sym}-${Date.now()}`,
      symbol: sym,
      side,
      quantity,
      averageEntryPrice: entryPrice,
      currentPrice: entryPrice,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      realizedPnl: 0,
      leverage,
      openedAt,
      updatedAt: Date.now(),
      agentId: 'hyperliquid-real',
      exchange,
      stopLossPrice,
      takeProfitPrice,
    };

    // v2.0.72: Store in realPositions (separate from paper positions).
    this.realPositions.set(sym, position);
    // No recalculateEquity — real positions don't affect paper equity.
  }

  /**
   * v2.0.42: adjustPosition — the HARD SAFETY layer for SL/TP adjustments.
   *
   * All callers (HACP adjustPositions, per-symbol consensus, manual trade)
   * go through this method. It validates:
   *   1. Direction: SL must be on correct side of current price (not trigger immediately)
   *   2. Direction: TP must be on profit side of entry
   *   3. No-widen: SL can only move TOWARD current price (never away = more risk)
   *   4. No-widen: TP can only move TOWARD current price (never away = greedier)
   *   5. v2.0.129: Not-too-tight: SL ≥ 1% from current price, TP ≥ 1.5% from current price
   *   6. Min gap: SL/TP gap ≥ 2% of current price
   *   7. Max narrow step: SL/TP can only move 0.5% of current price per cycle
   *
   * Returns true if accepted (values applied to local mirror), false if rejected.
   * RealTradingManager uses this return value to decide what to send to HL.
   *
   * ⚠️ MAINTENANCE NOTE: If you change validation logic, update BOTH this layer
   * AND hacp.ts adjustPositions() (the LLM retry loop layer).
   */
  adjustPosition(positionId: string, newStopLoss?: number, newTakeProfit?: number): boolean {
    // v2.0.72: search both real and paper positions
    const allPositions = [...this.realPositions.values(), ...this.portfolio.positions.values()];
    for (const pos of allPositions) {
      if (pos.id === positionId) {
        const isLong = pos.side === 'buy';

        // ── Hard safety: validate TP direction ──
        // TP for LONG must be ABOVE entry (profit side)
        // TP for SHORT must be BELOW entry (profit side)
        const validatedTP = (() => {
          if (newTakeProfit === undefined) return undefined;
          const tpOk = isLong ? newTakeProfit > pos.averageEntryPrice : newTakeProfit < pos.averageEntryPrice;
          if (!tpOk) {
            log.warn(`🚫 adjustPosition REJECTED: ${isLong ? 'LONG' : 'SHORT'} TP $${newTakeProfit} on wrong side of entry $${pos.averageEntryPrice}. Ignoring.`);
            return undefined;
          }
          return newTakeProfit;
        })();

        // ── v2.0.42: Validate SL direction — relaxed to allow profit-side SL ──
        // OLD: SL must be on the loss side of entry (LONG SL < entry, SHORT SL > entry)
        // NEW: SL can be on EITHER side of entry (allowing trailing stop / lock profit),
        //   BUT must be on the correct side of CURRENT MARK PRICE:
        //     LONG SL must be BELOW current price (otherwise it would trigger immediately)
        //     SHORT SL must be ABOVE current price (otherwise it would trigger immediately)
        //
        // ⚠️ MAINTENANCE NOTE: If you change SL validation logic, you MUST update
        // this comment AND the corresponding validation in hacp.ts adjustPositions().
        // The SL validation chain is: hacp.ts adjustPositions() → portfolio.ts adjustPosition().
        const validatedSL = (() => {
          if (newStopLoss === undefined) return undefined;
          const slOk = isLong ? newStopLoss < pos.currentPrice : newStopLoss > pos.currentPrice;
          if (!slOk) {
            log.warn(`🚫 adjustPosition REJECTED: ${isLong ? 'LONG' : 'SHORT'} SL $${newStopLoss} on wrong side of current price $${pos.currentPrice} (would trigger immediately). Ignoring.`);
            return undefined;
          }
          return newStopLoss;
        })();

        // ── v2.0.42: No-widen enforcement for SL ──
        // SL can only move TOWARD current price (trailing stop / lock profit).
        // It must NEVER move AWAY from current price (widening = more risk).
        //
        // ⚠️ MAINTENANCE NOTE: This is the HARD SAFETY layer for SL no-widen.
        // hacp.ts adjustPositions() also enforces no-widen, but this layer
        // catches any caller that bypasses HACP (per-symbol consensus, manual).
        // If you change no-widen logic, update BOTH layers.
        let finalSL = validatedSL;
        if (finalSL !== undefined && pos.stopLossPrice !== undefined) {
          if (isLong) {
            // Long SL can only go UP (toward price). If new SL < old SL, it's widening.
            if (finalSL < pos.stopLossPrice) {
              log.warn(`🚫 adjustPosition SL no-widen: LONG SL $${finalSL} < old SL $${pos.stopLossPrice} — widening blocked`);
              finalSL = undefined;
            }
          } else {
            // Short SL can only go DOWN (toward price). If new SL > old SL, it's widening.
            if (finalSL > pos.stopLossPrice) {
              log.warn(`🚫 adjustPosition SL no-widen: SHORT SL $${finalSL} > old SL $${pos.stopLossPrice} — widening blocked`);
              finalSL = undefined;
            }
          }
        }

        // ── v2.0.42: No-widen enforcement for TP ──
        // TP can only move TOWARD current price (tightening). It must NEVER
        // move AWAY (widening = greedier target that may never hit).
        let finalTP = validatedTP;
        if (finalTP !== undefined && pos.takeProfitPrice !== undefined) {
          if (isLong) {
            // Long TP can only go DOWN (toward price). If new TP > old TP, it's widening.
            if (finalTP > pos.takeProfitPrice) {
              log.warn(`🚫 adjustPosition TP no-widen: LONG TP $${finalTP} > old TP $${pos.takeProfitPrice} — widening blocked`);
              finalTP = undefined;
            }
          } else {
            // Short TP can only go UP (toward price). If new TP < old TP, it's widening.
            if (finalTP < pos.takeProfitPrice) {
              log.warn(`🚫 adjustPosition TP no-widen: SHORT TP $${finalTP} < old TP $${pos.takeProfitPrice} — widening blocked`);
              finalTP = undefined;
            }
          }
        }

        // v2.0.49: Minimum SL/TP gap constraint — if the gap between the
        // new SL and the existing/new TP is less than 2% of current price,
        // reject the adjustment. Over-narrowing causes noise stop-outs +
        // premature TP hits, cutting profits short.
        // (was 1% in v2.0.36 — increased to 2% for slower narrowing)
        const effectiveSL = finalSL ?? pos.stopLossPrice;
        const effectiveTP = finalTP ?? pos.takeProfitPrice;
        if (effectiveSL !== undefined && effectiveTP !== undefined) {
          const sltpGap = Math.abs(effectiveTP - effectiveSL);
          const gapPct = pos.currentPrice > 0 ? sltpGap / pos.currentPrice : 0;
          if (gapPct < 0.02) {
            log.warn(`🚫 adjustPosition REJECTED: ${isLong ? 'LONG' : 'SHORT'} ${pos.symbol} SL/TP gap=$${sltpGap.toFixed(2)} (${(gapPct * 100).toFixed(2)}%) < 2% minimum — keeping wider SL/TP to avoid noise stop-out`);
            return false;
          }
        }

        // v2.0.50: Maximum narrowing step — SL/TP can only move 0.5% of
        // current price closer per adjustment. This is the HARD SAFETY layer
        // (hacp.ts also enforces this with retry feedback to the LLM).
        // Prevents aggressive narrowing that causes premature stop-outs.
        const MAX_NARROW_STEP_PCT = 0.005; // 0.5% of current price
        if (finalSL !== undefined && pos.stopLossPrice !== undefined) {
          const oldDist = Math.abs(pos.currentPrice - pos.stopLossPrice);
          const newDist = Math.abs(pos.currentPrice - finalSL);
          const narrowingAmount = oldDist - newDist;
          if (narrowingAmount > pos.currentPrice * MAX_NARROW_STEP_PCT) {
            log.warn(`🚫 adjustPosition SL narrowing blocked: ${pos.symbol} moved $${narrowingAmount.toFixed(2)} (${(narrowingAmount / pos.currentPrice * 100).toFixed(2)}%) but max ${(MAX_NARROW_STEP_PCT * 100)}% per cycle — too fast`);
            finalSL = undefined;
          }
        }
        if (finalTP !== undefined && pos.takeProfitPrice !== undefined) {
          const oldDist = Math.abs(pos.currentPrice - pos.takeProfitPrice);
          const newDist = Math.abs(pos.currentPrice - finalTP);
          const narrowingAmount = oldDist - newDist;
          if (narrowingAmount > pos.currentPrice * MAX_NARROW_STEP_PCT) {
            log.warn(`🚫 adjustPosition TP narrowing blocked: ${pos.symbol} moved $${narrowingAmount.toFixed(2)} (${(narrowingAmount / pos.currentPrice * 100).toFixed(2)}%) but max ${(MAX_NARROW_STEP_PCT * 100)}% per cycle — too fast`);
            finalTP = undefined;
          }
        }

        // v2.0.129: Not-too-tight — minimum distance from current price.
        // SL must be at least MIN_SL_DIST_PCT away from current price
        // (otherwise normal market noise triggers premature stop-out).
        // TP must be at least MIN_TP_DIST_PCT away from current price
        // (otherwise normal market noise triggers premature take-profit).
        // This is the HARD SAFETY layer — hacp.ts also enforces this in the
        // LLM retry loop, but per-symbol consensus + manual paths bypass HACP.
        const MIN_SL_DIST_PCT = 0.01;  // 1% minimum SL distance
        const MIN_TP_DIST_PCT = 0.015; // 1.5% minimum TP distance
        if (finalSL !== undefined && pos.currentPrice > 0) {
          const slDistPct = Math.abs(pos.currentPrice - finalSL) / pos.currentPrice;
          if (slDistPct < MIN_SL_DIST_PCT) {
            log.warn(`🚫 adjustPosition SL too-tight: ${pos.symbol} SL $${finalSL.toFixed(2)} is ${(slDistPct * 100).toFixed(2)}% from current price $${pos.currentPrice.toFixed(2)} — minimum ${(MIN_SL_DIST_PCT * 100)}% required to avoid noise stop-out`);
            finalSL = undefined;
          }
        }
        if (finalTP !== undefined && pos.currentPrice > 0) {
          const tpDistPct = Math.abs(pos.currentPrice - finalTP) / pos.currentPrice;
          if (tpDistPct < MIN_TP_DIST_PCT) {
            log.warn(`🚫 adjustPosition TP too-tight: ${pos.symbol} TP $${finalTP.toFixed(2)} is ${(tpDistPct * 100).toFixed(2)}% from current price $${pos.currentPrice.toFixed(2)} — minimum ${(MIN_TP_DIST_PCT * 100)}% required to avoid noise take-profit`);
            finalTP = undefined;
          }
        }

        if (finalSL !== undefined) {
          pos.stopLossPrice = finalSL;
        }
        if (finalTP !== undefined) {
          pos.takeProfitPrice = finalTP;
        }
        pos.updatedAt = Date.now();
        log.info(`Position ${positionId.slice(0, 8)} adjusted: SL=${pos.stopLossPrice?.toFixed(2) ?? '-'} TP=${pos.takeProfitPrice?.toFixed(2) ?? '-'}`);
        return true;
      }
    }
    log.warn(`adjustPosition: position ${positionId.slice(0, 8)} not found`);
    return false;
  }

  /**
   * v2.0.47: Sync SL/TP from the actual Hyperliquid trigger orders into the
   * local mirror. This is the REVERSE of syncSLTP() — it reads what's actually
   * placed on HL and updates the local mirror so the UI shows the real values.
   *
   * Unlike adjustPosition(), this method does NOT enforce no-widen or gap
   * constraints because HL's values are the ground truth — the exchange already
   * accepted these orders, so they are valid by definition.
   *
   * v2.0.55: Added direction validation — if HL has inverted SL/TP (SL on
   * wrong side of current price, TP on wrong side of entry), the values are
   * REJECTED and the local mirror keeps its existing (correct) values.
   * This prevents corrupted HL trigger orders from polluting the local mirror.
   *
   * @param symbol  The position symbol (case-preserved, e.g. 'btc' or 'xyz:SKHX')
   * @param slPrice The actual SL trigger price from HL (undefined if no SL on HL)
   * @param tpPrice The actual TP trigger price from HL (undefined if no TP on HL)
   */
  syncSLTPFromExchange(symbol: string, slPrice?: number, tpPrice?: number): void {
    const sym = normalizeSymbol(symbol);
    // v2.0.72: real positions live in realPositions
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(sym);
    if (!pos) return;

    const isLong = pos.side === 'buy';
    let validSL = slPrice;
    let validTP = tpPrice;

    // v2.0.55: Validate SL direction — must be on correct side of current price.
    // LONG: SL must be BELOW current price. SHORT: SL must be ABOVE current price.
    // If SL would trigger immediately, it's invalid — reject it.
    if (validSL !== undefined) {
      const slSafe = isLong ? validSL < pos.currentPrice : validSL > pos.currentPrice;
      if (!slSafe) {
        log.warn(`🚫 syncSLTPFromExchange: ${isLong ? 'LONG' : 'SHORT'} SL $${validSL.toFixed(2)} on wrong side of current price $${pos.currentPrice.toFixed(2)} for ${sym} — rejecting HL value, keeping local SL=$${pos.stopLossPrice?.toFixed(2) ?? 'none'}`);
        validSL = undefined;
      }
    }

    // v2.0.55: Validate TP direction — must be on profit side of entry.
    // LONG: TP must be ABOVE entry. SHORT: TP must be BELOW entry.
    if (validTP !== undefined) {
      const tpValid = isLong ? validTP > pos.averageEntryPrice : validTP < pos.averageEntryPrice;
      if (!tpValid) {
        log.warn(`🚫 syncSLTPFromExchange: ${isLong ? 'LONG' : 'SHORT'} TP $${validTP.toFixed(2)} on wrong side of entry $${pos.averageEntryPrice.toFixed(2)} for ${sym} — rejecting HL value, keeping local TP=$${pos.takeProfitPrice?.toFixed(2) ?? 'none'}`);
        validTP = undefined;
      }
    }

    let changed = false;
    if (validSL !== undefined && pos.stopLossPrice !== validSL) {
      pos.stopLossPrice = validSL;
      changed = true;
    }
    if (validTP !== undefined && pos.takeProfitPrice !== validTP) {
      pos.takeProfitPrice = validTP;
      changed = true;
    }
    if (changed) {
      pos.updatedAt = Date.now();
      log.info(`🔄 SL/TP synced from HL for ${sym}: SL=${validSL?.toFixed(2) ?? '-'} TP=${validTP?.toFixed(2) ?? '-'}`);
    }

    // v2.0.56: Auto-correct inverted SL/TP in the local mirror.
    // If the local mirror's SL/TP are on the WRONG side (would trigger immediately
    // or are on the wrong side of entry), they were corrupted by a previous bug.
    // Recalculate correct SL/TP from config percentages and overwrite.
    // This runs every cycle via syncSLTP(), so corrupted values are fixed
    // automatically without manual intervention.
    this.correctInvertedSLTP(sym);
  }

  /**
   * v2.0.56: Detect and correct inverted SL/TP in the local mirror.
   *
   * Previous bugs (v2.0.47-v2.0.55) could write inverted SL/TP to the local
   * mirror — e.g. a SHORT position with SL below current price (LONG direction)
   * and TP above entry (LONG direction). These values would trigger immediately
   * if pushed to HL, or cause the UI to show nonsensical SL/TP.
   *
   * This method checks if the local SL/TP are on the correct side for the
   * position's direction. If not, it recalculates from config percentages:
   *   LONG: SL = entry × (1 - stopLossPct), TP = entry × (1 + takeProfitPct)
   *   SHORT: SL = entry × (1 + stopLossPct), TP = entry × (1 - takeProfitPct)
   *
   * This is a SELF-HEALING mechanism — corrupted values are automatically
   * corrected every cycle without manual intervention.
   */
  private correctInvertedSLTP(sym: string): void {
    // v2.0.72: real positions live in realPositions
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(sym);
    if (!pos) return;

    const isLong = pos.side === 'buy';
    let needsCorrection = false;
    const slPct = config.risk.stopLossPct;
    const tpPct = config.risk.takeProfitPct;

    // v2.0.58: Check if SL is MISSING — real positions must always have SL/TP.
    // This happens when a position is restored from portfolio-state.json without
    // SL/TP values (e.g. imported via exchange sync but never had defaults set).
    if (pos.stopLossPrice === undefined) {
      log.warn(`🔧 correctInvertedSLTP: ${isLong ? 'LONG' : 'SHORT'} ${sym} has NO stop-loss — setting default`);
      needsCorrection = true;
    } else {
      // Check if SL is on the wrong side of current price (would trigger immediately)
      const slSafe = isLong ? pos.stopLossPrice < pos.currentPrice : pos.stopLossPrice > pos.currentPrice;
      if (!slSafe) {
        log.warn(`🔧 correctInvertedSLTP: ${isLong ? 'LONG' : 'SHORT'} ${sym} SL $${pos.stopLossPrice.toFixed(2)} on wrong side of current price $${pos.currentPrice.toFixed(2)} — recalculating`);
        needsCorrection = true;
      }
    }

    // v2.0.58: Check if TP is MISSING
    if (pos.takeProfitPrice === undefined) {
      log.warn(`🔧 correctInvertedSLTP: ${isLong ? 'LONG' : 'SHORT'} ${sym} has NO take-profit — setting default`);
      needsCorrection = true;
    } else {
      // Check if TP is on the wrong side of entry (wrong profit direction)
      const tpValid = isLong ? pos.takeProfitPrice > pos.averageEntryPrice : pos.takeProfitPrice < pos.averageEntryPrice;
      if (!tpValid) {
        log.warn(`🔧 correctInvertedSLTP: ${isLong ? 'LONG' : 'SHORT'} ${sym} TP $${pos.takeProfitPrice.toFixed(2)} on wrong side of entry $${pos.averageEntryPrice.toFixed(2)} — recalculating`);
        needsCorrection = true;
      }
    }

    if (needsCorrection) {
      // Recalculate correct SL/TP from config percentages
      const newSL = isLong
        ? pos.averageEntryPrice * (1 - slPct)
        : pos.averageEntryPrice * (1 + slPct);
      const newTP = isLong
        ? pos.averageEntryPrice * (1 + tpPct)
        : pos.averageEntryPrice * (1 - tpPct);

      pos.stopLossPrice = newSL;
      pos.takeProfitPrice = newTP;
      pos.updatedAt = Date.now();
      log.info(`🔧 correctInvertedSLTP: ${sym} SL/TP corrected → SL=$${newSL.toFixed(2)} TP=$${newTP.toFixed(2)} (was inverted)`);
    }
  }

  /**
   * Reconcile the local portfolio against externally-known open positions.
   *
   * Detects positions that exist in the local tracker but have been manually
   * closed (paper-trade) or are no longer on the exchange (real-trade).
   * Uses the exchange/manager's getOpenPositionSymbols() to know what SHOULD be open.
   *
   * For each phantom position detected: closes it at the current mark price
   * to preserve system P&L integrity, then logs the reconciliation.
   *
   * @param getExternalOpenSymbols A callback that returns symbols open on-exchange
   * @returns Array of symbols that were reconciled (closed locally)
   */
  reconcilePositions(externalOpenSymbols: string[]): string[] {
    const reconciled: string[] = [];
    const externalSet = new Set(externalOpenSymbols.map(s => normalizeSymbol(s)));

    // v2.0.33: API-failure guard — if externalOpenSymbols is empty but we have
    // real (exchange-imported) positions locally, do NOT reconcile. An empty
    // external list likely means getPositions() failed (429, timeout, etc.),
    // not that all positions were closed. Reconciling would create phantom
    // close records for positions that are still open on HL.
    // v2.0.72: real positions now live in realPositions
    const hasRealPositions = this.realPositions.size > 0;
    if (externalSet.size === 0 && hasRealPositions) {
      log.warn(`⚠️ reconcilePositions: externalOpenSymbols is empty but real positions exist locally — likely API failure, skipping reconciliation to prevent phantom closes`);
      return [];
    }

    // v2.0.72: reconcile both real and paper positions
    const allSymbols = Array.from(new Set([
      ...this.realPositions.keys(),
      ...this.portfolio.positions.keys(),
    ]));
    for (const localSymbol of allSymbols) {
      if (!externalSet.has(localSymbol)) {
        // This position exists locally but NOT externally → manually closed
        const pos = this.realPositions.get(localSymbol) ?? this.portfolio.positions.get(localSymbol);
        if (!pos) continue;
        log.warn(`🔍 Reconciliation: ${localSymbol} not found externally. Closing local mirror @ $${pos.currentPrice.toFixed(2)}`);
        // v2.0.32: Use closeExchangePosition() for exchange-imported positions
        // (doesn't add margin back to balance — importExchangePosition didn't deduct it).
        // Use closePosition() for paper positions (margin was deducted at open).
        const trade = pos.agentId === 'hyperliquid-real'
          ? this.closeExchangePosition(localSymbol, pos.currentPrice)
          : this.closePosition(localSymbol, pos.currentPrice);
        if (trade) {
          reconciled.push(localSymbol);
          log.info(`  → Reconciled ${localSymbol}: PnL $${trade.pnl.toFixed(2)}`);
        }
      }
    }
    return reconciled;
  }

  closePosition(symbol: string, exitPrice: number): TradeRecord | null {
    const pos = this.portfolio.positions.get(symbol);
    if (!pos) return null;

    // v2.0.33: Defensive guard — real positions (agentId='hyperliquid-real')
    // must NEVER be closed via closePosition(). closePosition() adds margin
    // back to paper balance and updates paper stats — wrong for real positions
    // where margin was never deducted from paper balance. Redirect to
    // closeExchangePosition() which only produces a trade record + learning
    // without touching paper balance/stats.
    if (pos.agentId === 'hyperliquid-real') {
      log.warn(`⚠️ closePosition() called on real position ${symbol} — redirecting to closeExchangePosition() to prevent balance inflation`);
      return this.closeExchangePosition(symbol, exitPrice);
    }

    const lev = pos.leverage ?? 1;
    let realizedPnl: number;
    let cashReturned: number;
    // v2.0.63: Return MARGIN (notional / leverage), not full notional.
    // openPosition() deducts margin (notional / leverage), so closePosition()
    // must return the same amount. The old code returned full notional,
    // which inflated balance by (notional - margin) = notional × (1 - 1/lev)
    // on every close — at 10x leverage, this added 9× the margin back.
    const notional = pos.averageEntryPrice * pos.quantity;
    const margin = notional / lev;
    // v2.0.48: PnL = priceDelta * quantity (NOT * leverage).
    if (pos.side === 'buy') {
      realizedPnl = (exitPrice - pos.averageEntryPrice) * pos.quantity;
      cashReturned = margin + realizedPnl;
      this.portfolio.balance += cashReturned;
    } else {
      // Short: profit when exit < entry
      realizedPnl = (pos.averageEntryPrice - exitPrice) * pos.quantity;
      cashReturned = margin + realizedPnl;
      this.portfolio.balance += cashReturned;
    }

    // ── v2.0.18: Deduct exit taker fee (notional-based) ──
    // HL taker fee = 0.04% of NOTIONAL at exit. notional = exitPrice × quantity.
    // v2.0.48: Notional is NOT leveraged — fee is on raw position value.
    const exitNotional = exitPrice * pos.quantity;
    const exitFee = calculateTakerFee(exitNotional);
    this.portfolio.balance -= exitFee;
    // v2.0.78: realizedPnl must reflect TRUE net PnL (priceDelta − entryFee − exitFee).
    // entryFee was already deducted from balance at openPosition() time, so
    // balance arithmetic is correct. But realizedPnl (used for the trade record,
    // totalPnl, win/loss stats, dailyPnl, and the entire learning pipeline) only
    // subtracted exitFee — overstating by entryFee every close. This made
    // totalPnl diverge from (balance − initialBalance) by cumulative entryFees.
    const entryFee = pos.entryFee ?? 0;
    realizedPnl = realizedPnl - entryFee - exitFee;

    // Track P&L as a percentage of margin used (return on capital at risk)
    const marginUsed = margin;

    const trade: TradeRecord = {
      id: uuidv4(),
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.averageEntryPrice,
      exitPrice,
      quantity: pos.quantity,
      leverage: lev,
      investment: margin,
      pnl: realizedPnl,
      pnlPct: marginUsed > 0 ? realizedPnl / marginUsed : 0,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      agentId: pos.agentId,
      status: 'closed',
      // v2.0.138: capture frozen entryThesis for EXP thesis-experience memory
      entryThesis: pos.entryThesis,
    };

    // Update portfolio stats
    this.portfolio.positions.delete(symbol);
    this.portfolio.totalPnl += realizedPnl;
    this.portfolio.totalPnlPct = this.portfolio.totalPnl / this.portfolio.initialBalance;

    if (realizedPnl >= 0) {
      this.portfolio.winCount++;
    } else {
      this.portfolio.lossCount++;
    }
    this.portfolio.tradeCount = this.portfolio.winCount + this.portfolio.lossCount;

    // v2.0.23: auto-reset dailyPnl on calendar date change before accumulating.
    this.checkDailyReset();
    this.portfolio.dailyPnl += realizedPnl;
    this.recalculateEquity();
    log.info(`Position closed: ${pos.side.toUpperCase()} ${pos.symbol} PnL: ${realizedPnl.toFixed(2)}`);

    // Notify subscriber (PaperTradingEngine) so the trade is captured in its trades[]
    if (this.onPositionClosedCb) {
      this.onPositionClosedCb(trade);
    }

    return trade;
  }

  /**
   * v2.0.32: Close an exchange-imported position and produce a trade record
   * WITHOUT adding margin back to balance (because importExchangePosition
   * didn't deduct margin). Only adds realized PnL to balance + produces
   * trade record + triggers learning mechanisms.
   * Used by syncExchangePositions() when HL SL/TP trigger closes a position.
   */
  closeExchangePosition(symbol: string, exitPrice: number, hlRealizedPnl?: number): TradeRecord | null {
    // v2.0.72: real positions live in realPositions
    const sym = normalizeSymbol(symbol);
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(symbol);
    if (!pos) return null;

    // v2.0.66: DEDUP — if this position was already closed within CLOSE_DEDUP_TTL_MS,
    // skip creating a duplicate trade record. Reconciliation fires multiple times
    // per cycle (syncExchangePositions + paper mode cleanup + per-symbol loop),
    // and each path may detect the same position as "closed on HL".
    // Use (normalizedSymbol, entryPrice) as key — same symbol can have multiple
    // positions with different entry prices, and we only want to dedup the SAME one.
    const dedupKey = `${normalizeSymbol(symbol)}:${pos.averageEntryPrice.toFixed(2)}`;
    const lastClose = this.recentlyClosedSyms.get(dedupKey);
    if (lastClose && (Date.now() - lastClose) < this.CLOSE_DEDUP_TTL_MS) {
      log.info(`⏭️ closeExchangePosition dedup: ${symbol} @ $${pos.averageEntryPrice.toFixed(2)} already closed ${Date.now() - lastClose}ms ago — skipping duplicate`);
      // Still delete the position from the map (it's gone from HL)
      this.realPositions.delete(sym);
      this.portfolio.positions.delete(symbol);
      return null;
    }
    this.recentlyClosedSyms.set(dedupKey, Date.now());

    const lev = pos.leverage ?? 1;
    const margin = pos.averageEntryPrice * pos.quantity;
    let realizedPnl: number;

    if (hlRealizedPnl !== undefined) {
      // v2.0.32: Use HL's actual realized PnL (already calculated by the exchange,
      // includes all fees/funding). This is the real money gained/lost.
      // HL PnL = (exitPrice - entryPrice) × quantity (NO leverage multiplier).
      // The leverage affects margin requirement, not PnL per unit.
      realizedPnl = hlRealizedPnl;
    } else {
      // Fallback: calculate ourselves (without leverage multiplier — HL PnL
      // is not leveraged, it's the raw price difference × quantity)
      if (pos.side === 'buy') {
        realizedPnl = (exitPrice - pos.averageEntryPrice) * pos.quantity;
      } else {
        realizedPnl = (pos.averageEntryPrice - exitPrice) * pos.quantity;
      }
      // Deduct exit taker fee (notional-based, NOT leveraged)
      const exitNotional = exitPrice * pos.quantity;
      const exitFee = calculateTakerFee(exitNotional);
      realizedPnl -= exitFee;
    }

    // v2.0.32: Do NOT add PnL to paper balance — this is a REAL exchange
    // position. Its PnL is settled on HL, not in the paper portfolio.
    // Adding it here would inflate the paper balance with real trade PnL.
    // The trade record is still produced for learning + UI display.

    const trade: TradeRecord = {
      id: uuidv4(),
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.averageEntryPrice,
      exitPrice,
      quantity: pos.quantity,
      leverage: lev,
      investment: margin,
      pnl: realizedPnl,
      pnlPct: margin > 0 ? realizedPnl / margin : 0,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      agentId: pos.agentId,
      status: 'closed',
      // v2.0.138: capture frozen entryThesis for EXP thesis-experience memory
      entryThesis: pos.entryThesis,
    };

    // v2.0.32: Do NOT update paper portfolio stats (totalPnl, winCount,
    // lossCount, dailyPnl) — this is a REAL exchange position. Its PnL
    // should not affect paper portfolio statistics. Only delete the
    // position + produce trade record + trigger learning.
    // v2.0.72: delete from realPositions (separate store)
    this.realPositions.delete(sym);
    this.portfolio.positions.delete(symbol);
    // No recalculateEquity — real positions don't affect paper equity.
    // v2.0.35: Store the closed real trade so the UI Trade Records panel
    // can display it with accurate exit price + PnL. Previously this trade
    // was only used for learning — never stored, so the UI never showed
    // the close (the position just disappeared with no trace).
    this.closedRealTrades.push(trade);
    // Cap at 200 to avoid unbounded memory growth
    if (this.closedRealTrades.length > 200) {
      this.closedRealTrades.splice(0, this.closedRealTrades.length - 200);
    }
    log.info(`Exchange position closed: ${pos.side.toUpperCase()} ${pos.symbol} PnL: ${realizedPnl.toFixed(2)} (real trade, no paper balance/stats impact)`);

    // v2.0.32: Trigger learning callback directly (NOT onPositionClosedCb).
    // onPositionClosedCb pushes the trade into paperEngine.trades[] which
    // is for PAPER trades only. Real trades should NOT appear in the paper
    // trade list. But we still need to trigger learning (RBC, pattern
    // classifier, agent outcomes, evolution) from real trade outcomes.
    if (this.onExchangeClosedLearningCb) {
      this.onExchangeClosedLearningCb(trade);
    }

    // v2.0.33: Fire UI callback so index.ts can immediately pushToAPI() +
    // refresh cachedHLFills — the UI updates instantly without waiting for
    // the next cycle.
    if (this.onExchangeClosedUICb) {
      this.onExchangeClosedUICb();
    }

    return trade;
  }

  getAllTrades(): TradeRecord[] {
    // In a real system, store trades in a DB. For now, return empty.
    return [];
  }

  private checkPositionExits(pos: Position): void {
    if (pos.side === 'buy') {
      if (pos.stopLossPrice && pos.currentPrice <= pos.stopLossPrice) {
        log.warn(`Stop-loss triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
      if (pos.takeProfitPrice && pos.currentPrice >= pos.takeProfitPrice) {
        log.info(`Take-profit triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
    } else {
      if (pos.stopLossPrice && pos.currentPrice >= pos.stopLossPrice) {
        log.warn(`Stop-loss triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
      if (pos.takeProfitPrice && pos.currentPrice <= pos.takeProfitPrice) {
        log.info(`Take-profit triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
    }
  }

  private recalculateEquity(): void {
    let unrealizedSum = 0;
    let lockedMargin = 0;
    // v2.0.72: portfolio.positions now contains ONLY paper positions.
    // Real positions live in realPositions and never affect paper equity.
    for (const pos of this.portfolio.positions.values()) {
    // v2.0.63: lockedMargin = margin (notional / leverage), not full notional.
    // openPosition() deducts margin from balance, so equity adds it back.
    // Using full notional here would inflate equity by (notional - margin).
    unrealizedSum += pos.unrealizedPnl;
    lockedMargin += (pos.averageEntryPrice * pos.quantity) / (pos.leverage ?? 1);
    }

    // totalEquity = available balance + unrealized PnL + locked margin on open positions
    // (margin was deducted from balance at open but is still owned — it's collateral)
    this.portfolio.totalEquity = this.portfolio.balance + unrealizedSum + lockedMargin;

    // Update peak equity and drawdown
    if (this.portfolio.totalEquity > this.portfolio.peakEquity) {
      this.portfolio.peakEquity = this.portfolio.totalEquity;
    }

    const currentDrawdown = this.portfolio.peakEquity - this.portfolio.totalEquity;
    const currentDrawdownPct = this.portfolio.peakEquity > 0 ? currentDrawdown / this.portfolio.peakEquity : 0;

    // v2.0.42: currentDrawdownPct tracks the CURRENT drawdown from peak.
    // It decreases when equity recovers — used by canTrade() + SystemGuard.
    this.portfolio.currentDrawdownPct = currentDrawdownPct;

    // maxDrawdown/maxDrawdownPct are high-water marks (only increase).
    // Kept for historical reporting — NOT used for trading decisions.
    if (currentDrawdown > this.portfolio.maxDrawdown) {
      this.portfolio.maxDrawdown = currentDrawdown;
      this.portfolio.maxDrawdownPct = currentDrawdownPct;
    }

    this.portfolio.lastUpdated = Date.now();
  }

  resetDailyPnl(): void {
    this.portfolio.dailyPnl = 0;
    this.portfolio.dailyPnlResetDate = this.todayString();
  }

  /**
   * v2.0.45: Clear all drawdown data so the system can relaunch trading
   * after a drawdown circuit breaker (≥15%) has blocked cycles.
   *
   * Resets:
   *   - peakEquity → current totalEquity (so drawdown = 0%)
   *   - currentDrawdownPct → 0
   *   - maxDrawdown / maxDrawdownPct → 0 (historical high-water mark cleared)
   *   - dailyPnl → 0 (clears daily loss limit block)
   *
   * After this call, the next decision cycle will pass the SystemGuard
   * drawdown check and resume normal trading.
   */
  clearDrawdown(): void {
    this.portfolio.peakEquity = this.portfolio.totalEquity;
    this.portfolio.currentDrawdownPct = 0;
    this.portfolio.maxDrawdown = 0;
    this.portfolio.maxDrawdownPct = 0;
    this.portfolio.dailyPnl = 0;
    this.portfolio.dailyPnlResetDate = this.todayString();
    this.portfolio.lastUpdated = Date.now();
    log.info('🔄 Drawdown cleared — peakEquity reset to current equity, dailyPnl reset to 0. Trading can resume.');
  }

  /**
   * v2.0.23: Auto-reset dailyPnl when the calendar date changes.
   * Called from canTrade() and closePosition() so the reset happens
   * at the first trade/PnL event of each new day — no external scheduler
   * needed. Previously resetDailyPnl() was never called, so dailyPnl
   * accumulated across ALL days since system start, causing false
   * "daily loss limit reached" blocks even on profitable days.
   */
  checkDailyReset(): void {
    const today = this.todayString();
    if (this.portfolio.dailyPnlResetDate !== today) {
      if (this.portfolio.dailyPnlResetDate !== undefined) {
        log.info(`📅 Daily PnL reset: ${this.portfolio.dailyPnlResetDate} → ${today} (was ${this.portfolio.dailyPnl >= 0 ? '+' : ''}${this.portfolio.dailyPnl.toFixed(2)})`);
      }
      this.portfolio.dailyPnl = 0;
      this.portfolio.dailyPnlResetDate = today;
    }
  }

  private todayString(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }
}