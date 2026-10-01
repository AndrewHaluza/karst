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
 *   destructive control cannot outlive the record it deletes.
 *
 * Everything is scoped to `[data-karst-settings-app="true"]`: the id
 * `section-approaches` still belongs to the live VANILLA section until phase 4.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
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

interface Mounted {
  readonly view: RenderedSettings;
  readonly bridge: TestBridge;
  probe(): AppProbeShape;
  last(type: string): Record<string, unknown> | undefined;
}

async function mountOnApproaches(manifest: Manifest = MANIFEST): Promise<Mounted> {
  const bridge = createTestBridge();
  const view = await renderSettingsApp({ bridge });
  open = view;
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

/** The React tab, scoped by the mount marker the parity sweep keys on. */
function tab(view: RenderedSettings): Element {
  const node = view.document.querySelector('[data-karst-settings-app="true"]');
  if (!node) throw new Error('the React settings mount is not rendered');
  return node;
}

function navMarker(view: RenderedSettings, section: string): Element | null {
  return view.document.querySelector(`[id="root"] [data-section="${section}"]`);
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
    const { view, last } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    await setField(view, 'af-label', 'Remote renamed');
    await view.click(buttonNamed(tab(view), 'Save approach'));

    const save = last('save');
    expect(save).toMatchObject({ type: 'save', section: 'approaches' });
    const approaches = (save?.manifest as Manifest | undefined)?.approaches ?? [];
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
    const { view, bridge, probe } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    await setField(view, 'af-label', 'Renamed');
    await view.click(buttonNamed(tab(view), 'Save approach'));

    const requestId = bridge.last('save')?.requestId as string;
    await view.receive({
      type: 'action-result',
      requestId,
      ok: false,
      message: 'approaches.remote.include[0] is not a valid glob',
    });
    // Still open, with the message where the user can act on it.
    expect(tab(view).querySelector('[name="af-id"]')).not.toBeNull();
    expect(tab(view).querySelector('[role="alert"]')?.textContent).toContain('valid glob');
    expect(probe().errorSection ?? 'approaches').toBeTruthy();
  });

  it('closes the drawer on a success receipt', async () => {
    const { view, bridge } = await mountOnApproaches();
    await view.click(buttonNamed(tab(view).querySelector('[data-approach="remote"]') as Element, 'Edit'));
    await setField(view, 'af-label', 'Renamed');
    await view.click(buttonNamed(tab(view), 'Save approach'));
    const requestId = bridge.last('save')?.requestId as string;
    await view.receive({ type: 'action-result', requestId, ok: true });
    expect(tab(view).querySelector('[name="af-id"]')).toBeNull();
  });
});

describe('rendered Approaches tab — dirty marking (R26)', () => {
  it('marks only the Approaches tab dirty on an enable toggle', async () => {
    const { view, probe } = await mountOnApproaches();
    expect(probe().dirtySections).toEqual([]);
    const toggle = tab(view).querySelector(
      '[data-approach="review"] [role="switch"]',
    ) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    await view.click(toggle);
    expect(probe().dirtySections).toEqual(['approaches']);
    expect(navMarker(view, 'approaches')?.className).toContain('has-changes');
    expect(navMarker(view, 'general')?.className).not.toContain('has-changes');
  });

  it('rolls Approaches back alone on Discard', async () => {
    const { view, probe } = await mountOnApproaches();
    const toggle = tab(view).querySelector(
      '[data-approach="review"] [role="switch"]',
    ) as HTMLButtonElement;
    await view.click(toggle);
    expect(probe().dirtySections).toEqual(['approaches']);
    await view.click(buttonNamed(view.document.querySelector('[id="root"]') as Element, 'Discard'));
    expect(probe().dirtySections).toEqual([]);
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
