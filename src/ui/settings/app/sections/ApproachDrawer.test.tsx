/**
 * COMPONENT-mode tests for the Approaches editor drawer.
 *
 * The load-bearing assertions are the ones that would write a file the host
 * REFUSES, or destroy an installed package:
 *
 * - **unrendered keys survive an edit** — `workflow` has no drawer control, so an
 *   edit must not silently drop it;
 * - **a cleared optional field is DELETED**, not blanked — `...existing` would
 *   otherwise resurrect the description the user just removed;
 * - **Delete is blocked while installed**, with the note the vanilla view shows;
 * - **recommended is exclusive** — promoting one demotes the rest, because the
 *   host refuses two;
 * - **a state push that removes the edited approach closes the drawer**, so the
 *   destructive control cannot outlive its subject.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { ApproachesSection } from './ApproachesSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';

afterEach(cleanup);

const PACKAGED: ApproachDef[] = [
  {
    id: 'tdd',
    label: 'Test-driven development',
    description: 'Write the test first.',
    workflow: { artifact: 'packaged-tdd.md' },
  } as unknown as ApproachDef,
  { id: 'review', label: 'Review' } as unknown as ApproachDef,
];

const BASE: Manifest = {
  ...FIXTURE_MANIFEST,
  approaches: [
    // An untouched built-in: identical to packaged.
    { id: 'review', label: 'Review' } as unknown as ApproachDef,
    // An edited built-in.
    { id: 'tdd', label: 'TDD', description: 'Changed.', workflow: { artifact: 'packaged-tdd.md' } } as unknown as ApproachDef,
    // A sourced, not-installed approach.
    {
      id: 'remote',
      label: 'Remote',
      source: { type: 'git', repo: 'https://example.test/a', ref: 'main', include: ['**'] },
    } as unknown as ApproachDef,
  ],
};

let probeRef: (() => AppProbeShape) | null = null;

/**
 * The host `state` push every component test uses, extracted so a test can
 * push the IDENTICAL state twice — which is what the island-survives-a-push
 * claim needs (a different fixture would rebuild the picker on content alone).
 */
function stateFor(manifest: Manifest, installedIds: readonly string[]) {
  return buildSettingsState(
    manifest,
    null,
    [...installedIds],
    true,
    ['claude'],
    [],
    {},
    undefined,
    '/repo/karst.yml',
    undefined,
    undefined,
    PACKAGED,
  );
}

function mount(
  manifest: Manifest = BASE,
  installedIds: readonly string[] = ['tdd'],
): { bridge: TestBridge; probe(): AppProbeShape } {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="approaches">
        <ApproachesSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state: stateFor(manifest, installedIds) }));
  const probe = (): AppProbeShape => readProbe(view.baseElement);
  probeRef = probe;
  return { bridge, probe };
}

/** The current mount's probe shape. */
function live(): AppProbeShape {
  if (!probeRef) throw new Error('mount() has not run in this test');
  return probeRef();
}

function approaches(): readonly ApproachDef[] {
  return (live().draft as { approaches?: ApproachDef[] }).approaches ?? [];
}

function card(id: string): HTMLElement {
  const node = document.querySelector(`[data-approach="${id}"]`);
  if (!node) throw new Error(`no card for ${id}`);
  return node as HTMLElement;
}

/** The roster's "+ Add approach" control — scoped to the page header so it is
 *  never confused with the drawer's own "Add approach" submit button. */
function addApproachControl(): HTMLElement {
  const node = document.querySelector('.page-actions button');
  if (!node) throw new Error('no "+ Add approach" control');
  return node as HTMLElement;
}

/** Open the drawer for one approach through its own Edit control. */
function editApproach(id: string): void {
  fireEvent.click(within(card(id)).getByRole('button', { name: 'Edit' }));
}

function within(node: HTMLElement) {
  return {
    getByRole: (role: string, opts: { name: string }) => {
      const found = Array.from(node.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === opts.name,
      );
      if (!found) throw new Error(`no ${role} named ${opts.name} in the card`);
      return found;
    },
  };
}

function setField(name: string, value: string): void {
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) throw new Error(`no drawer field ${name}`);
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error(`no value setter on ${name}`);
  setter.call(el, value);
  // act() flushes the draft commit, which Field schedules as a transition.
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function checkField(name: string, checked: boolean): void {
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`no drawer field ${name}`);
  fireEvent.click(el);
  expect(el.checked).toBe(checked);
}

describe('ApproachDrawer — the form', () => {
  it('makes the id read-only on edit', () => {
    mount();
    editApproach('tdd');
    const id = document.querySelector('[name="af-id"]') as HTMLInputElement;
    expect(id.readOnly).toBe(true);
    expect(id.value).toBe('tdd');
  });

  it('keeps an unrendered key (workflow) across an edit', () => {
    mount();
    editApproach('tdd');
    setField('af-label', 'TDD renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Save approach' }));
    const edited = approaches().find((a) => a.id === 'tdd');
    expect(edited?.label).toBe('TDD renamed');
    // `workflow` has no drawer control, so the edit must not drop it.
    expect(edited?.workflow).toEqual({ artifact: 'packaged-tdd.md' });
  });

  it('DELETES a cleared optional field rather than blanking it', () => {
    mount();
    editApproach('tdd');
    setField('af-description', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save approach' }));
    // `description` was 'Changed.' before the clear; `...existing` would
    // resurrect it.
    expect(approaches().find((a) => a.id === 'tdd')?.description).toBeUndefined();
  });

  it('demotes other approaches when one is promoted to recommended', () => {
    mount();
    editApproach('remote');
    checkField('af-recommended', true);
    fireEvent.click(screen.getByRole('button', { name: 'Save approach' }));
    const list = approaches();
    // The host refuses two recommended approaches, so an add that skipped the
    // demotion would produce a file it rejects.
    expect(list.filter((a) => a.recommended)).toHaveLength(1);
    expect(list.find((a) => a.id === 'remote')?.recommended).toBe(true);
  });

  it('refuses an unsafe id with the vanilla wording', () => {
    mount({ ...FIXTURE_MANIFEST, approaches: [] });
    fireEvent.click(addApproachControl());
    setField('af-id', '../escape');
    setField('af-label', 'Escape');
    fireEvent.click(screen.getByRole('button', { name: 'Add approach' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('absolute path');
    expect(approaches()).toHaveLength(0);
  });

  it('refuses a duplicate id on add', () => {
    const { bridge } = mount({ ...FIXTURE_MANIFEST, approaches: [] });
    fireEvent.click(addApproachControl());
    setField('af-id', 'dup');
    setField('af-label', 'First');
    fireEvent.click(screen.getByRole('button', { name: 'Add approach' }));
    // The first Save is IN FLIGHT: `useHostMutation` refuses a second trigger
    // while one is pending, which is R17 — so settle it the way the host does
    // before starting the next edit.
    const requestId = bridge.last('save')?.requestId;
    act(() => bridge.push({ type: 'action-result', requestId: requestId as string, ok: true }));
    // A successful receipt CLOSES the drawer (UI-R14b), so the next edit starts
    // from the roster's Add control.
    expect(document.querySelector('[name="af-id"]')).toBeNull();
    fireEvent.click(addApproachControl());
    expect(document.querySelector('[name="af-id"]')).not.toBeNull();
    setField('af-id', 'dup');
    setField('af-label', 'Second');
    fireEvent.click(screen.getByRole('button', { name: 'Add approach' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('already exists');
    expect(approaches()).toHaveLength(1);
  });

  it('requires at least one git include glob', () => {
    mount({ ...FIXTURE_MANIFEST, approaches: [] });
    fireEvent.click(addApproachControl());
    setField('af-id', 'gitsrc');
    setField('af-label', 'Git source');
    fireEvent.click(screen.getByRole('radio', { name: 'Git' }));
    setField('af-gitRepo', 'https://example.test/r');
    fireEvent.click(screen.getByRole('button', { name: 'Add approach' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('at least one glob');
  });
});

describe('ApproachDrawer — the destructive controls (UI-R10b)', () => {
  it('disables Delete and shows the note while the approach is installed', () => {
    mount();
    editApproach('tdd');
    const del = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.getAttribute('data-karst-action')).toBe('discard-approach');
    expect(document.body.textContent).toContain('Uninstall before deleting');
  });

  it('allows Delete once the approach is not installed', () => {
    mount(BASE, []);
    editApproach('tdd');
    const del = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
    // The row is shown, not merely present: `.hidden` is display:none !important.
    expect(del.closest('.drawer-delete-row')!.classList.contains('hidden')).toBe(false);
    fireEvent.click(del);
    expect(approaches().find((a) => a.id === 'tdd')).toBeUndefined();
  });

  it('emits data-karst-action on the roster Uninstall control', () => {
    mount(BASE, ['remote']);
    const un = within(card('remote')).getByRole('button', { name: 'Uninstall' });
    expect(un.getAttribute('data-karst-action')).toBe('uninstall-approach');
  });

  it('removes the entry from the draft when the delete is not blocked', () => {
    mount(BASE, ['review']);
    editApproach('tdd');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(approaches().some((a) => a.id === 'tdd')).toBe(false);
  });
});

describe('ApproachDrawer — the shell (spec Edit 6)', () => {
  function monoNames(): string[] {
    return Array.from(document.querySelectorAll('[data-region="approach-drawer"] .drawer-mono'))
      .map((n) => n.getAttribute('name') ?? '')
      .sort();
  }

  it('is a form drawer with groups, a footer and no graph parts', () => {
    mount();
    editApproach('tdd');
    const node = document.querySelector('[data-region="approach-drawer"]')!;
    expect(node.querySelector('.drawer-body.form')).not.toBeNull();
    expect(node.classList.contains('is-graph')).toBe(false);
    expect(node.querySelector('.drawer-jump')).toBeNull();
    expect(node.querySelector('.form-grid')).toBeNull();
    const groups = Array.from(node.querySelectorAll('.drawer-group-title')).map((n) => n.textContent);
    expect(groups).toEqual(['Identity', 'Source', 'Run']);
    const footer = Array.from(node.querySelectorAll('.drawer-actions button')).map((b) => b.textContent);
    expect(footer).toEqual(['Cancel', 'Save approach']);
    expect(node.querySelector('.drawer-danger-title')?.textContent).toBe('Delete approach');
  });

  it('puts the mono font only on the code fields', () => {
    mount();
    editApproach('tdd');
    expect(monoNames()).toEqual(['af-entrypoint', 'af-id']);
    fireEvent.click(screen.getByRole('radio', { name: 'Git' }));
    expect(monoNames()).toEqual(['af-entrypoint', 'af-gitInclude', 'af-gitRef', 'af-gitRepo', 'af-id']);
    fireEvent.click(screen.getByRole('radio', { name: 'npm' }));
    expect(monoNames()).toEqual(['af-entrypoint', 'af-id', 'af-npmCollect', 'af-npmCommand', 'af-npmPackage']);
  });

  it('shows the source type as a Local / Git / npm segmented control', () => {
    mount();
    editApproach('remote');
    const radios = screen.getAllByRole('radio').map((r) => [r.textContent, r.getAttribute('aria-checked')]);
    expect(radios).toEqual([
      ['Local', 'false'],
      ['Git', 'true'],
      ['npm', 'false'],
    ]);
    expect(document.querySelector('.drawer-pair [name="af-gitRepo"]')).not.toBeNull();
    expect(document.querySelector('.drawer-pair [name="af-gitRef"]')).not.toBeNull();
  });

  it('shows one visible Recommended label in the Run group', () => {
    mount();
    editApproach('tdd');
    const check = document.querySelector('.drawer-check')!;
    expect(check.querySelector('[name="af-recommended"]')).not.toBeNull();
    expect(check.querySelector('label')?.textContent).toBe('Recommended');
  });
});

describe('ApproachDrawer — behaves as a dialog', () => {
  function drawer(): HTMLElement | null {
    return document.querySelector('.drawer[role="dialog"]');
  }

  it('focuses the id field on add and the label field on edit', () => {
    mount();
    fireEvent.click(addApproachControl());
    expect(document.activeElement?.getAttribute('name')).toBe('af-id');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    editApproach('tdd');
    expect(document.activeElement?.getAttribute('name')).toBe('af-label');
  });

  it('Escape closes it', () => {
    mount();
    editApproach('tdd');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer()).toBeNull();
  });

  it('has a close control in its header', () => {
    mount();
    editApproach('tdd');
    fireEvent.click(drawer()!.querySelector<HTMLElement>('.drawer-head button[aria-label="Close"]')!);
    expect(drawer()).toBeNull();
  });

  it('keeps Tab inside the drawer', () => {
    mount();
    editApproach('tdd');
    const focusables = [...drawer()!.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea')];
    const last = focusables[focusables.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.keyDown(focusables[0]!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('ApproachDrawer — a state push closes the drawer', () => {
  it('closes when the edited approach is gone, so Delete cannot outlive it', () => {
    const bridge = createTestBridge();
    const view = render(
      <AnnouncerProvider>
        <SettingsAppProvider bridge={bridge} initialSection="approaches">
          <ApproachesSection />
          <AppProbe />
        </SettingsAppProvider>
      </AnnouncerProvider>,
    );
    const push = (manifest: Manifest, installed: readonly string[]) =>
      act(() =>
        void bridge.push({
          type: 'state',
          state: buildSettingsState(manifest, null, [...installed], true, ['claude'], [], {}, undefined, '/r/k.yml', undefined, undefined, PACKAGED),
        }),
      );
    push(BASE, ['tdd']);
    probeRef = () => readProbe(view.baseElement);
    editApproach('tdd');
    expect(document.querySelector('[name="af-id"]')).not.toBeNull();

    // A push that took the approach away must not leave the drawer — and its
    // destructive control — pointed at a record that no longer exists.
    push({ ...BASE, approaches: [{ id: 'review', label: 'Review' } as unknown as ApproachDef] }, ['review']);
    expect(document.querySelector('[name="af-id"]')).toBeNull();
  });
});
