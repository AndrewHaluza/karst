import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import {
  setMergeCheck,
  getMergeCheck,
  listMergeChecksByTicket,
  type MergeCheckInput,
} from './mergeChecks.js';

function seedPr(
  store: Store,
  over: { ticketId?: number; repo?: string; number?: number; status?: string } = {},
): void {
  const number = over.number ?? 1;
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(
      over.ticketId ?? 1,
      over.repo ?? 'web',
      number,
      `https://github.com/o/r/pull/${number}`,
      over.status ?? 'open',
    );
}

function input(over: Partial<MergeCheckInput> = {}): MergeCheckInput {
  return {
    ticketId: 1,
    repo: 'web',
    state: 'clean',
    files: [],
    reason: null,
    headSha: 'aaa1111',
    baseSha: 'bbb2222',
    baseRef: 'main',
    checkedAt: '2026-07-21T10:00:00.000Z',
    ...over,
  };
}

describe('mergeChecks', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('records a clean check and reads it back', () => {
    setMergeCheck(store, input());

    expect(listMergeChecksByTicket(store, 1)).toEqual([
      {
        ticketId: 1,
        repo: 'web',
        state: 'clean',
        files: [],
        reason: null,
        headSha: 'aaa1111',
        baseSha: 'bbb2222',
        baseRef: 'main',
        checkedAt: '2026-07-21T10:00:00.000Z',
      },
    ]);
  });

  it('round-trips the conflicting file list', () => {
    setMergeCheck(
      store,
      input({ state: 'conflicted', files: ['src/store/db.ts', 'src/workflow/machine.ts'] }),
    );

    const [row] = listMergeChecksByTicket(store, 1);
    expect(row?.state).toBe('conflicted');
    expect(row?.files).toEqual(['src/store/db.ts', 'src/workflow/machine.ts']);
  });

  // The whole reason this table is not append-only: a stale `clean` presented as
  // current is the failure the feature exists to prevent, so a re-check must
  // replace the old answer rather than sit beside it.
  it('overwrites the previous answer for the same repo instead of appending', () => {
    setMergeCheck(store, input({ state: 'clean', checkedAt: '2026-07-21T10:00:00.000Z' }));
    setMergeCheck(
      store,
      input({
        state: 'conflicted',
        files: ['src/a.ts'],
        headSha: 'ccc3333',
        checkedAt: '2026-07-21T12:00:00.000Z',
      }),
    );

    const rows = listMergeChecksByTicket(store, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('conflicted');
    expect(rows[0]?.files).toEqual(['src/a.ts']);
    expect(rows[0]?.headSha).toBe('ccc3333');
    expect(rows[0]?.checkedAt).toBe('2026-07-21T12:00:00.000Z');
  });

  it('keeps one answer per repo, since each worktree has its own base', () => {
    setMergeCheck(store, input({ repo: 'web', state: 'clean' }));
    setMergeCheck(store, input({ repo: 'api', state: 'conflicted', files: ['api/x.ts'] }));

    const rows = listMergeChecksByTicket(store, 1);
    expect(rows.map((r) => [r.repo, r.state])).toEqual([
      ['api', 'conflicted'],
      ['web', 'clean'],
    ]);
  });

  it('keeps tickets apart', () => {
    setMergeCheck(store, input({ ticketId: 1 }));
    setMergeCheck(store, input({ ticketId: 2, state: 'conflicted' }));

    expect(listMergeChecksByTicket(store, 1).map((r) => r.state)).toEqual(['clean']);
    expect(listMergeChecksByTicket(store, 2).map((r) => r.state)).toEqual(['conflicted']);
  });

  it('stores the reason for an unknown check', () => {
    setMergeCheck(
      store,
      input({ state: 'unknown', reason: "fatal: couldn't find remote ref main" }),
    );

    expect(listMergeChecksByTicket(store, 1)[0]?.reason).toBe(
      "fatal: couldn't find remote ref main",
    );
  });

  it('returns nothing for a ticket that has never been checked', () => {
    expect(listMergeChecksByTicket(store, 99)).toEqual([]);
  });

  // Read paths run in the extension host on every dashboard refresh; one bad row
  // must degrade, not take the panel down.
  it('reads a malformed file list as empty rather than throwing', () => {
    setMergeCheck(store, input({ state: 'conflicted', files: ['src/a.ts'] }));
    store.db.prepare('UPDATE merge_checks SET files = ? WHERE ticket_id = ?').run('not json', 1);

    const [row] = listMergeChecksByTicket(store, 1);
    expect(row?.files).toEqual([]);
    expect(row?.state).toBe('conflicted');
  });

  // A row written by a newer karst, or corrupted, must never be able to claim a
  // branch is mergeable. Unrecognised degrades to 'unknown', never to 'clean'.
  it('reads an unrecognised state as unknown, never as clean', () => {
    setMergeCheck(store, input());
    store.db.prepare('UPDATE merge_checks SET state = ? WHERE ticket_id = ?').run('rebasing', 1);

    expect(listMergeChecksByTicket(store, 1)[0]?.state).toBe('unknown');
  });

  // Once the PR has landed, nothing can ever refresh the row again — the merge
  // sweep skips merged PRs on purpose — so the last pre-merge verdict would sit
  // on the panel forever, beside a PR row that reads "merged".
  describe('once the repo’s PR is merged', () => {
    it('reports no current merge state for that repo', () => {
      setMergeCheck(store, input({ state: 'conflicted', files: ['CLAUDE.md'] }));
      seedPr(store, { status: 'merged' });

      expect(listMergeChecksByTicket(store, 1)).toEqual([]);
      expect(getMergeCheck(store, 1, 'web')).toBeNull();
    });

    it('leaves every other repo on the ticket alone', () => {
      setMergeCheck(store, input({ repo: 'web', state: 'conflicted', files: ['a.ts'] }));
      setMergeCheck(store, input({ repo: 'api', state: 'conflicted', files: ['b.ts'] }));
      seedPr(store, { repo: 'web', status: 'merged' });

      expect(listMergeChecksByTicket(store, 1).map((r) => r.repo)).toEqual(['api']);
    });

    // Ship inserts a fresh PR row rather than reusing a terminal one, so a repo
    // re-shipped after a merge carries both. The open one is the current PR, and
    // its mergeability is a live question.
    it('still reports the state when a newer PR is open', () => {
      setMergeCheck(store, input({ state: 'conflicted', files: ['a.ts'] }));
      seedPr(store, { number: 1, status: 'merged' });
      seedPr(store, { number: 2, status: 'open' });

      expect(listMergeChecksByTicket(store, 1).map((r) => r.state)).toEqual(['conflicted']);
      expect(getMergeCheck(store, 1, 'web')?.state).toBe('conflicted');
    });
  });

  // A check is recorded per worktree, whether or not opening the PR succeeded.
  // No PR row is not a merged PR, and must not blank a real verdict.
  it('reports the state for a repo that has no PR recorded at all', () => {
    setMergeCheck(store, input({ state: 'conflicted', files: ['a.ts'] }));

    expect(listMergeChecksByTicket(store, 1).map((r) => r.state)).toEqual(['conflicted']);
  });

  it('reports the state while the PR is still open or closed', () => {
    setMergeCheck(store, input({ repo: 'web', state: 'conflicted', files: ['a.ts'] }));
    setMergeCheck(store, input({ repo: 'api', state: 'clean' }));
    seedPr(store, { repo: 'web', status: 'open' });
    seedPr(store, { repo: 'api', status: 'closed' });

    expect(listMergeChecksByTicket(store, 1).map((r) => r.repo)).toEqual(['api', 'web']);
  });
});
