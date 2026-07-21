import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { setMergeCheck, listMergeChecksByTicket, type MergeCheckInput } from './mergeChecks.js';

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
});
