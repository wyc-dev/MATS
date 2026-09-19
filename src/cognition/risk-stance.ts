/**
 * risk-stance.ts —— v2.0.919-P9-hacp-adversarial（主神批 PLAN_hacp-adversarial）
 *
 * 組件 3: 風險三 stance 壓力測試。
 * 背景(驗證實錘): 現有 risk auditor 單一視角「結構性 SL/TP」——冇 aggressive/neutral/
 * conservative 分化; TradingAgents 用 3 個 stance 輪流互駁 → Portfolio Manager 睇分歧先批。
 *
 * 設計(可測純函數 + 可注入 LLM):
 *   buildAggressivePrompt / buildNeutralPrompt / buildConservativePrompt:
 *     每個 stance 收同一 trade plan + 其他兩個 stance 最新 response, 要求直接互駁
 *     (aggressive: 指出保守/中立錯過咩機會; conservative: 質問樂觀嘅風險)
 *   runRiskStanceDebate(): aggressive → conservative → neutral 輪流 … rounds 次
 *     輸出: 三票 + disagreementFlag(三票 action 唔一致 = 真風險不確定)
 *
 * 統計層零 touched; 現有 independent_risk_auditor veto 邏輯零改——三票係額外視角注入。
 * env HACP_RISK_STANCES=false 回滾。全英文。
 */
import { z } from 'zod';

export interface LLMCall {
  (system: string, user: string): Promise<string>;
}

export interface RiskStanceInput {
  symbol: string;
  tradePlan: string;         // 現有 consensus/提案
  analystContext: string;
}

export interface RiskStanceTurn {
  stance: 'aggressive' | 'neutral' | 'conservative';
  argument: string;
}

export interface RiskStanceResult {
  aggressive: string;
  neutral: string;
  conservative: string;
  history: string;
  disagreement: boolean;     // 三票立場分歧 = 真風險不確定
}

export const RISK_STANCE_DEFAULT_ROUNDS = 1;
export const RISK_STANCE_MAX_ROUNDS = 3;

export function buildAggressivePrompt(input: RiskStanceInput, conservative: string, neutral: string): string {
  return [
    `As the Aggressive Risk Analyst, champion high-reward opportunities while evaluating ${input.symbol} trade plan.`,
    `Focus on upside, growth, and competitive advantages — even with elevated risk.`,
    `Respond directly to the conservative and neutral analysts: highlight where their caution misses critical opportunities or their assumptions are overly conservative.`,
    ``,
    `Trade plan: ${input.tradePlan}`,
    ``,
    `Analyst context: ${input.analystContext}`,
    ``,
    `Conservative analyst last argument: ${conservative || '(has not spoken yet)'}`,
    ``,
    `Neutral analyst last argument: ${neutral || '(has not spoken yet)'}`,
    ``,
    `Engage conversationally — refute their weaknesses, assert value of risk-taking.`,
  ].join('\n');
}

export function buildNeutralPrompt(input: RiskStanceInput, aggressive: string, conservative: string): string {
  return [
    `As the Neutral Risk Analyst, provide a balanced perspective on the ${input.symbol} trade plan.`,
    `Weigh both benefits and risks, factoring broader market trends, economic shifts, and diversification.`,
    `Acknowledge each side and give a fair intermediate view.`,
    ``,
    `Trade plan: ${input.tradePlan}`,
    ``,
    `Analyst context: ${input.analystContext}`,
    ``,
    `Aggressive analyst last argument: ${aggressive || '(has not spoken yet)'}`,
    ``,
    `Conservative analyst last argument: ${conservative || '(has not spoken yet)'}`,
    ``,
    `Engage conversationally — integrate both extremes into a balanced stance.`,
  ].join('\n');
}

export function buildConservativePrompt(input: RiskStanceInput, aggressive: string, neutral: string): string {
  return [
    `As the Conservative Risk Analyst, protect assets and minimize volatility while evaluating the ${input.symbol} trade plan.`,
    `Focus on stability, security, and risk mitigation — assess losses, downturns, market volatility.`,
    `Actively counter the aggressive and neutral analysts: question their optimism, emphasize downside they overlook, argue for a low-risk adjustment.`,
    ``,
    `Trade plan: ${input.tradePlan}`,
    ``,
    `Analyst context: ${input.analystContext}`,
    ``,
    `Aggressive analyst last argument: ${aggressive || '(has not spoken yet)'}`,
    ``,
    `Neutral analyst last argument: ${neutral || '(has not spoken yet)'}`,
    ``,
    `Engage conversationally — critique their optimism and highlight overlooked threats.`,
  ].join('\n');
}

/** 三 stance 輪流互駁, rounds 次; 任何失敗 → 保留已成功回合(唔 crash 主流程) */
export async function runRiskStanceDebate(
  llm: LLMCall,
  input: RiskStanceInput,
  rounds: number = RISK_STANCE_DEFAULT_ROUNDS,
  timeoutMs: number = 30_000,
): Promise<RiskStanceResult> {
  const safeRounds = Number.isInteger(rounds)
    ? Math.min(Math.max(rounds, 1), RISK_STANCE_MAX_ROUNDS)
    : RISK_STANCE_DEFAULT_ROUNDS;

  let aggressive = '';
  let neutral = '';
  let conservative = '';
  let history = '';

  for (let r = 0; r < safeRounds; r++) {
    const step = async (label: 'aggressive' | 'conservative' | 'neutral', prompt: string) => {
      try {
        const text = typeof (await withTimeout(llm(prompt, ''), timeoutMs)) === 'string'
          ? String((await withTimeout(llm(prompt, ''), timeoutMs)))
          : '';
        if (!text) return '';
        const tagged = `${label === 'aggressive' ? 'Aggressive' : label === 'conservative' ? 'Conservative' : 'Neutral'} Analyst: ${text}`;
        history = history ? `${history}\n${tagged}` : tagged;
        return text;
      } catch { return ''; }
    };

    const a = await step('aggressive', buildAggressivePrompt(input, conservative, neutral));
    if (a) aggressive = a;
    const c = await step('conservative', buildConservativePrompt(input, aggressive, neutral));
    if (c) conservative = c;
    const n = await step('neutral', buildNeutralPrompt(input, aggressive, conservative));
    if (n) neutral = n;
  }

  // 分歧判定: 三 stance 各自明確立場(有 keyword 買/賣/持倉), 唔一致 = disagreement
  const has = (s: string, kws: string[]) => s && kws.some(k => new RegExp(k, 'i').test(s));
  const aDir = has(aggressive, ['buy', 'long', 'upside', 'enter']) ? 'bull'
    : has(aggressive, ['avoid', 'sell', 'short', 'downside', 'reduce']) ? 'bear' : 'neutral';
  const cDir = has(conservative, ['avoid', 'sell', 'reduce', 'risk', 'protect']) ? 'bear'
    : has(conservative, ['buy', 'long', 'enter']) ? 'bull' : 'neutral';
  const nDir = has(neutral, ['buy', 'long', 'upside']) ? 'bull'
    : has(neutral, ['sell', 'short', 'downside']) ? 'bear' : 'neutral';
  const disagreement = (aDir !== cDir || cDir !== nDir) && (aDir !== 'neutral' || cDir !== 'neutral' || nDir !== 'neutral');

  return { aggressive, neutral, conservative, history, disagreement };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('risk-stance timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export const RiskStanceResultSchema = z.object({
  aggressive: z.string(),
  neutral: z.string(),
  conservative: z.string(),
  history: z.string(),
  disagreement: z.boolean(),
});
