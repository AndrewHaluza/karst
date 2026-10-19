import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import {
  claimUsageLimitPark,
  insertOpenPark,
  listOpenParks,
  type UsageLimitParkRow,
} from '../store/usageLimitParks.js';
import { parkGateStage } from '../store/stageBlocks.js';
import { listStageRuns, openStageRun } from '../store/stageRuns.js';
import { listRecoveryRounds, openRecoveryRound, attachRevalidationStageRun } from '../store/recoveryRounds.js';
import { getTicket } from '../store/tickets.js';
import { getStage } from '../store/stages.js';
import { transition } from './machine.js';
import { dismissUsageLimitPark, rerunParkedStage, type RerunParkOptions } from './usageLimitRerun.js';
import { listFindings, recordFindings } from '../store/reviewFindings.js';
import { listUatFindings } from '../store/uatFindings.js';
import { listProcessRuns } from '../store/processRuns.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { Manifest } from '../manifest/types.js';
import type { GateRunInput } from '../store/gateRuns.js';
import { recordGateRun } from '../store/gateRuns.js';
import type { GitRunner } from '../integrations/git.js';
import { UsageLimitError } from '../agent/cliFailure.js';

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

    expect(res).toEqual({ kind: 'stopped' });
    // No lane ran, and the park stays OPEN for the op's own path.
    expect(adapter.runHeadless).not.toHaveBeenCalled();
    expect(listOpenParks(store, ticket.id)).toHaveLength(1);
    expect(listStageRuns(store, ticket.id)).toHaveLength(0);
  });

  it('re-runs a parked review target with override adapter and advances stage when clean', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-3', title: 'Test review rerun ticket' });
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
      reason: 'anthropic/claude-3-7-sonnet out of quota',
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

    const manifest: Manifest = {
      review: {
        requireIndependentSignal: false,
        findings: { blockingSeverity: 'high' },
      },
    } as unknown as Manifest;

    const buildAdapter = vi.fn(() => mockAdapter);
    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'codex',
      model: 'gpt-4o',
      buildAdapter,
      manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('ship');
    // The override adapter is built from the picked pair after the claim wins.
    expect(buildAdapter).toHaveBeenCalledWith('codex', 'gpt-4o');
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

    expect(res).toEqual({ kind: 'stopped' });
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
      gates: [],
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

  it('fails a UAT re-run whose tester could not execute when a sibling already blocks', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-EXEC-SIBLING', title: 'Test exec-failed sibling' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });
    const siblingObservation = {
      severity: 'high',
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
      gates: [],
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
      keptOutcome: priorKeptOutcome,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    // The picked core cannot even be spawned: the only evidence left is what a
    // sibling target already reported before the first park. Dropping it would
    // advance the ticket on an unexecuted check.
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockRejectedValue(new Error('spawn failed')),
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

    expect(res).toMatchObject({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('fix');
    expect(listRecoveryRounds(store, ticket.id)[0]).toMatchObject({
      triggerKind: 'blocking-tester-observations',
    });
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

    expect(res).toEqual({ kind: 'stopped' });
  });

  it('re-runs review and commits failed verdict when findings meet blockingSeverity', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-6', title: 'Test review blocking findings' });
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
      repo: 'web',
      command: 'npm',
      args: ['run', 'lint'],
    };

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic/claude-3-7-sonnet out of quota',
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
        raw: JSON.stringify([
          {
            severity: 'critical',
            title: 'SQL injection vulnerability',
            file: 'src/db.ts',
            line: 42,
            detail: 'Unescaped user input in raw query',
          },
        ]),
      }),
    };

    const manifest: Manifest = {
      review: {
        requireIndependentSignal: false,
        findings: { blockingSeverity: 'high' },
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

    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('fix');
  });

  it('re-runs uat and commits failed verdict when tester observations meet blockingSeverity', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-7', title: 'Test uat blocking observations' });
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
      gateName: 'test (web)',
      exitCode: 0,
      repo: 'web',
      command: 'npm',
      args: ['run', 'test'],
    };

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      kind: 'usage-limit',
      reason: 'anthropic/claude-3-7-sonnet out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [gateRun],
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
        raw: JSON.stringify([
          {
            severity: 'high',
            title: 'UI button does not submit',
            file: 'src/index.html',
            line: 10,
            detail: 'Clicking submit triggers nothing',
          },
        ]),
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

    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('fix');
  });

  it('review re-run does not duplicate existing sibling findings in review_findings table', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-REV-DEDUP', title: 'Test review dedup' });
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

    // Record an existing sibling finding for this ticket & attempt
    recordFindings(store, {
      ticketId: ticket.id,
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      findings: [
        {
          severity: 'medium',
          title: 'Existing sibling issue',
          detail: 'Sibling issue detail',
          repo: 'api',
          file: 'src/api.ts',
          line: 20,
          source: 'agent',
        },
      ],
    });

    const initialFindings = listFindings(store, ticket.id);
    expect(initialFindings).toHaveLength(1);

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [
        {
          gateName: 'test',
          exitCode: 0,
          command: 'npm',
          args: ['test'],
        },
      ],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({
          findings: 1,
          targets: [{ repo: 'api', status: 'completed', findings: 1 }],
        }),
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
      keptOutcome: JSON.stringify({
        findings: 1,
        targets: [{ repo: 'api', status: 'completed', findings: 1 }],
      }),
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    // New re-run target reports 1 finding
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({
        sessionId: '',
        verdict: null,
        raw: JSON.stringify([
          {
            severity: 'low',
            title: 'New web issue',
            file: 'src/web.ts',
            line: 5,
          },
        ]),
      }),
    };

    const manifest: Manifest = {
      review: {
        requireIndependentSignal: false,
        findings: { blockingSeverity: 'high' },
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

    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    const allFindings = listFindings(store, ticket.id);
    // Should contain exactly the 1 existing sibling finding + the 1 newly discovered finding, NOT duplicates
    expect(allFindings).toHaveLength(2);
    expect(allFindings.map((f) => f.title)).toEqual(['Existing sibling issue', 'New web issue']);
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
      command: 'npm',
      args: ['run', 'test'],
    };

    // Sibling target 'api' had a high severity blocking observation before the park
    const siblingObservation = {
      severity: 'high',
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
    expect(uatFindings).toHaveLength(1);
    expect(uatFindings[0]?.title).toBe('Sibling API endpoint returns 500');
  });

  it('review re-run with unreadable output marks process run execution-failed, logs notes to artifact, and parks capability-missing', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UNREADABLE-RERUN', title: 'Test review rerun unreadable' });
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
      repo: 'web',
      command: 'npm',
      args: ['run', 'lint'],
    };

    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic/claude-3-7-sonnet out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [gateRun],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: JSON.stringify({ findings: 0, targets: [{ repo: 'web', status: 'usage-limited', findings: 0 }] }),
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
      keptOutcome: JSON.stringify({ findings: 0, targets: [{ repo: 'web', status: 'usage-limited', findings: 0 }] }),
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    // Headless call returns unparseable prose (unreadable)
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockResolvedValue({
        sessionId: '',
        verdict: null,
        raw: 'This is not json at all, completely unstructured text.',
      }),
    };

    const manifest: Manifest = {
      review: {
        requireIndependentSignal: false,
        findings: { blockingSeverity: 'high' },
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

    expect(res).toMatchObject({
      kind: 'blocked',
      blocker: 'capability-missing',
    });

    // Check process run closed as execution-failed
    const processRuns = listProcessRuns(store, ticket.id);
    expect(processRuns.length).toBeGreaterThan(0);
    const reviewRun = processRuns.find((r) => r.processId === 'review');
    expect(reviewRun?.resultKind).toBe('execution-failed');

    // Check artifact was written and contains unreadable notes
    const artifactFiles = readdirSync(artifactDir);
    expect(artifactFiles.length).toBeGreaterThan(0);
    const logContent = readFileSync(join(artifactDir, artifactFiles[0]!), 'utf-8');
    expect(logContent).toContain('review findings lane unreadable output: web');
    expect(logContent).toContain('unreadable output from web — no findings could be read');
  });

  it('uat re-run runs the deterministic tester verifier and fails the stage on a nonzero exit (K11)', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-VERIFIER', title: 'Test uat verifier rerun' });
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
      gates: [],
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
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
    };

    const manifest: Manifest = {
      uat: {
        testerObservations: { blockingSeverity: 'none' },
        testerVerifier: { name: 'verify', kind: 'script', script: 'verify' },
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
      // The deterministic verifier: a completed nonzero exit MUST fail the stage,
      // exactly as the full UAT stage does.
      runVerifier: async () => ({ kind: 'completed', exitCode: 1, output: '' }),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    const rounds = listRecoveryRounds(store, ticket.id);
    expect(rounds[0]).toMatchObject({ triggerKind: 'tester-verifier-failure' });
  });

  it('uat re-run with a configured verifier but no runner parks capability-missing (K11)', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-VERIFIER-NORUN', title: 'Test uat verifier no runner' });
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
      gates: [],
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
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
    };

    const manifest: Manifest = {
      uat: {
        testerObservations: { blockingSeverity: 'none' },
        testerVerifier: { name: 'verify', kind: 'script', script: 'verify' },
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

    expect(res).toMatchObject({ kind: 'blocked', blocker: 'capability-missing' });
  });

  it('review re-run defaults requireIndependentSignal to true (R7) when the manifest omits it', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-R7-DEFAULT', title: 'Test R7 default' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' }); // -> review

    // The UAT stage asked the exact same question the review re-run will ask.
    recordGateRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T09:00:00.000Z',
      gates: [{ gateName: 'lint (web)', exitCode: 0, repo: 'web', command: 'npm', args: ['run', 'lint'] }],
    });

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
      gates: [{ gateName: 'lint (web)', exitCode: 0, repo: 'web', command: 'npm', args: ['run', 'lint'] }],
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
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
    };

    // NOTE: no `requireIndependentSignal` key — the re-run must default it TRUE,
    // exactly like `stages/review.ts`, and fail on a review that adds no signal.
    const manifest: Manifest = {
      review: { findings: { blockingSeverity: 'high' }, maxFixAttempts: 2 },
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

    expect(res).toEqual({ kind: 'advanced', next: 'fix' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('fix');
    // The R7 failure is NOT the findings lane's: it is a deterministic gate
    // failure and must be attributed to `gates` with no AI process, exactly as
    // `stages/review.ts`'s recoveryTriggerFor does — never to `review`/a
    // findings process run.
    const rounds = listRecoveryRounds(store, ticket.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      sourceProcessId: 'gates',
      sourceProcessRunId: null,
      triggerKind: 'gate-failure',
    });
  });

  it('review re-run threads git and the conformance artifacts into the findings lane', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-GIT-ARTIFACTS', title: 'Test git+artifacts' });
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
      gates: [{ gateName: 'lint (web)', exitCode: 0, repo: 'web', command: 'npm', args: ['run', 'lint'] }],
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
      runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
    };

    const gitCalls: string[] = [];
    const git: GitRunner = async (args) => {
      gitCalls.push(args.join(' '));
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    let artifactsLoaded = 0;

    const manifest: Manifest = {
      review: { requireIndependentSignal: false, findings: { blockingSeverity: 'high' } },
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
      git,
      loadArtifacts: async () => {
        artifactsLoaded += 1;
        return { intent: 'INTENT', spec: null, plan: null };
      },
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'ship' });
    // The lane attempts a worktree SNAPSHOT (never a committed-only range) …
    expect(gitCalls).toContain('rev-parse HEAD');
    // … and the conformance artifacts were loaded and judged.
    expect(artifactsLoaded).toBe(1);
  });

  it('review re-run that hits the quota again re-parks and closes its Review process run', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-RERUN-REPARK', title: 'Test review re-park' });
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

    const priorKeptOutcome = JSON.stringify({
      findings: 2,
      targets: [{ repo: 'api', status: 'unreadable', findings: 2 }],
    });
    parkGateStage(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      kind: 'usage-limit',
      reason: 'anthropic out of quota',
      runAt: '2026-10-13T10:00:00.000Z',
      gates: [{ gateName: 'lint (web)', exitCode: 0, repo: 'web', command: 'npm', args: ['run', 'lint'] }],
      stageRunId: parkedRunId,
      park: {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        lane: 'review',
        target: 'web',
        detail: 'Monthly quota exceeded',
        keptOutcome: priorKeptOutcome,
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
      keptOutcome: priorKeptOutcome,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    // The picked core is ALSO out of quota: the re-run must re-park, and the
    // Review process run it opened must not be left `running` forever.
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockRejectedValue(
        new UsageLimitError('Claude usage limit reached — out of credits.', {
          tool: 'Claude',
          provider: 'claude',
          model: 'claude-3-7-sonnet',
        }),
      ),
    };

    const manifest: Manifest = {
      review: { requireIndependentSignal: false, findings: { blockingSeverity: 'high' } },
    } as unknown as Manifest;

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      adapter: mockAdapter,
      manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toMatchObject({ kind: 'blocked', blocker: 'usage-limit' });
    const reviewRuns = listProcessRuns(store, ticket.id).filter((r) => r.processId === 'review');
    expect(reviewRuns.length).toBeGreaterThan(0);
    expect(reviewRuns.at(-1)?.resultKind).toBe('execution-failed');

    // The NEW park keeps the sibling the earlier park answered (api) and the
    // target this re-run touched (web), so a third pick still knows both.
    const reparked = listOpenParks(store, ticket.id)[0]!;
    const kept = JSON.parse(reparked.keptOutcome!);
    expect(kept.targets.map((t: { repo: string }) => t.repo).sort()).toEqual(['api', 'web']);
    expect(kept.findings).toBe(2);
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
      gates: [],
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
    const newRun = listStageRuns(store, ticket.id).find(
      (r) => r.stageKey === 'uat' && r.id !== parkedRunId,
    );
    expect(newRun?.status).toBe('finished');
    expect(newRun?.outcome).toBe('stopped');
  });

  it('uat re-run interrupted by its verifier closes the stage run it opened', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-VERIFIER-STOP', title: 'Test uat verifier stop' });
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
      gates: [],
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
      manifest: {
        uat: {
          testerObservations: { blockingSeverity: 'none' },
          testerVerifier: { name: 'verify', kind: 'script', script: 'verify' },
        },
      } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      runVerifier: async () => ({ kind: 'aborted', output: '' }),
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'stopped' });
    const newRun = listStageRuns(store, ticket.id).find(
      (r) => r.stageKey === 'uat' && r.id !== parkedRunId,
    );
    expect(newRun?.status).toBe('finished');
    expect(newRun?.outcome).toBe('stopped');
  });

  it('uat re-run that hits the quota again carries sibling observations into the new park', async () => {
    const ticket = createTicketFlow(store, { key: 'TEST-UAT-REPARK', title: 'Test uat re-park merge' });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' }); // -> uat

    const parkedRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'uat',
      attempt: 0,
      runAt: '2026-10-13T10:00:00.000Z',
      startedAt: '2026-10-13T10:00:00.000Z',
    });

    const siblingObservation = {
      severity: 'high',
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
      gates: [],
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
      keptOutcome: priorKeptOutcome,
      parkedAt: '2026-10-13T10:00:00.000Z',
      resolvedAt: null,
      resolution: null,
    };

    // The picked core is ALSO out of quota: the re-run re-parks, and the new
    // park must carry the sibling's observation forward — otherwise the next
    // pick/retry has nothing left of what the sibling already answered.
    const mockAdapter: AgentAdapter = {
      requiredBinary: 'fake',
      capabilities: { lifecycleEvents: false, resume: false },
      buildInteractiveCommand: () => { throw new Error('not used'); },
      runHeadless: vi.fn().mockRejectedValue(
        new UsageLimitError('Claude usage limit reached — out of credits.', {
          tool: 'Claude',
          provider: 'claude',
          model: 'claude-3-7-sonnet',
        }),
      ),
    };

    const res = await rerunParkedStage({
      store,
      parkRow: park,
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      adapter: mockAdapter,
      manifest: { uat: { maxFixAttempts: 2 } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toMatchObject({ kind: 'blocked', blocker: 'usage-limit' });
    const open = listOpenParks(store, ticket.id);
    expect(open).toHaveLength(1);
    const kept = JSON.parse(open[0]!.keptOutcome!) as {
      observations: unknown[];
      targets: unknown[];
    };
    expect(kept.observations).toContainEqual(siblingObservation);
    expect(kept.targets).toContainEqual({ repo: 'web', status: 'usage-limited', observations: 0 });

    // A THIRD park (the second re-run also hits the quota) must keep the same
    // sibling evidence. The merge input is this park's row, so a chain that
    // only looked at the original would silently drop it here.
    const second = await rerunParkedStage({
      store,
      parkRow: open[0]!,
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      adapter: mockAdapter,
      manifest: { uat: { maxFixAttempts: 2 } } as unknown as Manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:20:00.000Z',
    });
    expect(second).toMatchObject({ kind: 'blocked', blocker: 'usage-limit' });
    const openAgain = listOpenParks(store, ticket.id);
    expect(openAgain).toHaveLength(1);
    const keptAgain = JSON.parse(openAgain[0]!.keptOutcome!) as {
      observations: unknown[];
      targets: unknown[];
    };
    expect(keptAgain.observations).toContainEqual(siblingObservation);
    expect(keptAgain.targets).toContainEqual({ repo: 'web', status: 'usage-limited', observations: 0 });
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
      gates: [],
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

