import type { Store } from './db.js';
import type { TokenUsage } from '../agent/tokenUsage.js';
import type { UsageQuery, UsageSort } from './tokenUsageQuery.js';

/**
 * Append and aggregate the token-usage ledger (§ token consumption stats).
 *
 * Writing is one INSERT — deliberately the cheapest thing in the module, because
 * it happens on the AI call's own path and must never be worth skipping.
 *
 * Reading is FIVE aggregate queries (overall, by call site, by model, by ticket,
 * by graph profile), each a GROUP BY. The first four SQLite answers off the v17
 * indexes; the profile rollup rides LEFT JOINs to `approach_node_runs`/
 * `approach_planner_runs` by primary key instead, since a profile is a fact of
 * the RUN a usage row was attributed to, not of the row's own range. None of
 * them selects a row: the alternative — pull the range into JS and reduce it — is an
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
  /** v45: reasoning tokens the core counted apart from output. */
  reasoningTokens: number;
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

/**
 * Graph-attributed spend rolled up per profile (Slice-6 T2). The profile is READ
 * from the run row through the join (`approach_node_runs.profile` /
 * `approach_planner_runs.profile`) — no `token_usage` column carries it.
 */
export interface UsageProfileRow extends UsageTotals {
  /** The profile name resolved on the node/planner run. `''` = never resolved. */
  profile: string;
  /** The provider the spend is attributed to; NULL = the core never named one. */
  provider: string | null;
}

export interface TokenUsageStats {
  totals: UsageTotals;
  byCallSite: UsageGroupRow[];
  byModel: UsageGroupRow[];
  /** One page of the per-ticket table, ordered by the query's `sort`. */
  byTicket: UsageTicketRow[];
  /** Distinct tickets in range — the page's denominator. */
  ticketGroups: number;
  /**
   * Graph spend grouped by (profile, provider) through the node/planner run
   * join (Slice-6 T2). Rows with no graph linkage are absent — this is the
   * graph runtime's spend, not the ticket's whole spend.
   */
  byProfile: UsageProfileRow[];
  range: { from: string | null; to: string | null };
}

/** The zero every empty range reports. Not an error — nothing was spent yet. */
export const EMPTY_USAGE_TOTALS: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
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
  /**
   * v35: the graph planner run the call was made inside (Slice-3 T10); NULL
   * outside the graph runtime, or a pre-v35 row. Never backfilled. ON DELETE
   * SET NULL: deleting graph history never takes the ledger's spend with it.
   */
  approachPlannerRunId?: number | null;
  /** v35: the graph node run the call was made inside (Slice-3 T10). */
  approachNodeRunId?: number | null;
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
  input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens,
  estimated, outcome, recorded_at, implementation_segment_id, interactive_usage_sample_id,
  approach_planner_run_id, approach_node_run_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`;

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
      u.reasoningTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.totalTokens,
      u.estimated ? 1 : 0,
      entry.outcome,
      entry.recordedAt ?? new Date().toISOString(),
      entry.implementationSegmentId ?? null,
      entry.approachPlannerRunId ?? null,
      entry.approachNodeRunId ?? null,
    );
}

/**
 * The most recently used model ids per provider, newest first, capped per
 * provider. This is the evidence the unified agent picker's "Last used" group
 * renders — a provider with a long catalog (opencode) buries a user's habitual
 * pick, so the picker pins the models they actually used to the top.
 *
 * Read from `token_usage`: the append-only ledger of every AI call, which is
 * the authoritative record of "models actually used" (headless gates AND
 * measured interactive sessions both land a row). `provider`/`model` filter to
 * rows the core actually named; the GROUP BY collapses each (provider, model)
 * pair to its most recent call, and global recency ordering (newest first)
 * gives each provider its own newest-first list as it is populated. Rows whose
 * core never named a model are not usage evidence of any model, so they are
 * skipped. Project-scoped like every other ticket-adjacent read — the DB is
 * shared by every IDE window.
 */
export function listRecentlyUsedModels(
  store: Store,
  projectId: number | null,
  limit = 5,
): Record<string, string[]> {
  const rows = store.db
    .prepare(
      `SELECT provider, model, MAX(recorded_at) AS last_at
         FROM token_usage
        WHERE project_id = ? AND provider IS NOT NULL AND model IS NOT NULL AND model != ''
        GROUP BY provider, model
        ORDER BY last_at DESC`,
    )
    .all(projectId) as { provider: string; model: string; last_at: string }[];
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const list = (out[row.provider] ??= []);
    if (list.length < limit) list.push(row.model);
  }
  return out;
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
  COALESCE(SUM(${p}reasoning_tokens), 0) AS reasoning_tokens,
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
  reasoning_tokens: number;
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
    reasoningTokens: row.reasoning_tokens,
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

  // The graph-spend rollup (Slice-6 T2): same range/scope as the rest of the
  // view, but ONLY rows linked to a graph run. The profile is read from the run
  // row through the JOIN — the join is the point, no token_usage column is
  // added. The WHERE is the query's shape (all values bound) plus the
  // graph-attribution scope; the scan still rides `idx_token_usage_*` and the
  // run lookups ride their PKs.
  const graphFilter = filter(query, 't.');
  const graphScope = '(t.approach_node_run_id IS NOT NULL OR t.approach_planner_run_id IS NOT NULL)';
  const graphWhere = graphFilter.clause
    ? `WHERE ${graphScope} AND ${graphFilter.clause.replace(/^WHERE /, '')}`
    : `WHERE ${graphScope}`;
  const profileRows = store.db
    .prepare(
      `SELECT COALESCE(nr.profile, pr.profile, '') AS profile,
              t.provider AS provider,
              ${aggregates('t.')}
         FROM token_usage t
         LEFT JOIN approach_node_runs nr ON nr.id = t.approach_node_run_id
         LEFT JOIN approach_planner_runs pr ON pr.id = t.approach_planner_run_id
         ${graphWhere}
        GROUP BY COALESCE(nr.profile, pr.profile, ''), t.provider
        ORDER BY total_tokens DESC, profile ASC, provider ASC`,
    )
    .all(...graphFilter.params) as (TotalsRow & { profile: string; provider: string | null })[];

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
    byProfile: profileRows.map((row) => ({
      profile: row.profile,
      provider: row.provider,
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
  /** v45: reasoning tokens the core counted apart from output. */
  reasoningTokens: number;
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
  /**
   * v35: the graph planner run the call was made inside; NULL outside the
   * graph runtime (Slice-3 T10). Never backfilled.
   */
  approachPlannerRunId: number | null;
  /** v35: the graph node run the call was made inside (Slice-3 T10). */
  approachNodeRunId: number | null;
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
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  estimated: number;
  outcome: string;
  recorded_at: string;
  implementation_segment_id: number | null;
  approach_planner_run_id: number | null;
  approach_node_run_id: number | null;
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
    reasoningTokens: r.reasoning_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    estimated: r.estimated === 1,
    // An unrecognized outcome degrades to 'error' — never silently 'ok'.
    outcome: r.outcome === 'ok' ? 'ok' : 'error',
    recordedAt: r.recorded_at,
    implementationSegmentId: r.implementation_segment_id,
    approachPlannerRunId: r.approach_planner_run_id,
    approachNodeRunId: r.approach_node_run_id,
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
              input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
              cache_write_tokens,
              total_tokens, estimated, outcome, recorded_at,
              implementation_segment_id, approach_planner_run_id, approach_node_run_id
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

/** Measured spend of one inside process — plus how many calls fell back. */
export interface ProcessRecordedUsage {
  /**
   * Measured token total across rows the core actually reported
   * (`estimated = 0`).
   */
  total: number;
  /**
   * Measured cache READS inside that total. Carried as its own fact so the
   * display can headline FRESH spend — a long cached session's re-reads are
   * ~95% of the raw tally and swamp the conversation's own cost.
   */
  cacheRead: number;
  /**
   * Calls whose counts are estimates (`estimated = 1`). COUNTED, never summed —
   * an estimate is not measured spend, and the two facts must never add up.
   */
  estimatedCalls: number;
}

/**
 * RECORDED spend of ONE inside process (a `process_runs.process_id` — session,
 * tester, review…), for the process rows' token views.
 *
 * The measured total excludes estimated rows; the estimate COUNT rides beside
 * it as a separate fact — a core that reported nothing stays visible, never
 * folded into the total. A process with no measured calls sums to zero, which
 * the caller renders as absence (never as a measured free call).
 */
export function summarizeRecordedTokenUsageForProcess(
  store: Store,
  ticketId: number,
  processId: string,
): ProcessRecordedUsage {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN estimated = 0 THEN total_tokens ELSE 0 END), 0) AS total,
              COALESCE(SUM(CASE WHEN estimated = 0 THEN cache_read_tokens ELSE 0 END), 0)
                AS cache_read,
              COALESCE(SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END), 0) AS estimated_calls
         FROM token_usage
        WHERE ticket_id = ? AND process_run_id IN (SELECT id FROM process_runs WHERE process_id = ?)`,
    )
    .get(ticketId, processId) as {
    total: number;
    cache_read: number;
    estimated_calls: number;
  };
  return { total: row.total, cacheRead: row.cache_read, estimatedCalls: row.estimated_calls };
}

/** Measured spend of one ticket, grouped by the inside role that spent it. */
export interface RecordedRoleUsage {
  /** `implementation` | `quality` | `ship` — the receipt's role breakdown. */
  role: string;
  input: number;
  output: number;
  total: number;
}

/**
 * Which inside role a process's spend belongs to. Unknown process ids — a
 * process a newer build introduced — are unattributed, not invented into a
 * role.
 */
const ROLE_BY_PROCESS: Readonly<Record<string, string>> = {
  session: 'implementation',
  tester: 'quality',
  review: 'quality',
  fix: 'quality',
  'pr-description': 'ship',
};

/** The receipt renders roles in a fixed order, whatever the query returned. */
const ROLE_ORDER: readonly string[] = ['implementation', 'quality', 'ship'];

/**
 * RECORDED spend per inside role, for the done receipt's breakdown.
 *
 * Same recorded-only contract as `summarizeRecordedTokenUsage` (estimated
 * rows excluded in the WHERE). Rows with no process link are legacy
 * pre-attribution spend: omitted here — a receipt must not guess which role
 * spent them — while they still appear in the ticket-wide summary.
 */
export function summarizeRecordedTokenUsageByRole(
  store: Store,
  ticketId: number,
): RecordedRoleUsage[] {
  const rows = store.db
    .prepare(
      `SELECT p.process_id AS process_id,
              COALESCE(SUM(t.input_tokens), 0) AS input,
              COALESCE(SUM(t.output_tokens), 0) AS output,
              COALESCE(SUM(t.total_tokens), 0) AS total
         FROM token_usage t
         LEFT JOIN process_runs p ON p.id = t.process_run_id
        WHERE t.ticket_id = ? AND t.estimated = 0
        GROUP BY p.process_id`,
    )
    .all(ticketId) as { process_id: string | null; input: number; output: number; total: number }[];

  const byRole = new Map<string, RecordedRoleUsage>();
  for (const row of rows) {
    if (row.process_id === null) continue;
    const role = ROLE_BY_PROCESS[row.process_id];
    if (role === undefined) continue;
    const held = byRole.get(role);
    if (held === undefined) {
      byRole.set(role, { role, input: row.input, output: row.output, total: row.total });
    } else {
      held.input += row.input;
      held.output += row.output;
      held.total += row.total;
    }
  }
  return ROLE_ORDER.filter((role) => {
    const held = byRole.get(role);
    return held !== undefined && (held.total > 0 || held.input > 0 || held.output > 0);
  }).map((role) => byRole.get(role)!);
}
