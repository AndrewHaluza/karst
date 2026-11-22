import { describe, expect, it } from 'vitest';
import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import {
  describeGraphRoles,
  graphConfigOfApproach,
  graphRoleView,
  GRAPH_ROLES,
  type GraphRoleView,
} from './graphRoleView.js';
import { resolveGraphNodeProfile, type ResolvedGraphProfile } from './profileResolver.js';

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

describe('graphConfigOfApproach with no id (T1266 fix)', () => {
  it('skips a disabled approach and takes the first enabled one that declares a graph', () => {
    const other = { ...config, profiles: { ...config.profiles, expert: { provider: 'codex', model: 'gpt-x' } } };
    const m = manifest({
      approaches: [
        { id: 'off', label: 'Off', enabled: false, graph: config },
        { id: 'on', label: 'On', enabled: true, graph: other },
      ],
    } as unknown as Partial<Manifest>);
    expect(graphConfigOfApproach(m)).toBe(other);
  });
  it('is undefined when every graph approach is disabled', () => {
    const m = manifest({ approaches: [{ id: 'off', label: 'Off', enabled: false, graph: config }] } as unknown as Partial<Manifest>);
    expect(graphConfigOfApproach(m)).toBeUndefined();
  });
});

describe('describeGraphRoles', () => {
  const view = (expert: ResolvedGraphProfile): GraphRoleView => ({ expert, worker: undefined, fast: undefined });

  it('lists expert, worker, fast with their labels and the rung that supplied each', () => {
    expect(describeGraphRoles(graphRoleView(manifest(), config))).toEqual([
      { role: 'expert', text: 'Claude Code · Opus 5 · high', source: 'approach' },
      { role: 'worker', text: 'Claude Code · Sonnet 5 · low', source: 'approach' },
      { role: 'fast', text: 'Claude Code · Sonnet 5 · low', source: 'approach' },
    ]);
  });
  it('prints the core and model labels, never the raw ids', () => {
    const lines = describeGraphRoles(view({ provider: 'claude', model: 'claude-sonnet-5', effort: 'low', source: 'approach' }));
    expect(lines[0]?.text).toBe('Claude Code · Sonnet 5 · low');
  });
  it('prints a routed model with its catalog label', () => {
    const lines = describeGraphRoles(view({ provider: 'opencode2', model: 'opencode-go/deepseek-v4.1-flash', source: 'approach' }));
    expect(lines[0]?.text).toBe('OpenCode v2 · OpenCode Go · DeepSeek v4.1 Flash');
  });
  it('reads a null model as the agent default', () => {
    const lines = describeGraphRoles(view({ provider: 'codex', source: 'preset' }));
    expect(lines[0]?.text).toBe('Codex · Agent default');
  });
  it('is empty when no role resolves', () => {
    expect(describeGraphRoles(graphRoleView(manifest(), undefined))).toEqual([]);
  });
});
