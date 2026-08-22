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
      // v2.0.870-fix(主神實證「This operation was aborted」):timeout 10s → 30s——
      // 主神網絡去 api.telegram.org 好慢(getMe 實測 2.7s),sendMessage 可超過 10s。
      // 同時加 retry 1 次(transient 網絡失敗常見;400 永久錯誤唔 retry)。
      const body = new URLSearchParams({
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: 'true',
      });
      const maxAttempts = 2;
      let lastErr = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
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
          const data = await res.json() as { ok?: boolean; description?: string };
          if (data.ok) {
            log.info(`[tg-signal] ${kind} signal sent to ${chatId}`);
            return true;
          }
          const desc = typeof data.description === 'string' ? data.description : '';
          // 400 = 永久錯誤(chat not found / bad request)——retry 冇意義 → 即失敗
          if (res.status === 400) {
            // v2.0.870-fix:chat not found 係最常見嘅靜默失敗源——測試污染/chatId 錯
            // 都會令訊號 send 去假 group——清晰警示(唔淨係 400 記錄)
            if (desc.includes('chat not found')) {
              log.warn(`[tg-signal] sendMessage failed (${kind}): chat not found — chatId=${chatId} 無效(bot 唔喺 group / chatId 錯 / settings 被測試污染——檢查 data/evolution/tg-signal-settings.json 同 env TELEGRAM_CHAT_ID)`);
            } else {
              log.warn(`[tg-signal] sendMessage failed (${kind}): ${JSON.stringify(data).slice(0, 200)}`);
            }
            return false;
          }
          // 5xx / 其他 → retry
          lastErr = `${res.status} ${desc.slice(0, 100)}`;
          if (attempt < maxAttempts) {
            log.warn(`[tg-signal] sendMessage failed (${kind}) attempt ${attempt}/${maxAttempts} (${lastErr}) — retrying...`);
            await new Promise(r => setTimeout(r, 1500 * attempt));
          }
        } catch (err) {
          // timeout(abort)/網絡錯誤 → retry(transient 失敗)
          lastErr = err instanceof Error ? err.message : String(err);
          if (attempt < maxAttempts) {
            log.warn(`[tg-signal] sendMessage failed (${kind}) attempt ${attempt}/${maxAttempts} (${lastErr}) — retrying...`);
            await new Promise(r => setTimeout(r, 1500 * attempt));
          }
        }
      }
      log.warn(`[tg-signal] pushSignal failed (${kind}): ${lastErr}`);
      return false;
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
    // v2.0.870-attack (V9):symbol 污染(undefined/null/non-string)→ String() 先
    const symbol = typeof trade.symbol === 'string' ? trade.symbol : '';
    lines.push(`📊 MATS TRADE — ${symbol.toUpperCase()} ${side} (OPEN)`);
    lines.push('');
    const entryNum = this.numOrNull(trade.entryPrice, 1e7);
    if (entryNum !== null && entryNum > 0) lines.push(`Entry $${entryNum.toFixed(2)}`);
    const stats: string[] = [];
    const levNum = this.numOrNull(trade.leverage, 1000);
    if (levNum !== null && levNum > 0) stats.push(`${levNum}x`);
    const confNum = this.numOrNull(trade.confidence, 10);
    if (confNum !== null && confNum > 0) stats.push(`Conf ${(confNum * 100).toFixed(0)}%`);
    // v2.0.870-attack (V10):regime 垃圾 type/超長 → truncate + type guard
    if (typeof trade.regime === 'string' && trade.regime.trim()) stats.push(this.truncate(trade.regime, 40));
    if (stats.length > 0) lines.push(stats.join(' · '));
    lines.push('');
    if (typeof trade.thesis === 'string' && trade.thesis.trim()) lines.push(`📝 ${this.truncate(trade.thesis, 350)}`);
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
    // v2.0.870-attack (V9):symbol 污染(undefined/null/non-string)→ String() 先
    const symbol = typeof trade.symbol === 'string' ? trade.symbol : '';
    // v2.0.870-attack (V4):fmtDate 對 Invalid Date 防禦——唔顯示 "Invalid Date"
    const fmtDate = (ts: number) => {
      const d = new Date(ts);
      return Number.isFinite(d.getTime())
        ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
        : '';
    };

    // ── 標題一行 ──
    // v2.0.868-fix(主神指正):reconciliation close 前系統已經用 HL fills 驗證
    // (冇 closing fill → 系統 hold——唔 close)——reconciliation 係「已驗證」嘅
    // 正常 close——唔需要 ⚠️ 警告、唔需要叫用戶核實——同其他 close 一樣格式。
    lines.push(`📊 MATS TRADE — ${symbol.toUpperCase()} ${side} (CLOSE)`);
    lines.push('');

    // ── 核心數據(合併相關——每行一個資訊單元)──
    // v2.0.870-attack (V2/V3):全部數字經 numOrNull 範圍檢查——1e308 污染值
    // (持久化垃圾)唔可以喺 group 公開顯示科學記號荒謬值。
    const entryNum = this.numOrNull(trade.entryPrice, 1e7);
    const exitNum = this.numOrNull(trade.exitPrice, 1e7);
    const entry = entryNum !== null && entryNum > 0 ? `$${entryNum.toFixed(2)}` : null;
    const exit = exitNum !== null && exitNum > 0 ? `$${exitNum.toFixed(2)}` : null;
    if (entry && exit) lines.push(`Entry ${entry} → Exit ${exit}`);
    else if (entry) lines.push(`Entry ${entry}`);
    else if (exit) lines.push(`Exit ${exit}`);

    // v2.0.870-attack (V6):pnlPct 污染(1e300)→ ±100(±10000%)上限拒絕
    const pnlNum = this.numOrNull(trade.pnlPct, 100);
    const pnl = pnlNum !== null ? pnlNum * 100 : NaN;
    if (Number.isFinite(pnl)) {
      const sign = pnl >= 0 ? '+' : '';
      // v2.0.867-fix(A):槓桿後 P&L + 未槓桿價格變化——清楚
      // v2.0.870-attack (V7):pricePct 計算溢出(entry 極細)→ ±1000% 上限
      if (entryNum !== null && exitNum !== null && entryNum > 0) {
        const pricePctRaw = ((exitNum - entryNum) / entryNum) * 100;
        const pricePct = this.numOrNull(pricePctRaw, 1000) ?? 0;
        const levNum = this.numOrNull(trade.leverage, 1000);
        const lev = levNum !== null && levNum > 0 ? ` (${levNum}x)` : '';
        lines.push(`P&L ${sign}${pnl.toFixed(2)}%${lev} | price ${pricePct >= 0 ? '+' : ''}${pricePct.toFixed(2)}%`);
      } else {
        lines.push(`P&L ${sign}${pnl.toFixed(2)}%`);
      }
    }

    // 合併:Hold + Leverage / MAE% + MFE%(主神:用 -x% & +x%——position value 極端 vs 開倉值)
    const stats: string[] = [];
    const holdNum = this.numOrNull(trade.holdMin, 1e5);
    if (holdNum !== null) stats.push(`${Math.round(holdNum)}m`);
    const levNum2 = this.numOrNull(trade.leverage, 1000);
    if (levNum2 !== null) stats.push(`${levNum2}x`);
    if (stats.length > 0) lines.push(`Hold ${stats.join(' · ')}`);
    const excursions: string[] = [];
    // initial = 開倉時 position value(investment/margin)——計算極端%需要
    const initialNum = this.numOrNull(trade.investment, 1e9);
    const initial = initialNum !== null && initialNum > 0 ? initialNum : null;
    if (initial !== null) {
      const minNum = this.numOrNull(trade.minValue, 1e9);
      if (minNum !== null && minNum > 0) {
        const maeRaw = ((minNum - initial) / initial) * 100;
        // v2.0.870-attack (V2):MAE% 超 ±100(污染)→ 唔顯示
        const maePct = this.numOrNull(maeRaw, 100);
        if (maePct !== null) excursions.push(`MAE ${maePct <= 0 ? '' : '+'}${maePct.toFixed(2)}%`);
      }
      const maxNum = this.numOrNull(trade.maxValue, 1e9);
      if (maxNum !== null && maxNum > 0) {
        const mfeRaw = ((maxNum - initial) / initial) * 100;
        const mfePct = this.numOrNull(mfeRaw, 100);
        if (mfePct !== null) excursions.push(`MFE ${mfePct >= 0 ? '+' : ''}${mfePct.toFixed(2)}%`);
      }
    }
    // 冇 initial(數據缺失)→ fallback 顯示價值(v2.0.870-attack V12:$ 值都要範圍檢查)
    if (excursions.length === 0) {
      const v: string[] = [];
      const minNum2 = this.numOrNull(trade.minValue, 1e9);
      if (minNum2 !== null && minNum2 > 0) v.push(`MAE $${minNum2.toFixed(2)}`);
      const maxNum2 = this.numOrNull(trade.maxValue, 1e9);
      if (maxNum2 !== null && maxNum2 > 0) v.push(`MFE $${maxNum2.toFixed(2)}`);
      if (v.length > 0) excursions.push(v.join(' · '));
    }
    if (excursions.length > 0) lines.push(excursions.join(' · '));
    // v2.0.870-attack (V4):openedAt/closedAt 1e308(有限但荒謬)→ 2e12(2033)上限
    const openedNum = this.numOrNull(trade.openedAt, 2e12);
    const closedNum = this.numOrNull(trade.closedAt, 2e12);
    if (openedNum !== null && openedNum > 0 && closedNum !== null && closedNum > 0) {
      // v2.0.867-format6(主神):時間左邊註明時區——避免混淆(本地時區 GMT+8)
      lines.push(`${this.timezoneLabel()} ${fmtDate(openedNum)} → ${fmtDate(closedNum)}`);
    } else if (closedNum !== null && closedNum > 0) {
      lines.push(`${this.timezoneLabel()} Closed ${fmtDate(closedNum)}`);
    }
    lines.push('');

    // ── 詳細文字(簡潔——label 用縮寫)──
    // v2.0.870(主神):TG group 詳細區塊以 Post-Review 為主體——closeReason
    // (reconciliation 等)對 group 觀眾冇意義、thesis 太長太技術性。
    // postReview 存在 → 只顯示 Review;冇(生成失敗/未有)→ fallback reason + theses
    // (資訊完整——postReview 缺失時唔靜默吞資訊)。
    // v2.0.870-attack (V1):全部 string 字段 type guard——持久化污染(JSON 可以
    // 存 number/array/object)→ 唔 crash(truncate 只收 string)。
    if (typeof trade.postReview === 'string' && trade.postReview.trim()) {
      lines.push(`✅ Review: ${this.truncate(trade.postReview, 600)}`);
    } else {
      if (typeof trade.reason === 'string' && trade.reason.trim()) lines.push(`📝 ${this.truncate(trade.reason, 220)}`);
      if (typeof trade.entryThesis === 'string' && trade.entryThesis.trim()) lines.push(`📄 Entry: ${this.truncate(trade.entryThesis, 350)}`);
      if (typeof trade.exitThesis === 'string' && trade.exitThesis.trim()) lines.push(`📄 Exit: ${this.truncate(trade.exitThesis, 250)}`);
    }
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
    // v2.0.870-attack (V1):type guard——持久化污染(JSON 可以存 number/array/
    // object)→ 唔 crash。truncate 只收 string。
    if (typeof s !== 'string' || s.length === 0) return '';
    const clean = s.replace(/\s+/g, ' ').trim();
    return clean.length > max ? clean.slice(0, max) + '…' : clean;
  }

  /** v2.0.870-attack:顯示數字統一入口——拒絕 NaN/±Infinity/非 number/超出
   *  合理範圍(持久化污染 1e308 等垃圾)→ null。maxAbs 係絕對值上限。 */
  private numOrNull(v: unknown, maxAbs: number): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = v as number;
    if (n < -maxAbs || n > maxAbs) return null;
    return n;
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
