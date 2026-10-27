import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveChangeRepoDir, resolveChangeDir } from './changeTarget.js';

describe('resolveChangeRepoDir', () => {
  const root = '/ws';

  it('uses a registered repository\u2019s absolute repoPath as-is', () => {
    expect(resolveChangeRepoDir('web', root, '/elsewhere/web')).toBe('/elsewhere/web');
  });

  it('resolves a registered repository\u2019s relative repoPath against the workspace root', () => {
    expect(resolveChangeRepoDir('web', root, 'apps/web')).toBe(join(root, 'apps/web'));
  });

  it('resolves a NOT-yet-registered repo to the named folder UNDER the root, never the root itself', () => {
    const target = resolveChangeRepoDir('web', root, undefined);
    expect(target).toBe(join(root, 'web'));
    expect(target).not.toBe(root);
  });
});

describe('resolveChangeDir', () => {
  const root = '/ws';

  it('without a path keeps today\u2019s resolution', () => {
    expect(resolveChangeDir({ repo: 'web' }, root, undefined)).toEqual({ ok: true, dir: '/ws/web' });
    expect(resolveChangeDir({ repo: 'web' }, root, 'apps/web')).toEqual({ ok: true, dir: '/ws/apps/web' });
  });

  it('"." means the workspace root itself (the retro case: repo macos_iot, root meant)', () => {
    expect(resolveChangeDir({ repo: 'macos_iot', path: '.' }, root, undefined)).toEqual({ ok: true, dir: '/ws' });
  });

  it('resolves a relative path against the root and wins over a registered repoPath', () => {
    expect(resolveChangeDir({ repo: 'web', path: 'sub/dir' }, root, '/elsewhere/web')).toEqual({ ok: true, dir: '/ws/sub/dir' });
  });

  it('accepts an absolute path inside the root', () => {
    expect(resolveChangeDir({ repo: 'web', path: '/ws/web' }, root, undefined)).toEqual({ ok: true, dir: '/ws/web' });
  });

  it.each(['..', '../x', 'a/../../x', '/etc', '/ws2/web'])('rejects %s (outside the root)', (path) => {
    const r = resolveChangeDir({ repo: 'web', path }, root, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`"${path}"`);
  });

  it('does not treat a ..-prefixed folder name as an escape', () => {
    expect(resolveChangeDir({ repo: 'web', path: '..cache' }, root, undefined)).toEqual({ ok: true, dir: '/ws/..cache' });
  });
});
