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
  cs: string;             // SPYBUSDT
  price: number | null;
}

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

  /** 攞所有 bStock 價格(對齊 xyz: symbol) */
  async fetchAllPrices(): Promise<BStockPrice[]> {
    const list = await this.fetchList();
    const out: BStockPrice[] = [];
    for (const b of list) {
      const price = await this.fetchPrice(b.cs);
      out.push({ symbol: b.symbol, cs: b.cs, price });
    }
    return out;
  }
}
