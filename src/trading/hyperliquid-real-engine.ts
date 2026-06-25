// ─── Hyperliquid Real Trading Engine ───
// Production-grade real-money trading via Hyperliquid Exchange API.
// Uses EIP-712 secp256k1 signing, dynamic asset index resolution,
// and native TP/SL via trigger orders.
//
// API Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../observability/logger.ts';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type {
  Order,
  OrderSide,
  Position,
  RealTradingEngine,
  ExchangeAccountInfo,
} from '../types/index.ts';

const log = createLogger({ phase: 'hyperliquid-real' });

// ─── Constants ───

const HL_EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const SIGNATURE_CHAIN_ID = '0xa4b1'; // Arbitrum mainnet

// ─── EIP-712 Signing ───

function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) {
    bytes[i / 2] = parseInt(h.slice(i, i + 2), 16);
  }
  return bytes;
}

/** EIP-712 domain separator for Hyperliquid */
function buildDomainSeparator(chainId: number): Uint8Array {
  // keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  const typeHash = keccak256(new TextEncoder().encode(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
  ));

  const nameHash = keccak256(new TextEncoder().encode('HyperliquidSignTransaction'));
  const versionHash = keccak256(new TextEncoder().encode('1'));

  // Encode: bytes32 typeHash + bytes32 nameHash + bytes32 versionHash + uint256 chainId + address
  const encoded = new Uint8Array(32 * 5);
  encoded.set(typeHash, 0);
  encoded.set(nameHash, 32);
  encoded.set(versionHash, 64);

  // uint256 chainId (big-endian, right-aligned in 32 bytes)
  const chainIdBytes = new Uint8Array(32);
  const view = new DataView(chainIdBytes.buffer);
  view.setBigUint64(24, BigInt(chainId));
  encoded.set(chainIdBytes, 96);

  // address (20 bytes, left-padded to 32)
  const zeroAddr = new Uint8Array(32);
  encoded.set(zeroAddr, 128);

  return keccak256(encoded);
}

/**
 * Sign a Hyperliquid action using EIP-712 typed data.
 * Uses secp256k1 (Ethereum-style) signing.
 */
function signL1Action(
  privateKeyHex: string,
  action: Record<string, unknown>,
  nonce: number,
  signatureChainId: string = SIGNATURE_CHAIN_ID,
): { r: string; s: string; v: number } {
  const privateKeyBytes = hexToBytes(privateKeyHex);

  // Build the EIP-712 message hash
  // Primary type: "HyperliquidTransaction:Order" (or appropriate type)
  const actionType = (action as any).type as string || 'order';
  const primaryType = `HyperliquidTransaction:${capitalize(actionType)}`;

  // 1. Build type hash
  const typeDef = buildTypeDef(action);
  const typeHash = keccak256(new TextEncoder().encode(typeDef));

  // 2. Build message struct hash
  const messageHash = buildMessageHash(action, nonce, signatureChainId, typeHash);

  // 3. Build domain separator
  const domainSeparator = buildDomainSeparator(42161); // Arbitrum chainId

  // 4. Final EIP-712 hash: keccak256("\x19\x01" ‖ domainSeparator ‖ messageHash)
  const prefix = new Uint8Array(2);
  prefix[0] = 0x19;
  prefix[1] = 0x01;
  const finalHash = keccak256(new Uint8Array([...prefix, ...domainSeparator, ...messageHash]));

  // 5. Sign with secp256k1
  const sig = secp256k1.sign(finalHash, privateKeyBytes) as unknown as {
    r: bigint; s: bigint; recovery?: number;
  };
  // Convert bigint r/s to 32-byte hex
  const rHex = sig.r.toString(16).padStart(64, '0');
  const sHex = sig.s.toString(16).padStart(64, '0');
  const rBytes = new Uint8Array(32);
  const sBytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    rBytes[i / 2] = parseInt(rHex.slice(i, i + 2), 16);
    sBytes[i / 2] = parseInt(sHex.slice(i, i + 2), 16);
  }
  const r = '0x' + toHex(rBytes);
  const s = '0x' + toHex(sBytes);
  const v = sig.recovery! + 27;

  return { r, s, v };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build the EIP-712 type definition string for the action.
 * Types vary by action type per HL spec.
 */
function buildTypeDef(action: Record<string, unknown>): string {
  const actionType = (action as any).type as string;

  switch (actionType) {
    case 'order': {
      const orders = (action as any).orders as Array<Record<string, unknown>>;
      const hasTrigger = orders?.some((o: any) => o.t?.trigger);
      const orderFields = hasTrigger
        ? 'uint32 asset,bool isBuy,string limitPx,string size,bool reduceOnly,string orderType,string cloid,string triggerPx,string tpsl'
        : 'uint32 asset,bool isBuy,string limitPx,string size,bool reduceOnly,string orderType,string cloid';
      return `HyperliquidTransaction:Order(${orderFields})HyperliquidTransaction:Order(uint64 nonce,string signatureChainId,${orderFields})`;
    }
    case 'cancel':
      return 'HyperliquidTransaction:Cancel(uint32 asset,uint64 oid)HyperliquidTransaction:Cancel(uint64 nonce,string signatureChainId,uint32 asset,uint64 oid)';
    case 'updateLeverage':
      return 'HyperliquidTransaction:UpdateLeverage(uint32 asset,bool isCross,uint32 leverage)HyperliquidTransaction:UpdateLeverage(uint64 nonce,string signatureChainId,uint32 asset,bool isCross,uint32 leverage)';
    default:
      // Generic: flatten all action fields
      const fields = Object.keys(action)
        .filter(k => k !== 'type')
        .map(k => `string ${k}`)
        .join(',');
      return `HyperliquidTransaction:Action(${fields})HyperliquidTransaction:Action(uint64 nonce,string signatureChainId,${fields})`;
  }
}

/**
 * Build the EIP-712 message hash for signing.
 * Encodes: typeHash ‖ encodeData(primaryType, message)
 */
function buildMessageHash(
  action: Record<string, unknown>,
  nonce: number,
  signatureChainId: string,
  typeHash: Uint8Array,
): Uint8Array {
  // Encode the message fields in order
  const parts: Uint8Array[] = [typeHash];

  // nonce (uint64, 32 bytes)
  const nonceBytes = new Uint8Array(32);
  new DataView(nonceBytes.buffer).setBigUint64(24, BigInt(nonce));
  parts.push(nonceBytes);

  // signatureChainId (string → bytes32 keccak)
  parts.push(keccak256(new TextEncoder().encode(signatureChainId)));

  // Encode action fields
  const actionType = (action as any).type as string;
  switch (actionType) {
    case 'order': {
      const orders = (action as any).orders as Array<Record<string, any>>;
      const o = orders?.[0];
      if (o) {
        // asset (uint32)
        const assetBytes = new Uint8Array(32);
        new DataView(assetBytes.buffer).setUint32(28, o['a'] as number);
        parts.push(assetBytes);

        // isBuy (bool → uint256)
        const buyBytes = new Uint8Array(32);
        buyBytes[31] = o['b'] ? 1 : 0;
        parts.push(buyBytes);

        // limitPx (string → bytes32)
        parts.push(keccak256(new TextEncoder().encode(String(o['p'] ?? '0'))));

        // size (string → bytes32)
        parts.push(keccak256(new TextEncoder().encode(String(o['s'] ?? '0'))));

        // reduceOnly (bool → uint256)
        const roBytes = new Uint8Array(32);
        roBytes[31] = o['r'] ? 1 : 0;
        parts.push(roBytes);

        // orderType (string → bytes32)
        const ot = o['t']?.trigger ? 'Trigger' : 'Limit';
        parts.push(keccak256(new TextEncoder().encode(ot)));

        // cloid (string → bytes32)
        parts.push(keccak256(new TextEncoder().encode(String(o['c'] ?? '0x0000000000000000000000000000000000000000000000000000000000000000'))));

        // trigger fields if present
        if (o['t']?.trigger) {
          parts.push(keccak256(new TextEncoder().encode(String(o['t'].trigger.triggerPx ?? '0'))));
          parts.push(keccak256(new TextEncoder().encode(String(o['t'].trigger.tpsl ?? 'sl'))));
        }
      }
      break;
    }
    case 'cancel': {
      const cancels = (action as any).cancels as Array<Record<string, any>>;
      const c = cancels?.[0];
      if (c) {
        const assetBytes = new Uint8Array(32);
        new DataView(assetBytes.buffer).setUint32(28, c['a'] as number);
        parts.push(assetBytes);

        const oidBytes = new Uint8Array(32);
        new DataView(oidBytes.buffer).setBigUint64(24, BigInt(c['o']));
        parts.push(oidBytes);
      }
      break;
    }
    default: {
      // Generic encoding: string values → keccak256
      for (const [key, value] of Object.entries(action)) {
        if (key === 'type') continue;
        parts.push(keccak256(new TextEncoder().encode(String(value))));
      }
    }
  }

  // Concatenate all parts and hash
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    combined.set(p, offset);
    offset += p.length;
  }

  return keccak256(combined);
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
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    });

    if (!res.ok) return null;
    const data = await res.json() as {
      universe: Array<{
        name: string;
        szDecimals: number;
        pxDecimals: number;
        maxLeverage: number;
      }>;
    };

    assetIndexCache = new Map();
    data.universe.forEach((asset, index) => {
      assetIndexCache!.set(asset.name.toUpperCase(), {
        name: asset.name,
        index,
        szDecimals: asset.szDecimals,
        pxDecimals: asset.pxDecimals,
        maxLeverage: asset.maxLeverage,
      });
    });
    assetCacheTimestamp = now;

    log.info(`Asset index cache refreshed: ${assetIndexCache.size} assets`);
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

  constructor(walletAddress: string, privateKeyHex: string) {
    this.walletAddress = walletAddress;
    this.privateKeyHex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
    log.info(`Hyperliquid Real Engine initialized: ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`);
  }

  async isConnected(): Promise<boolean> {
    try {
      const res = await fetch(HL_INFO_URL, {
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

  /** DEX names to query for clearinghouseState (DEX 0 = crypto perps, 'xyz' = TradFi perps) */
  private static readonly PERP_DEX_NAMES: Array<number | string> = [0, 'xyz'];

  async getBalance(): Promise<ExchangeAccountInfo> {
    try {
      let totalAccountValue = 0;
      let totalWithdrawable = 0;
      let totalMarginUsed = 0;
      let totalUnrealizedPnl = 0;

      // Query each perp DEX clearinghouse
      for (const dex of HyperliquidRealEngine.PERP_DEX_NAMES) {
        try {
          const res = await fetch(HL_INFO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: this.walletAddress, dex }),
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
        const spotRes = await fetch(HL_INFO_URL, {
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

      // Total = sum of all perp DEX account values + spot USDC (available but not in perp)
      const total = totalAccountValue + spotUsdc;
      const free = totalWithdrawable + spotUsdc;

      log.info(`[getBalance] total=${total}, free=${free}, marginUsed=${totalMarginUsed}, unrealizedPnl=${totalUnrealizedPnl}, spotUsdc=${spotUsdc}`);

      return {
        free,
        locked: totalMarginUsed,
        total,
        unrealizedPnl: totalUnrealizedPnl,
        marginUsed: totalMarginUsed,
      };
    } catch (err) {
      log.error(`getBalance failed: ${err instanceof Error ? err.message : String(err)}`);
      return { free: 0, locked: 0, total: 0, unrealizedPnl: 0, marginUsed: 0 };
    }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const allPositions: Position[] = [];

      // Query each perp DEX clearinghouse
      for (const dex of HyperliquidRealEngine.PERP_DEX_NAMES) {
        try {
          const res = await fetch(HL_INFO_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'clearinghouseState', user: this.walletAddress, dex }),
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
              openedAt: Date.now(),
              updatedAt: Date.now(),
              agentId: 'hyperliquid-real',
            } as Position);
          }
        } catch (err) {
          log.warn(`[getPositions] DEX ${dex} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return allPositions;
    } catch (err) {
      log.error(`getPositions failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Get the user's most recent N fills from Hyperliquid (v2.0.19).
   * Uses the `userFillsByTime` REST endpoint. Returns fills newest-first.
   * Used to sync the UI Trade Records panel with the real exchange so the
   * user sees their actual Hyperliquid trade history (last 5 by default).
   */
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
    try {
      // userFillsByTime requires startTime — HL API fails without it.
      // Query last 7 days to capture all recent fills.
      const startTime = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const res = await fetch(HL_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'userFillsByTime', user: this.walletAddress, startTime }),
      });
      if (!res.ok) return [];
      const data = await res.json() as { fills?: Array<{
        coin: string;
        side: string;
        px: string;
        sz: string;
        time: number;
        closedPnl: string;
        fee: string;
        dir: string;
      }> };
      const fills = data.fills ?? [];
      // Sort newest first (HL returns ascending), take the last `limit`.
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
      log.error(`getRecentFills failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ── Order Management ──

  async placeOrder(order: Order): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      const asset = await getAssetIndex(order.symbol);
      if (!asset) {
        return { success: false, error: `Unknown asset: ${order.symbol}. Run meta refresh first.` };
      }

      const isBuy = order.side === 'buy';
      const pxDecimals = asset.pxDecimals;
      const szDecimals = asset.szDecimals;

      // Build order spec
      const orderSpec: Record<string, unknown> = {
        a: asset.index,
        b: isBuy,
        p: order.price.toFixed(pxDecimals),
        s: order.quantity.toFixed(szDecimals),
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
              triggerPx: triggerPx.toFixed(pxDecimals),
              tpsl,
            },
          };
          orderSpec['r'] = true; // Reduce-only for SL/TP
        }
      }

      if (order.type === 'market') {
        // Get mid price for aggressive market order
        const mid = await this.getMidPrice(order.symbol);
        if (mid > 0) {
          const aggressivePx = isBuy ? mid * 1.05 : mid * 0.95;
          (orderSpec as any).p = aggressivePx.toFixed(pxDecimals);
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

      const res = await fetch(HL_EXCHANGE_URL, {
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

      const oid = status?.resting?.oid ?? status?.filled?.oid;
      if (oid) {
        log.info(`Order placed: ${order.side} ${order.quantity} ${order.symbol} oid=${oid}`);
        return { success: true, orderId: String(oid) };
      }

      return { success: false, error: `Unexpected response: ${JSON.stringify(result).slice(0, 200)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`placeOrder failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      // Need asset index — try to get from first position
      const positions = await this.getPositions();
      const assetIdx = positions[0]?.symbol
        ? (await getAssetIndex(positions[0].symbol))?.index ?? 0
        : 0;

      const action = {
        type: 'cancel',
        cancels: [{ a: assetIdx, o: parseInt(orderId) }],
      };

      const nonce = Date.now();
      const signature = signL1Action(this.privateKeyHex, action, nonce);

      const res = await fetch(HL_EXCHANGE_URL, {
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
      const pos = positions.find(p => p.id === positionId);
      if (!pos) {
        log.warn(`Position ${positionId.slice(0, 8)} not found for SL/TP placement`);
        return true; // Monitoring will handle it
      }

      const asset = await getAssetIndex(pos.symbol);
      if (!asset) return true;

      const pxDecimals = asset.pxDecimals;

      if (sl && sl > 0) {
        const slAction = {
          type: 'order',
          orders: [{
            a: asset.index,
            b: pos.side === 'buy' ? false : true, // opposite side
            p: sl.toFixed(pxDecimals),
            s: pos.quantity.toFixed(asset.szDecimals),
            r: true, // reduce-only
            t: { trigger: { isMarket: true, triggerPx: sl.toFixed(pxDecimals), tpsl: 'sl' } },
          }],
          grouping: 'na',
        };
        const nonce = Date.now();
        const signature = signL1Action(this.privateKeyHex, slAction, nonce);
        await fetch(HL_EXCHANGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: slAction, nonce, signature }),
        });
        log.info(`SL order placed: ${pos.symbol} @ $${sl.toFixed(2)}`);
      }

      if (tp && tp > 0) {
        const tpAction = {
          type: 'order',
          orders: [{
            a: asset.index,
            b: pos.side === 'buy' ? false : true,
            p: tp.toFixed(pxDecimals),
            s: pos.quantity.toFixed(asset.szDecimals),
            r: true,
            t: { trigger: { isMarket: true, triggerPx: tp.toFixed(pxDecimals), tpsl: 'tp' } },
          }],
          grouping: 'na',
        };
        const nonce = Date.now() + 1; // different nonce
        const signature = signL1Action(this.privateKeyHex, tpAction, nonce);
        await fetch(HL_EXCHANGE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: tpAction, nonce, signature }),
        });
        log.info(`TP order placed: ${pos.symbol} @ $${tp.toFixed(2)}`);
      }

      return true;
    } catch (err) {
      log.warn(`Native SL/TP placement failed, falling back to monitoring: ${err instanceof Error ? err.message : String(err)}`);
      return true; // Monitoring loop will handle it
    }
  }

  async closePosition(symbol: string): Promise<boolean> {
    try {
      const positions = await this.getPositions();
      const pos = positions.find(p => p.symbol.toUpperCase() === symbol.toUpperCase());
      if (!pos) return true; // No position = already closed

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
      const res = await fetch(HL_INFO_URL, {
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