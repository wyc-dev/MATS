// ─── TG Signal Pusher (v2.0.867) — MATS 訊號推送去 Telegram ───────────
//
// 主神商品化:@mats_trading TG group——每次 open/close 訊號公開推送。
// 設計:
//   · 設定(chatId + open/close 開關)——settings 優先,fallback env
//   · 格式化:解釋性訊號(點解開/點解 close——MATS 殺手功能)
//   · sendMessage 用 TELEGRAM_BOT_API(env 已有——token-like)
//   · 錯誤安全:send 失敗唔 block 交易(非阻塞)
//   · 冇 chatId → 靜默 skip(唔 crash)

import { createLogger } from '../observability/logger.ts';
import * as fs from 'node:fs';

const log = createLogger({ phase: 'tg-signal' });

const SETTINGS_PATH = 'data/evolution/tg-signal-settings.json';

export interface TGSignalSettings {
  /** 用戶自訂 group chat id(優先 env TELEGRAM_CHAT_ID) */
  chatId: string;
  /** 事前訊號:open position 推送開關 */
  openEnabled: boolean;
  /** close position 訊號推送開關 */
  closeEnabled: boolean;
}

function defaultSettings(): TGSignalSettings {
  return {
    chatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
    openEnabled: false,
    closeEnabled: true, // close 訊號預設開(事後記錄——安全)
  };
}

export class TGSignalPusher {
  private settings: TGSignalSettings;
  private path: string;
  /** v2.0.867-attack (V11):已發送訊號嘅 tradeId dedup——
   *  onPositionClosedLearning 對同一 trade 可被 call 兩次(EXP 重複 bug 已證)
   *  → 冇 dedup 會發兩條訊號 spam group——Set cap 200 */
  private sentTradeIds: Set<string> = new Set();

  constructor(path = SETTINGS_PATH) {
    this.settings = defaultSettings();
    this.path = path;
    this.load();
  }

  getSettings(): TGSignalSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<TGSignalSettings>): TGSignalSettings {
    if (typeof patch.chatId === 'string') {
      this.settings.chatId = patch.chatId.trim().slice(0, 64);
    }
    if (typeof patch.openEnabled === 'boolean') this.settings.openEnabled = patch.openEnabled;
    if (typeof patch.closeEnabled === 'boolean') this.settings.closeEnabled = patch.closeEnabled;
    this.save();
    return this.getSettings();
  }

  /** 攞最近 group chat id(getUpdates——bot 喺 group 收到訊息時)——用戶設定空時幫手 */
  async discoverChatId(): Promise<string | null> {
    try {
      const token = process.env['TELEGRAM_BOT_API'];
      if (!token) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      let res: Response;
      try {
        res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { method: 'GET', signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json() as { ok?: boolean; result?: Array<{ message?: { chat?: { id: number; type?: string; title?: string } } }> };
      if (data.ok && Array.isArray(data.result)) {
        // 揀 group/supergroup(排除個人 chat)
        for (const u of data.result) {
          const chat = u.message?.chat;
          if (chat && (chat.type === 'group' || chat.type === 'supergroup') && chat.id) {
            log.info(`[tg-signal] Discovered group chat id=${chat.id} (${chat.title ?? 'untitled'})`);
            return String(chat.id);
          }
        }
      }
      return null;
    } catch (err) {
      log.warn(`[tg-signal] discoverChatId failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 推送訊號(非阻塞——send 失敗唔影響交易)。
   * enabled 開關 + chatId 有效先發。
   */
  async pushSignal(kind: 'open' | 'close', text: string, tradeId?: string): Promise<boolean> {
    try {
      // v2.0.867-attack (V11):tradeId dedup——同一 trade 兩次事件 → 只發一次
      if (tradeId) {
        if (this.sentTradeIds.has(tradeId)) return false;
        this.sentTradeIds.add(tradeId);
        if (this.sentTradeIds.size > 200) {
          const first = this.sentTradeIds.values().next().value as string | undefined;
          if (first) this.sentTradeIds.delete(first); // cap 200
        }
      }
      const enabled = kind === 'open' ? this.settings.openEnabled : this.settings.closeEnabled;
      if (!enabled) return false;
      const chatId = this.settings.chatId.trim();
      const token = process.env['TELEGRAM_BOT_API'];
      if (!chatId || !token) return false; // 冇 chatId/token → 靜默 skip

      // 主神用緊嘅 bridge 發現:Telegram parse_mode 對未配對特殊字符敏感——
      // 用純文字(唔用 Markdown/HTML)——安全第一
      // v2.0.867-attack (V3):fetch 加 timeout(10s)——Telegram 唔通時唔好 hang
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const body = new URLSearchParams({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: 'true',
      });
      let res: Response;
      try {
        res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const data = await res.json() as { ok?: boolean };
      if (!data.ok) {
        log.warn(`[tg-signal] sendMessage failed (${kind}): ${JSON.stringify(data).slice(0, 200)}`);
        return false;
      }
      log.info(`[tg-signal] ${kind} signal sent to ${chatId}`);
      return true;
    } catch (err) {
      log.warn(`[tg-signal] pushSignal failed (${kind}): ${err instanceof Error ? err.message : String(err)}`);
      return false; // 非阻塞——交易唔受影響
    }
  }

  // ── 格式化 ───────────────────────────────────────────────────────────

  /** Open position 訊號(事前——解釋性) */
  formatOpenSignal(trade: {
    symbol: string; side: string; entryPrice?: number; leverage?: number;
    thesis?: string; confidence?: number; regime?: string;
  }): string {
    const side = trade.side === 'sell' ? 'SHORT' : 'LONG';
    const entry = Number.isFinite(trade.entryPrice) && (trade.entryPrice as number) > 0 ? ` @${trade.entryPrice}` : '';
    const lev = trade.leverage ? ` | ${trade.leverage}x` : '';
    const conf = trade.confidence ? ` | conf ${(trade.confidence * 100).toFixed(0)}%` : '';
    const thesis = trade.thesis ? `\n  開倉理由:${this.truncate(trade.thesis, 300)}` : '';
    return `📊 MATS Signal — OPEN ${side} ${trade.symbol}${entry}${lev}${conf}
${thesis}${trade.regime ? `\n  Regime: ${trade.regime}` : ''}`;
  }

  /** Close position 訊號(事後——記錄 + 解釋) */
  formatCloseSignal(trade: {
    symbol: string; side: string; exitPrice?: number; entryPrice?: number;
    pnlPct?: number; holdMin?: number; reason?: string; source?: string;
    exitThesis?: string;
  }): string {
    const side = trade.side === 'sell' ? 'SHORT' : 'LONG';
    const exit = trade.exitPrice ? ` @${trade.exitPrice}` : '';
    const pnl = trade.pnlPct !== undefined ? ` | ${(trade.pnlPct * 100).toFixed(2)}%` : '';
    const hold = trade.holdMin !== undefined ? ` | hold ${trade.holdMin}m` : '';
    const src = trade.source ? ` | [${trade.source.toUpperCase()}]` : '';
    const reason = trade.reason ? `\n  平倉理由:${this.truncate(trade.reason, 200)}` : '';
    const thesis = trade.exitThesis ? `\n  ${this.truncate(trade.exitThesis, 200)}` : '';
    return `📊 MATS Signal — CLOSE ${side} ${trade.symbol}${exit}${pnl}${hold}${src}
${reason}${thesis}`;
  }

  private truncate(s: string, max: number): string {
    const clean = s.replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max) + '…' : clean;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private save(): void {
    try {
      fs.writeFileSync(this.path, JSON.stringify({ version: 1, savedAt: Date.now(), ...this.settings }, null, 2), 'utf-8');
    } catch (err) {
      log.warn(`[tg-signal] save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.path)) return;
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8')) as Partial<TGSignalSettings>;
      if (raw && typeof raw === 'object') {
        if (typeof raw.chatId === 'string') this.settings.chatId = raw.chatId.trim().slice(0, 64);
        if (typeof raw.openEnabled === 'boolean') this.settings.openEnabled = raw.openEnabled;
        if (typeof raw.closeEnabled === 'boolean') this.settings.closeEnabled = raw.closeEnabled;
      }
    } catch (err) {
      log.warn(`[tg-signal] load failed (defaults): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 全系統共享單例 */
export const tgSignalPusher = new TGSignalPusher();
