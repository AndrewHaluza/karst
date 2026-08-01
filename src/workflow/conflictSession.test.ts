import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { buildConflictBrief } from './conflictSession.js';

function seedWorktree(store: Store, ticketId: number, repo: string, path: string, baseRef: string | null = 'main'): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, `karst/${repo}`, baseRef);
}

function seedPr(store: Store, ticketId: number, repo: string, number: number): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, number, `https://github.com/o/r/pull/${number}`, 'open');
}

function conflict(store: Store, ticketId: number, repo: string, files: string[]): void {
  setMergeCheck(store, {
    ticketId,
    repo,
    state: 'conflicted',
    files,
    reason: null,
    headSha: 'h',
    baseSha: 'b',
    baseRef: 'main',
    checkedAt: '2026-07-28T12:00:00.000Z',
  });
}

describe('buildConflictBrief', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('briefs the agent with the conflicting repo’s worktree, base and files', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api');
    seedPr(store, t.id, 'api', 12);
    conflict(store, t.id, 'api', ['src/a.ts']);

    const brief = buildConflictBrief(store, t.id, 'api');

    expect(brief).toContain('PROJ-1');
    expect(brief).toContain('/wt/api');
    expect(brief).toContain('karst/api');
    expect(brief).toContain('origin/main');
    expect(brief).toContain('src/a.ts');
    expect(brief).toContain('https://github.com/o/r/pull/12');
  });

  // The button is only offered for a conflicted repo, but the request arrives as
  // a webview message: acting on a repo the store says is fine would open a
  // session to merge a branch that has nothing to resolve.
  it('refuses a repo whose stored verdict is not conflicted', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'h',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });

    expect(buildConflictBrief(store, t.id, 'api')).toBeNull();
  });

  // The panel can still be carrying the pre-merge verdict when the click lands.
  // A landed branch has nothing to resolve, and the session would be opened
  // against a base the work is already part of.
  it('refuses a repo whose PR has since merged', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api');
    seedPr(store, t.id, 'api', 12);
    conflict(store, t.id, 'api', ['src/a.ts']);
    store.db
      .prepare("UPDATE prs SET status = 'merged' WHERE ticket_id = ? AND repo = ?")
      .run(t.id, 'api');

    expect(buildConflictBrief(store, t.id, 'api')).toBeNull();
  });

  it('refuses a repo that was never checked', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api');

    expect(buildConflictBrief(store, t.id, 'api')).toBeNull();
  });

  // No worktree means nowhere to run the merge. Naming another repo's directory
  // would send the agent at the wrong tree.
  it('refuses a conflicted repo whose worktree is gone', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'web', '/wt/web');
    conflict(store, t.id, 'api', ['src/a.ts']);

    expect(buildConflictBrief(store, t.id, 'api')).toBeNull();
  });

  // The verdict carries the ref it was actually measured against; the worktree
  // row is only the fallback. A base that moved must not be described with the
  // branch the worktree happened to be cut from.
  it('prefers the base the verdict was measured against over the worktree’s', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api', 'develop');
    conflict(store, t.id, 'api', ['src/a.ts']);

    expect(buildConflictBrief(store, t.id, 'api')).toContain('origin/main');
  });

  it('falls back to the worktree’s base when the verdict recorded none', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api', 'develop');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'conflicted',
      files: [],
      reason: null,
      headSha: 'h',
      baseSha: 'b',
      baseRef: null,
      checkedAt: '2026-07-28T12:00:00.000Z',
    });

    expect(buildConflictBrief(store, t.id, 'api')).toContain('origin/develop');
  });

  // Legacy rows predate the key, and the label is the first thing the agent
  // reads — "Ticket null cannot merge" names nothing.
  it('labels a keyless ticket by id rather than printing "null"', () => {
    const info = store.db
      .prepare(
        `INSERT INTO tickets (key, title, stage_current, agent_state) VALUES (NULL, 'thing', 'ship', 'none')`,
      )
      .run();
    const id = Number(info.lastInsertRowid);
    seedWorktree(store, id, 'api', '/wt/api');
    conflict(store, id, 'api', []);

    expect(buildConflictBrief(store, id, 'api')).toContain(`#${id}`);
  });
});
