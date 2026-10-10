/**
 * COMPONENT-mode tests for the Agents page (Roles + Agent profiles tabs).
 *
 * The state-dependent rendering rules run against the real document in
 * `renderedAgents.render.integration.test.tsx`; the layer rules (where an edit
 * lands) are pinned in `rolesModel.test.ts`. This file proves the wiring: the
 * tablist and its hash, the source chips, edits landing in the winning layer,
 * compare, and the profile texts.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { buildSettingsState, type SettingsAgentRow } from '../../state.js';
import type { AgentPickerOptions } from '../hostBridge.js';
import { AgentsSection } from './AgentsSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';

const pickers = new Map<HTMLElement, AgentPickerOptions>();

beforeEach(() => {
  pickers.clear();
  window.location.hash = '';
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (root: HTMLElement, opts: AgentPickerOptions) => {
    pickers.set(root, opts);
  };
});
afterEach(() => {
  cleanup();
  delete (globalThis as unknown as Record<string, unknown>).mountAgentPicker;
});

const AGENTS: SettingsAgentRow[] = [
  { name: 'reviewer', source: 'file', enabled: true, body: 'local reviewer text' },
  { name: 'plan', source: 'approach', approachId: 'speckit', enabled: true, body: 'approach plan text' },
];

const BASE = {
  ...FIXTURE_MANIFEST,
  agentProvider: 'opencode',
  defaultModel: 'opencode-go/deepseek-v4-flash',
  agentPresets: {
    A: { slots: { planning: { provider: 'claude', model: 'claude-opus-5' }, review: { provider: 'claude', model: 'claude-opus-5' } } },
    B: { slots: { planning: { provider: 'antigravity', model: 'gemini-3.8-flash-medium' } } },
  },
  activeAgentPreset: 'A',
  processes: { review: { agent: 'reviewer' } },
} as unknown as Manifest;

function mount(manifest: Manifest = BASE): { bridge: TestBridge; probe: () => AppProbeShape } {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <AgentsSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() =>
    bridge.push({
      type: 'state',
      state: buildSettingsState(manifest, null, [], true, ['claude', 'opencode'], AGENTS, {}, undefined, '/repo/karst.yml'),
    }),
  );
  return { bridge, probe: () => readProbe(view.baseElement) };
}

const row = (cap: string): HTMLElement => {
  const el = document.querySelector(`[data-role="${cap}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no row ${cap}`);
  return el;
};
const pickerOf = (cap: string): AgentPickerOptions => {
  const root = row(cap).querySelector('.agent-picker-island') as HTMLElement;
  const opts = pickers.get(root);
  if (!opts) throw new Error(`no picker mounted for ${cap}`);
  return opts;
};
const draftOf = (probe: () => AppProbeShape): Manifest => probe().draft as Manifest;

describe('Agents page — tabs and location', () => {
  it('renders a tablist with Roles and Agent profiles (n), arrow keys switch, the hash follows', () => {
    mount();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Roles', 'Agent profiles (2)']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#agents/profiles');
    fireEvent.keyDown(screen.getAllByRole('tab')[1]!, { key: 'ArrowLeft' });
    expect(window.location.hash).toBe('#agents/roles');
  });

  it('redirects an old Presets hash to the Roles tab', () => {
    window.location.hash = '#presets';
    mount();
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true');
  });
});

describe('Agents page — roles table', () => {
  it('shows every role with where its value comes from', () => {
    mount({ ...BASE, processes: { ...BASE.processes, uatTester: { provider: 'codex', model: 'gpt-5.6-sol', pinned: true } } } as unknown as Manifest);
    expect(document.querySelectorAll('[data-role]')).toHaveLength(11);
    expect(row('planning').querySelector('[data-source]')!.getAttribute('data-source')).toBe('preset');
    expect(row('uatTester').querySelector('[data-source]')!.getAttribute('data-source')).toBe('pin');
    expect(row('implementation').querySelector('[data-source]')!.getAttribute('data-source')).toBe('default');
    expect(pickerOf('planning').value).toEqual({ core: 'claude', model: 'claude-opus-5', effort: '' });
  });

  it('an unpinned edit writes the SELECTED preset, never the pin layer', () => {
    const { probe } = mount();
    act(() => pickerOf('planning').onChange({ core: 'antigravity', model: 'gemini-3.8-flash-medium', effort: '' }));
    const d = draftOf(probe);
    expect(d.agentPresets!.A!.slots.planning).toEqual({ provider: 'antigravity', model: 'gemini-3.8-flash-medium' });
    expect(d.processes?.planning).toBeUndefined();
  });

  it('pin makes the edit land in the pin; Unpin returns to the preset', () => {
    const { probe } = mount();
    fireEvent.click(within(row('planning')).getByRole('button', { name: 'Pin' }));
    expect(draftOf(probe).processes!.planning).toMatchObject({ pinned: true, provider: 'claude' });
    expect(row('planning').querySelector('[data-source]')!.getAttribute('data-source')).toBe('pin');
    act(() => pickerOf('planning').onChange({ core: 'antigravity', model: 'gemini-3.8-flash-medium', effort: '' }));
    expect(draftOf(probe).processes!.planning).toMatchObject({ provider: 'antigravity', pinned: true });
    expect(draftOf(probe).agentPresets!.A!.slots.planning!.provider).toBe('claude');
    fireEvent.click(within(row('planning')).getByRole('button', { name: 'Unpin' }));
    expect(row('planning').querySelector('[data-source]')!.getAttribute('data-source')).toBe('preset');
  });

  it('the reported bug cannot recur: preset claude + pin agy resolves to the pin', () => {
    const { probe } = mount();
    act(() => pickerOf('planning').onChange({ core: 'claude', model: 'claude-opus-5', effort: '' }));
    fireEvent.click(within(row('planning')).getByRole('button', { name: 'Pin' }));
    act(() => pickerOf('planning').onChange({ core: 'antigravity', model: 'gemini-3.8-flash-medium', effort: '' }));
    expect(row('planning').querySelector('[data-source]')!.getAttribute('data-source')).toBe('pin');
    expect(pickerOf('planning').value.core).toBe('antigravity');
    expect(draftOf(probe).agentPresets!.A!.slots.planning!.provider).toBe('claude');
  });

  it('Clear drops the preset value so the role inherits the Default row', () => {
    mount();
    fireEvent.click(within(row('planning')).getByRole('button', { name: 'Clear' }));
    expect(row('planning').querySelector('[data-source]')!.getAttribute('data-source')).toBe('default');
    expect(pickerOf('planning').value.core).toBe('opencode');
  });

  it('assigning an agent profile touches identity only', () => {
    const { probe } = mount();
    fireEvent.change(document.querySelector('[name="role-planning-profile"]')!, { target: { value: 'reviewer' } });
    expect(draftOf(probe).processes!.planning).toEqual({ agent: 'reviewer' });
    expect(draftOf(probe).agentPresets).toEqual(BASE.agentPresets);
  });

  it('the Default row edits the three default keys', () => {
    const { probe } = mount();
    const defaults = pickers.get(document.querySelector('.agents-default .agent-picker-island') as HTMLElement)!;
    act(() => defaults.onChange({ core: 'codex', model: 'gpt-5.6-sol', effort: '' }));
    expect(draftOf(probe)).toMatchObject({ agentProvider: 'codex', defaultModel: 'gpt-5.6-sol' });
  });
});

describe('Agents page — compare', () => {
  it('summarises the differing roles from EFFECTIVE values and copies B into A', () => {
    const { probe } = mount();
    fireEvent.change(document.querySelector('[name="agents-compare"]')!, { target: { value: 'B' } });
    expect(screen.getByRole('status').textContent).toBe('2 of 11 roles differ');
    fireEvent.click(within(row('planning')).getByText('← Copy from B'));
    expect(draftOf(probe).agentPresets!.A!.slots.planning).toEqual({ provider: 'antigravity', model: 'gemini-3.8-flash-medium' });
    expect(draftOf(probe).agentPresets!.B).toEqual(BASE.agentPresets!.B);
    expect(window.location.hash).toContain('compare=B');
  });

  it('Only show differences hides identical roles; Swap A/B exchanges the presets', () => {
    mount();
    fireEvent.change(document.querySelector('[name="agents-compare"]')!, { target: { value: 'B' } });
    fireEvent.click(document.querySelector('[name="agents-only-diffs"]')!);
    expect(document.querySelectorAll('.agents-compare-row')).toHaveLength(2);
    fireEvent.click(screen.getByText('Swap A/B'));
    expect(screen.getByText('A: B')).not.toBeNull();
    expect(screen.getByText('B: A')).not.toBeNull();
  });
});

describe('Agents page — agent profiles', () => {
  const openProfiles = (): void => {
    fireEvent.click(screen.getAllByRole('tab')[1]!);
  };

  it('lists Local, From approach and Built-in prompts groups with used-by counts', () => {
    mount();
    openProfiles();
    const titles = [...document.querySelectorAll('.agents-group-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Local (.karst/agents)', 'From approach: speckit', 'Built-in prompts']);
    expect(screen.getByText('reviewer').closest('button')!.textContent).toContain('used by 1');
    expect(screen.getByText('plan').closest('button')!.textContent).toContain('unused');
  });

  it('shows the real built-in prompt for a prompt-bearing role and the identity note for the rest', () => {
    mount();
    openProfiles();
    fireEvent.click(screen.getByText('UAT Agent'));
    expect(screen.getByLabelText(/built-in prompt$/).textContent).toMatch(/UAT tester/i);
    fireEvent.click(screen.getByText('Planner'));
    expect(screen.getByText(/keeps its built-in prompt; an agent profile changes identity only/)).not.toBeNull();
    expect((screen.getByText('Customize…') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an approach profile is read-only with its text visible', () => {
    mount();
    openProfiles();
    fireEvent.click(screen.getByText('plan'));
    expect(screen.getByLabelText('plan text').textContent).toBe('approach plan text');
    expect(document.querySelector('[name="agent-body-plan"]')).toBeNull();
    expect(screen.getByRole('button', { name: /manage in approach/ })).not.toBeNull();
  });

  it('a local profile edits a buffer, saves through the host, and guards leaving unsaved text', () => {
    const { bridge } = mount();
    openProfiles();
    fireEvent.click(screen.getByText('reviewer'));
    const area = document.querySelector('[name="agent-body-reviewer"]') as HTMLTextAreaElement;
    expect(area.value).toBe('local reviewer text');
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(area, { target: { value: 'edited' } });
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false);
    expect(bridge.last('save-agent-file')).toBeUndefined();
    // Leaving the item asks first.
    fireEvent.click(screen.getByText('plan'));
    expect(screen.getByRole('alertdialog').textContent).toContain('Unsaved changes to reviewer');
    fireEvent.click(screen.getByText('Keep editing'));
    expect((document.querySelector('[name="agent-body-reviewer"]') as HTMLTextAreaElement).value).toBe('edited');
    fireEvent.click(screen.getByText('Save'));
    expect(bridge.last('save-agent-file')).toMatchObject({ name: 'reviewer', body: 'edited' });
  });
});
