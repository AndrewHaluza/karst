/**
 * Rendered-Settings tests for the Approaches tab, through `renderSettingsApp`
 * (NDL-126 §9.5).
 *
 * The COMPONENT tests in `ApproachesSection.test.tsx` prove per-component
 * behaviour. These prove the STATE-DEPENDENT rules in the real hydrated document,
 * with the shell's nav and tab-scoped Save present:
 *
 * - a drawer Save posts `section: 'approaches'` and carries the DELTA against the
 *   packaged built-ins, not the effective list (UI-R34) — that payload is the
 *   thing the host merges, so it is asserted directly;
 * - a mutation is PENDING from the click, before any host result can arrive
 *   (UI-R11), and a failure receipt keeps the drawer open with the message
 *   inline (UI-R14b) instead of closing over an error nobody sees;
 * - an approach edit marks the Approaches tab dirty and nothing else (R26), and
 *   Discard rolls it back alone;
 * - a `state` push that removes the edited approach closes the drawer, so its
 *   destructive control cannot outlive the record it deletes;
 * - the graph prompt link posts `open-graph-prompt` through the pending-action
 *   runtime: one request with a correlation id from the click, nothing while
 *   pending, busy cleared by the host's `action-result` receipt (UI-R11/R12/R13).
 *
 * Since phase 4 the settings webview IS this React app (the injector chain
 * mounts it into `#root`), so the tests drive the chain-mounted instance
 * directly. The manually-mounted `AppProbe` that serialised reducer internals is
 * retired with the phase-3 helper; every fact is asserted through the rendered
 * DOM or the harness `posted` channel, mapping the probe reads like this:
 * - `dirtySections` → the nav buttons carrying `has-changes`;
 * - `section` → the `.nav-btn.active` marker's `data-section`;
 * - `errorSection` → the nav button carrying `has-error`, plus `.err-banner`;
 * - `bannerText` → the `.err-banner` text;
 * - the roster / drawer draft facts → the `[data-approach]` roster rows and the
 *   drawer's controls, and the manifest-shape delta a drawer Save posts → the
 *   payload of the last posted `save`;
 * - `bridge.last/all` → `view.last/all` (the harness `posted` array).
 */
// @vitest-environment jsdom
import { afterAll, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import {
  closeSettingsRealm,
  renderSettingsApp,
  type RenderedSettings,
} from '../renderSettingsApp.js';

// One jsdom realm per file, reset per mount (`renderSettingsApp`).
afterAll(() => {
  closeSettingsRealm();
});

/** The packaged built-ins the host ships, which the delta rule is measured against. */
const PACKAGED: ApproachDef[] = [
  { id: 'review', label: 'Review' } as unknown as ApproachDef,
];

const MANIFEST: Manifest = {
  ...FIXTURE_MANIFEST,
  approaches: [
    // Identical to packaged: the delta rule must make this ABSENT from the save.
    { id: 'review', label: 'Review' } as unknown as ApproachDef,
    {
      id: 'remote',
      label: 'Remote',
      source: { type: 'git', repo: 'https://example.test/a', ref: 'main', include: ['**'] },
    } as unknown as ApproachDef,
  ],
};

/**
 * A graph approach, so the card renders the graph configuration surface — and
 * with it the prompt link the R11 test drives. Mirrors the packaged built-in's
 * shape: planner prompt artifact, one profile, a limits block.
 */
const GRAPH_APPROACH = {
  id: 'karst-graph-engineering',
  label: 'Dynamic Graph',
  graph: {
    planner: { profile: 'expert', prompt: { artifact: 'prompts/graph-planner.md' } },
    profiles: { expert: { provider: 'claude', model: 'claude-sonnet' } },
    commands: {},
    limits: { maxParallel: 4 },
  },
} as unknown as ApproachDef;

const GRAPH_MANIFEST: Manifest = {
  ...MANIFEST,
  approaches: [...(MANIFEST.approaches ?? []), GRAPH_APPROACH],
};

interface Mounted {
  readonly view: RenderedSettings;
}

async function mountOnApproaches(manifest: Manifest = MANIFEST): Promise<Mounted> {
  const view = await renderSettingsApp();
  await view.receive({
    type: 'state',
    state: buildSettingsState(
      manifest,
      null,
      // `review` is INSTALLED, so its enable toggle is live — the enable guard
      // deliberately disables the toggle on a sourced-but-not-installed
      // approach, which is covered in the component tests.
      ['review'],
      true,
      ['claude'],
      [],
      {},
      undefined,
      '/repo/karst.yml',
      undefined,
      undefined,
      PACKAGED,
    ),
  });
  await view.click(view.document.querySelector('[id="root"] [data-section="approaches"]') as Element);
  return { view };
}

/** The chain-mounted React tree — since phase 4 the app renders into `#root`. */
function root(view: RenderedSettings): Element {
  const node = view.document.querySelector('[id="root"]');
  if (!node) throw new Error('#root is missing');
  return node;
}

/** The Approaches section, scoped by the mount marker `AppSections` emits. */
function tab(view: RenderedSettings): Element {
  const node = root(view).querySelector('[data-karst-settings-app="true"]');
  if (!node) throw new Error('the React settings mount is not rendered');
  return node;
}

/** The nav button for one tab. The shell marks it with `has-changes` /
 *  `has-error` classes (and a title), not a data attribute — so the assertion
 *  reads the class the shell actually renders. */
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

function buttonNamed(root: ParentNode, label: string): HTMLElement {
  const node = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
  if (!node) throw new Error(`no button named ${label}`);
  return node as HTMLElement;
}

async function setField(view: RenderedSettings, name: string, value: string): Promise<void> {
  const field = tab(view).querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!field) throw new Error(`no drawer field ${name}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set;
  if (!setter) throw new Error(`no value setter on ${name}`);
  setter.call(field, value);
  field.dispatchEvent(new (view.window.Event)('input', { bubbles: true }));
  field.dispatchEvent(new (view.window.Event)('change', { bubbles: true }));
  await view.settle();
}

describe('rendered Approaches tab — the roster mounts', () => {
  it('renders the grouped roster inside the React mount', async () => {
    const { view } = await mountOnApproaches();
    const mine = tab(view);
    expect(mine.querySelectorAll('.approach-group-header').length).toBeGreaterThan(0);
    expect(mine.querySelector('[data-approach="remote"]')).not.toBeNull();
  });
});

describe('rendered Approaches tab — the drawer Save payload (UI-R34)', () => {
  it('posts section approaches with the packaged built-in reduced to absence', async () => {
    const { view } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    await setField(view, 'af-label', 'Remote renamed');
    await view.click(buttonNamed(tab(view), 'Save approach'));

    const save = view.last('save');
    expect(save).toMatchObject({ type: 'save', section: 'approaches' });
    const approaches = ((save as { manifest?: Manifest } | undefined)?.manifest)?.approaches ?? [];
    // `review` is identical to its packaged definition, so it must NOT be in the
    // payload — writing it would restate the built-in body in the project file.
    expect(approaches.map((a) => a.id)).toEqual(['remote']);
    expect(approaches[0]?.label).toBe('Remote renamed');
  });

  it('is pending from the click, before any host result (UI-R11)', async () => {
    const { view } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    await setField(view, 'af-label', 'Renamed');
    // The button is busy the instant it is activated — the hook owns the
    // pending window, not a local flag — and `aria-busy` is what announces it.
    await view.click(buttonNamed(tab(view), 'Save approach'));
    const busy = buttonNamed(tab(view), 'Save approach');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('rendered Approaches tab — a failure keeps the drawer open (UI-R14b)', () => {
  it('renders the host message inline instead of closing over it', async () => {
    const { view } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    await setField(view, 'af-label', 'Renamed');
    await view.click(buttonNamed(tab(view), 'Save approach'));

    const requestId = view.last('save')?.requestId as string;
    await view.receive({
      type: 'action-result',
      requestId,
      ok: false,
      message: 'approaches.remote.include[0] is not a valid glob',
    });
    // Still open, with the message where the user can act on it.
    expect(tab(view).querySelector('[name="af-id"]')).not.toBeNull();
    expect(tab(view).querySelector('[role="alert"]')?.textContent).toContain('valid glob');
    // `probe().errorSection` read the NAV attribution, which the app derives
    // only from `validation`/`error` faults. A DRAWER rejection is attributed
    // INLINE (UI-R14b) — the open drawer's own alert above — so it must not be
    // promoted to the nav `has-error` marker or the shell banner they drive.
    expect(root(view).querySelector('.nav-btn.has-error')).toBeNull();
    expect(root(view).querySelector('.err-banner')).toBeNull();
  });

  it('closes the drawer on a success receipt', async () => {
    const { view } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    await setField(view, 'af-label', 'Renamed');
    await view.click(buttonNamed(tab(view), 'Save approach'));
    const requestId = view.last('save')?.requestId as string;
    await view.receive({ type: 'action-result', requestId, ok: true });
    expect(tab(view).querySelector('[name="af-id"]')).toBeNull();
  });
});

describe('rendered Approaches tab — dirty marking (R26)', () => {
  it('marks only the Approaches tab dirty on an enable toggle', async () => {
    const { view } = await mountOnApproaches();
    // `probe().dirtySections` → the nav buttons carrying `has-changes`.
    expect(dirtySections(view)).toEqual([]);
    const toggle = tab(view).querySelector(
      '[data-approach="review"] [role="switch"]',
    ) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    await view.click(toggle);
    expect(dirtySections(view)).toEqual(['approaches']);
    expect(navMarker(view, 'approaches')?.className).toContain('has-changes');
    expect(navMarker(view, 'general')?.className).not.toContain('has-changes');
  });

  it('rolls Approaches back alone on Discard', async () => {
    const { view } = await mountOnApproaches();
    const toggle = tab(view).querySelector(
      '[data-approach="review"] [role="switch"]',
    ) as HTMLButtonElement;
    await view.click(toggle);
    // `probe().dirtySections` → the nav buttons carrying `has-changes`.
    expect(dirtySections(view)).toEqual(['approaches']);
    await view.click(buttonNamed(root(view), 'Discard'));
    expect(dirtySections(view)).toEqual([]);
  });
});

describe('rendered Approaches tab — a state push closes the drawer', () => {
  it('closes when the edited approach is gone from the push', async () => {
    const { view } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    expect(tab(view).querySelector('[name="af-id"]')).not.toBeNull();
    // The host rewrote the file without the approach.
    await view.receive({
      type: 'state',
      state: buildSettingsState(
        { ...MANIFEST, approaches: [{ id: 'review', label: 'Review' } as unknown as ApproachDef] },
        null,
        [],
        true,
        ['claude'],
        [],
        {},
        undefined,
        '/repo/karst.yml',
        undefined,
        undefined,
        PACKAGED,
      ),
    });
    expect(tab(view).querySelector('[name="af-id"]')).toBeNull();
  });
});
describe('rendered Approaches tab — the graph prompt link (UI-R11)', () => {
  it('every graph-config host-posting control goes through the pending action runtime (UI-R11)', async () => {
    const { view } = await mountOnApproaches(GRAPH_MANIFEST);
    const link = tab(view).querySelector('[data-open-graph-prompt="karst-graph-planner"]') as Element;
    expect(link).not.toBeNull();

    // Pending enters on the activation, and exactly ONE request — carrying the
    // correlation id the receipt will be filed under — reaches the host. The
    // link never posts bare: it goes through `useHostMutation`, the one owner
    // of async lifecycle (the React form of vanilla's `postAction`).
    await view.click(link);
    const posts = view.all('open-graph-prompt');
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post).toMatchObject({ type: 'open-graph-prompt', identity: 'karst-graph-planner' });
    expect(post.requestId).toBeTruthy();
    expect(link.getAttribute('aria-busy')).toBe('true');

    // A second activation while pending posts nothing (UI-R12): the hook's
    // in-flight guard refuses the trigger, so the effective operation is one.
    await view.click(link);
    expect(view.all('open-graph-prompt')).toHaveLength(1);

    // The host's action-result receipt is what leaves pending (UI-R13) — busy
    // clears from the receipt, not from a local timer or the round trip.
    await view.receive({ type: 'action-result', requestId: post.requestId as string, ok: true });
    expect(link.getAttribute('aria-busy')).toBeNull();
    expect(link.getAttribute('aria-disabled')).toBeNull();
  });
});
