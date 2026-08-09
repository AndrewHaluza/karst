import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { setMergeCheck } from '../store/mergeChecks.js';
import { stageBlock } from '../store/stageBlocks.js';
import { stageBadge } from '../model/stageBadge.js';
import { facetOf } from '../ui/sidebar/facets.js';
import { transition } from './machine.js';
import { setStage } from '../store/stages.js';
import { mergeGateState, resolveShipLanding, settleShipGate, settleShipGates } from './mergeGate.js';

// Wrapped rather than stubbed (`vi.fn(actual.x)`), so every OTHER test in this
// file — which drives tickets through real transitions and real stage writes —
// keeps working unmocked. Only the two tests below reach for
// `mockImplementationOnce` to make a single specific call throw.
vi.mock('./machine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./machine.js')>();
  return { ...actual, transition: vi.fn(actual.transition) };
});
vi.mock('../store/stages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/stages.js')>();
  return { ...actual, setStage: vi.fn(actual.setStage) };
});

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

/** Walk a fresh ticket to `ship`, pending its confirm click — the way review leaves it. */
function walkToShip(store: Store, ticketId: number): void {
  for (const from of ['scope', 'impl', 'uat', 'review'] as const) {
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

  // The lookup-failure case: a degraded probe (a failed `gh pr view`, or a PR
  // row `prSync` could not resolve) leaves a status that is not literally
  // `'merged'`. It must never be read as landed — an unanswered question is not
  // a yes.
  it('does not read an unresolved PR lookup as merged', () => {
    seedPr(store, id, 'api', 'unknown');
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

describe('resolveShipLanding', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  it('blocks the ticket at ship while any PR is still open', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');

    const res = resolveShipLanding(store, id);
    expect(res.advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
    expect(stageBlock(store, id, 'ship')?.kind).toBe('awaiting-merge');
  });

  // The block reason is what "surface a clear reason naming the unmerged PR"
  // means in practice — the dashboard's fault card and rail read it verbatim.
  it('names the unmerged repo in the block reason', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    resolveShipLanding(store, id);
    expect(stageBlock(store, id, 'ship')?.reason).toContain('api');
  });

  // A passed ship row with a null endedAt reads as still running to anything
  // deriving a duration from `endedAt ?? startedAt` — the not-landed path
  // marks ship `passed` (its own work IS done; only the landing is pending)
  // so it must stamp `endedAt` alongside, same as any other completed stage.
  it('stamps endedAt on the not-landed ship row, not just blockedAt', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    resolveShipLanding(store, id);
    const shipStage = getTicket(store, id).stages.find((s) => s.stageKey === 'ship');
    expect(shipStage?.status).toBe('passed');
    expect(shipStage?.endedAt).not.toBeNull();
  });

  it('does not treat an unresolved PR lookup as merged', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'unknown');
    const res = resolveShipLanding(store, id);
    expect(res.advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('advances to done once every PR reads merged', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'merged');

    const res = resolveShipLanding(store, id);
    expect(res.advanced).toBe(true);
    expect(res.state.kind).toBe('merged');
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  // A PR with no changes from the base is never opened (ship's `hasChangesFrom`
  // path), so a repo with no PR at all is a pass, not a hold.
  it('advances a ticket that delivered nothing, which has no PR to wait for', () => {
    walkToShip(store, id);
    expect(resolveShipLanding(store, id).advanced).toBe(true);
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  // Bookkeeping over state that already exists (the PRs are open — the
  // irreversible part already succeeded). A failure here must never propagate
  // and be mistaken for ship itself failing, so it is swallowed.
  it('does not fail ship when the not-landed block-write throws', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    vi.mocked(setStage).mockImplementationOnce(() => {
      throw new Error('db locked');
    });

    expect(() => resolveShipLanding(store, id)).not.toThrow();
    // The swallow leaves the ticket at `ship` — not landed, not blocked — a
    // transient miss the next `shipTicket` re-run repairs by calling
    // resolveShipLanding again and re-establishing the block from scratch.
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  // Ship's own verdict must never be silently lost — a failure to record it
  // is real news, so unlike the not-landed path this stays unguarded and
  // propagates out of resolveShipLanding.
  it('propagates a throw from the landed path — recording ship\'s own pass is never swallowed', () => {
    walkToShip(store, id);
    // Nothing to merge — the landed branch.
    vi.mocked(transition).mockImplementationOnce(() => {
      throw new Error('write failed');
    });

    expect(() => resolveShipLanding(store, id)).toThrow('write failed');
  });
});

describe('settleShipGate', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  // The landmine this guards against: a ticket freshly parked at `ship`,
  // pending its FIRST confirm click, has no PR yet either — and would misread
  // as `nothing-to-merge` if this swept it the same way a blocked ticket is
  // swept. Only a ticket actually blocked on the gate may be settled here.
  it('leaves a ticket merely pending its first ship confirm untouched', () => {
    walkToShip(store, id);
    expect(settleShipGate(store, id).advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('holds the ticket while any PR is still open', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    resolveShipLanding(store, id); // ship's own tail — sets the block

    expect(settleShipGate(store, id).advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('ship');
  });

  it('advances a blocked ticket to done once the PR lands', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    resolveShipLanding(store, id);

    store.db.prepare("UPDATE prs SET status = 'merged' WHERE ticket_id = ?").run(id);
    const res = settleShipGate(store, id);
    expect(res.advanced).toBe(true);
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  it('is idempotent — a second call on a done ticket does nothing', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'merged');
    resolveShipLanding(store, id);
    expect(settleShipGate(store, id).advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('done');
  });

  // The gate may be called from anywhere; it must never pull a ticket forward
  // from a stage it has not reached.
  it('leaves a ticket that is not at ship exactly where it is', () => {
    seedPr(store, id, 'api', 'merged');
    expect(settleShipGate(store, id).advanced).toBe(false);
    expect(getTicket(store, id).stageCurrent).toBe('scope');
  });
});

describe('what the user sees while ship waits to be merged', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  // The acceptance line: an unmerged ticket must not read Done anywhere, and a
  // conflicted one must read Needs you.
  it('reads needs-you, not done, while a PR is open', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    resolveShipLanding(store, id);

    const t = getTicket(store, id);
    expect(t.stageCurrent).toBe('ship');
    expect(stageBadge(t).label).toBe('Needs you');
    expect(facetOf(t)).toBe('input');
  });

  it('reads needs-you when the branch stops merging cleanly', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    conflict(store, id, 'api');
    resolveShipLanding(store, id);

    const t = getTicket(store, id);
    expect(mergeGateState(store, id).kind).toBe('conflicted');
    expect(stageBadge(t).label).toBe('Needs you');
    expect(facetOf(t)).toBe('input');
  });

  it('reads done only once the PR has landed', () => {
    walkToShip(store, id);
    seedPr(store, id, 'api', 'open');
    resolveShipLanding(store, id);
    store.db.prepare("UPDATE prs SET status = 'merged' WHERE ticket_id = ?").run(id);
    settleShipGate(store, id);

    const t = getTicket(store, id);
    expect(stageBadge(t).label).toBe('Done');
    expect(facetOf(t)).toBe('done');
  });
});

describe('settleShipGates', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('advances every blocked ticket whose PRs have landed, and no others', () => {
    const landed = createTicket(store, { key: 'A', title: 'a' }).id;
    const waiting = createTicket(store, { key: 'B', title: 'b' }).id;
    const early = createTicket(store, { key: 'C', title: 'c' }).id;
    walkToShip(store, landed);
    walkToShip(store, waiting);
    seedPr(store, landed, 'api', 'open');
    seedPr(store, waiting, 'api', 'open');
    resolveShipLanding(store, landed);
    resolveShipLanding(store, waiting);
    seedPr(store, early, 'api', 'merged');
    store.db.prepare("UPDATE prs SET status = 'merged' WHERE ticket_id = ?").run(landed);

    expect(settleShipGates(store)).toEqual([landed]);
    expect(getTicket(store, waiting).stageCurrent).toBe('ship');
    expect(getTicket(store, early).stageCurrent).toBe('scope');
  });

  // A ticket merely pending its first confirm click (no PR, no block yet) must
  // never be swept forward — the same guard `settleShipGate` enforces alone.
  it('never sweeps a ticket that has not shipped yet', () => {
    const fresh = createTicket(store, { key: 'A', title: 'a' }).id;
    walkToShip(store, fresh);

    expect(settleShipGates(store)).toEqual([]);
    expect(getTicket(store, fresh).stageCurrent).toBe('ship');
  });

  // One broken ticket must not stop the sweep reaching the rest — the same rule
  // `syncPrStatuses` and `syncMergeChecks` follow.
  it('keeps going when one ticket cannot be settled', () => {
    const broken = createTicket(store, { key: 'A', title: 'a' }).id;
    const good = createTicket(store, { key: 'B', title: 'b' }).id;
    walkToShip(store, broken);
    walkToShip(store, good);
    // Both PRs start open, so resolveShipLanding parks each at `ship` blocked
    // on the merge gate rather than advancing them straight through — the
    // sweep below is what has to notice the later merge.
    seedPr(store, good, 'api', 'open');
    resolveShipLanding(store, good);
    seedPr(store, broken, 'api', 'open');
    resolveShipLanding(store, broken);
    store.db.prepare("UPDATE prs SET status = 'merged' WHERE ticket_id IN (?, ?)").run(good, broken);
    // Corrupt the registry: the ticket row itself vanishes between the sweep's
    // listing and its per-ticket settle — the shape a concurrent delete would
    // leave. `getTicket` throws on the unknown id, and that throw must not sink
    // the rest of the sweep.
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(broken);

    expect(settleShipGates(store)).toEqual([good]);
  });
});
