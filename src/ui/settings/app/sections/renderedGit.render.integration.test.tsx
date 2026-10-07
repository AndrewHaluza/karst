/**
 * Rendered-Settings tests for the Git tab, through `renderWebviewReady`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `GitSection.test.tsx` prove per-component behaviour.
 * These prove the STATE-DEPENDENT rules the tab touches, in the real hydrated
 * document:
 *
 * - the dirty markers for a `conventions` edit, and the nav dot / off-screen
 *   hint when Git is the dirty tab (R26);
 * - the tab-scoped Save posts the whole draft with `section: 'git'`, and the
 *   host scopes the write — the payload is asserted, not the host's merge;
 * - an inline fault is attributed to the Git tab by `sectionForError`, so the
 *   nav marker shows an ERROR dot and the banner names it (R26, R-X4 — the
 *   attribution is derived, never recomputed per tab);
 * - a `state` push adopts the file everywhere EXCEPT the tab being saved, so a
 *   Git edit survives an out-of-band write to another tab;
 * - Discard rolls Git back alone.
 *
 * Since phase 4 the settings webview IS this React app (the injector chain
 * mounts it into `#root`), so the tests drive the chain-mounted instance
 * directly. The `AppProbe` that serialised reducer internals is retired; every
 * fact is asserted through the rendered DOM (nav markers, banners, the fields
 * themselves) or the harness `posted` channel:
 * - `dirtySections` → the nav buttons carrying `has-changes`;
 * - `section` → the `.nav-btn.active` `data-section`;
 * - `errorSection` → the lone nav button carrying `has-error`;
 * - `bannerText` → the `.err-banner` text;
 * - `draft` → the rendered field values (same reducer, read back out of the DOM);
 * - the `posted` array is the recording channel (`last`/`all`), replacing the
 *   recording bridge.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { FIXTURE_MANIFEST, FIXTURE_STATE_PUSH } from '../testFixtures.js';
import { renderSettingsApp, type RenderedSettings } from '../renderSettingsApp.js';
import { DEFAULT_PR_DESCRIPTION_TEMPLATE } from '../../../../workflow/conventionPresets.js';

let open: RenderedSettings | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

interface Mounted {
  readonly view: RenderedSettings;
}

/** Mount the app, push the file, then switch to Git the way a user would. */
async function mountOnGit(state = FIXTURE_STATE_PUSH): Promise<Mounted> {
  const view = await renderSettingsApp();
  open = view;
  await view.receive({ type: 'state', state });
  await view.click(view.document.querySelector('[id="root"] [data-section="git"]') as Element);
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

async function typeInto(
  view: RenderedSettings,
  label: string,
  value: string,
): Promise<HTMLInputElement> {
  const field = (await findField(view, label)) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  if (!setter) throw new Error(`no value setter on the control labelled ${label}`);
  setter.call(field, value);
  field.dispatchEvent(new (view.window.Event)('input', { bubbles: true }));
  field.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
  return field;
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

describe('rendered Settings — Git tab mounts into the real document', () => {
  it('renders the tab with no script errors', async () => {
    const { view } = await mountOnGit();
    expect(root(view).querySelector('[id="section-git"]')).not.toBeNull();
    expect(root(view).querySelector('.page-title')?.textContent).toBe('Git');
    expect(view.errors).toEqual([]);
  });

  it('marks the Git tab active and names it in the topbar', async () => {
    const { view } = await mountOnGit();
    // `probe().section` → the `.nav-btn.active` marker's `data-section`.
    expect(root(view).querySelector('.nav-btn.active')?.getAttribute('data-section')).toBe('git');
    expect(root(view).querySelector('.topbar-section')?.textContent).toBe('› Git');
  });

  it('pre-fills the default PR description, matching what ship would open with', async () => {
    const { view } = await mountOnGit();
    const field = await findField(view, 'Pull request description template');
    expect((field as HTMLTextAreaElement).value).toBe(DEFAULT_PR_DESCRIPTION_TEMPLATE);
  });
});

describe('rendered Settings — a conventions edit drives the dirty markers (R26)', () => {
  it('starts clean and lights every marker once a template changes', async () => {
    const { view } = await mountOnGit();
    expect(dirtySections(view)).toEqual([]);
    await typeInto(view, 'Branch name template', 'karst/{key}-{slug}');
    expect(dirtySections(view)).toEqual(['git']);
    expect(root(view).querySelector('.dirty-dot')?.classList.contains('hidden')).toBe(false);
    expect(root(view).querySelector('[data-section="git"]')?.classList.contains('has-changes')).toBe(
      true,
    );
    expect(saveButton(view).getAttribute('disabled')).toBeNull();
  });

  it('leaving a dirty tab commits or discards it, so nothing off screen is left unnamed', async () => {
    const { view } = await mountOnGit();
    await typeInto(view, 'Branch name template', 'karst/{key}-{slug}');
    // The unsaved-changes gate is why at most ONE tab is ever dirty through the
    // UI: leaving asks, and the answer is save or discard. The off-screen hint
    // exists for the paths that write a whole draft (the approach drawer), and
    // after the gate there is nothing for it to name.
    await leaveGate(view, 'git', 'general', {
      ...FIXTURE_MANIFEST,
      conventions: { branchName: 'karst/{key}-{slug}' },
    });
    expect(dirtySections(view)).toEqual([]);
    const hint = root(view).querySelector('.unsaved-hint');
    expect(hint?.classList.contains('hidden')).toBe(true);
    await typeInto(view, 'Host', '0.0.0.0');
    expect(dirtySections(view)).toEqual(['general']);
    expect(hint?.classList.contains('hidden')).toBe(true);
  });

  it('re-asks for validation of the tab now on screen when the tab switches', async () => {
    const { view } = await mountOnGit();
    await view.click(root(view).querySelector('[data-section="quality"]') as Element);
    const last = view.last('validate') as { manifest?: unknown } | undefined;
    expect(last).toBeDefined();
    expect(last?.manifest).toBeDefined();
  });
});

describe('rendered Settings — Git faults are attributed by the shared selector', () => {
  it('marks the Git nav item with an ERROR dot and names the tab in the banner', async () => {
    const { view } = await mountOnGit();
    await typeInto(view, 'Branch name template', 'karst/{key}-{slug}');
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: conventions.branchName must include {slug}, {key} or {id}',
    });
    // `probe().errorSection` → the nav button that carries `has-error`.
    expect(errorSection(view)).toBe('git');
    const gitNav = root(view).querySelector('[data-section="git"]');
    expect(gitNav?.classList.contains('has-error')).toBe(true);
    expect(gitNav?.classList.contains('has-changes')).toBe(false);
    expect(gitNav?.getAttribute('title')).toBe('Git has a validation error');
    // Standing ON the faulted tab, the banner is the message itself — no prefix.
    // (`probe().bannerText` → the `.err-banner` text.)
    expect(root(view).querySelector('.err-banner')?.textContent).toBe(
      'conventions.branchName must include {slug}, {key} or {id}',
    );
    expect(saveButton(view).getAttribute('disabled')).toBe('');
  });

  it('prefixes the banner with the owning tab when the fault is elsewhere', async () => {
    const { view } = await mountOnGit();
    await view.receive({
      type: 'validation',
      ok: false,
      error: 'Invalid karst.yml: portRange min exceeds max',
    });
    // The fault belongs to General; the user is on Git.
    expect(root(view).querySelector('.err-banner')?.textContent).toBe(
      'General: portRange min exceeds max',
    );
  });
});

describe('rendered Settings — tab-scoped Save for Git', () => {
  it('posts the whole draft with section "git"', async () => {
    const { view } = await mountOnGit();
    await typeInto(view, 'Branch name template', 'karst/{key}-{slug}');
    await view.click(saveButton(view));
    const save = view.last('save');
    expect(save).toMatchObject({ type: 'save', section: 'git' });
    const manifest = (save as { manifest: { conventions?: Record<string, unknown> } }).manifest;
    expect(manifest.conventions).toMatchObject({ branchName: 'karst/{key}-{slug}' });
  });

  it('keeps a Git edit alive across an unrelated out-of-band write', async () => {
    const { view } = await mountOnGit();
    await typeInto(view, 'Branch name template', 'karst/{key}-{slug}');
    // The host re-pushes after an out-of-band write (an agent toggle, an approach
    // install). Every dirty tab keeps its draft except the one being saved.
    await view.receive({ type: 'state', state: { ...FIXTURE_STATE_PUSH } });
    // `probe().draft.conventions.branchName` → the rendered input still shows
    // the edit: the tab's draft survives the push.
    const branch = await findField(view, 'Branch name template');
    expect((branch as HTMLInputElement).value).toBe('karst/{key}-{slug}');
    expect(dirtySections(view)).toEqual(['git']);
  });

  it('drops the saved tab from the drafts a push keeps, so it goes clean', async () => {
    const { view } = await mountOnGit();
    await typeInto(view, 'Branch name template', 'karst/{key}-{slug}');
    await view.click(saveButton(view));
    const written: Manifest = {
      ...FIXTURE_MANIFEST,
      conventions: { ...(FIXTURE_MANIFEST.conventions ?? {}), branchName: 'karst/{key}-{slug}' },
    };
    await view.receive({ type: 'state', state: { ...FIXTURE_STATE_PUSH, manifest: written } });
    await view.receive({ type: 'saved', section: 'git' });
    expect(dirtySections(view)).toEqual([]);
    expect(view.last('save')).toMatchObject({ section: 'git' });
  });

  it('rolls only the tab on screen back to the baseline on Discard', async () => {
    const { view } = await mountOnGit();
    await typeInto(view, 'Branch name template', 'karst/{key}-{slug}');
    await typeInto(view, 'Default ticket type', 'fix');
    expect(dirtySections(view)).toEqual(['git']);
    const discard = [...root(view).querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Discard'),
    ) as Element;
    await view.click(discard);
    // `probe().draft.conventions` is gone — the observable twin is that every
    // conventions control is back to its baseline (the file declares none).
    const branch = await findField(view, 'Branch name template');
    expect((branch as HTMLInputElement).value).toBe('');
    const ticketType = await findField(view, 'Default ticket type');
    expect((ticketType as HTMLSelectElement).value).toBe('');
    expect(dirtySections(view)).toEqual([]);
  });
});

/**
 * Walk the unsaved-changes gate from `from` to `to` by SAVING and waiting for
 * the ack. `written` is the file the host comes back with — the gate saves the
 * tab being LEFT, so the push has to carry that tab's committed fields, exactly
 * as the host's `mergeSection` would write them.
 */
async function leaveGate(
  view: RenderedSettings,
  from: string,
  to: string,
  written: Manifest,
): Promise<void> {
  await view.click(root(view).querySelector(`[data-section="${to}"]`) as Element);
  const label = `Save ${from[0]!.toUpperCase()}${from.slice(1)}`;
  const save = [...root(view).querySelectorAll('.modal-actions button')].find(
    (b) => b.textContent === label,
  ) as Element;
  if (!save) throw new Error(`the leave gate offered no "${label}"`);
  await view.click(save);
  await view.receive({ type: 'state', state: { ...FIXTURE_STATE_PUSH, manifest: written } });
  await view.receive({ type: 'saved', section: from as never });
}

/** The control whose `<label for>` reads exactly `label` (UI-R25 pairing). */
async function findField(view: RenderedSettings, label: string): Promise<Element> {
  const field = [...root(view).querySelectorAll('input, select, textarea')].find((el) => {
    const id = el.getAttribute('id');
    if (!id) return false;
    return view.document.querySelector(`label[for="${id}"]`)?.textContent?.trim() === label;
  });
  if (!field) throw new Error(`no control labelled ${label}`);
  return field;
}