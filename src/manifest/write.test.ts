import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeServiceSignals } from './write.js';
import { loadManifest } from './load.js';

const VALID = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    ports:
      - { name: port, env: PORT, default: 3000 }
    dependsOn: []
  frontend:
    repoPath: ../frontend
    start: npm run dev
    ports:
      - { name: port, env: PORT, default: 5173 }
    dependsOn: []
`;

function fixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-write-'));
  const path = join(dir, 'karst.yml');
  writeFileSync(path, VALID);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('writeServiceSignals', () => {
  it('writes signals for a service and reloads them', () => {
    const { path, cleanup } = fixture();
    try {
      writeServiceSignals(path, 'backend', ['api', 'endpoint']);
      const m = loadManifest(path);
      expect(m.services.backend!.signals).toEqual(['api', 'endpoint']);
      expect(m.services.frontend!.signals).toEqual([]); // untouched
    } finally {
      cleanup();
    }
  });

  it('overwrites existing signals on the target service only', () => {
    const { path, cleanup } = fixture();
    try {
      writeServiceSignals(path, 'frontend', ['ui']);
      writeServiceSignals(path, 'frontend', ['ui', 'react', 'page']);
      const m = loadManifest(path);
      expect(m.services.frontend!.signals).toEqual(['ui', 'react', 'page']);
    } finally {
      cleanup();
    }
  });

  it('keeps the written file a valid manifest (round-trips through validation)', () => {
    const { path, cleanup } = fixture();
    try {
      writeServiceSignals(path, 'backend', ['api']);
      // A second load must not throw — the serialized YAML is still valid.
      expect(() => loadManifest(path)).not.toThrow();
      // And the rest of the manifest is intact.
      const m = loadManifest(path);
      expect(Object.keys(m.services).sort()).toEqual(['backend', 'frontend']);
      expect(m.services.backend!.ports[0]).toEqual({ name: 'port', env: 'PORT', default: 3000 });
    } finally {
      cleanup();
    }
  });

  it('throws when the service does not exist', () => {
    const { path, cleanup } = fixture();
    try {
      expect(() => writeServiceSignals(path, 'nope', ['x'])).toThrow(/nope/);
    } finally {
      cleanup();
    }
  });

  it('rejects empty or non-string signals before writing', () => {
    const { path, cleanup } = fixture();
    try {
      expect(() => writeServiceSignals(path, 'backend', ['ok', ''])).toThrow(/signal/i);
      // File unchanged — the bad write never landed.
      expect(readFileSync(path, 'utf8')).toBe(VALID);
    } finally {
      cleanup();
    }
  });
});
