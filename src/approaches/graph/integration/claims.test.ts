/**
 * Declared-writes resolution tests (Slice 3 Task 8).
 *
 * The node's declared writes are re-derived from the ACTIVE revision's
 * canonical graph (the same document the claim machinery compiled): an agent
 * node's `resources.writes` per repository, a command node's repository-wide
 * writes. Paths are rooted at the repository root within the worktree, and
 * grouped per physical domain key so the pipeline can validate each domain's
 * change set against exactly its own declared writes.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../../../store/db.js';
import { declaredWritesFor, type ResolvedRepoEntry } from './claims.js';

interface Ctx {
  db: ReturnType<typeof openStore>['db'];
  graphRunId: number;
  revisionId: number;
  ticketId: number;
}

const GRAPH = {
  version: 1,
  title: 't',
  rationaleArtifact: 'r',
  entries: ['a'],
  artifacts: [],
  nodes: [
    {
      id: 'a',
      kind: 'agent',
      label: 'a',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: [],
      resources: { reads: [], writes: [{ repo: 'api', paths: ['src/a.ts'] }] },
      outcomes: ['complete'],
      budget: { maxVisits: 1 },
    },
    {
      id: 'b',
      kind: 'agent',
      label: 'b',
      profile: 'default',
      instructionsArtifact: 'i',
      inputs: [],
      outputs: [],
      resources: { reads: [], writes: [{ repo: 'web', paths: ['x.ts'] }, { repo: 'api', paths: ['src/deep'] }] },
      outcomes: ['complete'],
      budget: { maxVisits: 1 },
    },
    {
      id: 'c',
      kind: 'command',
      label: 'c',
      command: 'test',
      repositories: ['api'],
      outcomes: ['passed', 'failed'],
      budget: { maxVisits: 1 },
    },
  ],
  edges: [],
  budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 1 },
};

function harness(): Ctx {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId, JSON.stringify(GRAPH))
      .lastInsertRowid,
  );
  return { db, graphRunId, revisionId, ticketId };
}

function insertNodeRun(ctx: Ctx, id: number, nodeId: string): void {
  ctx.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, ?, 'agent', 1, 'completing')`,
    )
    .run(id, ctx.graphRunId, ctx.revisionId, nodeId);
}

const REPOS: ResolvedRepoEntry[] = [
  { repoName: 'api', root: '', worktreePath: '/wt/api' },
  { repoName: 'web', root: 'web', worktreePath: '/wt/api' },
];

const keyOf = (worktreePath: string): string => `domain:${worktreePath}`;

describe('declaredWritesFor', () => {
  it('an agent node yields its write paths per domain, rooted at the repo root', () => {
    const ctx = harness();
    insertNodeRun(ctx, 11, 'a');
    const result = declaredWritesFor(ctx.db, 11, REPOS, keyOf);
    expect(result).toEqual([{ domainKey: 'domain:/wt/api', paths: ['src/a.ts'] }]);
  });

  it('multiple repos and subtree claims group by domain', () => {
    const ctx = harness();
    insertNodeRun(ctx, 12, 'b');
    const result = declaredWritesFor(ctx.db, 12, REPOS, keyOf);
    expect(result).toEqual([
      { domainKey: 'domain:/wt/api', paths: ['src/deep', 'web/x.ts'] },
    ]);
  });

  it('a command node declares repository-wide writes for each of its repositories', () => {
    const ctx = harness();
    insertNodeRun(ctx, 12, 'c');
    ctx.db
      .prepare(`UPDATE approach_node_runs SET node_kind = 'command' WHERE id = ?`)
      .run(12);
    const result = declaredWritesFor(ctx.db, 12, REPOS, keyOf);
    expect(result).toEqual([{ domainKey: 'domain:/wt/api', paths: [''] }]);
  });

  it('unknown repos in claims are skipped, never invented', () => {
    const ctx = harness();
    insertNodeRun(ctx, 13, 'a');
    const result = declaredWritesFor(ctx.db, 13, [{ repoName: 'api', root: '', worktreePath: '/wt/api' }], keyOf);
    expect(result).toEqual([{ domainKey: 'domain:/wt/api', paths: ['src/a.ts'] }]);
  });

  it('an unknown node id yields nothing', () => {
    const ctx = harness();
    insertNodeRun(ctx, 14, 'missing');
    expect(declaredWritesFor(ctx.db, 14, REPOS, keyOf)).toEqual([]);
  });

  it('a write on a repo with a root prefix is rooted at the worktree root', () => {
    const ctx = harness();
    const graph = {
      version: 1,
      title: 't',
      rationaleArtifact: 'r',
      entries: ['n'],
      artifacts: [],
      nodes: [
        {
          id: 'n',
          kind: 'agent',
          label: 'n',
          profile: 'default',
          instructionsArtifact: 'i',
          inputs: [],
          outputs: [],
          resources: { reads: [], writes: [{ repo: 'web', paths: ['x.ts'] }] },
          outcomes: ['complete'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [],
      budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans: 1 },
    };
    ctx.db
      .prepare('UPDATE approach_graph_revisions SET canonical_graph = ? WHERE id = ?')
      .run(JSON.stringify(graph), ctx.revisionId);
    insertNodeRun(ctx, 15, 'n');
    const result = declaredWritesFor(ctx.db, 15, REPOS, keyOf);
    expect(result).toEqual([{ domainKey: 'domain:/wt/api', paths: ['web/x.ts'] }]);
  });
});
