import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readClonedWorktree, recordClonedWorktree } from './clonedWorktree.js';

const WTS = [{ path: '/a' }, { path: '/b' }];
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'karst-clonedwt-')); });
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('cloned worktree record', () => {
  it('returns the worktree the sandbox cloned, not the first one', async () => {
    await recordClonedWorktree(dir, '/b');
    expect(readClonedWorktree(dir, WTS)).toBe(WTS[1]);
  });
  it('ignores a record naming a path that is not one of the ticket worktrees', async () => {
    await recordClonedWorktree(dir, '/etc');
    expect(readClonedWorktree(dir, WTS)).toBeUndefined();
  });
  it('is undefined without a dir, a record, or with a corrupt record', async () => {
    expect(readClonedWorktree(undefined, WTS)).toBeUndefined();
    expect(readClonedWorktree(dir, WTS)).toBeUndefined();
    await writeFile(join(dir, 'cloned-worktree.json'), '{nope');
    expect(readClonedWorktree(dir, WTS)).toBeUndefined();
  });
});
