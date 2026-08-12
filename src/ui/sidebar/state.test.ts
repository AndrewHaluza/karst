import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, archiveTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { buildSidebarState, RECENT_DONE_LIMIT } from './state.js';

/** Stamp a ticket done at a specific completion time (stage row + current stage). */
function markDone(store: Store, id: number, doneAt: string): void {
  store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(id);
  store.db
    .prepare(
      "UPDATE stages SET status = 'passed', ended_at = ? WHERE ticket_id = ? AND stage_key = 'done'",
    )
    .run(doneAt, id);
}

describe('buildSidebarState', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('default (all) facet excludes archived and returns active rows in Current', () => {
    createTicket(store, { key: 'A-1', title: 'active' });
    const gone = createTicket(store, { key: 'B-1', title: 'archived' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.current.map((r) => r.label)).toEqual(['A-1 — active']);
    expect(state.facets).toEqual(['all']);
    expect(state.sections.recentlyDone).toEqual([]);
    expect(state.sections.olderDone).toEqual([]);
  });

  it('shows only the bound project when one is given', () => {
    createTicket(store, { key: 'A-1', title: 'mine', projectId: 1 });
    createTicket(store, { key: 'B-1', title: 'theirs', projectId: 2 });

    const state = buildSidebarState(store, { facets: ['all'], filter: '', projectId: 1 });
    expect(state.sections.current.map((r) => r.label)).toEqual(['A-1 — mine']);
  });

  it('scopes the archived facet to the bound project too', () => {
    const mine = createTicket(store, { key: 'A-1', title: 'mine', projectId: 1 });
    const theirs = createTicket(store, { key: 'B-1', title: 'theirs', projectId: 2 });
    archiveTicket(store, mine.id);
    archiveTicket(store, theirs.id);

    const state = buildSidebarState(store, { facets: ['archived'], filter: '', projectId: 1 });
    expect(state.rows.map((r) => r.ticketId)).toEqual([mine.id]);
  });

  it('counts reflect only the bound project, so the chips do not leak', () => {
    createTicket(store, { key: 'A-1', title: 'mine', projectId: 1 });
    createTicket(store, { key: 'B-1', title: 'theirs', projectId: 2 });
    const other = createTicket(store, { key: 'B-2', title: 'theirs archived', projectId: 2 });
    archiveTicket(store, other.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: '', projectId: 1 });
    expect(state.counts.all).toBe(1);
    expect(state.counts.archived).toBe(0);
  });

  it('archived facet lists only archived tickets', () => {
    createTicket(store, { key: 'A-1', title: 'active' });
    const gone = createTicket(store, { key: 'B-1', title: 'archived' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facets: ['archived'], filter: '' });
    expect(state.rows.map((r) => r.ticketId)).toEqual([gone.id]);
    expect(state.rows[0]!.archived).toBe(true);
  });

  it('running facet narrows to running-stage tickets (flat rows, no sections)', () => {
    const r = createTicket(store, { key: 'R-1', title: 'running' });
    setStage(store, r.id, 'scope', { status: 'running' });
    createTicket(store, { key: 'P-1', title: 'pending' });

    const state = buildSidebarState(store, { facets: ['running'], filter: '' });
    expect(state.rows.map((x) => x.ticketId)).toEqual([r.id]);
    expect(state.sections.current).toEqual([]);
    expect(state.done).toEqual([]);
  });

  it('a multi-status selection returns the union (fix: several statuses at once)', () => {
    const r = createTicket(store, { key: 'R-1', title: 'running' });
    setStage(store, r.id, 'scope', { status: 'running' });
    const f = createTicket(store, { key: 'F-1', title: 'failed' });
    setStage(store, f.id, 'scope', { status: 'failed' });
    createTicket(store, { key: 'P-1', title: 'pending' });

    const state = buildSidebarState(store, { facets: ['running', 'failed'], filter: '' });
    expect(state.rows.map((x) => x.ticketId).sort()).toEqual([r.id, f.id].sort());
    expect(state.facets).toEqual(['running', 'failed']);
  });

  it('filter narrows by key/title, case-insensitive, inside every section', () => {
    createTicket(store, { key: 'A-1', title: 'add login' });
    const d = createTicket(store, { key: 'D-1', title: 'fix logout' });
    markDone(store, d.id, '2026-08-11T10:00:00Z');

    const state = buildSidebarState(store, { facets: ['all'], filter: 'LOGIN' });
    expect(state.sections.current.map((r) => r.label)).toEqual(['A-1 — add login']);
    expect(state.sections.recentlyDone).toEqual([]);
  });

  it('counts reflect the full active list + archived total, not the filter', () => {
    createTicket(store, { key: 'A-1', title: 'add login' });
    const gone = createTicket(store, { key: 'B-1', title: 'gone' });
    archiveTicket(store, gone.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: 'login' });
    expect(state.sections.current).toHaveLength(1); // filtered
    expect(state.counts.all).toBe(1); // one active ticket total
    expect(state.counts.archived).toBe(1);
  });

  it('rows carry the ticket servers and worktrees for the expanded body', () => {
    const t = createTicket(store, { key: 'A-1', title: 'has infra' });
    store.db
      .prepare("INSERT INTO servers (ticket_id, repo, host, port, status) VALUES (?,?,?,?, 'running')")
      .run(t.id, 'backend', 'localhost', 4000);
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, 'backend', '/wt/backend', 'feature/A-1');

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    const row = state.sections.current[0]!;
    expect(row.servers.map((s) => s.service)).toEqual(['backend']);
    expect(row.worktrees.map((w) => w.repo)).toEqual(['backend']);
  });

  it('worktree repoDisplay is the absolute repo path when no PathContext given', () => {
    const t = createTicket(store, { key: 'A-1', title: 'wt' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, '/Users/nd/Work/projects/tatto-timer', '/wt/tt', 'feature/A-1');

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.current[0]!.worktrees[0]!.repoDisplay).toBe(
      '/Users/nd/Work/projects/tatto-timer',
    );
  });

  it('worktree repoDisplay is project-relative under a relative PathContext', () => {
    const t = createTicket(store, { key: 'A-1', title: 'wt' });
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?,?,?,?)')
      .run(t.id, '/Users/nd/Work/projects/tatto-timer', '/wt/tt', 'feature/A-1');

    const state = buildSidebarState(
      store,
      { facets: ['all'], filter: '' },
      { display: 'relative', projectRoot: '/Users/nd/Work/projects/tatto-timer' },
    );
    // repo IS the workspace root → `./<name>` (the bug's single-repo case).
    expect(state.sections.current[0]!.worktrees[0]!.repoDisplay).toBe('./tatto-timer');
  });

  it("resolves a follow-up row's parentKey even when the parent sits in a different facet", () => {
    const parent = createTicket(store, { key: 'PROJ-1', title: 'root' });
    store.db.prepare("UPDATE tickets SET stage_current = 'done' WHERE id = ?").run(parent.id);
    archiveTicket(store, parent.id); // parent is archived; child is not
    createTicket(store, { key: 'PROJ-1-fu1', title: 'follow-up', parentTicketId: parent.id });

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    const child = state.sections.current.find((r) => r.label.startsWith('PROJ-1-fu1'));
    expect(child?.parentKey).toBe('PROJ-1');
  });

  it('marks only the active ticket row when activeTicketId matches', () => {
    const a = createTicket(store, { key: 'A-1', title: 'first' });
    const b = createTicket(store, { key: 'B-1', title: 'second' });

    const state = buildSidebarState(store, { facets: ['all'], filter: '', activeTicketId: b.id });
    expect(state.sections.current.find((r) => r.ticketId === a.id)?.isActive).toBe(false);
    expect(state.sections.current.find((r) => r.ticketId === b.id)?.isActive).toBe(true);
  });

  it('marks no row active when activeTicketId is absent or null', () => {
    createTicket(store, { key: 'A-1', title: 'first' });

    for (const activeTicketId of [undefined, null]) {
      const state = buildSidebarState(store, { facets: ['all'], filter: '', activeTicketId });
      expect(state.sections.current.every((r) => r.isActive === false)).toBe(true);
    }
  });

  it('keeps the active mark off rows a facet hides (nothing to highlight there)', () => {
    const a = createTicket(store, { key: 'A-1', title: 'active ticket' });
    archiveTicket(store, a.id);

    const state = buildSidebarState(store, { facets: ['all'], filter: '', activeTicketId: a.id });
    expect(state.sections.current).toHaveLength(0);
  });

  // ── Current / Recently Done / Older Completed sections ────────────────────

  it('splits the all view into Current, Recently Done and Older Completed', () => {
    for (let i = 0; i < 7; i++) createTicket(store, { key: `C-${i}`, title: `current ${i}` });
    for (let i = 0; i < 40; i++) {
      const t = createTicket(store, { key: `D-${i}`, title: `done ${i}` });
      markDone(store, t.id, `2026-08-10T10:00:${String(i).padStart(2, '0')}Z`);
    }

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.current).toHaveLength(7);
    expect(state.sections.recentlyDone).toHaveLength(3);
    expect(state.sections.olderDone).toHaveLength(37);
    // Newest first in both completed lists.
    expect(state.sections.recentlyDone.map((r) => r.label)).toEqual([
      'D-39 — done 39',
      'D-38 — done 38',
      'D-37 — done 37',
    ]);
    expect(state.sections.olderDone[0]!.label).toBe('D-36 — done 36');
    expect(state.sections.olderDone.at(-1)!.label).toBe('D-0 — done 0');
  });

  it('shows at most RECENT_DONE_LIMIT recently done, newest first', () => {
    for (let i = 0; i < 5; i++) {
      const t = createTicket(store, { key: `D-${i}`, title: `done ${i}` });
      markDone(store, t.id, `2026-08-10T10:00:0${i}Z`);
    }

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.recentlyDone.map((r) => r.label)).toEqual([
      'D-4 — done 4',
      'D-3 — done 3',
      'D-2 — done 2',
    ]);
    expect(state.sections.olderDone.map((r) => r.label)).toEqual(['D-1 — done 1', 'D-0 — done 0']);
    expect(RECENT_DONE_LIMIT).toBe(3);
  });

  it('0 done tickets render no completed sections at all', () => {
    createTicket(store, { key: 'A-1', title: 'only' });
    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.recentlyDone).toEqual([]);
    expect(state.sections.olderDone).toEqual([]);
  });

  it('1–3 done tickets show only Recently Done', () => {
    for (let i = 0; i < 3; i++) {
      const t = createTicket(store, { key: `D-${i}`, title: `done ${i}` });
      markDone(store, t.id, `2026-08-10T10:00:0${i}Z`);
    }
    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.recentlyDone).toHaveLength(3);
    expect(state.sections.olderDone).toEqual([]);
  });

  it('a fourth recent completion pushes the oldest recent item into Older Completed', () => {
    for (let i = 0; i < 3; i++) {
      const t = createTicket(store, { key: `D-${i}`, title: `done ${i}` });
      markDone(store, t.id, `2026-08-10T10:00:0${i}Z`);
    }
    const fourth = createTicket(store, { key: 'D-3', title: 'fourth' });
    markDone(store, fourth.id, '2026-08-11T10:00:00Z');

    const state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.recentlyDone.map((r) => r.label)).toEqual([
      'D-3 — fourth',
      'D-2 — done 2',
      'D-1 — done 1',
    ]);
    expect(state.sections.olderDone.map((r) => r.label)).toEqual(['D-0 — done 0']);
  });

  it('completing a ticket never reorders the remaining Current tickets (core invariant)', () => {
    const a = createTicket(store, { key: 'A-1', title: 'A' });
    const b = createTicket(store, { key: 'B-1', title: 'B' });
    const c = createTicket(store, { key: 'C-1', title: 'C' });
    // Canonical order (created_at DESC, id DESC): C, B, A.
    const before = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(before.sections.current.map((r) => r.ticketId)).toEqual([c.id, b.id, a.id]);

    markDone(store, b.id, '2026-08-11T10:00:00Z');
    const after = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(after.sections.current.map((r) => r.ticketId)).toEqual([c.id, a.id]);
    expect(after.sections.recentlyDone.map((r) => r.ticketId)).toEqual([b.id]);
  });

  it('falls back to the ticket updatedAt for ordering when the done stage has no end time', () => {
    const later = createTicket(store, { key: 'L-1', title: 'later' });
    const earlier = createTicket(store, { key: 'E-1', title: 'earlier' });
    // SQLite space-form `updated_at` (the datetime('now') shape), no done stage
    // end time — the fallback must still order newest first.
    store.db
      .prepare("UPDATE tickets SET stage_current = 'done', updated_at = ? WHERE id = ?")
      .run('2026-08-11 10:00:00', earlier.id);
    store.db
      .prepare("UPDATE tickets SET stage_current = 'done', updated_at = ? WHERE id = ?")
      .run('2026-08-11 12:00:00', later.id);

    const state = buildSidebarState(store, { facets: ['done'], filter: '' });
    expect(state.done.map((r) => r.label)).toEqual(['L-1 — later', 'E-1 — earlier']);
  });

  it('a reopened done ticket returns to Current in canonical order and leaves the completed lists', () => {
    const a = createTicket(store, { key: 'A-1', title: 'A' });
    const b = createTicket(store, { key: 'B-1', title: 'B' });
    markDone(store, b.id, '2026-08-11T10:00:00Z');

    let state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.current.map((r) => r.ticketId)).toEqual([a.id]);
    expect(state.sections.recentlyDone.map((r) => r.ticketId)).toEqual([b.id]);

    // Reopen: the stage moves back off `done` — no special handling needed.
    store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(b.id);
    state = buildSidebarState(store, { facets: ['all'], filter: '' });
    expect(state.sections.current.map((r) => r.ticketId)).toEqual([b.id, a.id]);
    expect(state.sections.recentlyDone).toEqual([]);
    expect(state.sections.olderDone).toEqual([]);
  });

  it('done facet shows the full completed list directly, newest first, no sections', () => {
    const d1 = createTicket(store, { key: 'D-1', title: 'oldest' });
    markDone(store, d1.id, '2026-08-10T10:00:00Z');
    const d2 = createTicket(store, { key: 'D-2', title: 'newest' });
    markDone(store, d2.id, '2026-08-11T10:00:00Z');
    createTicket(store, { key: 'A-1', title: 'current' });

    const state = buildSidebarState(store, { facets: ['done'], filter: '' });
    expect(state.done.map((r) => r.label)).toEqual(['D-2 — newest', 'D-1 — oldest']);
    expect(state.sections.current).toEqual([]);
    expect(state.sections.recentlyDone).toEqual([]);
  });

  it('search finds tickets inside collapsed Older Completed and reveals them there', () => {
    for (let i = 0; i < 5; i++) {
      const t = createTicket(store, { key: `D-${i}`, title: `done ${i}` });
      markDone(store, t.id, `2026-08-10T10:00:0${i}Z`);
    }
    const state = buildSidebarState(store, { facets: ['all'], filter: 'done 1' });
    // D-1 sits BEYOND the recent-3 boundary; the query must surface it there.
    expect(state.sections.olderDone.map((r) => r.label)).toEqual(['D-1 — done 1']);
    expect(state.sections.recentlyDone).toEqual([]);
  });

  // ── Expanded mini-dashboard (peek) ─────────────────────────────────────────

  it('a done ticket peek offers Create follow-up as its primary next action', () => {
    const t = createTicket(store, { key: 'D-1', title: 'done' });
    markDone(store, t.id, '2026-08-11T10:00:00Z');

    const row = buildSidebarState(store, { facets: ['done'], filter: '' }).done[0]!;
    expect(row.peek.title).toBe('Shipped');
    expect(row.peek.next).toEqual({ kind: 'create-follow-up', label: 'Create follow-up ticket' });
  });

  it('a ship ticket awaiting merge carries the landing state in its peek', () => {
    const t = createTicket(store, { key: 'S-1', title: 'ship' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'ship', { status: 'passed' });
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?,?,?,?,?)')
      .run(t.id, 'api', 1, 'https://github.com/x/pull/1', 'open');

    const row = buildSidebarState(store, { facets: ['all'], filter: '' }).sections.current[0]!;
    expect(row.peek.title).toBe('1 pull request awaiting merge');
    expect(row.peek.detail).toBe('api');
    expect(row.peek.next).toBeNull();
  });

  it('a conflicted ship names the conflict and offers Resolve conflicts', () => {
    const t = createTicket(store, { key: 'S-1', title: 'ship' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'ship', { status: 'passed' });
    store.db
      .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?,?,?,?,?)')
      .run(t.id, 'api', 1, 'https://github.com/x/pull/1', 'open');
    setMergeCheck(store, {
      ticketId: t.id,
      repo: 'api',
      state: 'conflicted',
      files: ['src/a.ts'],
      reason: null,
      headSha: null,
      baseSha: null,
      baseRef: 'develop',
      checkedAt: '2026-08-12T10:00:00Z',
    });

    const row = buildSidebarState(store, { facets: ['all'], filter: '' }).sections.current[0]!;
    expect(row.peek.title).toBe('1 merge conflict in api');
    expect(row.peek.next).toEqual({ kind: 'resolve-conflicts', label: 'Resolve conflicts', repo: 'api' });
  });

  it('a running uat ticket carries its gate progress in the peek', () => {
    const t = createTicket(store, { key: 'U-1', title: 'uat' });
    store.db.prepare("UPDATE tickets SET stage_current = 'uat' WHERE id = ?").run(t.id);
    setStage(store, t.id, 'uat', { status: 'running' });
    recordGateRun(store, {
      ticketId: t.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-08-12T10:00:00Z',
      gates: [
        { gateName: 'test', exitCode: 0, repo: '/wt/api' },
        { gateName: 'lint', exitCode: null, repo: '/wt/web' },
      ],
    });

    const row = buildSidebarState(store, { facets: ['all'], filter: '' }).sections.current[0]!;
    expect(row.peek.title).toBe('UAT running');
    expect(row.peek.detail).toBe('1/2 gates passed');
  });
});

