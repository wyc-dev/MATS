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
async function fetchCandles(symbol: string, interval: '1h' | '5m' | '15m', count: number): Promise<Candle[] | null> {
  try {
    const { MarketAgent } = await import('../market-agent/index.ts');
    const coin = symbol.includes(':') ? symbol : symbol.toUpperCase();
    const endTime = Date.now();
    const intervalMs = interval === '1h' ? 3_600_000 : interval === '5m' ? 300_000 : 900_000; // 15m = 900s
    // v2.0.863-cache-attack (V1): fetch 至少 100 支——cache 冇 count 維度,
    // 細 count 請求(getMomentum 7支)先 fill 會令大 count 消費者(getATR 30支)
    // 攞唔夠支 → computeATR 唔夠 period+1 → ATR=0 → SL 冇 ATR 保護。
    // 統一 fetch 100+ 支,消費者自行 slice 所需——cache 永遠夠用。
    const fetchCount = Math.max(100, count);
    const startTime = endTime - fetchCount * intervalMs;
    // v2.0.869(主神 並行 candle 測試):HL DEX 資產(貴金屬/指數——SILVER/GOLD/SP500)
    // 需要 xyz: 前綴——冇前綴 HL API 500(throw)。嘗試冇前綴——catch 後再試 xyz: 前綴。
    let data: Array<{ t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }> | null = null;
    try {
      data = await MarketAgent.hlFetch({
        type: 'candleSnapshot',
        req: { coin, interval, startTime, endTime },
      }) as Array<{ t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }>;
    } catch {
      // 500(throw)——fallback:試 xyz: 前綴(DEX 資產)
      if (!symbol.includes(':')) {
        const dexCoin = `xyz:${coin}`;
        data = await MarketAgent.hlFetch({
          type: 'candleSnapshot',
          req: { coin: dexCoin, interval, startTime, endTime },
        }) as Array<{ t?: string; o?: string; h?: string; l?: string; c?: string; v?: string }>;
      }
    }
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
  /** v2.0.863-cache-attack: 依賴注入——測試可傳 mock fetchFn(默認真實 HL) */
  private fetchFn: (symbol: string, interval: '1h' | '5m' | '15m', count: number) => Promise<Candle[] | null>;

  constructor(config?: Partial<CandleCacheConfig>, fetchFn?: (symbol: string, interval: '1h' | '5m' | '15m', count: number) => Promise<Candle[] | null>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fetchFn = fetchFn ?? fetchCandles;
  }

  /**
   * 攞 candles——cache hit 返回;miss 先 fetch(單次)。
   * TTL 內重用;fetch 失敗有 fail cooldown(唔會每 call 都 retry)。
   * malformed input → null(唔 crash)。
   */
  async getCandles(symbol: string, interval: '1h' | '5m' | '15m', count = 100): Promise<Candle[] | null> {
    if (typeof symbol !== 'string' || symbol.length === 0) return null;
    const key = `${symbol.toLowerCase()}|${interval}`;
    const now = Date.now();

    // 1. fail cooldown 優先——fetch 失敗後短時間唔 retry(亦唔當成功返 []),
    //    v2.0.863-cache-attack: fail 檢查必須喺 ttl 檢查之前,否則 fail entry
    //    喺 TTL 內被當成功返回空 []——failCooldown 永遠到唔到。
    const hit = this.cache.get(key);
    if (hit && hit.failTs > 0) {
      if (now - hit.failTs < this.config.failCooldownMs) return null;
      // cooldown 過咗 → 可以 retry(當 miss 處理)
    }

    // 2. cache hit(未過期,且唔係 fail entry)
    if (hit && now - hit.ts < this.config.ttlMs && hit.failTs === 0) return hit.candles;

    // 3. 並行 fetch 保護——同一 key 同時 call 共用一個 promise
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = this.fetchFn(symbol, interval, count).then(candles => {
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

  /**
   * P78: 同步讀取 cache（唔 fetch）——gate 堆疊係同步執行，用 cached candle
   * 判斷即時結構（momentum 層每 cycle 已 warm cache）。cache miss → null（中性，唔干擾）。
   * FIX-4（攻擊輪 D1）: copy-on-read——返回深 copy，caller mutate 唔污染 cache
   * （P28-attack B5 教訓: getMomentumSnapshot 返回內部引用 → 外部 mutate 污染 store）。
   */
  peekCandles(symbol: string, interval: '1h' | '5m' | '15m'): Candle[] | null {
    if (typeof symbol !== 'string' || symbol.length === 0) return null;
    const key = `${symbol.toLowerCase()}|${interval}`;
    const hit = this.cache.get(key);
    if (!hit || hit.failTs > 0) return null;
    return hit.candles.length > 0 ? hit.candles.map(c => ({ ...c })) : null;
  }

  /** 統計(cache hit/miss 監察) */
  getStats(): { size: number; keys: string[] } {
    return { size: this.cache.size, keys: [...this.cache.keys()] };
  }
}

/** 全系統共享單例——所有消費者共用一個 cache 池 */
export const candleCache = new CandleCache();
