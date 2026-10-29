import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicketFlow } from '../stages/create.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { transition } from '../machine.js';
import { openGateRun } from './evidence.js';
import { commitGateOutcome, type RunOutcome, type CommitGateOutcomeInput } from './commit.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listStageRuns } from '../../store/stageRuns.js';
import { openProcessRun } from '../../store/processRuns.js';
import { listRecoveryRounds, type RecoveryTriggerKind } from '../../store/recoveryRounds.js';
import { completeFixExecution } from '../../store/recoveryRounds.js';
import { runUat } from '../stages/uat.js';
import { stageBlock } from '../../store/stageBlocks.js';
import { listOpenParks } from '../../store/usageLimitParks.js';

const now = () => '2026-07-30T10:00:00.000Z';

describe('commitGateOutcome — recovery trigger', () => {
  let store: Store;
  let id: number;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    id = createTicketFlow(store, { key: 'T-1', title: 't' }).id;
    transition(store, id, 'scope', { kind: 'passed' });
    transition(store, id, 'impl', { kind: 'passed' });
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-commit-'));
  });
  afterEach(() => {
    store.close();
    rmSync(artifactDir, { recursive: true, force: true });
  });

  function commit(
    stageKey: 'uat' | 'review',
    outcome: RunOutcome,
    trigger: (runId: number) => CommitGateOutcomeInput['recoveryTrigger'],
  ) {
    const runAt = now();
    const evidence = openGateRun(store, { ticketId: id, stageKey, runAt });
    return {
      result: commitGateOutcome(store, {
        ticketId: id,
        stageKey,
        runAt,
        artifactPath: join(artifactDir, 'x.log'),
        gates: [],
        outcome,
        stageRunId: evidence.runId,
        recoveryTrigger: trigger(evidence.runId),
        now,
      }),
      runId: evidence.runId,
    };
  }

  const trigger = (over: Partial<NonNullable<CommitGateOutcomeInput['recoveryTrigger']>> = {}) => ({
    sourceProcessId: 'gates' as const,
    sourceStageRunId: 1,
    sourceProcessRunId: null,
    triggerKind: 'gate-failure' as RecoveryTriggerKind,
    triggerDetail: 'exit 1',
    maxRounds: 2,
    ...over,
  });

  it('a failed uat verdict opens a recovery round atomically, carrying the complete snapshot', () => {
    const { result, runId } = commit(
      'uat',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'gates failed: lint' } },
      (runId) => trigger({ sourceStageRunId: runId, triggerDetail: 'gates failed: lint', maxRounds: 3 }),
    );
    expect(result).toEqual({ kind: 'advanced', next: 'fix' });
    const rounds = listRecoveryRounds(store, id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      ticketId: id,
      sourceStage: 'uat',
      sourceProcessId: 'gates',
      sourceStageRunId: runId,
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
      triggerDetail: 'gates failed: lint',
      round: 1,
      maxRounds: 3,
      status: 'pending',
      fixProcessRunId: null,
      startedAt: now(),
    });
    // The failing verdict itself committed: the ticket rests at fix.
    expect(getTicket(store, id).stageCurrent).toBe('fix');
  });

  it('an exhausted budget records the failed verdict, opens no round and parks fix (T831)', () => {
    const fail = () =>
      commit(
        'uat',
        { kind: 'verdict', verdict: { kind: 'failed', reason: 'gates failed: lint' } },
        (runId) => trigger({ sourceStageRunId: runId, maxRounds: 1 }),
      );
    fail();
    // Round 1 of 1 spent: the driver marks it exhausted, a human retries uat.
    const [first] = listRecoveryRounds(store, id);
    store.db.prepare("UPDATE recovery_rounds SET status = 'exhausted' WHERE id = ?").run(first!.id);
    transition(store, id, 'fix', { kind: 'passed' });
    const { result } = fail();
    expect(result).toEqual({ kind: 'advanced', next: 'fix' });
    expect(listRecoveryRounds(store, id)).toHaveLength(1);
    expect(getStage(store, id, 'uat')?.status).toBe('failed');
    expect(getStage(store, id, 'fix')).toMatchObject({
      status: 'failed',
      verdict: 'fix attempts exhausted',
    });
  });

  describe('review stall detection', () => {
    const stallCfg = { enabled: true, sameFileRounds: 2, repeatedFindingRounds: null };
    const finding = (file: string, title: string) => ({
      severity: 'high' as const, repo: '/r', file, title, detail: 'd', source: 'agent' as const,
    });
    const failReview = (n: number, file: string, stall: typeof stallCfg | undefined) => {
      const runAt = `2026-07-30T10:00:0${n}.000Z`;
      const evidence = openGateRun(store, { ticketId: id, stageKey: 'review', runAt });
      return commitGateOutcome(store, {
        ticketId: id, stageKey: 'review', runAt, artifactPath: join(artifactDir, 'r.log'),
        gates: [], stageRunId: evidence.runId, now,
        findings: [finding(file, `problem ${n}`)],
        outcome: { kind: 'verdict', verdict: { kind: 'failed', reason: 'review findings' } },
        recoveryTrigger: trigger({
          sourceProcessId: 'review', sourceStageRunId: evidence.runId,
          triggerKind: 'blocking-review-findings', maxRounds: 5,
          ...(stall ? { stall: { config: stall, blockingSeverity: 'high' as const } } : {}),
        }),
      });
    };
    const backToReview = () => {
      transition(store, id, 'fix', { kind: 'passed' }); // -> uat
      transition(store, id, 'uat', { kind: 'passed' }); // -> review
    };
    beforeEach(() => {
      transition(store, id, 'uat', { kind: 'passed' }); // -> review
    });

    it('parks at fix as review-stalled instead of opening the next round', () => {
      failReview(1, 'src/hot.ts', stallCfg);
      expect(listRecoveryRounds(store, id)).toHaveLength(1);
      backToReview();
      failReview(2, 'src/hot.ts', stallCfg);
      expect(listRecoveryRounds(store, id)).toHaveLength(1);
      expect(getTicket(store, id).stageCurrent).toBe('fix');
      const block = stageBlock(store, id, 'fix');
      expect(block?.kind).toBe('review-stalled');
      expect(block?.reason).toContain('src/hot.ts (2 rounds)');
      expect(getStage(store, id, 'fix')?.status).toBe('failed');
      // Exhausted, so a human reset (hint / continue) can end the episode.
      expect(listRecoveryRounds(store, id)[0]?.status).toBe('exhausted');
    });
    it('never parks when findings move to different files', () => {
      failReview(1, 'a.ts', stallCfg);
      backToReview();
      failReview(2, 'b.ts', stallCfg);
      expect(listRecoveryRounds(store, id)).toHaveLength(2);
      expect(stageBlock(store, id, 'fix')).toBeNull();
    });
    it('without a stall config behaves as today', () => {
      failReview(1, 'a.ts', undefined);
      backToReview();
      failReview(2, 'a.ts', undefined);
      expect(listRecoveryRounds(store, id)).toHaveLength(2);
      expect(stageBlock(store, id, 'fix')).toBeNull();
    });
    it('enabled:false changes nothing', () => {
      const off = { ...stallCfg, enabled: false };
      failReview(1, 'a.ts', off);
      backToReview();
      failReview(2, 'a.ts', off);
      expect(listRecoveryRounds(store, id)).toHaveLength(2);
    });
  });

  it.each([
    ['gate-failure', 'gates'],
    ['tester-verifier-failure', 'tester'],
    ['blocking-review-findings', 'review'],
  ] as const)('opens the round for trigger kind %s from source %s', (triggerKind, sourceProcessId) => {
    transition(store, id, 'uat', { kind: 'passed' }); // -> review
    // An AI source (Tester/Review) carries its process run; a deterministic
    // gate failure has none.
    const processRunId =
      sourceProcessId === 'review'
        ? openProcessRun(store, {
            ticketId: id, stageKey: 'review', processId: 'review', attempt: 0,
            startedAt: now(),
          }).id
        : null;
    const { result, runId } = commit(
      'review',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'review findings: 2 critical' } },
      (runId) =>
        trigger({
          sourceStageRunId: runId,
          triggerKind,
          sourceProcessId,
          sourceProcessRunId: processRunId,
        }),
    );
    expect(result).toEqual({ kind: 'advanced', next: 'fix' });
    expect(listRecoveryRounds(store, id)[0]).toMatchObject({
      sourceStage: 'review',
      triggerKind,
      sourceProcessId,
      sourceProcessRunId: processRunId,
      round: 1,
    });
  });

  it('a trigger on a passed verdict is refused and mutates nothing', () => {
    expect(() =>
      commit('uat', { kind: 'verdict', verdict: { kind: 'passed' } }, () => trigger()),
    ).toThrow(/recovery trigger/i);
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(listGateRuns(store, id)).toEqual([]);
  });

  it('a trigger on a block is refused', () => {
    expect(() =>
      commit('uat', { kind: 'blocked', blocker: 'nothing-to-run', reason: 'no gates' }, () => trigger()),
    ).toThrow(/recovery trigger/i);
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  it('K11: a blocked usage-limit outcome writes the park row with the block', () => {
    commit(
      'review',
      {
        kind: 'blocked',
        blocker: 'usage-limit',
        reason: 'usage limit — claude claude-sonnet-5',
        park: {
          provider: 'claude',
          model: 'claude-sonnet-5',
          lane: 'review',
          target: '/web',
          detail: 'Claude usage limit reached — out of credits.',
          keptOutcome: '{"findings":0,"targets":[]}',
        },
      },
      () => undefined,
    );
    expect(stageBlock(store, id, 'review')?.kind).toBe('usage-limit');
    const open = listOpenParks(store, id);
    expect(open).toHaveLength(1);
    expect(open[0]!.provider).toBe('claude');
    expect(open[0]!.lane).toBe('review');
    expect(open[0]!.keptOutcome).toBe('{"findings":0,"targets":[]}');
    // No fix attempt was spent — the block is a park, not a failed verdict.
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  it('a failed verdict that enters automatic recovery MUST carry a trigger', () => {
    expect(() =>
      commit('uat', { kind: 'verdict', verdict: { kind: 'failed', reason: 'exit 1' } }, () => undefined),
    ).toThrow(/recovery trigger/i);
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });

  it('a transaction failure after the round insert leaves neither verdict nor round', () => {
    // Force the recovery_rounds INSERT to violate its foreign key (a
    // source_stage_run_id that names no stage_runs row) — inside the verdict
    // transaction, so every earlier write rolls back with it.
    expect(() =>
      commit(
        'uat',
        { kind: 'verdict', verdict: { kind: 'failed', reason: 'exit 1' } },
        () => trigger({ sourceStageRunId: 999_999 }),
      ),
    ).toThrow();
    expect(getTicket(store, id).stageCurrent).toBe('uat');
    expect(listRecoveryRounds(store, id)).toEqual([]);
    expect(listGateRuns(store, id)).toEqual([]);
    // The open run is still running — the verdict never committed.
    expect(listStageRuns(store, id)[0]!.status).toBe('running');
  });

  it('a uat revalidation pass completes the uat-origin round; a later failure opens round 2 and fails it', () => {
    // Failure 1: opens round 1, ticket -> fix.
    commit(
      'uat',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'exit 1' } },
      () => trigger(),
    );
    expect(completeFixExecution(store, id, now())).toBe(true);
    transition(store, id, 'fix', { kind: 'passed' }); // -> uat (the only legal edge)

    // The revalidation UAT run attaches to the round when it opens.
    const pass = commit('uat', { kind: 'verdict', verdict: { kind: 'passed' } }, () => undefined);
    expect(pass.result).toEqual({ kind: 'advanced', next: 'review' });
    const round1 = listRecoveryRounds(store, id)[0]!;
    expect(round1.status).toBe('passed');
    expect(round1.uatRevalidationStageRunId).toBe(pass.runId);
    expect(round1.endedAt).toBe(now());
  });

  it('a uat revalidation FAILURE fails round 1 and opens round 2 for the new cause', () => {
    commit(
      'uat',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'exit 1' } },
      (runId) => trigger({ sourceStageRunId: runId, triggerDetail: 'exit 1', maxRounds: 3 }),
    );
    completeFixExecution(store, id, now());
    transition(store, id, 'fix', { kind: 'passed' });

    const fail = commit(
      'uat',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'exit 2' } },
      (runId) => trigger({ sourceStageRunId: runId, triggerDetail: 'exit 2', maxRounds: 3 }),
    );
    expect(fail.result).toEqual({ kind: 'advanced', next: 'fix' });
    const [round1, round2] = listRecoveryRounds(store, id);
    expect(round1).toMatchObject({ round: 1, status: 'failed' });
    expect(round1!.uatRevalidationStageRunId).toBe(fail.runId);
    expect(round2).toMatchObject({ round: 2, status: 'pending', triggerDetail: 'exit 2' });
  });

  it('a review-origin round is attached to uat first, and only the review outcome completes it', () => {
    // The ticket reaches review and fails on blocking findings.
    transition(store, id, 'uat', { kind: 'passed' }); // -> review
    commit(
      'review',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'review findings: 1 high' } },
      (runId) =>
        trigger({ sourceStageRunId: runId, triggerKind: 'blocking-review-findings', sourceProcessId: 'review', maxRounds: 2 }),
    );
    expect(getTicket(store, id).stageCurrent).toBe('fix');
    // The fix marker passes the execution; the graph NEVER routes fix directly
    // to review — revalidation always re-enters uat.
    expect(completeFixExecution(store, id, now())).toBe(true);
    expect(transition(store, id, 'fix', { kind: 'passed' })).toBe('uat');

    // UAT revalidates and PASSES — the round is still revalidating.
    const uatPass = commit('uat', { kind: 'verdict', verdict: { kind: 'passed' } }, () => undefined);
    expect(uatPass.result).toEqual({ kind: 'advanced', next: 'review' });
    const round = listRecoveryRounds(store, id)[0]!;
    expect(round.status).toBe('revalidating');
    expect(round.uatRevalidationStageRunId).toBe(uatPass.runId);

    // The later review run attaches, and its PASS completes the round.
    const reviewPass = commit('review', { kind: 'verdict', verdict: { kind: 'passed' } }, () => undefined);
    expect(reviewPass.result).toEqual({ kind: 'advanced', next: 'ship' });
    const after = listRecoveryRounds(store, id)[0]!;
    expect(after.status).toBe('passed');
    expect(after.reviewRevalidationStageRunId).toBe(reviewPass.runId);
  });

  it('an intermediate uat failure fails the review-origin round and opens the uat round atomically', () => {
    transition(store, id, 'uat', { kind: 'passed' }); // -> review
    commit(
      'review',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'review findings: 1 high' } },
      (runId) =>
        trigger({ sourceStageRunId: runId, triggerKind: 'blocking-review-findings', sourceProcessId: 'review', maxRounds: 2 }),
    );
    expect(completeFixExecution(store, id, now())).toBe(true);
    transition(store, id, 'fix', { kind: 'passed' }); // -> uat

    const uatFail = commit(
      'uat',
      { kind: 'verdict', verdict: { kind: 'failed', reason: 'exit 1' } },
      (runId) => trigger({ sourceStageRunId: runId, triggerDetail: 'exit 1', maxRounds: 2 }),
    );
    expect(uatFail.result).toEqual({ kind: 'advanced', next: 'fix' });
    const [reviewRound, uatRound] = listRecoveryRounds(store, id);
    expect(reviewRound).toMatchObject({ sourceStage: 'review', round: 1, status: 'failed' });
    expect(reviewRound!.uatRevalidationStageRunId).toBe(uatFail.runId);
    expect(uatRound).toMatchObject({ sourceStage: 'uat', round: 1, status: 'pending' });
  });

  it('an execution error — a run that died before any verdict — creates no recovery round', async () => {
    // The real UAT runner throws mid-run (here: its stage row is gone, so the
    // transition would find no stage): the crash must not have invented a round.
    store.db.prepare('DELETE FROM stages WHERE ticket_id = ? AND stage_key = ?').run(id, 'uat');
    await expect(
      runUat(store, { ticketId: id, cwd: '/wt', artifactDir }, {
        now,
        planTargets: async () => ({ kind: 'targets', targets: [{ repo: '/web', path: '/wt', names: ['web'] }], unmapped: [] }),
        probe: () => ({ kind: 'ok', scripts: { test: 'vitest' } }),
        runGates: async (gates) => ({
          kind: 'ran',
          results: gates.map((g) => ({ name: g.name, exitCode: 0, output: '', startedAt: now(), endedAt: now() })),
        }),
      }),
    ).rejects.toThrow(/has no stage 'uat'/);
    expect(listRecoveryRounds(store, id)).toEqual([]);
  });
});
