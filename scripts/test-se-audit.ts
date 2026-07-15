// Minimal test: load EXP records and run System Engineer audit directly
// This avoids starting the full trading system (which uses too much memory)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  console.log('=== System Engineer Standalone Audit Test ===');

  // Load EXP records
  const expPath = join(process.cwd(), 'data/exp/trades.jsonl');
  const raw = readFileSync(expPath, 'utf-8');
  const lines = raw.trim().split('\n').filter(Boolean);
  console.log(`Loaded ${lines.length} EXP records from disk`);

  // Parse records
  const records = lines.map(l => JSON.parse(l));
  console.log(`Parsed ${records.length} records`);
  console.log(`Last record: side=${records[records.length - 1].side} symbol=${records[records.length - 1].symbol} outcome=${records[records.length - 1].outcome}`);

  // Initialize LLM provider first
  const { initializeLLM } = await import('../src/llm/index.ts');
  console.log('Initializing LLM provider...');
  await initializeLLM();
  console.log('LLM provider initialized');

  // Dynamically import system-engineer
  const { runSystemEngineer } = await import('../src/evolution/system-engineer.ts');

  console.log('Calling runSystemEngineer...');
  const result = await runSystemEngineer(records);

  if (result) {
    console.log('=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('=== No result returned (null) ===');
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});