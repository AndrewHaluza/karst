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
 *
 * Since phase 4 the settings webview IS this React app (the injector chain
 * mounts it into `#root`), so the tests drive the chain-mounted instance
 * directly. The manually-mounted `AppProbe` that serialised reducer internals is
 * retired with the phase-3 helper; every fact is asserted through the rendered
 * DOM or the harness `posted` channel, mapping the probe reads like this:
 * - `probe().section` → the `.nav-btn.active` marker's `data-section`;
 * - `probe().dirtySections` → the nav buttons carrying `has-changes`;
 * - `probe().errorSection` → the lone nav button carrying `has-error`;
 * - `uatOf(probe)` (`probe().draft.uat`) → the rendered Quality controls, and
 *   for the inert keys the tab never renders (env/secrets/origins) the payload
 *   of a save, which IS the whole draft;
 * - `bridge.last/all` → `view.last/all` (the harness `posted` array).
 */
// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest';
import type { Manifest, UatConfig } from '../../../../manifest/types.js';
import { runnableRepo } from '../../../../manifest/fixtures.js';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import {
  closeSettingsRealm,
  renderSettingsApp,
  type RenderedSettings,
} from '../renderSettingsApp.js';

// One jsdom realm per file, reset per mount (`renderSettingsApp`).
afterAll(() => {
  closeSettingsRealm();
});

interface Mounted {
  readonly view: RenderedSettings;
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

/** Mount the app, push the file, then switch to Quality the way a user would. */
async function mountOnQuality(manifest: Partial<Manifest> = {}): Promise<Mounted> {
  const view = await renderSettingsApp();
  await view.receive({
    type: 'state',
    state: {
      ...FIXTURE_STATE_PUSH,
      manifest: { ...FIXTURE_STATE_PUSH.manifest, ...manifest },
    },
  });
  await view.click(view.document.querySelector('[id="root"] [data-section="quality"]') as Element);
  return { view };
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

/** The control whose `<label for>` reads exactly `label` (UI-R25 pairing). */
function findLabelled(container: ParentNode, view: RenderedSettings, label: string): Element {
  const control = [...container.querySelectorAll('input, select, textarea')].find((el) => {
    const id = el.getAttribute('id');
    if (!id) return false;
    return view.document.querySelector(`label[for="${id}"]`)?.textContent?.trim() === label;
  });
  if (!control) throw new Error(`no control labelled ${label}`);
  return control;
}

/** The current value of the labelled control, as the DOM holds it. */
function controlValue(view: RenderedSettings, label: string): string {
  return (findLabelled(root(view), view, label) as HTMLInputElement).value;
}

/** The current value of a labelled control inside `container` (e.g. one
 *  override card's gate row, where a label is not unique in the whole tab). */
function controlValueIn(container: ParentNode, view: RenderedSettings, label: string): string {
  return (findLabelled(container, view, label) as HTMLInputElement).value;
}

/** The current `checked` of the labelled checkbox. */
function checkboxChecked(view: RenderedSettings, label: string): boolean {
  const id = findLabelled(root(view), view, label).getAttribute('id');
  const input = root(view).querySelector(`[id="${id}"]`) as HTMLInputElement;
  return input.checked;
}

/** One repository's override card, as the override editor renders it. */
function overrideCard(view: RenderedSettings, repo: string): Element {
  const card = [...root(view).querySelectorAll('.override-card')].find(
    (c) => c.querySelector('.override-repo')?.textContent === repo,
  );
  if (!card) throw new Error(`no override card for ${repo}`);
  return card;
}

async function setField(
  view: RenderedSettings,
  label: string,
  value: string,
): Promise<Element> {
  const control = findLabelled(root(view), view, label);
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
    const { view } = await mountOnQuality();
    // `probe().section` → the `.nav-btn.active` marker's `data-section`.
    expect(root(view).querySelector('.nav-btn.active')?.getAttribute('data-section')).toBe(
      'quality',
    );
    expect(root(view).querySelector('.topbar-section')?.textContent).toBe('› Quality');
  });
});

describe('rendered Settings — a Quality edit drives the dirty markers (R26)', () => {
  it('starts clean and marks the tab once a scalar changes', async () => {
    const { view } = await mountOnQuality();
    expect(dirtySections(view)).toEqual([]);
    await setField(view, 'Max fix attempts', '9');
    expect(dirtySections(view)).toEqual(['quality']);
    expect(root(view).querySelector('[data-section="quality"]')?.classList.contains('has-changes'))
      .toBe(true);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(false);
  });

  it('carries inert uat keys through the edit and the push that follows', async () => {
    const { view } = await mountOnQuality({
      uat: asUat({ ...INERT_UAT, maxFixAttempts: 3 }),
    });
    await setField(view, 'Max fix attempts', '9');
    // `uatOf(probe)` read `probe().draft.uat`, which the tab does not render
    // whole: it shows only the live-consumer keys. The faithful twins are the
    // rendered `maxFixAttempts` control, and — for the inert `env`/`secrets`/
    // `origins` keys, which no control shows — the payload of a save, which IS
    // the whole draft.
    expect(controlValue(view, 'Max fix attempts')).toBe('9');
    // An out-of-band write re-pushes the file; the dirty tab keeps its draft.
    await view.receive({ type: 'state', state: FIXTURE_STATE_PUSH });
    expect(controlValue(view, 'Max fix attempts')).toBe('9');
    expect(dirtySections(view)).toEqual(['quality']);
    // The saved manifest IS the draft, inert keys and all — how the block's
    // surviving shape (`maxFixAttempts` AND `secrets`) is observable end to end.
    await view.click(saveButton(view));
    const save = view.last('save') as { manifest: { uat?: UatConfig } } | undefined;
    expect(save?.manifest.uat).toMatchObject({
      maxFixAttempts: 9,
      secrets: INERT_UAT.secrets,
    });
  });
});

describe('rendered Settings — a Quality fault is attributed to the Quality tab', () => {
  it('marks the nav item with an ERROR dot and shows the message inline', async () => {
    const { view } = await mountOnQuality();
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: review.maxFixAttempts must be a positive integer',
    });
    // `sectionForError` has no `quality` branch in the vanilla script, so this is
    // the app's shared attribution and the first place it is observable.
    // `probe().errorSection` → the nav button carrying `has-error`.
    expect(errorSection(view)).toBe('quality');
    expect(root(view).querySelector('[data-section="quality"]')?.classList.contains('has-error'))
      .toBe(true);
    // `probe().bannerText` → the `.err-banner` text.
    expect(root(view).querySelector('.err-banner')?.textContent).toBe(
      'review.maxFixAttempts must be a positive integer',
    );
    expect(saveButton(view).getAttribute('disabled')).toBe('');
  });

  it('clears the attribution when the verdict turns positive', async () => {
    const { view } = await mountOnQuality();
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: uat.maxFixAttempts must be a positive integer',
    });
    expect(errorSection(view)).toBe('quality');
    await view.receive({ type: 'validation', ok: true, error: null });
    expect(errorSection(view)).toBeNull();
    expect(root(view).querySelector('.err-banner')).toBeNull();
  });
});

describe('rendered Settings — tab-scoped Save for Quality', () => {
  it('posts the whole draft with section "quality"', async () => {
    const { view } = await mountOnQuality();
    await setField(view, 'Max fix attempts', '9');
    await view.click(saveButton(view));
    const save = view.last('save');
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
    const { view } = await mountOnQuality();
    await setField(view, 'Max fix attempts', '9');
    await view.click(saveButton(view));
    await view.click(saveButton(view));
    expect(view.all('save')).toHaveLength(1);
  });

  it('goes clean once the push that follows the ack carries the written file', async () => {
    const { view } = await mountOnQuality();
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
    expect(dirtySections(view)).toEqual([]);
  });
});

describe('rendered Settings — the gate editor and overrides, end to end', () => {
  it('adds a gate, names it, and posts it with the rest of the draft', async () => {
    const { view } = await mountOnQuality({ repositories: REPOS });
    const add = root(view).querySelector('[data-karst-settings-app] button') as Element | null;
    expect(add).not.toBeNull();
    const addGate = [...root(view).querySelectorAll('button')].find(
      (b) => b.textContent === '+ Add gate',
    ) as Element;
    await view.click(addGate);
    await setField(view, 'Gate 1 name', 'build');
    // `uatOf(probe).gates` → the rendered gate row: the name input and the kind
    // select the tab shows for the added gate.
    expect(controlValue(view, 'Gate 1 name')).toBe('build');
    expect(controlValue(view, 'Gate 1 kind')).toBe('script');
    await view.click(saveButton(view));
    const save = view.last('save') as { manifest: { uat?: { gates?: unknown } } };
    expect(save.manifest.uat?.gates).toMatchObject([{ name: 'build', kind: 'script' }]);
  });

  it('offers an override seeded from the global list, and replaces rather than extends', async () => {
    const { view } = await mountOnQuality({ repositories: REPOS });
    const addGate = [...root(view).querySelectorAll('button')].find(
      (b) => b.textContent === '+ Add gate',
    ) as Element;
    await view.click(addGate);
    await setField(view, 'Gate 1 name', 'build');
    await setField(view, 'Repository to override', 'backend');
    // `uatOf(probe).repositories.backend.gates` → the override card's rendered
    // gate row; `uatOf(probe).gates` → the global list's rendered row. Both show
    // the seeded copy, which is what "replaces rather than extends" means.
    expect(controlValueIn(overrideCard(view, 'backend'), view, 'Gate 1 name')).toBe('build');
    expect(controlValue(view, 'Gate 1 name')).toBe('build');
    // And the tab says so in the copy, beside the cards.
    expect(root(view).querySelector('.override-editor-note')?.textContent).toContain('replaces');
  });

  it('removes the whole override from its own control (UI-R10b)', async () => {
    const { view } = await mountOnQuality({
      repositories: REPOS,
      uat: asUat({ repositories: { backend: { gates: [] } } }),
    });
    const remove = root(view).querySelector('[data-karst-action="remove-override"]') as Element;
    expect(remove).not.toBeNull();
    await view.click(remove);
    // `uatOf(probe).repositories.backend` → the override card is gone: the tab
    // renders one card per override, so no card for backend IS the key being
    // dropped.
    expect(
      [...root(view).querySelectorAll('.override-card')].some(
        (card) => card.querySelector('.override-repo')?.textContent === 'backend',
      ),
    ).toBe(false);
  });

  it('toggles the tester row and hides its severity when off', async () => {
    const { view } = await mountOnQuality();
    expect(root(view).querySelector('[id="uatTesterOptions"]')).toBeNull();
    await clickControl(view, 'Tester observations');
    // `uatOf(probe).testerObservations` present ⇔ the toggle is checked; the
    // checkbox's `checked` state is the observable, and the severity row it
    // guards is asserted around it.
    expect(checkboxChecked(view, 'Tester observations')).toBe(true);
    expect(root(view).querySelector('[id="uatTesterOptions"]')).not.toBeNull();
    await clickControl(view, 'Tester observations');
    expect(checkboxChecked(view, 'Tester observations')).toBe(false);
    expect(root(view).querySelector('[id="uatTesterOptions"]')).toBeNull();
  });
});