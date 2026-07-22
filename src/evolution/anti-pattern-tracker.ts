/**
 * v2.0.207 (#F): Anti-Pattern Tracker — clusters HISTORICAL FAILURE lessons
 * into anti-pattern classes so the system can recognise "we keep losing the
 * same way" and warn Skeptics when a candidate resembles a known anti-pattern.
 *
 * Architecture:
 *   - Each closed LOSS with a distilled `lesson` is embedded (text) into a vector.
 *   - Lessons are clustered by cosine similarity (single-linkage, threshold 0.78).
 *   - Each AntiPatternClass holds: centroid, member record ids, count, avgPnl,
 *     dominant rootCause, top example lessons, side bias.
 *   - On a candidate thesis, matchCandidate() embeds the thesis and returns the
 *     top-N matching classes (cosine > 0.55) with their stats so Skeptics sees
 *     "this resembles anti-pattern #3: 'counter-momentum SELL stop-out' — 6
 *     historical losses, avg -7.2%".
 *
 * Persistence: data/evolution/anti-patterns.json (atomic). Rebuilt on load if
 * the lesson corpus changed.
 *
 * Cold-start safe: empty corpus → no classes → matchCandidate returns [] →
 * Skeptics context has no anti-pattern block. No hard veto.
 */
import { createLogger } from '../observability/logger.ts';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { cosine, type EmbedProvider } from './embeddings.ts';
import type { ThesisExperienceRecord } from '../types/index.ts';
import { ComboWinRateTracker } from './combo-win-rate-tracker.ts'; // v2.0.221 Fix 2: autoGenerateLesson

const log = createLogger({ phase: 'anti-pattern' });

const PERSIST_PATH = 'data/evolution/anti-patterns.json';
const CLUSTER_THRESHOLD = 0.78; // cosine to join an existing class
const MATCH_THRESHOLD = 0.55; // cosine to flag a candidate
const MIN_CLASS_SIZE = 2; // need ≥2 losses to form an anti-pattern

export interface AntiPatternClass {
  id: number;
  centroid: number[];
  memberIds: string[];
  count: number;
  avgPnl: number;
  dominantRootCause?: string;
  sideBias?: 'buy' | 'sell' | 'mixed';
  exampleLessons: string[]; // up to 3
  lastUpdated: number;
}

export interface AntiPatternMatch {
  classId: number;
  similarity: number;
  count: number;
  avgPnl: number;
  dominantRootCause?: string;
  sideBias?: string;
  exampleLesson: string;
}

export class AntiPatternTracker {
  private classes: AntiPatternClass[] = [];
  private dirty = false;
  /** record ids that have already been ingested (dedup) */
  private ingested = new Set<string>();
  private embedProvider: EmbedProvider | null = null;

  setEmbedProvider(p: EmbedProvider): void { this.embedProvider = p; }

  /**
   * Rebuild classes from a full corpus of records. Called on startup after
   * the embed provider is wired. Idempotent: re-running with the same corpus
   * produces the same classes.
   */
  async rebuild(records: ThesisExperienceRecord[]): Promise<void> {
    if (!this.embedProvider) return;
    // v2.0.221 (Fix 2): Auto-generate structural lessons for losses that have
    // no LLM-generated lesson. Previously 130/138 losses had no lesson → only
    // 8 qualified → 0 anti-pattern clusters. Now every loss gets at least a
    // structural lesson, so clustering actually works.
    const losses = records.filter(r => r.outcome === 'LOSS');
    if (losses.length === 0) { this.classes = []; this.dirty = true; return; }
    // Build lesson texts: use LLM lesson if present, else auto-generate structural.
    const lessonTexts = losses.map(r => {
      if (r.lesson && r.lesson.trim().length > 0) return r.lesson.slice(0, 500);
      return ComboWinRateTracker.autoGenerateLesson({
        symbol: r.symbol,
        side: r.side,
        regime: r.regime ?? 'unknown',
        holdMin: r.holdMin ?? 0,
        closeReason: (r as any).exitType ?? (r as any).closeReason ?? null,
        pnlPct: r.pnlPct ?? 0,
        hourOfDay: r.ts ? new Date(r.ts).getHours() : undefined,
      });
    });
    try {
      const vecs = await this.embedProvider.embed(lessonTexts);
      this.classes = [];
      this.ingested = new Set();
      for (let i = 0; i < losses.length; i++) {
        const rec = losses[i]!;
        const vec = vecs[i] ?? [];
        if (vec.length === 0) continue;
        // Ensure the record has a lesson for downstream use (matchCandidate display).
        if (!rec.lesson || rec.lesson.trim().length === 0) {
          rec.lesson = lessonTexts[i]!;
        }
        this.ingest(rec.id, vec, rec);
      }
      // Drop classes below min size (noise).
      this.classes = this.classes.filter(c => c.memberIds.length >= MIN_CLASS_SIZE);
      // Re-id.
      this.classes.forEach((c, i) => { c.id = i + 1; });
      this.dirty = true;
      const autoGen = losses.filter(r => !r.lesson || r.lesson.trim().length === 0).length;
      log.info(`[anti-pattern] Rebuilt ${this.classes.length} anti-pattern classes from ${losses.length} losses (${autoGen} auto-generated structural lessons)`);
    } catch (err) {
      log.warn(`[anti-pattern] rebuild failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Ingest one loss record incrementally (after a trade closes). */
  async addLoss(rec: ThesisExperienceRecord): Promise<void> {
    if (!this.embedProvider) return;
    if (rec.outcome !== 'LOSS') return;
    if (this.ingested.has(rec.id)) return;
    // v2.0.221 (Fix 2): Auto-generate structural lesson when LLM lesson is missing.
    let lessonText = rec.lesson && rec.lesson.trim().length > 0
      ? rec.lesson.slice(0, 500)
      : ComboWinRateTracker.autoGenerateLesson({
          symbol: rec.symbol,
          side: rec.side,
          regime: rec.regime ?? 'unknown',
          holdMin: rec.holdMin ?? 0,
          closeReason: (rec as any).exitType ?? (rec as any).closeReason ?? null,
          pnlPct: rec.pnlPct ?? 0,
          hourOfDay: rec.ts ? new Date(rec.ts).getHours() : undefined,
        });
    if (!rec.lesson || rec.lesson.trim().length === 0) {
      rec.lesson = lessonText; // persist for downstream display
    }
    try {
      const v = await this.embedProvider.embed([lessonText]);
      const vec = v[0] ?? [];
      if (vec.length === 0) return;
      this.ingest(rec.id, vec, rec);
      // Re-filter min size + re-id.
      this.classes = this.classes.filter(c => c.memberIds.length >= MIN_CLASS_SIZE);
      this.classes.forEach((c, i) => { c.id = i + 1; });
      this.dirty = true;
    } catch (err) {
      log.warn(`[anti-pattern] addLoss failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private ingest(id: string, vec: number[], rec: ThesisExperienceRecord): void {
    // Find best matching existing class.
    let best: AntiPatternClass | null = null;
    let bestSim = -Infinity;
    for (const c of this.classes) {
      const sim = cosine(vec, c.centroid);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= CLUSTER_THRESHOLD) {
      this.addToClass(best, id, vec, rec);
    } else {
      this.classes.push({
        id: 0,
        centroid: vec.slice(),
        memberIds: [id],
        count: 1,
        avgPnl: rec.pnlPct,
        dominantRootCause: rec.rootCause,
        sideBias: rec.side,
        exampleLessons: [rec.lesson!.slice(0, 200)],
        lastUpdated: Date.now(),
      });
    }
    this.ingested.add(id);
  }

  private addToClass(c: AntiPatternClass, id: string, vec: number[], rec: ThesisExperienceRecord): void {
    // Update centroid as running mean.
    const n = c.memberIds.length;
    for (let k = 0; k < c.centroid.length; k++) {
      c.centroid[k] = (c.centroid[k]! * n + (vec[k] ?? 0)) / (n + 1);
    }
    c.memberIds.push(id);
    c.count = c.memberIds.length;
    c.avgPnl = (c.avgPnl * n + rec.pnlPct) / (n + 1);
    // Dominant rootCause: keep the most frequent (simple: keep latest if tie).
    c.dominantRootCause = rec.rootCause ?? c.dominantRootCause;
    // Side bias.
    if (c.sideBias && c.sideBias !== rec.side && c.sideBias !== 'mixed') c.sideBias = 'mixed';
    else if (!c.sideBias) c.sideBias = rec.side;
    // Example lessons (keep most recent 3).
    c.exampleLessons = [rec.lesson!.slice(0, 200), ...c.exampleLessons].slice(0, 3);
    c.lastUpdated = Date.now();
  }

  /**
   * Match a candidate thesis against known anti-pattern classes.
   * Returns top-N classes with cosine > MATCH_THRESHOLD, sorted by similarity.
   */
  async matchCandidate(candidateThesis: string, topN = 3): Promise<AntiPatternMatch[]> {
    if (!this.embedProvider || this.classes.length === 0) return [];
    try {
      const v = await this.embedProvider.embed([candidateThesis.slice(0, 500)]);
      const vec = v[0] ?? [];
      if (vec.length === 0) return [];
      const matches: AntiPatternMatch[] = [];
      for (const c of this.classes) {
        const sim = cosine(vec, c.centroid);
        if (sim >= MATCH_THRESHOLD) {
          matches.push({
            classId: c.id,
            similarity: sim,
            count: c.count,
            avgPnl: c.avgPnl,
            dominantRootCause: c.dominantRootCause,
            sideBias: c.sideBias,
            exampleLesson: c.exampleLessons[0] ?? '',
          });
        }
      }
      return matches.sort((a, b) => b.similarity - a.similarity).slice(0, topN);
    } catch (err) {
      log.warn(`[anti-pattern] matchCandidate failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Number of anti-pattern classes (clusters) learned from loss corpus. */
  getClusterCount(): number {
    return this.classes.length;
  }

  /** Total ingested loss records (dedup count). */
  getIngestedCount(): number {
    return this.ingested.size;
  }

  /** Summary stats for monitoring / API display. */
  getStats(): { clusterCount: number; ingestedCount: number; totalMembers: number } {
    return {
      clusterCount: this.classes.length,
      ingestedCount: this.ingested.size,
      totalMembers: this.classes.reduce((sum, c) => sum + c.memberIds.length, 0),
    };
  }

  /** Format matches into a Skeptics context block. */
  formatBlock(matches: AntiPatternMatch[]): string {
    if (matches.length === 0) return '';
    const lines = matches.map(m =>
      `  • Anti-pattern #${m.classId} [${(m.similarity * 100).toFixed(0)}% match]: ${m.dominantRootCause ?? 'unknown'} — ${m.count} historical losses, avg ${(m.avgPnl * 100).toFixed(1)}%${m.sideBias ? ` (${m.sideBias.toUpperCase()} bias)` : ''}. Example: "${m.exampleLesson.slice(0, 120)}"`,
    );
    return `\n=== 🚨 ANTI-PATTERN MATCH (you have lost this way before) ===\n${lines.join('\n')}\nIf this candidate resembles the above anti-pattern, you MUST explain how it differs — or REJECT. Repeating a known anti-pattern is worse than a novel loss.\n---`;
  }

  persist(path: string = PERSIST_PATH): void {
    if (!this.dirty) return;
    try {
      const obj = { classes: this.classes, ingested: [...this.ingested], savedAt: Date.now() };
      const tmp = path + '.tmp';
      writeFileSync(tmp, JSON.stringify(obj));
      renameSync(tmp, path);
      this.dirty = false;
    } catch (err) {
      log.warn(`[anti-pattern] persist failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  load(path: string = PERSIST_PATH): void {
    try {
      if (!existsSync(path)) return;
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (Array.isArray(data.classes)) this.classes = data.classes;
      if (Array.isArray(data.ingested)) this.ingested = new Set(data.ingested);
      log.info(`[anti-pattern] Loaded ${this.classes.length} anti-pattern classes (${this.ingested.size} ingested)`);
    } catch (err) {
      log.warn(`[anti-pattern] load failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}