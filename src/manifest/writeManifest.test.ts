import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { writeManifest } from './write.js';
import { loadManifest } from './load.js';
import type { Manifest } from './types.js';

// Includes an unknown top-level key (`extraTopLevel`) and an unmodeled service
// sub-key (`services.backend.customField`) that must SURVIVE a write.
const RAW = `
extraTopLevel: keep-me
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
    customField: also-keep
    ports:
      - { name: http, env: PORT, default: 3000 }
    dependsOn: []
`;

function fixture(body = RAW): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-wm-'));
  const path = join(dir, 'karst.yml');
  writeFileSync(path, body);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('writeManifest', () => {
  it('round-trips an edited manifest through validation', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const edited: Manifest = { ...m, baselineBranch: 'main' };
      writeManifest(path, edited);
      expect(loadManifest(path).baselineBranch).toBe('main');
    } finally {
      cleanup();
    }
  });

  it('preserves unknown top-level keys and unmodeled service fields', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      writeManifest(path, { ...m, host: '0.0.0.0' });
      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(raw.services.backend.customField).toBe('also-keep');
      expect(raw.host).toBe('0.0.0.0'); // edit landed
    } finally {
      cleanup();
    }
  });

  it('persists an edited ticketing block', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const edited: Manifest = {
        ...m,
        ticketing: { provider: 'clickup', teamId: '9001', listId: '42' },
      };
      writeManifest(path, edited);
      expect(loadManifest(path).ticketing).toEqual({
        provider: 'clickup',
        teamId: '9001',
        listId: '42',
        advanceOnShip: false,
      });
    } finally {
      cleanup();
    }
  });

  // Regression guard: writeManifest whitelists modeled top-level keys in its
  // overlay, so ANY newly-added Manifest field silently fails to persist until
  // it's added there. This round-trips a fully-populated manifest and asserts
  // every modeled section survives — a new field left out of the overlay makes
  // this fail. If you add a Manifest field, add it to the overlay AND here.
  it('round-trips every modeled section without dropping fields', () => {
    const { path, cleanup } = fixture();
    try {
      const full: Manifest = {
        host: '0.0.0.0',
        portRange: [5000, 5999],
        baselineBranch: 'main',
        services: {
          backend: {
            repoPath: '../backend',
            start: 'npm run dev',
            health: 'http://{host}:{port}/health',
            ports: [{ name: 'http', env: 'PORT', default: 3000 }],
            dependsOn: [],
            hasMigrations: true,
            signals: ['api', 'endpoint'],
          },
        },
        approaches: [
          {
            id: 'tdd',
            label: 'TDD',
            recommended: true,
            enabled: false,
            workflow: [{ name: 'research', command: '/rpi:research' }],
          },
        ],
        agents: {
          implement: {
            role: 'implement',
            command: 'claude',
            enabled: false,
            promptPath: 'agents/implement.md',
          },
        },
        worktreePathDisplay: 'absolute',
        ticketLabelTemplate: '{key} · {stage} · {status}',
        terminalNameTemplate: 'Karst: {key} · {stage}',
        ticketing: {
          provider: 'clickup',
          teamId: '9001',
          listId: '42',
          advanceOnShip: true,
          shipStatus: 'in review',
        },
        agentProvider: 'codex',
        defaultModel: 'claude-opus-4-8',
        id: 'karst-extension',
      };
      writeManifest(path, full);
      const reloaded = loadManifest(path);
      expect(reloaded).toEqual(full);
    } finally {
      cleanup();
    }
  });

  it('never writes when the merged manifest fails validation', () => {
    const { path, cleanup } = fixture();
    try {
      const before = readFileSync(path, 'utf8');
      const m = loadManifest(path);
      // portRange min > max — validateManifest throws.
      const bad: Manifest = { ...m, portRange: [9000, 1000] };
      expect(() => writeManifest(path, bad)).toThrow(/portRange/);
      expect(readFileSync(path, 'utf8')).toBe(before); // untouched
    } finally {
      cleanup();
    }
  });
});
