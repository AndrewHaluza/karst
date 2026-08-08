import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import { createTicket } from '../store/tickets.js';
import { openProcessRun, listProcessRuns } from '../store/processRuns.js';
import { resolveProcessAssignment, DEFAULT_PROCESS_AGENT_NAMES } from './processAssignment.js';
import { PROCESS_KEY_BY_ROLE } from '../manifest/validate/processAssignments.js';
import type { Manifest } from '../manifest/types.js';
import { manifest as buildManifest } from '../manifest/fixtures.js';
import { bundledModelCatalog, type ModelCatalog } from './modelCatalog.js';

const BASE: Manifest = buildManifest(
  { api: { repoPath: '/repo/api', hasMigrations: false } },
  { agentProvider: 'codex', defaultModel: 'gpt-5.6-sol' },
);

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

  it('explicit process config beats the ticket override', () => {
    const manifest: Manifest = { ...BASE, processes: { review: { provider: 'antigravity' } } };
    expect(
      resolveProcessAssignment(manifest, 'review', { provider: 'claude', model: 'claude-opus-4-8' }),
    ).toEqual({
      agentName: 'Review Agent',
      provider: 'antigravity',
      // The ticket's model is known only for claude and the CONFIG's provider is
      // antigravity — the same cross-provider drop resolveModelForProvider applies
      // to ticket models at launch, so it is dropped rather than launched wrong.
      model: undefined,
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

  it('returns null for every role whose configured process is disabled (Finding 2)', () => {
    for (const role of ['uat-tester', 'uat-fix', 'review', 'review-fix'] as const) {
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
    });
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
