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
    expect(screen.getByRole('columnheader', { name: 'A: B' })).not.toBeNull();
    expect(screen.getByRole('columnheader', { name: 'B: A' })).not.toBeNull();
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

describe('Agents page — roles table layout markup', () => {
  const cells = (r: Element) => Array.from(r.children).map((c) => c.className);
  const mountCompare = () => {
    mount();
    fireEvent.change(document.querySelector('[name="agents-compare"]')!, { target: { value: 'B' } });
  };

  it('header has an empty "Enabled" first column and Core / Model / Effort as separate headings', () => {
    mount();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Enabled', 'Role', 'Agent profile', 'Core', 'Model', 'Effort', 'Source', 'Actions']);
    const first = screen.getAllByRole('columnheader')[0]!;
    expect(first.querySelector('.sr-only')!.textContent).toBe('Enabled');
  });

  it('every normal row has the same six cells in the same order', () => {
    mount();
    for (const r of document.querySelectorAll('.agents-row[data-role]')) {
      expect(cells(r).map((c) => c.split(' ').find((n) => n.startsWith('agents-cell-')))).toEqual([
        'agents-cell-switch', 'agents-cell-role', 'agents-cell-profile',
        'agents-cell-picker', 'agents-cell-source', 'agents-cell-actions',
      ]);
    }
  });

  it('Core, Model and Effort are the row\'s own cells so they map 1:1 to the eight headings', () => {
    mount();
    const r = document.querySelector('.agents-row[data-role]:not(.agents-compare-row)')!;
    expect(r.querySelector('.agents-cell-picker')!.getAttribute('role')).toBeNull();
    // The compact picker's three .ap-field elements carry role="cell" (pinned in agentPicker.test.ts),
    // so the row has 5 own cells + 3 picker cells = the 8 headings.
    expect(Array.from(r.children).filter((c) => c.getAttribute('role') === 'cell')).toHaveLength(5);
  });

  it('a non-pinnable role has an empty switch cell and a hidden pin slot beside Clear', () => {
    mount();
    const r = Array.from(document.querySelectorAll('.agents-row[data-role]')).find(
      (el) => !el.querySelector('[role="switch"], input[type="checkbox"]'),
    )!;
    expect(r.querySelector('.agents-cell-switch')!.children).toHaveLength(0);
    const slot = r.querySelector('.agents-pin-slot')!;
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.nextElementSibling!.getAttribute('aria-label')).toBe('Clear');
  });

  it('the profile open button uses the file icon and names the profile', () => {
    mount();
    const btn = screen.getAllByRole('button', { name: /^Open profile / })[0]!;
    expect(btn.querySelector('.icon-island')).not.toBeNull();
  });

  it('Karst defaults carry the mark, say "default", and never say "Role default"', () => {
    mount();
    expect(document.body.textContent).not.toContain('Role default');
    const r = row('implementation');
    const chip = r.querySelector('[data-source="default"]')!;
    expect(chip.querySelector('.k-karst-mark')).not.toBeNull();
    expect(chip.getAttribute('title')).toContain('Karst default');
    expect(chip.textContent).toContain('Karst default');
    expect(chip.querySelector('[aria-hidden="true"]:not(svg)')!.textContent).toBe('default');
    expect(chip.getAttribute('title')).toContain("uses Karst's built-in default.");
  });

  it('a role on the built-in profile shows the mark and "Open Karst built-in …" labels', () => {
    mount();
    const btns = screen.getAllByRole('button', { name: /^Open Karst built-in (prompt|profile)$/ });
    expect(btns.length).toBeGreaterThan(0);
    expect(btns[0]!.querySelector('.k-karst-mark')).not.toBeNull();
    const sel = document.querySelector('.agents-profile-select.has-mark select') as HTMLSelectElement;
    expect(sel.selectedOptions[0]!.textContent).toBe('default');
    expect(sel.closest('.agents-profile-select')!.querySelector('.k-karst-mark')).not.toBeNull();
  });

  it('compare rows keep the empty switch cell and show A / B field labels', () => {
    mountCompare();
    const r = document.querySelector('.agents-compare-row')!;
    expect(r.firstElementChild!.className).toContain('agents-cell-switch');
    expect(Array.from(r.querySelectorAll('.agents-field-label')).map((l) => l.textContent?.slice(0, 2))).toEqual(['A:', 'B:']);
  });

  it('compare A / B labels are exposed to screen readers (cards have no header)', () => {
    mountCompare();
    const labels = document.querySelector('.agents-compare-row')!.querySelectorAll('.agents-field-label');
    expect(labels).toHaveLength(2);
    for (const l of labels) expect(l.closest('[aria-hidden="true"]') ?? (l.getAttribute('aria-hidden') === 'true' ? l : null)).toBeNull();
  });

  it('compare cells reuse the source cell: default chips carry the Karst mark, tooltip and SR text', () => {
    mountCompare();
    const chip = document.querySelector('.agents-compare-row [data-source="default"]')!;
    expect(chip.querySelector('.k-karst-mark')).not.toBeNull();
    expect(chip.getAttribute('title')).toContain('Karst default');
    expect(chip.querySelector('.sr-only')!.textContent).toBe('Karst default');
  });
});

describe('Agents page — sandbox backend', () => {
  const withStatus = (manifest: Manifest, backendStatus: unknown) => {
    const view = mount(manifest);
    act(() => view.bridge.push({ type: 'state', state: { ...buildSettingsState(manifest, null, [], true, ['claude', 'opencode', 'antigravity'], AGENTS, {}, undefined, '/repo/karst.yml'), backendStatus } as never }));
    return view;
  };
  const selector = (): HTMLSelectElement => screen.getByLabelText('Agent backend') as HTMLSelectElement;

  it('defaults to host and offers host / sbx / docker', () => {
    mount();
    expect(selector().value).toBe('host');
    expect([...selector().options].map((o) => o.value)).toEqual(['host', 'sbx', 'docker']);
  });

  it('choosing a backend edits the draft agentBackend', () => {
    const { probe } = mount();
    fireEvent.change(selector(), { target: { value: 'sbx' } });
    expect(draftOf(probe).agentBackend).toBe('sbx');
  });

  it('choosing host again removes the key so the yml stays clean', () => {
    const { probe } = mount({ ...BASE, agentBackend: 'docker' } as Manifest);
    fireEvent.change(selector(), { target: { value: 'host' } });
    expect('agentBackend' in draftOf(probe)).toBe(false);
  });

  it('shows the per-core effective backend with the fail-closed reason', () => {
    withStatus({ ...BASE, agentBackend: 'sbx' } as Manifest, { sbx: { ok: true }, docker: { ok: false, reason: 'docker daemon unreachable' } });
    const line = screen.getByTestId('effective-backend').textContent;
    expect(line).toContain('claude: sbx');
    expect(line).toContain('opencode: host (sbx backend unsupported)');
    expect(line).toContain('antigravity: host (sbx backend unsupported)');
  });

  it('shows each backend status with its fix hint', () => {
    withStatus(BASE, { sbx: { ok: false, reason: 'sbx not signed in (run `sbx login`)' }, docker: { ok: true } });
    expect(screen.getByTestId('backend-status-sbx').textContent).toContain('sbx not signed in');
    expect(screen.getByTestId('backend-status-docker').textContent).toContain('ready');
  });

  it('says status is not checked when the host has not reported', () => {
    mount();
    expect(screen.getByTestId('backend-status-sbx').textContent).toContain('not checked');
  });
});
