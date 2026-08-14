import type { AgentProvider } from '../manifest/types.js';

/**
 * Measured token counts for an INTERACTIVE provider session (Task 5).
 *
 * `tokenUsage.ts` reads what a HEADLESS run printed; this module describes
 * what a "sample source" produces while a live session runs — a bridge POST
 * (codex/opencode), a session transcript read (claude, via
 * claudeTranscriptWatch.ts), or a conversation-DB read (antigravity, via
 * agyUsageWatch.ts). The two share one rule: a count is a finite, non-negative
 * number, and anything else is not a count. The shape mirrors `TokenUsage` —
 * cache reads and cache writes are independent counters and must never be
 * collapsed into a single `cachedInput` value.
 *
 * A sample is CUMULIVE for one provider session: the source reports a running
 * tally (as opencode's session.updated `info.tokens` and codex's turn usage
 * do), and the delta since the last persisted observation is what a process
 * spent. The source may only emit a sample when the provider supplied numeric
 * counts AND a stable event/message id — the id is what makes the ingestion
 * idempotent, so an event without one is dropped before it reaches the store.
 * Nothing here ever estimates from transcript size, terminal text, elapsed
 * time, or model output.
 */

export interface InteractiveUsageSample {
  /** Stable provider event/message id — the dedupe key, never estimated. */
  eventId: string;
  provider: AgentProvider;
  /** The provider's own session id — the cumulative-count baseline scope. */
  providerSessionId: string;
  input: number;
  output: number;
  /**
   * Reasoning ("thinking") tokens, when the provider counts them apart from
   * `output`. They are OUTPUT-BILLED spend that opencode reports in its own
   * `tokens.reasoning` counter, so dropping them undercounted every reasoning
   * model's session; they are never folded INTO `output`, for the same reason
   * cache reads and writes stay disjoint — a counter karst rewrites can no
   * longer be compared with what the provider itself reports.
   */
  reasoning?: number;
  /** Input tokens served from a prompt cache, when the provider distinguishes them. */
  cacheRead?: number;
  /** Input tokens written INTO a prompt cache — never folded into cacheRead. */
  cacheWrite?: number;
  /** Provider-reported total when it gave one, else derived from the counters. */
  total?: number;
  /** ISO-8601 observation stamp. */
  observedAt: string;
}

/** The counter half of a sample — what the delta math compares. */
export type SampleCounts = Pick<
  InteractiveUsageSample,
  'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite' | 'total'
>;

/** The non-negative increment one cumulative sample adds over the previous. */
export interface UsageDelta {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A count is a finite, non-negative number. Anything else is not a count. */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * A present counter must BE a count: `undefined` = the key is absent,
 * `null` = the key is present but its value is not a finite non-negative
 * number. A present-but-invalid value (NaN, Infinity, a string, a negative)
 * rejects the WHOLE payload — silently dropping just that key would make a
 * broken bridge's sample read as "no cache reads" when reads happened.
 */
function presentCount(record: Record<string, unknown>, key: string): number | null | undefined {
  return key in record ? count(record[key]) : undefined;
}

/**
 * Narrow the untrusted `usage` object a bridge POSTs to the closed wire shape.
 *
 * `event_id` is required and must be a non-empty string — a stable provider
 * event id is the idempotency key, and an event without one must not reach the
 * store. `input`/`output` are required counts; `cache_read`/`cache_write`/
 * `reasoning`/`total` are optional counts. A non-numeric field is not coerced to 0 (a 0
 * would read as a measured free call) — the whole payload is rejected, so a
 * malformed bridge can never put invented numbers into the ledger.
 */
export function normalizeInteractiveUsage(raw: unknown): Omit<
  InteractiveUsageSample,
  'provider' | 'providerSessionId' | 'observedAt'
> | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const eventId = record['event_id'];
  if (typeof eventId !== 'string' || eventId.trim() === '') return null;
  const input = presentCount(record, 'input');
  const output = presentCount(record, 'output');
  if (input === undefined || input === null || output === undefined || output === null) {
    return null;
  }
  const reasoning = presentCount(record, 'reasoning');
  const cacheRead = presentCount(record, 'cache_read');
  const cacheWrite = presentCount(record, 'cache_write');
  const total = presentCount(record, 'total');
  if (reasoning === null || cacheRead === null || cacheWrite === null || total === null) {
    return null;
  }
  return {
    eventId,
    input,
    output,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

/** The five counters with absent reasoning/cache counts read as zero. */
export function normalizedCounts(sample: SampleCounts): {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} {
  const reasoning = sample.reasoning ?? 0;
  const cacheRead = sample.cacheRead ?? 0;
  const cacheWrite = sample.cacheWrite ?? 0;
  return {
    input: sample.input,
    output: sample.output,
    reasoning,
    cacheRead,
    cacheWrite,
    total:
      sample.total ?? sample.input + sample.output + reasoning + cacheRead + cacheWrite,
  };
}

/**
 * The increment a cumulative sample adds over the preceding one.
 *
 * A provider-reported total is preserved when both sides carry one; otherwise
 * the total is derived from the five normalized counters, exactly like
 * `tokenUsage.ts`'s normalization. A decreasing counter shows up here as a
 * negative component — callers must treat that as a provider counter reset
 * (see `hasCounterDecrease`), never as a billable negative delta.
 */
export function interactiveUsageDelta(
  prev: SampleCounts,
  next: SampleCounts,
): UsageDelta {
  const p = normalizedCounts(prev);
  const n = normalizedCounts(next);
  return {
    input: n.input - p.input,
    output: n.output - p.output,
    reasoning: n.reasoning - p.reasoning,
    cacheRead: n.cacheRead - p.cacheRead,
    cacheWrite: n.cacheWrite - p.cacheWrite,
    total: n.total - p.total,
  };
}

/**
 * Whether any counter (or the provider total) DECREASED between two cumulative
 * samples — the reset signal. A provider's cumulative tally never legitimately
 * shrinks within one continuously-instrumented session, so a decrease means
 * the provider opened a new counter epoch (or the session was replaced), and
 * the observation must never be billed as a negative delta.
 */
export function hasCounterDecrease(prev: SampleCounts, next: SampleCounts): boolean {
  const delta = interactiveUsageDelta(prev, next);
  return (
    delta.input < 0 ||
    delta.output < 0 ||
    delta.reasoning < 0 ||
    delta.cacheRead < 0 ||
    delta.cacheWrite < 0 ||
    delta.total < 0
  );
}
