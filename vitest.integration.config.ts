import { defineConfig } from 'vitest/config';

// The non-unit suite: tests named `*.integration.test.*` (real git/child
// processes, real ports, full settings/dashboard jsdom documents) and
// `*.e2e.test.*` (headless end-to-end). Both live here — and ONLY here — so a
// file is never run by two suites. The unit config (`vitest.config.ts`)
// excludes both suffixes; see CONTRIBUTING.md §5 for the naming rule.
//
// `pretest:integration` rebuilds better-sqlite3 for the Node ABI, so this
// suite is self-sufficient: it no longer has to run after `test:unit` just to
// inherit that rebuild (the ordering coupling the old CI job carried).
export default defineConfig({
  test: {
    include: [
      'src/**/*.integration.test.ts',
      'src/**/*.integration.test.tsx',
      'src/**/*.e2e.test.ts',
    ],
    environment: 'node',
    // Scrub the KARST_* vars karst-launched terminals inject, so the suite is hermetic.
    setupFiles: ['./scripts/vitest-setup-env.mjs'],
    // Per-file jsdom render tests rely on `forks` (each file is its own
    // process); the unit config documents why `vmThreads` cannot replace it.
    pool: 'forks',
    testTimeout: 30_000,
    // Hooks default to 10s and do NOT inherit `testTimeout`. Many `beforeAll`
    // hooks here spawn a real child and wait for it to become ready — enough
    // that a loaded run can cut one off at 10s, aborting teardown and surfacing
    // the transport close as `MCP error: Connection closed`. Give hooks the
    // same budget as tests.
    hookTimeout: 30_000,
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
  },
});
