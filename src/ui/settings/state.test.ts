import { describe, it, expect } from 'vitest';
import { buildSettingsState } from './state.js';
import type { Manifest } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';
import type { ModelCatalog } from '../../agent/modelCatalog.js';

const M: Manifest = buildManifest(
  {
    backend: runnableRepo(
      { ports: [slot('port', 'PORT', 3000)] },
      { repoPath: '../backend', signals: [] },
    ),
  },
  {
    portRange: [4000, 4999],
    approaches: [{ id: 'tdd', label: 'TDD', recommended: true }],
    agents: { implement: { role: 'implement', command: 'claude' } },
    worktreePathDisplay: 'relative',
  },
);

const REMOTE_MODELS: ModelCatalog = {
  claude: [{ id: 'claude-remote', label: 'Claude Remote', providers: ['claude'] }],
  codex: [{ id: 'codex-remote', label: 'Codex Remote', providers: ['codex'] }],
  antigravity: [{ id: 'agy-remote', label: 'Antigravity Remote', providers: ['antigravity'] }],
};

describe('buildSettingsState', () => {
  it('carries the whole manifest and a null error by default', () => {
    const s = buildSettingsState(M);
    expect(s.manifest).toEqual(M);
    expect(s.error).toBeNull();
  });

  it('carries a validation error when provided', () => {
    const s = buildSettingsState(M, 'portRange min exceeds max');
    expect(s.error).toBe('portRange min exceeds max');
  });

  it('carries installedIds as an empty array by default', () => {
    const s = buildSettingsState(M);
    expect(s.installedIds).toEqual([]);
  });

  it('carries installedIds when provided', () => {
    const s = buildSettingsState(M, null, ['approach-a', 'approach-b']);
    expect(s.installedIds).toEqual(['approach-a', 'approach-b']);
  });

  it('carries installedIds along with error', () => {
    const s = buildSettingsState(M, 'some error', ['approach-x']);
    expect(s.error).toBe('some error');
    expect(s.installedIds).toEqual(['approach-x']);
  });

  it('defaults tokenConfigured to false', () => {
    expect(buildSettingsState(M).tokenConfigured).toBe(false);
  });

  it('carries tokenConfigured when provided', () => {
    expect(buildSettingsState(M, null, [], true).tokenConfigured).toBe(true);
  });

  it('defaults implementedProviders to all usable providers', () => {
    expect(buildSettingsState(M).implementedProviders).toEqual([
      'claude',
      'codex',
      'antigravity',
    ]);
  });

  it('carries implementedProviders when provided', () => {
    const s = buildSettingsState(M, null, [], false, ['claude', 'codex']);
    expect(s.implementedProviders).toEqual(['claude', 'codex']);
  });

  it('defaults agents to an empty array', () => {
    expect(buildSettingsState(M).agents).toEqual([]);
  });

  it('carries injected agent rows', () => {
    const agents = [
      { name: 'reviewer', source: 'file' as const, enabled: true, body: '# reviewer' },
      { name: 'planner', source: 'approach' as const, enabled: false, body: null },
    ];
    const s = buildSettingsState(M, null, [], false, ['claude'], agents);
    expect(s.agents).toEqual(agents);
  });

  it('orders agents by provenance (file first, then grouped by approach)', () => {
    const agents = [
      { name: 'z', source: 'approach' as const, approachId: 'rpi', enabled: true, body: null },
      { name: 'a', source: 'file' as const, enabled: true, body: '' },
    ];
    const s = buildSettingsState(M, null, [], false, ['claude'], agents, {});
    expect(s.agents.map((r) => r.name)).toEqual(['a', 'z']);
  });

  it('defaults approachCommands to an empty object', () => {
    expect(buildSettingsState(M).approachCommands).toEqual({});
  });

  it('carries injected approachCommands', () => {
    const approachCommands = { tdd: ['karst-tdd', 'review'] };
    const s = buildSettingsState(M, null, [], false, ['claude'], [], approachCommands);
    expect(s.approachCommands).toEqual(approachCommands);
  });

  it('serializes the injected model lists for every provider', () => {
    const s = buildSettingsState(M, null, [], false, undefined, [], {}, REMOTE_MODELS);
    expect(s.models).toEqual(REMOTE_MODELS);
  });
});
