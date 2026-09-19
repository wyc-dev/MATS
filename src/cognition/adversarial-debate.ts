/**
 * adversarial-debate.ts —— v2.0.919-P9-hacp-adversarial（主神批 PLAN_hacp-adversarial）
 *
 * 組件 1: Bull/Bear 對抗辯論。
 * 背景(驗證實錘): MATS 7 agents 各自陳述 → 95.1% HOLD + Skeptics「0 modified」+
 * 296 個 minority 意向被 majority hold 淹沒; mock 實測(同 context 同 LLM):
 *   現版 → 0B/0S/7H 全 HOLD; 對抗版 → Bull「DIRECTION: LONG」/ Bear「Do Not Buy」
 *   / Research Manager commit 到 Overweight, 仲揪出 Bear「fatal analytical error」。
 * 即係「加對抗結構 = 由全 HOLD 變有方向 + 逼 fact-check」。
 *
 * 設計(可測純函數 + 可注入 LLM):
 *   opponentMarker(): 首輪防 fabrication(TradingAgents #1176——對手未發言 = 唔可以
 *     叫模型「反駁」空氣, 明確 marker「自己開局」)
 *   buildBullPrompt / buildBearPrompt: Bull 建最強買入 case + 反駁 Bear最新論點;
 *     Bear 建最強賣出 case + 反駁 Bull 最新論點(暴露 over-optimistic 假設)
 *   runAdversarialDebate(): 循環 Bull→Bear→…(rounds 次) → { bullRationale, bearRationale, history }
 *
 * 統計層零 touched; env HACP_ADVERSARIAL=false 回滾。全英文。
 */
import { z } from 'zod';

export interface LLMCall {
  (system: string, user: string): Promise<string>;
}

export interface AdversarialInput {
  symbol: string;
  analystContext: string; // 現有 market/news/sentiment/onchain 報告組(唔郁)
}

export interface AdversarialTurn {
  side: 'bull' | 'bear';
  argument: string;
}

export interface AdversarialResult {
  bullRationale: string;
  bearRationale: string;
  history: string;
  turns: AdversarialTurn[];
}

export const ADVERSARIAL_DEFAULT_ROUNDS = 1; // Bull→Bear 各 1 次
export const ADVERSARIAL_MAX_ROUNDS = 3;

/** 首輪防 fabrication: 對手未發言 → 明確「自己開局」(TradingAgents #1176) */
export function opponentMarker(opponent: 'bull' | 'bear'): string {
  return (
    `(The ${opponent === 'bull' ? 'Bull' : 'Bear'} analyst has not spoken yet — ` +
    `open the debate with your own case.)`
  );
}

/** Bull prompt——建最強買入 case + 直接反駁 Bear 最新論點 */
export function buildBullPrompt(input: AdversarialInput, lastBear: string, history: string): string {
  const bearSegment =
    lastBear && lastBear !== opponentMarker('bull')
      ? lastBear
      : opponentMarker('bear');
  return [
    `You are a Bull Analyst advocating for investing in ${input.symbol}. Build a strong, evidence-based case: growth potential, competitive advantages, positive indicators.`,
    `Critically analyze the bear argument with specific data — refute each concern and show why the bull perspective holds stronger merit.`,
    `Engage conversationally, debating effectively rather than listing data.`,
    ``,
    `Analyst context:`,
    input.analystContext,
    ``,
    `Conversation history:`,
    history || '(no prior debate)',
    ``,
    `Last bear argument:`,
    bearSegment,
    ``,
    `Deliver a compelling bull argument that refutes the bear's concerns.`,
  ].join('\n');
}

/** Bear prompt——建最強賣出 case + 直接反駁 Bull 最新論點(暴露 over-optimistic 假設) */
export function buildBearPrompt(input: AdversarialInput, lastBull: string, history: string): string {
  const bullSegment =
    lastBull && lastBull !== opponentMarker('bear')
      ? lastBull
      : opponentMarker('bull');
  return [
    `You are a Bear Analyst making the case against investing in ${input.symbol}. Build a well-reasoned argument: risks, challenges, negative indicators, competitive weaknesses.`,
    `Critically analyze the bull argument with specific data — expose weaknesses or over-optimistic assumptions.`,
    `Engage conversationally, debating effectively rather than listing facts.`,
    ``,
    `Analyst context:`,
    input.analystContext,
    ``,
    `Conversation history:`,
    history || '(no prior debate)',
    ``,
    `Last bull argument:`,
    bullSegment,
    ``,
    `Deliver a compelling bear argument that refutes the bull's claims.`,
  ].join('\n');
}

/**
 * 跑 Bull/Bear 對抗辯論。循環 Bull→Bear→… rounds 次。
 * 任何 LLM 失敗 → 返回空結果(唔 crash, 唔影響主流程——失敗 = 唔注入對抗)。
 */
export async function runAdversarialDebate(
  llm: LLMCall,
  input: AdversarialInput,
  rounds: number = ADVERSARIAL_DEFAULT_ROUNDS,
  timeoutMs: number = 30_000,
): Promise<AdversarialResult> {
  const safeRounds = Number.isInteger(rounds)
    ? Math.min(Math.max(rounds, 1), ADVERSARIAL_MAX_ROUNDS)
    : ADVERSARIAL_DEFAULT_ROUNDS;

  const turns: AdversarialTurn[] = [];
  let bullHistory = '';
  let bearHistory = '';
  let history = '';
  let lastBull = opponentMarker('bear');
  let lastBear = opponentMarker('bull');

  for (let r = 0; r < safeRounds; r++) {
    try {
      const bullArg = await withTimeout(
        llm(buildBullPrompt(input, lastBear, history), ''),
        timeoutMs,
      );
      const bullText = typeof bullArg === 'string' ? bullArg : '';
      if (bullText) {
        bullHistory = bullHistory ? bullHistory + '\n' + bullText : bullText;
        history = history ? history + '\nBull: ' + bullText : 'Bull: ' + bullText;
        lastBull = bullText;
        turns.push({ side: 'bull', argument: bullText });
      }
    } catch { /* 單輪失敗 → 跳過 (唔會 crash 主流程) */ }

    try {
      const bearArg = await withTimeout(
        llm(buildBearPrompt(input, lastBull, history), ''),
        timeoutMs,
      );
      const bearText = typeof bearArg === 'string' ? bearArg : '';
      if (bearText) {
        bearHistory = bearHistory ? bearHistory + '\n' + bearText : bearText;
        history = history ? history + '\nBear: ' + bearText : 'Bear: ' + bearText;
        lastBear = bearText;
        turns.push({ side: 'bear', argument: bearText });
      }
    } catch { /* 單輪失敗 → 跳過 */ }
  }

  return {
    bullRationale: bullHistory,
    bearRationale: bearHistory,
    history,
    turns,
  };
}

/** Abortable promise with timeout — LLM call failures never crash the cycle */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('adversarial timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Zod schemas(供外部校驗)
export const AdversarialResultSchema = z.object({
  bullRationale: z.string(),
  bearRationale: z.string(),
  history: z.string(),
  turns: z.array(z.object({ side: z.enum(['bull', 'bear']), argument: z.string() })),
});
