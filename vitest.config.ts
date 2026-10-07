import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // `scripts/**/*.test.mjs` covers plain-JS CI helper scripts (e.g. the
    // mutation mini report). They stay .mjs so CI runs them directly with
    // `node`, with no build/tsx step between Stryker and the summary.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    // The naming rule (see CONTRIBUTING.md §5) is a filename suffix, not a
    // directory: a file that spawns a real process, binds a real port, or
    // renders a full settings/dashboard jsdom document is named
    // `*.integration.test.*`; a headless end-to-end file is `*.e2e.test.*`.
    // Both are excluded here so the unit suite stays fast and hermetic; they
    // are run together by `vitest.integration.config.ts` (npm run
    // test:integration). `configDefaults.exclude` is spread first so the
    // library's node_modules/.git excludes are not dropped.
    exclude: [...configDefaults.exclude, '**/*.e2e.test.*', '**/*.integration.test.*'],
    environment: 'node',
    // Scrub the KARST_* vars karst-launched terminals inject, so the suite is hermetic.
    setupFiles: ['./scripts/vitest-setup-env.mjs'],
    // The webview message-sender bundles are generated esbuild output; build
    // them once per run so jsdom/VM tests that hydrate dashboard or settings
    // can read them from RUNTIME_ASSETS_ROOT (the src root here).
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    // `forks` runs each test file in its own child process, which is what
    // guarantees real per-file isolation. `vmThreads` was tried here and is NOT
    // equivalent: it runs files in worker threads against a shared module
    // graph, so a module imported (unmocked) by one file before another file
    // `vi.mock`s it is already cached in the shared worker and the mock never
    // takes effect. That surfaced as order/load-dependent failures that only
    // reproduced under full-suite CI (Linux) while passing in per-file
    // isolation — e.g. `mergeGate.test.ts`'s `transition` `mockImplementationOnce`
    // leaking across tests, and `worktreeServers.integration.test.ts`'s `removeContainer`
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
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  },
});
