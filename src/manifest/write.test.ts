import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRepoSignals, writeManifest } from './write.js';
import { loadManifest } from './load.js';
import type { Manifest, PresetSlot } from './types.js';

const VALID = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
    service:
      start: npm run dev
      ports:
        - { name: port, env: PORT, default: 3000 }
      dependsOn: []
  frontend:
    repoPath: ../frontend
    service:
      start: npm run dev
      ports:
        - { name: port, env: PORT, default: 5173 }
      dependsOn: []
  docs:
    repoPath: ../docs
`;

/** A pre-rework manifest, to prove signals can still be written to one. */
const LEGACY = `
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
`;

function fixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-write-'));
  const path = join(dir, 'karst.yml');
  writeFileSync(path, VALID);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('writeRepoSignals', () => {
  it('writes signals for a repository and reloads them', () => {
    const { path, cleanup } = fixture();
    try {
      writeRepoSignals(path, 'backend', ['api', 'endpoint']);
      const m = loadManifest(path);
      expect(m.repositories.backend!.signals).toEqual(['api', 'endpoint']);
      expect(m.repositories.frontend!.signals).toEqual([]); // untouched
    } finally {
      cleanup();
    }
  });

  it('overwrites existing signals on the target repository only', () => {
    const { path, cleanup } = fixture();
    try {
      writeRepoSignals(path, 'frontend', ['ui']);
      writeRepoSignals(path, 'frontend', ['ui', 'react', 'page']);
      const m = loadManifest(path);
      expect(m.repositories.frontend!.signals).toEqual(['ui', 'react', 'page']);
    } finally {
      cleanup();
    }
  });

  it('keeps the written file a valid manifest (round-trips through validation)', () => {
    const { path, cleanup } = fixture();
    try {
      writeRepoSignals(path, 'backend', ['api']);
      // A second load must not throw — the serialized YAML is still valid.
      expect(() => loadManifest(path)).not.toThrow();
      // And the rest of the manifest is intact.
      const m = loadManifest(path);
      expect(Object.keys(m.repositories).sort()).toEqual(['backend', 'docs', 'frontend']);
      expect(m.repositories.backend!.service!.ports[0]).toEqual({ name: 'port', env: 'PORT', default: 3000 });
    } finally {
      cleanup();
    }
  });

  it('throws when the repository does not exist', () => {
    const { path, cleanup } = fixture();
    try {
      expect(() => writeRepoSignals(path, 'nope', ['x'])).toThrow(/nope/);
    } finally {
      cleanup();
    }
  });

  it('rejects empty or non-string signals before writing', () => {
    const { path, cleanup } = fixture();
    try {
      expect(() => writeRepoSignals(path, 'backend', ['ok', ''])).toThrow(/signal/i);
      // File unchanged — the bad write never landed.
      expect(readFileSync(path, 'utf8')).toBe(VALID);
    } finally {
      cleanup();
    }
  });

  // A non-runnable repository still has to be classifiable, or no ticket could
  // ever be routed to it.
  it('writes signals for a repository that declares no service', () => {
    const { path, cleanup } = fixture();
    try {
      writeRepoSignals(path, 'docs', ['readme', 'guide']);
      const m = loadManifest(path);
      expect(m.repositories.docs!.signals).toEqual(['readme', 'guide']);
      expect(m.repositories.docs!.service).toBeUndefined(); // still not runnable
    } finally {
      cleanup();
    }
  });

  it('upgrades a legacy `services:` file in passing, leaving no stale key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-write-legacy-'));
    const path = join(dir, 'karst.yml');
    writeFileSync(path, LEGACY);
    try {
      writeRepoSignals(path, 'backend', ['api']);
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('repositories:');
      expect(text).not.toContain('services:');
      expect(loadManifest(path).repositories.backend!.signals).toEqual(['api']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeManifest', () => {
  function manifestFixture(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'karst-manifest-'));
    const path = join(dir, 'karst.yml');
    writeFileSync(
      path,
      `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
    service:
      start: npm run dev
      ports:
        - { name: port, env: PORT, default: 3000 }
      dependsOn: []
`,
    );
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('emits per-capability preset slots shape and round-trips', () => {
    const { path, cleanup } = manifestFixture();
    try {
      const loaded = loadManifest(path);
      const slot: PresetSlot = { provider: 'claude', model: 'claude-opus-5.5', effort: 'high' };
      const withPreset: Manifest = {
        ...loaded,
        agentPresets: {
          expensive: {
            label: 'Expensive Setup',
            slots: {
              implementation: slot,
              uatFix: slot,
            },
          },
        },
      };
      writeManifest(path, withPreset);
      const reloaded = loadManifest(path);
      expect(reloaded.agentPresets?.expensive?.slots?.implementation).toEqual(slot);
      expect(reloaded.agentPresets?.expensive?.slots?.uatFix).toEqual(slot);
      // Preset absent from slot list should not appear:
      expect(reloaded.agentPresets?.expensive?.slots?.review).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('renames defaultAgentPreset to activeAgentPreset and round-trips', () => {
    const { path, cleanup } = manifestFixture();
    try {
      const loaded = loadManifest(path);
      const withActive: Manifest = {
        ...loaded,
        agentPresets: {
          default: {
            label: 'Default',
            slots: {
              implementation: { provider: 'claude', model: 'claude-opus-5.5' },
            },
          },
        },
        activeAgentPreset: 'default',
      };
      writeManifest(path, withActive);
      const reloaded = loadManifest(path);
      expect(reloaded.activeAgentPreset).toEqual('default');
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('activeAgentPreset: default');
    } finally {
      cleanup();
    }
  });

  it('drops processes.<key>.preset on write and round-trips clean', () => {
    const { path, cleanup } = manifestFixture();
    try {
      const loaded = loadManifest(path);
      const withProcessPreset: Manifest = {
        ...loaded,
        processes: {
          uatTester: {
            agent: 'tester',
            provider: 'claude',
            model: 'claude-opus-5.5',
            pinned: true,
            preset: 'expensive',
          },
          review: {
            agent: 'reviewer',
          },
        },
      };
      writeManifest(path, withProcessPreset);
      const text = readFileSync(path, 'utf8');
      // Preset field should NOT be in the file (dropped by writer)
      expect(text).not.toContain('preset:');
      const reloaded = loadManifest(path);
      expect(reloaded.processes?.uatTester?.preset).toBeUndefined();
      expect(reloaded.processes?.uatTester?.agent).toEqual('tester');
      expect(reloaded.processes?.review?.agent).toEqual('reviewer');
    } finally {
      cleanup();
    }
  });

  it('keeps the written file valid across all three changes', () => {
    const { path, cleanup } = manifestFixture();
    try {
      const loaded = loadManifest(path);
      const comprehensive: Manifest = {
        ...loaded,
        agentPresets: {
          default: {
            label: 'Default',
            slots: {
              implementation: { provider: 'claude', model: 'claude-opus-5.5' },
            },
          },
        },
        activeAgentPreset: 'default',
        processes: {
          uatTester: { agent: 'tester', preset: 'default' },
        },
      };
      writeManifest(path, comprehensive);
      // Must not throw — the serialized YAML is still valid.
      expect(() => loadManifest(path)).not.toThrow();
      const reloaded = loadManifest(path);
      expect(reloaded.agentPresets?.default?.slots?.implementation?.model).toEqual(
        'claude-opus-5.5',
      );
      expect(reloaded.activeAgentPreset).toEqual('default');
      expect(reloaded.processes?.uatTester?.preset).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe('approach outputs round-trip', () => {
  it('survives load → writeManifest → load, and bad globs fail at load', () => {
    const { path, cleanup } = fixture();
    try {
      const outputs = [{ glob: 'docs/plans/**', kind: 'plan' }];
      writeFileSync(
        path,
        VALID +
          'approaches:\n  - id: custom\n    label: Custom\n    outputs:\n      - { glob: docs/plans/**, kind: plan }\n',
      );
      const loaded = loadManifest(path);
      expect(loaded.approaches![0]!.outputs).toEqual(outputs);
      writeManifest(path, loaded);
      expect(loadManifest(path).approaches![0]!.outputs).toEqual(outputs);

      writeFileSync(
        path,
        VALID +
          'approaches:\n  - id: custom\n    label: Custom\n    outputs:\n      - { glob: ../x/**, kind: plan }\n',
      );
      expect(() => loadManifest(path)).toThrow(/approaches\[0\]\.outputs\[0\]\.glob/);
    } finally {
      cleanup();
    }
  });
});
