import type { Store } from '../../store/db.js';
import {
  queryTokenUsageStats,
  type TokenUsageStats,
  type UsageGroupRow,
  type UsageTicketRow,
} from '../../store/tokenUsage.js';
import {
  DEFAULT_USAGE_LIMIT,
  DEFAULT_USAGE_RANGE,
  DEFAULT_USAGE_SORT,
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

/** A formatted row of the by-call-site / by-model breakdowns. */
export interface UsageBreakdownRow {
  key: string;
  label: string;
  calls: number;
  totalTokens: number;
  totalDisplay: string;
  totalExact: string;
  /** The same spend in input-equivalents (`store/tokenWeights.ts`). */
  effectiveDisplay: string;
  effectiveExact: string;
  inputDisplay: string;
  outputDisplay: string;
  /**
   * Percentage of the range's EFFECTIVE total, 0–100. Drives the bar width, and
   * it is the effective total on purpose: the rows are ranked on that number, so
   * a bar sized off the raw sum would contradict the order it sits in.
   */
  share: number;
  /** True when every call in this group had estimated counts. */
  estimated: boolean;
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
  effectiveDisplay: string;
  effectiveExact: string;
  inputDisplay: string;
  outputDisplay: string;
  /** Last call in range, ISO-8601 — the webview renders it as a local date. */
  lastAt: string | null;
  share: number;
  estimated: boolean;
}

export interface UsageTotalsView {
  calls: number;
  totalDisplay: string;
  totalExact: string;
  effectiveDisplay: string;
  effectiveExact: string;
  inputDisplay: string;
  outputDisplay: string;
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
  /**
   * Spend per AI call site. NOT per workflow stage — karst meters its own
   * headless calls (`agent/instrumentedAdapter.ts`) and nothing else, so the
   * agent session a human drives in the terminal is absent by construction. The
   * field was called `byStage` and the panel said "By stage", which read as
   * "implementation cost nothing" rather than "implementation is not measured".
   */
  byCallSite: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
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
  effective: 'Effective tokens',
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
  effectiveDisplay: '0',
  effectiveExact: '0',
  inputDisplay: '0',
  outputDisplay: '0',
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
    effectiveDisplay: formatTokens(row.effectiveTokens),
    effectiveExact: formatExactTokens(row.effectiveTokens),
    inputDisplay: formatTokens(row.inputTokens),
    outputDisplay: formatTokens(row.outputTokens),
    share: shareOfTotal(row.effectiveTokens, total),
    estimated: row.calls > 0 && row.estimatedCalls === row.calls,
  }));
}

function totalsView(stats: TokenUsageStats): UsageTotalsView {
  const t = stats.totals;
  return {
    calls: t.calls,
    totalDisplay: formatTokens(t.totalTokens),
    totalExact: formatExactTokens(t.totalTokens),
    effectiveDisplay: formatTokens(t.effectiveTokens),
    effectiveExact: formatExactTokens(t.effectiveTokens),
    inputDisplay: formatTokens(t.inputTokens),
    outputDisplay: formatTokens(t.outputTokens),
    cacheReadDisplay: formatTokens(t.cacheReadTokens),
    cacheWriteDisplay: formatTokens(t.cacheWriteTokens),
    estimatedCalls: t.estimatedCalls,
    erroredCalls: t.erroredCalls,
  };
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
    byCallSite: [],
    byModel: [],
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
  const sort = input.sort ?? DEFAULT_USAGE_SORT;
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
  // Shares are of the effective total, matching the order the rows arrive in.
  const total = stats.totals.effectiveTokens;

  return {
    ...base(rangeId, sort, offset, limit),
    empty: stats.totals.calls === 0,
    totals: totalsView(stats),
    byCallSite: breakdown(stats.byCallSite, total, aiCallSiteLabel),
    byModel: breakdown(stats.byModel, total, modelLabel),
    tickets: stats.byTicket.map((row) => ({
      ticketId: row.ticketId,
      ticketKey: row.ticketKey,
      label: ticketRowLabel(row),
      calls: row.calls,
      totalTokens: row.totalTokens,
      totalDisplay: formatTokens(row.totalTokens),
      totalExact: formatExactTokens(row.totalTokens),
      effectiveDisplay: formatTokens(row.effectiveTokens),
      effectiveExact: formatExactTokens(row.effectiveTokens),
      inputDisplay: formatTokens(row.inputTokens),
      outputDisplay: formatTokens(row.outputTokens),
      lastAt: row.lastAt,
      share: shareOfTotal(row.effectiveTokens, total),
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
