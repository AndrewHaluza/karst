/**
 * The validation boundary for every token-usage stats query (§ token
 * consumption stats).
 *
 * The query arrives from a webview — an untrusted surface — and its fields go
 * straight into a WHERE clause, a LIMIT, and an ORDER BY. Two of those cannot be
 * bound as a parameter, so `sort` is narrowed to a closed set here and mapped to
 * a literal expression by the store; nothing else is ever interpolated. An
 * invalid query returns a NAMED error rather than being coerced: a silently
 * clamped range renders as "you spent nothing", which is a wrong answer stated
 * confidently.
 *
 * Kept separate from `tokenUsage.ts` for the reason `manifest/validate` is
 * separate from the loaders: the rules must be testable without a database, and
 * the CLI-facing store helpers must stay driver-agnostic.
 */

/** Ways the per-ticket table can be ordered. Closed — it reaches ORDER BY. */
export const USAGE_SORTS = ['effective', 'total', 'input', 'output', 'calls', 'recent'] as const;
export type UsageSort = (typeof USAGE_SORTS)[number];

/**
 * What an unspecified query is ordered by. `effective`, not `total`: ranking on
 * the raw sum ranks by how many cached turns a call took rather than by what it
 * cost, which is the defect this view existed to make visible (`tokenWeights.ts`).
 */
export const DEFAULT_USAGE_SORT: UsageSort = 'effective';

/** Hard ceiling on one page of the per-ticket table. */
export const MAX_USAGE_LIMIT = 200;
export const DEFAULT_USAGE_LIMIT = 50;

/** The time ranges the view offers. `days: null` means "everything". */
export const USAGE_RANGES = [
  { id: '24h', label: 'Last 24 hours', days: 1 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'All time', days: null },
] as const;

export type UsageRangeId = (typeof USAGE_RANGES)[number]['id'];

export const DEFAULT_USAGE_RANGE: UsageRangeId = '30d';

export interface UsageQuery {
  /** Scope to one project. NULL is the deliberate all-projects view. */
  projectId: number | null;
  /** Narrow to one ticket. NULL = every ticket (and the unattributed calls). */
  ticketId: number | null;
  /** Inclusive lower bound, ISO-8601; null = unbounded. */
  from: string | null;
  /** Inclusive upper bound, ISO-8601; null = unbounded. */
  to: string | null;
  limit: number;
  offset: number;
  sort: UsageSort;
}

export type UsageQueryResult =
  | { ok: true; query: UsageQuery }
  | { ok: false; error: string };

const MS_PER_DAY = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: string): UsageQueryResult {
  return { ok: false, error };
}

/** An optional positive integer id, or an error naming the field. */
function readId(
  raw: Record<string, unknown>,
  field: 'projectId' | 'ticketId',
): { value: number | null } | { error: string } {
  const value = raw[field];
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { error: `${field} must be a positive integer` };
  }
  return { value };
}

/** An optional timestamp, normalized to ISO-8601, or an error naming the field. */
function readStamp(
  raw: Record<string, unknown>,
  field: 'from' | 'to',
): { value: string | null } | { error: string } {
  const value = raw[field];
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: `${field} must be an ISO-8601 timestamp` };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return { error: `${field} is not a valid ISO-8601 timestamp: ${value.slice(0, 40)}` };
  }
  return { value: parsed.toISOString() };
}

/** An optional bounded non-negative integer, or an error naming the field. */
function readBounded(
  raw: Record<string, unknown>,
  field: 'limit' | 'offset',
  min: number,
  max: number,
  fallback: number,
): { value: number } | { error: string } {
  const value = raw[field];
  if (value === undefined || value === null) return { value: fallback };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { value };
}

/**
 * Narrow an untrusted stats query. Every field is optional; what is present must
 * be well-formed, and the first problem is reported by name so the view can say
 * what to fix rather than showing an empty table.
 */
export function parseUsageQuery(raw: unknown): UsageQueryResult {
  if (raw === undefined || raw === null) raw = {};
  if (!isRecord(raw)) return fail('query must be an object');

  const projectId = readId(raw, 'projectId');
  if ('error' in projectId) return fail(projectId.error);
  const ticketId = readId(raw, 'ticketId');
  if ('error' in ticketId) return fail(ticketId.error);

  const from = readStamp(raw, 'from');
  if ('error' in from) return fail(from.error);
  const to = readStamp(raw, 'to');
  if ('error' in to) return fail(to.error);
  if (from.value !== null && to.value !== null && from.value > to.value) {
    return fail('from must be at or before to — the range is inverted');
  }

  const limit = readBounded(raw, 'limit', 1, MAX_USAGE_LIMIT, DEFAULT_USAGE_LIMIT);
  if ('error' in limit) return fail(limit.error);
  const offset = readBounded(raw, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
  if ('error' in offset) return fail(offset.error);

  const rawSort = raw['sort'];
  let sort: UsageSort = DEFAULT_USAGE_SORT;
  if (rawSort !== undefined && rawSort !== null) {
    if (typeof rawSort !== 'string' || !(USAGE_SORTS as readonly string[]).includes(rawSort)) {
      return fail(`sort must be one of: ${USAGE_SORTS.join(', ')}`);
    }
    sort = rawSort as UsageSort;
  }

  return {
    ok: true,
    query: {
      projectId: projectId.value,
      ticketId: ticketId.value,
      from: from.value,
      to: to.value,
      limit: limit.value,
      offset: offset.value,
      sort,
    },
  };
}

/**
 * Turn a range preset into query bounds. An unknown id resolves to all-time
 * rather than throwing: the presets are a display convenience, and the query
 * they produce is validated by `parseUsageQuery` regardless.
 */
export function resolveUsageRange(
  id: string,
  now: Date,
): { from: string | null; to: string | null } {
  const range = USAGE_RANGES.find((r) => r.id === id);
  if (!range || range.days === null) return { from: null, to: null };
  return { from: new Date(now.getTime() - range.days * MS_PER_DAY).toISOString(), to: null };
}
