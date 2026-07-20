// ─── EXP Thesis Experience Vector Memory (v2.0.138) ───
// Core module: records closed-trade rationale combinations as embedded vectors,
// and at open time queries the memory to compute a history-weighted P(win) verdict
// for Skeptics Phase 1.8a.
//
// Blueprint: /Users/y.c./Downloads/EXP_core_plan.md (556 lines, 15 confirmed decisions).
// Decisions honoured:
//   Q1  MiniLM (384-dim, transformers.js)              §4
//   Q2  直出 = skip 1.8b; conviction/risk still run    §8.5
//   Q3  1.8b = fallback (EXP error/disabled → 1.8b)    §8.5/§8.6
//   Q4  paper/real experience equal                    §6
//   Q5  delta: same-cat pos→approve; cross-cat pos→require one more;
//        neg+risk→REVERSE_DIRECTION; no history→直出; no delta→REJECT   §8.4
//   Q6  data/EXP.md + data/exp/trades.jsonl            §7
//   breakeven=exclude; similarity=asymmetric; LLM cost accepted
//   reverse conviction = (b) Meta-Agent re-issues; reverse thesis = Skeptics-generated
//   cross-cat no extra → REJECT; multi-delta conflict → most extreme winRate wins §15-5
//   §8.6 fallback → diagnose → Skeptics repair → retry 1.8a → record incident
//
// RED LINES: EXP NEVER bypasses conviction/risk/direction/frequency/SL-TP gates.
// All failures fall back safely (EXP_ERRORED → 1.8b; valid no-history → 直出).

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/index.ts';
import { rootLogger } from '../observability/logger.ts';
import { isThesisPlaceholder } from '../trading/portfolio.ts';
import {
  type AssetCategory,
  type DecisionOrigin,
  type ExitType,
  type ExpCheckResult,
  type ExpFallbackIncident,
  type ExpVerdict,
  type RationaleCategory,
  type RationaleItem,
  type ThesisExperienceRecord,
  type TradeOutcome,
} from '../types/index.ts';
import {
  type EmbedProvider,
  combinationSimilarity,
  cosine,
} from './embeddings.ts';
import { ExperienceDigester } from './experience-digester.ts';
import { extractJSON, categoriseRationale, normaliseCategory, wilsonScore } from './evolution-utils.ts';

const log = rootLogger;

/** v2.0.720: Coarse exit types — used to check if a record's exitType is
 *  still the original coarse classification (not yet overridden by digester). */
const COARSE_EXIT_TYPES = new Set(['sl_tp', 'consensus', 'manual', 'thesis_invalidation', 'reconciliation', 'exchange_closed']);

// ─── LLM caller abstraction (mockable for tests) ───

export interface ExpLLMMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ExpLLMCaller {
  chat(
    messages: ExpLLMMessage[],
    opts?: { temperature?: number; model?: string; timeoutMs?: number },
  ): Promise<string>;
}

/** Production adapter wrapping the active Ollama provider. */
export class ActiveProviderLLMCaller implements ExpLLMCaller {
  async chat(
    messages: ExpLLMMessage[],
    opts?: { temperature?: number; model?: string; timeoutMs?: number },
  ): Promise<string> {
    const { getActiveProvider } = await import('../llm/index.ts');
    const provider = getActiveProvider();
    const res = await provider.chat({
      messages,
      temperature: opts?.temperature ?? 0,
      model: opts?.model,
      timeoutMs: opts?.timeoutMs ?? 30_000,
    });
    return res.content;
  }
}

// ─── Config shape (overridable for tests) ───

export interface ExpRuntimeConfig {
  enabled: boolean;
  embedModel: string;
  embedDim: number;
  maxRecords: number;
  matchThreshold: number;
  winProbThreshold: number;
  lossProbThreshold: number;
  deltaThreshold: number;
  minDeltaSamples: number;
  deltaWinRateThreshold: number;
  deltaLossRateThreshold: number;
  allowReverse: boolean;
  breakevenIs: 'win' | 'loss' | 'exclude';
  similarityMode: 'asymmetric' | 'symmetric';
  jsonlPath: string;
  expMdPath: string;
  incidentsPath: string;
  repair: { enabled: boolean; maxRetries: number; backoffMs: number };
  assetCategoryMap: Record<string, AssetCategory>;
}

function defaultCfg(): ExpRuntimeConfig {
  const e = config.exp;
  return {
    enabled: e.enabled,
    embedModel: e.embedModel,
    embedDim: e.embedDim,
    maxRecords: e.maxRecords,
    matchThreshold: e.matchThreshold,
    winProbThreshold: e.winProbThreshold,
    lossProbThreshold: e.lossProbThreshold,
    deltaThreshold: e.deltaThreshold,
    minDeltaSamples: e.minDeltaSamples,
    deltaWinRateThreshold: e.deltaWinRateThreshold,
    deltaLossRateThreshold: e.deltaLossRateThreshold,
    allowReverse: e.allowReverse,
    breakevenIs: e.breakevenIs,
    similarityMode: e.similarityMode,
    jsonlPath: e.jsonlPath,
    expMdPath: e.expMdPath,
    incidentsPath: e.incidentsPath,
    repair: { ...e.repair },
    assetCategoryMap: { ...e.assetCategoryMap },
  };
}

// ─── Asset category classification (§8.4c) ───

export function assetCategory(symbol: string, map?: Record<string, AssetCategory>): AssetCategory {
  const s = symbol.toUpperCase();
  if (map) {
    for (const k of Object.keys(map)) {
      if (k.toUpperCase() === s) return map[k]!;
    }
  }
  for (const k of Object.keys(config.exp.assetCategoryMap)) {
    if (k.toUpperCase() === s) return config.exp.assetCategoryMap[k]!;
  }
  // Heuristic inference
  if (s === 'BTC' || s === 'ETH' || s.startsWith('XYZ:') || s.includes('USDT') || s.includes('USDC')) return 'crypto';
  if (s.includes('SILVER') || s.includes('GOLD') || s === 'XAU' || s === 'XAG') return 'commodity';
  if (s.includes('EUR') || s.includes('JPY') || s.includes('GBP') || (s.includes('USD') && s.length === 6)) return 'forex';
  return 'other';
}

// v2.0.174: extractJSON extracted to evolution-utils.ts

// ─── Heuristic rationale split (fallback when LLM fails) ───

const TF_FRAMES = /\[(?:1h|4h|1d|15m|5m|1w):\s*/i;

function heuristicSplit(thesis: string): RationaleItem[] {
  const parts = thesis.split(TF_FRAMES).map((p) => p.replace(/\]$/, '').trim()).filter((p) => p.length > 0);
  const items: RationaleItem[] = [];
  for (const p of parts) {
    // Sub-split by sentence if a part is long
    const sentences = p.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
    for (const s of sentences) items.push({ point: s, category: categoriseRationale(s) });
  }
  if (items.length === 0 && thesis.trim().length > 0) {
    items.push({ point: thesis.trim(), category: categoriseRationale(thesis) });
  }
  return items;
}

// v2.0.174: categorise + normaliseCat extracted to evolution-utils.ts

// ─── Core class ───

export interface RecordCloseInput {
  symbol: string;
  side: 'buy' | 'sell';
  source: 'paper' | 'real';
  decisionOrigin: DecisionOrigin;
  pnl: number;
  pnlPct: number;
  entry: number;
  exit: number;
  leverage: number;
  holdMin: number;
  regime: string;
  entryThesis: string;
  /** v2.0.143: How the position was closed (SL/TP, consensus, manual, etc.).
   *  Stored on the ThesisExperienceRecord and used by RIL CloseReasonAggregator. */
  exitType?: ExitType;
  /** v2.0.720: Fine-grained exit type from A2A digester (premature_sl, correct_sl, etc.).
   *  If provided, overrides the coarse exitType on the record so
   *  CloseReasonAggregator's premature warning logic actually fires.
   *  Falls back to coarse exitType if digester hasn't run or failed. */
  lessonExitType?: ExitType;
  /** v2.0.178: Market conditions at trade open time — the ACTUAL state that
   *  produced this outcome, not just the Meta-Agent's textual interpretation.
   *  Used for condition-based similarity matching in future checkThesisHistory
   *  calls, so the system learns "these market conditions + this thesis → WIN/LOSS"
   *  rather than just "this thesis text → WIN/LOSS". */
  marketFeatures?: Record<string, number>;
  /** v2.0.178: OLR P(win) at entry time — what the statistical model predicted.
   *  Stored so future analysis can compare predicted vs actual outcome. */
  olrPWinAtEntry?: number;
  /** v2.0.178: Shadow win rate at entry time — what the shadow engine predicted. */
  shadowWinRateAtEntry?: number;
}

export interface CheckThesisInput {
  thesis: string;
  symbol: string;
  side: 'buy' | 'sell';
  marketCtx: string;
  /** v2.0.140: Dual-Channel Fusion — OLR P(win) for this symbol+side.
   *  When provided, the fusion layer cross-references the semantic verdict
   *  against the statistical P(win) to resolve disagreements (e.g. semantic
   *  REJECT but OLR says 65% win → premature close, not bad direction). */
  olrPWin?: number;
  /** v2.0.140: Shadow trade win rate for this symbol+side (0-1).
   *  Shadow trades use fixed S/R SL/TP — not affected by premature closes.
   *  When > 0.50, it confirms the direction is statistically profitable. */
  shadowWinRate?: number;
  /** v2.0.721: Candidate's market regime — used to filter historical matches
   *  by regime. When provided, only same-regime records are matched (with
   *  fallback to all records if no same-regime matches exist). */
  regime?: string;
  /** v2.0.721: Candidate's volatility — used to filter historical matches
   *  by volatility band (±50% of candidate volatility). When provided with
   *  regime, enables condition-based matching instead of text-only. */
  volatility?: number;
}

export class ThesisExperience {
  /** v2.0.143: Last candidate vectors from checkThesisHistory — used by HACP
   *  to feed SimilarTradeRetriever without re-embedding the candidate thesis. */
  private lastCandidateVectors: number[][] = [];
  private records: ThesisExperienceRecord[] = [];
  private cfg: ExpRuntimeConfig;
  private readonly embed: EmbedProvider;
  private readonly llm: ExpLLMCaller;
  private readonly directionAllowed: (symbol: string, side: 'buy' | 'sell') => boolean;
  private loaded = false;
  /** v2.0.140: A2A Experience Digester — lesson digestion + classification. */
  private readonly digester: ExperienceDigester;
  /** v2.0.140: Last semantic verdict from the classification path (for fusion). */
  private lastSemanticVerdict: ExpCheckResult | null = null;

  constructor(opts: {
    embed: EmbedProvider;
    llm: ExpLLMCaller;
    directionAllowed: (symbol: string, side: 'buy' | 'sell') => boolean;
    cfg?: Partial<ExpRuntimeConfig>;
  }) {
    this.embed = opts.embed;
    this.llm = opts.llm;
    this.directionAllowed = opts.directionAllowed;
    this.cfg = { ...defaultCfg(), ...opts.cfg };
    // v2.0.140: the digester shares our embed + LLM. EXP disabled → digester
    // stays dormant (isReady()=false); getDigestSummary falls back to simple stats.
    this.digester = new ExperienceDigester({
      embed: opts.embed,
      llm: opts.llm as unknown as import('./experience-digester.ts').DigestLLMCaller,
      cfg: {
        enabled: this.cfg.enabled && config.exp.digest.enabled,
        classifyThreshold: config.exp.digest.classifyThreshold,
        clusterThreshold: config.exp.digest.clusterThreshold,
        minClassSize: config.exp.digest.minClassSize,
        classWinThreshold: config.exp.digest.classWinThreshold,
        classLossThreshold: config.exp.digest.classLossThreshold,
        maxDigestCache: config.exp.digest.maxDigestCache,
      },
    });
  }

  /** Access the A2A Experience Digester (for startup rebuild + UI). */
  getDigester(): ExperienceDigester {
    return this.digester;
  }

  getCfg(): ExpRuntimeConfig {
    return this.cfg;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** Preload the embedding model so the first checkThesisHistory() isn't delayed.
   *  Only meaningful when enabled (no-op otherwise). Safe to call at startup. */
  async warmup(): Promise<void> {
    if (!this.cfg.enabled) return;
    try {
      await this.embed.warmup();
      log.info(`[EXP] embed model warmed up (${this.cfg.embedModel})`);
    } catch (err) {
      log.warn(`[EXP] warmup failed (will repair on first use): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** v2.0.140: rebuild experience classes from all loaded records. Call after
   *  load() at startup (non-blocking to the trading loop).
   *  v2.0.178: Wait for embed warmup BEFORE digesting — previously warmup()
   *  and rebuildClasses() were both fire-and-forget, so rebuildClasses would
   *  try to embed 93 lessons before the model was ready → all embeds failed
   *  → 0 experience classes → semantic classification path never worked. */
  async rebuildClasses(): Promise<void> {
    if (!this.cfg.enabled || !this.digester.getCfg().enabled) return;
    try {
      // v2.0.178: Ensure embed model is ready before digesting
      await this.embed.warmup();
      log.info(`[EXP] embed model ready, rebuilding classes from ${this.records.length} records...`);
      await this.digester.rebuildClasses(this.records);
    } catch (err) {
      log.warn(`[EXP] rebuildClasses failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** v2.0.140: layered digest summary for agent context + UI. Falls back to
   *  simple stats when the digester is dormant. */
  getDigestSummary(): string {
    if (this.records.length === 0) return '';
    if (this.digester.getCfg().enabled && this.digester.classCount() >= 0) {
      return this.digester.getDigestSummary(this.records);
    }
    return this.simpleDigestSummary();
  }

  private simpleDigestSummary(): string {
    const wins = this.records.filter((r) => r.outcome === 'WIN').length;
    const losses = this.records.length - wins;
    const net = this.records.reduce((s, r) => s + r.pnl, 0);
    return `=== EXPERIENCE DIGEST (from ${this.records.length} closed trades) ===\nWin rate: ${(wins / this.records.length * 100).toFixed(0)}% (W${wins} L${losses}) | Net PnL: ${net.toFixed(3)}\n(digestion disabled — enable EXP + EXP_DIGEST_ENABLED for full analysis)`;
  }

  /** Number of records currently in memory. */
  size(): number {
    return this.records.length;
  }

  /** v2.0.143: Get the candidate vectors from the last checkThesisHistory call.
   *  Used by HACP to feed SimilarTradeRetriever without re-embedding. */
  getLastCandidateVectors(): number[][] {
    return this.lastCandidateVectors;
  }

  // ═══════════════════════════════════════════════════════════
  //  Memory load / persistence
  // ═══════════════════════════════════════════════════════════

  /** Load trades.jsonl into the in-memory index. Called once at startup. */
  load(): void {
    try {
      if (!existsSync(this.cfg.jsonlPath)) {
        this.records = [];
        this.loaded = true;
        log.info(`[EXP] no jsonl at ${this.cfg.jsonlPath} — starting empty`);
        return;
      }
      const raw = readFileSync(this.cfg.jsonlPath, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const recs: ThesisExperienceRecord[] = [];
      for (const line of lines) {
        try {
          recs.push(JSON.parse(line) as ThesisExperienceRecord);
        } catch {
          // skip corrupt line (§8.6 salvage)
          log.warn(`[EXP] skipping corrupt jsonl line during load`);
        }
      }
      // Rolling cap — keep most recent
      this.records = recs.slice(-this.cfg.maxRecords);
      this.loaded = true;
      log.info(`[EXP] loaded ${this.records.length} records from ${this.cfg.jsonlPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[EXP] load failed: ${msg}`);
      this.records = [];
      this.loaded = false;
      throw err;
    }
  }

  private ensureDir(path: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private appendRecordToDisk(record: ThesisExperienceRecord): void {
    try {
      this.ensureDir(this.cfg.jsonlPath);
      appendFileSync(this.cfg.jsonlPath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      log.warn(`[EXP] appendRecord disk write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private appendIncidentToDisk(incident: ExpFallbackIncident): void {
    try {
      this.ensureDir(this.cfg.incidentsPath);
      appendFileSync(this.cfg.incidentsPath, JSON.stringify(incident) + '\n', 'utf-8');
    } catch (err) {
      log.warn(`[EXP] incident write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Render data/EXP.md (human-readable) from the in-memory records. */
  renderEXPmd(): void {
    try {
      this.ensureDir(this.cfg.expMdPath);
      const lines: string[] = [];
      lines.push('# EXP — Thesis Experience Memory');
      lines.push('');
      lines.push(`> Auto-generated from \`data/exp/trades.jsonl\`. ${this.records.length} records (cap ${this.cfg.maxRecords}).`);
      lines.push("> Each record = one closed trade's rationale combination + outcome.");
      lines.push('');
      // Summary stats
      const wins = this.records.filter((r) => r.outcome === 'WIN').length;
      const losses = this.records.length - wins;
      lines.push(`## Summary`);
      lines.push(`- Records: ${this.records.length} (WIN ${wins} / LOSS ${losses})`);
      lines.push('');
      // Recent records (newest first)
      lines.push(`## Recent Trades (newest first, max 50)`);
      const recent = [...this.records].reverse().slice(0, 50);
      for (const r of recent) {
        const icon = r.outcome === 'WIN' ? '✅' : '❌';
        const date = new Date(r.ts).toISOString();
        lines.push(`### ${icon} ${r.symbol} ${r.side.toUpperCase()} — ${r.outcome} — ${date}`);
        lines.push(`- source: ${r.source} · origin: ${r.decisionOrigin} · category: ${r.assetCategory}`);
        lines.push(`- PnL: ${r.pnl.toFixed(2)} (${(r.pnlPct * 100).toFixed(2)}%) · hold: ${r.holdMin}min · lev: ${r.leverage}x · regime: ${r.regime}`);
        lines.push(`- thesis: ${r.entryThesis}`);
        lines.push(`- rationales: ${r.rationales.map((p, i) => `[${r.rationaleCats[i] ?? '?'}] ${p}`).join(' | ')}`);
        lines.push('');
      }
      writeFileSync(this.cfg.expMdPath, lines.join('\n'), 'utf-8');
    } catch (err) {
      log.warn(`[EXP] renderEXPmd failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Rationale extraction (LLM, §5)
  // ═══════════════════════════════════════════════════════════

  async extractRationales(thesis: string): Promise<RationaleItem[]> {
    const cleaned = thesis.trim();
    if (cleaned.length === 0) return [];
    try {
      const content = await this.llm.chat(
        [
          {
            role: 'system',
            content:
              'You extract individual, atomic rationales from a trading entry thesis. ' +
              'Split the thesis into its distinct reasoning points (one per claim). ' +
              'Each rationale should be a self-contained sentence. ' +
              'Categorise each as one of: technical, fundamental, news, macro, flow, sentiment, pattern, other. ' +
              'Respond ONLY with JSON: {"rationales":[{"point":"...","category":"technical"}]}. ' +
              'Stable, deterministic output — same thesis must yield the same split.',
          },
          { role: 'user', content: `Thesis: "${cleaned}"\n\nExtract the atomic rationales as JSON.` },
        ],
        { temperature: 0, timeoutMs: 20_000 },
      );
      const parsed = extractJSON(content) as { rationales?: Array<{ point?: string; category?: string }> };
      const arr = Array.isArray(parsed.rationales) ? parsed.rationales : [];
      const items: RationaleItem[] = arr
        .filter((x) => x && typeof x.point === 'string' && x.point!.trim().length > 0)
        .map((x) => ({
          point: x.point!.trim(),
          category: normaliseCategory(x.category),
        }));
      if (items.length === 0) throw new Error('extractor returned no rationales');
      return items;
    } catch (err) {
      log.warn(`[EXP] extractRationales LLM failed → heuristic split: ${err instanceof Error ? err.message : String(err)}`);
      return heuristicSplit(cleaned);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Write path — recordClose (§6)
  // ═══════════════════════════════════════════════════════════

  async recordClose(input: RecordCloseInput): Promise<ThesisExperienceRecord | null> {
    if (!this.cfg.enabled) return null;
    if (isThesisPlaceholder(input.entryThesis)) return null;
    // breakeven exclude (Master Lord 漏問一)
    if (this.cfg.breakevenIs === 'exclude' && input.pnl === 0) return null;
    try {
      let outcome: TradeOutcome;
      if (input.pnl === 0) {
        outcome = this.cfg.breakevenIs === 'loss' ? 'LOSS' : 'WIN';
      } else {
        outcome = input.pnl > 0 ? 'WIN' : 'LOSS';
      }

      const rationales = await this.extractRationales(input.entryThesis);
      let rationaleVectors: number[][] = [];
      if (rationales.length > 0) {
        try {
          rationaleVectors = await this.embed.embed(rationales.map((r) => r.point));
        } catch (err) {
          log.warn(`[EXP] recordClose embed failed — storing empty vectors: ${err instanceof Error ? err.message : String(err)}`);
          rationaleVectors = [];
        }
      }

      const record: ThesisExperienceRecord = {
        id: `exp-${uuidv4()}`,
        ts: Date.now(),
        symbol: input.symbol,
        side: input.side,
        source: input.source,
        decisionOrigin: input.decisionOrigin,
        outcome,
        pnl: input.pnl,
        pnlPct: input.pnlPct,
        entry: input.entry,
        exit: input.exit,
        leverage: input.leverage,
        holdMin: input.holdMin,
        regime: input.regime,
        assetCategory: assetCategory(input.symbol, this.cfg.assetCategoryMap),
        entryThesis: input.entryThesis,
        rationales: rationales.map((r) => r.point),
        rationaleCats: rationales.map((r) => r.category),
        rationaleVectors,
        // v2.0.143: Store exit type for RIL CloseReasonAggregator
        // v2.0.720: If lessonExitType (fine-grained from digester) is provided,
        // use it to override the coarse exitType. This ensures premature_sl /
        // correct_sl etc. flow into CloseReasonAggregator so its premature
        // warning logic actually fires. Falls back to coarse exitType if absent.
        exitType: input.lessonExitType ?? input.exitType,
        // v2.0.178: Store market conditions + fusion predictions at entry time
        marketFeatures: input.marketFeatures,
        olrPWinAtEntry: input.olrPWinAtEntry,
        shadowWinRateAtEntry: input.shadowWinRateAtEntry,
      };

      this.appendRecordToDisk(record);
      this.records.push(record);
      // Rolling cap in memory
      if (this.records.length > this.cfg.maxRecords) {
        this.records = this.records.slice(-this.cfg.maxRecords);
      }
      this.renderEXPmd();
      // v2.0.140: incremental class update (non-blocking) — digest + embed the
      // new trade into its lesson class so the next checkThesisHistory can
      // classify against it.
      // v2.0.720: Pass a callback that writes the digester's fine-grained
      // exitType (premature_sl, correct_sl, etc.) back to the in-memory record.
      // This bridges the A2A digester into RIL's CloseReasonAggregator.
      // Note: we only update the in-memory record (not disk) because JSONL is
      // append-only — on restart, the digester's rebuildClasses will re-digest
      // and re-derive the fine-grained exitType. This avoids duplicate JSONL lines.
      void this.digester.addRecord(record, (lessonExitType) => {
        if (!lessonExitType) return;
        // Map LessonStatement.exitType → ExitType
        // 'thesis_invalidated' (LessonStatement) → 'thesis_invalidation' (ExitType)
        // The other 4 values (premature_sl, premature_tp, correct_sl, correct_tp) are shared.
        const mappedExitType: ExitType | undefined = lessonExitType === 'thesis_invalidated'
          ? 'thesis_invalidation'
          : (lessonExitType as ExitType);
        // Only override if the record currently has a coarse exitType (not already fine-grained)
        if (record.exitType && !COARSE_EXIT_TYPES.has(record.exitType)) return;
        record.exitType = mappedExitType;
        log.info(`[EXP-digest] Wrote back fine-grained exitType="${mappedExitType}" for ${record.symbol} ${record.side} (in-memory only)`);
      }).catch((err: unknown) =>
        log.warn(`[EXP-digest] addRecord failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`),
      );
      log.info(`[EXP] recorded ${outcome} ${input.symbol} ${input.side.toUpperCase()} (${rationales.length} rationales) — memory ${this.records.length}`);
      return record;
    } catch (err) {
      // NEVER block the close path
      log.warn(`[EXP] recordClose failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Read path — checkThesisHistory (§8.2 / §8.4 / §8.6)
  // ═══════════════════════════════════════════════════════════

  async checkThesisHistory(
    input: CheckThesisInput,
    _repairAttempted = false,
  ): Promise<ExpCheckResult> {
    if (!this.cfg.enabled) return { verdict: 'EXP_DISABLED' };
    // Valid "no history" state — EXP works, just empty
    if (!this.loaded || this.records.length === 0) {
      return { verdict: 'PASS_OPEN_DIRECTLY', reason: 'EXP memory empty — no history to match' };
    }

    // v2.0.140: A2A Experience Classification (Master Lord's core request).
    // FIRST, digest the candidate into a lesson vector and classify it against
    // the clustered experience classes. This captures the SEMANTIC lesson
    // (why similar setups lost/won) rather than raw rationale wording. If a
    // class matches with enough members, emit a verdict here and skip the
    // raw-rationale similarity path. If no class matches (cold-start / sparse),
    // fall through to the existing raw similarity + delta logic.
    this.lastSemanticVerdict = null; // reset for this check
    if (this.digester.getCfg().enabled) {
      try {
        const candCat = assetCategory(input.symbol, this.cfg.assetCategoryMap);
        const cls = await this.digester.classifyCandidate(
          input.thesis, input.symbol, input.side, input.marketCtx, candCat,
        );
        if (cls.bestClass) {
          const c = cls.bestClass;
          const simPct = (cls.similarity * 100).toFixed(0);
          if (cls.classWinRate >= this.digester.getCfg().classWinThreshold && cls.directionAligned) {
            // v2.0.721: Gate FAST_APPROVE on Wilson 95% lower bound, not raw classWinRate.
            // A 2/2 class (raw 1.0) has Wilson LB ~0.45 — not enough to trust.
            // This prevents small-sample overconfidence from auto-approving trades.
            const wilsonLB = wilsonScore(c.wins, c.count);
            if (wilsonLB < this.digester.getCfg().classWinThreshold) {
              // Wilson says not enough evidence — fall through to raw similarity path
              log.info(`[EXP] Semantic class matched but Wilson LB=${(wilsonLB * 100).toFixed(0)}% < threshold ${(this.digester.getCfg().classWinThreshold * 100).toFixed(0)}% (${c.wins}W/${c.count} total) — deferring to raw similarity`);
            } else {
              this.lastSemanticVerdict = {
                verdict: 'FAST_APPROVE',
                pWin: cls.classWinRate,
                reason: `classified to winning lesson class [${c.count} trades, win ${(c.winRate * 100).toFixed(0)}%, Wilson LB ${(wilsonLB * 100).toFixed(0)}%, ${c.directionBias}] (sim ${simPct}%): ${c.lesson}`,
              };
              return this.lastSemanticVerdict;
            }
          }
          if (cls.classWinRate < this.digester.getCfg().classLossThreshold && cls.directionAligned) {
            // Repeating a LOSING setup class in the SAME direction — reject.
            // This directly answers Master Lord's "learn why it keeps losing":
            // the candidate matches a clustered losing pattern (e.g. quick-close
            // churn / SELL-near-resistance-FUD-misread) and keeps that direction.
            this.lastSemanticVerdict = {
              verdict: 'REJECT',
              matchedLossId: c.memberIds[0],
              reason: `classified to LOSING lesson class [${c.count} trades, win ${(c.winRate * 100).toFixed(0)}%, avg ${c.avgHoldMin.toFixed(0)}min, ${c.directionBias}] (sim ${simPct}%): ${c.lesson}. Avoid repeating this losing pattern.`,
            };
            return this.lastSemanticVerdict;
          }
          // Ambiguous band OR opposite-direction match (may be a contrarian
          // edge) → let it trade; the raw path below will still run as a tie-break.
          // (We do NOT short-circuit here; fall through to raw similarity which
          // can still FAST_APPROVE / delta / reverse.)
        }
      } catch (err) {
        log.warn(`[EXP-digest] classification failed — falling through to raw similarity: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // v2.0.140: Dual-Channel Fusion — cross-reference semantic verdict
    // against statistical channels (OLR P(win) + shadow win rate) to resolve
    // disagreements. The semantic channel (MiniLM) learns from real/paper
    // closed trades, which are polluted by premature closes — it may REJECT
    // a setup that is actually profitable (direction correct, exit wrong).
    // The statistical channels (OLR + shadow) use fixed SL/TP outcomes that
    // are NOT polluted by premature closes. When they disagree with the
    // semantic channel, the fusion layer resolves the conflict.
    const olrPWin = input.olrPWin;
    const shadowWR = input.shadowWinRate;
    if (olrPWin !== undefined || shadowWR !== undefined) {
      const lastVerdict = this.lastSemanticVerdict;
      if (lastVerdict) {
        const statWin = olrPWin ?? shadowWR ?? 0.5;
        const shadowConfirm = shadowWR !== undefined && shadowWR > 0.50;
        const olrConfirm = olrPWin !== undefined && olrPWin > 0.50;

        // Rule 1: Semantic REJECT + Statistical WIN → premature close, not bad direction
        if (lastVerdict.verdict === 'REJECT' && (olrConfirm || shadowConfirm)) {
          log.info(`[EXP-fusion] REJECT overridden → PASS: semantic reject but OLR P(win)=${olrPWin !== undefined ? (olrPWin * 100).toFixed(0) + '%' : 'N/A'} shadow WR=${shadowWR !== undefined ? (shadowWR * 100).toFixed(0) + '%' : 'N/A'} — real-trade loss was from premature close, not bad entry`);
          return {
            verdict: 'PASS_OPEN_DIRECTLY',
            reason: `Dual-Channel Fusion: semantic REJECT overridden by statistical channel (OLR P(win)=${olrPWin !== undefined ? (olrPWin * 100).toFixed(0) + '%' : 'N/A'}, shadow WR=${shadowWR !== undefined ? (shadowWR * 100).toFixed(0) + '%' : 'N/A'}). The real-trade loss was from premature close, not bad direction. Let it trade with wider SL.`,
          };
        }

        // Rule 2: Semantic FAST_APPROVE + Statistical LOSE → semantic class may be overfitted
        if ((lastVerdict.verdict === 'FAST_APPROVE' || lastVerdict.verdict === 'APPROVE_WITH_NOTE')
            && olrPWin !== undefined && olrPWin < 0.40
            && shadowWR !== undefined && shadowWR < 0.40) {
          log.info(`[EXP-fusion] APPROVE cautioned → PASS: semantic approve but OLR P(win)=${(olrPWin * 100).toFixed(0)}% shadow WR=${(shadowWR * 100).toFixed(0)}% — winning class may be overfitted to small sample`);
          return {
            verdict: 'PASS_OPEN_DIRECTLY',
            reason: `Dual-Channel Fusion: semantic APPROVE cautioned by statistical channel (OLR P(win)=${(olrPWin * 100).toFixed(0)}%, shadow WR=${(shadowWR * 100).toFixed(0)}%). The winning class may be overfitted to a small sample. Let it trade but monitor.`,
          };
        }

        // Rule 3: Both channels agree LOSE → strong reject (no override needed)
        // Rule 4: Both channels agree WIN → strong approve (no override needed)
        // These fall through to the existing verdict.
      }
    }

    let candRationales: RationaleItem[];
    let candVectors: number[][];
    try {
      candRationales = await this.extractRationales(input.thesis);
      if (candRationales.length === 0) throw new Error('no rationales extracted');
      candVectors = await this.embed.embed(candRationales.map((r) => r.point));
      if (candVectors.length === 0 || candVectors.some((v) => v.length === 0)) {
        throw new Error('embed returned empty vectors');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const diag = this.diagnoseError(err);
      // §8.6: diagnose → repair → retry → record incident
      if (_repairAttempted || !this.cfg.repair.enabled) {
        this.recordFallbackIncident(diag, msg, { fixed: false, degraded: false, resolvedBy: 'none' }, 'EXP_ERRORED', false);
        return { verdict: 'EXP_ERRORED', errorType: diag, error: msg };
      }
      const repair = await this.skepticsAttemptRepair(diag, msg);
      const finalVerdict: ExpVerdict = repair.fixed || repair.degraded ? 'PASS_OPEN_DIRECTLY' : 'EXP_ERRORED';
      this.recordFallbackIncident(diag, msg, repair, finalVerdict, repair.fixed || repair.degraded);
      if (repair.fixed || repair.degraded) {
        return this.checkThesisHistory(input, true);
      }
      return { verdict: 'EXP_ERRORED', errorType: diag, error: msg };
    }

    const candCategory = assetCategory(input.symbol, this.cfg.assetCategoryMap);

    // v2.0.143: Store candidate vectors for SimilarTradeRetriever (HACP reads
    // them via getLastCandidateVectors() after checkThesisHistory returns).
    this.lastCandidateVectors = candVectors;

    // Combination similarity vs every historical record
    // v2.0.175: Split matches by direction — a SELL candidate should be
    // compared against historical SELL records, not BUY records. Previously
    // all matches were pooled together, so a SELL "distribution-hype" thesis
    // could match a BUY "accumulation" thesis (both mention ETF, price, SKHX)
    // and the BUY wins would inflate pWin, masking the SELL losses.
    const sameDirMatches: Array<{ rec: ThesisExperienceRecord; sim: number }> = [];
    const allMatches: Array<{ rec: ThesisExperienceRecord; sim: number }> = [];
    // v2.0.721: Condition-based filtering — if candidate provides regime and/or
    // volatility, filter historical records to similar market conditions.
    // Falls back to all records if no condition-matched records exist (zero regression).
    const candRegime = input.regime;
    const candVol = input.volatility;
    const conditionMatched: Array<{ rec: ThesisExperienceRecord; sim: number }> = [];
    for (const h of this.records) {
      if (h.rationaleVectors.length === 0) continue;
      const sim = combinationSimilarity(candVectors, h.rationaleVectors, this.cfg.similarityMode);
      if (sim >= this.cfg.matchThreshold) {
        allMatches.push({ rec: h, sim });
        if (h.side === input.side) {
          sameDirMatches.push({ rec: h, sim });
        }
        // v2.0.721: Track condition-matched records separately
        if (candRegime || (candVol !== undefined && candVol > 0)) {
          let conditionOk = true;
          if (candRegime && h.regime.toLowerCase() !== candRegime.toLowerCase()) conditionOk = false;
          if (candVol !== undefined && candVol > 0 && h.marketFeatures) {
            const histVol = h.marketFeatures['volatility'] ?? 0;
            if (histVol > 0) {
              // ±50% volatility band — allows some variation while excluding
              // radically different regimes (e.g. 0.01 vs 0.05 volatility)
              const volRatio = Math.abs(histVol - candVol) / Math.max(candVol, histVol);
              if (volRatio > 0.5) conditionOk = false;
            }
          }
          if (conditionOk) {
            conditionMatched.push({ rec: h, sim });
          }
        }
      }
    }

    // v2.0.721: Use condition-matched records if available, otherwise fall back
    // to all matches (preserves existing behavior when no condition data provided).
    const effectiveAllMatches = conditionMatched.length > 0 ? conditionMatched : allMatches;
    const effectiveSameDir = effectiveAllMatches.filter((m) => m.rec.side === input.side);

    if (effectiveAllMatches.length === 0) {
      return { verdict: 'PASS_OPEN_DIRECTLY', reason: 'no historical combination above match threshold — let it trade & learn' };
    }

    // v2.0.175: Use same-direction matches for pWin calculation. If there are
    // same-direction matches, they are more predictive than cross-direction
    // matches. Fall back to all matches only if no same-direction matches exist
    // (cold-start for this direction).
    // v2.0.721: Use effective (condition-filtered) matches.
    const pWinMatches = effectiveSameDir.length > 0 ? effectiveSameDir : effectiveAllMatches;

    // Similarity-weighted P(win) — same direction only
    // v2.0.721: Soft asset-category weighting — same-category matches get 1.2×
    // weight, cross-category get 0.8×. This reduces cross-asset pollution
    // (BTC thesis matching XAU records) without hard-filtering (which would
    // return empty for small categories).
    const SAME_CAT_WEIGHT = 1.2;
    const CROSS_CAT_WEIGHT = 0.8;
    let totalW = 0;
    let winW = 0;
    for (const m of pWinMatches) {
      const isSameCat = m.rec.assetCategory === candCategory;
      const catWeight = isSameCat ? SAME_CAT_WEIGHT : CROSS_CAT_WEIGHT;
      const weightedSim = m.sim * catWeight;
      totalW += weightedSim;
      if (m.rec.outcome === 'WIN') winW += weightedSim;
    }
    const rawPWin = totalW > 0 ? winW / totalW : 0.5;

    // v2.0.722: Use Wilson score lower bound for pWin, not raw winRate.
    // The raw pWin (similarity-weighted win rate) is still computed for logging
    // and for the delta check, but the verdict thresholds are gated on the
    // Wilson 95% lower bound of the direction-filtered match count.
    // This prevents small-sample overconfidence: 2/3 matches (raw 66.7%) has
    // Wilson LB ~0.12 — far below any threshold, so the system will fall through
    // to the delta check instead of emitting a false positive FAST_APPROVE.
    const pWinWins = pWinMatches.filter((m) => m.rec.outcome === 'WIN').length;
    const pWinTotal = pWinMatches.length;
    const pWinWilsonLB = wilsonScore(pWinWins, pWinTotal);

    // v2.0.722: Use Wilson LB as the primary pWin for verdict decisions.
    // The raw pWin is still returned for logging/analytics but the verdict
    // thresholds are applied to the Wilson LB, which is always <= raw pWin
    // and penalizes small samples naturally.
    const verdictPWin = pWinWilsonLB;

    // v2.0.175: Log the direction-specific stats for debugging
    if (effectiveSameDir.length > 0) {
      const sameDirWins = effectiveSameDir.filter((m) => m.rec.outcome === 'WIN').length;
      const sameDirLosses = effectiveSameDir.filter((m) => m.rec.outcome === 'LOSS').length;
      const condStr = conditionMatched.length > 0 ? ` (condition-filtered: ${conditionMatched.length}/${allMatches.length})` : '';
      log.info(`[EXP] ${input.side.toUpperCase()} ${input.symbol}: ${effectiveSameDir.length} same-dir matches (${sameDirWins}W/${sameDirLosses}L, rawPWin=${rawPWin.toFixed(2)}, WilsonLB=${pWinWilsonLB.toFixed(2)}) vs ${effectiveAllMatches.length} total matches${condStr}`);
    }

    if (verdictPWin >= this.cfg.winProbThreshold) {
      return { verdict: 'FAST_APPROVE', pWin: verdictPWin, reason: `history skews WIN (raw pWin=${rawPWin.toFixed(2)}, Wilson LB=${pWinWilsonLB.toFixed(2)}, ${pWinWins}W/${pWinTotal} same-dir matches)` };
    }
    if (verdictPWin >= this.cfg.lossProbThreshold) {
      // Ambiguous band → 直出 — use Wilson LB instead of raw pWin to avoid
      // small-sample overconfidence in the ambiguous band. A raw pWin of 0.60
      // with 3/5 matches (Wilson LB ~0.23) should not be treated as ambiguous
      // — it should be treated as insufficient evidence (fall through to delta).
      return { verdict: 'PASS_OPEN_DIRECTLY', pWin: verdictPWin, reason: `ambiguous (raw pWin=${rawPWin.toFixed(2)}, Wilson LB=${pWinWilsonLB.toFixed(2)}, ${pWinWins}W/${pWinTotal} same-dir matches)` };
    }

    // P(loss) > P(win) → delta check (§8.4)
    // v2.0.747: Use Wilson score for delta computation instead of raw winRate.
    // The delta = sameDirPWin - crossDirPWin now uses wilsonScore() for both
    // same-direction and cross-direction matches. This prevents small-sample
    // overconfidence where 3/5 (60% raw) was treated equally to 30/50 (60% raw).
    // Wilson score penalizes small samples: 3/5 → ~25%, 30/50 → ~47%.
    // This fixes systematically losing patterns like BUY SKHX (30% WR over 33
    // trades) and BUY BTC (38% WR over 40 trades) where EXP was too permissive
    // due to inflated pWin from small-sample historical matches.
    //
    // Compute same-direction and cross-direction Wilson scores for the delta.
    // The delta is the difference between the Wilson LB of same-direction matches
    // and the Wilson LB of cross-direction matches. A positive delta means the
    // same-direction evidence is stronger than cross-direction evidence.
    const sameDirWins = effectiveSameDir.filter((m) => m.rec.outcome === 'WIN').length;
    const sameDirTotal = effectiveSameDir.length;
    const crossDirWins = effectiveAllMatches
      .filter((m) => m.rec.side !== input.side && m.rec.outcome === 'WIN').length;
    const crossDirTotal = effectiveAllMatches.filter((m) => m.rec.side !== input.side).length;
    
    const sameDirWilsonLB = sameDirTotal > 0 ? wilsonScore(sameDirWins, sameDirTotal) : 0.5;
    const crossDirWilsonLB = crossDirTotal > 0 ? wilsonScore(crossDirWins, crossDirTotal) : 0.5;
    const delta = sameDirWilsonLB - crossDirWilsonLB;
    
    // Log the delta computation for debugging
    log.info(`[EXP] delta: sameDir=${sameDirWins}W/${sameDirTotal} (WilsonLB=${sameDirWilsonLB.toFixed(3)}) vs crossDir=${crossDirWins}W/${crossDirTotal} (WilsonLB=${crossDirWilsonLB.toFixed(3)}) → delta=${delta.toFixed(3)}`);
    
    // If delta is positive (same-direction evidence stronger), approve.
    // If delta is negative (cross-direction evidence stronger), reject.
    // If delta is near zero (insufficient evidence), fall through to delta check.
    if (delta > this.cfg.deltaThreshold) {
      return { verdict: 'FAST_APPROVE', pWin: sameDirWilsonLB, reason: `same-direction Wilson LB=${sameDirWilsonLB.toFixed(3)} > cross-direction Wilson LB=${crossDirWilsonLB.toFixed(3)} (delta=${delta.toFixed(3)}) — same-direction evidence stronger` };
    }
    if (delta < -this.cfg.deltaThreshold) {
      return { verdict: 'REJECT', reason: `cross-direction Wilson LB=${crossDirWilsonLB.toFixed(3)} > same-direction Wilson LB=${sameDirWilsonLB.toFixed(3)} (delta=${delta.toFixed(3)}) — cross-direction evidence stronger` };
    }
    
    // v2.0.175: Use same-direction loss matches for delta check
    const lossMatches = pWinMatches.filter((m) => m.rec.outcome === 'LOSS').sort((a, b) => b.sim - a.sim);
    return this.assessExtraRationale(candRationales, candVectors, candCategory, lossMatches, input);
  }

  // ═══════════════════════════════════════════════════════════
  //  Delta check (§8.4) — cross-category + reverse + multi-delta extremeness
  // ═══════════════════════════════════════════════════════════

  private async assessExtraRationale(
    candRationales: RationaleItem[],
    candVectors: number[][],
    candCategory: AssetCategory,
    lossMatches: Array<{ rec: ThesisExperienceRecord; sim: number }>,
    input: CheckThesisInput,
  ): Promise<ExpCheckResult> {
    if (lossMatches.length === 0) {
      return { verdict: 'PASS_OPEN_DIRECTLY', reason: 'no losing match' };
    }
    const bestLoss = lossMatches[0]!.rec;

    // delta = candidate rationales NOT in the best losing combo (cos < deltaThreshold)
    const deltaItems: Array<{ idx: number; item: RationaleItem; vec: number[] }> = [];
    for (let i = 0; i < candVectors.length; i++) {
      let bestCos = -Infinity;
      for (const hv of bestLoss.rationaleVectors) {
        const c = cosine(candVectors[i]!, hv);
        if (c > bestCos) bestCos = c;
      }
      if (bestCos < this.cfg.deltaThreshold) {
        deltaItems.push({ idx: i, item: candRationales[i]!, vec: candVectors[i]! });
      }
    }

    if (deltaItems.length === 0) {
      return { verdict: 'REJECT', reason: 'same losing combo, no delta rationale', matchedLossId: bestLoss.id };
    }

    // Classify each delta + compute extremeness = |winRate − 0.5| (§15-5)
    type Signal = 'approve-strong' | 'approve-weak' | 'reverse' | 'none';
    interface DeltaSignal { signal: Signal; extremeness: number; winRate: number; item: RationaleItem; vec: number[]; }
    const signals: DeltaSignal[] = [];

    for (const d of deltaItems) {
      // v2.0.176: Filter by direction — delta win rates must be same-direction.
      // A delta rationale that wins as BUY but loses as SELL must not produce
      // an approve signal for a SELL candidate.
      // Fall back to all records if no same-direction records exist (cold-start
      // for this direction — same logic as pWin fallback above).
      const sameDirContaining = this.records.filter((h) =>
        h.side === input.side &&
        h.rationaleVectors.some((hv) => cosine(d.vec, hv) >= this.cfg.matchThreshold),
      );
      const containing = sameDirContaining.length > 0 ? sameDirContaining : this.records.filter((h) =>
        h.rationaleVectors.some((hv) => cosine(d.vec, hv) >= this.cfg.matchThreshold),
      );
      if (containing.length < this.cfg.minDeltaSamples) {
        signals.push({ signal: 'none', extremeness: 0, winRate: 0.5, item: d.item, vec: d.vec });
        continue;
      }
      const sameCat = containing.filter((h) => h.assetCategory === candCategory);
      const winRateAll = containing.filter((h) => h.outcome === 'WIN').length / containing.length;
      const winRateSame: number | null = sameCat.length >= this.cfg.minDeltaSamples
        ? sameCat.filter((h) => h.outcome === 'WIN').length / sameCat.length
        : null;

      // (1) same-cat positive
      if (winRateSame !== null && winRateSame >= this.cfg.deltaWinRateThreshold) {
        signals.push({ signal: 'approve-strong', extremeness: winRateSame - 0.5, winRate: winRateSame, item: d.item, vec: d.vec });
      } else if (winRateAll >= this.cfg.deltaWinRateThreshold) {
        // (2) cross-cat positive (winRateSame null or below threshold)
        signals.push({ signal: 'approve-weak', extremeness: winRateAll - 0.5, winRate: winRateAll, item: d.item, vec: d.vec });
      } else if (winRateAll < this.cfg.deltaLossRateThreshold) {
        // (3) negative
        signals.push({ signal: 'reverse', extremeness: 0.5 - winRateAll, winRate: winRateAll, item: d.item, vec: d.vec });
      } else {
        signals.push({ signal: 'none', extremeness: 0, winRate: winRateAll, item: d.item, vec: d.vec });
      }
    }

    // §15-5: most extreme delta wins
    const ranked = [...signals].sort((a, b) => b.extremeness - a.extremeness);
    const top = ranked[0]!;

    if (top.signal === 'none') {
      // All deltas have no/ambiguous history → 直出 (Master Lord: no history → let it trade)
      return { verdict: 'PASS_OPEN_DIRECTLY', reason: 'delta rationale has no/ambiguous history → let it trade & learn' };
    }
    if (top.signal === 'approve-strong') {
      return {
        verdict: 'APPROVE_WITH_NOTE',
        reason: `losing combo + same-category delta w/ positive history (winRate=${top.winRate.toFixed(2)})`,
        extraRationale: top.item.point,
      };
    }
    if (top.signal === 'approve-weak') {
      // cross-cat positive → require one more rationale (§8.4a)
      return this.requireOneMoreRationale(candRationales, top.item, input);
    }
    // reverse
    return this.assessReverseDirection(top.item, bestLoss, input);
  }

  // ═══════════════════════════════════════════════════════════
  //  §8.4a — cross-category positive delta → require one more rationale
  // ═══════════════════════════════════════════════════════════

  private async requireOneMoreRationale(
    candRationales: RationaleItem[],
    crossCatDelta: RationaleItem,
    input: CheckThesisInput,
  ): Promise<ExpCheckResult> {
    try {
      const otherRationales = candRationales
        .filter((r) => r.point !== crossCatDelta.point)
        .map((r) => r.point)
        .join(' | ');
      const content = await this.llm.chat(
        [
          {
            role: 'system',
            content:
              'A trading thesis has a cross-asset-category rationale that historically won in a DIFFERENT asset class ' +
              '(e.g. won on XAU/commodity, now applied to BTC/crypto). Cross-category evidence is weaker. ' +
              'Examine the OTHER rationales in the thesis + the market context and determine if there is ONE additional ' +
              'supporting rationale that strengthens the case for THIS asset. ' +
              'Respond ONLY with JSON: {"found":true/false,"rationale":"...","point":"...","category":"technical"}.',
          },
          {
            role: 'user',
            content:
              `Candidate side: ${input.side.toUpperCase()} ${input.symbol}\n` +
              `Cross-category delta (won elsewhere): ${crossCatDelta.point}\n` +
              `Other rationales in thesis: ${otherRationales || '(none)'}\n` +
              `Market context (abridged): ${input.marketCtx.slice(0, 1200)}\n\n` +
              `Is there one additional supporting rationale for THIS asset?`,
          },
        ],
        { temperature: 0, timeoutMs: 25_000 },
      );
      const parsed = extractJSON(content) as { found?: boolean; point?: string; rationale?: string };
      if (parsed.found === true && typeof parsed.point === 'string' && parsed.point.trim().length > 0) {
        return {
          verdict: 'APPROVE_WITH_NOTE',
          reason: `cross-category delta + one additional supporting rationale found`,
          extraRationale: parsed.point.trim(),
        };
      }
      // Master Lord §15-4: cross-cat positive + no extra → REJECT
      return { verdict: 'REJECT', reason: 'cross-category positive delta with no additional supporting rationale' };
    } catch (err) {
      log.warn(`[EXP] requireOneMoreRationale failed → conservative REJECT: ${err instanceof Error ? err.message : String(err)}`);
      return { verdict: 'REJECT', reason: `requireOneMoreRationale error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  §8.4b — negative delta → assessReverseDirection
  // ═══════════════════════════════════════════════════════════

  private async assessReverseDirection(
    negDelta: RationaleItem,
    bestLoss: ThesisExperienceRecord,
    input: CheckThesisInput,
  ): Promise<ExpCheckResult> {
    // v2.0.215: REVERSE_DIRECTION disabled — flipping BUY↔SELL based on historical
    // losses creates a dangerous feedback loop: lose in one direction → flip → lose
    // again → flip again → continuous flipping without learning. Instead, when delta
    // is negative, REJECT (→HOLD) and let the system wait for a better setup.
    // The direction filter and delta check remain intact — only the reverse action
    // is removed.
    return {
      verdict: 'REJECT',
      reason: `delta negative (losing rationale: "${negDelta.point.slice(0, 80)}") → REJECT instead of reverse (v2.0.215: reverse disabled to prevent direction-flipping feedback loop)`,
      matchedLossId: bestLoss.id,
    };
  }

  private async skepticsFindFurtherNegativeAndRisk(
    negDelta: RationaleItem,
    input: CheckThesisInput,
  ): Promise<{ furtherNegative: string[]; riskFactors: string[]; strong: boolean }> {
    const content = await this.llm.chat(
      [
        {
          role: 'system',
          content:
            'You are Skeptics. A rationale in the proposed thesis has historically LOST across multiple trades. ' +
            'Examine the market context for FURTHER negative signals and risk factors that confirm the original direction is wrong. ' +
            'Respond ONLY with JSON: {"furtherNegative":["..."],"riskFactors":["..."],"strong":true/false}. ' +
            'Set strong=true ONLY if there are concrete, specific further negatives OR risk factors (not speculative).',
        },
        {
          role: 'user',
          content:
            `Proposed: ${input.side.toUpperCase()} ${input.symbol}\n` +
            `Historically-losing rationale: ${negDelta.point}\n` +
            `Market context (abridged): ${input.marketCtx.slice(0, 1500)}\n\n` +
            `Identify further negative signals + risk factors. Is the evidence strong enough to reverse direction?`,
        },
      ],
      { temperature: 0, timeoutMs: 25_000 },
    );
    const parsed = extractJSON(content) as {
      furtherNegative?: string[]; riskFactors?: string[]; strong?: boolean;
    };
    const fn = Array.isArray(parsed.furtherNegative) ? parsed.furtherNegative.filter((s) => typeof s === 'string') : [];
    const rf = Array.isArray(parsed.riskFactors) ? parsed.riskFactors.filter((s) => typeof s === 'string') : [];
    return { furtherNegative: fn, riskFactors: rf, strong: parsed.strong === true };
  }

  private async skepticsBuildContrarianThesis(
    input: CheckThesisInput,
    reversedSide: 'buy' | 'sell',
    riskFactors: { furtherNegative: string[]; riskFactors: string[] },
  ): Promise<string> {
    const content = await this.llm.chat(
      [
        {
          role: 'system',
          content:
            'You are Skeptics. The original thesis has been invalidated by negative historical evidence + further risk factors. ' +
            'Build a concise CONTRARIAN entry thesis for the REVERSED direction, in the same [1h: ...] [1d: ...] format. ' +
            'Respond ONLY with JSON: {"thesis":"[1h: ...] [1d: ...]"}.',
        },
        {
          role: 'user',
          content:
            `Original proposal: ${input.side.toUpperCase()} ${input.symbol}\n` +
            `Original thesis: ${input.thesis}\n` +
            `Reversed direction: ${reversedSide.toUpperCase()}\n` +
            `Invalidating evidence: furtherNegatives=[${riskFactors.furtherNegative.join('; ')}] riskFactors=[${riskFactors.riskFactors.join('; ')}]\n\n` +
            `Build the contrarian thesis for ${reversedSide.toUpperCase()} ${input.symbol}.`,
        },
      ],
      { temperature: 0, timeoutMs: 25_000 },
    );
    const parsed = extractJSON(content) as { thesis?: string };
    const thesis = typeof parsed.thesis === 'string' ? parsed.thesis.trim() : '';
    if (thesis.length === 0) throw new Error('contrarian thesis empty');
    return thesis;
  }

  // ═══════════════════════════════════════════════════════════
  //  §8.6 — Fallback diagnose + repair + incident recording
  // ═══════════════════════════════════════════════════════════

  private diagnoseError(err: unknown): string {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes('embed') || msg.includes('pipeline') || msg.includes('onnx') || msg.includes('model')) return 'embed-load-fail';
    if (msg.includes('no rationales') || msg.includes('extract')) return 'llm-extract-fail';
    if (msg.includes('index') || msg.includes('load')) return 'index-load-fail';
    if (msg.includes('jsonl') || msg.includes('parse')) return 'jsonl-corrupt';
    return 'llm-extract-fail';
  }

  private async skepticsAttemptRepair(
    diag: string,
    _reason: string,
  ): Promise<{ fixed: boolean; degraded: boolean; resolvedBy: 'retry' | 'reload' | 'rebuild' | 'heuristic' | 'none'; note: string }> {
    try {
      switch (diag) {
        case 'embed-load-fail': {
          // Reload the embed pipeline
          await this.embed.warmup();
          if (this.embed.isReady()) return { fixed: true, degraded: false, resolvedBy: 'reload', note: 'embed pipeline reloaded' };
          return { fixed: false, degraded: false, resolvedBy: 'none', note: 'embed reload failed' };
        }
        case 'llm-extract-fail':
        case 'no-rationales': {
          // Retry once after backoff; LLM extraction already falls back to heuristic inside extractRationales,
          // so a second attempt mainly helps transient provider errors.
          await sleep(this.cfg.repair.backoffMs);
          return { fixed: false, degraded: true, resolvedBy: 'heuristic', note: 'heuristic split will be used on retry' };
        }
        case 'index-load-fail':
        case 'jsonl-corrupt': {
          // Salvage parse: reload skipping corrupt lines (load() already skips bad lines)
          this.load();
          if (this.loaded) return { fixed: true, degraded: false, resolvedBy: 'rebuild', note: `index salvaged (${this.records.length} records)` };
          return { fixed: false, degraded: false, resolvedBy: 'none', note: 'index salvage failed' };
        }
        default:
          return { fixed: false, degraded: false, resolvedBy: 'none', note: 'no repair strategy' };
      }
    } catch (err) {
      return { fixed: false, degraded: false, resolvedBy: 'none', note: `repair error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private recordFallbackIncident(
    errorType: string,
    reason: string,
    repair: { fixed: boolean; degraded: boolean; resolvedBy: string },
    finalVerdict: ExpVerdict,
    retried1_8a: boolean,
  ): void {
    const incident: ExpFallbackIncident = {
      ts: Date.now(),
      errorType,
      reason: reason.slice(0, 300),
      repairResult: repair.fixed ? 'fixed' : repair.degraded ? 'degraded' : 'failed',
      resolvedBy: repair.resolvedBy as ExpFallbackIncident['resolvedBy'],
      retried1_8a,
      finalVerdict,
    };
    this.appendIncidentToDisk(incident);
    log.warn(`[EXP] fallback incident: ${errorType} → ${incident.repairResult} (${repair.resolvedBy}) final=${finalVerdict}`);
  }

  // ── test scaffolding helpers ──

  /** Directly inject a record (tests only — bypasses disk). */
  _injectRecord(record: ThesisExperienceRecord): void {
    this.records.push(record);
    if (this.records.length > this.cfg.maxRecords) {
      this.records = this.records.slice(-this.cfg.maxRecords);
    }
    this.loaded = true;
  }

  /** Get all records (tests only). */
  /** Get all records (for RIL / analytics). */
  getRecords(): ThesisExperienceRecord[] {
    return [...this.records];
  }

  _records(): ThesisExperienceRecord[] {
    return [...this.records];
  }
}

// ─── helpers ───

// v2.0.174: normaliseCat extracted to evolution-utils.ts

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}