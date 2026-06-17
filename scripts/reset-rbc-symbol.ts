#!/usr/bin/env node
/**
 * Reset a single symbol's RBC state to blank (keeps other symbols untouched).
 *
 * Usage:
 *   npx tsx scripts/reset-rbc-symbol.ts xyz:meta
 *   npx tsx scripts/reset-rbc-symbol.ts btc
 */

import fs from 'node:fs';
import path from 'node:path';

const SYMBOL = (process.argv[2] ?? 'xyz:meta').toLowerCase();
const RBC_PATH = path.join(process.cwd(), 'data', 'evolution', 'rbc-state.json');

function makeEmptyBox(dimCount: number) {
  return {
    min: new Array(dimCount).fill(Infinity),
    max: new Array(dimCount).fill(-Infinity),
    count: 0,
    centroid: new Array(dimCount).fill(0),
  };
}

if (!fs.existsSync(RBC_PATH)) {
  console.log(`RBC state file not found at ${RBC_PATH}`);
  process.exit(1);
}

const raw = fs.readFileSync(RBC_PATH, 'utf-8');
const data = JSON.parse(raw);

const symKey = Object.keys(data.symbols ?? {}).find(
  (k) => k.toLowerCase() === SYMBOL
);

if (!symKey) {
  console.log(`Symbol "${SYMBOL}" not found in RBC state. Nothing to reset.`);
  process.exit(0);
}

const existing = data.symbols[symKey];
const D = existing?.winBox?.min?.length ?? 8;

console.log(`Resetting RBC state for "${symKey}" (was ${existing?.winBox?.count ?? 0}W / ${existing?.lossBox?.count ?? 0}L / ${existing?.totalSamples ?? 0} total)`);

data.symbols[symKey] = {
  winBox: makeEmptyBox(D),
  lossBox: makeEmptyBox(D),
  totalSamples: 0,
};

fs.mkdirSync(path.dirname(RBC_PATH), { recursive: true });
fs.writeFileSync(RBC_PATH, JSON.stringify(data, null, 2));
console.log(`Done. "${symKey}" RBC state wiped clean. It will re-learn from scratch on the next cycles.`);
