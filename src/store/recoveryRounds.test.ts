import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from './db.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { transition } from '../workflow/machine.js';
import {
  openRecoveryRound,
  activeRecoverySeries,
  recoveryDecision,
  beginLiveFixExecution,
  recordFixLaunchIntent,
  confirmFixLaunch,
  completeFixExecution,
  interruptFixExecution,
  interruptActiveFixExecution,
  completeRevalidation,
  attachRevalidationStageRun,
  exhaustRecoveryRound,
  reconcileStrandedFixRounds,
  listRecoveryRounds,
  parkFixStage,
  hasFixingRound,
  FIX_PARKED_INTERRUPTED,
  FIX_PARKED_EXHAUSTED,
  FIX_PARKED_NO_EXECUTION,
  type RecoveryRound,
} from './recoveryRounds.js';
import { getTicket } from './tickets.js';
import { listProcessRuns, openProcessRun } from './processRuns.js';
import { openStageRun, listStageRuns } from './stageRuns.js';
import {
  getSessionLaunchIntent,
  failSessionLaunchIntent,
  supersedePendingLaunchIntents,
} from './sessionLaunchIntents.js';
import { manifest, review as reviewConfig } from '../manifest/fixtures.js';

const T0 = '2026-08-01T10:00:00.000Z';
const T1 = '2026-08-01T11:00:00.000Z';
const T2 = '2026-08-01T12:00:00.000Z';

describe('recovery rounds — store', () => {
  let store: Store;
  let ticketId: number;

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, ticketId, 'scope', { kind: 'passed' });
    transition(store, ticketId, 'impl', { kind: 'passed' });
  });
  afterEach(() => store.close());

  function round(over: Partial<Parameters<typeof openRecoveryRound>[1]> = {}): RecoveryRound {
    return openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
      ...over,
    });
  }

  it('opens a round numbered per (ticket, source stage), ordering failures', () => {
    const first = round();
    const second = round({ triggerDetail: 'exit 2', startedAt: T1 });
    const reviewRound = round({ sourceStage: 'review', triggerDetail: 'review findings: 1 high' });
    expect(first.round).toBe(1);
    expect(second.round).toBe(2);
    expect(reviewRound.round).toBe(1);
    expect(first).toMatchObject({ status: 'pending', maxRounds: 3, fixProcessRunId: null });
    expect(listRecoveryRounds(store, ticketId).map((r) => [r.sourceStage, r.round])).toEqual([
      ['uat', 1],
      ['uat', 2],
      ['review', 1],
    ]);
  });

  it('the active series and the decision read the COMMITTED max_rounds, never the live manifest', () => {
    // The review failure committed under a manifest that allowed 2 attempts.
    round({ sourceStage: 'review', maxRounds: 2, triggerDetail: 'gates failed: lint' });
    expect(activeRecoverySeries(store, ticketId, 'review')?.maxRounds).toBe(2);
    // The manifest knob is raised AFTER the failure: the round is not widened.
    const m = manifest({}, { review: reviewConfig({ maxFixAttempts: 5 }) });
    expect(m.review!.maxFixAttempts).toBe(5);
    expect(recoveryDecision(store, ticketId, 'review')?.maxRounds).toBe(2);
    expect(recoveryDecision(store, ticketId, 'review')).toMatchObject({
      roundId: expect.any(Number),
      round: 1,
      sourceStage: 'review',
      maxRounds: 2,
      status: 'pending',
    });
  });

  it('the decision is null when the ticket has no active series for the gate', () => {
    expect(recoveryDecision(store, ticketId, 'uat')).toBeNull();
    round();
    expect(recoveryDecision(store, ticketId, 'review')).toBeNull();
  });

  it('a terminal round is history — the active series excludes it', () => {
    const r = round();
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'interrupted', ended_at = ? WHERE id = ?")
      .run(T1, r.id);
    expect(activeRecoverySeries(store, ticketId, 'uat')).toBeNull();
    expect(recoveryDecision(store, ticketId, 'uat')).toBeNull();
  });

  it('a revalidation failure fails the active round and the new round describes the new cause', () => {
    const stageRunId = openStageRun(store, {
      ticketId, stageKey: 'uat', attempt: 0, runAt: T0, startedAt: T0,
    });
    const revalidating = round();
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?")
      .run(revalidating.id);
    attachRevalidationStageRun(store, ticketId, 'uat', stageRunId);

    const next = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: stageRunId,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1 again',
      maxRounds: 3,
      startedAt: T1,
    });

    expect(next.round).toBe(2);
    const [failed, fresh] = listRecoveryRounds(store, ticketId);
    expect(failed!.status).toBe('failed');
    expect(failed!.endedAt).toBe(T1);
    expect(failed!.uatRevalidationStageRunId).toBe(stageRunId);
    expect(fresh).toMatchObject({ round: 2, status: 'pending', triggerDetail: 'exit 1 again' });
  });

  it('beginLiveFixExecution opens exactly one Fix process run and attaches it before delivery', () => {
    const r = round();
    const run = beginLiveFixExecution(store, {
      ticketId, roundId: r.id, provider: 'claude', model: 'opus', startedAt: T1,
    });
    expect(run.processId).toBe('fix');
    expect(run.stageKey).toBe('fix');
    expect(run.status).toBe('running');
    expect(listProcessRuns(store, ticketId)).toHaveLength(1);
    const after = listRecoveryRounds(store, ticketId)[0]!;
    expect(after.status).toBe('fixing');
    expect(after.fixProcessRunId).toBe(run.id);
  });

  it('refuses a LIVE fix attachment to another ticket\'s round — no process run, no round mutation', () => {
    const otherId = createTicketFlow(store, { key: 'T-2', title: 'other' }).id;
    const otherRound = round({ ticketId: otherId });
    expect(() =>
      beginLiveFixExecution(store, { ticketId, roundId: otherRound.id, startedAt: T1 }),
    ).toThrow(/owned by ticket/);
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
    expect(listProcessRuns(store, otherId)).toHaveLength(0);
    expect(listRecoveryRounds(store, otherId)[0]!.status).toBe('pending');
  });

  it('refuses a CLOSED fix launch intent against another ticket\'s round — no intent, no round mutation', () => {
    const otherId = createTicketFlow(store, { key: 'T-2', title: 'other' }).id;
    const otherRound = round({ ticketId: otherId });
    expect(() =>
      recordFixLaunchIntent(store, {
        ticketId, launchId: 'launch-fix', provider: 'claude',
        reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: otherRound.id, at: T1,
      }),
    ).toThrow(/owned by ticket/);
    expect(getSessionLaunchIntent(store, 'launch-fix')).toBeUndefined();
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
    expect(listRecoveryRounds(store, otherId)[0]!.status).toBe('pending');
  });

  it('beginLiveFixExecution refuses a round that is not pending — one execution per round', () => {
    const r = round();
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r.id);
    expect(() =>
      beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T1 }),
    ).toThrow(/not pending/);
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
  });

  it('recordFixLaunchIntent persists a fix intent owned by the round, opening no process run', () => {
    const r = round();
    const intent = recordFixLaunchIntent(store, {
      ticketId, launchId: 'launch-fix', provider: 'claude', model: 'opus',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: r.id, at: T1,
    });
    expect(intent.purpose).toBe('fix');
    expect(intent.recoveryRoundId).toBe(r.id);
    expect(intent.implementationRunId).toBeNull();
    expect(intent.processRunId).toBeNull();
    expect(intent.status).toBe('pending');
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('pending');
  });

  it('recordFixLaunchIntent refuses a round that is not pending', () => {
    const r = round();
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r.id);
    expect(() =>
      recordFixLaunchIntent(store, {
        ticketId, launchId: 'l', provider: 'claude', recoveryRoundId: r.id, at: T1,
        reason: 'resume', sessionOrigin: 'resume',
      }),
    ).toThrow(/not pending/);
  });

  it('the accepted SessionStart transactionally opens the Fix run, attaches it to intent and round, and confirms', () => {
    const r = round();
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'launch-fix', provider: 'claude', model: 'opus',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: r.id, at: T1,
    });

    expect(confirmFixLaunch(store, 'launch-fix', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1', at: T2,
    })).toBe('confirmed');

    const intent = getSessionLaunchIntent(store, 'launch-fix')!;
    expect(intent.status).toBe('confirmed');
    expect(intent.providerSessionId).toBe('claude-session-1');
    const run = listProcessRuns(store, ticketId)[0]!;
    expect(run.processId).toBe('fix');
    expect(run.status).toBe('running');
    expect(intent.processRunId).toBe(run.id);
    const after = listRecoveryRounds(store, ticketId)[0]!;
    expect(after.fixProcessRunId).toBe(run.id);
    expect(after.status).toBe('fixing');
  });

  it('a stale or mismatched start resolves the intent without creating a process run', () => {
    const r = round();
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'launch-fix', provider: 'claude',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: r.id, at: T1,
    });
    expect(confirmFixLaunch(store, 'nope', {
      ticketId, provider: 'claude', providerSessionId: 's', at: T2,
    })).toBe('unknown');
    expect(confirmFixLaunch(store, 'launch-fix', {
      ticketId: ticketId + 999, provider: 'claude', providerSessionId: 's', at: T2,
    })).toBe('ticket-mismatch');
    expect(confirmFixLaunch(store, 'launch-fix', {
      ticketId, provider: 'codex', providerSessionId: 's', at: T2,
    })).toBe('provider-mismatch');
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('pending');
    // The intent is still pending — only the matching start confirms it.
    expect(getSessionLaunchIntent(store, 'launch-fix')!.status).toBe('pending');
  });

  it('rejects a MALFORMED historical intent that references another ticket\'s pending round — round-mismatch, nothing opened', () => {
    // The intent row is inserted directly: `recordFixLaunchIntent` would refuse
    // the cross-ticket round at record time, but a row written by a buggy older
    // build (or a forged one) can carry ticket A's id and ticket B's round. The
    // confirmation must re-validate the round inside its transaction.
    const otherId = createTicketFlow(store, { key: 'T-2', title: 'other' }).id;
    const otherRound = round({ ticketId: otherId });
    store.db
      .prepare(
        `INSERT INTO session_launch_intents
           (ticket_id, launch_id, purpose, implementation_run_id, process_run_id,
            recovery_round_id, provider, model, reason, session_origin,
            provider_session_id, status, created_at, resolved_at)
         VALUES (?, ?, 'fix', NULL, NULL, ?, 'claude', NULL, 'resume', 'resume',
                 NULL, 'pending', ?, NULL)`,
      )
      .run(ticketId, 'launch-fix-cross', otherRound.id, T1);

    expect(confirmFixLaunch(store, 'launch-fix-cross', {
      ticketId, provider: 'claude', providerSessionId: 'sess-1', at: T2,
    })).toBe('round-mismatch');

    // No process run was opened, the round is untouched, and the intent stays
    // pending — the confirmation changed nothing.
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
    expect(listProcessRuns(store, otherId)).toHaveLength(0);
    expect(listRecoveryRounds(store, otherId)[0]).toMatchObject({
      status: 'pending',
      fixProcessRunId: null,
    });
    expect(getSessionLaunchIntent(store, 'launch-fix-cross')!.status).toBe('pending');
    expect(getSessionLaunchIntent(store, 'launch-fix-cross')!.processRunId).toBeNull();
  });

  it('a terminal-creation failure resolves the intent without creating a process run', () => {
    const r = round();
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'launch-fix', provider: 'claude',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: r.id, at: T1,
    });
    expect(failSessionLaunchIntent(store, 'launch-fix', T2)).toBe(true);
    expect(getSessionLaunchIntent(store, 'launch-fix')!.status).toBe('failed');
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('pending');
  });

  it('supersession retires a pending fix intent without creating a process run', () => {
    const r = round();
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'launch-fix', provider: 'claude',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: r.id, at: T1,
    });
    expect(supersedePendingLaunchIntents(store, ticketId, 'fix', 'launch-fix', T2)).toBe(0);
    // A newer fix launch supersedes the older pending one.
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'launch-fix-2', provider: 'claude',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: r.id, at: T2,
    });
    expect(getSessionLaunchIntent(store, 'launch-fix')!.status).toBe('superseded');
    expect(listProcessRuns(store, ticketId)).toHaveLength(0);
  });

  it('the stage fix pass marker passes the linked run and moves the round to revalidating', () => {
    const r = round();
    const run = beginLiveFixExecution(store, {
      ticketId, roundId: r.id, provider: 'claude', startedAt: T1,
    });
    expect(completeFixExecution(store, ticketId, T2)).toBe(true);
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('passed');
    expect(listProcessRuns(store, ticketId)[0]!.endedAt).toBe(T2);
    expect(run.status).toBe('running'); // the returned snapshot is immutable evidence
    const after = listRecoveryRounds(store, ticketId)[0]!;
    expect(after.status).toBe('revalidating');
    expect(after.endedAt).toBeNull();
  });

  it('completeFixExecution is a no-op for a ticket with no active round', () => {
    expect(completeFixExecution(store, ticketId, T1)).toBe(false);
  });

  it('interruptFixExecution marks the execution and the round interrupted, consuming no round', () => {
    const r = round();
    const run = beginLiveFixExecution(store, {
      ticketId, roundId: r.id, provider: 'claude', startedAt: T1,
    });
    expect(interruptFixExecution(store, r.id, T2)).toBe(true);
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('interrupted');
    const after = listRecoveryRounds(store, ticketId)[0]!;
    expect(after.status).toBe('interrupted');
    expect(after.endedAt).toBe(T2);
    expect(after.fixProcessRunId).toBe(run.id);
    // Idempotent: an interrupted round is not interrupted again.
    expect(interruptFixExecution(store, r.id, T2)).toBe(false);
  });

  it('interruptFixExecution re-stamps the fix stage row as parked, so it stops reading running', () => {
    // The ticket must actually BE at fix for the re-stamp to land — the machine's
    // transition review-fail → fix is what the production flow uses.
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const r = round();
    beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T1 });

    expect(interruptFixExecution(store, r.id, T2)).toBe(true);

    const fixStage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
    expect(fixStage.status).toBe('failed');
    expect(fixStage.verdict).toBe(FIX_PARKED_INTERRUPTED);
    expect(fixStage.endedAt).toBe(T2);
    // The ticket stays AT fix — the park is a read fix, never a transition.
    expect(getTicket(store, ticketId).stageCurrent).toBe('fix');
  });

  it('parkFixStage re-stamps only a running fix row of a ticket at fix, and only once', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix

    expect(parkFixStage(store, ticketId, FIX_PARKED_NO_EXECUTION, T1)).toBe(true);
    const parked = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
    expect(parked.status).toBe('failed');
    expect(parked.verdict).toBe(FIX_PARKED_NO_EXECUTION);
    expect(parked.endedAt).toBe(T1);

    // Idempotent: a second park is a no-op and never overwrites the first verdict.
    expect(parkFixStage(store, ticketId, FIX_PARKED_EXHAUSTED, T2)).toBe(false);
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.verdict).toBe(
      FIX_PARKED_NO_EXECUTION,
    );
  });

  it('parkFixStage refuses a ticket not at fix, and a fix row that is not running', () => {
    // Ticket at uat: the fix row is pending here (createTicketFlow seeds rows) —
    // nothing is re-stamped, whatever the row says.
    expect(parkFixStage(store, ticketId, FIX_PARKED_NO_EXECUTION, T1)).toBe(false);

    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    store.db.prepare("UPDATE stages SET status = 'passed' WHERE ticket_id = ? AND stage_key = 'fix'").run(ticketId);
    // A fix row the marker already passed is a finished fact — never re-parked.
    expect(parkFixStage(store, ticketId, FIX_PARKED_NO_EXECUTION, T1)).toBe(false);
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.status).toBe('passed');
  });

  it('a parked fix row reads running again the moment a fix execution begins', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const r = round();
    parkFixStage(store, ticketId, FIX_PARKED_NO_EXECUTION, T1);

    beginLiveFixExecution(store, { ticketId, roundId: r.id, provider: 'claude', startedAt: T1 });

    const fixStage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
    expect(fixStage.status).toBe('running');
    expect(fixStage.verdict).toBeNull();
    expect(fixStage.endedAt).toBeNull();
  });

  it('a parked fix row reads running again when the closed-session launch confirms', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const r = round();
    parkFixStage(store, ticketId, FIX_PARKED_NO_EXECUTION, T1);
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'launch-fix', provider: 'claude',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: r.id, at: T1,
    });

    expect(confirmFixLaunch(store, 'launch-fix', {
      ticketId, provider: 'claude', providerSessionId: 'claude-session-1', at: T2,
    })).toBe('confirmed');

    const fixStage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
    expect(fixStage.status).toBe('running');
    expect(fixStage.verdict).toBeNull();
  });

  it('interruptActiveFixExecution finds the in-flight round; a pending round is left alone', () => {
    const pending = round();
    expect(interruptActiveFixExecution(store, ticketId, T1)).toBe(false);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('pending');
    beginLiveFixExecution(store, { ticketId, roundId: pending.id, startedAt: T1 });
    expect(interruptActiveFixExecution(store, ticketId, T2)).toBe(true);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
  });

  it('a uat-origin round is passed by its uat revalidation', () => {
    const r = round();
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r.id);
    const runId = openStageRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: T1, startedAt: T1 });
    attachRevalidationStageRun(store, ticketId, 'uat', runId);
    completeRevalidation(store, { ticketId, stageKey: 'uat', stageRunId: runId, endedAt: T2 });
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('passed');
    expect(listRecoveryRounds(store, ticketId)[0]!.endedAt).toBe(T2);
  });

  it('a review-origin round needs its uat revalidation to pass BEFORE review is attached, and only review completes it', () => {
    const r = round({ sourceStage: 'review' });
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r.id);
    const uatRunId = openStageRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: T1, startedAt: T1 });
    attachRevalidationStageRun(store, ticketId, 'uat', uatRunId);
    completeRevalidation(store, { ticketId, stageKey: 'uat', stageRunId: uatRunId, endedAt: T1 });
    // UAT passed but the round is still revalidating — its own review is the authority.
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('revalidating');
    expect(listRecoveryRounds(store, ticketId)[0]!.uatRevalidationStageRunId).toBe(uatRunId);

    const reviewRunId = openStageRun(store, { ticketId, stageKey: 'review', attempt: 1, runAt: T1, startedAt: T1 });
    attachRevalidationStageRun(store, ticketId, 'review', reviewRunId);
    expect(listRecoveryRounds(store, ticketId)[0]!.reviewRevalidationStageRunId).toBe(reviewRunId);
    // A uat verdict cannot complete a review-origin round.
    completeRevalidation(store, { ticketId, stageKey: 'uat', stageRunId: reviewRunId, endedAt: T2 });
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('revalidating');
    completeRevalidation(store, { ticketId, stageKey: 'review', stageRunId: reviewRunId, endedAt: T2 });
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('passed');
  });

  it('an intermediate uat failure fails the review-origin round so the new uat round names the cause', () => {
    const r = round({ sourceStage: 'review' });
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r.id);
    const uatRunId = openStageRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: T1, startedAt: T1 });
    attachRevalidationStageRun(store, ticketId, 'uat', uatRunId);

    const next = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: uatRunId,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1 during revalidation',
      maxRounds: 3,
      startedAt: T1,
    });

    const [reviewRound, uatRound] = listRecoveryRounds(store, ticketId);
    expect(reviewRound).toMatchObject({ sourceStage: 'review', status: 'failed' });
    expect(reviewRound!.uatRevalidationStageRunId).toBe(uatRunId);
    expect(uatRound!.id).toBe(next.id);
    expect(uatRound).toMatchObject({ sourceStage: 'uat', round: 1, status: 'pending' });
  });

  it('exhaustRecoveryRound terminates only the pending round it owns, stamping endedAt', () => {
    const r = round();
    expect(exhaustRecoveryRound(store, ticketId, r.id, T1)).toBe(true);
    expect(listRecoveryRounds(store, ticketId)[0]).toMatchObject({
      status: 'exhausted',
      endedAt: T1,
    });
    // Already terminal — an idempotent no-op, never reconsidered as pending.
    expect(exhaustRecoveryRound(store, ticketId, r.id, T2)).toBe(false);
    // Another ticket cannot exhaust this ticket's round.
    const otherId = createTicketFlow(store, { key: 'T-2', title: 'other' }).id;
    expect(exhaustRecoveryRound(store, otherId, r.id, T2)).toBe(false);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('exhausted');
  });

  it('exhaustRecoveryRound re-stamps the fix stage row as parked at the cap', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const r = round();

    expect(exhaustRecoveryRound(store, ticketId, r.id, T1)).toBe(true);

    const fixStage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
    expect(fixStage.status).toBe('failed');
    expect(fixStage.verdict).toBe(FIX_PARKED_EXHAUSTED);
    expect(fixStage.endedAt).toBe(T1);
  });

  it('exhaustRecoveryRound never overwrites a fixing or revalidating round', () => {
    const r = round();
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r.id);
    expect(exhaustRecoveryRound(store, ticketId, r.id, T1)).toBe(false);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r.id);
    expect(exhaustRecoveryRound(store, ticketId, r.id, T1)).toBe(false);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('revalidating');
  });

  it('reconcileStrandedFixRounds interrupts a fixing round whose Fix run is no longer running', () => {
    const r = round();
    const run = beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
    // The host died: the activation process-run sweep (or a superseding open)
    // marked the run stale, which nothing propagated to the round — the round
    // stayed `fixing` and the ticket sat at fix forever.
    store.db.prepare("UPDATE process_runs SET status = 'stale' WHERE id = ?").run(run.id);

    const stranded = reconcileStrandedFixRounds(store, T1);

    expect(stranded).toEqual([
      { kind: 'execution', roundId: r.id, ticketId, sourceStage: 'uat', round: 1, fixProcessRunId: run.id },
    ]);
    expect(listRecoveryRounds(store, ticketId)[0]).toMatchObject({
      status: 'interrupted',
      endedAt: T1,
    });
    // Idempotent: a round already interrupted is not reported twice.
    expect(reconcileStrandedFixRounds(store, T2)).toEqual([]);
  });

  it('reconcileStrandedFixRounds parks a fix stage row that reads running with no round at all', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix, no round

    const stranded = reconcileStrandedFixRounds(store, T1);

    expect(stranded).toEqual([
      { kind: 'stage', roundId: null, ticketId, sourceStage: null, round: null, fixProcessRunId: null },
    ]);
    const fixStage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
    expect(fixStage.status).toBe('failed');
    expect(fixStage.verdict).toBe(FIX_PARKED_NO_EXECUTION);
    expect(fixStage.endedAt).toBe(T1);
    // Idempotent — a second activation parks nothing.
    expect(reconcileStrandedFixRounds(store, T2)).toEqual([]);
  });

  it('reconcileStrandedFixRounds parks a running fix row whose round never produced an execution', () => {
    // The launch never happened and never will (nothing drives fix tickets):
    // a pending round with no fix run and no launch intent is a parked ticket.
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    round();

    const stranded = reconcileStrandedFixRounds(store, T1);

    expect(stranded).toMatchObject([{ kind: 'stage', ticketId }]);
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.status).toBe('failed');
    // The round itself is evidence and stays pending — only the headline is parked.
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('pending');
  });

  it('reconcileStrandedFixRounds leaves alone a pending round with a PENDING fix launch intent', () => {
    // A launch is genuinely in flight: `recordFixLaunchIntent` was called, the
    // terminal was prepared, and the round awaits its SessionStart to confirm
    // (`confirmFixLaunch`). That is NOT "no fix execution in flight" — parking
    // the stage here is exactly how a review round-2 fix read blocked while the
    // agent was actually working (REVIEW-2ND-ROUND-FIX-STUCK-WITH): the intent
    // was recorded at 21:47:20 and the activation sweep parked the stage at
    // 22:00 with "fix parked — no fix execution in flight".
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const r = round();
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'launch-pending',
      provider: 'opencode',
      reason: 'initial',
      sessionOrigin: 'new',
      recoveryRoundId: r.id,
      at: T0,
    });

    expect(reconcileStrandedFixRounds(store, T1)).toEqual([]);
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.status).toBe('running');
    // The intent itself is untouched — only the headline park is refused.
    expect(getSessionLaunchIntent(store, 'launch-pending')!.status).toBe('pending');
  });

  it('reconcileStrandedFixRounds parks a running fix row whose every round is terminal', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const r = round();
    store.db.prepare("UPDATE recovery_rounds SET status = 'interrupted', ended_at = ? WHERE id = ?").run(T0, r.id);

    const stranded = reconcileStrandedFixRounds(store, T1);

    expect(stranded).toMatchObject([{ kind: 'stage', ticketId }]);
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.status).toBe('failed');
  });

  it('reconcileStrandedFixRounds leaves a fix stage row alone while a fix is fixing', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    const r = round();
    beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });

    expect(reconcileStrandedFixRounds(store, T1)).toEqual([]);
    expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.status).toBe('running');
  });

  it('hasFixingRound is true only while a fix execution is actually attached', () => {
    transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
    expect(hasFixingRound(store, ticketId)).toBe(false); // no round yet
    const r = round();
    expect(hasFixingRound(store, ticketId)).toBe(false); // pending is not fixing
    beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
    expect(hasFixingRound(store, ticketId)).toBe(true);
    interruptFixExecution(store, r.id, T1);
    expect(hasFixingRound(store, ticketId)).toBe(false);
  });

  it('reconcileStrandedFixRounds interrupts a fixing round that never opened a Fix run', () => {
    const r = round();
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r.id);
    expect(reconcileStrandedFixRounds(store, T1)).toMatchObject([{ roundId: r.id }]);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
  });

  it('reconcileStrandedFixRounds leaves a live Fix execution strictly alone', () => {
    const r = round();
    beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
    expect(reconcileStrandedFixRounds(store, T1)).toEqual([]);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
    // Nor any round that is not fixing at all.
    const otherId = createTicketFlow(store, { key: 'T-3', title: 'pending' }).id;
    openRecoveryRound(store, {
      ticketId: otherId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: T0,
    });
    expect(reconcileStrandedFixRounds(store, T1)).toEqual([]);
    expect(listRecoveryRounds(store, otherId)[0]!.status).toBe('pending');
  });

  it('an execution crash — evidence never committed — creates no recovery round', () => {
    // A run that died before any verdict (openStageRun left 'running', no
    // commitGateOutcome call) must not have invented a round.
    openStageRun(store, { ticketId, stageKey: 'uat', attempt: 0, runAt: T0, startedAt: T0 });
    openProcessRun(store, { ticketId, stageKey: 'uat', processId: 'gates', attempt: 0, startedAt: T0 });
    expect(listRecoveryRounds(store, ticketId)).toEqual([]);
    expect(listStageRuns(store, ticketId)[0]!.status).toBe('running');
  });
});
