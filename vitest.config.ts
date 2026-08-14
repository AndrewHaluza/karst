import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
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
