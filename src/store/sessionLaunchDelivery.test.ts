import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import { upsertProject } from './projects.js';
import { pauseTicket, archiveTicket } from './tickets.js';
import {
  failSessionLaunchIntent,
  markTicketLaunchIntentsRedelivered,
  recordSessionLaunchIntent,
  supersedePendingLaunchIntents,
} from './sessionLaunchIntents.js';
import { openRecoveryRound, recordFixLaunchIntent } from './recoveryRounds.js';
import { selectDeliveryCandidates } from './sessionLaunchDelivery.js';

const T0 = '2026-08-01T10:00:00.000Z';
const LATER = '2026-08-01T10:05:00.000Z';
const MIN_AGE_MS = 90_000;

describe('selectDeliveryCandidates', () => {
  let store: Store;
  let projectId: number;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'delivery-proj' }).id;
    ticketId = createTicketFlow(store, { key: 'D-1', title: 'd', projectId }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' }); // -> impl
  });
  afterEach(() => store.close());

  function intent(launchId: string, at = T0, ticket = ticketId): void {
    recordSessionLaunchIntent(store, {
      ticketId: ticket,
      launchId,
      purpose: 'implementation',
      provider: 'claude',
      reason: 'initial',
      sessionOrigin: 'new',
      at,
    });
  }

  const opts = () => ({ at: LATER, minAgeMs: MIN_AGE_MS, projectId });

  it('selects a pending launch older than the window, covering implementation purpose', () => {
    intent('L-1');
    const rows = selectDeliveryCandidates(store, opts());
    expect(rows).toEqual([
      {
        intentId: expect.any(Number),
        launchId: 'L-1',
        ticketId,
        purpose: 'implementation',
        provider: 'claude',
        createdAt: T0,
        redeliveredAt: null,
      },
    ]);
  });

  it('selects a fix-purpose launch too', () => {
    transition(store, ticketId, 'impl', { kind: 'passed' }); // -> uat
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const roundId = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    }).id;
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'F-1',
      provider: 'claude',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: roundId,
      at: T0,
    });
    const rows = selectDeliveryCandidates(store, opts());
    expect(rows.map((r) => r.purpose)).toEqual(['fix']);
  });

  it('excludes a launch younger than the window', () => {
    intent('L-1', '2026-08-01T10:04:30.000Z');
    expect(selectDeliveryCandidates(store, opts())).toEqual([]);
  });

  it('excludes settled (failed/superseded) launches', () => {
    intent('L-1');
    failSessionLaunchIntent(store, 'L-1', T0);
    intent('L-2');
    supersedePendingLaunchIntents(store, ticketId, 'implementation', 'other', T0);
    expect(selectDeliveryCandidates(store, opts())).toEqual([]);
  });

  it('excludes a paused ticket', () => {
    intent('L-1');
    pauseTicket(store, ticketId);
    expect(selectDeliveryCandidates(store, opts())).toEqual([]);
  });

  it('excludes an archived ticket', () => {
    intent('L-1');
    archiveTicket(store, ticketId);
    expect(selectDeliveryCandidates(store, opts())).toEqual([]);
  });

  it('excludes another project’s launch', () => {
    const otherProject = upsertProject(store, { slug: 'other' }).id;
    const otherTicket = createTicketFlow(store, {
      key: 'O-1',
      title: 'o',
      projectId: otherProject,
    }).id;
    transition(store, otherTicket, 'scope', { kind: 'passed' }); // -> impl
    intent('L-1', T0, otherTicket);
    expect(selectDeliveryCandidates(store, opts())).toEqual([]);
  });

  it('excludes a launch whose ticket advanced past the interactive stages', () => {
    intent('L-1');
    transition(store, ticketId, 'impl', { kind: 'passed' }); // -> uat
    expect(selectDeliveryCandidates(store, opts())).toEqual([]);
    transition(store, ticketId, 'uat', { kind: 'passed' }); // -> review
    transition(store, ticketId, 'review', { kind: 'passed' }); // -> ship
    transition(store, ticketId, 'ship', { kind: 'passed' }); // -> done
    expect(selectDeliveryCandidates(store, opts())).toEqual([]);
  });

  it('returns a re-delivered row so the guard can age it into needs-you', () => {
    intent('L-1');
    markTicketLaunchIntentsRedelivered(store, ticketId, T0);
    const rows = selectDeliveryCandidates(store, opts());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.redeliveredAt).toBe(T0);
  });

  it('returns nothing without a project, an invalid clock, or a non-positive window', () => {
    intent('L-1');
    expect(selectDeliveryCandidates(store, { ...opts(), projectId: null })).toEqual([]);
    expect(selectDeliveryCandidates(store, { ...opts(), at: 'not-a-date' })).toEqual([]);
    expect(selectDeliveryCandidates(store, { ...opts(), minAgeMs: 0 })).toEqual([]);
  });
});
