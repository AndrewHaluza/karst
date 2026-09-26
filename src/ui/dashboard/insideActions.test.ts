import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type NestableStore, type Store } from '../../store/db.js';
import { recordFindings } from '../../store/reviewFindings.js';
import { recordUatFindings } from '../../store/uatFindings.js';
import { openShipRun, openShipRepoStep, finishShipRepoStep, recordShipCommit } from '../../store/shipRuns.js';
import { openProcessRun } from '../../store/processRuns.js';
import { openImplementationRun, completeImplementationRun } from '../../store/implementationRuns.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import {
  InsideActionRegistry,
  dispatchInsideAction,
  resolveOpenFileTarget,
  type InsideActionTarget,
  type InsideFileFs,
  type InsideActionHost,
} from './insideActions.js';

let store: NestableStore;

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
  store.db
    .prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (?, ?, ?, ?)')
    .run(1, 'K-1', 'One', 1);
  store.db
    .prepare('INSERT INTO tickets (id, key, title, project_id) VALUES (?, ?, ?, ?)')
    .run(2, 'K-2', 'Two', 1);
  // Minimal stage rows, like `createTicket` seeds — `setStage` only updates.
  store.db
    .prepare(
      `INSERT INTO stages (ticket_id, stage_key, status) VALUES
         (1, 'uat', 'pending'), (1, 'review', 'pending'),
         (2, 'uat', 'pending'), (2, 'review', 'pending')`,
    )
    .run();
});
afterEach(() => store.close());

function reviewFindingId(over: { ticketId?: number; repo?: string; file?: string | null; line?: number | null } = {}): number {
  const ticketId = over.ticketId ?? 1;
  recordFindings(store, {
    ticketId,
    attempt: 1,
    runAt: '2026-08-08T10:00:00.000Z',
    processRunId: null,
    findings: [
      {
        severity: 'high',
        repo: over.repo ?? '/web',
        file: over.file ?? 'src/foo.ts',
        // `line` in over respects an EXPLICIT null (a finding with no line);
        // absent defaults to 12 so the resolve tests pin the carried line.
        line: 'line' in over ? over.line : 12,
        title: 'x',
        detail: 'y',
        source: 'agent',
      },
    ],
  });
  const row = store.db
    .prepare('SELECT id FROM review_findings ORDER BY id DESC LIMIT 1')
    .get() as { id: number };
  return row.id;
}

function uatFindingId(over: { ticketId?: number; repo?: string; file?: string | null } = {}): number {
  const run = openProcessRun(store, {
    ticketId: over.ticketId ?? 1,
    stageKey: 'uat',
    processId: 'tester',
    attempt: 0,
    startedAt: '2026-08-08T10:00:00.000Z',
  });
  const ids = recordUatFindings(store, {
    ticketId: over.ticketId ?? 1,
    processRunId: run.id,
    createdAt: '2026-08-08T10:00:00.000Z',
    findings: [
      {
        severity: 'high',
        repo: over.repo ?? '/web',
        file: over.file ?? 'src/foo.ts',
        title: 'x',
      },
    ],
  });
  return ids[0]!;
}

function seedPr(id: number, ticketId: number, number: number | null = 40): void {
  store.db
    .prepare('INSERT INTO prs (rowid, ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, ticketId, '/web', number, `https://github.com/o/r/pull/${number ?? 1}`, 'open');
}

/** Seed a graph run + an active revision; returns both row ids. */
function seedGraph(
  over: { ticketId?: number; runId?: number; stageAttempt?: number; status?: string } = {},
): { graphRunId: number; revisionId: number } {
  const graphRunId = over.runId ?? 1;
  store.db
    .prepare(
      `INSERT INTO approach_graph_runs
         (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
       VALUES (?, ?, 'impl', ?, 'karst-graph-engineering', ?, '2026-08-12T00:00:00.000Z')`,
    )
    .run(graphRunId, over.ticketId ?? 1, over.stageAttempt ?? 0, over.status ?? 'running');
  const revisionId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId)
      .lastInsertRowid,
  );
  return { graphRunId, revisionId };
}

/** Seed a node run under the given revision; returns its id. */
function seedNodeRun(revisionId: number, over: { id: number; graphRunId: number; status?: string }): void {
  store.db
    .prepare(
      `INSERT INTO approach_node_runs
         (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status)
       VALUES (?, ?, ?, 'worker', 'agent', 1, ?)`,
    )
    .run(over.id, over.graphRunId, revisionId, over.status ?? 'running');
}

/** Seed a planner run under the given graph run; returns its id. */
function seedPlannerRun(graphRunId: number, over: { id: number; status?: string }): void {
  store.db
    .prepare(
      `INSERT INTO approach_planner_runs
         (id, graph_run_id, planner_run_number, kind, status)
       VALUES (?, ?, 1, 'bootstrap', ?)`,
    )
    .run(over.id, graphRunId, over.status ?? 'running');
}

/** A worktree map keyed by repo path. */
const worktrees = new Map<string, string>([['/web', '/wt/web']]);

const fs: InsideFileFs = {
  existsSync: (p) => p === '/wt/web' || p.startsWith('/wt/web/'),
  realpathSync: (p) => p,
};

function host(calls: string[]): InsideActionHost {
  return {
    openFile: (path) => void calls.push(`file:${path}`),
    openPr: (ticketId, prId) => void calls.push(`pr:${ticketId}:${prId}`),
    openCommit: (ticketId, shipCommitId) => void calls.push(`commit:${ticketId}:${shipCommitId}`),
    resumeStage: (ticketId, stageKey) => void calls.push(`resume:${ticketId}:${stageKey}`),
    openFullEvidence: (ticketId, processRunId) => void calls.push(`evidence:${ticketId}:${processRunId}`),
    openBoundedEvidence: (ticketId, title, rows) =>
      void calls.push(`bounded:${ticketId}:${title}:${rows.map((row) => row.label).join(',')}`),
    openSession: (ticketId) => void calls.push(`open-session:${ticketId}`),
    graphOpenSession: (ticketId, session) =>
      void calls.push(`graph-open:${ticketId}:${session.kind}:${session.runId}`),
    graphStop: (ticketId, graphRunId) => void calls.push(`graph-stop:${ticketId}:${graphRunId}`),
    graphResume: (ticketId, graphRunId) => void calls.push(`graph-resume:${ticketId}:${graphRunId}`),
    graphRestart: (ticketId, graphRunId) => void calls.push(`graph-restart:${ticketId}:${graphRunId}`),
    graphReplan: (ticketId, graphRunId) => void calls.push(`graph-replan:${ticketId}:${graphRunId}`),
    graphConfirm: (ticketId, graphRunId) =>
      void calls.push(`graph-confirm:${ticketId}:${graphRunId}`),
    graphMarkImpl: (ticketId, graphRunId) =>
      void calls.push(`graph-mark-impl:${ticketId}:${graphRunId}`),
    graphDiscardNode: (ticketId, nodeRunId) =>
      void calls.push(`graph-discard:${ticketId}:${nodeRunId}`),
    graphEditOverride: (ticketId, nodeRunId) =>
      void calls.push(`graph-edit-override:${ticketId}:${nodeRunId}`),
    retryShipRepo: (ticketId, repo) =>
      void calls.push(`retry-ship-repo:${ticketId}:${repo}`),
  };
}

function registry(generation: number, ticketId = 1): InsideActionRegistry {
  return new InsideActionRegistry(generation, ticketId);
}

describe('InsideActionRegistry', () => {
  it('mints opaque snapshot-scoped ids and resolves them back', () => {
    const r = registry(7);
    const action = r.register({ kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: 3 } });
    expect(action.actionId).toBe('snapshot-7:action-0');
    expect(action.kind).toBe('open-file');
    expect(r.resolve('snapshot-7:action-0')).toMatchObject({ kind: 'open-file' });
  });

  it('rejects malformed, stale-generation and other-ticket ids', () => {
    const r = registry(7);
    r.register({ kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: 3 } });
    expect(r.resolve('forged')).toBeNull();
    expect(r.resolve('snapshot-7:action-0:extra')).toBeNull();
    expect(r.resolve('snapshot-6:action-0')).toBeNull();
    expect(r.resolve('snapshot-7:action-99')).toBeNull();
  });

  it('rejects a target that does not belong to the registry ticket', () => {
    // Defense in depth: even a mis-registered target (another ticket's id
    // minted into this registry) must never resolve.
    const r = registry(7, 2);
    r.register({ kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: 3 } });
    expect(r.resolve('snapshot-7:action-0')).toBeNull();
  });

  it('dispose drops every capability — a replaced snapshot cannot dispatch', () => {
    const old = registry(7);
    const action = old.register({ kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: 3 } });
    old.dispose();
    expect(old.resolve(action.actionId)).toBeNull();

    // A new snapshot generation supersedes the old one.
    const fresh = registry(8);
    expect(fresh.resolve(action.actionId)).toBeNull();
  });

  it('mints the SAME id for the SAME target within one registry — a live repaint re-mints the same rows', () => {
    // A live repaint reuses the registry and re-mints every row; memoizing by
    // target keeps the webview's displayed id valid instead of growing a new
    // id per row per tick (869eja6uv).
    const r = registry(7);
    const target: InsideActionTarget = {
      kind: 'open-file',
      ticketId: 1,
      evidence: { source: 'review-finding', id: 3 },
    };
    expect(r.register(target).actionId).toBe('snapshot-7:action-0');
    expect(r.register(target).actionId).toBe('snapshot-7:action-0');
    // A distinct target still gets its own id.
    expect(
      r.register({
        kind: 'open-file',
        ticketId: 1,
        evidence: { source: 'review-finding', id: 4 },
      }).actionId,
    ).toBe('snapshot-7:action-1');
  });
});

describe('resolveOpenFileTarget', () => {
  const deps = { worktreeForRepo: (repo: string) => worktrees.get(repo), fs };

  it('opens a canonical descendant of the recorded worktree for a review finding', () => {
    const id = reviewFindingId({ file: 'src/foo.ts' });
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } },
      deps,
    );
    expect(resolved).toEqual({ path: '/wt/web/src/foo.ts', line: 12 });
  });

  it('opens a uat finding the same way', () => {
    const id = uatFindingId({ file: 'e2e/spec.ts' });
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'uat-finding', id } },
      deps,
    );
    expect(resolved).toEqual({ path: '/wt/web/e2e/spec.ts', line: null });
  });

  it('carries a finding without a recorded line as null, never a fabricated 0', () => {
    const id = reviewFindingId({ file: 'src/foo.ts', line: null });
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } },
      deps,
    );
    expect(resolved).toEqual({ path: '/wt/web/src/foo.ts', line: null });
  });

  it('rejects evidence that belongs to another ticket', () => {
    const id = reviewFindingId({ ticketId: 2, file: 'src/foo.ts' });
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } },
      deps,
    );
    expect(resolved).toEqual({ error: 'evidence belongs to another ticket' });
  });

  it('rejects unknown evidence ids', () => {
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: 999 } },
      deps,
    );
    expect(resolved).toEqual({ error: 'unknown evidence' });
  });

  it('rejects absolute paths, traversal, and empty paths', () => {
    const absolute = reviewFindingId({ file: '/etc/passwd' });
    expect(
      resolveOpenFileTarget(
        store,
        { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: absolute } },
        deps,
      ),
    ).toEqual({ error: 'absolute path refused' });

    const traversal = reviewFindingId({ file: 'src/../../etc/passwd' });
    expect(
      resolveOpenFileTarget(
        store,
        { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: traversal } },
        deps,
      ),
    ).toEqual({ error: 'path traversal refused' });

    const empty = reviewFindingId({ file: '' });
    expect(
      resolveOpenFileTarget(
        store,
        { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id: empty } },
        deps,
      ),
    ).toEqual({ error: 'evidence is not file-scoped' });
  });

  it('rejects evidence with no repository mapping', () => {
    const id = reviewFindingId({ repo: '/missing', file: 'src/foo.ts' });
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } },
      deps,
    );
    expect(resolved).toEqual({ error: 'no worktree registered for the evidence repository' });
  });

  it('rejects an existing symlink that escapes the worktree', () => {
    const id = reviewFindingId({ file: 'link/out.ts' });
    const symlinkFs: InsideFileFs = {
      existsSync: (p) => p === '/wt/web' || p === '/wt/web/link',
      // The existing ancestor resolves OUTSIDE the worktree.
      realpathSync: (p) => (p === '/wt/web/link' ? '/elsewhere/link' : p),
    };
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } },
      { worktreeForRepo: (repo) => worktrees.get(repo), fs: symlinkFs },
    );
    expect(resolved).toEqual({ error: 'path escapes the recorded worktree' });
  });

  it('rejects a not-yet-existing leaf whose existing ancestor is an escaping symlink', () => {
    const id = reviewFindingId({ file: 'link/new/deep/file.ts' });
    const symlinkFs: InsideFileFs = {
      existsSync: (p) => p === '/wt/web' || p === '/wt/web/link',
      realpathSync: (p) => (p === '/wt/web/link' ? '/elsewhere/link' : p),
    };
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } },
      { worktreeForRepo: (repo) => worktrees.get(repo), fs: symlinkFs },
    );
    expect(resolved).toEqual({ error: 'path escapes the recorded worktree' });
  });

  it('appends a missing leaf onto the deepest EXISTING ancestor and opens that', () => {
    const id = reviewFindingId({ file: 'src/not/here/yet.ts' });
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } },
      deps,
    );
    expect(resolved).toEqual({ path: '/wt/web/src/not/here/yet.ts', line: 12 });
  });
});

describe('dispatchInsideAction', () => {
  const deps = (calls: string[]) => ({
    host: host(calls),
    worktreeForRepo: (repo: string) => worktrees.get(repo),
    fs,
  });

  it('returns unknown for an id no snapshot issued', () => {
    const r = registry(7);
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'unknown',
    });
  });

  it('dispatches open-file only through the re-loaded, ticket-owned row', () => {
    const id = reviewFindingId({ file: 'src/foo.ts' });
    const r = registry(7);
    r.register({ kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['file:/wt/web/src/foo.ts']);
  });

  it('passes the finding line to the host so the editor positions the cursor', () => {
    const id = reviewFindingId({ file: 'src/foo.ts', line: 4450 });
    const r = registry(7);
    r.register({ kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } });
    const opened: Array<{ path: string; line: number | null | undefined }> = [];
    expect(
      dispatchInsideAction(store, r, 'snapshot-7:action-0', {
        host: { ...host([]), openFile: (path, line) => void opened.push({ path, line }) },
        worktreeForRepo: (repo) => worktrees.get(repo),
        fs,
      }),
    ).toEqual({ outcome: 'dispatched' });
    expect(opened).toEqual([{ path: '/wt/web/src/foo.ts', line: 4450 }]);
  });

  it('dispatches open-pr only for a PR row owned by this ticket', () => {
    seedPr(11, 1);
    seedPr(12, 2, 41);

    const r = registry(7);
    r.register({ kind: 'open-pr', ticketId: 1, prId: 11 });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['pr:1:11']);

    // A PR of another ticket is rejected, never dispatched.
    const r2 = registry(7);
    r2.register({ kind: 'open-pr', ticketId: 1, prId: 12 });
    expect(dispatchInsideAction(store, r2, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'PR not found for this ticket',
    });
  });

  it('dispatches open-commit only for a ship commit owned by this ticket', () => {
    openShipRun(store, { ticketId: 1, attempt: 1, startedAt: '2026-08-08T10:00:00.000Z' });
    recordShipCommit(store, {
      shipRunId: 1,
      repo: '/web',
      sha: 'abc123',
      message: 'm',
      origin: 'created-by-ship',
    });
    const id = store.db.prepare('SELECT id FROM ship_commits').get() as { id: number };

    const r = registry(7);
    r.register({ kind: 'open-commit', ticketId: 1, shipCommitId: id.id });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['commit:1:1']);

    r.register({ kind: 'open-commit', ticketId: 2, shipCommitId: id.id });
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-1', deps([]))).toEqual({
      outcome: 'unknown',
    });
  });

  it('dispatches open-stage-log only when the stage has an artifact', () => {
    store.db
      .prepare(
        `UPDATE stages SET artifact_path = ? WHERE ticket_id = 1 AND stage_key = 'uat'`,
      )
      .run('/logs/uat.log');

    const r = registry(7);
    r.register({ kind: 'open-stage-log', ticketId: 1, stageKey: 'uat' });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['file:/logs/uat.log']);

    // The same target against a ticket that owns no such stage is rejected.
    const r2 = registry(7, 2);
    r2.register({ kind: 'open-stage-log', ticketId: 2, stageKey: 'uat' });
    expect(dispatchInsideAction(store, r2, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'no log artifact recorded',
    });

    // No artifact at all is rejected, never opened.
    const r3 = registry(7);
    r3.register({ kind: 'open-stage-log', ticketId: 1, stageKey: 'review' });
    expect(dispatchInsideAction(store, r3, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'no log artifact recorded',
    });
  });

  it('dispatches resume-stage only while the stage is actually blocked', () => {
    parkGateStage(store, {
      ticketId: 1,
      stageKey: 'uat',
      kind: 'nothing-to-run',
      reason: 'no target resolved',
      runAt: '2026-08-08T10:00:00.000Z',
      gates: [],
    });

    const r = registry(7);
    r.register({ kind: 'resume-stage', ticketId: 1, stageKey: 'uat' });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['resume:1:uat']);

    // The same id after the block was cleared is rejected — a stale snapshot
    // must not resume a stage that is no longer parked.
    store.db
      .prepare("UPDATE stages SET blocked_kind = NULL, blocked_reason = NULL, blocked_at = NULL WHERE ticket_id = 1 AND stage_key = 'uat'")
      .run();
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'stage is not blocked',
    });
  });

  it('dispatches open-full-evidence only for a process run owned by this ticket', () => {
    const run = openProcessRun(store, {
      ticketId: 1,
      stageKey: 'impl',
      processId: 'session',
      attempt: 0,
      startedAt: '2026-08-08T10:00:00.000Z',
    });

    const r = registry(7);
    r.register({ kind: 'open-full-evidence', ticketId: 1, processRunId: run.id });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['evidence:1:1']);

    r.register({ kind: 'open-full-evidence', ticketId: 2, processRunId: run.id });
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-1', deps([]))).toEqual({
      outcome: 'unknown',
    });
  });

  it('dispatches open-session only while the ticket has a live implementation run', () => {
    const r = registry(7);
    r.register({ kind: 'open-session', ticketId: 1 });
    const calls: string[] = [];
    // No implementation run recorded at all yet — rejected, never dispatched
    // against a ticket that never opened a session.
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'rejected',
      reason: 'no live implementation session for this ticket',
    });

    openImplementationRun(store, {
      ticketId: 1,
      attempt: 0,
      provider: 'claude',
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['open-session:1']);

    // The run ended (the done marker fired) — the same id must now refuse:
    // the session that produced it is gone, there is nothing left to reveal.
    completeImplementationRun(store, 1, '2026-08-08T11:00:00.000Z');
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'no live implementation session for this ticket',
    });
  });

  it('dispatches host-owned bounded evidence without accepting row data from the client', () => {
    const r = registry(7);
    r.register({
      kind: 'open-bounded-evidence',
      ticketId: 1,
      title: 'Ship · Commit',
      rows: [
        { status: 'pass', label: '/web', detail: '2 created' },
        { status: 'pass', label: '/api', detail: '1 created' },
      ],
    });
    const calls: string[] = [];

    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['bounded:1:Ship · Commit:/web,/api']);
  });

  it('a client-supplied kind, repo, path, number or sha never affects dispatch', () => {
    // The registry stores the target; the action id alone is resolved. A
    // message that FORGED these fields carries none of them — the parse
    // boundary (messages.test.ts) rejects the payload — and an id minted for
    // one target can never resolve to another.
    const id = reviewFindingId({ file: 'src/foo.ts' });
    const r = registry(7);
    r.register({ kind: 'open-file', ticketId: 1, evidence: { source: 'review-finding', id } });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['file:/wt/web/src/foo.ts']);
  });

  it('dispatches graph-open-session only for a node/planner run owned by this ticket', () => {
    const mine = seedGraph({ ticketId: 1, runId: 1 });
    seedNodeRun(mine.revisionId, { id: 11, graphRunId: 1 });
    seedPlannerRun(1, { id: 21 });
    // A node run under ANOTHER ticket's graph run: exists, but not this
    // ticket's — rejected, never revealed.
    const theirs = seedGraph({ ticketId: 2, runId: 2 });
    seedNodeRun(theirs.revisionId, { id: 12, graphRunId: 2 });

    const r = registry(7);
    r.register({ kind: 'graph-open-session', ticketId: 1, session: { kind: 'node', runId: 11 } });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-open:1:node:11']);

    const r2 = registry(7);
    r2.register({ kind: 'graph-open-session', ticketId: 1, session: { kind: 'planner', runId: 21 } });
    expect(dispatchInsideAction(store, r2, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'dispatched',
    });

    const r3 = registry(7);
    r3.register({ kind: 'graph-open-session', ticketId: 1, session: { kind: 'node', runId: 12 } });
    expect(dispatchInsideAction(store, r3, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'session run not found for this ticket',
    });

    const r4 = registry(7);
    r4.register({ kind: 'graph-open-session', ticketId: 1, session: { kind: 'node', runId: 999 } });
    expect(dispatchInsideAction(store, r4, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'session run not found for this ticket',
    });
  });

  it('dispatches graph-stop only to the graph run that minted the capability', () => {
    seedGraph({ ticketId: 1, runId: 1, status: 'running' });
    const r = registry(7);
    r.register({ kind: 'graph-stop', ticketId: 1, graphRunId: 1 });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-stop:1:1']);

    store.db.prepare("UPDATE approach_graph_runs SET status = 'blocked' WHERE id = 1").run();
    const blocked = registry(7);
    blocked.register({ kind: 'graph-stop', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, blocked, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-stop:1:1', 'graph-stop:1:1']);

    // Once the original run has finished, a capability from its old panel must
    // not be redirected to this newer running graph run.
    store.db.prepare("UPDATE approach_graph_runs SET status = 'closed' WHERE id = 1").run();
    seedGraph({ ticketId: 1, runId: 2, stageAttempt: 1, status: 'running' });
    const stale = registry(8);
    stale.register({ kind: 'graph-stop', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, stale, 'snapshot-8:action-0', deps(calls))).toEqual({
      outcome: 'rejected',
      reason: 'graph run is not stoppable',
    });
    expect(calls).toEqual(['graph-stop:1:1', 'graph-stop:1:1']);

    // A ticket with NO graph run is rejected — Stop never signals nothing.
    const r2 = registry(7, 2);
    r2.register({ kind: 'graph-stop', ticketId: 2, graphRunId: 99 });
    expect(dispatchInsideAction(store, r2, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'graph run is not stoppable',
    });

    // A run that is no longer stoppable (closed) is rejected, never stopped.
    store.db
      .prepare("UPDATE approach_graph_runs SET status = 'closed' WHERE id = 2")
      .run();
    const r3 = registry(7);
    r3.register({ kind: 'graph-stop', ticketId: 1, graphRunId: 2 });
    expect(dispatchInsideAction(store, r3, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'graph run is not stoppable',
    });
  });

  it('dispatches graph recovery controls only while the recorded run is blocked', () => {
    seedGraph({ ticketId: 1, runId: 1, status: 'blocked' });
    const calls: string[] = [];
    const actions = registry(7);
    actions.register({ kind: 'graph-resume', ticketId: 1, graphRunId: 1 });
    actions.register({ kind: 'graph-replan', ticketId: 1, graphRunId: 1 });

    expect(dispatchInsideAction(store, actions, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(dispatchInsideAction(store, actions, 'snapshot-7:action-1', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-resume:1:1', 'graph-replan:1:1']);

    store.db.prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = 1").run();
    const stale = registry(8);
    stale.register({ kind: 'graph-resume', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, stale, 'snapshot-8:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'graph is not blocked',
    });
  });

  it('H2: dispatches graph-restart only for a run drained with no live replan planner', () => {
    seedGraph({ ticketId: 1, runId: 1, status: 'draining' });
    const calls: string[] = [];
    const actions = registry(7);
    actions.register({ kind: 'graph-restart', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, actions, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-restart:1:1']);

    // A run draining FOR a replan planner is mid-replan: the coordinator owns
    // its exit, and a restart would race the submission it is waiting for.
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status)
         VALUES (1, 2, 'replan', 'running')`,
      )
      .run();
    const mid = registry(8);
    mid.register({ kind: 'graph-restart', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, mid, 'snapshot-8:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'graph is not a stopped drain',
    });

    // A running run is not a drain at all.
    store.db.prepare("UPDATE approach_planner_runs SET status = 'stale' WHERE kind = 'replan'").run();
    store.db.prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = 1").run();
    const stale = registry(9);
    stale.register({ kind: 'graph-restart', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, stale, 'snapshot-9:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'graph is not a stopped drain',
    });
  });

  it('dispatches graph-confirm only while the ticket awaits graph confirmation', () => {
    seedGraph({ ticketId: 1, runId: 1, status: 'awaiting-confirmation' });
    const r = registry(7);
    r.register({ kind: 'graph-confirm', ticketId: 1, graphRunId: 1 });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-confirm:1:1']);

    store.db.prepare("UPDATE approach_graph_runs SET status = 'cancelled' WHERE id = 1").run();
    seedGraph({ ticketId: 1, runId: 2, stageAttempt: 1, status: 'awaiting-confirmation' });
    const stale = registry(8);
    stale.register({ kind: 'graph-confirm', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, stale, 'snapshot-8:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'graph is not awaiting confirmation',
    });
  });

  it('dispatches graph-mark-impl only while the run awaits the implementation marker', () => {
    seedGraph({ ticketId: 1, runId: 1, status: 'completed-awaiting-impl-marker' });
    const r = registry(7);
    r.register({ kind: 'graph-mark-impl', ticketId: 1, graphRunId: 1 });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-mark-impl:1:1']);

    store.db.prepare("UPDATE approach_graph_runs SET status = 'closed' WHERE id = 1").run();
    const stale = registry(8);
    stale.register({ kind: 'graph-mark-impl', ticketId: 1, graphRunId: 1 });
    expect(dispatchInsideAction(store, stale, 'snapshot-8:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'graph is not awaiting the implementation marker',
    });
  });

  it('dispatches graph-discard-node only for a node run owned by this ticket', () => {
    const mine = seedGraph({ ticketId: 1, runId: 1 });
    seedNodeRun(mine.revisionId, { id: 61, graphRunId: 1, status: 'termination-unknown' });
    // A node run under ANOTHER ticket's graph run: exists, but not this
    // ticket's — rejected, never discarded.
    const theirs = seedGraph({ ticketId: 2, runId: 2 });
    seedNodeRun(theirs.revisionId, { id: 62, graphRunId: 2, status: 'termination-unknown' });

    const r = registry(7);
    r.register({ kind: 'graph-discard-node', ticketId: 1, nodeRunId: 61 });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-discard:1:61']);

    const r2 = registry(7);
    r2.register({ kind: 'graph-discard-node', ticketId: 1, nodeRunId: 62 });
    expect(dispatchInsideAction(store, r2, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'node run not found for this ticket',
    });

    const r3 = registry(7);
    r3.register({ kind: 'graph-discard-node', ticketId: 1, nodeRunId: 999 });
    expect(dispatchInsideAction(store, r3, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'node run not found for this ticket',
    });
  });

  it('dispatches graph-edit-override only for a node run owned by this ticket', () => {
    const mine = seedGraph({ ticketId: 1, runId: 1 });
    seedNodeRun(mine.revisionId, { id: 71, graphRunId: 1, status: 'blocked' });
    // A node run under ANOTHER ticket's graph run: exists, but not this
    // ticket's — rejected, never handed to the editor.
    const theirs = seedGraph({ ticketId: 2, runId: 2 });
    seedNodeRun(theirs.revisionId, { id: 72, graphRunId: 2, status: 'blocked' });

    const r = registry(7);
    r.register({ kind: 'graph-edit-override', ticketId: 1, nodeRunId: 71 });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['graph-edit-override:1:71']);

    const r2 = registry(7);
    r2.register({ kind: 'graph-edit-override', ticketId: 1, nodeRunId: 72 });
    expect(dispatchInsideAction(store, r2, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'node run not found for this ticket',
    });

    const r3 = registry(7);
    r3.register({ kind: 'graph-edit-override', ticketId: 1, nodeRunId: 999 });
    expect(dispatchInsideAction(store, r3, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'node run not found for this ticket',
    });
  });

  it('dispatches retry-ship-repo only for a failed step on a ticket at ship', () => {
    // Set ticket 1 to the ship stage.
    store.db
      .prepare(`UPDATE tickets SET stage_current = 'ship' WHERE id = 1`)
      .run();
    // Also seed a ship stage row so the ticket is consistent.
    store.db
      .prepare(
        `INSERT INTO stages (ticket_id, stage_key, status) VALUES (1, 'ship', 'running')`,
      )
      .run();

    const shipRun = openShipRun(store, {
      ticketId: 1,
      attempt: 1,
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    const step = openShipRepoStep(store, {
      shipRunId: shipRun.id,
      repo: '/web',
      step: 'describe',
      detail: 'running',
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    finishShipRepoStep(store, step.id, {
      status: 'failed',
      detail: 'agent crashed',
      endedAt: '2026-08-08T10:01:00.000Z',
    });

    const r = registry(7);
    r.register({ kind: 'retry-ship-repo', ticketId: 1, shipRepoStepId: step.id });
    const calls: string[] = [];
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps(calls))).toEqual({
      outcome: 'dispatched',
    });
    expect(calls).toEqual(['retry-ship-repo:1:/web']);
  });

  it('rejects retry-ship-repo for an unknown step id', () => {
    const r = registry(7);
    r.register({ kind: 'retry-ship-repo', ticketId: 1, shipRepoStepId: 999 });
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'ship repo step not found for this ticket',
    });
  });

  it('rejects retry-ship-repo for a step belonging to another ticket', () => {
    store.db
      .prepare(`UPDATE tickets SET stage_current = 'ship' WHERE id = 2`)
      .run();
    store.db
      .prepare(
        `INSERT INTO stages (ticket_id, stage_key, status) VALUES (2, 'ship', 'running')`,
      )
      .run();

    const shipRun = openShipRun(store, {
      ticketId: 2,
      attempt: 1,
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    const step = openShipRepoStep(store, {
      shipRunId: shipRun.id,
      repo: '/web',
      step: 'describe',
      detail: 'running',
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    finishShipRepoStep(store, step.id, {
      status: 'failed',
      detail: 'agent crashed',
      endedAt: '2026-08-08T10:01:00.000Z',
    });

    // Ticket 1 tries to retry ticket 2's step — rejected.
    const r = registry(7);
    r.register({ kind: 'retry-ship-repo', ticketId: 1, shipRepoStepId: step.id });
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'ship repo step not found for this ticket',
    });
  });

  it('rejects retry-ship-repo when the step is not failed', () => {
    store.db
      .prepare(
        `INSERT INTO stages (ticket_id, stage_key, status) VALUES (1, 'ship', 'running')`,
      )
      .run();

    const shipRun = openShipRun(store, {
      ticketId: 1,
      attempt: 1,
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    const step = openShipRepoStep(store, {
      shipRunId: shipRun.id,
      repo: '/web',
      step: 'describe',
      detail: 'running',
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    finishShipRepoStep(store, step.id, {
      status: 'passed',
      detail: 'done',
      endedAt: '2026-08-08T10:01:00.000Z',
    });

    const r = registry(7);
    r.register({ kind: 'retry-ship-repo', ticketId: 1, shipRepoStepId: step.id });
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'ship step is not failed',
    });
  });

  it('rejects retry-ship-repo when the ticket is not at ship', () => {
    // Ticket 1 has no 'ship' stage (only uat/review in beforeEach).
    const shipRun = openShipRun(store, {
      ticketId: 1,
      attempt: 1,
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    const step = openShipRepoStep(store, {
      shipRunId: shipRun.id,
      repo: '/web',
      step: 'describe',
      detail: 'running',
      startedAt: '2026-08-08T10:00:00.000Z',
    });
    finishShipRepoStep(store, step.id, {
      status: 'failed',
      detail: 'agent crashed',
      endedAt: '2026-08-08T10:01:00.000Z',
    });

    const r = registry(7);
    r.register({ kind: 'retry-ship-repo', ticketId: 1, shipRepoStepId: step.id });
    expect(dispatchInsideAction(store, r, 'snapshot-7:action-0', deps([]))).toEqual({
      outcome: 'rejected',
      reason: 'ticket is not at ship',
    });
  });
});
