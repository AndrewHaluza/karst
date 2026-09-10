import type {
  UsageState,
  UsageBreakdownRow,
  UsageProfileRowView,
  UsageTicketRowView,
  UsageTotalsView,
} from './state.js';
import { USAGE_RANGES, USAGE_SORTS, type UsageSort } from '../../store/tokenUsageQuery.js';

/**
 * The checked-in render fixture corpus for the usage webview.
 *
 * Every fixture is built ONLY from production presentation shapes
 * (`UsageState`, `UsageBreakdownRow`, `UsageTicketRowView`, `UsageTotalsView`)
 * and is pure data: no SQLite reads, no real worktrees. Every action/target id
 * is `fixture:`-prefixed so no fixture control can resolve a real host target.
 * Ticket ids use the reserved numeric band 900001–999999 (Key Decision 5).
 * Deliberately long, hostile, untrusted labels and paths (`<script>`, `&`,
 * `"`) ensure render tests exercise escaping.
 */

export type UsageScenario =
  | 'empty'
  | 'single-page'
  | 'paged-middle'
  | 'error'
  | 'all-sorts'
  | 'hostile';

export const USAGE_SCENARIOS: readonly UsageScenario[] = [
  'empty',
  'single-page',
  'paged-middle',
  'error',
  'all-sorts',
  'hostile',
];

export interface UsageRenderFixture {
  scenario: UsageScenario;
  state: UsageState;
}

const RANGES = USAGE_RANGES.map((r) => ({ id: r.id, label: r.label }));

const SORT_LABELS: Record<UsageSort, string> = {
  total: 'Total tokens',
  input: 'Input tokens',
  output: 'Output tokens',
  calls: 'Calls',
  recent: 'Most recent',
};

const SORTS = USAGE_SORTS.map((id) => ({ id, label: SORT_LABELS[id] }));

function fixtureTotals(overrides?: Partial<UsageTotalsView>): UsageTotalsView {
  return {
    calls: 0,
    totalDisplay: '0',
    totalExact: '0',
    inputDisplay: '0',
    outputDisplay: '0',
    reasoningDisplay: '0',
    cacheReadDisplay: '0',
    cacheWriteDisplay: '0',
    estimatedCalls: 0,
    erroredCalls: 0,
    ...overrides,
  };
}

function fixtureBreakdownRow(
  index: number,
  overrides?: Partial<UsageBreakdownRow>,
): UsageBreakdownRow {
  return {
    key: `fixture:key:${index}`,
    label: `Stage ${index}`,
    calls: 10 + index,
    totalTokens: 1000 * (index + 1),
    totalDisplay: `${(index + 1)}k`,
    totalExact: String(1000 * (index + 1)),
    inputDisplay: `${index}k`,
    outputDisplay: `${index + 1}k`,
    share: 20 * (index + 1),
    estimated: false,
    ...overrides,
  };
}

function fixtureTicketRow(
  index: number,
  overrides?: Partial<UsageTicketRowView>,
): UsageTicketRowView {
  return {
    ticketId: 900001 + index,
    ticketKey: `FEAT-${100 + index}`,
    label: `FEAT-${100 + index} — Ticket ${index + 1}`,
    calls: 5 + index,
    totalTokens: 500 * (index + 1),
    totalDisplay: `${(index + 1) * 0.5}k`,
    totalExact: String(500 * (index + 1)),
    inputDisplay: `${index * 0.3}k`,
    outputDisplay: `${(index + 1) * 0.2}k`,
    lastAt: `2026-01-0${index + 1}T12:00:00Z`,
    share: 10 * (index + 1),
    estimated: false,
    ...overrides,
  };
}

function fixtureProfileRow(
  index: number,
  overrides?: Partial<UsageProfileRowView>,
): UsageProfileRowView {
  return {
    key: `fixture:profile:${index}`,
    label: `Profile ${index}`,
    calls: 8 + index,
    totalTokens: 800 * (index + 1),
    totalDisplay: `${(index + 1) * 0.8}k`,
    totalExact: String(800 * (index + 1)),
    inputDisplay: `${index * 0.5}k`,
    outputDisplay: `${(index + 1) * 0.3}k`,
    share: 15 * (index + 1),
    estimated: false,
    provider: 'claude',
    ...overrides,
  };
}

function emptyState(): UsageState {
  return {
    empty: true,
    rangeId: RANGES[0]!.id,
    ranges: RANGES,
    sort: 'total',
    sorts: SORTS,
    totals: fixtureTotals(),
    byStage: [],
    byModel: [],
    byProfile: [],
    tickets: [],
    page: { offset: 0, limit: 20, groups: 0, hasPrev: false, hasNext: false },
    error: null,
  };
}

function singlePageState(): UsageState {
  return {
    empty: false,
    rangeId: RANGES[0]!.id,
    ranges: RANGES,
    sort: 'total',
    sorts: SORTS,
    totals: fixtureTotals({ calls: 42, totalDisplay: '12.5k', totalExact: '12500' }),
    byStage: [fixtureBreakdownRow(0), fixtureBreakdownRow(1)],
    byModel: [fixtureBreakdownRow(0, { key: 'fixture:model:0', label: 'claude-opus-4' })],
    byProfile: [fixtureProfileRow(0)],
    tickets: [fixtureTicketRow(0), fixtureTicketRow(1)],
    page: { offset: 0, limit: 20, groups: 2, hasPrev: false, hasNext: false },
    error: null,
  };
}

function pagedMiddleState(): UsageState {
  return {
    empty: false,
    rangeId: RANGES[1]!.id,
    ranges: RANGES,
    sort: 'calls',
    sorts: SORTS,
    totals: fixtureTotals({ calls: 100, totalDisplay: '50k', totalExact: '50000' }),
    byStage: [fixtureBreakdownRow(0), fixtureBreakdownRow(1), fixtureBreakdownRow(2)],
    byModel: [fixtureBreakdownRow(0), fixtureBreakdownRow(1)],
    byProfile: [fixtureProfileRow(0), fixtureProfileRow(1)],
    tickets: [fixtureTicketRow(0), fixtureTicketRow(1), fixtureTicketRow(2)],
    page: { offset: 20, limit: 20, groups: 60, hasPrev: true, hasNext: true },
    error: null,
  };
}

function errorState(): UsageState {
  return {
    empty: true,
    rangeId: RANGES[0]!.id,
    ranges: RANGES,
    sort: 'total',
    sorts: SORTS,
    totals: fixtureTotals(),
    byStage: [],
    byModel: [],
    byProfile: [],
    tickets: [],
    page: { offset: 0, limit: 20, groups: 0, hasPrev: false, hasNext: false },
    error: 'fixture: Query rejected — range not valid for this project',
  };
}

function allSortsState(): UsageState {
  return {
    empty: false,
    rangeId: RANGES[0]!.id,
    ranges: RANGES,
    sort: 'recent',
    sorts: SORTS,
    totals: fixtureTotals({ calls: 25, totalDisplay: '8k', totalExact: '8000' }),
    byStage: [fixtureBreakdownRow(0)],
    byModel: [fixtureBreakdownRow(0)],
    byProfile: [],
    tickets: [fixtureTicketRow(0)],
    page: { offset: 0, limit: 20, groups: 1, hasPrev: false, hasNext: false },
    error: null,
  };
}

const HOSTILE_LABEL = '<script>alert(1)</script>';
const HOSTILE_DETAIL = 'A & B "quoted" <b>';
const HOSTILE_LONG = 'Y'.repeat(300);

function hostileState(): UsageState {
  return {
    empty: false,
    rangeId: RANGES[0]!.id,
    ranges: RANGES,
    sort: 'total',
    sorts: SORTS,
    totals: fixtureTotals({ calls: 3, totalDisplay: '1k', totalExact: '1000' }),
    byStage: [
      fixtureBreakdownRow(0, { label: HOSTILE_LABEL, note: HOSTILE_DETAIL }),
    ],
    byModel: [
      fixtureBreakdownRow(0, { label: HOSTILE_LONG }),
    ],
    byProfile: [],
    tickets: [
      fixtureTicketRow(0, { label: HOSTILE_LABEL }),
      fixtureTicketRow(1, { label: HOSTILE_LONG, ticketKey: null, ticketId: null }),
    ],
    page: { offset: 0, limit: 20, groups: 2, hasPrev: false, hasNext: false },
    error: null,
  };
}

const BUILDERS: Readonly<Record<UsageScenario, () => UsageState>> = {
  empty: emptyState,
  'single-page': singlePageState,
  'paged-middle': pagedMiddleState,
  error: errorState,
  'all-sorts': allSortsState,
  hostile: hostileState,
};

export function usageRenderFixtures(): UsageRenderFixture[] {
  return USAGE_SCENARIOS.map((scenario) => ({
    scenario,
    state: BUILDERS[scenario](),
  }));
}
