import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openRecoveryRound, roundById } from '../store/recoveryRounds.js';
import { recordFixRoundHeads } from '../store/fixRoundHeads.js';
import { getStage, setStage } from '../store/stages.js';
import { getTicket, setStageCurrent } from '../store/tickets.js';
import { FIX_CONTINUED_PREFIX } from '../model/noChange.js';
import { continueOrPark, FIX_SAME_HEAD_LIMIT } from './fixContinue.js';
import { PARK_NO_NEW_COMMIT_RERUN_FAILED } from './fixHostRerun.js';

const AT = '2026-09-01T10:00:00.000Z';
const WT = '/wt/web';

describe('continueOrPark (T1330)', () => {
  let store: Store;
  let ticketId: number;

  const open = (over: {
    triggerKind?: string;
    sourceStage?: 'uat' | 'review' | 'ship';
    maxRounds?: number;
    status?: string;
    head?: string;
  } = {}): number => {
    const id = openRecoveryRound(store, {
      ticketId,
      sourceStage: over.sourceStage ?? 'uat',
      sourceProcessId: over.sourceStage === 'review' ? 'review' : 'gates',
      triggerKind: over.triggerKind ?? 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: over.maxRounds ?? 10,
      startedAt: AT,
    } as never).id;
    store.db.prepare('UPDATE recovery_rounds SET status = ? WHERE id = ?').run(over.status ?? 'fixing', id);
    recordFixRoundHeads(store, id, [{ worktreePath: WT, headSha: over.head ?? 'aaa' }]);
    return id;
  };

  const opts = { detail: 'unit (web): flaky', parkVerdict: PARK_NO_NEW_COMMIT_RERUN_FAILED, at: AT };

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
  });

  it('opens the next round while the budget has one, closing this round failed with the prefix', () => {
    const id = open();
    const out = continueOrPark(store, roundById(store, id)!, opts);
    expect(out.kind).toBe('continued');
    if (out.kind !== 'continued') throw new Error('unreachable');
    expect(out.round).toMatchObject({ round: 2, status: 'pending' });
    expect(store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(id)).toEqual({
      status: 'failed',
      end_reason: `${FIX_CONTINUED_PREFIX} unit (web): flaky`,
    });
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
    expect(getStage(store, ticketId, 'fix')?.status).toBe('running');
  });

  it('parks with the spent text when no fix round is left', () => {
    open({ maxRounds: 3, status: 'failed' });
    open({ maxRounds: 3, status: 'failed' });
    const last = open({ maxRounds: 3 });
    const out = continueOrPark(store, roundById(store, last)!, opts);
    expect(out.kind).toBe('parked');
    if (out.kind !== 'parked') throw new Error('unreachable');
    expect(out.verdict).toBe(`${PARK_NO_NEW_COMMIT_RERUN_FAILED} — the fix rounds are spent (round 3 of 3)`);
    expect(store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(last)).toEqual({
      status: 'interrupted',
      end_reason: out.verdict,
    });
    expect(getStage(store, ticketId, 'fix')).toMatchObject({ status: 'failed', verdict: out.verdict });
  });

  it(`parks at the ${FIX_SAME_HEAD_LIMIT}th round on one head`, () => {
    for (let i = 0; i < FIX_SAME_HEAD_LIMIT - 1; i += 1) open({ status: 'failed' });
    const last = open();
    const out = continueOrPark(store, roundById(store, last)!, opts);
    expect(out.kind).toBe('parked');
    if (out.kind !== 'parked') throw new Error('unreachable');
    expect(out.verdict).toContain(`${FIX_SAME_HEAD_LIMIT} rounds in a row changed nothing on the same head`);
    expect(roundById(store, last)?.status).toBe('interrupted');
    expect(getStage(store, ticketId, 'fix')?.status).toBe('failed');
  });

  it('parks when the source stage is not uat or review', () => {
    const id = open({ sourceStage: 'ship' });
    const out = continueOrPark(store, roundById(store, id)!, opts);
    expect(out.kind).toBe('parked');
    if (out.kind !== 'parked') throw new Error('unreachable');
    expect(out.verdict).toContain('cannot continue from the ship stage');
  });

  it('bounds the continued end_reason and keeps the prefix', () => {
    const id = open();
    const out = continueOrPark(store, roundById(store, id)!, { ...opts, detail: 'x'.repeat(400) });
    expect(out.kind).toBe('continued');
    const row = store.db.prepare('SELECT end_reason FROM recovery_rounds WHERE id = ?').get(id) as { end_reason: string };
    expect(row.end_reason.startsWith(FIX_CONTINUED_PREFIX)).toBe(true);
    expect(row.end_reason.length).toBeLessThanOrEqual(200);
  });
});
