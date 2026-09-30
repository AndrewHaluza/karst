// @vitest-environment jsdom
/**
 * The Presets tab through the shared jsdom render harness (NDL-117 §5).
 *
 * `webview.test.ts` lifts single functions out of the page and asserts on what
 * they compute. This file answers the other question: what does the browser
 * show once the host's `state` arrives. The capability matrix, the bulk row and
 * the picker mount points are all BUILT at runtime from host-supplied facts
 * (UI-R31), so a static assertion on the HTML proves nothing about them.
 *
 * jsdom CSSOM limits apply (renderHarness.ts header): no var() resolution, no
 * layout, no paint — this file claims only UI-R09, R25, R31, R32, R36 as
 * rendered.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderWebview, type RenderHandle } from '../testing/renderHarness.js';
import { buildSettingsState } from './state.js';
import { PRESET_CAPABILITIES } from '../../manifest/types.js';
import type { AgentPreset, Manifest } from '../../manifest/types.js';
import {
  manifest as buildManifest,
  runnableRepo,
  review,
  slot,
  uat,
} from '../../manifest/fixtures.js';

/** One handle per test, closed in afterEach so a failure never leaks a window. */
let handle: RenderHandle | null = null;
afterEach(() => { handle?.close(); handle = null; });

const HOSTILE_NAME = '<img src=x onerror=alert(1)>';

function manifestWithPresets(extra: Record<string, AgentPreset> = {}): Manifest {
  const cheap: AgentPreset = {
    label: 'Cheap',
    slots: { uatTester: { provider: 'opencode', model: 'deepseek-v4-flash' } },
  };
  return buildManifest(
    { api: runnableRepo({ ports: [slot('port', 'PORT', 3000)] }, { repoPath: '../api', signals: [] }) },
    {
      host: 'localhost',
      portRange: [4000, 4999],
      baselineBranch: 'main',
      agentPresets: { cheap, smart: { slots: {} }, ...extra },
      activeAgentPreset: 'cheap',
      // The project default every Inherit row falls back to — without it the
      // host preview has nothing to name and a seeded Override would be empty.
      agentProvider: 'claude',
      defaultModel: 'claude-sonnet-5',
      uat: uat(),
      review: review(),
      agents: {},
      worktreePathDisplay: 'relative',
      ticketing: { provider: 'manual' },
      conventions: { branchName: 'karst/{slug}' },
    },
  );
}

/** Render the settings view, push state, open the Presets tab. */
function openPresets(manifest: Manifest = manifestWithPresets()): RenderHandle {
  const h = renderWebview('settings');
  handle = h;
  h.receive({ type: 'state', state: buildSettingsState(manifest) });
  h.click('.nav-btn[data-section="presets"]');
  expect(h.errors).toEqual([]);
  return h;
}

describe('Presets tab — render (§5)', () => {
  it('opens the section from its nav button and leaves General behind', () => {
    const h = openPresets();
    expect(h.query('#section-presets')!.classList.contains('hidden')).toBe(false);
    expect(h.query('#section-general')!.classList.contains('hidden')).toBe(true);
    expect(h.query('.nav-btn[data-section="presets"]')!.classList.contains('active')).toBe(true);
    // ONE surface: the General tab carries no preset control at all.
    expect(h.query('#section-general')!.querySelector('#agentPresetList')).toBeNull();
    expect(h.query('#section-general')!.querySelector('#f-defaultAgentPreset')).toBeNull();
    // …and no process row carries a preset dropdown (§5 pins capabilities).
    expect(h.document.querySelector('[data-proc-field="preset"]')).toBeNull();
  });

  it('renders the preset list with override counts and marks the active one', () => {
    const h = openPresets();
    const rows = h.queryAll('#agentPresetList .preset-row');
    expect(rows).toHaveLength(2);

    const byName = new Map(rows.map((r) => [
      r.querySelector('.preset-name')!.textContent,
      r.querySelector('.preset-meta')!.textContent,
    ]));
    expect(byName.get('cheap')).toBe(`Cheap · 1/${PRESET_CAPABILITIES.length} overridden · active`);
    expect(byName.get('smart')).toBe(`0/${PRESET_CAPABILITIES.length} overridden`);
    // Edit / Duplicate / Delete on every row.
    expect(h.queryAll('#agentPresetList [data-edit-preset]')).toHaveLength(2);
    expect(h.queryAll('#agentPresetList [data-duplicate-preset]')).toHaveLength(2);
    expect(h.queryAll('#agentPresetList [data-remove-preset]')).toHaveLength(2);

    // The selector carries the same selection as the active row.
    const select = h.query<HTMLSelectElement>('#f-activeAgentPreset')!;
    expect(select.value).toBe('cheap');
    expect(select.options[0]!.textContent).toContain('None');
  });

  it('builds the whole capability matrix from the host groups and labels (UI-R31)', () => {
    const h = openPresets();
    const groups = h.queryAll('#presetCapabilityTable .cap-group');
    expect(groups.map((g) => g.querySelector('.matrix-group')!.textContent))
      .toEqual(['Quality', 'Ticket', 'Graph roles']);
    expect(groups.map((g) => g.querySelectorAll('.cap-row').length)).toEqual([4, 3, 3]);

    const labels = h.queryAll('#presetCapabilityTable .cap-name').map((n) => n.textContent);
    // The names the Agents tab and the ticket form already use — never ids.
    expect(labels).toEqual([
      'UAT Tester', 'UAT Fix', 'Review', 'Review Fix',
      'PR description', 'Ticket analysis', 'Ticket implementation',
      'Expert', 'Worker', 'Fast',
    ]);
    // Row ids are the manifest's, keyed so a later write targets one row.
    expect(h.queryAll<HTMLElement>('#presetCapabilityTable [data-cap-row]')
      .map((r) => r.dataset.capRow))
      .toEqual([...PRESET_CAPABILITIES]);
  });

  it('shows Override + the mounted picker for a pinned row, and the host preview for an Inherit one', () => {
    const h = openPresets();
    const pinned = h.query('[data-cap-row="uatTester"]')!;
    expect(pinned.querySelector<HTMLSelectElement>('select[data-cap-mode]')!.value)
      .toBe('override');
    expect(pinned.querySelector('[data-cap-picker="uatTester"]')).not.toBeNull();

    const inheriting = h.query('[data-cap-row="review"]')!;
    expect(inheriting.querySelector<HTMLSelectElement>('select[data-cap-mode]')!.value)
      .toBe('inherit');
    expect(inheriting.querySelector('[data-cap-picker]')).toBeNull();
    // The preview is the HOST's fact (UI-R31) — joined with §5's wording here.
    const preview = inheriting.querySelector('.cap-inherited')!.textContent!;
    expect(preview.startsWith('Inherited: ')).toBe(true);
    expect(preview.length).toBeGreaterThan('Inherited: '.length);
  });

  it('switches an Inherit row to Override with a complete seeded slot', () => {
    const h = openPresets();
    const mode = h.query<HTMLSelectElement>('[data-cap-row="review"] select[data-cap-mode]')!;
    mode.value = 'override';
    mode.dispatchEvent(new h.window.Event('change', { bubbles: true }));

    // Every write re-renders the table, so the live element is a NEW select —
    // holding the old one would dispatch on a detached node and silently do
    // nothing.
    const row = h.query('[data-cap-row="review"]')!;
    expect(row.querySelector<HTMLSelectElement>('select[data-cap-mode]')!.value)
      .toBe('override');
    // A row must never open as `{ provider }` with no model — the host refuses
    // that at Save, and a control that opens broken is UI-R25 backwards.
    expect(row.querySelector('[data-cap-picker="review"]')).not.toBeNull();
    // The edit reached the draft: the nav button flags unsaved work.
    expect(h.query('.nav-btn[data-section="presets"]')!.classList.contains('has-changes'))
      .toBe(true);

    // …and back again drops the slot rather than blanking fields.
    const again = h.query<HTMLSelectElement>('[data-cap-row="review"] select[data-cap-mode]')!;
    expect(again).not.toBe(mode);
    again.value = 'inherit';
    again.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    const back = h.query('[data-cap-row="review"]')!;
    expect(back.querySelector('[data-cap-picker]')).toBeNull();
    expect(back.classList.contains('is-override')).toBe(false);
    // The draft is back to exactly what the file holds, so the tab is clean.
    expect(h.query('.nav-btn[data-section="presets"]')!.classList.contains('has-changes'))
      .toBe(false);
  });

  it('"Set all to…" pins every row, and "Inherit every row" clears them again', () => {
    const h = openPresets();
    h.query<HTMLSelectElement>('#f-setAllProvider')!.value = 'codex';
    h.query<HTMLSelectElement>('#f-setAllProvider')!.dispatchEvent(
      new h.window.Event('change', { bubbles: true }),
    );
    // Whatever the codex catalog offers first — the assertion is about the
    // WRITE, not about which model happens to be bundled.
    const model = h.query<HTMLSelectElement>('#f-setAllModel')!;
    expect(model.options.length).toBeGreaterThan(0);
    model.dispatchEvent(new h.window.Event('change', { bubbles: true }));

    h.click('#setAllOverrideBtn');
    expect(h.queryAll('#presetCapabilityTable .cap-row.is-override'))
      .toHaveLength(PRESET_CAPABILITIES.length);
    expect(h.queryAll('#presetCapabilityTable [data-cap-picker]'))
      .toHaveLength(PRESET_CAPABILITIES.length);

    h.click('#setAllInheritBtn');
    expect(h.queryAll('#presetCapabilityTable [data-cap-picker]')).toHaveLength(0);
    expect(h.queryAll('#presetCapabilityTable .cap-row.is-override')).toHaveLength(0);
  });

  it('deselects to the add affordance, then adds a preset as a new row', () => {
    const h = openPresets();
    // Opening the tab selects a preset so the matrix has something to show, and
    // Save then means "save THIS one under the name in the field" (rename). The
    // add flow is Cancel → "+ Add preset", and the table says so meanwhile.
    expect(h.query<HTMLButtonElement>('#savePresetBtn')!.textContent).toBe('Save preset');
    h.click('#cancelPresetBtn');
    expect(h.query('#presetCapabilityTable .preset-empty')!.textContent)
      .toContain('Select a preset above');
    expect(h.query<HTMLButtonElement>('#savePresetBtn')!.textContent).toBe('+ Add preset');

    h.query<HTMLInputElement>('#f-presetName')!.value = 'nightly';
    h.click('#savePresetBtn');

    expect(h.queryAll('#agentPresetList .preset-row')).toHaveLength(3);
    expect([...h.queryAll('#agentPresetList .preset-name')].map((n) => n.textContent))
      .toContain('nightly');
    // An ADD starts all-Inherit, and the tab is now dirty.
    expect(h.query('#presetCapabilityTable .cap-row.is-override')).toBeNull();
    expect(h.query('.nav-btn[data-section="presets"]')!.classList.contains('has-changes'))
      .toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('empties to the no-presets line once every preset goes', () => {
    const h = openPresets();
    // The active selector references `cheap`, and a referenced preset is
    // refused a delete rather than silently unlinked — clear it first, the way
    // an operator would.
    const active = h.query<HTMLSelectElement>('#f-activeAgentPreset')!;
    active.value = '';
    active.dispatchEvent(new h.window.Event('change', { bubbles: true }));

    // Re-query every time: a delete re-renders the list, so a held row is
    // detached from the document and its click would go nowhere.
    for (;;) {
      const row = h.query('#agentPresetList .preset-row');
      if (!row) break;
      row.querySelector<HTMLElement>('[data-remove-preset]')!.click();
    }
    expect(h.query('#agentPresetList .preset-empty')!.textContent).toContain('No presets yet.');
    expect(h.query('#presetCapabilityTable .preset-empty')!.textContent)
      .toContain('Select a preset above');
    expect(h.errors).toEqual([]);
  });

  it('renders a hostile preset name as text, never as markup (UI-R32)', () => {
    const h = openPresets(manifestWithPresets({ [HOSTILE_NAME]: { slots: {} } }));
    const list = h.query('#agentPresetList')!;
    // The name builds TEXT and attributes, never nodes: no element from the
    // string, and no handler attribute on anything the list did render.
    expect(list.querySelectorAll('img, script, iframe')).toHaveLength(0);
    for (const el of list.querySelectorAll('*')) {
      for (const attr of el.attributes) expect(attr.name).not.toMatch(/^on/i);
    }
    expect(list.textContent).toContain(HOSTILE_NAME);
    // The attribute round-trips to the SAME string, so the click handler later
    // reads one name, not a truncated `a` (the classic quote break-out).
    const edit = list.querySelector<HTMLElement>('[data-edit-preset]')!;
    expect(edit.dataset.editPreset).toBe(edit.closest('.preset-row')!
      .querySelector('.preset-name')!.textContent);
    // …and the same name round-trips through the selector as text.
    const options = [...h.query<HTMLSelectElement>('#f-activeAgentPreset')!.options]
      .map((o) => o.textContent);
    expect(options).toContain(HOSTILE_NAME);
  });

  it('gives every control in the tab an accessible name (UI-R25, R09)', () => {
    const h = openPresets(manifestWithPresets({ [HOSTILE_NAME]: { slots: {} } }));
    const section = h.query('#section-presets')!;
    const violations: string[] = [];
    for (const el of section.querySelectorAll<HTMLElement>('input, select, textarea, button')) {
      if (el.tagName === 'BUTTON') {
        if (el.textContent?.trim()) continue;
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) continue;
        violations.push(`button without text or aria: ${el.outerHTML.slice(0, 120)}`);
        continue;
      }
      const named =
        el.getAttribute('aria-label')
        || el.getAttribute('aria-labelledby')
        || (el.id && section.querySelector(`label[for="${el.id}"]`));
      if (!named) violations.push(`${el.tagName} without label: ${el.outerHTML.slice(0, 120)}`);
    }
    expect(violations).toEqual([]);

    // Both fault lines are live regions so a refusal is announced, not drawn.
    expect(section.querySelector('#presetFormError')!.getAttribute('role')).toBe('alert');
    expect(section.querySelector('#presetListError')!.getAttribute('role')).toBe('alert');
  });

  it('surfaces a refusal on its line and flags the control it is about (UI-R25)', () => {
    const h = openPresets();
    h.query<HTMLInputElement>('#f-presetName')!.value = '   ';
    h.click('#savePresetBtn');

    const line = h.query('#presetFormError')!;
    expect(line.textContent).toContain('must not be blank');
    expect(line.classList.contains('hidden')).toBe(false);
    expect(h.query<HTMLInputElement>('#f-presetName')!.getAttribute('aria-invalid')).toBe('true');
    // A refusal never reaches the draft.
    expect(h.queryAll('#agentPresetList .preset-row')).toHaveLength(2);
    expect(h.errors).toEqual([]);
  });
});
