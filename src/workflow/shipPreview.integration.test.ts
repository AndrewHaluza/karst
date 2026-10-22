import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { manifest, repo } from '../manifest/fixtures.js';
import type { Manifest } from '../manifest/types.js';
import {
  cleanupQuarantine,
  headCommit,
  prepareCommitInQuarantine,
  promoteQuarantinedObjects,
  runGit,
  defaultGitRunner,
  type PersistedCommitIdentity,
} from '../integrations/git.js';
import type { GhRunner } from '../integrations/github.js';
import { loadShipPreview } from './shipPreview.js';

const identity: PersistedCommitIdentity = {
  name: 'Test',
  email: 'test@example.com',
  at: '2026-01-01T00:00:00.000Z',
};

let root: string;
let dir: string;
let store: Store;
let ticketId: number;

async function initRepo(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
  await runGit(['init', '-b', 'main'], path);
  await runGit(['config', 'user.name', 'Test'], path);
  await runGit(['config', 'user.email', 'test@example.com'], path);
  await runGit(['config', 'commit.gpgsign', 'false'], path);
  writeFileSync(join(path, 'base.txt'), 'base');
  writeFileSync(join(path, 'dist-out.js'), 'base dist');
  await runGit(['add', '-A'], path);
  const commit = await runGit(['commit', '-m', 'base'], path);
  expect(commit.exitCode).toBe(0);
  await runGit(['branch', 'develop'], path);
  await runGit(['checkout', '-b', 'karst/x'], path);
}

function seedWorktree(id: number, repoPath: string, baseRef = 'develop'): void {
  store.db
    .prepare(
      `INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref, deps_mode)
       VALUES (?, ?, ?, 'karst/x', ?, 'inherited')`,
    )
    .run(id, repoPath, dir, baseRef);
}

function manifestFor(over: Partial<Manifest['repositories'][string]> = {}): Manifest {
  return manifest({ extention: repo({ repoPath: dir, ...over }) });
}

async function preview(m: Manifest) {
  return loadShipPreview({
    store,
    manifest: m,
    git: defaultGitRunner,
    ticketId,
    key: 'T1',
    title: 'Add ship preview',
    ticket: { type: null, model: null },
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'karst-ship-preview-'));
  dir = join(root, 'repo');
  await initRepo(dir);
  store = openStore(':memory:');
  ticketId = createTicket(store, { key: 'T1', title: 'Add ship preview' }).id;
  seedWorktree(ticketId, dir);
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('loadShipPreview', () => {
  it('reads tracked and untracked dirty paths, and nothing else', async () => {
    writeFileSync(join(dir, 'base.txt'), 'changed');
    writeFileSync(join(dir, 'brand-new.ts'), 'new');
    const result = await preview(manifestFor());
    expect(result.repos).toHaveLength(1);
    const row = result.repos[0]!;
    expect(row.repo).toBe('extention');
    expect(row.status).toBe('will-commit');
    expect(row.commitFiles.sort()).toEqual(['base.txt', 'brand-new.ts']);
    expect(row.excludedFiles).toEqual([]);
    expect(row.deny).toEqual([]);
  });

  it('names a filename containing " -> " exactly, matching ship', async () => {
    // git quotes it (`"a -> b.txt"`); a mis-split would report a mangled path
    // while ship commits the real name.
    writeFileSync(join(dir, 'a -> b.txt'), 'x');
    const row = (await preview(manifestFor())).repos[0]!;
    expect(row.status).toBe('will-commit');
    expect(row.commitFiles).toEqual(['a -> b.txt']);
  });

  it('removes exclude matches from the commit set and keeps them dirty', async () => {
    writeFileSync(join(dir, 'dist-out.js'), 'changed dist');
    writeFileSync(join(dir, 'base.txt'), 'changed');
    const result = await preview(manifestFor({ ship: { exclude: ['dist-out.js'] } }));
    const row = result.repos[0]!;
    expect(row.excludedFiles).toEqual(['dist-out.js']);
    expect(row.commitFiles).toEqual(['base.txt']);
    // The excluded path is still dirty in the worktree — nothing touched it.
    const status = await runGit(['status', '--porcelain', '-uall'], dir);
    expect(status.stdout).toContain('dist-out.js');
  });

  it('treats an all-excluded worktree as nothing to commit', async () => {
    writeFileSync(join(dir, 'dist-out.js'), 'changed dist');
    const result = await preview(manifestFor({ ship: { exclude: ['dist-out.js'] } }));
    const row = result.repos[0]!;
    expect(row.status).toBe('nothing-to-commit');
    expect(row.commitFiles).toEqual([]);
    expect(row.excludedFiles).toEqual(['dist-out.js']);
    expect(row.changedFromBase).toBe(false);
  });

  it('blocks a repo whose untracked file matches the deny scan', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    const result = await preview(manifestFor());
    const row = result.repos[0]!;
    expect(row.status).toBe('blocked');
    expect(row.deny).toEqual(['.env']);
  });

  it('warns when an exclude spec also matches committed changes', async () => {
    writeFileSync(join(dir, 'dist-out.js'), 'committed dist');
    await runGit(['add', '-A'], dir);
    await runGit(['commit', '-m', 'committed dist'], dir);
    writeFileSync(join(dir, 'base.txt'), 'changed');
    const result = await preview(manifestFor({ ship: { exclude: ['dist-out.js'] } }));
    const row = result.repos[0]!;
    expect(row.committedExcludedWarning).toEqual(['dist-out.js']);
    expect(row.commitFiles).toEqual(['base.txt']);
  });

  it('skips a repo with a live PR', async () => {
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 5, 'u', 'open')`,
      )
      .run(ticketId, dir);
    writeFileSync(join(dir, 'base.txt'), 'changed');
    const result = await preview(manifestFor());
    expect(result.repos[0]!.status).toBe('already-shipped');
    expect(result.repos[0]!.prNumber).toBe(5);
    expect(result.repos[0]!.commitFiles).toEqual([]);
  });

  it('does NOT skip a live PR after a completed ship — it re-ships into it (FIX-46)', async () => {
    store.db
      .prepare(
        `INSERT INTO ship_runs (ticket_id, attempt, status, started_at)
         VALUES (?, 1, 'passed', '2026-01-01T00:00:00.000Z')`,
      )
      .run(ticketId);
    store.db
      .prepare(
        `INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 5, 'u', 'open')`,
      )
      .run(ticketId, dir);
    writeFileSync(join(dir, 'base.txt'), 'changed');
    const result = await preview(manifestFor());
    const row = result.repos[0]!;
    // A human re-ship commits and pushes onto the open PR — never "skipped".
    expect(row.status).toBe('will-commit');
    expect(row.prNumber).toBe(5);
    expect(row.commitFiles).toEqual(['base.txt']);
  });

  it('reports the branch as changed when the agent already committed the work', async () => {
    writeFileSync(join(dir, 'base.txt'), 'committed');
    await runGit(['add', '-A'], dir);
    await runGit(['commit', '-m', 'agent work'], dir);
    const result = await preview(manifestFor());
    const row = result.repos[0]!;
    expect(row.status).toBe('nothing-to-commit');
    expect(row.changedFromBase).toBe(true);
  });
});

describe('preview agrees with the commit ship actually prepares', () => {
  it('commits exactly the preview commitFiles, leaving excluded paths dirty', async () => {
    writeFileSync(join(dir, 'base.txt'), 'changed');
    writeFileSync(join(dir, 'dist-out.js'), 'changed dist');
    writeFileSync(join(dir, 'extra.ts'), 'new');
    const m = manifestFor({ ship: { exclude: ['dist-out.js'] } });
    const row = (await preview(m)).repos[0]!;
    expect(row.commitFiles.sort()).toEqual(['base.txt', 'extra.ts']);
    expect(row.excludedFiles).toEqual(['dist-out.js']);

    const preHead = (await headCommit(defaultGitRunner, dir))!;
    const key = randomUUID();
    const prepared = await prepareCommitInQuarantine(defaultGitRunner, dir, key, {
      preHead,
      message: 'Add ship preview',
      author: identity,
      committer: identity,
      exclude: ['dist-out.js'],
    });
    expect(prepared.excluded).toEqual(row.excludedFiles);
    expect(prepared.expectedHead).not.toBeNull();
    await promoteQuarantinedObjects(defaultGitRunner, dir, key);
    const tree = await runGit(['ls-tree', '-r', '--name-only', prepared.intendedTree], dir);
    expect(tree.stdout.trim().split('\n').sort()).toEqual([
      'base.txt',
      'dist-out.js',
      'extra.ts',
    ]);
    // dist-out.js was already in base, so the tree carries the BASE version.
    const distAtTree = await runGit(['show', `${prepared.intendedTree}:dist-out.js`], dir);
    expect(distAtTree.stdout).toBe('base dist');
    await cleanupQuarantine(defaultGitRunner, dir, key);
  });

  it('commits a rename SOURCE when the destination is excluded, matching ship', async () => {
    // `git mv base.txt dist/moved.txt` with `dist/**` excluded: the quarantine
    // reset restores dist/moved.txt, but the staged base.txt deletion survives —
    // so ship DELETES base.txt. The preview must say the same.
    mkdirSync(join(dir, 'dist'), { recursive: true });
    await runGit(['mv', 'base.txt', 'dist/moved.txt'], dir);
    const m = manifestFor({ ship: { exclude: ['dist/**'] } });
    const row = (await preview(m)).repos[0]!;
    expect(row.status).toBe('will-commit');
    expect(row.excludedFiles).toEqual(['dist/moved.txt']);
    expect(row.commitFiles).toEqual(['base.txt']);

    const preHead = (await headCommit(defaultGitRunner, dir))!;
    const key = randomUUID();
    const prepared = await prepareCommitInQuarantine(defaultGitRunner, dir, key, {
      preHead,
      message: 'Add ship preview',
      author: identity,
      committer: identity,
      exclude: ['dist/**'],
    });
    expect(prepared.excluded).toEqual(row.excludedFiles);
    expect(prepared.expectedHead).not.toBeNull();
    await promoteQuarantinedObjects(defaultGitRunner, dir, key);
    const tree = await runGit(['ls-tree', '-r', '--name-only', prepared.intendedTree], dir);
    // base.txt is DELETED and dist/moved.txt never entered the tree.
    expect(tree.stdout.trim().split('\n').sort()).toEqual(['dist-out.js']);
    await cleanupQuarantine(defaultGitRunner, dir, key);
  });

  describe('merged PR with nothing new', () => {
    const seedMerged = () =>
      store.db
        .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, 7, ?, ?)')
        .run(ticketId, dir, 'https://github.com/o/r/pull/7', 'merged');
    const ghAt = (oid: string): GhRunner => async () => ({ stdout: `${oid}\n`, stderr: '', exitCode: 0 });
    const previewWith = (gh: GhRunner) =>
      loadShipPreview({
        store,
        manifest: manifestFor(),
        git: defaultGitRunner,
        gh,
        ticketId,
        key: 'T1',
        title: 'Add ship preview',
        ticket: { type: null, model: null },
      });

    it('reads already-merged when HEAD is the merged head', async () => {
      seedMerged();
      const head = (await headCommit(defaultGitRunner, dir))!;
      const row = (await previewWith(ghAt(head))).repos[0]!;
      expect(row.status).toBe('already-merged');
      expect(row.prNumber).toBe(7);
    });

    it('does not read already-merged once the branch moved past the merged head', async () => {
      seedMerged();
      const merged = (await headCommit(defaultGitRunner, dir))!;
      writeFileSync(join(dir, 'later.txt'), 'later');
      await runGit(['add', '-A'], dir);
      await runGit(['commit', '-m', 'later'], dir);
      const row = (await previewWith(ghAt(merged))).repos[0]!;
      expect(row.status).not.toBe('already-merged');
    });
  });
});
