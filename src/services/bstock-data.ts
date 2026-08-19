/**
 * v2.0.870-P54: bStock 數據源(Binance spot,同 xyz: 對齊 symbol)
 *
 * bStock 係 1:1 背書嘅代幣化美股,喺 Binance Spot 有交易對(cs 欄位,
 * 例如 MUBUSDT)。數據源:
 *   1. bStock list(type=3 API)→ ticker/symbol/contractAddress/cs/multiplier
 *   2. 價格/蠟燭(Binance spot API)→ ticker/price + klines
 *
 * 對齊:xyz:sp500→SPYB→SPYBUSDT;xyz:skhx→SKHYB→SKHYBUSDT;xyz:mu→MUB→MUBUSDT
 *
 * 紀律:list 緩存 TTL 10min;price 緩存 TTL 30s;防禦式 parse;唔 crash。
 */
export interface BStockInfo {
  symbol: string;          // SPYB
  ticker: string;         // SPY
  contractAddress: string;
  cs: string;             // SPYBUSDT(Binance spot pair)
  multiplier: number;
}

export interface BStockPrice {
  symbol: string;         // SPYB
  ticker: string;         // SPY(underlying ticker)
  cs: string;             // SPYBUSDT
  price: number | null;
}

/** xyz: ticker → bStock ticker 例外映射(xyz: 同 bStock 嘅 ticker 唔一致嗰啲) */
const TICKER_EXCEPTIONS: Record<string, string> = {
  'skhx': 'skhy',   // SK Hynix(xyz:SKHX → bStock SKHY)
  'sp500': 'spy',   // S&P 500(xyz:SP500 → bStock SPY)
};

const LIST_URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=3';
const LIST_TTL_MS = 10 * 60 * 1000; // 10 min
const PRICE_TTL_MS = 30 * 1000;     // 30s

export class BStockData {
  private listCache: { value: BStockInfo[]; ts: number } | null = null;
  private priceCache = new Map<string, { value: number; ts: number }>();

  /** 攞 bStock list(type=3 API,緩存 10min) */
  async fetchList(): Promise<BStockInfo[]> {
    if (this.listCache && Date.now() - this.listCache.ts < LIST_TTL_MS) return this.listCache.value;
    try {
      const res = await fetch(LIST_URL, {
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/1.1 (Skill)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return this.listCache?.value ?? [];
      const json = await res.json() as { data?: unknown };
      const data = json.data ?? json;
      const items = (Array.isArray(data) ? data : (data as { list?: unknown[] }).list ?? (data as { items?: unknown[] }).items ?? []) as Array<Record<string, unknown>>;
      const list: BStockInfo[] = items.map((it) => ({
        symbol: String(it['symbol'] ?? ''),
        ticker: String(it['ticker'] ?? ''),
        contractAddress: String(it['contractAddress'] ?? ''),
        cs: String(it['cs'] ?? ''),
        multiplier: Number.isFinite(parseFloat(String(it['multiplier'] ?? '1'))) ? parseFloat(String(it['multiplier'] ?? '1')) : 1,
      })).filter((b) => b.symbol && b.cs);
      this.listCache = { value: list, ts: Date.now() };
      return list;
    } catch {
      return this.listCache?.value ?? [];
    }
  }

  /** 攞 bStock 價格(Binance spot,緩存 30s) */
  async fetchPrice(cs: string): Promise<number | null> {
    const cached = this.priceCache.get(cs);
    if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.value;
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(cs)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return cached?.value ?? null;
      const json = await res.json() as { price?: string };
      const p = parseFloat(json.price ?? '');
      if (!Number.isFinite(p) || p <= 0) return cached?.value ?? null;
      this.priceCache.set(cs, { value: p, ts: Date.now() });
      return p;
    } catch {
      return cached?.value ?? null;
    }
  }

  /** API 4: per-asset 交易狀態(企業行動風險檢查) */
  async fetchAssetStatus(contractAddress: string): Promise<{ openState: boolean; marketStatus: string; reasonCode: string | null; reasonMsg: string | null } | null> {
    try {
      const res = await fetch(
        `https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/asset/market/status/ai?chainId=56&contractAddress=${encodeURIComponent(contractAddress)}`,
        { headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/1.1 (Skill)' }, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return null;
      const json = await res.json() as { data?: Record<string, unknown> };
      const d = json.data ?? {};
      return {
        openState: d['openState'] === true,
        marketStatus: String(d['marketStatus'] ?? ''),
        reasonCode: typeof d['reasonCode'] === 'string' ? d['reasonCode'] : null,
        reasonMsg: typeof d['reasonMsg'] === 'string' ? d['reasonMsg'] : null,
      };
    } catch {
      return null;
    }
  }

  /** 判斷 bStock 係咪可交易(只有 TRADING / openState=true 先可 swap)。
   *  API 查唔到 → fail-open(放行,但 caller 記 warning)——唔 hard-block。 */
  async isTradable(contractAddress: string): Promise<{ tradable: boolean; reasonCode: string | null; reasonMsg: string | null }> {
    const status = await this.fetchAssetStatus(contractAddress);
    if (!status) return { tradable: true, reasonCode: null, reasonMsg: null };
    const tradable = status.reasonCode === 'TRADING' || status.openState === true;
    return { tradable, reasonCode: status.reasonCode, reasonMsg: status.reasonMsg };
  }

  /** 動態 map:xyz: symbol → bStock(ticker 例外 + 全 list 查找)。
   *  唔再 hardcode——新 symbol 只要 ticker 喺 bStock list 就自動 map 到。 */
  async getBStockForXyzSymbol(xyzSymbol: string): Promise<{ symbol: string; contractAddress: string; cs: string; ticker: string } | null> {
    const list = await this.fetchList();
    const rawTicker = xyzSymbol.includes(':') ? xyzSymbol.split(':')[1] ?? '' : xyzSymbol;
    const ticker = (TICKER_EXCEPTIONS[rawTicker.toLowerCase()] ?? rawTicker.toLowerCase());
    const bStock = list.find((b) => b.ticker.toLowerCase() === ticker);
    return bStock ? { symbol: bStock.symbol, contractAddress: bStock.contractAddress, cs: bStock.cs, ticker: bStock.ticker } : null;
  }

  /**
   * v2.0.870-P73: 反向查 HL symbol(bStock symbol → xyz:symbol)。
   * 用於倉位同步:bStock 有倉位 → 揾對應嘅 HL symbol → check HL 有冇倉位。
   * 例如 SPYB → xyz:SP500、SKHYB → xyz:SKHX。
   */
  async getHLForBStockSymbol(bStockSymbol: string): Promise<string | null> {
    const list = await this.fetchList();
    const bStock = list.find((b) => b.symbol === bStockSymbol);
    if (!bStock) return null;
    // ticker 對應返 xyz:symbol(用 TICKER_EXCEPTIONS 反向)
    const revExceptions: Record<string, string> = Object.fromEntries(Object.entries(TICKER_EXCEPTIONS).map(([k, v]) => [v, k]));
    const rawTicker = bStock.ticker.toLowerCase();
    const hlTicker = revExceptions[rawTicker] ?? rawTicker;
    return `xyz:${hlTicker.toUpperCase()}`;
  }

  /** v2.0.870-P73: 同步版(用 cache——避免每 cycle 都 fetch) */
  getHLForBStockSymbolSync(bStockSymbol: string): string | null {
    // 用現有 listCache(如果冇就 null,下個 cycle 先 fetch)
    const cached = this.listCache;
    if (!cached) return null;
    const bStock = cached.value.find((b) => b.symbol === bStockSymbol);
    if (!bStock) return null;
    const revExceptions: Record<string, string> = Object.fromEntries(Object.entries(TICKER_EXCEPTIONS).map(([k, v]) => [v, k]));
    const rawTicker = bStock.ticker.toLowerCase();
    const hlTicker = revExceptions[rawTicker] ?? rawTicker;
    return `xyz:${hlTicker.toUpperCase()}`;
  }

  /** 攞所有 bStock 價格(對齊 xyz: symbol) */
  async fetchAllPrices(): Promise<BStockPrice[]> {
    const list = await this.fetchList();
    const out: BStockPrice[] = [];
    for (const b of list) {
      const price = await this.fetchPrice(b.cs);
      out.push({ symbol: b.symbol, ticker: b.ticker, cs: b.cs, price });
    }
    return out;
  }
}
