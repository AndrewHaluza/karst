/**
 * Node work preservation (T1323).
 *
 * Real git repos in temp dirs prove the recipe end to end: a binary patch per
 * repository carries commits, staged and unstaged edits, deletions, renames,
 * untracked and binary files, leaves a gitignored file out, and never changes
 * the clone's own index. An empty diff writes nothing and keeps an older patch
 * (a failed diff must not destroy the last good one).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, type Store } from '../../../store/db.js';
import { recordWorkspace } from '../../../store/graph/nodeRuns.js';
import { defaultGitRunner, type GitRunner } from '../../../integrations/git.js';
import {
  preserveNodeWork,
  preservedDir,
  readPreservedWork,
  restoreNodeWork,
  type PreserveDeps,
} from './preserve.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-preserve-src-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@karst']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  writeFileSync(join(dir, 'b.ts'), 'b\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return { dir, baseSha: git(dir, ['rev-parse', 'HEAD']) };
}

interface Harness {
  store: Store;
  db: Store['db'];
  ticketId: number;
  graphRunId: number;
  nodeRunId: number;
  globalRoot: string;
  repoDir: string;
  baseSha: string;
  clone: string;
  artifactRoot: (graphRunId: number) => string;
  deps: PreserveDeps;
  close: () => void;
}

let seq = 0;

function harness(withBaseHead = true): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId)
      .lastInsertRowid,
  );
  const { dir, baseSha } = makeRepo();
  const nodeRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, base_heads)
         VALUES (?, ?, 'worker-1', 'agent', 1, 'blocked', ?)`,
      )
      .run(
        graphRunId,
        revisionId,
        withBaseHead ? JSON.stringify([{ domainKey: 'd-web', commit: baseSha }]) : null,
      )
      .lastInsertRowid,
  );
  const globalRoot = mkdtempSync(join(tmpdir(), 'karst-preserve-root-'));
  // A clone standing in for the node's workspace clone.
  const clone = join(globalRoot, 'workspaces', String(nodeRunId), 'web');
  const cl = spawnSync('git', ['clone', '--local', '-q', dir, clone], { encoding: 'utf8' });
  if (cl.status !== 0) throw new Error(`clone: ${cl.stderr}`);
  git(clone, ['checkout', '-q', '--detach', baseSha]);
  // A second node run in the same graph run keeps the ledger realistic.
  recordWorkspace(db, {
    graphRunId,
    nodeRunId,
    repoName: 'web',
    cwd: clone,
    byteSize: 10,
    now: '2026-08-12T00:00:00.000Z',
  });
  const artifactRoot = (runId: number): string =>
    join(globalRoot, 'runs', String(runId), 'artifacts');
  return {
    store,
    db,
    ticketId,
    graphRunId,
    nodeRunId,
    globalRoot,
    repoDir: dir,
    baseSha,
    clone,
    artifactRoot,
    deps: { db, git: defaultGitRunner, artifactRoot },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    },
  };
}

describe('preserveNodeWork', () => {
  let h: Harness;
  afterEach(() => h?.close());

  function patchPath(): string {
    return join(preservedDir(h.artifactRoot(h.graphRunId), h.nodeRunId), 'web.patch');
  }

  it('writes nothing for a clean clone and keeps an older patch', async () => {
    h = harness();
    const dir = preservedDir(h.artifactRoot(h.graphRunId), h.nodeRunId);
    mkdirSync(dir, { recursive: true });
    // A good older patch of an earlier attempt must survive an empty diff.
    writeFileSync(join(dir, 'web.patch'), 'older-good-patch\n');
    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result).toEqual({ kind: 'nothing' });
    expect(readFileSync(patchPath(), 'utf8')).toBe('older-good-patch\n');
    expect(existsSync(join(dir, 'web.paths.json'))).toBe(false);
  });

  it('carries a commit, an unstaged edit, an untracked file and a binary file into one patch', async () => {
    h = harness();
    // One commit on top of the base.
    writeFileSync(join(h.clone, 'a.ts'), 'committed\n');
    git(h.clone, ['add', '-A']);
    git(h.clone, ['-c', 'user.name=karst-test', '-c', 'user.email=t@karst.local', 'commit', '-qm', 'work']);
    // One unstaged edit.
    writeFileSync(join(h.clone, 'b.ts'), 'unstaged\n');
    // One untracked file.
    writeFileSync(join(h.clone, 'c.ts'), 'untracked\n');
    // One binary file.
    const binary = Buffer.from([0, 1, 2, 3, 255, 0]);
    writeFileSync(join(h.clone, 'bin.dat'), binary);

    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result).toEqual({ kind: 'preserved', repos: ['web'] });
    expect(existsSync(patchPath())).toBe(true);
    const paths = readPreservedWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]!.repoName).toBe('web');
    expect(paths[0]!.patchPath).toBe(patchPath());
    expect(paths[0]!.paths.sort()).toEqual(['a.ts', 'b.ts', 'bin.dat', 'c.ts']);

    // Restore into a fresh clone at the base: everything comes back uncommitted.
    const fresh = join(h.globalRoot, 'fresh');
    spawnSync('git', ['clone', '--local', '-q', h.repoDir, fresh], { encoding: 'utf8' });
    git(fresh, ['checkout', '-q', '--detach', h.baseSha]);
    const restored = await restoreNodeWork(
      { git: defaultGitRunner, artifactRoot: h.deps.artifactRoot },
      { graphRunId: h.graphRunId, nodeRunId: h.nodeRunId, repoName: 'web', cwd: fresh },
    );
    expect(restored.kind).toBe('restored');
    expect(git(fresh, ['rev-parse', 'HEAD'])).toBe(h.baseSha);
    expect(readFileSync(join(fresh, 'a.ts'), 'utf8')).toBe('committed\n');
    expect(readFileSync(join(fresh, 'b.ts'), 'utf8')).toBe('unstaged\n');
    expect(readFileSync(join(fresh, 'c.ts'), 'utf8')).toBe('untracked\n');
    expect(readFileSync(join(fresh, 'bin.dat'))).toEqual(binary);
    expect(git(fresh, ['status', '--porcelain'])).not.toBe('');
  });

  it('records a deletion and a rename in the patch', async () => {
    h = harness();
    rmSync(join(h.clone, 'b.ts'));
    git(h.clone, ['mv', 'a.ts', 'renamed.ts']);
    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result.kind).toBe('preserved');
    const [entry] = readPreservedWork(h.deps, { graphRunId: h.graphRunId, nodeRunId: h.nodeRunId });
    expect(entry!.paths).toEqual(expect.arrayContaining(['b.ts', 'renamed.ts']));

    const fresh = join(h.globalRoot, 'fresh');
    spawnSync('git', ['clone', '--local', '-q', h.repoDir, fresh], { encoding: 'utf8' });
    git(fresh, ['checkout', '-q', '--detach', h.baseSha]);
    const restored = await restoreNodeWork(
      { git: defaultGitRunner, artifactRoot: h.deps.artifactRoot },
      { graphRunId: h.graphRunId, nodeRunId: h.nodeRunId, repoName: 'web', cwd: fresh },
    );
    expect(restored.kind).toBe('restored');
    expect(existsSync(join(fresh, 'b.ts'))).toBe(false);
    expect(existsSync(join(fresh, 'a.ts'))).toBe(false);
    expect(readFileSync(join(fresh, 'renamed.ts'), 'utf8')).toBe('a\n');
  });

  it('leaves a gitignored file out of the patch', async () => {
    h = harness();
    writeFileSync(join(h.clone, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(h.clone, 'ignored.txt'), 'secret\n');
    writeFileSync(join(h.clone, 'kept.ts'), 'kept\n');
    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result.kind).toBe('preserved');
    const [entry] = readPreservedWork(h.deps, { graphRunId: h.graphRunId, nodeRunId: h.nodeRunId });
    expect(entry!.paths).toEqual(['.gitignore', 'kept.ts']);
    const patch = readFileSync(entry!.patchPath, 'utf8');
    expect(patch).not.toContain('b/ignored.txt');
  });

  it('overwrites an older patch with the newer non-empty diff', async () => {
    h = harness();
    const dir = preservedDir(h.artifactRoot(h.graphRunId), h.nodeRunId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'web.patch'), 'older\n');
    writeFileSync(join(h.clone, 'c.ts'), 'new\n');
    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result.kind).toBe('preserved');
    expect(readFileSync(patchPath(), 'utf8')).not.toBe('older\n');
    expect(readFileSync(patchPath(), 'utf8')).toContain('c.ts');
  });

  it('never changes the clone index', async () => {
    h = harness();
    writeFileSync(join(h.clone, 'b.ts'), 'unstaged\n');
    writeFileSync(join(h.clone, 'c.ts'), 'untracked\n');
    const indexPath = join(h.clone, '.git', 'index');
    const before = readFileSync(indexPath);
    await preserveNodeWork(h.deps, { graphRunId: h.graphRunId, nodeRunId: h.nodeRunId });
    expect(readFileSync(indexPath)).toEqual(before);
  });

  it('returns failed and writes nothing when the node run recorded no base head', async () => {
    h = harness(false);
    writeFileSync(join(h.clone, 'c.ts'), 'work\n');
    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain('base');
    expect(existsSync(patchPath())).toBe(false);
  });

  it('returns nothing when no ledger row has a clone on disk', async () => {
    h = harness();
    rmSync(h.clone, { recursive: true, force: true });
    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result).toEqual({ kind: 'nothing' });
  });

  it('refuses a repository name that would leave the preserved directory', async () => {
    h = harness();
    h.db
      .prepare('UPDATE approach_graph_workspaces SET repo_name = ? WHERE node_run_id = ?')
      .run('../escape', h.nodeRunId);
    writeFileSync(join(h.clone, 'c.ts'), 'work\n');
    const result = await preserveNodeWork(h.deps, {
      graphRunId: h.graphRunId,
      nodeRunId: h.nodeRunId,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toContain('../escape');
  });
});

describe('restoreNodeWork', () => {
  let h: Harness;
  beforeEach(() => (h = harness()));
  afterEach(() => h.close());

  it('reports none when no patch exists for this repository', async () => {
    const result = await restoreNodeWork(
      { git: defaultGitRunner, artifactRoot: h.deps.artifactRoot },
      { graphRunId: h.graphRunId, nodeRunId: h.nodeRunId, repoName: 'web', cwd: h.clone },
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('leaves a clean clone and keeps the patch when it does not apply', async () => {
    const dir = preservedDir(h.artifactRoot(h.graphRunId), h.nodeRunId);
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, 'web.patch');
    // A patch whose base blob does not match this clone.
    writeFileSync(
      bad,
      [
        'diff --git a/a.ts b/a.ts',
        'index 0000000..1111111 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-never-in-this-tree',
        '+something',
        '',
      ].join('\n'),
    );
    const result = await restoreNodeWork(
      { git: defaultGitRunner, artifactRoot: h.deps.artifactRoot },
      { graphRunId: h.graphRunId, nodeRunId: h.nodeRunId, repoName: 'web', cwd: h.clone },
    );
    expect(result.kind).toBe('failed');
    expect(existsSync(bad)).toBe(true);
    expect(git(h.clone, ['status', '--porcelain'])).toBe('');
  });
});
