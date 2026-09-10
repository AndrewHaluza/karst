import type { SidebarState, SidebarSections, TicketRow, SidebarPr } from './state.js';
import type { SidebarWorktree } from './state.js';
import type { TicketPeek } from './peek.js';
import type { FacetKey } from './facets.js';
import { FACETS } from './facets.js';
import type { Glyph } from '../../model/glyph.js';

/**
 * The checked-in render fixture corpus for the sidebar webview.
 *
 * Every fixture is built ONLY from production presentation shapes and is
 * pure data: no SQLite reads, no real worktrees. Ticket ids use the reserved
 * numeric band 900001–999999 (Key Decision 5). Paths and PR urls are
 * `fixture:`-prefixed. Counts is an exhaustive Record<FacetKey, number>.
 */

export type SidebarScenario =
  | 'empty'
  | 'all-sections'
  | 'done-facet'
  | 'archived-facet'
  | 'multi-facet'
  | 'filtered'
  | 'hostile';

export const SIDEBAR_SCENARIOS: readonly SidebarScenario[] = [
  'empty', 'all-sections', 'done-facet', 'archived-facet', 'multi-facet', 'filtered', 'hostile',
];

export interface SidebarRenderFixture {
  scenario: SidebarScenario;
  state: SidebarState;
}

const ALL_FACET_KEYS: FacetKey[] = FACETS.map((f) => f.key);

function fixtureCounts(overrides?: Partial<Record<FacetKey, number>>): Record<FacetKey, number> {
  const base: Record<FacetKey, number> = { all: 0, running: 0, input: 0, failed: 0, done: 0, archived: 0 };
  return { ...base, ...overrides };
}

const HOSTILE_LABEL = '<script>alert(1)</script>';
const HOSTILE_LONG = 'W'.repeat(300);

function fixturePeek(overrides?: Partial<TicketPeek>): TicketPeek {
  return { title: 'fixture:peek', detail: null, next: null, ...overrides };
}

function fixtureRow(index: number, overrides?: Partial<TicketRow>): TicketRow {
  return {
    kind: 'ticket',
    ticketId: 900001 + index,
    label: `FEAT-${100 + index}`,
    glyph: 'blue' as Glyph,
    description: `fixture:desc:${index}`,
    stageLabel: 'Implementing',
    stageClass: 'stg-impl',
    stageChip: 'impl',
    blocker: null,
    sessionAction: { kind: 'start', label: 'Start', detail: 'Start a new session' },
    lastActiveAt: null,
    model: null,
    archived: false,
    parentKey: null,
    collapsible: true as const,
    servers: [],
    worktrees: [],
    prs: [],
    isActive: false,
    peek: fixturePeek(),
    ...overrides,
  };
}

function emptyState(): SidebarState {
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts(),
    sections: { current: [], recentlyDone: [], olderDone: [] },
    done: [],
    rows: [],
  };
}

function allSectionsState(): SidebarState {
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts({ all: 5, running: 2, input: 1, failed: 1, done: 1 }),
    sections: {
      current: [
        fixtureRow(0, { glyph: 'blue' }),
        fixtureRow(1, { glyph: 'amber' }),
        fixtureRow(2, { glyph: 'red', blocker: { reason: 'gate failed', attempt: 2 } }),
      ],
      recentlyDone: [fixtureRow(3, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' })],
      olderDone: [fixtureRow(4, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' })],
    },
    done: [],
    rows: [],
  };
}

function doneFacetState(): SidebarState {
  const doneRows = [
    fixtureRow(0, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' }),
    fixtureRow(1, { glyph: 'green', stageLabel: 'Done', stageClass: 'stg-done', stageChip: 'done' }),
  ];
  return {
    facets: ['done'],
    filter: '',
    counts: fixtureCounts({ all: 2, done: 2 }),
    sections: { current: [], recentlyDone: [], olderDone: [] },
    done: doneRows,
    rows: [],
  };
}

function archivedFacetState(): SidebarState {
  return {
    facets: ['archived'],
    filter: '',
    counts: fixtureCounts({ archived: 3 }),
    sections: { current: [], recentlyDone: [], olderDone: [] },
    done: [],
    rows: [
      fixtureRow(0, { label: 'DELETED-1', glyph: 'gray' }),
      fixtureRow(1, { label: 'DELETED-2', glyph: 'gray' }),
      fixtureRow(2, { label: 'DELETED-3', glyph: 'gray' }),
    ],
  };
}

function multiFacetState(): SidebarState {
  return {
    facets: ['running', 'failed'],
    filter: '',
    counts: fixtureCounts({ all: 4, running: 2, failed: 2 }),
    sections: { current: [], recentlyDone: [], olderDone: [] },
    done: [],
    rows: [
      fixtureRow(0, { glyph: 'blue' }),
      fixtureRow(1, { glyph: 'blue' }),
      fixtureRow(2, { glyph: 'red' }),
      fixtureRow(3, { glyph: 'red' }),
    ],
  };
}

function filteredState(): SidebarState {
  return {
    facets: ['all'],
    filter: 'auth',
    counts: fixtureCounts({ all: 3, running: 1 }),
    sections: {
      current: [fixtureRow(0, { label: 'FEAT-auth-flow', glyph: 'blue' })],
      recentlyDone: [],
      olderDone: [],
    },
    done: [],
    rows: [],
  };
}

function hostileState(): SidebarState {
  return {
    facets: ['all'],
    filter: '',
    counts: fixtureCounts({ all: 1 }),
    sections: {
      current: [
        fixtureRow(0, { label: HOSTILE_LABEL, description: HOSTILE_LONG, peek: fixturePeek({ title: HOSTILE_LABEL }) }),
      ],
      recentlyDone: [],
      olderDone: [],
    },
    done: [],
    rows: [],
  };
}

const BUILDERS: Readonly<Record<SidebarScenario, () => SidebarState>> = {
  empty: emptyState,
  'all-sections': allSectionsState,
  'done-facet': doneFacetState,
  'archived-facet': archivedFacetState,
  'multi-facet': multiFacetState,
  filtered: filteredState,
  hostile: hostileState,
};

export function sidebarRenderFixtures(): SidebarRenderFixture[] {
  return SIDEBAR_SCENARIOS.map((scenario) => ({ scenario, state: BUILDERS[scenario]() }));
}
