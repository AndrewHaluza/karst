import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentAdapter } from '../agent/adapter.js';
import type { ModelCatalog } from '../agent/modelCatalog.js';
import type { Manifest } from '../manifest/types.js';
import type { GitRunner } from '../integrations/git.js';

const { showQuickPick, mockedRunProcess, mockedDefaultGitRunner } = vi.hoisted(() => ({
  showQuickPick: vi.fn(),
  mockedRunProcess: vi.fn(),
  mockedDefaultGitRunner: vi.fn(),
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

import { createUsageLimitParkBinding, makeUsageLimitAgentModelPicker } from './usageLimitParkBinding.js';
import { openStore } from '../store/db.js';
import { insertOpenPark, listOpenParks, listParks } from '../store/usageLimitParks.js';
import { createTicketFlow } from '../workflow/stages/create.js';
import { setStage, getStage } from '../store/stages.js';
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

describe('createUsageLimitParkBinding', () => {
  function setup() {
    const store = openStore(':memory:');
    const ticket = createTicketFlow(store, { key: 'TEST-1', title: 'Test ticket' });
    // The intent reaches the re-run's prompt ONLY through the artifacts loader
    // — with the default one, the conformance block appears.
    updateTicketFields(store, ticket.id, { intent: 'THE INTENT' });
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

  it('defaults the git runner to the production seam', async () => {
    const { store, ticket } = setup();
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
});
