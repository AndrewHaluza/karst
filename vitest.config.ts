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
    // The unit gate runs real-git / real-service integration tests (quarantine
    // commit primitives, the ship saga, spin) under full parallel load. Their
    // individual runtimes blow the 5s vitest default whenever the machine is
    // loaded — and which test crosses the line varies run to run, so per-test
    // timeouts are a lottery. The e2e config applies the same 30s global.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
