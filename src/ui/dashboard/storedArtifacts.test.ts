import { describe, expect, it } from 'vitest';

import type { ArtifactStore } from '../../artifacts/store.js';
import { buildStoredArtifacts, UNKNOWN_LABEL } from './storedArtifacts.js';

type Reader = Pick<ArtifactStore, 'listArtifacts' | 'history' | 'listSkips'>;

const reader = (): Reader => ({
  listArtifacts: async () => [
    { path: 'app/plans/a.md', revisions: 3, latestSha: 'sha-a' },
    { path: 'app/plans/b.md', revisions: 1, latestSha: 'sha-b' },
    { path: 'lib/spec.md', revisions: 2, latestSha: 'sha-c' },
    { path: 'lib/odd.txt', revisions: 1, latestSha: 'sha-d' },
  ],
  history: async (_t, path) => {
    const trailers: Record<string, Record<string, string>> = {
      'app/plans/a.md': { kind: 'plan', approach: 'superpowers', source: 'watcher' },
      'app/plans/b.md': { kind: 'plan', approach: 'gsd', source: 'hook' },
      'lib/spec.md': { kind: 'spec', approach: 'gsd', source: 'manual-edit' },
    };
    return [{ sha: `top-${path}`, at: '2026-01-02T00:00:00Z', trailers: trailers[path] ?? {} }];
  },
  listSkips: async () => [{ ticketId: 1, path: 'app/.env', reason: 'secret-pattern', at: 'x' }],
});

describe('buildStoredArtifacts', () => {
  it('groups by kind then approach, splitting repo from path', async () => {
    const v = await buildStoredArtifacts(reader(), 1, ['plans/**']);
    expect(v.total).toBe(4);
    expect(v.globs).toEqual(['plans/**']);
    expect(v.groups.map((g) => g.kind)).toEqual(['plan', 'spec', UNKNOWN_LABEL]);
    const plan = v.groups[0]!;
    expect(plan.approaches.map((a) => a.approach)).toEqual(['gsd', 'superpowers']);
    expect(plan.approaches[1]!.rows[0]).toEqual({
      path: 'app/plans/a.md', repo: 'app', relPath: 'plans/a.md', kind: 'plan',
      approach: 'superpowers', source: 'watcher', revisions: 3, lastAt: '2026-01-02T00:00:00Z',
      latestSha: 'sha-a',
    });
  });

  it('labels artifacts without trailers as unknown', async () => {
    const v = await buildStoredArtifacts(reader(), 1, []);
    const row = v.groups.at(-1)!.approaches[0]!.rows[0]!;
    expect(row).toMatchObject({ path: 'lib/odd.txt', kind: UNKNOWN_LABEL, approach: UNKNOWN_LABEL, source: UNKNOWN_LABEL });
  });

  it('lists skips with their reasons', async () => {
    const v = await buildStoredArtifacts(reader(), 1, []);
    expect(v.skips).toEqual([{ path: 'app/.env', reason: 'secret-pattern' }]);
  });

  it('is empty (no groups, globs kept) for a ticket with nothing stored', async () => {
    const empty: Reader = { listArtifacts: async () => [], history: async () => [], listSkips: async () => [] };
    expect(await buildStoredArtifacts(empty, 1, ['a/**'])).toEqual({ total: 0, groups: [], skips: [], globs: ['a/**'] });
  });
});
