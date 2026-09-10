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
    //
    // jsdom render tests (*.render.test.ts) use `// @vitest-environment jsdom`
    // per-file — that docblock works under forks (each file is its own process)
    // but NOT under vmThreads (jsdom's transitive @exodus/bytes ships ESM in
    // CJS and vmThreads cannot interop it).
    pool: 'forks',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
