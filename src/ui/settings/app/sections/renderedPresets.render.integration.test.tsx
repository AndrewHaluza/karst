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
 *
 * Since phase 4 the settings webview IS this React app (the injector chain
 * mounts it into `#root`), so the tests drive the chain-mounted instance
 * directly. The manually-mounted `AppProbe` that serialised reducer internals is
 * retired with the phase-3 helper; every fact is asserted through the rendered
 * DOM or the harness `posted` channel, mapping the probe reads like this:
 * - `dirtySections` → the nav buttons carrying `has-changes`;
 * - `section` → the `.nav-btn.active` marker's `data-section`;
 * - `errorSection` → the lone nav button carrying `has-error`;
 * - `bannerText` → the `.err-banner` text;
 * - `draft` → the rendered presets controls (the preset list, the matrix rows,
 *   the form's own fields) — and where a manifest-shape fact no control shows
 *   (a field owned by another tab), the payload of a save, which IS the whole
 *   draft;
 * - `bridge.last/all` → `view.last/all` (the harness `posted` array).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest, AgentPreset } from '../../../../manifest/types.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';

let open: RenderedSettings | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

interface Mounted {
  readonly view: RenderedSettings;
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
  const view = await renderSettingsApp();
  open = view;
  await view.receive({ type: 'state', state: stateWith(manifest) });
  await view.click(view.document.querySelector('[id="root"] [data-section="presets"]') as Element);
  return { view };
}

/** The React tree — since phase 4 the chain mounts the app into `#root`. */
function root(view: RenderedSettings): Element {
  const node = view.document.querySelector('[id="root"]');
  if (!node) throw new Error('#root is missing');
  return node;
}

/** The REACT tab, scoped by the mount marker `AppSections` emits. */
function tab(view: RenderedSettings): Element {
  const node = root(view).querySelector('[data-karst-settings-app="true"]');
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

/**
 * The dirty tabs, as the nav renders them — one `has-changes` marker per dirty
 * tab. This is the observable twin of the retired probe's `dirtySections`: the
 * marker is derived from the same reducer list (R26).
 */
function dirtySections(view: RenderedSettings): string[] {
  return [...root(view).querySelectorAll('.nav-btn[data-section]')]
    .filter((btn) => btn.classList.contains('has-changes'))
    .map((btn) => btn.getAttribute('data-section') ?? '');
}

/**
 * The faulted tab, as the nav renders it — the lone `has-error` marker. This is
 * the observable twin of the retired probe's `errorSection`.
 */
function errorSection(view: RenderedSettings): string | null {
  return root(view).querySelector('.nav-btn.has-error')?.getAttribute('data-section') ?? null;
}

/** The mode one capability row currently shows (`inherit` or `override`). */
function capMode(view: RenderedSettings, capability: string): string {
  const select = tab(view).querySelector(
    `[data-cap-row="${capability}"] .cap-mode select`,
  ) as HTMLSelectElement | null;
  return select?.value ?? '';
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
    const { view } = await mountOnPresets();
    // The tab defaults to the first name in sorted order.
    expect(tab(view).querySelector('.preset-card-compact.is-selected .preset-card-name')?.textContent).toBe('cheap');
    // A push that drops `cheap` must not leave the matrix pointed at a record
    // that no longer exists — the tab stays usable.
    await view.receive({
      type: 'state',
      state: stateWith({
        ...PRESET_MANIFEST,
        agentPresets: { smart: { slots: {} } } as Record<string, AgentPreset>,
      }),
    });
    expect(tab(view).querySelector('.preset-card-compact.is-selected .preset-card-name')?.textContent).toBe('smart');
    // `probe().draft` → the rendered preset list: the push dropped `cheap`, so
    // the draft's `agentPresets` map now names only the surviving preset.
    const names = Array.from(tab(view).querySelectorAll('.preset-card-compact .preset-card-name')).map(
      (n) => n.textContent ?? '',
    );
    expect(names).toEqual(['smart']);
  });
});

describe('rendered Presets tab — dirty marking (R26)', () => {
  it('marks the Presets tab dirty and no other tab, on a matrix edit', async () => {
    const { view } = await mountOnPresets();
    // `probe().dirtySections` → the nav buttons carrying `has-changes`.
    expect(dirtySections(view)).toEqual([]);
    await overrideRow(view, 'review');
    expect(dirtySections(view)).toEqual(['presets']);
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

  it('does not mark draft dirty simply by selecting different presets', async () => {
    const { view } = await mountOnPresets();
    await view.click(tab(view).querySelectorAll('.preset-card-compact')[0] as Element);
    const names = Array.from(tab(view).querySelectorAll('.preset-card-compact .preset-card-name')).map(
      (n) => n.textContent ?? '',
    );
    expect(names.sort()).toEqual(['cheap', 'smart']);
    expect(dirtySections(view)).toEqual([]);
  });
});

describe('rendered Presets tab — the tab-scoped Save (R11, R26)', () => {
  it('posts the whole draft with section: presets', async () => {
    const { view } = await mountOnPresets();
    await overrideRow(view, 'review');
    await view.click(saveButton(view));
    const save = view.last('save') as { manifest: Manifest } | undefined;
    expect(save).toMatchObject({ type: 'save', section: 'presets' });
    // The host scopes the write; the payload carries the whole draft plus the
    // section it belongs to.
    const written = (save?.manifest.agentPresets ?? {}) as Record<string, AgentPreset>;
    expect(Object.keys(written).sort()).toEqual(['cheap', 'smart']);
  });

  it('rolls Presets back alone on Discard', async () => {
    const { view } = await mountOnPresets();
    await overrideRow(view, 'review');
    // `probe().dirtySections` → the nav buttons carrying `has-changes`.
    expect(dirtySections(view)).toEqual(['presets']);
    const discard = Array.from(root(view).querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').startsWith('Discard'),
    );
    expect(discard).toBeDefined();
    await view.click(discard as Element);
    expect(dirtySections(view)).toEqual([]);
  });
});

describe('rendered Presets tab — fault attribution (R26, R-X4)', () => {
  it('attributes a preset fault to the Presets tab and shows the banner', async () => {
    const { view } = await mountOnPresets();
    await view.receive({
      type: 'error',
      message: 'agentPresets.smart.slots.review.provider must be one of: claude, codex',
    });
    // `probe().errorSection` → the nav button carrying `has-error`; `probe().
    // bannerText` → the `.err-banner` text.
    expect(errorSection(view)).toBe('presets');
    expect(root(view).querySelector('.err-banner')?.textContent).toContain(
      'agentPresets.smart.slots.review.provider',
    );
    // The nav shows an ERROR marker, not the dirty one: a fault outranks a
    // pending edit in the same dot.
    const marker = navMarker(view, 'presets');
    expect(marker?.className).toContain('has-error');
    expect(marker?.className).not.toContain('has-changes');
  });

  it('prefixes the banner with the owning tab label when standing elsewhere', async () => {
    const { view } = await mountOnPresets();
    await view.click(root(view).querySelector('[data-section="general"]') as Element);
    await view.receive({ type: 'error', message: 'agentPresets.smart.slots.review.provider is invalid' });
    // `probe().section` → the `.nav-btn.active` marker's `data-section`;
    // `probe().bannerText` → the `.err-banner` text.
    expect(root(view).querySelector('.nav-btn.active')?.getAttribute('data-section')).toBe('general');
    expect(root(view).querySelector('.err-banner')?.textContent).toMatch(/^Presets: /);
  });
});

describe('rendered Presets tab — a state push adopts the file except the saved tab', () => {
  it('keeps the in-flight Presets edit when another tab is written', async () => {
    const { view } = await mountOnPresets();
    await overrideRow(view, 'review');
    // An out-of-band rewrite of an unrelated field arrives.
    await view.receive({
      type: 'state',
      state: stateWith({ ...PRESET_MANIFEST, host: '10.0.0.1' }),
    });
    // `probe().draft.agentPresets` → the rendered matrix: the `review` row still
    // reads Override, so the uncommitted Presets edit survived the push.
    expect(capMode(view, 'review')).toBe('override');
    // `probe().draft.host` lives on a tab the single-tab mount does not render,
    // so the whole draft is read where it crosses the boundary: the payload of a
    // save, which adopts the file's `host` change AND carries the surviving edit
    // — the "everywhere except the saved tab" claim end to end.
    await view.click(saveButton(view));
    const save = view.last('save') as { manifest: Manifest } | undefined;
    // The file's change to `general` is adopted…
    expect(save?.manifest.host).toBe('10.0.0.1');
    // …while the uncommitted Presets edit survives.
    expect(save?.manifest.agentPresets?.cheap?.slots?.review).toBeDefined();
  });
});

describe('rendered Presets tab — foldable groups', () => {
  it('renders every group with its disclosure toggle expanded', async () => {
    const { view } = await mountOnPresets();
    const toggles = Array.from(
      root(view).querySelectorAll('.cap-group-toggle'),
    ) as HTMLButtonElement[];
    expect(toggles.length).toBeGreaterThan(0);
    for (const t of toggles) {
      expect(t.getAttribute('aria-expanded')).toBe('true');
    }
  });

  it('collapses a group via its toggle and re-expands it', async () => {
    const { view } = await mountOnPresets();
    const toggles = Array.from(
      root(view).querySelectorAll('.cap-group-toggle'),
    ) as HTMLButtonElement[];
    expect(toggles.length).toBeGreaterThan(0);
    const toggle = toggles[0]!;
    const bodyId = toggle.getAttribute('aria-controls')!;
    expect(root(view).querySelectorAll(`#${bodyId} [data-cap-row]`).length).toBeGreaterThan(0);
    await view.click(toggle);
    await view.settle();
    expect(view.document.querySelector(`#${bodyId}`)).toBeNull();
    await view.click(toggle);
    await view.settle();
    expect(view.document.querySelector(`#${bodyId}`)).not.toBeNull();
  });
});