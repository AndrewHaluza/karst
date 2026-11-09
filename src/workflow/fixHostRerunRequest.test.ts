import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { openRecoveryRound, activeFixRound } from '../store/recoveryRounds.js';
import { recordGateRun } from '../store/gateRuns.js';
import { setStage } from '../store/stages.js';
import { setStageCurrent } from '../store/tickets.js';
import { claimHostRerun } from '../store/hostRerunRound.js';
import { NO_NEW_COMMIT_REASON, snapshotFixRoundHeads } from './fixRoundGuard.js';
import { ticketsWithRequestedHostRerun } from '../store/hostRerunRound.js';
import type { GitRunner } from '../integrations/git.js';
import {
  requestHostRerun,
  assertFixHasNewCommitOrRequestRerun,
  runRequestedHostReruns,
  HOST_RERUN_REQUESTED_REPLY,
} from './fixHostRerunRequest.js';
import type { FailedGate } from './fixHostRerun.js';

import { upsertProject } from '../store/projects.js';

const AT = '2026-01-01T00:00:00Z';
let PROJECT = 0;

describe('host re-run request from a refused CLI fix marker', () => {
  let store: Store;
  let ticketId: number;
  let roundId: number;

  const openRound = (triggerKind: string): number => {
    const id = openRecoveryRound(store, {
      ticketId,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      triggerKind,
      triggerDetail: 'x',
      maxRounds: 3,
      startedAt: AT,
    } as never).id;
    store.db.prepare("UPDATE recovery_rounds SET status = 'fixing' WHERE id = ?").run(id); // the agent is fixing when it fires the marker
    return id;
  };

  beforeEach(() => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId: (PROJECT = upsertProject(store, { slug: 'p' }).id) }).id;
    setStage(store, ticketId, 'uat', { status: 'failed', verdict: 'gates failed', startedAt: AT, endedAt: AT, attempt: 1 });
    setStage(store, ticketId, 'fix', { status: 'running', startedAt: AT });
    setStageCurrent(store, ticketId, 'fix');
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 1,
      runAt: AT,
      gates: [{ gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['run', 'test:unit'], summary: 'flaky' }],
    });
  });

  it('requests the re-run for a gate-failure round and tells the agent to stop', () => {
    roundId = openRound('gate-failure');
    expect(requestHostRerun(store, ticketId, AT)).toEqual({ kind: 'requested', message: HOST_RERUN_REQUESTED_REPLY });
    expect(HOST_RERUN_REQUESTED_REPLY).toContain(NO_NEW_COMMIT_REASON);
    expect(HOST_RERUN_REQUESTED_REPLY).toMatch(/host re-runs the failed gates/);
    expect(HOST_RERUN_REQUESTED_REPLY).toMatch(/stop now/i);
    const row = store.db.prepare('SELECT host_rerun_requested_at AS r, host_rerun_at AS h FROM recovery_rounds WHERE id = ?').get(roundId);
    expect(row).toEqual({ r: AT, h: null });
  });

  it('does not request twice in one round', () => {
    openRound('gate-failure');
    requestHostRerun(store, ticketId, AT);
    expect(requestHostRerun(store, ticketId, AT)).toEqual({ kind: 'not-applicable' });
  });

  it('does not request once the host already re-ran', () => {
    roundId = openRound('gate-failure');
    claimHostRerun(store, roundId, AT);
    expect(requestHostRerun(store, ticketId, AT)).toEqual({ kind: 'not-applicable' });
  });

  it('does not request for a round that is not a gate failure', () => {
    openRound('blocking-review-findings');
    expect(requestHostRerun(store, ticketId, AT)).toEqual({ kind: 'not-applicable' });
  });

  it('does not request when the source stage has no failed gate', () => {
    openRound('gate-failure');
    store.db.prepare('DELETE FROM gate_runs').run();
    expect(requestHostRerun(store, ticketId, AT)).toEqual({ kind: 'not-applicable' });
  });

  it('does not request without an active fix round', () => {
    expect(requestHostRerun(store, ticketId, AT)).toEqual({ kind: 'not-applicable' });
  });

  describe('sweep', () => {
    const ok = { exitCode: 0, summary: null };
    it('runs exactly one re-run for a requested round, even over many ticks (green)', async () => {
      roundId = openRound('gate-failure');
      requestHostRerun(store, ticketId, AT);
      const ran: FailedGate[] = [];
      const rerunDeps = { runGate: async (_: number, g: FailedGate) => (ran.push(g), ok), now: () => '2026-01-02T00:00:00Z' };
      await runRequestedHostReruns(store, PROJECT, rerunDeps);
      await runRequestedHostReruns(store, PROJECT, rerunDeps);
      expect(ran).toHaveLength(1);
      expect(store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(roundId)).toEqual({
        status: 'passed',
        end_reason: 'no change: failed gates passed on re-run',
      });
    });

    it('parks the fix stage with the gate names and summaries when a gate is still red', async () => {
      roundId = openRound('gate-failure');
      requestHostRerun(store, ticketId, AT);
      const outcomes = await runRequestedHostReruns(store, PROJECT, {
        runGate: async () => ({ exitCode: 1, summary: 'ENOTEMPTY' }),
        now: () => '2026-01-02T00:00:00Z',
      });
      expect(outcomes.map((o) => o.kind)).toEqual(['failed']);
      expect(activeFixRound(store, ticketId)).toBeNull();
      const row = store.db.prepare('SELECT status, end_reason FROM recovery_rounds WHERE id = ?').get(roundId) as Record<string, string>;
      expect(row.status).toBe('interrupted');
      expect(row.end_reason).toMatch(/unit \(web\): ENOTEMPTY/);
    });

    it('ignores a requested round of another project', async () => {
      openRound('gate-failure');
      requestHostRerun(store, ticketId, AT);
      let calls = 0;
      await runRequestedHostReruns(store, PROJECT + 1, { runGate: async () => (calls++, ok) });
      expect(calls).toBe(0);
    });

    it('ignores a round nobody requested', async () => {
      openRound('gate-failure');
      let calls = 0;
      await runRequestedHostReruns(store, PROJECT, { runGate: async () => (calls++, ok) });
      expect(calls).toBe(0);
    });
  });
});

describe('host CLI fix marker guard with the re-run request', () => {
  const gitAt = (heads: Record<string, string>): GitRunner => async (args, cwd) =>
    args[0] === 'rev-parse' && cwd !== undefined && heads[cwd] !== undefined
      ? { exitCode: 0, stdout: `${heads[cwd]}\n`, stderr: '' }
      : { exitCode: 128, stdout: '', stderr: 'bad' };
  let store: Store;
  let ticketId: number;
  const setup = async (triggerKind: string, withFailedGate: boolean): Promise<void> => {
    store = openStore(':memory:');
    ticketId = createTicketFlow(store, { key: 'T-1', title: 't', projectId: (PROJECT = upsertProject(store, { slug: 'p' }).id) }).id;
    store.db.prepare('INSERT INTO worktrees (ticket_id, repo, path, branch) VALUES (?, ?, ?, ?)').run(ticketId, 'web', '/wt/web', 'b');
    if (withFailedGate) {
      recordGateRun(store, { ticketId, stageKey: 'uat', attempt: 1, runAt: AT, gates: [{ gateName: 'unit (web)', exitCode: 1, repo: 'web', command: 'npm', args: ['t'], summary: 's' }] });
    }
    const round = openRecoveryRound(store, { ticketId, sourceStage: 'uat', sourceProcessId: 'gates', triggerKind, triggerDetail: 'x', maxRounds: 3, startedAt: AT } as never);
    await snapshotFixRoundHeads(store, ticketId, round.id, gitAt({ '/wt/web': 'w1' }));
  };

  it('replaces the refusal with the host re-run reply, once', async () => {
    await setup('gate-failure', true);
    const git = gitAt({ '/wt/web': 'w1' });
    await expect(assertFixHasNewCommitOrRequestRerun(store, ticketId, git, () => AT)).rejects.toThrow(/host re-runs the failed gates/);
    // A second refusal in the same round keeps today's text.
    const second = assertFixHasNewCommitOrRequestRerun(store, ticketId, git, () => AT);
    await expect(second).rejects.toThrow(NO_NEW_COMMIT_REASON);
    await expect(second).rejects.not.toThrow(/host re-runs/);
  });

  it('requests nothing when the bridge runs the marker, which re-runs the gates itself', async () => {
    await setup('gate-failure', true);
    const p = assertFixHasNewCommitOrRequestRerun(store, ticketId, gitAt({ '/wt/web': 'w1' }), () => AT, { viaBridge: true });
    await expect(p).rejects.toThrow(NO_NEW_COMMIT_REASON);
    await expect(p).rejects.not.toThrow(/host re-runs/);
    expect(ticketsWithRequestedHostRerun(store, PROJECT)).toEqual([]);
  });

  it('keeps today\'s text for a round that is not a gate failure', async () => {
    await setup('blocking-review-findings', true);
    const p = assertFixHasNewCommitOrRequestRerun(store, ticketId, gitAt({ '/wt/web': 'w1' }), () => AT);
    await expect(p).rejects.not.toThrow(/host re-runs/);
    await expect(p).rejects.toThrow(NO_NEW_COMMIT_REASON);
  });

  it('accepts a new commit and requests nothing', async () => {
    await setup('gate-failure', true);
    await expect(assertFixHasNewCommitOrRequestRerun(store, ticketId, gitAt({ '/wt/web': 'w2' }), () => AT)).resolves.toBeUndefined();
    expect(ticketsWithRequestedHostRerun(store, PROJECT)).toEqual([]);
  });
});
