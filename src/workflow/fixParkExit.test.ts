import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openRecoveryRound } from '../store/recoveryRounds.js';
import { roundById } from '../store/recoveryRoundsRead.js';
import { parkRoundOutOfFixing } from '../store/hostRerunRound.js';
import { getStage, setStage } from '../store/stages.js';
import { setStageCurrent, setAgentState, getTicket } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { parkedFixRound } from '../store/fixNoChangeRounds.js';
import { recordFindings } from '../store/reviewFindings.js';
import { recordUatFindings } from '../store/uatFindings.js';
import { openProcessRun } from '../store/processRuns.js';
import { recordGateRun } from '../store/gateRuns.js';
import { listFixRoundAcceptances } from '../store/fixRoundAcceptances.js';
import {
  acceptParkedFixRound, retryParkedFixRound, fixParkView, parkedRoundItems,
  FIX_PARK_ACCEPT_END_REASON, FIX_PARK_RETRY_END_REASON,
} from './fixParkExit.js';

const AT = '2026-01-01T00:00:00Z';
const LATER = '2026-01-02T00:00:00Z';

describe('parked fix round exits', () => {
  let store: Store;
  let ticketId: number;

  const park = (sourceStage: 'uat' | 'review', triggerKind: string): number => {
    const id = openRecoveryRound(store, {
      ticketId, sourceStage, sourceProcessId: sourceStage === 'uat' ? 'gates' : 'review', triggerKind,
      triggerDetail: 'x', maxRounds: 3, startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(id);
    parkRoundOutOfFixing(store, id, 'parked', AT);
    setStage(store, ticketId, sourceStage, { status: 'failed', startedAt: AT });
    setStage(store, ticketId, 'fix', { status: 'failed', verdict: 'parked: no code change', endedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
    return id;
  };

  const addReviewFinding = (): void =>
    recordFindings(store, { ticketId, attempt: 1, runAt: AT, findings: [
      { severity: 'high', repo: '', file: 'f.ts', line: 1, title: 't', detail: 'd', source: 'agent' },
    ] });

  beforeEach(() => {
    store = openStore(':memory:');
    const projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
  });

  it('retry: source stage running, fix pending, the round stays interrupted with the retry reason', () => {
    const roundId = park('review', 'blocking-review-findings');
    expect(retryParkedFixRound(store, ticketId, { now: () => LATER })).toEqual({ ok: true, stage: 'review' });
    expect(getStage(store, ticketId, 'review')?.status).toBe('running');
    expect(getStage(store, ticketId, 'fix')?.status).toBe('pending');
    expect(getTicket(store, ticketId).stageCurrent).toBe('review');
    expect(roundById(store, roundId)?.status).toBe('interrupted');
    const row = store.db.prepare('SELECT end_reason FROM recovery_rounds WHERE id = ?').get(roundId) as { end_reason: string };
    expect(row.end_reason).toBe(FIX_PARK_RETRY_END_REASON('review'));
    expect(row.end_reason).toBe('no change: the user retried the review gate');
  });

  it('accept on a review round records the decision, closes the round and moves past review', () => {
    const roundId = park('review', 'blocking-review-findings');
    addReviewFinding();
    expect(acceptParkedFixRound(store, ticketId, 'known limit', { now: () => LATER })).toEqual({ ok: true, stage: 'review' });
    expect(listFixRoundAcceptances(store, ticketId)).toMatchObject([
      { roundId, sourceStage: 'review', triggerKind: 'blocking-review-findings', items: ['[high] t (f.ts:1)'], note: 'known limit' },
    ]);
    expect(roundById(store, roundId)?.status).toBe('passed');
    const row = store.db.prepare('SELECT end_reason FROM recovery_rounds WHERE id = ?').get(roundId) as { end_reason: string };
    expect(row.end_reason).toBe(FIX_PARK_ACCEPT_END_REASON);
    expect(getTicket(store, ticketId).stageCurrent).toBe('ship');
    expect(getStage(store, ticketId, 'fix')?.status).toBe('pending');
  });

  it('accept on a uat gate-failure round records the failed gate names and advances to review', () => {
    park('uat', 'gate-failure');
    recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: AT, gates: [
      { gateName: 'unit', exitCode: 1, command: 'npm', args: ['test'] },
      { gateName: 'visual', exitCode: 2, command: 'npm', args: ['v'] },
      { gateName: 'lint', exitCode: 0, command: 'npm', args: ['l'] },
    ] } as never);
    expect(acceptParkedFixRound(store, ticketId, null, { now: () => LATER })).toEqual({ ok: true, stage: 'uat' });
    expect(listFixRoundAcceptances(store, ticketId)[0]).toMatchObject({ items: ['unit', 'visual'], note: null });
    expect(getTicket(store, ticketId).stageCurrent).toBe('review');
  });

  it('both exits refuse while the fix agent session is running and change nothing', () => {
    park('review', 'blocking-review-findings');
    setAgentState(store, ticketId, 'running');
    const refused = { ok: false, reason: 'the fix agent session is still running' };
    expect(acceptParkedFixRound(store, ticketId, null, { now: () => LATER })).toEqual(refused);
    expect(retryParkedFixRound(store, ticketId, { now: () => LATER })).toEqual(refused);
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
    expect(listFixRoundAcceptances(store, ticketId)).toEqual([]);
  });

  it('accept on a uat tester round records the blocking observations', () => {
    park('uat', 'blocking-tester-observations');
    const run = openProcessRun(store, { ticketId, stageKey: 'uat', processId: 'tester', attempt: 1, startedAt: AT }).id;
    recordUatFindings(store, { ticketId, processRunId: run, createdAt: AT, findings: [{ severity: 'high', file: 'a.ts', line: 2, title: 'broken' }] });
    expect(parkedRoundItems(store, ticketId, parkedFixRound(store, ticketId)!, 'high')).toEqual(['[high] broken (a.ts:2)']);
    expect(acceptParkedFixRound(store, ticketId, null, { now: () => LATER, blockingSeverityOf: () => 'high' }).ok).toBe(true);
    expect(listFixRoundAcceptances(store, ticketId)[0]?.items).toEqual(['[high] broken (a.ts:2)']);
    expect(getTicket(store, ticketId).stageCurrent).toBe('review');
  });

  it('fixParkView caps the items at five and names the trigger', () => {
    park('review', 'blocking-review-findings');
    recordFindings(store, { ticketId, attempt: 1, runAt: AT, findings: Array.from({ length: 7 }, (_, i) => (
      { severity: 'high' as const, repo: '', title: `t${i}`, detail: 'd', source: 'agent' as const }
    )) });
    const view = fixParkView(store, ticketId);
    expect(view).toMatchObject({ sourceStage: 'review', trigger: 'blocking-review-findings', reason: 'parked: no code change' });
    expect(view?.items).toHaveLength(5);
  });

  it('fixParkView names an unknown trigger as other', () => {
    park('uat', 'tester-verifier-failure');
    expect(fixParkView(store, ticketId)).toMatchObject({ trigger: 'other', items: [] });
  });

  it('both exits refuse when the round is not parked, and write nothing', () => {
    const roundId = park('review', 'blocking-review-findings');
    store.db.prepare("UPDATE recovery_rounds SET status = 'exhausted' WHERE id = ?").run(roundId);
    expect(retryParkedFixRound(store, ticketId)).toMatchObject({ ok: false });
    expect(acceptParkedFixRound(store, ticketId, null)).toMatchObject({ ok: false });
    expect(fixParkView(store, ticketId)).toBeNull();
    expect(listFixRoundAcceptances(store, ticketId)).toEqual([]);
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
  });

  it('both exits refuse for a review-stalled block', () => {
    park('review', 'blocking-review-findings');
    store.db.prepare("UPDATE stages SET blocked_kind = 'review-stalled' WHERE ticket_id = ? AND stage_key = 'fix'").run(ticketId);
    expect(retryParkedFixRound(store, ticketId).ok).toBe(false);
    expect(acceptParkedFixRound(store, ticketId, null).ok).toBe(false);
  });
});
