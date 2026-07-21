import { describe, it, expect } from 'vitest';
import { previewEnv } from './previewEnv.js';
import type { Manifest } from '../manifest/types.js';
import { manifest as buildManifest, stack } from '../manifest/fixtures.js';

function manifest(): Manifest {
  return buildManifest(stack({ backendRepo: '../backend', frontendRepo: '../frontend' }));
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
