import { beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openRecoveryRound, roundById } from '../store/recoveryRounds.js';
import { recordGateRun } from '../store/gateRuns.js';
import { getStage, setStage } from '../store/stages.js';
import { setStageCurrent } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import { recordFixRoundHeads } from '../store/fixRoundHeads.js';
import { ticketsWithRequestedNoChangeRerun } from '../store/fixNoChangeRounds.js';
import { NO_CHANGE_RERUN_REQUESTED_REPLY } from '../model/noChange.js';
import type { GitRunner } from '../integrations/git.js';
import { applyNoChangeMarker } from './fixNoChange.js';

const AT = '2026-01-01T00:00:00Z';
const WT = '/wt/web';

const gitAt = (sha: string): GitRunner => (async () => ({ exitCode: 0, stdout: `${sha}\n`, stderr: '' })) as unknown as GitRunner;

describe('applyNoChangeMarker', () => {
  let store: Store;
  let ticketId: number;
  let projectId: number;

  const openFixing = (triggerKind: string, sourceStage: 'uat' | 'review', head = 'aaa'): number => {
    const id = openRecoveryRound(store, {
      ticketId, sourceStage, sourceProcessId: sourceStage === 'uat' ? 'gates' : 'review', triggerKind,
      triggerDetail: 'x', maxRounds: 3, startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(id);
    recordFixRoundHeads(store, id, [{ worktreePath: WT, headSha: head }]);
    return id;
  };

  beforeEach(() => {
    store = openStore(':memory:');
    projectId = upsertProject(store, { slug: 'p' }).id;
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
    recordGateRun(store, {
      ticketId, stageKey: 'uat', attempt: 1, runAt: AT,
      gates: [{ gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'test:unit'], summary: 'flaky' }],
    });
  });

  it('gate-failure round, no new commit, host CLI: records the reason and requests the sweep re-run', async () => {
    const roundId = openFixing('gate-failure', 'uat');
    const out = await applyNoChangeMarker(store, ticketId, 'port window', gitAt('aaa'), { viaBridge: false, now: () => AT });
    expect(out).toEqual({ kind: 'rerun-requested', message: NO_CHANGE_RERUN_REQUESTED_REPLY });
    expect(roundById(store, roundId)?.noChangeReason).toBe('port window');
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([ticketId]);
  });

  it('gate-failure round via the bridge hands the re-run to recoverRefusal, and the sweep does not list it', async () => {
    openFixing('gate-failure', 'uat');
    expect((await applyNoChangeMarker(store, ticketId, 'r', gitAt('aaa'), { viaBridge: true })).kind).toBe('rerun-via-bridge');
    expect(ticketsWithRequestedNoChangeRerun(store, projectId)).toEqual([]);
  });

  it('gate-failure round with no failed gate rows: not applicable and no reason recorded', async () => {
    store.db.prepare('DELETE FROM gate_runs WHERE ticket_id = ?').run(ticketId);
    const roundId = openFixing('gate-failure', 'uat');
    expect((await applyNoChangeMarker(store, ticketId, 'r', gitAt('aaa'), { viaBridge: false })).kind).toBe('not-applicable');
    expect(roundById(store, roundId)?.noChangeReason).toBeNull();
  });

  it('review round: records the reason and lets the normal marker pass', async () => {
    const roundId = openFixing('blocking-review-findings', 'review');
    expect((await applyNoChangeMarker(store, ticketId, 'needs real sbx run', gitAt('aaa'), { viaBridge: false })).kind).toBe('proceed');
    expect(roundById(store, roundId)?.noChangeReason).toBe('needs real sbx run');
  });

  it('a new commit: not applicable, nothing recorded', async () => {
    const roundId = openFixing('gate-failure', 'uat');
    expect((await applyNoChangeMarker(store, ticketId, 'r', gitAt('bbb'), { viaBridge: false })).kind).toBe('not-applicable');
    expect(roundById(store, roundId)?.noChangeReason).toBeNull();
  });

  it('a second no-change on the same head parks the fix stage', async () => {
    const r1 = openFixing('blocking-review-findings', 'review');
    await applyNoChangeMarker(store, ticketId, 'first', gitAt('aaa'), { viaBridge: false, now: () => AT });
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r1);
    const r2 = openFixing('blocking-review-findings', 'review', 'aaa');
    const out = await applyNoChangeMarker(store, ticketId, 'again', gitAt('aaa'), { viaBridge: false, now: () => AT });
    expect(out.kind).toBe('refused');
    expect(getStage(store, ticketId, 'fix')?.status).toBe('failed');
    expect(getStage(store, ticketId, 'fix')?.verdict).toContain('second no-change verdict on the same head');
    expect(roundById(store, r2)?.status).toBe('interrupted');
    expect(roundById(store, r2)?.noChangeReason).toBe('again');
  });

  it('a repeat no-change in the same round keeps the first reason and repeats the decision', async () => {
    const roundId = openFixing('blocking-review-findings', 'review');
    await applyNoChangeMarker(store, ticketId, 'first', gitAt('aaa'), { viaBridge: false });
    const out = await applyNoChangeMarker(store, ticketId, 'second', gitAt('aaa'), { viaBridge: false });
    expect(out.kind).toBe('proceed');
    expect(roundById(store, roundId)?.noChangeReason).toBe('first');
    expect(roundById(store, roundId)?.status).toBe('fixing');
  });

  it('a different head after a previous no-change does not park', async () => {
    const r1 = openFixing('blocking-review-findings', 'review');
    await applyNoChangeMarker(store, ticketId, 'first', gitAt('aaa'), { viaBridge: false });
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r1);
    openFixing('blocking-review-findings', 'review', 'ccc');
    expect((await applyNoChangeMarker(store, ticketId, 'again', gitAt('ccc'), { viaBridge: false })).kind).toBe('proceed');
  });

  it('no active round: not applicable', async () => {
    expect((await applyNoChangeMarker(store, ticketId, 'r', gitAt('aaa'), { viaBridge: false })).kind).toBe('not-applicable');
  });
});
