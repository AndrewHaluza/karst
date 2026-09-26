import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type NestableStore, type Store } from '../store/db.js';
import { getTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { createTicketFlow } from './stages/create.js';
import { openGateRun } from './gates/evidence.js';
import { commitGateOutcome } from './gates/commit.js';
import {
  listRecoveryRounds,
  completeRevalidation,
  completeFixExecution,
} from '../store/recoveryRounds.js';
import { driveTicket, type DriveTicketDeps } from './driveTicket.js';

const now = () => '2026-08-01T10:00:00.000Z';
const T1 = '2026-08-01T11:00:00.000Z';

describe('REPRO: review-origin round 2 resume', () => {
  let store: NestableStore;
  let id: number;
  let artifactDir: string;
  let resumed: any[];

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

  function passUat(runAt: string): number {
    const evidence = openGateRun(store, { ticketId: id, stageKey: 'uat', runAt });
    commitGateOutcome(store, {
      ticketId: id,
      stageKey: 'uat',
      runAt,
      artifactPath: join(artifactDir, 'u.log'),
      gates: [],
      outcome: { kind: 'verdict', verdict: { kind: 'passed' } },
      stageRunId: evidence.runId,
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
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-repro-'));
    resumed = [];
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
      ...over,
    };
  }

  it('resumes round 2 after review revalidation fails', async () => {
    // Round 1 (review-origin): review fails -> fix
    failReview(now());
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    const r1 = listRecoveryRounds(store, id)[0]!;
    expect(r1.status).toBe('pending');
    expect(r1.round).toBe(1);

    // Fix round 1 done + marker -> uat
    completeFixExecution(store, id, T1);
    transition(store, id, 'fix', { kind: 'passed' }); // -> uat
    // uat revalidation passes
    const uatRun = passUat(now());
    completeRevalidation(store, { ticketId: id, stageKey: 'uat', stageRunId: uatRun, endedAt: T1 });
    expect(getTicket(store, id).stageCurrent).toBe('review');
    expect(listRecoveryRounds(store, id)[0]!.status).toBe('revalidating');

    // Round 2: review revalidation fails -> fix, round 2 opened
    failReview(now());
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    const rounds = listRecoveryRounds(store, id);
    expect(rounds[0]!.status).toBe('failed');
    expect(rounds[1]!.status).toBe('pending');
    expect(rounds[1]!.round).toBe(2);

    // Drive: should resume round 2
    const outcome = await driveTicket(deps(), id);
    console.log('OUTCOME', JSON.stringify(outcome));
    console.log('RESUMED', JSON.stringify(resumed));
    console.log('ROUNDS', JSON.stringify(listRecoveryRounds(store, id).map(r => ({ id: r.id, round: r.round, status: r.status }))));
    expect(resumed).toEqual([
      { ticketId: id, gate: 'review', attempts: 2, roundId: rounds[1]!.id, process: null },
    ]);
  });
});
