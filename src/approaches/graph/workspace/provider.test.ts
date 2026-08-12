/**
 * Node execution workspace provider tests (Slice 5 Task 1).
 *
 * Real git repos in temp dirs (like pipeline.test.ts) prove the workspace
 * isolation claims: a clone has its OWN refs/index/worktree, so two concurrent
 * writers in two workspaces never share state, while the canonical worktree the
 * clone was cut from stays clean throughout. The attribution probes, the
 * same-device decision and the byte measurement are injected so the crash and
 * ceiling paths are decided purely, never by this machine's processes.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../../store/db.js';
import {
  createNodeWorkspace,
  nodeWorkspaceDir,
  type NodeWorkspaceDeps,
  type WorkspaceDomain,
} from './provider.js';
import { domainKeyOf, gitCommonDirFromFs } from '../integration/domains.js';
import { canonicalPath } from '../../../runtime/pathScope.js';
import { workspaceBytesOf, workspacesForNode } from '../../../store/graph/nodeRuns.js';
import { defaultGitRunner } from '../../../integrations/git.js';
import type { ProcessFactsSource } from '../../../runtime/serverIdentity.js';
import type { GitRunner } from '../../../integrations/git.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A real git repo at `dir` with `a.ts`, committed. */
function makeRepo(): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'karst-ws-repo-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@karst']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'a.ts'), 'a\n');
  writeFileSync(join(dir, 'b.ts'), 'b\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return { dir, baseSha: git(dir, ['rev-parse', 'HEAD']) };
}

/** BEGIN IMMEDIATE wrapper (the installed @types predate `{begin}`). */
function withImmediate<T>(db: ReturnType<typeof openStore>['db'], fn: () => T): T {
  const runner = (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(
    fn,
    { begin: 'immediate' },
  );
  return runner();
}

/** A fixed `ProcessFactsSource` for the crash/attribution paths. */
function factsOf(input: {
  alive?: (pid: number) => boolean;
  cwd?: (pid: number) => { path: string; deleted: boolean } | null;
  start?: (pid: number) => number | null;
}): ProcessFactsSource {
  return {
    isAlive: (pid) => input.alive?.(pid) ?? false,
    liveCwd: (pid) => input.cwd?.(pid) ?? null,
    processStartMs: (pid) => input.start?.(pid) ?? null,
  };
}

interface Harness {
  store: ReturnType<typeof openStore>;
  db: ReturnType<typeof openStore>['db'];
  ticketId: number;
  graphRunId: number;
  revisionId: number;
  worktree: string;
  baseSha: string;
  globalRoot: string;
  domains: WorkspaceDomain[];
  close: () => void;
}

function harness(): Harness {
  const store = openStore(':memory:');
  const db = store.db;
  db.pragma('busy_timeout = 0');
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
  const globalRoot = mkdtempSync(join(tmpdir(), 'karst-ws-root-'));
  const domains: WorkspaceDomain[] = [
    {
      repoName: 'web',
      canonicalWorktreePath: dir,
      gitCommonDir: gitCommonDirFromFs(dir),
      baseCommit: baseSha,
    },
  ];
  return {
    store,
    db,
    ticketId,
    graphRunId,
    revisionId,
    worktree: dir,
    baseSha,
    globalRoot,
    domains,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(globalRoot, { recursive: true, force: true });
    },
  };
}

function makeDeps(
  h: Harness,
  overrides: Partial<NodeWorkspaceDeps> = {},
): NodeWorkspaceDeps {
  return {
    db: h.db,
    transaction: <T>(fn: () => T): T => withImmediate(h.db, fn),
    git: defaultGitRunner,
    maxAggregateWorkspaceBytes: 1 << 30,
    globalStorageRoot: h.globalRoot,
    facts: factsOf({}),
    now: () => '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function input(h: Harness, nodeRunId: number) {
  // The provider records workspaces against the node run, so the row must
  // exist (in the real flow the claim created it).
  h.db
    .prepare(
      `INSERT INTO approach_node_runs (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', 1, 'ready')
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(nodeRunId, h.graphRunId, h.revisionId, `worker-${nodeRunId}`);
  return {
    projectSlug: 'proj',
    ticketId: h.ticketId,
    graphRunId: h.graphRunId,
    nodeRunId,
    domains: h.domains,
  };
}

/** A git runner that records every invocation while still running real git. */
function recordingRunner(h: Harness): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args, cwd, options) => {
    calls.push(args);
    return defaultGitRunner(args, cwd, options);
  };
  return { git, calls };
}

describe('createNodeWorkspace', () => {
  it('creates workspaces at the mandated location, outside every worktree', async () => {
    const h = harness();
    try {
      const deps = makeDeps(h);
      const result = await createNodeWorkspace(deps, input(h, 7));
      expect(result.kind).toBe('created');
      if (result.kind !== 'created') return;
      expect(result.paths).toHaveLength(1);
      const expectPath = nodeWorkspaceDir(h.globalRoot, 'proj', h.ticketId, h.graphRunId, 7);
      expect(join(expectPath, 'web')).toBe(result.paths[0]!.cwd);
      expect(existsSync(result.paths[0]!.cwd)).toBe(true);
      // Outside every worktree: no part of the path sits under the repo.
      expect(result.paths[0]!.cwd.startsWith(h.worktree)).toBe(false);
    } finally {
      h.close();
    }
  });

  it('two workspaces from the same base have independent refs and indexes; commits never leak across', async () => {
    const h = harness();
    try {
      const deps = makeDeps(h);
      const a = await createNodeWorkspace(deps, input(h, 1));
      const b = await createNodeWorkspace(deps, input(h, 2));
      expect(a.kind).toBe('created');
      expect(b.kind).toBe('created');
      if (a.kind !== 'created' || b.kind !== 'created') return;
      const cwdA = a.paths[0]!.cwd;
      const cwdB = b.paths[0]!.cwd;

      // Independent common-dir identity — a linked worktree would share it.
      const commonA = git(cwdA, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const commonB = git(cwdB, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      expect(commonA).not.toBe(commonB);

      // Both start at the base, detached at the claim-time commit.
      expect(git(cwdA, ['rev-parse', 'HEAD'])).toBe(h.baseSha);
      expect(git(cwdB, ['rev-parse', 'HEAD'])).toBe(h.baseSha);
      expect(git(cwdA, ['status', '--porcelain'])).toBe('');
      expect(git(cwdB, ['status', '--porcelain'])).toBe('');

      // Conflicting writers: each commits independently and the other's HEAD
      // and index are untouched (a shared-ref linked worktree would move both).
      writeFileSync(join(cwdA, 'a.ts'), 'writer-A\n');
      git(cwdA, ['add', '-A']);
      git(cwdA, ['commit', '-qm', 'A']);
      expect(git(cwdA, ['rev-parse', 'HEAD'])).not.toBe(h.baseSha);
      expect(git(cwdB, ['rev-parse', 'HEAD'])).toBe(h.baseSha);
      expect(git(cwdB, ['status', '--porcelain'])).toBe('');

      writeFileSync(join(cwdB, 'a.ts'), 'writer-B\n');
      git(cwdB, ['add', '-A']);
      git(cwdB, ['commit', '-qm', 'B']);
      const headB = git(cwdB, ['rev-parse', 'HEAD']);
      expect(headB).not.toBe(h.baseSha);
      expect(git(cwdA, ['rev-parse', 'HEAD'])).not.toBe(headB);
    } finally {
      h.close();
    }
  });

  it('uses a local clone on the same filesystem and a full clone across devices', async () => {
    const h = harness();
    try {
      const rec = recordingRunner(h);
      const local = await createNodeWorkspace(
        makeDeps(h, { git: rec.git, sameDevice: () => true }),
        input(h, 1),
      );
      expect(local.kind).toBe('created');
      const cross = await createNodeWorkspace(
        makeDeps(h, { git: rec.git, sameDevice: () => false }),
        input(h, 2),
      );
      expect(cross.kind).toBe('created');
      if (local.kind !== 'created' || cross.kind !== 'created') return;

      const clones = rec.calls.filter((args) => args[0] === 'clone');
      expect(clones.some((args) => args.includes('--local'))).toBe(true);
      expect(clones.some((args) => !args.includes('--local'))).toBe(true);
      // A cross-device clone still yields a working repo at the base commit.
      expect(git(cross.paths[0]!.cwd, ['rev-parse', 'HEAD'])).toBe(h.baseSha);
    } finally {
      h.close();
    }
  });

  it('a pre-existing workspace from a crashed run is removed only after attribution says the process is not live', async () => {
    const h = harness();
    try {
      // First creation succeeds with dead facts.
      const deps = makeDeps(h, { facts: factsOf({ alive: () => false }) });
      expect((await createNodeWorkspace(deps, input(h, 9))).kind).toBe('created');
      const dir = nodeWorkspaceDir(h.globalRoot, 'proj', h.ticketId, h.graphRunId, 9);
      const marker = join(dir, 'web', 'marker.txt');
      writeFileSync(marker, 'leftover');
      // The crashed run left a running server row whose process is dead.
      h.db
        .prepare(
          `INSERT INTO servers (ticket_id, repo, pid, status, cwd, started_at)
           VALUES (?, 'web', 4242, 'running', ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(h.ticketId, join(dir, 'web'));
      // Superseded re-creation: attribution says dead → the stale dir is removed.
      const recreated = await createNodeWorkspace(deps, input(h, 9));
      expect(recreated.kind).toBe('created');
      if (recreated.kind !== 'created') return;
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dir, 'web'))).toBe(true);

      // Now a LIVE-but-unattributable process: attribution is unknown → the
      // provider blocks rather than deleting the live tree.
      const live = makeDeps(h, {
        facts: factsOf({ alive: () => true, cwd: () => null, start: () => null }),
      });
      writeFileSync(marker, 'still-leftover');
      const blocked = await createNodeWorkspace(live, input(h, 9));
      expect(blocked.kind).toBe('live-process');
      expect(existsSync(marker)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('a workspace over the byte ceiling blocks with graph-budget-exhausted', async () => {
    const h = harness();
    try {
      // Deterministic byte accounting: every directory measures exactly 1000.
      const measureBytes = () => 1000;
      const deps = makeDeps(h, {
        measureBytes,
        maxAggregateWorkspaceBytes: 1500,
        facts: factsOf({}),
      });
      const first = await createNodeWorkspace(deps, input(h, 1));
      expect(first.kind).toBe('created');
      if (first.kind !== 'created') return;
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(1000);

      // A second workspace pushes 1000 + 1000 past the 1500 ceiling.
      const second = await createNodeWorkspace(deps, input(h, 2));
      expect(second.kind).toBe('budget-exhausted');
      if (second.kind !== 'budget-exhausted') return;
      expect(second.currentBytes).toBe(1000);
      expect(second.limitBytes).toBe(1500);
      // Nothing for the refused workspace was recorded or left on disk.
      expect(existsSync(nodeWorkspaceDir(h.globalRoot, 'proj', h.ticketId, h.graphRunId, 2))).toBe(false);
      expect(workspaceBytesOf(h.db, h.graphRunId)).toBe(1000);
      expect(workspacesForNode(h.db, 1)).toHaveLength(1);
      expect(workspacesForNode(h.db, 2)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('refuses before cloning when the ESTIMATE alone exceeds the ceiling', async () => {
    const h = harness();
    try {
      const deps = makeDeps(h, { measureBytes: () => 1000, maxAggregateWorkspaceBytes: 1500 });
      // Two domains → 2000 estimated bytes, over the 1500 ceiling immediately.
      const secondDomain: WorkspaceDomain = {
        ...h.domains[0]!,
        repoName: 'api',
      };
      const result = await createNodeWorkspace(deps, {
        ...input(h, 1),
        domains: [...h.domains, secondDomain],
      });
      expect(result.kind).toBe('budget-exhausted');
      expect(existsSync(nodeWorkspaceDir(h.globalRoot, 'proj', h.ticketId, h.graphRunId, 1))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('git status in the canonical worktrees stays clean throughout', async () => {
    const h = harness();
    try {
      const deps = makeDeps(h);
      expect((await createNodeWorkspace(deps, input(h, 1))).kind).toBe('created');
      const cross = await createNodeWorkspace(
        makeDeps(h, { sameDevice: () => false }),
        input(h, 2),
      );
      expect(cross.kind).toBe('created');
      // The clone reads from the canonical worktree; it must not write to it.
      expect(git(h.worktree, ['status', '--porcelain'])).toBe('');
      expect(git(h.worktree, ['rev-parse', 'HEAD'])).toBe(h.baseSha);
    } finally {
      h.close();
    }
  });
});
