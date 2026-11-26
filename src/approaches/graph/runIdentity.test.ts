import { describe, it, expect, vi } from 'vitest';
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
import { ticketLaunchFields } from './profileResolver.js';

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

describe('pinned account', () => {
  const base = resolveRunIdentities(manifestWith(undefined), config);
  const withAccount = (account: unknown): string =>
    JSON.stringify({ v: 1, roles: { ...base.roles, worker: { ...base.roles.worker, account } } });

  it('serializes and parses a pinned account per role', () => {
    const ids = {
      v: 1 as const,
      roles: { ...base.roles, worker: { ...base.roles.worker!, account: 'work' } },
    };
    expect(parseRunIdentities(serializeRunIdentities(ids))).toEqual(ids);
  });

  it('drops an unsafe account name, keeps the role, and logs one debug line', () => {
    const debug = vi.fn();
    for (const unsafe of ['../escape', 'Work Account', 'default']) {
      debug.mockClear();
      const parsed = parseRunIdentities(withAccount(unsafe), debug);
      expect(parsed?.roles.worker).toEqual(base.roles.worker);
      expect(parsed?.roles.worker).not.toHaveProperty('account');
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]![0])).toContain('account');
    }
  });

  it('parses a pre-change snapshot with no account field exactly as before', () => {
    const legacy = JSON.stringify({ v: 1, roles: base.roles });
    expect(parseRunIdentities(legacy)).toEqual({ v: 1, roles: base.roles });
    expect(parseRunIdentities(legacy, vi.fn())).toEqual({ v: 1, roles: base.roles });
  });

  it('does not make two snapshots differ when only the account differs', () => {
    const other = { v: 1 as const, roles: { ...base.roles, worker: { ...base.roles.worker!, account: 'work' } } };
    expect(identitiesDiffer(base, other)).toBe(false);
    expect(identityDifference(base, other)).toBe('');
    expect(identitiesDiffer(other, base)).toBe(false);
  });

  it('shows the account in the summary as provider/model@account', () => {
    const ids = { v: 1 as const, roles: { ...base.roles, worker: { ...base.roles.worker!, account: 'work' } } };
    expect(summarizeRunIdentities(ids)).toContain('worker claude/claude-sonnet-5@work');
    expect(summarizeRunIdentities(base)).not.toContain('@');
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
  it('fold the ticket agentPreset into the snapshot', () => {
    const ids = resolveRunIdentities(manifestWith(undefined), config, { agentPreset: 'b' });
    expect(ids.roles.worker).toEqual({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'low', source: 'preset' });
    expect(ids.roles.expert?.source).toBe('approach');
  });
  it('make a ticket agentPreset change differ from the stored snapshot', () => {
    const before = resolveRunIdentities(manifestWith(undefined), config, { agentPreset: null });
    const after = resolveRunIdentities(manifestWith(undefined), config, { agentPreset: 'b' });
    expect(identitiesDiffer(before, after)).toBe(true);
  });
  it('ignore the ticket core, model and effort (AC-63)', () => {
    const row = { agentPreset: null, agentProvider: 'opencode2', model: 'kimi-k2', effort: 'max' };
    const live = resolveRunIdentities(manifestWith(undefined), config, ticketLaunchFields(row));
    expect(identitiesDiffer(resolveRunIdentities(manifestWith(undefined), config), live)).toBe(false);
  });
});

describe('legacy ticket-rung snapshots', () => {
  const legacy = JSON.stringify({
    v: 1,
    roles: { expert: { provider: 'opencode2', model: 'kimi-k2', effort: 'max', source: 'ticket' } },
  });
  it('still parse a stored "source":"ticket" role', () => {
    expect(parseRunIdentities(legacy)?.roles.expert).toEqual({
      provider: 'opencode2',
      model: 'kimi-k2',
      effort: 'max',
      source: 'ticket',
    });
  });
  it('pin the legacy identity for a launch of that run', () => {
    expect(pinnedProfile(parseRunIdentities(legacy), 'expert')).toMatchObject({ provider: 'opencode2', source: 'ticket' });
  });
  it('differ from the live identity by provider, model and effort only', () => {
    const live = resolveRunIdentities(manifestWith(undefined), config);
    expect(identitiesDiffer(parseRunIdentities(legacy)!, live)).toBe(true);
    const sameTriple = JSON.stringify({
      v: 1,
      roles: { ...live.roles, expert: { ...live.roles.expert, source: 'ticket' } },
    });
    expect(identitiesDiffer(parseRunIdentities(sameTriple)!, live)).toBe(false);
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
