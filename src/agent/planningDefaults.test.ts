/**
 * The planning-session core/model resolution (§ planner gets its own core).
 *
 * The load-bearing property is the FALLBACK: an existing project that has never
 * configured a planner must launch exactly what it launched before — the
 * implementation resolution, including the active preset's `implementation`
 * slot. The two rungs above it are the planning preset slot and
 * `processes.planning`.
 */
import { describe, expect, it } from 'vitest';
import { resolvePlanningDefaults, resolvePlanningInherited } from './planningDefaults.js';
import { bundledModelCatalog } from './modelCatalog.js';
import { manifest as buildManifest } from '../manifest/fixtures.js';
import type { Manifest } from '../manifest/types.js';

const CATALOG = bundledModelCatalog();

const BASE: Manifest = buildManifest(
  {},
  { agentProvider: 'claude', defaultModel: 'claude-sonnet-5' },
);

describe('resolvePlanningDefaults', () => {
  it('falls back to the implementation resolution when nothing planning-specific is set', () => {
    expect(resolvePlanningDefaults(BASE, CATALOG)).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
  });

  it('takes the implementation preset slot as its fallback', () => {
    const m: Manifest = {
      ...BASE,
      agentPresets: {
        turbo: { slots: { implementation: { provider: 'codex', model: 'gpt-5.6-sol' } } },
      },
      activeAgentPreset: 'turbo',
    };
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('prefers processes.planning over the implementation fallback', () => {
    const m: Manifest = {
      ...BASE,
      processes: { planning: { provider: 'codex', model: 'gpt-5.6-sol', pinned: true } },
    };
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });

  it('a processes.planning PIN beats the active preset planning slot (source "pin")', () => {
    const m: Manifest = {
      ...BASE,
      processes: { planning: { provider: 'codex', model: 'gpt-5.6-sol', pinned: true } },
      agentPresets: {
        smart: { slots: { planning: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } } },
      },
      activeAgentPreset: 'smart',
    };
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
      source: 'pin',
    });
  });

  it('honours a planning effort the resolved model advertises', () => {
    const m: Manifest = {
      ...BASE,
      processes: { planning: { provider: 'claude', model: 'claude-sonnet-5', effort: 'high', pinned: true } },
    };
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5',
      effort: 'high',
    });
  });

  it('never crosses a model to another core when a planning row changes the core', () => {
    const m: Manifest = {
      ...BASE,
      processes: { planning: { provider: 'codex', pinned: true } },
    };
    // The implementation model is a claude model; the resolved core is codex,
    // so it is dropped rather than launched on the wrong core.
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({ provider: 'codex' });
  });

  it('treats processes.planning.enabled false as "inherit the implementation setting"', () => {
    const m: Manifest = {
      ...BASE,
      processes: {
        planning: { provider: 'codex', model: 'gpt-5.6-sol', enabled: false, pinned: true },
      },
    };
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
  });

  it('does not carry the implementation effort into planning', () => {
    const m: Manifest = { ...BASE, defaultEffort: 'high' };
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5',
    });
  });
});

describe('resolvePlanningInherited', () => {
  it('ignores the processes.planning row, keeping the preset + implementation fallback', () => {
    const m: Manifest = {
      ...BASE,
      processes: { planning: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash', pinned: true } },
      agentPresets: {
        turbo: { slots: { implementation: { provider: 'codex', model: 'gpt-5.6-sol' } } },
      },
      activeAgentPreset: 'turbo',
    };
    expect(resolvePlanningInherited(m, CATALOG)).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6-sol',
    });
  });
});

describe('resolvePlanningDefaults — source', () => {
  it('reports the implementation resolution source when the planner overrides nothing', () => {
    expect(resolvePlanningDefaults(BASE, CATALOG).source).toBe('default');
  });
  it('reports "preset" for a planning slot and ignores an unpinned planning row', () => {
    const m: Manifest = {
      ...BASE,
      processes: { planning: { provider: 'codex', model: 'gpt-5.6-sol' } },
      agentPresets: { smart: { slots: { planning: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } } } },
      activeAgentPreset: 'smart',
    };
    expect(resolvePlanningDefaults(m, CATALOG)).toMatchObject({ provider: 'opencode', source: 'preset' });
  });
});
