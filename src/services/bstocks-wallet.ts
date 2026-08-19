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
