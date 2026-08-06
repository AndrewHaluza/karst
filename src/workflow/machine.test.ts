import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket, setAgentState } from '../store/tickets.js';
import { transition } from './machine.js';
import { createTicketFlow } from './stages/create.js';
import { setStage, type Stage } from '../store/stages.js';
import type { StageKey } from '../model/types.js';
import { stageBadge } from '../model/stageBadge.js';
import { ticketGlyph } from '../model/ticketGlyph.js';
import { facetOf } from '../ui/sidebar/facets.js';

function stageOf(store: Store, ticketId: number, key: StageKey): Stage {
  const s = getTicket(store, ticketId).stages.find((x) => x.stageKey === key);
  if (!s) throw new Error(`no stage ${key}`);
  return s;
}

describe('transition (stage machine core)', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
  });

  it('pass at scope advances to impl and sets stage_current', () => {
    const next = transition(store, ticketId, 'scope', { kind: 'passed' });
    expect(next).toBe('impl');
    expect(getTicket(store, ticketId).stageCurrent).toBe('impl');
    expect(stageOf(store, ticketId, 'scope').status).toBe('passed');
    expect(stageOf(store, ticketId, 'impl').status).toBe('running');
  });

  it('pass at uat advances to review', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' }); // now at uat
    expect(transition(store, ticketId, 'uat', { kind: 'passed' })).toBe('review');
  });

  it('fail at uat routes to fix and increments the failing stage attempt', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' }); // now at uat
    const before = stageOf(store, ticketId, 'uat').attempt;
    const next = transition(store, ticketId, 'uat', { kind: 'failed', reason: 'x' });
    expect(next).toBe('fix');
    expect(stageOf(store, ticketId, 'uat').status).toBe('failed');
    expect(stageOf(store, ticketId, 'uat').attempt).toBe(before + 1);
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
  });

  it('fail persists the reason as the stage verdict', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    transition(store, ticketId, 'review', { kind: 'failed', reason: 'lint broke' });
    expect(stageOf(store, ticketId, 'review').verdict).toBe('lint broke');
  });

  it('fix pass re-enters uat (revalidate loop)', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'failed' }); // now at fix
    expect(transition(store, ticketId, 'fix', { kind: 'passed' })).toBe('uat');
  });

  // `stages` is keyed (ticket_id, stage_key), so a retry OVERWRITES the row —
  // the verdict column describes what the row says NOW, it is not a history
  // (gate_runs is). Left behind, the reason one attempt failed outlives the
  // attempt that fixed it: the diagnostic report then prints a review stage as
  // `status: passed` beside `verdict: "gates failed: lint"`, and every reader
  // has to guess which half is true.
  it('re-entering a stage clears the reason its previous attempt recorded', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    transition(store, ticketId, 'review', { kind: 'failed', reason: 'gates failed: lint' });
    // Every fix revalidates from uat (graph.ts), so uat is what re-enters first —
    // and it must not carry a reason either.
    transition(store, ticketId, 'fix', { kind: 'passed' });
    expect(stageOf(store, ticketId, 'uat').status).toBe('running');
    expect(stageOf(store, ticketId, 'uat').verdict).toBeNull();

    // review is re-entered one step later; its own stale reason clears there.
    transition(store, ticketId, 'uat', { kind: 'passed' });
    expect(stageOf(store, ticketId, 'review').status).toBe('running');
    expect(stageOf(store, ticketId, 'review').verdict).toBeNull();
  });

  it('passing a stage clears a reason left by its previous attempt', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    // setStage injects the stale reason directly on the row — it does not touch
    // stage_current, so the ticket is still legitimately AT review.
    setStage(store, ticketId, 'review', { status: 'failed', verdict: 'gates failed: lint' });
    transition(store, ticketId, 'review', { kind: 'passed' });
    expect(stageOf(store, ticketId, 'review').status).toBe('passed');
    expect(stageOf(store, ticketId, 'review').verdict).toBeNull();
  });

  it('fail at review routes to fix', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    expect(transition(store, ticketId, 'review', { kind: 'failed' })).toBe('fix');
  });

  it('pass at review advances to ship, ship to done', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    expect(transition(store, ticketId, 'review', { kind: 'passed' })).toBe('ship');
    // The machine itself has no notion of "landed" — that gate lives above it,
    // in `workflow/mergeGate.ts`, which decides WHETHER to call this transition
    // at all (see mergeGate.test.ts). Called directly, ship's pass verdict goes
    // straight to `done`.
    expect(transition(store, ticketId, 'ship', { kind: 'passed' })).toBe('done');
  });

  // A terminal stage has no edges and nothing to run: no verdict will ever
  // arrive to close it. Left 'running', a shipped ticket would sit on a blue,
  // forever-running `done` node and file itself under "In progress" (facets.ts).
  it('entering the terminal stage completes it — arriving IS finishing', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    transition(store, ticketId, 'review', { kind: 'passed' });
    transition(store, ticketId, 'ship', { kind: 'passed' });

    const done = stageOf(store, ticketId, 'done');
    expect(done.status).toBe('passed');
    expect(done.endedAt).not.toBeNull();
    expect(getTicket(store, ticketId).stageCurrent).toBe('done');
  });

  it('a non-terminal stage is still entered as running (not completed)', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    const impl = stageOf(store, ticketId, 'impl');
    expect(impl.status).toBe('running');
    expect(impl.endedAt).toBeNull();
  });

  // A confirm stage does not start itself: reaching `ship` parks the ticket until
  // the user clicks Confirm ship. Entered 'running' it claimed work nobody was
  // doing, which painted the ticket blue / "In progress" — so the needs-you state
  // (amber, "Needs you") was unreachable for the one stage that always needs you.
  it('entering a confirm stage parks it as pending — nothing runs until the user acts', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    transition(store, ticketId, 'review', { kind: 'passed' });

    const ship = stageOf(store, ticketId, 'ship');
    expect(ship.status).toBe('pending');
    expect(ship.startedAt).not.toBeNull();
    expect(ship.endedAt).toBeNull();
    expect(getTicket(store, ticketId).stageCurrent).toBe('ship');
  });

  // Entering ship must not leave a stale endedAt behind on the row:
  // deriveStageCurrent ranks stages by `endedAt ?? startedAt`, so a stale
  // timestamp makes the parked ship look older than the review it just came
  // from. `ship` currently has exactly one inbound edge (review→ship), so this
  // exercises entryPatch's clearing on that one legitimate entry rather than a
  // literal re-entry: setStage (not transition, so stage_current is untouched)
  // seeds the row with a leftover endedAt — the kind of artifact ship.ts's own
  // failure path (`setStage(..., 'ship', { status: 'failed', endedAt: ... })`)
  // can leave behind — and the transition into ship is the ordinary one.
  it('re-entering a confirm stage clears the previous attempt end time', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'passed' }); // now at review
    setStage(store, ticketId, 'ship', { status: 'failed', endedAt: '2020-01-01T00:00:00.000Z' });

    transition(store, ticketId, 'review', { kind: 'passed' });

    const ship = stageOf(store, ticketId, 'ship');
    expect(ship.status).toBe('pending');
    expect(ship.endedAt).toBeNull();
  });

  // End to end over a real store: the machine and the derivation are the two
  // halves this bug fell between, so walking a ticket to ship and reading what
  // the user would actually see is the assertion that matters.
  describe('what the user sees while a ticket waits on them', () => {
    function walkToShip(): void {
      transition(store, ticketId, 'scope', { kind: 'passed' });
      transition(store, ticketId, 'impl', { kind: 'passed' });
      transition(store, ticketId, 'uat', { kind: 'passed' });
      transition(store, ticketId, 'review', { kind: 'passed' });
    }

    it('a ticket parked at ship reports needs-you on every surface', () => {
      walkToShip();
      const t = getTicket(store, ticketId);

      expect(t.stageCurrent).toBe('ship');
      expect(stageBadge(t).label).toBe('Needs you');
      expect(ticketGlyph(t)).toBe('amber');
      expect(facetOf(t)).toBe('input');
    });

    it('no earlier stage on that walk ever claims to need the user', () => {
      // The other half of the acceptance line: the agent-driven stages must not
      // start reporting needs-you just because ship now can.
      for (const from of ['scope', 'impl', 'uat'] as const) {
        transition(store, ticketId, from, { kind: 'passed' });
        const t = getTicket(store, ticketId);
        expect(stageBadge(t).label, `${t.stageCurrent} must not need the user`).not.toBe('Needs you');
        expect(facetOf(t), `${t.stageCurrent} must not be in Needs you`).not.toBe('input');
      }
    });

    it('confirming the ship clears needs-you — it is working, then shipped', () => {
      walkToShip();

      // The click: shipTicket marks the stage running before it opens the PRs.
      setStage(store, ticketId, 'ship', { status: 'running' });
      expect(stageBadge(getTicket(store, ticketId)).label).toBe('Shipping');
      expect(facetOf(getTicket(store, ticketId))).toBe('running');

      // Shipping done does NOT mean shipped: a ticket still blocked on the
      // merge gate (`stages.blocked_kind === 'awaiting-merge'`, set by
      // `mergeGate.ts`'s `resolveShipLanding` — the layer above this raw
      // machine call) reads needs-you until the PRs actually land.
      setStage(store, ticketId, 'ship', {
        status: 'passed',
        blockedKind: 'awaiting-merge',
        blockedReason: 'blocked: the pull request for "api" has changes and is not merged yet.',
        blockedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(stageBadge(getTicket(store, ticketId)).label).toBe('Needs you');
      expect(facetOf(getTicket(store, ticketId))).toBe('input');

      // The merge lands: the block clears and the transition into `done` fires.
      setStage(store, ticketId, 'ship', { blockedKind: null, blockedReason: null, blockedAt: null });
      transition(store, ticketId, 'ship', { kind: 'passed' });
      expect(stageBadge(getTicket(store, ticketId)).label).toBe('Done');
      expect(facetOf(getTicket(store, ticketId))).toBe('done');
    });

    it('a waiting agent still reports needs-you, unchanged by any of this', () => {
      transition(store, ticketId, 'scope', { kind: 'passed' }); // impl, running
      setAgentState(store, ticketId, 'waiting');

      const t = getTicket(store, ticketId);
      expect(stageBadge(t).label).toBe('Needs you');
      expect(facetOf(t)).toBe('input');
    });
  });

  it('a null verdict does NOT transition (no-inference guarantee)', () => {
    expect(() => transition(store, ticketId, 'uat', null)).toThrow();
    // stage_current untouched, uat still pending
    expect(getTicket(store, ticketId).stageCurrent).toBe('scope');
    expect(stageOf(store, ticketId, 'uat').status).toBe('pending');
  });

  it('a stage with no edge for the verdict throws (e.g. fail at scope)', () => {
    expect(() => transition(store, ticketId, 'scope', { kind: 'failed' })).toThrow();
  });

  it('transitioning from done throws (terminal)', () => {
    expect(() => transition(store, ticketId, 'done', { kind: 'passed' })).toThrow();
  });

  it('a repeated fix loop climbs attempt each time', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' }); // now at uat
    transition(store, ticketId, 'uat', { kind: 'failed' }); // uat attempt 1, -> fix
    transition(store, ticketId, 'fix', { kind: 'passed' }); // back to uat
    // fix ALWAYS revalidates through uat (graph.ts) — it never returns straight
    // to review, so uat must pass again before review can fail.
    transition(store, ticketId, 'uat', { kind: 'passed' }); // -> review
    transition(store, ticketId, 'review', { kind: 'failed' }); // review attempt 1, -> fix
    transition(store, ticketId, 'fix', { kind: 'passed' }); // back to uat
    transition(store, ticketId, 'uat', { kind: 'failed' }); // uat attempt 2
    expect(stageOf(store, ticketId, 'uat').attempt).toBe(2);
  });

  // `transition` verified only that a stage ROW exists for `from` — never that
  // it was the ticket's CURRENT stage. That let a transition be authored from a
  // stage the ticket already left (two IDE windows sweeping the same ticket
  // could both advance it).
  it('refuses to transition a stage that is not the ticket current stage', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' }); // now at impl
    expect(() => transition(store, ticketId, 'scope', { kind: 'passed' })).toThrow(
      /scope' is not ticket .*'s current stage \(impl\)/,
    );
    // nothing mutated by the refused call
    expect(getTicket(store, ticketId).stageCurrent).toBe('impl');
    expect(stageOf(store, ticketId, 'scope').status).toBe('passed');
  });

  // better-sqlite3 is synchronous, so "concurrent" here means the second call
  // observing state the first already committed — not real parallelism.
  //
  // Status alone does not prove the refusal prevented anything: a second,
  // unguarded pass through entryPatch would leave `review` at status 'running'
  // and `uat` at status 'passed' too — status is exactly what a REDUNDANT
  // re-entry leaves unchanged. The tell is the TIMESTAMPS entryPatch stamps
  // with a fresh `now()` on every entry (`review.startedAt`) and setStage
  // stamps on every pass (`uat.endedAt`); the clock is advanced between the
  // two calls specifically so an unguarded second write would be provably
  // detectable here, rather than risk landing in the same millisecond as the
  // first and passing by accident.
  it('refuses a second concurrent transition from the same stage', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' }); // now at uat

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
      expect(transition(store, ticketId, 'uat', { kind: 'passed' })).toBe('review');
      const reviewStartedAt = stageOf(store, ticketId, 'review').startedAt;
      const uatEndedAt = stageOf(store, ticketId, 'uat').endedAt;
      expect(reviewStartedAt).toBe('2020-01-01T00:00:00.000Z');

      // Advance the clock: an unguarded second call would stamp fresh
      // timestamps here — the guard must refuse before either write happens.
      vi.setSystemTime(new Date('2020-01-01T00:00:01.000Z'));
      expect(() => transition(store, ticketId, 'uat', { kind: 'passed' })).toThrow();

      // the second (refused) call mutated nothing beyond the first's outcome
      expect(getTicket(store, ticketId).stageCurrent).toBe('review');
      expect(stageOf(store, ticketId, 'uat').status).toBe('passed');
      expect(stageOf(store, ticketId, 'uat').endedAt).toBe(uatEndedAt);
      expect(stageOf(store, ticketId, 'review').status).toBe('running');
      expect(stageOf(store, ticketId, 'review').startedAt).toBe(reviewStartedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  // Pins the guard's position relative to `premutate`: moving the guard below
  // `premutate()` would leave every other assertion in this file green while
  // committing a phantom evidence write (the `gate_runs` row Task 2 folds in
  // via `premutate`) on a refused transition. A spy is the only thing that
  // catches that — the guard's own thrown error looks identical either way.
  it('never runs premutate when the guard refuses the transition', () => {
    transition(store, ticketId, 'scope', { kind: 'passed' }); // now at impl
    const premutate = vi.fn();

    expect(() =>
      transition(store, ticketId, 'scope', { kind: 'passed' }, premutate),
    ).toThrow();

    expect(premutate).not.toHaveBeenCalled();
  });
});

it('a review failure re-validates through uat, not straight back to review', () => {
  const store = openStore(':memory:');
  const id = createTicketFlow(store, { key: 'T-9', title: 't' }).id;
  transition(store, id, 'scope', { kind: 'passed' });
  transition(store, id, 'impl', { kind: 'passed' });
  transition(store, id, 'uat', { kind: 'passed' });
  expect(transition(store, id, 'review', { kind: 'failed' })).toBe('fix');
  expect(transition(store, id, 'fix', { kind: 'passed' })).toBe('uat');
  store.close();
});
