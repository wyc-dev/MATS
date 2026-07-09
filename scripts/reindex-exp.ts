// ─── EXP Reindex Script (v2.0.138) ───
// Re-embeds every record in data/exp/trades.jsonl with the current embed model.
// Run after switching exp.embedModel (e.g. MiniLM → nomic) so all historical
// rationale vectors share the same model/dimensionality as new queries.
//
// Usage:  npx tsx scripts/reindex-exp.ts
//
// Safety: writes a .bak backup before overwriting. Skips records with empty
// rationales. Non-interactive — confirm before running on production data.

import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { config } from '../src/config/index.ts';
import { TransformersEmbedProvider, type EmbedProvider } from '../src/evolution/embeddings.ts';
import { isThesisPlaceholder } from '../src/trading/portfolio.ts';
import type { ThesisExperienceRecord } from '../src/types/index.ts';

async function main(): Promise<void> {
  const jsonlPath = config.exp.jsonlPath;
  if (!existsSync(jsonlPath)) {
    console.error(`No trades.jsonl at ${jsonlPath} — nothing to reindex.`);
    process.exit(0);
  }

  const raw = readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  console.log(`[reindex] loaded ${lines.length} records from ${jsonlPath}`);

  const provider: EmbedProvider = new TransformersEmbedProvider();
  await provider.warmup();
  if (!provider.isReady()) {
    console.error('[reindex] embed provider warmup failed — aborting.');
    process.exit(1);
  }

  const out: ThesisExperienceRecord[] = [];
  let reembedded = 0;
  let skipped = 0;
  for (const line of lines) {
    let rec: ThesisExperienceRecord;
    try {
      rec = JSON.parse(line) as ThesisExperienceRecord;
    } catch {
      console.warn('[reindex] skipping corrupt line');
      skipped++;
      continue;
    }
    if (rec.rationales.length === 0 || isThesisPlaceholder(rec.entryThesis)) {
      out.push(rec); // preserve as-is (no rationales to embed)
      continue;
    }
    try {
      rec.rationaleVectors = await provider.embed(rec.rationales);
      reembedded++;
    } catch (err) {
      console.warn(`[reindex] embed failed for ${rec.id} — preserving old vectors: ${err instanceof Error ? err.message : String(err)}`);
    }
    out.push(rec);
  }

  // Backup then write
  const bakPath = `${jsonlPath}.bak-${Date.now()}`;
  renameSync(jsonlPath, bakPath);
  writeFileSync(jsonlPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  console.log(`[reindex] re-embedded ${reembedded} records, skipped ${skipped}, backup → ${bakPath}`);
  console.log(`[reindex] wrote ${out.length} records to ${jsonlPath}`);
}

main().catch((err) => {
  console.error('[reindex] fatal:', err);
  process.exit(1);
});