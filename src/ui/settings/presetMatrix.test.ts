/**
 * The Presets tab's HOST-computed facts (§5): the row matrix shape and the
 * Inherit preview (NDL-117).
 *
 * Both exist so the webview renders them verbatim and derives nothing (UI-R31).
 * The preview is the load-bearing one: it is defined as the identity the launch
 * path resolves with ALL preset influence stripped, so a change that lets a
 * preset leak into it turns every "Inherit (default)" row into a lie about what
 * that row does.
 */
import { describe, expect, it } from 'vitest';
import {
  PRESET_CAPABILITY_GROUPS,
  PRESET_CAPABILITY_LABELS,
  buildPresetCapabilityGroups,
  buildPresetInheritanceViews,
} from './presetMatrix.js';
import { PRESET_CAPABILITIES, type Manifest } from '../../manifest/types.js';
import { compatibilityModelCatalog } from '../../agent/models.js';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import {
  agentPresets,
  fullPreset,
  graphApproach,
  manifest as buildManifest,
  processes,
  runnableRepo,
  slot,
} from '../../manifest/fixtures.js';

const CATALOG = bundledModelCatalog();

const BASE: Manifest = buildManifest(
  { api: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../api', signals: [] }) },
  {
    host: 'localhost',
    baselineBranch: 'main',
    agentProvider: 'codex',
    defaultModel: 'gpt-5.6-sol',
    approaches: [graphApproach()],
    processes: processes(),
    agents: {},
    worktreePathDisplay: 'relative',
    ticketing: { provider: 'manual' },
    conventions: { branchName: 'karst/{slug}' },
  },
);

describe('preset matrix — group shape', () => {
  it('pairs every row id with its label, in PRESET_CAPABILITIES order', () => {
    const groups = buildPresetCapabilityGroups();
    const flat = groups.flatMap((g) => g.rows);
    expect(flat.map((r) => r.capability)).toEqual([...PRESET_CAPABILITIES]);
    // No row can ship an id without the name the rest of the UI already uses.
    for (const row of flat) expect(row.label).toBe(PRESET_CAPABILITY_LABELS[row.capability]);
    // …and every label is a real word, never the raw id.
    for (const row of flat) expect(row.label).not.toBe(row.capability);
  });

  it('is the §5 Quality / Ticket / Graph-role split, in render order', () => {
    const groups = buildPresetCapabilityGroups();
    expect(groups.map((g) => g.id)).toEqual(['quality', 'ticket', 'graph']);
    expect(groups.map((g) => g.label)).toEqual(['Quality', 'Ticket', 'Graph roles']);
    expect(groups.map((g) => g.rows.length)).toEqual([4, 4, 3]);
    // Derived from the constants, not written out a second time.
    expect(groups.flatMap((g) => g.rows.map((r) => r.capability)))
      .toEqual(PRESET_CAPABILITY_GROUPS.flatMap((g) => g.capabilities));
  });

  it('covers every capability exactly once — a row is never unreachable', () => {
    const seen = new Set(buildPresetCapabilityGroups().flatMap((g) => g.rows.map((r) => r.capability)));
    expect(seen.size).toBe(PRESET_CAPABILITIES.length);
    for (const capability of PRESET_CAPABILITIES) expect(seen.has(capability)).toBe(true);
  });
});

describe('preset matrix — Inherit preview', () => {
  it('has an entry for every capability, so a row never guesses', () => {
    const views = buildPresetInheritanceViews(BASE, CATALOG);
    expect(Object.keys(views).sort()).toEqual([...PRESET_CAPABILITIES].sort());
    for (const capability of PRESET_CAPABILITIES) {
      expect(views[capability].provider, capability).toBeTruthy();
    }
  });

  it('is identical with and without preset influence — Inherit means "beneath the preset"', () => {
    const clean = buildPresetInheritanceViews(BASE, CATALOG);
    const influenced: Manifest = {
      ...BASE,
      agentPresets: agentPresets({ smart: fullPreset('opencode', 'opencode-go/deepseek-v4-flash') }),
      activeAgentPreset: 'smart',
      defaultAgentPreset: undefined,
      processes: { ...processes(), uatTester: { ...processes().uatTester!, preset: 'smart' } },
    };
    expect(buildPresetInheritanceViews(influenced, CATALOG)).toEqual(clean);
  });

  it('takes a process role from `processes.<key>`, probed as enabled', () => {
    const views = buildPresetInheritanceViews(BASE, CATALOG);
    expect(views.uatTester).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });

    // The preview answers "which core would this run on", not "is it running"
    // — an OFF role still shows the identity it would take if switched on.
    const off: Manifest = {
      ...BASE,
      processes: { uatTester: { provider: 'claude', model: 'claude-opus-5', pinned: true, enabled: false } },
    };
    expect(buildPresetInheritanceViews(off, CATALOG).uatTester)
      .toEqual({ provider: 'claude', model: 'claude-opus-5' });
  });

  it('takes planning from processes.planning, then the implementation resolution', () => {
    // Nothing planning-specific: the Inherit preview is the implementation
    // resolution (the manifest default here), never a guessed value.
    const views = buildPresetInheritanceViews(BASE, CATALOG);
    expect(views.planning).toEqual({ provider: 'codex', model: 'gpt-5.6-sol' });

    // A `processes.planning` row is what an Inherit row previews.
    const planned: Manifest = {
      ...BASE,
      processes: { ...processes(), planning: { provider: 'claude', model: 'claude-opus-5', pinned: true } },
    };
    expect(buildPresetInheritanceViews(planned, CATALOG).planning)
      .toEqual({ provider: 'claude', model: 'claude-opus-5' });
  });

  it('takes a graph role from the approach profile, not from the manifest default', () => {
    const views = buildPresetInheritanceViews(BASE, CATALOG);
    expect(views.graphExpert).toEqual({ provider: 'claude', model: 'claude-opus-5', effort: 'high' });
    expect(views.graphWorker).toEqual({ provider: 'claude', model: 'claude-sonnet-5', effort: 'low' });
    expect(views.graphFast).toEqual({ provider: 'claude', model: 'claude-sonnet-5', effort: 'low' });
    // …and `implementation`, which no process and no profile owns, is the
    // manifest default — the same rung a slot composes over.
    expect(views.implementation.provider).toBe('codex');
  });

  it('carries an effort only when the model advertises it', () => {
    const views = buildPresetInheritanceViews(BASE, compatibilityModelCatalog(CATALOG));
    // The same preview either way: the effort is a fact about the MODEL, and a
    // preview that invented one would promise an effort the launch path drops.
    expect(views.graphExpert.effort).toBe('high');
    expect(views.uatTester.effort).toBeUndefined();
  });
});
