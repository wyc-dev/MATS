import { describe, it, expect } from 'vitest';
import { mapRatingToAction, ratingSizeMultiplier, buildConflictNotHoldClause } from '../src/cognition/rating.ts';
import { opponentMarker, buildBullPrompt, buildBearPrompt, runAdversarialDebate } from '../src/cognition/adversarial-debate.ts';
import { buildAggressivePrompt, runRiskStanceDebate } from '../src/cognition/risk-stance.ts';

describe('rating.ts (5-tier mapping)', () => {
  it('Buy/Overweight→buy, Hold→hold, Underweight/Sell→sell, size 細粒度', () => {
    expect(mapRatingToAction('Buy')).toEqual({ action: 'buy', sizeMult: 1.0 });
    expect(mapRatingToAction('Overweight')).toEqual({ action: 'buy', sizeMult: 0.6 });
    expect(mapRatingToAction('Hold')).toEqual({ action: 'hold', sizeMult: 1.0 });
    expect(mapRatingToAction('Underweight')).toEqual({ action: 'sell', sizeMult: 0.6 });
    expect(mapRatingToAction('Sell')).toEqual({ action: 'sell', sizeMult: 1.0 });
  });
  it('垃圾 rating → 保守 hold(唔 crash, 唔誤導)', () => {
    expect(mapRatingToAction('banana').action).toBe('hold');
    expect(mapRatingToAction(null).action).toBe('hold');
    expect(mapRatingToAction(undefined).action).toBe('hold');
    expect(mapRatingToAction(42 as never).action).toBe('hold');
    expect(mapRatingToAction({} as never).action).toBe('hold');
  });
  it('ratingSizeMultiplier: fallback × sizeMult, 垃圾 fallback → mult 乾淨', () => {
    expect(ratingSizeMultiplier('Overweight', 0.5)).toBeCloseTo(0.3, 5);
    expect(ratingSizeMultiplier('Buy', 0.5)).toBeCloseTo(0.5, 5);
    expect(ratingSizeMultiplier('Hold', NaN)).toBe(1.0);
    expect(ratingSizeMultiplier('Underweight', 2.0)).toBeCloseTo(1.0, 5); // clamp ≤1
    expect(ratingSizeMultiplier('Sell', 0)).toBe(1.0); // fallback 0 → 唔視為合理 → 用 rating 本身乘數
  });
  it('ConflictNotHold clause 有 commit 紀律 + hold 唔係避難所', () => {
    const c = buildConflictNotHoldClause();
    expect(c).toContain('conflict alone is not a reason to HOLD');
    expect(c.toLowerCase()).toContain('commit');
    expect(c.toLowerCase()).toContain('stronger');
  });
});

describe('adversarial-debate.ts (Bull/Bear 對抗)', () => {
  const input = { symbol: 'BTC', analystContext: 'range-bound, +6% pre-news pump' };
  it('opponentMarker: 首輪唔叫模型反駁空氣', () => {
    expect(opponentMarker('bear')).toContain('Bear analyst has not spoken yet');
    expect(opponentMarker('bull')).toContain('Bull analyst has not spoken yet');
  });
  it('Bull prompt 含反駁指令 + Bear prompt 含暴露 over-optimism', () => {
    const b = buildBullPrompt(input, 'the bear said distribution', 'hist');
    expect(b.toLowerCase()).toContain('refute');
    expect(b.toLowerCase()).toContain('last bear argument');
    const k = buildBearPrompt(input, 'bull said breakout', 'hist');
    expect(k.toLowerCase()).toContain('over-optimistic');
    expect(k.toLowerCase()).toContain('last bull argument');
  });
  it('runAdversarialDebate: 正常 LLM → bull/bear/history 有內容', async () => {
    const r = await runAdversarialDebate(
      async (s, u) => s.includes('Bull Analyst') ? 'BULL CASE' : 'BEAR CASE',
      input,
    );
    expect(r.bullRationale).toContain('BULL CASE');
    expect(r.bearRationale).toContain('BEAR CASE');
    expect(r.history).toContain('Bull:').and.toContain('Bear:');
    expect(r.turns.length).toBe(2);
  });
  it('LLM 失敗 → 返回空(唔 crash, 唔影響主流程)', async () => {
    const r = await runAdversarialDebate(async () => { throw new Error('LLM down'); }, input);
    expect(r.bullRationale).toBe('');
    expect(r.bearRationale).toBe('');
    expect(r.history).toBe('');
  });
  it('rounds clamp: 負數/垃圾/超大 → 1~3', async () => {
    const r = await runAdversarialDebate(async () => 'x', input, -5);
    expect(r.turns.length).toBe(2); // rounds clamp 1 → 2 turns
    await expect(runAdversarialDebate(async () => { throw new Error('t'); }, input, 999)).resolves.toBeDefined();
  });
});

describe('risk-stance.ts (三 stance 互駁)', () => {
  const input = { symbol: 'BTC', tradePlan: 'BUY BTC $81k', analystContext: 'context' };
  it('Aggressive prompt 要求反駁保守/中立', () => {
    const p = buildAggressivePrompt(input, 'conservative said risk', 'neutral said balanced');
    expect(p.toLowerCase()).toContain('conservative analyst last argument');
    expect(p.toLowerCase()).toContain('neutral analyst last argument');
    expect(p.toLowerCase()).toContain('overly conservative');
  });
  it('runRiskStanceDebate: 正常 LLM → 三票 + disagreement', async () => {
    const r = await runRiskStanceDebate(
      async (s) => s.startsWith('As the Aggressive Risk Analyst')
        ? 'aggressive: buy upside'
        : s.startsWith('As the Conservative Risk Analyst') ? 'conservative: protect reduce risk' : 'neutral: hold balanced',
      input,
    );
    expect(r.aggressive).toContain('buy');
    expect(r.conservative.toLowerCase()).toContain('risk');
    expect(r.disagreement).toBe(true); // bullish vs bearish vs neutral → 分歧
  });
  it('LLM 失敗 → 返回空(唔 crash)', async () => {
    const r = await runRiskStanceDebate(async () => { throw new Error('down'); }, input);
    expect(r.history).toBe('');
    expect(r.disagreement).toBe(false);
  });
});
