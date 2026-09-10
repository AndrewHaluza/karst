import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
    projects: [
      {
        name: 'unit',
        include: ['src/**/*.test.ts'],
        exclude: ['src/ui/**/*.render.test.ts'],
        environment: 'node',
        // `vmThreads` runs files in worker threads against a shared module
        // graph.  This is fast and correct for the ~413 non-render test files.
        // Do NOT move the render project onto vmThreads: jsdom's transitive
        // `@exodus/bytes` ships ESM inside a CJS package and vmThreads cannot
        // interop it — `server.deps.inline` does not help.  The render project
        // uses `forks` for that reason.
        pool: 'vmThreads',
        testTimeout: 30_000,
      },
      {
        name: 'render',
        include: ['src/ui/**/*.render.test.ts'],
        // jsdom's transitive `@exodus/bytes` ships ESM inside a CJS package;
        // vmThreads cannot interop it, and `server.deps.inline` does not help.
        // `forks` does — each test file runs in its own child process.
        environment: 'jsdom',
        pool: 'forks',
        testTimeout: 30_000,
      },
    ],
  },
});
