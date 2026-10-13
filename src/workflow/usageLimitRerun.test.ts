import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../store/db.js';
import { createTicketFlow } from './stages/create.js';
import { insertOpenPark, type UsageLimitParkRow } from '../store/usageLimitParks.js';
import { parkGateStage } from '../store/stageBlocks.js';
import { listStageRuns, openStageRun } from '../store/stageRuns.js';
import { listRecoveryRounds } from '../store/recoveryRounds.js';
import { getTicket } from '../store/tickets.js';
import { transition } from './machine.js';
import { dismissUsageLimitPark, rerunParkedStage, type RerunParkOptions } from './usageLimitRerun.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { Manifest } from '../manifest/types.js';
import type { GateRunInput } from '../store/gateRuns.js';

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
    expect(getTicket(store, ticket.id).stageCurrent).toBe('ship');
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
      manifest,
      cwd: '/wt/web',
      artifactDir,
      now: () => '2026-10-13T10:10:00.000Z',
    });

    expect(res).toEqual({ kind: 'advanced', next: 'review' });
    expect(getTicket(store, ticket.id).stageCurrent).toBe('review');
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
});

