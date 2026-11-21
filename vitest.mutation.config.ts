import { defineConfig } from 'vitest/config';

// Stryker re-runs the suite once per mutant. It is not validated against the
// main config's `vmThreads` pool, and the mutation gate only covers
// `src/extension/**`, so it gets its own narrow config rather than perturbing
// the primary suite's carefully-measured pool choice (see vitest.config.ts).
//
// The include is `src/extension/**/*.test.ts`, which deliberately also matches
// the two `*.integration.test.ts` files under `src/extension/ops/`
// (`bootSweeps`, `planningOutbox`). They are the ONLY tests covering those
// modules, so dropping them would leave their mutants unkilled and push the
// score below `thresholds.break`. The mutation gate therefore keeps running
// them — unlike the unit suite, which excludes them. `stryker.config.json`
// still excludes every `*.test.ts` from mutation, so the rename changed
// nothing there.
export default defineConfig({
  test: {
    include: ['src/extension/**/*.test.ts', 'src/agent/quota/**/*.test.ts'],
    environment: 'node',
    // Scrub the KARST_* vars karst-launched terminals inject, so the suite is hermetic.
    // The second file avoids the worker-thread teardown SIGSEGV (see that file).
    setupFiles: ['./scripts/vitest-setup-env.mjs', './scripts/vitest-setup-mutation.mjs'],
    pool: 'forks',
    // The fork pool loads better-sqlite3 in every worker. On a loaded host the default
    // (one fork per CPU) makes the Stryker dry run exhaust memory and the worker dies with
    // SIGSEGV, which the gate reads as a crashed test runner (@arch:GATE-MUTATION). A bounded
    // pool keeps the dry run (and each mutant run) inside the host's memory.
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
