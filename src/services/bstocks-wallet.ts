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
  'xyz:spcx': '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1',   // SPCXB
  'xyz:sndk': '0x3ee4df61bd4f867e349beae8bfe07bc31b4850fb',   // SNDKB
};

/** v2.0.870-P56: xyz: symbol → bStock symbol(UI 顯示用) */
export const BSTOCK_SYMBOLS: Record<string, string> = {
  'xyz:sp500': 'SPYB',
  'xyz:skhx': 'SKHYB',
  'xyz:mu': 'MUB',
  'xyz:spcx': 'SPCXB',
  'xyz:sndk': 'SNDKB',
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

/** v2.0.870-P66: 全部平倉 bStocks 結果 */
export interface BStocksCloseAllResult {
  success: boolean;
  closed: number;
  results?: Array<{ symbol: string; success: boolean; error?: string }>;
  message?: string;
  error?: string;
}

export interface BStocksBalanceResult {
  success: boolean;
  tvl: number | null;
  /** v2.0.870-P64: BNB 餘額(gas 保留檢查用)——每次 swap 都係 on-chain tx,冇 BNB gas 會失敗 */
  bnbBalance: number | null;
  bnbValue: number | null;
  tokens: Array<{ symbol: string; balance: string; value: string; address?: string }>;
  error?: string;
}

/** v2.0.870-P65-attack: BStock swap 前置檢查結果 */
export interface BStockSwapPrecheck {
  ok: boolean;
  reason?: string;
}

/**
 * v2.0.870-P65-attack: BStock swap 前置檢查(純函數,可獨立測試)。
 * fail-closed:唔知 gas 狀態(null/NaN/負數)→ skip,唔好 swap。
 * 攻擊修復:A1(getBalance 失敗 null bypass)/ A2(BNB NaN)/ A3(USDT 垃圾)。
 */
export function checkBStockSwapPreconditions(
  bal: BStocksBalanceResult,
  side: 'buy' | 'sell',
  minBnbGas = 0.01,
): BStockSwapPrecheck {
  // BNB gas 檢查:null(唔知)/NaN/負數/< min → fail-closed skip
  if (bal.bnbBalance == null || !Number.isFinite(bal.bnbBalance) || bal.bnbBalance < minBnbGas) {
    return { ok: false, reason: `BNB gas 不足 (${bal.bnbBalance} BNB < ${minBnbGas})` };
  }
  // 買 bStock 需要 USDT——冇 USDT 或者 balance 垃圾 → skip(唔好將全部資金轉做 bStock)
  if (side === 'buy') {
    const usdt = bal.tokens.find((t) => t.symbol === 'USDT');
    const usdtBal = usdt ? parseFloat(usdt.balance) : 0;
    if (!Number.isFinite(usdtBal) || usdtBal <= 0) {
      return { ok: false, reason: `USDT 餘額不足 (${usdtBal})` };
    }
  }
  return { ok: true };
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

  /** baw wallet balance → TVL(所有 token value 總和)+ BNB 餘額(gas 保留檢查) */
  getBalance(): BStocksBalanceResult {
    try {
      const out = this.run('baw wallet balance --json', 15_000);
      const parsed = JSON.parse(out);
      const tokens: Array<{ symbol: string; balance: string; value: string; address?: string }> = parsed?.data ?? [];
      const tvl = tokens.reduce((sum, t) => {
        const v = parseFloat(t.value);
        return sum + (Number.isFinite(v) ? v : 0);
      }, 0);
      // v2.0.870-P64: 分開 BNB 餘額——每次 swap 都係 on-chain tx,冇 BNB gas 會失敗
      const bnb = tokens.find((t) => t.symbol === 'BNB');
      const bnbBalance = bnb ? parseFloat(bnb.balance) : 0;
      const bnbValue = bnb ? parseFloat(bnb.value) : 0;
      return {
        success: true,
        tvl: Number.isFinite(tvl) ? tvl : null,
        bnbBalance: Number.isFinite(bnbBalance) ? bnbBalance : 0,
        bnbValue: Number.isFinite(bnbValue) ? bnbValue : 0,
        tokens,
      };
    } catch (err) {
      return { success: false, tvl: null, bnbBalance: null, bnbValue: null, tokens: [], error: err instanceof Error ? err.message : String(err) };
    }
  }



/**
 * v2.0.870-P66: 全部平倉 bStocks——賣晒所有 bStock token → USDT。
 * 只平 bStock(symbol 以 B 結尾且唔係 payment token),保留 USDT/USDC/BNB 做 gas。
 * 逐個 swap(串行,避免 rate limit);失敗唔中斷,繼續平其餘。
 */
  closeAll(): BStocksCloseAllResult {
    try {
      const bal = this.getBalance();
      if (!bal.success || !bal.tokens.length) {
        return { success: true, closed: 0, message: 'no tokens to close' };
      }
      const usdtAddr = PAYMENT_TOKEN_ADDRESSES['USDT'] ?? '';
      if (!usdtAddr) return { success: false, closed: 0, error: 'no USDT address configured' };
      const bStocks = findBStockTokens(bal.tokens);
      if (bStocks.length === 0) {
        return { success: true, closed: 0, message: 'no bStock holdings' };
      }
      const results: Array<{ symbol: string; success: boolean; error?: string }> = [];
      for (const b of bStocks) {
        const qty = parseFloat(b.balance);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        if (!b.address) {
          results.push({ symbol: b.symbol, success: false, error: 'no token address' });
          continue;
        }
        const r = this.swap(b.address, usdtAddr, b.balance);
        results.push({ symbol: b.symbol, success: r.success, error: r.error });
      }
      const closed = results.filter((r) => r.success).length;
      return { success: true, closed, results };
    } catch (err) {
      return { success: false, closed: 0, error: err instanceof Error ? err.message : String(err) };
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

/** v2.0.870-P66: 搵 bStock tokens(symbol 以 B 結尾且唔係 payment token)。純函數,可獨立測試。 */
export function findBStockTokens(tokens: Array<{ symbol: string; balance: string; value: string; address?: string }>): Array<{ symbol: string; balance: string; value: string; address?: string }> {
  const PAYMENT_SYMS = new Set(['USDT', 'USDC', 'BNB', 'U', 'USD1']);
  return tokens.filter((t) => {
    const sym = String(t.symbol ?? '').toUpperCase();
    return sym.endsWith('B') && !PAYMENT_SYMS.has(sym);
  });
}
