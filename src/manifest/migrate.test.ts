import { describe, it, expect } from 'vitest';
import { migrateLegacyManifest } from './migrate.js';
import { ManifestError } from './schema.js';

/**
 * `MigrationResult.raw` is `unknown` because a non-mapping input passes straight
 * through (validation owns that error). Every case here feeds a mapping, so
 * narrow once rather than casting at each assertion.
 */
function migrate(input: unknown): { raw: Record<string, unknown>; warnings: string[] } {
  const { raw, warnings } = migrateLegacyManifest(input);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('expected a mapping');
  }
  return { raw: raw as Record<string, unknown>, warnings };
}

/** The shape every karst.yml written before this change uses. */
const LEGACY = {
  host: '127.0.0.1',
  portRange: [4000, 4100],
  baselineBranch: 'main',
  services: {
    backend: {
      repoPath: '/repo/backend',
      start: 'node server.mjs',
      health: 'http://{host}:{port}/health',
      ports: [{ name: 'http', env: 'PORT', default: 8000 }],
      dependsOn: [],
      hasMigrations: true,
      signals: ['api'],
    },
  },
};

describe('migrateLegacyManifest — legacy files', () => {
  it('moves runtime fields under `service:` and keeps source-tree fields at repo level', () => {
    const { raw } = migrate(LEGACY);

    expect(raw.repositories).toEqual({
      backend: {
        repoPath: '/repo/backend',
        hasMigrations: true,
        signals: ['api'],
        service: {
          start: 'node server.mjs',
          health: 'http://{host}:{port}/health',
          ports: [{ name: 'http', env: 'PORT', default: 8000 }],
          dependsOn: [],
        },
      },
    });
  });

  it('drops the legacy key so the result cannot carry both', () => {
    const { raw } = migrate(LEGACY);
    expect(raw.services).toBeUndefined();
    expect('services' in raw).toBe(false);
  });

  it('preserves every unrelated top-level key', () => {
    const { raw } = migrate({ ...LEGACY, id: 'proj', defaultModel: 'haiku' });
    expect(raw.host).toBe('127.0.0.1');
    expect(raw.portRange).toEqual([4000, 4100]);
    expect(raw.baselineBranch).toBe('main');
    expect(raw.id).toBe('proj');
    expect(raw.defaultModel).toBe('haiku');
  });

  it('warns so the host can tell the user to re-save', () => {
    const { warnings } = migrate(LEGACY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/legacy `services:` key/);
    expect(warnings[0]).toMatch(/Settings/);
  });

  it('does not mutate the input tree', () => {
    const input = structuredClone(LEGACY);
    migrateLegacyManifest(input);
    expect(input).toEqual(LEGACY);
  });

  it('keeps unmodeled sub-keys at repository level rather than guessing', () => {
    const { raw } = migrate({
      ...LEGACY,
      services: { backend: { ...LEGACY.services.backend, customField: 'keep me' } },
    });
    const backend = (raw.repositories as Record<string, Record<string, unknown>>).backend!;
    expect(backend.customField).toBe('keep me');
    expect(backend.service).not.toHaveProperty('customField');
  });

  it('omits `service` entirely when an entry declares no runtime field at all', () => {
    const { raw } = migrate({
      ...LEGACY,
      services: { docs: { repoPath: '/repo/docs', hasMigrations: false } },
    });
    const docs = (raw.repositories as Record<string, Record<string, unknown>>).docs!;
    expect(docs).not.toHaveProperty('service');
  });
});

describe('migrateLegacyManifest — current files', () => {
  it('passes a `repositories:` tree through untouched and warns nothing', () => {
    const current = {
      host: 'localhost',
      repositories: { docs: { repoPath: '/repo/docs', hasMigrations: false } },
    };
    const { raw, warnings } = migrate(current);
    expect(raw).toEqual(current);
    expect(warnings).toEqual([]);
  });

  it('leaves a tree with neither key for validation to reject', () => {
    const { raw, warnings } = migrate({ host: 'localhost' });
    expect(raw).toEqual({ host: 'localhost' });
    expect(warnings).toEqual([]);
  });
});

describe('migrateLegacyManifest — contradictions', () => {
  it('refuses a file carrying BOTH keys rather than picking one', () => {
    expect(() =>
      migrateLegacyManifest({ ...LEGACY, repositories: { docs: { repoPath: '/d' } } }),
    ).toThrow(ManifestError);

    expect(() =>
      migrateLegacyManifest({ ...LEGACY, repositories: { docs: { repoPath: '/d' } } }),
    ).toThrow(/both `repositories:` and the legacy `services:` key/);
  });

  it('hands a malformed legacy key to validation under the new name', () => {
    const { raw } = migrate({ host: 'x', services: 'not a mapping' });
    expect(raw.repositories).toBe('not a mapping');
    expect(raw.services).toBeUndefined();
  });
});
