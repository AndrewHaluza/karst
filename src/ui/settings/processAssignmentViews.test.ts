import { describe, expect, it } from 'vitest';
import { bundledModelCatalog } from '../../agent/modelCatalog.js';
import type { Manifest } from '../../manifest/types.js';
import { manifest as buildManifest, runnableRepo, slot } from '../../manifest/fixtures.js';
import { buildProcessAssignmentView, buildProcessAssignmentViews } from './processAssignmentViews.js';

const BASE: Manifest = buildManifest(
  { api: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../api', signals: [] }) },
  { portRange: [4000, 4999], approaches: [], agents: {}, ticketing: { provider: 'manual' } },
);

const POOL = ['uat-author', 'review-author'];

function views(m: Manifest, pool: string[] = POOL) {
  return buildProcessAssignmentViews(m, pool, bundledModelCatalog());
}

function row(m: Manifest, key: string) {
  const found = views(m).find((v) => v.key === key);
  if (!found) throw new Error(`no view for ${key}`);
  return found;
}

describe('buildProcessAssignmentViews (handoff §7)', () => {
  it('renders one view per inside process key, labeled per the handoff, never the manifest term', () => {
    const all = views(BASE);
    expect(all.map((v) => v.key)).toEqual([
      'uatTester',
      'uatFix',
      'review',
      'reviewFix',
      'prDescription',
      'ticketAnalysis',
    ]);
    expect(all.map((v) => v.roleLabel)).toEqual([
      'UAT Tester',
      'UAT Fix',
      'Review',
      'Review Fix',
      'PR description',
      'Ticket analysis',
    ]);
    expect(all.map((v) => v.description)).toEqual([
      'Runs after required UAT gates pass',
      'Runs to fix a failed UAT gate',
      'Runs after required review gates pass',
      'Runs to fix a failed review gate',
      'Writes the pull request description at ship time',
      'Synthesizes the ticket prompt; suggests approach, repos and type on the ticket form',
    ]);
  });

  it('defaults the ticket-analysis row like any other omitted role', () => {
    const v = row(BASE, 'ticketAnalysis');
    expect(v.state).toBe('omitted');
    expect(v.profileHint).toBe('Default: Ticket Analysis Agent');
    expect(v.coreHint).toBe('Default: Claude Code');
  });

  it('shows the approved defaults with Default hints when a row is omitted', () => {
    const uat = row(BASE, 'uatTester');
    expect(uat.state).toBe('omitted');
    expect(uat.stateMessage).toBe('');
    expect(uat.profileHint).toBe('Default: UAT Agent');
    expect(uat.coreHint).toBe('Default: Claude Code');
    // The PR-description role's approved default is the ticket-resolved
    // adapter — the provider's own label, never a fixed agent name.
    expect(row(BASE, 'prDescription').profileHint).toBe('Default: Claude Code');
  });

  it('offers the host-supplied agent pool as the profile vocabulary', () => {
    expect(row(BASE, 'uatTester').profileOptions).toEqual(POOL);
  });

  it('flags an agent profile that is no longer in the pool, naming it', () => {
    const m: Manifest = { ...BASE, processes: { uatTester: { agent: 'ghost-agent' } } };
    const v = row(m, 'uatTester');
    expect(v.state).toBe('unknown-profile');
    expect(v.stateTone).toBe('error');
    expect(v.invalidField).toBe('agent');
    expect(v.stateMessage).toContain('ghost-agent');
    // A pool match resolves: the same value against a declared profile is valid.
    expect(row({ ...BASE, processes: { uatTester: { agent: 'uat-author' } } } as Manifest, 'uatTester').state).toBe('valid');
  });

  it('flags an unknown saved agent core and claims no model picker for it', () => {
    const m: Manifest = { ...BASE, processes: { review: { provider: 'copilot' as never } } };
    const v = row(m, 'review');
    expect(v.state).toBe('unknown-provider');
    expect(v.stateTone).toBe('error');
    expect(v.invalidField).toBe('provider');
    expect(v.effectiveProvider).toBeNull();
    expect(v.stateMessage).toContain('copilot');
  });

  it('flags a model that is incompatible with the row core, without substituting', () => {
    const m: Manifest = { ...BASE, processes: { review: { provider: 'codex', model: 'claude-opus-4-8' } } };
    const v = row(m, 'review');
    expect(v.state).toBe('incompatible-model');
    expect(v.stateTone).toBe('error');
    expect(v.invalidField).toBe('model');
    expect(v.stateMessage).toContain('claude-opus-4-8');
    expect(v.stateMessage).toContain('Codex');
  });

  it('keeps a saved model visible with an unavailable-catalog note when the core lists none', () => {
    const m: Manifest = {
      ...BASE,
      processes: { prDescription: { provider: 'opencode', model: 'custom-x' } },
    };
    const v = row(m, 'prDescription');
    expect(v.state).toBe('catalog-unavailable');
    expect(v.stateTone).toBe('note');
    expect(v.stateMessage).toContain('OpenCode');
  });

  it('preserves a disabled row and explains what is skipped', () => {
    const m: Manifest = { ...BASE, processes: { uatTester: { provider: 'codex', enabled: false } } };
    const v = row(m, 'uatTester');
    expect(v.state).toBe('disabled');
    expect(v.stateTone).toBe('note');
    expect(v.stateMessage).toContain('UAT Tester');
  });

  it('resolves a fully configured row to valid with no message', () => {
    const m: Manifest = {
      ...BASE,
      processes: { uatTester: { agent: 'uat-author', provider: 'codex', model: 'gpt-5.6-sol' } },
    };
    const v = row(m, 'uatTester');
    expect(v.state).toBe('valid');
    expect(v.stateMessage).toBe('');
    expect(v.effectiveProvider).toBe('codex');
  });

  it('keys the model picker off the manifest provider when the row declares none', () => {
    const m: Manifest = { ...BASE, agentProvider: 'codex' };
    const v = row(m, 'uatTester');
    expect(v.effectiveProvider).toBe('codex');
    expect(v.coreHint).toBe('Default: Codex');
  });

  it('hints the resolved default model when the row declares none', () => {
    const m: Manifest = { ...BASE, defaultModel: 'claude-opus-4-8' };
    expect(row(m, 'uatTester').modelHint).toBe('Default: Opus 4.8');
  });

  it('keys the effort hint off the resolved default model and manifest default effort', () => {
    const m: Manifest = {
      ...BASE,
      agentProvider: 'claude',
      defaultModel: 'claude-sonnet-5',
      defaultEffort: 'high',
    };
    const v = row(m, 'uatTester');
    expect(v.effectiveModel).toBe('claude-sonnet-5');
    expect(v.effortHint).toBe('Default: high');
  });

  it('renders no effort hint when the resolved model advertises no efforts', () => {
    const m: Manifest = {
      ...BASE,
      defaultModel: 'claude-opus-4-8',
      defaultEffort: 'xhigh',
    };
    const v = row(m, 'uatTester');
    expect(v.effortHint).toBe('');
  });

  it('flags an explicit effort the resolved model does not advertise', () => {
    const m: Manifest = {
      ...BASE,
      processes: { uatTester: { provider: 'claude', model: 'claude-sonnet-5', effort: 'xhigh' } },
    };
    const v = row(m, 'uatTester');
    expect(v.state).toBe('incompatible-effort');
    expect(v.stateTone).toBe('error');
    expect(v.invalidField).toBe('effort');
    expect(v.stateMessage).toContain('xhigh');
    expect(v.stateMessage).toContain('claude-sonnet-5');
  });

  it('accepts an explicit effort the resolved model advertises', () => {
    const m: Manifest = {
      ...BASE,
      processes: { uatTester: { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' } },
    };
    const v = row(m, 'uatTester');
    expect(v.state).toBe('valid');
    expect(v.stateMessage).toBe('');
  });

  it('reports the preset the row would inherit and honors a row preset', () => {
    const m: Manifest = {
      ...BASE,
      agentPresets: {
        fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
        deep: { provider: 'claude', model: 'claude-opus-5' },
      },
      defaultAgentPreset: 'fast',
      processes: { review: { preset: 'deep' } },
    };
    const view = buildProcessAssignmentView('review', { preset: 'deep' }, m, []);
    expect(view.presetOptions).toEqual(['deep', 'fast']);
    expect(view.effectiveProvider).toBe('claude');
    expect(view.effectiveModel).toBe('claude-opus-5');
  });

  it('an omitted row inherits the default preset', () => {
    const m: Manifest = {
      ...BASE,
      agentPresets: { fast: { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' } },
      defaultAgentPreset: 'fast',
      processes: { review: {} },
    };
    const view = buildProcessAssignmentView('review', {}, m, []);
    expect(view.presetHint).toBe('Default: fast');
    expect(view.effectiveProvider).toBe('opencode');
    expect(view.effectiveModel).toBe('opencode-go/deepseek-v4-flash');
  });

  // A preset is a (core, model) PAIR: a row that references a preset but
  // explicitly picks a different core shows the explicit core and must not
  // carry the preset's model.
  it('shows the explicit core and drops the preset model when a row picks a different core', () => {
    const m: Manifest = {
      ...BASE,
      agentPresets: { deep: { provider: 'claude', model: 'claude-opus-5' } },
      defaultModel: 'gpt-5.6-sol',
      processes: { review: { preset: 'deep', provider: 'codex' } },
    };
    const view = buildProcessAssignmentView('review', { preset: 'deep', provider: 'codex' }, m, []);
    expect(view.effectiveProvider).toBe('codex');
    expect(view.effectiveModel).toBe('gpt-5.6-sol');
    expect(view.effectiveModel).not.toBe('claude-opus-5');
  });
});
