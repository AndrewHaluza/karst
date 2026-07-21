import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, getTicket, getTicketByKey, listTickets, updateTicketOnboarding } from '../../store/tickets.js';
import {
  buildOnboardingActions,
  type OnboardingActionsDeps,
  type StartTicketResult,
} from './actions.js';
import type { OnboardingActionsCtx } from './panel.js';
import type { OnboardingHostMessage } from './messages.js';
import type { ContextBrief, TicketingProvider } from '../../integrations/ticketing.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { Manifest, ServiceDef } from '../../manifest/types.js';

function svc(over: Partial<ServiceDef> = {}): ServiceDef {
  return {
    repoPath: '/repo',
    start: 'x',
    ports: [{ name: 'port', env: 'PORT', default: 3000 }],
    dependsOn: [],
    hasMigrations: false,
    ...over,
  };
}

const MANIFEST: Manifest = {
  host: 'localhost',
  portRange: [4000, 4100],
  baselineBranch: 'develop',
  services: { fe: svc({ signals: ['ui'] }), be: svc({ signals: ['api'] }) },
  approaches: [
    {
      id: 'rpi',
      label: 'RPI',
      recommended: true,
      source: { type: 'git', repo: 'a/b', ref: 'main', include: ['.claude/agents'] },
    },
  ],
  agents: {},
  worktreePathDisplay: 'absolute',
};

const BRIEF: ContextBrief = {
  title: 'Login modal',
  description: 'ui bug',
  tags: ['frontend'],
  comments: [],
  attachments: [],
};

function fakeProvider(over: Partial<TicketingProvider> = {}): TicketingProvider {
  return {
    updateStatus: vi.fn(),
    fetchTicket: vi.fn(async () => BRIEF),
    ...over,
  };
}

function fakeAdapter(): AgentAdapter {
  return {
    requiredBinary: 'claude',
    capabilities: { httpHooks: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'c', args: [], env: {} }),
    runHeadless: vi.fn(async () => ({ sessionId: 's', verdict: null, raw: '["x","y"]' })),
  };
}

/**
 * A ctx with a mutable ticket binding (mirrors the real panel ctx). Records
 * posts; `bindTicket` flips it to edit mode so persist-on-fetch can rebind a
 * create panel to its new draft.
 */
function mkCtx(ticketId?: number): OnboardingActionsCtx & {
  posted: OnboardingHostMessage[];
  pushes: number;
  closes: number;
} {
  let boundId = ticketId;
  let pushes = 0;
  let closes = 0;
  const posted: OnboardingHostMessage[] = [];
  const ctx = {
    posted,
    get pushes() {
      return pushes;
    },
    get closes() {
      return closes;
    },
    post: (m: OnboardingHostMessage) => posted.push(m),
    pushState: () => {
      pushes += 1;
    },
    get ticketId() {
      return boundId;
    },
    get mode(): 'create' | 'edit' {
      return boundId === undefined ? 'create' : 'edit';
    },
    bindTicket: (id: number) => {
      boundId = id;
    },
    close: () => {
      closes += 1;
    },
  };
  return ctx as OnboardingActionsCtx & {
    posted: OnboardingHostMessage[];
    pushes: number;
    closes: number;
  };
}

describe('buildOnboardingActions', () => {
  let store: Store;
  let deps: OnboardingActionsDeps;
  let onCreated: ReturnType<typeof vi.fn<() => void>>;
  let writeSignals: ReturnType<typeof vi.fn<(p: string, s: string, sig: string[]) => void>>;
  let reloadManifest: ReturnType<typeof vi.fn<() => void>>;
  let listInstalledIds: ReturnType<typeof vi.fn<() => string[]>>;
  let startTicket: ReturnType<typeof vi.fn<(id: number) => Promise<StartTicketResult>>>;
  let openDashboard: ReturnType<typeof vi.fn<(id: number) => void>>;

  beforeEach(() => {
    store = openStore(':memory:');
    onCreated = vi.fn<() => void>();
    writeSignals = vi.fn<(p: string, s: string, sig: string[]) => void>();
    reloadManifest = vi.fn<() => void>();
    listInstalledIds = vi.fn<() => string[]>(() => ['rpi']);
    startTicket = vi.fn<(id: number) => Promise<StartTicketResult>>(async () => ({ ok: true }));
    openDashboard = vi.fn<(id: number) => void>();
    deps = {
      store,
      manifest: MANIFEST,
      manifestPath: '/tmp/karst.yml',
      provider: fakeProvider(),
      adapter: fakeAdapter(),
      onChange: onCreated,
      writeSignals,
      reloadManifest,
      listInstalledIds,
      startTicket,
      openDashboard,
    };
  });

  it('fetchSource posts the brief and persists it for an existing ticket', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m),
      pushState: () => {},
      mode: 'edit',
      ticketId: t.id,
      bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.fetchSource('CU-9');
    // busy on/off + brief posted
    expect(posted.find((m) => m.type === 'brief')).toBeTruthy();
    expect(getTicket(store, t.id).brief).toContain('Login modal');
  });

  it('fetchSource in create mode persists a draft, binds it, and scores repos', async () => {
    const ctx = mkCtx(); // create mode: no ticket yet
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.fetchSource('CU-42');

    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1); // exactly one draft created
    const draft = tickets[0]!;
    expect(ctx.ticketId).toBe(draft.id); // panel rebound to the draft
    expect(ctx.mode).toBe('edit');
    expect(draft.key).toBe('CU-42'); // seeded from the ref
    expect(draft.title).toBe('Login modal'); // seeded from brief.title
    expect(getTicket(store, draft.id).brief).toContain('Login modal');
    // 'fe' has signal 'ui', which appears in the brief description → scored + selected.
    expect(draft.selectedRepos).toContain('fe');
    expect(onCreated).toHaveBeenCalled();
    expect(ctx.posted.find((m) => m.type === 'brief')).toBeTruthy();
  });

  it('fetchSource twice on one create panel updates the same draft, no duplicate', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.fetchSource('CU-42');
    await actions.fetchSource('CU-99');

    expect(listTickets(store)).toHaveLength(1); // still one ticket
  });

  it('fetchSource does not bind the panel when create fails', async () => {
    deps.provider = fakeProvider({
      fetchTicket: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.fetchSource('CU-42');
    expect(ctx.ticketId).toBeUndefined(); // half-bound state never happens
    expect(listTickets(store)).toHaveLength(0);
  });

  it('fetchSource posts an error when the provider rejects', async () => {
    deps.provider = fakeProvider({ fetchTicket: vi.fn(async () => { throw new Error('boom'); }) });
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.fetchSource('CU-9');
    const err = posted.find((m) => m.type === 'error') as { message: string } | undefined;
    expect(err?.message).toMatch(/boom/);
  });

  it('suggestSignals posts the suggested words for a service', async () => {
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.suggestSignals('fe');
    const s = posted.find((m) => m.type === 'signals-suggested') as
      | { service: string; signals: string[] }
      | undefined;
    expect(s?.service).toBe('fe');
    expect(s?.signals).toEqual(['x', 'y']);
  });

  it('saveSignals writes to the manifest and re-pushes state', async () => {
    let pushes = 0;
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => (pushes += 1), mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    actions.saveSignals('be', ['api', 'endpoint']);
    expect(deps.writeSignals).toHaveBeenCalledWith('/tmp/karst.yml', 'be', ['api', 'endpoint']);
    expect(pushes).toBeGreaterThan(0);
  });

  it('saveSignals reloads the manifest BEFORE re-pushing state (so the gate clears)', async () => {
    const order: string[] = [];
    reloadManifest.mockImplementation(() => order.push('reload'));
    const ctx: OnboardingActionsCtx = {
      post: () => {},
      pushState: () => order.push('push'),
      mode: 'create',
      bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    actions.saveSignals('be', ['api']);
    expect(reloadManifest).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reload', 'push']);
  });

  it('saveSignals does not reload or push when the write throws', async () => {
    writeSignals.mockImplementation(() => { throw new Error('bad yml'); });
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    actions.saveSignals('be', ['api']);
    expect(reloadManifest).not.toHaveBeenCalled();
    expect((posted.find((m) => m.type === 'error') as { message: string }).message).toMatch(/bad yml/);
  });

  it('submit in create mode creates a ticket with the entered fields', async () => {
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({ key: 'NEW-1', title: 'a title', description: 'a desc', repos: ['fe'], approach: 'rpi', agent: null, model: null });
    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.key).toBe('NEW-1');
    expect(tickets[0]!.description).toBe('a desc');
    expect(onCreated).toHaveBeenCalled();
    // Finish hands the just-created ticket off to the workflow.
    expect(startTicket).toHaveBeenCalledWith(tickets[0]!.id);
  });

  it('submit persists the create-mode repo + approach selection before starting', async () => {
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({ key: 'NEW-R', title: 't', description: '', repos: ['fe', 'be'], approach: 'rpi', agent: null, model: null });
    const t = getTicket(store, listTickets(store)[0]!.id);
    expect(t.selectedRepos).toEqual(['fe', 'be']);
    expect(t.approach).toBe('rpi');
  });

  it('submit persists the per-ticket model when chosen, and leaves it null on inherit', async () => {
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({ key: 'NEW-M', title: 't', description: '', repos: [], approach: null, agent: null, model: 'claude-opus-4-8' });
    expect(getTicket(store, listTickets(store)[0]!.id).model).toBe('claude-opus-4-8');
  });

  it('submit with a null model leaves the ticket inheriting the default', async () => {
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({ key: 'NEW-I', title: 't', description: '', repos: [], approach: null, agent: null, model: null });
    expect(getTicket(store, listTickets(store)[0]!.id).model).toBeNull();
  });

  it('submit persists the agent selection when present', async () => {
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-A', title: 't', description: '', repos: [], approach: null, agent: 'reviewer', model: null,
    });
    const t = getTicket(store, listTickets(store)[0]!.id);
    expect(t.agent).toBe('reviewer');
  });

  it('submit binds the create panel to the new draft before starting it', async () => {
    let bound: number | undefined;
    const ctx: OnboardingActionsCtx = {
      post: () => {}, pushState: () => {}, mode: 'create',
      bindTicket: (id) => { bound = id; },
      close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({ key: 'NEW-2', title: 't', description: '', repos: [], approach: null, agent: null, model: null });
    const id = listTickets(store)[0]!.id;
    expect(bound).toBe(id);
    expect(startTicket).toHaveBeenCalledWith(id);
  });

  it('submit in edit mode updates key/title of the existing ticket', async () => {
    const t = createTicket(store, { key: 'OLD', title: 'old' });
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({ key: 'NEW', title: 'new', description: '', repos: [], approach: null, agent: null, model: null });
    const reloaded = getTicket(store, t.id);
    expect(reloaded.key).toBe('NEW');
    expect(reloaded.title).toBe('new');
    expect(listTickets(store)).toHaveLength(1); // no duplicate created
    expect(startTicket).toHaveBeenCalledWith(t.id);
  });

  it('submit hands off to the dashboard and closes the panel once the ticket starts', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-D', title: 't', description: '', repos: ['fe'], approach: 'rpi', agent: null, model: null,
    });

    const id = listTickets(store)[0]!.id;
    expect(openDashboard).toHaveBeenCalledWith(id);
    expect(ctx.closes).toBe(1);
    // Busy brackets the start so the button can't be double-fired mid-launch,
    // and clears before the panel goes away.
    expect(ctx.posted[0]).toEqual({ type: 'busy', what: 'submit', on: true });
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'submit', on: false });
  });

  it('submit opens the dashboard only after startTicket resolves', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    startTicket.mockImplementation(async () => {
      order.push('start');
      await new Promise<void>((r) => (release = r));
      return { ok: true };
    });
    openDashboard.mockImplementation(() => order.push('dashboard'));
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    const done = actions.submit({
      key: 'NEW-O', title: 't', description: '', repos: ['fe'], approach: null, agent: null, model: null,
    });
    expect(order).toEqual(['start']); // still launching — panel stays put
    expect(ctx.closes).toBe(0);
    release!();
    await done;
    expect(order).toEqual(['start', 'dashboard']);
  });

  it('submit keeps the panel open and posts the reason when the ticket cannot start', async () => {
    startTicket.mockResolvedValue({ ok: false, message: 'Select at least one repository.' });
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-F', title: 't', description: '', repos: [], approach: null, agent: null, model: null,
    });

    expect(ctx.posted.find((m) => m.type === 'error')).toEqual({
      type: 'error',
      message: 'Select at least one repository.',
    });
    expect(openDashboard).not.toHaveBeenCalled();
    expect(ctx.closes).toBe(0);
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'submit', on: false });
    // The ticket itself was still created — the user can retry from the panel.
    expect(listTickets(store)).toHaveLength(1);
  });

  it('submit posts the error and keeps the panel open when startTicket throws', async () => {
    startTicket.mockRejectedValue(new Error('worktree exists'));
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-T', title: 't', description: '', repos: ['fe'], approach: null, agent: null, model: null,
    });

    expect((ctx.posted.find((m) => m.type === 'error') as { message: string }).message).toMatch(
      /worktree exists/,
    );
    expect(ctx.closes).toBe(0);
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'submit', on: false });
  });

  it('submit in edit mode also hands off to the dashboard and closes the panel', async () => {
    const t = createTicket(store, { key: 'OLD-D', title: 'old' });
    const ctx = mkCtx(t.id);
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.submit({
      key: 'OLD-D', title: 'new', description: '', repos: ['fe'], approach: null, agent: null, model: null,
    });

    expect(openDashboard).toHaveBeenCalledWith(t.id);
    expect(ctx.closes).toBe(1);
  });

  it('save in create mode persists a ticket WITHOUT starting it', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({
      key: 'DRAFT-1', title: 'a draft', description: 'no run yet', repos: [], approach: null, agent: null, model: null,
    });

    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1);
    const t = tickets[0]!;
    expect(t.key).toBe('DRAFT-1');
    expect(t.title).toBe('a draft');
    expect(t.description).toBe('no run yet');
    // run-less: never advanced past the seed stage, no session, no worktrees
    expect(t.stageCurrent).toBe('scope');
    expect(t.agentState).toBe('none');
    expect(t.sessionId).toBeNull();
    expect(startTicket).not.toHaveBeenCalled();
    expect(openDashboard).not.toHaveBeenCalled();
    expect(ctx.closes).toBe(0); // panel stays open
    expect(onCreated).toHaveBeenCalled();
  });

  it('save persists repos/approach/agent/model exactly like submit does', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({
      key: 'DRAFT-2', title: 't', description: '', repos: ['fe', 'be'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8',
    });

    const t = getTicket(store, listTickets(store)[0]!.id);
    expect(t.selectedRepos).toEqual(['fe', 'be']);
    expect(t.approach).toBe('rpi');
    expect(t.agent).toBe('reviewer');
    expect(t.model).toBe('claude-opus-4-8');
  });

  it('save binds the create panel to the new draft (retrievable afterward)', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-3', title: 't', description: '', repos: [], approach: null, agent: null, model: null });

    const id = listTickets(store)[0]!.id;
    expect(ctx.ticketId).toBe(id);
    expect(getTicketByKey(store, 'DRAFT-3')?.id).toBe(id);
  });

  it('save in edit mode updates the existing ticket WITHOUT starting it, no duplicate', async () => {
    const t = createTicket(store, { key: 'OLD-S', title: 'old' });
    const ctx = mkCtx(t.id);
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'NEW-S', title: 'new title', description: '', repos: [], approach: null, agent: null, model: null });

    const reloaded = getTicket(store, t.id);
    expect(reloaded.key).toBe('NEW-S');
    expect(reloaded.title).toBe('new title');
    expect(listTickets(store)).toHaveLength(1);
    expect(startTicket).not.toHaveBeenCalled();
  });

  it('save posts busy on/off around the persist and pushes fresh state on success', async () => {
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-4', title: 't', description: '', repos: [], approach: null, agent: null, model: null });

    expect(ctx.posted[0]).toEqual({ type: 'busy', what: 'save', on: true });
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'save', on: false });
    expect(ctx.pushes).toBeGreaterThan(0);
  });

  it('save posts a user-facing error and persists nothing when the store rejects the write', async () => {
    store.close();
    const ctx = mkCtx();
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-5', title: 't', description: '', repos: [], approach: null, agent: null, model: null });

    expect(ctx.posted.find((m) => m.type === 'error')).toBeTruthy();
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'save', on: false });
  });

  /** An adapter whose analyzer returns a canned coupled-JSON object. */
  function analyzerAdapter(raw: string): AgentAdapter {
    return { ...fakeAdapter(), runHeadless: vi.fn(async () => ({ sessionId: 's', verdict: null, raw })) };
  }

  it('analyze posts busy on, persists the coupled result, and posts analysis, then busy off', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketOnboarding(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.adapter = analyzerAdapter(
      '{"prompt":"Add an X button","approach":"rpi","repos":["fe"],"reason":"UI-only change"}',
    );
    const posted: OnboardingHostMessage[] = [];
    let pushes = 0;
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m),
      pushState: () => { pushes += 1; },
      mode: 'edit',
      ticketId: t.id,
      bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('');

    expect(posted[0]).toEqual({ type: 'busy', what: 'analyze', on: true });
    expect(posted.find((m) => m.type === 'analysis')).toEqual({
      type: 'analysis',
      prompt: 'Add an X button',
      approachId: 'rpi',
      repos: ['fe'],
      reason: 'UI-only change',
    });
    expect(posted[posted.length - 1]).toEqual({ type: 'busy', what: 'analyze', on: false });
    // persisted onto the ticket + re-pushed state
    const reloaded = getTicket(store, t.id);
    expect(reloaded.description).toBe('Add an X button');
    expect(reloaded.selectedRepos).toEqual(['fe']);
    expect(reloaded.approach).toBe('rpi');
    expect(pushes).toBe(1);
  });

  it('analyze posts an error and busy off when the adapter rejects', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketOnboarding(store, t.id, { brief: 'the brief text' });
    deps.adapter = { ...fakeAdapter(), runHeadless: vi.fn(async () => { throw new Error('agent down'); }) };
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('');

    const err = posted.find((m) => m.type === 'error') as { message: string } | undefined;
    expect(err?.message).toMatch(/agent down/);
    expect(posted[posted.length - 1]).toEqual({ type: 'busy', what: 'analyze', on: false });
  });

  it('analyze in create mode (no ticket) computes from the live prompt WITHOUT persisting', async () => {
    deps.adapter = analyzerAdapter(
      '{"prompt":"Rename the button","approach":"rpi","repos":["fe"],"reason":"trivial"}',
    );
    const posted: OnboardingHostMessage[] = [];
    let pushes = 0;
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m), pushState: () => { pushes += 1; }, mode: 'create', bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('rename the settings button');

    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({ prompt: 'Rename the button' });
    expect(pushes).toBe(0); // nothing persisted, no state re-push
    expect(listTickets(store)).toHaveLength(0); // no draft created
  });

  it('analyze is a no-op with no bound ticket AND no live prompt (nothing to reason over)', async () => {
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('');
    expect(posted).toEqual([]);
  });

  it('analyze is a no-op when the ticket has neither a brief nor a prompt', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' }); // no description/brief
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('');
    expect(posted).toEqual([]);
  });

  it('analyze runs off the live prompt alone for a manual ticket (no brief)', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    const runHeadless = vi.fn(async (opts: { prompt: string; cwd: string }) => {
      void opts;
      return { sessionId: 's', verdict: null, raw: '{"prompt":"p","approach":"rpi","repos":["be"],"reason":"from prompt"}' };
    });
    deps.adapter = { ...fakeAdapter(), runHeadless };
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('Add a rate limiter');

    expect(posted.find((m) => m.type === 'analysis')).toBeTruthy();
    // The live prompt reached the analyzer prompt.
    expect(runHeadless.mock.calls[0]![0].prompt).toContain('Add a rate limiter');
  });

  it('analyze is a no-op when no approaches are available (adapter not called)', async () => {
    listInstalledIds.mockReturnValue([]); // rpi is sourced → unavailable, and no built-ins
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketOnboarding(store, t.id, { brief: 'the brief text' });
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('');
    expect(posted).toEqual([]);
    expect(deps.adapter.runHeadless).not.toHaveBeenCalled();
  });

  it('analyze considers built-in (sourceless) approaches even when nothing is installed', async () => {
    listInstalledIds.mockReturnValue([]);
    deps.manifest = { ...MANIFEST, approaches: [{ id: 'direct', label: 'Direct' }] }; // built-in
    deps.adapter = analyzerAdapter(
      '{"prompt":"p","approach":"direct","repos":["fe"],"reason":"tiny change"}',
    );
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketOnboarding(store, t.id, { brief: 'the brief text' });
    const posted: OnboardingHostMessage[] = [];
    const ctx: OnboardingActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildOnboardingActions(deps)(ctx);

    await actions.analyze('');

    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({
      approachId: 'direct',
      reason: 'tiny change',
    });
  });

  it('setApproach and setRepos persist onto an existing ticket', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    actions.setApproach('rpi');
    actions.setRepos(['fe', 'be']);
    const reloaded = getTicket(store, t.id);
    expect(reloaded.approach).toBe('rpi');
    expect(reloaded.selectedRepos).toEqual(['fe', 'be']);
  });

  it('setAgent persists onto an existing ticket', () => {
    const t = createTicket(store, { key: 'P-A', title: 't' });
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    actions.setAgent('reviewer');
    expect(getTicket(store, t.id).agent).toBe('reviewer');
  });

  it('setAgent is a no-op in create mode with no bound ticket', () => {
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    expect(() => actions.setAgent('reviewer')).not.toThrow();
    expect(listTickets(store)).toHaveLength(0);
  });

  it('setModel persists onto an existing ticket, and empty clears it to inherit', () => {
    const t = createTicket(store, { key: 'P-M', title: 't' });
    const ctx: OnboardingActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildOnboardingActions(deps)(ctx);

    actions.setModel('claude-sonnet-5');
    expect(getTicket(store, t.id).model).toBe('claude-sonnet-5');
    actions.setModel('');
    expect(getTicket(store, t.id).model).toBeNull();
  });

});
