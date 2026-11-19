import { describe, it, expect } from 'vitest';
import type { GraphApproachConfig, Manifest } from '../../manifest/types.js';
import {
  GRAPH_ROLES,
  identitiesDiffer,
  identityDifference,
  launchProfileFor,
  parseRunIdentities,
  resolveLiveGraphProfile,
  resolveRunIdentities,
  serializeRunIdentities,
  summarizeRunIdentities,
} from './runIdentity.js';

const config = {
  planner: { profile: 'expert' },
  profiles: {
    expert: { provider: 'claude', model: 'opus-cfg', effort: 'high' },
    worker: { provider: 'claude', model: 'sonnet-cfg' },
    fast: { provider: 'opencode', model: 'fast-cfg' },
  },
} as unknown as GraphApproachConfig;

function manifestWith(active: string | undefined, slots: Record<string, unknown> = {}): Manifest {
  return {
    activeAgentPreset: active,
    agentPresets: { a: { slots }, b: { slots: { graphWorker: { provider: 'codex', model: 'gpt-x', effort: 'low' } } } },
  } as unknown as Manifest;
}

describe('resolveRunIdentities', () => {
  it('reads each role from the config profile when no preset slot applies', () => {
    const ids = resolveRunIdentities(manifestWith(undefined), config);
    expect(ids.roles.expert).toEqual({ provider: 'claude', model: 'opus-cfg', effort: 'high', source: 'config' });
    expect(ids.roles.fast).toEqual({ provider: 'opencode', model: 'fast-cfg', source: 'config' });
  });

  it('prefers the active preset slot and marks its source', () => {
    const ids = resolveRunIdentities(manifestWith('b'), config);
    expect(ids.roles.worker).toEqual({ provider: 'codex', model: 'gpt-x', effort: 'low', source: 'preset' });
    expect(ids.roles.expert?.source).toBe('config');
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
    const parsed = parseRunIdentities('{"v":1,"roles":{"alien":{"provider":"x","source":"config"}}}');
    expect(parsed?.roles).toEqual({});
  });
});

describe('identitiesDiffer', () => {
  const base = resolveRunIdentities(manifestWith(undefined), config);
  it('is false for equal identities, even when only the source differs', () => {
    expect(identitiesDiffer(base, resolveRunIdentities(manifestWith(undefined), config))).toBe(false);
    const other = { v: 1 as const, roles: { ...base.roles, fast: { ...base.roles.fast!, source: 'preset' } } };
    expect(identitiesDiffer(base, other)).toBe(false);
  });
  it('is true when a model, effort, provider or role presence changes', () => {
    expect(identitiesDiffer(base, resolveRunIdentities(manifestWith('b'), config))).toBe(true);
    const noEffort = { v: 1 as const, roles: { ...base.roles, expert: { provider: 'claude', model: 'opus-cfg', source: 'config' } } };
    expect(identitiesDiffer(base, noEffort)).toBe(true);
    expect(identitiesDiffer(base, { v: 1, roles: { expert: base.roles.expert! } })).toBe(true);
  });
});

describe('summaries', () => {
  const a = resolveRunIdentities(manifestWith(undefined), config);
  const b = resolveRunIdentities(manifestWith('b'), config);
  it('summarizes every role in one line', () => {
    expect(summarizeRunIdentities(a)).toBe('expert claude/opus-cfg (high), worker claude/sonnet-cfg, fast opencode/fast-cfg');
  });
  it('names only the roles that differ', () => {
    expect(identityDifference(a, b)).toBe('worker: claude/sonnet-cfg → codex/gpt-x (low)');
    expect(identityDifference(a, a)).toBe('');
  });
});

describe('launchProfileFor', () => {
  it('returns the snapshot identity for a graph role', () => {
    const snap = resolveRunIdentities(manifestWith('b'), config);
    expect(launchProfileFor(snap, manifestWith('a'), config, 'worker')).toEqual({ provider: 'codex', model: 'gpt-x', effort: 'low' });
  });
  it('resolves live when there is no snapshot (a pre-v133 run)', () => {
    expect(launchProfileFor(undefined, manifestWith('b'), config, 'worker')).toEqual({ provider: 'codex', model: 'gpt-x', effort: 'low' });
  });
  it('resolves a profile that is not a graph role from the config alone', () => {
    const custom = { ...config, profiles: { ...config.profiles, scribe: { provider: 'claude', model: 'm' } } } as unknown as GraphApproachConfig;
    const snap = resolveRunIdentities(manifestWith('b'), custom);
    expect(launchProfileFor(snap, manifestWith('b'), custom, 'scribe')).toEqual({ provider: 'claude', model: 'm', effort: undefined });
  });
  it('falls back to live resolution for a role the snapshot lacks', () => {
    const snap = { v: 1 as const, roles: {} };
    expect(resolveLiveGraphProfile(manifestWith(undefined), config, 'fast')?.provider).toBe('opencode');
    expect(launchProfileFor(snap, manifestWith(undefined), config, 'fast')?.provider).toBe('opencode');
  });
});
