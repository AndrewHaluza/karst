/**
 * COMPONENT-mode tests for the Agents tab (NDL-126 §9.5, phase 3 step 3).
 *
 * The load-bearing assertions:
 *
 * - **the roster is the HOST's pool, in the HOST's order** — file agents first,
 *   then approach agents grouped by `approachId`. The component derives no
 *   ordering and no identity (UI-R10c): a name is a name the host sent.
 * - **approach agents are read-only** — a switch and their owning approach, with
 *   no body editor and no Delete, because their prompt lives in the approach.
 * - **a saved profile the pool no longer offers stays VISIBLE** as its own option:
 *   silently dropping it would save an empty value away and quietly un-configure
 *   a working assignment.
 * - **the assignment rows SPREAD `processes`** — rebuilding the map from the
 *   rendered rows would drop a key the tab does not render, and the host's
 *   `mergeSection` deletes a field the incoming manifest no longer carries, so a
 *   rebuilt block silently deletes configuration (D1/D3).
 * - **a cleared optional value is DELETED**, not written as `''`.
 * - **the body editor is a local buffer** — typing must not write a file, and the
 *   Save is disabled until the buffer differs from the host's body.
 * - **the island's DOM survives a re-render** (R-X3).
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge, type TestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import type { SettingsAgentRow } from '../../state.js';
import type { SettingsProcessAssignmentView } from '../../processAssignmentViews.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { AgentsSection } from './AgentsSection.js';
import { AppProbe, readProbe, type AppProbeShape } from './AppProbe.js';

afterEach(cleanup);

/** The stand-in vanilla picker writes a node it owns and records its options. */
let pickerOptions: unknown[] = [];
let pickerCalls = 0;

beforeEach(() => {
  pickerOptions = [];
  pickerCalls = 0;
  (globalThis as unknown as Record<string, unknown>).mountAgentPicker = (
    root: HTMLElement,
    opts: unknown,
  ) => {
    pickerCalls += 1;
    pickerOptions.push(opts);
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

const AGENTS: SettingsAgentRow[] = [
  { name: 'review', source: 'file', enabled: true, body: 'review body' },
  { name: 'tdd-one', source: 'approach', approachId: 'tdd', enabled: true, body: null },
  { name: 'tdd-two', source: 'approach', approachId: 'tdd', enabled: false, body: null },
];

const VIEWS: SettingsProcessAssignmentView[] = [
  {
    key: 'review',
    roleLabel: 'Review findings',
    description: 'Runs after the review pass',
    state: 'ok',
    stateTone: 'note',
    stateMessage: '',
    invalidField: null,
    profileOptions: ['review', 'tdd-one'],
    effectiveProvider: 'claude',
    effectiveModel: 'claude-sonnet',
    profileHint: 'Default: Review Agent',
    coreHint: '',
    modelHint: '',
    effortHint: '',
  } as unknown as SettingsProcessAssignmentView,
  {
    key: 'uatTester',
    roleLabel: 'UAT Tester',
    description: 'Runs after required UAT gates pass',
    state: 'unknown-profile',
    stateTone: 'error',
    stateMessage: 'That agent profile no longer exists.',
    invalidField: 'agent',
    profileOptions: ['tdd-one'],
    effectiveProvider: null,
    effectiveModel: undefined,
    profileHint: '',
    coreHint: '',
    modelHint: '',
    effortHint: '',
  } as unknown as SettingsProcessAssignmentView,
];

const BASE: Manifest = {
  ...FIXTURE_MANIFEST,
  // `draft.agents` is the obsolete role/command shape; the ROSTER comes from the
  // host pool. Only the body is carried here.
  agents: { review: { body: 'review body' } } as unknown as Manifest['agents'],
  processes: {
    review: { agent: 'review', agentName: '', enabled: true, inertKeyKarstNeverRenders: 'keep me' },
    // A saved profile the pool no longer offers.
    uatTester: { agent: 'retired-profile', enabled: true },
  } as unknown as Manifest['processes'],
};

let probeRef: (() => AppProbeShape) | null = null;

function mount(manifest: Manifest = BASE, agents: readonly SettingsAgentRow[] = AGENTS): {
  bridge: TestBridge;
  probe(): AppProbeShape;
} {
  const bridge = createTestBridge();
  const view = render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="agents">
        <AgentsSection />
        <AppProbe />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() =>
    bridge.push({
      type: 'state',
      state: buildSettingsState(manifest, null, ['tdd'], true, ['claude'], [...agents], { tdd: ['karst-tdd'] }, undefined, '/repo/karst.yml'),
    }),
  );
  // The assignment views arrive in their OWN message, not on the `state` push.
  act(() => bridge.push({ type: 'process-assignment-views', rows: VIEWS }));
  const probe = (): AppProbeShape => readProbe(view.baseElement);
  probeRef = probe;
  return { bridge, probe };
}

function live(): AppProbeShape {
  if (!probeRef) throw new Error('mount() has not run in this test');
  return probeRef();
}

function processes(): Record<string, Record<string, unknown>> {
  return ((live().draft as { processes?: Record<string, Record<string, unknown>> }).processes ??
    {}) as Record<string, Record<string, unknown>>;
}

function setValue(name: string, value: string): void {
  const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
  if (!el) throw new Error(`no control named ${name}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (!setter) throw new Error(`no value setter on ${name}`);
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AgentsSection — the roster is the host pool, in host order', () => {
  it('renders every host row and names the owning approach for approach agents', () => {
    mount();
    expect(document.body.textContent).toContain('review');
    expect(document.body.textContent).toContain('tdd-one');
    // The approach id is shown, so a row's provenance is never guessed.
    expect(document.querySelector('.agent-appr-head .appr-id')?.textContent).toBe('tdd');
  });

  it('emits one group header per approach id', () => {
    mount();
    expect(document.querySelectorAll('.agent-appr-head')).toHaveLength(1);
  });

  it('shows the enabled count as the hero stat', () => {
    mount();
    expect(document.querySelector('.agent-hero .stat')?.textContent?.replace(/\s+/g, '')).toBe('2/3');
  });

  it('renders the empty state when the host pool is empty', () => {
    // The roster is the HOST pool, so an empty pool is what shows the empty
    // state — not an empty manifest.
    mount({ ...FIXTURE_MANIFEST }, []);
    expect(document.body.textContent).toContain('No agents yet');
  });
});

describe('AgentsSection — approach agents are read-only', () => {
  it('gives an approach row a switch but no body editor and no Delete', () => {
    mount();
    // Only the FILE agent carries a Delete, and there is exactly one.
    const deletes = screen.getAllByRole('button', { name: 'Delete' });
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.getAttribute('data-karst-action')).toBe('delete-agent');
    // Only the file agent has a body editor.
    expect(document.querySelector('[name="agent-body-review"]')).not.toBeNull();
    expect(document.querySelector('[name="agent-body-tdd-one"]')).toBeNull();
  });

  it('emits data-karst-action="delete-agent" on the file row', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('data-karst-action')).toBe(
      'delete-agent',
    );
  });

  it('removes the agent from the draft on Delete, and drops the key when last', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect((live().draft as { agents?: Record<string, unknown> }).agents).toBeUndefined();
  });
});

describe('AgentsSection — the body editor is a local buffer', () => {
  it('does not write the draft on typing, and disables Save until it differs', () => {
    mount();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    // Nothing typed: the buffer matches the host's body, so there is nothing to save.
    expect(save.disabled).toBe(true);
    setValue('agent-body-review', 'edited body');
    expect((live().draft as { agents?: Record<string, { body?: string }> }).agents?.review?.body).toBe(
      'review body',
    );
  });

  it('writes the body on Save', () => {
    mount();
    setValue('agent-body-review', 'edited body');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((live().draft as { agents?: Record<string, { body?: string }> }).agents?.review?.body).toBe(
      'edited body',
    );
  });
});

describe('AgentsSection — the assignment matrix', () => {
  it('renders a row per closed-vocabulary process key, with the host role label', () => {
    mount();
    expect(document.querySelectorAll('[data-proc-key]').length).toBeGreaterThan(0);
    // The label is the HOST's, never the manifest key.
    expect(document.body.textContent).toContain('Review findings');
    expect(document.body.textContent).toContain('UAT Tester');
  });

  it('keeps a saved profile the pool no longer offers visible', () => {
    mount();
    const select = document.querySelector('[name="proc-uatTester-profile"]') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    // Dropping it would save an empty value away and un-configure the row.
    expect(values).toContain('retired-profile');
    expect(values).toContain('tdd-one');
  });

  it('attaches the host state message to the control it is about (UI-R25)', () => {
    mount();
    // `invalidField: 'agent'` means the profile control is the invalid one.
    const field = document.querySelector('[name="proc-uatTester-profile"]');
    const shell = field?.closest('.k-field');
    expect(shell?.getAttribute('class')).toContain('k-field');
    expect(document.body.textContent).toContain('That agent profile no longer exists.');
  });

  it('SPREADS processes — an unrendered key survives an edit (D1/D3)', () => {
    mount();
    setValue('proc-review-name', 'Snapshot');
    // `inertKeyKarstNeverRenders` has no control, so a rebuilt map would drop it
    // and the host's mergeSection would delete the field from the file.
    expect(processes().review?.inertKeyKarstNeverRenders).toBe('keep me');
    expect(processes().review?.agentName).toBe('Snapshot');
  });

  it('DELETES a cleared optional value instead of writing an empty string', () => {
    mount();
    setValue('proc-review-name', 'Snapshot');
    setValue('proc-review-name', '');
    expect('agentName' in (processes().review ?? {})).toBe(false);
  });

  it('writes the display name through the assignment row, not the roster', () => {
    mount();
    setValue('proc-review-name', 'Snapshot');
    expect(processes().review?.agentName).toBe('Snapshot');
  });
});

describe('AgentsSection — the roster toggle writes the matching assignment row', () => {
  it('records an explicit boolean rather than flipping an absent field', () => {
    mount();
    const toggle = document.querySelector('[data-switch="agent-enabled-review"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    // Absent means true on disk, so the write is explicit.
    expect(processes().review?.enabled).toBe(false);
  });

  it('disables the toggle for an agent with no assignment row', () => {
    mount();
    // `tdd-one` is not a process key, so there is nowhere legal to record it.
    const toggle = document.querySelector('[data-switch="agent-enabled-tdd-one"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});

describe('AgentsSection — the island is opaque (R-X3)', () => {
  it('preserves the vanilla runtime DOM across a re-render', () => {
    const { bridge } = mount();
    expect(document.querySelector('[data-picker-owned="true"]')).not.toBeNull();
    const before = pickerCalls;
    // An unrelated state push must not tear down the pickers: React never
    // reconciles children into that container.
    act(() =>
      bridge.push({
        type: 'state',
        state: buildSettingsState(BASE, null, ['tdd'], true, ['claude'], AGENTS, { tdd: ['karst-tdd'] }, undefined, '/repo/karst.yml'),
      }),
    );
    expect(document.querySelector('[data-picker-owned="true"]')).not.toBeNull();
    expect(pickerCalls).toBe(before);
  });
});

describe('AgentsSection — the process matrix structure (v7 parity)', () => {
  it('emits the matrix head and UAT/Review/Ship group headers from the row renderer', () => {
    mount();
    const head = document.querySelector('.matrix-head');
    expect(head, 'matrix head').not.toBeNull();
    expect([...head!.children].map((child) => child.textContent)).toEqual([
      'Process',
      'Agent profile',
      'Agent',
      'State',
    ]);
    // PROCESS_KEYS order: uatTester, uatFix, review, reviewFix, prDescription,
    // ticketAnalysis — a group header precedes only the FIRST row of its group.
    const markers = [...document.querySelectorAll('.matrix-group, .proc-row')].map((el) =>
      el.classList.contains('matrix-group')
        ? `group:${el.textContent?.trim()}`
        : `row:${(el as HTMLElement).dataset.procKey}`,
    );
    expect(markers).toEqual([
      'group:UAT',
      'row:uatTester',
      'row:uatFix',
      'group:Review',
      'row:review',
      'row:reviewFix',
      'group:Ship',
      'row:prDescription',
      'row:ticketAnalysis',
    ]);
  });
});
