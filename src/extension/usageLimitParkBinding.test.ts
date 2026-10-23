import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentAdapter } from '../agent/adapter.js';
import type { ModelCatalog } from '../agent/modelCatalog.js';
import type { Manifest } from '../manifest/types.js';
import type { GitRunner } from '../integrations/git.js';

const {
  showQuickPick,
  mockedRunProcess,
  mockedDefaultGitRunner,
  mockedSpinTicket,
  mockedStopTicketServers,
} = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  mockedRunProcess: vi.fn(),
  mockedDefaultGitRunner: vi.fn(),
  mockedSpinTicket: vi.fn(),
  mockedStopTicketServers: vi.fn(),
}));

// The binding is the vscode half; the mock gives it a QuickPick surface.
vi.mock('vscode', () => ({ window: { showQuickPick } }));
// The PRODUCTION seams the binding defaults to are mocked so the default
// branches are observable without spawning a real process or a real git.
vi.mock('../workflow/gates/run.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runProcess: mockedRunProcess,
}));
vi.mock('../integrations/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  defaultGitRunner: mockedDefaultGitRunner,
}));
// The service seams a UAT re-run defaults to (D155) are mocked the same way:
// the default branches must start/stop the ticket's stack without a real boot.
vi.mock('../runtime/spin.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  spinTicket: mockedSpinTicket,
}));
vi.mock('../runtime/supervisor.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stopTicketServers: mockedStopTicketServers,
}));
// A pass-through spy on the conformance loader: the binding builds it once, so
// the test can read the options it was handed (the `projectId` fallback).
vi.mock('./reviewArtifactsBinding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reviewArtifactsBinding.js')>();
  return { ...actual, makeReviewArtifactsBinding: vi.fn(actual.makeReviewArtifactsBinding) };
});

import {
  createUsageLimitParkBinding,
  driverLockedRun,
  makeUsageLimitAgentModelPicker,
} from './usageLimitParkBinding.js';
import { makeReviewArtifactsBinding } from './reviewArtifactsBinding.js';
import { openStore } from '../store/db.js';
import { insertOpenPark, listOpenParks, listParks } from '../store/usageLimitParks.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { setStage, getStage } from '../store/stages.js';
import { stageBlock } from '../store/stageBlocks.js';
import { openStageRun } from '../store/stageRuns.js';
import { recordGateRun } from '../store/gateRuns.js';
import { updateTicketFields } from '../store/tickets.js';
import { transition } from '../workflow/machine.js';

const fakeCatalog: ModelCatalog = {
  claude: [{ id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', providers: ['claude'] }],
  codex: [{ id: 'gpt-4o', label: 'GPT-4o', providers: ['codex'] }],
  antigravity: [],
  opencode: [],
  opencode2: [],
};

/** A git runner that fails every command: the snapshot then degrades safely. */
const failingGit: GitRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'no git' });

/** An agent that answers the findings lane with an empty finding set. */
const fakeAdapter = {
  runHeadless: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' }),
} as unknown as AgentAdapter;

/** An agent that answers the UAT Tester with an empty observation set. */
const uatAdapter = {
  runHeadless: vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) }),
} as unknown as AgentAdapter;

beforeEach(() => {
  showQuickPick.mockReset();
  mockedRunProcess.mockReset();
  mockedDefaultGitRunner.mockReset();
  mockedDefaultGitRunner.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'no git' });
  mockedSpinTicket.mockReset();
  mockedSpinTicket.mockResolvedValue({ servers: [], reclaimedPids: [] });
  mockedStopTicketServers.mockReset();
  mockedStopTicketServers.mockResolvedValue(undefined);
  fakeAdapter.runHeadless = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
  uatAdapter.runHeadless = vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: JSON.stringify([]) });
});

describe('makeUsageLimitAgentModelPicker', () => {
  it('asks for a core then a model, and returns the picked pair', async () => {
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });

    const pick = makeUsageLimitAgentModelPicker(() => fakeCatalog);
    const picked = await pick('claude', 'claude-3-7-sonnet');

    expect(picked).toEqual({ provider: 'codex', model: 'gpt-4o' });
    expect(showQuickPick).toHaveBeenCalledTimes(2);

    const [coreItems, coreOptions] = showQuickPick.mock.calls[0]!;
    expect(coreOptions).toEqual({ title: 'Pick agent core' });
    // The parked core is tagged so the user can see which one ran out.
    const parked = coreItems.find((c: { id: string }) => c.id === 'claude');
    expect(parked.label).toContain('(usage limit)');
    const other = coreItems.find((c: { id: string }) => c.id === 'codex');
    expect(other.label).not.toContain('(usage limit)');

    const [modelItems, modelOptions] = showQuickPick.mock.calls[1]!;
    expect(modelOptions).toEqual({ title: 'Pick model' });
    const models = modelItems.map((m: { model: string | null }) => m.model);
    expect(models).toContain('gpt-4o');
  });

  it('returns undefined when the core pick is cancelled', async () => {
    showQuickPick.mockResolvedValueOnce(undefined);

    const pick = makeUsageLimitAgentModelPicker(() => fakeCatalog);
    expect(await pick('claude', null)).toBeUndefined();
    expect(showQuickPick).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when the model pick is cancelled', async () => {
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce(undefined);

    const pick = makeUsageLimitAgentModelPicker(() => fakeCatalog);
    expect(await pick('claude', null)).toBeUndefined();
    expect(showQuickPick).toHaveBeenCalledTimes(2);
  });
});

describe('driverLockedRun', () => {
  it('runs under the lock with the run signal and releases it afterwards', async () => {
    const stop = new AbortController();
    const driver = {
      begin: vi.fn().mockReturnValue(true),
      end: vi.fn(),
      signalFor: vi.fn().mockReturnValue(stop.signal),
    };
    const run = vi.fn(async (signal?: AbortSignal) => signal);

    const result = await driverLockedRun(driver)(7, run);

    expect(result).toBe(stop.signal);
    expect(driver.begin).toHaveBeenCalledWith(7);
    expect(run).toHaveBeenCalledWith(stop.signal);
    expect(driver.end).toHaveBeenCalledWith(7);
  });

  it('does not run when the ticket already has a driver in flight', async () => {
    const driver = {
      begin: vi.fn().mockReturnValue(false),
      end: vi.fn(),
      signalFor: vi.fn(),
    };
    const run = vi.fn();

    expect(await driverLockedRun(driver)(7, run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(driver.end).not.toHaveBeenCalled();
  });
});

describe('createUsageLimitParkBinding', () => {
  /** The parked target's worktree row: the re-run resolves trees through it. */
  function registerWorktree(store: ReturnType<typeof openStore>, ticketId: number): void {
    store.db
      .prepare('INSERT INTO worktrees (ticket_id, repo, path, branch, base_ref) VALUES (?, ?, ?, ?, ?)')
      .run(ticketId, 'repo', '/tmp', 'karst/repo', 'develop');
  }

  /**
   * The gate rows a UAT park stands in for. A UAT park only happens AFTER the
   * gates (the Tester runs last), so the re-run aggregates that evidence — with
   * none it correctly blocks `nothing-to-run` (R3) and never reaches the seam
   * a test is exercising.
   */
  function seedUatGateEvidence(store: ReturnType<typeof openStore>, ticketId: number): number {
    const runAt = '2026-10-14T00:00:00.000Z';
    const stageRunId = openStageRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 0,
      runAt,
      startedAt: runAt,
    });
    recordGateRun(store, {
      ticketId,
      stageKey: 'uat',
      attempt: 0,
      runAt,
      stageRunId,
      gates: [
        {
          gateName: 'test (repo)',
          exitCode: 0,
          startedAt: runAt,
          endedAt: runAt,
          repo: 'repo',
          command: 'npm',
          args: ['test'],
        },
      ],
    });
    return stageRunId;
  }

  function setup() {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-1', title: 'Test ticket' });
    registerWorktree(store, ticket.id);
    // The re-run's passed verdict advances the ticket: it must BE at review.
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    transition(store, ticket.id, 'uat', { kind: 'passed' });
    // The intent reaches the re-run's prompt ONLY through the artifacts loader
    // — with the default one, the conformance block appears.
    updateTicketFields(store, ticket.id, { intent: 'THE INTENT' });
    // The re-run re-asks the LANE and reuses the parked run's gate evidence; a
    // park with no gate rows would re-park `nothing-to-run` (R3), which is not
    // the passing path these fixtures mean to exercise.
    const runAt = '2026-10-14T00:00:00.000Z';
    const stageRunId = openStageRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt,
      startedAt: runAt,
    });
    recordGateRun(store, {
      ticketId: ticket.id,
      stageKey: 'review',
      attempt: 0,
      runAt,
      stageRunId,
      gates: [
        {
          gateName: 'lint (repo)',
          exitCode: 0,
          startedAt: runAt,
          endedAt: runAt,
          repo: 'repo',
          command: 'npm',
          args: ['run', 'lint'],
        },
      ],
    });
    setStage(store, ticket.id, 'review', {
      blockedKind: 'usage-limit',
      blockedReason: 'out of credits',
      blockedAt: '2026-10-14T00:00:00Z',
    });
    insertOpenPark(store, {
      ticketId: ticket.id,
      stage: 'review',
      kind: 'stage-block',
      lane: 'review',
      target: 'repo',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      detail: 'out of credits',
      stageRunId,
      keptOutcome: null,
    });
    return { store, ticket };
  }

  function binding(store: ReturnType<typeof openStore>, ticketId: number, extra: Partial<Parameters<typeof createUsageLimitParkBinding>[0]> = {}) {
    return createUsageLimitParkBinding({
      store,
      notify: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      catalog: () => fakeCatalog,
      manifest: () => undefined,
      redrive: vi.fn(),
      refresh: vi.fn(),
      adapterFor: vi.fn().mockReturnValue(fakeAdapter),
      artifactDirFor: (id) => `/tmp/karst-artifacts/${id}`,
      cwd: () => '/tmp',
      // The host names both service seams (they are required): a raw host
      // default is what booted a host stack under a sandboxed ticket.
      spin: mockedSpinTicket,
      stopServers: mockedStopTicketServers,
      ...extra,
    });
  }

  it('re-runs the parked lane with the picked core and model', async () => {
    const { store, ticket } = setup();
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
    const adapterFor = vi.fn().mockReturnValue(fakeAdapter);
    const redrive = vi.fn();
    const refresh = vi.fn();

    const actions = binding(store, ticket.id, { adapterFor, redrive, refresh, git: failingGit }).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'review');

    expect(adapterFor).toHaveBeenCalledWith('codex', 'gpt-4o');
    expect(fakeAdapter.runHeadless).toHaveBeenCalled();
    // The picker asks for a core, then a model — each with its own title.
    expect(showQuickPick.mock.calls[0]?.[1]).toEqual({ title: 'Pick agent core' });
    expect(showQuickPick.mock.calls[1]?.[1]).toEqual({ title: 'Pick model' });
    // The DEFAULT artifacts loader ran: the ticket's intent reaches the prompt
    // as the conformance block, so the re-run judges the change against it.
    expect(fakeAdapter.runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('fulfils the ticket'),
      }),
    );
    // The re-run writes its artifact under the TICKET's artifact dir.
    expect(getStage(store, ticket.id, 'review')?.artifactPath).toContain('/tmp/karst-artifacts');
    expect(listOpenParks(store, ticket.id)).toHaveLength(0);
    expect(redrive).toHaveBeenCalledWith(ticket.id);
    expect(refresh).toHaveBeenCalledWith(ticket.id);
  });

  it('retries with the ORIGINAL core and model, without asking the user', async () => {
    const { store, ticket } = setup();
    const adapterFor = vi.fn().mockReturnValue(fakeAdapter);

    const actions = binding(store, ticket.id, { adapterFor, git: failingGit }).forTicket(ticket.id);
    await actions.usageLimitRetry(ticket.id, 'review');

    expect(adapterFor).toHaveBeenCalledWith('claude', 'claude-3-7-sonnet');
    expect(showQuickPick).not.toHaveBeenCalled();
    expect(listParks(store, ticket.id)[0]?.resolution).toBe('retry');
  });

  it('dismisses without running an agent', async () => {
    const { store, ticket } = setup();
    store.db.prepare("UPDATE tickets SET stage_current = 'review' WHERE id = ?").run(ticket.id);
    const adapterFor = vi.fn().mockReturnValue(fakeAdapter);

    const actions = binding(store, ticket.id, { adapterFor, git: failingGit }).forTicket(ticket.id);
    await actions.usageLimitDismiss(ticket.id, 'review');

    expect(adapterFor).not.toHaveBeenCalled();
    expect(fakeAdapter.runHeadless).not.toHaveBeenCalled();
    expect(listParks(store, ticket.id)[0]?.resolution).toBe('dismiss');
  });

  it('runs the action under the driver single-flight wrapper with its Stop signal', async () => {
    const { store, ticket } = setup();
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
    const stop = new AbortController();
    type DriverRun = NonNullable<Parameters<typeof createUsageLimitParkBinding>[0]['withDriverRun']>;
    const withDriverRunSpy = vi.fn(
      async (_id: number, run: (signal?: AbortSignal) => Promise<unknown>) => run(stop.signal),
    );

    const actions = binding(store, ticket.id, {
      withDriverRun: withDriverRunSpy as unknown as DriverRun,
      git: failingGit,
    }).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'review');

    expect(withDriverRunSpy).toHaveBeenCalledWith(ticket.id, expect.any(Function));
    expect(fakeAdapter.runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({ signal: stop.signal }),
    );
  });

  it('reads conformance artifacts through the current project when the ticket has none', () => {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-PROJECT', title: 'Project fallback' });

    // NO `loadArtifacts` seam: the binding builds the default loader, which the
    // STAGE hands `currentProject()?.id` — a re-run must not silently judge the
    // change with no spec/plan while the stage it replaces had both.
    binding(store, ticket.id, { projectId: () => 77 });

    const options = vi.mocked(makeReviewArtifactsBinding).mock.calls.at(-1)?.[0];
    expect(options?.fallbackProjectId()).toBe(77);
  });

  it('defaults the git runner to the production seam', async () => {    const { store, ticket } = setup();
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });

    // NO `git` seam: the binding must fall back to the production runner.
    const actions = binding(store, ticket.id).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'review');

    expect(mockedDefaultGitRunner).toHaveBeenCalled();
  });

  it('defaults the verifier runner to the production seam', async () => {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-2', title: 'UAT ticket' });
    registerWorktree(store, ticket.id);
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    setStage(store, ticket.id, 'uat', {
      blockedKind: 'usage-limit',
      blockedReason: 'out of credits',
      blockedAt: '2026-10-14T00:00:00Z',
    });
    insertOpenPark(store, {
      ticketId: ticket.id,
      stage: 'uat',
      stageRunId: seedUatGateEvidence(store, ticket.id),
      kind: 'stage-block',
      lane: 'uat',
      target: 'repo',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      detail: 'out of credits',
      keptOutcome: null,
    });
    mockedRunProcess.mockResolvedValue({ kind: 'completed', exitCode: 0, stdout: '', stderr: '' });
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
    const manifest = {
      uat: { testerVerifier: { name: 'verify', kind: 'script', script: 'verify' } },
    } as unknown as Manifest;

    // NO `runVerifier` seam: the binding must fall back to the production runner.
    const actions = binding(store, ticket.id, {
      manifest: () => manifest,
      git: failingGit,
      adapterFor: vi.fn().mockReturnValue(uatAdapter),
    }).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'uat');

    expect(mockedRunProcess).toHaveBeenCalled();
  });

  it('runs the UAT verifier through the ticket sandbox gate runner when the host has one', async () => {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-VERIFIER-SANDBOX', title: 'UAT ticket' });
    registerWorktree(store, ticket.id);
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    const stageRunId = seedUatGateEvidence(store, ticket.id);
    setStage(store, ticket.id, 'uat', {
      blockedKind: 'usage-limit',
      blockedReason: 'out of credits',
      blockedAt: '2026-10-14T00:00:00Z',
    });
    insertOpenPark(store, {
      ticketId: ticket.id,
      stage: 'uat',
      stageRunId,
      kind: 'stage-block',
      lane: 'uat',
      target: 'repo',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      detail: 'out of credits',
      keptOutcome: null,
    });
    const sandboxRunner = vi
      .fn()
      .mockResolvedValue({ kind: 'completed', exitCode: 0, stdout: '', stderr: '' });
    const hostRunner = vi.fn();
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
    const manifest = {
      uat: { testerVerifier: { name: 'verify', kind: 'script', script: 'verify' } },
    } as unknown as Manifest;

    // The host names the ticket's SANDBOX gate runner (AC-32). A raw host
    // `runProcess` under a sandbox row would run the verifier against a copy
    // the sandbox's toolchain may not have — pass the sandbox seam through.
    const actions = binding(store, ticket.id, {
      manifest: () => manifest,
      git: failingGit,
      adapterFor: vi.fn().mockReturnValue(uatAdapter),
      runVerifier: hostRunner,
      gateProcessFor: () => sandboxRunner,
    }).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'uat');

    expect(sandboxRunner).toHaveBeenCalled();
    expect(hostRunner).not.toHaveBeenCalled();
    expect(mockedRunProcess).not.toHaveBeenCalled();
  });

  it('parks the driver sandbox blockers when the host preflight refuses', async () => {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-SANDBOX-REFUSAL', title: 'UAT ticket' });
    registerWorktree(store, ticket.id);
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    const stageRunId = seedUatGateEvidence(store, ticket.id);
    setStage(store, ticket.id, 'uat', {
      blockedKind: 'usage-limit',
      blockedReason: 'out of credits',
      blockedAt: '2026-10-14T00:00:00Z',
    });
    insertOpenPark(store, {
      ticketId: ticket.id,
      stage: 'uat',
      stageRunId,
      kind: 'stage-block',
      lane: 'uat',
      target: 'repo',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      detail: 'out of credits',
      keptOutcome: null,
    });
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
    const syncSandbox = vi.fn(async () => ({ ok: true as const }));

    const actions = binding(store, ticket.id, {
      manifest: () => ({ uat: { testerObservations: { blockingSeverity: 'none' } } }) as unknown as Manifest,
      git: failingGit,
      adapterFor: vi.fn().mockReturnValue(uatAdapter),
      syncSandbox,
      provisionSandbox: async () => ({ ok: false, reason: 'docker image missing' }),
    }).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'uat');

    // The host's preflight reached the re-run: a refusal parks the stage and
    // the lane never runs against the host tree.
    expect(syncSandbox).toHaveBeenCalledWith(ticket.id);
    expect(stageBlock(store, ticket.id, 'uat')).toMatchObject({ kind: 'sandbox-setup' });
    expect(uatAdapter.runHeadless).not.toHaveBeenCalled();
  });

  it('boots and reaps a UAT re-run through the HOST-provided service seams', async () => {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-SPIN', title: 'UAT ticket' });
    registerWorktree(store, ticket.id);
    updateTicketFields(store, ticket.id, { selectedRepos: ['repo'] });
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    setStage(store, ticket.id, 'uat', {
      blockedKind: 'usage-limit',
      blockedReason: 'out of credits',
      blockedAt: '2026-10-14T00:00:00Z',
    });
    insertOpenPark(store, {
      ticketId: ticket.id,
      stage: 'uat',
      stageRunId: seedUatGateEvidence(store, ticket.id),
      kind: 'stage-block',
      lane: 'uat',
      target: 'repo',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      detail: 'out of credits',
      keptOutcome: null,
    });
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
    const manifest = {
      repositories: {
        repo: { repoPath: '/tmp', hasMigrations: false, service: { start: 'npm run dev' } },
      },
      uat: { testerObservations: { blockingSeverity: 'none' } },
    } as unknown as Manifest;

    // The HOST's seams — for a sandboxed ticket they boot the sandbox stack
    // (parent synced first) and reap it through the sandbox's own bookkeeping.
    // The binding must use exactly these, never a raw host fallback.
    const spin = vi.fn().mockResolvedValue({ ok: true });
    const stopServers = vi.fn().mockResolvedValue(undefined);
    const actions = binding(store, ticket.id, {
      manifest: () => manifest,
      git: failingGit,
      adapterFor: vi.fn().mockReturnValue(uatAdapter),
      spin: spin as unknown as Parameters<typeof createUsageLimitParkBinding>[0]['spin'],
      stopServers:
        stopServers as unknown as Parameters<typeof createUsageLimitParkBinding>[0]['stopServers'],
    }).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'uat');

    expect(spin).toHaveBeenCalledWith(store, manifest, ticket.id, ['repo'], expect.anything());
    expect(stopServers).toHaveBeenCalledWith(store, ticket.id);
    // The raw host defaults must not be reached when the host passed its own.
    expect(mockedSpinTicket).not.toHaveBeenCalled();
    expect(mockedStopTicketServers).not.toHaveBeenCalled();
  });

  it('threads the stage context pointer into a UAT re-run prompt', async () => {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-CTX', title: 'UAT ticket' });
    registerWorktree(store, ticket.id);
    transition(store, ticket.id, 'scope', { kind: 'passed' });
    transition(store, ticket.id, 'impl', { kind: 'passed' });
    setStage(store, ticket.id, 'uat', {
      blockedKind: 'usage-limit',
      blockedReason: 'out of credits',
      blockedAt: '2026-10-14T00:00:00Z',
    });
    insertOpenPark(store, {
      ticketId: ticket.id,
      stage: 'uat',
      stageRunId: seedUatGateEvidence(store, ticket.id),
      kind: 'stage-block',
      lane: 'uat',
      target: 'repo',
      provider: 'claude',
      model: 'claude-3-7-sonnet',
      detail: 'out of credits',
      keptOutcome: null,
    });
    showQuickPick.mockResolvedValueOnce({ id: 'codex', label: 'Codex' });
    showQuickPick.mockResolvedValueOnce({ model: 'gpt-4o', label: 'GPT-4o', description: 'gpt-4o' });
    const runHeadless = vi.fn().mockResolvedValue({ sessionId: '', verdict: null, raw: '[]' });

    const actions = binding(store, ticket.id, {
      git: failingGit,
      contextCommand: 'karst context',
      adapterFor: vi.fn().mockReturnValue({ ...uatAdapter, runHeadless }),
    }).forTicket(ticket.id);
    await actions.usageLimitPick(ticket.id, 'uat');

    expect(runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Run exactly: karst context TEST-CTX --for tester --md'),
      }),
    );
  });
});
