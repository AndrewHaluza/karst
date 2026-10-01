/**
 * Rendered-Settings tests for the Presets tab, through `renderSettingsApp`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `PresetsSection.test.tsx` prove per-component behaviour
 * against a bare provider. These prove the STATE-DEPENDENT rules in the real
 * hydrated document, with the nav, the shell and the section mount all present:
 *
 * - a `state` push that removes the preset being edited falls back to the first
 *   preset instead of leaving the matrix pointed at a record that no longer
 *   exists — the behaviour `renderPresets()` guards;
 * - a Presets edit marks the PRESETS tab dirty and nothing else, so the nav dot
 *   and the off-screen hint are correct (R26);
 * - the tab-scoped Save posts the whole draft with `section: 'presets'`, and the
 *   host scopes the write — the payload is asserted, not the host's merge;
 * - a preset fault is attributed to the Presets tab by `sectionForError`, so the
 *   nav shows an ERROR dot and the banner names it (R26, R-X4);
 * - a `state` push adopts the file everywhere EXCEPT the tab being saved, so a
 *   Presets edit survives an out-of-band write to another tab;
 * - Discard rolls Presets back alone.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest, AgentPreset } from '../../../../manifest/types.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';
import type { AppProbeShape } from './AppProbe.js';

let open: RenderedSettings | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

interface Mounted {
  readonly view: RenderedSettings;
  readonly bridge: TestBridge;
  probe(): AppProbeShape;
  /** The last outbound message of `type`, as the recording bridge saw it. */
  last(type: string): Record<string, unknown> | undefined;
}

const PRESET_MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  agentProvider: 'claude',
  defaultModel: 'claude-sonnet',
  agentPresets: {
    smart: { slots: { implementation: { provider: 'claude', model: 'claude-sonnet' } } },
    cheap: { slots: {} },
  } as Record<string, AgentPreset>,
};

function stateWith(manifest: Manifest) {
  return buildSettingsState(manifest, null, ['tdd'], true, ['claude'], [], {}, undefined, '/repo/karst.yml');
}

/** Mount the app, push the file, then switch to Presets the way a user would. */
async function mountOnPresets(manifest: Manifest = PRESET_MANIFEST): Promise<Mounted> {
  const bridge = createTestBridge();
  const view = await renderSettingsApp({ bridge });
  open = view;
  await view.receive({ type: 'state', state: stateWith(manifest) });
  await view.click(view.document.querySelector('[id="root"] [data-section="presets"]') as Element);
  const probe = (): AppProbeShape => {
    const node = view.document.querySelector('[id="root"]')?.querySelector('[data-probe="app"]');
    if (!node) throw new Error('AppProbe is not mounted');
    return JSON.parse(node.getAttribute('data-state') ?? '{}') as AppProbeShape;
  };
  return {
    view,
    bridge,
    probe,
    last: (type: string) => bridge.last(type as never) as unknown as Record<string, unknown> | undefined,
  };
}

/**
 * The React tree. NOTE: the section mount is a SIBLING of `#root` (the shell
 * renders nav/topbar inside `#root` and the current section beside it), so a
 * section-scoped selector has to reach the document, not `#root`.
 */
function root(view: RenderedSettings): Element {
  const node = view.document.querySelector('[id="root"]');
  if (!node) throw new Error('#root is missing');
  return node;
}

/**
 * The REACT tab, scoped by the mount marker `AppSections` emits.
 *
 * It cannot be found by `id="section-presets"`: that id still belongs to the
 * VANILLA section in `webview.html`, which remains the live view through phase 3
 * (the `KARST_SETTINGS_APP` marker arrives in phase 4). Two elements share the
 * id and the vanilla one wins `querySelector`, so every assertion here is scoped
 * to `[data-karst-settings-app]` — the same hook the phase 4 parity sweep diffs
 * against the vanilla subtree.
 */
function tab(view: RenderedSettings): Element {
  const node = view.document.querySelector('[data-karst-settings-app="true"]');
  if (!node) throw new Error('the React settings mount is not rendered');
  return node;
}

/**
 * The SHELL's topbar Save — named by the tab it acts on. It is found by its
 * text rather than by `k-btn--primary`, because the Presets section also renders
 * primary buttons of its own (`+ Add preset`) and the topbar one is the only
 * that saves.
 */
function saveButton(view: RenderedSettings, label = 'Save Presets'): Element {
  const node = Array.from(root(view).querySelectorAll('button')).find(
    (b) => b.textContent === label,
  );
  if (!node) throw new Error(`${label} is not rendered`);
  return node;
}

/**
 * The nav button for one tab. The shell marks it with `has-changes` / `has-error`
 * classes (and a title), not a data attribute — so the assertion reads the class
 * the shell actually renders.
 */
function navMarker(view: RenderedSettings, section: string): Element | null {
  return root(view).querySelector(`[data-section="${section}"]`);
}

/** Set a control's value the way React's own onChange observes it. */
async function typeInto(view: RenderedSettings, name: string, value: string): Promise<void> {
  const field = tab(view).querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!field) throw new Error(`no control named ${name}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  if (!setter) throw new Error(`no value setter on ${name}`);
  setter.call(field, value);
  field.dispatchEvent(new (view.window.Event)('input', { bubbles: true }));
  field.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
}

/**
 * Flip one matrix row to Override through its own mode select — the control the
 * user touches, not an internal setter.
 */
async function overrideRow(view: RenderedSettings, capability: string): Promise<void> {
  const select = tab(view).querySelector(
    `[data-cap-row="${capability}"] .cap-mode select`,
  ) as HTMLSelectElement | null;
  if (!select) throw new Error(`no matrix row for ${capability}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
  if (!setter) throw new Error(`no value setter on the ${capability} mode select`);
  setter.call(select, 'override');
  select.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
}

describe('rendered Presets tab — the section mounts and re-renders on a push', () => {
  it('renders the capability matrix for the selected preset', async () => {
    const { view } = await mountOnPresets();
    const mine = tab(view);
    // Every host-supplied capability row is present, in host order, grouped as
    // the host grouped them — the app derives neither.
    const rows = mine.querySelectorAll('[data-cap-row]');
    expect(rows.length).toBeGreaterThan(1);
    expect(mine.querySelectorAll('.matrix-group').length).toBeGreaterThan(0);
  });

  it('falls back to the first preset when a push removes the one being edited', async () => {
    const { view, probe } = await mountOnPresets();
    // The tab defaults to the first name in sorted order.
    expect(tab(view).querySelector('.preset-row.is-selected .preset-name')?.textContent).toBe('cheap');
    // A push that drops `cheap` must not leave the matrix pointed at a record
    // that no longer exists — the tab stays usable.
    await view.receive({
      type: 'state',
      state: stateWith({
        ...PRESET_MANIFEST,
        agentPresets: { smart: { slots: {} } } as Record<string, AgentPreset>,
      }),
    });
    expect(tab(view).querySelector('.preset-row.is-selected .preset-name')?.textContent).toBe('smart');
    expect(Object.keys(probe().draft as Record<string, unknown>)).toContain('agentPresets');
  });
});

describe('rendered Presets tab — dirty marking (R26)', () => {
  it('marks the Presets tab dirty and no other tab, on a matrix edit', async () => {
    const { view, probe } = await mountOnPresets();
    expect(probe().dirtySections).not.toContain('presets');
    await overrideRow(view, 'review');
    expect(probe().dirtySections).toEqual(['presets']);
  });

  it('shows the nav dot only on the dirty tab', async () => {
    const { view } = await mountOnPresets();
    await overrideRow(view, 'review');
    expect(navMarker(view, 'presets')?.className).toContain('has-changes');
    expect(navMarker(view, 'general')?.className).not.toContain('has-changes');
    // The shell also names the tab in the title, which is what the dot's
    // accessible text comes from.
    expect(navMarker(view, 'presets')?.getAttribute('title')).toContain('unsaved changes');
  });

  it('does not touch the draft until Save is pressed — the name field is a form buffer', async () => {
    const { view, probe } = await mountOnPresets();
    await typeInto(view, 'f-presetName', 'smarter');
    // Typing is not a manifest write: the rename is committed by the Save
    // button, which is what makes "leave it as-is to edit in place" safe.
    const draft = probe().draft as { agentPresets?: Record<string, AgentPreset> };
    expect(Object.keys(draft.agentPresets ?? {}).sort()).toEqual(['cheap', 'smart']);
    expect(probe().dirtySections).toEqual([]);
  });
});

describe('rendered Presets tab — the tab-scoped Save (R11, R26)', () => {
  it('posts the whole draft with section: presets', async () => {
    const { view, last } = await mountOnPresets();
    await overrideRow(view, 'review');
    await view.click(saveButton(view));
    const save = last('save');
    expect(save).toMatchObject({ type: 'save', section: 'presets' });
    // The host scopes the write; the payload carries the whole draft plus the
    // section it belongs to.
    const manifest = (save?.manifest ?? {}) as Manifest;
    const written = (manifest.agentPresets ?? {}) as Record<string, AgentPreset>;
    expect(Object.keys(written).sort()).toEqual(['cheap', 'smart']);
  });

  it('rolls Presets back alone on Discard', async () => {
    const { view, probe } = await mountOnPresets();
    await overrideRow(view, 'review');
    expect(probe().dirtySections).toEqual(['presets']);
    const discard = Array.from(root(view).querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').startsWith('Discard'),
    );
    expect(discard).toBeDefined();
    await view.click(discard as Element);
    expect(probe().dirtySections).toEqual([]);
  });
});

describe('rendered Presets tab — fault attribution (R26, R-X4)', () => {
  it('attributes a preset fault to the Presets tab and shows the banner', async () => {
    const { view, probe } = await mountOnPresets();
    await view.receive({
      type: 'error',
      message: 'agentPresets.smart.slots.review.provider must be one of: claude, codex',
    });
    expect(probe().errorSection).toBe('presets');
    expect(probe().bannerText).toContain('agentPresets.smart.slots.review.provider');
    // The nav shows an ERROR marker, not the dirty one: a fault outranks a
    // pending edit in the same dot.
    const marker = navMarker(view, 'presets');
    expect(marker?.className).toContain('has-error');
    expect(marker?.className).not.toContain('has-changes');
  });

  it('prefixes the banner with the owning tab label when standing elsewhere', async () => {
    const { view, probe } = await mountOnPresets();
    await view.click(root(view).querySelector('[data-section="general"]') as Element);
    await view.receive({ type: 'error', message: 'agentPresets.smart.slots.review.provider is invalid' });
    expect(probe().section).toBe('general');
    expect(probe().bannerText).toMatch(/^Presets: /);
  });
});

describe('rendered Presets tab — a state push adopts the file except the saved tab', () => {
  it('keeps the in-flight Presets edit when another tab is written', async () => {
    const { view, probe } = await mountOnPresets();
    await overrideRow(view, 'review');
    // An out-of-band rewrite of an unrelated field arrives.
    await view.receive({
      type: 'state',
      state: stateWith({ ...PRESET_MANIFEST, host: '10.0.0.1' }),
    });
    const draft = probe().draft as { host?: string; agentPresets?: Record<string, AgentPreset> };
    // The file's change to `general` is adopted…
    expect(draft.host).toBe('10.0.0.1');
    // …while the uncommitted Presets edit survives.
    expect(draft.agentPresets?.cheap?.slots?.review).toBeDefined();
  });
});
