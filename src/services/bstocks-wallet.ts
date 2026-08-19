/**
 * v2.0.870-P51: Binance Agentic Wallet 接入(bStocks)
 *
 * 包裝 `baw` CLI(https://github.com/binance/binance-skills-hub 嘅
 * binance-agentic-wallet skill)。MATS 只係 drive 個 CLI,唔攞 token 出嚟——
 * session 由 baw 自己存喺本地。
 *
 * 安全紀律:
 * - 命令固定(冇 user input 拼入 shell,除咗 qrCodeId——UUID 格式驗證)
 * - execSync timeout 防掛死
 * - JSON parse 防禦(CLI 未裝/輸出異常 → 優雅錯誤,唔 crash)
 * - 唔 log/唔存 session token / private key
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface BStocksSignInResult {
  alreadyConnected?: boolean;
  urlForWeb?: string;
  qrCodeId?: string;
  pairingCode?: string;
  error?: string;
}

export interface BStocksVerifyResult {
  success: boolean;
  status?: string;
  error?: string;
}

export interface BStocksStatusResult {
  connected: boolean;
  address: string | null;
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** v2.0.870-P53: bStock contract addresses(BSC,type=3 API 實證) */
export const BSTOCK_ADDRESSES: Record<string, string> = {
  'xyz:sp500': '0x7138b48df7d98d7e3cc221bfe7192d0a178182d8', // SPYB
  'xyz:skhx': '0xca750ef65f295bbecd685abf54e82caf297bdb61',   // SKHYB
  'xyz:mu': '0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699',     // MUB
};

/** 比賽 eligible payment tokens(BSC) */
export const PAYMENT_TOKEN_ADDRESSES: Record<string, string> = {
  USDT: '0x55d398326f99059fF775485246999027B3197955',
  USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  BNB: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  U: '0xcE24439F2D9C6a2289F741120FE202248B666666',
  USD1: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d',
};

export interface BStocksSwapResult {
  success: boolean;
  orderId?: string;
  status?: string;
  txHash?: string | null;
  error?: string;
}

export interface BStocksBalanceResult {
  success: boolean;
  tvl: number | null;
  tokens: Array<{ symbol: string; balance: string; value: string }>;
  error?: string;
}

export class BStocksWallet {
  private run(cmd: string, timeoutMs: number): string {
    return execSync(cmd, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /** baw auth signin → 返回 pairingCode + urlForWeb(用戶掃 QR) */
  signIn(): BStocksSignInResult {
    try {
      const out = this.run('baw auth signin --json', 15_000);
      const parsed = JSON.parse(out);
      if (parsed?.data?.status === 'ALREADY_CONNECTED') return { alreadyConnected: true };
      return {
        urlForWeb: typeof parsed?.data?.urlForWeb === 'string' ? parsed.data.urlForWeb : undefined,
        qrCodeId: typeof parsed?.data?.qrCodeId === 'string' ? parsed.data.qrCodeId : undefined,
        pairingCode: typeof parsed?.data?.pairingCode === 'string' ? parsed.data.pairingCode : undefined,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** baw auth verify → 阻塞直到用戶喺 App 確認(或 5 分鐘 timeout) */
  verify(qrCodeId: string): BStocksVerifyResult {
    if (!UUID_RE.test(qrCodeId)) {
      return { success: false, error: 'invalid qrCodeId (must be UUID)' };
    }
    try {
      const out = this.run(`baw auth verify --qrCodeId ${qrCodeId} --json`, 300_000);
      const parsed = JSON.parse(out);
      return {
        success: parsed?.success === true,
        status: typeof parsed?.data?.status === 'string' ? parsed.data.status : undefined,
        error: typeof parsed?.error?.message === 'string' ? parsed.error.message : undefined,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** baw market-order swap → 提交 + poll 到 terminal state(FINISHED/FAILED) */
  swap(fromToken: string, toToken: string, qty: string): BStocksSwapResult {
    try {
      const out = this.run(
        `baw market-order swap --fromTokenQty ${qty} --fromToken ${fromToken} --toToken ${toToken} --binanceChainId 56 --json`,
        30_000,
      );
      const parsed = JSON.parse(out);
      const orderId = parsed?.data?.orderId;
      if (!orderId) return { success: false, error: parsed?.error?.message ?? 'no orderId' };
      // poll 到 terminal state(最多 ~30s)
      for (let i = 0; i < 6; i++) {
        const listOut = this.run(`baw market-order list --orderId ${orderId} --json`, 10_000);
        const listParsed = JSON.parse(listOut);
        const order = listParsed?.data?.list?.[0];
        if (order?.status === 'FINISHED') {
          return { success: true, orderId, status: 'FINISHED', txHash: order.txHash ?? null };
        }
        if (order?.status === 'FAILED') {
          return { success: false, orderId, status: 'FAILED', txHash: order.txHash ?? null, error: 'swap failed on-chain' };
        }
        // PENDING → 等 5s 再 poll
        execSync('sleep 5', { timeout: 6000 });
      }
      return { success: false, orderId, status: 'PENDING', error: 'swap still pending after 30s' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** baw wallet balance → TVL(所有 token value 總和) */
  getBalance(): BStocksBalanceResult {
    try {
      const out = this.run('baw wallet balance --json', 15_000);
      const parsed = JSON.parse(out);
      const tokens: Array<{ symbol: string; balance: string; value: string }> = parsed?.data ?? [];
      const tvl = tokens.reduce((sum, t) => {
        const v = parseFloat(t.value);
        return sum + (Number.isFinite(v) ? v : 0);
      }, 0);
      return { success: true, tvl: Number.isFinite(tvl) ? tvl : null, tokens };
    } catch (err) {
      return { success: false, tvl: null, tokens: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 將 BSC 地址寫入 .env(BINANCE_AW_ADDRESS) */
  saveAddress(address: string): void {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return; // 地址格式驗證
    const envPath = path.join(process.cwd(), '.env');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    const regex = /^BINANCE_AW_ADDRESS=.*$/m;
    if (regex.test(content)) {
      content = content.replace(regex, `BINANCE_AW_ADDRESS=${address}`);
    } else {
      content += `\nBINANCE_AW_ADDRESS=${address}`;
    }
    fs.writeFileSync(envPath, content);
    process.env['BINANCE_AW_ADDRESS'] = address;
  }

  /** baw wallet status + address → 連接狀態 + BSC 地址 */
  getStatus(): BStocksStatusResult {
    try {
      const out = this.run('baw wallet status --json', 10_000);
      const parsed = JSON.parse(out);
      const connected = parsed?.data?.status === 'CONNECTED';
      let address: string | null = null;
      if (connected) {
        try {
          const addrOut = this.run('baw wallet address --json', 10_000);
          const addrParsed = JSON.parse(addrOut);
          const addrs: Array<{ binanceChainId?: string; address?: string }> = addrParsed?.data?.addresses ?? [];
          const bsc = addrs.find((a) => a.binanceChainId === '56');
          address = bsc?.address ?? addrs[0]?.address ?? null;
        } catch { address = null; }
      }
      return { connected, address };
    } catch (err) {
      return { connected: false, address: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
