import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { openProcessRun, listProcessRuns } from '../store/processRuns.js';
import { resolveProcessAssignment, DEFAULT_PROCESS_AGENT_NAMES } from './processAssignment.js';
import { PROCESS_KEY_BY_ROLE } from '../manifest/validate/processAssignments.js';
import type { Manifest } from '../manifest/types.js';
import { fullPreset, manifest as buildManifest } from '../manifest/fixtures.js';
import { bundledModelCatalog, type ModelCatalog } from './modelCatalog.js';

const BASE: Manifest = buildManifest(
  { api: { repoPath: '/repo/api', hasMigrations: false } },
  { agentProvider: 'codex', defaultModel: 'gpt-5.6-sol' },
);

/**
 * A manifest whose ACTIVE preset overrides ONLY `uatTester` — every other
 * capability has no slot and is therefore Inherit (§3's sparse matrix), which
 * is what pins that each of the six roles reads its OWN capability row.
 */
function mSparse(): Manifest {
  return buildManifest(
    { api: { repoPath: '/repo/api', hasMigrations: false } },
    {
      agentProvider: 'codex',
      defaultModel: 'gpt-5.6-sol',
      agentPresets: {
        uatOnly: { slots: { uatTester: { provider: 'claude', model: 'claude-sonnet-5' } } },
      },
      activeAgentPreset: 'uatOnly',
    },
  );
}

describe('resolveProcessAssignment', () => {
  it('resolves the approved defaults when no process config exists', () => {
    expect(resolveProcessAssignment(BASE, 'uat-tester')).toEqual({
      agentName: 'UAT Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(resolveProcessAssignment(BASE, 'uat-fix')).toEqual({
      agentName: 'UAT Fix Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(resolveProcessAssignment(BASE, 'review')).toEqual({
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(resolveProcessAssignment(BASE, 'review-fix')).toEqual({
      agentName: 'Review Fix Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('resolves the pr-description role to the ticket-resolved adapter', () => {
    expect(resolveProcessAssignment(BASE, 'pr-description')).toEqual({
      agentName: 'Codex',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('resolves the ticket-analysis role to the approved default agent on the manifest core', () => {
    expect(resolveProcessAssignment(BASE, 'ticket-analysis')).toEqual({
      agentName: 'Ticket Analysis Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('applies an explicit ticketAnalysis assignment and the ticket override', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: { ticketAnalysis: { provider: 'opencode', model: 'gemini-2.5-pro' } },
    };
    expect(resolveProcessAssignment(manifest, 'ticket-analysis')).toEqual({
      agentName: 'Ticket Analysis Agent',
      provider: 'opencode',
      model: 'gemini-2.5-pro',
    });
    expect(
      resolveProcessAssignment(manifest, 'ticket-analysis', {
        provider: 'claude',
        model: 'claude-sonnet-5',
      }),
    ).toEqual({
      agentName: 'Ticket Analysis Agent',
      // §4 rung 1: the TICKET's own core and model win over the config's.
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
  });

  // The assigned profile reference (`processes.<key>.agent`) rides the snapshot
  // VERBATIM so the host's execution boundary can resolve its body as the
  // process's instructions. A display-name override (`agentName`) must NOT
  // erase it — the profile still drives the prompt even under a custom label.
  it('carries the assigned profile reference alongside the agentName display label', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: {
        ticketAnalysis: {
          agent: 'description-improver',
          agentName: 'My Analyzer',
          provider: 'opencode',
          model: 'gemini-2.5-pro',
        },
      },
    };
    expect(resolveProcessAssignment(manifest, 'ticket-analysis')).toEqual({
      agentName: 'My Analyzer',
      agent: 'description-improver',
      provider: 'opencode',
      model: 'gemini-2.5-pro',
    });
    // No profile set → no `agent` key at all (the snapshot stays lean).
    expect(resolveProcessAssignment(BASE, 'ticket-analysis')).not.toHaveProperty('agent');
  });

  it('applies an explicit assignment over the defaults (plan example)', () => {
    const manifest: Manifest = { ...BASE, processes: { uatTester: { model: 'sol' } } };
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
      agentName: 'UAT Agent',
      provider: 'codex',
      model: 'sol',
    });
  });

  it('prefers explicit agentName, provider and model from the config', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: {
        review: { agentName: 'Team Reviewer', provider: 'antigravity', model: 'gemini-3.6-flash-high' },
      },
    };
    expect(resolveProcessAssignment(manifest, 'review')).toEqual({
      agentName: 'Team Reviewer',
      provider: 'antigravity',
      model: 'gemini-3.6-flash-high',
    });
  });

  it('names the referenced agent profile when agentName is absent', () => {
    const manifest: Manifest = {
      ...BASE,
      agents: { 'uat-author': { role: 'uat' } },
      processes: { uatTester: { agent: 'uat-author' } },
    };
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
      agentName: 'uat-author',
    });
  });

  it('agentName beats the referenced agent profile', () => {
    const manifest: Manifest = {
      ...BASE,
      agents: { 'uat-author': { role: 'uat' } },
      processes: { uatTester: { agent: 'uat-author', agentName: 'My UAT' } },
    };
    expect(resolveProcessAssignment(manifest, 'uat-tester')!.agentName).toBe('My UAT');
  });

  it('ticket override wins over manifest defaults', () => {
    expect(
      resolveProcessAssignment(BASE, 'review', { provider: 'claude', model: 'claude-sonnet-5' }),
    ).toEqual({
      agentName: 'Review Agent',
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
  });

  it('the ticket override beats the explicit process config (§4 rung 1)', () => {
    const manifest: Manifest = { ...BASE, processes: { review: { provider: 'antigravity' } } };
    expect(
      resolveProcessAssignment(manifest, 'review', { provider: 'claude', model: 'claude-opus-4-8' }),
    ).toEqual({
      agentName: 'Review Agent',
      provider: 'claude',
      model: 'claude-opus-4-8',
    });
  });

  it('drops a ticket model known only for another provider, keeping the manifest default', () => {
    expect(resolveProcessAssignment(BASE, 'review', { model: 'claude-sonnet-5' })).toEqual({
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('uses the active catalog to reject a newly discovered cross-provider ticket model', () => {
    const bundled = bundledModelCatalog();
    const activeCatalog: ModelCatalog = {
      ...bundled,
      claude: [
        ...bundled.claude,
        { id: 'feed-only-claude', label: 'Feed Claude', providers: ['claude'] },
      ],
    };

    expect(
      resolveProcessAssignment(
        BASE,
        'review',
        { provider: 'codex', model: 'feed-only-claude' },
        activeCatalog,
      ),
    ).toEqual({
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('keeps an explicitly configured model even when known only for another provider', () => {
    const manifest: Manifest = { ...BASE, processes: { review: { model: 'claude-sonnet-5' } } };
    expect(resolveProcessAssignment(manifest, 'review')).toMatchObject({
      model: 'claude-sonnet-5',
    });
  });

  it('resolves no model when neither ticket nor manifest has one', () => {
    const manifest = buildManifest(
      { api: { repoPath: '/repo/api', hasMigrations: false } },
      { agentProvider: 'codex' },
    );
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toEqual({
      agentName: 'UAT Agent',
      provider: 'codex',
      model: undefined,
    });
  });

  it('carries the verbatim config effort when the resolved model advertises it', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: { uatTester: { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' } },
    };
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5',
      effort: 'high',
    });
  });

  it('drops an explicit config effort the resolved model does not advertise', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: { uatTester: { provider: 'claude', model: 'claude-sonnet-5', effort: 'xhigh' } },
    };
    const snapshot = resolveProcessAssignment(manifest, 'uat-tester')!;
    expect(snapshot.model).toBe('claude-sonnet-5');
    expect('effort' in snapshot).toBe(false);
  });

  it('drops a config effort when no model resolves for the row', () => {
    const manifest = buildManifest(
      { api: { repoPath: '/repo/api', hasMigrations: false } },
      { agentProvider: 'codex' },
    );
    const withEffort: Manifest = { ...manifest, processes: { review: { effort: 'high' } } };
    const snapshot = resolveProcessAssignment(withEffort, 'review')!;
    expect(snapshot.model).toBeUndefined();
    expect('effort' in snapshot).toBe(false);
  });

  it('ticket effort wins over the manifest default, gated on the advertised model', () => {
    const manifest = buildManifest(
      { api: { repoPath: '/repo/api', hasMigrations: false } },
      { agentProvider: 'claude', defaultModel: 'claude-sonnet-5', defaultEffort: 'low' },
    );
    expect(
      resolveProcessAssignment(manifest, 'uat-tester', { effort: 'high' }),
    ).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
    });
  });

  it('resolves the manifest default effort when none is set and the model advertises it', () => {
    const manifest = buildManifest(
      { api: { repoPath: '/repo/api', hasMigrations: false } },
      { agentProvider: 'claude', defaultModel: 'claude-sonnet-5', defaultEffort: 'high' },
    );
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
    });
  });

  it('leaves effort off the snapshot when nothing is set and no default resolves', () => {
    expect('effort' in (resolveProcessAssignment(BASE, 'uat-tester') ?? {})).toBe(false);
  });

  it('returns null for every role whose configured process is disabled (Finding 2)', () => {
    for (const role of ['uat-tester', 'uat-fix', 'review', 'review-fix', 'ticket-analysis'] as const) {
      const manifest: Manifest = {
        ...BASE,
        processes: { [PROCESS_KEY_BY_ROLE[role]]: { enabled: false } },
      };
      expect(resolveProcessAssignment(manifest, role)).toBeNull();
    }
  });

  it('keeps resolving when the process config is absent or explicitly enabled', () => {
    expect(resolveProcessAssignment(BASE, 'uat-tester')).toMatchObject({ provider: 'codex' });
    const enabled: Manifest = { ...BASE, processes: { uatTester: { enabled: true } } };
    expect(resolveProcessAssignment(enabled, 'uat-tester')).toMatchObject({ provider: 'codex' });
  });

  it('pr-description keeps its existing behavior — unaffected by another role being disabled', () => {
    const manifest: Manifest = { ...BASE, processes: { uatTester: { enabled: false } } };
    expect(resolveProcessAssignment(manifest, 'pr-description')).toEqual({
      agentName: 'Codex',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('falls back to claude when the manifest declares no provider', () => {
    const manifest = buildManifest({ api: { repoPath: '/repo/api', hasMigrations: false } });
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toEqual({
      agentName: 'UAT Agent',
      provider: 'claude',
      model: undefined,
    });
  });

  it('exposes the approved default names keyed by role', () => {
    expect(DEFAULT_PROCESS_AGENT_NAMES).toEqual({
      'uat-tester': 'UAT Agent',
      'uat-fix': 'UAT Fix Agent',
      review: 'Review Agent',
      'review-fix': 'Review Fix Agent',
      'ticket-analysis': 'Ticket Analysis Agent',
    });
  });

  // The retired inline override: the resolver must never produce an
  // `instructions` value of its own, whatever a legacy config carries. The
  // profile body is resolved at the host's execution boundary instead, so a
  // second source here would be able to outrank the Settings pick invisibly.
  it('never resolves instructions itself, even from a legacy inline value', () => {
    const manifest = {
      ...BASE,
      processes: {
        uatTester: { instructions: 'Focus on API endpoints.' },
        review: { instructions: 'Check for regression patterns.' },
      },
    } as unknown as Manifest;
    expect('instructions' in (resolveProcessAssignment(manifest, 'uat-tester') ?? {})).toBe(false);
    expect(resolveProcessAssignment(manifest, 'review')?.instructions).toBeUndefined();
  });

  it('carries no instructions key when none are configured', () => {
    expect(resolveProcessAssignment(BASE, 'uat-tester')).toEqual({
      agentName: 'UAT Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect('instructions' in (resolveProcessAssignment(BASE, 'uat-tester') ?? {})).toBe(false);
  });

  // §4 rung 2 over rung 3 (§8: "preset beats processes.<key>"): the slot
  // replaces the config's own provider/model, it does not merge with them.
  it('the preset slot beats the process config provider and model', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: {
        fast: fullPreset('opencode', 'opencode-go/deepseek-v4-flash'),
      },
      activeAgentPreset: 'fast',
      processes: { review: { provider: 'antigravity', model: 'gemini-3.6-flash-high' } },
    };
    const snap = resolveProcessAssignment(manifest, 'review', {});
    expect(snap?.provider).toBe('opencode');
    expect(snap?.model).toBe('opencode-go/deepseek-v4-flash');
  });

  it('the process config supplies the slot when the preset has no slot for the role (Inherit)', () => {
    const manifest: Manifest = {
      ...mSparse(),
      processes: { review: { provider: 'antigravity', model: 'gemini-3.6-flash-high' } },
    };
    const snap = resolveProcessAssignment(manifest, 'review', {});
    expect(snap?.provider).toBe('antigravity');
    expect(snap?.model).toBe('gemini-3.6-flash-high');
  });

  it('a ticket preset applies to every process role when the role names none', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: { deep: fullPreset('claude', 'claude-opus-5') },
      processes: { review: {} },
    };
    const snap = resolveProcessAssignment(manifest, 'review', { preset: 'deep' });
    expect(snap?.provider).toBe('claude');
    expect(snap?.model).toBe('claude-opus-5');
  });

  it('the process preset beats the ticket preset', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: {
        fast: fullPreset('opencode', 'opencode-go/deepseek-v4-flash'),
        deep: fullPreset('claude', 'claude-opus-5'),
      },
      processes: { review: { preset: 'fast' } },
    };
    const snap = resolveProcessAssignment(manifest, 'review', { preset: 'deep' });
    expect(snap?.provider).toBe('opencode');
  });

  it('a ticket preset does not override an explicit ticket provider/model', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: { deep: fullPreset('claude', 'claude-opus-5') },
    };
    const snap = resolveProcessAssignment(manifest, 'review', {
      preset: 'deep',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
    expect(snap?.provider).toBe('codex');
    expect(snap?.model).toBe('gpt-5.6-sol');
  });

  // A preset is a (core, model) PAIR: its model applies ONLY on its own core, so
  // an explicit different core must not inherit it.
  it('drops a preset model when the ticket explicitly picks a different provider', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: { deep: fullPreset('claude', 'claude-opus-5') },
    };
    const snap = resolveProcessAssignment(manifest, 'review', { preset: 'deep', provider: 'codex' });
    expect(snap?.provider).toBe('codex');
    expect(snap?.model).toBe('gpt-5.6-sol');
    expect(snap?.model).not.toBe('claude-opus-5');
  });
});

describe('resolveProcessAssignment precedence rungs (§4)', () => {
  it('rung 0: enabled:false wins over a preset slot that names the role', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: { all: fullPreset('claude', 'claude-opus-5', 'high') },
      activeAgentPreset: 'all',
      processes: { review: { enabled: false } },
    };
    expect(resolveProcessAssignment(manifest, 'review')).toBeNull();
    // …and the disabled sibling does not disable the others.
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
      provider: 'claude',
      model: 'claude-opus-5',
    });
  });

  it('rung 1: a ticket field beats the preset slot', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: { all: fullPreset('claude', 'claude-opus-5', 'high') },
      activeAgentPreset: 'all',
    };
    const snap = resolveProcessAssignment(manifest, 'review', {
      provider: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(snap).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' });
  });

  it('rung 2 applies as a WHOLE slot: core, model and effort travel together', () => {
    const manifest: Manifest = {
      ...BASE,
      agentPresets: { all: fullPreset('claude', 'claude-opus-5', 'low') },
      activeAgentPreset: 'all',
    };
    expect(resolveProcessAssignment(manifest, 'review', {})).toEqual({
      agentName: 'Review Agent',
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'low',
    });
    // A ticket that picks another core drops the WHOLE slot, never just its
    // model — then the manifest defaults take over.
    expect(resolveProcessAssignment(manifest, 'review', { provider: 'codex' })).toEqual({
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('rung 1: a ticket core never drags a known-foreign config model across it', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: { review: { provider: 'antigravity', model: 'gemini-3.6-flash-high' } },
    };
    // On the config's own core the declared model stays verbatim, exactly as
    // before — even though the catalog knows it for another provider.
    expect(resolveProcessAssignment(manifest, 'review')).toMatchObject({
      provider: 'antigravity',
      model: 'gemini-3.6-flash-high',
    });
    // A ticket that picks another core must not inherit it: "a model never
    // crosses to another core" still holds for rung 3.
    const snap = resolveProcessAssignment(manifest, 'review', { provider: 'claude' });
    expect(snap).toMatchObject({ provider: 'claude' });
    expect(snap?.model).toBeUndefined();
  });

  it('rung 3: the process config beats the manifest defaults', () => {
    const manifest: Manifest = {
      ...BASE,
      processes: { review: { provider: 'antigravity', model: 'gemini-3.6-flash-high' } },
    };
    expect(resolveProcessAssignment(manifest, 'review')).toMatchObject({
      provider: 'antigravity',
      model: 'gemini-3.6-flash-high',
    });
  });

  it('rung 4: the manifest defaults apply when nothing above them is set', () => {
    expect(resolveProcessAssignment(BASE, 'review')).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  // The six roles each resolve THEIR OWN capability row: a preset that only
  // overrides the UAT tester must not leak onto review, pr-description, …
  it('each of the six roles reads its own capability slot', () => {
    const manifest = mSparse();
    expect(resolveProcessAssignment(manifest, 'uat-tester')).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
    for (const role of ['uat-fix', 'review', 'review-fix', 'pr-description', 'ticket-analysis'] as const) {
      expect(resolveProcessAssignment(manifest, role)).toMatchObject({
        provider: 'codex',
        model: 'gpt-5.6-sol',
      });
    }
  });
});

describe('process_runs snapshot immutability', () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => store.close());

  it('a later Settings edit does not mutate an already stored process_runs row', () => {
    const ticketId = createTicket(store, { key: 'T-1', title: 't' }).id;
    const snapshot = resolveProcessAssignment(BASE, 'review')!;
    openProcessRun(store, {
      ticketId,
      stageKey: 'review',
      processId: 'review',
      attempt: 1,
      agentName: snapshot.agentName ?? null,
      provider: snapshot.provider,
      model: snapshot.model ?? null,
      startedAt: '2026-08-08T10:00:00.000Z',
    });

    const edited: Manifest = {
      ...BASE,
      processes: {
        review: { agentName: 'Renamed', provider: 'claude', model: 'claude-opus-4-8' },
      },
    };
    resolveProcessAssignment(edited, 'review');

    const rows = listProcessRuns(store, ticketId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentName: 'Review Agent',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      status: 'running',
    });
  });
});
