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
    // Render snapshots hold formatted clock times (e.g. the ship preview's "as of 09:41 AM"), recorded in UTC.
    env: { TZ: 'UTC' },
    // Scrub the KARST_* vars karst-launched terminals inject, so the suite is hermetic.
    setupFiles: ['./scripts/vitest-setup-env.mjs'],
    // Per-file jsdom render tests rely on `forks` (each file is its own
    // process); the unit config documents why `vmThreads` cannot replace it.
    pool: 'forks',
    // Each fork loads a full jsdom document for the render files; one such file
    // peaks around 1.3 GB. The default (available CPUs - 1) can keep five forks
    // resident on this 6-CPU sandbox and exhaust its ~5 GB: the UAT run
    // OOM-killed a fork mid-file, which surfaced only as `Worker exited
    // unexpectedly` after every reported test had passed. Cap the pool so the
    // gate keeps headroom; the wall-clock cost is a few tens of seconds. Two
    // forks also leave CPU for the files that spawn several children at once
    // (`workspaceTrust.integration.test.ts` races eight), which is where the
    // UAT integration gate lost a case to writer starvation.
    maxWorkers: Number(process.env.KARST_GATE_MAX_WORKERS) || 2,
    // Hide console output of passing tests; a failing test still prints its own.
    silent: 'passed-only',
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
