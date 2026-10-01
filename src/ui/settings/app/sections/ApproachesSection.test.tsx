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
 *
 * The graph configuration surface is pinned the same way — the load-bearing
 * claims there are the ones that would write a budget or ceiling the host
 * refuses, or drift from the validator:
 *
 * - **the ceilings and defaults are the IMPORTED constants (R-X1/UI-R34)** —
 *   every rendered `data-ceiling` / `data-packaged` equals the `graphConfig.ts`
 *   export, and every ceiling key has a row, so no `.tsx` can restate a number
 *   the validator does not enforce;
 * - **a profile pick writes ONLY that profile**, spreading `graph`/`profiles`
 *   so the sibling profile and the `limits`/`commands`/`planner` blocks keep
 *   their references (spread-not-rebuild);
 * - **a limit edit touches one key of `limits`** — byte-identical elsewhere —
 *   and an emptied input DELETES the key (absence = packaged default at Save);
 * - **the shared picker mounts per profile row and survives a state push**
 *   (R-X3): it is a vanilla runtime inside an island React never reconciles.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import {
  DEFAULT_GRAPH_LIMITS,
  GRAPH_COMMAND_TIMEOUT_CEILING,
  GRAPH_HARD_CEILINGS,
} from '../../../../manifest/graphConfig.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import type { AgentPickerOptions } from '../hostBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { ApproachesSection } from './ApproachesSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';
import { toApproachDeltas } from './approachDraft.js';

afterEach(cleanup);

/**
 * The shared agent picker is an injected VANILLA runtime (R-X3). The stand-in
 * records EVERY mount with the profile row it landed in (the island re-mounts
 * whenever its value changes, so a test reads the LATEST entry per profile)
 * and writes one node it "owns" into the container React will never reconcile
 * children into — which is what lets the island test prove the DOM survives a
 * `state` push, and the profile-wiring test drive the runtime's own `onChange`.
 */
let pickerMounts: ReadonlyArray<{ readonly name: string; readonly opts: AgentPickerOptions }> = [];

beforeEach(() => {
  pickerMounts = [];
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (
    root: HTMLElement,
    opts: AgentPickerOptions,
  ) => {
    const row = root.closest('[data-gf-profile-picker]');
    pickerMounts = [
      ...pickerMounts,
      { name: row?.getAttribute('data-gf-profile-picker') ?? '', opts },
    ];
    if (root.childElementCount === 0) {
      const owned = document.createElement('span');
      owned.dataset.pickerOwned = 'true';
      root.appendChild(owned);
    }
  };
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

/** The graph approach the graph-surface tests mount — profiles, limits, planner. */
const GRAPH_ID = 'karst-graph-engineering';

const GRAPH_APPROACH = {
  id: GRAPH_ID,
  label: 'Dynamic Graph',
  graph: {
    planner: { profile: 'expert', prompt: { artifact: 'prompts/graph-planner.md' } },
    profiles: {
      expert: { provider: 'claude', model: 'claude-sonnet' },
      worker: { provider: 'claude', model: 'claude-sonnet' },
    },
    commands: {
      test: { command: 'npm', args: ['test'], cwd: 'repository', access: 'write', timeoutSeconds: 1800 },
    },
    limits: { maxParallel: 2, maxAgentWallSeconds: 9999 },
  },
} as unknown as ApproachDef;

const GRAPH_MANIFEST: Manifest = { ...FIXTURE_MANIFEST, approaches: [GRAPH_APPROACH] };

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

// ---- The graph configuration surface (vanilla's renderGraphConfig) ----

/** Mount the roster with ONLY the graph approach, so rows are unambiguous. */
function mountGraph(): { bridge: TestBridge; probe(): AppProbeShape } {
  return mount(GRAPH_MANIFEST, []);
}

/** The graph approach as the draft currently holds it. */
function graphApproach(): ApproachDef {
  const entry = approaches().find((a) => a.id === GRAPH_ID);
  if (!entry) throw new Error('the graph approach is missing from the draft');
  return entry;
}

/**
 * The LATEST mount options for one profile row — the island re-mounts whenever
 * its value changes, so a test that drives `onChange` must use the entry the
 * current render produced, not the one from mount time.
 */
function pickOptions(name: string): AgentPickerOptions {
  const matches = pickerMounts.filter((m) => m.name === name);
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`no agent picker mounted for profile ${name}`);
  return last.opts;
}

describe('ApproachesSection — the graph configuration surface', () => {
  it('renders a graph configuration surface inside the built-in approach card', () => {
    mountGraph();
    // The three markers the retired vanilla assertion read out of the script:
    // the per-card data hook, the Budgets subsection, and real limit rows.
    const surface = document.querySelector(`[data-graph-config="${GRAPH_ID}"]`);
    expect(surface).not.toBeNull();
    const titles = Array.from(surface!.querySelectorAll('.graph-subsection-title')).map(
      (node) => node.textContent,
    );
    expect(titles).toContain('Budgets');
    expect(titles).toContain('Execution profiles');
    expect(surface!.querySelectorAll('[data-gf-limit]').length).toBeGreaterThan(0);
    expect(surface!.querySelectorAll('[data-gf-profile-picker]').length).toBeGreaterThan(0);
    expect(surface!.querySelector('[data-open-graph-prompt="karst-graph-planner"]')).not.toBeNull();
  });

  it('shows the packaged default and hard ceiling beside every wall-time budget', () => {
    mountGraph();
    const rows = Array.from(document.querySelectorAll('[data-gf-limit]'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const field = row.getAttribute('data-gf-limit') as keyof typeof GRAPH_HARD_CEILINGS;
      // The data hooks vanilla put on the input itself ride the row that owns
      // it — the raw-input guard wins (architecture.test R07/R08), so the
      // control is a Field and the attributes are addressed through the input.
      const input = row.querySelector('input[type="number"]') as HTMLInputElement | null;
      expect(input, field).not.toBeNull();
      expect(row.getAttribute('data-packaged'), field).toBe(String(DEFAULT_GRAPH_LIMITS[field]));
      expect(row.getAttribute('data-ceiling'), field).toBe(String(GRAPH_HARD_CEILINGS[field]));
      // Accessible name: vanilla's aria-label, here the Field's for/id pairing —
      // same string, and `getByLabelText` resolves either spelling.
      const label = row.querySelector('label');
      expect(label, field).not.toBeNull();
      expect(label!.getAttribute('for'), field).toBe(input!.id);
      expect(screen.getByLabelText(label!.textContent ?? '')).toBe(input);
      // …and both VALUES are visible beside the input, as vanilla's hint did.
      expect(row.textContent, field).toContain(`packaged ${DEFAULT_GRAPH_LIMITS[field]}`);
      expect(row.textContent, field).toContain(`hard ceiling ${GRAPH_HARD_CEILINGS[field]}`);
    }
  });

  it('mirrors the host graph hard ceilings and command-timeout ceiling exactly (UI-R34)', () => {
    mountGraph();
    // R-X1: the rendered values ARE the imported constants — a ceiling
    // restated in a .tsx would drift from the validator that enforces it, so
    // the assertion compares the DOM against the graphConfig.ts exports.
    const rendered: string[] = [];
    for (const row of Array.from(document.querySelectorAll('[data-gf-limit]'))) {
      const field = row.getAttribute('data-gf-limit') as keyof typeof GRAPH_HARD_CEILINGS;
      rendered.push(field);
      expect(row.getAttribute('data-ceiling')).toBe(String(GRAPH_HARD_CEILINGS[field]));
      expect(row.getAttribute('data-packaged')).toBe(String(DEFAULT_GRAPH_LIMITS[field]));
    }
    // Every ceiling key has a row and nothing else does: the field list is the
    // ceilings' key set, not a hand-copied subset that could quietly drop one.
    expect([...rendered].sort()).toEqual([...(Object.keys(GRAPH_HARD_CEILINGS) as string[])].sort());
    // The command-timeout ceiling is the imported value too — scoped to its own
    // hint row, because maxAgentIdleSeconds' ceiling shares the literal 7200.
    const timeoutRow = Array.from(document.querySelectorAll('.graph-row')).find((row) =>
      row.textContent?.includes('Command timeout'),
    );
    expect(timeoutRow, 'the command-timeout hint row').toBeTruthy();
    expect(timeoutRow!.textContent).toContain(`hard ceiling ${GRAPH_COMMAND_TIMEOUT_CEILING}`);
    // It is a hint, not a limit row: the timeout is set per command.
    expect(timeoutRow!.hasAttribute('data-gf-limit')).toBe(false);
  });
});

describe('ApproachesSection — graph profile identity (R-X3)', () => {
  it('the shared identity picker mounts per graph execution profile', () => {
    const { bridge } = mountGraph();
    const pickers = document.querySelectorAll('[data-gf-profile-picker]');
    expect(pickers).toHaveLength(2);
    expect(new Set(pickerMounts.map((m) => m.name))).toEqual(new Set(['expert', 'worker']));
    for (const picker of pickers) {
      // Each row's island contains the DOM the vanilla runtime owns — React
      // never reconciles children into it.
      expect(picker.querySelector('[data-picker-owned="true"]')).not.toBeNull();
    }
    // A fresh state push re-renders the tab. The islands must survive it —
    // same DOM, no re-mount of the runtime (R-X3).
    const mountsBefore = pickerMounts.length;
    act(() => bridge.push({ type: 'state', state: stateFor(GRAPH_MANIFEST, []) }));
    expect(document.querySelectorAll('[data-picker-owned="true"]')).toHaveLength(2);
    expect(pickerMounts.length).toBe(mountsBefore);
  });

  it('writes a profile pick into that profile only, spreading the graph blocks', () => {
    mountGraph();
    const before = graphApproach();
    const limitsBefore = before.graph!.limits;
    const commandsBefore = before.graph!.commands;
    const plannerBefore = before.graph!.planner;
    // Drive the island's own onChange the way the vanilla runtime would when
    // the user picks — the card writes, the island only reports the identity.
    act(() => pickOptions('expert').onChange({ core: 'codex', model: 'gpt-5', effort: 'high' }));
    const after = graphApproach();
    expect(after.graph!.profiles.expert).toEqual({
      provider: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });
    // The sibling profile is untouched — same record, not a rebuilt map.
    expect(after.graph!.profiles.worker).toEqual({ provider: 'claude', model: 'claude-sonnet' });
    // Spread, not rebuild: the graph blocks the write does not own serialize
    // to the SAME BYTES as before — key order included, which is what a
    // rebuilt object would silently change. (The probe reads the store through
    // JSON, so byte equality over the rendered draft is the observable form of
    // the reference-identity rule.)
    expect(JSON.stringify(after.graph!.limits)).toBe(JSON.stringify(limitsBefore));
    expect(JSON.stringify(after.graph!.commands)).toBe(JSON.stringify(commandsBefore));
    expect(JSON.stringify(after.graph!.planner)).toBe(JSON.stringify(plannerBefore));
    // And the write marks this tab dirty, exactly like the enable toggle (R26).
    expect(live().dirtySections).toEqual(['approaches']);
  });
});

describe('ApproachesSection — graph limit writes', () => {
  it('writes one limit key by spread, leaving the other graph blocks byte-identical', () => {
    mountGraph();
    const before = graphApproach();
    const profilesBefore = before.graph!.profiles;
    const commandsBefore = before.graph!.commands;
    const plannerBefore = before.graph!.planner;
    setField('gf-limit-maxAgentIdleSeconds', '3000');
    const after = graphApproach();
    expect(after.graph!.limits.maxAgentIdleSeconds).toBe(3000);
    // Byte-identical for everything the row does not own: the untouched keys
    // keep their order, the untouched blocks keep their references.
    expect(JSON.stringify(after.graph!.limits)).toBe(
      JSON.stringify({ ...before.graph!.limits, maxAgentIdleSeconds: 3000 }),
    );
    expect(after.graph!.limits.maxParallel).toBe(2);
    expect(after.graph!.limits.maxAgentWallSeconds).toBe(9999);
    // Byte-identical for the blocks the row does not own — key order
    // included, which is what a rebuild would change (the probe reads the
    // store through JSON, so bytes are the observable identity here).
    expect(JSON.stringify(after.graph!.profiles)).toBe(JSON.stringify(profilesBefore));
    expect(JSON.stringify(after.graph!.commands)).toBe(JSON.stringify(commandsBefore));
    expect(JSON.stringify(after.graph!.planner)).toBe(JSON.stringify(plannerBefore));
    expect(live().dirtySections).toEqual(['approaches']);
  });

  it('deletes the limit key when the input is cleared, so absence is the packaged default', () => {
    mountGraph();
    expect(graphApproach().graph!.limits.maxAgentWallSeconds).toBe(9999);
    setField('gf-limit-maxAgentWallSeconds', '');
    const limits = graphApproach().graph!.limits;
    // An emptied input never writes 0 or "" — it REMOVES the override, and the
    // host falls back to the packaged default at Save (vanilla's rule).
    expect('maxAgentWallSeconds' in limits).toBe(false);
    // The sibling key survives the delete.
    expect(limits.maxParallel).toBe(2);
    // Typing the value back re-creates it through the same spread write.
    setField('gf-limit-maxAgentWallSeconds', '7200');
    expect(graphApproach().graph!.limits.maxAgentWallSeconds).toBe(7200);
  });
});
