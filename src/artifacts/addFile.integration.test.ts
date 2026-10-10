import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addArtifactFile } from './addFile.js';
import { readTracked } from './tracked.js';
import { createArtifactStore, ticketStoreDir, type ArtifactStore } from './store.js';

let root: string;
let wt: string;
let outside: string;
let artifactsRoot: string;
let store: ArtifactStore;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'art-add-')));
  wt = join(root, 'wt');
  outside = join(root, 'outside');
  mkdirSync(join(wt, 'scripts'), { recursive: true });
  mkdirSync(outside);
  artifactsRoot = join(root, 'artifacts');
  store = createArtifactStore({ artifactsRoot, projectId: 3 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const call = (path: string, kind: 'script' | 'plan' = 'script') =>
  addArtifactFile({
    store, artifactsRoot, projectId: 3, ticketId: 9, worktrees: [{ repo: 'app', path: wt }],
    path, kind,
  });

describe('addArtifactFile', () => {
  it('commits with source=pushed and persists the tracked entry', async () => {
    writeFileSync(join(wt, 'scripts/dev.sh'), 'echo hi');
    const res = await call(join(wt, 'scripts/dev.sh'));
    expect(res).toMatchObject({ repo: 'app', relPath: 'scripts/dev.sh' });
    const hist = await store.history(9, 'app/scripts/dev.sh');
    expect(hist[0]!.trailers).toMatchObject({ source: 'pushed', kind: 'script' });
    expect(readTracked(ticketStoreDir(artifactsRoot, 3, 9))).toEqual([
      { repo: 'app', relPath: 'scripts/dev.sh', kind: 'script' },
    ]);
  });

  it('resolves a relative path against the worktree and re-adding updates the kind without duplicating', async () => {
    writeFileSync(join(wt, 'scripts/dev.sh'), 'x');
    await call(join(wt, 'scripts/dev.sh'));
    await call(join(wt, 'scripts/dev.sh'), 'plan');
    expect(readTracked(ticketStoreDir(artifactsRoot, 3, 9))).toEqual([
      { repo: 'app', relPath: 'scripts/dev.sh', kind: 'plan' },
    ]);
  });

  it('rejects a path outside every worktree and does not track it', async () => {
    writeFileSync(join(outside, 'a.sh'), 'x');
    await expect(call(join(outside, 'a.sh'))).rejects.toThrow(/inside/);
    expect(readTracked(ticketStoreDir(artifactsRoot, 3, 9))).toEqual([]);
  });

  it('rejects a symlink inside the worktree that points outside', async () => {
    writeFileSync(join(outside, 'key'), 'secret');
    symlinkSync(join(outside, 'key'), join(wt, 'scripts/link.sh'));
    await expect(call(join(wt, 'scripts/link.sh'))).rejects.toThrow(/inside/);
    expect(readTracked(ticketStoreDir(artifactsRoot, 3, 9))).toEqual([]);
  });

  it('rejects ../ traversal and a missing file', async () => {
    writeFileSync(join(outside, 'a.sh'), 'x');
    await expect(call(join(wt, 'scripts/../../outside/a.sh'))).rejects.toThrow(/inside/);
    await expect(call(join(wt, 'scripts/nope.sh'))).rejects.toThrow(/not found|inside/);
  });

  it('does not track a file the store skips (secret name)', async () => {
    writeFileSync(join(wt, '.env'), 'K=v');
    await expect(call(join(wt, '.env'))).rejects.toThrow(/skipped/);
    expect(readTracked(ticketStoreDir(artifactsRoot, 3, 9))).toEqual([]);
  });
});
