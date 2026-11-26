/**
 * COMPONENT-mode tests for the graph approach's Edit drawer (spec Edits 7, 8).
 *
 * The load-bearing assertions:
 *
 * - **the ceilings and defaults are the IMPORTED constants (R-X1/UI-R34)**:
 *   every rendered `data-ceiling` / `data-packaged` equals the `graphConfig.ts`
 *   export, and every ceiling key has a row;
 * - **a graph edit lives in the drawer only**: the Settings draft does not
 *   change and the tab does not go dirty until Save; Cancel, Escape and close
 *   discard the edit and post no save;
 * - **a profile pick writes ONLY that profile**, and a limit edit ONLY one key
 *   (spread-not-rebuild, byte-identical elsewhere);
 * - **the round trip is exact**: Save with no edit writes the same graph, and
 *   "20 GiB" saves 21474836480;
 * - **the shared picker mounts per profile row and survives a state push**
 *   (R-X3).
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import { DEFAULT_GRAPH_LIMITS, GRAPH_HARD_CEILINGS } from '../../../../manifest/graphConfig.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import type { AgentPickerOptions } from '../hostBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { ApproachesSection } from './ApproachesSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { limitHint } from './graphLimitUnits.js';

afterEach(cleanup);

/**
 * The shared agent picker is an injected VANILLA runtime (R-X3). The stand-in
 * records EVERY mount with the profile row it landed in, and writes one node it
 * "owns" into the container React never reconciles children into.
 */
let pickerMounts: ReadonlyArray<{ readonly name: string; readonly opts: AgentPickerOptions }> = [];

beforeEach(() => {
  pickerMounts = [];
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (
    root: HTMLElement,
    opts: AgentPickerOptions,
  ) => {
    const row = root.closest('[data-gf-profile-picker]');
    pickerMounts = [...pickerMounts, { name: row?.getAttribute('data-gf-profile-picker') ?? '', opts }];
    if (root.childElementCount === 0) {
      const owned = document.createElement('span');
      owned.dataset.pickerOwned = 'true';
      root.appendChild(owned);
    }
  };
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).mountAgentPicker;
});

const GRAPH_ID = 'karst-graph-engineering';

const GRAPH_APPROACH = {
  id: GRAPH_ID,
  label: 'Dynamic Graph',
  graph: {
    planner: { profile: 'expert', prompt: { artifact: 'prompts/graph-planner.md' } },
    profiles: {
      expert: { provider: 'claude', model: 'claude-sonnet' },
      worker: { provider: 'claude', model: 'claude-sonnet' },
    },
    commands: {
      test: { command: 'npm', args: ['test'], cwd: 'repository', access: 'write', timeoutSeconds: 1800 },
    },
    limits: { maxParallel: 2, maxAgentWallSeconds: 9999 },
  },
} as unknown as ApproachDef;

const GRAPH_MANIFEST: Manifest = { ...FIXTURE_MANIFEST, approaches: [GRAPH_APPROACH] };

let probeRef: (() => AppProbeShape) | null = null;

function stateFor(manifest: Manifest) {
  return buildSettingsState(manifest, null, [], true, ['claude'], [], {}, undefined, '/repo/karst.yml');
}

function mount(): { bridge: TestBridge } {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="approaches">
        <ApproachesSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state: stateFor(GRAPH_MANIFEST) }));
  probeRef = () => readProbe(view.baseElement);
  return { bridge };
}

function live(): AppProbeShape {
  if (!probeRef) throw new Error('mount() has not run in this test');
  return probeRef();
}

/** The graph approach as the Settings draft holds it. */
function graphApproach(): ApproachDef {
  const list = (live().draft as { approaches?: ApproachDef[] }).approaches ?? [];
  const entry = list.find((a) => a.id === GRAPH_ID);
  if (!entry) throw new Error('the graph approach is missing from the draft');
  return entry;
}

function drawer(): HTMLElement | null {
  return document.querySelector('[data-region="approach-drawer"]');
}

function openDrawer(): HTMLElement {
  const card = document.querySelector(`[data-approach="${GRAPH_ID}"]`)!;
  const edit = Array.from(card.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Edit')!;
  fireEvent.click(edit);
  const node = drawer();
  if (!node) throw new Error('the drawer did not open');
  return node;
}

function setField(name: string, value: string): void {
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null;
  if (!el) throw new Error(`no drawer field ${name}`);
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error(`no value setter on ${name}`);
  setter.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function inputValue(name: string): string {
  return (document.querySelector(`[name="${name}"]`) as HTMLInputElement).value;
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

/** The LATEST mount options for one profile row. */
function pickOptions(name: string): AgentPickerOptions {
  const matches = pickerMounts.filter((m) => m.name === name);
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`no agent picker mounted for profile ${name}`);
  return last.opts;
}

describe('graph drawer — the shell and the regions', () => {
  it('renders Agents, Limits and Planner with a jump bar, and hides Source and Entrypoint', () => {
    mount();
    const node = openDrawer();
    expect(node.classList.contains('is-graph')).toBe(true);
    expect(node.querySelector('.drawer-body.form')).not.toBeNull();
    for (const region of ['graph-agents', 'graph-limits', 'graph-planner']) {
      expect(node.querySelector(`[data-region="${region}"]`), region).not.toBeNull();
    }
    const jumps = Array.from(node.querySelectorAll('.drawer-jump button')).map((b) => b.textContent);
    expect(jumps).toEqual(['Identity', 'Agents', 'Limits', 'Planner']);
    expect(node.querySelector('[name="af-entrypoint"]')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Git' })).toBeNull();
    // Recommended moves into Identity, so it stays editable.
    expect(node.querySelector('[name="af-recommended"]')).not.toBeNull();
  });

  it('shows the planner artifact path and an Open prompt button', () => {
    const { bridge } = mount();
    const node = openDrawer();
    const planner = node.querySelector('[data-region="graph-planner"]')!;
    expect(planner.querySelector('.graph-prompt-path')?.textContent).toBe('prompts/graph-planner.md');
    const open = planner.querySelector('[data-open-graph-prompt="karst-graph-planner"]') as HTMLButtonElement;
    expect(open.textContent).toBe('Open prompt');
    fireEvent.click(open);
    expect(bridge.all('open-graph-prompt')).toHaveLength(1);
  });

  it('shows the override note and a link to Agents › Roles', () => {
    mount();
    const agents = openDrawer().querySelector('[data-region="graph-agents"]')!;
    expect(agents.textContent).toContain('An active agent preset overrides these.');
    fireEvent.click(button('Open Agents › Roles'));
    expect(window.location.hash).toBe('#agents/roles');
  });
});

describe('graph drawer — the limit rows (R-X1, UI-R34)', () => {
  it('has one row per ceiling key, with the imported default, max and hint', () => {
    mount();
    const node = openDrawer();
    const rendered: string[] = [];
    for (const row of Array.from(node.querySelectorAll('[data-gf-limit]'))) {
      const field = row.getAttribute('data-gf-limit') as keyof typeof GRAPH_HARD_CEILINGS;
      rendered.push(field);
      expect(row.getAttribute('data-packaged'), field).toBe(String(DEFAULT_GRAPH_LIMITS[field]));
      expect(row.getAttribute('data-ceiling'), field).toBe(String(GRAPH_HARD_CEILINGS[field]));
      expect(row.textContent, field).toContain(limitHint(field));
      const input = row.querySelector('input[type="number"]') as HTMLInputElement;
      expect(row.querySelector('label')!.getAttribute('for'), field).toBe(input.id);
    }
    expect([...rendered].sort()).toEqual(Object.keys(GRAPH_HARD_CEILINGS).sort());
  });

  it('groups the rows by Time, Storage and Runs, with a Command timeout text row', () => {
    mount();
    const node = openDrawer();
    const titles = Array.from(node.querySelectorAll('.graph-limit-group-title')).map((n) => n.textContent);
    expect(titles).toEqual(['Time', 'Storage', 'Runs']);
    const timeout = Array.from(node.querySelectorAll('.graph-limit-row')).find((row) =>
      row.textContent?.includes('Command timeout'),
    )!;
    expect(timeout.textContent).toContain('Set on each gate command · max 2 h');
    expect(timeout.hasAttribute('data-gf-limit')).toBe(false);
  });

  it('seeds each row in the largest whole unit', () => {
    mount();
    openDrawer();
    expect(inputValue('gf-limit-maxGraphWallSeconds')).toBe('24');
    expect(inputValue('gf-unit-maxGraphWallSeconds')).toBe('hours');
    expect(inputValue('gf-limit-maxAgentWallSeconds')).toBe('9999');
    expect(inputValue('gf-unit-maxAgentWallSeconds')).toBe('s');
    expect(inputValue('gf-limit-maxAggregateWorkspaceBytes')).toBe('20');
    expect(inputValue('gf-unit-maxAggregateWorkspaceBytes')).toBe('GiB');
    expect(document.querySelector('[name="gf-unit-maxParallel"]')).toBeNull();
  });

  it('marks a changed row with a dot and a Reset that deletes the key on Save', () => {
    mount();
    const node = openDrawer();
    const row = node.querySelector('[data-gf-limit="maxAgentWallSeconds"]')!;
    expect(row.querySelector('.graph-limit-dot')).not.toBeNull();
    expect(node.querySelector('[data-gf-limit="maxGraphWallSeconds"] .graph-limit-dot')).toBeNull();
    fireEvent.click(row.querySelector('.graph-limit-reset')!);
    expect(inputValue('gf-limit-maxAgentWallSeconds')).toBe('2');
    expect(inputValue('gf-unit-maxAgentWallSeconds')).toBe('hours');
    fireEvent.click(button('Save approach'));
    const limits = graphApproach().graph!.limits;
    expect('maxAgentWallSeconds' in limits).toBe(false);
    expect(limits.maxParallel).toBe(2);
  });

  it('shows an invalid value error under its row and disables Save', () => {
    const { bridge } = mount();
    const node = openDrawer();
    setField('gf-limit-maxActivations', '2000');
    const row = node.querySelector('[data-gf-limit="maxActivations"]')!;
    expect(row.textContent).toContain('Activations must be 1000 or less.');
    expect(button('Save approach').disabled).toBe(true);
    expect(node.querySelector('.drawer-error-count')?.textContent).toBe('1 error');
    fireEvent.click(button('Save approach'));
    expect(bridge.all('save')).toHaveLength(0);
    setField('gf-limit-maxActivations', '300');
    expect(button('Save approach').disabled).toBe(false);
    expect(node.querySelector('.drawer-error-count')).toBeNull();
  });
});

describe('graph drawer — edits apply on Save only (spec Edit 8)', () => {
  it('a limit edit changes one key by spread, and only on Save', () => {
    const { bridge } = mount();
    const before = graphApproach();
    openDrawer();
    setField('gf-unit-maxAgentIdleSeconds', 'min');
    setField('gf-limit-maxAgentIdleSeconds', '50');
    // Nothing reaches the Settings draft yet.
    expect(JSON.stringify(graphApproach())).toBe(JSON.stringify(before));
    expect(live().dirtySections).toEqual([]);
    fireEvent.click(button('Save approach'));
    expect(bridge.all('save')).toHaveLength(1);
    const after = graphApproach();
    expect(JSON.stringify(after.graph!.limits)).toBe(
      JSON.stringify({ ...before.graph!.limits, maxAgentIdleSeconds: 3000 }),
    );
    expect(JSON.stringify(after.graph!.profiles)).toBe(JSON.stringify(before.graph!.profiles));
    expect(JSON.stringify(after.graph!.commands)).toBe(JSON.stringify(before.graph!.commands));
    expect(JSON.stringify(after.graph!.planner)).toBe(JSON.stringify(before.graph!.planner));
  });

  it('a profile pick writes that profile only, and only on Save', () => {
    mount();
    const before = graphApproach();
    openDrawer();
    act(() => pickOptions('expert').onChange({ core: 'codex', model: 'gpt-5', effort: 'high' }));
    expect(JSON.stringify(graphApproach())).toBe(JSON.stringify(before));
    expect(live().dirtySections).toEqual([]);
    fireEvent.click(button('Save approach'));
    const after = graphApproach();
    expect(after.graph!.profiles.expert).toEqual({ provider: 'codex', model: 'gpt-5', effort: 'high' });
    expect(after.graph!.profiles.worker).toEqual({ provider: 'claude', model: 'claude-sonnet' });
    expect(JSON.stringify(after.graph!.limits)).toBe(JSON.stringify(before.graph!.limits));
    expect(JSON.stringify(after.graph!.commands)).toBe(JSON.stringify(before.graph!.commands));
    expect(JSON.stringify(after.graph!.planner)).toBe(JSON.stringify(before.graph!.planner));
  });

  it('round trip: Save with no edit writes the same graph back (invariant)', () => {
    const { bridge } = mount();
    const before = graphApproach();
    openDrawer();
    fireEvent.click(button('Save approach'));
    expect(bridge.all('save')).toHaveLength(1);
    expect(JSON.stringify(graphApproach().graph)).toBe(JSON.stringify(before.graph));
  });

  it('saves "20 GiB" as 21474836480 bytes', () => {
    mount();
    openDrawer();
    setField('gf-unit-maxAggregateWorkspaceBytes', 'MiB');
    setField('gf-limit-maxAggregateWorkspaceBytes', '1');
    setField('gf-unit-maxAggregateWorkspaceBytes', 'GiB');
    setField('gf-limit-maxAggregateWorkspaceBytes', '20');
    fireEvent.click(button('Save approach'));
    expect(graphApproach().graph!.limits.maxAggregateWorkspaceBytes).toBe(21474836480);
  });

  it('Cancel after a graph edit posts no save and keeps the draft clean (invariant)', () => {
    const { bridge } = mount();
    const before = graphApproach();
    openDrawer();
    setField('gf-limit-maxParallel', '6');
    act(() => pickOptions('worker').onChange({ core: 'codex', model: 'gpt-5', effort: '' }));
    fireEvent.click(button('Cancel'));
    expect(drawer()).toBeNull();
    expect(bridge.all('save')).toHaveLength(0);
    expect(JSON.stringify(graphApproach())).toBe(JSON.stringify(before));
    expect(live().dirtySections).toEqual([]);
    // A reopen shows the original values, not the discarded edit.
    openDrawer();
    expect(inputValue('gf-limit-maxParallel')).toBe('2');
    expect(pickOptions('worker').value).toMatchObject({ core: 'claude', model: 'claude-sonnet' });
  });

  it('Escape and the close control also discard the graph edit', () => {
    const { bridge } = mount();
    openDrawer();
    setField('gf-limit-maxParallel', '6');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer()).toBeNull();
    const node = openDrawer();
    setField('gf-limit-maxParallel', '7');
    fireEvent.click(node.querySelector<HTMLElement>('.drawer-head button[aria-label="Close"]')!);
    expect(drawer()).toBeNull();
    expect(bridge.all('save')).toHaveLength(0);
    expect(graphApproach().graph!.limits.maxParallel).toBe(2);
  });

  it('an Escape that closes an open picker menu keeps the drawer open', () => {
    mount();
    const node = openDrawer();
    setField('gf-limit-maxParallel', '6');
    const shell = document.createElement('div');
    shell.setAttribute('data-ap-shell', '');
    shell.className = 'ap-shell is-open';
    node.querySelector('[data-gf-profile-picker="expert"]')!.appendChild(shell);
    fireEvent.keyDown(shell, { key: 'Escape' });
    expect(drawer()).not.toBeNull();
    expect(inputValue('gf-limit-maxParallel')).toBe('6');
    shell.remove();
    fireEvent.keyDown(node, { key: 'Escape' });
    expect(drawer()).toBeNull();
  });
});

describe('graph drawer — profile pickers (R-X3)', () => {
  it('mounts one compact picker per profile, with the profile hints, and survives a state push', () => {
    const { bridge } = mount();
    const node = openDrawer();
    const pickers = node.querySelectorAll('[data-gf-profile-picker]');
    expect(pickers).toHaveLength(2);
    expect(new Set(pickerMounts.map((m) => m.name))).toEqual(new Set(['expert', 'worker']));
    expect(pickerMounts.every((m) => m.opts.compact === true)).toBe(true);
    const hints = Array.from(node.querySelectorAll('.graph-profile-hint')).map((n) => n.textContent);
    expect(hints).toEqual(['Planner and hard nodes', 'Most nodes']);
    const mountsBefore = pickerMounts.length;
    act(() => bridge.push({ type: 'state', state: stateFor(GRAPH_MANIFEST) }));
    expect(document.querySelectorAll('[data-picker-owned="true"]')).toHaveLength(2);
    expect(pickerMounts.length).toBe(mountsBefore);
  });
});
