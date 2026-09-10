import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import {
  createTicket,
  deleteTicket,
  getTicket,
  getTicketByKey,
  listTickets,
  updateTicketFields,
} from '../../store/tickets.js';
import {
  buildTicketFormActions,
  type TicketFormActionsDeps,
  type StartTicketResult,
  type StartTicketOptions,
} from './actions.js';
import type { TicketFormActionsCtx } from './panel.js';
import type { TicketFormHostMessage } from './messages.js';
import type { ContextBrief, TicketingProvider } from '../../integrations/ticketing.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { Manifest, RepositoryDef } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';
import {
  getAttachment,
  insertAttachment,
  listAttachments,
} from '../../store/attachments.js';
import { listProcessRuns } from '../../store/processRuns.js';
import type { DriveProcessBundle } from '../../agent/processAssignment.js';
import { MAX_PASTE_BYTES } from '../../attachments/ingest.js';
import { attachmentDir, attachmentPath } from '../../attachments/paths.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshStorage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'karst-ticket-form-attachments-'));
  dirs.push(dir);
  return dir;
}

function sourceFile(name: string, contents: string): string {
  const path = join(freshStorage(), name);
  writeFileSync(path, contents);
  return path;
}

function sourceImage(name: string): string {
  return sourceFile(name, `PNGDATA:${name}`);
}

function svc(over: Partial<RepositoryDef> = {}): RepositoryDef {
  return runnableRepo({ start: 'x', ports: [slot('port', 'PORT', 3000)] }, over);
}

const MANIFEST: Manifest = buildManifest(
  { fe: svc({ signals: ['ui'] }), be: svc({ signals: ['api'] }) },
  {
    portRange: [4000, 4100],
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
  },
);

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
    capabilities: { lifecycleEvents: false, resume: false },
    buildInteractiveCommand: () => ({ command: 'c', args: [], env: {} }),
    runHeadless: vi.fn(async () => ({ sessionId: 's', verdict: null, raw: '["x","y"]' })),
  };
}

/**
 * A ctx with a mutable ticket binding (mirrors the real panel ctx). Records
 * posts; `bindTicket` flips it to edit mode so persist-on-fetch can rebind a
 * create panel to its new draft.
 */
function mkCtx(ticketId?: number): TicketFormActionsCtx & {
  posted: TicketFormHostMessage[];
  pushes: number;
  statePushes: number;
  boundTicketId?: number;
  closes: number;
} {
  let boundId = ticketId;
  let pushes = 0;
  let closes = 0;
  const posted: TicketFormHostMessage[] = [];
  const ctx = {
    posted,
    get pushes() {
      return pushes;
    },
    get statePushes() {
      return pushes;
    },
    get boundTicketId() {
      return boundId;
    },
    get closes() {
      return closes;
    },
    post: (m: TicketFormHostMessage) => posted.push(m),
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
  return ctx as TicketFormActionsCtx & {
    posted: TicketFormHostMessage[];
    pushes: number;
    statePushes: number;
    boundTicketId?: number;
    closes: number;
  };
}

describe('buildTicketFormActions', () => {
  let store: Store;
  let deps: TicketFormActionsDeps;
  let onCreated: ReturnType<typeof vi.fn<() => void>>;
  let writeSignals: ReturnType<typeof vi.fn<(p: string, s: string, sig: string[]) => void>>;
  let reloadManifest: ReturnType<typeof vi.fn<() => void>>;
  let listInstalledIds: ReturnType<typeof vi.fn<() => string[]>>;
  let startTicket: ReturnType<
    typeof vi.fn<(id: number, opts: StartTicketOptions) => Promise<StartTicketResult>>
  >;
  let openDashboard: ReturnType<typeof vi.fn<(id: number) => void>>;

  beforeEach(() => {
    store = openStore(':memory:');
    onCreated = vi.fn<() => void>();
    writeSignals = vi.fn<(p: string, s: string, sig: string[]) => void>();
    reloadManifest = vi.fn<() => void>();
    listInstalledIds = vi.fn<() => string[]>(() => ['rpi']);
    startTicket = vi.fn<(id: number, opts: StartTicketOptions) => Promise<StartTicketResult>>(
      async () => ({ ok: true }),
    );
    openDashboard = vi.fn<(id: number) => void>();
    const adapter = fakeAdapter();
    deps = {
      store,
      manifest: MANIFEST,
      manifestPath: '/tmp/karst.yml',
      provider: fakeProvider(),
      adapter,
      // Default resolver: the CURRENT deps.adapter under the approved default
      // assignment, read at CALL time so per-test `deps.adapter` swaps apply.
      // Individual tests override this with a configured bundle.
      resolveAnalysisProcess: vi.fn<(id: number) => DriveProcessBundle | null>(() => ({
        assignment: { agentName: 'Ticket Analysis Agent', provider: 'claude' },
        adapter: deps.adapter,
      })),
      onChange: onCreated,
      writeSignals,
      reloadManifest,
      listInstalledIds,
      startTicket,
      openDashboard,
      storageDir: freshStorage(),
      pickAttachment: async () => [],
      openFile: () => {},
    };
  });

  function makeActions(input: { mode: 'create' | 'edit' }) {
    const ticketId = input.mode === 'edit'
      ? createTicket(store, { key: `ATT-${Math.random()}`, title: 'attachments' }).id
      : undefined;
    const ctx = mkCtx(ticketId);
    const actions = buildTicketFormActions(deps)(ctx);
    return { actions, ctx, deps, ticketId };
  }

  it('fetchSource posts the brief and persists it for an existing ticket', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m),
      pushState: () => {},
      mode: 'edit',
      ticketId: t.id,
      bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.fetchSource('CU-9');
    // busy on/off + brief posted
    expect(posted.find((m) => m.type === 'brief')).toBeTruthy();
    expect(getTicket(store, t.id).brief).toContain('Login modal');
  });

  it('fetchSource persists the provider-native priority from the brief', async () => {
    const t = createTicket(store, { key: 'P-2', title: 't' });
    deps.provider = fakeProvider({
      fetchTicket: vi.fn(async () => ({ ...BRIEF, priority: 'urgent' })),
    });
    const actions = buildTicketFormActions(deps)(mkCtx(t.id));
    await actions.fetchSource('CU-9');
    expect(getTicket(store, t.id).priority).toBe('urgent');
  });

  it('fetchSource clears a stale priority when the provider stops reporting one', async () => {
    const t = createTicket(store, { key: 'P-3', title: 't' });
    updateTicketFields(store, t.id, { priority: 'urgent' });
    // This brief carries no priority — the provider no longer exposes it.
    const actions = buildTicketFormActions(deps)(mkCtx(t.id));
    await actions.fetchSource('CU-9');
    expect(getTicket(store, t.id).priority).toBeNull();
  });

  /** Persist a brief with the given attachments and return the stored text. */
  async function briefWithAttachments(
    attachments: ContextBrief['attachments'],
  ): Promise<string> {
    const t = createTicket(store, { key: `A-${attachments.length}-${Math.random()}`, title: 't' });
    deps.provider = fakeProvider({
      fetchTicket: vi.fn(async () => ({ ...BRIEF, attachments })),
    });
    const actions = buildTicketFormActions(deps)(mkCtx(t.id));
    await actions.fetchSource('CU-9');
    return getTicket(store, t.id).brief ?? '';
  }

  it('renders an image attachment as a markdown image', async () => {
    const brief = await briefWithAttachments([
      { name: 'shot.png', url: 'https://files/shot.png', kind: 'image', mimeType: 'image/png', size: 900 },
    ]);
    expect(brief).toContain('## Attachments');
    expect(brief).toContain('![shot.png](https://files/shot.png)');
  });

  it('inlines a text attachment', async () => {
    const brief = await briefWithAttachments([
      { name: 'notes.md', url: 'https://files/notes.md', kind: 'text', content: 'inline body here' },
    ]);
    expect(brief).toContain('inline body here');
    expect(brief).toContain('```');
  });

  it('renders a binary attachment as a labeled link and does not throw', async () => {
    const brief = await briefWithAttachments([
      { name: 'app.zip', url: 'https://files/app.zip', kind: 'binary', mimeType: 'application/zip', size: 4096 },
    ]);
    expect(brief).toContain('[app.zip](https://files/app.zip)');
    expect(brief).toContain('application/zip');
  });

  it('still renders the brief when an attachment could not be downloaded', async () => {
    const brief = await briefWithAttachments([
      { name: 'x.pdf', url: 'https://files/x.pdf', kind: 'unavailable', error: 'download returned 403' },
    ]);
    expect(brief).toContain('Login modal'); // the rest of the brief survives
    expect(brief.toLowerCase()).toContain('unavailable');
  });

  it('leaves a brief with zero attachments byte-identical', async () => {
    const brief = await briefWithAttachments([]);
    expect(brief).toBe('# Login modal\n\nui bug\n\nTags: frontend');
  });

  it('fetchSource in create mode persists a draft, binds it, and scores repos', async () => {
    const ctx = mkCtx(); // create mode: no ticket yet
    const actions = buildTicketFormActions(deps)(ctx);

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
    const actions = buildTicketFormActions(deps)(ctx);

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
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.fetchSource('CU-42');
    expect(ctx.ticketId).toBeUndefined(); // half-bound state never happens
    expect(listTickets(store)).toHaveLength(0);
  });

  it('fetchSource posts an error when the provider rejects', async () => {
    deps.provider = fakeProvider({ fetchTicket: vi.fn(async () => { throw new Error('boom'); }) });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.fetchSource('CU-9');
    const err = posted.find((m) => m.type === 'error') as { message: string } | undefined;
    expect(err?.message).toMatch(/boom/);
  });

  it('searchTickets posts the provider results, echoing the request', async () => {
    deps.provider = fakeProvider({
      searchTickets: vi.fn(async (query, opts) => [
        { ref: 't1', title: `${query} one`, status: opts?.status ?? 'to do', priority: 'urgent' },
      ]),
    });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.searchTickets('pay', 'to do');
    const res = posted.find((m) => m.type === 'ticket-search-results') as
      | { query: string; status: string | null; results: { ref: string }[] }
      | undefined;
    expect(res?.query).toBe('pay');
    expect(res?.status).toBe('to do');
    expect(res?.results[0]?.ref).toBe('t1');
    expect(deps.provider.searchTickets).toHaveBeenCalledWith('pay', { status: 'to do' });
  });

  it('searchTickets drops the status option when the filter is null', async () => {
    deps.provider = fakeProvider({ searchTickets: vi.fn(async () => []) });
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.searchTickets('pay', null);
    expect(deps.provider.searchTickets).toHaveBeenCalledWith('pay', undefined);
  });

  it('searchTickets posts a dropdown error when the provider rejects', async () => {
    deps.provider = fakeProvider({
      searchTickets: vi.fn(async () => { throw new Error('rate limited'); }),
    });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.searchTickets('pay', null);
    const err = posted.find((m) => m.type === 'ticket-search-error') as
      | { message: string }
      | undefined;
    expect(err?.message).toMatch(/rate limited/);
  });

  it('searchTickets reports a provider without search support on the dropdown channel', async () => {
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx); // fakeProvider has no searchTickets

    await actions.searchTickets('pay', null);
    const err = ctx.posted.find((m) => m.type === 'ticket-search-error') as
      | { message: string }
      | undefined;
    expect(err?.message).toMatch(/cannot search/);
  });

  it('searchStatuses posts the provider status names', async () => {
    deps.provider = fakeProvider({ listStatuses: vi.fn(async () => ['to do', 'in progress']) });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.searchStatuses();
    const res = posted.find((m) => m.type === 'ticket-search-statuses') as
      | { statuses: string[] }
      | undefined;
    expect(res?.statuses).toEqual(['to do', 'in progress']);
  });

  it('searchStatuses reports a provider failure on the dropdown channel', async () => {
    deps.provider = fakeProvider({ listStatuses: vi.fn(async () => { throw new Error('no list'); }) });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.searchStatuses();
    const err = posted.find((m) => m.type === 'ticket-search-error') as
      | { message: string }
      | undefined;
    expect(err?.message).toMatch(/no list/);
  });

  it('suggestSignals posts the suggested words for a service', async () => {
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.suggestSignals('fe');
    const s = posted.find((m) => m.type === 'signals-suggested') as
      | { service: string; signals: string[] }
      | undefined;
    expect(s?.service).toBe('fe');
    expect(s?.signals).toEqual(['x', 'y']);
  });

  it('saveSignals writes to the manifest and re-pushes state', async () => {
    let pushes = 0;
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => (pushes += 1), mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.saveSignals('be', ['api', 'endpoint']);
    expect(deps.writeSignals).toHaveBeenCalledWith('/tmp/karst.yml', 'be', ['api', 'endpoint']);
    expect(pushes).toBeGreaterThan(0);
  });

  it('saveSignals reloads the manifest BEFORE re-pushing state (so the gate clears)', async () => {
    const order: string[] = [];
    reloadManifest.mockImplementation(() => order.push('reload'));
    const ctx: TicketFormActionsCtx = {
      post: () => {},
      pushState: () => order.push('push'),
      mode: 'create',
      bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.saveSignals('be', ['api']);
    expect(reloadManifest).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reload', 'push']);
  });

  it('saveSignals does not reload or push when the write throws', async () => {
    writeSignals.mockImplementation(() => { throw new Error('bad yml'); });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.saveSignals('be', ['api']);
    expect(reloadManifest).not.toHaveBeenCalled();
    expect((posted.find((m) => m.type === 'error') as { message: string }).message).toMatch(/bad yml/);
  });

  it('submit in create mode creates a ticket with the entered fields', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: 'NEW-1', title: 'a title', description: 'a desc', repos: ['fe'], approach: 'rpi', agent: null, model: null, ticketType: null,
      createInProvider: false });
    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.key).toBe('NEW-1');
    expect(tickets[0]!.description).toBe('a desc');
    expect(onCreated).toHaveBeenCalled();
    // Finish hands the just-created ticket off to the workflow.
    expect(startTicket).toHaveBeenCalledWith(tickets[0]!.id, { pullBase: true });
  });

  it('submit generates a unique key when the key field is left blank (manual creation)', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: '', title: 'no key please', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });
    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.key).toBeTruthy(); // never persists an empty string
  });

  it('a blank key is derived from the title, not a random MANUAL- id', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: '', title: 'Fix login redirect', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });
    expect(listTickets(store)[0]!.key).toBe('FIX-LOGIN-REDIRECT');
  });

  it('two blank-key submissions of the SAME title still get distinct keys', async () => {
    const mk = () => buildTicketFormActions(deps)({
      post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
    });
    const fields = { key: '', title: 'Fix login redirect', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false };

    await mk().submit({ ...fields });
    await mk().submit({ ...fields });
    const keys = listTickets(store).map((t) => t.key).sort();
    expect(keys).toEqual(['FIX-LOGIN-REDIRECT', 'FIX-LOGIN-REDIRECT-2']);
  });

  it('auto-derived (non-blank preview) submissions of the SAME title still get distinct keys', async () => {
    const mk = () => buildTicketFormActions(deps)({
      post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
    });
    // Simulates the webview: the Key field holds the derived preview (non-empty),
    // and keyAutoDerived tells the host it is NOT user-owned.
    const fields = { key: 'FIX-LOGIN-REDIRECT', title: 'Fix login redirect', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null, createInProvider: false, keyAutoDerived: true };

    await mk().submit({ ...fields });
    await mk().submit({ ...fields });
    const keys = listTickets(store).map((t) => t.key).sort();
    expect(keys).toEqual(['FIX-LOGIN-REDIRECT', 'FIX-LOGIN-REDIRECT-2']);
  });

  it('a user-owned key is kept verbatim even when it matches another ticket (no auto re-key)', async () => {
    const mk = () => buildTicketFormActions(deps)({
      post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
    });
    const base = { title: 'Fix login redirect', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null, createInProvider: false };

    // createTicketFlow is idempotent by key, so a repeated user-owned key reuses
    // the same row — the point is that it is NOT re-keyed to `-2` the way an
    // auto-derived key would be. The key stays verbatim.
    await mk().submit({ ...base, key: 'FIX-LOGIN-REDIRECT', keyAutoDerived: false });
    await mk().submit({ ...base, key: 'FIX-LOGIN-REDIRECT', keyAutoDerived: false });
    const keys = listTickets(store).map((t) => t.key);
    expect(keys).toEqual(['FIX-LOGIN-REDIRECT']);
  });

  it('two blank-key submissions generate distinct keys — no collision', async () => {
    const actionsA = buildTicketFormActions(deps)({
      post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
    });
    const actionsB = buildTicketFormActions(deps)({
      post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
    });

    await actionsA.submit({ key: '', title: 'first', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });
    await actionsB.submit({ key: '', title: 'second', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });
    const [a, b] = listTickets(store);
    expect(a!.key).not.toBe(b!.key);
  });

  it('submit persists the create-mode repo + approach selection before starting', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: 'NEW-R', title: 't', description: '', repos: ['fe', 'be'], approach: 'rpi', agent: null, model: null, ticketType: null,
      createInProvider: false });
    const t = getTicket(store, listTickets(store)[0]!.id);
    expect(t.selectedRepos).toEqual(['fe', 'be']);
    expect(t.approach).toBe('rpi');
  });

  it('submit persists the per-ticket model when chosen, and leaves it null on inherit', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: 'NEW-M', title: 't', description: '', repos: [], approach: null, agent: null, model: 'claude-opus-4-8', ticketType: null,
      createInProvider: false });
    expect(getTicket(store, listTickets(store)[0]!.id).model).toBe('claude-opus-4-8');
  });

  it('submit persists the chosen agentProvider on a newly created ticket', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-P', title: 't', description: '', repos: [], approach: null, agent: null,
      model: null, agentProvider: 'antigravity', ticketType: null,
      createInProvider: false,
    });
    expect(getTicket(store, listTickets(store)[0]!.id).agentProvider).toBe('antigravity');
  });

  it('submit with a null model leaves the ticket inheriting the default', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: 'NEW-I', title: 't', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });
    expect(getTicket(store, listTickets(store)[0]!.id).model).toBeNull();
  });

  it('submit persists the agent selection when present', async () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-A', title: 't', description: '', repos: [], approach: null, agent: 'reviewer', model: null, ticketType: null,
      createInProvider: false,
    });
    const t = getTicket(store, listTickets(store)[0]!.id);
    expect(t.agent).toBe('reviewer');
  });

  it('submit binds the create panel to the new draft before starting it', async () => {
    let bound: number | undefined;
    const ctx: TicketFormActionsCtx = {
      post: () => {}, pushState: () => {}, mode: 'create',
      bindTicket: (id) => { bound = id; },
      close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: 'NEW-2', title: 't', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });
    const id = listTickets(store)[0]!.id;
    expect(bound).toBe(id);
    expect(startTicket).toHaveBeenCalledWith(id, { pullBase: true });
  });

  it('submit in edit mode updates key/title of the existing ticket', async () => {
    const t = createTicket(store, { key: 'OLD', title: 'old' });
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({ key: 'NEW', title: 'new', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });
    const reloaded = getTicket(store, t.id);
    expect(reloaded.key).toBe('NEW');
    expect(reloaded.title).toBe('new');
    expect(listTickets(store)).toHaveLength(1); // no duplicate created
    expect(startTicket).toHaveBeenCalledWith(t.id, { pullBase: true });
  });

  it('submit hands off to the dashboard and closes the panel once the ticket starts', async () => {
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-D', title: 't', description: '', repos: ['fe'], approach: 'rpi', agent: null, model: null, ticketType: null,
      createInProvider: false,
    });

    const id = listTickets(store)[0]!.id;
    expect(openDashboard).toHaveBeenCalledWith(id);
    expect(ctx.closes).toBe(1);
    // Busy brackets the start so the button can't be double-fired mid-launch,
    // and clears before the panel goes away.
    expect(ctx.posted[0]).toEqual({ type: 'busy', what: 'submit', on: true });
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'submit', on: false });
  });

  // The pull switch is a LAUNCH choice, not a stored field: submit forwards
  // whatever the page said, and its absence means "pull" (the default).
  it('submit forwards an explicit pull opt-out to startTicket', async () => {
    const actions = buildTicketFormActions(deps)(mkCtx());

    await actions.submit({
      key: 'NEW-P', title: 't', description: '', repos: ['fe'], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false, pullBase: false,
    });

    const id = listTickets(store)[0]!.id;
    expect(startTicket).toHaveBeenCalledWith(id, { pullBase: false });
    // Nothing about the switch is persisted on the ticket.
    expect(getTicket(store, id)).not.toHaveProperty('pullBase');
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
    const actions = buildTicketFormActions(deps)(ctx);

    const done = actions.submit({
      key: 'NEW-O', title: 't', description: '', repos: ['fe'], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false,
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
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-F', title: 't', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false,
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
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-T', title: 't', description: '', repos: ['fe'], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false,
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
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'OLD-D', title: 'new', description: '', repos: ['fe'], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false,
    });

    expect(openDashboard).toHaveBeenCalledWith(t.id);
    expect(ctx.closes).toBe(1);
  });

  it('save in create mode persists a ticket WITHOUT starting it', async () => {
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({
      key: 'DRAFT-1', title: 'a draft', description: 'no run yet', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false,
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

  it('save generates a unique key when the key field is left blank (manual creation)', async () => {
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({ key: '', title: 'a draft', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });

    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.key).toBeTruthy();
  });

  it('save persists repos/approach/agent/model exactly like submit does', async () => {
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({
      key: 'DRAFT-2', title: 't', description: '', repos: ['fe', 'be'], approach: 'rpi', agent: 'reviewer', model: 'claude-opus-4-8', ticketType: null,
      createInProvider: false,
    });

    const t = getTicket(store, listTickets(store)[0]!.id);
    expect(t.selectedRepos).toEqual(['fe', 'be']);
    expect(t.approach).toBe('rpi');
    expect(t.agent).toBe('reviewer');
    expect(t.model).toBe('claude-opus-4-8');
  });

  it('save binds the create panel to the new draft (retrievable afterward)', async () => {
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-3', title: 't', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });

    const id = listTickets(store)[0]!.id;
    expect(ctx.ticketId).toBe(id);
    expect(getTicketByKey(store, 'DRAFT-3')?.id).toBe(id);
  });

  it('save in edit mode updates the existing ticket WITHOUT starting it, no duplicate', async () => {
    const t = createTicket(store, { key: 'OLD-S', title: 'old' });
    const ctx = mkCtx(t.id);
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({ key: 'NEW-S', title: 'new title', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });

    const reloaded = getTicket(store, t.id);
    expect(reloaded.key).toBe('NEW-S');
    expect(reloaded.title).toBe('new title');
    expect(listTickets(store)).toHaveLength(1);
    expect(startTicket).not.toHaveBeenCalled();
  });

  it('save in edit mode with a blank key assigns a fresh generated key, never persists empty', async () => {
    const t = createTicket(store, { key: 'HAD-1', title: 'old' });
    const ctx = mkCtx(t.id);
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({ key: '', title: 'old', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });

    const reloaded = getTicket(store, t.id);
    expect(reloaded.key).toBeTruthy();
    expect(reloaded.key).not.toBe('');
  });

  it('save posts busy on/off around the persist and pushes fresh state on success', async () => {
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-4', title: 't', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });

    expect(ctx.posted[0]).toEqual({ type: 'busy', what: 'save', on: true });
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'save', on: false });
    expect(ctx.pushes).toBeGreaterThan(0);
  });

  it('save posts a user-facing error and persists nothing when the store rejects the write', async () => {
    store.close();
    const ctx = mkCtx();
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({ key: 'DRAFT-5', title: 't', description: '', repos: [], approach: null, agent: null, model: null, ticketType: null,
      createInProvider: false });

    expect(ctx.posted.find((m) => m.type === 'error')).toBeTruthy();
    expect(ctx.posted.at(-1)).toEqual({ type: 'busy', what: 'save', on: false });
  });

  /** An adapter whose analyzer returns a canned coupled-JSON object. */
  function analyzerAdapter(raw: string): AgentAdapter {
    return { ...fakeAdapter(), runHeadless: vi.fn(async () => ({ sessionId: 's', verdict: null, raw })) };
  }

  /**
   * An adapter that returns different results for the classify call (prompt
   * contains 'conventional-commit type') vs. the improve call (anything else).
   */
  function branchAdapter(opts: { classifyRaw: string; improveProse: string }): AgentAdapter {
    return {
      ...fakeAdapter(),
      runHeadless: vi.fn(async (input: { prompt: string }) => {
        const raw = input.prompt.includes('conventional-commit type')
          ? opts.classifyRaw
          : opts.improveProse;
        return { sessionId: 's', verdict: null, raw };
      }),
    };
  }

  it('analyze posts busy on, persists the coupled result, and posts analysis, then busy off', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.adapter = branchAdapter({
      classifyRaw: '{"prompt":"Add an X button","approach":"rpi","repos":["fe"],"reason":"UI-only change"}',
      improveProse: 'Add an X button to close the modal.',
    });
    const posted: TicketFormHostMessage[] = [];
    let pushes = 0;
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m),
      pushState: () => { pushes += 1; },
      mode: 'edit',
      ticketId: t.id,
      bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    expect(posted[0]).toEqual({ type: 'busy', what: 'analyze', on: true });
    expect(posted.find((m) => m.type === 'analysis')).toEqual({
      type: 'analysis',
      prompt: 'Add an X button to close the modal.',
      approachId: 'rpi',
      repos: ['fe'],
      reason: 'UI-only change',
      ticketType: 'feat',
    });
    expect(posted[posted.length - 1]).toEqual({ type: 'busy', what: 'analyze', on: false });
    // prompt + repos are prefilled onto the ticket + re-pushed state…
    const reloaded = getTicket(store, t.id);
    expect(reloaded.description).toBe('Add an X button to close the modal.');
    expect(reloaded.selectedRepos).toEqual(['fe']);
    // …as is the conventional type, which the ticket did not have yet.
    expect(reloaded.type).toBe('feat');
    // …and — fresh form, no persisted choice, picker untouched (design,
    // Selection and Enablement) — the analyzer's approach pick is applied.
    expect(reloaded.approach).toBe('rpi');
    expect(pushes).toBe(1);
  });

  it('analyze never overwrites the approach the user already selected', async () => {
    const t = createTicket(store, { key: 'P-A', title: 't' });
    // The ticket already carries a launched approach (stored verbatim).
    updateTicketFields(store, t.id, {
      brief: 'the brief text', selectedRepos: [], approach: 'superpowers:writing-plans',
    });
    deps.adapter = analyzerAdapter(
      '{"prompt":"Add an X button","approach":"rpi","repos":[],"reason":"plan first"}',
    );
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    // The analyzer's pick still surfaces to the page as a suggestion (badge)…
    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({ approachId: 'rpi' });
    // …but the ticket's stored approach is untouched — no silent clobber.
    expect(getTicket(store, t.id).approach).toBe('superpowers:writing-plans');
  });

  it('analyze does not set the approach once the user has touched the picker', async () => {
    const t = createTicket(store, { key: 'P-TCH', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.adapter = analyzerAdapter(
      '{"prompt":"p","approach":"rpi","repos":[],"reason":"r"}',
    );
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id,
      bindTicket: () => {}, close: () => {},
      // The user picked (or at least interacted with) the approach picker
      // earlier in this form session — the host never clears the flag.
      pickerTouched: true,
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    // Still a recommendation — the badge carries the suggestion…
    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({ approachId: 'rpi' });
    // …but the pick is NOT applied: after a touch, later analysis may never
    // move the selection (design, Selection and Enablement).
    expect(getTicket(store, t.id).approach).toBeNull();
  });

  it('analyze never overwrites the ticket type the user already picked', async () => {
    const t = createTicket(store, { key: 'P-T', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', type: 'chore' });
    deps.adapter = analyzerAdapter(
      '{"prompt":"p","approach":"rpi","repos":[],"reason":"r","type":"feat"}',
    );
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    expect(getTicket(store, t.id).type).toBe('chore');
    // The page is told what the ticket actually carries, not the model's guess.
    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({ ticketType: 'chore' });
  });

  it('analyze posts an error and busy off when the adapter rejects', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text' });
    deps.adapter = { ...fakeAdapter(), runHeadless: vi.fn(async () => { throw new Error('agent down'); }) };
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    const err = posted.find((m) => m.type === 'error') as { message: string } | undefined;
    expect(err?.message).toMatch(/agent down/);
    expect(posted[posted.length - 1]).toEqual({ type: 'busy', what: 'analyze', on: false });
  });

  it('analyze in create mode binds a draft and records the prefill process run', async () => {
    deps.adapter = branchAdapter({
      classifyRaw: '{"prompt":"Rename the button","approach":"rpi","repos":["fe"],"reason":"trivial"}',
      improveProse: 'Rename the settings button.',
    });
    const posted: TicketFormHostMessage[] = [];
    // Mirrors the real panel ctx: bindTicket flips the panel to edit mode, so
    // the post-ensureTicket persist block runs against the freshly minted draft.
    let bound: number | undefined;
    let pushes = 0;
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m),
      pushState: () => { pushes += 1; },
      get mode(): 'create' | 'edit' {
        return bound === undefined ? 'create' : 'edit';
      },
      get ticketId() {
        return bound;
      },
      bindTicket: (id) => { bound = id; },
      close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('rename the settings button');

    // The analysis is the scope stage's prefill process, and a process run
    // needs a ticket to attach to — the draft is bound on Analyze now.
    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({ prompt: 'Rename the settings button.' });
    const tickets = listTickets(store);
    expect(tickets).toHaveLength(1);
    expect(bound).toBe(tickets[0]!.id);
    // The call was attributed to a closed, passed prefill run.
    const runs = listProcessRuns(store, tickets[0]!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ processId: 'prefill', stageKey: 'scope', status: 'passed' });
    // The bound draft is a fresh form with no persisted choice and an untouched
    // picker — the analyzer's approach pick is applied to it (the state push
    // carries it back so the webview radio reflects the applied pick).
    expect(getTicket(store, tickets[0]!.id).approach).toBe('rpi');
    expect(pushes).toBe(1);
  });

  it('analyze runs through the configured ticket-analysis process and snapshots its identity', async () => {
    const classifyRaw = '{"prompt":"p","approach":"rpi","repos":["fe"],"reason":"r"}';
    const runHeadless = vi.fn(async (opts: { prompt: string; model?: string }) => {
      // Branch by classify marker: classify returns JSON, improve returns prose.
      const raw = opts.prompt.includes('conventional-commit type') ? classifyRaw : 'Improved p';
      return { sessionId: 's', verdict: null, raw };
    });
    const configured: AgentAdapter = { ...fakeAdapter(), runHeadless };
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.resolveAnalysisProcess = () => ({
      assignment: { agentName: 'My Analyzer', provider: 'opencode', model: 'gemini-2.5-pro' },
      adapter: configured,
    });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('a ticket prompt');

    // Two headless calls: classify then improve, both with the configured model.
    expect(runHeadless).toHaveBeenCalledTimes(2);
    expect(runHeadless.mock.calls[0]![0].model).toBe('gemini-2.5-pro');
    expect(runHeadless.mock.calls[1]![0].model).toBe('gemini-2.5-pro');
    // The prefill run snapshots the identity that actually ran — the settings
    // pick, never the manifest default.
    const runs = listProcessRuns(store, t.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      processId: 'prefill',
      stageKey: 'scope',
      status: 'passed',
      agentName: 'My Analyzer',
      provider: 'opencode',
      model: 'gemini-2.5-pro',
    });
    expect(posted.find((m) => m.type === 'analysis')).toBeTruthy();
  });

  // The analysis runs through the configured Ticket-analysis assignment: the
  // resolver overlays the Settings profile's body (or inline `instructions`)
  // as the assignment's `instructions`, and improve must receive it as its
  // prompt while classify uses the built-in analyzer.
  it('analyze threads the resolved assignment instructions into the improve call, not classify', async () => {
    const classifyRaw = '{"prompt":"p","approach":"rpi","repos":["fe"],"reason":"r"}';
    const runHeadless = vi.fn(async (opts: { prompt: string }) => {
      const raw = opts.prompt.includes('conventional-commit type') ? classifyRaw : 'Improved p';
      return { sessionId: 's', verdict: null, raw };
    });
    const configured: AgentAdapter = { ...fakeAdapter(), runHeadless };
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.resolveAnalysisProcess = () => ({
      assignment: {
        agentName: 'description-improver',
        provider: 'claude',
        instructions: '# description-improver\nRewrite the description.',
      },
      adapter: configured,
    });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    expect(runHeadless).toHaveBeenCalledTimes(2);
    // Call[0] is classify — built-in analyzer, NO profile body.
    expect(runHeadless.mock.calls[0]![0].prompt).toContain('conventional-commit type');
    expect(runHeadless.mock.calls[0]![0].prompt).not.toContain('# description-improver');
    // Call[1] is improve — profile body is the prompt, no JSON contract.
    expect(runHeadless.mock.calls[1]![0].prompt).toContain('# description-improver');
    expect(runHeadless.mock.calls[1]![0].prompt).toContain('Rewrite the description.');
    expect(runHeadless.mock.calls[1]![0].prompt).not.toContain('Respond with ONLY a single JSON object');
  });

  it('analyze refuses with an inline error when the ticket-analysis process is disabled', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.resolveAnalysisProcess = () => null;
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    // Configured absence: the analyzer performs no model call and opens no run —
    // the page gets a reason it can act on (enable it), not a silent no-op.
    expect(deps.adapter.runHeadless).not.toHaveBeenCalled();
    expect(listProcessRuns(store, t.id)).toHaveLength(0);
    const err = posted.find((m) => m.type === 'error') as { message: string } | undefined;
    expect(err?.message).toMatch(/disabled/i);
    expect(posted.at(-1)).toEqual({ type: 'busy', what: 'analyze', on: false });
  });

  it('analyze is a no-op with no bound ticket AND no live prompt (nothing to reason over)', async () => {
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = { post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');
    expect(posted).toEqual([]);
  });

  it('analyze is a no-op when the ticket has neither a brief nor a prompt', async () => {
    const t = createTicket(store, { key: 'P-1', title: 't' }); // no description/brief
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

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
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('Add a rate limiter');

    expect(posted.find((m) => m.type === 'analysis')).toBeTruthy();
    // The live prompt reached the analyzer prompt.
    expect(runHeadless.mock.calls[0]![0].prompt).toContain('Add a rate limiter');
  });

  it('analyze is a no-op when no approaches are available (adapter not called)', async () => {
    listInstalledIds.mockReturnValue([]); // rpi is sourced → unavailable, and no built-ins
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text' });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

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
    updateTicketFields(store, t.id, { brief: 'the brief text' });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({
      approachId: 'direct',
      reason: 'tiny change',
    });
  });

  it('improve failure degrades to the classify prompt and keeps the run passed', async () => {
    const t = createTicket(store, { key: 'P-IMP-FAIL', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    const classifyRaw = '{"prompt":"Fallback prompt","approach":"rpi","repos":["fe"],"reason":"r"}';
    const runHeadless = vi.fn(async (opts: { prompt: string }) => {
      if (opts.prompt.includes('conventional-commit type')) {
        return { sessionId: 's', verdict: null, raw: classifyRaw };
      }
      throw new Error('improve crashed');
    });
    deps.adapter = { ...fakeAdapter(), runHeadless };
    const posted: TicketFormHostMessage[] = [];
    const warns: string[] = [];
    deps.warn = (msg: string) => { warns.push(msg); };
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    // The posted analysis uses the classify prompt as fallback.
    expect(posted.find((m) => m.type === 'analysis')).toMatchObject({
      prompt: 'Fallback prompt',
    });
    // The run stayed passed despite the improve failure.
    const runs = listProcessRuns(store, t.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'passed' });
    // A warning was emitted.
    expect(warns.some((w) => w.includes('description improve failed'))).toBe(true);
  });

  it('improve runs at the project root, not in the picked repo', async () => {
    const t = createTicket(store, { key: 'P-CWD', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.manifest = buildManifest(
      { fe: svc({ signals: ['ui'], repoPath: '/elsewhere/fe' }), be: svc({ signals: ['api'] }) },
      { portRange: [4000, 4100], approaches: [{ id: 'rpi', label: 'RPI', recommended: true, source: { type: 'git', repo: 'a/b', ref: 'main', include: ['.claude/agents'] } }] },
    );
    deps.manifestPath = '/proj/.karst/karst.yml';
    const classifyRaw = '{"prompt":"p","approach":"rpi","repos":["fe"],"reason":"r"}';
    const runHeadless = vi.fn(async (opts: { prompt: string; cwd: string }) => {
      const raw = opts.prompt.includes('conventional-commit type') ? classifyRaw : 'Improved';
      return { sessionId: 's', verdict: null, raw };
    });
    deps.adapter = { ...fakeAdapter(), runHeadless };
    const t2 = createTicket(store, { key: 'P-CWD-2', title: 't2' });
    updateTicketFields(store, t2.id, { brief: 'the brief text', selectedRepos: [] });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t2.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    // The improve (2nd) call's cwd is the PROJECT ROOT (/proj), not the repo.
    expect(runHeadless.mock.calls[1]![0].cwd).toBe('/proj');
    // The improve prompt contains the picked repo as data.
    expect(runHeadless.mock.calls[1]![0].prompt).toContain('Primary repository: /elsewhere/fe');
  });

  it('improve omits the repository line when classify yields no repo and the manifest is multi-repo', async () => {
    const t = createTicket(store, { key: 'P-NO-REPO', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.manifest = buildManifest(
      { fe: svc({ signals: ['ui'] }), be: svc({ signals: ['api'] }) },
      { portRange: [4000, 4100], approaches: [{ id: 'rpi', label: 'RPI', recommended: true, source: { type: 'git', repo: 'a/b', ref: 'main', include: ['.claude/agents'] } }] },
    );
    deps.manifestPath = '/proj/.karst/karst.yml';
    const classifyRaw = '{"prompt":"p","approach":"rpi","repos":[],"reason":"r"}';
    const runHeadless = vi.fn(async (opts: { prompt: string; cwd: string }) => {
      const raw = opts.prompt.includes('conventional-commit type') ? classifyRaw : 'Improved';
      return { sessionId: 's', verdict: null, raw };
    });
    deps.adapter = { ...fakeAdapter(), runHeadless };
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    // The improve call's cwd is still the project root.
    expect(runHeadless.mock.calls[1]![0].cwd).toBe('/proj');
    // No Primary repository: line.
    expect(runHeadless.mock.calls[1]![0].prompt).not.toContain('Primary repository:');
  });

  it('improve names the sole repository when classify yields none', async () => {
    const t = createTicket(store, { key: 'P-sole', title: 't' });
    updateTicketFields(store, t.id, { brief: 'the brief text', selectedRepos: [] });
    deps.manifest = buildManifest(
      { fe: svc({ signals: ['ui'], repoPath: '/solo/fe' }) },
      { portRange: [4000, 4100], approaches: [{ id: 'rpi', label: 'RPI', recommended: true, source: { type: 'git', repo: 'a/b', ref: 'main', include: ['.claude/agents'] } }] },
    );
    deps.manifestPath = '/proj/.karst/karst.yml';
    const classifyRaw = '{"prompt":"p","approach":"rpi","repos":[],"reason":"r"}';
    const runHeadless = vi.fn(async (opts: { prompt: string }) => {
      const raw = opts.prompt.includes('conventional-commit type') ? classifyRaw : 'Improved';
      return { sessionId: 's', verdict: null, raw };
    });
    deps.adapter = { ...fakeAdapter(), runHeadless };
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.analyze('');

    // The improve prompt contains the sole repo's path.
    expect(runHeadless.mock.calls[1]![0].prompt).toContain('Primary repository: /solo/fe');
  });

  it('setApproach and setRepos persist onto an existing ticket', () => {
    const t = createTicket(store, { key: 'P', title: 't' });
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.setApproach('rpi');
    actions.setRepos(['fe', 'be']);
    const reloaded = getTicket(store, t.id);
    expect(reloaded.approach).toBe('rpi');
    expect(reloaded.selectedRepos).toEqual(['fe', 'be']);
  });

  it('stores a base ref override on the ticket', () => {
    const t = createTicket(store, { key: 'P-BR', title: 't' });
    // Give fe/be distinct repoPaths for this test — MANIFEST's default (both
    // '/repo') deliberately shares a path so the "refuses" test below has a
    // real conflict to reject; an isolated override needs no such collision.
    deps.manifest = buildManifest(
      { fe: svc({ signals: ['ui'], repoPath: '/repo/fe' }), be: svc({ signals: ['api'], repoPath: '/repo/be' }) },
      { portRange: [4000, 4100] },
    );
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.setBaseRef('fe', 'epic/x');
    expect(getTicket(store, t.id).baseRefs).toEqual({ fe: 'epic/x' });
  });

  it('drops an override that equals the manifest default', () => {
    const t = createTicket(store, { key: 'P-BR-2', title: 't' });
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    // MANIFEST's baseline branch (the manifest default with no repo-level
    // override) is 'develop' — see manifest/fixtures.ts.
    actions.setBaseRef('fe', 'develop');
    expect(getTicket(store, t.id).baseRefs).toEqual({});
  });

  it('refuses two different bases for entries sharing a repoPath', () => {
    const t = createTicket(store, { key: 'P-BR-3', title: 't' });
    const posted: TicketFormHostMessage[] = [];
    // MANIFEST's `fe` and `be` both default to repoPath '/repo' (see svc()
    // in manifest/fixtures.ts) — one deduped worktree, so they cannot be
    // given different base branches.
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m),
      pushState: () => {},
      mode: 'edit',
      ticketId: t.id,
      bindTicket: () => {},
      close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.setBaseRef('fe', 'epic/x');
    // Reported through the form's existing error channel — the same `error`
    // post used by every other validation failure in this module.
    expect(posted.find((m) => m.type === 'error')).toBeTruthy();
    // The rejected override must not have been persisted.
    expect(getTicket(store, t.id).baseRefs).toEqual({});
  });

  // The webview's setBaseRef rejection leaves stale text in the input, which
  // collectBaseRefs() re-sends on Submit — persistDraft must not trust it.
  it('submit refuses conflicting base refs for entries sharing a repoPath, and creates nothing', async () => {
    // MANIFEST's `fe` and `be` share repoPath '/repo' by default.
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'NEW-BR', title: 't', description: '', repos: ['fe', 'be'], approach: null, agent: null,
      model: null, ticketType: null, createInProvider: false,
      baseRefs: { fe: 'epic/x' },
    });

    expect(posted.find((m) => m.type === 'error')).toBeTruthy();
    expect(listTickets(store)).toHaveLength(0);
    expect(startTicket).not.toHaveBeenCalled();
  });

  it('save refuses conflicting base refs for entries sharing a repoPath, and creates nothing', async () => {
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.save({
      key: 'DRAFT-BR', title: 't', description: '', repos: ['fe', 'be'], approach: null, agent: null,
      model: null, ticketType: null, createInProvider: false,
      baseRefs: { fe: 'epic/x' },
    });

    expect(posted.find((m) => m.type === 'error')).toBeTruthy();
    expect(listTickets(store)).toHaveLength(0);
  });

  // An edit-mode submit must not silently overwrite the ticket's key/title
  // with a rejected baseRefs payload attached — the assert must run BEFORE
  // any field is written, not after some fields already landed.
  it('an edit-mode submit with conflicting base refs leaves the existing ticket untouched', async () => {
    const t = createTicket(store, { key: 'P-BR-EDIT', title: 'original title' });
    const posted: TicketFormHostMessage[] = [];
    const ctx: TicketFormActionsCtx = {
      post: (m) => posted.push(m), pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {},
    };
    const actions = buildTicketFormActions(deps)(ctx);

    await actions.submit({
      key: 'P-BR-EDIT', title: 'a hijacked title', description: '', repos: ['fe', 'be'], approach: null,
      agent: null, model: null, ticketType: null, createInProvider: false,
      baseRefs: { fe: 'epic/x' },
    });

    expect(posted.find((m) => m.type === 'error')).toBeTruthy();
    expect(getTicket(store, t.id).title).toBe('original title');
    expect(getTicket(store, t.id).baseRefs).toEqual({});
    expect(startTicket).not.toHaveBeenCalled();
  });

  it('setAgent persists onto an existing ticket', () => {
    const t = createTicket(store, { key: 'P-A', title: 't' });
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.setAgent('reviewer');
    expect(getTicket(store, t.id).agent).toBe('reviewer');
  });

  it('setAgent is a no-op in create mode with no bound ticket', () => {
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'create', bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    expect(() => actions.setAgent('reviewer')).not.toThrow();
    expect(listTickets(store)).toHaveLength(0);
  });

  it('setModel persists onto an existing ticket, and empty clears it to inherit', () => {
    const t = createTicket(store, { key: 'P-M', title: 't' });
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.setModel('claude-sonnet-5');
    expect(getTicket(store, t.id).model).toBe('claude-sonnet-5');
    actions.setModel('');
    expect(getTicket(store, t.id).model).toBeNull();
  });

  it('setEffort persists onto an existing ticket, and empty clears it to inherit', () => {
    const t = createTicket(store, { key: 'P-EF', title: 't' });
    const ctx: TicketFormActionsCtx = { post: () => {}, pushState: () => {}, mode: 'edit', ticketId: t.id, bindTicket: () => {}, close: () => {} };
    const actions = buildTicketFormActions(deps)(ctx);

    actions.setEffort('high');
    expect(getTicket(store, t.id).effort).toBe('high');
    actions.setEffort('');
    expect(getTicket(store, t.id).effort).toBeNull();
  });

  it('setProvider persists onto an existing ticket, re-pushes state, and empty clears it to inherit', () => {
    const t = createTicket(store, { key: 'P-PR', title: 't' });
    const ctx = mkCtx(t.id);
    const actions = buildTicketFormActions(deps)(ctx);

    actions.setProvider('codex');
    expect(getTicket(store, t.id).agentProvider).toBe('codex');
    expect(ctx.pushes).toBe(1);
    actions.setProvider('');
    expect(getTicket(store, t.id).agentProvider).toBeNull();
    expect(ctx.pushes).toBe(2);
  });

  describe('attachments', () => {
    it('persists a draft ticket on the first attach in create mode', async () => {
      const { actions, ctx, deps } = makeActions({ mode: 'create' });
      deps.pickAttachment = async () => [sourceImage('shot.png')];
      await actions.attachPick();
      expect(ctx.boundTicketId).toBeGreaterThan(0);
      expect(listAttachments(deps.store, ctx.boundTicketId!)).toHaveLength(1);
    });

    it('does not create a second draft on the next attach', async () => {
      const { actions, ctx, deps } = makeActions({ mode: 'create' });
      deps.pickAttachment = async () => [sourceImage('one.png')];
      await actions.attachPick();
      const first = ctx.boundTicketId;
      deps.pickAttachment = async () => [sourceImage('two.png')];
      await actions.attachPick();
      expect(ctx.boundTicketId).toBe(first);
      expect(listAttachments(deps.store, first!)).toHaveLength(2);
    });

    it('does nothing when the picker is cancelled', async () => {
      const { actions, ctx, deps } = makeActions({ mode: 'create' });
      deps.pickAttachment = async () => [];
      await actions.attachPick();
      expect(ctx.boundTicketId).toBeUndefined();
      expect(ctx.posted.filter((m) => m.type === 'error')).toEqual([]);
    });

    it('reports a picker rejection inline without binding a draft', async () => {
      const { actions, ctx, deps } = makeActions({ mode: 'create' });
      deps.pickAttachment = async () => {
        throw new Error('picker failed');
      };
      const outcome = await actions.attachPick().then(
        () => 'resolved',
        () => 'rejected',
      );
      expect(outcome).toBe('resolved');
      expect(ctx.boundTicketId).toBeUndefined();
      expect(ctx.posted).toContainEqual({ type: 'error', message: 'picker failed' });
    });

    it('ingests every file the picker returns', async () => {
      const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
      deps.pickAttachment = async () => [sourceImage('a.png'), sourceImage('b.png')];
      await actions.attachPick();
      expect(listAttachments(deps.store, ticketId!)).toHaveLength(2);
    });

    it('reports an unsupported file as an inline error and attaches nothing', async () => {
      const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
      deps.pickAttachment = async () => [sourceFile('README', 'plain text, no extension')];
      await actions.attachPick();
      expect(listAttachments(deps.store, ticketId!)).toEqual([]);
      expect(ctx.posted).toContainEqual(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('not a supported attachment') }),
      );
    });

    it('stores pasted bytes and pushes fresh state', async () => {
      const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
      await actions.attachBytes('shot.png', Buffer.from('PNGDATA').toString('base64'));
      const rows = listAttachments(deps.store, ticketId!);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.originalName).toBe('shot.png');
      expect(ctx.statePushes).toBeGreaterThan(0);
    });

    it('rejects invalid base64 as an inline error, not a throw', async () => {
      const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
      await actions.attachBytes('shot.png', '!!!not-base64!!!');
      expect(listAttachments(deps.store, ticketId!)).toEqual([]);
      expect(ctx.posted).toContainEqual(expect.objectContaining({ type: 'error' }));
    });

    it('rejects invalid base64 before binding a create-mode draft', async () => {
      const { actions, ctx, deps } = makeActions({ mode: 'create' });
      await actions.attachBytes('shot.png', '!!!not-base64!!!');
      expect(ctx.boundTicketId).toBeUndefined();
      expect(listTickets(deps.store)).toEqual([]);
      expect(ctx.posted).toContainEqual({
        type: 'error',
        message: 'shot.png could not be decoded',
      });
    });

    it('rejects an unsupported pasted filename before binding a create-mode draft', async () => {
      const { actions, ctx, deps } = makeActions({ mode: 'create' });

      await actions.attachBytes('README', Buffer.from('no extension').toString('base64'));

      expect(ctx.boundTicketId).toBeUndefined();
      expect(listTickets(deps.store)).toEqual([]);
      expect(ctx.posted).toContainEqual(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('not a supported attachment'),
        }),
      );
    });

    it('rejects the largest encoded payload that decodes over the cap before binding a draft', async () => {
      const { actions, ctx, deps } = makeActions({ mode: 'create' });
      const maximumEncodedPayload = Buffer.alloc(MAX_PASTE_BYTES + 1).toString('base64');
      expect(maximumEncodedPayload).toHaveLength(Math.ceil(MAX_PASTE_BYTES / 3) * 4);
      expect(Buffer.from(maximumEncodedPayload, 'base64').byteLength).toBe(MAX_PASTE_BYTES + 1);

      await actions.attachBytes('edge.png', maximumEncodedPayload);

      expect(ctx.boundTicketId).toBeUndefined();
      expect(listTickets(deps.store)).toEqual([]);
      expect(ctx.posted).toContainEqual(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('too large') }),
      );
    });

    // Identical bytes are one file, so a second attach must not add a second tile
    // pointing at it — and must certainly not leave a row whose file a later
    // detach would unlink out from under the first.
    it('does not add a second row for identical bytes', async () => {
      const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
      const b64 = Buffer.from('SAME').toString('base64');
      await actions.attachBytes('one.png', b64);
      await actions.attachBytes('two.png', b64);
      expect(listAttachments(deps.store, ticketId!)).toHaveLength(1);
    });

    it('removes bytes when an in-flight attach loses its parent ticket', async () => {
      const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });

      const attaching = actions.attachBytes('late.png', Buffer.from('LATE').toString('base64'));
      deleteTicket(deps.store, ticketId!);
      await attaching;

      expect(listAttachments(deps.store, ticketId!)).toEqual([]);
      const directory = attachmentDir(deps.storageDir, ticketId!);
      expect(existsSync(directory) ? readdirSync(directory) : []).toEqual([]);
      expect(ctx.posted).toContainEqual({
        type: 'error',
        message: 'This ticket was deleted before the attachment could be saved.',
      });
    });

    it('detaches an attachment and unlinks its file', async () => {
      const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
      await actions.attachBytes('shot.png', Buffer.from('X').toString('base64'));
      const row = listAttachments(deps.store, ticketId!)[0]!;
      const path = attachmentPath(deps.storageDir, ticketId!, row.storedName);
      expect(existsSync(path)).toBe(true);
      await actions.detachAttachment(row.id);
      expect(listAttachments(deps.store, ticketId!)).toEqual([]);
      expect(existsSync(path)).toBe(false);
    });

    it('keeps shared bytes until a deliberately seeded duplicate row is the last reference', async () => {
      const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
      await actions.attachBytes('shot.png', Buffer.from('SHARED').toString('base64'));
      const first = listAttachments(deps.store, ticketId!)[0]!;
      const path = attachmentPath(deps.storageDir, ticketId!, first.storedName);
      deps.store.db.exec('DROP INDEX idx_ticket_attachments_ticket_stored_name');
      const info = deps.store.db.prepare(
        `INSERT INTO ticket_attachments
           (ticket_id, kind, stored_name, original_name, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        ticketId!,
        first.kind,
        first.storedName,
        'legacy-copy.png',
        first.byteSize,
        '2026-08-01T00:00:00.000Z',
      );
      const duplicateId = Number(info.lastInsertRowid);

      await actions.detachAttachment(first.id);

      expect(getAttachment(deps.store, duplicateId)).not.toBeNull();
      expect(existsSync(path)).toBe(true);

      await actions.detachAttachment(duplicateId);

      expect(listAttachments(deps.store, ticketId!)).toEqual([]);
      expect(existsSync(path)).toBe(false);
    });

    it('reports an unlink failure inline and keeps the row retryable', async () => {
      const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
      await actions.attachBytes('shot.png', Buffer.from('X').toString('base64'));
      const row = listAttachments(deps.store, ticketId!)[0]!;
      const path = attachmentPath(deps.storageDir, ticketId!, row.storedName);
      rmSync(path);
      mkdirSync(path);

      const outcome = await actions.detachAttachment(row.id).then(
        () => 'resolved',
        () => 'rejected',
      );

      expect(getAttachment(deps.store, row.id)).not.toBeNull();
      expect(outcome).toBe('resolved');
      expect(ctx.posted).toContainEqual(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('directory') }),
      );
    });

    it('ignores a detach for an unknown id', async () => {
      const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
      await expect(actions.detachAttachment(9999)).resolves.toBeUndefined();
      expect(listAttachments(deps.store, ticketId!)).toEqual([]);
    });

    // An id belonging to another ticket must not let this panel delete its file.
    it('ignores a detach for an attachment on another ticket', async () => {
      const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
      const other = createTicket(deps.store, { key: 'OTHER-1', title: 'other' }).id;
      const foreign = insertAttachment(deps.store, {
        ticketId: other, kind: 'image', storedName: 'x.png', originalName: 'x.png', byteSize: 1,
      });
      expect(foreign).not.toBeNull();
      if (!foreign) return;
      await actions.detachAttachment(foreign.id);
      expect(getAttachment(deps.store, foreign.id)).not.toBeNull();
      expect(ticketId).not.toBe(other);
    });

    it('opens an attachment by its absolute path', async () => {
      const { actions, deps, ticketId } = makeActions({ mode: 'edit' });
      const opened: string[] = [];
      deps.openFile = (p: string) => {
        opened.push(p);
      };
      await actions.attachBytes('shot.png', Buffer.from('X').toString('base64'));
      const row = listAttachments(deps.store, ticketId!)[0]!;
      await actions.openAttachment(row.id);
      expect(opened).toEqual([attachmentPath(deps.storageDir, ticketId!, row.storedName)]);
    });

    it('reports an asynchronous open failure inline', async () => {
      const { actions, ctx, deps, ticketId } = makeActions({ mode: 'edit' });
      const rejected = Promise.reject(new Error('open failed'));
      // Avoid an unhandled rejection in the pre-fix implementation, which
      // discards this promise instead of awaiting it.
      void rejected.catch(() => {});
      deps.openFile = () => rejected;
      await actions.attachBytes('shot.png', Buffer.from('X').toString('base64'));
      const row = listAttachments(deps.store, ticketId!)[0]!;

      await actions.openAttachment(row.id);

      expect(ctx.posted).toContainEqual({ type: 'error', message: 'open failed' });
    });

    it('does not open an attachment belonging to another ticket', async () => {
      const { actions, deps } = makeActions({ mode: 'edit' });
      const opened: string[] = [];
      deps.openFile = (p: string) => {
        opened.push(p);
      };
      const other = createTicket(deps.store, { key: 'OTHER-2', title: 'other' }).id;
      const foreign = insertAttachment(deps.store, {
        ticketId: other, kind: 'image', storedName: 'x.png', originalName: 'x.png', byteSize: 1,
      });
      expect(foreign).not.toBeNull();
      if (!foreign) return;
      await actions.openAttachment(foreign.id);
      expect(opened).toEqual([]);
    });
  });

  describe('provider ticket creation (869e9xq5y-fu1)', () => {
    const CREATED = { ref: 'cu-new-1', url: 'https://app.clickup.com/t/cu-new-1' };

    it('createProviderTicket mints the task and binds sourceRef on an unbound edit-mode ticket', async () => {
      const t = createTicket(store, { key: 'P-1', title: 'Fix login', description: 'modal' });
      deps.provider = fakeProvider({ createTicket: vi.fn(async () => CREATED) });
      const ctx = mkCtx(t.id);
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.createProviderTicket();

      expect(deps.provider.createTicket).toHaveBeenCalledWith({ title: 'Fix login', description: 'modal' });
      expect(getTicket(store, t.id).sourceRef).toBe('cu-new-1');
      expect(ctx.posted).toContainEqual({ type: 'provider-ticket-created', ...CREATED });
      expect(ctx.posted).toContainEqual({ type: 'busy', what: 'provider-ticket', on: true });
      expect(ctx.posted).toContainEqual({ type: 'busy', what: 'provider-ticket', on: false });
      expect(ctx.pushes).toBe(1); // re-seeded so the link appears
    });

    it('never re-creates a task for an already-bound ticket (no double-creation)', async () => {
      const t = createTicket(store, { key: 'P-2', title: 't' });
      updateTicketFields(store, t.id, { sourceRef: 'cu-existing' });
      const providerCreate = vi.fn(async () => CREATED);
      deps.provider = fakeProvider({ createTicket: providerCreate });
      const ctx = mkCtx(t.id);
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.createProviderTicket();

      expect(providerCreate).not.toHaveBeenCalled();
      expect(getTicket(store, t.id).sourceRef).toBe('cu-existing');
    });

    it('reports a provider failure inline and leaves the ticket untouched', async () => {
      const t = createTicket(store, { key: 'P-3', title: 't' });
      deps.provider = fakeProvider({
        createTicket: vi.fn(async () => {
          throw new Error('ClickUp: a List ID is required to create tickets');
        }),
      });
      const ctx = mkCtx(t.id);
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.createProviderTicket();

      expect(getTicket(store, t.id).sourceRef).toBeNull(); // ticket survives
      expect(ctx.posted).toContainEqual({
        type: 'provider-ticket-error',
        message: 'ClickUp: a List ID is required to create tickets',
      });
      expect(ctx.pushes).toBe(1); // stays on the page, retryable
    });

    it('refuses when the provider cannot create tickets', async () => {
      const t = createTicket(store, { key: 'P-4', title: 't' });
      const ctx = mkCtx(t.id);
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.createProviderTicket();

      expect(ctx.posted).toContainEqual({
        type: 'provider-ticket-error',
        message: 'This provider cannot create tickets.',
      });
      expect(getTicket(store, t.id).sourceRef).toBeNull();
    });

    it('is a no-op in create mode with no bound ticket', async () => {
      const providerCreate = vi.fn(async () => CREATED);
      deps.provider = fakeProvider({ createTicket: providerCreate });
      const ctx = mkCtx();
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.createProviderTicket();

      expect(providerCreate).not.toHaveBeenCalled();
    });

    it('submit with createInProvider creates + binds the task before starting', async () => {
      deps.provider = fakeProvider({ createTicket: vi.fn(async () => CREATED) });
      const ctx = mkCtx();
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.submit({
        key: 'NEW-CU', title: 'Fix login', description: 'modal', repos: ['fe'], approach: 'rpi',
        agent: null, model: null, ticketType: null, createInProvider: true,
      });

      const t = getTicket(store, listTickets(store)[0]!.id);
      expect(t.sourceRef).toBe('cu-new-1');
      expect(ctx.posted).toContainEqual({ type: 'provider-ticket-created', ...CREATED });
      expect(startTicket).toHaveBeenCalledWith(t.id, { pullBase: true });
    });

    it('submit with createInProvider on a provider failure keeps the ticket, skips the launch, and stays retryable', async () => {
      deps.provider = fakeProvider({
        createTicket: vi.fn(async () => {
          throw new Error('ClickUp: a List ID is required to create tickets');
        }),
      });
      const ctx = mkCtx();
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.submit({
        key: 'NEW-FAIL', title: 'Fix login', description: 'modal', repos: ['fe'], approach: 'rpi',
        agent: null, model: null, ticketType: null, createInProvider: true,
      });

      // The Karst ticket was persisted FIRST and must survive the provider failure.
      const tickets = listTickets(store);
      expect(tickets).toHaveLength(1);
      expect(tickets[0]!.sourceRef).toBeNull();
      expect(startTicket).not.toHaveBeenCalled();
      expect(ctx.posted).toContainEqual({
        type: 'provider-ticket-error',
        message: 'ClickUp: a List ID is required to create tickets',
      });
      expect(ctx.pushes).toBeGreaterThan(0); // re-seeded so the page offers a retry
    });

    it('submit with createInProvider:false never calls the provider', async () => {
      const providerCreate = vi.fn(async () => CREATED);
      deps.provider = fakeProvider({ createTicket: providerCreate });
      const ctx = mkCtx();
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.submit({
        key: 'NEW-LOCAL', title: 't', description: '', repos: ['fe'], approach: 'rpi',
        agent: null, model: null, ticketType: null, createInProvider: false,
      });

      expect(providerCreate).not.toHaveBeenCalled();
      expect(listTickets(store)[0]!.sourceRef).toBeNull();
    });

    it('save with createInProvider binds the task without starting anything', async () => {
      deps.provider = fakeProvider({ createTicket: vi.fn(async () => CREATED) });
      const ctx = mkCtx();
      const actions = buildTicketFormActions(deps)(ctx);

      await actions.save({
        key: 'SAVE-CU', title: 'Fix login', description: 'modal', repos: [], approach: null,
        agent: null, model: null, ticketType: null, createInProvider: true,
      });

      expect(getTicket(store, listTickets(store)[0]!.id).sourceRef).toBe('cu-new-1');
      expect(startTicket).not.toHaveBeenCalled();
      expect(ctx.posted).toContainEqual({ type: 'provider-ticket-created', ...CREATED });
    });
  });

});
