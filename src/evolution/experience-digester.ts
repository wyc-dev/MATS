// ─── v2.0.140: A2A Experience Digester (三層經驗消化) ───
// Master Lord doctrine: EXP.md 經 A2A prompt 重點處理 → 濃縮精簡向量 →
// 判斷數據分類 → 更準確嘅經驗消化物。
//
// 每筆 closed trade 由 LLM 消化成一條 A2A-structured LessonStatement
// (OBS conditions + ASSESS direction + rootCause + lesson), embed 成一條
// 濃縮精簡向量 (lessonVector)。相似 lessons 聚類成 ExperienceClass
// (centroid + 勝率/PnL/hold/symbols)。新 candidate thesis 經同樣消化 →
// classification vs class centroids → 更準確嘅 verdict + 消化物。
//
// RED LINES: digestion NEVER bypasses conviction/risk/direction/frequency/SL-TP.
// All failures fall back safely (LLM fail → heuristic lesson; embed fail → empty
// vector → classification returns no class → caller falls back to raw similarity).

import { config } from '../config/index.ts';
import { rootLogger } from '../observability/logger.ts';
import type {
  AssetCategory,
  DigestClassification,
  ExperienceClass,
  LessonStatement,
  RationaleCategory,
  ThesisExperienceRecord,
  TradeOutcome,
} from '../types/index.ts';
import { type EmbedProvider, cosine } from './embeddings.ts';
import { extractJSON, categoriseRationale, normaliseCategory, computeVectorConditionalWinRate, formatVectorConditional } from './evolution-utils.ts';
import type { NumericEmbedProvider } from './numeric-autoencoder.ts';

const log = rootLogger;

// ─── LLM caller (structurally identical to ExpLLMCaller; duplicated to avoid
//     a circular import with thesis-experience.ts). ActiveProviderLLMCaller
//     satisfies this interface via TypeScript structural typing. ───

export interface DigestLLMMessage {
  role: 'system' | 'user';
  content: string;
}

export interface DigestLLMCaller {
  chat(
    messages: DigestLLMMessage[],
    opts?: { temperature?: number; model?: string; timeoutMs?: number },
  ): Promise<string>;
}

// ─── Config ───

export interface DigestRuntimeConfig {
  enabled: boolean;
  classifyThreshold: number;
  clusterThreshold: number;
  minClassSize: number;
  classWinThreshold: number;
  classLossThreshold: number;
  maxDigestCache: number;
}

function defaultDigestCfg(): DigestRuntimeConfig {
  const d = config.exp.digest;
  return {
    enabled: d.enabled,
    classifyThreshold: d.classifyThreshold,
    clusterThreshold: d.clusterThreshold,
    minClassSize: d.minClassSize,
    classWinThreshold: d.classWinThreshold,
    classLossThreshold: d.classLossThreshold,
    maxDigestCache: d.maxDigestCache,
  };
}

// v2.0.174: extractJSON + categorise + normaliseCat extracted to evolution-utils.ts

// ─── Core class ───

export class ExperienceDigester {
  private readonly embed: EmbedProvider;
  private readonly llm: DigestLLMCaller;
  private cfg: DigestRuntimeConfig;
  /** Lesson statements cache keyed by record id (for summary + debugging). */
  private lessonCache = new Map<string, LessonStatement>();
  /** Clustered experience classes, rebuilt from records. */
  private classes: ExperienceClass[] = [];
  private classesBuilt = false;

  constructor(opts: { embed: EmbedProvider; llm: DigestLLMCaller; cfg?: Partial<DigestRuntimeConfig> }) {
    this.embed = opts.embed;
    this.llm = opts.llm;
    this.cfg = { ...defaultDigestCfg(), ...opts.cfg };
  }

  getCfg(): DigestRuntimeConfig {
    return this.cfg;
  }

  isReady(): boolean {
    return this.cfg.enabled;
  }

  /** Number of clustered classes currently in memory. */
  classCount(): number {
    return this.classes.length;
  }

  /** All classes (tests + summary). */
  getClasses(): ExperienceClass[] {
    return [...this.classes];
  }

  // ═══════════════════════════════════════════════════════════
  //  Lesson digestion (A2A LLM prompt) — the core of Master Lord's request
  // ═══════════════════════════════════════════════════════════

  /**
   * Digest one closed trade into an A2A-structured LessonStatement.
   * The LLM is told to extract the ROOT CAUSE (why it won/lost, why it closed
   * fast) — the actual lesson — not just repeat the thesis.
   */
  async digestTrade(rec: ThesisExperienceRecord): Promise<LessonStatement> {
    const cached = this.lessonCache.get(rec.id);
    if (cached) return cached;
    try {
      const content = await this.llm.chat(
        [
          {
            role: 'system',
            content:
              'You are the Experience Digester of a multi-agent trading system running on Hyperliquid. ' +
              'Your PRIMARY mission: identify whether this trade was closed by a PREMATURE stop-loss or ' +
              'premature take-profit — the system\'s biggest recurring problem is exiting too early, ' +
              'cutting winners short and stopping out before the thesis has room to develop.\n\n' +
              'You distil ONE closed trade into a structured LESSON. Use A2A vocabulary: ' +
              'OBS (observed market conditions), ASSESS (directional conviction taken).\n\n' +
              'CRITICAL — classify the exit type:\n' +
              '  "premature_sl": SL hit too early — thesis was directionally correct but SL was too tight. ' +
              'The position would have been profitable with a wider SL.\n' +
              '  "premature_tp": TP hit but position was closed too small — the move continued well beyond TP. ' +
              'Leaving significant profit on the table.\n' +
              '  "correct_sl": SL hit and the thesis was genuinely wrong — direction was incorrect.\n' +
              '  "correct_tp": TP hit at the right time — the move exhausted near TP.\n' +
              '  "thesis_invalidated": Closed by consensus/Skeptics because the thesis was invalidated, not by SL/TP.\n\n' +
              'DEEP ROOT CAUSE ANALYSIS — if the trade closed in ≤8 minutes, you MUST diagnose WHY the thesis ' +
              'failed so fast. A genuine news catalyst or macro trend CANNOT invalidate in 5 minutes. Ask:\n' +
              '  1. Was the thesis itself too shallow / floating (no concrete price level, no volume confirmation)?\n' +
              '  2. Was the market in a choppy/ranging regime where direction is noise, not signal?\n' +
              '  3. Was the information incomplete (missing order book depth, funding rate, on-chain data)?\n' +
              '  4. Was the SL placed at an arbitrary % rather than at a real S/R level?\n' +
              '  5. Was the volatility reading abnormally low? If ALL recent trades show low volatility, ' +
              'the volatility CALCULATION may be broken — flag this in rootCause.\n' +
              'The "rootCause" field must answer the deepest WHY, not just "SL hit".\n\n' +
              'The "lesson" field must be ONE condensed sentence that future trades can compare against. ' +
              'Focus on the EXIT QUALITY and the ROOT CAUSE: was the SL/TP placement appropriate given the ' +
              'volatility and thesis? Should the SL have been wider? Should the TP have been further? ' +
              'Was the thesis correct but the exit premature? Was the thesis itself too weak?\n\n' +
              'Respond ONLY with JSON: {"obs":"...","assess":{"direction":"buy|sell","conviction":0.0-1.0},' +
              '"outcome":"WIN|LOSS","exitType":"premature_sl|premature_tp|correct_sl|correct_tp|thesis_invalidated",' +
              '"rootCause":"...","lesson":"...","categories":["technical",...],"regime":"...","holdMin":N}.',
          },
          {
            role: 'user',
            content:
              `Trade: ${rec.side.toUpperCase()} ${rec.symbol} (${rec.assetCategory})\n` +
              `Outcome: ${rec.outcome} | PnL: ${rec.pnl.toFixed(3)} (${(rec.pnlPct * 100).toFixed(2)}%) | Hold: ${rec.holdMin}min\n` +
              `Regime: ${rec.regime} | Leverage: ${rec.leverage}x | Source: ${rec.source}\n` +
              `Entry thesis: ${rec.entryThesis}\n` +
              `Rationales: ${rec.rationales.map((p, i) => `[${rec.rationaleCats[i] ?? '?'}] ${p}`).join(' | ')}\n\n` +
              `Analyse this trade\'s EXIT QUALITY and ROOT CAUSE.\n` +
              `1. Was the SL/TP placement appropriate? Did the position exit too early?\n` +
              `2. WHY did the thesis fail/succeed in ${rec.holdMin} minutes? If ≤8min: was the thesis too shallow? ` +
              `Was the market choppy? Was information incomplete? Was SL at an arbitrary % vs real S/R?\n` +
              `3. Is the regime (${rec.regime}) consistent with a ${rec.holdMin}min exit, or does the exit timing ` +
              `suggest the regime classification may be wrong?\n` +
              `4. What should future trades with similar setups do differently regarding SL/TP width, ` +
              `thesis depth, and entry confirmation?`,
          },
        ],
        { temperature: 0, timeoutMs: 25_000 },
      );
      const parsed = extractJSON(content) as {
        obs?: string; assess?: { direction?: string; conviction?: number };
        outcome?: string; exitType?: string; rootCause?: string; lesson?: string;
        categories?: string[]; regime?: string; holdMin?: number;
      };
      const lesson = this.validateLesson(parsed, rec);
      this.lessonCache.set(rec.id, lesson);
      if (this.lessonCache.size > this.cfg.maxDigestCache) {
        // evict oldest (Map preserves insertion order)
        const firstKey = this.lessonCache.keys().next().value;
        if (firstKey) this.lessonCache.delete(firstKey);
      }
      return lesson;
    } catch (err) {
      log.warn(`[EXP-digest] digestTrade LLM failed → heuristic: ${err instanceof Error ? err.message : String(err)}`);
      const heuristic = this.heuristicTradeLesson(rec);
      this.lessonCache.set(rec.id, heuristic);
      return heuristic;
    }
  }

  private validateLesson(p: Record<string, unknown>, rec: ThesisExperienceRecord): LessonStatement {
    const obs = typeof p['obs'] === 'string' && p['obs'].trim() ? (p['obs'] as string).trim() : rec.entryThesis.slice(0, 160);
    const dir = (p['assess'] as { direction?: string } | undefined)?.direction === 'sell' ? 'sell' : 'buy';
    const conviction = typeof (p['assess'] as { conviction?: number } | undefined)?.conviction === 'number'
      ? clamp01((p['assess'] as { conviction: number }).conviction)
      : 0.5;
    const outcome: TradeOutcome = (p['outcome'] as string) === 'WIN' ? 'WIN' : 'LOSS';
    const rootCause = typeof p['rootCause'] === 'string' && p['rootCause'].trim() ? (p['rootCause'] as string).trim() : '';
    const exitType = (p['exitType'] as string) ?? '';
    const validExitTypes = ['premature_sl', 'premature_tp', 'correct_sl', 'correct_tp', 'thesis_invalidated'] as const;
    const typedExit = validExitTypes.includes(exitType as typeof validExitTypes[number]) ? exitType as typeof validExitTypes[number] : undefined;
    const lesson = typeof p['lesson'] === 'string' && p['lesson'].trim() ? (p['lesson'] as string).trim() : '';
    const cats = Array.isArray(p['categories'])
      ? (p['categories'] as unknown[]).filter((x): x is string => typeof x === 'string').map((c) => normaliseCategory(c))
      : rec.rationaleCats.slice(0, 3);
    return {
      obs,
      assess: { direction: dir as 'buy' | 'sell', conviction },
      outcome,
      rootCause,
      exitType: typedExit,
      lesson: lesson || `${outcome} ${rec.side.toUpperCase()} ${rec.symbol} — ${rootCause || rec.entryThesis.slice(0, 80)}`,
      categories: cats.length > 0 ? cats : ['other'],
      regime: rec.regime,
      holdMin: rec.holdMin,
    };
  }

  private heuristicTradeLesson(rec: ThesisExperienceRecord): LessonStatement {
    const cats = rec.rationaleCats.slice(0, 3);
    const fastClose = rec.holdMin <= 8;
    // Derive exit type from outcome + hold time when LLM is unavailable
    const exitType: LessonStatement['exitType'] = fastClose && rec.outcome === 'LOSS'
      ? 'premature_sl'
      : fastClose && rec.outcome === 'WIN'
        ? 'premature_tp'
        : rec.outcome === 'LOSS' ? 'correct_sl' : 'correct_tp';
    const rootCause = fastClose
      ? `Closed in ${rec.holdMin}min — ${rec.outcome === 'LOSS' ? 'SL hit too early (premature stop — thesis may have been correct but SL too tight)' : 'TP hit too early (premature take-profit — move likely continued)'}`
      : `Held ${rec.holdMin}min — ${rec.outcome === 'WIN' ? 'winner ran to TP correctly' : 'thesis failed to develop, SL correct'}`;
    return {
      obs: rec.entryThesis.slice(0, 160),
      assess: { direction: rec.side, conviction: 0.5 },
      outcome: rec.outcome,
      exitType,
      rootCause,
      lesson: `${rec.outcome} ${rec.side.toUpperCase()} ${rec.symbol} (${rec.assetCategory}, ${rec.regime}) — ${rootCause}`,
      categories: cats.length > 0 ? cats : ['other'],
      regime: rec.regime,
      holdMin: rec.holdMin,
    };
  }

  /**
   * Digest a CANDIDATE thesis (no outcome yet) into a LessonStatement-shaped
   * "setup pattern". Used for classification against historical classes.
   */
  async digestCandidate(
    thesis: string,
    symbol: string,
    side: 'buy' | 'sell',
    marketCtx: string,
    assetCat: AssetCategory,
  ): Promise<LessonStatement> {
    try {
      const content = await this.llm.chat(
        [
          {
            role: 'system',
            content:
              'You are the Experience Digester. A NEW trade is being proposed. Distil the PROPOSED setup ' +
              'into a structured "setup pattern" statement, using A2A vocabulary (OBS conditions + ASSESS ' +
              'direction). The "lesson" field should describe the PATTERN this trade belongs to — the kind ' +
              'of setup it is — so it can be compared to the system\'s historical experience. No outcome yet. ' +
              'Respond ONLY with JSON: {"obs":"...","assess":{"direction":"buy|sell","conviction":0.0-1.0},' +
              '"lesson":"...","categories":["technical",...],"regime":"..."}.',
          },
          {
            role: 'user',
            content:
              `Proposed: ${side.toUpperCase()} ${symbol} (${assetCat})\n` +
              `Thesis: ${thesis}\n` +
              `Market context (abridged): ${marketCtx.slice(0, 1200)}\n\n` +
              `Describe this setup as a pattern that can be compared to historical experience.`,
          },
        ],
        { temperature: 0, timeoutMs: 22_000 },
      );
      const parsed = extractJSON(content) as {
        obs?: string; assess?: { direction?: string; conviction?: number };
        lesson?: string; categories?: string[]; regime?: string;
      };
      return this.validateCandidate(parsed, thesis, symbol, side);
    } catch (err) {
      log.warn(`[EXP-digest] digestCandidate LLM failed → heuristic: ${err instanceof Error ? err.message : String(err)}`);
      return this.heuristicCandidateLesson(thesis, symbol, side);
    }
  }

  private validateCandidate(
    p: Record<string, unknown>,
    thesis: string,
    _symbol: string,
    side: 'buy' | 'sell',
  ): LessonStatement {
    const obs = typeof p['obs'] === 'string' && p['obs'].trim() ? (p['obs'] as string).trim() : thesis.slice(0, 160);
    const dir = (p['assess'] as { direction?: string } | undefined)?.direction === 'sell' ? 'sell' : 'buy';
    const conviction = typeof (p['assess'] as { conviction?: number } | undefined)?.conviction === 'number'
      ? clamp01((p['assess'] as { conviction: number }).conviction)
      : 0.5;
    const lesson = typeof p['lesson'] === 'string' && p['lesson'].trim() ? (p['lesson'] as string).trim() : '';
    const cats = Array.isArray(p['categories'])
      ? (p['categories'] as unknown[]).filter((x): x is string => typeof x === 'string').map((c) => normaliseCategory(c))
      : [];
    return {
      obs,
      assess: { direction: (dir as 'buy' | 'sell') || side, conviction },
      lesson: lesson || `Proposed ${side.toUpperCase()} setup — ${thesis.slice(0, 100)}`,
      categories: cats.length > 0 ? cats : ['other'],
    };
  }

  private heuristicCandidateLesson(thesis: string, symbol: string, side: 'buy' | 'sell'): LessonStatement {
    return {
      obs: thesis.slice(0, 160),
      assess: { direction: side, conviction: 0.5 },
      lesson: `Proposed ${side.toUpperCase()} ${symbol} — ${thesis.slice(0, 100)}`,
      categories: ['other'],
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  Embedding the lesson → condensed vector (Master Lord: 濃縮精簡向量)
  // ═══════════════════════════════════════════════════════════

  /**
   * Embed a LessonStatement into a single condensed vector. The embedding text
   * fuses the lesson (causal essence) + dominant categories + OBS conditions,
   * so the vector captures the *semantic lesson*, not raw rationale wording.
   */
  async embedLesson(lesson: LessonStatement): Promise<number[]> {
    const text =
      `${lesson.lesson}` +
      ` [${lesson.categories.join(',')}]` +
      ` dir=${lesson.assess.direction}` +
      (lesson.outcome ? ` outcome=${lesson.outcome}` : '') +
      (lesson.regime ? ` regime=${lesson.regime}` : '') +
      ` | ${lesson.obs}`;
    try {
      const vecs = await this.embed.embed([text]);
      return vecs[0] ?? [];
    } catch (err) {
      log.warn(`[EXP-digest] embedLesson failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Clustering → ExperienceClass (增量 greedy clustering)
  // ═══════════════════════════════════════════════════════════

  /**
   * Rebuild all ExperienceClasses from a set of records. Each record is
   * digested → embedded → greedily assigned to the nearest existing class
   * (cosine ≥ clusterThreshold), or starts a new class. Centroids are running
   * means, L2-renormalised after each addition.
   *
   * Cost: O(n × classes × dim). Fine for ≤ a few hundred records.
   * Called on startup (after load) and periodically (e.g. every N closes).
   */
  async rebuildClasses(records: ThesisExperienceRecord[]): Promise<ExperienceClass[]> {
    if (!this.cfg.enabled || records.length === 0) {
      this.classes = [];
      this.classesBuilt = true;
      return [];
    }
    const classes: ExperienceClass[] = [];
    // v2.0.197: Use heuristic digestion for rebuild to avoid LLM timeout storm
    // at startup (98 records × 25s timeout = 40min). Heuristic is fast + reliable.
    // LLM digestion happens incrementally via addRecord() on each new trade close.
    // The lessonCache ensures that if a record was already digested by LLM (via
    // a prior addRecord), its cached lesson is reused instead of re-digesting.
    for (const rec of records) {
      const cached = this.lessonCache.get(rec.id);
      const lesson = cached ?? this.heuristicTradeLesson(rec);
      const vec = await this.embedLesson(lesson);
      if (vec.length === 0) continue; // embed failed — skip (can't classify)
      // find nearest class
      let best: ExperienceClass | null = null;
      let bestSim = -Infinity;
      for (const c of classes) {
        const sim = cosine(vec, c.centroid);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      if (best && bestSim >= this.cfg.clusterThreshold) {
        this.addToClass(best, rec, lesson, vec);
      } else {
        classes.push(this.newClass(rec, lesson, vec));
      }
    }
    // sort by count desc — most-populated classes are most trustworthy
    classes.sort((a, b) => b.count - a.count);
    this.classes = classes;
    this.classesBuilt = true;
    log.info(`[EXP-digest] rebuilt ${classes.length} experience classes from ${records.length} records`);
    return classes;
  }

  private newClass(rec: ThesisExperienceRecord, lesson: LessonStatement, vec: number[]): ExperienceClass {
    return {
      id: `class-${rec.id}`,
      centroid: vec,
      lesson: lesson.lesson,
      count: 1,
      wins: rec.outcome === 'WIN' ? 1 : 0,
      losses: rec.outcome === 'LOSS' ? 1 : 0,
      netPnl: rec.pnl,
      winRate: rec.outcome === 'WIN' ? 1 : 0,
      symbols: [rec.symbol],
      sides: [rec.side],
      // v2.0.176: Per-direction tracking
      buyWins: rec.side === 'buy' && rec.outcome === 'WIN' ? 1 : 0,
      buyLosses: rec.side === 'buy' && rec.outcome === 'LOSS' ? 1 : 0,
      sellWins: rec.side === 'sell' && rec.outcome === 'WIN' ? 1 : 0,
      sellLosses: rec.side === 'sell' && rec.outcome === 'LOSS' ? 1 : 0,
      regimes: [rec.regime],
      avgHoldMin: rec.holdMin,
      memberIds: [rec.id],
      directionBias: rec.side,
      ts: rec.ts,
    };
  }

  private addToClass(
    c: ExperienceClass,
    rec: ThesisExperienceRecord,
    lesson: LessonStatement,
    vec: number[],
  ): void {
    // running-mean centroid: new = (old*count + vec) / (count+1), then renormalise
    const n = c.count;
    const sum: number[] = c.centroid.map((v, i) => v * n + (vec[i] ?? 0));
    const dim = sum.length;
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += sum[i]! * sum[i]!;
    norm = Math.sqrt(norm) || 1;
    c.centroid = sum.map((v) => v / norm);
    c.count = n + 1;
    if (rec.outcome === 'WIN') c.wins++; else c.losses++;
    c.netPnl += rec.pnl;
    c.winRate = c.wins / c.count;
    if (!c.symbols.includes(rec.symbol)) c.symbols.push(rec.symbol);
    if (!c.sides.includes(rec.side)) c.sides.push(rec.side);
    // v2.0.176: Per-direction tracking
    if (rec.side === 'buy') {
      if (rec.outcome === 'WIN') c.buyWins++; else c.buyLosses++;
    } else {
      if (rec.outcome === 'WIN') c.sellWins++; else c.sellLosses++;
    }
    if (!c.regimes.includes(rec.regime)) c.regimes.push(rec.regime);
    c.avgHoldMin = (c.avgHoldMin * n + rec.holdMin) / c.count;
    c.memberIds.push(rec.id);
    c.directionBias =
      c.sides.includes('buy') && c.sides.includes('sell') ? 'mixed'
        : c.sides[0] ?? rec.side;
    c.ts = Math.max(c.ts, rec.ts);
    // adopt a more-central lesson if this member's lesson is closer to the new centroid
    void lesson; // (kept for future representative refresh; centroid drift is the signal)
  }

  /** Incremental: add a single freshly-closed record to the existing classes
   *  without a full rebuild. Falls back to new class if no cluster matches.
   *  v2.0.720: Added onLessonDigest callback — after the trade is digested into
   *  a lesson, the callback is invoked with the derived exitType so the caller
   *  can write it back to the record (e.g. premature_sl → record.exitType). */
  async addRecord(
    rec: ThesisExperienceRecord,
    onLessonDigest?: (exitType: NonNullable<LessonStatement['exitType']>) => void,
  ): Promise<void> {
    if (!this.cfg.enabled) return;
    if (!this.classesBuilt) return; // not yet built — rebuild will pick it up
    const lesson = await this.digestTrade(rec);
    // v2.0.720: If the digester derived a fine-grained exitType, invoke the
    // callback so the caller can write it back to the record. This bridges
    // the A2A digester's premature_sl/correct_sl classification into RIL's
    // CloseReasonAggregator, which was previously dead code.
    if (onLessonDigest && lesson.exitType) {
      try {
        onLessonDigest(lesson.exitType);
      } catch (err: unknown) {
        log.warn(`[digester] onLessonDigest callback failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const vec = await this.embedLesson(lesson);
    if (vec.length === 0) return;
    let best: ExperienceClass | null = null;
    let bestSim = -Infinity;
    for (const c of this.classes) {
      const sim = cosine(vec, c.centroid);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= this.cfg.clusterThreshold) {
      this.addToClass(best, rec, lesson, vec);
    } else {
      this.classes.push(this.newClass(rec, lesson, vec));
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Classification — the core of "判斷數據嘅分類"
  // ═══════════════════════════════════════════════════════════

  /**
   * Classify a candidate thesis against all experience classes.
   * Returns the best-matching class (if above classifyThreshold and ≥ minClassSize),
   * its winRate, and whether the candidate direction aligns with the class bias.
   */
  async classifyCandidate(
    thesis: string,
    symbol: string,
    side: 'buy' | 'sell',
    marketCtx: string,
    assetCat: AssetCategory,
  ): Promise<DigestClassification> {
    if (!this.cfg.enabled || this.classes.length === 0) {
      return { bestClass: null, similarity: 0, classWinRate: 0, directionAligned: true };
    }
    const lesson = await this.digestCandidate(thesis, symbol, side, marketCtx, assetCat);
    const vec = await this.embedLesson(lesson);
    if (vec.length === 0) {
      return { bestClass: null, similarity: 0, classWinRate: 0, directionAligned: true };
    }
    let best: ExperienceClass | null = null;
    let bestSim = -Infinity;
    for (const c of this.classes) {
      const sim = cosine(vec, c.centroid);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (!best || bestSim < this.cfg.classifyThreshold || best.count < this.cfg.minClassSize) {
      return { bestClass: null, similarity: bestSim, classWinRate: 0, directionAligned: true };
    }
    const directionAligned =
      best.directionBias === 'mixed' || best.directionBias === side;
    // v2.0.176: Use per-direction winRate instead of pooled winRate.
    // A mixed class with 80% BUY wins and 20% SELL wins should show 20% for
    // a SELL candidate, not the pooled 50%.
    const dirWinRate = side === 'buy'
      ? (best.buyWins + best.buyLosses > 0 ? best.buyWins / (best.buyWins + best.buyLosses) : best.winRate)
      : (best.sellWins + best.sellLosses > 0 ? best.sellWins / (best.sellWins + best.sellLosses) : best.winRate);
    return {
      bestClass: best,
      similarity: bestSim,
      classWinRate: dirWinRate,
      directionAligned,
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  Layered Digest Summary — SL/TP exit quality focus
  // ═══════════════════════════════════════════════════════════

  /**
   * Produce a concise, premature-close-focused digest of accumulated experience.
   * Core question: are positions being closed too early by Meta-Agent/Skeptics?
   * The SL/TP placement itself is not the primary issue — the issue is that
   * Meta-Agent and Skeptics initiate manual closes that ignore the actual price
   * structure, causing positions to exit before the thesis has time to develop.
   *
   * Structure:
   *   1. Headline — total, win rate, net PnL, streak
   *   2. EXIT QUALITY ANALYSIS — premature close counts + impact
   *   3. ROOT CAUSE DIAGNOSIS — why do theses fail in ≤8min?
   *   4. VOLATILITY ANOMALY CHECK — is the vol calculation broken?
   *   5. SL/TP LESSONS — actionable adjustments
   *   6. Losing classes (top 2, with exit-type breakdown)
   *   7. Winning classes (top 1, with exit-type breakdown)
   *   8. Per symbol/side (compact)
   */
  getDigestSummary(records: ThesisExperienceRecord[], embeddingProvider?: NumericEmbedProvider): string {
    if (records.length === 0) return '';
    const lines: string[] = [];

    // ── Layer 1: Headline ──
    const wins = records.filter((r) => r.outcome === 'WIN').length;
    const losses = records.length - wins;
    const winRate = wins / records.length;
    const netPnl = records.reduce((s, r) => s + r.pnl, 0);
    const sorted = [...records].sort((a, b) => a.ts - b.ts);
    let streak = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i]!.outcome === 'LOSS') streak++; else break;
    }
    const streakIcon = streak >= 3 ? '🔴' : streak > 0 ? '🟠' : '🟢';
    lines.push(`=== EXPERIENCE DIGEST (from ${records.length} closed trades) ===`);
    lines.push(`${streakIcon} Win rate: ${(winRate * 100).toFixed(0)}% (W${wins} L${losses}) | Net PnL: ${netPnl.toFixed(3)} | Current losing streak: ${streak}`);

    // ── Layer 2: EXIT QUALITY ANALYSIS (the core insight) ──
    lines.push('');
    lines.push('EXIT QUALITY ANALYSIS (premature close detection — Meta-Agent/Skeptics initiated):');
    const quickCloses = records.filter((r) => r.holdMin <= 8);
    const prematureSlCount = quickCloses.filter((r) => r.outcome === 'LOSS').length;
    const prematureTpCount = quickCloses.filter((r) => r.outcome === 'WIN').length;
    const prematureSlPnl = quickCloses.filter((r) => r.outcome === 'LOSS').reduce((s, r) => s + r.pnl, 0);
    const prematureTpPnl = quickCloses.filter((r) => r.outcome === 'WIN').reduce((s, r) => s + r.pnl, 0);
    const longWins = records.filter((r) => r.holdMin > 30 && r.outcome === 'WIN');
    const longWinPnl = longWins.reduce((s, r) => s + r.pnl, 0);

    lines.push(`  Premature close (≤8min loss): ${prematureSlCount} trades, net ${prematureSlPnl.toFixed(3)} — ${prematureSlCount > losses * 0.4 ? '⚠️ MAJOR ISSUE: over 40% of losses are premature closes. Meta-Agent/Skeptics are closing positions before SL/TP is hit, ignoring the actual price structure. The DIRECTION is often correct — the close decision is wrong.' : 'acceptable'}`);
    lines.push(`  Premature close (≤8min win): ${prematureTpCount} trades, net ${prematureTpPnl.toFixed(3)} — ${prematureTpCount > wins * 0.5 ? '⚠️ Winners exiting too early — Meta-Agent/Skeptics closing before TP is hit. Let winners run.' : 'acceptable'}`);
    if (longWins.length > 0) {
      lines.push(`  Long holds (>30min wins): ${longWins.length} trades, net ${longWinPnl.toFixed(3)} — letting winners run IS working when given room.`);
    }
    // Net impact of premature exits
    const prematureCost = prematureSlPnl + (prematureTpCount > 0 ? -prematureTpPnl * 0.5 : 0); // estimate: premature TP leaves ~50% on table
    if (prematureSlCount > 0 || prematureTpCount > 0) {
      lines.push(`  → ESTIMATED COST of premature exits: ${prematureCost.toFixed(3)} (wider SL/TP could have recovered this).`);
    }

    // ── Layer 2b: ROOT CAUSE DIAGNOSIS (why does the thesis fail in 5min?) ──
    lines.push('');
    lines.push('ROOT CAUSE DIAGNOSIS (why do theses fail in ≤8min?):');
    if (prematureSlCount > 0 || prematureTpCount > 0) {
      const quickLosses = quickCloses.filter((r) => r.outcome === 'LOSS');
      const quickWins = quickCloses.filter((r) => r.outcome === 'WIN');
      // Check regime distribution of quick closes
      const regimeCounts = new Map<string, number>();
      for (const r of quickCloses) {
        regimeCounts.set(r.regime, (regimeCounts.get(r.regime) ?? 0) + 1);
      }
      const topRegime = [...regimeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      // Check thesis length (short thesis = shallow reasoning)
      const avgThesisLen = quickCloses.reduce((s, r) => s + r.entryThesis.length, 0) / quickCloses.length;
      const shallowThesis = avgThesisLen < 80;

      lines.push(`  Quick exits: ${quickCloses.length} trades (≤8min) — ${quickLosses.length} losses, ${quickWins.length} wins.`);
      if (topRegime) {
        lines.push(`  Dominant regime at exit: ${topRegime[0]} (${topRegime[1]}/${quickCloses.length}) — ${topRegime[0] === 'low_volatility' || topRegime[0] === 'mean_reverting' ? 'choppy/ranging market — direction is noise, not signal. Thesis cannot survive in a range-bound market.' : topRegime[0] === 'chaotic' ? 'chaotic regime — unpredictable, thesis is guesswork.' : 'regime may be misclassified — check if volatility calculation is correct.'}`);
      }
      if (shallowThesis) {
        lines.push(`  ⚠️ THESIS TOO SHALLOW: avg thesis length ${avgThesisLen.toFixed(0)} chars (< 80) — theses are floating / lack concrete price levels, volume confirmation, or S/R reference. A thesis that says "BUY because trend" will fail in 5min because it has no structural anchor.`);
      }
      // News/trend cannot fail in 5min
      const newsCats = quickCloses.filter((r) => r.rationaleCats.includes('news') || r.rationaleCats.includes('macro'));
      if (newsCats.length > 0) {
        lines.push(`  ⚠️ NEWS/MACRO thesis failed in ≤8min: ${newsCats.length} trades — a genuine news catalyst or macro trend CANNOT invalidate in 5 minutes. If the thesis was news-based and failed in 5min, either (a) the news was not a real catalyst, (b) the entry was front-running the news and the move was already priced in, or (c) the SL was too tight for a news-driven move which requires wider room.`);
      }
      lines.push(`  → KEY INSIGHT: a thesis that fails in ≤8min is almost never a direction error — it is an EXIT PLACEMENT error (SL too tight) or a THESIS DEPTH error (no structural anchor). Before entering, the agent must verify: (1) is the SL at a real S/R level, not an arbitrary %? (2) does the thesis reference a concrete price level + volume/funding confirmation? (3) is the market actually trending, or is it ranging (choppy)?`);
    } else {
      lines.push(`  No quick exits detected — thesis depth and SL/TP placement appear adequate.`);
    }

    // ── Layer 2c: VOLATILITY ANOMALY CHECK ──
    lines.push('');
    lines.push('VOLATILITY ANOMALY CHECK:');
    const lowVolCount = records.filter((r) => r.regime === 'low_volatility').length;
    const normalVolCount = records.filter((r) => r.regime === 'trending_bull' || r.regime === 'trending_bear' || r.regime === 'high_volatility' || r.regime === 'breakout').length;
    if (records.length > 3 && lowVolCount > records.length * 0.7) {
      lines.push(`  ⚠️ ANOMALY: ${lowVolCount}/${records.length} trades (${(lowVolCount / records.length * 100).toFixed(0)}%) recorded as "low_volatility" — NO trades show normal or high volatility.`);
      lines.push(`  This is statistically implausible across ${records.length} trades on multiple assets. The volatility CALCULATION is likely broken — it may be:`);
      lines.push(`    (a) using too short a lookback window (e.g. 5 candles instead of 20+),`);
      lines.push(`    (b) computing on stale/cached price data instead of live websocket prices,`);
      lines.push(`    (c) normalising against a wrong baseline (e.g. 24h average instead of recent rolling std).`);
      lines.push(`  → ACTION REQUIRED: Agents should flag this anomaly and the system should audit the volatility computation (estimateVolatility / MarketStateAggregator). Low volatility readings cause: tight SL placement, premature stops, and false regime classification (choppy instead of trending).`);
    } else if (lowVolCount > records.length * 0.4) {
      lines.push(`  ⚠️ ${lowVolCount}/${records.length} trades in low_volatility — elevated. Check if volatility calculation is underestimating actual market movement.`);
    } else {
      lines.push(`  Volatility distribution appears normal (${lowVolCount} low / ${normalVolCount} normal-high out of ${records.length}).`);
    }

    // ── Layer 5: SL/TP LESSONS (actionable — focus on close discipline) ──
    lines.push('');
    lines.push('CLOSE DISCIPLINE LESSONS (for Meta-Agent + Skeptics):');
    // Average hold time for losses vs wins
    const avgLossHold = losses > 0 ? records.filter((r) => r.outcome === 'LOSS').reduce((s, r) => s + r.holdMin, 0) / losses : 0;
    const avgWinHold = wins > 0 ? records.filter((r) => r.outcome === 'WIN').reduce((s, r) => s + r.holdMin, 0) / wins : 0;
    if (losses > 0 && avgLossHold < 10) {
      lines.push(`  → PREMATURE CLOSE: losses average ${avgLossHold.toFixed(0)}min hold — positions are being closed before the thesis has time to develop. Meta-Agent/Skeptics: STOP closing positions \u003c 15min unless SL is actually hit. A 1h thesis cannot be invalidated in 5min.`);
    }
    if (wins > 0 && avgWinHold < 10) {
      lines.push(`  → PREMATURE TP: wins average ${avgWinHold.toFixed(0)}min hold — winners are being closed too early. Let TP work — do not close manually before TP is hit.`);
    }
    if (wins > 0 && avgWinHold > 30) {
      lines.push(`  → Hold discipline OK: wins average ${avgWinHold.toFixed(0)}min — winners are given room. Keep this discipline.`);
    }
    // Streak-specific advice
    if (streak >= 3) {
      lines.push(`  → ${streak}-trade losing streak: the DIRECTION is often correct but positions are closed prematurely. Before closing, Meta-Agent MUST verify: (1) has price actually breached the key S/R level? (2) has SL been hit? (3) has the position been open ≥15min? If ANY answer is NO → HOLD.`);
    }

    // ── Layer 4: Losing classes (top 2, with exit-type context) ──
    lines.push('');
    const losingClasses = this.classes
      .filter((c) => c.count >= this.cfg.minClassSize && c.winRate < this.cfg.classLossThreshold)
      .sort((a, b) => b.count - a.count)
      .slice(0, 2);
    if (losingClasses.length > 0) {
      lines.push('LOSING PATTERNS (check if SL was premature before avoiding the setup):');
      for (const c of losingClasses) {
        const exitNote = c.avgHoldMin <= 8 ? 'PREMATURE SL — setup direction may be correct, SL too tight' : 'SL correct — direction was wrong';
        lines.push(`  ❌ [${c.count} trades, win ${(c.winRate * 100).toFixed(0)}%, avg ${c.avgHoldMin.toFixed(0)}min, ${c.directionBias}] ${exitNote}`);
        lines.push(`      ${c.lesson}`);
        lines.push(`      symbols: ${c.symbols.join(', ')} | net ${c.netPnl.toFixed(3)}`);
      }
    } else if (this.classes.length > 0) {
      lines.push('LOSING PATTERNS: none clustered yet (cold-start — keep trading to build classes)');
    }

    // ── Layer 5: Winning classes (top 1, with exit-type context) ──
    const winningClasses = this.classes
      .filter((c) => c.count >= this.cfg.minClassSize && c.winRate >= this.cfg.classWinThreshold)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 1);
    if (winningClasses.length > 0) {
      lines.push('');
      lines.push('WINNING PATTERNS (repeat — note the SL/TP width that worked):');
      for (const c of winningClasses) {
        const exitNote = c.avgHoldMin <= 8 ? 'PREMATURE TP — won but exited too early, widen TP next time' : 'TP correct — exit timing was right';
        lines.push(`  ✅ [${c.count} trades, win ${(c.winRate * 100).toFixed(0)}%, avg ${c.avgHoldMin.toFixed(0)}min, ${c.directionBias}] ${exitNote}`);
        lines.push(`      ${c.lesson}`);
      }
    }

    // ── Layer 6: Per symbol/side (compact) ──
    // v2.0.203: Raw W/L is retained as SAMPLE-SIZE context only. The actionable
    // edge signal is the VECTOR-CONDITIONAL win rate — the win rate of
    // historically similar MARKET CONDITIONS (cross-symbol, same side),
    // not the raw per-symbol count. A symbol with 0W/1L is not evidence of a
    // bad setup if that single trade occurred under totally different
    // market conditions than the current candidate.
    lines.push('');
    lines.push('PER SYMBOL/SIDE (raw = sample context; conditional = true edge signal):');
    const byKey = new Map<string, { w: number; l: number; pnl: number; avgHold: number; count: number; latestFeatures?: Record<string, number>; latestSide?: 'buy' | 'sell' }>();
    for (const r of records) {
      const k = `${r.symbol} ${r.side.toUpperCase()}`;
      const e = byKey.get(k) ?? { w: 0, l: 0, pnl: 0, avgHold: 0, count: 0 };
      if (r.outcome === 'WIN') e.w++; else e.l++;
      e.pnl += r.pnl;
      e.avgHold += r.holdMin;
      e.count++;
      // Keep the LATEST trade's marketFeatures for this symbol/side
      if (r.marketFeatures && Object.keys(r.marketFeatures).length > 0) {
        e.latestFeatures = r.marketFeatures;
        e.latestSide = r.side;
      }
      byKey.set(k, e);
    }
    for (const [k, e] of byKey) {
      const tag = e.pnl >= 0 ? '+' : '';
      const avgH = e.count > 0 ? (e.avgHold / e.count).toFixed(0) : '0';
      const exitFlag = Number(avgH) <= 8 ? ' ⚠️premature' : '';
      const rawLine = `  ${k}: W${e.w} L${e.l} net ${tag}${e.pnl.toFixed(3)} avg ${avgH}min${exitFlag}`;
      // Compute vector-conditional WR using the latest trade's features as
      // the candidate, cross-symbol (so a thin single-symbol sample is backed
      // by the broader feature-space population), same side.
      if (e.latestFeatures && e.latestSide) {
        const result = computeVectorConditionalWinRate(
          e.latestFeatures,
          records,
          { side: e.latestSide, minSamples: 3, threshold: 0.80, topN: 20, embeddingProvider },
        );
        const condLine = formatVectorConditional(result, '    conditional');
        lines.push(`${rawLine} | ${condLine}`);
      } else {
        lines.push(`${rawLine} | (no marketFeatures — conditional N/A)`);
      }
    }

    return lines.join('\n');
  }

  // ── test scaffolding ──
  _setClasses(classes: ExperienceClass[]): void {
    this.classes = classes;
    this.classesBuilt = true;
  }
}

// ─── helpers ───

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  return Math.max(0, Math.min(1, x));
}

// v2.0.174: normaliseCat extracted to evolution-utils.ts