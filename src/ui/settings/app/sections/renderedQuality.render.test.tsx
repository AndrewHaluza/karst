/**
 * Rendered-Settings tests for the Quality tab, through `renderWebviewReady`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `QualitySection.test.tsx` prove per-component
 * behaviour. These prove the STATE-DEPENDENT rules the tab touches, in the real
 * hydrated document:
 *
 * - a `uat` / `review` edit drives the Quality nav marker and the dirty dot (R26);
 * - tab-scoped Save posts the whole draft with `section: 'quality'`, so the
 *   host's `mergeSection` is what decides which keys reach the file;
 * - a Quality fault is attributed to the Quality tab, which the VANILLA script
 *   does not do (`sectionForError` there has no `quality` branch). The app's
 *   shared `diagnostics.ts` does, and this pins that divergence deliberately;
 * - the topbar Save enters pending on activation and settles on the domain ack;
 * - `qa`-style inert keys survive a push, because a `state` push adopts the file
 *   everywhere except the tab being saved.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest, UatConfig } from '../../../../manifest/types.js';
import { runnableRepo } from '../../../../manifest/fixtures.js';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
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
}

const REPOS: NonNullable<Manifest['repositories']> = {
  backend: runnableRepo({}),
  frontend: { ...runnableRepo({}), repoPath: '../frontend' },
};

/** Inert UAT keys the tab never renders: config a Quality edit must not lose. */
const INERT_UAT = {
  env: { BASE_URL: 'https://example.test' },
  secrets: ['STRIPE_KEY'],
  origins: ['https://api.stripe.com'],
};

async function mountOnQuality(manifest: Partial<Manifest> = {}): Promise<Mounted> {
  const bridge = createTestBridge();
  const view = await renderSettingsApp({ bridge });
  open = view;
  await view.receive({
    type: 'state',
    state: {
      ...FIXTURE_STATE_PUSH,
      manifest: { ...FIXTURE_STATE_PUSH.manifest, ...manifest },
    },
  });
  await view.click(view.document.querySelector('[id="root"] [data-section="quality"]') as Element);
  return {
    view,
    bridge,
    probe: () => {
      const node = view.document
        .querySelector('[id="root"]')
        ?.querySelector('[data-probe="app"]');
      if (!node) throw new Error('AppProbe is not mounted');
      return JSON.parse(node.getAttribute('data-state') ?? '{}') as AppProbeShape;
    },
  };
}

function root(view: RenderedSettings): Element {
  const node = view.document.querySelector('[id="root"]');
  if (!node) throw new Error('#root is missing');
  return node;
}

function saveButton(view: RenderedSettings): Element {
  const node = root(view).querySelector('button.k-btn--primary');
  if (!node) throw new Error('Save is not rendered');
  return node;
}

async function setField(
  view: RenderedSettings,
  label: string,
  value: string,
): Promise<Element> {
  const control = [...root(view).querySelectorAll('input, select, textarea')].find((el) => {
    const id = el.getAttribute('id');
    if (!id) return false;
    return view.document.querySelector(`label[for="${id}"]`)?.textContent?.trim() === label;
  });
  if (!control) throw new Error(`no control labelled ${label}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')?.set;
  if (!setter) throw new Error(`no value setter on the control labelled ${label}`);
  setter.call(control, value);
  control.dispatchEvent(new (view.window.Event)('input', { bubbles: true }));
  control.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
  return control;
}

async function clickControl(view: RenderedSettings, label: string): Promise<Element> {
  const control = [...root(view).querySelectorAll('input[type="checkbox"]')].find((el) => {
    const id = el.getAttribute('id');
    if (!id) return false;
    return view.document.querySelector(`label[for="${id}"]`)?.textContent?.trim() === label;
  });
  if (!control) throw new Error(`no checkbox labelled ${label}`);
  await view.click(control);
  return control;
}

/** A hand-edited / partially-defaulted block, which is what a draft carries. */
const asUat = (block: Record<string, unknown>): UatConfig =>
  block as unknown as UatConfig;

const uatOf = (probe: () => AppProbeShape): UatConfig =>
  (probe().draft as { uat?: UatConfig }).uat ?? ({} as UatConfig);

describe('rendered Settings — Quality tab mounts into the real document', () => {
  it('renders both policy panels and the gate mount, with no script errors', async () => {
    const { view } = await mountOnQuality();
    expect(root(view).querySelector('[id="section-quality"]')).not.toBeNull();
    expect(root(view).querySelector('.page-title')?.textContent).toBe('Quality');
    const titles = Array.from(root(view).querySelectorAll('.section-title')).map(
      (n) => n.textContent,
    );
    expect(titles).toContain('UAT policy');
    expect(titles).toContain('Review policy');
    // Findings is MERGED into the review panel, not a panel of its own.
    expect(titles).not.toContain('Findings');
    expect(view.errors).toEqual([]);
  });

  it('labels the Quality tab active and names it in the topbar', async () => {
    const { view, probe } = await mountOnQuality();
    expect(root(view).querySelector('.nav-btn.active')?.getAttribute('data-section')).toBe('quality');
    expect(root(view).querySelector('.topbar-section')?.textContent).toBe('› Quality');
    expect(probe().section).toBe('quality');
  });
});

describe('rendered Settings — a Quality edit drives the dirty markers (R26)', () => {
  it('starts clean and marks the tab once a scalar changes', async () => {
    const { view, probe } = await mountOnQuality();
    expect(probe().dirtySections).toEqual([]);
    await setField(view, 'Max fix attempts', '9');
    expect(probe().dirtySections).toEqual(['quality']);
    expect(root(view).querySelector('[data-section="quality"]')?.classList.contains('has-changes'))
      .toBe(true);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(false);
  });

  it('carries inert uat keys through the edit and the push that follows', async () => {
    const { view, probe } = await mountOnQuality({
      uat: asUat({ ...INERT_UAT, maxFixAttempts: 3 }),
    });
    await setField(view, 'Max fix attempts', '9');
    expect(uatOf(probe)).toMatchObject({ maxFixAttempts: 9, secrets: INERT_UAT.secrets });
    // An out-of-band write re-pushes the file; the dirty tab keeps its draft.
    await view.receive({ type: 'state', state: FIXTURE_STATE_PUSH });
    expect(uatOf(probe)).toMatchObject({ maxFixAttempts: 9, secrets: INERT_UAT.secrets });
  });
});

describe('rendered Settings — a Quality fault is attributed to the Quality tab', () => {
  it('marks the nav item with an ERROR dot and shows the message inline', async () => {
    const { view, probe } = await mountOnQuality();
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: review.maxFixAttempts must be a positive integer',
    });
    // `sectionForError` has no `quality` branch in the vanilla script, so this is
    // the app's shared attribution and the first place it is observable.
    expect(probe().errorSection).toBe('quality');
    expect(root(view).querySelector('[data-section="quality"]')?.classList.contains('has-error'))
      .toBe(true);
    expect(root(view).querySelector('.err-banner')?.textContent).toBe(
      'review.maxFixAttempts must be a positive integer',
    );
    expect(saveButton(view).getAttribute('disabled')).toBe('');
  });

  it('clears the attribution when the verdict turns positive', async () => {
    const { view, probe } = await mountOnQuality();
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: uat.maxFixAttempts must be a positive integer',
    });
    expect(probe().errorSection).toBe('quality');
    await view.receive({ type: 'validation', ok: true, error: null });
    expect(probe().errorSection).toBeNull();
    expect(root(view).querySelector('.err-banner')).toBeNull();
  });
});

describe('rendered Settings — tab-scoped Save for Quality', () => {
  it('posts the whole draft with section "quality"', async () => {
    const { view, bridge } = await mountOnQuality();
    await setField(view, 'Max fix attempts', '9');
    await view.click(saveButton(view));
    const save = bridge.last('save');
    expect(save).toMatchObject({ type: 'save', section: 'quality' });
    const manifest = (save as { manifest: { uat?: { maxFixAttempts?: number } } }).manifest;
    expect(manifest.uat?.maxFixAttempts).toBe(9);
  });

  it('enters pending on activation and settles on the domain ack (R11, R13, R15)', async () => {
    const { view } = await mountOnQuality();
    await setField(view, 'Max fix attempts', '9');
    await view.click(saveButton(view));
    expect(saveButton(view).getAttribute('aria-busy')).toBe('true');
    expect(root(view).querySelector('.save-state')?.textContent).toBe('Saving…');
    await view.receive({ type: 'saved', section: 'quality' });
    expect(saveButton(view).getAttribute('aria-busy')).toBeNull();
    expect(root(view).querySelector('.saved-msg')?.textContent).toBe('Quality saved');
    expect(root(view).querySelectorAll('.k-live-region')).toHaveLength(1);
  });

  it('drops a second activation while the save is in flight (R12)', async () => {
    const { view, bridge } = await mountOnQuality();
    await setField(view, 'Max fix attempts', '9');
    await view.click(saveButton(view));
    await view.click(saveButton(view));
    expect(bridge.all('save')).toHaveLength(1);
  });

  it('goes clean once the push that follows the ack carries the written file', async () => {
    const { view, probe } = await mountOnQuality();
    await setField(view, 'Max fix attempts', '9');
    await view.click(saveButton(view));
    await view.receive({
      type: 'state',
      state: {
        ...FIXTURE_STATE_PUSH,
        manifest: {
          ...FIXTURE_STATE_PUSH.manifest,
          uat: asUat({ ...INERT_UAT, maxFixAttempts: 9 }),
        },
      },
    });
    await view.receive({ type: 'saved', section: 'quality' });
    expect(probe().dirtySections).toEqual([]);
  });
});

describe('rendered Settings — the gate editor and overrides, end to end', () => {
  it('adds a gate, names it, and posts it with the rest of the draft', async () => {
    const { view, bridge, probe } = await mountOnQuality({ repositories: REPOS });
    const add = root(view).querySelector('[data-karst-settings-app] button') as Element | null;
    expect(add).not.toBeNull();
    const addGate = [...root(view).querySelectorAll('button')].find(
      (b) => b.textContent === '+ Add gate',
    ) as Element;
    await view.click(addGate);
    await setField(view, 'Gate 1 name', 'build');
    expect(uatOf(probe).gates).toMatchObject([{ name: 'build', kind: 'script' }]);
    await view.click(saveButton(view));
    const save = bridge.last('save') as { manifest: { uat?: { gates?: unknown } } };
    expect(save.manifest.uat?.gates).toMatchObject([{ name: 'build', kind: 'script' }]);
  });

  it('offers an override seeded from the global list, and replaces rather than extends', async () => {
    const { view, probe } = await mountOnQuality({ repositories: REPOS });
    const addGate = [...root(view).querySelectorAll('button')].find(
      (b) => b.textContent === '+ Add gate',
    ) as Element;
    await view.click(addGate);
    await setField(view, 'Gate 1 name', 'build');
    await setField(view, 'Repository to override', 'backend');
    expect(uatOf(probe).repositories?.backend?.gates).toMatchObject([{ name: 'build' }]);
    expect(uatOf(probe).gates).toMatchObject([{ name: 'build' }]);
    // And the tab says so in the copy, beside the cards.
    expect(root(view).querySelector('.override-editor-note')?.textContent).toContain('replaces');
  });

  it('removes the whole override from its own control (UI-R10b)', async () => {
    const { view, probe } = await mountOnQuality({
      repositories: REPOS,
      uat: asUat({ repositories: { backend: { gates: [] } } }),
    });
    const remove = root(view).querySelector('[data-karst-action="remove-override"]') as Element;
    expect(remove).not.toBeNull();
    await view.click(remove);
    expect(uatOf(probe).repositories?.backend).toBeUndefined();
  });

  it('toggles the tester row and hides its severity when off', async () => {
    const { view, probe } = await mountOnQuality();
    expect(root(view).querySelector('[id="uatTesterOptions"]')).toBeNull();
    await clickControl(view, 'Tester observations');
    expect(uatOf(probe).testerObservations).toBeDefined();
    expect(root(view).querySelector('[id="uatTesterOptions"]')).not.toBeNull();
    await clickControl(view, 'Tester observations');
    expect(uatOf(probe).testerObservations).toBeUndefined();
    expect(root(view).querySelector('[id="uatTesterOptions"]')).toBeNull();
  });
});
