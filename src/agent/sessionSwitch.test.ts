import { describe, expect, it } from 'vitest';
import type { ModelCatalog } from './modelCatalog.js';
import {
  agentSwitchModelChoices,
  agentSwitchProviderChoices,
  buildAgentSessionView,
  canSwitchAgentSession,
  runAgentSwitchFlow,
  type AgentSwitchFlowDeps,
} from './sessionSwitch.js';

const CATALOG: ModelCatalog = {
  claude: [{ id: 'claude-x', label: 'Claude X', providers: ['claude'] }],
  codex: [{ id: 'codex-x', label: 'Codex X', providers: ['codex'] }],
  antigravity: [{ id: 'agy-x', label: 'Agy X', providers: ['antigravity'] }],
  opencode: [],
};

describe('agent switch presentation', () => {
  it.each([
    ['impl', true, true],
    ['fix', true, true],
    ['impl', false, false],
    ['review', true, false],
  ] as const)('switchability at %s/open=%s is %s', (stage, open, expected) => {
    expect(canSwitchAgentSession(stage, open)).toBe(expected);
  });

  it('omits the current provider and supplies human labels', () => {
    expect(agentSwitchProviderChoices('claude')).toEqual([
      { provider: 'codex', label: 'Codex' },
      { provider: 'antigravity', label: 'Antigravity' },
      { provider: 'opencode', label: 'OpenCode' },
    ]);
  });

  it('labels opencode in the agent session view', () => {
    expect(buildAgentSessionView({
      provider: 'opencode', ticketModel: null, defaultModel: null,
      catalog: CATALOG, stageCurrent: 'impl', sessionOpen: true,
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
      catalog: CATALOG, stageCurrent: 'impl', sessionOpen: true,
    })).toEqual({
      provider: 'codex', providerLabel: 'Codex',
      modelId: 'codex-x', modelLabel: 'Codex X', canSwitch: true,
    });
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
      catalog, stageCurrent: 'impl', sessionOpen: true,
    }).modelLabel).toBe('Codex Shared');
  });
});

function flow(overrides: Partial<AgentSwitchFlowDeps> = {}) {
  const order: string[] = [];
  const deps: AgentSwitchFlowDeps = {
    read: () => ({
      stageCurrent: 'impl', provider: 'claude', ticketModel: 'claude-x', defaultModel: null,
    }),
    isSessionOpen: () => true,
    pickProvider: async () => (order.push('pick-provider'), 'codex'),
    isProviderReady: async (provider) => (order.push(`ready:${provider}`), true),
    pickModel: async (_provider, choices) => (order.push('pick-model'), choices[1]),
    confirm: async () => (order.push('confirm'), true),
    persist: (selection) => order.push(`persist:${selection.provider}:${selection.model}`),
    dispose: () => order.push('dispose'),
    launch: async (options) => {
      order.push(
        `launch:allow-resume=${String(options.allowResume)}:provider-ready=${String(options.providerReady)}`,
      );
    },
    ...overrides,
  };
  return { deps, order };
}

describe('runAgentSwitchFlow', () => {
  it('persists one selection, disposes, then launches', async () => {
    const { deps, order } = flow();
    await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({ kind: 'switched' });
    expect(order).toEqual([
      'pick-provider', 'ready:codex', 'pick-model', 'confirm',
      'persist:codex:codex-x', 'dispose',
      'launch:allow-resume=false:provider-ready=true',
    ]);
  });

  it('awaits replacement readiness and keeps the current session when it times out', async () => {
    let finishReadiness!: (ready: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { finishReadiness = resolve; });
    const { deps, order } = flow({
      isProviderReady: async () => {
        order.push('ready:codex');
        return await readiness;
      },
    });

    const switching = runAgentSwitchFlow(deps, CATALOG);
    await Promise.resolve();
    expect(order).toEqual(['pick-provider', 'ready:codex']);

    finishReadiness(false);
    await expect(switching).resolves.toEqual({ kind: 'unavailable', provider: 'codex' });
    expect(order.some((entry) => entry.startsWith('persist'))).toBe(false);
    expect(order).not.toContain('dispose');
  });

  it('propagates a replacement readiness error without mutating or disposing', async () => {
    const readiness = Promise.reject(new Error('probe failed'));
    // Avoid an unhandled-rejection diagnostic against the pre-fix implementation,
    // which does not yet await the returned promise.
    void readiness.catch(() => undefined);
    const { deps, order } = flow({
      isProviderReady: async () => await readiness,
    });

    await expect(runAgentSwitchFlow(deps, CATALOG)).rejects.toThrow('probe failed');
    expect(order.some((entry) => entry.startsWith('persist'))).toBe(false);
    expect(order).not.toContain('dispose');
  });

  it.each(['provider', 'model', 'confirm'] as const)(
    'cancelling at %s mutates nothing', async (at) => {
      const { deps, order } = flow({
        ...(at === 'provider' ? { pickProvider: async () => undefined } : {}),
        ...(at === 'model' ? { pickModel: async () => undefined } : {}),
        ...(at === 'confirm' ? { confirm: async () => false } : {}),
      });
      await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({ kind: 'cancelled', at });
      expect(order.some((entry) => entry.startsWith('persist'))).toBe(false);
      expect(order).not.toContain('dispose');
      expect(order.some((entry) => entry.startsWith('launch'))).toBe(false);
    },
  );

  it('keeps the current session when the selected CLI is unavailable', async () => {
    const { deps, order } = flow({ isProviderReady: async () => false });
    await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({
      kind: 'unavailable', provider: 'codex',
    });
    expect(order).not.toContain('dispose');
  });

  it('revalidates stage, provider, and live terminal after confirmation', async () => {
    let reads = 0;
    const { deps, order } = flow({
      read: () => ({
        stageCurrent: ++reads === 1 ? 'impl' : 'review',
        provider: 'claude', ticketModel: null, defaultModel: null,
      }),
    });
    await expect(runAgentSwitchFlow(deps, CATALOG)).resolves.toEqual({ kind: 'stale' });
    expect(order).not.toContain('dispose');
  });

  it('keeps the new selection and reports a retryable launch failure', async () => {
    const { deps, order } = flow({ launch: async () => { order.push('launch'); throw new Error('spawn'); } });
    const outcome = await runAgentSwitchFlow(deps, CATALOG);
    expect(outcome.kind).toBe('launch-failed');
    expect(order.slice(-3)).toEqual(['persist:codex:codex-x', 'dispose', 'launch']);
  });

  it('leaves the old terminal open when persistence fails', async () => {
    const { deps, order } = flow({ persist: () => { throw new Error('write'); } });
    await expect(runAgentSwitchFlow(deps, CATALOG)).rejects.toThrow('write');
    expect(order).not.toContain('dispose');
    expect(order.some((entry) => entry.startsWith('launch'))).toBe(false);
  });
});
