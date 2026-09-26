import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type NestableStore, type Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../../workflow/machine.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { openGateRun } from '../../workflow/gates/evidence.js';
import { commitGateOutcome } from '../../workflow/gates/commit.js';
import { completeFixExecution } from '../../store/recoveryRounds.js';
import { openStageRun } from '../../store/stageRuns.js';
import { buildDashboardState } from '../../ui/dashboard/state.js';

/**
 * E2E: the Inside gate-stage ledger through a full round-2 cycle, driven
 * through the real workflow entry points rather than hand-built rows.
 *
 * This is the backstop for the fix landed across Tasks 1-5
 * (`currentAttemptFor`, `gates.ts`, `rounds.ts`, `state.ts`): every prior test
 * pins one seam. This file drives create -> uat -> fail -> fix -> re-enter
 * uat -> pass and asserts on `buildDashboardState`'s output at each step —
 * the same shape a user sees in the panel — so a regression in any single
 * seam shows up here even if its own unit test is weakened or removed.
 */

// Real wall-clock timestamps, not fixed literals: `transition`/`entryPatch`
// stamp stage entry with the real `nowIso()`, so a fixed-in-the-past literal
// here would read as EARLIER than the stage's own entry stamp and trip
// `currentAttemptFor`'s re-entry check for round 1 too — a false positive
// this file exists to rule out, not produce.
const now = () => new Date().toISOString();

describe('E2E: round-2 Inside ledger stays live, never stale', () => {
  let store: NestableStore;
  let id: number;
  let artifactDir: string;

  function failUat(runAt: string): number {
    const evidence = openGateRun(store, { ticketId: id, stageKey: 'uat', runAt });
    commitGateOutcome(store, {
      ticketId: id,
      stageKey: 'uat',
      runAt,
      artifactPath: join(artifactDir, 'u1.log'),
      gates: [
        {
          gateName: 'test (web)',
          exitCode: 1,
          startedAt: runAt,
          endedAt: runAt,
          repo: '/wt/web',
        },
      ],
      outcome: { kind: 'verdict', verdict: { kind: 'failed', reason: 'gates failed: test (web)' } },
      stageRunId: evidence.runId,
      recoveryTrigger: {
        sourceProcessId: 'gates',
        sourceStageRunId: evidence.runId,
        sourceProcessRunId: null,
        triggerKind: 'gate-failure',
        triggerDetail: 'gates failed: test (web)',
        maxRounds: 3,
      },
      now,
    });
    return evidence.runId;
  }

  function passUat(runAt: string): number {
    const evidence = openGateRun(store, { ticketId: id, stageKey: 'uat', runAt });
    commitGateOutcome(store, {
      ticketId: id,
      stageKey: 'uat',
      runAt,
      artifactPath: join(artifactDir, 'u2.log'),
      gates: [
        {
          gateName: 'test (web)',
          exitCode: 0,
          startedAt: runAt,
          endedAt: runAt,
          repo: '/wt/web',
        },
      ],
      outcome: { kind: 'verdict', verdict: { kind: 'passed' } },
      stageRunId: evidence.runId,
      now,
    });
    return evidence.runId;
  }

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'RT-1', title: 'round two' }).id;
    // Drive to uat, without driving through it.
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-round2-e2e-'));
  });

  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('round 2 renders live, not round 1s stale failure', async () => {
    // Step 2: round 1 fails uat and opens a recovery round -> fix.
    failUat(now());
    expect(getTicket(store, id).stageCurrent).toBe('fix');

    // Step 3: round 1's dashboard state shows the failed batch.
    const round1 = buildDashboardState(store, id);
    const round1Gates = round1.insideViews.uat.processes.find((p) => p.id === 'gates')!;
    expect(round1Gates.evidence).toMatchObject({ kind: 'gates', failed: 1 });
    expect(round1Gates.status).toBe('fail');

    // Step 4: the fix lands and the ticket drives back to uat.
    completeFixExecution(store, id, now());
    transition(store, id, 'fix', { kind: 'passed' });
    expect(getTicket(store, id).stageCurrent).toBe('uat');

    // Sequencing note: `stage_runs` is written at stage ENTRY, before the
    // first gate. `transition`'s `entryPatch` for uat does not itself open a
    // `stage_runs` row (only `openGateRun` does, at the first gate), so round
    // 2's invocation is opened explicitly here with zero gate rows recorded —
    // this is exactly production's window between re-entry and the first gate
    // completing, and it is what gives `currentAttemptFor` a real key to name
    // (a `null` current-attempt, from no stage run at all, legitimately
    // renders no synthetic tab at all, by Task 3's own contract).
    const cell = getTicket(store, id).stages.find((s) => s.stageKey === 'uat')!;
    const alreadyOpened = store.db
      .prepare(
        `SELECT id FROM stage_runs WHERE ticket_id = ? AND stage_key = 'uat' AND started_at = ?`,
      )
      .get(id, cell.startedAt);
    if (!alreadyOpened) {
      openStageRun(store, {
        ticketId: id,
        stageKey: 'uat',
        attempt: 2,
        runAt: cell.startedAt!,
        startedAt: cell.startedAt!,
      });
    }

    // Step 5: the regression this file exists to pin — before any round-2
    // gate row exists, the ledger must read as LIVE, not as round 1's stale
    // failure.
    const round2Pending = buildDashboardState(store, id);
    const uatPending = round2Pending.insideViews.uat;
    const pendingGates = uatPending.processes.find((p) => p.id === 'gates')!;
    expect(pendingGates.evidence).toMatchObject({ kind: 'gates', rows: [], failed: 0 });
    expect(pendingGates.status).toBe('run');
    expect(uatPending.attempts?.map((a) => ({ label: a.label, latest: a.latest }))).toEqual([
      { label: 'attempt 1 · R1', latest: false },
      { label: 'live', latest: true },
    ]);

    // Step 6: round 2 records a passing batch — the ledger reads passed.
    passUat(now());
    const round2Done = buildDashboardState(store, id);
    const doneGates = round2Done.insideViews.uat.processes.find((p) => p.id === 'gates')!;
    expect(doneGates.evidence).toMatchObject({ passed: 1, failed: 0 });
  });
});
