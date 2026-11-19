import { describe, it, expect } from 'vitest';
import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import {
  GRAPH_ROLES,
  identitiesDiffer,
  identityDifference,
  parseRunIdentities,
  pinnedProfile,
  resolveRunIdentities,
  serializeRunIdentities,
  summarizeRunIdentities,
} from './runIdentity.js';

const config = {
  planner: { profile: 'expert' },
  profiles: {
    expert: { provider: 'claude', model: 'claude-opus-5', effort: 'high' },
    worker: { provider: 'claude', model: 'claude-sonnet-5' },
    fast: { provider: 'opencode', model: 'mimo-2.5' },
  },
} as unknown as GraphApproachConfig;

function manifestWith(active: string | undefined, slots: Record<string, unknown> = {}): Manifest {
  return {
    activeAgentPreset: active,
    agentPresets: { a: { slots }, b: { slots: { graphWorker: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'low' } } } },
  } as unknown as Manifest;
}

describe('resolveRunIdentities', () => {
  it('reads each role from the config profile when no preset slot applies', () => {
    const ids = resolveRunIdentities(manifestWith(undefined), config);
    expect(ids.roles.expert).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high', source: 'approach' });
    expect(ids.roles.fast).toEqual({ provider: 'opencode', model: 'mimo-2.5', source: 'approach' });
  });

  it('prefers the active preset slot and marks its source', () => {
    const ids = resolveRunIdentities(manifestWith('b'), config);
    expect(ids.roles.worker).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', source: 'preset' });
    expect(ids.roles.expert?.source).toBe('approach');
  });

  it('omits a role that neither the preset nor the config declares', () => {
    const sparse = { planner: { profile: 'expert' }, profiles: {} } as unknown as GraphApproachConfig;
    expect(resolveRunIdentities(manifestWith(undefined), sparse).roles).toEqual({});
  });

  it('lists the three graph roles', () => {
    expect([...GRAPH_ROLES]).toEqual(['expert', 'worker', 'fast']);
  });
});

describe('serialize and parse', () => {
  it('round-trips a snapshot', () => {
    const ids = resolveRunIdentities(manifestWith('b'), config);
    expect(parseRunIdentities(serializeRunIdentities(ids))).toEqual(ids);
  });

  it('returns undefined for null, bad JSON and a wrong shape', () => {
    expect(parseRunIdentities(null)).toBeUndefined();
    expect(parseRunIdentities('{nope')).toBeUndefined();
    expect(parseRunIdentities('{"v":1}')).toBeUndefined();
    expect(parseRunIdentities('{"v":2,"roles":{}}')).toBeUndefined();
    expect(parseRunIdentities('{"v":1,"roles":{"expert":{"model":"m"}}}')).toBeUndefined();
  });

  it('ignores a role name it does not know', () => {
    const parsed = parseRunIdentities('{"v":1,"roles":{"alien":{"provider":"x","source":"approach"}}}');
    expect(parsed?.roles).toEqual({});
  });
});

describe('identitiesDiffer', () => {
  const base = resolveRunIdentities(manifestWith(undefined), config);
  it('is false for equal identities, even when only the source differs', () => {
    expect(identitiesDiffer(base, resolveRunIdentities(manifestWith(undefined), config))).toBe(false);
    const other = { v: 1 as const, roles: { ...base.roles, fast: { ...base.roles.fast!, source: 'preset' as const } } };
    expect(identitiesDiffer(base, other)).toBe(false);
  });
  it('is true when a model, effort, provider or role presence changes', () => {
    expect(identitiesDiffer(base, resolveRunIdentities(manifestWith('b'), config))).toBe(true);
    const noEffort = { v: 1 as const, roles: { ...base.roles, expert: { provider: 'claude', model: 'claude-opus-5', source: 'approach' as const } } };
    expect(identitiesDiffer(base, noEffort)).toBe(true);
    expect(identitiesDiffer(base, { v: 1, roles: { expert: base.roles.expert! } })).toBe(true);
  });
});

describe('summaries', () => {
  const a = resolveRunIdentities(manifestWith(undefined), config);
  const b = resolveRunIdentities(manifestWith('b'), config);
  it('summarizes every role in one line', () => {
    expect(summarizeRunIdentities(a)).toBe('expert claude/claude-opus-5 (high), worker claude/claude-sonnet-5, fast opencode/mimo-2.5');
  });
  it('names only the roles that differ', () => {
    expect(identityDifference(a, b)).toBe('worker: claude/claude-sonnet-5 → codex/gpt-5.6-sol (low)');
    expect(identityDifference(a, a)).toBe('');
  });
});

describe('ticket fields', () => {
  it('fold the ticket core, model and effort into the snapshot', () => {
    const ids = resolveRunIdentities(manifestWith(undefined), config, {
      agentPreset: null,
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'max',
    });
    expect(ids.roles.expert).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'max', source: 'ticket' });
  });
  it('make a ticket change differ from the stored snapshot', () => {
    const none = { agentPreset: null, provider: null, model: null, effort: null };
    const before = resolveRunIdentities(manifestWith(undefined), config, none);
    const after = resolveRunIdentities(manifestWith(undefined), config, { ...none, effort: 'max' });
    expect(identitiesDiffer(before, after)).toBe(true);
  });
});

describe('pinnedProfile', () => {
  const snap = resolveRunIdentities(manifestWith('b'), config);
  it('returns the snapshot identity for a graph role', () => {
    expect(pinnedProfile(snap, 'worker')).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', source: 'preset' });
  });
  it('returns undefined without a snapshot, for a role it lacks, and for a profile that is not a graph role', () => {
    expect(pinnedProfile(undefined, 'worker')).toBeUndefined();
    expect(pinnedProfile({ v: 1, roles: {} }, 'fast')).toBeUndefined();
    expect(pinnedProfile(snap, 'scribe')).toBeUndefined();
  });
});
