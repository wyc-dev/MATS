import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // v2.0.845: Force a SINGLE worker to stop the background node process storm.
    // vitest 2.1 defaults to `pool: 'forks'` with maxWorkers = CPU core count,
    // which spawns 8+ node processes on modern machines. Locking maxWorkers and
    // minWorkers to 1 keeps a single vitest node process.
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
    // This is a pure TypeScript backend — no CSS. Disabling CSS processing
    // stops vitest from resolving a PostCSS config, which would walk UP the
    // directory tree and try to read a parent package.json outside the sandbox
    // (EPERM: operation not permitted, open '/Users/y.c./package.json').
    css: false,
    // Keep tests within the backend workspace.
    root: '.',
  },
});
