import type { Store } from '../../store/db.js';
import {
  queryTokenUsageStats,
  type TokenUsageStats,
  type UsageGroupRow,
  type UsageProfileRow,
  type UsageTicketRow,
} from '../../store/tokenUsage.js';
import {
  DEFAULT_USAGE_LIMIT,
  DEFAULT_USAGE_RANGE,
  parseUsageQuery,
  resolveUsageRange,
  USAGE_RANGES,
  USAGE_SORTS,
  type UsageSort,
} from '../../store/tokenUsageQuery.js';
import { aiCallSiteLabel } from '../../agent/aiCallSites.js';
import { formatExactTokens, formatTokens, shareOfTotal } from '../../model/tokenFormat.js';

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

/** A formatted row of the by-stage / by-model breakdowns. */
export interface UsageBreakdownRow {
  key: string;
  label: string;
  calls: number;
  totalTokens: number;
  totalDisplay: string;
  totalExact: string;
  inputDisplay: string;
  outputDisplay: string;
  /** Percentage of the range's total tokens, 0–100. Drives the bar width. */
  share: number;
  /** True when every call in this group had estimated counts. */
  estimated: boolean;
  /** A host-resolved annotation rendered on the row's meta line, if any. */
  note?: string;
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
  label: string;
  calls: number;
  totalTokens: number;
  totalDisplay: string;
  totalExact: string;
  inputDisplay: string;
  outputDisplay: string;
  /** Last call in range, ISO-8601 — the webview renders it as a local date. */
  lastAt: string | null;
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
  inputDisplay: string;
  outputDisplay: string;
  /** v45: reasoning tokens — output-billed, counted apart from output. */
  reasoningDisplay: string;
  cacheReadDisplay: string;
  cacheWriteDisplay: string;
  estimatedCalls: number;
  erroredCalls: number;
}

export interface UsageState {
  /** Nothing recorded in range. The view shows its empty state, not zeroes. */
  empty: boolean;
  rangeId: string;
  ranges: { id: string; label: string }[];
  sort: UsageSort;
  sorts: { id: UsageSort; label: string }[];
  totals: UsageTotalsView;
  byStage: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  /** Graph spend rolled up per profile (Slice-6 T2); empty when none in range. */
  byProfile: UsageProfileRowView[];
  tickets: UsageTicketRowView[];
  page: { offset: number; limit: number; groups: number; hasPrev: boolean; hasNext: boolean };
  /** A rejected query, stated. Null when the query was well-formed. */
  error: string | null;
}

export interface UsageStateInput {
  /** The window's bound project. Absent = the all-projects recovery view. */
  projectId?: number | null;
  rangeId?: string;
  sort?: UsageSort;
  offset?: number;
  limit?: number;
  /** Injected clock — the rolling ranges are relative to it. */
  now?: () => Date;
}

const SORT_LABELS: Record<UsageSort, string> = {
  total: 'Total tokens',
  input: 'Input tokens',
  output: 'Output tokens',
  calls: 'Calls',
  recent: 'Most recent',
};

const EMPTY_TOTALS: UsageTotalsView = {
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
};

/** A model id the core never reported is named, not left blank. */
function modelLabel(key: string): string {
  return key === '' ? 'unreported' : key;
}

function ticketRowLabel(row: UsageTicketRow): string {
  if (row.ticketId === null) return 'Not attributed to a ticket';
  const key = row.ticketKey ?? `#${row.ticketId}`;
  return row.ticketTitle ? `${key} — ${row.ticketTitle}` : key;
}

function breakdown(
  rows: UsageGroupRow[],
  total: number,
  label: (key: string) => string,
): UsageBreakdownRow[] {
  return rows.map((row) => ({
    key: row.key,
    label: label(row.key),
    calls: row.calls,
    totalTokens: row.totalTokens,
    totalDisplay: formatTokens(row.totalTokens),
    totalExact: formatExactTokens(row.totalTokens),
    inputDisplay: formatTokens(row.inputTokens),
    outputDisplay: formatTokens(row.outputTokens),
    share: shareOfTotal(row.totalTokens, total),
    estimated: row.calls > 0 && row.estimatedCalls === row.calls,
  }));
}

function totalsView(stats: TokenUsageStats): UsageTotalsView {
  const t = stats.totals;
  // The headline is fresh spend; cache reads keep their own tile. Clamped at
  // zero — the two sums are independent and a legacy row can carry reads its
  // total never counted, which must never render as a negative headline.
  const fresh = Math.max(0, t.totalTokens - t.cacheReadTokens);
  return {
    calls: t.calls,
    totalDisplay: formatTokens(fresh),
    totalExact: formatExactTokens(fresh),
    inputDisplay: formatTokens(t.inputTokens),
    outputDisplay: formatTokens(t.outputTokens),
    reasoningDisplay: formatTokens(t.reasoningTokens),
    cacheReadDisplay: formatTokens(t.cacheReadTokens),
    cacheWriteDisplay: formatTokens(t.cacheWriteTokens),
    estimatedCalls: t.estimatedCalls,
    erroredCalls: t.erroredCalls,
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

function profileRows(rows: UsageProfileRow[], total: number): UsageProfileRowView[] {
  return rows.map((row) => ({
    key: row.profile,
    label: profileLabel(row.profile),
    calls: row.calls,
    totalTokens: row.totalTokens,
    totalDisplay: formatTokens(row.totalTokens),
    totalExact: formatExactTokens(row.totalTokens),
    inputDisplay: formatTokens(row.inputTokens),
    outputDisplay: formatTokens(row.outputTokens),
    share: shareOfTotal(row.totalTokens, total),
    estimated: row.calls > 0 && row.estimatedCalls === row.calls,
    provider: row.provider,
    note: row.provider === null ? 'provider unknown' : row.provider,
  }));
}

/** The shell every state shares — also what an error or empty range renders. */
function base(rangeId: string, sort: UsageSort, offset: number, limit: number): UsageState {
  return {
    empty: true,
    rangeId,
    ranges: USAGE_RANGES.map((r) => ({ id: r.id, label: r.label })),
    sort,
    sorts: USAGE_SORTS.map((id) => ({ id, label: SORT_LABELS[id] })),
    totals: EMPTY_TOTALS,
    byStage: [],
    byModel: [],
    byProfile: [],
    tickets: [],
    page: { offset, limit, groups: 0, hasPrev: offset > 0, hasNext: false },
    error: null,
  };
}

/**
 * Build the whole view from the store. Validates its own inputs through
 * `parseUsageQuery` — the range and sort arrive from the webview, which is a
 * trust boundary, and the SAME validator guards them here as would guard an
 * external API call.
 */
export function buildUsageState(store: Store, input: UsageStateInput = {}): UsageState {
  const rangeId = input.rangeId ?? DEFAULT_USAGE_RANGE;
  const sort = input.sort ?? 'total';
  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_USAGE_LIMIT;
  const now = input.now?.() ?? new Date();
  const { from, to } = resolveUsageRange(rangeId, now);

  const parsed = parseUsageQuery({
    ...(input.projectId != null ? { projectId: input.projectId } : {}),
    from,
    to,
    sort,
    offset,
    limit,
  });
  if (!parsed.ok) return { ...base(rangeId, sort, offset, limit), error: parsed.error };

  const stats = queryTokenUsageStats(store, parsed.query);
  const total = stats.totals.totalTokens;

  return {
    ...base(rangeId, sort, offset, limit),
    empty: stats.totals.calls === 0,
    totals: totalsView(stats),
    byStage: breakdown(stats.byCallSite, total, aiCallSiteLabel),
    byModel: breakdown(stats.byModel, total, modelLabel),
    byProfile: profileRows(stats.byProfile, total),
    tickets: stats.byTicket.map((row) => ({
      ticketId: row.ticketId,
      ticketKey: row.ticketKey,
      label: ticketRowLabel(row),
      calls: row.calls,
      totalTokens: row.totalTokens,
      totalDisplay: formatTokens(row.totalTokens),
      totalExact: formatExactTokens(row.totalTokens),
      inputDisplay: formatTokens(row.inputTokens),
      outputDisplay: formatTokens(row.outputTokens),
      lastAt: row.lastAt,
      share: shareOfTotal(row.totalTokens, total),
      estimated: row.calls > 0 && row.estimatedCalls === row.calls,
    })),
    page: {
      offset,
      limit,
      groups: stats.ticketGroups,
      hasPrev: offset > 0,
      hasNext: offset + stats.byTicket.length < stats.ticketGroups,
    },
  };
}
