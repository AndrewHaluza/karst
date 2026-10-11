import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultGitRunner } from '../integrations/git.js';
import type { Manifest } from '../manifest/types.js';
import { createWorktree } from '../runtime/worktree.js';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { createArtifactCaptureService, type ArtifactCaptureService } from './service.js';
import { createArtifactStore } from './store.js';

const sh = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
};
const put = (root: string, rel: string, body: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};

describe('artifact capture service (real git + store)', () => {
  let tmp: string;
  let repo: string;
  let store: Store;
  let svc: ArtifactCaptureService;
  let ticketId: number;
  let wtPath: string;
  const manifest = { approaches: [{ id: 'superpowers' }] } as unknown as Manifest;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'karst-svc-'));
    repo = join(tmp, 'app');
    mkdirSync(repo);
    sh(repo, 'init', '-q', '--initial-branch=develop');
    put(repo, 'docs/superpowers/plans/old-ticket.md', 'an older ticket plan');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    wtPath = createWorktree(store, { ticketId, repoPath: repo, slug: 'T-1', baseRef: 'develop' }).path;
    svc = createArtifactCaptureService({
      store,
      globalStorageRoot: join(tmp, 'gs'),
      projectId: () => 7,
      manifest: () => manifest,
      git: defaultGitRunner,
      watch: () => ({ close: () => {} }),
      debug: () => {},
    });
  });
  afterEach(() => {
    svc.dispose();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const history = () => createArtifactStore({ artifactsRoot: join(tmp, 'gs', 'artifacts'), projectId: 7 });

  it('final sweep captures new output under the repo prefix, never base-committed plans', async () => {
    put(wtPath, 'docs/superpowers/plans/mine.md', 'my plan');
    put(wtPath, 'src/unrelated.ts', 'x');
    await svc.sweepWorktree({ ticketId, repoPath: repo, worktreePath: wtPath, baseRef: 'develop' });
    const listed = await history().listArtifacts(ticketId);
    expect(listed.map((a) => a.path)).toEqual([`${basename(repo)}/docs/superpowers/plans/mine.md`]);
  });

  it('captureTicket sweeps every worktree of the ticket and keeps no stale state', async () => {
    put(wtPath, 'docs/superpowers/specs/s.md', 'spec');
    await svc.captureTicket(ticketId);
    const listed = await history().listArtifacts(ticketId);
    expect(listed.map((a) => a.path)).toEqual([`${basename(repo)}/docs/superpowers/specs/s.md`]);
  });

  it('a file removed after capture keeps its last captured revision', async () => {
    put(wtPath, 'docs/superpowers/plans/tmp.md', 'v1');
    const target = { ticketId, repoPath: repo, worktreePath: wtPath, baseRef: 'develop' };
    await svc.sweepWorktree(target);
    rmSync(join(wtPath, 'docs/superpowers/plans/tmp.md'));
    // file is untracked-and-gone, so the base diff no longer lists it: history keeps v1.
    await svc.sweepWorktree(target);
    const h = await history().history(ticketId, `${basename(repo)}/docs/superpowers/plans/tmp.md`);
    expect(h).toHaveLength(1);
  });

  it('deleting a base-committed output is a no-op for a path the store never held', async () => {
    rmSync(join(wtPath, 'docs/superpowers/plans/old-ticket.md'));
    await svc.sweepWorktree({ ticketId, repoPath: repo, worktreePath: wtPath, baseRef: 'develop' });
    expect(await history().listArtifacts(ticketId)).toEqual([]);
  });

  it('purge removes the ticket history', async () => {
    put(wtPath, 'docs/superpowers/plans/p.md', 'v1');
    await svc.sweepWorktree({ ticketId, repoPath: repo, worktreePath: wtPath, baseRef: 'develop' });
    await svc.purge(ticketId);
    expect(await history().listArtifacts(ticketId)).toEqual([]);
  });

  describe('captureEdit (agent post-edit hook)', () => {
    const rel = 'docs/superpowers/plans/hooked.md';
    const hooked = () => `${basename(repo)}/${rel}`;

    it('commits the notified file tagged agent-hook with the provider session', async () => {
      put(wtPath, rel, 'v1');
      await svc.captureEdit({ ticketId, cwd: wtPath, filePath: join(wtPath, rel), sessionId: 'prov-9' });
      const h = await history().history(ticketId, hooked());
      expect(h).toHaveLength(1);
      expect(h[0]!.trailers).toMatchObject({ source: 'agent-hook', session: 'prov-9' });
    });

    it('reads the file itself: only the notified path is captured', async () => {
      put(wtPath, rel, 'v1');
      put(wtPath, 'docs/superpowers/plans/other.md', 'not notified');
      await svc.captureEdit({ ticketId, cwd: wtPath, filePath: join(wtPath, rel), sessionId: 's' });
      expect((await history().listArtifacts(ticketId)).map((a) => a.path)).toEqual([hooked()]);
    });

    it('dedups with the watcher/sweep: same content adds no revision', async () => {
      put(wtPath, rel, 'v1');
      await svc.captureEdit({ ticketId, cwd: wtPath, filePath: join(wtPath, rel), sessionId: 's' });
      await svc.sweepWorktree({ ticketId, repoPath: repo, worktreePath: wtPath, baseRef: 'develop' });
      await svc.captureEdit({ ticketId, cwd: wtPath, filePath: join(wtPath, rel), sessionId: 's' });
      expect(await history().history(ticketId, hooked())).toHaveLength(1);
    });

    it('rejects a path outside the worktree', async () => {
      put(tmp, 'docs/superpowers/plans/evil.md', 'x');
      await svc.captureEdit({ ticketId, cwd: wtPath, filePath: join(tmp, 'docs/superpowers/plans/evil.md'), sessionId: 's' });
      await svc.captureEdit({ ticketId, cwd: wtPath, filePath: '../../../evil.md', sessionId: 's' });
      expect(await history().listArtifacts(ticketId)).toEqual([]);
    });

    it('ignores a notified file that is not an output', async () => {
      put(wtPath, 'src/unrelated.ts', 'x');
      await svc.captureEdit({ ticketId, cwd: wtPath, filePath: join(wtPath, 'src/unrelated.ts'), sessionId: 's' });
      expect(await history().listArtifacts(ticketId)).toEqual([]);
    });
  });
});
