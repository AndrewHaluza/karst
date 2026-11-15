import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket, getTicket } from '../store/tickets.js';
import { setStage, getStage } from '../store/stages.js';
import { recordShippedPr, updatePrStatus } from '../store/prs.js';
import { listRecoveryRounds, openRecoveryRound } from '../store/recoveryRounds.js';
import { enterShipFixRound, shipFixRoundState } from './shipFixRound.js';
import { FIX_ATTEMPT_CAP } from './fixAttempts.js';
import { fixBriefForTicket } from '../extension/ops/fixBriefForTicket.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const PR_URL = 'https://github.com/acme/repo/pull/1';
const REASON = 'Sent back by the host: CI failed on the pull request head.\nrepo #1: lint failed';

describe('ship fix round (T1158)', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  function shipTicket(): number {
    const ticket = createTicket(store, { key: 'A', title: 't' });
    store.db.prepare("UPDATE tickets SET stage_current = 'ship' WHERE id = ?").run(ticket.id);
    setStage(store, ticket.id, 'ship', {
      status: 'passed', startedAt: T0, endedAt: T0, blockedKind: 'awaiting-merge', blockedReason: 'PR open', blockedAt: T0,
    });
    return ticket.id;
  }

  function shipRound(ticketId: number, status: string): void {
    const round = openRecoveryRound(store, {
      ticketId, sourceStage: 'ship', sourceProcessId: 'pr-review', sourceStageRunId: null, sourceProcessRunId: null,
      triggerKind: 'upstream-changes-requested', triggerDetail: 'x', maxRounds: FIX_ATTEMPT_CAP, startedAt: T0,
    });
    store.db.prepare('UPDATE recovery_rounds SET status = ?, ended_at = ? WHERE id = ?').run(status, T0, round.id);
  }

  function rows(ticketId: number): unknown {
    return {
      stageCurrent: getTicket(store, ticketId).stageCurrent,
      stages: store.db.prepare('SELECT * FROM stages WHERE ticket_id = ? ORDER BY stage_key').all(ticketId),
      rounds: store.db.prepare('SELECT * FROM recovery_rounds WHERE ticket_id = ? ORDER BY id').all(ticketId),
    };
  }

  function expectRefusal(ticketId: number, reason: string): void {
    expect(shipFixRoundState(store, ticketId)).toEqual({ available: false, reason });
    const before = rows(ticketId);
    expect(() => enterShipFixRound(store, ticketId, { reason: REASON, artifactPath: null })).toThrow(`ship fix round refused: ticket ${ticketId} (${reason})`);
    expect(rows(ticketId)).toEqual(before);
  }

  it('refuses a ticket that is not at ship', () => {
    const ticket = createTicket(store, { key: 'A', title: 't' });
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(ticket.id);
    expectRefusal(ticket.id, 'stage');
  });

  it('refuses while the ship saga runs', () => {
    const id = shipTicket();
    setStage(store, id, 'ship', { status: 'running' });
    expectRefusal(id, 'in-flight');
  });

  it('refuses once a pull request has landed', () => {
    const id = shipTicket();
    recordShippedPr(store, { ticketId: id, repo: 'frontend', number: 1, url: PR_URL });
    updatePrStatus(store, { ticketId: id, repo: 'frontend', url: PR_URL, status: 'merged' });
    expectRefusal(id, 'landed');
  });

  it('refuses while a ship round is still active', () => {
    const id = shipTicket();
    shipRound(id, 'pending');
    expectRefusal(id, 'round-active');
  });

  it('refuses at the cap: the driver would exhaust the round at once', () => {
    const id = shipTicket();
    shipRound(id, 'failed');
    shipRound(id, 'failed');
    expectRefusal(id, 'exhausted');
  });

  it('offers the next round number while the budget holds', () => {
    const id = shipTicket();
    shipRound(id, 'failed');
    expect(shipFixRoundState(store, id)).toEqual({ available: true, round: 2 });
  });

  it('marks ship failed with the reason, opens a CI round at ship and enters fix', () => {
    const id = shipTicket();
    store.db.prepare("INSERT INTO autopilot_tickets (ticket_id, stopped_reason, stopped_head_sha, paused_reason) VALUES (?, 'x', 'sha', 'p')").run(id);
    const result = enterShipFixRound(store, id, { reason: REASON, artifactPath: '/a/ci.log', now: () => T1 });
    expect(result).toEqual({ roundId: expect.any(Number), round: 1 });
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    expect(getStage(store, id, 'fix')).toMatchObject({ status: 'running', attempt: 0, startedAt: T1, blockedKind: null });
    expect(getStage(store, id, 'ship')).toMatchObject({ status: 'failed', verdict: REASON, attempt: 1, endedAt: T1, artifactPath: '/a/ci.log' });
    const [round] = listRecoveryRounds(store, id);
    expect(round).toMatchObject({
      id: result.roundId, sourceStage: 'ship', sourceProcessId: 'ci', triggerKind: 'ci-failure', round: 1, maxRounds: FIX_ATTEMPT_CAP, status: 'pending', startedAt: T1,
    });
    expect(round?.triggerDetail).toBe('Sent back by the host: CI failed on the pull request head.');
    expect(store.db.prepare('SELECT stopped_reason, stopped_head_sha, paused_reason FROM autopilot_tickets WHERE ticket_id = ?').get(id))
      .toEqual({ stopped_reason: null, stopped_head_sha: null, paused_reason: null });
  });

  it('clears the ship block, so a base-moved-failed park does not hold the round', () => {
    const id = shipTicket();
    setStage(store, id, 'ship', { status: 'pending', verdict: null, endedAt: null, blockedKind: 'base-moved-failed', blockedReason: 'gate failed', blockedAt: T0 });
    enterShipFixRound(store, id, { reason: REASON, artifactPath: null, now: () => T1 });
    expect(getStage(store, id, 'ship')).toMatchObject({ status: 'failed', blockedKind: null, blockedReason: null, blockedAt: null });
  });

  it('bounds the trigger detail to one short line', () => {
    const id = shipTicket();
    enterShipFixRound(store, id, { reason: 'x'.repeat(500), artifactPath: null });
    expect(listRecoveryRounds(store, id)[0]?.triggerDetail).toBe(`${'x'.repeat(297)}...`);
  });

  it('the fix brief names the ship failure, the reason and the log', () => {
    const id = shipTicket();
    enterShipFixRound(store, id, { reason: REASON, artifactPath: '/a/ci.log' });
    const brief = fixBriefForTicket(store, id) ?? '';
    expect(brief).toContain('The ship gate failed for ticket');
    expect(brief).toContain(`It reported: ${REASON}`);
    expect(brief).toContain('Its full output is at /a/ci.log');
  });

  it('logs the decision with a [ship] prefix', () => {
    const id = shipTicket();
    const lines: string[] = [];
    enterShipFixRound(store, id, { reason: REASON, artifactPath: null, debug: (m) => lines.push(m) });
    expect(lines.some((l) => l.startsWith(`[ship] ship fix round ticket ${id}: round 1`))).toBe(true);
  });
});
