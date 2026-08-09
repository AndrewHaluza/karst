import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from './db.js';
import { createTicket, setSessionId } from './tickets.js';
import {
  recordSessionLaunchIntent,
  confirmSessionLaunchIntent,
} from './sessionLaunchIntents.js';
import {
  completeImplementationRun,
  interruptImplementationRun,
} from './implementationRuns.js';
import { listProcessRuns } from './processRuns.js';
import {
  openRecoveryRound,
  recordFixLaunchIntent,
  confirmFixLaunch,
  beginLiveFixExecution,
  interruptFixExecution,
  listRecoveryRounds,
} from './recoveryRounds.js';
import { listTokenUsage, queryTokenUsageStats } from './tokenUsage.js';
import { parseUsageQuery } from './tokenUsageQuery.js';
import {
  appendInteractiveUsageSample,
  lastInteractiveUsageSample,
  type InteractiveUsageSampleRow,
} from './interactiveUsageSamples.js';
import type { InteractiveUsageSample } from '../agent/interactiveUsage.js';

/**
 * The measured interactive token-delta ledger (Task 5).
 *
 * A provider session is the baseline scope: every sample is CUMULATIVE for one
 * (provider, provider_session_id), and the delta row is the increment since the
 * last persisted observation of that session — regardless of which Karst
 * process or segment currently owns it. Process linkage (the token_usage row)
 * answers where the increment occurred; the sample table alone can answer "how
 * much has this provider session burned" without any process bookkeeping.
 */

let store: Store;
let ticketId: number;

const PROVIDER = 'codex';
const SESSION = 'sess-1';
const T0 = '2026-08-01T10:00:00.000Z';

beforeEach(() => {
  store = openStore(':memory:');
  store.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
  const t = createTicket(store, { key: 'T-1', title: 'one' });
  ticketId = t.id;
  store.db.prepare('UPDATE tickets SET project_id = 1 WHERE id = ?').run(t.id);
});
afterEach(() => store.close());

function sample(overrides: Partial<InteractiveUsageSample>): InteractiveUsageSample {
  return {
    eventId: 'evt',
    provider: PROVIDER,
    providerSessionId: SESSION,
    input: 100,
    output: 10,
    observedAt: T0,
    ...overrides,
  };
}

function launch(
  launchId: string,
  purpose: 'implementation' | 'fix',
  sessionOrigin: 'new' | 'resume' | 'unknown' = 'new',
  reason: 'initial' | 'resume' | 'switch' = 'initial',
  model: string | null = 'sol',
): void {
  recordSessionLaunchIntent(store, {
    ticketId,
    launchId,
    purpose,
    provider: PROVIDER,
    model,
    reason,
    sessionOrigin,
    at: T0,
  });
}

function confirm(launchId: string, providerSessionId: string, at = T0): void {
  expect(
    confirmSessionLaunchIntent(store, launchId, {
      ticketId,
      provider: PROVIDER,
      providerSessionId,
      at,
    }),
  ).toBe('confirmed');
}

/** The token_usage rows attributed to the ticket, oldest first. */
function ledger(): ReturnType<typeof listTokenUsage> {
  return listTokenUsage(store, { ticketId });
}

describe('appendInteractiveUsageSample — first observation', () => {
  it('records the FULL counts from a proven-new session (implicit zero) with the session process binding', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    const processRunId = lastSampleIntentProcessRun();

    const result = appendInteractiveUsageSample(
      store,
      {
        ticketId,
        sample: sample({ eventId: 'evt-1', input: 1_450, output: 320, cacheRead: 180, cacheWrite: 40, total: 1_990 }),
      },
    );
    expect(result).toMatchObject({ kind: 'recorded' });
    expect(result.kind === 'recorded' && result.delta).toEqual({
      input: 1_450, output: 320, cacheRead: 180, cacheWrite: 40, total: 1_990,
    });

    const rows = store.db
      .prepare('SELECT * FROM interactive_usage_samples')
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      process_run_id: processRunId,
      source_event_id: 'evt-1',
      provider: PROVIDER,
      provider_session_id: SESSION,
      input_tokens: 1_450,
      output_tokens: 320,
      cache_read_tokens: 180,
      cache_write_tokens: 40,
      total_tokens: 1_990,
      counter_epoch: 0,
      baseline_only: 0,
      observed_at: T0,
    });
    expect(rows[0]!.implementation_segment_id).not.toBeNull();

    const entries = ledger();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      processRunId,
      callSite: 'implementation',
      provider: PROVIDER,
      model: 'sol',
      inputTokens: 1_450,
      outputTokens: 320,
      cacheReadTokens: 180,
      cacheWriteTokens: 40,
      totalTokens: 1_990,
      estimated: false,
      outcome: 'ok',
    });
    expect(entries[0]!.implementationSegmentId).not.toBeNull();
  });

  function lastSampleIntentProcessRun(): number {
    const intent = store.db
      .prepare(
        `SELECT process_run_id FROM session_launch_intents
          WHERE ticket_id = ? AND provider = ? AND provider_session_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(ticketId, PROVIDER, SESSION) as { process_run_id: number };
    return intent.process_run_id;
  }

  it('baselines a resumed session with no prior sample — no ledger row, and the next sample subtracts it', () => {
    launch('l1', 'implementation', 'resume', 'resume');
    confirm('l1', SESSION);

    const first = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'evt-1', input: 5_000, output: 400 }) },
    );
    expect(first).toEqual({ kind: 'baseline', sampleId: expect.any(Number) });
    expect(ledger()).toHaveLength(0);
    const baseline = store.db
      .prepare('SELECT baseline_only, counter_epoch FROM interactive_usage_samples')
      .get() as { baseline_only: number; counter_epoch: number };
    expect(baseline).toEqual({ baseline_only: 1, counter_epoch: 0 });

    // The next observation subtracts that baseline and becomes billable.
    const second = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'evt-2', input: 5_500, output: 460 }) },
    );
    expect(second.kind).toBe('recorded');
    expect(second.kind === 'recorded' && second.delta).toEqual({
      input: 500, output: 60, cacheRead: 0, cacheWrite: 0, total: 560,
    });
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({ inputTokens: 500, outputTokens: 60, totalTokens: 560 });
  });

  it('drops a sample with no confirmed binding (wrong provider, foreign session, or pending launch)', () => {
    // No intent at all.
    expect(
      appendInteractiveUsageSample(store, { ticketId, sample: sample({ eventId: 'x' }) }),
    ).toEqual({ kind: 'unattributed' });
    // A pending (never confirmed) intent is not a binding.
    launch('l1', 'implementation');
    expect(
      appendInteractiveUsageSample(store, { ticketId, sample: sample({ eventId: 'x' }) }),
    ).toEqual({ kind: 'unattributed' });
    // A confirmed intent for a DIFFERENT provider session does not bind this one.
    confirm('l1', 'other-session');
    expect(
      appendInteractiveUsageSample(store, { ticketId, sample: sample({ eventId: 'x' }) }),
    ).toEqual({ kind: 'unattributed' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 0,
    });
    expect(ledger()).toHaveLength(0);
  });

  it('does not bind a confirmed Implementation launch after its process is no longer running', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    const processRunId = lastSampleIntentProcessRun();

    store.db.prepare("UPDATE process_runs SET status = 'stale' WHERE id = ?").run(processRunId);

    expect(
      appendInteractiveUsageSample(store, { ticketId, sample: sample({ eventId: 'late-implementation' }) }),
    ).toEqual({ kind: 'unattributed' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({ n: 0 });
    expect(ledger()).toEqual([]);
  });

  it('does not bind a malformed Implementation intent to a process moved to another ticket', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    const processRunId = lastSampleIntentProcessRun();
    const otherTicket = createTicket(store, { key: 'T-2', title: 'other' });

    // Historical corruption must not let the intent's ticket claim a process
    // that belongs to a different ticket when the UsageUpdate arrives late.
    store.db.prepare('UPDATE process_runs SET ticket_id = ? WHERE id = ?').run(otherTicket.id, processRunId);

    expect(
      appendInteractiveUsageSample(store, { ticketId, sample: sample({ eventId: 'malformed-implementation' }) }),
    ).toEqual({ kind: 'unattributed' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({ n: 0 });
  });

  it('rejects an already-recorded event id idempotently — one row, one ledger entry', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    const first = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'evt-1', input: 10, output: 2 }) },
    );
    expect(first.kind).toBe('recorded');

    const again = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'evt-1', input: 99, output: 99 }) },
    );
    expect(again).toEqual({ kind: 'duplicate' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 1,
    });
    expect(ledger()).toHaveLength(1);
  });
});

describe('appendInteractiveUsageSample — cumulative deltas', () => {
  it('subtracts the provider session’s last persisted sample, across processes and segments', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    const p1 = store.db
      .prepare('SELECT process_run_id FROM session_launch_intents WHERE launch_id = ?')
      .get('l1') as { process_run_id: number };
    const segmentA = store.db
      .prepare('SELECT id FROM implementation_segments WHERE launch_intent_id = (SELECT id FROM session_launch_intents WHERE launch_id = ?)')
      .get('l1') as { id: number };

    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200, cacheRead: 100, cacheWrite: 20, total: 1_320 }) },
    );
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 1_450, output: 320, cacheRead: 180, cacheWrite: 40, total: 1_990 }) },
    );

    // Close the segment/process, resume the SAME provider session into a later
    // segment: a switch closes segment A and opens segment B on the same id.
    launch('l2', 'implementation', 'new', 'switch');
    confirm('l2', SESSION, '2026-08-01T11:00:00.000Z');
    const segmentB = store.db
      .prepare('SELECT id FROM implementation_segments WHERE launch_intent_id = (SELECT id FROM session_launch_intents WHERE launch_id = ?)')
      .get('l2') as { id: number };
    expect(segmentB.id).not.toBe(segmentA.id);
    const closedA = store.db
      .prepare('SELECT status FROM implementation_segments WHERE id = ?')
      .get(segmentA.id) as { status: string };
    expect(closedA.status).toBe('closed');

    const afterSwitch = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e3', input: 1_800, output: 380, cacheRead: 200, cacheWrite: 50, total: 2_430, observedAt: '2026-08-01T11:05:00.000Z' }) },
    );
    expect(afterSwitch.kind).toBe('recorded');
    expect(afterSwitch.kind === 'recorded' && afterSwitch.delta).toEqual({
      input: 350, output: 60, cacheRead: 20, cacheWrite: 10, total: 440,
    });

    const entries = ledger();
    expect(entries).toHaveLength(3);
    // The new increment belongs to the new owner — the later segment, same process run.
    expect(entries[2]).toMatchObject({
      processRunId: p1.process_run_id,
      implementationSegmentId: segmentB.id,
      callSite: 'implementation',
      inputTokens: 350,
      outputTokens: 60,
      totalTokens: 440,
    });

    // The provider-session linkage is the baseline scope: the last sample of
    // the session is the switch's successor, whatever process recorded it.
    const last = lastInteractiveUsageSample(store, PROVIDER, SESSION)!;
    expect(last.sourceEventId).toBe('e3');
    expect(last.inputTokens).toBe(1_800);
    expect(last.counterEpoch).toBe(0);
  });

  it('attributes a cross-provider switch to the new running segment while preserving the canonical process run', () => {
    launch('l-codex', 'implementation');
    confirm('l-codex', 'codex-session');
    const canonical = store.db
      .prepare('SELECT process_run_id FROM session_launch_intents WHERE launch_id = ?')
      .get('l-codex') as { process_run_id: number };
    appendInteractiveUsageSample(store, {
      ticketId,
      sample: sample({
        provider: 'codex',
        providerSessionId: 'codex-session',
        eventId: 'codex-1',
        input: 1_000,
        output: 200,
      }),
    });

    recordSessionLaunchIntent(store, {
      ticketId,
      launchId: 'l-claude',
      purpose: 'implementation',
      provider: 'claude',
      model: 'claude-sonnet-5',
      reason: 'switch',
      sessionOrigin: 'new',
      at: '2026-08-01T11:00:00.000Z',
    });
    expect(
      confirmSessionLaunchIntent(store, 'l-claude', {
        ticketId,
        provider: 'claude',
        providerSessionId: 'claude-session',
        at: '2026-08-01T11:00:01.000Z',
      }),
    ).toBe('confirmed');

    const result = appendInteractiveUsageSample(store, {
      ticketId,
      sample: sample({
        provider: 'claude',
        providerSessionId: 'claude-session',
        eventId: 'claude-1',
        input: 300,
        output: 40,
        observedAt: '2026-08-01T11:05:00.000Z',
      }),
    });

    expect(result.kind).toBe('recorded');
    const entry = ledger()[1]!;
    expect(entry).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5',
      processRunId: canonical.process_run_id,
      callSite: 'implementation',
      inputTokens: 300,
      outputTokens: 40,
    });
    const switched = lastInteractiveUsageSample(store, 'claude', 'claude-session')!;
    expect(switched.implementationSegmentId).not.toBeNull();
  });

  it('attributes a cross-provider Fix sample to the Fix process model and groups it by that model', () => {
    launch('l-impl', 'implementation');
    confirm('l-impl', 'codex-session');
    completeImplementationRun(store, ticketId, '2026-08-01T12:00:00.000Z');

    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'review',
      sourceProcessId: 'review',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'blocking-review-findings',
      triggerDetail: '1 blocking finding',
      maxRounds: 3,
      startedAt: '2026-08-01T12:00:30.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'l-fix-claude',
      provider: 'claude',
      model: 'claude-sonnet-5',
      reason: 'initial',
      sessionOrigin: 'new',
      recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });
    expect(confirmFixLaunch(store, 'l-fix-claude', {
      ticketId,
      provider: 'claude',
      providerSessionId: 'claude-session',
      at: '2026-08-01T12:01:01.000Z',
    })).toBe('confirmed');

    expect(appendInteractiveUsageSample(store, {
      ticketId,
      sample: sample({
        provider: 'claude',
        providerSessionId: 'claude-session',
        eventId: 'fix-claude-1',
        input: 300,
        output: 40,
      }),
    }).kind).toBe('recorded');

    expect(ledger().at(-1)).toMatchObject({
      callSite: 'fix-resume',
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    const parsed = parseUsageQuery({ projectId: 1, ticketId });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(queryTokenUsageStats(store, parsed.query).byModel.map((row) => row.key)).toContain(
      'claude-sonnet-5',
    );
  });

  it('preserves an intentionally unnamed default model as NULL and the empty aggregate key', () => {
    launch('l-default', 'implementation', 'new', 'initial', null);
    confirm('l-default', SESSION);

    expect(appendInteractiveUsageSample(store, {
      ticketId,
      sample: sample({ eventId: 'default-1', input: 80, output: 20 }),
    }).kind).toBe('recorded');
    expect(ledger()[0]).toMatchObject({ provider: PROVIDER, model: null, totalTokens: 100 });

    const parsed = parseUsageQuery({ projectId: 1, ticketId });
    if (!parsed.ok) throw new Error(parsed.error);
    expect(queryTokenUsageStats(store, parsed.query).byModel).toMatchObject([
      { key: '', totalTokens: 100, calls: 1 },
    ]);
  });

  it('rejects a late sample from provider A after provider B closed A’s segment', () => {
    launch('l-codex', 'implementation');
    confirm('l-codex', 'codex-session');
    recordSessionLaunchIntent(store, {
      ticketId,
      launchId: 'l-claude',
      purpose: 'implementation',
      provider: 'claude',
      model: 'claude-sonnet-5',
      reason: 'switch',
      sessionOrigin: 'new',
      at: '2026-08-01T11:00:00.000Z',
    });
    expect(
      confirmSessionLaunchIntent(store, 'l-claude', {
        ticketId,
        provider: 'claude',
        providerSessionId: 'claude-session',
        at: '2026-08-01T11:00:01.000Z',
      }),
    ).toBe('confirmed');

    expect(
      appendInteractiveUsageSample(store, {
        ticketId,
        sample: sample({
          provider: 'codex',
          providerSessionId: 'codex-session',
          eventId: 'late-codex',
          input: 1_500,
          output: 250,
        }),
      }),
    ).toEqual({ kind: 'unattributed' });
    expect(ledger()).toEqual([]);
  });

  it('rejects usage when the canonical implementation run is closed even if its process row still says running', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    store.db
      .prepare("UPDATE implementation_runs SET status = 'passed', ended_at = ? WHERE ticket_id = ?")
      .run('2026-08-01T12:00:00.000Z', ticketId);

    expect(
      appendInteractiveUsageSample(store, {
        ticketId,
        sample: sample({ eventId: 'closed-run', input: 1_000, output: 200 }),
      }),
    ).toEqual({ kind: 'unattributed' });
    expect(ledger()).toEqual([]);
  });

  it('attributes later samples to a Fix process with call_site fix-resume, subtracting the implementation session’s last counts', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200 }) },
    );
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 1_450, output: 320 }) },
    );

    // The implementation completes: run passed, segment closed, process run ended.
    completeImplementationRun(store, ticketId, '2026-08-01T12:00:00.000Z');
    expect(listProcessRuns(store, ticketId)[0]!.status).toBe('passed');

    // A recovery round is committed by the failing verdict; the Fix relaunch
    // owns it (recordFixLaunchIntent) and its accepted SessionStart opens the
    // Fix process run and attaches it to the round (confirmFixLaunch).
    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: '2026-08-01T12:00:30.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId,
      launchId: 'l-fix',
      provider: PROVIDER,
      model: 'sol',
      reason: 'resume',
      sessionOrigin: 'resume',
      recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });
    expect(confirmFixLaunch(store, 'l-fix', {
      ticketId, provider: PROVIDER, providerSessionId: SESSION,
      at: '2026-08-01T12:02:00.000Z',
    })).toBe('confirmed');
    const fixRun = listProcessRuns(store, ticketId).find((r) => r.processId === 'fix')!;
    expect(fixRun.status).toBe('running');
    expect(listRecoveryRounds(store, ticketId)[0]).toMatchObject({
      status: 'fixing',
      fixProcessRunId: fixRun.id,
    });

    const fixSample = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e3', input: 1_700, output: 340, observedAt: '2026-08-01T12:05:00.000Z' }) },
    );
    expect(fixSample.kind).toBe('recorded');
    expect(fixSample.kind === 'recorded' && fixSample.delta).toEqual({
      input: 250, output: 20, cacheRead: 0, cacheWrite: 0, total: 270,
    });

    const fixEntry = ledger()[2]!;
    expect(fixEntry).toMatchObject({
      processRunId: fixRun.id,
      implementationSegmentId: null,
      callSite: 'fix-resume',
      inputTokens: 250,
      outputTokens: 20,
      totalTokens: 270,
    });

    // The provider session's own last sample is the fix observation — the
    // implementation row remains untouched evidence.
    const last = lastInteractiveUsageSample(store, PROVIDER, SESSION)!;
    expect(last.sourceEventId).toBe('e3');
    expect(last.processRunId).toBe(fixRun.id);
    expect(last.counterEpoch).toBe(0);
  });

  it('drops usage once the Fix execution is no longer active — a completed or interrupted fix owns nothing', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    completeImplementationRun(store, ticketId, '2026-08-01T12:00:00.000Z');
    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: '2026-08-01T12:00:30.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'l-fix', provider: PROVIDER, model: 'sol',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });
    confirmFixLaunch(store, 'l-fix', {
      ticketId, provider: PROVIDER, providerSessionId: SESSION,
      at: '2026-08-01T12:02:00.000Z',
    });
    interruptFixExecution(store, round.id, '2026-08-01T12:03:00.000Z');

    const result = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200, observedAt: '2026-08-01T12:04:00.000Z' }) },
    );
    expect(result).toEqual({ kind: 'unattributed' });
    expect(ledger()).toHaveLength(0);
  });
});

describe('appendInteractiveUsageSample — live Fix ownership', () => {
  /**
   * Findings 5/14: a LIVE fix nudge opens a Fix process run and attaches it to
   * its round but records NO session launch intent — the nudge continues the
   * already-live session — so the old confirmed Implementation intent used to
   * win and the UsageUpdate stayed `implementation`. The Fix execution may own
   * a sample only when durable fields prove it belongs to THIS provider
   * session: the ticket's recorded live session (`session_id`/`session_provider`,
   * captured at SessionStart) is the session the nudge continued.
   */
  function liveFix(ticket: number = ticketId): number {
    const round = openRecoveryRound(store, {
      ticketId: ticket,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: '2026-08-01T12:00:30.000Z',
    });
    return beginLiveFixExecution(store, {
      ticketId: ticket,
      roundId: round.id,
      provider: PROVIDER,
      model: 'sol',
      startedAt: '2026-08-01T12:01:00.000Z',
    }).id;
  }

  it('attributes a live fix nudge’s UsageUpdate to the Fix process run — fix-resume, no implementation segment', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    // The dispatch captures the live session onto the ticket at SessionStart;
    // a live nudge never records a new launch intent, so this is the durable
    // proof that the Fix execution continues THIS provider session.
    setSessionId(store, ticketId, SESSION, PROVIDER);
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200 }) },
    );

    completeImplementationRun(store, ticketId, '2026-08-01T12:00:00.000Z');
    const fixRunId = liveFix();

    const fixSample = appendInteractiveUsageSample(
      store,
      {
        ticketId,
        sample: sample({ eventId: 'e2', input: 1_700, output: 340, observedAt: '2026-08-01T12:05:00.000Z' }),
      },
    );
    expect(fixSample.kind).toBe('recorded');
    expect(fixSample.kind === 'recorded' && fixSample.delta).toEqual({
      input: 700, output: 140, cacheRead: 0, cacheWrite: 0, total: 840,
    });

    const fixEntry = ledger()[1]!;
    expect(fixEntry).toMatchObject({
      processRunId: fixRunId,
      implementationSegmentId: null,
      callSite: 'fix-resume',
      inputTokens: 700,
      outputTokens: 140,
      totalTokens: 840,
    });
  });

  it('does not let a running Fix for ANOTHER ticket steal the implementation binding', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    setSessionId(store, ticketId, SESSION, PROVIDER);

    const other = createTicket(store, { key: 'T-2', title: 'two' });
    store.db.prepare('UPDATE tickets SET project_id = 1 WHERE id = ?').run(other.id);
    const otherFixRunId = liveFix(other.id);

    const result = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200 }) },
    );
    expect(result.kind).toBe('recorded');
    expect(ledger()[0]).toMatchObject({ callSite: 'implementation' });
    expect(ledger()[0]!.processRunId).not.toBe(otherFixRunId);
  });

  it('does not let a running Fix for ANOTHER provider steal the implementation binding', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    setSessionId(store, ticketId, SESSION, PROVIDER);

    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: '2026-08-01T12:00:30.000Z',
    });
    // The fix runs under a DIFFERENT provider than the one that minted the session.
    const fixRun = beginLiveFixExecution(store, {
      ticketId,
      roundId: round.id,
      provider: 'claude',
      model: 'opus',
      startedAt: '2026-08-01T12:01:00.000Z',
    });

    const result = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200 }) },
    );
    expect(result.kind).toBe('recorded');
    expect(ledger()[0]).toMatchObject({ callSite: 'implementation' });
    expect(ledger()[0]!.processRunId).not.toBe(fixRun.id);
  });

  it('does not let a Fix bind an unrelated provider session', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    setSessionId(store, ticketId, SESSION, PROVIDER);
    // The SAME ticket also holds a confirmed implementation intent for another session.
    launch('l2', 'implementation');
    confirm('l2', 'other-sess');
    const fixRunId = liveFix();

    const result = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ providerSessionId: 'other-sess', eventId: 'e1', input: 1_000, output: 200 }) },
    );
    expect(result.kind).toBe('recorded');
    expect(ledger()[0]).toMatchObject({ callSite: 'implementation' });
    expect(ledger()[0]!.processRunId).not.toBe(fixRunId);
  });

  it('rejects a duplicate live-Fix event idempotently — one sample, one ledger row', () => {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    setSessionId(store, ticketId, SESSION, PROVIDER);
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200 }) },
    );
    completeImplementationRun(store, ticketId, '2026-08-01T12:00:00.000Z');
    liveFix();

    const first = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 1_700, output: 340 }) },
    );
    expect(first.kind).toBe('recorded');
    const again = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 1_700, output: 340 }) },
    );
    expect(again).toEqual({ kind: 'duplicate' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 2,
    });
    expect(ledger()).toHaveLength(2);
  });
});

describe('appendInteractiveUsageSample — only a RUNNING Fix process owns usage', () => {
  /**
   * The round can read `fixing` while its process run is NOT running: the
   * activation sweep marks a dead host's run `stale` without touching the
   * round (nothing observed the session end), and the session-death path can
   * interrupt the run before the round follows. A binding must never answer
   * with a process that is not running — usage may reference only a currently
   * running process owned by the ticket/provider/provider-session.
   */
  function fixingRound(): number {
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200 }) },
    );
    completeImplementationRun(store, ticketId, '2026-08-01T12:00:00.000Z');
    const round = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: null,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'exit 1',
      maxRounds: 3,
      startedAt: '2026-08-01T12:00:30.000Z',
    });
    recordFixLaunchIntent(store, {
      ticketId, launchId: 'l-fix', provider: PROVIDER, model: 'sol',
      reason: 'resume', sessionOrigin: 'resume', recoveryRoundId: round.id,
      at: '2026-08-01T12:01:00.000Z',
    });
    expect(confirmFixLaunch(store, 'l-fix', {
      ticketId, provider: PROVIDER, providerSessionId: SESSION,
      at: '2026-08-01T12:02:00.000Z',
    })).toBe('confirmed');
    const fixRun = listProcessRuns(store, ticketId).find((r) => r.processId === 'fix')!;
    expect(fixRun.status).toBe('running');
    return fixRun.id;
  }

  it('drops usage when the activation sweep marked the Fix process STALE — the round still reads fixing', () => {
    const fixRunId = fixingRound();
    store.db.prepare("UPDATE process_runs SET status = 'stale' WHERE id = ?").run(fixRunId);

    const result = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 1_700, output: 340, observedAt: '2026-08-01T12:05:00.000Z' }) },
    );
    expect(result).toEqual({ kind: 'unattributed' });
    // No NEW sample and no new ledger row — the earlier implementation sample
    // remains untouched evidence.
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 1,
    });
    expect(ledger()).toHaveLength(1);
  });

  it('drops usage when the Fix process run is INTERRUPTED while the round still reads fixing', () => {
    const fixRunId = fixingRound();
    store.db
      .prepare("UPDATE process_runs SET status = 'interrupted', ended_at = ? WHERE id = ?")
      .run('2026-08-01T12:03:00.000Z', fixRunId);

    const result = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 1_700, output: 340, observedAt: '2026-08-01T12:04:00.000Z' }) },
    );
    expect(result).toEqual({ kind: 'unattributed' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM interactive_usage_samples').get()).toEqual({
      n: 1,
    });
    expect(ledger()).toHaveLength(1);
  });

  it('a RUNNING Fix process keeps the binding — the control that remains fix-resume', () => {
    const fixRunId = fixingRound();
    const result = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 1_700, output: 340, observedAt: '2026-08-01T12:05:00.000Z' }) },
    );
    expect(result.kind).toBe('recorded');
    expect(result.kind === 'recorded' && result.delta).toEqual({
      input: 700, output: 140, cacheRead: 0, cacheWrite: 0, total: 840,
    });
    const fixEntry = ledger()[1]!;
    expect(fixEntry).toMatchObject({
      processRunId: fixRunId,
      implementationSegmentId: null,
      callSite: 'fix-resume',
      inputTokens: 700,
      outputTokens: 140,
      totalTokens: 840,
    });
  });
});

describe('appendInteractiveUsageSample — counter resets', () => {
  it('opens a new provider-session epoch and counts the reset from zero when the binding proves continuous instrumentation', () => {
    launch('l1', 'implementation'); // origin 'new' — karst created the session
    confirm('l1', SESSION);
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 1_000, output: 200 }) },
    );

    const reset = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 300, output: 50 }) },
    );
    expect(reset.kind).toBe('recorded');
    expect(reset.kind === 'recorded' && reset.delta).toEqual({
      input: 300, output: 50, cacheRead: 0, cacheWrite: 0, total: 350,
    });
    const resetRow = store.db
      .prepare('SELECT counter_epoch, baseline_only FROM interactive_usage_samples WHERE source_event_id = ?')
      .get('e2') as { counter_epoch: number; baseline_only: number };
    expect(resetRow).toEqual({ counter_epoch: 1, baseline_only: 0 });
    expect(ledger()[1]).toMatchObject({ inputTokens: 300, outputTokens: 50, totalTokens: 350 });

    // Later samples subtract only the preceding sample in the same persisted epoch.
    const third = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e3', input: 350, output: 60 }) },
    );
    expect(third.kind === 'recorded' && third.delta).toEqual({
      input: 50, output: 10, cacheRead: 0, cacheWrite: 0, total: 60,
    });
  });

  it('baselines a decrease when continuity cannot be proved — a resumed session', () => {
    // A resumed session whose counters dropped below the prior karst observation
    // cannot be proven to be the same continuous instrumentation: karst did not
    // create it, so the decrease may be an unrelated session's counters.
    launch('l1', 'implementation', 'resume', 'resume');
    confirm('l1', SESSION);
    appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e1', input: 5_000, output: 400 }) },
    ); // baseline_only

    const reset = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e2', input: 400, output: 50 }) },
    );
    expect(reset).toEqual({ kind: 'baseline', sampleId: expect.any(Number) });
    expect(ledger()).toHaveLength(0);
    const row = store.db
      .prepare('SELECT counter_epoch, baseline_only FROM interactive_usage_samples WHERE source_event_id = ?')
      .get('e2') as { counter_epoch: number; baseline_only: number };
    expect(row).toEqual({ counter_epoch: 1, baseline_only: 1 });

    // The next observation subtracts the reset baseline in its epoch.
    const next = appendInteractiveUsageSample(
      store,
      { ticketId, sample: sample({ eventId: 'e3', input: 460, output: 60 }) },
    );
    expect(next.kind === 'recorded' && next.delta).toEqual({
      input: 60, output: 10, cacheRead: 0, cacheWrite: 0, total: 70,
    });
  });
});

describe('appendInteractiveUsageSample — durability', () => {
  it('persists the decision across a close/reopen: baselines and deltas survive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-interactive-usage-'));
    const path = join(dir, 'karst.db');
    try {
      const first = openStore(path);
      first.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
      const t = createTicket(first, { key: 'T-2', title: 'two' });
      first.db.prepare('UPDATE tickets SET project_id = 1 WHERE id = ?').run(t.id);
      recordSessionLaunchIntent(first, {
        ticketId: t.id, launchId: 'l1', purpose: 'implementation',
        provider: PROVIDER, model: 'sol', reason: 'initial', sessionOrigin: 'new',
        at: T0,
      });
      confirmSessionLaunchIntent(first, 'l1', {
        ticketId: t.id, provider: PROVIDER, providerSessionId: SESSION, at: T0,
      });
      const firstResult = appendInteractiveUsageSample(first, {
        ticketId: t.id,
        sample: sample({ eventId: 'e1', input: 1_000, output: 200 }),
      });
      expect(firstResult.kind).toBe('recorded');
      first.close();

      const reopened = openStore(path);
      const second = appendInteractiveUsageSample(reopened, {
        ticketId: t.id,
        sample: sample({ eventId: 'e2', input: 1_450, output: 320 }),
      });
      expect(second.kind).toBe('recorded');
      expect(second.kind === 'recorded' && second.delta).toEqual({
        input: 450, output: 120, cacheRead: 0, cacheWrite: 0, total: 570,
      });
      expect(listTokenUsage(reopened, { ticketId: t.id })[1]).toMatchObject({
        inputTokens: 450,
        outputTokens: 120,
        totalTokens: 570,
      });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a resumed session’s baseline across a reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-interactive-usage-'));
    const path = join(dir, 'karst.db');
    try {
      const first = openStore(path);
      first.db.prepare('INSERT INTO projects (id, slug) VALUES (?, ?)').run(1, 'karst');
      const t = createTicket(first, { key: 'T-3', title: 'three' });
      recordSessionLaunchIntent(first, {
        ticketId: t.id, launchId: 'l1', purpose: 'implementation',
        provider: PROVIDER, model: 'sol', reason: 'resume', sessionOrigin: 'resume',
        at: T0,
      });
      confirmSessionLaunchIntent(first, 'l1', {
        ticketId: t.id, provider: PROVIDER, providerSessionId: SESSION, at: T0,
      });
      expect(
        appendInteractiveUsageSample(first, {
          ticketId: t.id,
          sample: sample({ eventId: 'e1', input: 5_000, output: 400 }),
        }),
      ).toEqual({ kind: 'baseline', sampleId: expect.any(Number) });
      first.close();

      const reopened = openStore(path);
      const next = appendInteractiveUsageSample(reopened, {
        ticketId: t.id,
        sample: sample({ eventId: 'e2', input: 5_500, output: 460 }),
      });
      expect(next.kind === 'recorded' && next.delta).toEqual({
        input: 500, output: 60, cacheRead: 0, cacheWrite: 0, total: 560,
      });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lastInteractiveUsageSample', () => {
  it('returns the latest persisted observation of a provider session, or null', () => {
    expect(lastInteractiveUsageSample(store, PROVIDER, SESSION)).toBeNull();
    launch('l1', 'implementation');
    confirm('l1', SESSION);
    appendInteractiveUsageSample(store, { ticketId, sample: sample({ eventId: 'e1', input: 10, output: 2 }) });
    appendInteractiveUsageSample(store, { ticketId, sample: sample({ eventId: 'e2', input: 20, output: 3 }) });
    const last = lastInteractiveUsageSample(store, PROVIDER, SESSION)!;
    expect(last.sourceEventId).toBe('e2');
    expect(last.inputTokens).toBe(20);
    // A different provider or session id is a different baseline scope.
    expect(lastInteractiveUsageSample(store, 'claude', SESSION)).toBeNull();
    expect(lastInteractiveUsageSample(store, PROVIDER, 'other')).toBeNull();
  });
});

/** Structural check so the row shape is pinned where the plan names it. */
export type { InteractiveUsageSampleRow };
