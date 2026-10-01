/**
 * COMPONENT-mode tests for the Approaches tab (NDL-126 §9.5, phase 3 step 3).
 *
 * The load-bearing assertions are the ones that would write a file the host
 * REFUSES, or destroy an installed package:
 *
 * - **the delta against packaged built-ins (UI-R34)** — a never-touched built-in
 *   reduces to absence, a disable reduces to a tombstone that keeps
 *   `enabled:false`, and an edited built-in is an explicit override rather than a
 *   resurrected packaged body;
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { ApproachesSection } from './ApproachesSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { toApproachDeltas } from './approachDraft.js';

afterEach(cleanup);

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = () => {};
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).mountAgentPicker;
});

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
  act(() =>
    bridge.push({
      type: 'state',
      state: buildSettingsState(manifest, null, [...installedIds], true, ['claude'], [], {}, undefined, '/repo/karst.yml', undefined, undefined, PACKAGED),
    }),
  );
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
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function checkField(name: string, checked: boolean): void {
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`no drawer field ${name}`);
  fireEvent.click(el);
  expect(el.checked).toBe(checked);
}

describe('toApproachDeltas — the built-in delta rule (UI-R34)', () => {
  it('drops a never-touched built-in entirely', () => {
    const deltas = toApproachDeltas([{ id: 'review', label: 'Review' } as unknown as ApproachDef], PACKAGED);
    // Absent IS the packaged definition, so nothing is written.
    expect(deltas).toEqual([]);
  });

  it('keeps enabled:false on a disable tombstone', () => {
    const deltas = toApproachDeltas(
      [{ id: 'review', label: 'Review', enabled: false } as unknown as ApproachDef],
      PACKAGED,
    );
    // Dropping the flag would flip the built-in back on at the next load.
    expect(deltas).toEqual([{ id: 'review', label: 'Review', enabled: false }]);
  });

  it('writes only the differing fields of an edited built-in', () => {
    const deltas = toApproachDeltas(
      [{ id: 'tdd', label: 'TDD', description: 'Changed.', workflow: { artifact: 'packaged-tdd.md' } } as unknown as ApproachDef],
      PACKAGED,
    );
    expect(deltas).toEqual([
      { id: 'tdd', label: 'TDD', description: 'Changed.', enabled: true },
    ]);
  });

  it('passes a non-built-in entry through untouched', () => {
    const custom = { id: 'mine', label: 'Mine' } as unknown as ApproachDef;
    expect(toApproachDeltas([custom], PACKAGED)).toEqual([custom]);
  });

  it('keeps only the graph sub-blocks that differ', () => {
    const deltas = toApproachDeltas(
      [
        {
          id: 'tdd',
          label: 'Test-driven development',
          graph: { planner: { profile: 'expert' }, limits: { maxParallel: 2 } },
        } as unknown as ApproachDef,
      ],
      [{ ...PACKAGED[0]!, graph: { planner: { profile: 'expert' }, limits: { maxParallel: 4 } } } as unknown as ApproachDef],
    );
    // `planner` matches the packaged value, so only `limits` is written.
    expect((deltas[0] as { graph?: unknown }).graph).toEqual({ limits: { maxParallel: 2 } });
  });
});

describe('ApproachesSection — the roster', () => {
  it('groups by Installed / Available / Built-in', () => {
    mount();
    const headers = Array.from(document.querySelectorAll('.approach-group-header')).map((n) => n.textContent);
    // tdd is installed; remote is sourced and not installed; review is a
    // built-in that is not installed.
    expect(headers).toEqual(['Installed', 'Available', 'Built-in']);
  });

  it('omits a group with no members', () => {
    // Only an installed approach: Available and Built-in are both empty.
    mount({ ...BASE, approaches: [{ id: 'tdd', label: 'TDD' } as unknown as ApproachDef] }, ['tdd']);
    const headers = Array.from(document.querySelectorAll('.approach-group-header')).map((n) => n.textContent);
    expect(headers).toEqual(['Installed']);
  });

  it('renders the empty state when nothing is configured', () => {
    mount({ ...FIXTURE_MANIFEST, approaches: [] });
    expect(document.querySelector('.k-empty-title')?.textContent).toBe('No approaches configured.');
  });

  it('disables the enable toggle for a sourced but not-installed approach', () => {
    mount();
    const toggle = card('remote').querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-label')).toBe('Install to enable');
  });

  it('enables the toggle for an installed approach and writes an explicit boolean', () => {
    mount();
    const toggle = card('tdd').querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    // Absent means true on disk, so the write is explicit rather than a flip.
    expect(approaches().find((a) => a.id === 'tdd')?.enabled).toBe(false);
  });
});

describe('ApproachesSection — the drawer', () => {
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
    setField('af-sourceType', 'git');
    setField('af-gitRepo', 'https://example.test/r');
    fireEvent.click(screen.getByRole('button', { name: 'Add approach' }));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('at least one glob');
  });
});

describe('ApproachesSection — the destructive controls (UI-R10b)', () => {
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
    fireEvent.click(del);
    expect(approaches().find((a) => a.id === 'tdd')).toBeUndefined();
  });

  it('emits data-karst-action on the roster Uninstall control', () => {
    mount();
    const un = within(card('tdd')).getByRole('button', { name: 'Uninstall' });
    expect(un.getAttribute('data-karst-action')).toBe('uninstall-approach');
  });

  it('removes the entry from the draft when the delete is not blocked', () => {
    mount(BASE, ['review']);
    editApproach('tdd');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(approaches().some((a) => a.id === 'tdd')).toBe(false);
  });
});

describe('ApproachesSection — a state push closes the drawer', () => {
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
