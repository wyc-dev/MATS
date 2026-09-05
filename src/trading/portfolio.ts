// ─── Portfolio Tracker ───
// Tracks portfolio state, positions, P&L, drawdown calculations

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import { loadPortfolio, type PortfolioSnapshot } from '../evolution/persistence.ts';
import { calculateTakerFee } from './cost-model.ts';
import { computeSLTP, recomputePnL, trackMAEMFE, safeLeverage, safePrice, safeQuantity } from './position-utils.ts';
import type {
  Portfolio,
  Position,
  Order,
  TradeRecord,
  OrderSide,
  Ticker,
  EntryFeatures,
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
  // v2.0.869-P7: null/undefined/non-string → '' (never crash). HL WS push or
  // corrupted persistence can inject a non-string symbol; symbol.includes would
  // throw TypeError and kill the whole mark-price polling loop.
  if (typeof symbol !== 'string' || symbol.length === 0) return '';
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
  // v2.0.221 (Fix #7): Catch LLM-generated placeholder theses that pass the old
  // check because "thesis", "market", "win", "loss", "noise", "invalidation",
  // "profitable" are real words with 3+ letters. These are the exact patterns
  // the audit found in 81% of records. Match the full thesis string (after
  // stripping timeframe labels + punctuation) against known placeholder patterns.
  const strippedForPattern = t
    .replace(/\[(1h|1d|4h|1w|1m|5m|15m)\s*:/g, ' ')
    .replace(/[\[\]():,.\-—_/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const PLACEHOLDER_PATTERNS = [
    'thesis', 'market win', 'market loss', 'market win 1', 'market win 2',
    'noise invalidation', 'profitable invalidation', 'market win 3',
    'market loss 1', 'market loss 2', 'test', 'momentum',
  ];
  if (PLACEHOLDER_PATTERNS.includes(strippedForPattern)) return true;
  // v2.0.221 (Fix #7b): Single-word theses with no numbers/edge are placeholders.
  // A real thesis must contain at least one numeric/quantitative element (price
  // level, percentage, edge magnitude, bps, etc.) or be multi-word. "[1h: test]"
  // or "[1h: momentum]" are single words with no edge — not a real thesis.
  const wordCount = strippedForPattern.split(/\s+/).filter((w) => w.length > 0).length;
  const hasNumber = /\d/.test(strippedForPattern);
  if (wordCount <= 2 && !hasNumber) return true;
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

/**
 * v2.0.855-attack: Whitelist for closeReason values. A caller-supplied reason
 * that is NOT in this set (typo 'thesis_invalid', empty string '', garbage,
 * NaN) MUST be rejected — otherwise `closeReason ?? inferCloseReason()` lets
 * '' through ('' ?? x === '') and computeLearningWeight falls through to
 * default 1.0, silently inflating a 0.3× thesis_invalidation close to full
 * weight (3.3× error). Returns undefined for invalid input so the caller
 * falls back to deterministic inference.
 */
export const VALID_CLOSE_REASONS = new Set([
  'sl_tp',
  'tp_hit', // v2.0.868-fix(主神 SKHX 調查):TP 觸發分開——之前同 SL 共用 'sl_tp' 誤導
  'consensus',
  'consensus_reversal', // v2.0.870-P47: 共識反轉離場(系統判斷趨勢反轉)
  'manual',
  'reconciliation',
  'exchange_closed',
  'thesis_invalidation',
  // v2.0.862: data-driven lock-profit close — PAEL MFE extension check reached
  // the asset's typical favourable-extension zone (TP side one-vote exit).
  'exit_price_lock',
  'profit_lock',
  // v2.0.869-P15: regime-reversal lock-profit close — MFE ≥ 1.5×ATR AND
  // regime reversed (P(win) < 0.5). System decision at the regime-flip sweet spot.
  'regime_reversal_lock',
  // v2.0.870-P78-E1: reversal-point structure exit — reversal score ≥ 0.7 HIGH
  // + position underwater. Structure-first (ATH/ATL pullback, candle shape),
  // complements consensus_reversal (LLM consensus, slower).
  'reversal_point',
  // v2.0.873-P9-edt（Phase A 2026-08-30）: reversal-point 止血離場獨立標籤——
  // 舊版 reversal_point 同時用於「鎖利」同「止血」（標籤分裂——歸因層無法分辨
  // 過早鎖利 vs 正確止蝕）。統一: 鎖利 → exit_price_lock, 止血 → reversal_point_exit。
  'reversal_point_exit',
] as const);

/**
 * v2.0.855-attack: Sanitize a caller-supplied closeReason against the
 * whitelist. Non-string, empty, unknown, or non-finite values → undefined
 * (fall back to inference). This closes the '' / typo / garbage injection.
 */
export function sanitizeCloseReason(reason: unknown): TradeRecord['closeReason'] | undefined {
  if (typeof reason !== 'string' || reason.length === 0) return undefined;
  // Cast through the non-optional union — VALID_CLOSE_REASONS is the
  // canonical set, and TradeRecord['closeReason'] includes `undefined`
  // (optional field) which Set.has() rejects at the type level.
  const r = reason as Exclude<TradeRecord['closeReason'], undefined>;
  if (!VALID_CLOSE_REASONS.has(r)) return undefined;
  return r;
}

/**
 * v2.0.851: Infer the CLOSE REASON for a position being closed, based on where
 * the exit price landed relative to the stop-loss / take-profit levels.
 *
 * This is the foundation for close-context-aware learning (v2.0.226) and the
 * RIL CloseReasonAggregator — without it, every TradeRecord has an undefined
 * `closeReason`, so:
 *   - `computeLearningWeight` falls back to 'sl_tp' for EVERY close (tight-SL
 *     losses are treated as full-weight real market losses, contaminating OLR)
 *   - the RIL "premature SL" warning never fires
 *   - the trade-audit cannot distinguish "SL too tight" from "thesis wrong"
 *
 * The inference is a best-effort DEFAULT only. Agent-driven closes (consensus,
 * manual, thesis-invalidation, reconciliation) pass an explicit closeReason
 * from the caller which OVERRIDES this inference (see closePosition /
 * closeExchangePosition). The SL/TP detection is deterministic:
 *   - exit at/beyond the SL level   → 'sl_tp' (stop-loss hit)
 *   - exit at/beyond the TP level   → 'sl_tp' (take-profit hit)
 *   - exit between SL and TP        → 'reconciliation' (position disappeared
 *     without a trigger order firing — e.g. manual UI close or exchange-side
 *     liquidation handled outside the SL/TP loop)
 *   - no SL/TP levels set           → 'reconciliation' (unprotected close)
 *
 * @param side       Position direction ('buy' or 'sell').
 * @param exitPrice  The fill price the position was closed at.
 * @param stopLoss   Final stop-loss price (undefined if none set).
 * @param takeProfit Final take-profit price (undefined if none set).
 * @returns The inferred close-reason string ('sl_tp' | 'reconciliation').
 */
export function inferCloseReason(
  side: 'buy' | 'sell',
  exitPrice: number,
  stopLoss?: number | null,
  takeProfit?: number | null,
): 'sl_tp' | 'tp_hit' | 'reconciliation' {
  // Defensive guard (v2.0.851-fix): an invalid exitPrice (NaN, Infinity,
  // zero, negative) means we CANNOT determine whether SL/TP was hit. Never
  // classify such a close as 'sl_tp' — return 'reconciliation' (unknown exit).
  // Without this, exitPrice=0 (corrupt data) or exitPrice=NaN would compare
  // against SL/TP and misclassify the close reason.
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return 'reconciliation';
  const validSL = typeof stopLoss === 'number' && Number.isFinite(stopLoss) && stopLoss > 0;
  const validTP = typeof takeProfit === 'number' && Number.isFinite(takeProfit) && takeProfit > 0;
  if (validSL && side === 'buy' && exitPrice <= stopLoss!) return 'sl_tp';
  if (validSL && side === 'sell' && exitPrice >= stopLoss!) return 'sl_tp';
  // v2.0.868-fix(主神 SKHX 調查):TP 觸發唔應該標記 'sl_tp'(誤導——主神見到
  // sl_tp 以為止蝕——但實際係 TP 取利)。分開 'tp_hit'——UI/TG 顯示 Take-profit
  if (validTP && side === 'buy' && exitPrice >= takeProfit!) return 'tp_hit';
  if (validTP && side === 'sell' && exitPrice <= takeProfit!) return 'tp_hit';
  return 'reconciliation';
}

/** v2.0.868-attack:local safeNum——NaN/undefined/Infinity → fallback(log 行 toFixed 硬化) */
function safeNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** v2.0.868-attack8+fix(主神 MAE 調查):close 時 min/max sanity。
 *   主神發現:state file 有大量污染 minValueReached(-0.55 負值、-48% 等)——
 *   restore/import 路徑冇 sanitize——污染值帶入新 trade(「MAE -49.9%」假象——
 *   price 根本冇跌到嗰個位——candle 驗證最低 973.7——要 895 先 -49.9%)。
 *   收緊:min 唔可以 < margin×0.6(跌 40% margin = price -8% at 5x——閃崩級——
 *   正常 MAE -5~-30%——低過 = 錯價污染)→ 重置為 margin。
 *   min > 3×margin(max 唔合理)→ 重置。 */
function sanitizeMinMax(pos: { minValueReached?: number; maxValueReached?: number }, margin: number): { min: number; max: number } {
  const safeMargin = Number.isFinite(margin) && margin > 0 ? margin : 0;
  const min = Number.isFinite(pos.minValueReached) && (pos.minValueReached as number) >= safeMargin * 0.6
    ? Math.min(pos.minValueReached as number, safeMargin > 0 ? safeMargin * 3 : Infinity)
    : safeMargin;
  const max = Number.isFinite(pos.maxValueReached) && (pos.maxValueReached as number) >= 0
    ? Math.max(pos.maxValueReached as number, safeMargin)
    : safeMargin;
  return { min, max };
}

/** v2.0.868-attack2:side 大小寫硬化——'BUY'/'buy'/'Long'/'long' 都係多頭。
 *  之前 `pos.side === 'buy'` 對 'BUY'(大寫)/'Long' 唔 match →
 *  方向計算反轉——買升變蝕、賣跌變賺——「TG 顯示賺/UI 顯示蝕」另一源頭。 */
function isBuySide(side: unknown): boolean {
  const s = String(side ?? '').toLowerCase();
  return s === 'buy' || s === 'long';
}

/**
 * v2.0.870-P19': spread-first restore helpers(根治「allowlist 重建蒸發欄位」bug 類)。
 *
 * 歷史病:restore mapping 用 allowlist 逐一 rebuild——每次新加欄位
 * (entryConsensusConfidence / regime / entryMarketFeatures / 將來任何嘢),
 * 唔記得入 allowlist 就喺 restart 靜默蒸發。實證:200/200 實倉 trade 冇
 * entryConsensusConfidence → LLMConvictionCalibrator 出世至今空腹死碼。
 *
 * 規則:原物件全部保留(spread first),必要 coercion 同 sanitizer override
 * 喺 spread 之後(順序反轉 = 污染復活,留意)。
 */
export function restoreClosedRealTradeRecord(t: Record<string, unknown>): TradeRecord {
  return {
    ...(t as object),
    id: t['id'],
    symbol: t['symbol'],
    side: t['side'],
    entryPrice: t['entryPrice'],
    exitPrice: t['exitPrice'],
    quantity: t['quantity'],
    leverage: t['leverage'],
    investment: t['investment'],
    pnl: t['pnl'],
    pnlPct: t['pnlPct'],
    openedAt: t['openedAt'],
    closedAt: t['closedAt'],
    agentId: (t['agentId'] as string | undefined) ?? '',
    status: ((t['status'] as string | undefined) ?? 'closed'),
  } as unknown as TradeRecord;
}

export function restoreRealPositionRecord(rp: Record<string, unknown>, normSym: string): Position {
  const margin = (safeNum(rp['averageEntryPrice'], 0) * safeNum(rp['quantity'], 0)) / safeLeverage((rp['leverage'] as number | undefined) ?? 1);
  return {
    ...(rp as object),
    id: rp['id'],
    symbol: normSym,
    side: rp['side'],
    quantity: rp['quantity'],
    averageEntryPrice: rp['averageEntryPrice'],
    currentPrice: rp['currentPrice'],
    unrealizedPnl: rp['unrealizedPnl'],
    unrealizedPnlPct: rp['unrealizedPnlPct'],
    realizedPnl: rp['realizedPnl'] ?? 0,
    stopLossPrice: rp['stopLossPrice'],
    takeProfitPrice: rp['takeProfitPrice'],
    leverage: rp['leverage'],
    openedAt: rp['openedAt'],
    updatedAt: rp['updatedAt'] ?? Date.now(),
    agentId: (rp['agentId'] as string | undefined) ?? 'hyperliquid-real',
    exchange: rp['exchange'],
    // sanitizer 必須排 spread 之後(P19-attack 原則)。
    // v2.0.870-P19'-fix2:sanitizeMinMax 返回 {min,max},舊代码直接 spread →
    // key 錯名,污染值照樣存活(v2.0.868「fix」自始失效)。依家正確映射。
    ...(() => {
      const mm = sanitizeMinMax(rp as { minValueReached?: number; maxValueReached?: number }, margin);
      return { minValueReached: mm.min, maxValueReached: mm.max };
    })(),
  } as unknown as Position;
}

/** attack-round7: shadowWinRateSource 白名單 sanitize——垃圾值/garbage → undefined（唔污染下游 'entry-snapshot'/'live-fallback' 判斷） */
function sanitizeShadowSource(v: unknown): 'entry-snapshot' | 'live-fallback' | undefined {
  return v === 'entry-snapshot' || v === 'live-fallback' ? v : undefined;
}

export class PortfolioTracker {
  private portfolio: Portfolio;
  /** Callback so PaperTradingEngine can capture trades from SL/TP closes */
  private onPositionClosedCb: OnPositionClosed | null = null;
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
  /**
   * Closed REAL (Hyperliquid) trade records — CLOSED trades only.
   *
   * ═══ 前文後理 (data provenance) ═══
   * - A trade enters this list ONLY when a real position is CLOSED
   *   (closeExchangePosition → closeTrade path). OPEN real positions live in
   *   `realPositions` and are NOT here.
   * - Their unrealized PnL is therefore NOT included in any sum of this
   *   list. To see current real-account profitability incl. open positions,
   *   use Hyperliquid accountValue (getBalance().total) — not this list.
   * - PnL here is REAL (actual HL fills), but the list is historical only.
   */
  private closedRealTrades: TradeRecord[] = [];
  /** v2.0.66: Dedup set — symbols that were recently closed via closeExchangePosition().
   *  Prevents duplicate trade records when reconciliation fires multiple times
   *  for the same position. TTL: 60 seconds (long enough to cover a full cycle). */
  private readonly recentlyClosedSyms: Map<string, number> = new Map();
  /** v2.0.71: Extended to 5min — syncExchangePositions re-imports positions
   *  within the same cycle after closeExchangePosition deletes them. */
  private readonly CLOSE_DEDUP_TTL_MS = 300_000;
  /**
   * v2.0.868: Reconciliation confirmation counter — 防幻影 close。
   * Root cause:「TG 顯示 GOLD 賺、UI 顯示蝕」——reconcilePositions 用單次
   * externalOpenSymbols 快照判斷「消失」——若該快照唔完整(HL API partial/
   * 延遲/DEX 查法錯)→ position 被誤判消失 → 幻影 close → 觸發 TG 訊號(假平倉)
   * → 之後 sync 又 re-import → 循環。HL position 實際一直 open。
   * 修復:position 要「連續 RECONCILIATION_CONFIRM_COUNT 次」都唔喺 external
   * 先真正 close——單次查錯唔再造成幻影。喺 external → reset 計數。
   */
  private readonly reconciliationMissingCounts: Map<string, number> = new Map();
  private static readonly RECONCILIATION_CONFIRM_COUNT = 2;

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
          // v2.0.143/870: MAE/MFE 由下面 sanitizer override(含 restore 污染重置)
          // v2.0.868-fix(主神 MAE 調查):restore 污染值(負值/-48%)帶入——
          // 用 margin 計算後 sanitize——重置污染 min/max
          // v2.0.870-P19'-fix2:sanitizeMinMax 返回 {min,max} 唔係
          // {minValueReached,maxValueReached}——舊寫法 spread 錯 key 名,
          // 污染值原樣存活。依家正確映射。
          ...(() => {
            const m = (safeNum((p as any).averageEntryPrice, 0) * safeNum((p as any).quantity, 0)) / safeLeverage((p as any).leverage ?? 1);
            const mm = sanitizeMinMax(p as { minValueReached?: number; maxValueReached?: number }, m);
            return { minValueReached: mm.min, maxValueReached: mm.max };
          })(),
          // v2.0.143: Restore original SL/TP for exitThesis narrowing analysis
          originalStopLossPrice: (p as any).originalStopLossPrice,
          originalTakeProfitPrice: (p as any).originalTakeProfitPrice,
        };
        // v2.0.72: route real positions to realPositions, paper to portfolio.positions
        if (p.agentId === 'hyperliquid-real') {
          this.realPositions.set(normSym, pos);
        } else {
          this.portfolio.positions.set(normSym, pos);
        }
      }

      // Restore trades
      // v2.0.870-P19': spread-first(同上,根治欄位蒸發)
      this.restoredTrades = (saved.trades ?? []).map(t => restoreClosedRealTradeRecord(t as unknown as Record<string, unknown>));

      // v2.0.38: Restore real (exchange) trades — these are HL SL/TP-triggered
      // closes + manual exchange closes. Stored separately from paper trades
      // so they survive restarts but don't pollute paper stats.
      // v2.0.870-P19': spread-first(規則化見 restoreClosedRealTradeRecord 註釋)
      const restoredRealTrades = (saved.realTrades ?? []).map(t => restoreClosedRealTradeRecord(t as unknown as Record<string, unknown>));
      this.closedRealTrades.push(...restoredRealTrades);
      if (restoredRealTrades.length > 0) {
        log.info(`📋 Restored ${restoredRealTrades.length} real (exchange) trade records`);
      }

      // v2.0.160: Restore real positions with thesis + MAE/MFE + SL/TP
      const restoredRealPositions = saved.realPositions ?? [];
      for (const rpRaw of restoredRealPositions) {
        const normSym = normalizeSymbol((rpRaw as { symbol: string }).symbol);
        // v2.0.870-P19': spread-first——allowlist 曾蒸發 entryConsensusConfidence/
        // regime/entryMarketFeatures;而家原欄位全保留,sanitize 喺 helper 內置後。
        const rp = rpRaw as unknown as Record<string, unknown>;
        if (!this.realPositions.has(normSym) && rp['symbol']) {
          this.realPositions.set(normSym, restoreRealPositionRecord(rp, normSym));
        }
      }
      if (restoredRealPositions.length > 0) {
        log.info(`📋 Restored ${restoredRealPositions.length} real positions with thesis + MAE/MFE`);
      }

      log.info(`Portfolio restored: balance=${saved.balance.toFixed(2)}, ${saved.positions?.length ?? 0} positions, ${saved.tradeCount} trades, ${restoredRealTrades.length} real trades, ${restoredRealPositions.length} real positions`);
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

  /** v2.0.153: Delete a single closed real trade by ID */
  deleteClosedRealTrade(tradeId: string): void {
    const idx = this.closedRealTrades.findIndex(t => t.id === tradeId);
    if (idx >= 0) {
      this.closedRealTrades.splice(idx, 1);
    }
  }

  /** v2.0.170: Update a single field on a closed real trade by ID.
   *  Allows the user to correct Entry Thesis / Exit Thesis / Post-Review
   *  so the evolution system learns from accurate data, not LLM mistakes. */
  updateClosedRealTradeField(tradeId: string, field: 'entryThesis' | 'exitThesis' | 'postReview', value: string): boolean {
    const trade = this.closedRealTrades.find(t => t.id === tradeId);
    if (!trade) return false;
    (trade as any)[field] = value;
    log.info(`✏️ Closed real trade ${tradeId} field '${field}' updated (${value.length} chars)`);
    return true;
  }

  /** v2.0.158: Purge all closed real trades without entry thesis */
  purgeClosedRealTradesWithoutThesis(): number {
    const before = this.closedRealTrades.length;
    this.closedRealTrades = this.closedRealTrades.filter(t => t.entryThesis && t.entryThesis.trim().length > 0);
    return before - this.closedRealTrades.length;
  }

  getPortfolio(): Readonly<Portfolio> {
    return this.portfolio;
  }

  /** Get portfolio data for persistence (serializable format) */
  getPortfolioSnapshot(): import('../evolution/persistence.ts').PortfolioSnapshot {
    // ⚠️ 前文後理 (data provenance): the `balance` / `initialBalance` /
    // `totalEquity` / `totalPnl` fields in the returned snapshot are the
    // PAPER (simulated) account numbers — NOT the real HL account. Real
    // positions are included below (so they survive restart) but the real
    // account BALANCE is fetched fresh from HL API on each startup, never
    // restored from this snapshot.
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
      // v2.0.143: Include MAE/MFE in snapshot
      minValueReached: (p as any).minValueReached,
      maxValueReached: (p as any).maxValueReached,
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

  openPosition(order: Order, entryPrice: number, leverage = 1, entryThesis?: string, entryData?: EntryFeatures): Position {
    const symbol = normalizeSymbol(order.symbol);
    // v2.0.854-ATTACK: Sanitize leverage AT STORAGE so every downstream consumer
    // (position-utils recomputePnL/trackMAEMFE, index.ts margin calcs, UI) is
    // safe from division-by-zero. A stored leverage of 0/NaN/negative/>50 is an
    // invalid order that must degrade to 1 (no leverage), never Infinity/NaN.
    const safeLev = safeLeverage(leverage);
    // v2.0.854-ATTACK2: Sanitize price + quantity AT STORAGE. NaN/Infinity/0/
    // negative entryPrice or quantity corrupts notional → margin → balance →
    // every learning system. Degrade to 0 (zero-value position) so the
    // portfolio stays finite.
    const safeEntryPrice = safePrice(entryPrice);
    const quantity = safeQuantity(order.filledQuantity > 0 ? order.filledQuantity : order.quantity);
    const notional = quantity * safeEntryPrice;
    // v2.0.63: Deduct MARGIN (notional / leverage), not full notional.
    // On Hyperliquid, a 10x leveraged position only requires 10% margin.
    // The old code deducted full notional, causing balance to drop 10x
    // faster than reality. closePosition() now returns margin (not notional).
    // v2.0.854-ATTACK: safeLeverage guards leverage=0/NaN which would make
    // margin Infinity/NaN and corrupt the paper balance.
    const margin = notional / safeLev;

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
      averageEntryPrice: safeEntryPrice,
      currentPrice: safeEntryPrice,
      unrealizedPnl: -entryFee,
      unrealizedPnlPct: margin > 0 ? -entryFee / margin : 0,
      realizedPnl: 0,
      leverage: safeLev,
      openedAt: Date.now(),
      updatedAt: Date.now(),
      agentId: order.agentId,
      exchange,
      entryFee,
      // v2.0.80: Store Meta-Agent's entry thesis for Skeptics re-validation
      entryThesis,
      // v2.0.143: Initialize MAE/MFE tracking as position VALUE (margin + unrealized PnL).
      // At open, unrealized PnL = -entryFee, so value = margin - entryFee.
      minValueReached: margin - entryFee,
      maxValueReached: margin - entryFee,
      // v2.0.819: Entry-time data pipeline — set SYNCHRONOUSLY at construction
      // so the closed TradeRecord inherits the TRUE entry conditions. This
      // replaces the flaky post-execution patching that the close path silently
      // dropped (root cause of 100% NO_OLR / NO_SHADOW on real trades).
      entryMarketFeatures: entryData?.marketFeatures,
      entryOlrPWin: entryData?.olrPWin,
      entryShadowWinRate: entryData?.shadowWinRate,
      entryShadowWinRateSource: sanitizeShadowSource(entryData?.shadowWinRateSource),
      entryConvictionLedger: entryData?.entryConvictionLedger,
      entryPersistence: entryData?.persistence,
      regime: entryData?.regime,
      entryConsensusConfidence: entryData?.consensusConfidence,
    };

    // Set stop-loss and take-profit
    const sltp = computeSLTP(entryPrice, order.side);
    position.stopLossPrice = sltp.sl;
    position.takeProfitPrice = sltp.tp;
    // v2.0.143: Record original SL/TP at open so exitThesis can detect narrowing/widening.
    position.originalStopLossPrice = position.stopLossPrice;
    position.originalTakeProfitPrice = position.takeProfitPrice;

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
      // v2.0.819: Carry entry-time data onto the open record too so any
      // consumer reading open trades sees the same features as the position.
      entryMarketFeatures: entryData?.marketFeatures,
      entryOlrPWin: entryData?.olrPWin,
      entryShadowWinRate: entryData?.shadowWinRate,
      entryShadowWinRateSource: sanitizeShadowSource(entryData?.shadowWinRateSource),
      entryConvictionLedger: entryData?.entryConvictionLedger,
      entryPersistence: entryData?.persistence,
      regime: entryData?.regime,
      entryConsensusConfidence: entryData?.consensusConfidence,
    };

    log.info(`Position opened: ${order.side.toUpperCase()} ${quantity.toFixed(6)} ${symbol} @ ${entryPrice}`, {
      cost: margin.toFixed(2),
      balance: this.portfolio.balance.toFixed(2),
    });

    return position;
  }

  updatePosition(symbol: string, currentPrice: number): void {
    const pos = this.portfolio.positions.get(symbol);
    if (!pos) return;

    // v2.0.219: Price sanity check — same as softUpdatePosition.
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;
    if (pos.currentPrice > 0) {
      const deviation = Math.abs(currentPrice - pos.currentPrice) / pos.currentPrice;
      // v2.0.868-fix(主神 MAE -50% 調查):單 tick 跳動 >10% 極可能係錯價
      // (HL WS spike/API 錯)——之前 25% 太寛鬆——SKHX 一時讀到 11.7% 錯價
      // → unrealizedPnl 計到 -58% margin → trackMAEMFE 永久污染 minValueReached
      if (deviation > 0.10) {
        log.warn(`[updatePosition] Rejected corrupt price ${currentPrice.toFixed(2)} for ${symbol} (deviation ${(deviation * 100).toFixed(1)}% from last ${safeNum(pos.currentPrice, 0).toFixed(2)}) — single-tick >10% jump`);
        return;
      }
    }

    pos.currentPrice = currentPrice;
    pos.updatedAt = Date.now();

    // v2.0.19: include the entry fee already paid so unrealized PnL reflects
    // the real cost from open. The exit fee (paid on close) is NOT included
    // here — it's deducted in closePosition() when the trade realises.
    //
    // v2.0.48: FIX — removed `* (pos.leverage ?? 1)` from PnL calculation.
    // v2.0.48: FIX — removed `* (pos.leverage ?? 1)` from PnL calculation.
    // PnL = priceDelta * quantity (NOT priceDelta * quantity * leverage).
    // v2.0.48: PnL = priceDelta × quantity (no leverage multiplier).
    // v2.0.63: PnL% = PnL / margin (leveraged return on capital).
    // v2.0.173: Extracted to shared helpers (recomputePnL + trackMAEMFE)
    recomputePnL(pos, currentPrice);
    trackMAEMFE(pos);

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

  /** v2.0.143: Set exit thesis on a position BEFORE closing it.
   *  Called by index.ts when consensus/Skeptics decides to close a position,
   *  so the rationale is captured in the TradeRecord at close time.
   *  Must be called BEFORE closePosition()/closeExchangePosition() because
   *  those methods delete the position from the map. */
  setExitThesis(symbol: string, thesis: string): void {
    const sym = normalizeSymbol(symbol);
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(sym);
    if (!pos) return;
    if (thesis && thesis.trim().length > 0) {
      pos.exitThesis = thesis.trim();
      pos.updatedAt = Date.now();
    }
  }

  /** v2.0.869-P14(主神 開倉×平倉市況):Set the market regime at close time
   *  (called before closePosition/closeExchangePosition)。用於學「開倉 regime
   *  → 平倉 regime」嘅 persistence rate(regime 持續/反轉)。 */
  setCloseRegime(symbol: string, regime: string): void {
    const sym = normalizeSymbol(symbol);
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(sym);
    if (!pos) return;
    if (regime && regime.trim().length > 0) {
      pos.closeRegime = regime.trim();
    }
  }

  /**
   * v2.0.869-fix(主神 SKHX MAE=0 調查):soft update——可選傳入 HL 回傳嘅 unrealizedPnl。
   *  HL WS position push 有真實 unrealizedPnl(HL 計算)——但係之前用 entryPx 做
   *  currentPrice——pnl = 0——trackMAEMFE 冇追蹤——短持倉 trade MAE/MFE = 0(數據錯)。
   *  有 HL pnl → 直接使用(HL 真實值——sanitize)——trackMAEMFE 追蹤真實 min/max。
   *  冇 HL pnl(本地 call)→ 現有邏輯(recomputePnL + trackMAEMFE)。
   */
  softUpdatePosition(symbol: string, currentPrice: number, hlUnrealizedPnl?: number): void {
    // v2.0.72: check real positions first, then paper
    const sym = normalizeSymbol(symbol);
    const pos = this.realPositions.get(sym) ?? this.portfolio.positions.get(symbol);
    if (!pos) return;

    // v2.0.869-attack(主神 刁鑽攻擊):持久化污染防禦——load 時 minValueReached 可能
    // 係負值/NaN(舊版污染 state file)——softUpdate 前 sanitize:
    // 負值/NaN → 重置為開倉值(margin - entryFee)——唔 crash + 唔污染追蹤
    const safeMargin0 = (pos.averageEntryPrice * pos.quantity) / safeLeverage(pos.leverage);
    const openValue = Number.isFinite(safeMargin0) && safeMargin0 > 0 ? safeMargin0 - (Number.isFinite(pos.entryFee) ? (pos.entryFee as number) : 0) : 0;
    if (!Number.isFinite(pos.minValueReached) || (pos.minValueReached as number) < 0) {
      pos.minValueReached = openValue;
    }
    if (!Number.isFinite(pos.maxValueReached) || (pos.maxValueReached as number) < 0) {
      pos.maxValueReached = openValue;
    }

    // v2.0.219: Price sanity check — reject corrupt/stale prices that deviate
    // too far from the last known price. A 10%+ move in a single update is
    // almost certainly a data glitch (wrong symbol, stale REST response, WS
    // desync). Accepting it permanently corrupts minValueReached/maxValueReached.
    // Threshold: 25% — generous enough for real flash crashes, tight enough to
    // catch data corruption (the SKHX bug had a 10% fake drop → minValue=$7.82
    // on a $15.73 margin position where SL was 0.8% away).
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;
    if (pos.currentPrice > 0) {
      const deviation = Math.abs(currentPrice - pos.currentPrice) / pos.currentPrice;
      // v2.0.868-fix:單 tick >10% 拒絕(防錯價污染 min/max——MAE -50% 調查)
      if (deviation > 0.10) {
        log.warn(`[softUpdatePosition] Rejected corrupt price ${currentPrice.toFixed(2)} for ${sym} (deviation ${(deviation * 100).toFixed(1)}% from last ${safeNum(pos.currentPrice, 0).toFixed(2)}) — keeping MAE/MFE clean`);
        return;
      }
    }

    pos.currentPrice = currentPrice;
    pos.updatedAt = Date.now();

    // v2.0.869-fix(主神 SKHX MAE=0 調查):HL 回傳 unrealizedPnl——直接使用
    // (HL 計算嘅真實未實現盈虧——sanitize NaN/Infinity——唔覆蓋本地計算)
    // 有 HL pnl → 用 HL 值追蹤 min/max(短持倉 trade 唔再 MAE=0)
    // 冇 HL pnl → 現有 recomputePnL(本地計算——含 entryFee)
    //
    // v2.0.869-attack(主神 刁鑽攻擊):HL pnl 必須先驗證「posValue 喺 sanity range」——
    // 否則超大/超細/負值 pnl 污染 pos.unrealizedPnl(即使 trackMAEMFE 拒絕——
    // pos.unrealizedPnl 已經被設定——recalculateEquity 用錯值)。
    // 驗證:0 ≤ margin + hlPnl ≤ 3×margin(同 trackMAEMFE 一致)——跳出 → 唔用 HL 值
    if (Number.isFinite(hlUnrealizedPnl)) {
      const margin = (pos.averageEntryPrice * pos.quantity) / safeLeverage(pos.leverage);
      const hlPosValue = margin + (hlUnrealizedPnl as number);
      if (Number.isFinite(margin) && margin > 0 && hlPosValue >= 0 && hlPosValue <= margin * 3) {
        pos.unrealizedPnl = hlUnrealizedPnl as number;
        // v2.0.869-P5(主神 price moved 0.00% 調查):用 HL pnl 同步更新 unrealizedPnlPct——
        // 之前淨係更新 unrealizedPnl——unrealizedPnlPct 仲係 recomputePnL(currentPrice=entryPx)——
        // = 0——hacp.ts thesis invalidation 用 unrealizedPnlPct 判斷「price moved」——
        // 全部 0.00%——BLOCK 所有 thesis invalidation——唔 close——倒蝕!
        pos.unrealizedPnlPct = margin > 0 ? (hlUnrealizedPnl as number) / margin : 0;
        trackMAEMFE(pos);
      } else {
        // HL pnl 跳出 sanity range(錯值/污染)——fallback 本地 recomputePnL
        recomputePnL(pos, currentPrice);
        trackMAEMFE(pos);
      }
    } else {
      // v2.0.173: Extracted to shared helpers (same as updatePosition, minus SL/TP check)
      recomputePnL(pos, currentPrice);
      trackMAEMFE(pos);
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
    /** v2.0.819: Entry-time data pipeline — set synchronously at import so
     *  the real-position mirror carries the TRUE entry conditions through to
     *  the closed TradeRecord. */
    entryData?: EntryFeatures,
  ): void {
    // v2.0.31: Use normalizeSymbol for case-sensitive colon symbol support
    const sym = normalizeSymbol(symbol);
    // v2.0.854-ATTACK: Sanitize leverage AT STORAGE so every downstream consumer
    // is safe from division-by-zero. leverage=0/NaN/negative/>50 → 1 (safe).
    const safeLev = safeLeverage(leverage);
    // v2.0.854-ATTACK2: Sanitize price + quantity AT STORAGE. NaN/Infinity/0/
    // negative entryPrice or quantity corrupts notional → margin → MAE/MFE →
    // every learning system. Degrade to 0 (zero-value position).
    const safeEntryPrice = safePrice(entryPrice);
    const safeQty = safeQuantity(quantity);

    // Don't import if already exists in either map
    if (this.portfolio.positions.has(sym) || this.realPositions.has(sym)) return;

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
    const dedupKey = `${sym}:${safeEntryPrice.toFixed(2)}`;
    const lastClose = this.recentlyClosedSyms.get(dedupKey);
    if (lastClose && (Date.now() - lastClose) < this.CLOSE_DEDUP_TTL_MS) {
      // v2.0.97: Position exists on HL (caller confirmed via getPositions()),
      // so the local close was either a paper-only close or the HL close failed.
      // Either way, the position is still open on HL and must be re-imported
      // so agents can manage it. Clear the dedup entry and proceed.
      log.info(`⏭️ importExchangePosition dedup bypassed: ${sym} @ $${safeEntryPrice.toFixed(2)} was closed locally ${Date.now() - lastClose}ms ago but still exists on HL — re-importing`);
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
    // Uses config.risk defaults via computeSLTP (no more hardcoded 0.02/0.05)
    const { sl: stopLossPrice, tp: takeProfitPrice } = computeSLTP(safeEntryPrice, side);

    const position: Position = {
      id: `hl-${sym}-${Date.now()}`,
      symbol: sym,
      side,
      quantity: safeQty,
      averageEntryPrice: safeEntryPrice,
      currentPrice: safeEntryPrice,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      realizedPnl: 0,
      leverage: safeLev,
      openedAt,
      updatedAt: Date.now(),
      agentId: 'hyperliquid-real',
      exchange,
      stopLossPrice,
      takeProfitPrice,
      // v2.0.143: Initialize MAE/MFE tracking at import.
      // Position value = margin (notional / leverage) + unrealized PnL (0 at import).
      // v2.0.854-ATTACK: safeLeverage guards leverage=0/NaN (Infinity margin).
      minValueReached: (safeEntryPrice * safeQty) / safeLev,
      maxValueReached: (safeEntryPrice * safeQty) / safeLev,
      // v2.0.143: Record original SL/TP at import.
      originalStopLossPrice: stopLossPrice,
      originalTakeProfitPrice: takeProfitPrice,
      // v2.0.819: Entry-time data pipeline — set synchronously at import so
      // closeExchangePosition() inherits the TRUE entry conditions. This is
      // the fix for the 12 failed v2.0.777-818 patch attempts: features are
      // now part of the Position object literal, not a post-hoc monkey-patch.
      entryMarketFeatures: entryData?.marketFeatures,
      entryOlrPWin: entryData?.olrPWin,
      entryShadowWinRate: entryData?.shadowWinRate,
      entryShadowWinRateSource: sanitizeShadowSource(entryData?.shadowWinRateSource),
      entryConvictionLedger: entryData?.entryConvictionLedger,
      entryPersistence: entryData?.persistence,
      regime: entryData?.regime,
      entryConsensusConfidence: entryData?.consensusConfidence,
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
   * TradingManager uses this return value to decide what to send to HL.
   *
   * ⚠️ MAINTENANCE NOTE: If you change validation logic, update BOTH this layer
   * AND hacp.ts adjustPositions() (the LLM retry loop layer).
   */
  adjustPosition(positionId: string, newStopLoss?: number, newTakeProfit?: number): boolean {
    // v2.0.72: search both real and paper positions
    const allPositions = [...this.realPositions.values(), ...this.portfolio.positions.values()];
    for (const pos of allPositions) {
      if (pos.id === positionId) {
        const isLong = isBuySide(pos.side);

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
            log.warn(`🚫 adjustPosition SL too-tight: ${pos.symbol} SL $${finalSL.toFixed(2)} is ${(slDistPct * 100).toFixed(2)}% from current price $${safeNum(pos.currentPrice, 0).toFixed(2)} — minimum ${(MIN_SL_DIST_PCT * 100)}% required to avoid noise stop-out`);
            finalSL = undefined;
          }
        }
        if (finalTP !== undefined && pos.currentPrice > 0) {
          const tpDistPct = Math.abs(pos.currentPrice - finalTP) / pos.currentPrice;
          if (tpDistPct < MIN_TP_DIST_PCT) {
            log.warn(`🚫 adjustPosition TP too-tight: ${pos.symbol} TP $${finalTP.toFixed(2)} is ${(tpDistPct * 100).toFixed(2)}% from current price $${safeNum(pos.currentPrice, 0).toFixed(2)} — minimum ${(MIN_TP_DIST_PCT * 100)}% required to avoid noise take-profit`);
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

    const isLong = isBuySide(pos.side);
    let validSL = slPrice;
    let validTP = tpPrice;

    // v2.0.55: Validate SL direction — must be on correct side of current price.
    // LONG: SL must be BELOW current price. SHORT: SL must be ABOVE current price.
    // If SL would trigger immediately, it's invalid — reject it.
    if (validSL !== undefined) {
      const slSafe = isLong ? validSL < pos.currentPrice : validSL > pos.currentPrice;
      if (!slSafe) {
        log.warn(`🚫 syncSLTPFromExchange: ${isLong ? 'LONG' : 'SHORT'} SL $${validSL.toFixed(2)} on wrong side of current price $${safeNum(pos.currentPrice, 0).toFixed(2)} for ${sym} — rejecting HL value, keeping local SL=$${pos.stopLossPrice?.toFixed(2) ?? 'none'}`);
        validSL = undefined;
      }
    }

    // v2.0.55: Validate TP direction — must be on profit side of entry.
    // LONG: TP must be ABOVE entry. SHORT: TP must be BELOW entry.
    if (validTP !== undefined) {
      const tpValid = isLong ? validTP > pos.averageEntryPrice : validTP < pos.averageEntryPrice;
      if (!tpValid) {
        log.warn(`🚫 syncSLTPFromExchange: ${isLong ? 'LONG' : 'SHORT'} TP $${validTP.toFixed(2)} on wrong side of entry $${safeNum(pos.averageEntryPrice, 0).toFixed(2)} for ${sym} — rejecting HL value, keeping local TP=$${pos.takeProfitPrice?.toFixed(2) ?? 'none'}`);
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

    const isLong = isBuySide(pos.side);
    let needsCorrection = false;

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
        log.warn(`🔧 correctInvertedSLTP: ${isLong ? 'LONG' : 'SHORT'} ${sym} SL $${safeNum(pos.stopLossPrice, 0).toFixed(2)} on wrong side of current price $${safeNum(pos.currentPrice, 0).toFixed(2)} — recalculating`);
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
        log.warn(`🔧 correctInvertedSLTP: ${isLong ? 'LONG' : 'SHORT'} ${sym} TP $${safeNum(pos.takeProfitPrice, 0).toFixed(2)} on wrong side of entry $${safeNum(pos.averageEntryPrice, 0).toFixed(2)} — recalculating`);
        needsCorrection = true;
      }
    }

    if (needsCorrection) {
      // Recalculate correct SL/TP from config percentages
      const { sl: newSL, tp: newTP } = computeSLTP(pos.averageEntryPrice, pos.side);

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
  /**
   * v2.0.868-fix:reconcilePositions 加 confirmClosed callback——系統自己驗證。
   * 主神指正:「系統應該完成檢查,唔係叫用戶核實」——之前 reconciliation close
   * 冇 fill 驗證——幻影 close 後發 TG 警告「可能仍持有,請核實」——荒謬。
   * 而家:close 前 caller(index.ts)提供 fill 驗證 callback——
   *   有 closing fill(HL 實際成交)→ confirmClosed=true → 真 close
   *   冇 closing fill(唔確定)→ skip(系統自己 hold——唔製造幻影 trade)
   */
  reconcilePositions(externalOpenSymbols: string[], confirmClosed?: (symbol: string) => boolean): string[] {
    const reconciled: string[] = [];
    // v2.0.868-attack:比較用「全小寫」——normalizeSymbol 只 lower prefix
    // (asset name 保留原樣)——HL 用 'xyz:GOLD'(大寫 asset)vs local
    // 'xyz:gold'(小寫)→ 永遠唔 match → 幻影 close(每次 reconciliation
    // 誤判消失 → 假平倉訊號 → re-import 循環)——GOLD 幻影真正 root cause
    const externalSet = new Set(externalOpenSymbols.map(s => normalizeSymbol(String(s ?? '')).toLowerCase()));

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
      if (!localSymbol) continue;
      if (!externalSet.has(normalizeSymbol(localSymbol).toLowerCase())) {
        // This position exists locally but NOT externally → possibly manually closed
        const pos = this.realPositions.get(localSymbol) ?? this.portfolio.positions.get(localSymbol);
        if (!pos) continue;
        // v2.0.868: 連續 N 次確認(防幻影——單次 external 快照唔完整會誤判消失)
        const prevMissing = this.reconciliationMissingCounts.get(localSymbol) ?? 0;
        const missingCount = prevMissing + 1;
        this.reconciliationMissingCounts.set(localSymbol, missingCount);
        if (missingCount < PortfolioTracker.RECONCILIATION_CONFIRM_COUNT) {
          log.warn(`🔍 Reconciliation: ${localSymbol} not found externally (attempt ${missingCount}/${PortfolioTracker.RECONCILIATION_CONFIRM_COUNT}) — NOT closing yet (single snapshot may be incomplete; position may still be open on HL)`);
          continue;
        }
        // v2.0.868-fix:系統自己驗證——confirmClosed callback(fill 驗證)。
        // 冇 closing fill(唔確定 HL 真係 close 咗)→ 唔 close——系統 hold——
        // 唔製造幻影 trade、唔叫用戶核實。
        // v2.0.868-attack7 (O2):callback 可能 throw(caller bug/垃圾 fills)→
        // 包 try/catch——throw = 唔確定 → 唔 close(保守——唔崩潰拖垮 reconciliation)
        let confirmed = true;
        if (confirmClosed) {
          try {
            confirmed = confirmClosed(localSymbol);
          } catch {
            log.warn(`🔍 Reconciliation: ${localSymbol} confirmClosed callback threw — treating as NOT confirmed (system holds)`);
            confirmed = false;
          }
        }
        if (!confirmed) {
          log.warn(`🔍 Reconciliation: ${localSymbol} missing ${missingCount} syncs but NO closing fill found on HL — NOT closing (system holds — verify failure means position likely still open)`);
          continue;
        }
        log.warn(`🔍 Reconciliation: ${localSymbol} missing ${missingCount} consecutive syncs — closing local mirror @ $${safeNum(pos.currentPrice, 0).toFixed(2)}`);
        // v2.0.32: Use closeExchangePosition() for exchange-imported positions
        // (doesn't add margin back to balance — importExchangePosition didn't deduct it).
        // Use closePosition() for paper positions (margin was deducted at open).
        // v2.0.868-fix(主神 SP500 調查):reason 競態——PAEL(exit-price-lock)已經寫咗
        // EXIT-PRICE LOCK thesis(準備鎖利)——reconciliation 搶先 close——
        // reason 應該反映「系統意圖」(PAEL 決定先)→ 用 exit_price_lock——
        // 唔好顯示「reconciliation」(誤導主神以為係幻影/操作 close)
        const paelPending = typeof pos.exitThesis === 'string' && pos.exitThesis.includes('EXIT-PRICE LOCK');
        const closeReason = paelPending ? 'exit_price_lock' : 'reconciliation';
        const trade = pos.agentId === 'hyperliquid-real'
          ? this.closeExchangePosition(localSymbol, pos.currentPrice, undefined, closeReason)
          : this.closePosition(localSymbol, pos.currentPrice, closeReason);
        if (trade) {
          reconciled.push(localSymbol);
          this.reconciliationMissingCounts.delete(localSymbol);
          log.info(`  → Reconciled ${localSymbol}: PnL $${trade.pnl.toFixed(2)}`);
        }
      } else {
        // v2.0.868: position confirmed on external exchange → reset counter
        this.reconciliationMissingCounts.delete(localSymbol);
      }
    }
    return reconciled;
  }

  /**
   * v2.0.30: Close a PAPER position and produce a trade record.
   * Deducted margin is returned to balance; entry/exit fees are netted.
   *
   * @param closeReason v2.0.851: Optional explicit close reason passed by the
   *  caller (consensus / manual / reconciliation / thesis_invalidation). When
   *  omitted, it is inferred from the exit price vs SL/TP levels. Stored on the
   *  TradeRecord so learning + RIL + trade-audit see HOW the position closed.
   */
  closePosition(symbol: string, exitPrice: number, closeReason?: TradeRecord['closeReason']): TradeRecord | null {
    // v2.0.854-ATTACK2: Sanitize exitPrice — NaN/Infinity/0/negative corrupts
    // PnL, balance, and every learning system. Degrade to 0 (zero PnL close).
    const safeExitPrice = safePrice(exitPrice);
    // v2.0.851-fix: Look up BOTH stores (paper + real). The previous code only
    // checked `portfolio.positions`, so a real position (which lives in
    // `realPositions`) returned undefined → the real-position redirect guard
    // below was DEAD CODE and the position was silently never closed. Using
    // getPosition() (which checks both maps) makes the redirect guard actually
    // effective: a real position passed to closePosition is safely redirected.
    const pos = this.getPosition(symbol);
    if (!pos) return null;

    // v2.0.33: Defensive guard — real positions (agentId='hyperliquid-real')
    // must NEVER be closed via closePosition(). closePosition() adds margin
    // back to paper balance and updates paper stats — wrong for real positions
    // where margin was never deducted from paper balance. Redirect to
    // closeExchangePosition() which only produces a trade record + learning
    // without touching paper balance/stats.
    if (pos.agentId === 'hyperliquid-real') {
      log.warn(`⚠️ closePosition() called on real position ${symbol} — redirecting to closeExchangePosition() to prevent balance inflation`);
      return this.closeExchangePosition(symbol, safeExitPrice, undefined, closeReason);
    }

    const lev = safeLeverage(pos.leverage);
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
    if (isBuySide(pos.side)) {
      realizedPnl = (safeExitPrice - pos.averageEntryPrice) * pos.quantity;
      cashReturned = margin + realizedPnl;
      this.portfolio.balance += cashReturned;
    } else {
      // Short: profit when exit < entry
      realizedPnl = (pos.averageEntryPrice - safeExitPrice) * pos.quantity;
      cashReturned = margin + realizedPnl;
      this.portfolio.balance += cashReturned;
    }

    // ── v2.0.18: Deduct exit taker fee (notional-based) ──
    // HL taker fee = 0.04% of NOTIONAL at exit. notional = exitPrice × quantity.
    // v2.0.48: Notional is NOT leveraged — fee is on raw position value.
    // v2.0.854-ATTACK2: Use safeExitPrice so NaN/Infinity exitPrice doesn't
    // produce a NaN exitFee that corrupts balance + realizedPnl.
    const exitNotional = safeExitPrice * pos.quantity;
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

    // v2.0.143: If no exitThesis was set by setExitThesis() or checkPositionExits
    // (e.g. reconciliation close, paper mode cleanup), generate a fallback.
    if (!pos.exitThesis) {
      const isWin = realizedPnl >= 0;
      const slTpGapPct = (pos.stopLossPrice !== undefined && pos.takeProfitPrice !== undefined && pos.currentPrice > 0)
        ? Math.abs(pos.takeProfitPrice - pos.stopLossPrice) / pos.currentPrice
        : 0;
      const origGapPct = (pos.originalStopLossPrice !== undefined && pos.originalTakeProfitPrice !== undefined && pos.averageEntryPrice > 0)
        ? Math.abs(pos.originalTakeProfitPrice - pos.originalStopLossPrice) / pos.averageEntryPrice
        : 0;
      let gapNote = '';
      if (slTpGapPct > 0 && slTpGapPct < 0.03) {
        gapNote = ` ⚠️ SL/TP gap was only ${(slTpGapPct * 100).toFixed(1)}% at close`;
        if (origGapPct > slTpGapPct) {
          gapNote += ` (narrowed from original ${(origGapPct * 100).toFixed(1)}%) — unreasonably tight.`;
        } else {
          gapNote += ` — unreasonably tight.`;
        }
      }
      // SL/TP change detection
      let slChange = '';
      if (pos.originalStopLossPrice !== undefined && pos.stopLossPrice !== undefined && pos.originalStopLossPrice !== pos.stopLossPrice) {
        slChange = pos.averageEntryPrice > 0 && Number.isFinite(pos.averageEntryPrice) && Number.isFinite(pos.originalStopLossPrice)
          ? ` SL: ${(((safeNum(pos.originalStopLossPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}%→${(((safeNum(pos.stopLossPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}% from entry.`
          : '';
      }
      let tpChange = '';
      if (pos.originalTakeProfitPrice !== undefined && pos.takeProfitPrice !== undefined && pos.originalTakeProfitPrice !== pos.takeProfitPrice) {
        tpChange = pos.averageEntryPrice > 0 && Number.isFinite(pos.averageEntryPrice) && Number.isFinite(pos.originalTakeProfitPrice)
          ? ` TP: ${(((safeNum(pos.originalTakeProfitPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}%→${(((safeNum(pos.takeProfitPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}% from entry.`
          : '';
      }
      // v2.0.870-no-dollar（主神 2026-08-25）: exit thesis 唔提實際金額——全用 %。
      // v2.0.870-attack（主神 2026-08-25）: NaN 防禦——垃圾價寫入會顯示「NaN%」。
      const exitPnlPct = pos.averageEntryPrice > 0 && Number.isFinite(exitPrice) && Number.isFinite(pos.averageEntryPrice) && Number.isFinite(pos.leverage ?? 1)
        ? ((exitPrice - pos.averageEntryPrice) / pos.averageEntryPrice) * 100 * (pos.leverage ?? 1) * (isBuySide(pos.side) ? 1 : -1)
        : 0;
      const slDistPctC = pos.averageEntryPrice > 0 && Number.isFinite(pos.stopLossPrice) && Number.isFinite(pos.averageEntryPrice)
        ? Math.abs((safeNum(pos.stopLossPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100
        : 0;
      const tpDistPctC = pos.averageEntryPrice > 0 && Number.isFinite(pos.takeProfitPrice) && Number.isFinite(pos.averageEntryPrice)
        ? Math.abs((safeNum(pos.takeProfitPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100
        : 0;
      if (pos.stopLossPrice && ((isBuySide(pos.side) && exitPrice <= pos.stopLossPrice) || (!isBuySide(pos.side) && exitPrice >= pos.stopLossPrice))) {
        pos.exitThesis = `Stop-loss triggered (SL -${slDistPctC.toFixed(1)}% from entry).${slChange}${gapNote}`;
      } else if (pos.takeProfitPrice && ((isBuySide(pos.side) && exitPrice >= pos.takeProfitPrice) || (!isBuySide(pos.side) && exitPrice <= pos.takeProfitPrice))) {
        pos.exitThesis = `Take-profit triggered (TP +${tpDistPctC.toFixed(1)}% from entry).${tpChange}${gapNote}`;
      } else {
        pos.exitThesis = `Position closed (${isWin ? 'profit' : 'loss'} ${Math.abs(exitPnlPct).toFixed(2)}%).${slChange}${tpChange}${gapNote}`;
      }
    }

    // v2.0.868-attack8:close 時 min/max sanity——restore 舊污染(錯價寫入嘅
    // minValueReached/maxValueReached)兜底重置為 margin(唔帶污染入 trade record)
    const saneMargin = marginUsed > 0 ? marginUsed : 0;
    const safeMin = Number.isFinite(pos.minValueReached) && (pos.minValueReached as number) >= 0
      ? Math.min(pos.minValueReached as number, saneMargin > 0 ? saneMargin * 3 : Infinity)
      : saneMargin;
    const safeMax = Number.isFinite(pos.maxValueReached) && (pos.maxValueReached as number) >= 0
      ? Math.max(pos.maxValueReached as number, saneMargin)
      : saneMargin;

    const trade: TradeRecord = {
      id: uuidv4(),
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.averageEntryPrice,
      exitPrice: safeExitPrice,
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
      // v2.0.143: capture exit thesis (set by setExitThesis before close)
      exitThesis: pos.exitThesis,
      // v2.0.143: capture MAE/MFE from position lifetime tracking
      // v2.0.868-attack8:sanitize——restore 舊污染兜底重置(唔帶污染入 trade record)
      minValueReached: sanitizeMinMax(pos, margin).min,
      maxValueReached: sanitizeMinMax(pos, margin).max,
      // v2.0.226: Capture original + final SL/TP for close-context learning.
      originalStopLossPrice: pos.originalStopLossPrice,
      finalStopLossPrice: pos.stopLossPrice,
      originalTakeProfitPrice: pos.originalTakeProfitPrice,
      finalTakeProfitPrice: pos.takeProfitPrice,
      slNarrowed: pos.originalStopLossPrice !== undefined && pos.stopLossPrice !== undefined && pos.originalStopLossPrice !== pos.stopLossPrice,
      // v2.0.819: Copy entry-time data from the position onto the closed
      // trade record. ROOT FIX for NO_OLR / NO_SHADOW on every trade: the
      // close path previously reconstructed the TradeRecord WITHOUT these
      // fields, so entry features set at open were silently dropped and every
      // learning system (OLR/EXP/RIL/AttnRes) starved.
      entryMarketFeatures: pos.entryMarketFeatures,
      entryOlrPWin: pos.entryOlrPWin,
      entryShadowWinRate: pos.entryShadowWinRate,
      entryShadowWinRateSource: sanitizeShadowSource(pos.entryShadowWinRateSource),
      entryConvictionLedger: pos.entryConvictionLedger,
      entryPersistence: pos.entryPersistence,
      regime: pos.regime,
      closeRegime: pos.closeRegime,
      entryConsensusConfidence: pos.entryConsensusConfidence,
      // v2.0.851: Capture HOW the position closed. Prefer the caller-provided
      // reason; fall back to deterministic inference from exitPrice vs SL/TP.
      // v2.0.855-attack: Sanitize the caller reason against the whitelist —
      // '' / typo / garbage would otherwise store an invalid reason and
      // silently inflate computeLearningWeight to 1.0.
      closeReason: sanitizeCloseReason(closeReason) ?? inferCloseReason(
        pos.side,
        exitPrice,
        pos.stopLossPrice,
        pos.takeProfitPrice,
      ),
    };

    // Update portfolio stats
    // v2.0.854: Use the normalized symbol for the delete. openPosition() stores
    // under normalizeSymbol(order.symbol), but closePosition() received the raw
    // `symbol` param — if any caller passed an un-normalized symbol (e.g. 'BTC'
    // vs stored 'btc'), this delete silently missed the position → ghost
    // position stayed open while balance/PnL were already credited → double
    // PnL on a later reconcile. getPosition() normalizes, so the lookup found
    // the position but the delete didn't. Now normalize here to match.
    this.portfolio.positions.delete(normalizeSymbol(symbol));
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
   *
   * @param closeReason v2.0.851: Optional explicit close reason (consensus,
   *  manual, reconciliation, thesis_invalidation) passed by the caller. When
   *  omitted, it is inferred deterministically from the exit price vs the
   *  SL/TP levels via inferCloseReason(). Stored on the TradeRecord so the
   *  learning pipeline + RIL + trade-audit can see HOW the position closed.
   */
  closeExchangePosition(symbol: string, exitPrice: number, hlRealizedPnl?: number, closeReason?: TradeRecord['closeReason']): TradeRecord | null {
    // v2.0.868-fix(主神 GOLD 調查):PAEL 寫咗 EXIT-PRICE LOCK thesis(準備鎖利)
    // → 任何路徑 close(reconcile/sync/HL fill)reason 都應該係 exit_price_lock——
    // 唔好顯示 reconciliation(誤導——主神見到「EXIT-PRICE LOCK + reconciliation」矛盾)
    const pos0 = this.getPosition(symbol);
    if (pos0 && typeof pos0.exitThesis === 'string' && pos0.exitThesis.includes('EXIT-PRICE LOCK')
        && (!closeReason || closeReason === 'reconciliation')) {
      closeReason = 'exit_price_lock';
    }
    // v2.0.854-ATTACK2: Sanitize exitPrice — NaN/Infinity/0/negative corrupts
    // PnL, pnlPct, inferCloseReason, and every learning system.
    const safeExitPrice = safePrice(exitPrice);
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
    const dedupKey = `${normalizeSymbol(symbol)}:${safeNum(pos.averageEntryPrice, 0).toFixed(2)}`;
    const lastClose = this.recentlyClosedSyms.get(dedupKey);
    if (lastClose && (Date.now() - lastClose) < this.CLOSE_DEDUP_TTL_MS) {
      log.info(`⏭️ closeExchangePosition dedup: ${symbol} @ $${safeNum(pos.averageEntryPrice, 0).toFixed(2)} already closed ${Date.now() - lastClose}ms ago — skipping duplicate`);
      // Still delete the position from the map (it's gone from HL)
      this.realPositions.delete(sym);
      this.portfolio.positions.delete(sym);
      return null;
    }
    this.recentlyClosedSyms.set(dedupKey, Date.now());
    // v2.0.854: Bound the dedup map so it can't grow unboundedly.
    // Previously entries were only ever removed by importExchangePosition
    // (on a dedup-bypass), so over months of trading one key per
    // (symbol:entryPrice) accumulated forever — a silent memory leak.
    // (a) Purge expired keys, and (b) hard-cap total size by evicting the
    // oldest entries regardless of TTL. (b) matters because in a burst of
    // closes (many symbols at once) the keys are all "fresh", so an
    // expiry-only purge would never trigger — the map would keep growing
    // up to the burst size. The FIFO eviction guarantees a hard bound.
    const CLOSE_DEDUP_MAX = 512;
    if (this.recentlyClosedSyms.size > CLOSE_DEDUP_MAX) {
      const now = Date.now();
      // (a) remove expired
      for (const [k, ts] of this.recentlyClosedSyms) {
        if (now - ts > this.CLOSE_DEDUP_TTL_MS) this.recentlyClosedSyms.delete(k);
      }
      // (b) FIFO-evict oldest until back under cap (Map preserves insertion order)
      for (const k of this.recentlyClosedSyms.keys()) {
        if (this.recentlyClosedSyms.size <= CLOSE_DEDUP_MAX) break;
        this.recentlyClosedSyms.delete(k);
      }
    }

    const lev = safeLeverage(pos.leverage);
    // v2.0.854: Use NOTIONAL / LEVERAGE for margin, matching closePosition()
    // (paper) and recalculateEquity(). The previous code used full notional
    // (no / lev), so real positions reported `investment` and `pnlPct` as if
    // they were UN-leveraged — a 10x position showed 1/10th of its true
    // return-on-margin. This distorted every learning system (OLR/EXP/RIL)
    // that consumes pnlPct, biasing them to underestimate real-trade edge.
    // v2.0.854-ATTACK: safeLeverage guards leverage=0/NaN (division-by-zero →
    // Infinity margin).
    const margin = (pos.averageEntryPrice * pos.quantity) / lev;
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
      if (isBuySide(pos.side)) {
        realizedPnl = (safeExitPrice - pos.averageEntryPrice) * pos.quantity;
      } else {
        realizedPnl = (pos.averageEntryPrice - safeExitPrice) * pos.quantity;
      }
      // Deduct exit taker fee (notional-based, NOT leveraged)
      const exitNotional = safeExitPrice * pos.quantity;
      const exitFee = calculateTakerFee(exitNotional);
      realizedPnl -= exitFee;
    }

    // v2.0.32: Do NOT add PnL to paper balance — this is a REAL exchange
    // position. Its PnL is settled on HL, not in the paper portfolio.
    // Adding it here would inflate the paper balance with real trade PnL.
    // The trade record is still produced for learning + UI display.

    // v2.0.143: If no exitThesis was set by setExitThesis() (e.g. HL SL/TP
    // triggered, not a consensus close), generate one from the close context.
    // Include original vs final SL/TP comparison to detect narrowing/widening.
    if (!pos.exitThesis) {
      const isWin = realizedPnl >= 0;
      const slDistPct = pos.stopLossPrice !== undefined && pos.currentPrice > 0
        ? Math.abs(pos.currentPrice - pos.stopLossPrice) / pos.currentPrice
        : 0;
      const tpDistPct = pos.takeProfitPrice !== undefined && pos.currentPrice > 0
        ? Math.abs(pos.currentPrice - pos.takeProfitPrice) / pos.currentPrice
        : 0;
      const slTpGapPct = (pos.stopLossPrice !== undefined && pos.takeProfitPrice !== undefined && pos.currentPrice > 0)
        ? Math.abs(pos.takeProfitPrice - pos.stopLossPrice) / pos.currentPrice
        : 0;
      const origGapPct = (pos.originalStopLossPrice !== undefined && pos.originalTakeProfitPrice !== undefined && pos.averageEntryPrice > 0)
        ? Math.abs(pos.originalTakeProfitPrice - pos.originalStopLossPrice) / pos.averageEntryPrice
        : 0;
      let gapNote = '';
      if (slTpGapPct > 0 && slTpGapPct < 0.03) {
        gapNote = ` ⚠️ SL/TP gap was only ${(slTpGapPct * 100).toFixed(1)}% at close`;
        if (origGapPct > slTpGapPct) {
          gapNote += ` (narrowed from original ${(origGapPct * 100).toFixed(1)}%) — unreasonably tight.`;
        } else {
          gapNote += ` — unreasonably tight.`;
        }
      }
      let slChange = '';
      if (pos.originalStopLossPrice !== undefined && pos.stopLossPrice !== undefined && pos.originalStopLossPrice !== pos.stopLossPrice) {
        slChange = pos.averageEntryPrice > 0 && Number.isFinite(pos.averageEntryPrice) && Number.isFinite(pos.originalStopLossPrice)
          ? ` SL: ${(((safeNum(pos.originalStopLossPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}%→${(((safeNum(pos.stopLossPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}% from entry.`
          : '';
      }
      let tpChange = '';
      if (pos.originalTakeProfitPrice !== undefined && pos.takeProfitPrice !== undefined && pos.originalTakeProfitPrice !== pos.takeProfitPrice) {
        tpChange = pos.averageEntryPrice > 0 && Number.isFinite(pos.averageEntryPrice) && Number.isFinite(pos.originalTakeProfitPrice)
          ? ` TP: ${(((safeNum(pos.originalTakeProfitPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}%→${(((safeNum(pos.takeProfitPrice, 0) - pos.averageEntryPrice) / pos.averageEntryPrice) * 100).toFixed(1)}% from entry.`
          : '';
      }
      // v2.0.870-no-profit:exit thesis 唔提實際金額——全用 %（同區塊 1 一致）。
      const exitPnlPct2 = pos.averageEntryPrice > 0 && Number.isFinite(exitPrice) && Number.isFinite(pos.averageEntryPrice) && Number.isFinite(pos.leverage ?? 1)
        ? ((exitPrice - pos.averageEntryPrice) / pos.averageEntryPrice) * 100 * (pos.leverage ?? 1) * (isBuySide(pos.side) ? 1 : -1)
        : 0;
      if (hlRealizedPnl !== undefined) {
        pos.exitThesis = `Exchange close (${isWin ? 'profit' : 'loss'} ${Math.abs(exitPnlPct2).toFixed(2)}%).${slChange}${tpChange}${gapNote}`;
      } else if (pos.stopLossPrice && ((isBuySide(pos.side) && exitPrice <= pos.stopLossPrice) || (!isBuySide(pos.side) && exitPrice >= pos.stopLossPrice))) {
        pos.exitThesis = `Stop-loss triggered (SL -${(slDistPct * 100).toFixed(1)}% from entry).${slChange}${gapNote}`;
      } else if (pos.takeProfitPrice && ((isBuySide(pos.side) && exitPrice >= pos.takeProfitPrice) || (!isBuySide(pos.side) && exitPrice <= pos.takeProfitPrice))) {
        pos.exitThesis = `Take-profit triggered (TP +${(tpDistPct * 100).toFixed(1)}% from entry).${tpChange}${gapNote}`;
      } else {
        pos.exitThesis = `Exchange position closed (${isWin ? 'profit' : 'loss'} ${Math.abs(exitPnlPct2).toFixed(2)}%).${slChange}${tpChange}${gapNote}`;
      }
    }

    const trade: TradeRecord = {
      id: uuidv4(),
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.averageEntryPrice,
      exitPrice: safeExitPrice,
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
      // v2.0.143: capture exit thesis (set by setExitThesis before close)
      exitThesis: pos.exitThesis,
      // v2.0.143: capture MAE/MFE from position lifetime tracking
      // v2.0.868-attack8:sanitize——restore 舊污染兜底重置(唔帶污染入 trade record)
      minValueReached: sanitizeMinMax(pos, margin).min,
      maxValueReached: sanitizeMinMax(pos, margin).max,
      // v2.0.226: Capture original + final SL/TP for close-context learning.
      originalStopLossPrice: pos.originalStopLossPrice,
      finalStopLossPrice: pos.stopLossPrice,
      originalTakeProfitPrice: pos.originalTakeProfitPrice,
      finalTakeProfitPrice: pos.takeProfitPrice,
      slNarrowed: pos.originalStopLossPrice !== undefined && pos.stopLossPrice !== undefined && pos.originalStopLossPrice !== pos.stopLossPrice,
      // v2.0.819: Copy entry-time data from the real position onto the closed
      // trade record. Same root fix as closePosition() — without this, the 12
      // prior patch attempts (v2.0.777-818) set features on the position object
      // but the close path dropped them, so 100% of real trades had
      // NO_OLR / NO_SHADOW / NO_MARKET_DATA.
      entryMarketFeatures: pos.entryMarketFeatures,
      entryOlrPWin: pos.entryOlrPWin,
      entryShadowWinRate: pos.entryShadowWinRate,
      entryShadowWinRateSource: sanitizeShadowSource(pos.entryShadowWinRateSource),
      entryConvictionLedger: pos.entryConvictionLedger,
      entryPersistence: pos.entryPersistence,
      regime: pos.regime,
      closeRegime: pos.closeRegime,
      entryConsensusConfidence: pos.entryConsensusConfidence,
      // v2.0.851: Capture HOW the position closed. Prefer the caller-provided
      // reason (consensus/manual/reconciliation/thesis_invalidation); fall back
      // to deterministic inference from exitPrice vs SL/TP levels. Without this,
      // every real trade had an undefined closeReason → learning + RIL + audit
      // all treated every close as 'sl_tp'.
      // v2.0.855-attack: Sanitize the caller reason against the whitelist.
      closeReason: sanitizeCloseReason(closeReason) ?? inferCloseReason(
        pos.side,
        exitPrice,
        pos.stopLossPrice,
        pos.takeProfitPrice,
      ),
    };

    // v2.0.32: Do NOT update paper portfolio stats (totalPnl, winCount,
    // lossCount, dailyPnl) — this is a REAL exchange position. Its PnL
    // should not affect paper portfolio statistics. Only delete the
    // position + produce trade record + trigger learning.
    // v2.0.72: delete from realPositions (separate store)
    // v2.0.854: delete with the normalized symbol from BOTH maps. `sym` is
    // already normalized at the top of this method; `symbol` is the raw
    // caller param. Using raw `symbol` could miss a position stored under a
    // different casing (e.g. 'BTC' vs 'btc'), leaving a ghost position.
    this.realPositions.delete(sym);
    this.portfolio.positions.delete(sym);
    // No recalculateEquity — real positions don't affect paper equity.
    // v2.0.35: Store the closed real trade so the UI Trade Records panel
    // can display it with accurate exit price + PnL. Previously this trade
    // was only used for learning — never stored, so the UI never showed
    // the close (the position just disappeared with no trace).
    // v2.0.158: Dedup — check if a trade with the same symbol + side + openedAt
    // already exists. This prevents double-recording when syncExchangePositions
    // and another close path both fire for the same position.
    const isDuplicate = this.closedRealTrades.some(existing =>
      existing.symbol === trade.symbol &&
      existing.side === trade.side &&
      Math.abs((existing.openedAt ?? 0) - (trade.openedAt ?? 0)) < 60_000 // within 1 min = same position
    );
    if (!isDuplicate) {
      this.closedRealTrades.push(trade);
    } else {
      log.info(`⏭️ closeExchangePosition: duplicate trade record skipped for ${symbol} (same symbol+side+openedAt already exists)`);
    }
    // v2.0.870-pnl-range-fix: 用 30 日期限代替 200 個數目限制——保留 30 日內 trade
    // （PNL 頁面 1 MONTH 需要完整 30 日數據——200 個限制會截斷）
    // v2.0.870-pnl-range-fix-attack（攻擊硬化）:
    //   1. 垃圾時間（NaN/Infinity/負數/0/null）→ 保留（唔刪除——避免數據丟失——
    //      `NaN >= cutoff` = false 會刪除正常 trade）
    //   2. 只喺 length > 200 先 filter（效能保護——30 日內 trade 有限——避免每次 close 都掃）
    if (this.closedRealTrades.length > 200) {
      const cutoff30d = Date.now() - 30 * 24 * 3600 * 1000;
      this.closedRealTrades = this.closedRealTrades.filter((t) => {
        const ts = t.closedAt ?? t.openedAt ?? 0;
        return !Number.isFinite(ts) || ts <= 0 || ts >= cutoff30d;
      });
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

  private checkPositionExits(pos: Position): void {
    // v2.0.156: Skip local SL/TP monitoring for real exchange positions.
    // Real positions have SL/TP placed as trigger orders on HL — the exchange
    // handles the close. Local monitoring creates phantom close records when
    // the local price hits SL/TP but the HL trigger order hasn't filled yet
    // (or the local price is stale/different from HL's mark price).
    if (pos.agentId === 'hyperliquid-real') return;
    // v2.0.143: Set exitThesis BEFORE closing so the TradeRecord captures it.
    // Include SL/TP narrowing analysis: compare original SL/TP (at open) vs
    // current SL/TP (at close) to detect whether the system tightened them
    // to an unreasonable degree.
    const slDistPct = pos.stopLossPrice !== undefined && pos.currentPrice > 0
      ? Math.abs(pos.currentPrice - pos.stopLossPrice) / pos.currentPrice
      : 0;
    const tpDistPct = pos.takeProfitPrice !== undefined && pos.currentPrice > 0
      ? Math.abs(pos.currentPrice - pos.takeProfitPrice) / pos.currentPrice
      : 0;
    const slTpGapPct = (pos.stopLossPrice !== undefined && pos.takeProfitPrice !== undefined && pos.currentPrice > 0)
      ? Math.abs(pos.takeProfitPrice - pos.stopLossPrice) / pos.currentPrice
      : 0;

    // v2.0.143: Compare original vs current SL/TP to detect narrowing/widening.
    const origSL = pos.originalStopLossPrice;
    const origTP = pos.originalTakeProfitPrice;
    const currSL = pos.stopLossPrice;
    const currTP = pos.takeProfitPrice;
    const isLong = isBuySide(pos.side);

    // SL narrowing: SL moved closer to entry (tighter stop = more risk of noise stop-out)
    // SL widening: SL moved further from entry (wider stop = more risk) — blocked by no-widen, but check anyway
    let slChangeNote = '';
    if (origSL !== undefined && currSL !== undefined && origSL !== currSL) {
      const origSlDist = Math.abs(pos.averageEntryPrice - origSL);
      const currSlDist = Math.abs(pos.averageEntryPrice - currSL);
      const slNarrowedPct = origSlDist > 0 ? ((origSlDist - currSlDist) / origSlDist * 100) : 0;
      if (currSlDist < origSlDist) {
        slChangeNote = ` SL was tightened by ${Math.abs(slNarrowedPct).toFixed(1)}% (original SL=$${origSL.toFixed(2)} → final SL=$${currSL.toFixed(2)}).`;
      } else {
        slChangeNote = ` SL was widened by ${Math.abs(slNarrowedPct).toFixed(1)}% (original SL=$${origSL.toFixed(2)} → final SL=$${currSL.toFixed(2)}).`;
      }
    }

    // TP narrowing: TP moved closer to entry (tighter target = less profit)
    let tpChangeNote = '';
    if (origTP !== undefined && currTP !== undefined && origTP !== currTP) {
      const origTpDist = Math.abs(pos.averageEntryPrice - origTP);
      const currTpDist = Math.abs(pos.averageEntryPrice - currTP);
      const tpNarrowedPct = origTpDist > 0 ? ((origTpDist - currTpDist) / origTpDist * 100) : 0;
      if (currTpDist < origTpDist) {
        tpChangeNote = ` TP was tightened by ${Math.abs(tpNarrowedPct).toFixed(1)}% (original TP=$${origTP.toFixed(2)} → final TP=$${currTP.toFixed(2)}).`;
      } else {
        tpChangeNote = ` TP was widened by ${Math.abs(tpNarrowedPct).toFixed(1)}% (original TP=$${origTP.toFixed(2)} → final TP=$${currTP.toFixed(2)}).`;
      }
    }

    // SL/TP gap analysis
    const origGapPct = (origSL !== undefined && origTP !== undefined && pos.averageEntryPrice > 0)
      ? Math.abs(origTP - origSL) / pos.averageEntryPrice
      : 0;
    let gapNote = '';
    if (slTpGapPct > 0 && slTpGapPct < 0.03) {
      gapNote = ` ⚠️ SL/TP gap was only ${(slTpGapPct * 100).toFixed(1)}% at close`;
      if (origGapPct > 0 && origGapPct > slTpGapPct) {
        gapNote += ` (narrowed from original ${(origGapPct * 100).toFixed(1)}%) — unreasonably tight, likely noise stop-out.`;
      } else {
        gapNote += ` — unreasonably tight, likely noise stop-out.`;
      }
    }

    if (isBuySide(pos.side)) {
      if (pos.stopLossPrice && pos.currentPrice <= pos.stopLossPrice) {
        log.warn(`Stop-loss triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        pos.exitThesis = `Stop-loss triggered (SL -${(slDistPct * 100).toFixed(1)}% from entry).${slChangeNote}${gapNote}`;
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
      if (pos.takeProfitPrice && pos.currentPrice >= pos.takeProfitPrice) {
        log.info(`Take-profit triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        pos.exitThesis = `Take-profit triggered (TP +${(tpDistPct * 100).toFixed(1)}% from entry).${tpChangeNote}${gapNote}`;
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
    } else {
      if (pos.stopLossPrice && pos.currentPrice >= pos.stopLossPrice) {
        log.warn(`Stop-loss triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        pos.exitThesis = `Stop-loss triggered (SL -${(slDistPct * 100).toFixed(1)}% from entry).${slChangeNote}${gapNote}`;
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
      if (pos.takeProfitPrice && pos.currentPrice <= pos.takeProfitPrice) {
        log.info(`Take-profit triggered for ${pos.symbol} @ ${pos.currentPrice}`);
        pos.exitThesis = `Take-profit triggered (TP +${(tpDistPct * 100).toFixed(1)}% from entry).${tpChangeNote}${gapNote}`;
        this.closePosition(pos.symbol, pos.currentPrice);
        return;
      }
    }
  }

  /**
   * Recompute PAPER totalEquity = paper balance + unrealized PnL + locked
   * margin on OPEN PAPER positions.
   *
   * ⚠️ 前文後理 (data provenance):
   * - v2.0.72: portfolio.positions contains ONLY paper positions. Real
   *   positions live in `realPositions` (imported from HL via
   *   importExchangePosition / syncExchangePositions).
   * - This function therefore EXCLUDES real positions entirely — real
   *   unrealized PnL and real locked margin are NOT added here.
   * - The REAL account value comes from Hyperliquid's own API
   *   (`clearinghouseState.marginSummary.accountValue`), fetched by
   *   `hyperliquid-engine.ts getBalance()` → `cachedExchangeBalance` in
   *   index.ts. UI "Genuine Balance" reads that; it is NOT this value.
   * - Consequence: paper totalEquity ≠ real HL equity. Diagnosing
   *   real-account profitability from `portfolio-state.json` (which
   *   persists this paper value) is WRONG. Use HL accountValue.
   */
  private recalculateEquity(): void {
    let unrealizedSum = 0;
    let lockedMargin = 0;
    // v2.0.72: portfolio.positions now contains ONLY paper positions.
    // Real positions live in realPositions and never affect paper equity.
    for (const pos of this.portfolio.positions.values()) {
    // v2.0.63: lockedMargin = margin (notional / leverage), not full notional.
    // openPosition() deducts margin from balance, so equity adds it back.
    // Using full notional here would inflate equity by (notional - margin).
    // v2.0.854-ATTACK: safeLeverage guards leverage=0/NaN (Infinity margin).
    // v2.0.854-ATTACK3: Guard NaN unrealizedPnl (corrupted restore) — a single
    // NaN position would make totalEquity NaN, poisoning the entire portfolio.
    const uPnl = Number.isFinite(pos.unrealizedPnl) ? pos.unrealizedPnl : 0;
    unrealizedSum += uPnl;
    lockedMargin += (pos.averageEntryPrice * pos.quantity) / safeLeverage(pos.leverage);
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

  /**
   * 🕐 TIMEZONE: HK 日期（GMT+8）——`toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' })`
   * 輸出 YYYY-MM-DD（en-CA 保證格式）。daily PnL reset 喺 HK 00:00 翻新——
   * 同 computeDailyPnl todayStart（HK midnight）一致。
   * （舊版用 toISOString() = UTC 日期 → reset 喺 HK 08:00, 已修 ——主神 2026-09-02 裁決）
   */
  private todayString(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' }); // YYYY-MM-DD (HK GMT+8)
  }
}