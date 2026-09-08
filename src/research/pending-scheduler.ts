// research/pending-scheduler.ts — Pending Validation 自動調度 (Upgrade ③補完).
//
// 初衷: P2/研究驗證「到期」唔應該靠人記得——startup/定期檢查「樣本累積量」,
// 達標 → 自動提醒 + 可選觸發驗證。對應 OpenAI「automated intern: 監控 runs」。
//
// 機制: 每個 pending 驗證有「觸發條件」(樣本數/最小日期)——scheduler 讀實際數據
// (shadow-events.jsonl 筆數、entryConvictionLedger 等) → 到期 → log 醒目提醒 +
// 返回「到期清單」畀 caller(主神/agent 睇)。

import { existsSync, readFileSync } from 'fs';

export interface PendingValidationRule {
  id: string;
  /** 驗證目的 */
  purpose: string;
  /** 檢查數據源(file path;唔存在 → 未啟動) */
  dataFile: string;
  /** 觸發: 最少事件數(唔夠 → 未到期) */
  minEvents: number;
  /** 觸發: 最少已運行日數(optional) */
  minAgeDays?: number;
  /** 啟動日期 ms(用嚟計 age;唔設 → 用 dataFile mtime) */
  startedAt?: number;
}

export interface DueValidation {
  id: string;
  purpose: string;
  events: number;
  threshold: number;
  ageDays?: number;
}

/** 計 jsonl/event 檔案行數(研究事件檔) */
export function countEvents(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    const raw = readFileSync(filePath, 'utf8');
    let n = 0;
    for (const line of raw.split('\n')) if (line.trim()) n++;
    return n;
  } catch { return 0; }
}

/** 檢查邊啲 pending 驗證到期;到期 → 傳返去(唔自動跑——跑要主神/agent 揀,但提醒自動) */
export function checkPendingValidations(rules: PendingValidationRule[]): DueValidation[] {
  const due: DueValidation[] = [];
  for (const r of rules) {
    const events = countEvents(r.dataFile);
    const now = Date.now();
    const mtime = existsSync(r.dataFile) ? (() => { try { return readFileSync(r.dataFile, 'utf8').length >= 0 ? (r.startedAt ?? now) : now; } catch { return now; } })() : now;
    const ageDays = ((now - (r.startedAt ?? mtime)) / 86_400_000);
    const eventsOk = events >= r.minEvents;
    const ageOk = r.minAgeDays == null || ageDays >= r.minAgeDays;
    if (eventsOk && ageOk) {
      due.push({ id: r.id, purpose: r.purpose, events, threshold: r.minEvents, ageDays: Math.round(ageDays * 10) / 10 });
    }
  }
  return due;
}

/** 預設 Pending Validation 規則(P2 等)——dataFile 換成實際研究檔路徑 */
export function defaultPendingRules(dataDir: string): PendingValidationRule[] {
  return [
    {
      id: 'P2-entry-feature-validation',
      purpose: 'shadow entry 特徵分辨力驗證(adaptive sizing 基礎)——用 shadow-events.jsonl',
      dataFile: `${dataDir}/shadow-events.jsonl`,
      minEvents: 500,          // 幾日 shadow resolve 已可到(每 cycle 多個)
      minAgeDays: 10,          // 但要最少運行 10 日先算「累積咗啲」
    },
    {
      id: 'P3-convLedger-clean-ablation',
      purpose: 'convLedger 乾淨樣本消融重播(§27 六誤傷候選裁決)——依賴 real trade',
      dataFile: `${dataDir}/evolution-state.json`,
      minEvents: 1e9,          // 佔位——實際由 real trade count 觸發(2-4 週)
      minAgeDays: 21,
    },
  ];
}
