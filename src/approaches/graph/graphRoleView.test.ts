import { describe, expect, it } from 'vitest';
import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import { describeGraphRoles, graphConfigOfApproach, graphRoleView, GRAPH_ROLES } from './graphRoleView.js';
import { resolveGraphNodeProfile } from './profileResolver.js';

const config: GraphApproachConfig = {
  planner: { profile: 'expert', prompt: { artifact: 'x' } },
  profiles: {
    expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    worker: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    fast: { provider: 'claude', model: 'claude-sonnet-5', effort: 'low' },
  },
  commands: {},
  limits: {} as GraphApproachConfig['limits'],
};

const manifest = (extra: Partial<Manifest> = {}): Manifest =>
  ({
    agentProvider: 'codex',
    defaultModel: 'gpt-x',
    approaches: [{ id: 'dyn', label: 'Dyn', enabled: true, graph: config }],
    ...extra,
  }) as unknown as Manifest;

describe('graphRoleView', () => {
  it('falls back to the approach profile, never the Default row', () => {
    const view = graphRoleView(manifest(), config);
    expect(view.expert).toMatchObject({ provider: 'claude', model: 'claude-opus-5', source: 'approach' });
    expect(view.worker?.source).toBe('approach');
    expect(view.fast?.model).toBe('claude-sonnet-5');
  });

  it('uses the preset slot when it is set', () => {
    const m = manifest({
      agentPresets: { p: { slots: { graphExpert: { provider: 'claude', model: 'claude-sonnet-5' } } } },
    } as unknown as Partial<Manifest>);
    const view = graphRoleView(m, config, { agentPreset: 'p', provider: null, model: null, effort: null });
    expect(view.expert).toMatchObject({ model: 'claude-sonnet-5', source: 'preset' });
    expect(view.worker?.source).toBe('approach');
  });

  it('reports the ticket rung', () => {
    const view = graphRoleView(manifest(), config, {
      agentPreset: null,
      provider: 'claude',
      model: 'claude-sonnet-5',
      effort: null,
    });
    expect(view.expert?.source).toBe('ticket');
  });

  it('matches the launch resolver for every role', () => {
    const m = manifest();
    const view = graphRoleView(m, config);
    for (const role of GRAPH_ROLES) {
      expect(view[role]).toEqual(resolveGraphNodeProfile(m, config, role));
    }
  });

  it('returns undefined roles when there is no config', () => {
    expect(graphRoleView(manifest(), undefined)).toEqual({ expert: undefined, worker: undefined, fast: undefined });
  });
});

describe('graphConfigOfApproach', () => {
  it('finds the graph block of an approach id', () => {
    expect(graphConfigOfApproach(manifest(), 'dyn')).toBe(config);
    expect(graphConfigOfApproach(manifest(), 'other')).toBeUndefined();
    expect(graphConfigOfApproach(manifest(), null)).toBeUndefined();
  });

  it('with no id, uses the first approach that declares a graph', () => {
    expect(graphConfigOfApproach(manifest())).toBe(config);
  });
});

describe('describeGraphRoles', () => {
  it('lists expert, worker, fast with a text and the rung that supplied it', () => {
    expect(describeGraphRoles(graphRoleView(manifest(), config))).toEqual([
      { role: 'expert', text: 'claude · claude-opus-5 · high', source: 'approach' },
      { role: 'worker', text: 'claude · claude-sonnet-5 · low', source: 'approach' },
      { role: 'fast', text: 'claude · claude-sonnet-5 · low', source: 'approach' },
    ]);
  });
  it('is empty when no role resolves', () => {
    expect(describeGraphRoles(graphRoleView(manifest(), undefined))).toEqual([]);
  });
});
