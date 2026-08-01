import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { setStage } from '../store/stages.js';
import { stageBadge } from '../model/stageBadge.js';
import { facetOf } from '../ui/sidebar/facets.js';
import { transition } from './machine.js';
import { mergeGateState, settleMergeStage, settleMergeGates } from './mergeGate.js';

function seedPr(
  store: Store,
  ticketId: number,
  repo: string,
  status: string,
  number = 12,
): void {
  store.db
    .prepare('INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, number, `https://github.com/o/r/pull/${number}`, status);
}

function conflict(store: Store, ticketId: number, repo: string): void {
  setMergeCheck(store, {
    ticketId,
    repo,
    state: 'conflicted',
    files: ['src/a.ts'],
    reason: null,
    headSha: 'h',
    baseSha: 'b',
    baseRef: 'main',
    checkedAt: '2026-08-01T10:00:00Z',
  });
}

/** Walk a fresh ticket to `merge`, the way ship leaves it. */
function walkToMerge(store: Store, ticketId: number): void {
  for (const from of ['scope', 'impl', 'uat', 'review', 'ship'] as const) {
    transition(store, ticketId, from, { kind: 'passed' });
  }
}

describe('mergeGateState', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  it('reads a ticket that opened no PR as nothing to merge', () => {
    expect(mergeGateState(store, id)).toEqual({ kind: 'nothing-to-merge' });
  });

  it('reads every PR merged as merged', () => {
    seedPr(store, id, 'api', 'merged');
    seedPr(store, id, 'web', 'merged', 13);
    expect(mergeGateState(store, id)).toEqual({ kind: 'merged', repos: ['api', 'web'] });
  });

  it('names only the repos that have not landed while others have', () => {
    seedPr(store, id, 'api', 'merged');
    seedPr(store, id, 'web', 'open', 13);
    expect(mergeGateState(store, id)).toEqual({ kind: 'awaiting', repos: ['web'] });
  });

  // A closed PR is not merged and never will be on its own. Treating it as
  // landed would mark the ticket done for work that was thrown away.
  it('does not read a closed PR as landed', () => {
    seedPr(store, id, 'api', 'closed');
    expect(mergeGateState(store, id)).toEqual({ kind: 'awaiting', repos: ['api'] });
  });

  it('separates a conflicted repo from the ones merely waiting', () => {
    seedPr(store, id, 'api', 'open');
    seedPr(store, id, 'web', 'open', 13);
    conflict(store, id, 'api');
    expect(mergeGateState(store, id)).toEqual({
      kind: 'conflicted',
      repos: ['api'],
      pending: ['web'],
    });
  });

  // A repo re-shipped after a merge holds BOTH rows. Reading them both would let
  // the stale merged one answer for a branch that is still open.
  it('asks only the current PR when a repo has been re-shipped', () => {
    seedPr(store, id, 'api', 'merged', 12);
    seedPr(store, id, 'api', 'open', 14);
    expect(mergeGateState(store, id)).toEqual({ kind: 'awaiting', repos: ['api'] });
  });

  // `listMergeChecksByTicket` already filters on the PR not being merged, so a
  // verdict frozen at merge time cannot hold a landed ticket open. Pinned here
  // because the gate is the consumer that would turn it into a stuck ticket.
  it('ignores a conflict verdict left behind by a PR that has since merged', () => {
    seedPr(store, id, 'api', 'merged');
    conflict(store, id, 'api');
    expect(mergeGateState(store, id)).toEqual({ kind: 'merged', repos: ['api'] });
  });
});

describe('settleMergeStage', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  it('holds the ticket at merge while any PR is still open', () => {
    walkToMerge(store, id);
    seedPr(store, id, 'api', 'open');

    expect(settleMergeStage(store, id).advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('merge');
  });

  it('advances to done once every PR reads merged', () => {
    walkToMerge(store, id);
    seedPr(store, id, 'api', 'merged');

    const res = settleMergeStage(store, id);
    expect(res.advanced).toBe(true);
    expect(res.state.kind).toBe('merged');
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  // The caveat on the ticket: "of course, if there is anything to deliver". A
  // ticket whose work produced no diff has delivered everything it had.
  it('advances a ticket that delivered nothing, which has no PR to wait for', () => {
    walkToMerge(store, id);
    expect(settleMergeStage(store, id).advanced).toBe(true);
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  it('is idempotent — a second call on a done ticket does nothing', () => {
    walkToMerge(store, id);
    seedPr(store, id, 'api', 'merged');
    expect(settleMergeStage(store, id).advanced).toBe(true);
    expect(settleMergeStage(store, id).advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  // The gate may be called from anywhere; it must never pull a ticket forward
  // from a stage it has not reached.
  it('leaves a ticket that is not at merge exactly where it is', () => {
    seedPr(store, id, 'api', 'merged');
    expect(settleMergeStage(store, id).advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('scope');
  });
});

describe('what the user sees while a ticket waits to be merged', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  // The acceptance line: an unmerged ticket must not read Done anywhere, and a
  // conflicted one must read Needs you.
  it('reads needs-you, not done, while a PR is open', () => {
    walkToMerge(store, id);
    seedPr(store, id, 'api', 'open');
    settleMergeStage(store, id);

    const t = getTicket(store, id);
    expect(t.stageCurrent).toBe('merge');
    expect(stageBadge(t).label).toBe('Needs you');
    expect(facetOf(t)).toBe('input');
  });

  it('reads needs-you when the branch stops merging cleanly', () => {
    walkToMerge(store, id);
    seedPr(store, id, 'api', 'open');
    conflict(store, id, 'api');

    const t = getTicket(store, id);
    expect(mergeGateState(store, id).kind).toBe('conflicted');
    expect(stageBadge(t).label).toBe('Needs you');
    expect(facetOf(t)).toBe('input');
  });

  it('reads done only once the PR has landed', () => {
    walkToMerge(store, id);
    seedPr(store, id, 'api', 'open');
    store.db.prepare("UPDATE prs SET status = 'merged' WHERE ticket_id = ?").run(id);
    settleMergeStage(store, id);

    const t = getTicket(store, id);
    expect(stageBadge(t).label).toBe('Done');
    expect(facetOf(t)).toBe('done');
  });
});

describe('settleMergeGates', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('advances every parked ticket whose PRs have landed, and no others', () => {
    const landed = createTicket(store, { key: 'A', title: 'a' }).id;
    const waiting = createTicket(store, { key: 'B', title: 'b' }).id;
    const early = createTicket(store, { key: 'C', title: 'c' }).id;
    walkToMerge(store, landed);
    walkToMerge(store, waiting);
    seedPr(store, landed, 'api', 'merged');
    seedPr(store, waiting, 'api', 'open');
    seedPr(store, early, 'api', 'merged');

    expect(settleMergeGates(store)).toEqual([landed]);
    expect(getTicket(store, waiting).stageCurrent).toBe('merge');
    expect(getTicket(store, early).stageCurrent).toBe('scope');
  });

  // One broken ticket must not stop the sweep reaching the rest — the same rule
  // `syncPrStatuses` and `syncMergeChecks` follow.
  it('keeps going when one ticket cannot be settled', () => {
    const broken = createTicket(store, { key: 'A', title: 'a' }).id;
    const good = createTicket(store, { key: 'B', title: 'b' }).id;
    walkToMerge(store, broken);
    walkToMerge(store, good);
    seedPr(store, good, 'api', 'merged');
    // The machine refuses to transition a stage with no row — the shape a
    // pre-v20 registry would have had before its merge rows were seeded.
    store.db.prepare("DELETE FROM stages WHERE ticket_id = ? AND stage_key = 'merge'").run(broken);
    setStage(store, broken, 'ship', { status: 'passed' });
    store.db.prepare("UPDATE tickets SET stage_current = 'merge' WHERE id = ?").run(broken);

    expect(settleMergeGates(store)).toEqual([good]);
  });
});
