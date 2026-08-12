import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketFields } from '../../store/tickets.js';
import { insertAttachment } from '../../store/attachments.js';
import { setStage } from '../../store/stages.js';
import { buildTicketFormState } from './state.js';
import type { Manifest, RepositoryDef } from '../../manifest/types.js';
import {
  manifest as buildManifest,
  repo as bareRepo,
  runnableRepo,
  slot,
} from '../../manifest/fixtures.js';
import type { PoolAgent } from '../../agents/pool.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';

const AGENTS: PoolAgent[] = [{ name: 'reviewer', source: 'file' }];
const REMOTE_MODELS: ModelCatalog = {
  claude: [{ id: 'claude-remote', label: 'Claude Remote', providers: ['claude'] }],
  codex: [{ id: 'codex-remote', label: 'Codex Remote', providers: ['codex'] }],
  antigravity: [{ id: 'agy-remote', label: 'Antigravity Remote', providers: ['antigravity'] }],
  opencode: [],
};

function svc(over: Partial<RepositoryDef> = {}): RepositoryDef {
  return runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, over);
}

const MANIFEST: Manifest = buildManifest(
  {
    fe: svc({ signals: ['ui', 'modal'] }),
    be: svc({ signals: ['api'] }),
  },
  {
    portRange: [4000, 4100],
    approaches: [
      {
        id: 'rpi',
        label: 'RPI',
        recommended: true,
        source: { type: 'git', repo: 'a/b', ref: 'main', include: ['.claude/agents'] },
      },
      {
        id: 'tdd',
        label: 'TDD',
        source: { type: 'git', repo: 'a/b', ref: 'main', include: ['skills/tdd'] },
      },
      // No source → built-in approach, needs no install, always offered.
      { id: 'direct', label: 'Direct' },
    ],
    agents: {},
    worktreePathDisplay: 'absolute',
  },
);

describe('buildTicketFormState — create mode', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('starts an empty draft in create mode', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    expect(s.mode).toBe('create');
    expect(s.ticketId).toBeUndefined();
    expect(s.key).toBe('');
    expect(s.title).toBe('');
    expect(s.brief).toBeNull();
    expect(s.stepper).toEqual([]); // no ticket yet → no workflow to show
  });

  it("defaults provider to 'manual' when the manifest has no ticketing config", () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    expect(s.provider).toBe('manual');
  });

  it('reflects the configured ticketing provider', () => {
    const withClickup: Manifest = { ...MANIFEST, ticketing: { provider: 'clickup' } };
    const s = buildTicketFormState(store, withClickup, () => [], () => []);
    expect(s.provider).toBe('clickup');
  });

  it('enables ticket search for a clickup provider with a configured list (default on)', () => {
    const withClickup: Manifest = {
      ...MANIFEST,
      ticketing: { provider: 'clickup', listId: '42' },
    };
    const s = buildTicketFormState(store, withClickup, () => [], () => []);
    expect(s.ticketSearchEnabled).toBe(true);
  });

  it('disables ticket search without a configured list (nothing to search)', () => {
    const withClickup: Manifest = { ...MANIFEST, ticketing: { provider: 'clickup' } };
    const s = buildTicketFormState(store, withClickup, () => [], () => []);
    expect(s.ticketSearchEnabled).toBe(false);
  });

  it('honors an explicit searchEnabled: false', () => {
    const off: Manifest = {
      ...MANIFEST,
      ticketing: { provider: 'clickup', listId: '42', searchEnabled: false },
    };
    const s = buildTicketFormState(store, off, () => [], () => []);
    expect(s.ticketSearchEnabled).toBe(false);
  });

  it('disables ticket search for the manual provider', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    expect(s.ticketSearchEnabled).toBe(false);
  });

  it('enables provider-ticket creation only for the clickup provider (869e9xq5y-fu1)', () => {
    const withClickup: Manifest = { ...MANIFEST, ticketing: { provider: 'clickup' } };
    expect(
      buildTicketFormState(store, withClickup, () => [], () => []).canCreateProviderTicket,
    ).toBe(true);
    // No listId still allows creation — an unconfigured list must surface its
    // clear inline error, not hide the control that would say so.
    expect(
      buildTicketFormState(store, withClickup, () => [], () => []).canCreateProviderTicket,
    ).toBe(true);
    expect(buildTicketFormState(store, MANIFEST, () => [], () => []).canCreateProviderTicket).toBe(
      false,
    );
  });

  it('offers the current provider models from an injected catalog', () => {
    const withCodex: Manifest = { ...MANIFEST, agentProvider: 'codex' };
    const s = buildTicketFormState(
      store,
      withCodex,
      () => [],
      () => [],
      undefined,
      undefined,
      REMOTE_MODELS,
    );
    expect(s.models).toEqual([
      { id: 'codex-remote', label: 'Codex Remote', providers: ['codex'] },
    ]);
  });

  it('carries the whole model catalog so the webview can re-filter on an agent-core switch', () => {
    // Create mode: the host no-ops set-provider (no ticket to persist), so no
    // state push follows a provider pick. The page must be able to re-render
    // the Model select locally, which needs every provider's models — the
    // flattened `models` list alone (current provider only) cannot answer a
    // switch to a different core.
    const s = buildTicketFormState(
      store,
      MANIFEST,
      () => [],
      () => [],
      undefined,
      undefined,
      REMOTE_MODELS,
    );
    expect(s.modelCatalog).toEqual(REMOTE_MODELS);
  });

  it('offers installed sourced approaches plus built-in (sourceless) ones', () => {
    // rpi installed; tdd sourced-but-not-installed (dropped); direct built-in
    // (always); karst-graph-engineering offered since the Slice 3 T12 flip
    // ships the packaged default ENABLED.
    const s = buildTicketFormState(store, MANIFEST, () => ['rpi'], () => []);
    expect(s.approaches.map((a) => a.id)).toEqual(['rpi', 'direct', 'karst-graph-engineering']);
    expect(s.approaches.every((a) => a.installed === true)).toBe(true);
  });

  it('drops disabled approaches (built-in and installed sourced) from the picker', () => {
    const m: Manifest = {
      ...MANIFEST,
      approaches: [
        { id: 'rpi', label: 'RPI', source: { type: 'git', repo: 'a/b', ref: 'main', include: ['x'] }, enabled: false },
        { id: 'tdd', label: 'TDD', source: { type: 'git', repo: 'a/b', ref: 'main', include: ['y'] } },
        { id: 'direct', label: 'Direct', enabled: false },
        { id: 'single-subagent', label: 'Single subagent' },
      ],
    };
    // rpi installed but disabled → dropped; direct built-in but disabled → dropped;
    // tdd installed+enabled → kept; single-subagent built-in+enabled → kept;
    // karst-graph-engineering packaged default is ENABLED (Slice 3 T12 flip) → kept.
    const s = buildTicketFormState(store, m, () => ['rpi', 'tdd'], () => []);
    expect(s.approaches.map((a) => a.id)).toEqual(['tdd', 'single-subagent', 'karst-graph-engineering']);
  });

  it('always offers a built-in (sourceless) approach even when nothing is installed', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    // direct + the ENABLED packaged graph built-in (Slice 3 T12 flip).
    expect(s.approaches.map((a) => a.id)).toEqual(['direct', 'karst-graph-engineering']);
  });

  it('defaults to the recommended-flagged approach even when it is not first', () => {
    const m: Manifest = {
      ...MANIFEST,
      approaches: [
        { id: 'tdd', label: 'TDD', source: { type: 'git', repo: 'a/b', ref: 'main', include: ['x'] } },
        { id: 'rpi', label: 'RPI', recommended: true, source: { type: 'git', repo: 'a/b', ref: 'main', include: ['y'] } },
      ],
    };
    const s = buildTicketFormState(store, m, () => ['tdd', 'rpi'], () => []);
    expect(s.selectedApproach).toBe('rpi'); // recommended wins over first
  });

  it('returns only built-in approaches and defaults to one when nothing is installed', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    // direct + the ENABLED packaged graph built-in (Slice 3 T12 flip); the
    // default pick stays the first (direct), never the graph built-in.
    expect(s.approaches.map((a) => a.id)).toEqual(['direct', 'karst-graph-engineering']);
    expect(s.selectedApproach).toBe('direct');
  });

  it('returns an empty approaches array and null selectedApproach only when the built-in is disabled', () => {
    // An explicit `approaches: []` still resolves the ENABLED packaged
    // built-in (absence = packaged defaults, Slice 3 T12 flip); with nothing
    // else to pick it IS the default pick. The picker is truly empty only
    // when the built-in is explicitly disabled.
    const m = { ...MANIFEST, approaches: [] };
    const s = buildTicketFormState(store, m, () => [], () => []);
    expect(s.approaches.map((a) => a.id)).toEqual(['karst-graph-engineering']);
    expect(s.selectedApproach).toBe('karst-graph-engineering');
    const disabled = { ...MANIFEST, approaches: [{ id: 'karst-graph-engineering', label: 'Graph Engineering', enabled: false }] };
    const s2 = buildTicketFormState(store, disabled, () => [], () => []);
    expect(s2.approaches).toEqual([]);
    expect(s2.selectedApproach).toBeNull();
  });

  it('lists unclassified repositories', () => {
    const m: Manifest = {
      ...MANIFEST,
      repositories: { fe: svc({ signals: [] }), be: svc({ signals: ['api'] }) },
    };
    const s = buildTicketFormState(store, m, () => [], () => []);
    expect(s.unclassified).toEqual(['fe']);
  });

  it('seeds a repo row per repository with its signals and no selection yet', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    expect(s.repos.map((r) => r.service).sort()).toEqual(['be', 'fe']);
    const fe = s.repos.find((r) => r.service === 'fe')!;
    expect(fe.signals).toEqual(['ui', 'modal']);
    expect(fe.selected).toBe(false);
  });

  it('populates agents from the injected listAgents fn, with no selection yet', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => AGENTS);
    expect(s.agents).toEqual(AGENTS);
    expect(s.selectedAgent).toBeNull();
  });
});

describe('buildTicketFormState — repo auto-selection & approach default', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('auto-selects the lone repository even with a zero score', () => {
    const solo: Manifest = { ...MANIFEST, repositories: { only: svc({ signals: [] }) } };
    const s = buildTicketFormState(store, solo, () => [], () => []);
    const row = s.repos.find((r) => r.service === 'only')!;
    expect(row.score).toBe(0);
    expect(row.selected).toBe(true); // single repository is always chosen
  });

  // The motivating case: karst's own extension repo is edited but never run.
  it('offers a repository with no service, marked not runnable', () => {
    const m: Manifest = {
      ...MANIFEST,
      repositories: { docs: bareRepo({ repoPath: '/repo/docs', signals: ['guide'] }) },
    };
    const s = buildTicketFormState(store, m, () => [], () => []);
    const row = s.repos.find((r) => r.service === 'docs')!;
    expect(row.runnable).toBe(false);
    expect(row.selected).toBe(true); // sole repo: still auto-selected
  });

  it('marks a repository that declares a service as runnable', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    expect(s.repos.every((r) => r.runnable)).toBe(true);
  });

  it('does not auto-select any repo in a multi-service stack with no score hits', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => []);
    expect(s.repos.every((r) => r.selected === false)).toBe(true);
  });

  it('defaults the selected approach to the manifest recommended one, not the first', () => {
    const m: Manifest = {
      ...MANIFEST,
      approaches: [
        { id: 'tdd', label: 'TDD' },
        { id: 'rpi', label: 'RPI', recommended: true },
      ],
    };
    const s = buildTicketFormState(store, m, () => ['tdd', 'rpi'], () => []);
    expect(s.selectedApproach).toBe('rpi'); // recommended wins over first
  });

  it('falls back to the first approach when none is flagged recommended', () => {
    const m: Manifest = {
      ...MANIFEST,
      approaches: [
        { id: 'tdd', label: 'TDD' },
        { id: 'rpi', label: 'RPI' },
      ],
    };
    const s = buildTicketFormState(store, m, () => ['tdd', 'rpi'], () => []);
    expect(s.selectedApproach).toBe('tdd');
  });
});

describe('buildTicketFormState — edit mode', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('loads persisted ticket fields into the draft', () => {
    const t = createTicket(store, { key: 'PROJ-7', title: 'a thing', description: 'desc' });
    updateTicketFields(store, t.id, {
      brief: 'the brief',
      approach: 'tdd',
      selectedRepos: ['be'],
    });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.mode).toBe('edit');
    expect(s.ticketId).toBe(t.id);
    expect(s.key).toBe('PROJ-7');
    expect(s.title).toBe('a thing');
    expect(s.description).toBe('desc');
    expect(s.brief).toBe('the brief');
    expect(s.selectedApproach).toBe('tdd');
  });

  it('retains an absent saved ticket model for the model picker', () => {
    const t = createTicket(store, { key: 'P-MODEL', title: 'keep saved model' });
    updateTicketFields(store, t.id, { model: 'codex-preview-removed' });
    const withCodex: Manifest = { ...MANIFEST, agentProvider: 'codex' };

    const s = buildTicketFormState(
      store,
      withCodex,
      () => [],
      () => [],
      t.id,
      undefined,
      REMOTE_MODELS,
    );

    expect(s.selectedModel).toBe('codex-preview-removed');
    expect(s.models.map((model) => model.id)).toEqual(['codex-remote']);
  });

  it('carries the whole model catalog in edit mode too', () => {
    const t = createTicket(store, { key: 'P-CAT', title: 'catalog' });
    const s = buildTicketFormState(
      store,
      MANIFEST,
      () => [],
      () => [],
      t.id,
      undefined,
      REMOTE_MODELS,
    );
    expect(s.modelCatalog).toEqual(REMOTE_MODELS);
  });

  it('marks previously selected repos as selected', () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketFields(store, t.id, { selectedRepos: ['fe'] });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.repos.find((r) => r.service === 'fe')!.selected).toBe(true);
    expect(s.repos.find((r) => r.service === 'be')!.selected).toBe(false);
  });

  it('scores repos against the ticket text and auto-selects hits when none chosen yet', () => {
    // Description contains 'modal' (fe signal) but no 'api' (be signal).
    const t = createTicket(store, { key: 'P-2', title: 'fix', description: 'the login modal breaks' });
    updateTicketFields(store, t.id, { brief: 'the brief' });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    const fe = s.repos.find((r) => r.service === 'fe')!;
    const be = s.repos.find((r) => r.service === 'be')!;
    expect(fe.score).toBeGreaterThan(0);
    expect(fe.selected).toBe(true); // auto-selected: score > 0, no explicit pick
    expect(be.score).toBe(0);
    expect(be.selected).toBe(false);
  });

  it('does not override an explicit repo selection with the score-based default', () => {
    // 'modal' scores fe, but the user explicitly picked only be — respect it.
    const t = createTicket(store, { key: 'P-3', title: 'fix', description: 'login modal' });
    updateTicketFields(store, t.id, { selectedRepos: ['be'] });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.repos.find((r) => r.service === 'fe')!.selected).toBe(false);
    expect(s.repos.find((r) => r.service === 'be')!.selected).toBe(true);
  });

  it('reflects the persisted ticket.agent as selectedAgent, and populates agents', () => {
    const t = createTicket(store, { key: 'P-4', title: 'fix' });
    updateTicketFields(store, t.id, { agent: 'reviewer' });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => AGENTS, t.id);
    expect(s.agents).toEqual(AGENTS);
    expect(s.selectedAgent).toBe('reviewer');
  });

  it('defaults selectedAgent to null when the ticket has no persisted agent', () => {
    const t = createTicket(store, { key: 'P-5', title: 'fix' });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => AGENTS, t.id);
    expect(s.selectedAgent).toBeNull();
  });

  it('throws for an unknown ticket id', () => {
    expect(() => buildTicketFormState(store, MANIFEST, () => [], () => [], 9999)).toThrow(/not found|unknown/i);
  });

  it('projects the ticket stages onto an ordered read-only stepper', () => {
    const t = createTicket(store, { key: 'P-STEP', title: 'fix' });
    setStage(store, t.id, 'scope', { status: 'passed' });
    setStage(store, t.id, 'impl', { status: 'running' });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.stepper.map((c) => c.stageKey)).toEqual([
      'scope', 'impl', 'uat', 'review', 'fix', 'ship', 'done',
    ]);
    expect(s.stepper[0]!.status).toBe('passed');
    expect(s.stepper[1]!.status).toBe('running');
    expect(s.stepper[2]!.status).toBe('pending');
  });

  it('reports sessionOpen from the injected predicate in edit mode', () => {
    const t = createTicket(store, { key: 'P-6', title: 'fix' });
    const open = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id, (id) => id === t.id);
    expect(open.sessionOpen).toBe(true);
    const closed = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id, () => false);
    expect(closed.sessionOpen).toBe(false);
  });

  it('defaults sessionOpen to false when no predicate is injected', () => {
    const t = createTicket(store, { key: 'P-7', title: 'fix' });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.sessionOpen).toBe(false);
  });
});

describe('buildTicketFormState — sessionOpen in create mode', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('is always false in create mode (no ticket, nothing to lock)', () => {
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], undefined, () => true);
    expect(s.sessionOpen).toBe(false);
  });
});

describe('buildTicketFormState — attachments', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('is empty in create mode', () => {
    const state = buildTicketFormState(store, MANIFEST, () => [], () => []);
    expect(state.attachments).toEqual([]);
  });

  it('carries each attachment with an absolute src path in edit mode', () => {
    const ticket = createTicket(store, { key: 'P-ATTACH', title: 'attachment' });
    insertAttachment(store, {
      ticketId: ticket.id,
      kind: 'image',
      storedName: 'aaaa1111bbbb2222.png',
      originalName: 'login-error.png',
      byteSize: 4096,
    });

    const state = buildTicketFormState(
      store,
      MANIFEST,
      () => [],
      () => [],
      ticket.id,
      () => false,
      undefined,
      '/storage',
    );

    expect(state.attachments).toEqual([
      {
        id: expect.any(Number),
        kind: 'image',
        name: 'login-error.png',
        byteSize: 4096,
        src: join('/storage', 'attachments', String(ticket.id), 'aaaa1111bbbb2222.png'),
      },
    ]);
  });

  it('is empty when no storage dir is supplied', () => {
    const ticket = createTicket(store, { key: 'P-NOSTORE', title: 'no storage' });
    insertAttachment(store, {
      ticketId: ticket.id,
      kind: 'image',
      storedName: 'aaaa.png',
      originalName: 'a.png',
      byteSize: 1,
    });

    const state = buildTicketFormState(store, MANIFEST, () => [], () => [], ticket.id);
    expect(state.attachments).toEqual([]);
  });
});

describe('buildTicketFormState — agent core (provider) fields', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('create mode offers every implemented provider, selects none, and defaults to the manifest provider', () => {
    const m: Manifest = { ...MANIFEST, agentProvider: 'codex' };
    const s = buildTicketFormState(store, m, () => [], () => []);
    expect(s.agentProviders).toEqual(['claude', 'codex', 'antigravity', 'opencode']);
    expect(s.selectedAgentProvider).toBeNull();
    expect(s.defaultAgentProvider).toBe('codex');
  });

  it("edit mode reflects the ticket's persisted agentProvider override", () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketFields(store, t.id, { agentProvider: 'antigravity' });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.selectedAgentProvider).toBe('antigravity');
    expect(s.defaultAgentProvider).toBe('claude');
  });

  it("the model list is filtered by the ticket's resolved provider, not always the manifest default", () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketFields(store, t.id, { agentProvider: 'antigravity' });
    const s = buildTicketFormState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.models.map((m) => m.id)).toContain('gemini-3.6-flash-high');
    expect(s.models.map((m) => m.id)).not.toContain('claude-opus-4-8');
  });
});
