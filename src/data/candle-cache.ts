// ─── Candle Cache Pool (v2.0.863) ──────────────────────────────────────
//
// 主神洞察:同一 symbol 嘅 chart data 被多個消費者重複 fetch——
//   getATR(1h 30支)/ getMomentum(1h 7支)/ fetchCandleHighLow(1h 50支)/
//   buildKlineBlock(1h 30支)/ support-resistance(1h+5m)/ mfe-calibrator(1h+5m)
//   ——一筆 trade 嘅 1h candles 被 fetch 4-5 次(浪費 + rate limit 風險)。
//
// 設計(Lazy Cache——最簡潔,天然消除重複):
//   · 第一次 call getCandles(symbol, interval) → fetch + 存 cache
//   · TTL 內同一 symbol+interval 嘅後續 call → cache hit(0 次 fetch)
//   · 同一 cycle:ATR → fetch(1h 存) → momentum → hit → kline → hit
//     = 1 次 fetch 供全部消費者
//   · 唔使 prefetch / round-robin——第一次用先 fetch
//
// Production-grade:
//   - TTL 90s(5 分鐘 cycle 內重用;下 cycle TTL 過期再 fetch)
//   - fallback:fetch 失敗 → null(消費者自行處理,唔 crash)
//   - bounded cache(最多 N 個 entry,LRU 逐出)
//   - 單一 fetch 並行保護(同一 key 並發 call 唔會 double-fetch)

import { createLogger } from '../observability/logger.ts';

const log = createLogger({ phase: 'candle-cache' });

export interface Candle {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

export interface CandleCacheConfig {
  /** TTL——TTL 內重用 cache(5 分鐘 cycle → 90s 合理) */
  ttlMs: number;
  /** max entries(LRU 逐出——bounded memory) */
  maxEntries: number;
  /** fetch 失敗時嘅重試冷卻(避免每 call 都 retry) */
  failCooldownMs: number;
}

const DEFAULT_CONFIG: CandleCacheConfig = {
  ttlMs: 90_000,
  maxEntries: 60, // 10 symbols × 2 intervals × 3 版本(保守)
  failCooldownMs: 10_000,
};

interface CacheEntry {
  candles: Candle[];
  ts: number;
  /** fetch 失敗時間(fail cooldown 用) */
  failTs: number;
}

/** HL candleSnapshot fetch(經 MarketAgent.hlFetch——global rate limiter) */
async function fetchCandles(symbol: string, interval: '1h' | '5m', count: number): Promise<Candle[] | null> {
  try {
    const { MarketAgent } = await import('../market-agent/index.ts');
    const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
    const endTime = Date.now();
    const intervalMs = interval === '1h' ? 3_600_000 : 300_000;
    const startTime = endTime - count * intervalMs;
    const data = await MarketAgent.hlFetch({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    }) as Array<{ t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    return data.map(cd => ({
      t: Number(cd.t ?? 0),
      o: Number(cd.o ?? 0), h: Number(cd.h ?? 0), l: Number(cd.l ?? 0),
      c: Number(cd.c ?? 0), v: Number(cd.v ?? 0),
    })).filter(cd => cd.o > 0 && Number.isFinite(cd.o));
  } catch (err) {
    log.warn(`[candle-cache] fetch ${symbol} ${interval} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export class CandleCache {
  private cache = new Map<string, CacheEntry>();
  /** 並行 fetch 保護:同一 key 同時 call → 共用一個 pending promise */
  private inflight = new Map<string, Promise<Candle[] | null>>();
  private config: CandleCacheConfig;

  constructor(config?: Partial<CandleCacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 攞 candles——cache hit 返回;miss 先 fetch(單次)。
   * TTL 內重用;fetch 失敗有 fail cooldown(唔會每 call 都 retry)。
   * malformed input → null(唔 crash)。
   */
  async getCandles(symbol: string, interval: '1h' | '5m', count = 100): Promise<Candle[] | null> {
    if (typeof symbol !== 'string' || symbol.length === 0) return null;
    const key = `${symbol.toLowerCase()}|${interval}`;
    const now = Date.now();

    // 1. cache hit(未過期)
    const hit = this.cache.get(key);
    if (hit && now - hit.ts < this.config.ttlMs) return hit.candles;

    // 2. fail cooldown——fetch 失敗後短時間唔 retry
    if (hit && hit.failTs > 0 && now - hit.failTs < this.config.failCooldownMs) return null;

    // 3. 並行 fetch 保護——同一 key 同時 call 共用一個 promise
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = fetchCandles(symbol, interval, count).then(candles => {
      if (candles && candles.length > 0) {
        this.cache.set(key, { candles, ts: now, failTs: 0 });
        this.evictIfNeeded();
      } else {
        // fetch 失敗——記錄 failTs 做 cooldown
        this.cache.set(key, { candles: [], ts: now, failTs: now });
      }
      this.inflight.delete(key);
      return candles;
    });
    this.inflight.set(key, promise);
    return promise;
  }

  /** LRU 逐出——超過 maxEntries 時移除最舊 entry */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.config.maxEntries) return;
    // 最舊(ts 最小)逐出
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of this.cache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey) this.cache.delete(oldestKey);
  }

  /** 統計(cache hit/miss 監察) */
  getStats(): { size: number; keys: string[] } {
    return { size: this.cache.size, keys: [...this.cache.keys()] };
  }
}

/** 全系統共享單例——所有消費者共用一個 cache 池 */
export const candleCache = new CandleCache();
