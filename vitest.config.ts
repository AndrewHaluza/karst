import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // vmThreads runs test files inside a worker thread's VM contexts with the
    // transformed module graph shared across files — the same per-file
    // isolation as the default `forks` pool (fresh module instances per file;
    // `vi.mock` and module state reset between files), but no child-process
    // spawn per test file and no re-transform of the shared store/agent/model
    // graphs. Measured on 413 files / 7301 tests: ~35-55s wall vs ~45-130s
    // forks (the ticket's 132s baseline was under 2-3 concurrent tickets), and
    // ~2.4x faster on the import-heavy store subset — the ~413 child processes
    // become ~10 worker threads, so parallel tickets contend far less for CPU.
    // Native addon errors (better-sqlite3) cross VM realms, so the store layer
    // must match on error `.code` rather than `instanceof Error` — shipRuns.ts.
    pool: 'vmThreads',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
