// ─── Hyperliquid Real Trading Engine ───
// Production-grade real-money trading via Hyperliquid Exchange API.
// Uses EIP-712 secp256k1 signing, dynamic asset index resolution,
// and native TP/SL via trigger orders.
//
// API Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { hlRateLimitedFetch } from '../utils/hl-global-limiter.ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import type {
  Order,
  OrderSide,
  Position,
  RealTradingEngine,
  ExchangeAccountInfo,
} from '../types/index.ts';
// v2.0.42: Import normalizeSymbol for consistent symbol casing.
import { normalizeSymbol } from './portfolio.ts';

const log = createLogger({ phase: 'hyperliquid-real' });

// ─── Constants ───

const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const IS_MAINNET = true;

// ─── HL L1 Action Signing (Phantom Agent) ───
// Implements the official Hyperliquid signing scheme:
// 1. action_hash = keccak256(msgpack(action) + nonce(8 bytes BE) + vault_flag)
// 2. phantom_agent = { source: "a"|"b", connectionId: action_hash }
// 3. EIP-712 sign Agent(string source, bytes32 connectionId)
//    Domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: 0x000... }

function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * v2.0.32: Format a price for HL API — uses the correct number of decimals
 * based on price magnitude, then strips trailing zeros.
 *
 * HL enforces per-asset tick sizes. From l2Book data analysis across 19 assets:
 *   BTC  ($59,333):  0 decimals  (>= 10000)
 *   ETH  ($1,562.9): 1 decimal    (>= 1000)
 *   SOL  ($66.165):  3 decimals   (>= 10)
 *   ATOM ($1.5976):  4 decimals   (>= 1)
 *   DOGE ($0.073336): 6 decimals  (< 1)
 *
 * Rule: use the max decimals allowed for the price magnitude, then strip
 * trailing zeros with parseFloat().toString(). This ensures the price is
 * always within HL's accepted tick size for any asset.
 */
/** Strip trailing zeros + trailing decimal point from a numeric string so it
 *  matches Hyperliquid's server-side normalization. HL normalizes "0.00100"→"0.001"
 *  and "62062.0"→"62062" before re-msgpacking the action for signature verification.
 *  If the signed payload contains trailing zeros, the recomputed hash diverges from
 *  the signed hash and ECDSA recovery yields a garbage address →
 *  "User or API Wallet <random> does not exist." (intermittent — only triggers when
 *  the size/price rounds to a value ending in zero). v2.0.139 fix.
 *
 *  String-based (not parseFloat) to avoid scientific-notation for tiny values
 *  (e.g. parseFloat("0.0000001").toString() === "1e-7" which HL would reject). */
function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function formatPrice(price: number, _decimals?: number): string {
  let decimals: number;
  if (price >= 10000) decimals = 0;
  else if (price >= 1000) decimals = 1;
  else if (price >= 100) decimals = 2;
  else if (price >= 10) decimals = 3;
  else if (price >= 1) decimals = 4;
  else decimals = 6;
  return stripTrailingZeros(price.toFixed(decimals));
}

/** Compute the action hash: keccak256(msgpack(action) + nonce + vault_flag) */
function actionHash(
  action: Record<string, unknown>,
  vaultAddress: string | null,
  nonce: number,
): Uint8Array {
  const actionBytes = msgpackEncode(action);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce));

  let vaultBytes: Uint8Array;
  if (vaultAddress) {
    vaultBytes = new Uint8Array(21);
    vaultBytes[0] = 0x01;
    vaultBytes.set(hexToBytes(vaultAddress), 1);
  } else {
    vaultBytes = new Uint8Array([0x00]);
  }

  return keccak256(new Uint8Array([...actionBytes, ...nonceBytes, ...vaultBytes]));
}

/** Build EIP-712 domain separator for HL Exchange */
function buildExchangeDomainSeparator(): Uint8Array {
  const typeHash = keccak256(new TextEncoder().encode(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  ));
  const nameHash = keccak256(new TextEncoder().encode('Exchange'));
  const versionHash = keccak256(new TextEncoder().encode('1'));

  const chainIdBytes = new Uint8Array(32);
  new DataView(chainIdBytes.buffer).setBigUint64(24, BigInt(1337));

  const verifyingContractBytes = new Uint8Array(32);

  return keccak256(new Uint8Array([
    ...typeHash,
    ...nameHash,
    ...versionHash,
    ...chainIdBytes,
    ...verifyingContractBytes,
  ]));
}

/**
 * Sign a Hyperliquid L1 action using the phantom agent EIP-712 scheme.
 * Matches the official Python SDK sign_l1_action() implementation.
 */
function signL1Action(
  privateKeyHex: string,
  action: Record<string, unknown>,
  nonce: number,
  vaultAddress: string | null = null,
): { r: string; s: string; v: number } {
  const privateKeyBytes = hexToBytes(privateKeyHex);

  // 1. Compute action hash
  const hash = actionHash(action, vaultAddress, nonce);

  // 2. Construct phantom agent
  const source = IS_MAINNET ? 'a' : 'b';

  // 3. EIP-712 encode Agent(string source, bytes32 connectionId)
  const agentTypeHash = keccak256(
    new TextEncoder().encode('Agent(string source,bytes32 connectionId)')
  );
  const sourceHash = keccak256(new TextEncoder().encode(source));

  const messageHash = keccak256(new Uint8Array([
    ...agentTypeHash,
    ...sourceHash,
    ...hash, // connectionId is the action hash (bytes32)
  ]));

  // 4. Domain separator
  const domainSeparator = buildExchangeDomainSeparator();

  // 5. Final EIP-712 hash: keccak256(0x19 0x01 || domainSeparator || messageHash)
  const finalHash = keccak256(new Uint8Array([
    0x19, 0x01,
    ...domainSeparator,
    ...messageHash,
  ]));

  // 6. Sign with secp256k1
  // format: 'recovered' returns 65 bytes (recoveryByte || r || s)
  // prehash: false because finalHash is already a keccak256 digest
  const sigBytes = secp256k1.sign(finalHash, privateKeyBytes, {
    format: 'recovered',
    prehash: false,
  });

  const recovery = sigBytes[0]!;
  // Convert r and s to BigInt then hex to strip leading zeros (matches Python's to_hex)
  const rBig = BigInt('0x' + Buffer.from(sigBytes.slice(1, 33)).toString('hex'));
  const sBig = BigInt('0x' + Buffer.from(sigBytes.slice(33, 65)).toString('hex'));

  return {
    r: '0x' + rBig.toString(16),
    s: '0x' + sBig.toString(16),
    v: recovery + 27,
  };
}

// ─── Asset Index Cache ───

interface AssetMeta {
  name: string;
  index: number;
  szDecimals: number;
  pxDecimals: number;
  maxLeverage: number;
}

let assetIndexCache: Map<string, AssetMeta> | null = null;
let assetCacheTimestamp = 0;
const ASSET_CACHE_TTL = 300_000; // 5 minutes

async function getAssetIndex(symbol: string): Promise<AssetMeta | null> {
  const now = Date.now();
  if (assetIndexCache && now - assetCacheTimestamp < ASSET_CACHE_TTL) {
    return assetIndexCache.get(symbol.toUpperCase()) ?? null;
  }

  try {
    assetIndexCache = new Map();

    // Fetch DEX 0 (crypto perps) meta
    const res0 = await hlRateLimitedFetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    });
    if (res0.ok) {
      const data0 = await res0.json() as {
        universe: Array<{ name: string; szDecimals: number; pxDecimals: number; maxLeverage: number }>;
      };
      data0.universe.forEach((asset, index) => {
        assetIndexCache!.set(asset.name.toUpperCase(), {
          name: asset.name,
          index,
          szDecimals: asset.szDecimals,
          pxDecimals: asset.pxDecimals ?? 5,
          maxLeverage: asset.maxLeverage,
        });
      });
    }

    // Fetch xyz DEX (TradFi perps) meta
    // v2.0.32: xyz DEX assets need a global asset index offset of 110000
    // (builder-deployed perp DEXs start at 110000 per HL Python SDK)
    const XYZ_DEX_OFFSET = 110000;
    try {
      const resXyz = await hlRateLimitedFetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta', dex: 'xyz' }),
      });
      if (resXyz.ok) {
        const dataXyz = await resXyz.json() as {
          universe: Array<{ name: string; szDecimals: number; pxDecimals?: number; maxLeverage: number }>;
        };
        dataXyz.universe.forEach((asset, index) => {
          assetIndexCache!.set(asset.name.toUpperCase(), {
            name: asset.name,
            index: index + XYZ_DEX_OFFSET,
            szDecimals: asset.szDecimals,
            pxDecimals: asset.pxDecimals ?? 2,
            maxLeverage: asset.maxLeverage,
          });
        });
      }
    } catch { /* xyz DEX meta optional */ }

    assetCacheTimestamp = now;
    log.info(`Asset index cache refreshed: ${assetIndexCache.size} assets (DEX 0 + xyz)`);
    return assetIndexCache.get(symbol.toUpperCase()) ?? null;
  } catch (err) {
    log.warn(`Failed to fetch asset meta: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Hyperliquid Real Engine ───

export class HyperliquidRealEngine implements RealTradingEngine {
  readonly name = 'hyperliquid';
  private walletAddress: string;
  private privateKeyHex: string;
  /** SL/TP monitoring: positionId → { sl, tp } */
  private stopLossTakeProfit: Map<string, { sl?: number; tp?: number }> = new Map();
  /** v2.0.65: Pending orders cache — symbol → { slPrice, tpPrice, timestamp }.
   *  Prevents race-condition duplicates when syncSLTP() and hacp adjustPositions()
   *  both call adjustPosition() within the same cycle. Orders are considered
   *  pending for 15 seconds (HL typically processes in < 2s). */
  private pendingOrders: Map<string, { sl?: number; tp?: number; ts: number }> = new Map();
  private readonly PENDING_TTL_MS = 15_000;

  constructor(walletAddress: string, privateKeyHex: string) {
    this.walletAddress = walletAddress;
    this.privateKeyHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
    log.info(`Hyperliquid Real Engine initialized: ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`);
  }

  async isConnected(): Promise<boolean> {
    try {
      const res = await hlRateLimitedFetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'spotMeta' }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Account Info ──

  /** DEX names to query for clearinghouseState ('' = default crypto perps, 'xyz' = TradFi perps) */
  // v2.0.32: HL API rejects dex: 0 (number). Must use '' (empty string) or omit the field.
  private static readonly PERP_DEX_NAMES: string[] = ['', 'xyz'];

  // v2.0.79: Short-lived balance cache — prevents redundant getBalance() calls
  // within the same cycle. Uses inflight promise to prevent cache stampede
  // (multiple concurrent calls all miss the cache and all fetch simultaneously).
  private balanceCache: { value: ExchangeAccountInfo; ts: number } | null = null;
  private static readonly BALANCE_CACHE_TTL_MS = 10_000; // 10s cache
  private balanceInflight: Promise<ExchangeAccountInfo> | null = null;

  /** v2.0.79: Clear all caches — called after position close to force fresh fetch */
  clearCaches(): void {
    this.balanceCache = null;
    this.positionsCache = null;
    this.fillsCache = null;
  }

  async getBalance(): Promise<ExchangeAccountInfo> {
    // v2.0.79: Return cached balance if fresh (< 10s old)
    if (this.balanceCache && (Date.now() - this.balanceCache.ts) < HyperliquidRealEngine.BALANCE_CACHE_TTL_MS) {
      return this.balanceCache.value;
    }
    // v2.0.79: If a fetch is already in flight, await it instead of starting a new one
    if (this.balanceInflight) {
      return this.balanceInflight;
    }

    this.balanceInflight = this._fetchBalance();
    try {
      return await this.balanceInflight;
    } finally {
      this.balanceInflight = null;
    }
  }

  private async _fetchBalance(): Promise<ExchangeAccountInfo> {
    try {
      let totalAccountValue = 0;
      let totalWithdrawable = 0;
      let totalMarginUsed = 0;
      let totalUnrealizedPnl = 0;

      // Query each perp DEX clearinghouse
      for (const dex of HyperliquidRealEngine.PERP_DEX_NAMES) {
        try {
          // v2.0.32: Omit dex field for default DEX ('') — HL API rejects dex: 0 or dex: ''
          const body: Record<string, unknown> = { type: 'clearinghouseState', user: this.walletAddress };
          if (dex) body['dex'] = dex;
          const res = await hlRateLimitedFetch(HL_INFO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) continue;
          const data = await res.json() as {
            marginSummary?: { accountValue?: string; totalMarginUsed?: string };
            withdrawable?: string;
            assetPositions?: Array<{ position?: { unrealizedPnl?: string } }>;
          };
          if (!data || data.marginSummary === undefined) continue;

          const acctVal = parseFloat(data.marginSummary.accountValue ?? '0');
          const wdrl = parseFloat(data.withdrawable ?? '0');
          const mgnUsed = parseFloat(data.marginSummary.totalMarginUsed ?? '0');

          totalAccountValue += acctVal;
          totalWithdrawable += wdrl;
          totalMarginUsed += mgnUsed;

          // Sum unrealized PnL from positions
          if (data.assetPositions) {
            for (const ap of data.assetPositions) {
              totalUnrealizedPnl += parseFloat(ap.position?.unrealizedPnl ?? '0');
            }
          }

          log.info(`[getBalance] DEX ${dex}: accountValue=${acctVal}, withdrawable=${wdrl}, marginUsed=${mgnUsed}`);
        } catch (err) {
          log.warn(`[getBalance] DEX ${dex} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Fetch spot clearinghouse state (USDC held in spot wallet)
      let spotUsdc = 0;
      try {
        const spotRes = await hlRateLimitedFetch(HL_INFO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'spotClearinghouseState', user: this.walletAddress }),
        });
        if (spotRes.ok) {
          const spotData = await spotRes.json() as {
            balances?: Array<{ coin: string; total: string; hold: string }>;
          };
          const usdcBalance = spotData.balances?.find(b => b.coin === 'USDC');
          if (usdcBalance) {
            spotUsdc = parseFloat(usdcBalance.total) - parseFloat(usdcBalance.hold);
          }
        }
      } catch { /* non-critical */ }

      // v2.0.32: total = perp accountValue + spot USDC (both are real assets).
      // free = perp withdrawable + spot USDC (total available across both wallets).
      const total = totalAccountValue + spotUsdc;
      const free = totalWithdrawable + spotUsdc;

      log.info(`[getBalance] total(perp)=${total}, free=${free}, marginUsed=${totalMarginUsed}, unrealizedPnl=${totalUnrealizedPnl}, spotUsdc=${spotUsdc}`);

      const result: ExchangeAccountInfo = {
        free,
        locked: totalMarginUsed,
        total,
        unrealizedPnl: totalUnrealizedPnl,
        marginUsed: totalMarginUsed,
      };
      // v2.0.79: Cache the result
      this.balanceCache = { value: result, ts: Date.now() };
      return result;
    } catch (err) {
      log.error(`_fetchBalance failed: ${err instanceof Error ? err.message : String(err)}`);
      return { free: 0, locked: 0, total: 0, unrealizedPnl: 0, marginUsed: 0 };
    }
  }

  // v2.0.79: Short-lived positions cache — same reason as balance cache
  private positionsCache: { value: Position[]; ts: number } | null = null;
  private static readonly POSITIONS_CACHE_TTL_MS = 10_000;
  private positionsInflight: Promise<Position[]> | null = null;

  async getPositions(): Promise<Position[]> {
    // v2.0.79: Return cached positions if fresh
    if (this.positionsCache && (Date.now() - this.positionsCache.ts) < HyperliquidRealEngine.POSITIONS_CACHE_TTL_MS) {
      return this.positionsCache.value;
    }
    // v2.0.79: If a fetch is already in flight, await it
    if (this.positionsInflight) {
      return this.positionsInflight;
    }
    this.positionsInflight = this._fetchPositions();
    try {
      return await this.positionsInflight;
    } finally {
      this.positionsInflight = null;
    }
  }

  private async _fetchPositions(): Promise<Position[]> {
    try {
      const allPositions: Position[] = [];
      let dexFetchFailures = 0;

      // v2.0.33: Fetch recent fills to get actual open timestamps.
      // HL clearinghouseState doesn't include position open time, so we
      // match by coin + side + approximate entry price to find the real
      // open timestamp.
      // v2.0.33 FIX: Previous code matched by coin only and took the first
      // "Open" fill — wrong if there were multiple open/close cycles.
      // Also, fallback was Date.now() which overwrote the real open time
      // every cycle when no fill was found. Now we match by coin + side +
      // entry price (within tolerance), and if no match is found we return
      // openedAt=0 (caller preserves existing openedAt).
      // v2.0.33 FIX 2: Increased fill limit from 50 to 200 to ensure we
      // capture the open fill even after many subsequent trades. Also
      // match by side (Open Short vs Open Long) to distinguish long/short
      // positions on the same coin.
      let openFills: Array<{ symbol: string; side: string; price: number; timestamp: number }> = [];
      try {
        const fills = await this.getRecentFills(200);
        for (const f of fills) {
          if (f.dir.toLowerCase().startsWith('open')) {
            openFills.push({ symbol: f.symbol, side: f.dir, price: f.price, timestamp: f.timestamp });
          }
        }
      } catch { /* non-critical */ }

      // Query each perp DEX clearinghouse
      for (const dex of HyperliquidRealEngine.PERP_DEX_NAMES) {
        try {
          // v2.0.32: Omit dex field for default DEX ('') — HL API rejects dex: 0 or dex: ''
          const body: Record<string, unknown> = { type: 'clearinghouseState', user: this.walletAddress };
          if (dex) body['dex'] = dex;
          const res = await hlRateLimitedFetch(HL_INFO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) continue;
          const data = await res.json() as {
            assetPositions?: Array<{
              position?: {
                coin: string;
                szi: string;
                entryPx: string;
                leverage?: { value: number };
                unrealizedPnl?: string;
                liquidationPx?: string;
                positionValue?: string;
              };
            }>;
          };
          if (!data?.assetPositions) continue;

          for (const ap of data.assetPositions) {
            const p = ap.position;
            if (!p || parseFloat(p.szi) === 0) continue;

            const size = parseFloat(p.szi);
            const entryPx = parseFloat(p.entryPx);
            const unrealizedPnl = parseFloat(p.unrealizedPnl ?? '0');
            const leverage = p.leverage?.value ?? 1;

            // v2.0.33: Match open fill by coin + side + approximate entry price.
            // The fill price might not exactly match the position entry price
            // (weighted average for partial fills, or different decimal precision).
            // Use a tolerance of 0.5% to match approximately.
            // Also match by side: "Open Short" for sell, "Open Long" for buy.
            const posSide = size > 0 ? 'long' : 'short';
            let matchingFill = openFills.find(f => {
              if (f.symbol.toLowerCase() !== p.coin.toLowerCase()) return false;
              if (!f.side.toLowerCase().includes(posSide)) return false;
              const priceDiff = Math.abs(f.price - entryPx) / entryPx;
              return priceDiff < 0.005; // 0.5% tolerance
            });

            // v2.0.50: If no matching fill found, retry instantly with a
            // wider time window (30 days instead of 7). HL's userFillsByTime
            // API sometimes misses fills that are older than 7 days, especially
            // for positions opened weeks ago. Without this retry, openedAt=0
            // (Unix epoch Jan 1 1970) shows in the UI — confusing and wrong.
            // If the retry also fails, fall back to Date.now() so the UI shows
            // a reasonable timestamp instead of 1970.
            if (!matchingFill) {
              try {
                const widerFills = await this.getRecentFillsByTime(30 * 24 * 60 * 60 * 1000, 500);
                const widerOpenFills = widerFills
                  .filter(f => f.dir.toLowerCase().startsWith('open'))
                  .map(f => ({ symbol: f.symbol, side: f.dir, price: f.price, timestamp: f.timestamp }));
                matchingFill = widerOpenFills.find(f => {
                  if (f.symbol.toLowerCase() !== p.coin.toLowerCase()) return false;
                  if (!f.side.toLowerCase().includes(posSide)) return false;
                  const priceDiff = Math.abs(f.price - entryPx) / entryPx;
                  return priceDiff < 0.005;
                });
                if (matchingFill) {
                  log.info(`[getPositions] Found open fill for ${p.coin} via wider 30-day search: ${new Date(matchingFill.timestamp).toISOString()}`);
                }
              } catch { /* non-critical — fall through to fallback */ }
            }

            // v2.0.50: If still no matching fill, use Date.now() as fallback.
            // Showing Jan 1 1970 is worse than showing "now" — at least "now"
            // is a plausible open time. The local mirror may have the real
            // openedAt from the original trade execution.
            const openTime = matchingFill?.timestamp ?? Date.now();

            allPositions.push({
              id: `${p.coin}-${this.walletAddress}`,
              symbol: p.coin,
              side: size > 0 ? 'buy' : 'sell',
              quantity: Math.abs(size),
              averageEntryPrice: entryPx,
              currentPrice: entryPx, // Will be updated by mark price polling
              unrealizedPnl,
              unrealizedPnlPct: entryPx > 0 ? unrealizedPnl / (Math.abs(size) * entryPx / leverage) : 0,
              realizedPnl: 0,
              leverage,
              openedAt: openTime, // 0 = unknown, caller should preserve existing
              updatedAt: Date.now(),
              agentId: 'hyperliquid-real',
            } as Position);
          }
        } catch (err) {
          dexFetchFailures++;
          log.warn(`[getPositions] DEX ${dex} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // v2.0.79: Only cache if ALL DEXes succeeded — a partial result (missing
      // xyz DEX) would be cached and prevent the next caller from getting full data.
      if (dexFetchFailures === 0) {
        this.positionsCache = { value: allPositions, ts: Date.now() };
      } else {
        log.warn(`[getPositions] ${dexFetchFailures} DEX fetch(es) failed — NOT caching (partial data)`);
      }
      return allPositions;
    } catch (err) {
      log.error(`_fetchPositions failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Get the user's most recent N fills from Hyperliquid (v2.0.19).
   * Uses the `userFillsByTime` REST endpoint. Returns fills newest-first.
   * Used to sync the UI Trade Records panel with the real exchange so the
   * user sees their actual Hyperliquid trade history (last 5 by default).
   */
  // v2.0.79: Short-lived fills cache
  private fillsCache: { value: any[]; ts: number; limit: number } | null = null;
  private static readonly FILLS_CACHE_TTL_MS = 10_000;
  private fillsInflight: Promise<any[]> | null = null;

  async getRecentFills(limit = 10): Promise<Array<{
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
    closedPnl: number;
    fee: number;
    dir: string;
  }>> {
    // v2.0.79: Return cached fills if fresh and same limit
    if (this.fillsCache && this.fillsCache.limit >= limit && (Date.now() - this.fillsCache.ts) < HyperliquidRealEngine.FILLS_CACHE_TTL_MS) {
      return this.fillsCache.value.slice(0, limit);
    }
    // v2.0.79: If a fetch is already in flight, await it
    if (this.fillsInflight) {
      return (await this.fillsInflight).slice(0, limit);
    }
    this.fillsInflight = this._fetchRecentFills(limit);
    try {
      return await this.fillsInflight;
    } finally {
      this.fillsInflight = null;
    }
  }

  private async _fetchRecentFills(limit = 10): Promise<Array<{
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
    closedPnl: number;
    fee: number;
    dir: string;
  }>> {
    try {
      // userFillsByTime requires startTime — HL API fails without it.
      // Query last 7 days to capture all recent fills.
      const startTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const res = await hlRateLimitedFetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFillsByTime', user: this.walletAddress, startTime }),
      });
      if (!res.ok) return [];
      // v2.0.78 FIX: HL userFillsByTime returns a BARE ARRAY, not { fills: [...] }.
      // Previous code read data.fills which was always undefined → empty array →
      // no fills ever reached the UI Trade Records panel.
      const raw = await res.json();
      const fills = (Array.isArray(raw) ? raw : (raw as { fills?: Array<{
        coin: string;
        side: string;
        px: string;
        sz: string;
        time: number;
        closedPnl: string;
        fee: string;
        dir: string;
      }> }).fills) ?? [];
      // Sort newest first (HL returns ascending), take the last `limit`.
      const sorted = fills.sort((a, b) => b.time - a.time).slice(0, limit);
      const result: Array<{ symbol: string; side: 'buy' | 'sell'; price: number; size: number; timestamp: number; closedPnl: number; fee: number; dir: string }> = sorted.map(f => ({
        symbol: f.coin,
        side: (f.side === 'B' ? 'buy' : 'sell') as 'buy' | 'sell',
        price: parseFloat(f.px ?? '0'),
        size: parseFloat(f.sz ?? '0'),
        timestamp: f.time,
        closedPnl: parseFloat(f.closedPnl ?? '0'),
        fee: parseFloat(f.fee ?? '0'),
        dir: f.dir,
      }));
      // v2.0.79: Cache the result
      this.fillsCache = { value: result, ts: Date.now(), limit };
      return result;
    } catch (err) {
      log.error(`_fetchRecentFills failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * v2.0.50: Fetch recent fills with a custom time window and larger limit.
   * Used by getPositions() when the default 7-day / 200-fill search misses
   * the open fill (e.g. position opened weeks ago). The wider window catches
   * fills that the default search misses, so the UI shows the real open time
   * instead of Jan 1 1970 (Unix epoch 0).
   *
   * @param timeWindowMs  How far back to search (default 30 days)
   * @param limit         Max fills to return (default 500)
   */
  async getRecentFillsByTime(timeWindowMs = 30 * 24 * 60 * 60 * 1000, limit = 500): Promise<Array<{
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    timestamp: number;
    closedPnl: number;
    fee: number;
    dir: string;
  }>> {
    try {
      const startTime = Date.now() - timeWindowMs;
      const res = await hlRateLimitedFetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFillsByTime', user: this.walletAddress, startTime }),
      });
      if (!res.ok) return [];
      // v2.0.78 FIX: Same as getRecentFills — HL returns a bare array.
      const raw = await res.json();
      const fills = (Array.isArray(raw) ? raw : (raw as { fills?: Array<{
        coin: string;
        side: string;
        px: string;
        sz: string;
        time: number;
        closedPnl: string;
        fee: string;
        dir: string;
      }> }).fills) ?? [];
      const sorted = fills.sort((a, b) => b.time - a.time).slice(0, limit);
      return sorted.map(f => ({
        symbol: f.coin,
        side: f.side === 'B' ? 'buy' : 'sell',
        price: parseFloat(f.px ?? '0'),
        size: parseFloat(f.sz ?? '0'),
        timestamp: f.time,
        closedPnl: parseFloat(f.closedPnl ?? '0'),
        fee: parseFloat(f.fee ?? '0'),
        dir: f.dir,
      }));
    } catch (err) {
      log.error(`getRecentFillsByTime failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * v2.0.32: Update leverage for an asset on HL before placing an order.
   * HL uses per-asset leverage settings — the order itself doesn't specify leverage.
   * If we don't call this, HL uses the account's default (which may be 40x).
   */
  async updateLeverage(symbol: string, leverage: number, isCross: boolean = true): Promise<boolean> {
    try {
      const asset = await getAssetIndex(symbol);
      if (!asset) {
        log.warn(`updateLeverage: unknown asset ${symbol}`);
        return false;
      }

      const action = {
        type: 'updateLeverage',
        asset: asset.index,
        isCross,
        leverage,
      };

      const nonce = Date.now();
      const signature = signL1Action(this.privateKeyHex, action, nonce);

      const res = await hlRateLimitedFetch(HL_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });

      const result = await res.json() as { status?: string; response?: { data?: { statuses?: Array<string | { error: string }> } } };
      if (result.status === 'ok') {
        log.info(`Leverage set: ${symbol} ${leverage}x ${isCross ? 'cross' : 'isolated'}`);
        return true;
      }
      log.warn(`updateLeverage failed: ${JSON.stringify(result)}`);
      return false;
    } catch (err) {
      log.warn(`updateLeverage error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async placeOrder(order: Order): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      const asset = await getAssetIndex(order.symbol);
      if (!asset) {
        return { success: false, error: `Unknown asset: ${order.symbol}. Run meta refresh first.` };
      }

      // v2.0.32: Set leverage on HL before placing the order.
      // HL uses per-asset leverage settings; without this call, HL uses the
      // account default (e.g. 40x) instead of the intended leverage.
      const desiredLeverage = (order.metadata?.['leverage'] as number) ?? 10;
      if (desiredLeverage !== asset.maxLeverage) {
        await this.updateLeverage(order.symbol, desiredLeverage, true);
      }

      const isBuy = order.side === 'buy';
      const pxDecimals = asset.pxDecimals;
      const szDecimals = asset.szDecimals;

      // Build order spec
      const orderSpec: Record<string, unknown> = {
        a: asset.index,
        b: isBuy,
        p: formatPrice(order.price, pxDecimals),
        s: stripTrailingZeros(order.quantity.toFixed(szDecimals)),
        r: false,
        t: { limit: { tif: 'Ioc' } }, // IOC for market-like execution
      };

      // Handle SL/TP orders
      const sltp = this.stopLossTakeProfit.get(order.id as string);
      if (sltp) {
        const triggerPx = sltp.sl ?? sltp.tp;
        const tpsl = sltp.sl ? 'sl' : 'tp';
        if (triggerPx) {
          orderSpec['t'] = {
            trigger: {
              isMarket: true,
              triggerPx: formatPrice(triggerPx, pxDecimals),
              tpsl,
            },
          };
          orderSpec['r'] = true; // Reduce-only for SL/TP
        }
      }

      if (order.type === 'market') {
        // v2.0.136: Use the LIVE l2Book (best bid/ask) as the PRIMARY source for
        // the aggressive price, keyed by the canonical HL coin name (asset.name).
        // The previous code used allMids keyed by order.symbol, but order.symbol is
        // normalizeSymbol()'d to lowercase ('btc'), while HL's l2Book/allMids APIs
        // are CASE-SENSITIVE and require the canonical name ('BTC'). l2Book('btc')
        // returns null and allMids has no 'btc' key, so both price fetches silently
        // returned 0 and the order fell back to the decision price (~= mid). For a
        // SELL that mid sits just above the best bid -> no match -> HL rejected
        // with "Order could not immediately match against any resting orders".
        // xyz:SILVER worked only because normalizeSymbol preserves its case.
        //
        // Fix: use asset.name (canonical HL coin name) for both l2Book and
        // allMids. SELL -> price just below best bid; BUY -> just above best ask.
        // A 0.5% buffer absorbs book movement between fetch and submission.
        const hlCoin = asset.name; // canonical HL coin name (e.g. 'BTC', 'xyz:SILVER')
        let aggressivePx: number | null = null;
        try {
          const l2Res = await hlRateLimitedFetch(HL_INFO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'l2Book', coin: hlCoin }),
          });
          if (l2Res.ok) {
            const l2Data = await l2Res.json() as { levels?: Array<Array<{ px: string; sz: string; n: number }>> };
            const bids = l2Data.levels?.[0];
            const asks = l2Data.levels?.[1];
            if (bids?.length && asks?.length) {
              const bestBid = parseFloat(bids[0]!.px);
              const bestAsk = parseFloat(asks[0]!.px);
              if (bestBid > 0 && bestAsk > 0) {
                aggressivePx = isBuy ? bestAsk * 1.005 : bestBid * 0.995;
                log.info(`[placeOrder] Using l2Book for ${hlCoin}: bestBid=$${bestBid.toFixed(2)} bestAsk=$${bestAsk.toFixed(2)} -> aggressive $${aggressivePx.toFixed(2)} (${isBuy ? 'BUY' : 'SELL'})`);
              }
            }
          }
        } catch { /* fall through to allMids fallback */ }

        if (aggressivePx === null) {
          const mid = await this.getMidPrice(hlCoin);
          if (mid > 0) {
            aggressivePx = isBuy ? mid * 1.05 : mid * 0.95;
            log.info(`[placeOrder] Using allMids mid for ${hlCoin}: $${mid.toFixed(2)} -> aggressive $${aggressivePx.toFixed(2)} (l2Book unavailable - STALE RISK)`);
          }
        }

        if (aggressivePx !== null) {
          (orderSpec as any).p = formatPrice(aggressivePx, pxDecimals);
        }
      }

      // Build signed action
      const action = {
        type: 'order',
        orders: [orderSpec],
        grouping: 'na',
      };

      const nonce = Date.now();
      const signature = signL1Action(this.privateKeyHex, action, nonce);

      const payload: Record<string, unknown> = {
        action,
        nonce,
        signature,
      };

      const res = await hlRateLimitedFetch(HL_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await res.json() as {
        status?: string;
        response?: {
          type?: string;
          data?: {
            statuses?: Array<{
              resting?: { oid: number };
              filled?: { oid: number; totalSz: string; avgPx: string };
              error?: string;
            }>;
          };
        };
      };

      const status = result.response?.data?.statuses?.[0];
      if (status?.error) {
        return { success: false, error: status.error };
      }

      // v2.0.32: Only treat FILLED orders as successful position opens.
      // A RESTING order (limit order on the book) does NOT create a position
      // yet — it may never fill. Returning success for resting orders caused
      // phantom paper mirrors to be created without real exchange positions.
      if (status?.filled?.oid) {
        log.info(`Order filled: ${order.side} ${order.quantity} ${order.symbol} oid=${status.filled.oid} avgPx=${status.filled.avgPx}`);
        return { success: true, orderId: String(status.filled.oid) };
      }

      if (status?.resting?.oid) {
        log.info(`Order resting (not filled): ${order.side} ${order.quantity} ${order.symbol} oid=${status.resting.oid} — not creating mirror`);
        return { success: false, error: 'Order placed but not filled (resting on book). No position created.' };
      }

      return { success: false, error: `Unexpected response: ${JSON.stringify(result).slice(0, 200)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : '';
      log.error(`placeOrder failed: ${msg}\n  symbol=${order.symbol} price=${order.price} qty=${order.quantity} side=${order.side}\n  ${stack}`);
      return { success: false, error: msg };
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      // v2.0.32: Use correct asset index for the order's coin.
      // If symbol is provided, use it; otherwise fall back to positions[0].
      let assetIdx = 0;
      if (symbol) {
        const asset = await getAssetIndex(symbol);
        assetIdx = asset?.index ?? 0;
      } else {
        const positions = await this.getPositions();
        assetIdx = positions[0]?.symbol
          ? (await getAssetIndex(positions[0].symbol))?.index ?? 0
          : 0;
      }

      const action = {
        type: 'cancel',
        cancels: [{ a: assetIdx, o: parseInt(orderId) }],
      };

      const nonce = Date.now();
      const signature = signL1Action(this.privateKeyHex, action, nonce);

      const res = await hlRateLimitedFetch(HL_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });

      const result = await res.json() as {
        response?: { data?: { statuses?: Array<string | { error: string }> } };
      };

      const status = result.response?.data?.statuses?.[0];
      return status === 'success';
    } catch (err) {
      log.error(`cancelOrder failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * v2.0.32: Get the asset index for a given symbol (public method).
   * Used by realTradingManager to get the correct asset index for cancelling orders.
   */
  async getAssetIndexForSymbol(symbol: string): Promise<number> {
    const asset = await getAssetIndex(symbol);
    return asset?.index ?? 0;
  }

  /**
   * v2.0.32: Cancel a specific order by oid with a known asset index.
   * More efficient than cancelOrder() which looks up the asset index.
   */
  async cancelOrderWithAsset(assetIdx: number, oid: number): Promise<boolean> {
    try {
      const action = {
        type: 'cancel',
        cancels: [{ a: assetIdx, o: oid }],
      };
      const nonce = Date.now();
      const signature = signL1Action(this.privateKeyHex, action, nonce);
      const res = await hlRateLimitedFetch(HL_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });
      const result = await res.json() as {
        response?: { data?: { statuses?: Array<string | { error: string }> } };
      };
      const status = result.response?.data?.statuses?.[0];
      return status === 'success';
    } catch (err) {
      log.warn(`cancelOrderWithAsset failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * v2.0.32: Cancel all open orders for a specific symbol on HL.
   * Used before placing new SL/TP orders (to avoid duplicates) and before
   * closing a position (to avoid conflicts with existing trigger orders).
   */
  async cancelAllOrdersForSymbol(symbol: string): Promise<number> {
    try {
      const asset = await getAssetIndex(symbol);
      if (!asset) return 0;

      // Get open orders for both DEXs
      const openOrders = await this.getOpenOrders();
      const symbolOrders = openOrders.filter(o =>
        o.coin.toLowerCase() === symbol.toLowerCase()
      );

      if (symbolOrders.length === 0) return 0;

      const cancels = symbolOrders.map(o => ({ a: asset.index, o: o.oid }));
      const action = {
        type: 'cancel',
        cancels,
      };

      const nonce = Date.now();
      const signature = signL1Action(this.privateKeyHex, action, nonce);
      const res = await hlRateLimitedFetch(HL_EXCHANGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature }),
      });

      const result = await res.json() as {
        response?: { data?: { statuses?: Array<string | { error: string }> } };
      };

      const cancelled = result.response?.data?.statuses?.filter(
        s => s === 'success'
      ).length ?? 0;

      if (cancelled > 0) {
        log.info(`🗑️ Cancelled ${cancelled} order(s) for ${symbol} on HL`);
      }
      return cancelled;
    } catch (err) {
      log.warn(`cancelAllOrdersForSymbol failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async adjustPosition(positionId: string, sl?: number, tp?: number): Promise<boolean> {
    if (!sl && !tp) {
      // Remove monitoring
      this.stopLossTakeProfit.delete(positionId);
      return true;
    }

    // Store SL/TP for monitoring
    this.stopLossTakeProfit.set(positionId, { sl, tp });
    log.info(`SL/TP set for ${positionId.slice(0, 8)}: SL=${sl} TP=${tp}`);

    // HL supports native trigger orders — place them if we have the position details
    try {
      const positions = await this.getPositions();
      // v2.0.31: Match by symbol (passed from realTradingManager) or by positionId
      const pos = positions.find(p => p.id === positionId)
        ?? positions.find(p => p.symbol.toLowerCase() === positionId.toLowerCase());
      if (!pos) {
        log.warn(`Position ${positionId.slice(0, 20)} not found on exchange for SL/TP placement`);
        return false; // v2.0.33: return false so caller can retry or safety-close
      }

      const asset = await getAssetIndex(pos.symbol);
      if (!asset) {
        log.warn(`Asset meta not found for ${pos.symbol} — cannot place native SL/TP on HL`);
        return false; // v2.0.33: return false so caller can retry or safety-close
      }

      const pxDecimals = asset.pxDecimals;
      const szDecimals = asset.szDecimals;
      log.info(`[adjustPosition] ${pos.symbol}: asset.index=${asset.index} pxDec=${pxDecimals} szDec=${szDecimals} qty=${pos.quantity} sl=${sl} tp=${tp}`);

      // v2.0.32: Safety check — SL must be on the correct side.
      // v2.0.54: SL can be on EITHER side of entry (trailing stop / profit-side
      // SL is allowed), BUT must be on the correct side of CURRENT MARK PRICE
      // to avoid immediate triggering:
      //   BUY (long): SL must be BELOW current price
      //   SELL (short): SL must be ABOVE current price
      // TP must be on the profit side of entry:
      //   BUY (long): TP > entry
      //   SELL (short): TP < entry
      if (sl && sl > 0) {
        const slOnLossSide = pos.side === 'buy' ? sl < pos.averageEntryPrice : sl > pos.averageEntryPrice;
        if (!slOnLossSide) {
          // SL is on profit side of entry — check if it's safe vs current price
          const slSafeVsPrice = pos.side === 'buy' ? sl < pos.currentPrice : sl > pos.currentPrice;
          if (!slSafeVsPrice) {
            // v2.0.71: Don't just reject — calculate a fallback SL at 2% from
            // current price on the correct side. An unprotected position is
            // worse than a slightly wider SL.
            const fallbackSL = pos.side === 'buy'
              ? pos.currentPrice * 0.98   // LONG: 2% below current
              : pos.currentPrice * 1.02;  // SHORT: 2% above current
            log.warn(`⚠️ SL $${sl.toFixed(2)} would trigger immediately for ${pos.side} ${pos.symbol} (current=$${pos.currentPrice.toFixed(2)}) — using fallback SL $${fallbackSL.toFixed(2)} (2% from current)`);
            sl = fallbackSL;
          } else {
            log.info(`📐 SL $${sl} is on profit side of entry $${pos.averageEntryPrice} for ${pos.side} ${pos.symbol} — trailing stop, valid (current=$${pos.currentPrice})`);
          }
        }
      }
      if (tp && tp > 0) {
        const tpCorrect = pos.side === 'buy' ? tp > pos.averageEntryPrice : tp < pos.averageEntryPrice;
        if (!tpCorrect) {
          log.error(`❌ TP $${tp} is on wrong side for ${pos.side} ${pos.symbol} (entry=$${pos.averageEntryPrice}) — NOT placing TP trigger`);
          tp = undefined;
        }
      }

      // v2.0.66: EARLY RETURN if nothing to place. Do NOT cancel existing
      // orders — the position must stay protected. Previously the cancel
      // block ran BEFORE this check, so invalid SL/TP would cancel old
      // orders and leave the position UNPROTECTED.
      if (!sl && !tp) {
        log.info(`⏭️ No valid SL/TP to place for ${pos.symbol} — keeping existing orders`);
        return true;
      }

      // v2.0.64: CANCEL existing trigger orders BEFORE placing new ones.
      // Without this, every SL/TP adjustment adds a NEW pair of trigger orders
      // on HL while the old ones remain — causing duplicate/stale orders to
      // accumulate (e.g. 5 SL + 5 TP for the same position).
      // We cancel all existing reduce-only orders for this coin + close side,
      // then place fresh SL + TP orders.
      //
      // v2.0.65: DEDUP GUARD — before cancelling, check if the orders we want
      // to place ALREADY EXIST at the target prices. If both SL and TP are
      // already present (within tolerance), skip the entire cancel+replace
      // cycle. This prevents race conditions where syncSLTP() and
      // adjustPositions() run concurrently and both try to place orders.
      //
      // Also check the local pending-orders cache — if we just placed these
      // orders within PENDING_TTL_MS, skip to avoid race-condition duplicates.
      let skipPlacement = false;
      try {
        const existingOrders = await this.getOpenOrders();
        const closeSide = pos.side === 'buy' ? 'A' : 'B'; // HL: 'A'=Ask(sell), 'B'=Bid(buy). Sell to close long, buy to close short.
        const myOrders = existingOrders.filter(o =>
          o.coin.toLowerCase() === pos.symbol.toLowerCase() &&
          o.side === closeSide
        );

        // Check pending cache first (fast path, no API call needed)
        const pending = this.pendingOrders.get(pos.symbol.toLowerCase());
        if (pending && (Date.now() - pending.ts) < this.PENDING_TTL_MS) {
          const slMatch = sl === undefined || (pending.sl !== undefined && Math.abs(pending.sl - sl) < 1);
          const tpMatch = tp === undefined || (pending.tp !== undefined && Math.abs(pending.tp - tp) < 1);
          if (slMatch && tpMatch) {
            log.info(`⏭️ SL/TP pending in local cache for ${pos.symbol} — skipping placement (age=${Date.now() - pending.ts}ms)`);
            skipPlacement = true;
          }
        }

        if (!skipPlacement) {
          // Dedup check: if both SL and TP already exist at target prices, skip
          const slRounded = sl !== undefined ? parseFloat(sl.toFixed(2)) : undefined;
          const tpRounded = tp !== undefined ? parseFloat(tp.toFixed(2)) : undefined;
          const hasSL = slRounded !== undefined && myOrders.some(o =>
            o.triggerPx && Math.abs(parseFloat(o.triggerPx) - slRounded) < 1
          );
          const hasTP = tpRounded !== undefined && myOrders.some(o =>
            o.triggerPx && Math.abs(parseFloat(o.triggerPx) - tpRounded) < 1
          );
          const slNeeded = sl !== undefined && sl > 0;
          const tpNeeded = tp !== undefined && tp > 0;
          // v2.0.66: Only skip if prices match AND we have at most 2 orders
          // (1 SL + 1 TP). If myOrders.length > 2, there are DUPLICATES from
          // previous buggy cycles — must cancel ALL and re-place fresh even
          // if the target prices happen to match one of the duplicates.
          const orderCountOk = myOrders.length <= 2;
          if ((!slNeeded || hasSL) && (!tpNeeded || hasTP) && orderCountOk) {
            log.info(`⏭️ SL/TP already present on HL for ${pos.symbol} — skipping placement (SL=${hasSL} TP=${hasTP}, orders=${myOrders.length})`);
            skipPlacement = true;
          } else if (myOrders.length > 0) {
            // v2.0.66: Always cancel ALL existing orders before placing new ones.
            // This handles: (a) price mismatch, (b) duplicate orders from previous
            // buggy cycles (myOrders.length > 2), (c) stale orders at old prices.
            log.info(`🗑️ Cancelling ${myOrders.length} existing trigger order(s) for ${pos.symbol} before placing new SL/TP${myOrders.length > 2 ? ' (CLEANING DUPLICATES)' : ''}`);
            for (const o of myOrders) {
              try {
                await this.cancelOrderWithAsset(asset.index, o.oid);
              } catch (err) {
                log.warn(`Failed to cancel order ${o.oid} for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      } catch (err) {
        log.warn(`Failed to fetch/cancel existing orders for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)} — continuing with new placement`);
      }

      if (skipPlacement) {
        return true;
      }

      // v2.0.65: Record pending orders BEFORE placing to prevent race-condition
      // duplicates from concurrent calls within the same cycle.
      this.pendingOrders.set(pos.symbol.toLowerCase(), { sl, tp, ts: Date.now() });

      // v2.0.33: Track actual success of trigger order placement.
      // Previously returned true even when HL rejected the orders.
      let slPlaced = !sl; // if no SL needed, consider it "placed"
      let tpPlaced = !tp; // if no TP needed, consider it "placed"

      if (sl && sl > 0) {
        const slAction = {
          type: 'order',
          orders: [{
            a: asset.index,
            b: pos.side === 'buy' ? false : true, // opposite side
            p: formatPrice(sl, pxDecimals),
            s: stripTrailingZeros(pos.quantity.toFixed(asset.szDecimals)),
            r: true, // reduce-only
            t: { trigger: { isMarket: true, triggerPx: formatPrice(sl, pxDecimals), tpsl: 'sl' } },
          }],
          grouping: 'na',
        };
        const nonce = Date.now();
        const signature = signL1Action(this.privateKeyHex, slAction, nonce);
        const slRes = await hlRateLimitedFetch(HL_EXCHANGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: slAction, nonce, signature }),
        });
        const slResult = await slRes.json() as { response?: { data?: { statuses?: Array<string | { error: string; resting?: { oid: number } }> } } };
        const slStatus = slResult.response?.data?.statuses?.[0];
        if (slStatus === 'success' || (typeof slStatus === 'object' && slStatus.resting)) {
          log.info(`✅ SL trigger order placed on HL: ${pos.symbol} @ $${sl.toFixed(2)}`);
          slPlaced = true;
        } else {
          const errMsg = typeof slStatus === 'object' ? slStatus.error : String(slStatus);
          log.error(`❌ SL trigger order rejected by HL: ${pos.symbol} @ $${sl.toFixed(2)} — ${errMsg}`);
          slPlaced = false;
        }
      }

      if (tp && tp > 0) {
        const tpAction = {
          type: 'order',
          orders: [{
            a: asset.index,
            b: pos.side === 'buy' ? false : true,
            p: formatPrice(tp, pxDecimals),
            s: stripTrailingZeros(pos.quantity.toFixed(asset.szDecimals)),
            r: true,
            t: { trigger: { isMarket: true, triggerPx: formatPrice(tp, pxDecimals), tpsl: 'tp' } },
          }],
          grouping: 'na',
        };
        const tpNonce = Date.now() + 1; // different nonce
        const tpSig = signL1Action(this.privateKeyHex, tpAction, tpNonce);
        const tpRes = await hlRateLimitedFetch(HL_EXCHANGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: tpAction, nonce: tpNonce, signature: tpSig }),
        });
        const tpResult = await tpRes.json() as { response?: { data?: { statuses?: Array<string | { error: string; resting?: { oid: number } }> } } };
        const tpStatus = tpResult.response?.data?.statuses?.[0];
        if (tpStatus === 'success' || (typeof tpStatus === 'object' && tpStatus.resting)) {
          log.info(`✅ TP trigger order placed on HL: ${pos.symbol} @ $${tp.toFixed(2)}`);
          tpPlaced = true;
        } else {
          const errMsg = typeof tpStatus === 'object' ? tpStatus.error : String(tpStatus);
          log.error(`❌ TP trigger order rejected by HL: ${pos.symbol} @ $${tp.toFixed(2)} — ${errMsg}`);
          tpPlaced = false;
        }
      }

      // v2.0.33: Return true only if BOTH SL and TP were successfully placed
      // (or weren't needed). If either failed, return false so the caller
      // can retry or safety-close the position.
      return slPlaced && tpPlaced;
    } catch (err) {
      log.error(`Native SL/TP placement failed: ${err instanceof Error ? err.message : String(err)}`);
      return false; // v2.0.33: return false so caller can retry or safety-close
    }
  }

  async closePosition(symbol: string): Promise<boolean> {
    try {
      const positions = await this.getPositions();
      // v2.0.33: If getPositions() returned empty, this is likely an API
      // failure, NOT "already closed". Return false so the caller knows
      // the close did not succeed. Previously returned true (false success)
      // which caused phantom close records — the local mirror was deleted
      // but the HL position remained open.
      if (positions.length === 0) {
        log.warn(`⚠️ closePosition(${symbol}): getPositions() returned empty — likely API failure, cannot confirm close`);
        return false;
      }
      const pos = positions.find(p => normalizeSymbol(p.symbol) === normalizeSymbol(symbol));
      if (!pos) return true; // Position genuinely not found = already closed

      // v2.0.32: Cancel existing trigger orders for this position's close
      // side before closing. Only cancel orders matching this position's
      // close side (B for short, A for long) — don't touch the opposite
      // side's orders in case there's a simultaneous long+short on the
      // same asset.
      const closeSide = pos.side === 'buy' ? 'A' : 'B'; // HL: 'A'=Ask(sell), 'B'=Bid(buy)
      const openOrders = await this.getOpenOrders();
      const myOrders = openOrders.filter(o =>
        o.coin.toLowerCase() === symbol.toLowerCase() &&
        o.side === closeSide
      );
      // v2.0.32: Use correct asset index for cancel (not positions[0])
      const asset = await getAssetIndex(symbol);
      const assetIdx = asset?.index ?? 0;
      for (const o of myOrders) {
        await this.cancelOrderWithAsset(assetIdx, o.oid);
      }
      if (myOrders.length > 0) {
        log.info(`🗑️ Cancelled ${myOrders.length} trigger order(s) for ${symbol} (${closeSide} side) before close`);
      }

      const order: Order = {
        id: uuidv4(),
        symbol: pos.symbol,
        side: pos.side === 'buy' ? 'sell' : 'buy',
        type: 'market',
        quantity: pos.quantity,
        price: pos.currentPrice,
        status: 'pending',
        filledQuantity: 0,
        filledPrice: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        agentId: '' as any,
      };

      const result = await this.placeOrder(order);
      return result.success;
    } catch (err) {
      log.error(`closePosition failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * v2.0.32: Get all open orders (including trigger/SL/TP orders) from HL.
   * Used to check if SL/TP trigger orders already exist on the exchange.
   * Queries both DEX 0 and xyz DEX.
   */
  async getOpenOrders(): Promise<Array<{
    coin: string;
    side: string;
    orderType: string;
    triggerPx?: string;
    tpsl?: string;
    sz: string;
    oid: number;
  }>> {
    const allOrders: Array<{ coin: string; side: string; orderType: string; triggerPx?: string; tpsl?: string; sz: string; oid: number }> = [];

    for (const dex of [undefined, 'xyz']) {
      try {
        const body: Record<string, unknown> = { type: 'openOrders', user: this.walletAddress };
        if (dex) body['dex'] = dex;
        const res = await hlRateLimitedFetch(HL_INFO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) continue;
        const data = await res.json() as Array<{
          coin: string;
          side: string;
          sz: string;
          oid: number;
          limitPx: string;
          reduceOnly: boolean;
          orderType?: { limit?: { tif: string }; trigger?: { isMarket: boolean; triggerPx: string; tpsl: string } };
        }>;
        for (const o of data) {
          const trigger = o.orderType?.trigger;
          // v2.0.32: HL openOrders response doesn't include orderType for trigger orders.
          // Use limitPx as triggerPx for reduce-only orders (SL/TP are always reduce-only).
          // tpsl can't be determined from the response, so we leave it undefined.
          // syncSLTP() will use limitPx to check if an order already exists at that price.
          allOrders.push({
            coin: o.coin,
            side: o.side,
            orderType: trigger ? 'trigger' : (o.reduceOnly ? 'trigger' : 'limit'),
            triggerPx: trigger?.triggerPx ?? (o.reduceOnly ? o.limitPx : undefined),
            tpsl: trigger?.tpsl,
            sz: o.sz,
            oid: o.oid,
          });
        }
      } catch { /* non-critical */ }
    }

    return allOrders;
  }

  /**
   * Check if any monitored SL/TP levels have been breached.
   * Called periodically by the trading manager.
   */
  async checkStopLossTakeProfit(currentPrices: Map<string, number>): Promise<Array<{ positionId: string; action: 'close'; reason: string }>> {
    const triggers: Array<{ positionId: string; action: 'close'; reason: string }> = [];

    for (const [positionId, sltp] of this.stopLossTakeProfit) {
      const positions = await this.getPositions();
      const pos = positions.find(p => p.id === positionId);
      if (!pos) {
        this.stopLossTakeProfit.delete(positionId);
        continue;
      }

      const currentPrice = currentPrices.get(pos.symbol) ?? pos.currentPrice;

      if (sltp.sl && pos.side === 'buy' && currentPrice <= sltp.sl) {
        triggers.push({ positionId, action: 'close', reason: `Stop-loss triggered: ${currentPrice} <= ${sltp.sl}` });
        this.stopLossTakeProfit.delete(positionId);
      } else if (sltp.sl && pos.side === 'sell' && currentPrice >= sltp.sl) {
        triggers.push({ positionId, action: 'close', reason: `Stop-loss triggered: ${currentPrice} >= ${sltp.sl}` });
        this.stopLossTakeProfit.delete(positionId);
      } else if (sltp.tp && pos.side === 'buy' && currentPrice >= sltp.tp) {
        triggers.push({ positionId, action: 'close', reason: `Take-profit triggered: ${currentPrice} >= ${sltp.tp}` });
        this.stopLossTakeProfit.delete(positionId);
      } else if (sltp.tp && pos.side === 'sell' && currentPrice <= sltp.tp) {
        triggers.push({ positionId, action: 'close', reason: `Take-profit triggered: ${currentPrice} <= ${sltp.tp}` });
        this.stopLossTakeProfit.delete(positionId);
      }
    }

    return triggers;
  }

  // ── Helpers ──

  private async getMidPrice(symbol: string): Promise<number> {
    try {
      const res = await hlRateLimitedFetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });
      if (!res.ok) return 0;
      const data = await res.json() as Record<string, string>;
      return parseFloat(data[symbol] ?? '0');
    } catch {
      return 0;
    }
  }
}