import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { writeManifest } from './write.js';
import { loadManifest } from './load.js';
import type { Manifest } from './types.js';

// Includes an unknown top-level key (`extraTopLevel`) and an unmodeled repository
// sub-key (`repositories.backend.customField`) that must SURVIVE a write.
const RAW = `
extraTopLevel: keep-me
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
repositories:
  backend:
    repoPath: ../backend
    customField: also-keep
    service:
      start: npm run dev
      ports:
        - { name: http, env: PORT, default: 3000 }
      dependsOn: []
`;

/** A pre-rework manifest, for the on-disk upgrade path. */
const LEGACY_RAW = `
host: localhost
portRange: [4000, 4999]
baselineBranch: develop
services:
  backend:
    repoPath: ../backend
    start: npm run dev
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

  it('preserves unknown top-level keys and unmodeled repository fields', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      writeManifest(path, { ...m, host: '0.0.0.0' });
      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(raw.repositories.backend.customField).toBe('also-keep');
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
        advanceOnStart: false,
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
        repositories: {
          backend: {
            repoPath: '../backend',
            baselineBranch: 'release',
            // `validateRepository` always sets this concretely, so a round-trip
            // reload carries it whether or not the file does.
            enabled: true,
            hasMigrations: true,
            signals: ['api', 'endpoint'],
            service: {
              start: 'npm run dev',
              health: 'http://{host}:{port}/health',
              ports: [{ name: 'http', env: 'PORT', default: 3000 }],
              dependsOn: [],
            },
          },
          // A non-runnable repository must survive the round-trip too — if the
          // overlay wrote an empty `service: {}` here, reload would reject it.
          docs: {
            repoPath: '../docs',
            enabled: true,
            hasMigrations: false,
            signals: ['readme'],
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
        conventions: {
          commitMessage: 'feat({repo}): {title} [{key}]',
          pullRequestTitle: '[{key}] {title}',
          pullRequestDescription: '## Summary\n\n{description}\n\nRepository: {repo}\n',
        },
        ticketing: {
          provider: 'clickup',
          teamId: '9001',
          listId: '42',
          advanceOnShip: true,
          shipStatus: 'in review',
          advanceOnStart: true,
          startStatus: 'in dev',
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

  it('preserves unknown top-level data while writing multiline conventions', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const pullRequestDescription =
        '  ## Summary\n\n{description}\n\nRepository: {repo}\n';
      writeManifest(path, {
        ...m,
        conventions: {
          commitMessage: 'feat({repo}): {title}',
          pullRequestDescription,
        },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(raw.conventions.pullRequestDescription).toBe(pullRequestDescription);
      expect(loadManifest(path).conventions).toEqual({
        commitMessage: 'feat({repo}): {title}',
        pullRequestDescription,
      });
    } finally {
      cleanup();
    }
  });

  it('removes stale raw conventions when the modeled section is cleared', () => {
    const { path, cleanup } = fixture(`${RAW}
conventions:
  commitMessage: "feat({repo}): {title}"
  pullRequestTitle: "[{key}] {title}"
`);
    try {
      const m = loadManifest(path);
      writeManifest(path, { ...m, conventions: undefined });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.conventions).toBeUndefined();
      expect(raw.extraTopLevel).toBe('keep-me');
      expect(loadManifest(path).conventions).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('preserves unknown nested convention keys while overlaying modeled fields', () => {
    const { path, cleanup } = fixture(`${RAW}
conventions:
  organizationPolicy: keep-me
  commitMessage: "old: {title}"
`);
    try {
      const m = loadManifest(path);
      writeManifest(path, {
        ...m,
        conventions: {
          ...m.conventions,
          commitMessage: 'feat({repo}): {title}',
          pullRequestTitle: '[{key}] {title}',
        },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.conventions).toEqual({
        organizationPolicy: 'keep-me',
        commitMessage: 'feat({repo}): {title}',
        pullRequestTitle: '[{key}] {title}',
      });
    } finally {
      cleanup();
    }
  });

  it('clears one modeled convention while retaining unknown nested keys', () => {
    const { path, cleanup } = fixture(`${RAW}
conventions:
  organizationPolicy: keep-me
  commitMessage: "feat: {title}"
  pullRequestTitle: "[{key}] {title}"
`);
    try {
      const m = loadManifest(path);
      writeManifest(path, {
        ...m,
        conventions: {
          commitMessage: m.conventions!.commitMessage,
          pullRequestTitle: undefined,
        },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.conventions).toEqual({
        organizationPolicy: 'keep-me',
        commitMessage: 'feat: {title}',
      });
      expect(loadManifest(path).conventions).toEqual({
        commitMessage: 'feat: {title}',
      });
    } finally {
      cleanup();
    }
  });

  // Turning a repository's service OFF must actually remove the block. If the
  // overlay merely omitted the key, the raw `service:` would survive and the
  // repo would silently stay runnable after the user said it wasn't.
  it('drops the `service:` block when a repository becomes non-runnable', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const backend = m.repositories.backend!;
      const { service: _removed, ...withoutService } = backend;
      writeManifest(path, { ...m, repositories: { backend: withoutService } });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.service).toBeUndefined();
      expect(loadManifest(path).repositories.backend!.service).toBeUndefined();
      // The unmodeled sub-key still survives.
      expect(raw.repositories.backend.customField).toBe('also-keep');
    } finally {
      cleanup();
    }
  });

  // Draft state is the ONE repository field whose default is not what a reload
  // produces from silence: `enabled: true` is omitted from the file, so only
  // `false` has to survive as a written key. A round-trip that lost it would
  // quietly promote a half-filled draft into a repository the resolver uses.
  it('round-trips a draft repository, writing `enabled` only when false', () => {
    const { path, cleanup } = fixture();
    try {
      const m = loadManifest(path);
      const backend = m.repositories.backend!;
      writeManifest(path, {
        ...m,
        repositories: { backend: { ...backend, enabled: false } },
      });

      const raw = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(raw.repositories.backend.enabled).toBe(false);
      expect(loadManifest(path).repositories.backend!.enabled).toBe(false);

      // Back to enabled: the key is dropped, not written as `true`.
      writeManifest(path, {
        ...m,
        repositories: { backend: { ...backend, enabled: true } },
      });
      const back = yamlLoad(readFileSync(path, 'utf8')) as Record<string, any>;
      expect(back.repositories.backend.enabled).toBeUndefined();
      expect(loadManifest(path).repositories.backend!.enabled).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('upgrades a legacy `services:` file on write, leaving no stale key', () => {
    const { path, cleanup } = fixture(LEGACY_RAW);
    try {
      const m = loadManifest(path); // migrated in memory
      writeManifest(path, { ...m, host: '0.0.0.0' });

      const text = readFileSync(path, 'utf8');
      expect(text).toContain('repositories:');
      expect(text).not.toContain('services:');
      // And the upgraded file reloads clean (both keys present would throw).
      expect(loadManifest(path).repositories.backend!.service!.start).toBe('npm run dev');
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
