/**
 * COMPONENT-mode tests for the Approaches tab's page header and roster groups.
 *
 * These are the section-level claims: the page description, the
 * Installed / Available / Built-in grouping, the omitted empty group, the empty
 * state, and the built-in delta rule the drawer's Save writes against (UI-R34).
 *
 * The card's own tests live in `ApproachCard.test.tsx`; the drawer's in
 * `ApproachDrawer.test.tsx`.
 */
// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApproachDef, Manifest } from '../../../../manifest/types.js';
import { AnnouncerProvider } from '../primitives/LiveRegion.js';
import { SettingsAppProvider } from '../SettingsAppContext.js';
import { createTestBridge } from '../testBridge.js';
import { buildSettingsState } from '../../state.js';
import { FIXTURE_MANIFEST } from '../testFixtures.js';
import { ApproachesSection } from './ApproachesSection.js';
import { toApproachDeltas } from './approachDraft.js';

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
): { bridge: ReturnType<typeof createTestBridge> } {
  const bridge = createTestBridge();
  render(
    <AnnouncerProvider>
      <SettingsAppProvider bridge={bridge} initialSection="approaches">
        <ApproachesSection />
      </SettingsAppProvider>
    </AnnouncerProvider>,
  );
  act(() => bridge.push({ type: 'state', state: stateFor(manifest, installedIds) }));
  return { bridge };
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

describe('ApproachesSection — the page and groups', () => {
  it('describes the page by what the tab configures (SET-10)', () => {
    mount();
    expect(document.querySelector('.page-desc')?.textContent).toBe(
      'How Karst plans and runs a ticket.',
    );
  });

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
});
