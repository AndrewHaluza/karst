import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket, updateTicketOnboarding } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { buildOnboardingState } from './state.js';
import type { Manifest, RepositoryDef } from '../../manifest/types.js';
import {
  manifest as buildManifest,
  repo as bareRepo,
  runnableRepo,
  slot,
} from '../../manifest/fixtures.js';
import type { PoolAgent } from '../../agents/pool.js';

const AGENTS: PoolAgent[] = [{ name: 'reviewer', source: 'file' }];

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

describe('buildOnboardingState — create mode', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('starts an empty draft in create mode', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => []);
    expect(s.mode).toBe('create');
    expect(s.ticketId).toBeUndefined();
    expect(s.key).toBe('');
    expect(s.title).toBe('');
    expect(s.brief).toBeNull();
    expect(s.stepper).toEqual([]); // no ticket yet → no workflow to show
  });

  it("defaults provider to 'manual' when the manifest has no ticketing config", () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => []);
    expect(s.provider).toBe('manual');
  });

  it('reflects the configured ticketing provider', () => {
    const withClickup: Manifest = { ...MANIFEST, ticketing: { provider: 'clickup' } };
    const s = buildOnboardingState(store, withClickup, () => [], () => []);
    expect(s.provider).toBe('clickup');
  });

  it('offers installed sourced approaches plus built-in (sourceless) ones', () => {
    // rpi installed; tdd sourced-but-not-installed (dropped); direct built-in (always).
    const s = buildOnboardingState(store, MANIFEST, () => ['rpi'], () => []);
    expect(s.approaches.map((a) => a.id)).toEqual(['rpi', 'direct']);
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
    // tdd installed+enabled → kept; single-subagent built-in+enabled → kept.
    const s = buildOnboardingState(store, m, () => ['rpi', 'tdd'], () => []);
    expect(s.approaches.map((a) => a.id)).toEqual(['tdd', 'single-subagent']);
  });

  it('always offers a built-in (sourceless) approach even when nothing is installed', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => []);
    expect(s.approaches.map((a) => a.id)).toEqual(['direct']);
  });

  it('defaults to the recommended-flagged approach even when it is not first', () => {
    const m: Manifest = {
      ...MANIFEST,
      approaches: [
        { id: 'tdd', label: 'TDD', source: { type: 'git', repo: 'a/b', ref: 'main', include: ['x'] } },
        { id: 'rpi', label: 'RPI', recommended: true, source: { type: 'git', repo: 'a/b', ref: 'main', include: ['y'] } },
      ],
    };
    const s = buildOnboardingState(store, m, () => ['tdd', 'rpi'], () => []);
    expect(s.selectedApproach).toBe('rpi'); // recommended wins over first
  });

  it('returns only built-in approaches and defaults to one when nothing is installed', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => []);
    expect(s.approaches.map((a) => a.id)).toEqual(['direct']);
    expect(s.selectedApproach).toBe('direct');
  });

  it('returns an empty approaches array and null selectedApproach when none configured', () => {
    const m = { ...MANIFEST, approaches: [] };
    const s = buildOnboardingState(store, m, () => [], () => []);
    expect(s.approaches).toEqual([]);
    expect(s.selectedApproach).toBeNull();
  });

  it('lists unclassified repositories', () => {
    const m: Manifest = {
      ...MANIFEST,
      repositories: { fe: svc({ signals: [] }), be: svc({ signals: ['api'] }) },
    };
    const s = buildOnboardingState(store, m, () => [], () => []);
    expect(s.unclassified).toEqual(['fe']);
  });

  it('seeds a repo row per repository with its signals and no selection yet', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => []);
    expect(s.repos.map((r) => r.service).sort()).toEqual(['be', 'fe']);
    const fe = s.repos.find((r) => r.service === 'fe')!;
    expect(fe.signals).toEqual(['ui', 'modal']);
    expect(fe.selected).toBe(false);
  });

  it('populates agents from the injected listAgents fn, with no selection yet', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => AGENTS);
    expect(s.agents).toEqual(AGENTS);
    expect(s.selectedAgent).toBeNull();
  });
});

describe('buildOnboardingState — repo auto-selection & approach default', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('auto-selects the lone repository even with a zero score', () => {
    const solo: Manifest = { ...MANIFEST, repositories: { only: svc({ signals: [] }) } };
    const s = buildOnboardingState(store, solo, () => [], () => []);
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
    const s = buildOnboardingState(store, m, () => [], () => []);
    const row = s.repos.find((r) => r.service === 'docs')!;
    expect(row.runnable).toBe(false);
    expect(row.selected).toBe(true); // sole repo: still auto-selected
  });

  it('marks a repository that declares a service as runnable', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => []);
    expect(s.repos.every((r) => r.runnable)).toBe(true);
  });

  it('does not auto-select any repo in a multi-service stack with no score hits', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => []);
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
    const s = buildOnboardingState(store, m, () => ['tdd', 'rpi'], () => []);
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
    const s = buildOnboardingState(store, m, () => ['tdd', 'rpi'], () => []);
    expect(s.selectedApproach).toBe('tdd');
  });
});

describe('buildOnboardingState — edit mode', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('loads persisted ticket fields into the draft', () => {
    const t = createTicket(store, { key: 'PROJ-7', title: 'a thing', description: 'desc' });
    updateTicketOnboarding(store, t.id, {
      brief: 'the brief',
      approach: 'tdd',
      selectedRepos: ['be'],
    });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.mode).toBe('edit');
    expect(s.ticketId).toBe(t.id);
    expect(s.key).toBe('PROJ-7');
    expect(s.title).toBe('a thing');
    expect(s.description).toBe('desc');
    expect(s.brief).toBe('the brief');
    expect(s.selectedApproach).toBe('tdd');
  });

  it('marks previously selected repos as selected', () => {
    const t = createTicket(store, { key: 'P-1', title: 't' });
    updateTicketOnboarding(store, t.id, { selectedRepos: ['fe'] });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.repos.find((r) => r.service === 'fe')!.selected).toBe(true);
    expect(s.repos.find((r) => r.service === 'be')!.selected).toBe(false);
  });

  it('scores repos against the ticket text and auto-selects hits when none chosen yet', () => {
    // Description contains 'modal' (fe signal) but no 'api' (be signal).
    const t = createTicket(store, { key: 'P-2', title: 'fix', description: 'the login modal breaks' });
    updateTicketOnboarding(store, t.id, { brief: 'the brief' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
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
    updateTicketOnboarding(store, t.id, { selectedRepos: ['be'] });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.repos.find((r) => r.service === 'fe')!.selected).toBe(false);
    expect(s.repos.find((r) => r.service === 'be')!.selected).toBe(true);
  });

  it('reflects the persisted ticket.agent as selectedAgent, and populates agents', () => {
    const t = createTicket(store, { key: 'P-4', title: 'fix' });
    updateTicketOnboarding(store, t.id, { agent: 'reviewer' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => AGENTS, t.id);
    expect(s.agents).toEqual(AGENTS);
    expect(s.selectedAgent).toBe('reviewer');
  });

  it('defaults selectedAgent to null when the ticket has no persisted agent', () => {
    const t = createTicket(store, { key: 'P-5', title: 'fix' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => AGENTS, t.id);
    expect(s.selectedAgent).toBeNull();
  });

  it('throws for an unknown ticket id', () => {
    expect(() => buildOnboardingState(store, MANIFEST, () => [], () => [], 9999)).toThrow(/not found|unknown/i);
  });

  it('projects the ticket stages onto an ordered read-only stepper', () => {
    const t = createTicket(store, { key: 'P-STEP', title: 'fix' });
    setStage(store, t.id, 'scope', { status: 'passed' });
    setStage(store, t.id, 'impl', { status: 'running' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.stepper.map((c) => c.stageKey)).toEqual([
      'scope', 'impl', 'uat', 'review', 'fix', 'ship', 'done',
    ]);
    expect(s.stepper[0]!.status).toBe('passed');
    expect(s.stepper[1]!.status).toBe('running');
    expect(s.stepper[2]!.status).toBe('pending');
  });

  it('reports sessionOpen from the injected predicate in edit mode', () => {
    const t = createTicket(store, { key: 'P-6', title: 'fix' });
    const open = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id, (id) => id === t.id);
    expect(open.sessionOpen).toBe(true);
    const closed = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id, () => false);
    expect(closed.sessionOpen).toBe(false);
  });

  it('defaults sessionOpen to false when no predicate is injected', () => {
    const t = createTicket(store, { key: 'P-7', title: 'fix' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.sessionOpen).toBe(false);
  });
});

describe('buildOnboardingState — sessionOpen in create mode', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('is always false in create mode (no ticket, nothing to lock)', () => {
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], undefined, () => true);
    expect(s.sessionOpen).toBe(false);
  });
});

describe('buildOnboardingState — agent core (provider) fields', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));

  it('create mode offers every implemented provider, selects none, and defaults to the manifest provider', () => {
    const m: Manifest = { ...MANIFEST, agentProvider: 'codex' };
    const s = buildOnboardingState(store, m, () => [], () => []);
    expect(s.agentProviders).toEqual(['claude', 'codex', 'antigravity']);
    expect(s.selectedAgentProvider).toBeNull();
    expect(s.defaultAgentProvider).toBe('codex');
  });

  it("edit mode reflects the ticket's persisted agentProvider override", () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'antigravity' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.selectedAgentProvider).toBe('antigravity');
    expect(s.defaultAgentProvider).toBe('claude');
  });

  it("the model list is filtered by the ticket's resolved provider, not always the manifest default", () => {
    const t = createTicket(store, { key: 'K-1', title: 't' });
    updateTicketOnboarding(store, t.id, { agentProvider: 'antigravity' });
    const s = buildOnboardingState(store, MANIFEST, () => [], () => [], t.id);
    expect(s.models.map((m) => m.id)).toContain('gemini-3.6-flash-high');
    expect(s.models.map((m) => m.id)).not.toContain('claude-opus-4-8');
  });
});
