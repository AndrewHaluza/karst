import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { parseConflictBriefArgs, runConflictBriefCommand } from './conflictBriefCommand.js';

function seedWorktree(store: Store, ticketId: number, repo: string, path: string, baseRef: string | null = 'main'): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, `karst/${repo}`, baseRef);
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

describe('parseConflictBriefArgs', () => {
  it('parses key and repo', () => {
    expect(parseConflictBriefArgs(['conflict-brief', 'PROJ-1', 'api'])).toEqual({
      key: 'PROJ-1',
      repo: 'api',
    });
  });

  it('throws on the wrong command', () => {
    expect(() => parseConflictBriefArgs(['context', 'PROJ-1', 'api'])).toThrow(/conflict-brief/);
  });

  it('throws when the key is missing', () => {
    expect(() => parseConflictBriefArgs(['conflict-brief'])).toThrow(/key/);
  });

  it('throws when the repo is missing', () => {
    expect(() => parseConflictBriefArgs(['conflict-brief', 'PROJ-1'])).toThrow(/missing repo/);
  });

  it('throws on extra arguments', () => {
    expect(() => parseConflictBriefArgs(['conflict-brief', 'PROJ-1', 'api', 'extra'])).toThrow(
      /unexpected/,
    );
  });
});

describe('runConflictBriefCommand', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  it('returns a brief when the repo is conflicted', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api');
    conflict(store, t.id, 'api', ['src/a.ts']);

    const out = runConflictBriefCommand(store, { key: 'PROJ-1', repo: 'api' });
    expect(out).toContain('PROJ-1');
    expect(out).toContain('/wt/api');
    expect(out).toContain('src/a.ts');
  });

  it('returns "nothing to resolve" when the repo is not conflicted', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    seedWorktree(store, t.id, 'api', '/wt/api');

    const out = runConflictBriefCommand(store, { key: 'PROJ-1', repo: 'api' });
    expect(out).toBe(
      'No merge conflict is recorded for "api" on this ticket — nothing to resolve.',
    );
  });

  // T758 asked for `extention` when the recorded repo was a path, and the
  // read-only answer looked like "no conflict". Naming the recorded repo lets
  // the agent correct its own argument instead of re-probing git.
  it('names the recorded conflicted repo when the passed repo does not match', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    conflict(store, t.id, '/Users/nd/Work/projects/karst/', ['src/a.ts']);

    const out = runConflictBriefCommand(store, { key: 'PROJ-1', repo: 'extention' });

    expect(out).toContain('No merge conflict is recorded for "extention"');
    expect(out).toContain('Recorded conflicts: /Users/nd/Work/projects/karst/');
    expect(out).toContain('Pass the repo exactly as recorded.');
  });

  it('lists every recorded conflicted repo, not just one', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    conflict(store, t.id, '/repos/api', []);
    conflict(store, t.id, '/repos/web', []);

    const out = runConflictBriefCommand(store, { key: 'PROJ-1', repo: 'extention' });

    expect(out).toContain('/repos/api');
    expect(out).toContain('/repos/web');
  });

  // A repo with a clean verdict is not a hint — it would send the agent at a
  // record that says there is nothing to merge.
  it('does not list repos whose recorded verdict is not conflicted', () => {
    const t = createTicket(store, { key: 'PROJ-1', title: 'thing' });
    setMergeCheck(store, {
      ticketId: t.id,
      repo: '/repos/api',
      state: 'clean',
      files: [],
      reason: null,
      headSha: 'h',
      baseSha: 'b',
      baseRef: 'main',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });

    const out = runConflictBriefCommand(store, { key: 'PROJ-1', repo: 'extention' });

    expect(out).toBe(
      'No merge conflict is recorded for "extention" on this ticket — nothing to resolve.',
    );
  });

  it('throws on an unknown key', () => {
    expect(() => runConflictBriefCommand(store, { key: 'NOPE-1', repo: 'api' })).toThrow(
      /no ticket found for key or id 'NOPE-1'/,
    );
  });
});
