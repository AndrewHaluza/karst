import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // `forks` runs each test file in its own child process, which is what
    // guarantees real per-file isolation. `vmThreads` was tried here and is NOT
    // equivalent: it runs files in worker threads against a shared module
    // graph, so a module imported (unmocked) by one file before another file
    // `vi.mock`s it is already cached in the shared worker and the mock never
    // takes effect. That surfaced as order/load-dependent failures that only
    // reproduced under full-suite CI (Linux) while passing in per-file
    // isolation — e.g. `mergeGate.test.ts`'s `transition` `mockImplementationOnce`
    // leaking across tests, and `worktreeServers.test.ts`'s `removeContainer`
    // mock not applying. `forks` is slower than vmThreads was, but a correctly
    // isolated suite that always runs the same is worth the wall time.
    // Native addon errors (better-sqlite3) stay within one process under forks,
    // so the store layer matches on error `.code` rather than `instanceof
    // Error` — shipRuns.ts.
    pool: 'forks',
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
