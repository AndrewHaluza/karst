import type { AgentProvider } from '../../manifest/types.js';
import type {
  UsageState,
  UsageBreakdownRow,
  UsageProfileRowView,
  UsageTicketRowView,
  UsageTotalsView,
  UsageTab,
} from './state.js';
import { USAGE_TABS } from './state.js';
import type { QuotaView } from './quotaState.js';
import { buildQuotaView } from './quotaState.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';
import { DEFAULT_QUOTA_WARN_THRESHOLD_PCT } from '../../manifest/validate/quota.js';
import { USAGE_SORTS, type UsageSort } from '../../store/tokenUsageQuery.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentProviders.js';
import { aiCallSiteLabel } from '../../agent/aiCallSites.js';
import {
  formatExactTokens,
  formatShare,
  formatTokens,
  shareOfTotal,
} from '../../model/tokenFormat.js';
import { formatCalendarDate, formatFullDateTime, formatLongDate } from '../../model/dateText.js';
import { plural } from '../../model/notifyText.js';

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
 *
 * US-9: numbers are NOT hand-written. One raw dataset is aggregated in this
 * file and every display field passes through the same formatter the host uses
 * (`formatTokens`, `formatExactTokens`, `formatShare`, `shareOfTotal`,
 * `formatCalendarDate`, `formatLongDate`, `plural`). Totals are the sums of the
 * rows, and each breakdown's shares add to 100 within display rounding.
 */

/** The fixed clock all fixtures (and their dates/countdowns) are relative to. */
export const FIXTURE_NOW = new Date('2026-03-10T10:42:00Z');

/** Deterministic locale/zone so Docker and developer machines match. */
const DATE_OPTS = { locale: 'en-US', timeZone: 'UTC' } as const;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW_MS = FIXTURE_NOW.getTime();

export type UsageScenario =
  | 'empty'
  | 'single-page'
  | 'paged-middle'
  | 'error'
  | 'all-sorts'
  | 'hostile'
  | 'long-key'
  | 'host-failure'
  | 'quota-near'
  | 'quota-exhausted'
  | 'quota-expired'
  | 'quota-stale'
  | 'quota-empty';

export const USAGE_SCENARIOS: readonly UsageScenario[] = [
  'empty',
  'single-page',
  'paged-middle',
  'error',
  'all-sorts',
  'hostile',
  'long-key',
  'host-failure',
  'quota-near',
  'quota-exhausted',
  'quota-expired',
  'quota-stale',
  'quota-empty',
];

export interface UsageRenderFixture {
  scenario: UsageScenario;
  state: UsageState;
}

const SORT_LABELS: Record<UsageSort, string> = {
  total: 'Total tokens',
  input: 'Input tokens',
  output: 'Output tokens',
  calls: 'Calls',
  recent: 'Most recent',
};

const SORTS = USAGE_SORTS.map((id) => ({ id, label: SORT_LABELS[id] }));

/**
 * One raw ledger row, before any formatting: the ticket it belongs to, the
 * core/model/activity it was spent on, and its raw token counts. The fixtures
 * aggregate these; no display string exists at this level.
 */
interface RawTicket {
  index: number;
  ticketId: number | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  core: AgentProvider;
  model: string;
  activity: string;
  activityNote?: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  estimatedCalls: number;
  erroredCalls: number;
  daysAgo: number;
  profile: string;
  profileProvider: string | null;
}

interface RawTicketOptions {
  calls?: number;
  estimatedCalls?: number;
  erroredCalls?: number;
  cacheRead?: number;
  inputOverride?: number;
  daysAgo?: number;
  profile?: string;
  profileProvider?: string | null;
  key?: string | null;
  title?: string | null;
  activityNote?: string;
}

/** `fresh` is split into input/output/reasoning/cache-write, so the sum is exact. */
function ticket(
  index: number,
  core: AgentProvider,
  model: string,
  activity: string,
  fresh: number,
  options: RawTicketOptions = {},
): RawTicket {
  const reasoning = Math.round(fresh * 0.1);
  const cacheWrite = Math.round(fresh * 0.05);
  const input = options.inputOverride ?? Math.round(fresh * 0.4);
  const output = fresh - input - reasoning - cacheWrite;
  return {
    index,
    ticketId: 900001 + index,
    ticketKey: options.key === undefined ? `FEAT-${100 + index}` : options.key,
    ticketTitle: options.title === undefined ? `Fixture ticket ${index + 1}` : options.title,
    core,
    model,
    activity,
    ...(options.activityNote !== undefined ? { activityNote: options.activityNote } : {}),
    input,
    output,
    reasoning,
    cacheRead: options.cacheRead ?? 0,
    cacheWrite,
    calls: options.calls ?? 1,
    estimatedCalls: options.estimatedCalls ?? 0,
    erroredCalls: options.erroredCalls ?? 0,
    daysAgo: options.daysAgo ?? index,
    profile: options.profile ?? 'graphite',
    profileProvider: options.profileProvider ?? core,
  };
}

const FRESH_TOTAL = 1_000_000;
/** The two real instants the corpus exercises: the smallest raw count and a cache-heavy row. */
const MIN_RAW_TOKENS = 120;
const MAX_CACHE_READ = 3_400_000;

/**
 * The one raw Spend dataset (US-9): 3 cores, 4 models, 6 activities, 25 ticket
 * rows, and exactly `FRESH_TOTAL` fresh tokens. The grouping is chosen so every
 * breakdown partitions the total into whole percentages (cores 50/30/20,
 * models 40/30/20/10, activities 25/20/20/15/10/10), which makes the rendered
 * shares add to exactly 100.
 */
const BASE_ROWS: RawTicket[] = [
  ticket(0, 'claude', 'claude-opus-4', 'ticket-analysis', 60_000, { calls: 3, cacheRead: MAX_CACHE_READ }),
  ticket(1, 'claude', 'claude-opus-4', 'ticket-analysis', 50_000, { calls: 3 }),
  ticket(2, 'claude', 'claude-opus-4', 'ticket-analysis', 40_000, { calls: 3 }),
  ticket(3, 'claude', 'claude-opus-4', 'implementation', 30_000, { calls: 3 }),
  ticket(4, 'claude', 'claude-opus-4', 'implementation', 30_000, { calls: 3 }),
  ticket(5, 'claude', 'claude-opus-4', 'implementation', 40_000, { calls: 3 }),
  ticket(6, 'claude', 'claude-opus-4', 'pr-description', 50_000, { calls: 3 }),
  ticket(7, 'claude', 'claude-opus-4', 'pr-description', 50_000, { calls: 3 }),
  ticket(8, 'claude', 'claude-opus-4', 'fix-resume', 50_000, { calls: 2, erroredCalls: 1 }),
  ticket(9, 'codex', 'gpt-5-codex', 'ticket-analysis', 60_000, { daysAgo: 9, profile: 'obsidian', profileProvider: 'codex' }),
  ticket(10, 'codex', 'gpt-5-codex', 'ticket-analysis', 40_000, { daysAgo: 10, profile: 'obsidian', profileProvider: 'codex' }),
  ticket(11, 'codex', 'gpt-5-codex', 'implementation', 50_000, { daysAgo: 11, profile: 'obsidian', profileProvider: 'codex' }),
  ticket(12, 'codex', 'gpt-5-codex', 'implementation', 50_000, { daysAgo: 12, profile: 'obsidian', profileProvider: 'codex' }),
  ticket(13, 'codex', 'gpt-5-codex', 'pr-description', 50_000, { daysAgo: 13, profile: 'obsidian', profileProvider: 'codex' }),
  ticket(14, 'codex', 'gpt-5-codex', 'fix-resume', 50_000, { daysAgo: 14, profile: 'obsidian', profileProvider: 'codex' }),
  ticket(15, 'opencode', 'opencode-go', 'pr-description', 30_000, { daysAgo: 15, profileProvider: 'opencode' }),
  ticket(16, 'opencode', 'opencode-go', 'pr-description', 20_000, { daysAgo: 16, profileProvider: 'opencode' }),
  ticket(17, 'opencode', 'opencode-go', 'fix-resume', 30_000, { daysAgo: 17, profileProvider: 'opencode' }),
  ticket(18, 'opencode', 'opencode-go', 'fix-resume', 20_000, { daysAgo: 18, profileProvider: 'opencode' }),
  ticket(19, 'opencode', 'opencode-go', 'graph-node', 50_000, { daysAgo: 19, profileProvider: 'opencode' }),
  ticket(20, 'opencode', 'opencode-go', 'unknown', 50_000, { daysAgo: 20, profileProvider: 'opencode' }),
  ticket(21, 'claude', 'claude-haiku-4', 'graph-node', 25_000, { daysAgo: 21, profile: '', profileProvider: null }),
  ticket(22, 'claude', 'claude-haiku-4', 'graph-node', 25_000, { daysAgo: 22, profile: '', profileProvider: null, inputOverride: MIN_RAW_TOKENS }),
  ticket(23, 'claude', 'claude-haiku-4', 'unknown', 25_000, { daysAgo: 23, profile: '', profileProvider: null, estimatedCalls: 1 }),
  ticket(24, 'claude', 'claude-haiku-4', 'unknown', 25_000, { daysAgo: 24, profile: '', profileProvider: null, estimatedCalls: 1 }),
];

const LONG_KEY = 'FIX-A-SANDBOX-SETUP-FAILURE';
const LONG_TITLE =
  "fix: a sandbox setup failure quotes npm's 'A complete log…' trailer — name the blocked host (proxy 403) and the real error, keep the npm debug log";

const HOSTILE_LABEL = '<script>alert(1)</script>';
const HOSTILE_DETAIL = 'A & B "quoted" <b>';
const HOSTILE_LONG = 'Y'.repeat(300);

/** 12 models so the host-side top-6 cap produces `Other (6)` (US-23). */
const HOSTILE_KEY = 'HOSTILE-LONG-TITLE';
const HOSTILE_ROWS: RawTicket[] = Array.from({ length: 12 }, (_, i) =>
  ticket(i, (['claude', 'codex', 'opencode'] as const)[i % 3]!, i === 3 ? HOSTILE_LONG : `hostile-model-${i}`, i === 0 ? HOSTILE_LABEL : 'implementation', 12_000 - i * 1_000, {
    calls: 1,
    daysAgo: i,
    ...(i === 0 ? { activityNote: HOSTILE_DETAIL } : {}),
    ...(i === 0 ? { key: HOSTILE_LABEL, title: HOSTILE_LABEL } : {}),
    ...(i === 1 ? { key: 'A & B', title: HOSTILE_DETAIL } : {}),
    ...(i === 2 ? { key: HOSTILE_KEY, title: HOSTILE_LONG } : {}),
  }),
);

const LONG_KEY_ROWS: RawTicket[] = BASE_ROWS.map((row, i) =>
  i === 0 ? { ...row, ticketKey: LONG_KEY, ticketTitle: LONG_TITLE } : row,
);

function freshOf(row: RawTicket): number {
  return row.input + row.output + row.reasoning + row.cacheWrite;
}

interface GroupTotals {
  key: string;
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  fresh: number;
  estimatedCalls: number;
  provider: string | null;
}

function emptyGroup(key: string): GroupTotals {
  return {
    key,
    calls: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    fresh: 0,
    estimatedCalls: 0,
    provider: null,
  };
}

function addTo(group: GroupTotals, row: RawTicket): void {
  group.calls += row.calls;
  group.input += row.input;
  group.output += row.output;
  group.reasoning += row.reasoning;
  group.cacheRead += row.cacheRead;
  group.cacheWrite += row.cacheWrite;
  group.fresh += freshOf(row);
  group.estimatedCalls += row.estimatedCalls;
  if (group.provider === null) group.provider = row.profileProvider;
}

function groupedBy(rows: RawTicket[], keyOf: (row: RawTicket) => string): GroupTotals[] {
  const groups = new Map<string, GroupTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? emptyGroup(key);
    addTo(group, row);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function cappedGroups(groups: GroupTotals[]): { rows: GroupTotals[]; restCount: number } {
  const sorted = [...groups].sort((a, b) => b.fresh - a.fresh || a.key.localeCompare(b.key));
  if (sorted.length <= 6) return { rows: sorted, restCount: 0 };
  const rest = sorted.slice(6);
  const merged = emptyGroup('__other__');
  merged.calls = rest.reduce((sum, g) => sum + g.calls, 0);
  merged.input = rest.reduce((sum, g) => sum + g.input, 0);
  merged.output = rest.reduce((sum, g) => sum + g.output, 0);
  merged.reasoning = rest.reduce((sum, g) => sum + g.reasoning, 0);
  merged.cacheRead = rest.reduce((sum, g) => sum + g.cacheRead, 0);
  merged.cacheWrite = rest.reduce((sum, g) => sum + g.cacheWrite, 0);
  merged.fresh = rest.reduce((sum, g) => sum + g.fresh, 0);
  merged.estimatedCalls = rest.reduce((sum, g) => sum + g.estimatedCalls, 0);
  return { rows: [...sorted.slice(0, 6), merged], restCount: rest.length };
}

function breakdownRows(
  groups: GroupTotals[],
  freshTotal: number,
  label: (key: string) => string,
  title?: (key: string) => string | undefined,
): UsageBreakdownRow[] {
  const capped = cappedGroups(groups);
  return capped.rows.map((group) => {
    const rowTitle = title?.(group.key);
    return {
      key: group.key,
      label: group.key === '__other__' ? `Other (${capped.restCount})` : label(group.key),
      ...(rowTitle !== undefined ? { title: rowTitle } : {}),
      calls: group.calls,
      callsText: plural(group.calls, 'call', 'calls'),
      totalTokens: group.fresh,
      totalDisplay: formatTokens(group.fresh),
      totalExact: formatExactTokens(group.fresh, DATE_OPTS.locale),
      inputDisplay: formatTokens(group.input),
      outputDisplay: formatTokens(group.output),
      share: shareOfTotal(group.fresh, freshTotal),
      shareDisplay: formatShare(group.fresh, freshTotal),
      estimated: group.calls > 0 && group.estimatedCalls === group.calls,
    };
  });
}

function providerLabel(key: string): string {
  if (key === '') return 'Core not reported';
  return AGENT_PROVIDER_LABELS[key as keyof typeof AGENT_PROVIDER_LABELS] ?? key;
}

function activityLabel(key: string): string {
  return aiCallSiteLabel(key);
}

function profileRows(groups: GroupTotals[], freshTotal: number): UsageProfileRowView[] {
  const capped = cappedGroups(groups);
  return capped.rows.map((group) => {
    const isOther = group.key === '__other__';
    return {
      key: group.key,
      label: isOther ? `Other (${capped.restCount})` : group.key === '' ? 'unknown profile' : group.key,
      calls: group.calls,
      callsText: plural(group.calls, 'call', 'calls'),
      totalTokens: group.fresh,
      totalDisplay: formatTokens(group.fresh),
      totalExact: formatExactTokens(group.fresh, DATE_OPTS.locale),
      inputDisplay: formatTokens(group.input),
      outputDisplay: formatTokens(group.output),
      share: shareOfTotal(group.fresh, freshTotal),
      shareDisplay: formatShare(group.fresh, freshTotal),
      estimated: group.calls > 0 && group.estimatedCalls === group.calls,
      provider: group.provider,
      note: isOther ? undefined : group.provider ?? 'provider unknown',
    };
  });
}

function totalsView(rows: RawTicket[]): UsageTotalsView {
  const calls = rows.reduce((sum, r) => sum + r.calls, 0);
  const input = rows.reduce((sum, r) => sum + r.input, 0);
  const output = rows.reduce((sum, r) => sum + r.output, 0);
  const reasoning = rows.reduce((sum, r) => sum + r.reasoning, 0);
  const cacheRead = rows.reduce((sum, r) => sum + r.cacheRead, 0);
  const cacheWrite = rows.reduce((sum, r) => sum + r.cacheWrite, 0);
  const estimatedCalls = rows.reduce((sum, r) => sum + r.estimatedCalls, 0);
  const erroredCalls = rows.reduce((sum, r) => sum + r.erroredCalls, 0);
  const fresh = input + output + reasoning + cacheWrite;
  return {
    calls,
    totalDisplay: formatTokens(fresh),
    totalExact: formatExactTokens(fresh, DATE_OPTS.locale),
    totalNote: `${formatExactTokens(fresh, DATE_OPTS.locale)} tokens`,
    inputDisplay: formatTokens(input),
    outputDisplay: formatTokens(output),
    reasoningDisplay: formatTokens(reasoning),
    cacheReadDisplay: formatTokens(cacheRead),
    cacheWriteDisplay: formatTokens(cacheWrite),
    estimatedCalls,
    estimatedNote: estimatedCalls > 0 ? `${estimatedCalls} of ${plural(calls, 'call', 'calls')} estimated` : null,
    erroredCalls,
    erroredNote: erroredCalls > 0 ? `${erroredCalls} failed` : '',
  };
}

function lastAtOf(row: RawTicket): string {
  return new Date(NOW_MS - row.daysAgo * DAY).toISOString();
}

function sortTickets(rows: RawTicket[], sort: UsageSort): RawTicket[] {
  const value = (row: RawTicket): number => {
    if (sort === 'input') return row.input;
    if (sort === 'output') return row.output;
    if (sort === 'calls') return row.calls;
    if (sort === 'recent') return NOW_MS - row.daysAgo * DAY;
    return freshOf(row);
  };
  return [...rows].sort((a, b) => value(b) - value(a) || a.index - b.index);
}

function pageSummary(offset: number, rowCount: number, groups: number): string {
  return groups === 0 ? 'No tickets' : `${offset + 1}–${offset + rowCount} of ${plural(groups, 'ticket', 'tickets')}`;
}

interface BuildStateOptions {
  rows: RawTicket[];
  sort?: UsageSort;
  offset?: number;
  limit?: number;
  tab?: UsageTab;
  quota?: QuotaView;
  error?: string | null;
}

function buildState(options: BuildStateOptions): UsageState {
  const rows = options.rows;
  const sort = options.sort ?? 'total';
  const offset = options.offset ?? 0;
  const limit = options.limit ?? Math.max(1, rows.length);
  const tab = options.tab ?? 'spend';
  const freshTotal = rows.reduce((sum, r) => sum + freshOf(r), 0);
  const ordered = sortTickets(rows, sort);
  const pageRows = ordered.slice(offset, offset + limit);
  const oldest = rows.reduce<RawTicket | null>(
    (best, row) => (best === null || row.daysAgo > best.daysAgo ? row : best),
    null,
  );
  const firstAt = oldest === null ? null : lastAtOf(oldest);
  const quota = options.quota ?? quotaNearView();

  const tickets: UsageTicketRowView[] = pageRows.map((row) => {
    const fresh = freshOf(row);
    const key = row.ticketKey;
    const label = key === null
      ? 'Not attributed to a ticket'
      : row.ticketTitle ? `${key} — ${row.ticketTitle}` : key;
    return {
      ticketId: row.ticketId,
      ticketKey: key,
      ticketTitle: row.ticketTitle,
      label,
      calls: row.calls,
      totalTokens: fresh,
      totalDisplay: formatTokens(fresh),
      totalExact: formatExactTokens(fresh, DATE_OPTS.locale),
      inputDisplay: formatTokens(row.input),
      outputDisplay: formatTokens(row.output),
      lastAt: lastAtOf(row),
      lastDisplay: formatCalendarDate(lastAtOf(row), FIXTURE_NOW, DATE_OPTS),
      lastTitle: formatFullDateTime(lastAtOf(row), DATE_OPTS),
      share: shareOfTotal(fresh, freshTotal),
      estimated: row.calls > 0 && row.estimatedCalls === row.calls,
    };
  });

  return {
    tab,
    tabs: USAGE_TABS,
    empty: rows.length === 0,
    sort,
    sorts: SORTS,
    scopeLabel: firstAt === null ? 'All time' : `All time · since ${formatLongDate(firstAt, DATE_OPTS)}`,
    costNote: 'Tokens, not cost',
    updatedLabel: `Updated ${formatCalendarDate(FIXTURE_NOW.toISOString(), FIXTURE_NOW, DATE_OPTS)}`,
    totals: totalsView(rows),
    byProvider: breakdownRows(groupedBy(rows, (r) => r.core), freshTotal, providerLabel),
    byActivity: breakdownRows(groupedBy(rows, (r) => r.activity), freshTotal, activityLabel, (key) =>
      key === 'unknown' ? 'The call site did not declare an activity' : undefined,
    ),
    byModel: breakdownRows(groupedBy(rows, (r) => r.model), freshTotal, (key) => key),
    byProfile: profileRows(groupedBy(rows, (r) => r.profile), freshTotal),
    counts: (() => {
      const providerCount = new Set(rows.map((r) => r.core)).size;
      const activityCount = new Set(rows.map((r) => r.activity)).size;
      const modelCount = new Set(rows.map((r) => r.model)).size;
      const profileCount = new Set(rows.map((r) => r.profile)).size;
      return {
        providers: plural(providerCount, 'agent core', 'agent cores'),
        activities: plural(activityCount, 'activity', 'activities'),
        models: plural(modelCount, 'model', 'models'),
        profiles: plural(profileCount, 'profile', 'profiles'),
        tickets: plural(rows.length, 'ticket', 'tickets'),
        providerCount,
        activityCount,
        modelCount,
        profileCount,
      };
    })(),
    tickets,
    page: {
      offset,
      limit,
      groups: rows.length,
      hasPrev: offset > 0,
      hasNext: offset + pageRows.length < rows.length,
      summary: pageSummary(offset, pageRows.length, rows.length),
    },
    quota,
    error: options.error ?? null,
  };
}

/** A read of `core` at `readAt`, with real reset instants relative to `FIXTURE_NOW`. */
function known(
  core: AgentProvider,
  source: string,
  readAtMs: number,
  windows: { label: string; usedPct: number; resetsAtMs: number | null }[],
): QuotaSnapshot {
  return {
    core,
    state: 'ok',
    source,
    readAt: new Date(readAtMs).toISOString(),
    windows: windows.map((w) => ({
      label: w.label,
      usedPct: w.usedPct,
      resetsAt: w.resetsAtMs === null ? null : new Date(w.resetsAtMs).toISOString(),
    })),
  };
}

function unknown(core: AgentProvider, reason: string): QuotaSnapshot {
  return { core, state: 'unknown', reason };
}

function quotaView(snapshots: readonly QuotaSnapshot[]): QuotaView {
  return buildQuotaView(snapshots, DEFAULT_QUOTA_WARN_THRESHOLD_PCT, FIXTURE_NOW);
}

const QUOTA_NEAR: QuotaSnapshot[] = [
  known('claude', 'Claude statusline telemetry', NOW_MS - 3 * MINUTE, [
    { label: '5-hour', usedPct: 34, resetsAtMs: NOW_MS + 2 * HOUR + 13 * MINUTE },
    { label: '7-day', usedPct: 12, resetsAtMs: NOW_MS + 5 * DAY + 3 * HOUR },
  ]),
  known('codex', 'Codex session rate limits', NOW_MS - 1 * MINUTE, [
    { label: '7-day', usedPct: 82, resetsAtMs: NOW_MS + 4 * DAY + 1 * HOUR },
  ]),
  unknown('antigravity', 'no local quota source; agy exposes no zero-request usage endpoint'),
  known('opencode', 'OpenCode Go usage API', NOW_MS, [
    { label: '5-hour', usedPct: 3, resetsAtMs: NOW_MS + 1 * HOUR + 10 * MINUTE },
    { label: 'Weekly', usedPct: 9, resetsAtMs: NOW_MS + 4 * DAY + 23 * HOUR },
    { label: 'Monthly', usedPct: 45, resetsAtMs: NOW_MS + 16 * DAY + 10 * HOUR },
  ]),
];

function quotaNearView(): QuotaView {
  return quotaView(QUOTA_NEAR);
}

function emptyState(): UsageState {
  return buildState({ rows: [], quota: quotaNearView() });
}

function singlePageState(): UsageState {
  return buildState({ rows: BASE_ROWS, sort: 'total', limit: 25 });
}

function pagedMiddleState(): UsageState {
  return buildState({ rows: BASE_ROWS, sort: 'calls', offset: 10, limit: 10 });
}

function errorState(): UsageState {
  return buildState({
    rows: [],
    error: 'fixture: Page offset 40 is past the last page',
    quota: quotaNearView(),
  });
}

function allSortsState(): UsageState {
  return buildState({ rows: BASE_ROWS, sort: 'recent', limit: 25 });
}

function hostileState(): UsageState {
  return buildState({ rows: HOSTILE_ROWS, limit: 12, quota: quotaNearView() });
}

function longKeyState(): UsageState {
  return buildState({ rows: LONG_KEY_ROWS, sort: 'total', limit: 25 });
}

function hostFailureState(): UsageState {
  return buildState({
    rows: [],
    error: 'Could not read token usage. Details are in the Karst log.',
  });
}

function quotaScenarioState(snapshots: readonly QuotaSnapshot[]): UsageState {
  return buildState({ rows: BASE_ROWS, tab: 'quota', limit: 25, quota: quotaView(snapshots) });
}

const BUILDERS: Readonly<Record<UsageScenario, () => UsageState>> = {
  empty: emptyState,
  'single-page': singlePageState,
  'paged-middle': pagedMiddleState,
  error: errorState,
  'all-sorts': allSortsState,
  hostile: hostileState,
  'long-key': longKeyState,
  'host-failure': hostFailureState,
  'quota-near': () => quotaScenarioState(QUOTA_NEAR),
  'quota-exhausted': () =>
    quotaScenarioState([
      known('claude', 'Claude statusline telemetry', NOW_MS - 1 * MINUTE, [
        { label: '5-hour', usedPct: 100, resetsAtMs: NOW_MS + 2 * HOUR + 13 * MINUTE },
      ]),
    ]),
  'quota-expired': () =>
    quotaScenarioState([
      known('codex', 'Codex session rate limits', NOW_MS - 30 * MINUTE, [
        { label: '5-hour', usedPct: 64, resetsAtMs: NOW_MS - 20 * MINUTE },
      ]),
    ]),
  'quota-stale': () =>
    quotaScenarioState([
      known('opencode', 'OpenCode Go usage API', NOW_MS - 4 * DAY, [
        { label: '7-day', usedPct: 40, resetsAtMs: NOW_MS + 2 * DAY },
      ]),
    ]),
  'quota-empty': () => quotaScenarioState([]),
};

export function usageRenderFixtures(): UsageRenderFixture[] {
  return USAGE_SCENARIOS.map((scenario) => ({
    scenario,
    state: BUILDERS[scenario](),
  }));
}

/** Exported for the data-contract test: the one raw dataset's identity. */
export const USAGE_FIXTURE_RAW = {
  freshTotal: FRESH_TOTAL,
  minRawTokens: MIN_RAW_TOKENS,
  maxCacheRead: MAX_CACHE_READ,
  rows: BASE_ROWS,
} as const;
