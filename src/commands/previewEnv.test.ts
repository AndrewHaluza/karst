import { describe, it, expect } from 'vitest';
import { previewEnv } from './previewEnv.js';
import type { Manifest } from '../manifest/types.js';

function slot(name: string, env: string, def: number) {
  return { name, env, default: def };
}

function manifest(): Manifest {
  return {
    host: 'localhost',
    portRange: [4000, 4999],
    baselineBranch: 'develop',
    services: {
      backend: {
        repoPath: '../backend',
        start: 'npm run dev',
        health: 'http://{host}:{port}/health',
        ports: [slot('http', 'PORT', 3000)],
        dependsOn: [],
        hasMigrations: false,
      },
      frontend: {
        repoPath: '../frontend',
        start: 'npm run dev',
        ports: [slot('http', 'PORT', 5173)],
        dependsOn: [
          {
            target: 'backend',
            port: 'http',
            bind: [{ env: 'VITE_API_URL', template: 'http://{host}:{port}' }],
          },
        ],
        hasMigrations: false,
      },
    },
  };
}

describe('previewEnv', () => {
  it('shows the hot frontend\'s alt PORT and its VITE_API_URL line', () => {
    const out = previewEnv(manifest(), ['frontend']);
    expect(out).toMatch(/frontend/);
    expect(out).toMatch(/hot/);
    expect(out).toMatch(/PORT=4000/); // first alt port from a fresh dry-run allocator
    expect(out).toMatch(/VITE_API_URL=http:\/\/localhost:3000/); // backend default
  });

  it('marks non-hot services as baseline', () => {
    const out = previewEnv(manifest(), ['frontend']);
    expect(out).toMatch(/backend.*baseline|baseline.*backend/s);
  });

  it('is deterministic for a given hot set (snapshot)', () => {
    expect(previewEnv(manifest(), ['frontend'])).toMatchInlineSnapshot(`
      "Resolved env preview — hot: frontend

      backend  [baseline]
        ports: http=3000
        env:   (none)

      frontend  [hot]
        ports: http=4000
        env:   PORT=4000
               VITE_API_URL=http://localhost:3000
        baseline deps: backend

      start order: frontend
      "
    `);
  });

  it('does not persist — repeated calls start ports from the range floor', () => {
    const a = previewEnv(manifest(), ['frontend']);
    const b = previewEnv(manifest(), ['frontend']);
    expect(a).toBe(b); // fresh dry-run allocator each call, no shared state
  });
});
