import type { Store } from './db.js';
import type { TokenUsage } from '../agent/tokenUsage.js';
import type { UsageQuery, UsageSort } from './tokenUsageQuery.js';

/**
 * Append and aggregate the token-usage ledger (§ token consumption stats).
 *
 * Writing is one INSERT — deliberately the cheapest thing in the module, because
 * it happens on the AI call's own path and must never be worth skipping.
 *
 * Reading is FOUR aggregate queries (overall, by call site, by model, by
 * ticket), each a GROUP BY that SQLite answers off the v17 indexes. None of them
 * selects a row: the alternative — pull the range into JS and reduce it — is an
 * unbounded in-memory rollup whose cost grows with history, and history here
 * only ever grows. The per-ticket page is LIMIT/OFFSET'd, and its full group
 * count comes back separately so the view can page without having read the rest.
 *
 * `store.db.prepare(...).get/all/run` with positional `?` only, per the
 * driver-agnostic rule — the same helpers must work under `node:sqlite` if the
 * CLI ever grows a stats verb.
 */

/** What is summed for any grouping. Same shape overall, per site, per ticket. */
export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Calls whose counts were estimated because the core reported none. */
  estimatedCalls: number;
  /** Calls that failed. The tokens were still spent, so they still count. */
  erroredCalls: number;
}

export interface UsageGroupRow extends UsageTotals {
  /** The call site or model id. `''` = the core never named a model. */
  key: string;
}

export interface UsageTicketRow extends UsageTotals {
  /** NULL for calls made before the ticket existed (a ticket-form draft). */
  ticketId: number | null;
  ticketKey: string | null;
  ticketTitle: string | null;
  /** Most recent call in range, ISO-8601 — what `sort: 'recent'` orders on. */
  lastAt: string | null;
}

export interface TokenUsageStats {
  totals: UsageTotals;
  byCallSite: UsageGroupRow[];
  byModel: UsageGroupRow[];
  /** One page of the per-ticket table, ordered by the query's `sort`. */
  byTicket: UsageTicketRow[];
  /** Distinct tickets in range — the page's denominator. */
  ticketGroups: number;
  range: { from: string | null; to: string | null };
}

/** The zero every empty range reports. Not an error — nothing was spent yet. */
export const EMPTY_USAGE_TOTALS: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  estimatedCalls: 0,
  erroredCalls: 0,
};

export interface TokenUsageEntry {
  projectId: number | null;
  ticketId: number | null;
  /**
   * The inside process run this call belongs to (v27, § task 3); NULL for a
   * call a caller made without naming a process, or a pre-v27 row.
   */
  processRunId?: number | null;
  /**
   * v28: the implementation segment this call was made inside (an interactive
   * session). NULL for calls made outside a segment — and every call today:
   * Task 5 adds the measured ingestion seam that writes it.
   */
  implementationSegmentId?: number | null;
  /** An `AiCallSite`; typed as string here so the store stays agent-free. */
  callSite: string;
  provider?: string | null;
  usage: TokenUsage;
  /** Whether the call itself succeeded. A failure still burned its input. */
  outcome: 'ok' | 'error';
  /** ISO-8601; defaults to now. Injected by tests, never by a call site. */
  recordedAt?: string;
}

const INSERT = `
INSERT INTO token_usage (
  project_id, ticket_id, process_run_id, call_site, provider, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
  estimated, outcome, recorded_at, implementation_segment_id, interactive_usage_sample_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`;

/**
 * Append one call to the ledger. Throws only on a genuine store failure — the
 * caller (`instrumentedAdapter`) swallows and logs, because a bookkeeping fault
 * must never surface as a failure of the AI feature it was measuring.
 */
export function recordTokenUsage(store: Store, entry: TokenUsageEntry): void {
  const u = entry.usage;
  store.db
    .prepare(INSERT)
    .run(
      entry.projectId,
      entry.ticketId,
      entry.processRunId ?? null,
      entry.callSite,
      entry.provider ?? null,
      u.model,
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.totalTokens,
      u.estimated ? 1 : 0,
      entry.outcome,
      entry.recordedAt ?? new Date().toISOString(),
      entry.implementationSegmentId ?? null,
    );
}

/**
 * The SUM/COUNT list every grouping shares, so the four queries cannot drift
 * apart. `p` prefixes the columns with a table alias for the per-ticket query,
 * which joins `tickets` — the two tables share `project_id`, so an unqualified
 * reference there is ambiguous.
 */
function aggregates(p = ''): string {
  return `
  COUNT(*) AS calls,
  COALESCE(SUM(${p}input_tokens), 0) AS input_tokens,
  COALESCE(SUM(${p}output_tokens), 0) AS output_tokens,
  COALESCE(SUM(${p}cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(${p}cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(${p}total_tokens), 0) AS total_tokens,
  COALESCE(SUM(${p}estimated), 0) AS estimated_calls,
  COALESCE(SUM(CASE WHEN ${p}outcome = 'error' THEN 1 ELSE 0 END), 0) AS errored_calls`;
}

interface TotalsRow {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  estimated_calls: number;
  errored_calls: number;
}

function toTotals(row: TotalsRow): UsageTotals {
  return {
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    totalTokens: row.total_tokens,
    estimatedCalls: row.estimated_calls,
    erroredCalls: row.errored_calls,
  };
}

/**
 * ORDER BY expressions for the per-ticket table. A closed map, not string
 * concatenation of a caller's value: `sort` is the ONE query field that cannot
 * be bound as a parameter, and `parseUsageQuery` has already narrowed it to a
 * key of this object before it gets here.
 */
const SORT_EXPRESSIONS: Record<UsageSort, string> = {
  total: 'total_tokens DESC',
  input: 'input_tokens DESC',
  output: 'output_tokens DESC',
  calls: 'calls DESC',
  recent: 'last_at DESC',
};

/**
 * The shared WHERE clause + its positional parameters. `p` is the table alias
 * prefix, for the same ambiguity reason as `aggregates`. The clause is built
 * from the query's SHAPE only — every value is bound, never interpolated.
 */
function filter(
  query: UsageQuery,
  p = '',
): { clause: string; params: (number | string)[] } {
  const parts: string[] = [];
  const params: (number | string)[] = [];
  if (query.projectId !== null) {
    parts.push(`${p}project_id = ?`);
    params.push(query.projectId);
  }
  if (query.ticketId !== null) {
    parts.push(`${p}ticket_id = ?`);
    params.push(query.ticketId);
  }
  if (query.from !== null) {
    parts.push(`${p}recorded_at >= ?`);
    params.push(query.from);
  }
  if (query.to !== null) {
    parts.push(`${p}recorded_at <= ?`);
    params.push(query.to);
  }
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

function groupBy(
  store: Store,
  column: string,
  { clause, params }: { clause: string; params: (number | string)[] },
): UsageGroupRow[] {
  const rows = store.db
    .prepare(
      `SELECT COALESCE(${column}, '') AS key, ${aggregates()}
       FROM token_usage ${clause}
       GROUP BY COALESCE(${column}, '')
       ORDER BY total_tokens DESC, key ASC`,
    )
    .all(...params) as (TotalsRow & { key: string })[];
  return rows.map((row) => ({ key: row.key, ...toTotals(row) }));
}

/**
 * The stats view's whole read. `query` must have come from `parseUsageQuery` —
 * this function assumes its fields are already narrowed (notably `sort`).
 */
export function queryTokenUsageStats(store: Store, query: UsageQuery): TokenUsageStats {
  const where = filter(query);

  const joined = filter(query, 'u.');

  const totalsRow = store.db
    .prepare(`SELECT ${aggregates()} FROM token_usage ${where.clause}`)
    .get(...where.params) as TotalsRow | undefined;

  const ticketGroupsRow = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT ticket_id FROM token_usage ${where.clause} GROUP BY ticket_id
       )`,
    )
    .get(...where.params) as { n: number } | undefined;

  const ticketRows = store.db
    .prepare(
      `SELECT u.ticket_id AS ticket_id,
              t.key AS ticket_key,
              t.title AS ticket_title,
              MAX(u.recorded_at) AS last_at,
              ${aggregates('u.')}
       FROM token_usage u
       LEFT JOIN tickets t ON t.id = u.ticket_id
       ${joined.clause}
       GROUP BY u.ticket_id
       ORDER BY ${SORT_EXPRESSIONS[query.sort]}, u.ticket_id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...joined.params, query.limit, query.offset) as (TotalsRow & {
    ticket_id: number | null;
    ticket_key: string | null;
    ticket_title: string | null;
    last_at: string | null;
  })[];

  return {
    totals: totalsRow ? toTotals(totalsRow) : EMPTY_USAGE_TOTALS,
    byCallSite: groupBy(store, 'call_site', where),
    byModel: groupBy(store, 'model', where),
    byTicket: ticketRows.map((row) => ({
      ticketId: row.ticket_id,
      ticketKey: row.ticket_key,
      ticketTitle: row.ticket_title,
      lastAt: row.last_at,
      ...toTotals(row),
    })),
    ticketGroups: ticketGroupsRow?.n ?? 0,
    range: { from: query.from, to: query.to },
  };
}

/**
 * One ledger row as evidence (§ task 3). The raw facts the inside view needs to
 * show a process's spend: counts, outcome, and the ticket/process-run linkage.
 */
export interface TokenUsageRow {
  id: number;
  ticketId: number | null;
  processRunId: number | null;
  callSite: string;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Whether the counts are an estimate because the core reported none. */
  estimated: boolean;
  outcome: 'ok' | 'error';
  recordedAt: string;
  /**
   * v28: the implementation segment the call was made inside; NULL outside a
   * segment (Task 5 writes it for measured interactive deltas).
   */
  implementationSegmentId: number | null;
}

interface TokenUsageRowRow {
  id: number;
  ticket_id: number | null;
  process_run_id: number | null;
  call_site: string;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  estimated: number;
  outcome: string;
  recorded_at: string;
  implementation_segment_id: number | null;
}

function rowToUsage(r: TokenUsageRowRow): TokenUsageRow {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    processRunId: r.process_run_id,
    callSite: r.call_site,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    estimated: r.estimated === 1,
    // An unrecognized outcome degrades to 'error' — never silently 'ok'.
    outcome: r.outcome === 'ok' ? 'ok' : 'error',
    recordedAt: r.recorded_at,
    implementationSegmentId: r.implementation_segment_id,
  };
}

/** Narrow a ledger list. Every field is optional; an empty filter lists all. */
export interface TokenUsageListFilter {
  ticketId?: number;
  processRunId?: number;
}

/**
 * The ledger rows matching a filter, oldest first (call order).
 *
 * Deliberately NOT the stats view: this returns evidence, one row per call,
 * for a surface (the inside view) that shows a process's individual calls.
 * Rows written before process-run linkage (NULL `process_run_id`) are returned
 * by ticket-scoped reads like any other row — an unattributed call is still
 * the ticket's spend.
 */
export function listTokenUsage(
  store: Store,
  filter: TokenUsageListFilter = {},
): TokenUsageRow[] {
  const parts: string[] = [];
  const params: number[] = [];
  if (filter.ticketId !== undefined) {
    parts.push('ticket_id = ?');
    params.push(filter.ticketId);
  }
  if (filter.processRunId !== undefined) {
    parts.push('process_run_id = ?');
    params.push(filter.processRunId);
  }
  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  return store.db
    .prepare(
      `SELECT id, ticket_id, process_run_id, call_site, provider, model,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              total_tokens, estimated, outcome, recorded_at,
              implementation_segment_id
         FROM token_usage ${where}
        ORDER BY id`,
    )
    .all(...params)
    .map((r) => rowToUsage(r as TokenUsageRowRow));
}

/** Measured spend of one ticket — input/output/total across RECORDED calls. */
export interface RecordedUsageSummary {
  input: number;
  output: number;
  total: number;
}

/**
 * The RECORDED (measured) spend of a ticket: sums over calls the core actually
 * reported counts for.
 *
 * `estimated = 0` is a WHERE clause, not a SUM condition: an estimate is not
 * measured spend, and a ticket whose every call fell back to an estimate must
 * read as zero recorded — never as a measured total. The query still runs
 * against the v19 indexes (`idx_token_usage_ticket`).
 */
export function summarizeRecordedTokenUsage(
  store: Store,
  ticketId: number,
): RecordedUsageSummary {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(total_tokens), 0) AS total
         FROM token_usage
        WHERE ticket_id = ? AND estimated = 0`,
    )
    .get(ticketId) as { input: number; output: number; total: number };
  return row;
}
