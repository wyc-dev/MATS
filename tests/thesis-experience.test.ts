import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  ThesisExperience,
  type ExpLLMCaller,
  type ExpLLMMessage,
  assetCategory,
} from '../src/evolution/thesis-experience.ts';
import {
  MockEmbedProvider,
  TransformersEmbedProvider,
  cosine,
  combinationSimilarity,
  combinationSimilarityAsymmetric,
} from '../src/evolution/embeddings.ts';
import type {
  ThesisExperienceRecord,
  RationaleCategory,
  AssetCategory,
} from '../src/types/index.ts';

// ─── Test helpers ───

const TMP = join(os.tmpdir(), `exp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
mkdirSync(TMP, { recursive: true });

function paths() {
  return {
    jsonlPath: join(TMP, 'trades.jsonl'),
    expMdPath: join(TMP, 'EXP.md'),
    incidentsPath: join(TMP, 'incidents.jsonl'),
  };
}

/** Mock LLM that dispatches on system-prompt keywords. */
function makeLLM(handler: (msgs: ExpLLMMessage[]) => string): ExpLLMCaller {
  return {
    async chat(msgs: ExpLLMMessage[]): Promise<string> {
      return handler(msgs);
    },
  };
}

/** Default extract-rationales handler: echoes back the thesis as a single rationale,
 *  OR returns a configured list when the user content tags rationales with |. */
function extractHandler(msgs: ExpLLMMessage[]): string {
  const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
  const user = msgs.find((m) => m.role === 'user')?.content ?? '';
  if (sys.includes('atomic rationales')) {
    // Parse "Thesis: "<th>"" — if thesis contains " | " split into multiple rationales
    const m = user.match(/Thesis:\s*"([^"]*)"/);
    const thesis = m?.[1] ?? 'test';
    const points = thesis.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
    const cats: RationaleCategory[] = ['technical', 'fundamental', 'flow', 'sentiment', 'macro', 'news', 'pattern', 'other'];
    const rationales = points.map((p, i) => ({ point: p, category: cats[i % cats.length] ?? 'other' }));
    return JSON.stringify({ rationales });
  }
  return JSON.stringify({ rationales: [{ point: 'fallback', category: 'other' }] });
}

/** Build a ThesisExperience with a 384-dim mock embed + handler-driven LLM. */
function makeEXP(
  embed: MockEmbedProvider,
  llm: ExpLLMCaller,
  cfgOverrides: Record<string, unknown> = {},
  directionAllowed: (s: string, side: 'buy' | 'sell') => boolean = () => true,
): ThesisExperience {
  const p = paths();
  return new ThesisExperience({
    embed,
    llm,
    directionAllowed,
    cfg: {
      enabled: true,
      embedDim: 384,
      maxRecords: 200,
      matchThreshold: 0.55,
      winProbThreshold: 0.6,
      lossProbThreshold: 0.4,
      deltaThreshold: 0.55,
      minDeltaSamples: 2,
      deltaWinRateThreshold: 0.6,
      deltaLossRateThreshold: 0.4,
      allowReverse: true,
      breakevenIs: 'exclude',
      similarityMode: 'asymmetric',
      repair: { enabled: false, maxRetries: 1, backoffMs: 1 },
      assetCategoryMap: { BTC: 'crypto', 'xyz:MU': 'equity', 'xyz:SILVER': 'commodity', XAU: 'commodity' },
      ...p,
      ...cfgOverrides,
    } as unknown as Record<string, unknown>,
  } as never);
}

/** Inject a historical record with given rationales (vectors must be pre-planted on embed). */
function injectRecord(
  exp: ThesisExperience,
  embed: MockEmbedProvider,
  opts: {
    rationales: string[];
    outcome: 'WIN' | 'LOSS';
    symbol?: string;
    assetCategory?: AssetCategory;
    side?: 'buy' | 'sell';
  },
): void {
  const vecs = opts.rationales.map((r) => embed.vectorFor(r));
  const rec: ThesisExperienceRecord = {
    id: `rec-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    symbol: opts.symbol ?? 'BTC',
    side: opts.side ?? 'buy',
    source: 'paper',
    decisionOrigin: 'meta-agent',
    outcome: opts.outcome,
    pnl: opts.outcome === 'WIN' ? 1 : -1,
    pnlPct: opts.outcome === 'WIN' ? 0.05 : -0.05,
    entry: 100,
    exit: 101,
    leverage: 1,
    holdMin: 10,
    regime: 'unknown',
    assetCategory: opts.assetCategory ?? assetCategory(opts.symbol ?? 'BTC', { BTC: 'crypto' }),
    entryThesis: opts.rationales.join(' | '),
    rationales: opts.rationales,
    rationaleCats: opts.rationales.map(() => 'technical' as RationaleCategory),
    rationaleVectors: vecs,
  };
  exp._injectRecord(rec);
}

// ─── Vector scaffolding ───
// Plant unit-ish vectors in 384-dim; only first 3 dims used for controlled cosine.
function plant(embed: MockEmbedProvider, name: string, vec: number[]): void {
  const full = new Array(384).fill(0);
  for (let i = 0; i < vec.length && i < 384; i++) full[i] = vec[i]!;
  embed.setVector(name, full); // normalises
}

describe('EXP embeddings — vector math', () => {
  const embed = new MockEmbedProvider(384);
  plant(embed, 'B', [1, 0, 0]);
  plant(embed, 'C', [0, 1, 0]);
  plant(embed, 'Y', [0, 0, 1]);
  plant(embed, 'Z', [0, 0.05, 0.99]); // ≈Y, far from C
  plant(embed, 'Zprime', [0.05, 0.99, 0]); // ≈C, far from Y

  it('cosine of orthogonal vectors ≈ 0, identical ≈ 1', () => {
    const B = embed.vectorFor('B');
    const C = embed.vectorFor('C');
    expect(cosine(B, B)).toBeCloseTo(1, 5);
    expect(cosine(B, C)).toBeCloseTo(0, 5);
  });

  it('combinationSimilarity asymmetric matches the B+Z worked example shape', () => {
    const B = embed.vectorFor('B');
    const C = embed.vectorFor('C');
    const Y = embed.vectorFor('Y');
    const Z = embed.vectorFor('Z');
    // B+Z vs B+C = (cos(B,B)=1 + cos(Z,C))/2
    const vsC = combinationSimilarityAsymmetric([B, Z], [B, C]);
    expect(vsC).toBeCloseTo((1 + cosine(Z, C)) / 2, 4);
    // B+Z vs B+Y = (1 + cos(Z,Y))/2 — should be high (Z≈Y)
    const vsY = combinationSimilarityAsymmetric([B, Z], [B, Y]);
    expect(vsY).toBeGreaterThan(vsC);
    expect(vsY).toBeCloseTo((1 + cosine(Z, Y)) / 2, 4);
  });

  it('combinationSimilarity symmetric averages both directions', () => {
    const B = embed.vectorFor('B');
    const Y = embed.vectorFor('Y');
    const s = combinationSimilarity([B], [B, Y], 'symmetric');
    const fwd = combinationSimilarityAsymmetric([B], [B, Y]);
    const bwd = combinationSimilarityAsymmetric([B, Y], [B]);
    expect(s).toBeCloseTo((fwd + bwd) / 2, 5);
  });
});

describe('EXP recordClose — write path', () => {
  afterEach(() => { rmSync(join(TMP, 'trades.jsonl'), { force: true }); rmSync(join(TMP, 'EXP.md'), { force: true }); });

  it('records a WIN trade and renders EXP.md', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed, makeLLM(extractHandler));
    await exp.recordClose({
      symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: 5, pnlPct: 0.05, entry: 100, exit: 105, leverage: 1, holdMin: 10, regime: 'trending_bull',
      entryThesis: '[1h: breakout above 100] [1d: AI capex tailwind]',
    });
    expect(exp.size()).toBe(1);
    const rec = exp._records()[0]!;
    expect(rec.outcome).toBe('WIN');
    expect(rec.assetCategory).toBe('crypto');
    expect(rec.rationales.length).toBeGreaterThan(0);
    expect(existsSync(join(TMP, 'EXP.md'))).toBe(true);
  });

  it('excludes breakeven PnL=0 when breakevenIs=exclude', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed, makeLLM(extractHandler));
    await exp.recordClose({
      symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: 0, pnlPct: 0, entry: 100, exit: 100, leverage: 1, holdMin: 10, regime: 'unknown',
      entryThesis: '[1h: test]',
    });
    expect(exp.size()).toBe(0);
  });

  it('skips placeholder thesis (N/A / empty)', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed, makeLLM(extractHandler));
    await exp.recordClose({
      symbol: 'BTC', side: 'buy', source: 'real', decisionOrigin: 'meta-agent',
      pnl: 5, pnlPct: 0.05, entry: 100, exit: 105, leverage: 1, holdMin: 10, regime: 'unknown',
      entryThesis: 'N/A',
    });
    expect(exp.size()).toBe(0);
  });

  it('rolls over at maxRecords cap', async () => {
    const embed = new MockEmbedProvider(384);
    const exp = makeEXP(embed, makeLLM(extractHandler), { maxRecords: 3 });
    for (let i = 0; i < 5; i++) {
      await exp.recordClose({
        symbol: 'BTC', side: 'buy', source: 'paper', decisionOrigin: 'meta-agent',
        pnl: 1, pnlPct: 0.01, entry: 100, exit: 101, leverage: 1, holdMin: 1, regime: 'unknown',
        entryThesis: `[1h: reason ${i}]`,
      });
    }
    expect(exp.size()).toBe(3);
  });
});

describe('EXP checkThesisHistory — decision branches', () => {
  let embed: MockEmbedProvider;
  let exp: ThesisExperience;

  beforeEach(() => {
    embed = new MockEmbedProvider(384);
    plant(embed, 'B', [1, 0, 0]);
    plant(embed, 'C', [0, 1, 0]);
    plant(embed, 'Y', [0, 0, 1]);
    plant(embed, 'Z', [0, 0.05, 0.99]);   // ≈Y
    plant(embed, 'Zprime', [0.05, 0.99, 0]); // ≈C
    plant(embed, 'D',  [0, 0.3, 0.95, 0, 0, 0]);  // delta: cos(D,B)=0, cos(D,C)≈0.30 (combo matches B+C via B)
    plant(embed, 'F1', [0, 0, 0, 1, 0, 0]);        // combo partners far from B so D-history records don't match candidate
    plant(embed, 'F2', [0, 0, 0, 0.6, 0.8, 0]);
    plant(embed, 'V', [0, 0.2, 0.98]);   // negative delta: cos(V,B)=0, cos(V,C)≈0.2 (delta; combo matches via B)
    exp = makeEXP(embed, makeLLM(extractHandler));
  });

  it('EXP_DISABLED when enabled=false', async () => {
    const e = makeEXP(embed, makeLLM(extractHandler), { enabled: false });
    const r = await e.checkThesisHistory({ thesis: 'B|Z', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('EXP_DISABLED');
  });

  it('PASS_OPEN_DIRECTLY when memory is empty', async () => {
    const r = await exp.checkThesisHistory({ thesis: 'B|Z', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('PASS_OPEN_DIRECTLY');
  });

  it('FAST_APPROVE when history skews WIN (B+Z ≈ B+Y WIN)', async () => {
    injectRecord(exp, embed, { rationales: ['B', 'Y'], outcome: 'WIN' });
    const r = await exp.checkThesisHistory({ thesis: 'B|Z', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('FAST_APPROVE');
    expect(r.pWin).toBeGreaterThan(0.6);
  });

  it('REJECT when matching a losing combo with no delta (B+Zprime ≈ B+C LOSS, Zprime≈C)', async () => {
    injectRecord(exp, embed, { rationales: ['B', 'C'], outcome: 'LOSS' });
    const r = await exp.checkThesisHistory({ thesis: 'B|Zprime', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('REJECT');
  });

  it('PASS_OPEN_DIRECTLY when delta rationale has no history', async () => {
    // Candidate B+D; losing combo B+C matches via B (cos(D,C)≈0.30 → combSim 0.65 ≥ 0.55)
    injectRecord(exp, embed, { rationales: ['B', 'C'], outcome: 'LOSS' });
    // D has no other records → no history → 直出
    const r = await exp.checkThesisHistory({ thesis: 'B|D', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('PASS_OPEN_DIRECTLY');
  });

  it('APPROVE_WITH_NOTE when delta has same-category positive history', async () => {
    injectRecord(exp, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC' });
    // Two WIN records containing D in crypto → winRateSame = 1.0
    injectRecord(exp, embed, { rationales: ['D', 'F1'], outcome: 'WIN', symbol: 'BTC' });
    injectRecord(exp, embed, { rationales: ['D', 'F2'], outcome: 'WIN', symbol: 'BTC' });
    const r = await exp.checkThesisHistory({ thesis: 'B|D', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('APPROVE_WITH_NOTE');
    expect(r.extraRationale).toBeDefined();
  });

  it('REJECT when cross-category positive delta finds no extra rationale', async () => {
    // Losing combo in crypto
    injectRecord(exp, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    // D's positive history only in commodity (XAU) → cross-category
    injectRecord(exp, embed, { rationales: ['D', 'F1'], outcome: 'WIN', symbol: 'XAU', assetCategory: 'commodity' });
    injectRecord(exp, embed, { rationales: ['D', 'F2'], outcome: 'WIN', symbol: 'XAU', assetCategory: 'commodity' });
    // Candidate on BTC (crypto) → D's wins are commodity → cross-cat → require one more
    const llm = makeLLM((msgs) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('atomic rationales')) return JSON.stringify({ rationales: [{ point: 'B', category: 'technical' }, { point: 'D', category: 'flow' }] });
      if (sys.includes('cross-asset-category')) return JSON.stringify({ found: false, rationale: 'no extra', point: '' });
      return JSON.stringify({});
    });
    const e2 = makeEXP(embed, llm);
    injectRecord(e2, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    injectRecord(e2, embed, { rationales: ['D', 'F1'], outcome: 'WIN', symbol: 'XAU', assetCategory: 'commodity' });
    injectRecord(e2, embed, { rationales: ['D', 'F2'], outcome: 'WIN', symbol: 'XAU', assetCategory: 'commodity' });
    const r = await e2.checkThesisHistory({ thesis: 'B|D', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('REJECT');
  });

  it('APPROVE_WITH_NOTE when cross-category positive delta finds an extra rationale', async () => {
    const llm = makeLLM((msgs) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('atomic rationales')) return JSON.stringify({ rationales: [{ point: 'B', category: 'technical' }, { point: 'D', category: 'flow' }] });
      if (sys.includes('cross-asset-category')) return JSON.stringify({ found: true, rationale: 'extra', point: 'BTC funding reversal', category: 'flow' });
      return JSON.stringify({});
    });
    const e = makeEXP(embed, llm);
    injectRecord(e, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    injectRecord(e, embed, { rationales: ['D', 'F1'], outcome: 'WIN', symbol: 'XAU', assetCategory: 'commodity' });
    injectRecord(e, embed, { rationales: ['D', 'F2'], outcome: 'WIN', symbol: 'XAU', assetCategory: 'commodity' });
    const r = await e.checkThesisHistory({ thesis: 'B|D', symbol: 'BTC', side: 'buy', marketCtx: 'funding turning' });
    expect(r.verdict).toBe('APPROVE_WITH_NOTE');
    expect(r.extraRationale).toBe('BTC funding reversal');
  });

  it('REJECT when delta negative + strong risk factors (v2.0.215: reverse disabled)', async () => {
    const llm = makeLLM((msgs) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('atomic rationales')) return JSON.stringify({ rationales: [{ point: 'B', category: 'technical' }, { point: 'V', category: 'flow' }] });
      if (sys.includes('historically LOST')) return JSON.stringify({ furtherNegative: ['OB imbalance -15%'], riskFactors: ['funding reversal'], strong: true });
      if (sys.includes('CONTRARIAN')) return JSON.stringify({ thesis: '[1h: contrarian short] [1d: thesis invalidated]' });
      return JSON.stringify({});
    });
    const e = makeEXP(embed, llm);
    injectRecord(e, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC' });
    // V's negative history: two LOSS records containing V
    injectRecord(e, embed, { rationales: ['V', 'F1'], outcome: 'LOSS', symbol: 'BTC' });
    injectRecord(e, embed, { rationales: ['V', 'F2'], outcome: 'LOSS', symbol: 'BTC' });
    const r = await e.checkThesisHistory({ thesis: 'B|V', symbol: 'BTC', side: 'buy', marketCtx: 'OB -15%, funding reversing' });
    // v2.0.215: REVERSE_DIRECTION disabled — should REJECT instead
    expect(r.verdict).toBe('REJECT');
    expect(r.reason).toContain('reverse disabled');
  });

  it('REJECT when reverse direction is restricted (SILVER SELL-only, reverse to BUY blocked)', async () => {
    const llm = makeLLM((msgs) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('atomic rationales')) return JSON.stringify({ rationales: [{ point: 'B', category: 'technical' }, { point: 'V', category: 'flow' }] });
      if (sys.includes('historically LOST')) return JSON.stringify({ furtherNegative: ['x'], riskFactors: ['y'], strong: true });
      if (sys.includes('CONTRARIAN')) return JSON.stringify({ thesis: '[1h: reverse]' });
      return JSON.stringify({});
    });
    // directionAllowed forbids BUY on SILVER (SELL-only). Candidate is SELL → reverse to BUY blocked.
    const e = makeEXP(embed, llm, {}, (sym, side) => !(sym.toUpperCase() === 'XYZ:SILVER' && side === 'buy'));
    injectRecord(e, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'xyz:SILVER', assetCategory: 'commodity' });
    injectRecord(e, embed, { rationales: ['V', 'F1'], outcome: 'LOSS', symbol: 'xyz:SILVER', assetCategory: 'commodity' });
    injectRecord(e, embed, { rationales: ['V', 'F2'], outcome: 'LOSS', symbol: 'xyz:SILVER', assetCategory: 'commodity' });
    const r = await e.checkThesisHistory({ thesis: 'B|V', symbol: 'xyz:SILVER', side: 'sell', marketCtx: 'risk' });
    expect(r.verdict).toBe('REJECT');
    // v2.0.215: reverse disabled — reason contains 'reverse disabled' instead of 'restricted'
    expect(r.reason).toContain('reverse disabled');
  });

  it('REJECT when delta negative but no further risk factors (strong=false)', async () => {
    const llm = makeLLM((msgs) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('atomic rationales')) return JSON.stringify({ rationales: [{ point: 'B', category: 'technical' }, { point: 'V', category: 'flow' }] });
      if (sys.includes('historically LOST')) return JSON.stringify({ furtherNegative: [], riskFactors: [], strong: false });
      return JSON.stringify({});
    });
    const e = makeEXP(embed, llm);
    injectRecord(e, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC' });
    injectRecord(e, embed, { rationales: ['V', 'F1'], outcome: 'LOSS', symbol: 'BTC' });
    injectRecord(e, embed, { rationales: ['V', 'F2'], outcome: 'LOSS', symbol: 'BTC' });
    const r = await e.checkThesisHistory({ thesis: 'B|V', symbol: 'BTC', side: 'buy', marketCtx: 'calm' });
    expect(r.verdict).toBe('REJECT');
  });
});

describe('EXP multi-delta conflict (§15-5) — most extreme wins', () => {
  it('picks the more extreme (negative) delta over a milder positive delta', async () => {
    const embed = new MockEmbedProvider(384);
    // Multi-dim placement so deltas are far from B, near-but-below-threshold to C, and far from each other.
    plant(embed, 'B',   [1, 0,    0,    0,   0,   0]);
    plant(embed, 'C',   [0, 1,    0,    0,   0,   0]);
    plant(embed, 'Dpos',[0, 0.45, 0.89, 0,   0,   0]); // cos(Dpos,C)≈0.45 (delta); cos(Dpos,B)=0
    plant(embed, 'Dneg',[0, 0.45, 0,    0.89,0,   0]); // cos(Dneg,C)≈0.45 (delta); cos(Dneg,Dpos)≈0.20
    plant(embed, 'Fp1', [0, 0,    0,    0,   1,   0]);
    plant(embed, 'Fp2', [0, 0,    0,    0,   0.6, 0.8]);
    plant(embed, 'Fn1', [0, 0,    0,    0,   0,   1]);
    plant(embed, 'Fn2', [0, 0,    0,    0,   0.8, 0.6]);
    const llm = makeLLM((msgs) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('atomic rationales')) return JSON.stringify({ rationales: [
        { point: 'B', category: 'technical' },
        { point: 'Dpos', category: 'flow' },
        { point: 'Dneg', category: 'flow' },
      ] });
      if (sys.includes('historically LOST')) return JSON.stringify({ furtherNegative: ['OB -15%'], riskFactors: ['funding reversal'], strong: true });
      if (sys.includes('CONTRARIAN')) return JSON.stringify({ thesis: '[1h: contrarian short]' });
      return JSON.stringify({});
    });
    const e = makeEXP(embed, llm);
    // Losing combo B+C (crypto) — the candidate matches it via B.
    injectRecord(e, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    // Dpos: 3W 2L in COMMODITY (XAU) → winRateAll=0.6 (mild positive), cross-category → approve-weak, extremeness 0.1
    injectRecord(e, embed, { rationales: ['Dpos', 'Fp1'], outcome: 'WIN',  symbol: 'XAU', assetCategory: 'commodity' });
    injectRecord(e, embed, { rationales: ['Dpos', 'Fp2'], outcome: 'WIN',  symbol: 'XAU', assetCategory: 'commodity' });
    injectRecord(e, embed, { rationales: ['Dpos', 'Fp1'], outcome: 'WIN',  symbol: 'XAU', assetCategory: 'commodity' });
    injectRecord(e, embed, { rationales: ['Dpos', 'Fp2'], outcome: 'LOSS', symbol: 'XAU', assetCategory: 'commodity' });
    injectRecord(e, embed, { rationales: ['Dpos', 'Fp1'], outcome: 'LOSS', symbol: 'XAU', assetCategory: 'commodity' });
    // Dneg: 2L in CRYPTO → winRateAll=0.0 (strong negative), extremeness 0.5
    injectRecord(e, embed, { rationales: ['Dneg', 'Fn1'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    injectRecord(e, embed, { rationales: ['Dneg', 'Fn2'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    const r = await e.checkThesisHistory({ thesis: 'B|Dpos|Dneg', symbol: 'BTC', side: 'buy', marketCtx: 'risk-off' });
    // v2.0.215: REVERSE_DIRECTION disabled — Dneg extremeness (0.5) > Dpos extremeness (0.1) but now REJECT
    expect(r.verdict).toBe('REJECT');
    expect(r.reason).toContain('reverse disabled');
  });

  it('picks the positive delta when it is more extreme than a milder negative', async () => {
    const embed = new MockEmbedProvider(384);
    plant(embed, 'B',   [1, 0,    0,    0,   0,   0]);
    plant(embed, 'C',   [0, 1,    0,    0,   0,   0]);
    plant(embed, 'Dpos',[0, 0.45, 0.89, 0,   0,   0]);
    plant(embed, 'Dneg',[0, 0.45, 0,    0.89,0,   0]);
    plant(embed, 'Fp1', [0, 0,    0,    0,   1,   0]);
    plant(embed, 'Fp2', [0, 0,    0,    0,   0.6, 0.8]);
    plant(embed, 'Fn1', [0, 0,    0,    0,   0,   1]);
    const llm = makeLLM((msgs) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('atomic rationales')) return JSON.stringify({ rationales: [
        { point: 'B', category: 'technical' },
        { point: 'Dpos', category: 'flow' },
        { point: 'Dneg', category: 'flow' },
      ] });
      return JSON.stringify({});
    });
    const e = makeEXP(embed, llm);
    injectRecord(e, embed, { rationales: ['B', 'C'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    // Dpos: 2W in crypto (same-cat) → winRateSame=1.0, approve-strong, extremeness 0.5
    injectRecord(e, embed, { rationales: ['Dpos', 'Fp1'], outcome: 'WIN', symbol: 'BTC', assetCategory: 'crypto' });
    injectRecord(e, embed, { rationales: ['Dpos', 'Fp2'], outcome: 'WIN', symbol: 'BTC', assetCategory: 'crypto' });
    // Dneg: 2L 3W in crypto → winRateAll=0.6 (mild, NOT < 0.4) → signal 'none', extremeness 0
    injectRecord(e, embed, { rationales: ['Dneg', 'Fn1'], outcome: 'LOSS', symbol: 'BTC', assetCategory: 'crypto' });
    injectRecord(e, embed, { rationales: ['Dneg', 'Fn1'], outcome: 'WIN',  symbol: 'BTC', assetCategory: 'crypto' });
    injectRecord(e, embed, { rationales: ['Dneg', 'Fn1'], outcome: 'WIN',  symbol: 'BTC', assetCategory: 'crypto' });
    const r = await e.checkThesisHistory({ thesis: 'B|Dpos|Dneg', symbol: 'BTC', side: 'buy', marketCtx: '' });
    // Dpos extremeness (0.5) > Dneg extremeness (0) → approve-strong wins
    expect(r.verdict).toBe('APPROVE_WITH_NOTE');
  });
});

describe('EXP fallback + self-heal (§8.6)', () => {
  afterEach(() => { rmSync(join(TMP, 'incidents.jsonl'), { force: true }); });

  it('EXP_ERRORED when embed fails and repair is disabled', async () => {
    const embed = new MockEmbedProvider(384);
    plant(embed, 'B', [1, 0, 0]);
    plant(embed, 'Y', [0, 0, 1]);
    plant(embed, 'Z', [0, 0.05, 0.99]);
    // Failing embed: throws on embed()
    const failingEmbed = {
      name: 'failing',
      dim: 384,
      isReady: () => true,
      warmup: async () => {},
      embed: async () => { throw new Error('onnx runtime load failed'); },
    };
    const llm = makeLLM(extractHandler);
    const e = makeEXP(failingEmbed as never, llm, { repair: { enabled: false, maxRetries: 1, backoffMs: 1 } });
    injectRecord(e, embed, { rationales: ['B', 'Y'], outcome: 'WIN' });
    const r = await e.checkThesisHistory({ thesis: 'B|Z', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('EXP_ERRORED');
    expect(r.errorType).toBe('embed-load-fail');
  });

  it('repair reloads embed pipeline then retries 1.8a (recursion guard)', async () => {
    const embed = new MockEmbedProvider(384);
    let embedFailing = true;
    const failingEmbed: InstanceType<typeof MockEmbedProvider> = new MockEmbedProvider(384);
    // Wrap embed: fail until warmup() called, then recover
    const wrappedEmbed = {
      name: 'mock-wrapped',
      dim: 384,
      isReady: () => !embedFailing,
      warmup: async () => { embedFailing = false; },
      embed: async (texts: string[]) => {
        if (embedFailing) throw new Error('embed pipeline not loaded');
        return failingEmbed.embed(texts);
      },
    };
    plant(failingEmbed, 'B', [1, 0, 0]);
    plant(failingEmbed, 'Y', [0, 0, 1]);
    plant(failingEmbed, 'Z', [0, 0.05, 0.99]);
    const llm = makeLLM(extractHandler);
    const e = makeEXP(wrappedEmbed as never, llm, { repair: { enabled: true, maxRetries: 1, backoffMs: 1 } });
    injectRecord(e, failingEmbed, { rationales: ['B', 'Y'], outcome: 'WIN' });
    // First embed throws → diagnose embed-load-fail → warmup() recovers → retry → FAST_APPROVE
    const r = await e.checkThesisHistory({ thesis: 'B|Z', symbol: 'BTC', side: 'buy', marketCtx: '' });
    expect(r.verdict).toBe('FAST_APPROVE');
  });
});

describe('EXP assetCategory classification (§8.4c)', () => {
  it('maps via config + heuristic fallback', () => {
    expect(assetCategory('BTC', { BTC: 'crypto' })).toBe('crypto');
    expect(assetCategory('xyz:MU', { 'xyz:MU': 'equity' })).toBe('equity');
    expect(assetCategory('xyz:SILVER', { 'xyz:SILVER': 'commodity' })).toBe('commodity');
    expect(assetCategory('XAU', { XAU: 'commodity' })).toBe('commodity');
    expect(assetCategory('UNKNOWNUSDT')).toBe('crypto');
  });
});

describe('EXP TransformersEmbedProvider — construction only (no model download)', () => {
  it('constructs without loading the model', () => {
    const p = new TransformersEmbedProvider();
    expect(p.name).toBe('transformers.js:all-MiniLM-L6-v2');
    expect(p.dim).toBe(384);
    expect(p.isReady()).toBe(false);
  });
});

// clean up tmp dir after all tests
afterEach(() => {
  // best-effort; individual tests also remove specific files
});