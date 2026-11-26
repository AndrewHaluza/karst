/**
 * COMPONENT-mode tests for one Approaches roster card.
 *
 * The load-bearing assertions are the ones that would write a file the host
 * REFUSES, or destroy an installed package:
 *
 * - **the enable toggle is DEAD for a sourced-but-not-installed approach**,
 *   because there is nothing to enable until it is installed;
 * - **Install / Uninstall go through the shared receipt pattern** (UI-R11) and
 *   keep their per-row busy and error state;
 * - **Delete is blocked while installed** — pinned in `ApproachDrawer.test.tsx`.
 *
 * The graph agents, limits and planner prompt live in the Edit drawer
 * (`ApproachGraphDrawer.test.tsx`). The card shows only one summary line.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, within as rtlWithin } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('ApproachCard — the roster card', () => {
  it('shows the display name only, with the raw id on the title (SET-27)', () => {
    mount();
    const row = card('tdd');
    expect(row.querySelector('.approach-id')).toBeNull();
    expect(row.querySelector('.approach-label')?.textContent).toBe('TDD');
    expect(row.querySelector('.approach-head')?.getAttribute('title')).toBe('tdd');
    expect(row.textContent).not.toContain('tdd TDD');
  });

  it('names the switch by its aria-label and shows no visible "Enabled" text', () => {
    mount();
    const toggle = card('tdd').querySelector('[role="switch"]') as HTMLElement;
    expect(toggle.getAttribute('aria-label')).toBe('Enable in create flow');
    expect(card('tdd').textContent).not.toContain('Enabled');
  });

  it('shows no switch on an available card; its actions are Edit and a primary Install', () => {
    mount();
    const row = card('remote');
    expect(row.querySelector('[role="switch"]')).toBeNull();
    const names = Array.from(row.querySelectorAll('.approach-actions button')).map((b) => b.textContent?.trim());
    expect(names).toEqual(['Edit', 'Install']);
    const install = rtlWithin(row).getByRole('button', { name: 'Install' });
    expect(install.className).toContain('k-btn--primary');
  });

  it('shows the source as one chip: repo@ref for git, npm <pkg> for npm', () => {
    const npm = {
      id: 'pkg',
      label: 'Pkg',
      source: { type: 'npm', package: '@x/pkg', command: 'run', collect: [] },
    } as unknown as ApproachDef;
    mount({ ...BASE, approaches: [...BASE.approaches!, npm] });
    expect(card('remote').querySelector('.approach-source')?.textContent).toBe('https://example.test/a@main');
    expect(card('pkg').querySelector('.approach-source')?.textContent).toBe('npm @x/pkg');
    expect(card('tdd').querySelector('.approach-source')).toBeNull();
    expect(card('tdd').querySelector('.builtin-tag')?.textContent).toBe('Built-in');
  });

  it('shows no Install or Uninstall on a sourceless card, even when its id is installed', () => {
    mount(BASE, ['tdd', 'review']);
    for (const id of ['tdd', 'review']) {
      expect(rtlWithin(card(id)).queryByRole('button', { name: 'Uninstall' })).toBeNull();
      expect(rtlWithin(card(id)).queryByRole('button', { name: 'Install' })).toBeNull();
    }
  });

  it('clamps the description to 2 lines and offers More / Less when it overflows', () => {
    // jsdom has no layout: give every element a taller scroll height than client height.
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(80);
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    try {
      mount();
      const desc = card('tdd').querySelector('.approach-desc')!;
      expect(desc.classList.contains('is-clamped')).toBe(true);
      fireEvent.click(rtlWithin(card('tdd')).getByRole('button', { name: 'More' }));
      expect(card('tdd').querySelector('.approach-desc')!.classList.contains('is-clamped')).toBe(false);
      fireEvent.click(rtlWithin(card('tdd')).getByRole('button', { name: 'Less' }));
      expect(card('tdd').querySelector('.approach-desc')!.classList.contains('is-clamped')).toBe(true);
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it('shows no More button when the description fits', () => {
    mount();
    expect(rtlWithin(card('tdd')).queryByRole('button', { name: 'More' })).toBeNull();
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

// ---- The graph card: one summary line, no configuration surface ----

/** The graph approach the summary tests mount. */
const GRAPH_APPROACH = {
  id: 'karst-graph-engineering',
  label: 'Dynamic Graph',
  graph: {
    planner: { profile: 'expert' },
    profiles: {
      expert: { provider: 'claude', model: 'claude-opus-4-1' },
      worker: { provider: 'claude' },
    },
    limits: { maxParallel: 2, maxAgentWallSeconds: 9999 },
  },
} as unknown as ApproachDef;

describe('ApproachCard — the graph summary line', () => {
  it('has no graph configuration surface on the card', () => {
    mount({ ...FIXTURE_MANIFEST, approaches: [GRAPH_APPROACH] }, []);
    const row = card('karst-graph-engineering');
    expect(row.querySelector('[data-graph-config]')).toBeNull();
    expect(row.querySelector('.graph-config')).toBeNull();
    expect(row.querySelector('[data-gf-limit]')).toBeNull();
    expect(row.querySelector('[data-gf-profile-picker]')).toBeNull();
  });

  it('reads "<profile> <model>" per profile, then the changed-limit count in the warning class', () => {
    mount({ ...FIXTURE_MANIFEST, approaches: [GRAPH_APPROACH] }, []);
    const summary = card('karst-graph-engineering').querySelector('.graph-summary')!;
    expect(summary.textContent).toMatch(/^expert .+ · worker Agent default · 2 limits changed$/);
    expect(summary.querySelector('.graph-summary-changed')?.textContent).toBe(' · 2 limits changed');
  });

  it('counts only limits that differ from the default', () => {
    const one = {
      ...GRAPH_APPROACH,
      graph: { ...GRAPH_APPROACH.graph!, limits: { maxParallel: 4, maxReplans: 1 } },
    } as unknown as ApproachDef;
    mount({ ...FIXTURE_MANIFEST, approaches: [one] }, []);
    const summary = card('karst-graph-engineering').querySelector('.graph-summary')!;
    expect(summary.textContent).toContain('· 1 limit changed');
  });
});

describe('roster Install / Uninstall actions (UI-R11 receipt pattern)', () => {
  const SECOND: Manifest = {
    ...BASE,
    approaches: [
      ...(BASE.approaches ?? []),
      {
        id: 'other',
        label: 'Other',
        source: { type: 'git', repo: 'https://example.test/b', include: ['**'] },
      } as unknown as ApproachDef,
    ],
  };

  const btn = (id: string, name: string): HTMLButtonElement =>
    rtlWithin(card(id)).getByRole('button', { name }) as HTMLButtonElement;
  const settle = (bridge: TestBridge, type: 'install-approach' | 'uninstall-approach', ok: boolean, message?: string) =>
    act(() =>
      bridge.push({
        type: 'action-result',
        requestId: bridge.last(type)?.requestId as string,
        ok,
        ...(message ? { message } : {}),
      }),
    );

  it('Install posts install-approach for that row, goes busy, ignores a repeat click', () => {
    const { bridge } = mount(SECOND);
    fireEvent.click(btn('remote', 'Install'));
    fireEvent.click(btn('remote', 'Install'));
    expect(bridge.all('install-approach')).toHaveLength(1);
    expect(bridge.last('install-approach')).toMatchObject({ id: 'remote' });
    expect(bridge.last('install-approach')?.requestId).toBeTruthy();
    expect(btn('remote', 'Install').getAttribute('aria-busy')).toBe('true');
    // Only this row is busy.
    expect(btn('other', 'Install').getAttribute('aria-busy')).toBeNull();
  });

  it('Install failure shows the message on that row only and re-enables Install', () => {
    const { bridge } = mount(SECOND);
    fireEvent.click(btn('remote', 'Install'));
    settle(bridge, 'install-approach', false, 'GitHub returned 403');
    expect(rtlWithin(card('remote')).getByRole('alert').textContent).toContain('GitHub returned 403');
    expect(rtlWithin(card('other')).queryByRole('alert')).toBeNull();
    expect(btn('remote', 'Install').disabled).toBe(false);
    expect(btn('remote', 'Install').getAttribute('aria-busy')).toBeNull();
  });

  it('Install success leaves busy and, after the state push, offers Uninstall', () => {
    const { bridge } = mount(SECOND);
    fireEvent.click(btn('remote', 'Install'));
    settle(bridge, 'install-approach', true);
    act(() => bridge.push({ type: 'state', state: stateFor(SECOND, ['tdd', 'remote']) }));
    expect(btn('remote', 'Uninstall')).toBeTruthy();
    expect(rtlWithin(card('remote')).queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('Uninstall asks first: no request until confirmed; Cancel sends nothing', () => {
    const { bridge } = mount(SECOND, ['remote']);
    fireEvent.click(btn('remote', 'Uninstall'));
    expect(bridge.all('uninstall-approach')).toHaveLength(0);
    fireEvent.click(rtlWithin(card('remote')).getByRole('button', { name: 'Cancel' }));
    expect(bridge.all('uninstall-approach')).toHaveLength(0);
    expect(btn('remote', 'Uninstall')).toBeTruthy();
  });

  it('Uninstall confirm posts uninstall-approach, goes busy, ignores repeats', () => {
    const { bridge } = mount(SECOND, ['remote']);
    fireEvent.click(btn('remote', 'Uninstall'));
    const confirm = rtlWithin(card('remote')).getByRole('button', { name: 'Confirm uninstall' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(bridge.all('uninstall-approach')).toHaveLength(1);
    expect(bridge.last('uninstall-approach')).toMatchObject({ id: 'remote' });
    expect(rtlWithin(card('remote')).getByRole('button', { name: /Uninstall/ }).getAttribute('aria-busy')).toBe('true');
  });

  it('Uninstall failure shows the message on the row', () => {
    const { bridge } = mount(SECOND, ['remote']);
    fireEvent.click(btn('remote', 'Uninstall'));
    fireEvent.click(rtlWithin(card('remote')).getByRole('button', { name: 'Confirm uninstall' }));
    settle(bridge, 'uninstall-approach', false, 'cannot remove');
    expect(rtlWithin(card('remote')).getByRole('alert').textContent).toContain('cannot remove');
    expect(btn('remote', 'Uninstall').disabled).toBe(false);
  });

  it('Uninstall success then state push shows Install', () => {
    const { bridge } = mount(SECOND, ['remote']);
    fireEvent.click(btn('remote', 'Uninstall'));
    fireEvent.click(rtlWithin(card('remote')).getByRole('button', { name: 'Confirm uninstall' }));
    settle(bridge, 'uninstall-approach', true);
    act(() => bridge.push({ type: 'state', state: stateFor(SECOND, []) }));
    expect(btn('remote', 'Install')).toBeTruthy();
  });
});
