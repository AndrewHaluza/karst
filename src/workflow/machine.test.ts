import { describe, it, expect, beforeEach } from 'vitest';
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
    expect(transition(store, ticketId, 'uat', { kind: 'passed' })).toBe('review');
  });

  it('fail at uat routes to fix and increments the failing stage attempt', () => {
    const before = stageOf(store, ticketId, 'uat').attempt;
    const next = transition(store, ticketId, 'uat', { kind: 'failed', reason: 'x' });
    expect(next).toBe('fix');
    expect(stageOf(store, ticketId, 'uat').status).toBe('failed');
    expect(stageOf(store, ticketId, 'uat').attempt).toBe(before + 1);
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
  });

  it('fail persists the reason as the stage verdict', () => {
    transition(store, ticketId, 'review', { kind: 'failed', reason: 'lint broke' });
    expect(stageOf(store, ticketId, 'review').verdict).toBe('lint broke');
  });

  it('fix pass re-enters uat (revalidate loop)', () => {
    expect(transition(store, ticketId, 'fix', { kind: 'passed' })).toBe('uat');
  });

  it('fail at review routes to fix', () => {
    expect(transition(store, ticketId, 'review', { kind: 'failed' })).toBe('fix');
  });

  it('pass at review advances to ship, ship to done', () => {
    expect(transition(store, ticketId, 'review', { kind: 'passed' })).toBe('ship');
    expect(transition(store, ticketId, 'ship', { kind: 'passed' })).toBe('done');
  });

  // A terminal stage has no edges and nothing to run: no verdict will ever
  // arrive to close it. Left 'running', a shipped ticket would sit on a blue,
  // forever-running `done` node and file itself under "In progress" (facets.ts).
  it('entering the terminal stage completes it — arriving IS finishing', () => {
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
    transition(store, ticketId, 'review', { kind: 'passed' });

    const ship = stageOf(store, ticketId, 'ship');
    expect(ship.status).toBe('pending');
    expect(ship.startedAt).not.toBeNull();
    expect(ship.endedAt).toBeNull();
    expect(getTicket(store, ticketId).stageCurrent).toBe('ship');
  });

  // Re-entering ship after a failed attempt (fix → review → ship) must not leave
  // the previous attempt's endedAt behind: deriveStageCurrent ranks stages by
  // `endedAt ?? startedAt`, so a stale timestamp makes the parked ship look older
  // than the review it just came from.
  it('re-entering a confirm stage clears the previous attempt end time', () => {
    transition(store, ticketId, 'review', { kind: 'passed' });
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
    transition(store, ticketId, 'uat', { kind: 'failed' }); // attempt 1
    transition(store, ticketId, 'fix', { kind: 'passed' }); // back to uat
    transition(store, ticketId, 'review', { kind: 'failed' }); // review attempt 1
    transition(store, ticketId, 'fix', { kind: 'passed' });
    transition(store, ticketId, 'uat', { kind: 'failed' }); // uat attempt 2
    expect(stageOf(store, ticketId, 'uat').attempt).toBe(2);
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
