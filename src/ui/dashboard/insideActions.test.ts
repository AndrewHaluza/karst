import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { recordFindings } from '../../store/reviewFindings.js';
import { recordUatFindings } from '../../store/uatFindings.js';
import { openShipRun, recordShipCommit } from '../../store/shipRuns.js';
import { openProcessRun } from '../../store/processRuns.js';
import { parkGateStage } from '../../store/stageBlocks.js';
import {
  InsideActionRegistry,
  dispatchInsideAction,
  resolveOpenFileTarget,
  type InsideActionTarget,
  type InsideFileFs,
  type InsideActionHost,
} from './insideActions.js';

let store: Store;

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
        line: over.line ?? 12,
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
    expect(resolved).toEqual({ path: '/wt/web/src/foo.ts' });
  });

  it('opens a uat finding the same way', () => {
    const id = uatFindingId({ file: 'e2e/spec.ts' });
    const resolved = resolveOpenFileTarget(
      store,
      { kind: 'open-file', ticketId: 1, evidence: { source: 'uat-finding', id } },
      deps,
    );
    expect(resolved).toEqual({ path: '/wt/web/e2e/spec.ts' });
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
    expect(resolved).toEqual({ path: '/wt/web/src/not/here/yet.ts' });
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
});

