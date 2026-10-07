import { defineConfig } from 'vitest/config';

// Stryker re-runs the suite once per mutant. It is not validated against the
// main config's `vmThreads` pool, and the mutation gate only covers
// `src/extension/**`, so it gets its own narrow config rather than perturbing
// the primary suite's carefully-measured pool choice (see vitest.config.ts).
export default defineConfig({
  test: {
    include: ['src/extension/**/*.test.ts'],
    environment: 'node',
    // Scrub the KARST_* vars karst-launched terminals inject, so the suite is hermetic.
    setupFiles: ['./scripts/vitest-setup-env.mjs'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
