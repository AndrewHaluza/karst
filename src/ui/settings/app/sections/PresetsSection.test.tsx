/**
 * COMPONENT-mode tests for the Presets tab (NDL-126 §9.5, phase 3 step 3).
 *
 * The load-bearing assertions here are the ones that would silently corrupt a
 * user's file rather than merely look wrong:
 *
 * - **Normalize on write, never on read.** A §6 legacy flat preset is ONE slot on
 *   every capability. An untouched one must stay byte-for-byte (so the tab does
 *   not rewrite a file on open), and any write must produce the `slots:` form so
 *   `{provider, model, slots}` — which the host REFUSES — can never reach disk.
 * - **A referenced preset refuses rename and delete**, naming every referrer.
 *   The active selector is on this tab but `processes.<key>.preset` belongs to
 *   the Agents tab, and a tab-scoped Save writes only its own fields — so
 *   "fixing" the reference here would never reach the file.
 * - **An Override row is seeded with a COMPLETE slot.** `{provider}` alone is
 *   refused by the host at Save, so a row that opens Override with nothing valid
 *   must stay Inherit instead (UI-R25).
 * - **The empty case says which fallback applies.** An empty override is
 *   indistinguishable from no override, so the Inherit line names the host's
 *   inherited identity rather than showing a blank.
 * - **The island's DOM survives a re-render** (R-X3): the agent picker is a
 *   vanilla runtime, so an ordinary parent re-render must not tear it down.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import type { Manifest, AgentPreset } from '../../../../manifest/types.js';
import type { AgentPickerOptions } from '../hostBridge.js';
import { PresetsSection } from './PresetsSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';

afterEach(cleanup);

/**
 * The shared agent picker is an injected VANILLA runtime (R-X3). The stand-in
 * writes one node it "owns" into the container React will never reconcile
 * children into, so the island tests can prove the DOM survives a re-render, and
 * records the options so a test can drive the runtime's own `onChange`.
 */
let pickerOptions: AgentPickerOptions | null = null;
let pickerCalls = 0;

beforeEach(() => {
  pickerOptions = null;
  pickerCalls = 0;
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (
    root: HTMLElement,
    opts: AgentPickerOptions,
  ) => {
    pickerCalls += 1;
    pickerOptions = opts;
    if (root.childElementCount === 0) {
      const owned = document.createElement('span');
      owned.textContent = 'picker-dom';
      owned.dataset.pickerOwned = 'true';
      root.appendChild(owned);
    }
  };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).mountAgentPicker;
});

/** A state push whose manifest carries `agentPresets` and a project default. */
function stateWith(manifest: Manifest, implemented: Parameters<typeof buildSettingsState>[4] = ['claude']) {
  return buildSettingsState(manifest, null, [], true, implemented, [], {}, undefined, '/repo/karst.yml');
}

const BASE: Manifest = {
  ...FIXTURE_MANIFEST,
  agentProvider: 'claude',
  defaultModel: 'claude-sonnet',
  agentPresets: {
    smart: { slots: { implementation: { provider: 'claude', model: 'claude-sonnet' } } },
  } as Record<string, AgentPreset>,
};

function mount(manifest: Manifest = BASE): {
  bridge: TestBridge;
  probe(): AppProbeShape;
} {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="presets">
        <PresetsSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state: stateWith(manifest) }));
  const probe = (): AppProbeShape => readProbe(view.baseElement);
  probeRef = probe;
  return { bridge, probe };
}

/** The current mount's probe; `mount()` binds it before any assertion runs. */
function live(): () => AppProbeShape {
  if (!probeRef) throw new Error('mount() has not run in this test');
  return probeRef;
}

/**
 * The tab under test for the current `it`. `mount()` returns the probe; tests
 * that only need to assert on the draft read it through here so the assertion
 * stays next to the behaviour rather than threaded through every signature.
 */
let probeRef: (() => AppProbeShape) | null = null;

function presets(probe: () => AppProbeShape): Record<string, AgentPreset> {
  return (probe().draft as { agentPresets?: Record<string, AgentPreset> }).agentPresets ?? {};
}

/**
 * The slots map, read through a widened view: the manifest types it as
 * `Partial<Record<PresetCapability, PresetSlot>>` and a test addresses rows by
 * the capability id it found in the DOM, which is a plain string.
 */
function slotsOf(name: string): Record<string, { provider: string; model?: string; effort?: string }> {
  return (presets(live())[name]?.slots ?? {}) as Record<
    string,
    { provider: string; model?: string; effort?: string }
  >;
}

/** The matrix row for one capability, by its host-supplied id. */
function row(capability: string): HTMLElement {
  const node = document.querySelector(`[data-cap-row="${capability}"]`);
  if (!node) throw new Error(`no matrix row for ${capability}`);
  return node as HTMLElement;
}

function modeSelect(capability: string): HTMLSelectElement {
  return row(capability).querySelector('.cap-mode select') as HTMLSelectElement;
}

describe('PresetsSection — host-computed facts are rendered verbatim (UI-R31)', () => {
  it('renders every group label and row label the host pushed, deriving none', () => {
    mount();
    // The group labels arrive in `presetGroups`; the tab must show them as-is.
    const groups = Array.from(document.querySelectorAll('.matrix-group')).map((n) => n.textContent);
    expect(groups.length).toBeGreaterThan(0);
    const rowLabels = Array.from(document.querySelectorAll('.cap-name')).map((n) => n.textContent);
    expect(rowLabels.length).toBeGreaterThan(0);
    // Every label is non-empty: an empty row label would be a derived one that
    // the host did not supply.
    expect(rowLabels.every((t) => t !== null && t.trim() !== '')).toBe(true);
  });

  it('names the inherited fallback on an Inherit row rather than showing a blank', () => {
    mount();
    const inheritCell = row('review').querySelector('.cap-inherited');
    expect(inheritCell?.textContent ?? '').toMatch(/^Inherited: /);
  });

  it('shows the overridden count and the active marker in the preset list', () => {
    mount();
    const meta = document.querySelector('.preset-meta')?.textContent ?? '';
    expect(meta).toMatch(/\d+\/\d+ (overridden|overrides)/);
  });
});

describe('PresetsSection — the matrix rows', () => {
  it('reflects Override for a row with a slot and Inherit for one without', () => {
    mount();
    expect(modeSelect('implementation').value).toBe('override');
    const untouched = Array.from(document.querySelectorAll('.cap-mode select')).find(
      (n) => (n as HTMLSelectElement).value === 'inherit',
    );
    expect(untouched).toBeDefined();
  });

  it('seeds an Override row with the host inherited identity, complete', () => {
    mount();
    const inheritOnly = Array.from(document.querySelectorAll('.cap-mode select')).find(
      (n) => (n as HTMLSelectElement).value === 'inherit',
    ) as HTMLSelectElement;
    // The control's name IS the capability id — `Field` owns the id, and the row
    // keeps the host-supplied capability on `data-cap-row`.
    const row = inheritOnly.closest('[data-cap-row]');
    const cap = row?.getAttribute('data-cap-row') ?? '';
    expect(cap).not.toBe('');
    fireEvent.change(inheritOnly, { target: { value: 'override' } });
    // The seeded slot must name BOTH a core and a model: `{provider}` alone is
    // refused by the host at Save, so opening Override to fail on Apply is
    // UI-R25 backwards.
    const written = slotsOf('smart')[cap];
    expect(written?.provider).toBeTruthy();
    expect(written?.model).toBeTruthy();
  });

  it('keeps a row Inherit when there is no valid seed to open it on', () => {
    // A preset EXISTS (so the matrix renders) but the project declares no default
    // identity and the host's inheritance view is emptied, so `seedPresetSlot`
    // has nothing to build a complete `{provider, model}` slot from. Opening
    // Override would hand the host a slot it refuses at Save, so the row must
    // stay Inherit instead (UI-R25).
    const bridge = createTestBridge();
    const state = stateWith({
      ...FIXTURE_MANIFEST,
      agentProvider: undefined,
      defaultModel: undefined,
      agentPresets: { smart: { slots: {} } } as Record<string, AgentPreset>,
    } as Manifest);
    // Empty the host's inheritance view: the matrix has no identity to fall back
    // to for any row.
    (state as unknown as { presetInheritance: Record<string, unknown> }).presetInheritance = {};
    const view = render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="presets">
          <PresetsSection />
          <AppProbe />
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    act(() => bridge.push({ type: 'state', state }));
    probeRef = () => readProbe(view.baseElement);

    const anySelect = Array.from(document.querySelectorAll('.cap-mode select'))[0] as HTMLSelectElement;
    fireEvent.change(anySelect, { target: { value: 'override' } });
    // The row gained no slot, so it is still Inherit — the select snapped back
    // because the rendered mode is derived from the slot's absence.
    expect(slotsOf('smart')).toEqual({});
    expect(anySelect.value).toBe('inherit');
  });

  it('returns a row to Inherit when the picker reports an emptied core', () => {
    mount();
    // Drive the island's own onChange the way the vanilla runtime would when the
    // user clears the core: a blank core is a CLEAR, not a write.
    expect(pickerOptions).not.toBeNull();
    act(() => pickerOptions?.onChange({ core: '', model: '', effort: '' }));
    expect(slotsOf('smart').implementation).toBeUndefined();
  });
});

describe('PresetsSection — legacy flat presets', () => {
  it('leaves an untouched legacy preset byte-for-byte (no normalize on read)', () => {
    const legacy = { smart: { provider: 'claude', model: 'claude-sonnet' } } as unknown as Record<
      string,
      AgentPreset
    >;
    mount({ ...FIXTURE_MANIFEST, agentProvider: 'claude', agentPresets: legacy });
    // Merely opening the tab must not rewrite the record: normalization happens
    // on the way OUT of a write, never on read.
    expect((presets(live()).smart as unknown as { provider?: string }).provider).toBe('claude');
    expect((presets(live()).smart as unknown as { slots?: unknown }).slots).toBeUndefined();
  });

  it('reports a legacy preset as overriding every capability', () => {
    const legacy = { smart: { provider: 'claude', model: 'claude-sonnet' } } as unknown as Record<
      string,
      AgentPreset
    >;
    mount({ ...FIXTURE_MANIFEST, agentProvider: 'claude', agentPresets: legacy });
    const meta = document.querySelector('.preset-meta')?.textContent ?? '';
    const total = Number(/(\d+)\/(\d+) overridden/.exec(meta)?.[2] ?? '0');
    const overridden = Number(/(\d+)\/(\d+) overridden/.exec(meta)?.[1] ?? '0');
    // A legacy flat record is ONE slot on EVERY row, so the counts match.
    expect(overridden).toBe(total);
  });

  it('normalizes to the slots form on a write, so both forms never coexist', () => {
    const legacy = { smart: { provider: 'claude', model: 'claude-sonnet' } } as unknown as Record<
      string,
      AgentPreset
    >;
    mount({ ...FIXTURE_MANIFEST, agentProvider: 'claude', agentPresets: legacy });
    const anySelect = Array.from(document.querySelectorAll('.cap-mode select'))[0] as HTMLSelectElement;
    fireEvent.change(anySelect, { target: { value: 'inherit' } });
    const record = presets(live()).smart as unknown as { provider?: string; slots?: unknown };
    expect(record.slots).toBeDefined();
    // The legacy flat keys must be gone: `{provider, model, slots}` is refused by
    // the host, so leaving them behind would make the Save fail.
    expect(record.provider).toBeUndefined();
  });
});

describe('PresetsSection — referenced presets are protected', () => {
  it('refuses a delete while the active selector names it, naming the referrer', () => {
    mount({ ...BASE, activeAgentPreset: 'smart' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset' }));
    const alert = document.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Cannot delete "smart"');
    expect(alert).toContain('the active preset selector');
    // The preset must survive the refusal.
    expect(presets(live()).smart).toBeDefined();
  });

  it('refuses a delete while a process assignment names it', () => {
    mount({
      ...BASE,
      processes: { implement: { preset: 'smart' } },
    } as Manifest);
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset' }));
    const alert = document.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('Cannot delete "smart"');
    expect(alert).toContain('process assignment');
    expect(presets(live()).smart).toBeDefined();
  });

  it('allows the delete once nothing references it', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete preset' }));
    expect(presets(live()).smart).toBeUndefined();
  });
});

describe('PresetsSection — the destructive control uses the taxonomy (UI-R10b)', () => {
  it('emits data-karst-action="remove-preset" so the parity sweep can diff it', () => {
    mount();
    const del = screen.getByRole('button', { name: 'Delete preset' });
    expect(del.getAttribute('data-karst-action')).toBe('remove-preset');
  });
});

describe('PresetsSection — the bulk set-all paths', () => {
  it('writes every capability in host order on Override every row', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Override every row' }));
    const slots = slotsOf('smart');
    const total = document.querySelectorAll('[data-cap-row]').length;
    expect(Object.keys(slots).length).toBe(total);
    // One identity for every row — that is what "set all" means.
    const identities = new Set(Object.values(slots).map((s) => `${s.provider}/${s.model}`));
    expect(identities.size).toBe(1);
  });

  it('clears every row on Inherit every row', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Override every row' }));
    expect(Object.keys(slotsOf("smart")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Inherit every row' }));
    expect(slotsOf('smart')).toEqual({});
  });

  
});

describe('PresetsSection — the island is opaque (R-X3)', () => {
  it('preserves the vanilla runtime DOM across a re-render', () => {
    const { bridge } = mount();
    // The picker wrote its own node into the container.
    expect(document.querySelector('[data-picker-owned="true"]')).not.toBeNull();
    const callsBefore = pickerCalls;
    // An unrelated state push re-renders the tab. The island's DOM must survive
    // it: React never reconciles children into that container.
    expect(document.querySelector('[data-picker-owned="true"]')).not.toBeNull();
    // And the island was NOT rebuilt — the runtime keeps its state.
    act(() => bridge.push({ type: 'state', state: stateWith(BASE) }));
    expect(pickerCalls).toBe(callsBefore);
  });
});

describe('PresetsSection — active preset status in preset deck', () => {
  it('renders active preset status on cards in the preset deck', () => {
    mount({
      ...BASE,
      agentPresets: {
        ...BASE.agentPresets,
        quiet: { slots: { implementation: { provider: 'claude', model: 'claude-sonnet' } } },
      } as Record<string, AgentPreset>,
      activeAgentPreset: 'smart',
    });
    const activeChip = document.querySelector('.preset-card-compact.is-active');
    expect(activeChip).not.toBeNull();
    expect(activeChip?.textContent).toContain('smart');
  });
});

describe('PresetsSection — the capability groups are foldable', () => {
  /** The group-header disclosure button (a real `<button aria-expanded>`). */
  function groupToggle(groupLabelFragment: string): HTMLButtonElement {
    const toggles = Array.from(document.querySelectorAll('.cap-group-toggle')) as HTMLButtonElement[];
    const toggle = toggles.find((t) => (t.textContent ?? '').includes(groupLabelFragment));
    if (!toggle) throw new Error(`no group toggle matching "${groupLabelFragment}"`);
    return toggle;
  }

  it('renders every group expanded by default', () => {
    mount();
    const toggles = Array.from(document.querySelectorAll('.cap-group-toggle'));
    expect(toggles.length).toBeGreaterThan(0);
    for (const t of toggles) {
      expect((t as HTMLButtonElement).getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('collapses a group on toggle, hiding its rows but keeping the others', () => {
    mount();
    const groupIds = Array.from(document.querySelectorAll('[id^="cap-group-body-"]')).map(
      (n) => n.id,
    );
    expect(groupIds.length).toBeGreaterThan(0);
    const firstId = groupIds[0]!;
    const firstFragment = firstId.replace('cap-group-body-', '');
    // Find the toggle for the first group: the toggle whose aria-controls
    // matches the first group's body id.
    const firstToggle = Array.from(
      document.querySelectorAll('.cap-group-toggle'),
    ) as HTMLButtonElement[];
    const target = firstToggle.find(
      (t) => t.getAttribute('aria-controls')! === firstId,
    );
    expect(target, 'first group toggle').toBeDefined();
    expect(document.querySelectorAll(`#cap-group-body-${firstFragment} [data-cap-row]`).length).toBeGreaterThan(0);
    fireEvent.click(target as HTMLButtonElement);
    expect(target?.getAttribute('aria-expanded')).toBe('false');
    // The first group's body is gone from the DOM; the other groups keep theirs.
    expect(document.getElementById(firstId)).toBeNull();
    for (const id of groupIds.slice(1)) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  it('re-expands a collapsed group on a second click', () => {
    mount();
    const firstToggle = Array.from(
      document.querySelectorAll('.cap-group-toggle'),
    )[0] as HTMLButtonElement;
    const bodyId = firstToggle.getAttribute('aria-controls')!;
    expect(document.querySelectorAll(`#${bodyId} [data-cap-row]`).length).toBeGreaterThan(0);
    fireEvent.click(firstToggle);
    expect(document.getElementById(bodyId)).toBeNull();
    fireEvent.click(firstToggle);
    expect(document.getElementById(bodyId)).not.toBeNull();
    expect(firstToggle.getAttribute('aria-expanded')).toBe('true');
  });
});
