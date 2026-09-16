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
  latestInterruptedRound,
  reopenInterruptedRound,
  reconcileStrandedFixRounds,
  sweepStalledFixRounds,
  listRecoveryRounds,
  parkFixStage,
  hasFixingRound,
  FIX_PARKED_INTERRUPTED,
  FIX_PARKED_EXHAUSTED,
  FIX_PARKED_NO_EXECUTION,
  FIX_PARKED_STALLED,
  type RecoveryRound,
} from './recoveryRounds.js';
import { getTicket } from './tickets.js';
import { upsertProject } from './projects.js';
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

  it('round-trips a ship source with pr-review and upstream-changes-requested', () => {
    const opened = round({
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      triggerKind: 'upstream-changes-requested',
      triggerDetail: '2 open items across api,web from @alice',
    });
    expect(opened.sourceStage).toBe('ship');
    expect(opened.sourceProcessId).toBe('pr-review');
    expect(opened.triggerKind).toBe('upstream-changes-requested');
    expect(opened.round).toBe(1);
    // A stored row reads back through `rowToRound` without falling back to the
    // conservative defaults (a drift in `SOURCE_PROCESS_IDS`/`TRIGGER_KINDS`
    // would silently rewrite these).
    const readBack = activeRecoverySeries(store, ticketId, 'ship');
    expect(readBack?.id).toBe(opened.id);
    expect(readBack?.sourceProcessId).toBe('pr-review');
    expect(readBack?.triggerKind).toBe('upstream-changes-requested');
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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);
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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);

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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);
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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);
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

  it('a ship-origin round revalidates uat then review and is completed ONLY by review', () => {
    const r = round({
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      triggerKind: 'upstream-changes-requested',
    });
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r.id);

    const uatRunId = openStageRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 1,
      runAt: T1,
      startedAt: T1,
    });
    attachRevalidationStageRun(store, ticketId, 'uat', uatRunId);
    completeRevalidation(store, { ticketId, stageKey: 'uat', stageRunId: uatRunId, endedAt: T1 });
    // UAT passed, but a ship round awaits its own review run.
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('revalidating');

    const reviewRunId = openStageRun(store, {
      ticketId,
      stageKey: 'review',
      attempt: 1,
      runAt: T1,
      startedAt: T1,
    });
    attachRevalidationStageRun(store, ticketId, 'review', reviewRunId);
    expect(listRecoveryRounds(store, ticketId)[0]!.reviewRevalidationStageRunId).toBe(reviewRunId);
    completeRevalidation(store, { ticketId, stageKey: 'review', stageRunId: reviewRunId, endedAt: T2 });
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('passed');
    expect(listRecoveryRounds(store, ticketId)[0]!.endedAt).toBe(T2);
  });

  it('a failed review revalidation fails a ship-origin round, so it never sticks revalidating', () => {
    const r = round({
      sourceStage: 'ship',
      sourceProcessId: 'pr-review',
      triggerKind: 'upstream-changes-requested',
    });
    store.db.prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?").run(r.id);
    const uatRunId = openStageRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: T1, startedAt: T1 });
    attachRevalidationStageRun(store, ticketId, 'uat', uatRunId);
    completeRevalidation(store, { ticketId, stageKey: 'uat', stageRunId: uatRunId, endedAt: T1 });
    const reviewRunId = openStageRun(store, { ticketId, stageKey: 'review', attempt: 1, runAt: T1, startedAt: T1 });
    attachRevalidationStageRun(store, ticketId, 'review', reviewRunId);

    const next = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'review',
      sourceProcessId: 'review',
      sourceStageRunId: reviewRunId,
      sourceProcessRunId: null,
      triggerKind: 'blocking-review-findings',
      triggerDetail: 'findings during revalidation',
      maxRounds: 3,
      startedAt: T2,
    });

    const [shipRound, reviewRound] = listRecoveryRounds(store, ticketId);
    expect(shipRound).toMatchObject({ sourceStage: 'ship', status: 'failed' });
    expect(shipRound!.reviewRevalidationStageRunId).toBe(reviewRunId);
    expect(reviewRound!.id).toBe(next.id);
    expect(reviewRound).toMatchObject({ sourceStage: 'review', status: 'pending' });
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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);
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

  it('latestInterruptedRound returns the LATEST interrupted round for the gate', () => {
    const first = round();
    const second = round({ triggerDetail: 'exit 2', startedAt: T1 });
    expect(latestInterruptedRound(store, ticketId, 'uat')).toBeNull();
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'interrupted', ended_at = ? WHERE id = ?")
      .run(T1, first.id);
    expect(latestInterruptedRound(store, ticketId, 'uat')?.id).toBe(first.id);
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'interrupted', ended_at = ? WHERE id = ?")
      .run(T2, second.id);
    expect(latestInterruptedRound(store, ticketId, 'uat')?.id).toBe(second.id);
    // A different gate's interrupted round is not this gate's.
    const reviewRound = round({ sourceStage: 'review', startedAt: T2 });
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'interrupted', ended_at = ? WHERE id = ?")
      .run(T2, reviewRound.id);
    expect(latestInterruptedRound(store, ticketId, 'uat')?.id).toBe(second.id);
    expect(latestInterruptedRound(store, ticketId, 'review')?.id).toBe(reviewRound.id);
  });

  it('latestInterruptedRound is null when the only round is another status', () => {
    const r = round();
    expect(latestInterruptedRound(store, ticketId, 'uat')).toBeNull(); // pending
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'failed', ended_at = ? WHERE id = ?")
      .run(T1, r.id);
    expect(latestInterruptedRound(store, ticketId, 'uat')).toBeNull(); // failed
  });

  it('reopenInterruptedRound moves an interrupted round back to pending, clearing ended_at', () => {
    const r = round();
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'interrupted', ended_at = ? WHERE id = ?")
      .run(T1, r.id);
    expect(reopenInterruptedRound(store, ticketId, r.id)).toBe(true);
    expect(listRecoveryRounds(store, ticketId)[0]).toMatchObject({
      status: 'pending',
      endedAt: null,
    });
    // An already-pending round is an idempotent no-op.
    expect(reopenInterruptedRound(store, ticketId, r.id)).toBe(false);
  });

  it('reopenInterruptedRound refuses a round that is not interrupted', () => {
    const r = round(); // pending
    expect(reopenInterruptedRound(store, ticketId, r.id)).toBe(false);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('pending');
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r.id);
    expect(reopenInterruptedRound(store, ticketId, r.id)).toBe(false);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
    // Another ticket cannot reopen this ticket's round.
    const otherId = createTicketFlow(store, { key: 'T-2', title: 'other' }).id;
    expect(reopenInterruptedRound(store, otherId, r.id)).toBe(false);
    expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
  });

  it('interruptFixExecution increments interrupt_count — the crash-loop backstop', () => {
    // A crash consumes no round, but it must advance the counter that bounds
    // the driver's reopen, or a fix that keeps dying relaunches forever.
    const r = round();
    beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
    expect(interruptFixExecution(store, r.id, T1)).toBe(true);
    expect(listRecoveryRounds(store, ticketId)[0]).toMatchObject({
      status: 'interrupted',
      interruptCount: 1,
    });
    // Reopen (a crash is resumable) and crash again: the tally keeps climbing.
    expect(reopenInterruptedRound(store, ticketId, r.id)).toBe(true);
    beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T2 });
    expect(interruptFixExecution(store, r.id, T2)).toBe(true);
    expect(listRecoveryRounds(store, ticketId)[0]).toMatchObject({
      status: 'interrupted',
      interruptCount: 2,
    });
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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);

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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);
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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);
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
    store.db.prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'").run(T0, ticketId);
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

  describe('sweepStalledFixRounds', () => {
    let projectId: number;
    beforeEach(() => {
      // The sweep is project-scoped: bind a project and put the ticket in it.
      projectId = upsertProject(store, { slug: 'sweep-proj' }).id;
      store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(projectId, ticketId);
    });

    // The ticket must actually BE at fix for the park to land, exactly like the
    // sibling sweep's park tests.
    function toFix(): void {
      transition(store, ticketId, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
      store.db
        .prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'")
        .run(T0, ticketId);
    }

    it('parks a fixing round whose live run has shown no progress past the timeout', () => {
      toFix();
      const r = round();
      const run = beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });

      const stalled = sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId });

      expect(stalled).toEqual([
        {
          kind: 'stalled',
          roundId: r.id,
          ticketId,
          sourceStage: 'uat',
          round: 1,
          fixProcessRunId: run.id,
        },
      ]);
      expect(listRecoveryRounds(store, ticketId)[0]).toMatchObject({
        status: 'interrupted',
        endedAt: T2,
      });
      const fixRun = listProcessRuns(store, ticketId)[0]!;
      // `stale` carries NO end stamp — a run we stopped believing in has no
      // known stop time (the same contract every other stale transition keeps).
      expect(fixRun.status).toBe('stale');
      expect(fixRun.endedAt).toBeNull();
      const fixStage = getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!;
      expect(fixStage.status).toBe('failed');
      expect(fixStage.verdict).toBe(FIX_PARKED_STALLED);
      expect(fixStage.endedAt).toBe(T2);
    });

    it('leaves a fixing round alone while it is still inside the timeout', () => {
      toFix();
      const r = round();
      beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });

      // Cutoff is T2 - 180m = 09:00; the run started at T0 (10:00) is newer.
      expect(sweepStalledFixRounds(store, { at: T2, timeoutMs: 180 * 60_000, projectId })).toEqual([]);
      expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
      expect(listProcessRuns(store, ticketId)[0]!.status).toBe('running');
      expect(getTicket(store, ticketId).stages.find((s) => s.stageKey === 'fix')!.status).toBe(
        'running',
      );
    });

    it('leaves a round alone when a newer guide pull shows progress', () => {
      toFix();
      const r = round();
      beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
      // A working agent opens guide-pull rows: a NEWER pull by the ticket's
      // session is progress.
      openProcessRun(store, {
        ticketId,
        stageKey: 'impl',
        processId: 'guide-pull',
        attempt: 0,
        startedAt: T2,
      });

      expect(sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId })).toEqual([]);
      expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
    });

    it('does not let an unrelated pipeline run reset the stall clock', () => {
      toFix();
      const r = round();
      const run = beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
      // A gate/tester/review run is PIPELINE activity, not the fix agent working
      // — it must not mask a fix that has produced no progress for the window.
      openProcessRun(store, {
        ticketId,
        stageKey: 'uat',
        processId: 'gates',
        attempt: 0,
        startedAt: T2,
      });

      const stalled = sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId });

      expect(stalled).toMatchObject([{ kind: 'stalled', ticketId, fixProcessRunId: run.id }]);
      expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('interrupted');
    });

    it('is idempotent', () => {
      toFix();
      const r = round();
      beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });

      expect(sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId })).toHaveLength(1);
      expect(sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId })).toEqual([]);
    });

    it('ignores a round whose run is not running', () => {
      toFix();
      const r = round();
      const run = beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });
      // This set belongs to reconcileStrandedFixRounds; the two sweeps never
      // double-settle.
      store.db.prepare("UPDATE process_runs SET status = 'passed' WHERE id = ?").run(run.id);

      expect(sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId })).toEqual([]);
      expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
    });

    it("never settles another project's ticket with this project's window", () => {
      toFix();
      const r = round();
      beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });

      const otherProject = upsertProject(store, { slug: 'other-proj' }).id;
      const otherTicket = createTicketFlow(store, {
        key: 'T-2',
        title: 'other',
        projectId: otherProject,
      }).id;
      transition(store, otherTicket, 'scope', { kind: 'passed' });
      transition(store, otherTicket, 'impl', { kind: 'passed' });
      transition(store, otherTicket, 'uat', { kind: 'failed', reason: 'exit 1' }); // -> fix
      store.db
        .prepare("UPDATE stages SET started_at = ? WHERE ticket_id = ? AND stage_key = 'fix'")
        .run(T0, otherTicket);
      const otherRound = openRecoveryRound(store, {
        ticketId: otherTicket,
        sourceStage: 'uat',
        sourceProcessId: 'gates',
        sourceStageRunId: null,
        sourceProcessRunId: null,
        triggerKind: 'gate-failure',
        triggerDetail: 'exit 1',
        maxRounds: 3,
        startedAt: T0,
      });
      beginLiveFixExecution(store, {
        ticketId: otherTicket,
        roundId: otherRound.id,
        startedAt: T0,
      });

      const stalled = sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId });

      expect(stalled).toMatchObject([{ kind: 'stalled', ticketId }]);
      // The other project's identical stall is left for ITS own window.
      expect(listRecoveryRounds(store, otherTicket)[0]!.status).toBe('fixing');
    });

    it('settles nothing when no project is bound', () => {
      toFix();
      const r = round();
      beginLiveFixExecution(store, { ticketId, roundId: r.id, startedAt: T0 });

      expect(
        sweepStalledFixRounds(store, { at: T2, timeoutMs: 60 * 60_000, projectId: null }),
      ).toEqual([]);
      expect(listRecoveryRounds(store, ticketId)[0]!.status).toBe('fixing');
    });
  });
});

describe('recovery rounds — episode scoping (T1B, root-cause fix)', () => {
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
      maxRounds: 2,
      startedAt: T0,
      ...over,
    });
  }

  function setStatus(id: number, status: string, endedAt: string | null = T1): void {
    store.db
      .prepare('UPDATE recovery_rounds SET status = ?, ended_at = ? WHERE id = ?')
      .run(status, endedAt, id);
  }

  it('numbers rounds within an episode, not across the ticket lifetime', () => {
    const a = round();
    setStatus(a.id, 'failed');
    const b = round({ startedAt: T1 });
    // Both rounds are in episode 1: failed does not end the episode.
    expect(a.round).toBe(1);
    expect(b.round).toBe(2);
    expect(listRecoveryRounds(store, ticketId).map((r) => r.episode)).toEqual([1, 1]);
  });

  it('a passed round opens the next failure in a fresh episode at round 1', () => {
    const a = round();
    setStatus(a.id, 'passed');
    const b = round({ startedAt: T1 });
    expect(b.round).toBe(1);
    expect(b.episode).toBe(2);
  });

  it('a reset round opens the next failure in a fresh episode', () => {
    const a = round();
    setStatus(a.id, 'reset');
    const b = round({ startedAt: T1 });
    expect(b.round).toBe(1);
    expect(b.episode).toBe(2);
  });

  it('a failed/exhausted/interrupted round does NOT end the episode', () => {
    for (const status of ['failed', 'exhausted', 'interrupted'] as const) {
      const fresh = createTicketFlow(store, { key: `T-${status}`, title: status }).id;
      transition(store, fresh, 'scope', { kind: 'passed' });
      transition(store, fresh, 'impl', { kind: 'passed' });
      const a = openRecoveryRound(store, {
        ticketId: fresh, sourceStage: 'uat', sourceProcessId: 'gates',
        sourceStageRunId: null, sourceProcessRunId: null, triggerKind: 'gate-failure',
        triggerDetail: 'exit 1', maxRounds: 2, startedAt: T0,
      });
      setStatus(a.id, status);
      const b = openRecoveryRound(store, {
        ticketId: fresh, sourceStage: 'uat', sourceProcessId: 'gates',
        sourceStageRunId: null, sourceProcessRunId: null, triggerKind: 'gate-failure',
        triggerDetail: 'exit 2', maxRounds: 2, startedAt: T1,
      });
      expect(b.episode).toBe(1);
      expect(b.round).toBe(2);
    }
  });

  it('raising maxFixAttempts after an episode ends applies to the new episode', () => {
    const a = round({ maxRounds: 1 });
    // The episode's budget was 1: the round is instantly exhausted by the driver
    // in production, but here we exercise the store fact directly.
    setStatus(a.id, 'exhausted');
    // The episode does NOT end on exhausted — raising the budget is applied to
    // the SAME episode's next round.
    const b = round({ startedAt: T1, maxRounds: 3 });
    expect(b.episode).toBe(1);
    expect(b.round).toBe(2);
    expect(b.maxRounds).toBe(3);

    // Now genuinely end the episode via a pass, and confirm the raised budget
    // rides the new episode's first round too.
    setStatus(b.id, 'passed');
    const c = round({ startedAt: T2, maxRounds: 5 });
    expect(c.episode).toBe(2);
    expect(c.round).toBe(1);
    expect(c.maxRounds).toBe(5);
  });

  it('excludes a reset round from the active series', () => {
    const a = round();
    setStatus(a.id, 'reset');
    expect(activeRecoverySeries(store, ticketId, 'uat')).toBeNull();
    expect(recoveryDecision(store, ticketId, 'uat')).toBeNull();
  });

  it('excludes a refused round from the active series', () => {
    const a = round();
    setStatus(a.id, 'refused');
    expect(activeRecoverySeries(store, ticketId, 'uat')).toBeNull();
  });

  it('a Review round left revalidating while a new UAT failure opens numbers both correctly', () => {
    // Review-origin round stays `revalidating` through an intervening UAT pass
    // (two-phase revalidation) — an interleaved UAT failure must open its own
    // episode/round numbering for 'uat' without violating the unique index on
    // (ticket_id, source_stage, episode, round).
    const reviewRound = round({ sourceStage: 'review', triggerDetail: 'review findings' });
    setStatus(reviewRound.id, 'revalidating', null);

    const uatStageRunId = openStageRun(store, {
      ticketId, stageKey: 'uat', attempt: 0, runAt: T0, startedAt: T0,
    });
    attachRevalidationStageRun(store, ticketId, 'uat', uatStageRunId);

    // UAT passes (handled elsewhere) — then a LATER, unrelated UAT failure opens
    // a fresh uat-series round while the review round is still revalidating.
    const uatFailure = openRecoveryRound(store, {
      ticketId, sourceStage: 'uat', sourceProcessId: 'gates',
      sourceStageRunId: null, sourceProcessRunId: null, triggerKind: 'gate-failure',
      triggerDetail: 'new uat failure', maxRounds: 2, startedAt: T1,
    });

    expect(uatFailure.sourceStage).toBe('uat');
    expect(uatFailure.round).toBe(1);
    expect(uatFailure.episode).toBe(1);
    // The review round is untouched — it revalidates on review, not uat.
    const reviewAfter = listRecoveryRounds(store, ticketId).find((r) => r.sourceStage === 'review')!;
    expect(reviewAfter.status).toBe('revalidating');
    expect(reviewAfter.round).toBe(1);
    expect(reviewAfter.episode).toBe(1);
  });

  it('end-to-end: an exhausted budget followed by a pass opens a fresh episode that actually spawns a fix', () => {
    // The exact dead-end scenario: budget 1, first failure exhausts immediately,
    // but a later PASS must let the next failure open episode 2 at round 1 —
    // resumable, not instantly exhausted. The manifest is raised to 3 for the
    // new episode (the same way a user would raise review.maxFixAttempts after
    // seeing the exhaustion), so round 1 < 3 is resumable.
    const a = round({ maxRounds: 1 });
    expect(roundFixDecisionForTest(a)).toBe('exhausted');
    setStatus(a.id, 'exhausted');

    // A human or later process marks it passed (e.g. after manual resolution) —
    // simulate the pass directly for this store-level regression.
    setStatus(a.id, 'passed');

    const b = round({ startedAt: T1, maxRounds: 3 });
    expect(b.episode).toBe(2);
    expect(b.round).toBe(1);
    expect(roundFixDecisionForTest(b)).toBe('resume');
  });

  function roundFixDecisionForTest(r: RecoveryRound): 'resume' | 'exhausted' {
    return r.round < r.maxRounds ? 'resume' : 'exhausted';
  }
});
