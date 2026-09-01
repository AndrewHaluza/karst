import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { createTicketFlow } from './stages/create.js';
import { openGateRun } from './gates/evidence.js';
import { commitGateOutcome } from './gates/commit.js';
import {
  listRecoveryRounds,
  interruptFixExecution,
} from '../store/recoveryRounds.js';
import { driveTicket, type DriveTicketDeps } from './driveTicket.js';

const now = () => '2026-08-01T10:00:00.000Z';
const T1 = '2026-08-01T11:00:00.000Z';

describe('REPRO: an interrupted fix round within budget is reopened and resumed', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;
  let resumed: any[];
  let debugLines: string[];

  function failReview(runAt: string): number {
    const evidence = openGateRun(store, { ticketId: id, stageKey: 'review', runAt });
    commitGateOutcome(store, {
      ticketId: id,
      stageKey: 'review',
      runAt,
      artifactPath: join(artifactDir, 'r.log'),
      gates: [],
      outcome: { kind: 'verdict', verdict: { kind: 'failed', reason: 'gates failed: lint (frontend)' } },
      stageRunId: evidence.runId,
      recoveryTrigger: {
        sourceProcessId: 'gates',
        sourceStageRunId: evidence.runId,
        sourceProcessRunId: null,
        triggerKind: 'gate-failure',
        triggerDetail: 'gates failed: lint (frontend)',
        maxRounds: 3,
      },
      now,
    });
    return evidence.runId;
  }

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    transition(store, id, 'uat', { kind: 'passed' }); // -> review
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-repro-round1-'));
    resumed = [];
    debugLines = [];
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  function deps(over: Partial<DriveTicketDeps> = {}): DriveTicketDeps {
    return {
      store,
      manifest: () => undefined,
      artifactDirFor: () => artifactDir,
      worktreeFor: () => '/wt',
      onProgress: () => {},
      shouldContinue: () => true,
      resumeFix: (ticketId, gate, attempts, roundId, process) =>
        resumed.push({ ticketId, gate, attempts, roundId, process }),
      log: () => {},
      debug: (m) => debugLines.push(m),
      ...over,
    };
  }

  it('reopens and resumes a review round 1 that crashed without the marker', async () => {
    // Review fails -> fix, a pending round 1 committed atomically.
    failReview(now());
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    const r1 = listRecoveryRounds(store, id)[0]!;
    expect(r1.status).toBe('pending');
    expect(r1.round).toBe(1);

    // The fix session crashed: a live execution attached (`fixing`) and then
    // died without the marker — `interruptFixExecution` marks the round
    // interrupted, consuming no additional round.
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(r1.id);
    expect(interruptFixExecution(store, r1.id, T1)).toBe(true);
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({
      status: 'interrupted',
      endedAt: T1,
    });

    // Drive: the interrupted round within budget is reopened and resumed.
    const outcome = await driveTicket(deps(), id);

    expect(outcome.stage).toBe('fix');
    expect(resumed).toEqual([
      { ticketId: id, gate: 'review', attempts: 1, roundId: r1.id, process: null },
    ]);
    expect(listRecoveryRounds(store, id)[0]!.status).toBe('pending');
    // The debug line names the PER-TICKET round number (1), never the global
    // recovery_rounds.id row — a row id that climbs across the whole registry
    // would read as "79 rounds in this ticket".
    const resume = debugLines.find((l) => l.includes('resuming round'));
    expect(resume).toContain('resuming round 1');
    expect(resume).toContain(`round id ${r1.id}`);
    expect(resume).toContain('attempt 2 of 3');
    const reopen = debugLines.find((l) => l.includes('reopened interrupted'));
    expect(reopen).toContain('reopened interrupted recovery round 1');
    expect(reopen).toContain(`round id ${r1.id}`);
  });
});
