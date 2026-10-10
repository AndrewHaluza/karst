import { describe, it, expect } from 'vitest';
import { dump } from 'js-yaml';
import { foldProcessRows } from './foldProcessRows.js';
import { parseManifestText } from './load.js';
import { resolveProcessAssignment } from '../agent/processAssignment.js';
import { PROCESS_ROLE_BY_KEY, PROCESS_KEYS } from './validate/processAssignments.js';

const BASE = { host: 'localhost', portRange: [4000, 4999], baselineBranch: 'develop', repositories: { api: { repoPath: '../api' } }, agentProvider: 'claude', defaultModel: 'claude-sonnet-5' };
const fast = { slots: { review: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } } };
const deep = { slots: { planning: { provider: 'claude', model: 'claude-opus-5' } } };

function fold(over: Record<string, unknown>) {
  const res = foldProcessRows({ ...BASE, ...over });
  return { raw: res.raw as Record<string, any>, notices: res.notices };
}

describe('foldProcessRows', () => {
  it('writes the row into the ACTIVE preset, overwriting its slot, and strips the row', () => {
    const { raw, notices } = fold({
      processes: { planning: { provider: 'antigravity', model: 'gemini-3.8-flash-medium', agent: 'p' } },
      agentPresets: { OC: { slots: { planning: { provider: 'claude', model: 'claude-opus-5' } } } },
      activeAgentPreset: 'OC',
    });
    expect(raw.agentPresets.OC.slots.planning).toEqual({ provider: 'antigravity', model: 'gemini-3.8-flash-medium' });
    expect(raw.processes.planning).toEqual({ agent: 'p' });
    expect(notices).toEqual([
      expect.stringMatching(/^Moved Planner \(.*gemini-3\.8-flash-medium\) into active preset "OC"\. Pin a role/),
    ]);
  });

  it('copies into other presets lacking a slot, leaves ones with their own slot', () => {
    const { raw } = fold({
      processes: { review: { provider: 'codex', model: 'gpt-5.6-sol' } },
      agentPresets: { a: { slots: {} }, b: fast, c: { slots: { review: { provider: 'claude', model: 'claude-opus-5' } } } },
      activeAgentPreset: 'a',
    });
    expect(raw.agentPresets.a.slots.review.provider).toBe('codex');
    expect(raw.agentPresets.b.slots.review.provider).toBe('opencode');
    expect(raw.agentPresets.c.slots.review.provider).toBe('claude');
  });

  it('expands a legacy flat active preset to slots, only the role overwritten', () => {
    const { raw } = fold({
      processes: { review: { provider: 'codex', model: 'gpt-5.6-sol' } },
      agentPresets: { flat: { provider: 'claude', model: 'claude-opus-5' } },
      activeAgentPreset: 'flat',
    });
    expect(raw.agentPresets.flat.slots.review.provider).toBe('codex');
    expect(raw.agentPresets.flat.slots.planning.provider).toBe('claude');
    expect(raw.agentPresets.flat.provider).toBeUndefined();
  });

  it('pins the row when no preset is defined or none is active', () => {
    expect(fold({ processes: { review: { provider: 'codex', model: 'm' } } }).raw.processes.review).toMatchObject({
      provider: 'codex',
      pinned: true,
    });
    const inactive = fold({
      processes: { review: { provider: 'codex', model: 'm' } },
      agentPresets: { a: fast },
    });
    expect(inactive.raw.processes.review.pinned).toBe(true);
    expect(inactive.raw.agentPresets).toEqual({ a: fast });
  });

  it('is idempotent and leaves pinned rows alone', () => {
    const once = fold({
      processes: { review: { provider: 'codex', model: 'm' }, planning: { provider: 'codex', model: 'x', pinned: true } },
      agentPresets: { a: deep },
      activeAgentPreset: 'a',
    });
    const twice = foldProcessRows(once.raw);
    expect(twice.raw).toEqual(once.raw);
    expect(twice.notices).toEqual([]);
    expect(once.raw.processes.planning).toEqual({ provider: 'codex', model: 'x', pinned: true });
  });

  it('does not mutate its input', () => {
    const input = { ...BASE, processes: { review: { provider: 'codex', model: 'm' } }, agentPresets: { a: fast }, activeAgentPreset: 'a' };
    const copy = structuredClone(input);
    foldProcessRows(input);
    expect(input).toEqual(copy);
  });
});

describe('migration keeps every role × preset resolving as before (property)', () => {
  const ROW = { provider: 'codex', model: 'gpt-5.6-sol' };
  const presets: Record<string, { slots: Record<string, unknown> }> = {
    active: { slots: {} },
    other: { slots: {} },
    ...Object.fromEntries([]),
  };

  it.each(PROCESS_KEYS)('%s: active resolves to the row, others as before', (key) => {
    const role = PROCESS_ROLE_BY_KEY[key];
    const own = { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' };
    const raw = {
      ...BASE,
      processes: { [key]: ROW },
      agentPresets: { ...presets, withSlot: { slots: { [key]: own } }, empty: { slots: {} } },
      activeAgentPreset: 'active',
    };
    const { manifest, notices } = (() => {
      const loaded = parseManifestText(dump(raw));
      return { manifest: loaded.manifest, notices: loaded.notices };
    })();
    expect(notices.some((n) => n.startsWith('Moved '))).toBe(true);
    expect(manifest.processes?.[key]?.provider).toBeUndefined();
    const via = (preset: string) => resolveProcessAssignment(manifest, role, { preset });
    expect(via('active')).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol', source: 'preset' });
    expect(via('empty')).toMatchObject({ provider: 'codex', model: 'gpt-5.6-sol' });
    expect(via('withSlot')).toMatchObject(own);
  });
});
