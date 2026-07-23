// ─── v2.0.211 refined fix: system-decision close handling ───
//
// Two independent bugs were conflated in the first fix attempt. The data
// revealed 16 thesis_invalidation+WIN records, 9 of which have SUBSTANTIAL
// profit (max $1.95 / +2.04%) — NOT the $0.004 noise the audit literally
// flagged. Relabelling ALL invalidation → LOSS would corrupt those real
// profits and make the conditional WR falsely report profitable conditions
// as losing. The refined fix:
//
// Fix 1 (computeLearningWeight): system-decision closes (thesis_invalidation,
//   manual, consensus) get their learning discount REGARDLESS of isWin.
//   Before, `if (isWin) return 1.0` short-circuited and the v2.0.226 0.3
//   discount never applied to profitable invalidations — a $1.95 system
//   force-close was learned at full weight as if the market confirmed it.
//
// Fix 2 (conditional WR exclusion): thesis_invalidation records are EXCLUDED
//   from computeVectorConditionalWinRate's pool (opt-in via excludeExitTypes),
//   so the market-conditional WR reflects only clean market-risk closes
//   (SL/TP). Consistent with the conviction-gate exclusion at index.ts
//   (~'closeReason !== thesis_invalidation'). The $0.004 noise no longer
//   inflates the WR, AND the $1.95 real profit is not falsely counted as LOSS.
//
// The `outcome` FIELD stays pnl-based (economic reality). No JSONL migration
// is needed — exclusion is read-time, so historical records are handled
// automatically the moment the code ships.

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  ThesisExperience,
  type ExpLLMCaller,
  type ExpLLMMessage,
} from '../src/evolution/thesis-experience.ts';
import { computeVectorConditionalWinRate, entryDecisionCondWROptions, SYSTEM_DECISION_EXIT_TYPES } from '../src/evolution/evolution-utils.ts';
import { computeLearningWeight } from '../src/evolution/learning-weight.ts';
import { MockEmbedProvider } from '../src/evolution/embeddings.ts';

// computeLearningWeight is the real extracted function — no local re-derivation.

const TMP = join(os.tmpdir(), `exp-refined-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
mkdirSync(TMP, { recursive: true });

function paths() {
  return { jsonlPath: join(TMP, 't.jsonl'), expMdPath: join(TMP, 'E.md'), incidentsPath: join(TMP, 'i.jsonl') };
}

const extractHandler = (msgs: ExpLLMMessage[]): string => {
  const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
  const user = msgs.find((m) => m.role === 'user')?.content ?? '';
  if (sys.includes('atomic rationales')) {
    const m = user.match(/Thesis:\s*"([^"]*)"/);
    const thesis = m?.[1] ?? 'test';
    const points = thesis.split('|').map((s) => s.trim()).filter(Boolean);
    return JSON.stringify({ rationales: points.length ? points.map((p) => ({ point: p, category: 'technical' as const })) : [{ point: 'fallback', category: 'other' as const }] });
  }
  return JSON.stringify({ rationales: [{ point: 'fallback', category: 'other' as const }] });
};

function makeEXP(embed: MockEmbedProvider) {
  return new ThesisExperience({
    embed,
    llm: { async chat(m: ExpLLMMessage[]) { return extractHandler(m); } },
    directionAllowed: () => true,
    cfg: {
      enabled: true, embedDim: 384, maxRecords: 1000, matchThreshold: 0.55,
      winProbThreshold: 0.6, lossProbThreshold: 0.4, deltaThreshold: 0.55,
      minDeltaSamples: 2, deltaWinRateThreshold: 0.6, deltaLossRateThreshold: 0.4,
      allowReverse: true, breakevenIs: 'win', similarityMode: 'asymmetric',
      repair: { enabled: false, maxRetries: 1, backoffMs: 1 },
      assetCategoryMap: { BTC: 'crypto' },
    },
  } as never);
}

const FEATS = { volatility: 0.012, obImbalance: 0.1, fundingRate: 0.0001, srDistanceBps: 50, sentiment: 0.2, volumeRatio: 1.1 };

describe('computeLearningWeight — system-decision discount before isWin short-circuit', () => {
  it('thesis_invalidation + isWin=true → 0.3 (was 1.0 — the real bug)', () => {
    // A $1.95 system force-close is NOT a clean market signal. Before the fix,
    // `if (isWin) return 1.0` ran first and the 0.3 discount never applied.
    expect(computeLearningWeight('thesis_invalidation', false, true)).toBe(0.3);
  });
  it('thesis_invalidation + isWin=false → 0.3 (unchanged)', () => {
    expect(computeLearningWeight('thesis_invalidation', false, false)).toBe(0.3);
  });
  it('manual + isWin=true → 0.5 (discount applies to profitable manual closes too)', () => {
    expect(computeLearningWeight('manual', false, true)).toBe(0.5);
  });
  it('consensus + isWin=true → 0.5', () => {
    expect(computeLearningWeight('consensus', false, true)).toBe(0.5);
  });
  it('sl_tp + isWin=true → 1.0 (clean market win, full weight — unchanged)', () => {
    expect(computeLearningWeight('sl_tp', false, true)).toBe(1.0);
  });
  it('sl_tp + isWin=false + slNarrowed → 0.3 (execution loss — unchanged)', () => {
    expect(computeLearningWeight('sl_tp', true, false)).toBe(0.3);
  });
  it('sl_tp + isWin=false + not narrowed → 1.0 (genuine market loss — unchanged)', () => {
    expect(computeLearningWeight('sl_tp', false, false)).toBe(1.0);
  });
  it('reconciliation + isWin=true → 1.0', () => {
    expect(computeLearningWeight('reconciliation', false, true)).toBe(1.0);
  });
});

describe('conditional WR exclusion — thesis_invalidation removed from market-conditional pool', () => {
  afterEach(() => { rmSync(join(TMP, 't.jsonl'), { force: true }); rmSync(join(TMP, 'E.md'), { force: true }); });

  it('excludes thesis_invalidation records (noise $0.004 AND real $1.95 profit both excluded)', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed);

    // 4 thesis_invalidation closes: mix of noise ($0.004, the audit's $0.00
    // case) and real profit ($1.95). Both are system force-closes, NOT clean
    // market SL/TP outcomes — both must be excluded from conditional WR.
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: 0.004, pnlPct: 0.00004, entry: 100, exit: 100.0004, leverage: 1, holdMin: 8,
      regime: 'low_volatility', entryThesis: '[1h: noise invalidation]',
      exitType: 'thesis_invalidation', marketFeatures: FEATS });
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: 1.9547, pnlPct: 0.0204, entry: 100, exit: 102.04, leverage: 1, holdMin: 59,
      regime: 'low_volatility', entryThesis: '[1h: profitable invalidation]',
      exitType: 'thesis_invalidation', marketFeatures: FEATS });

    // 1 genuine market SL loss + 2 genuine market TP wins (clean market outcomes).
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: -1.2, pnlPct: -0.012, entry: 100, exit: 98.8, leverage: 1, holdMin: 12,
      regime: 'low_volatility', entryThesis: '[1h: market loss]',
      exitType: 'correct_sl', marketFeatures: FEATS });
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: 0.8, pnlPct: 0.008, entry: 100, exit: 100.8, leverage: 1, holdMin: 40,
      regime: 'low_volatility', entryThesis: '[1h: market win 1]',
      exitType: 'correct_tp', marketFeatures: FEATS });
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: 0.6, pnlPct: 0.006, entry: 100, exit: 100.6, leverage: 1, holdMin: 35,
      regime: 'low_volatility', entryThesis: '[1h: market win 2]',
      exitType: 'correct_tp', marketFeatures: FEATS });

    const records = exp.getRecords();
    expect(records.length).toBe(5);

    // outcome field preserves economic reality: invalidation+profit stays WIN.
    const inv = records.filter((r) => r.exitType === 'thesis_invalidation').map((r) => r.outcome);
    expect(inv).toEqual(['WIN', 'WIN']); // $0.004 AND $1.95 both WIN — NOT relabeled

    // WITHOUT exclusion: 4 wins / 5 = 80% (the $1.95 + $0.004 + 2 TP wins all count).
    const withoutExcl = computeVectorConditionalWinRate(FEATS, records, { side: 'buy', minSamples: 3, threshold: 0.70, topN: 20 });
    expect(withoutExcl.sampleSize).toBe(5);
    expect(withoutExcl.conditionalWinRate).toBe(0.8); // polluted (the bug)

    // WITH exclusion: invalidation records removed → 2 wins / 3 = 67% clean market WR.
    const withExcl = computeVectorConditionalWinRate(FEATS, records, { side: 'buy', minSamples: 3, threshold: 0.70, topN: 20, excludeExitTypes: ['thesis_invalidation'] });
    expect(withExcl.sampleSize).toBe(3); // only the 3 clean market closes
    expect(withExcl.wins).toBe(2);
    expect(withExcl.losses).toBe(1);
    expect(withExcl.conditionalWinRate).toBeCloseTo(2 / 3, 6);
  });

  it('exclusion is opt-in — callers without excludeExitTypes keep current behavior', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed);
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: 1.95, pnlPct: 0.0195, entry: 100, exit: 101.95, leverage: 1, holdMin: 59,
      regime: 'low_volatility', entryThesis: '[1h: profitable invalidation]',
      exitType: 'thesis_invalidation', marketFeatures: FEATS });
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: -1.0, pnlPct: -0.01, entry: 100, exit: 99, leverage: 1, holdMin: 12,
      regime: 'low_volatility', entryThesis: '[1h: market loss]',
      exitType: 'correct_sl', marketFeatures: FEATS });
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
      pnl: 0.5, pnlPct: 0.005, entry: 100, exit: 100.5, leverage: 1, holdMin: 40,
      regime: 'low_volatility', entryThesis: '[1h: market win]',
      exitType: 'correct_tp', marketFeatures: FEATS });

    const records = exp.getRecords();
    // No excludeExitTypes → invalidation included (backward compatible).
    const result = computeVectorConditionalWinRate(FEATS, records, { side: 'buy', minSamples: 3, threshold: 0.70, topN: 20 });
    expect(result.sampleSize).toBe(3); // invalidation still counted
  });
});

describe('outcome field — economic reality preserved (no relabel)', () => {
  afterEach(() => { rmSync(join(TMP, 't.jsonl'), { force: true }); rmSync(join(TMP, 'E.md'), { force: true }); });

  it('thesis_invalidation + $1.95 profit → outcome=WIN (NOT relabeled to LOSS)', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed);
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: 1.95, pnlPct: 0.0195, entry: 100, exit: 101.95, leverage: 1, holdMin: 59,
      regime: 'low_volatility', entryThesis: '[1h: thesis]',
      exitType: 'thesis_invalidation' });
    expect(exp._records()[0]!.outcome).toBe('WIN'); // real profit stays WIN
  });

  it('thesis_invalidation + $0.004 noise → outcome=WIN (label correct; pollution solved by exclusion not relabel)', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed);
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: 0.004, pnlPct: 0.00004, entry: 100, exit: 100.0004, leverage: 1, holdMin: 8,
      regime: 'low_volatility', entryThesis: '[1h: thesis]',
      exitType: 'thesis_invalidation' });
    expect(exp._records()[0]!.outcome).toBe('WIN'); // pnl>0 → WIN, factually correct
  });

  it('thesis_invalidation + negative pnl → outcome=LOSS (unchanged)', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed);
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: -2, pnlPct: -0.02, entry: 100, exit: 98, leverage: 1, holdMin: 10,
      regime: 'unknown', entryThesis: '[1h: thesis]',
      exitType: 'thesis_invalidation' });
    expect(exp._records()[0]!.outcome).toBe('LOSS');
  });

  it('normal tiny positive pnl → WIN (unchanged, no scope creep)', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed);
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: 0.004, pnlPct: 0.00004, entry: 100, exit: 100.0004, leverage: 1, holdMin: 10,
      regime: 'trending_bull', entryThesis: '[1h: thesis]',
      exitType: 'correct_tp' });
    expect(exp._records()[0]!.outcome).toBe('WIN');
  });

  it('normal breakeven pnl=0 (breakevenIs=win) → WIN (unchanged, no scope creep)', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed);
    await exp.recordClose({ symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: 0, pnlPct: 0, entry: 100, exit: 100, leverage: 1, holdMin: 10,
      regime: 'unknown', entryThesis: '[1h: thesis]',
      exitType: 'consensus' });
    expect(exp._records()[0]!.outcome).toBe('WIN');
  });
});
describe('entryDecisionCondWROptions — shared entry-decision contract', () => {
  it('SYSTEM_DECISION_EXIT_TYPES = thesis_invalidation', () => {
    expect([...SYSTEM_DECISION_EXIT_TYPES]).toEqual(['thesis_invalidation']);
  });

  it('helper always includes the system-close exclusion', () => {
    const opts = entryDecisionCondWROptions('buy', undefined);
    expect(opts.excludeExitTypes).toEqual(['thesis_invalidation']);
    expect(opts.side).toBe('buy');
    expect(opts.minSamples).toBe(3);
    expect(opts.threshold).toBe(0.75);
    expect(opts.topN).toBe(20);
  });

  it('overrides win over defaults but NEVER drop the exclusion', () => {
    const opts = entryDecisionCondWROptions('sell', undefined,
      { minSamples: 5, threshold: 0.80, rmsNormKeys: true, softmaxWeightedWR: true });
    expect(opts.minSamples).toBe(5);
    expect(opts.threshold).toBe(0.80);
    expect(opts.rmsNormKeys).toBe(true);
    expect(opts.softmaxWeightedWR).toBe(true);
    expect(opts.excludeExitTypes).toEqual(['thesis_invalidation']);
  });

  it('helper output is consumable by computeVectorConditionalWinRate (excludes invalidation)', () => {
    const FEATS = { volatility: 0.01, obImbalance: 0.1, fundingRate: 0, srDistanceBps: 50, sentiment: 0, volumeRatio: 1 };
    const records = [
      { marketFeatures: FEATS, outcome: 'WIN', symbol: 'BTC', side: 'buy' as const, exitType: 'thesis_invalidation' },
      { marketFeatures: FEATS, outcome: 'WIN', symbol: 'BTC', side: 'buy' as const, exitType: 'correct_tp' },
      { marketFeatures: FEATS, outcome: 'LOSS', symbol: 'BTC', side: 'buy' as const, exitType: 'correct_sl' },
    ];
    const opts = entryDecisionCondWROptions('buy', undefined, { threshold: 0.70 });
    const result = computeVectorConditionalWinRate(FEATS, records, opts);
    expect(result.sampleSize).toBe(2);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
  });
});
