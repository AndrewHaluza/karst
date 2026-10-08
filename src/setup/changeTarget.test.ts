import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveChangeRepoDir } from './changeTarget.js';

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
