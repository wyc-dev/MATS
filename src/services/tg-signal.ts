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
  /** 主神:輸錢平倉暫時唔推——只推盈利 close */
  profitOnlyClose: boolean;
}

function defaultSettings(): TGSignalSettings {
  return {
    chatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
    openEnabled: false,
    closeEnabled: true, // close 訊號預設開(事後記錄——安全)
    profitOnlyClose: true, // 主神:暫時只推盈利 close(輸錢唔 expose)
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
    if (typeof patch.profitOnlyClose === 'boolean') this.settings.profitOnlyClose = patch.profitOnlyClose;
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
  async pushSignal(kind: 'open' | 'close', text: string, tradeId?: string, pnlPct?: number): Promise<boolean> {
    try {
      // 主神:輸錢平倉暫時唔推(profitOnlyClose)——pnlPct < 0 → skip
      // (check 喺 dedup 之前——輸錢唔應該入 dedup——唔係「已推」)
      if (kind === 'close' && this.settings.profitOnlyClose && pnlPct !== undefined && Number.isFinite(pnlPct) && pnlPct < 0) {
        log.info(`[tg-signal] close signal skipped (loss ${(pnlPct * 100).toFixed(2)}% — profitOnlyClose)`);
        return false;
      }
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

  /** Open position 訊號(事前——簡潔點列,同 close 一致風格;主神準備用) */
  formatOpenSignal(trade: {
    symbol: string; side: string; entryPrice?: number; leverage?: number;
    thesis?: string; confidence?: number; regime?: string;
  }): string {
    const lines: string[] = [];
    const side = trade.side === 'sell' ? 'SHORT' : 'LONG';
    lines.push(`📊 MATS TRADE — ${trade.symbol.toUpperCase()} ${side} (OPEN)`);
    lines.push('');
    if (Number.isFinite(trade.entryPrice) && (trade.entryPrice as number) > 0) lines.push(`Entry $${Number(trade.entryPrice).toFixed(2)}`);
    const stats: string[] = [];
    if (Number.isFinite(trade.leverage) && (trade.leverage as number) > 0) stats.push(`${trade.leverage}x`);
    if (Number.isFinite(trade.confidence) && (trade.confidence as number) > 0) stats.push(`Conf ${((trade.confidence as number) * 100).toFixed(0)}%`);
    if (trade.regime) stats.push(trade.regime);
    if (stats.length > 0) lines.push(stats.join(' · '));
    lines.push('');
    if (trade.thesis) lines.push(`📝 ${this.truncate(trade.thesis, 350)}`);
    return lines.join('\n');
  }

  /** Close position 訊號(事後——簡潔點列,主神要求:唔用表格框(TG box-drawing
   *  效果差)——合併相關數據、每行一個資訊單元、易讀) */
  formatCloseSignal(trade: {
    symbol: string; side: string; exitPrice?: number; entryPrice?: number;
    pnlPct?: number; holdMin?: number; reason?: string; source?: string;
    entryThesis?: string; exitThesis?: string; postReview?: string;
    leverage?: number; investment?: number; minValue?: number; maxValue?: number;
    openedAt?: number; closedAt?: number;
  }): string {
    const lines: string[] = [];
    const side = trade.side === 'sell' ? 'SHORT' : 'LONG';
    const fmtDate = (ts: number) => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

    // ── 標題一行 ──
    lines.push(`📊 MATS TRADE — ${trade.symbol.toUpperCase()} ${side} (CLOSE)`);
    lines.push('');

    // ── 核心數據(合併相關——每行一個資訊單元)──
    const entry = Number.isFinite(trade.entryPrice) && (trade.entryPrice as number) > 0 ? `$${Number(trade.entryPrice).toFixed(2)}` : null;
    const exit = Number.isFinite(trade.exitPrice) && (trade.exitPrice as number) > 0 ? `$${Number(trade.exitPrice).toFixed(2)}` : null;
    if (entry && exit) lines.push(`Entry ${entry} → Exit ${exit}`);
    else if (entry) lines.push(`Entry ${entry}`);
    else if (exit) lines.push(`Exit ${exit}`);

    const pnl = Number.isFinite(trade.pnlPct) ? (trade.pnlPct as number) * 100 : NaN;
    if (Number.isFinite(pnl)) {
      const sign = pnl >= 0 ? '+' : '';
      // v2.0.867-fix(A):槓桿後 P&L + 未槓桿價格變化——清楚
      if (entry && exit && Number.isFinite(trade.entryPrice) && Number.isFinite(trade.exitPrice)) {
        const pricePct = (((trade.exitPrice as number) - (trade.entryPrice as number)) / (trade.entryPrice as number)) * 100;
        const lev = Number.isFinite(trade.leverage) && (trade.leverage as number) > 0 ? ` (${trade.leverage}x)` : '';
        lines.push(`P&L ${sign}${pnl.toFixed(2)}%${lev} | price ${pricePct >= 0 ? '+' : ''}${pricePct.toFixed(2)}%`);
      } else {
        lines.push(`P&L ${sign}${pnl.toFixed(2)}%`);
      }
    }

    // 合併:Hold + Leverage / MAE% + MFE%(主神:用 -x% & +x%——position value 極端 vs 開倉值)
    const stats: string[] = [];
    if (Number.isFinite(trade.holdMin)) stats.push(`${Math.round(trade.holdMin as number)}m`);
    if (Number.isFinite(trade.leverage)) stats.push(`${trade.leverage}x`);
    if (stats.length > 0) lines.push(`Hold ${stats.join(' · ')}`);
    const excursions: string[] = [];
    // initial = 開倉時 position value(investment/margin)——計算極端%需要
    const initial = Number.isFinite(trade.investment) && (trade.investment as number) > 0 ? (trade.investment as number) : null;
    if (initial && Number.isFinite(trade.minValue) && (trade.minValue as number) > 0) {
      const maePct = ((trade.minValue as number) - initial) / initial * 100;
      excursions.push(`MAE ${maePct <= 0 ? '' : '+'}${maePct.toFixed(2)}%`);
    }
    if (initial && Number.isFinite(trade.maxValue) && (trade.maxValue as number) > 0) {
      const mfePct = ((trade.maxValue as number) - initial) / initial * 100;
      excursions.push(`MFE ${mfePct >= 0 ? '+' : ''}${mfePct.toFixed(2)}%`);
    }
    // 冇 initial(數據缺失)→ fallback 顯示價值
    if (excursions.length === 0) {
      const v: string[] = [];
      if (Number.isFinite(trade.minValue) && (trade.minValue as number) > 0) v.push(`MAE $${Number(trade.minValue).toFixed(2)}`);
      if (Number.isFinite(trade.maxValue) && (trade.maxValue as number) > 0) v.push(`MFE $${Number(trade.maxValue).toFixed(2)}`);
      if (v.length > 0) excursions.push(v.join(' · '));
    }
    if (excursions.length > 0) lines.push(excursions.join(' · '));
    if (Number.isFinite(trade.openedAt) && (trade.openedAt as number) > 0 && Number.isFinite(trade.closedAt) && (trade.closedAt as number) > 0) {
      // v2.0.867-format6(主神):時間左邊註明時區——避免混淆(本地時區 GMT+8)
      lines.push(`${this.timezoneLabel()} ${fmtDate(trade.openedAt as number)} → ${fmtDate(trade.closedAt as number)}`);
    } else if (Number.isFinite(trade.closedAt) && (trade.closedAt as number) > 0) {
      lines.push(`${this.timezoneLabel()} Closed ${fmtDate(trade.closedAt as number)}`);
    }
    lines.push('');

    // ── 詳細文字(簡潔——label 用縮寫)──
    if (trade.reason) lines.push(`📝 ${this.truncate(trade.reason, 220)}`);
    if (trade.entryThesis) lines.push(`📄 Entry: ${this.truncate(trade.entryThesis, 350)}`);
    if (trade.exitThesis) lines.push(`📄 Exit: ${this.truncate(trade.exitThesis, 250)}`);
    if (trade.postReview) lines.push(`✅ Review: ${this.truncate(trade.postReview, 280)}`);
    return lines.join('\n');
  }

  /** 時區 label——動態計本地 offset(例:(GMT+8))——主神要求時間左邊註明 */
  private timezoneLabel(): string {
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '';
    const h = Math.floor(Math.abs(offsetMin) / 60);
    const m = Math.abs(offsetMin) % 60;
    return `(GMT${sign}${h}${m > 0 ? ':' + String(m).padStart(2, '0') : ''})`;
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
        if (typeof raw.profitOnlyClose === 'boolean') this.settings.profitOnlyClose = raw.profitOnlyClose;
      }
    } catch (err) {
      log.warn(`[tg-signal] load failed (defaults): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 全系統共享單例 */
export const tgSignalPusher = new TGSignalPusher();
