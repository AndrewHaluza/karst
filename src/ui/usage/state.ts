import type { Store } from '../../store/db.js';
import {
  queryTokenUsageStats,
  type TokenUsageStats,
  type UsageGroupRow,
  type UsageProfileRow,
  type UsageTicketRow,
  type UsageTotals,
} from '../../store/tokenUsage.js';
import {
  DEFAULT_USAGE_LIMIT,
  parseUsageQuery,
  USAGE_SORTS,
  type UsageSort,
} from '../../store/tokenUsageQuery.js';
import { aiCallSiteLabel } from '../../agent/aiCallSites.js';
import {
  formatExactTokens,
  formatShare,
  formatTokens,
  shareOfTotal,
} from '../../model/tokenFormat.js';
import { formatId } from '../../model/entityId.js';
import { plural } from '../../model/notifyText.js';
import { AGENT_PROVIDER_LABELS } from '../../model/agentProviders.js';
import { formatCalendarDate, formatFullDateTime, formatLongDate, type DateTextOptions } from '../../model/dateText.js';
import { quotaWarnThresholdText } from '../../model/quotaText.js';
import { buildQuotaView, type AccountOf, type QuotaView } from './quotaState.js';
import type { QuotaSnapshot } from '../../agent/quota/types.js';
import { DEFAULT_QUOTA_WARN_THRESHOLD_PCT } from '../../manifest/validate/quota.js';

/**
 * The token-usage view's read model (§ token consumption stats).
 *
 * Every number is formatted HERE, host-side, exactly like `prPanelView.ts` and
 * for the same reason: the webview cannot import a formatter, so anything it
 * formats itself is a second implementation of the rule. It receives strings and
 * renders them.
 *
 * The state is also the error channel. An invalid query (a range the view could
 * not have produced, a page past the end) comes back as `error` with an empty
 * body rather than as a thrown exception or a silently clamped result — an
 * empty table that should have been an error message reads as "you spent
 * nothing", which is the one wrong answer this view must never give.
 */

/** A formatted row of the by-activity / by-model / by-core breakdowns. */
export interface UsageBreakdownRow {
  key: string;
  label: string;
  /** A host-resolved annotation rendered on the row's meta line, if any. */
  note?: string;
  /** A host-resolved tooltip for the row label (e.g. why a row is Undeclared). */
  title?: string;
  calls: number;
  /** The call count as the view prints it, from `plural` (@arch:NTF-07). */
  callsText: string;
  totalTokens: number;
  totalDisplay: string;
  totalExact: string;
  inputDisplay: string;
  outputDisplay: string;
  /** Percentage of the range's total tokens, 0–100. Drives the bar width. */
  share: number;
  /** The share as display text: `25%`, `33.3%`, `<0.1%` (US-18). */
  shareDisplay: string;
  /** True when every call in this group had estimated counts. */
  estimated: boolean;
}

/**
 * A formatted graph-spend row (Slice-6 T2): the spend of the graph runtime,
 * grouped by the profile the node/planner run resolved — read from the RUN
 * through the join, never from a `token_usage` column. `label` carries the
 * profile name; a run that never resolved one renders as "unknown profile".
 */
export interface UsageProfileRowView extends UsageBreakdownRow {
  /** The provider that spent it; NULL = the core never named one. */
  provider: string | null;
}

/** A formatted row of the per-ticket table. */
export interface UsageTicketRowView {
  ticketId: number | null;
  /** The ticket's key, or null for spend recorded before a ticket existed. */
  ticketKey: string | null;
  /** The ticket title alone, for its own ellipsised span (US-35). */
  ticketTitle: string | null;
  /** The full `KEY — title` string, for the link's tooltip. */
  label: string;
  calls: number;
  totalTokens: number;
  totalDisplay: string;
  totalExact: string;
  inputDisplay: string;
  outputDisplay: string;
  /** Last call in range, ISO-8601 — the host formats the display and tooltip. */
  lastAt: string | null;
  /** `10:42` / `Mar 4` / `Mar 4, 2025` — the cell text (US-16). */
  lastDisplay: string;
  /** `Mar 4, 2026, 10:42` — the `<time>` tooltip (US-16). */
  lastTitle: string;
  share: number;
  estimated: boolean;
}

export interface UsageTotalsView {
  calls: number;
  /**
   * FRESH spend — input, output, reasoning and cache WRITES. Cache READS are
   * their own tile: they are context the provider re-sent and re-charged at a
   * fraction of the fresh rate, and on a long session they are the great
   * majority of the raw tally, so a headline that sums them reported an
   * ordinary conversation as a runaway one.
   */
  totalDisplay: string;
  totalExact: string;
  /** `12,500 tokens` — the hero's exact count (US-17). */
  totalNote: string;
  inputDisplay: string;
  outputDisplay: string;
  /** v45: reasoning tokens — output-billed, counted apart from output. */
  reasoningDisplay: string;
  cacheReadDisplay: string;
  cacheWriteDisplay: string;
  estimatedCalls: number;
  /** `3 of 42 calls estimated`, or null when every call was measured (US-7). */
  estimatedNote: string | null;
  erroredCalls: number;
  /** `2 failed`, or '' when no call failed. */
  erroredNote: string;
}

/** The host-built panel counts, for each panel's accessible name (US-17). */
export interface UsageCounts {
  providers: string;
  activities: string;
  models: string;
  profiles: string;
  tickets: string;
  /** The true group count behind each label, even when the panel draws a capped row list (US-23). */
  providerCount: number;
  activityCount: number;
  modelCount: number;
  profileCount: number;
}

export interface UsageState {
  /** The active tab. `spend` is the token-usage view; `quota` is per-core. */
  tab: UsageTab;
  tabs: { id: UsageTab; label: string }[];
  /** Nothing recorded. The view shows its empty state, not zeroes. */
  empty: boolean;
  sort: UsageSort;
  sorts: { id: UsageSort; label: string }[];
  /** `All time · since Mar 4, 2026`, or `All time` when nothing was recorded. */
  scopeLabel: string;
  /** `Tokens, not cost` — the tokens-only note under the stats strip. */
  costNote: string;
  /** `Updated 10:42` — the header's last-push label (US-11). */
  updatedLabel: string;
  totals: UsageTotalsView;
  byProvider: UsageBreakdownRow[];
  byActivity: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  /** Graph spend rolled up per profile (Slice-6 T2); empty when none. */
  byProfile: UsageProfileRowView[];
  /** Host-built counts for each panel's `aria-label` (US-17). */
  counts: UsageCounts;
  tickets: UsageTicketRowView[];
  page: {
    offset: number;
    limit: number;
    groups: number;
    hasPrev: boolean;
    hasNext: boolean;
    /** The pager label, from `pageSummary` (@arch:NTF-07). */
    summary: string;
  };
  /** Per-core subscription quota, independent of the spend query. */
  quota: QuotaView;
  /** A rejected query, stated. Null when the query was well-formed. */
  error: string | null;
}

/** The usage panel's two tabs. */
export type UsageTab = 'spend' | 'quota';

export const USAGE_TABS: { id: UsageTab; label: string }[] = [
  { id: 'spend', label: 'Spend' },
  { id: 'quota', label: 'Quota' },
];

export interface UsageStateInput {
  /** The window's bound project. Absent = the all-projects recovery view. */
  projectId?: number | null;
  sort?: UsageSort;
  offset?: number;
  limit?: number;
  /** The active tab. Absent = spend. */
  tab?: UsageTab;
  /** Cached per-core quota snapshots from the service. */
  quota?: readonly QuotaSnapshot[];
  /** The manifest's warn threshold; absent = the loader default. */
  quotaThresholdPct?: number;
  /** Active account name of a core when not 'default'. */
  quotaAccountOf?: AccountOf;
  /** Injected clock — the rolling ranges are relative to it. */
  now?: () => Date;
  /** Injected locale/zone for deterministic dates; absent = the viewer's. */
  dateOptions?: DateTextOptions;
}

const SORT_LABELS: Record<UsageSort, string> = {
  total: 'Total tokens',
  input: 'Input tokens',
  output: 'Output tokens',
  calls: 'Calls',
  recent: 'Most recent',
};

/** The most rows a breakdown panel prints before folding the rest (US-23). */
export const BREAKDOWN_TOP_LIMIT = 6;

/** The synthetic row that carries the folded remainder. */
const OTHER_KEY = '__other__';

const EMPTY_TOTALS: UsageTotalsView = {
  calls: 0,
  totalDisplay: '0',
  totalExact: '0',
  totalNote: '0 tokens',
  inputDisplay: '0',
  outputDisplay: '0',
  reasoningDisplay: '0',
  cacheReadDisplay: '0',
  cacheWriteDisplay: '0',
  estimatedCalls: 0,
  estimatedNote: null,
  erroredCalls: 0,
  erroredNote: '',
};

/** The quota view an error or empty state renders without reading the service (US-2). */
export const EMPTY_QUOTA_VIEW: QuotaView = {
  thresholdPct: DEFAULT_QUOTA_WARN_THRESHOLD_PCT,
  rows: [],
  anyNear: false,
  subtitle: quotaWarnThresholdText(DEFAULT_QUOTA_WARN_THRESHOLD_PCT),
  summaryLine: null,
};

/** A model id the core never reported is named, not left blank. */
function modelLabel(key: string): string {
  return key === '' ? 'unreported' : key;
}

/** A provider id the core never reported is named, not left blank (US-4). */
function providerLabel(key: string): string {
  if (key === '' || key === OTHER_KEY) return key === '' ? 'Core not reported' : '';
  return AGENT_PROVIDER_LABELS[key as keyof typeof AGENT_PROVIDER_LABELS] ?? key;
}

function ticketRowLabel(row: UsageTicketRow): string {
  if (row.ticketId === null) return 'Not attributed to a ticket';
  const key = row.ticketKey ?? formatId('ticket', row.ticketId);
  return row.ticketTitle ? `${key} — ${row.ticketTitle}` : key;
}

/** Sum every numeric token field of `UsageTotals` across rows. */
function sumTotals(rows: UsageTotals[]): UsageTotals {
  const total: UsageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    freshTokens: 0,
    estimatedCalls: 0,
    erroredCalls: 0,
  };
  for (const row of rows) {
    total.calls += row.calls;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.reasoningTokens += row.reasoningTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.cacheWriteTokens += row.cacheWriteTokens;
    total.totalTokens += row.totalTokens;
    total.freshTokens += row.freshTokens;
    total.estimatedCalls += row.estimatedCalls;
    total.erroredCalls += row.erroredCalls;
  }
  return total;
}

function capRows<T>(rows: T[], merge: (rest: T[]) => T): { rows: T[]; restCount: number } {
  if (rows.length <= BREAKDOWN_TOP_LIMIT) return { rows, restCount: 0 };
  const rest = rows.slice(BREAKDOWN_TOP_LIMIT);
  return { rows: [...rows.slice(0, BREAKDOWN_TOP_LIMIT), merge(rest)], restCount: rest.length };
}

function breakdown(
  rows: UsageGroupRow[],
  freshTotal: number,
  label: (key: string) => string,
  title?: (key: string) => string | undefined,
): UsageBreakdownRow[] {
  // Every row's own figure is FRESH spend too — a call site or model that is
  // mostly cache reads must not claim a share of the raw tally it never
  // fresh-spent. `freshTokens` comes from the SAME SQL expression the query
  // ordered on, so the rendered order always matches the rendered numbers.
  return rows.map((row) => {
    const fresh = row.freshTokens;
    const rowTitle = title?.(row.key);
    return {
      key: row.key,
      label: label(row.key),
      ...(rowTitle !== undefined ? { title: rowTitle } : {}),
      calls: row.calls,
      callsText: plural(row.calls, 'call', 'calls'),
      totalTokens: fresh,
      totalDisplay: formatTokens(fresh),
      totalExact: formatExactTokens(fresh),
      inputDisplay: formatTokens(row.inputTokens),
      outputDisplay: formatTokens(row.outputTokens),
      share: shareOfTotal(fresh, freshTotal),
      shareDisplay: formatShare(fresh, freshTotal),
      estimated: row.calls > 0 && row.estimatedCalls === row.calls,
    };
  });
}

/**
 * A capped breakdown list: the top rows plus one `Other (n)` row that carries
 * the folded remainder's summed spend and calls (US-23).
 */
function cappedBreakdown(
  rows: UsageGroupRow[],
  freshTotal: number,
  label: (key: string) => string,
  title?: (key: string) => string | undefined,
): UsageBreakdownRow[] {
  const capped = capRows(rows, (rest) => ({ ...sumTotals(rest), key: OTHER_KEY }));
  return breakdown(
    capped.rows,
    freshTotal,
    (key) => (key === OTHER_KEY ? `Other (${capped.restCount})` : label(key)),
    title,
  );
}

function totalsView(stats: TokenUsageStats): UsageTotalsView {
  const t = stats.totals;
  // The headline is fresh spend; cache reads keep their own tile. The clamp
  // lives in the SQL that computes `freshTokens` — the two sums are
  // independent and a legacy row can carry reads its total never counted.
  const fresh = t.freshTokens;
  return {
    calls: t.calls,
    totalDisplay: formatTokens(fresh),
    totalExact: formatExactTokens(fresh),
    totalNote: `${formatExactTokens(fresh)} tokens`,
    inputDisplay: formatTokens(t.inputTokens),
    outputDisplay: formatTokens(t.outputTokens),
    reasoningDisplay: formatTokens(t.reasoningTokens),
    cacheReadDisplay: formatTokens(t.cacheReadTokens),
    cacheWriteDisplay: formatTokens(t.cacheWriteTokens),
    estimatedCalls: t.estimatedCalls,
    estimatedNote:
      t.estimatedCalls > 0
        ? `${t.estimatedCalls} of ${plural(t.calls, 'call', 'calls')} estimated`
        : null,
    erroredCalls: t.erroredCalls,
    erroredNote: t.erroredCalls > 0 ? `${t.erroredCalls} failed` : '',
  };
}

/**
 * A profile the run never resolved is NAMED — never a blank cell, never a "0"
 * that reads as a profile called zero. Its recorded spend is shown as
 * recorded; the one wrong answer this view must never give is a fabricated
 * zero on an unmeasured invocation.
 */
function profileLabel(key: string): string {
  return key === '' ? 'unknown profile' : key;
}

function profileRows(rows: UsageProfileRow[], freshTotal: number): UsageProfileRowView[] {
  const capped = capRows(rows, (rest) => ({ ...sumTotals(rest), profile: OTHER_KEY, provider: null }));
  return capped.rows.map((row) => {
    const fresh = row.freshTokens;
    const key = row.profile;
    const isOther = key === OTHER_KEY;
    return {
      key: isOther ? OTHER_KEY : key,
      label: isOther ? `Other (${capped.restCount})` : profileLabel(key),
      calls: row.calls,
      callsText: plural(row.calls, 'call', 'calls'),
      totalTokens: fresh,
      totalDisplay: formatTokens(fresh),
      totalExact: formatExactTokens(fresh),
      inputDisplay: formatTokens(row.inputTokens),
      outputDisplay: formatTokens(row.outputTokens),
      share: shareOfTotal(fresh, freshTotal),
      shareDisplay: formatShare(fresh, freshTotal),
      estimated: row.calls > 0 && row.estimatedCalls === row.calls,
      provider: row.provider,
      note: isOther ? undefined : row.provider === null ? 'provider unknown' : row.provider,
    };
  });
}

/** `No tickets`, `1–1 of 1 ticket`, `1–2 of 4 tickets` — one text for the pager. */
function pageSummary(offset: number, rowCount: number, groups: number): string {
  return groups === 0 ? 'No tickets' : `${offset + 1}–${offset + rowCount} of ${plural(groups, 'ticket', 'tickets')}`;
}

/** The shell every state shares — also what an error or empty state renders. */
function base(
  tab: UsageTab,
  quota: QuotaView,
  sort: UsageSort,
  offset: number,
  limit: number,
  now: Date,
  dateOptions: DateTextOptions,
): UsageState {
  return {
    tab,
    tabs: USAGE_TABS.map((t) => ({ id: t.id, label: t.label })),
    empty: true,
    sort,
    sorts: USAGE_SORTS.map((id) => ({ id, label: SORT_LABELS[id] })),
    scopeLabel: 'All time',
    costNote: 'Tokens, not cost',
    updatedLabel: `Updated ${formatCalendarDate(now.toISOString(), now, dateOptions)}`,
    totals: EMPTY_TOTALS,
    byProvider: [],
    byActivity: [],
    byModel: [],
    byProfile: [],
    counts: {
      providers: plural(0, 'agent core', 'agent cores'),
      activities: plural(0, 'activity', 'activities'),
      models: plural(0, 'model', 'models'),
      profiles: plural(0, 'profile', 'profiles'),
      tickets: plural(0, 'ticket', 'tickets'),
      providerCount: 0,
      activityCount: 0,
      modelCount: 0,
      profileCount: 0,
    },
    tickets: [],
    page: { offset, limit, groups: 0, hasPrev: offset > 0, hasNext: false, summary: pageSummary(offset, 0, 0) },
    quota,
    error: null,
  };
}

/**
 * The state a host read failure renders (US-2): the page's shell with a stated
 * error and no store or quota read. Never the exception text — the user gets
 * one actionable sentence and a way out.
 */
export function usageErrorState(
  input: { tab: UsageTab; sort: UsageSort; offset: number; limit: number },
  message: string,
  now: Date = new Date(),
  dateOptions: DateTextOptions = {},
): UsageState {
  return {
    ...base(input.tab, EMPTY_QUOTA_VIEW, input.sort, input.offset, input.limit, now, dateOptions),
    error: message,
  };
}

/**
 * Build the whole view from the store. Validates its own inputs through
 * `parseUsageQuery` — the sort arrives from the webview, which is a
 * trust boundary, and the SAME validator guards it here as would guard an
 * external API call.
 */
export function buildUsageState(store: Store, input: UsageStateInput = {}): UsageState {
  const sort = input.sort ?? 'total';
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_USAGE_LIMIT;
  const tab = input.tab ?? 'spend';
  const now = input.now?.() ?? new Date();
  const dateOptions = input.dateOptions ?? {};
  const thresholdPct = input.quotaThresholdPct ?? DEFAULT_QUOTA_WARN_THRESHOLD_PCT;
  const quota = buildQuotaView(input.quota ?? [], thresholdPct, now, input.quotaAccountOf);

  const parsed = parseUsageQuery({
    ...(input.projectId != null ? { projectId: input.projectId } : {}),
    from: null,
    to: null,
    sort,
    offset,
    limit,
  });
  if (!parsed.ok) {
    return { ...base(tab, quota, sort, offset, limit, now, dateOptions), error: parsed.error };
  }

  const stats = queryTokenUsageStats(store, parsed.query);
  // The share denominator is FRESH spend, matching the headline (`totalsView`),
  // every breakdown row and the ORDER BY — a raw-total denominator would let
  // cache-read-heavy rows claim shares of tokens nothing fresh-spent.
  const total = stats.totals.freshTokens;

  return {
    ...base(tab, quota, sort, offset, limit, now, dateOptions),
    empty: stats.totals.calls === 0,
    scopeLabel: stats.firstAt ? `All time · since ${formatLongDate(stats.firstAt, dateOptions)}` : 'All time',
    totals: totalsView(stats),
    byProvider: cappedBreakdown(stats.byProvider, total, providerLabel),
    byActivity: cappedBreakdown(
      stats.byCallSite,
      total,
      aiCallSiteLabel,
      (key) => (key === 'unknown' ? 'The call site did not declare an activity' : undefined),
    ),
    byModel: cappedBreakdown(stats.byModel, total, modelLabel),
    byProfile: profileRows(stats.byProfile, total),
    counts: {
      providers: plural(stats.byProvider.length, 'agent core', 'agent cores'),
      activities: plural(stats.byCallSite.length, 'activity', 'activities'),
      models: plural(stats.byModel.length, 'model', 'models'),
      profiles: plural(stats.byProfile.length, 'profile', 'profiles'),
      tickets: plural(stats.ticketGroups, 'ticket', 'tickets'),
      providerCount: stats.byProvider.length,
      activityCount: stats.byCallSite.length,
      modelCount: stats.byModel.length,
      profileCount: stats.byProfile.length,
    },
    tickets: stats.byTicket.map((row) => {
      // Same expression the query sorted and paginated on.
      const fresh = row.freshTokens;
      return {
        ticketId: row.ticketId,
        ticketKey: row.ticketKey ?? (row.ticketId !== null ? formatId('ticket', row.ticketId) : null),
        ticketTitle: row.ticketTitle,
        label: ticketRowLabel(row),
        calls: row.calls,
        totalTokens: fresh,
        totalDisplay: formatTokens(fresh),
        totalExact: formatExactTokens(fresh),
        inputDisplay: formatTokens(row.inputTokens),
        outputDisplay: formatTokens(row.outputTokens),
        lastAt: row.lastAt,
        lastDisplay: row.lastAt === null ? '' : formatCalendarDate(row.lastAt, now, dateOptions),
        lastTitle: formatFullDateTime(row.lastAt, dateOptions),
        share: shareOfTotal(fresh, total),
        estimated: row.calls > 0 && row.estimatedCalls === row.calls,
      };
    }),
    page: {
      offset,
      limit,
      groups: stats.ticketGroups,
      hasPrev: offset > 0,
      hasNext: offset + stats.byTicket.length < stats.ticketGroups,
      summary: pageSummary(offset, stats.byTicket.length, stats.ticketGroups),
    },
  };
}
