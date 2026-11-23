/**
 * Claim evidence for a node that reported `blocked` (T1323).
 *
 * Real git clones prove the capture. The transport, the session registry and
 * the process facts are fakes. A "no change" case compares the full node row
 * and the full run row with their state before the call.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../../store/db.js';
import { defaultGitRunner } from '../../../integrations/git.js';
import { canonicalPath } from '../../../runtime/pathScope.js';
import { recoveryCategoryFor } from '../coordinator/recovery.js';
import { preserveNodeWork } from '../workspace/preserve.js';
import type { SupervisedAgentSession } from '../transport/supervisedCliTransport.js';
import { domainKeyOf } from './domains.js';
import { recordClaimEvidence, type ClaimEvidenceDeps } from './claimEvidence.js';

const NOW = '2026-11-01T00:00:00.000Z';
const NODE = 31;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

interface Ctx {
  store: Store;
  db: Store['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
  canonical: string;
  clone: string;
  base: string;
  domain: string;
  artifactRoot: string;
  logs: string[];
}

/** A `running` graph run with one node that reported `blocked`, and its clone. */
function setup(): Ctx {
  const store = openStore(':memory:');
  cleanups.push(() => store.close());
  const db = store.db;
  const insert = (sql: string, ...args: unknown[]): number => Number(db.prepare(sql).run(...args).lastInsertRowid);
  const projectId = insert("INSERT INTO projects (slug) VALUES ('proj')");
  const ticketId = insert("INSERT INTO tickets (key, project_id) VALUES ('T-1', ?)", projectId);
  const graphRunId = insert(
    `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
     VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', ?)`,
    ticketId,
    NOW,
  );
  const revisionId = insert(
    `INSERT INTO approach_graph_revisions
       (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
     VALUES (?, 1, '{}', 'fp', 'active', ?)`,
    graphRunId,
    NOW,
  );
  const canonical = tempDir('karst-evidence-canonical-');
  git(canonical, ['init', '-q', '-b', 'main']);
  git(canonical, ['config', 'user.email', 't@karst']);
  git(canonical, ['config', 'user.name', 'T']);
  writeFileSync(join(canonical, 'a.ts'), 'a\n');
  writeFileSync(join(canonical, 'b.ts'), 'b\n');
  git(canonical, ['add', '-A']);
  git(canonical, ['commit', '-qm', 'base']);
  const base = git(canonical, ['rev-parse', 'HEAD']);
  const clone = join(tempDir('karst-evidence-ws-'), 'api');
  git(canonical, ['clone', '-q', '--local', canonical, clone]);
  git(clone, ['checkout', '-q', '--detach', base]);
  const ctx: Ctx = {
    store,
    db,
    graphRunId,
    revisionId,
    ticketId,
    canonical,
    clone,
    base,
    domain: domainKeyOf(canonicalPath(canonical), git(canonical, ['rev-parse', '--git-common-dir'])),
    artifactRoot: tempDir('karst-evidence-artifacts-'),
    logs: [],
  };
  blockedNode(ctx, NODE, 'n', clone);
  return ctx;
}

function blockedNode(ctx: Ctx, id: number, nodeId: string, clone: string): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, outcome, reason, base_heads)
       VALUES (?, ?, ?, ?, 'agent', ?, 'blocked', 'blocked', 'needs b.ts', ?)`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, nodeId, id, JSON.stringify([{ domainKey: ctx.domain, commit: ctx.base }]));
  ctx.db
    .prepare(
      `INSERT INTO approach_graph_workspaces (graph_run_id, node_run_id, repo_name, cwd, byte_size, created_at)
       VALUES (?, ?, 'api', ?, 1, ?)`,
    )
    .run(ctx.graphRunId, id, clone, NOW);
}

function makeDeps(ctx: Ctx, overrides: Partial<ClaimEvidenceDeps> = {}): ClaimEvidenceDeps {
  return {
    db: ctx.db,
    transaction: <T>(fn: () => T): T =>
      (ctx.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
        begin: 'immediate',
      })(),
    now: () => NOW,
    debug: (message) => ctx.logs.push(message),
    facts: { isAlive: async () => true, liveCwd: async () => null, processStartMs: async () => null },
    git: defaultGitRunner,
    gitCommonDirOf: (cwd) => git(cwd, ['rev-parse', '--git-common-dir']),
    transport: {
      capabilities: () => ({ exactModel: false, attributedTermination: true }),
      start: async () => {
        throw new Error('unused');
      },
      terminate: async () => ({ kind: 'attributable', kill: 'killed' }),
    },
    getSession: (nodeRunId) =>
      ({ nodeRunId, ticketId: ctx.ticketId, graphRunId: ctx.graphRunId, pid: 1, cwd: '/wt' }) as SupervisedAgentSession,
    domainsFor: () => [{ repoName: 'api', worktreePath: ctx.canonical }],
    declaredWritesOf: () => [{ domainKey: ctx.domain, paths: ['a.ts'] }],
    workspaceCwdOf: (nodeRunId) =>
      (
        ctx.db.prepare('SELECT cwd FROM approach_graph_workspaces WHERE node_run_id = ?').get(nodeRunId) as
          | { cwd: string }
          | undefined
      )?.cwd,
    preserveWork: (nodeRunId) => preserve(ctx, nodeRunId),
    ...overrides,
  };
}

const preserve = (ctx: Ctx, nodeRunId: number): ReturnType<typeof preserveNodeWork> =>
  preserveNodeWork(
    {
      db: ctx.db,
      git: defaultGitRunner,
      artifactRoot: () => ctx.artifactRoot,
    },
    { graphRunId: ctx.graphRunId, nodeRunId },
  );

const node = (ctx: Ctx, id = NODE): Record<string, unknown> =>
  ctx.db.prepare('SELECT * FROM approach_node_runs WHERE id = ?').get(id) as Record<string, unknown>;
const run = (ctx: Ctx): Record<string, unknown> =>
  ctx.db.prepare('SELECT * FROM approach_graph_runs WHERE id = ?').get(ctx.graphRunId) as Record<string, unknown>;
const patchOf = (ctx: Ctx): string => join(ctx.artifactRoot, 'preserved', String(NODE), 'api.patch');

/** Run the evidence step and require that the store and the patch did not change. */
async function expectNoChange(ctx: Ctx, overrides: Partial<ClaimEvidenceDeps> = {}): Promise<void> {
  const before = { node: node(ctx), run: run(ctx) };
  await recordClaimEvidence(makeDeps(ctx, overrides), ctx.graphRunId);
  expect({ node: node(ctx), run: run(ctx) }).toEqual(before);
  expect(existsSync(patchOf(ctx))).toBe(false);
}

function drain(ctx: Ctx, revisionStatus: 'draining' | 'active'): void {
  ctx.db.prepare("UPDATE approach_graph_runs SET status = 'draining' WHERE id = ?").run(ctx.graphRunId);
  ctx.db.prepare('UPDATE approach_graph_revisions SET status = ? WHERE id = ?').run(revisionStatus, ctx.revisionId);
}

describe('recordClaimEvidence — a violation', () => {
  it('blocks the run on the path, classifies the node and routes to a replan', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');

    expect(await recordClaimEvidence(makeDeps(ctx), ctx.graphRunId)).toEqual([
      { nodeRunId: NODE, violations: ['b.ts'] },
    ]);

    expect(node(ctx)).toMatchObject({
      status: 'blocked',
      outcome: 'blocked',
      failure_category: 'resource-claim-violated',
      reason: 'resource-claim-violated: b.ts (declared writes: a.ts)',
      ended_at: NOW,
    });
    expect(run(ctx)).toMatchObject({ status: 'blocked', blocked_reason: 'resource-claim-violated: b.ts' });
    expect(recoveryCategoryFor(run(ctx).blocked_reason as string)).toBe('replan');
  });

  it('sees a committed and an untracked out-of-claim file, and preserves both before the block', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'committed\n');
    git(ctx.clone, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'agent commit']);
    writeFileSync(join(ctx.clone, 'new.ts'), 'untracked\n');
    const runAtPreserve: unknown[] = [];

    const result = await recordClaimEvidence(
      makeDeps(ctx, {
        preserveWork: (nodeRunId) => {
          runAtPreserve.push(run(ctx).status);
          return preserve(ctx, nodeRunId);
        },
      }),
      ctx.graphRunId,
    );

    expect(result.map((r) => [...r.violations].sort())).toEqual([['b.ts', 'new.ts']]);
    expect(runAtPreserve).toEqual(['running']);
    const patch = readFileSync(patchOf(ctx), 'utf8');
    expect(patch).toContain('+committed');
    expect(patch).toContain('+untracked');
    // The preserve left the clone as it was: the file is still untracked.
    expect(git(ctx.clone, ['status', '--porcelain'])).toBe('?? new.ts');
  });

  it('still sees an untracked out-of-claim file after an earlier preserve', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'new.ts'), 'untracked\n');
    await preserve(ctx, NODE);
    expect(await recordClaimEvidence(makeDeps(ctx), ctx.graphRunId)).toEqual([
      { nodeRunId: NODE, violations: ['new.ts'] },
    ]);
  });

  it('a preserve failure is logged and does not stop the block', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    await recordClaimEvidence(
      makeDeps(ctx, { preserveWork: async () => ({ kind: 'failed', reason: 'disk full' }) }),
      ctx.graphRunId,
    );
    expect(run(ctx).status).toBe('blocked');
    expect(ctx.logs.some((l) => l.includes('disk full'))).toBe(true);
  });

  it('a second call makes no change', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    await recordClaimEvidence(makeDeps(ctx), ctx.graphRunId);
    const before = { node: node(ctx), run: run(ctx) };
    const later = makeDeps(ctx, { now: () => '2026-11-02T00:00:00.000Z' });
    expect(await recordClaimEvidence(later, ctx.graphRunId)).toEqual([]);
    // The category alone also stops it, with a run that runs again.
    ctx.db.prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = ?").run(ctx.graphRunId);
    expect(await recordClaimEvidence(later, ctx.graphRunId)).toEqual([]);
    expect(node(ctx)).toEqual(before.node);
  });

  it('replan drain: sets only the node category', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    drain(ctx, 'draining');
    const before = run(ctx);
    await recordClaimEvidence(makeDeps(ctx), ctx.graphRunId);
    expect(node(ctx)).toMatchObject({ status: 'blocked', failure_category: 'resource-claim-violated' });
    expect(run(ctx)).toEqual(before);
  });

  it('evaluates a node that reports blocked while another node is evaluated', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    let added = false;
    const result = await recordClaimEvidence(
      makeDeps(ctx, {
        declaredWritesOf: (nodeRunId) => {
          if (!added) {
            added = true;
            blockedNode(ctx, 40, 'late', ctx.clone);
          }
          return [{ domainKey: ctx.domain, paths: nodeRunId === NODE ? ['a.ts', 'b.ts'] : ['a.ts'] }];
        },
      }),
      ctx.graphRunId,
    );
    expect(result).toEqual([{ nodeRunId: 40, violations: ['b.ts'] }]);
  });

  it('a violation of one node is recorded when another node cannot be evaluated', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    blockedNode(ctx, 30, 'first', ctx.clone);
    ctx.db.prepare('UPDATE approach_node_runs SET base_heads = NULL WHERE id = 30').run();
    expect(await recordClaimEvidence(makeDeps(ctx), ctx.graphRunId)).toEqual([
      { nodeRunId: NODE, violations: ['b.ts'] },
    ]);
    expect(node(ctx, 30).failure_category).toBeNull();
  });
});

describe('recordClaimEvidence — no change', () => {
  it('only in-claim work', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'a.ts'), 'a2\n');
    await expectNoChange(ctx);
  });

  it('termination is not proven', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    await expectNoChange(ctx, {
      transport: { ...makeDeps(ctx).transport, terminate: async () => ({ kind: 'attributable', kill: 'denied' }) },
    });
    // No session and no durable process identity.
    await expectNoChange(ctx, { getSession: () => undefined });
  });

  it('does not terminate a session that can belong to a planner run with the same id', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    ctx.db
      .prepare(
        `INSERT INTO approach_planner_runs (id, graph_run_id, planner_run_number, kind, status, started_at)
         VALUES (?, ?, 1, 'replan', 'running', ?)`,
      )
      .run(NODE, ctx.graphRunId, NOW);
    let terminated = 0;
    await expectNoChange(ctx, {
      transport: {
        ...makeDeps(ctx).transport,
        terminate: async () => {
          terminated += 1;
          return { kind: 'attributable', kill: 'killed' };
        },
      },
    });
    expect(terminated).toBe(0);

    // The owner nonce proves that the session is the node's own.
    ctx.db.prepare("UPDATE approach_node_runs SET owner_nonce = 'node-nonce' WHERE id = ?").run(NODE);
    const own = { ...makeDeps(ctx).getSession(NODE)!, ownerNonce: 'node-nonce' };
    await recordClaimEvidence(makeDeps(ctx, { getSession: () => own }), ctx.graphRunId);
    expect(node(ctx).failure_category).toBe('resource-claim-violated');
  });

  it('no clone: never reads or restores the canonical tree', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.canonical, 'b.ts'), 'dirty\n');
    rmSync(ctx.clone, { recursive: true, force: true });
    // A ledger row whose clone is gone, and no ledger row.
    await expectNoChange(ctx);
    await expectNoChange(ctx, {
      workspaceCwdOf: () => undefined,
      domainsFor: () => [{ repoName: 'api', worktreePath: ctx.canonical, regeneratedPaths: ['b.ts'] }],
    });
    expect(readFileSync(join(ctx.canonical, 'b.ts'), 'utf8')).toBe('dirty\n');
  });

  it('a capture error is logged', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    await expectNoChange(ctx, { git: async () => ({ stdout: '', stderr: 'boom', exitCode: 128 }) });
    expect(ctx.logs.some((l) => l.includes('not evaluated'))).toBe(true);
  });

  it('a Stop drain', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    drain(ctx, 'active');
    await expectNoChange(ctx);
  });

  it('another outcome, another status, and a category that is already set', async () => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    for (const set of [
      "outcome = 'replan'",
      "outcome = 'blocked', status = 'cancelled'",
      "status = 'blocked', failure_category = 'integration-conflict'",
    ]) {
      ctx.db.prepare(`UPDATE approach_node_runs SET ${set} WHERE id = ?`).run(NODE);
      await expectNoChange(ctx);
    }
  });

  it.each([
    ['the node is cancelled', "UPDATE approach_node_runs SET status = 'cancelled' WHERE id = 31"],
    ['a Stop drains the run', "UPDATE approach_graph_runs SET status = 'draining' WHERE id = 1"],
  ])('%s while the work is preserved', async (_name, sql) => {
    const ctx = setup();
    writeFileSync(join(ctx.clone, 'b.ts'), 'b2\n');
    const result = await recordClaimEvidence(
      makeDeps(ctx, {
        preserveWork: async () => {
          ctx.db.prepare(sql).run();
          return { kind: 'nothing' };
        },
      }),
      ctx.graphRunId,
    );
    expect(result).toEqual([]);
    expect(node(ctx)).toMatchObject({ failure_category: null, reason: 'needs b.ts' });
    expect(run(ctx).status).not.toBe('blocked');
  });
});
