import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { openRecoveryRound } from './recoveryRounds.js';
import { upsertProject } from './projects.js';
import { setStage } from './stages.js';
import { setStageCurrent } from './tickets.js';
import { hostParkCandidates } from './hostRerunRound.js';

const AT = '2026-01-01T00:00:00Z';
const PARK = 'the agent found no change to make, and the re-run of the failed gates did not close the round — x';

describe('hostParkCandidates', () => {
  let store: Store;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    otherProjectId = upsertProject(store, { slug: 'q' }).id;
  });

  const ticket = (key: string, owner = projectId): number => createTicketFlow(store, { key, title: 't', projectId: owner }).id;

  const round = (ticketId: number, sourceStage: 'uat' | 'review' | 'ship' = 'uat', status = 'interrupted'): number => {
    const id = openRecoveryRound(store, {
      ticketId,
      sourceStage,
      sourceProcessId: sourceStage === 'uat' ? 'gates' : 'review',
      triggerKind: 'gate-failure',
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = ?, end_reason = ? WHERE id = ?").run(status, PARK, id);
    return id;
  };

  /** The parked-fix shape of one ticket, with its latest round as the caller leaves it. */
  const parkedTicket = (key: string, owner = projectId): { ticketId: number; roundId: number } => {
    const ticketId = ticket(key, owner);
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked', startedAt: AT });
    return { ticketId, roundId: round(ticketId) };
  };

  it('names the round and ticket of a parked fix round with its end reason', () => {
    const { ticketId, roundId } = parkedTicket('T-1');
    expect(hostParkCandidates(store, projectId)).toEqual([{ roundId, ticketId, endReason: PARK }]);
  });

  it('lists only the tickets of the project', () => {
    parkedTicket('T-1');
    parkedTicket('T-2', otherProjectId);
    expect(hostParkCandidates(store, projectId)).toHaveLength(1);
    expect(hostParkCandidates(store, otherProjectId)).toHaveLength(1);
  });

  it('excludes an archived ticket', () => {
    const { ticketId } = parkedTicket('T-1');
    store.db.prepare("UPDATE tickets SET archived_at = datetime('now') WHERE id = ?").run(ticketId);
    expect(hostParkCandidates(store, projectId)).toEqual([]);
  });

  it('excludes a ticket that is not at fix', () => {
    const { ticketId } = parkedTicket('T-1');
    setStageCurrent(store, ticketId, 'uat');
    expect(hostParkCandidates(store, projectId)).toEqual([]);
  });

  it('excludes a fix row that is not failed or is blocked', () => {
    const first = parkedTicket('T-1').ticketId;
    setStage(store, first, 'fix', { status: 'running' });
    const second = parkedTicket('T-2').ticketId;
    setStage(store, second, 'fix', { blockedKind: 'usage-limit' });
    expect(hostParkCandidates(store, projectId)).toEqual([]);
  });

  it('excludes a latest round that is not interrupted', () => {
    const { ticketId, roundId } = parkedTicket('T-1');
    store.db.prepare("UPDATE recovery_rounds SET status = 'failed' WHERE id = ?").run(roundId);
    expect(hostParkCandidates(store, projectId)).toEqual([]);
  });

  it('excludes a latest round whose source stage is not uat or review', () => {
    const ticketId = ticket('T-1');
    setStageCurrent(store, ticketId, 'fix');
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked', startedAt: AT });
    round(ticketId, 'ship');
    expect(hostParkCandidates(store, projectId)).toEqual([]);
  });

  it('reads the LATEST round only, not an earlier interrupted one', () => {
    const { ticketId } = parkedTicket('T-1');
    round(ticketId, 'uat', 'passed');
    expect(hostParkCandidates(store, projectId)).toEqual([]);
  });
});
