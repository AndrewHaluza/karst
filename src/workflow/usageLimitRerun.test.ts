import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow as createTicketFlowBase } from './stages/create.js';
import {
  claimUsageLimitPark,
  insertOpenPark,
  listOpenParks,
  listParks,
  type UsageLimitParkRow,
} from '../store/usageLimitParks.js';
import { parkGateStage, stageBlock } from '../store/stageBlocks.js';
import { listStageRuns, openStageRun } from '../store/stageRuns.js';
import { listRecoveryRounds, openRecoveryRound, attachRevalidationStageRun } from '../store/recoveryRounds.js';
import { getTicket } from '../store/tickets.js';
import { getStage } from '../store/stages.js';
import { transition } from './machine.js';
import { dismissUsageLimitPark, rerunParkedStage } from './usageLimitRerun.js';
import { listUatFindings as listAllUatFindings, recordUatFindings } from '../store/uatFindings.js';
import { isCoverageRecord } from '../model/coverageRecord.js';

/** The agent's observations only: the advisory coverage record is not one. */
const listUatFindings = (...args: Parameters<typeof listAllUatFindings>) =>
  listAllUatFindings(...args).filter((f) => !isCoverageRecord(f));
import { listProcessRuns, openProcessRun } from '../store/processRuns.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { Manifest } from '../manifest/types.js';
import type { GateRunInput } from '../store/gateRuns.js';
import { UsageLimitError } from '../agent/cliFailure.js';

/**
 * The deterministic gate a parked run already passed. A UAT park only ever
 * happens AFTER its gates (the Tester runs last), so the re-run must see that
 * evidence — without it `aggregateUat` correctly reads "asked nothing" (R3) and
 * blocks instead of re-running the lane.
 */
const UAT_GREEN_GATE: GateRunInput = {
  gateName: 'test (web)',
  exitCode: 0,
  startedAt: '2026-10-13T10:00:00.000Z',
  endedAt: '2026-10-13T10:00:01.000Z',
  repo: 'web',
  command: 'npm',
  args: ['test'],
};

/** Register one ticket worktree exactly as the stage's target planner would. */
function registerWorktree(
  store: Store,
  ticketId: number,
  repo: string,
  path: string,
  branch = `karst/${repo}`,
  baseRef = 'develop',
): void {
  store.db
    .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, repo, path, branch, baseRef);
}

/**
 * The re-run resolves every target through the ticket's WORKTREE rows (never a
 * silent `cwd` fallback), so the fixture — like production, where the stage
 * could not have run without a row — registers them. `web` is the primary
 * checkout every re-run test parks on.
 */
function createTicketFlow(
  store: Store,
  input: Parameters<typeof createTicketFlowBase>[1],
): ReturnType<typeof createTicketFlowBase> {
  const ticket = createTicketFlowBase(store, input);
  registerWorktree(store, ticket.id, 'web', '/wt/web');
  return ticket;
}

describe('dismissUsageLimitPark', () => {
  let store: Store;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-dismiss-park-'));
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('dismisses an op park without creating stage runs or recovery rounds', () => {
    const ticket = createTicketFlow(store, { key: 'TEST-1', title: 'Test ticket' });
    const parkId = insertOpenPark(store, {
      ticketId: ticket.id,
      kind: 'op',
      stage: 'scope',
      lane: null,
      target: null,
      keptOutcome: null,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exhausted',
    });

    const park: UsageLimitParkRow = {
      id: parkId,
      ticketId: ticket.id,
      stage: 'scope',
      kind: 'op',
      lane: null,
      target: null,
      sessionId: null,
      stageRunId: null,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exhausted',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const res = dismissUsageLimitPark(store, park, { artifactDir });
    expect(res).toEqual({ kind: 'stopped' });

    // Assert no stage runs opened
    expect(listStageRuns(store, ticket.id)).toHaveLength(0);
    // Assert no recovery rounds opened
    expect(listRecoveryRounds(store, ticket.id)).toHaveLength(0);
  });

  it('dismisses a stage-block park by opening its own stage run and committing a failed verdict with usage-limit-dismissed recovery trigger', () => {
    const ticket = createTicketFlow(store, { key: 'TEST-2', title: 'Test stage park ticket' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' }); // -> review

    // Open stage run 101 first (FK)
    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    // Simulate stage parked at review
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic/claude-3-7-sonnet out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({ findings: 0, targets: [] }),
      },
    });

    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'review',
      kind: 'stage-block',
      lane: 'review',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: JSON.stringify({ findings: 0, targets: [] }),
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const manifest: Manifest = {
      review: { maxFixAttempts: 3 },
    } as unknown as Manifest;

    const res = dismissUsageLimitPark(store, park, {
      manifest,
      artifactDir,
      now: () => '2026-10-13T10:05:00.000Z',
    });

    expect(res.kind).toBe('advanced');
    // Ticket transitions to fix
    const updated = getTicket(store, ticket.id);
    expect(updated.stageCurrent).toBe('fix');

    // Check stage runs: one for parked run, one for dismissed run
    const runs = listStageRuns(store, ticket.id);
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const newRun = runs.find((r) => r.id !== parkedRunId);
    expect(newRun).toBeDefined();
    expect(newRun?.status).toBe('finished');
    expect(newRun?.outcome).toBe('advanced');

    // Check recovery rounds
    const rounds = listRecoveryRounds(store, ticket.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      sourceStage: 'review',
      sourceProcessId: 'review',
      sourceStageRunId: newRun?.id,
      sourceProcessRunId: null,
      triggerKind: 'usage-limit-dismissed',
      triggerDetail: 'Monthly quota exceeded',
      maxRounds: 3,
    });
  });

  it('dismissing a parked revalidation FAILS the prior round instead of opening a second', () => {
    const ticket = createTicketFlow(store, { key: 'TEST-DISMISS-REVAL', title: 'dismiss reval' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' }); // -> review

    // A prior review-derived round is mid-revalidation: its terminal review run
    // IS the parked (quota-stopped) run.
    const originalRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-10-13T09:00:00.000Z',
      startedAt: '2026-10-13T09:00:00.000Z',
    });
    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    const prior = openRecoveryRound(store, {
      ticketId: ticket.id,
      sourceStage: 'review',
      sourceProcessId: 'review',
      sourceStageRunId: originalRunId,
      sourceProcessRunId: null,
      triggerKind: 'blocking-review-findings',
      triggerDetail: 'the original failure',
      maxRounds: 3,
      startedAt: '2026-10-13T09:00:00.000Z',
    });
    attachRevalidationStageRun(store, ticket.id, 'review', parkedRunId);
    store.db
      .prepare("UPDATE recovery_rounds SET status = 'revalidating' WHERE id = ?")
      .run(prior.id);

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });
    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'review',
      kind: 'stage-block',
      lane: 'review',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const res = dismissUsageLimitPark(store, park, {
      manifest: { review: { maxFixAttempts: 3 } } as unknown as Manifest,
      artifactDir,
      now: () => '2026-10-13T10:05:00.000Z',
    });

    expect(res.kind).toBe('advanced');
    const rounds = listRecoveryRounds(store, ticket.id);
    // The dismissed run WAS the prior round's revalidation, so committing its
    // failed verdict fails that round — it must not be left 'revalidating'
    // while a second round opens (two concurrently-open rounds).
    expect(rounds.find((r) => r.id === prior.id)?.status).toBe('failed');
    const active = rounds.filter(
      (r) => r.status === 'pending' || r.status === 'fixing' || r.status === 'revalidating',
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.triggerKind).toBe('usage-limit-dismissed');
  });
});

describe('rerunParkedStage', () => {
  let store: Store;
  let artifactDir: string;

  beforeEach(() => {
    store = openStore(':memory:');
    artifactDir = mkdtempSync(join(tmpdir(), 'karst-rerun-park-'));
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('never re-runs an op park as a stage lane (the op path owns it)', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-OP', title: 'Test op park ticket' });
    const parkId = insertOpenPark(store, {
      ticketId: ticket.id,
      kind: 'op',
      stage: 'review',
      lane: 'analysis',
      target: null,
      keptOutcome: null,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exhausted',
    });
    const park: UsageLimitParkRow = {
      id: parkId,
      ticketId: ticket.id,
      stage: 'review',
      kind: 'op',
      lane: 'analysis',
      target: null,
      sessionId: null,
      stageRunId: null,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exhausted',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };
    const adapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn(),
    } as unknown as AgentAdapter;

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter,
      cwd: '/wt/web',
      artifactDir,
    });

    expect(res).toEqual({ kind: 'stopped', alreadyHandled: true });
    // No lane ran, and the park stays OPEN for the op's own path.
    expect(adapter.runHeadless).not.toHaveBeenCalled();
    expect(listOpenParks(store, ticket.id)).toHaveLength(1);
    expect(listStageRuns(store, ticket.id)).toHaveLength(0);
  });

  it('leaves a park that names no re-runnable lane OPEN (it is never consumed without a run)', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-NO-LANE', title: 'Test no lane park' });
    const parkId = insertOpenPark(store, {
      ticketId: ticket.id,
      kind: 'stage-block',
      stage: 'scope',
      lane: null,
      target: null,
      keptOutcome: null,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exhausted',
    });
    const park: UsageLimitParkRow = {
      id: parkId,
      ticketId: ticket.id,
      stage: 'scope',
      kind: 'stage-block',
      lane: null,
      target: null,
      sessionId: null,
      stageRunId: null,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exhausted',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };
    const adapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn(),
    } as unknown as AgentAdapter;

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter,
      cwd: '/wt/web',
      artifactDir,
    });

    expect(res).toEqual({ kind: 'stopped', alreadyHandled: true });
    // The park named no lane this path can run: it stays OPEN, so the stage it
    // blocks is not left blocked by a park that reads as handled.
    expect(listOpenParks(store, ticket.id)).toHaveLength(1);
    expect(listParks(store, ticket.id)[0]?.resolvedAt).toBeNull();
    expect(adapter.runHeadless).not.toHaveBeenCalled();
  });
  it('re-runs with the role assignment (instructions, effort, agent name), not a provider/model stub', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-ROLE-ASSIGN', title: 'Test role assignment' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' }); // -> review

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    const gateRun: GateRunInput = {
      gateName: 'lint (web)',
      exitCode: 0,
      startedAt: '2026-10-13T10:00:00.000Z',
      endedAt: '2026-10-13T10:00:01.000Z',
      repo: 'web',
      command: 'npm',
      args: ['run', 'lint'],
    };
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [gateRun],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({ findings: 0, targets: [] }),
      },
    });
    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'review',
      kind: 'stage-block',
      lane: 'review',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: JSON.stringify({ findings: 0, targets: [] }),
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({
        sessionId: '',
        verdict: null,
        raw: JSON.stringify([]),
      }),
    };

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      resolveAssignment: (stageKey, provider, model) => ({
        provider,
        model: model ?? undefined,
        effort: 'high',
        agentName: 'Review Agent',
        instructions: 'ROLE INSTRUCTIONS THAT MUST REACH THE PROMPT',
      }),
      manifest: {
        review: { requireIndependentSignal: false },
      } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(mockAdapter.runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        effort: 'high',
        prompt: expect.stringContaining('ROLE INSTRUCTIONS THAT MUST REACH THE PROMPT'),
      }),
    );
    const run = listProcessRuns(store, ticket.id).find((r) => r.processId === 'review');
    expect(run).toMatchObject({
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'gpt-4o',
    });
  });

  it('does not build an adapter when the park was already claimed', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-RACE', title: 'Race ticket' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' }); // -> review

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic/claude-3-7-sonnet out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({ findings: 0, targets: [] }),
      },
    });
    const park = listOpenParks(store, ticket.id)[0]!;
    // A concurrent window claimed first.
    claimUsageLimitPark(store, park.id, 'retry');

    const buildAdapter = vi.fn();
    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      buildAdapter,
      cwd: '/wt/web',
      artifactDir,
    });

    expect(res).toEqual({ kind: 'stopped', alreadyHandled: true });
    expect(buildAdapter).not.toHaveBeenCalled();
  });

  it('re-runs a parked uat target with override adapter and advances stage when clean', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-4', title: 'Test uat rerun ticket' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic/claude-3-7-sonnet out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [UAT_GREEN_GATE],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({ observations: 0, targets: [] }),
      },
    });

    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'uat',
      kind: 'stage-block',
      lane: 'uat',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: JSON.stringify({ observations: 0, targets: [] }),
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({
        sessionId: '',
        verdict: null,
        raw: JSON.stringify([]),
      }),
    };

    const manifest: Manifest = {
      uat: {
        testerObservations: { blockingSeverity: 'none' },
      },
    } as unknown as Manifest;

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      resolveAssignment: (stageKey, provider, model) => ({
        provider,
        model: model ?? undefined,
        effort: 'medium',
        agentName: 'UAT Agent',
        instructions: 'TESTER ROLE INSTRUCTIONS',
      }),
      manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('review');
    expect(mockAdapter.runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        effort: 'medium',
        prompt: expect.stringContaining('TESTER ROLE INSTRUCTIONS'),
      }),
    );
  });

  it('a UAT re-run whose parked gates were all disabled commits BYPASSED, never passed', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-BYPASS', title: 'Test uat bypass rerun' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      // The user disabled the only gate: the stage asked nothing, so its
      // verdict is `bypassed` — the state aggregateUat is the sole producer of.
      gates: [
        {
          gateName: 'test (web)',
          exitCode: null,
          repo: 'web',
          command: 'npm',
          args: ['test'],
          skipped: true,
        },
      ],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });
    const park = listOpenParks(store, ticket.id)[0]!;
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used');
      },
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: '[]' }),
    };

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest: { uat: { testerObservations: { blockingSeverity: 'none' } } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    // Recorded as the gate's own answer: BYPASSED, not a green nobody ran.
    expect(getStage(store, ticket.id, 'uat')?.status).toBe('bypassed');
  });

  it('a sandbox preflight refusal parks the stage and never runs the lane', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-SANDBOX', title: 'Test uat sandbox preflight' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [UAT_GREEN_GATE],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });
    const park = listOpenParks(store, ticket.id)[0]!;
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used');
      },
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: '[]' }),
    };

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest: { uat: { testerObservations: { blockingSeverity: 'none' } } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      syncSandbox: async () => ({ ok: false, reason: 'sandbox has changes that cannot sync' }),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    // Refusing to read a stale host tree is a PARK, exactly like the driver's
    // own preflight — never a UAT of the wrong copy.
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'sandbox-sync' });
    expect(mockAdapter.runHeadless).not.toHaveBeenCalled();
    expect(stageBlock(store, ticket.id, 'uat')).toMatchObject({ kind: 'sandbox-sync' });
  });

  it('a sandbox provisioning refusal parks sandbox-setup after a successful sync', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-PROVISION', title: 'Test uat sandbox provision' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [UAT_GREEN_GATE],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });
    const park = listOpenParks(store, ticket.id)[0]!;
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => {
        throw new Error('not used');
      },
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: '[]' }),
    };
    const syncSandbox = vi.fn(async () => ({ ok: true as const }));

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest: { uat: { testerObservations: { blockingSeverity: 'none' } } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      syncSandbox,
      provisionSandbox: async () => ({ ok: false, reason: 'docker image missing' }),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(syncSandbox).toHaveBeenCalledWith(ticket.id);
    expect(res).toMatchObject({ kind: 'blocked', blocker: 'sandbox-setup' });
    expect(mockAdapter.runHeadless).not.toHaveBeenCalled();
    expect(stageBlock(store, ticket.id, 'uat')).toMatchObject({ kind: 'sandbox-setup' });
  });
  it('returns stopped when park is already claimed', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-5', title: 'Test already claimed ticket' });
    const park: UsageLimitParkRow = {
      id: 999, // non-existent or resolved
      ticketId: ticket.id,
      stage: 'review',
      kind: 'stage-block',
      lane: 'review',
      target: 'web',
      sessionId: null,
      stageRunId: null,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: '2026-10-13T10:05:00.000Z',
      resolution: 'dismiss',
    };

    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn(),
    };

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      cwd: '/wt/web',
      artifactDir,
    });

    expect(res).toEqual({ kind: 'stopped', alreadyHandled: true });
  });

  it('a claim whose adapter cannot be built is put back, not consumed', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-ADAPTER-THROW', title: 'Test adapter throw' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' }); // -> review

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      stageRunId: null,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'repo',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });
    const park = listOpenParks(store, ticket.id)[0]!;

    await expect(
      rerunParkedStage({
        store,
        parkRow: park,
        provider: 'codex',
        model: 'gpt-4o',
        buildAdapter: () => {
          throw new Error('no adapter for that park');
        },
        cwd: '/wt/repo',
        artifactDir,
        now: () => '2026-10-13T10:10:00.000Z',
      }),
    ).rejects.toThrow('no adapter for that park');

    // The claim must not survive a run that never reached a verdict: the row is
    // open and the stage blocked again, so Pick/Retry are still offered.
    expect(listOpenParks(store, ticket.id).map((p) => p.id)).toEqual([park.id]);
    expect(stageBlock(store, ticket.id, 'review')).toMatchObject({
      kind: 'usage-limit',
      reason: 'usage limit — codex gpt-4o',
    });
  });
  it('uat re-run merges sibling observations from keptOutcome', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-MERGE', title: 'Test uat merge' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    const gateRun: GateRunInput = {
      gateName: 'test',
      exitCode: 0,
      repo: 'web',
      command: 'npm',
      args: ['run', 'test'],
    };

    // Sibling target 'api' had a high severity blocking observation before the park
    const siblingObservation = {
      severity: 'high' as const,
      title: 'Sibling API endpoint returns 500',
      repo: 'api',
      file: 'src/server.ts',
      line: 42,
    };

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [gateRun],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({
          observations: [siblingObservation],
          targets: [{ repo: 'api', status: 'completed', observations: 1 }],
        }),
      },
    });

    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'uat',
      kind: 'stage-block',
      lane: 'uat',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: JSON.stringify({
        observations: [siblingObservation],
        targets: [{ repo: 'api', status: 'completed', observations: 1 }],
      }),
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    // The sibling observation is already durable from the run that made it —
    // the park only carries a copy so the re-run can still COUNT it.
    const priorTesterRunId = openProcessRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      processId: 'tester',
      attempt: 0,
      stageRunId: parkedRunId,
      startedAt: '2026-10-13T10:00:00.000Z',
    }).id;
    recordUatFindings(store, {
      ticketId: ticket.id,
      processRunId: priorTesterRunId,
      findings: [siblingObservation],
      createdAt: '2026-10-13T10:00:00.000Z',
    });

    // The re-run target 'web' produces 0 observations (clean pass on web)
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({
        sessionId: '',
        verdict: null,
        raw: JSON.stringify([]),
      }),
    };

    const manifest: Manifest = {
      uat: {
        testerObservations: { blockingSeverity: 'high' },
        maxFixAttempts: 2,
      },
    } as unknown as Manifest;

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    // Even though web had 0 observations, the merged sibling observation is high severity, so stage transitions to fix
    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('fix');

    const uatFindings = listUatFindings(store, ticket.id);
    // Exactly one row: the observation the sibling's own run recorded. The
    // re-run counted it but already had it, so it writes no second copy.
    expect(uatFindings).toHaveLength(1);
    expect(uatFindings[0]?.title).toBe('Sibling API endpoint returns 500');
    expect(uatFindings[0]?.processRunId).toBe(priorTesterRunId);
  });
  it('a SECOND uat quota park keeps the sibling observations the first park kept', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-SECOND-PARK', title: 'Test second park' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    // The FIRST park: the sibling target 'api' already reported a blocking
    // observation before 'web' hit the quota.
    const siblingObservation = {
      severity: 'high' as const,
      title: 'Sibling API endpoint returns 500',
      repo: 'api',
      file: 'src/server.ts',
      line: 42,
    };
    const priorKeptOutcome = JSON.stringify({
      observations: [siblingObservation],
      targets: [{ repo: 'api', status: 'completed', observations: 1 }],
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [UAT_GREEN_GATE],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: priorKeptOutcome,
      },
    });
    const park = listOpenParks(store, ticket.id)[0]!;

    // The picked core is out of quota too: the re-run parks AGAIN.
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockRejectedValue(
        new UsageLimitError('Claude usage limit reached — out of credits.', {
          tool: 'Claude',
          provider: 'anthropic',
          model: 'claude-3-7-sonnet',
        }),
      ),
    };

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest: {
        uat: { testerObservations: { blockingSeverity: 'high' } },
      } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toMatchObject({ kind: 'blocked', blocker: 'usage-limit' });
    // The SECOND park carries the sibling observation forward — a quota stop
    // that lands again must not erase what a partner target already reported.
    const parks = listParks(store, ticket.id);
    expect(parks).toHaveLength(2);
    const second = parks.find((p) => p.resolvedAt === null);
    expect(second).toBeDefined();
    const kept = JSON.parse(second!.keptOutcome!) as {
      observations: { repo: string; title: string }[];
      targets: { repo: string; status: string }[];
    };
    expect(kept.observations).toEqual([siblingObservation]);
    expect(kept.targets.map((t) => t.repo).sort()).toEqual(['api', 'web']);
  });
  it('review re-run that stops closes the stage run it opened', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-REVIEW-STOP', title: 'Test review stop' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' }); // -> review

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });

    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'review',
      kind: 'stage-block',
      lane: 'review',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
    };

    // A Stop reaches the lane before it asks anything: the re-run returns
    // `stopped`. The stage run it OPENED must be closed, or the dashboard reads
    // a live run that no process will ever finish.
    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest: { review: { requireIndependentSignal: false } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      signal: AbortSignal.abort(),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'stopped' });
    const newRun = listStageRuns(store, ticket.id).find(
      (r) => r.stageKey === 'review' && r.id !== parkedRunId,
    );
    expect(newRun?.status).toBe('finished');
    expect(newRun?.outcome).toBe('stopped');
    // No verdict was reached, so the claim must not consume the park: the row
    // is open again and the stage is blocked, keeping Pick/Retry available.
    const reopened = listOpenParks(store, ticket.id);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.id).toBe(park.id);
    expect(stageBlock(store, ticket.id, 'review')).toMatchObject({ kind: 'usage-limit' });
  });

  it('uat re-run that stops closes the stage run it opened', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-STOP', title: 'Test uat stop' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [UAT_GREEN_GATE],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });

    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'uat',
      kind: 'stage-block',
      lane: 'uat',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
    };

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest: { uat: { maxFixAttempts: 2 } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      signal: AbortSignal.abort(),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'stopped' });
    // A Stop reaches the lane before a verdict: the park stays usable.
    expect(listOpenParks(store, ticket.id).map((p) => p.id)).toEqual([park.id]);
    expect(stageBlock(store, ticket.id, 'uat')).toMatchObject({ kind: 'usage-limit' });
    const newRun = listStageRuns(store, ticket.id).find(
      (r) => r.stageKey === 'uat' && r.id !== parkedRunId,
    );
    expect(newRun?.status).toBe('finished');
    expect(newRun?.outcome).toBe('stopped');
  });
  it('uat re-run tolerates an empty artifactDir instead of crashing', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-NO-ARTIFACT', title: 'Test uat no artifact dir' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [UAT_GREEN_GATE],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'uat',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: null,
      },
    });

    const park: UsageLimitParkRow = {
      id: 1,
      ticketId: ticket.id,
      stage: 'uat',
      kind: 'stage-block',
      lane: 'uat',
      target: 'web',
      sessionId: null,
      stageRunId: parkedRunId,
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      detail: 'Monthly quota exceeded',
      keptOutcome: null,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
    };

    // The host passes `artifactDir: ''` when no artifact directory is
    // configured; `mkdirSync('')` throws ENOENT, so the re-run must guard it
    // exactly like the review path does.
    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      adapter: mockAdapter,
      manifest: { uat: { maxFixAttempts: 2 } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir: '',
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(getStage(store, ticket.id, 'uat')?.artifactPath).toBeFalsy();
  });
});

