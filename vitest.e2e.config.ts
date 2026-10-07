import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    environment: 'node',
    // Scrub the KARST_* vars karst-launched terminals inject, so the suite is hermetic.
    setupFiles: ['./scripts/vitest-setup-env.mjs'],
    testTimeout: 30_000,
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
  },
});
