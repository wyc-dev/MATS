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
function normalizeSymbol(symbol: string): string {
  return symbol.includes(':') ? symbol : symbol.toLowerCase();
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
        this.portfolio.positions.set(normSym, {
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
        });
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
    const positions = Array.from(this.portfolio.positions.values()).map(p => ({
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
    return this.portfolio.positions.has(normalizeSymbol(symbol));
  }

  getPosition(symbol: string): Position | undefined {
    return this.portfolio.positions.get(normalizeSymbol(symbol));
  }

  /**
   * v2.0.32: Remove a position from the local portfolio WITHOUT recording
   * a trade or adjusting balance. Used by syncExchangePositions() when the
   * exchange position has fundamentally changed (side flip, qty change) and
   * the old mirror needs to be replaced with a fresh import.
   */
  removePosition(symbol: string): void {
    const sym = normalizeSymbol(symbol);
    this.portfolio.positions.delete(sym);
    this.recalculateEquity();
  }

  /** Get all open symbols for reconciliation checks */
  getOpenSymbols(): string[] {
    return Array.from(this.portfolio.positions.keys());
  }

  getPositionCount(): number {
    return this.portfolio.positions.size;
  }

  canTrade(): { allowed: boolean; reason?: string } {
    // v2.0.23: auto-reset dailyPnl on calendar date change.
    this.checkDailyReset();

    if (this.portfolio.maxDrawdownPct >= config.paper.maxDrawdownPct) {
      return {
        allowed: false,
        reason: `Max drawdown ${(this.portfolio.maxDrawdownPct * 100).toFixed(1)}% exceeded. Trading halted.`,
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

  openPosition(order: Order, entryPrice: number, leverage = 1): Position {
    const symbol = normalizeSymbol(order.symbol);
    const quantity = order.filledQuantity > 0 ? order.filledQuantity : order.quantity;
    const cost = quantity * entryPrice;

    // Deduct margin from balance.
    this.portfolio.balance -= cost;

    // ── v2.0.18: Deduct entry taker fee (notional-based) ──
    // HL taker fee = 0.04% of NOTIONAL (leveraged value), not margin.
    // notional = entryPrice × quantity × leverage.
    // At 10x leverage this is 0.4% of margin per side; at 100x it's 4%.
    // Deducting this from balance ensures paper PnL reflects the real cost
    // of entering a leveraged position, so the system only learns strategies
    // that are profitable AFTER fees — critical for competing in an uneven
    // market where we can't out-speed or out-news institutional quants.
    const entryNotional = cost * leverage;
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
    const position: Position = {
      id: uuidv4(),
      symbol,
      side: order.side,
      quantity,
      averageEntryPrice: entryPrice,
      currentPrice: entryPrice,
      unrealizedPnl: -entryFee,
      unrealizedPnlPct: cost > 0 ? -entryFee / cost : 0,
      realizedPnl: 0,
      leverage,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      agentId: order.agentId,
      exchange,
      entryFee,
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
      investment: cost,
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
      cost: cost.toFixed(2),
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
    const entryFee = pos.entryFee ?? 0;
    if (pos.side === 'buy') {
      pos.unrealizedPnl = (currentPrice - pos.averageEntryPrice) * pos.quantity * (pos.leverage ?? 1) - entryFee;
      pos.unrealizedPnlPct = ((currentPrice - pos.averageEntryPrice) / pos.averageEntryPrice) * (pos.leverage ?? 1) - (pos.averageEntryPrice * pos.quantity > 0 ? entryFee / (pos.averageEntryPrice * pos.quantity) : 0);
    } else {
      pos.unrealizedPnl = (pos.averageEntryPrice - currentPrice) * pos.quantity * (pos.leverage ?? 1) - entryFee;
      pos.unrealizedPnlPct = ((pos.averageEntryPrice - currentPrice) / pos.averageEntryPrice) * (pos.leverage ?? 1) - (pos.averageEntryPrice * pos.quantity > 0 ? entryFee / (pos.averageEntryPrice * pos.quantity) : 0);
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
   */
  softUpdatePosition(symbol: string, currentPrice: number): void {
    const pos = this.portfolio.positions.get(symbol);
    if (!pos) return;

    pos.currentPrice = currentPrice;
    pos.updatedAt = Date.now();

    // v2.0.19: include the entry fee already paid (same as updatePosition).
    const entryFee = pos.entryFee ?? 0;
    if (pos.side === 'buy') {
      pos.unrealizedPnl = (currentPrice - pos.averageEntryPrice) * pos.quantity * (pos.leverage ?? 1) - entryFee;
      pos.unrealizedPnlPct = ((currentPrice - pos.averageEntryPrice) / pos.averageEntryPrice) * (pos.leverage ?? 1) - (pos.averageEntryPrice * pos.quantity > 0 ? entryFee / (pos.averageEntryPrice * pos.quantity) : 0);
    } else {
      pos.unrealizedPnl = (pos.averageEntryPrice - currentPrice) * pos.quantity * (pos.leverage ?? 1) - entryFee;
      pos.unrealizedPnlPct = ((pos.averageEntryPrice - currentPrice) / pos.averageEntryPrice) * (pos.leverage ?? 1) - (pos.averageEntryPrice * pos.quantity > 0 ? entryFee / (pos.averageEntryPrice * pos.quantity) : 0);
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

    this.portfolio.positions.set(sym, position);
    this.recalculateEquity();
  }

  /**
   * Adjust stop-loss and/or take-profit for an existing position.
   * Called by meta-agent during HACP cycle for dynamic TP/SL management.
   * This is the extension point for real trading — same interface.
   */
  adjustPosition(positionId: string, newStopLoss?: number, newTakeProfit?: number): boolean {
    for (const [, pos] of this.portfolio.positions) {
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

        // ── Hard safety: validate SL direction ──
        // SL for LONG must be BELOW entry (loss side)
        // SL for SHORT must be ABOVE entry (loss side)
        const validatedSL = (() => {
          if (newStopLoss === undefined) return undefined;
          const slOk = isLong ? newStopLoss < pos.averageEntryPrice : newStopLoss > pos.averageEntryPrice;
          if (!slOk) {
            log.warn(`🚫 adjustPosition REJECTED: ${isLong ? 'LONG' : 'SHORT'} SL $${newStopLoss} on wrong side of entry $${pos.averageEntryPrice}. Ignoring.`);
            return undefined;
          }
          return newStopLoss;
        })();

        // v2.0.36: Minimum SL/TP gap constraint — if the gap between the
        // new SL and the existing/new TP is less than 1% of current price,
        // reject the adjustment. Over-narrowing causes noise stop-outs +
        // premature TP hits, cutting profits short.
        const effectiveSL = validatedSL ?? pos.stopLossPrice;
        const effectiveTP = validatedTP ?? pos.takeProfitPrice;
        if (effectiveSL !== undefined && effectiveTP !== undefined) {
          const sltpGap = Math.abs(effectiveTP - effectiveSL);
          const gapPct = pos.currentPrice > 0 ? sltpGap / pos.currentPrice : 0;
          if (gapPct < 0.01) {
            log.warn(`🚫 adjustPosition REJECTED: ${isLong ? 'LONG' : 'SHORT'} ${pos.symbol} SL/TP gap=$${sltpGap.toFixed(2)} (${(gapPct * 100).toFixed(2)}%) < 1% minimum — keeping wider SL/TP to avoid noise stop-out`);
            return false;
          }
        }

        if (validatedSL !== undefined) {
          pos.stopLossPrice = validatedSL;
        }
        if (validatedTP !== undefined) {
          pos.takeProfitPrice = validatedTP;
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
    const hasRealPositions = Array.from(this.portfolio.positions.values())
      .some(p => p.agentId === 'hyperliquid-real');
    if (externalSet.size === 0 && hasRealPositions) {
      log.warn(`⚠️ reconcilePositions: externalOpenSymbols is empty but real positions exist locally — likely API failure, skipping reconciliation to prevent phantom closes`);
      return [];
    }

    for (const localSymbol of this.portfolio.positions.keys()) {
      if (!externalSet.has(localSymbol)) {
        // This position exists locally but NOT externally → manually closed
        const pos = this.portfolio.positions.get(localSymbol)!;
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
    // Margin capital at risk = entryPrice * quantity
    const margin = pos.averageEntryPrice * pos.quantity;
    if (pos.side === 'buy') {
      // Leveraged P&L = (exit - entry) * quantity * leverage
      realizedPnl = (exitPrice - pos.averageEntryPrice) * pos.quantity * lev;
      cashReturned = margin + realizedPnl;
      this.portfolio.balance += cashReturned;
    } else {
      // Short: profit when exit < entry
      realizedPnl = (pos.averageEntryPrice - exitPrice) * pos.quantity * lev;
      cashReturned = margin + realizedPnl;
      this.portfolio.balance += cashReturned;
    }

    // ── v2.0.18: Deduct exit taker fee (notional-based) ──
    // HL taker fee = 0.04% of NOTIONAL at exit. notional = exitPrice × quantity × leverage.
    // Deduct from balance AND from realizedPnl so both the account and the
    // trade record reflect the real cost. Combined with the entry fee, a
    // round-trip costs 0.08% of notional = 0.8% of margin at 10x, 8% at 100x.
    const exitNotional = exitPrice * pos.quantity * lev;
    const exitFee = calculateTakerFee(exitNotional);
    this.portfolio.balance -= exitFee;
    realizedPnl -= exitFee;

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
    const pos = this.portfolio.positions.get(symbol);
    if (!pos) return null;

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
    };

    // v2.0.32: Do NOT update paper portfolio stats (totalPnl, winCount,
    // lossCount, dailyPnl) — this is a REAL exchange position. Its PnL
    // should not affect paper portfolio statistics. Only delete the
    // position + produce trade record + trigger learning.
    this.portfolio.positions.delete(symbol);
    this.recalculateEquity();
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
    for (const pos of this.portfolio.positions.values()) {
      // v2.0.33: Do NOT include real (exchange) positions in paper equity.
      // Real position margin was never deducted from paper balance
      // (importExchangePosition doesn't deduct), so adding lockedMargin
      // back would inflate the paper equity. Real position PnL is settled
      // on HL, not in the paper portfolio.
      if (pos.agentId === 'hyperliquid-real') continue;
      unrealizedSum += pos.unrealizedPnl;
      lockedMargin += pos.averageEntryPrice * pos.quantity;
    }

    // totalEquity = available balance + unrealized PnL + locked margin on open positions
    // (margin was deducted from balance at open but is still owned — it's collateral)
    this.portfolio.totalEquity = this.portfolio.balance + unrealizedSum + lockedMargin;

    // Update peak equity and drawdown
    if (this.portfolio.totalEquity > this.portfolio.peakEquity) {
      this.portfolio.peakEquity = this.portfolio.totalEquity;
    }

    const currentDrawdown = this.portfolio.peakEquity - this.portfolio.totalEquity;
    const currentDrawdownPct = currentDrawdown / this.portfolio.peakEquity;

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