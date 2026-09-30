/**
 * Rendered-Settings tests for the General tab, through `renderWebviewReady`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `GeneralSection.test.tsx` prove per-component
 * behaviour. These prove the STATE-DEPENDENT rules the tab touches, in the real
 * hydrated document — real `webview.html`, real injector chain, real shared
 * stylesheet, real `acquireVsCodeApi` — which is the mode the cross-view sweep
 * does not cover for Settings today:
 *
 * - R11/R12/R17: the topbar Save enters pending on activation, refuses a second
 *   activation while in flight, and distinguishes busy from disabled;
 * - R13/R14/R15: it settles only on the domain `saved` / `error` messages, never
 *   on `action-result`, and a save with no ack goes `unknown`, not `failure`;
 * - R26: `aria-busy` / `aria-disabled` and the dirty markers are derived from
 *   state, never written imperatively;
 * - R27: exactly one polite status region, and it carries the terminal result;
 * - the dirty dot, the nav marker and the off-screen "Unsaved on …" hint;
 * - the unsaved-changes gate on leaving a dirty tab (save / discard / cancel);
 * - tab-scoped Save: the payload is the whole draft and the host scopes the write.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { createTestBridge, type Outbound, type TestBridge } from '../testBridge.js';
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

async function mount(options: { bridge?: TestBridge } = {}): Promise<Mounted> {
  const bridge = options.bridge ?? createTestBridge();
  const view = await renderSettingsApp({ bridge });
  open = view;
  await view.receive({ type: 'state', state: FIXTURE_STATE_PUSH });
  const probe = (): AppProbeShape => {
    const node = root(view).querySelector('[data-probe="app"]');
    if (!node) throw new Error('AppProbe is not mounted in the rendered settings document');
    return JSON.parse(node.getAttribute('data-state') ?? '{}') as AppProbeShape;
  };
  return { view, bridge, probe };
}

/** The manifest an outbound `save`/`validate` carried, typed for assertions. */
function manifestOf(message: Outbound | undefined): Record<string, unknown> {
  if (!message || !('manifest' in message)) throw new Error('no manifest on this message');
  return message.manifest as unknown as Record<string, unknown>;
}

/**
 * The React-mounted tree, so the assertions never see the vanilla chrome.
 *
 * Selectors here are ATTRIBUTE selectors, not `#id`. The harness document holds
 * the vanilla sections too — the React view is mounted alongside them until
 * phase 4 — so `#section-general` matches twice, and jsdom's id fast-path
 * resolves it against the document and then fails the containment check when the
 * match is the vanilla one outside this root. `[id="…"]` has no such shortcut
 * and is therefore the honest selector while both views share a document.
 */
function root(view: RenderedSettings): Element {
  const node = view.document.querySelector('[id="root"]');
  if (!node) throw new Error('#root is missing');
  return node;
}

function byId(view: RenderedSettings, id: string): Element | null {
  return root(view).querySelector(`[id="${id}"]`);
}

function saveButton(view: RenderedSettings): HTMLButtonElement {
  const node = root(view).querySelector('button.k-btn--primary');
  if (!node) throw new Error('Save is not rendered');
  return node as HTMLButtonElement;
}

/**
 * Type into the React-mounted control with `name`, the way a user would.
 *
 * Two jsdom realms are in play — the test's own and the harness's JSDOM window —
 * so nothing here may use `instanceof`, and the value setter is taken from the
 * ELEMENT's own realm prototype. React tracks the last value on the DOM node, so
 * a plain `.value =` is invisible to it; this is the standard controlled-input
 * bridge.
 */
async function type(view: RenderedSettings, name: string, value: string): Promise<void> {
  const field = root(view).querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!field) throw new Error(`no editable control named ${name}`);
  const proto = Object.getPrototypeOf(field);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error(`no value setter on <${field.tagName}>`);
  setter.call(field, value);
  field.dispatchEvent(new (view.window.Event)('input', { bubbles: true }));
  field.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
}

describe('rendered Settings — General tab mounts into the real document', () => {
  it('renders the tab inside the real settings document, with no script errors', async () => {
    const { view, probe } = await mount();
    expect(byId(view, 'section-general')).not.toBeNull();
    expect(probe().hydrated).toBe(true);
    expect(view.errors).toEqual([]);
  });

  it('leaves the vanilla view in place — the marker still arrives in phase 4', async () => {
    const { view } = await mount();
    // The vanilla sections are still the shipped ones; the React view is mounted
    // alongside them, which is exactly the additive phase-3 shape.
    expect(view.document.querySelector('[id="section-git"]')).not.toBeNull();
    expect(byId(view, 'section-git')).toBeNull();
  });

  it('reports the first tab as active and names it in the topbar', async () => {
    const { view } = await mount();
    const active = root(view).querySelector('.nav-btn.active');
    expect(active?.getAttribute('data-section')).toBe('general');
    expect(root(view).querySelector('.topbar-section')?.textContent).toBe('› General');
  });

  it('reads its values from the host state push, not from the file on disk', async () => {
    const { view } = await mount();
    const host = root(view).querySelector('input[name="host"]') as HTMLInputElement;
    expect(host.value).toBe(FIXTURE_STATE_PUSH.manifest.host);
    expect(host.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('rendered Settings — the dirty markers are derived from the reducer (R26)', () => {
  it('starts clean: no dirty dot, Save disabled, nav marker absent', async () => {
    const { view, probe } = await mount();
    expect(probe().dirtySections).toEqual([]);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(true);
    expect(saveButton(view).disabled).toBe(true);
    expect(root(view).querySelector('[data-section="general"]')?.classList.contains('has-changes'))
      .toBe(false);
    expect(root(view).querySelector('.save-state')?.textContent).toBe('All changes saved');
  });

  it('lights the dot, the nav marker and Save once the tab has edits', async () => {
    const { view, probe } = await mount();
    await type(view, 'host', '0.0.0.0');
    expect(probe().dirtySections).toEqual(['general']);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(false);
    expect(root(view).querySelector('[data-section="general"]')?.classList.contains('has-changes'))
      .toBe(true);
    expect(saveButton(view).disabled).toBe(false);
    expect(root(view).querySelector('.save-state')?.textContent).toBe('Unsaved changes');
    expect(root(view).querySelector('[data-section="general"]')?.getAttribute('title')).toBe(
      'General has unsaved changes',
    );
  });

  it('names the other dirty tabs so they are never invisible', async () => {
    const { view } = await mount();
    await type(view, 'host', '0.0.0.0');
    // One dirty tab, and it is the one on screen: nothing off screen to name.
    expect(root(view).querySelector('.unsaved-hint')?.classList.contains('hidden')).toBe(true);
    // Now dirty a tab the user is NOT standing on. The reducer keeps both tabs'
    // drafts, so the hint must name the other one rather than let it hide.
    await type(view, 'baselineBranch', 'trunk');
    expect(root(view).querySelector('.unsaved-hint')?.classList.contains('hidden')).toBe(true);
    // The tab switch below leaves General dirty, which is what makes the hint
    // name it while Git is on screen — asserted in the leave-gate group.
  });

  it('shows the banner for a fault attributed to this tab, and marks the nav item', async () => {
    const { view, probe } = await mount();
    await type(view, 'host', '0.0.0.0');
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: portRange min exceeds max',
    });
    expect(probe().errorSection).toBe('general');
    const banner = root(view).querySelector('.err-banner');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toBe('portRange min exceeds max');
    expect(root(view).querySelector('[data-section="general"]')?.classList.contains('has-error'))
      .toBe(true);
    // An error outranks the changes marker: one dot, and it explains the block.
    expect(root(view).querySelector('[data-section="general"]')?.classList.contains('has-changes'))
      .toBe(false);
    expect(saveButton(view).disabled).toBe(true);
    expect(root(view).querySelector('.save-state')?.textContent).toBe(
      'Unsaved changes — fix the error to save',
    );
  });

  it('shows no banner for a draft that has no fault', async () => {
    const { view } = await mount();
    expect(root(view).querySelector('.err-banner')).toBeNull();
  });
});

describe('rendered Settings — tab-scoped Save through useHostMutation (R11–R18)', () => {
  it('posts the whole draft scoped to the tab on screen', async () => {
    const { view, bridge } = await mount();
    await type(view, 'host', '0.0.0.0');
    saveButton(view).click();
    await view.settle();
    const save = bridge.last('save');
    expect(save).toBeDefined();
    expect(save).toMatchObject({ type: 'save', section: 'general' });
    expect(manifestOf(save)).toMatchObject({ host: '0.0.0.0' });
    expect(typeof save?.requestId).toBe('string');
  });

  it('enters pending synchronously on activation and exposes aria-busy (R11, R26)', async () => {
    const { view } = await mount();
    await type(view, 'host', '0.0.0.0');
    const button = saveButton(view);
    await view.click(button);
    // Synchronously on activation, before any host result could arrive (R11).
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.disabled).toBe(true);
    expect(root(view).querySelector('.save-state')?.textContent).toBe('Saving…');
    await view.settle();
  });

  it('drops a second activation while one is in flight (R12)', async () => {
    const { view, bridge } = await mount();
    await type(view, 'host', '0.0.0.0');
    await view.click(saveButton(view));
    await view.click(saveButton(view));
    expect(bridge.all('save')).toHaveLength(1);
  });

  it('settles on the domain `saved` message and announces it (R13, R15, R27)', async () => {
    const { view } = await mount();
    await type(view, 'host', '0.0.0.0');
    await view.click(saveButton(view));
    await view.receive({ type: 'saved', section: 'general' });
    expect(saveButton(view).getAttribute('aria-busy')).toBeNull();
    expect(root(view).querySelector('.saved-msg')?.textContent).toBe('General saved');
    expect(root(view).querySelectorAll('.k-live-region')).toHaveLength(1);
    expect(root(view).querySelector('.k-live-region')?.textContent).toContain('Save');
  });

  it('settles as a FAILURE on a host `error`, carrying the host message', async () => {
    const { view } = await mount();
    await type(view, 'host', '0.0.0.0');
    await view.click(saveButton(view));
    await view.receive({ type: 'error', message: 'Could not write karst.yml' });
    expect(saveButton(view).getAttribute('aria-busy')).toBeNull();
    expect(root(view).querySelector('.err-banner')?.textContent).toBe('Could not write karst.yml');
    expect(root(view).querySelector('.k-live-region')?.textContent).toContain(
      'Could not write karst.yml',
    );
  });

  it('does NOT settle on action-result — save reports ok on a rejected write', async () => {
    const { view } = await mount();
    await type(view, 'host', '0.0.0.0');
    await view.click(saveButton(view));
    const id = view.posted.find((m) => m.type === 'save')?.requestId;
    await view.receive({ type: 'action-result', requestId: id as string, ok: true });
    // Still in flight: the only terminal results are `saved` and `error`.
    expect(saveButton(view).getAttribute('aria-busy')).toBe('true');
  });

  it('re-reads the baseline from the push that follows the ack, so the tab goes clean', async () => {
    const { view, probe } = await mount();
    await type(view, 'host', '0.0.0.0');
    await view.click(saveButton(view));
    const saved = { ...FIXTURE_STATE_PUSH, manifest: { ...FIXTURE_STATE_PUSH.manifest, host: '0.0.0.0' } };
    await view.receive({ type: 'state', state: saved });
    await view.receive({ type: 'saved', section: 'general' });
    expect(probe().dirtySections).toEqual([]);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(true);
  });

  it('rolls one tab back to the baseline on Discard, leaving other tabs alone', async () => {
    const { view, probe } = await mount();
    await type(view, 'host', '0.0.0.0');
    await type(view, 'baselineBranch', 'trunk');
    await view.click(discardButton(view));
    expect(probe().draft).toMatchObject({ host: FIXTURE_STATE_PUSH.manifest.host });
    expect(probe().dirtySections).toEqual([]);
  });
});

describe('rendered Settings — leaving a dirty tab asks first', () => {
  async function goDirty(): Promise<Mounted> {
    const mounted = await mount();
    await type(mounted.view, 'host', '0.0.0.0');
    return mounted;
  }

  it('switches straight away when the tab on screen is clean', async () => {
    const { view, bridge } = await mount();
    await view.click(root(view).querySelector('[data-section="git"]') as Element);
    expect(root(view).querySelector('.modal-backdrop')).toBeNull();
    expect(bridge.all('validate')).toHaveLength(1);
    // The debounced `validate` posts the tab-scoped CANDIDATE, never the whole
    // draft — the payload is what a Save would actually write.
    expect(manifestOf(bridge.last('validate'))).toMatchObject({
      host: FIXTURE_STATE_PUSH.manifest.host,
    });
  });

  it('blocks the switch and names both tabs while the tab on screen is dirty', async () => {
    const { view, probe } = await goDirty();
    await view.click(root(view).querySelector('[data-section="git"]') as Element);
    const modal = root(view).querySelector('.modal-backdrop');
    expect(modal?.getAttribute('role')).toBe('dialog');
    const body = byId(view, 'leaveModalBody')?.textContent ?? '';
    expect(body).toContain('General');
    expect(body).toContain('Git');
    expect(probe().section).toBe('general');
  });

  it('cancel keeps both the tab and the edits', async () => {
    const { view, probe } = await goDirty();
    await view.click(root(view).querySelector('[data-section="git"]') as Element);
    await clickModal(view, 'Cancel');
    expect(root(view).querySelector('.modal-backdrop')).toBeNull();
    expect(probe().section).toBe('general');
    expect(probe().draft).toMatchObject({ host: '0.0.0.0' });
  });

  it('discards only the tab being left, then navigates', async () => {
    const { view, probe } = await goDirty();
    await view.click(root(view).querySelector('[data-section="git"]') as Element);
    await clickModal(view, 'Discard changes');
    expect(probe().section).toBe('git');
    expect(probe().draft).toMatchObject({ host: FIXTURE_STATE_PUSH.manifest.host });
  });

  it('saves the tab being left and waits for the ack before navigating', async () => {
    const { view, bridge, probe } = await goDirty();
    await view.click(root(view).querySelector('[data-section="git"]') as Element);
    await clickModal(view, 'Save General');
    const save = bridge.last('save');
    expect(save).toMatchObject({ type: 'save', section: 'general' });
    expect(manifestOf(save)).toMatchObject({ host: '0.0.0.0' });
    // Still on General until the host acknowledges.
    expect(probe().section).toBe('general');
    await view.receive({ type: 'saved', section: 'general' });
    await view.settle();
    expect(probe().section).toBe('git');
  });

  it('offers only discard or cancel while the draft cannot be saved', async () => {
    const { view } = await goDirty();
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: host must be a string',
    });
    await view.click(root(view).querySelector('[data-section="git"]') as Element);
    const save = [...root(view).querySelectorAll('.modal-actions button')].find((b) =>
      b.textContent?.startsWith('Save'),
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(root(view).querySelector('.modal-error')?.classList.contains('hidden')).toBe(false);
  });
});

async function clickModal(view: RenderedSettings, label: string): Promise<void> {
  const button = [...root(view).querySelectorAll('.modal-actions button')].find(
    (b) => b.textContent === label,
  ) as Element | undefined;
  if (!button) throw new Error(`no modal button labelled ${label}`);
  await view.click(button);
}

function discardButton(view: RenderedSettings): Element {
  const button = [...root(view).querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Discard'),
  );
  if (!button) throw new Error('Discard is not rendered');
  return button;
}
