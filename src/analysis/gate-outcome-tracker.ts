// ─── Gate Outcome Tracker ─────────────────────────────────────────────
// v2.0.870: 量化金融分析師思路——每個 gate 係一個「策略」，必須量度佢嘅
// 攔截準確率（hit rate）先知道應唔應該信佢。當 gate 攔截咗一個訊號
// （four-window HARD BLOCK / conviction-gate / Skeptics BLOCKED close），
// 記錄攔截時價格，之後檢查價格走勢：
//   • 攔截 BUY → 價格跌 = hit（避免損失）；價格升 = miss（錯過盈利）
//   • 攔截 SELL → 價格升 = hit；價格跌 = miss
//   • Skeptics BLOCKED close → 持倉繼續賺 = hit；錯過離場 = miss
// 統計 per-gate hit rate + avg move——hit rate 高嘅 gate 有 edge（可加強），
// 低嘅太保守（錯過盈利）。純觀測層——零決策邏輯改動，安全。

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'gate-outcome' });

export type BlockedDirection = 'buy' | 'sell' | 'close';
export type GateOutcome = 'hit' | 'miss';

export interface BlockedSignal {
  symbol: string;
  gate: string;
  direction: BlockedDirection;
  /** 持倉方向（close 時用——Skeptics block close 嘅倉位方向） */
  side: 'buy' | 'sell' | null;
  entryPrice: number;
  recordedAt: number;
  cycle: number;
  outcome?: GateOutcome;
  resolvedAt?: number;
  movePct?: number;
}

export interface GateStats {
  hits: number;
  misses: number;
  hitRate: number;
  /** 平均價格移動 %——正 = 攔截啱方向（避免損失 / 保留盈利） */
  avgMovePct: number;
}

/** 0.5% 閾值——低過係噪音，保持 pending */
const RESOLVE_THRESHOLD = 0.005;
/** 4h 後強制 resolve（用最後價格）——唔可以無限 pending */
const MAX_PENDING_AGE_MS = 4 * 60 * 60 * 1000;
const MAX_PENDING = 200;

/** Symbol key 統一：細楷 + 去 xyz: 前綴（record/check 一致先 resolve 到） */
function normalizeSymbolKey(symbol: string): string {
  return String(symbol).toLowerCase().replace(/^xyz:/, '');
}

/** 純函數：判定被攔截訊號嘅後續走勢係 hit（攔截啱）定 miss（攔截錯）。 */
export function judgeGateOutcome(
  direction: BlockedDirection,
  side: 'buy' | 'sell' | null,
  entryPrice: number,
  currentPrice: number,
): GateOutcome | 'pending' {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 'pending';
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 'pending';
  const move = (currentPrice - entryPrice) / entryPrice;
  if (Math.abs(move) < RESOLVE_THRESHOLD) return 'pending';
  if (direction === 'buy') return move < 0 ? 'hit' : 'miss';
  if (direction === 'sell') return move > 0 ? 'hit' : 'miss';
  // close — 用持倉方向判定
  if (side === 'sell') return move < 0 ? 'hit' : 'miss';
  return move > 0 ? 'hit' : 'miss';
}

function forcedOutcome(direction: BlockedDirection, side: 'buy' | 'sell' | null, move: number): GateOutcome {
  if (move === 0) return 'miss';
  if (direction === 'buy') return move < 0 ? 'hit' : 'miss';
  if (direction === 'sell') return move > 0 ? 'hit' : 'miss';
  if (side === 'sell') return move < 0 ? 'hit' : 'miss';
  return move > 0 ? 'hit' : 'miss';
}

export class GateOutcomeTracker {
  private pending: BlockedSignal[] = [];
  private stats = new Map<string, GateStats>();
  private file: string;

  constructor(file = 'data/evolution/gate-outcome.json') {
    this.file = file;
    this.load();
  }

  /** 記錄一個被攔截訊號。防禦 sanitize——垃圾輸入唔可以 crash。
   *  symbol normalize：細楷 + 去 xyz: 前綴（record/check 一致先 resolve 到）。 */
  record(signal: Omit<BlockedSignal, 'recordedAt'> & { cycle: number }): void {
    if (!signal || typeof signal !== 'object') return;
    if (typeof signal.symbol !== 'string' || !signal.symbol || signal.symbol.length > 64) return;
    if (typeof signal.gate !== 'string' || !signal.gate || signal.gate.length > 40) return;
    if (signal.direction !== 'buy' && signal.direction !== 'sell' && signal.direction !== 'close') return;
    if (signal.side !== 'buy' && signal.side !== 'sell' && signal.side !== null) return;
    if (!Number.isFinite(signal.entryPrice) || signal.entryPrice <= 0) return;
    if (!Number.isFinite(signal.cycle)) return;
    this.pending.push({
      symbol: normalizeSymbolKey(signal.symbol),
      gate: signal.gate,
      direction: signal.direction,
      side: signal.side,
      entryPrice: signal.entryPrice,
      recordedAt: Date.now(),
      cycle: signal.cycle,
    });
    this.pending = this.pending.slice(-MAX_PENDING);
  }

  /** 每 cycle 檢查 pending blocks——價格行咗 >0.5% 就 resolve。 */
  check(currentPrices: ReadonlyMap<string, number>): void {
    const now = Date.now();
    const stillPending: BlockedSignal[] = [];
    for (const s of this.pending) {
      if (s.outcome) {
        stillPending.push(s);
        continue;
      }
      const price = currentPrices.get(normalizeSymbolKey(s.symbol));
      if (price === undefined) {
        if (now - s.recordedAt > MAX_PENDING_AGE_MS) continue; // 過期冇價——drop
        stillPending.push(s);
        continue;
      }
      const outcome = judgeGateOutcome(s.direction, s.side, s.entryPrice, price);
      if (outcome === 'pending') {
        if (now - s.recordedAt > MAX_PENDING_AGE_MS) {
          const move = (price - s.entryPrice) / s.entryPrice;
          s.outcome = forcedOutcome(s.direction, s.side, move);
          s.resolvedAt = now;
          s.movePct = move * 100;
          this.applyStats(s);
          continue;
        }
        stillPending.push(s);
        continue;
      }
      s.outcome = outcome;
      s.resolvedAt = now;
      s.movePct = ((price - s.entryPrice) / s.entryPrice) * 100;
      this.applyStats(s);
    }
    this.pending = stillPending;
    this.save();
  }

  private applyStats(s: BlockedSignal): void {
    const key = s.gate;
    const prev = this.stats.get(key);
    const st: GateStats = prev ?? { hits: 0, misses: 0, hitRate: 0, avgMovePct: 0 };
    if (s.outcome === 'hit') st.hits++;
    else st.misses++;
    const n = st.hits + st.misses;
    st.hitRate = st.hits / n;
    st.avgMovePct = ((st.avgMovePct * (n - 1)) + (s.movePct ?? 0)) / n;
    this.stats.set(key, st);
  }

  getStats(): Record<string, GateStats> {
    return Object.fromEntries(this.stats);
  }

  /** v2.0.873-P9-got-observe: per-gate 單行摘要（n≥5 先顯示——冷啟動樣本唔誤導）。
   *  用途：每 100 cycle log——低 hit rate gate 進入 P9-deadweight 停用候選流程。 */
  summary(): string {
    const parts: string[] = [];
    for (const [gate, st] of [...this.stats.entries()].sort((a, b) => (b[1].hits + b[1].misses) - (a[1].hits + a[1].misses))) {
      const n = st.hits + st.misses;
      if (n < 5) continue;
      parts.push(`${gate}=${(st.hitRate * 100).toFixed(0)}%(n=${n},avg=${st.avgMovePct.toFixed(2)}%)`);
    }
    return parts.length ? parts.join(' ') : 'no-gate-data';
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ pending: this.pending, stats: Object.fromEntries(this.stats) }, null, 2));
    } catch (err) {
      log.warn(`[gate-outcome] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { pending?: unknown; stats?: Record<string, unknown> };
      if (Array.isArray(raw.pending)) {
        this.pending = raw.pending
          .filter((s): s is BlockedSignal => !!s && typeof s === 'object' && typeof (s as BlockedSignal).symbol === 'string' && typeof (s as BlockedSignal).gate === 'string')
          // v2.0.873-P9-got-observe: legacy 'gate' bucket（無 gate 名 + close-defer 被
          // 誤標 direction 'buy'——v2.0.873 調查發現）不可歸因——丢弃, 從新數據開始
          .filter((s) => s.gate !== 'gate')
          .slice(-MAX_PENDING);
      }
      if (raw.stats && typeof raw.stats === 'object') {
        for (const [k, v] of Object.entries(raw.stats)) {
          const st = v as Partial<GateStats>;
          if (!st || typeof st !== 'object') continue;
          const hits = Number.isFinite(st.hits) ? Math.max(0, Math.floor(st.hits as number)) : 0;
          const misses = Number.isFinite(st.misses) ? Math.max(0, Math.floor(st.misses as number)) : 0;
          this.stats.set(k, {
            hits,
            misses,
            hitRate: hits + misses > 0 ? hits / (hits + misses) : 0,
            avgMovePct: Number.isFinite(st.avgMovePct) ? st.avgMovePct as number : 0,
          });
        }
      }
    } catch (err) {
      log.warn(`[gate-outcome] load failed (fresh start): ${err instanceof Error ? err.message : String(err)}`);
      this.pending = [];
      this.stats = new Map();
    }
  }
}
