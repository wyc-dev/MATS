// ─── Market Agent ───
// Selects the highest-volume trading pair from Binance or Hyperliquid,
// manages exchange/trade-mode config, and feeds the selected symbol
// into the HACP decision cycle for all 6 agents to analyse.

import { createLogger } from '../observability/logger.ts';
import { config } from '../config/index.ts';
import { HLRateLimiter } from './hl-rate-limiter.ts';
import { hlRateLimitedFetch } from '../utils/hl-global-limiter.ts';
import { setHLFetchFn } from '../analysis/support-resistance.ts';
import { setHLFetchFnForATR } from '../analysis/atr.ts';
import type {
  MarketAgentConfig,
  TopVolumePair,
  TradeMode,
  ExchangeType,
  HyperliquidAssetType,
} from '../types/index.ts';

const log = createLogger({ phase: 'market-agent' });

// ─── Default config ───

const DEFAULT_CONFIG: MarketAgentConfig = {
  tradeMode: 'paper',
  exchange: 'hyperliquid',
  selectedSymbol: '',
  hyperliquidAssetType: 'crypto_perps',
  positionSizePct: 0.10,
  leverage: 10,
  updatedAt: Date.now(),
};

// ─── Market Agent Class ───

export class MarketAgent {
  private config: MarketAgentConfig = { ...DEFAULT_CONFIG };
  private topPairs: TopVolumePair[] = [];
  private lastFetchTime = 0;
  private readonly FETCH_COOLDOWN_MS = 30_000;
  private fetchInProgress = false;
  /** Tracks whether exchange has changed since last fetch — forces re-fetch */
  private configDirty = false;
  /**
   * v2.0.44: When true, autoSelectTopPair() will NOT override the user's
   * manual symbol selection. Set by setSelectedSymbolManual(). Cleared by
   * setSelectedSymbol('') or setTradeMode() (mode change resets selection).
   */
  private manualSymbolLock = false;
  /** HL rate limiter (8 tokens, 3s refill) shared across all calls */
  private static hlLimiter = new HLRateLimiter(8, 3_000);
  /** Cache for allPerpMetas + perpCategories (rarely changes) */
  private static metaCache: { metas: unknown; categories: unknown; ts: number } | null = null;
  private static readonly META_CACHE_TTL = 300_000; // 5 min
  /** Cache for metaAndAssetCtxs (ALL DEX 0 prices, volumes, changes) — shared between fetchTopPairs and fetchPriceForSymbol */
  private static dex0CtxsCache: { timestamp: number; data: Array<{ name: string; price: number; volume24h: number; change24h: number }> } | null = null;

  /**
   * Register the S/R module's HL fetch function with our rate-limited endpoint.
   * Called once during startup.
   */
  static registerSRModule(): void {
    setHLFetchFn((body: unknown) => MarketAgent.hlFetch(body));
    // v2.0.73 S2.3: register ATR module's HL fetch fn too (same rate-limited endpoint)
    setHLFetchFnForATR((body: unknown) => MarketAgent.hlFetch(body));
  }

  /**
   * Rate-limited HL info endpoint fetch.
   * v2.0.XX: Now routes through the GLOBAL rate limiter (hl-global-limiter.ts)
   * instead of the per-class HLRateLimiter. This ensures ALL HL API calls
   * across the entire process share one queue, preventing 429 storms.
   * Exposed for external modules (S/R detector, ATR, etc.) to share the same limiter.
   */
  static async hlFetch(body: unknown): Promise<unknown> {
    const res = await hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`HL fetch failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<unknown>;
  }
  private static readonly DEX0_CACHE_TTL = 60_000; // 60s — refreshed each cycle's first consumer
  /** Caches previous prices per symbol to compute 24h change for DEX 1-8 assets */
  private previousPriceCache = new Map<string, { price: number; prevDay: number }>();

  // Callbacks for when the selected symbol changes
  private onSymbolChange: ((symbol: string) => void) | null = null;

  constructor() {
    log.info('Market Agent initialized', { exchange: this.config.exchange, symbol: this.config.selectedSymbol });
  }

  // ── Config Getters ──

  getConfig(): Readonly<MarketAgentConfig> {
    return { ...this.config };
  }

  getTradeMode(): TradeMode {
    return this.config.tradeMode;
  }

  getExchange(): ExchangeType {
    return this.config.exchange;
  }

  getSelectedSymbol(): string {
    return this.config.selectedSymbol;
  }

  getTopPairs(): readonly TopVolumePair[] {
    return this.topPairs;
  }

  /** Returns the timestamp (ms epoch) of the last successful REST fetch */
  getLastFetchTime(): number {
    return this.lastFetchTime;
  }

  /** Returns true if the Market Agent has a valid symbol — allows fallback to previously selected symbol */
  hasValidSymbol(): boolean {
    return this.config.selectedSymbol.length > 0;
  }

  // ── Config Setters ──

  setTradeMode(mode: TradeMode): void {
    if (this.config.tradeMode === mode) return;
    this.config.tradeMode = mode;
    this.config.updatedAt = Date.now();
    // v2.0.64: Do NOT clear manualSymbolLock on trade mode change.
    // The user's market selection should persist across PAPER↔REAL switches.
    // Only setExchange() and setHyperliquidAssetType() clear the lock (they
    // change the market category, which invalidates the selection).
    log.info(`Trade mode changed: ${mode}`);
  }

  setExchange(exchange: ExchangeType): void {
    if (this.config.exchange === exchange) return;
    this.config.exchange = exchange;
    this.config.updatedAt = Date.now();
    this.config.selectedSymbol = '';
    this.topPairs = [];
    this.configDirty = true;
    // v2.0.46: Clear manual lock — exchange change means fresh market.
    this.manualSymbolLock = false;
    log.info(`Exchange changed: ${exchange}`);
  }

  setHyperliquidAssetType(assetType: HyperliquidAssetType): void {
    if (this.config.hyperliquidAssetType === assetType) return;
    this.config.hyperliquidAssetType = assetType;
    this.config.updatedAt = Date.now();
    // Don't clear topPairs — client-side filter temporarily keeps showable data while re-fetching
    this.configDirty = true;
    // v2.0.46: Clear manual lock — asset type change means different market category.
    this.manualSymbolLock = false;
    log.info(`Hyperliquid asset type changed: ${assetType} (re-fetch queued)`);
  }

  /**
   * v2.0.44: Manual symbol selection — sets the lock flag so autoSelectTopPair()
   * does NOT override this choice on the next cycle. The user explicitly chose
   * this market from the Top Volume Pairs list.
   */
  setSelectedSymbolManual(symbol: string): void {
    this.manualSymbolLock = true;
    this.setSelectedSymbol(symbol);
  }

  /** v2.0.44: Clear the manual lock (e.g. when switching trade mode). */
  clearManualSymbolLock(): void {
    this.manualSymbolLock = false;
  }

  /** v2.0.44: Returns true if the user has manually locked a symbol. */
  isManualSymbolLocked(): boolean {
    return this.manualSymbolLock;
  }

  setSelectedSymbol(symbol: string): void {
    if (this.config.selectedSymbol === symbol) return;
    this.config.selectedSymbol = symbol;
    this.config.updatedAt = Date.now();
    log.info(`Selected symbol changed: ${symbol}`);
    if (this.onSymbolChange) {
      this.onSymbolChange(symbol);
    }
  }

  setPositionSizePct(pct: number): void {
    const clamped = Math.max(0.01, Math.min(0.20, pct));
    if (Math.abs(this.config.positionSizePct - clamped) < 0.001) return;
    this.config.positionSizePct = clamped;
    this.config.updatedAt = Date.now();
    log.info(`Position size changed: ${(clamped * 100).toFixed(1)}%`);
  }

  setLeverage(lev: number): void {
    const clamped = Math.max(1, Math.min(10, Math.round(lev)));
    if (this.config.leverage === clamped) return;
    this.config.leverage = clamped;
    this.config.updatedAt = Date.now();
    log.info(`Leverage changed: ${clamped}x`);
  }

  /** Register callback for symbol changes */
  onSymbolChanged(cb: (symbol: string) => void): void {
    this.onSymbolChange = cb;
  }

  // ── Top Volume Pair Fetching ──

  /**
   * Fetch top volume pairs from the currently selected exchange.
   * Returns the top N pairs sorted by 24h USDT volume descending.
   */
  async fetchTopPairs(limit = 30): Promise<TopVolumePair[]> {
    if (this.fetchInProgress) {
      log.debug('Fetch already in progress, returning cached data');
      return this.topPairs;
    }

    const now = Date.now();
    // Skip cooldown if exchange or asset type just changed
    if (!this.configDirty && this.topPairs.length > 0 && now - this.lastFetchTime < this.FETCH_COOLDOWN_MS) {
      return this.topPairs;
    }

    this.fetchInProgress = true;
    const wasDirty = this.configDirty;
    this.configDirty = false;

    // Keep old topPairs visible while fetching — don't clear them
    const oldPairs = this.topPairs;

    try {
      if (this.config.exchange === 'binance') {
        this.topPairs = await this.fetchBinanceTopPairs(limit);
      } else {
        this.topPairs = await this.fetchHyperliquidTopPairs(limit, wasDirty);
      }
      this.lastFetchTime = Date.now();

      // v2.0.46: Auto-select the top pair — but ONLY if the user hasn't
      // manually locked a symbol. fetchTopPairs() is called from both
      // autoSelectTopPair() and the UI refresh button, so this guard is
      // critical to prevent overriding the user's manual selection.
      if (this.topPairs.length > 0 && !this.manualSymbolLock) {
        const top = this.topPairs[0]!;
        if (this.config.selectedSymbol !== top.symbol) {
          this.config.selectedSymbol = top.symbol;
          log.info(`Auto-selected top pair: ${top.symbol} ($${(top.volume24h / 1_000_000).toFixed(1)}M vol)`);
          if (this.onSymbolChange) {
            this.onSymbolChange(top.symbol);
          }
        }
      }

      log.info(`Fetched ${this.topPairs.length} top pairs from ${this.config.exchange}`);
    } catch (err) {
      log.error(`Failed to fetch top pairs: ${err instanceof Error ? err.message : String(err)}`);
      if (wasDirty && oldPairs.length > 0) {
        this.topPairs = oldPairs;
        log.info('Reverted to previous top pairs after fetch failure');
      }
    } finally {
      this.fetchInProgress = false;
    }

    return this.topPairs;
  }

  /**
   * Fetch top USDT volume pairs from Binance spot.
   * Uses /api/v3/ticker/24hr which returns all tickers.
   */
  private async fetchBinanceTopPairs(limit: number): Promise<TopVolumePair[]> {
    const url = `${config.binance.restUrl}/api/v3/ticker/24hr`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance 24hr ticker returned ${res.status}`);
    }

    const allTickers = await res.json() as Array<{
      symbol: string;
      lastPrice: string;
      volume: string;
      quoteVolume: string;
      priceChangePercent: string;
    }>;

    // Filter for USDT pairs only, exclude stablecoins and leveraged tokens
    const stablecoins = new Set(['USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI', 'USDX']);
    const usdtPairs = allTickers
      .filter(t => {
        if (!t.symbol.endsWith('USDT')) return false;
        const base = t.symbol.replace('USDT', '');
        if (stablecoins.has(base)) return false;
        if (t.symbol.includes('UP') || t.symbol.includes('DOWN') || t.symbol.includes('BULL') || t.symbol.includes('BEAR')) return false;
        return true;
      })
      .map(t => ({
        symbol: t.symbol,
        volume24h: parseFloat(t.quoteVolume) || 0,
        price: parseFloat(t.lastPrice) || 0,
        priceChangePercent: parseFloat(t.priceChangePercent) || 0,
        exchange: 'binance' as const,
      }))
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, limit);

    return usdtPairs;
  }

  /**
   * Fetch top notional volume pairs from ALL Hyperliquid DEXs.
   *
   * Hyperliquid has 9 perp DEXs with 416 total assets across categories:
   *   DEX 0 (first perp): 230 crypto perps
   *   DEX 1 (xyz):  84 assets — stocks, indices, FX, commodities, preIPO
   *   DEX 2 (flx):  16 assets — stocks, crypto, commodities
   *   DEX 3 (vntl): 15 assets — preIPO, indices, commodities, stocks
   *   DEX 4 (hyna): 25 assets — crypto
   *   DEX 5 (km):   23 assets — stocks, indices, commodities, FX
   *   DEX 6 (abcd):  1 asset  — indices
   *   DEX 7 (cash): 17 assets — stocks, indices
   *   DEX 8 (para):  5 assets — crypto
   *
   * Volume source for ALL DEXs: metaAndAssetCtxs (dayNtlVlm = USD notional) for DEX 0,
   * candleSnapshot (v = raw contract units) for DEX 1-8, converted to USD notional (v * price).
   */
  private async fetchHyperliquidTopPairs(limit: number, wasDirty?: boolean): Promise<TopVolumePair[]> {
    // v2.0.XX: Use the global rate limiter instead of per-class HLRateLimiter.
    // This ensures fetchTopPairs shares the same request budget as the HL real
    // engine, candle proxy, REST polling, S/R detector, and ATR — preventing
    // 429 storms when multiple modules fire simultaneously.
    const hlFetch = async (body: object): Promise<Response> => {
      return hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    };

    // ── Step 1: fetch metadata + categories (cached for 5 min) + DEX 0 price/volume ──
    let allMetas: Array<{ universe: Array<{ name: string; szDecimals: number }> }>;
    let categories: Array<[string, string]>;

    const now = Date.now();
    if (MarketAgent.metaCache && now - MarketAgent.metaCache.ts < MarketAgent.META_CACHE_TTL) {
      allMetas = MarketAgent.metaCache.metas as typeof allMetas;
      categories = MarketAgent.metaCache.categories as typeof categories;
      log.info('HL meta cache hit');
    } else {
      const [metaRes, catRes] = await Promise.all([
        hlFetch({ type: 'allPerpMetas' }),
        hlFetch({ type: 'perpCategories' }),
      ]);
      if (!metaRes.ok) throw new Error(`allPerpMetas returned ${metaRes.status}`);
      allMetas = await metaRes.json() as typeof allMetas;
      categories = catRes.ok ? await catRes.json() as typeof categories : [];
      MarketAgent.metaCache = { metas: allMetas, categories, ts: now };
    }

    const ctxsRes = await hlFetch({ type: 'metaAndAssetCtxs' });
    if (!ctxsRes.ok) throw new Error(`metaAndAssetCtxs returned ${ctxsRes.status}`);

    const [dex0Meta, dex0Ctxs] = await ctxsRes.json() as [
      { universe: Array<{ name: string }> },
      Array<{ dayNtlVlm: string; markPx: string; midPx: string; prevDayPx: string }>,
    ];

    // Cache dex0Ctxs for fetchPriceForSymbol — avoids duplicate metaAndAssetCtxs REST calls in the same cycle
    const cachedEntries: Array<{ name: string; price: number; volume24h: number; change24h: number }> = [];
    for (let i = 0; i < dex0Meta.universe.length && i < dex0Ctxs.length; i++) {
      const name = dex0Meta.universe[i]!.name;
      const ctx = dex0Ctxs[i]!;
      const price = parseFloat(ctx.markPx) || parseFloat(ctx.midPx) || 0;
      const volume24h = parseFloat(ctx.dayNtlVlm) || 0;
      const prevDay = parseFloat(ctx.prevDayPx) || price;
      const change24h = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : 0;
      cachedEntries.push({ name, price, volume24h, change24h });
    }
    MarketAgent.dex0CtxsCache = { timestamp: Date.now(), data: cachedEntries };

    // ── Step 2: build category lookup ──
    const catMap = new Map<string, string>();
    for (const [asset, cat] of categories) {
      catMap.set(asset, cat);
    }

    // ── Step 3: build DEX 0 pairs (has real USD notional volume) ───
    const dex0Names = new Map<string, number>();
    for (let i = 0; i < dex0Meta.universe.length; i++) {
      dex0Names.set(dex0Meta.universe[i]!.name, i);
    }

    const allPairs: TopVolumePair[] = [];

    for (let i = 0; i < dex0Meta.universe.length && i < dex0Ctxs.length; i++) {
      const name = dex0Meta.universe[i]!.name;
      const ctx = dex0Ctxs[i]!;
      const volume = parseFloat(ctx.dayNtlVlm) || 0;
      const price = parseFloat(ctx.markPx) || parseFloat(ctx.midPx) || 0;
      const prevDay = parseFloat(ctx.prevDayPx) || price;
      const changePct = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : 0;
      allPairs.push({ symbol: name, volume24h: volume, price, priceChangePercent: changePct, exchange: 'hyperliquid' });
    }

    // Fetch 5m volume for top DEX 0 pairs via candleSnapshot
    const top5Pairs = allPairs.slice(0, 5);
    if (top5Pairs.length > 0) {
      try {
        // v2.0.XX: Use global rate limiter instead of per-call bgLimiter
        const bgFetch = async (body: object): Promise<Response> => {
          return hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        };
        await Promise.all(top5Pairs.map(async (pair) => {
          try {
            const res = await bgFetch({
              type: 'candleSnapshot',
              req: { coin: pair.symbol, interval: '5m', startTime: Date.now() - 3_600_000, endTime: Date.now() },
            });
            if (res.ok) {
              const data = await res.json() as Array<Record<string, string>>;
              if (Array.isArray(data) && data.length > 0) {
                let vol5m = 0;
                for (const c of data) {
                  const v = parseFloat(c['v'] ?? '0');
                  if (!isNaN(v)) vol5m += v;
                }
                if (vol5m > 0 && pair.price > 0) pair.volume5m = vol5m * pair.price;
              }
            }
          } catch { /* 5m volume optional */ }
        }));
      } catch { /* 5m volume is optional */ }
    }

    // ── Step 4: build DEX 1-8 pairs (NON-BLOCKING — background scan)
    // Return DEX 0 pairs immediately so UI doesn't go blank.
    // DEX 1-8 assets are added to allPairs asynchronously.
    const activeType = this.config.hyperliquidAssetType ?? 'crypto_perps';
    const getTargetCategories = (type: string): string[] | null => {
      switch (type) {
        case 'crypto_perps': return ['crypto'];
        case 'tradfi': return ['indices', 'stocks', 'commodities', 'FX', 'fx', 'preipo'];
        case 'indices': return ['indices'];
        case 'stocks': return ['stocks'];
        case 'commodities': return ['commodities'];
        case 'fx': return ['FX', 'fx'];
        default: return null;
      }
    };
    const targetCats = getTargetCategories(activeType);

    const otherAssets: Array<{ name: string; coin: string }> = [];
    for (let d = 1; d < allMetas.length; d++) {
      for (const u of allMetas[d]!.universe) {
        if (!dex0Names.has(u.name)) {
          const cat = catMap.get(u.name);
          if (targetCats === null || (cat && targetCats.includes(cat))) {
            let coin = u.name;
            for (const [catKey] of catMap) {
              if (catKey.endsWith(':' + u.name)) { coin = catKey; break; }
            }
            otherAssets.push({ name: u.name, coin });
          }
        }
      }
    }

    // Kick off DEX 1-8 background scan — does NOT block the return
    const backgroundTask = otherAssets.length > 0
      ? this.scanDEX18AssetsInBackground(otherAssets, allPairs, hlFetch)
      : Promise.resolve();

    // ── Step 5: filter by asset type and sort ──
    const filtered = this.filterHyperliquidPairs(allPairs, catMap);

    const result = filtered.sort((a, b) => {
      if (a.volume24h > 0 && b.volume24h > 0) return b.volume24h - a.volume24h;
      if (a.volume24h > 0) return -1;
      if (b.volume24h > 0) return 1;
      return b.price - a.price;
    }).slice(0, limit);

    // If config just changed (asset type), WAIT for background scan so user sees real pairs immediately.
    // Otherwise, return DEX 0 pairs first and let background fill in later.
    if (wasDirty && otherAssets.length > 0) {
      await backgroundTask;
      const updated = this.filterHyperliquidPairs(allPairs, catMap);
      const sorted = updated.sort((a, b) => {
        if (a.volume24h > 0 && b.volume24h > 0) return b.volume24h - a.volume24h;
        if (a.volume24h > 0) return -1;
        if (b.volume24h > 0) return 1;
        return b.price - a.price;
      }).slice(0, limit);
      this.topPairs = sorted;

      // ── Fetch real 5m volume for top 5 pairs ──
      if (sorted.length > 0) {
        const top5 = sorted.slice(0, 5);
        // v2.0.XX: Use global rate limiter
        const bgFetch = async (body: object): Promise<Response> => {
          return hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        };
        await Promise.all(top5.map(async (pair) => {
          try {
            const res = await bgFetch({
              type: 'candleSnapshot',
              req: { coin: pair.symbol, interval: '5m', startTime: Date.now() - 3_600_000, endTime: Date.now() },
            });
            if (res.ok) {
              const data = await res.json() as Array<Record<string, string>>;
              if (Array.isArray(data) && data.length > 0) {
                let vol5m = 0;
                for (const c of data) {
                  const v = parseFloat(c['v'] ?? '0');
                  if (!isNaN(v)) vol5m += v;
                }
                if (vol5m > 0 && pair.price > 0) pair.volume5m = vol5m * pair.price;
              }
            }
          } catch { /* 5m volume optional */ }
        }));
      }

      // v2.0.46: Auto-select top pair after background scan — respect manual lock.
      if (sorted.length > 0 && !this.manualSymbolLock) {
        const top = sorted[0]!;
        if (this.config.selectedSymbol !== top.symbol) {
          this.config.selectedSymbol = top.symbol;
          log.info(`Auto-selected top pair: ${top.symbol} ($${(top.volume24h / 1_000_000).toFixed(1)}M vol)`);
          if (this.onSymbolChange) {
            this.onSymbolChange(top.symbol);
          }
        }
      }
      return sorted;
    }

    // Background fill for non-dirty fetches
    backgroundTask.then(async () => {
      const updated = this.filterHyperliquidPairs(allPairs, catMap);
      const sorted = updated.sort((a, b) => {
        if (a.volume24h > 0 && b.volume24h > 0) return b.volume24h - a.volume24h;
        if (a.volume24h > 0) return -1;
        if (b.volume24h > 0) return 1;
        return b.price - a.price;
      }).slice(0, limit);
      this.topPairs = sorted;

      // ── Fetch real 5m volume for top 5 pairs ──
      if (sorted.length > 0) {
        const top5 = sorted.slice(0, 5);
        // v2.0.XX: Use global rate limiter
        const bgFetch = async (body: object): Promise<Response> => {
          return hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        };
        await Promise.all(top5.map(async (pair) => {
          try {
            const res = await bgFetch({
              type: 'candleSnapshot',
              req: { coin: pair.symbol, interval: '5m', startTime: Date.now() - 3_600_000, endTime: Date.now() },
            });
            if (res.ok) {
              const data = await res.json() as Array<Record<string, string>>;
              if (Array.isArray(data) && data.length > 0) {
                let vol5m = 0;
                for (const c of data) {
                  const v = parseFloat(c['v'] ?? '0');
                  if (!isNaN(v)) vol5m += v;
                }
                if (vol5m > 0 && pair.price > 0) pair.volume5m = vol5m * pair.price;
              }
            }
          } catch { /* 5m volume optional */ }
        }));
      }

      // v2.0.46: Auto-select top pair after background scan — respect manual lock.
      if (sorted.length > 0 && !this.manualSymbolLock) {
        const top = sorted[0]!;
        if (this.config.selectedSymbol !== top.symbol) {
          this.config.selectedSymbol = top.symbol;
          log.info(`Background scan: auto-selected top pair: ${top.symbol}`);
          if (this.onSymbolChange) {
            this.onSymbolChange(top.symbol);
          }
        }
      }
    }).catch((err: unknown) => {
      log.error(`Background scan failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return result;
  }

  /** Background scan of DEX 1-8 assets — completely non-blocking */
  private async scanDEX18AssetsInBackground(assets: Array<{ name: string; coin: string }>, allPairs: TopVolumePair[], hlFetch: (body: object, retries?: number) => Promise<Response>): Promise<void> {
    if (assets.length === 0) return;
    log.info(`DEX 1-8: background-scanning ${assets.length} assets (via candleSnapshot)`);

    // v2.0.XX: Use global rate limiter — no per-scan bgLimiter needed.
    // The global limiter handles 429 retries with exponential backoff.
    const bgFetch = async (body: object): Promise<Response> => {
      return hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    };

    // candleSnapshot gives both price (c=close) and volume (v=raw contracts)
    const scanOne = async (asset: { name: string; coin: string }): Promise<void> => {
      try {
        const snapRes = await bgFetch({
          type: 'candleSnapshot',
          req: { coin: asset.coin, interval: '1d', startTime: Date.now() - 172_800_000, endTime: Date.now() },
        });
        let price = 0;
        let volume = 0;
        if (snapRes.ok) {
          const snapData = await snapRes.json() as Array<Record<string, string>>;
          if (Array.isArray(snapData) && snapData.length > 0) {
            const last = snapData[snapData.length - 1]!;
            price = parseFloat(last['c'] ?? '0');
            for (const c of snapData) {
              const v = parseFloat(c['v'] ?? '0');
              if (!isNaN(v)) volume += v;
            }
            if (volume > 0 && price > 0) volume = volume * price;
          }
        }
        if (price > 0) {
          const stored = this.previousPriceCache.get(asset.name);
          const changePct = stored?.prevDay && stored.prevDay > 0 ? ((price - stored.prevDay) / stored.prevDay) * 100 : 0;
          allPairs.push({ symbol: asset.coin, volume24h: volume, volume5m: 0, price, priceChangePercent: changePct, exchange: 'hyperliquid' });
          this.previousPriceCache.set(asset.name, { price, prevDay: stored?.price ?? price });
        }
      } catch { /* skip individual asset */ }
    };

    // Process in batches of 5 concurrent
    const promises: Promise<void>[] = [];
    for (const asset of assets) {
      promises.push(scanOne(asset));
      if (promises.length >= 5) {
        await Promise.all(promises);
        promises.length = 0;
      }
    }
    if (promises.length > 0) await Promise.all(promises);

    log.info(`DEX 1-8 background: scan complete — ${assets.length} assets processed`);
  }

  /**
   * Filter Hyperliquid pairs by asset type using perpCategories mapping.
   *
   * Mapping from perpCategories endpoint:
   *   indices, stocks, commodities, FX/fx, crypto, preipo
   *
   * Asset naming convention: {dex}:{NAME} e.g. xyz:SP500, flx:NVDA, km:MU
   */
  private filterHyperliquidPairs(pairs: TopVolumePair[], catMap: Map<string, string>): TopVolumePair[] {
    const assetType = this.config.hyperliquidAssetType ?? 'crypto_perps';

    // Build a map of symbol → perpCategories category
    const symCat = new Map<string, string>();
    for (const [asset, cat] of catMap) {
      symCat.set(asset, cat);
    }

    switch (assetType) {
      case 'crypto_perps':
        return pairs.filter(p => {
          const cat = symCat.get(p.symbol);
          // DEX 0 bare symbols (BTC, ETH, SOL) are always crypto
          if (!p.symbol.includes(':')) return true;
          return cat === 'crypto';
        });

      case 'tradfi':
        return pairs.filter(p => {
          const cat = symCat.get(p.symbol);
          return cat === 'indices' || cat === 'stocks' || cat === 'commodities' || cat === 'FX' || cat === 'fx' || cat === 'preipo';
        });

      case 'indices':
        return pairs.filter(p => symCat.get(p.symbol) === 'indices');

      case 'stocks':
        return pairs.filter(p => symCat.get(p.symbol) === 'stocks');

      case 'commodities':
        return pairs.filter(p => symCat.get(p.symbol) === 'commodities');

      case 'fx':
        return pairs.filter(p => {
          const cat = symCat.get(p.symbol);
          return cat === 'FX' || cat === 'fx';
        });

      default:
        return pairs;
    }
  }

  /**
   * Auto-select the top volume pair.
   * Always fetches fresh data and picks #1. Called at the start of each HACP cycle.
   * Returns the selected symbol.
   *
   * v2.0.44: If the user has manually selected a symbol (manualSymbolLock=true),
   * this method will NOT override their choice. It still fetches fresh top pairs
   * data (for the UI table) but keeps the user's selected symbol.
   */
  async autoSelectTopPair(): Promise<string> {
    await this.fetchTopPairs(30);
    // v2.0.44: Respect manual symbol lock — don't override user's choice.
    if (this.manualSymbolLock && this.config.selectedSymbol) {
      log.info(`Manual symbol lock active — keeping user-selected: ${this.config.selectedSymbol}`);
      return this.config.selectedSymbol;
    }
    if (this.topPairs.length > 0) {
      const top = this.topPairs[0]!;
      if (this.config.selectedSymbol !== top.symbol) {
        this.config.selectedSymbol = top.symbol;
        this.config.updatedAt = Date.now();
        log.info(`Auto-selected top pair: ${top.symbol} ($${(top.volume24h / 1_000_000).toFixed(1)}M vol)`);
        if (this.onSymbolChange) {
          this.onSymbolChange(top.symbol);
        }
      }
    } else {
      // If fetch failed (e.g. HL 429), keep previous symbol — don't block the cycle
      if (this.config.selectedSymbol) {
        log.warn(`Top pairs fetch returned empty — keeping previous symbol: ${this.config.selectedSymbol}`);
      } else {
        log.warn('Top pairs fetch returned empty and no previous symbol available');
      }
    }
    return this.config.selectedSymbol;
  }

  /**
   * Fetch current price for any symbol from the active exchange via REST.
   * Works for both first-perp-dex assets (via metaAndAssetCtxs) and 
   * all other DEX assets (via l2Book).
   */
  async fetchPriceForSymbol(symbol: string): Promise<{ price: number; volume24h: number; change24h: number }> {
    // v2.0.XX: Use global rate limiter
    const hlFetch = async (body: object): Promise<Response> => {
      return hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    };

    try {
      // ── Check dex0Ctxs cache FIRST (populated by fetchHyperliquidTopPairs) ──
      if (this.config.exchange !== 'binance') {
        const cached = MarketAgent.dex0CtxsCache;
        if (cached && Date.now() - cached.timestamp < MarketAgent.DEX0_CACHE_TTL) {
          const entry = cached.data.find(e => e.name === symbol.toUpperCase());
          if (entry) {
            log.debug(`[price-cache] HIT for ${symbol} (${(Date.now() - cached.timestamp) / 1000}s old)`);
            return { price: entry.price, volume24h: entry.volume24h, change24h: entry.change24h };
          }
        }
      }

      if (this.config.exchange === 'binance') {
        let res = await fetch(`${config.binance.futuresRestUrl}/fapi/v1/ticker/24hr?symbol=${symbol.toUpperCase()}`);
        if (!res.ok) {
          res = await fetch(`${config.binance.restUrl}/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`);
        }
        if (res.ok) {
          const data = await res.json() as Record<string, string>;
          return {
            price: parseFloat(data['lastPrice'] ?? '0'),
            volume24h: parseFloat(data['quoteVolume'] ?? '0'),
            change24h: parseFloat(data['priceChangePercent'] ?? '0'),
          };
        }
      } else {
        // Cache miss — fetch fresh metaAndAssetCtxs (single REST call that has ALL prices + volumes)
        const dex0Res = await hlFetch({ type: 'metaAndAssetCtxs' }).catch(() => null);

        // Check DEX 0 first (has dayNtlVlm for bare symbols like BTC, ETH)
        if (dex0Res?.ok && !symbol.includes(':')) {
          const dex0 = await dex0Res.json() as [
            { universe: Array<{ name: string }> },
            Array<{ dayNtlVlm: string; markPx: string; prevDayPx: string }>,
          ];
          const idx = dex0[0]?.universe?.findIndex((u: { name: string }) => u.name === symbol);
          if (idx !== undefined && idx >= 0 && idx < dex0[1]?.length) {
            const ctx = dex0[1][idx]!;
            const price = parseFloat(ctx.markPx) || 0;
            const volume24h = parseFloat(ctx.dayNtlVlm) || 0;
            const prevDay = parseFloat(ctx.prevDayPx) || price;
            const change24h = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : 0;
            return { price, volume24h, change24h };
          }
        }

        // Colon symbol or not found in DEX 0: l2Book for price + candleSnapshot for volume
        if (symbol.includes(':')) {
          const [bookRes, snapRes] = await Promise.all([
            hlFetch({ type: 'l2Book', coin: symbol }),
            hlFetch({
              type: 'candleSnapshot',
              // candleSnapshot requires FULL coin name (e.g. "xyz:META" not "META")
              req: { coin: symbol, interval: '1d', startTime: Date.now() - 172_800_000, endTime: Date.now() },
            }),
          ]);
          let price = 0;
          let volume = 0;
          if (bookRes.ok) {
            const book = await bookRes.json() as { levels: Array<Array<{ px: string }>> };
            price = parseFloat(book.levels?.[0]?.[0]?.px ?? '0');
          }
          if (snapRes.ok) {
            const snapData = await snapRes.json() as Array<Record<string, string>>;
            if (Array.isArray(snapData)) {
              for (const c of snapData) {
                const v = parseFloat(c['v'] ?? '0');
                if (!isNaN(v)) volume += v;
              }
            }
            // Convert raw contract volume → USD notional: v * price
            if (volume > 0 && price > 0) volume = volume * price;
          }
          return { price, volume24h: volume, change24h: 0 };
        }
      }
    } catch (err) {
      log.warn(`fetchPriceForSymbol(${symbol}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { price: 0, volume24h: 0, change24h: 0 };
  }

  /**
   * v2.0.66: Batch fetch prices for multiple symbols in a single call.
   *
   * DEX 0 symbols (BTC, ETH, etc.) are all fetched from a single
   * `metaAndAssetCtxs` REST call (which returns ALL DEX 0 prices at once).
   * Colon symbols (xyz:SKHX, xyz:MU) are fetched via `l2Book` in parallel.
   *
   * This reduces HL API calls from N×3 (per-symbol metaAndAssetCtxs + l2Book
   * + candleSnapshot) to 1 (metaAndAssetCtxs) + M (l2Book for M colon symbols).
   * At 3 symbols (2 DEX 0 + 1 colon), this saves ~5 API calls per cycle.
   *
   * @param symbols Array of symbols to fetch prices for
   * @returns Map of symbol → { price, volume24h, change24h }
   */
  async fetchPricesForSymbols(symbols: string[]): Promise<Map<string, { price: number; volume24h: number; change24h: number }>> {
    const result = new Map<string, { price: number; volume24h: number; change24h: number }>();

    if (symbols.length === 0) return result;

    // Split into DEX 0 (bare) and colon symbols
    const dex0Symbols = symbols.filter(s => !s.includes(':'));
    const colonSymbols = symbols.filter(s => s.includes(':'));

    // ── DEX 0: single metaAndAssetCtxs call gets ALL prices ──
    if (dex0Symbols.length > 0 && this.config.exchange !== 'binance') {
      // Check cache first
      const cached = MarketAgent.dex0CtxsCache;
      if (cached && Date.now() - cached.timestamp < MarketAgent.DEX0_CACHE_TTL) {
        for (const sym of dex0Symbols) {
          const entry = cached.data.find(e => e.name === sym.toUpperCase());
          if (entry) {
            result.set(sym, { price: entry.price, volume24h: entry.volume24h, change24h: entry.change24h });
          }
        }
      }

      // If any DEX 0 symbols missed the cache, fetch fresh metaAndAssetCtxs
      const missing = dex0Symbols.filter(s => !result.has(s));
      if (missing.length > 0) {
        try {
          // v2.0.XX: Use global rate limiter
          const res = await hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
          });
          if (res.ok) {
            const [meta, ctxs] = await res.json() as [
              { universe: Array<{ name: string }> },
              Array<{ dayNtlVlm: string; markPx: string; midPx: string; prevDayPx: string }>,
            ];
            // Update cache
            const newEntries: Array<{ name: string; price: number; volume24h: number; change24h: number }> = [];
            for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
              const name = meta.universe[i]!.name;
              const ctx = ctxs[i]!;
              const price = parseFloat(ctx.markPx) || parseFloat(ctx.midPx) || 0;
              const volume24h = parseFloat(ctx.dayNtlVlm) || 0;
              const prevDay = parseFloat(ctx.prevDayPx) || price;
              const change24h = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : 0;
              newEntries.push({ name, price, volume24h, change24h });
            }
            MarketAgent.dex0CtxsCache = { timestamp: Date.now(), data: newEntries };

            // Fill in missing symbols from fresh data
            for (const sym of missing) {
              const entry = newEntries.find(e => e.name === sym.toUpperCase());
              if (entry) {
                result.set(sym, { price: entry.price, volume24h: entry.volume24h, change24h: entry.change24h });
              }
            }
          }
        } catch (err) {
          log.warn(`[fetchPricesForSymbols] DEX 0 batch fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── Colon symbols: parallel l2Book fetch (1 call each, but parallel) ──
    if (colonSymbols.length > 0) {
      const colonResults = await Promise.allSettled(
        colonSymbols.map(async (sym) => {
          // v2.0.XX: Use global rate limiter
          const res = await hlRateLimitedFetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'l2Book', coin: sym }),
          });
          if (!res.ok) return { symbol: sym, price: 0, volume24h: 0, change24h: 0 };
          const book = await res.json() as { levels: Array<Array<{ px: string }>> };
          const price = parseFloat(book.levels?.[0]?.[0]?.px ?? '0');
          return { symbol: sym, price, volume24h: 0, change24h: 0 };
        })
      );
      for (const r of colonResults) {
        if (r.status === 'fulfilled') {
          result.set(r.value.symbol, { price: r.value.price, volume24h: r.value.volume24h, change24h: r.value.change24h });
        }
      }
    }

    return result;
  }

  /**
   * Get a market description string for agent context.
   */
  getMarketDescription(): string {
    const pair = this.topPairs.find(p => p.symbol === this.config.selectedSymbol);
    const lines: string[] = [
      `=== Market Agent Config ===`,
      `Exchange: ${this.config.exchange.toUpperCase()}`,
      `Trade Mode: ${this.config.tradeMode.toUpperCase()}`,
      `Selected Symbol: ${this.config.selectedSymbol || '(none)'}`,
    ];

    if (this.config.exchange === 'hyperliquid') {
      lines.push(`Asset Filter: ${this.config.hyperliquidAssetType ?? 'crypto_perps'}`);
    }

    if (pair) {
      lines.push(
        `24h Volume: $${(pair.volume24h / 1_000_000).toFixed(2)}M`,
        `Price: $${pair.price.toFixed(2)}`,
        `24h Change: ${pair.priceChangePercent >= 0 ? '+' : ''}${pair.priceChangePercent.toFixed(2)}%`,
      );
    }

    lines.push(`---`);
    return lines.join('\n');
  }

  /**
   * Get serializable state for API push.
   */
  getState(): {
    config: MarketAgentConfig;
    topPairs: TopVolumePair[];
  } {
    return {
      config: { ...this.config },
      topPairs: this.topPairs.slice(0, 30),
    };
  }
}
