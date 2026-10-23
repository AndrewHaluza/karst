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
import { AppShell } from './AppShell.js';
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

/** Mount the Agents page inside the real shell, for the Settings-section guard. */
function mountWithShell(manifest: Manifest = BASE): { bridge: TestBridge } {
  const bridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <AppShell>
          <AgentsSection />
        </AppShell>
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() =>
    bridge.push({
      type: 'state',
      state: buildSettingsState(manifest, null, [], true, ['claude', 'opencode'], AGENTS, {}, undefined, '/repo/karst.yml'),
    }),
  );
  return { bridge };
}

const activeSection = (): string | null =>
  document.querySelector('.nav-btn.active')?.getAttribute('data-section') ?? null;

const openProfiles = (): void => {
  fireEvent.click(screen.getAllByRole('tab')[1]!);
};

const editReviewer = (text: string): HTMLElement => {
  openProfiles();
  fireEvent.click(screen.getByText('reviewer'));
  const area = document.querySelector('[name="agent-body-reviewer"]') as HTMLTextAreaElement;
  fireEvent.change(area, { target: { value: text } });
  return area;
};

const itemButton = (name: string): HTMLElement => {
  const item = [...document.querySelectorAll<HTMLElement>('.agents-item')].find(
    (el) => el.querySelector('.agents-item-name')?.textContent === name,
  );
  if (!item) throw new Error(`no profile item ${name}`);
  return item;
};


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

  it('Home and End jump to the first and last tab', () => {
    mount();
    const tabs = (): HTMLElement[] => screen.getAllByRole('tab');
    fireEvent.keyDown(tabs()[0]!, { key: 'End' });
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#agents/profiles');
    fireEvent.keyDown(tabs()[1]!, { key: 'Home' });
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(window.location.hash).toBe('#agents/roles');
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
    const compareBar = document.querySelector('.agents-compare-bar') as HTMLElement;
    expect(within(compareBar).getByRole('status').textContent).toBe('2 of 11 roles differ');
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

describe('Agents page — the unsaved bar is reachable and reversible (UI-R23, R27)', () => {
  it('moves focus to Save, describes itself by the message, and Escape returns focus', () => {
    mount();
    editReviewer('edited');
    const plan = itemButton('plan');
    plan.focus();
    fireEvent.click(plan);

    const bar = screen.getByRole('alertdialog');
    const save = within(bar).getByRole('button', { name: 'Save' });
    expect(document.activeElement).toBe(save);
    const described = bar.getAttribute('aria-describedby');
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)!.textContent).toBe('Unsaved changes to reviewer');

    fireEvent.keyDown(save, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(plan);
  });

  it('Keep editing closes the bar and returns focus to the item that opened it', () => {
    mount();
    editReviewer('edited');
    const plan = itemButton('plan');
    plan.focus();
    fireEvent.click(plan);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(plan);
  });

  it('Save commits the buffer and moves focus to the newly selected item', () => {
    const { bridge } = mount();
    editReviewer('edited');
    fireEvent.click(itemButton('plan'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    expect(bridge.last('save-agent-file')).toMatchObject({ name: 'reviewer', body: 'edited' });
    expect(document.activeElement).toBe(itemButton('plan'));
  });

  it('Discard drops the buffer, then moves focus to the newly selected item', () => {
    const { bridge } = mount();
    editReviewer('edited');
    fireEvent.click(itemButton('plan'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    expect(bridge.last('save-agent-file')).toBeUndefined();
    expect(document.activeElement).toBe(itemButton('plan'));
  });

  it('a tab switch resolves onto that tab, which takes focus', () => {
    mount();
    editReviewer('edited');
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    const roles = screen.getAllByRole('tab')[0]!;
    expect(roles.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(roles);
  });
});

describe('Agents page — a Settings-section switch is guarded while profile text is unsaved', () => {
  it('blocks the switch and shows the same bar; Discard switches without saving', () => {
    const { bridge } = mountWithShell();
    editReviewer('edited');
    fireEvent.click(document.querySelector('[data-section="git"]')!);
    expect(screen.getByRole('alertdialog').textContent).toContain('Unsaved changes to reviewer');
    expect(activeSection()).toBe('agents');

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
    expect(bridge.last('save-agent-file')).toBeUndefined();
    expect(activeSection()).toBe('git');
  });

  it('Save writes the buffer through the host, then completes the switch', () => {
    const { bridge } = mountWithShell();
    editReviewer('edited');
    fireEvent.click(document.querySelector('[data-section="git"]')!);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save' }));
    expect(bridge.last('save-agent-file')).toMatchObject({ name: 'reviewer', body: 'edited' });
    expect(activeSection()).toBe('git');
  });

  it('a page with no unsaved profile text switches straight away', () => {
    mountWithShell();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(document.querySelector('[data-section="git"]')!);
    expect(activeSection()).toBe('git');
  });
});

describe('Agents page — Source reasons without a tooltip (UI-R19, R22)', () => {
  it('every source chip carries its reason as screen-reader text after it', () => {
    mount({
      ...BASE,
      processes: { ...BASE.processes, uatTester: { provider: 'codex', model: 'gpt-5.6-sol', pinned: true } },
    } as unknown as Manifest);
    expect(row('planning').querySelector('[data-source="preset"] .sr-only')!.textContent).toBe(
      'From the selected preset.',
    );
    expect(row('uatTester').querySelector('[data-source="pin"] .sr-only')!.textContent).toBe(
      'Pinned — the same in all presets, and it beats the preset.',
    );
    const inherited = row('implementation').querySelector('[data-source="default"]')!;
    expect(inherited.textContent).toContain("uses Karst's built-in default.");
    // `title` stays as the supplemental pointer path.
    expect(inherited.getAttribute('title')).toContain("uses Karst's built-in default.");
  });

  it("shows the selected row's Source reason in the status line under the table", () => {
    window.location.hash = '#agents/roles/planning';
    mount();
    const status = document.querySelector('.agents-status') as HTMLElement;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe('Planner: From the selected preset.');
  });
});

describe('Agents page — draft pin actions are announced (UI-R27, R28)', () => {
  it('names the role and what the draft now does for pin, unpin and clear', () => {
    mount();
    const status = (): string => (document.querySelector('.agents-status') as HTMLElement).textContent ?? '';
    fireEvent.click(within(row('planning')).getByRole('button', { name: 'Pin' }));
    expect(status()).toBe('Planner pinned: same agent in every preset.');
    fireEvent.click(within(row('planning')).getByRole('button', { name: 'Unpin' }));
    expect(status()).toBe('Planner unpinned: uses the preset value.');
    fireEvent.click(within(row('planning')).getByRole('button', { name: 'Clear' }));
    expect(status()).toBe("Planner cleared: uses Karst's default.");
  });
});

describe('Agents page — the all-presets matrix is not colour-only (UI-R28)', () => {
  it('marks a differing cell with a dot and says so in text', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'All presets' }));
    const differing = document.querySelectorAll('.agents-matrix-cell.differs');
    expect(differing.length).toBeGreaterThan(0);
    for (const cell of differing) {
      expect(cell.querySelector('.agents-change-dot')).not.toBeNull();
      expect(cell.querySelector('.sr-only')!.textContent).toContain('differs from A');
    }
  });
});

describe('Agents page — subscription quota', () => {
  it('renders the warn threshold with the loader default as its placeholder', () => {
    mount();
    const field = screen.getByLabelText('Warn at used %') as HTMLInputElement;
    expect(field.getAttribute('type')).toBe('number');
    expect(field.getAttribute('min')).toBe('1');
    expect(field.getAttribute('max')).toBe('100');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('80');
  });

  it('writes the threshold as a whole number from 1 to 100', () => {
    const { probe } = mount();
    fireEvent.change(screen.getByLabelText('Warn at used %'), { target: { value: '95' } });
    expect(draftOf(probe)).toMatchObject({ quota: { warnThresholdPct: 95 } });
  });

  it('snaps an out-of-range threshold back to blank and flags it inline', () => {
    const { probe } = mount();
    const field = screen.getByLabelText('Warn at used %') as HTMLInputElement;
    for (const bad of ['0', '101', '2.5']) {
      fireEvent.change(field, { target: { value: '90' } });
      fireEvent.change(field, { target: { value: bad } });
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(probe().draft).not.toHaveProperty('quota');
    }
    fireEvent.change(field, { target: { value: '80' } });
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('renders the global Claude statusline install OFF by default', () => {
    mount();
    const toggle = screen.getByLabelText('Install for all Claude sessions') as HTMLInputElement;
    expect(toggle.getAttribute('type')).toBe('checkbox');
    expect(toggle.checked).toBe(false);
  });

  it('writes the opt-in flag while preserving the warn threshold', () => {
    const { probe } = mount({ ...BASE, quota: { warnThresholdPct: 95 } } as unknown as Manifest);
    fireEvent.click(screen.getByLabelText('Install for all Claude sessions'));
    expect(draftOf(probe).quota).toEqual({ warnThresholdPct: 95, claudeGlobalStatusline: true });
  });

  it('writes OFF when the installed toggle is turned off', () => {
    const { probe } = mount({
      ...BASE,
      quota: { warnThresholdPct: 95, claudeGlobalStatusline: true },
    } as unknown as Manifest);
    const toggle = screen.getByLabelText('Install for all Claude sessions') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(draftOf(probe).quota).toEqual({ warnThresholdPct: 95, claudeGlobalStatusline: false });
  });

  it('renders the Claude usage API fallback OFF by default', () => {
    mount();
    const toggle = screen.getByLabelText('Use the Claude usage API') as HTMLInputElement;
    expect(toggle.getAttribute('type')).toBe('checkbox');
    expect(toggle.checked).toBe(false);
  });

  it('writes the usage API opt-in while preserving the other quota settings', () => {
    const { probe } = mount({
      ...BASE,
      quota: { warnThresholdPct: 95, claudeGlobalStatusline: true },
    } as unknown as Manifest);
    fireEvent.click(screen.getByLabelText('Use the Claude usage API'));
    expect(draftOf(probe).quota).toEqual({
      warnThresholdPct: 95,
      claudeGlobalStatusline: true,
      claudeOauthUsageApi: true,
    });
  });

  it('writes OFF when the usage API toggle is turned off', () => {
    const { probe } = mount({
      ...BASE,
      quota: { warnThresholdPct: 95, claudeOauthUsageApi: true },
    } as unknown as Manifest);
    const toggle = screen.getByLabelText('Use the Claude usage API') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(draftOf(probe).quota).toEqual({ warnThresholdPct: 95, claudeOauthUsageApi: false });
  });
});

describe('Agents page — roles table layout markup', () => {
  const cells = (r: Element) => Array.from(r.children).map((c) => c.className);
  const mountCompare = () => {
    mount();
    fireEvent.change(document.querySelector('[name="agents-compare"]')!, { target: { value: 'B' } });
  };

  it('header has an empty "Enabled" first column and one picker column with Core/Model/Effort spans', () => {
    mount();
    const heads = screen.getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual(['Enabled', 'Role', 'Agent profile', 'CoreModelEffort', 'Source', 'Actions']);
    expect(heads[0]!.querySelector('.sr-only')!.textContent).toBe('Enabled');
    const spans = Array.from(heads[3]!.querySelectorAll('.agents-picker-head-grid > span'));
    expect(spans.map((s) => s.textContent)).toEqual(['Core', 'Model', 'Effort']);
  });

  it('every normal row has the same six cells in the same order, all role=cell', () => {
    mount();
    for (const r of document.querySelectorAll('.agents-row[data-role]')) {
      expect(cells(r).map((c) => c.split(' ').find((n) => n.startsWith('agents-cell-')))).toEqual([
        'agents-cell-switch', 'agents-cell-role', 'agents-cell-profile',
        'agents-cell-picker', 'agents-cell-source', 'agents-cell-actions',
      ]);
      expect(Array.from(r.children).map((c) => c.getAttribute('role'))).toEqual([
        'cell', 'cell', 'cell', 'cell', 'cell', 'cell',
      ]);
    }
  });

  it('a non-pinnable role has an empty switch cell and a hidden pin slot beside Clear', () => {
    mount();
    const r = Array.from(document.querySelectorAll('.agents-row[data-role]')).find(
      (el) => !el.querySelector('[role="switch"], input[type="checkbox"]'),
    )!;
    expect(r.querySelector('.agents-cell-switch')!.children).toHaveLength(0);
    const slot = r.querySelector('.agents-slot')!;
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
  const withStatus = (manifest: Manifest, status: unknown) => {
    const view = mount(manifest);
    act(() => view.bridge.push({ type: 'backend-status', status } as never));
    return view;
  };
  const group = (core: string) => within(screen.getByTestId(`backend-row-${core}`));
  const radio = (core: string, value: string) => group(core).getByRole('radio', { name: value });
  const checkedOf = (core: string) =>
    group(core).getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent);
  const lastWant = (bridge: { posted: readonly unknown[] }) =>
    (bridge.posted.filter((m) => (m as { type: string }).type === 'check-backends').at(-1) as { want: unknown }).want;

  it('all host: one row per core, each offering only its allowed values', () => {
    mount();
    const values = (core: string) => group(core).getAllByRole('radio').map((r) => r.textContent);
    expect(values('claude')).toEqual(['host', 'sbx']);
    expect(values('codex')).toEqual(['host', 'sbx']);
    expect(values('opencode')).toEqual(['host', 'docker']);
    expect(values('opencode2')).toEqual(['host', 'docker']);
    expect(values('agy')).toEqual(['host']);
    for (const core of ['claude', 'codex', 'opencode', 'opencode2', 'agy']) expect(checkedOf(core)).toEqual(['host']);
  });

  it('the agy row is host only, disabled, with a "no sandbox yet" note', () => {
    mount();
    expect((radio('agy', 'host') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('backend-row-agy').textContent).toContain('no sandbox yet');
  });

  it('choosing a backend edits only that core in the draft map', () => {
    const { probe } = mount();
    fireEvent.click(radio('claude', 'sbx'));
    fireEvent.click(radio('opencode', 'docker'));
    expect(draftOf(probe).agentBackends).toEqual({ claude: 'sbx', opencode: 'docker' });
    expect('agentBackend' in draftOf(probe)).toBe(false);
  });

  it('choosing host again deletes the core key, and the map when empty, so the yml stays clean', () => {
    const { probe } = mount({ ...BASE, agentBackends: { claude: 'sbx', opencode: 'docker' } } as Manifest);
    fireEvent.click(radio('claude', 'host'));
    expect(draftOf(probe).agentBackends).toEqual({ opencode: 'docker' });
    fireEvent.click(radio('opencode', 'host'));
    expect('agentBackends' in draftOf(probe)).toBe(false);
  });

  it('mixed sbx + docker: effective line per core and both statuses shown', () => {
    withStatus(
      { ...BASE, agentBackends: { claude: 'sbx', opencode: 'docker' } } as Manifest,
      { sbx: { ok: true }, docker: { ok: true } },
    );
    const line = screen.getByTestId('effective-backend').textContent;
    expect(line).toContain('claude: sbx');
    expect(line).toContain('opencode: docker');
    expect(line).toContain('codex: host');
    expect(screen.getByTestId('backend-status-sbx').textContent).toContain('ready');
    expect(screen.getByTestId('backend-status-docker').textContent).toContain('ready');
  });

  it('preflight fail: the core falls back to host with the reason and the fix hint shows', () => {
    withStatus(
      { ...BASE, agentBackends: { claude: 'sbx' } } as Manifest,
      { sbx: { ok: false, reason: 'sbx not signed in (run `sbx login`)' }, docker: { ok: true } },
    );
    expect(screen.getByTestId('effective-backend').textContent).toContain('claude: host (sbx not signed in (run `sbx login`))');
    expect(screen.getByTestId('backend-status-sbx').textContent).toContain('sbx not signed in');
    expect(screen.queryByTestId('backend-status-docker')).toBeNull();
  });

  it('shows no backend status while every core is on host', () => {
    mount();
    expect(screen.queryByTestId('backend-status-sbx')).toBeNull();
    expect(screen.queryByTestId('backend-status-docker')).toBeNull();
  });

  it('asks the host to probe only the backends some core selects, on mount, on change and on Re-check', () => {
    const { bridge } = mount();
    const checks = () => bridge.posted.filter((m) => (m as { type: string }).type === 'check-backends').length;
    expect(checks()).toBe(1);
    expect(lastWant(bridge)).toEqual({ sbx: false, docker: false });
    fireEvent.click(radio('opencode2', 'docker'));
    expect(checks()).toBe(2);
    expect(lastWant(bridge)).toEqual({ sbx: false, docker: true });
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(checks()).toBe(3);
  });

  it('says status is not checked when the host has not reported', () => {
    mount({ ...BASE, agentBackends: { codex: 'sbx' } } as Manifest);
    expect(screen.getByTestId('backend-status-sbx').textContent).toContain('not checked');
  });
});
