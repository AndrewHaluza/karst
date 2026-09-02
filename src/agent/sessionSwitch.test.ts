import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from './modelCatalog.js';
import {
  agentSwitchCoreChoices,
  agentSwitchModelChoices,
  applyAgentSwitchSelection,
  buildAgentSessionView,
  canSwitchAgentSession,
  type AgentSwitchFlowDeps,
} from './sessionSwitch.js';

const CATALOG: ModelCatalog = {
  claude: [{ id: 'claude-x', label: 'Claude X', providers: ['claude'], efforts: ['low', 'high'] }],
  codex: [{ id: 'codex-x', label: 'Codex X', providers: ['codex'] }],
  antigravity: [{ id: 'agy-x', label: 'Agy X', providers: ['antigravity'] }],
  opencode: [],
};

describe('agent switch presentation', () => {
  // The switch is available at EVERY stage — impl, the gate stages, ship, done
  // and scope — whether or not a live session is open: the whole point is to
  // let a user change core after a provider hit its usage limit mid-flight
  // (869ehtcmz). The ONE withheld state is a running Fix execution, which owns
  // the live session and must not be interrupted.
  it.each([
    'scope', 'impl', 'fix', 'uat', 'review', 'ship', 'done', null,
  ] as const)('offers the switch at %s even with no live session', (stage) => {
    expect(canSwitchAgentSession(stage)).toBe(true);
    // The fix-execution guard is the ONLY withholding state (asserted below).
    expect(canSwitchAgentSession(stage, stage === 'fix')).toBe(stage !== 'fix');
  });

  it('withholds the switch only while a Fix execution owns the live session', () => {
    expect(canSwitchAgentSession('fix', true)).toBe(false);
  });

  it('lists every implemented core with its canonical label for the header select', () => {
    expect(agentSwitchCoreChoices()).toEqual([
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'antigravity', label: 'Antigravity CLI' },
      { id: 'opencode', label: 'OpenCode' },
    ]);
  });

  it('labels opencode in the agent session view', () => {
    expect(buildAgentSessionView({
      provider: 'opencode', ticketModel: null, defaultModel: null,
      catalog: CATALOG, stageCurrent: 'impl',
    }).providerLabel).toBe('OpenCode');
  });

  it('offers only compatible models plus an accurately labeled inherit choice', () => {
    expect(agentSwitchModelChoices({
      provider: 'codex', ticketModel: 'claude-x', defaultModel: 'codex-x', catalog: CATALOG,
    })).toEqual([
      { model: null, label: 'Inherit (settings: Codex X)', description: 'codex-x', picked: true },
      { model: 'codex-x', label: 'Codex X', description: 'codex-x', picked: false },
    ]);
    expect(agentSwitchModelChoices({
      provider: 'codex', ticketModel: 'claude-x', defaultModel: 'claude-x', catalog: CATALOG,
    })[0]!.label).toBe('Agent default');
  });

  it('renders the resolved provider/model and switch availability', () => {
    expect(buildAgentSessionView({
      provider: 'codex', ticketModel: null, defaultModel: 'codex-x',
      catalog: CATALOG, stageCurrent: 'impl',
    })).toEqual({
      provider: 'codex', providerLabel: 'Codex',
      modelId: 'codex-x', modelLabel: 'Codex X', effort: null, canSwitch: true,
    });
  });

  it('resolves the effort/variant against the resolved model', () => {
    expect(buildAgentSessionView({
      provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
      ticketEffort: 'high', defaultEffort: null,
      catalog: CATALOG, stageCurrent: 'impl',
    }).effort).toBe('high');
    // An effort the model does not advertise is not carried.
    expect(buildAgentSessionView({
      provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
      ticketEffort: 'ultracode', defaultEffort: null,
      catalog: CATALOG, stageCurrent: 'impl',
    }).effort).toBeNull();
    // Falls back to the manifest default.
    expect(buildAgentSessionView({
      provider: 'claude', ticketModel: null, defaultModel: 'claude-x',
      ticketEffort: null, defaultEffort: 'high',
      catalog: CATALOG, stageCurrent: 'impl',
    }).effort).toBe('high');
  });

  it('keeps the switch available at a later stage with no live session', () => {
    expect(buildAgentSessionView({
      provider: 'codex', ticketModel: null, defaultModel: 'codex-x',
      catalog: CATALOG, stageCurrent: 'done',
    }).canSwitch).toBe(true);
  });

  it('uses the selected provider label when model ids are shared', () => {
    const catalog: ModelCatalog = {
      claude: [{ id: 'shared', label: 'Claude Shared', providers: ['claude'] }],
      codex: [{ id: 'shared', label: 'Codex Shared', providers: ['codex'] }],
      antigravity: [],
      opencode: [],
    };

    expect(buildAgentSessionView({
      provider: 'codex', ticketModel: null, defaultModel: 'shared',
      catalog, stageCurrent: 'impl',
    }).modelLabel).toBe('Codex Shared');
  });
});

function flow(overrides: Partial<AgentSwitchFlowDeps> = {}) {
  const order: string[] = [];
  const deps: AgentSwitchFlowDeps = {
    read: () => ({
      stageCurrent: 'impl', provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
      ticketEffort: null, defaultEffort: null,
    }),
    isSessionOpen: () => true,
    isProviderReady: async (provider) => (order.push(`ready:${provider}`), true),
    confirm: async ({ willReplaceSession }) => (order.push(`confirm:replace=${String(willReplaceSession)}`), true),
    persist: (selection) => order.push(`persist:${selection.provider}:${selection.model}`),
    dispose: () => order.push('dispose'),
    launch: async (options) => {
      order.push(`launch:allow-resume=${String(options.allowResume)}:provider-ready=${String(options.providerReady)}`);
    },
    ...overrides,
  };
  return { deps, order };
}

describe('applyAgentSwitchSelection', () => {
  it('rejects a switch during an owned Fix execution without mutating anything', async () => {
    let owned = true;
    const { deps, order } = flow({
      read: () => ({
        stageCurrent: 'fix', provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
        ticketEffort: null, defaultEffort: null,
        fixExecutionActive: true,
      }),
      dispose: () => { owned = false; order.push('dispose'); },
    });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).toEqual([]);
    expect(owned).toBe(true);
  });

  it('persists one selection, disposes the live session, then launches', async () => {
    const { deps, order } = flow();
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null }),
    ).resolves.toEqual({ kind: 'switched' });
    expect(order).toEqual(['ready:codex', 'confirm:replace=true', 'persist:codex:codex-x', 'dispose', 'launch:allow-resume=false:provider-ready=true']);
  });

  it('persists and launches — with no dispose — when no live session is open', async () => {
    const { deps, order } = flow({ isSessionOpen: () => false });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null }),
    ).resolves.toEqual({ kind: 'switched' });
    expect(order).toEqual(['ready:codex', 'confirm:replace=false', 'persist:codex:codex-x', 'launch:allow-resume=false:provider-ready=true']);
  });

  it('allows a model-only switch on the current core without a readiness probe', async () => {
    const { deps, order } = flow({ isProviderReady: async () => { order.push('ready:unexpected'); return true; } });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'claude', model: 'claude-x', effort: null }),
    ).resolves.toEqual({ kind: 'switched' });
    expect(order).toEqual(['confirm:replace=true', 'persist:claude:claude-x', 'dispose', 'launch:allow-resume=false:provider-ready=true']);
  });

  it('keeps the current session when the new core is not ready', async () => {
    const { deps, order } = flow({ isProviderReady: async () => false });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null }),
    ).resolves.toEqual({ kind: 'unavailable', provider: 'codex' });
    expect(order.some((e) => e.startsWith('persist'))).toBe(false);
    expect(order).not.toContain('dispose');
  });

  it('rejects a model that is not among the provider’s own choices', async () => {
    const { deps, order } = flow();
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'claude-x', effort: null }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).toEqual([]);
  });

  it('allows a custom opencode model not in the catalog (provider/model format)', async () => {
    const { deps, order } = flow();
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'opencode', model: 'openrouter/z-ai/glm-5.2', effort: null }),
    ).resolves.toEqual({ kind: 'switched' });
    expect(order).toContain('persist:opencode:openrouter/z-ai/glm-5.2');
  });


  it('rejects an unknown provider', async () => {
    const { deps, order } = flow();
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'evil' as never, model: null, effort: null }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).toEqual([]);
  });

  it('cancelling at the confirm modal mutates nothing', async () => {
    const { deps, order } = flow({ confirm: async () => false });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null }),
    ).resolves.toEqual({ kind: 'cancelled', at: 'confirm' });
    expect(order.some((e) => e.startsWith('persist'))).toBe(false);
    expect(order).not.toContain('dispose');
  });

  it('revalidates after confirmation when a Fix execution takes over the session', async () => {
    let reads = 0;
    const { deps, order } = flow({
      read: () => ({
        stageCurrent: 'fix',
        provider: 'claude', ticketModel: null, defaultModel: null,
        ticketEffort: null, defaultEffort: null,
        fixExecutionActive: ++reads === 2,
      }),
    });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(order).not.toContain('dispose');
  });

  it('keeps the new selection and reports a retryable launch failure', async () => {
    const { deps, order } = flow({ launch: async () => { order.push('launch'); throw new Error('spawn'); } });
    const outcome = await applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null });
    expect(outcome.kind).toBe('launch-failed');
    expect(order.slice(-3)).toEqual(['persist:codex:codex-x', 'dispose', 'launch']);
  });

  it('leaves the old terminal open when persistence fails', async () => {
    const { deps, order } = flow({ persist: () => { throw new Error('write'); } });
    await expect(
      applyAgentSwitchSelection(deps, CATALOG, { provider: 'codex', model: 'codex-x', effort: null }),
    ).rejects.toThrow('write');
    expect(order).not.toContain('dispose');
    expect(order.some((e) => e.startsWith('launch'))).toBe(false);
  });
});
