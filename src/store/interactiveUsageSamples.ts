import type { Store } from './db.js';
import type { InteractiveUsageSample } from '../agent/interactiveUsage.js';
import {
  hasCounterDecrease,
  interactiveUsageDelta,
  type UsageDelta,
} from '../agent/interactiveUsage.js';

/**
 * The measured interactive token-delta ledger (v29, Task 5).
 *
 * A provider session is the baseline scope: every sample is CUMULATIVE for one
 * (provider, provider_session_id), and the delta row is the increment since the
 * last persisted observation of that session — across EVERY Karst process.
 * Process linkage (the `token_usage` row) answers where the increment occurred;
 * the samples alone answer "how much has this provider session burned".
 *
 * The first observation of a provider session starts from implicit zero only
 * when the confirmed launch intent proves Karst created it under instrumentation
 * (`session_origin = 'new'`). A resumed/adopted session with no prior sample is
 * persisted `baseline_only = 1` — it is the next delta's predecessor, but no
 * accounting row is written, because the counters may include usage Karst never
 * measured. A counter decrease opens a new provider-session counter epoch:
 * counted from zero when the binding proves continuous instrumentation,
 * baselined otherwise. Moving between Karst processes or segments NEVER resets
 * the baseline — the same provider session id is one continuous conversation.
 *
 * Writing is one transaction: the binding is resolved, the event id is rejected
 * idempotently, the preceding sample is read, the cumulative sample is appended
 * with its required process run, and at most one non-negative delta row reaches
 * `token_usage`. The store is the source of truth — an extension-host restart
 * between samples must not lose the baseline decision, so nothing here is ever
 * derived from in-memory state.
 *
 * `store.db.prepare(...)` with positional `?` only, per the driver-agnostic
 * rule (the same helpers must work under `node:sqlite`).
 */

export interface InteractiveUsageSampleRow {
  id: number;
  /** The Karst process that was bound to the session when the sample landed. */
  processRunId: number;
  /** The implementation segment, when the binding was an implementation session. */
  implementationSegmentId: number | null;
  sourceEventId: string;
  provider: string;
  providerSessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  /** Provider counter epoch; bumped when the counters reset. */
  counterEpoch: number;
  /** 1 = observation persisted as a baseline; it wrote no `token_usage` row. */
  baselineOnly: boolean;
  observedAt: string;
}

interface SampleRow {
  id: number;
  process_run_id: number;
  implementation_segment_id: number | null;
  source_event_id: string;
  provider: string;
  provider_session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  counter_epoch: number;
  baseline_only: number;
  observed_at: string;
}

const SAMPLE_SELECT =
  `SELECT id, process_run_id, implementation_segment_id, source_event_id, provider,
          provider_session_id, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, counter_epoch, baseline_only, observed_at
     FROM interactive_usage_samples`;

function rowToSample(r: SampleRow): InteractiveUsageSampleRow {
  return {
    id: r.id,
    processRunId: r.process_run_id,
    implementationSegmentId: r.implementation_segment_id,
    sourceEventId: r.source_event_id,
    provider: r.provider,
    providerSessionId: r.provider_session_id,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    counterEpoch: r.counter_epoch,
    baselineOnly: r.baseline_only === 1,
    observedAt: r.observed_at,
  };
}

/** The latest persisted observation of one provider session, or null. */
export function lastInteractiveUsageSample(
  store: Store,
  provider: string,
  providerSessionId: string,
): InteractiveUsageSampleRow | null {
  const row = store.db
    .prepare(
      `${SAMPLE_SELECT} WHERE provider = ? AND provider_session_id = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(provider, providerSessionId) as SampleRow | undefined;
  return row === undefined ? null : rowToSample(row);
}

export interface AppendInteractiveUsageInput {
  ticketId: number;
  /** The full normalized sample; provider + session id scope the baseline. */
  sample: InteractiveUsageSample;
}

export type AppendInteractiveUsageResult =
  | { kind: 'recorded'; sampleId: number; delta: UsageDelta }
  | { kind: 'baseline'; sampleId: number }
  | { kind: 'duplicate' }
  | { kind: 'unattributed' };

/** The confirmed intent currently bound to a provider session. */
interface SessionBinding {
  purpose: 'implementation' | 'fix';
  sessionOrigin: 'new' | 'resume' | 'unknown';
  provider: string;
  processRunId: number | null;
  implementationSegmentId: number | null;
}

/**
 * The provider session's recorded origin — the session_origin of the latest
 * confirmed launch intent that bound it. NULL/no intent = 'unknown': the
 * session's continuity under karst instrumentation cannot be proved, so a
 * counter decrease on it must baseline rather than count from zero.
 */
function sessionOriginFor(
  store: Store,
  ticketId: number,
  provider: string,
  providerSessionId: string,
): SessionBinding['sessionOrigin'] {
  const row = store.db
    .prepare(
      `SELECT session_origin FROM session_launch_intents
        WHERE ticket_id = ? AND provider = ? AND provider_session_id = ?
          AND status = 'confirmed'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, provider, providerSessionId) as { session_origin: string } | undefined;
  return (row?.session_origin as SessionBinding['sessionOrigin']) ?? 'unknown';
}

/**
 * Resolve the provider session's CURRENT Karst process binding from durable
 * state:
 *
 *  1. The ticket's ACTIVE Fix execution — the LIVE-nudge path, which records
 *     NO new session launch intent (the nudge continues the already-live
 *     session). It owns the sample only when durable fields prove the fix
 *     belongs to THIS provider session: the round is the ticket's and still
 *     `fixing`, the Fix process run carries the same provider, and the sample's
 *     provider session IS the ticket's recorded live session
 *     (`tickets.session_id`/`session_provider`, captured at SessionStart) —
 *     the session the nudge continued. Ownership is never inferred from stage
 *     or timestamp, and never from "latest running Fix for ticket".
 *  2. The latest confirmed launch intent for (ticket, provider,
 *     provider_session_id) — the prepared-launch path. An implementation
 *     intent carries its run's Session process run and the segment the intent
 *     confirmed; a fix intent names the round it owns (`recovery_round_id`),
 *     and only that round's attached Fix process run may answer — the run must
 *     be CURRENTLY RUNNING (a `stale` run whose host died, or an interrupted
 *     one, owns nothing even while the round still reads `fixing`) and owned
 *     by the same ticket and provider — while the round is still `fixing`;
 *     a completed or interrupted round owns nothing.
 *
 * No owned process is NOT a binding — nothing is ever invented to make an
 * observation fit.
 */
function resolveSessionBinding(
  store: Store,
  ticketId: number,
  provider: string,
  providerSessionId: string,
): SessionBinding | null {
  const fixRound = store.db
    .prepare(
      `SELECT r.fix_process_run_id AS fix_process_run_id, pr.provider AS provider
         FROM recovery_rounds r
         JOIN process_runs pr
           ON pr.id = r.fix_process_run_id
          AND pr.ticket_id = r.ticket_id
          AND pr.status = 'running'
        WHERE r.ticket_id = ? AND r.status = 'fixing' AND r.fix_process_run_id IS NOT NULL
        ORDER BY r.id DESC LIMIT 1`,
    )
    .get(ticketId) as { fix_process_run_id: number; provider: string | null } | undefined;
  if (fixRound !== undefined && fixRound.provider === provider) {
    const live = store.db
      .prepare('SELECT session_id, session_provider FROM tickets WHERE id = ?')
      .get(ticketId) as
      | { session_id: string | null; session_provider: string | null }
      | undefined;
    if (
      live !== undefined &&
      live.session_id === providerSessionId &&
      live.session_provider === provider
    ) {
      return {
        purpose: 'fix',
        sessionOrigin: sessionOriginFor(store, ticketId, provider, providerSessionId),
        provider,
        processRunId: fixRound.fix_process_run_id,
        implementationSegmentId: null,
      };
    }
  }

  const intent = store.db
    .prepare(
      `SELECT id, purpose, implementation_run_id, session_origin, provider,
              process_run_id, recovery_round_id, ticket_id
         FROM session_launch_intents
        WHERE ticket_id = ? AND provider = ? AND provider_session_id = ?
          AND status = 'confirmed'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, provider, providerSessionId) as
    | {
        id: number;
        purpose: string;
        implementation_run_id: number | null;
        session_origin: string;
        provider: string;
        process_run_id: number | null;
        recovery_round_id: number | null;
        ticket_id: number;
      }
    | undefined;
  if (intent === undefined) return null;
  if (intent.purpose === 'implementation' && intent.implementation_run_id !== null) {
    const segment = store.db
      .prepare(
        `SELECT s.id AS id, pr.id AS process_run_id
           FROM implementation_runs ir
          JOIN process_runs pr
            ON pr.id = ir.process_run_id
           AND pr.ticket_id = ir.ticket_id
           AND pr.status = 'running'
          JOIN implementation_segments s
            ON s.implementation_run_id = ir.id
           AND s.launch_intent_id = ?
           AND s.status = 'running'
           AND s.provider = ?
           AND s.provider_session_id = ?
          WHERE ir.id = ? AND ir.ticket_id = ? AND ir.status = 'running'`,
      )
      .get(
        intent.id,
        provider,
        providerSessionId,
        intent.implementation_run_id,
        ticketId,
      ) as { id: number; process_run_id: number } | undefined;
    if (segment === undefined) return null;
    return {
      purpose: 'implementation',
      sessionOrigin: intent.session_origin as SessionBinding['sessionOrigin'],
      provider: intent.provider,
      processRunId: segment.process_run_id,
      implementationSegmentId: segment.id,
    };
  }
  if (intent.recovery_round_id !== null) {
    const fixRun = store.db
      .prepare(
        `SELECT r.fix_process_run_id AS fix_process_run_id
           FROM recovery_rounds r
           JOIN process_runs pr
             ON pr.id = r.fix_process_run_id
            AND pr.ticket_id = r.ticket_id
            AND pr.status = 'running'
            AND pr.provider = ?
          WHERE r.id = ? AND r.ticket_id = ? AND r.status = 'fixing'`,
      )
      .get(intent.provider, intent.recovery_round_id, intent.ticket_id) as
      | { fix_process_run_id: number | null }
      | undefined;
    if (fixRun !== undefined && fixRun.fix_process_run_id !== null) {
      return {
        purpose: 'fix',
        sessionOrigin: intent.session_origin as SessionBinding['sessionOrigin'],
        provider: intent.provider,
        processRunId: fixRun.fix_process_run_id,
        implementationSegmentId: null,
      };
    }
  }
  return null;
}

/**
 * Append one cumulative observation and, when it is billable, its delta row.
 *
 * The decision is made from PERSISTED state only and committed in one
 * transaction, so a close/reopen between samples can never lose the baseline:
 *
 *  - no prior sample: `session_origin = 'new'` proves Karst created the session
 *    under instrumentation → the full counts are the delta from implicit zero;
 *    anything else is persisted `baseline_only` and writes no ledger row;
 *  - prior sample, no decrease: the delta since that sample, same epoch;
 *  - prior sample with a decrease: a new counter epoch. Counted from zero when
 *    the binding proves continuous instrumentation (`session_origin = 'new'`),
 *    baselined otherwise — a resumed session's decrease may be an unrelated
 *    session's counters and must never read as measured spend.
 *
 * An already-recorded (provider, provider_session_id, source_event_id) is
 * rejected idempotently. Returns `unattributed` (nothing written) when the
 * session has no owned process binding. The binding is resolved INSIDE the
 * transaction that commits the sample, so another window superseding or
 * closing ownership cannot race the write: the sample is attributed to the
 * ownership that exists when it lands, or to nothing, atomically.
 */
export function appendInteractiveUsageSample(
  store: Store,
  input: AppendInteractiveUsageInput,
): AppendInteractiveUsageResult {
  const { sample } = input;
  const now = sample.observedAt;

  let outcome: AppendInteractiveUsageResult = { kind: 'unattributed' };
  const apply = store.db.transaction(() => {
    // The binding is resolved INSIDE the transaction: another window could
    // supersede or close ownership between a read outside and the writes below,
    // and the sample must be attributed to the ownership that exists when it
    // lands — or to nothing, atomically. No owned process is `unattributed`,
    // and nothing is written.
    const binding = resolveSessionBinding(
      store,
      input.ticketId,
      sample.provider,
      sample.providerSessionId,
    );
    if (binding === null || binding.processRunId === null) {
      outcome = { kind: 'unattributed' };
      return;
    }

    const callSite = binding.purpose === 'fix' ? 'fix-resume' : 'implementation';

    const existing = store.db
      .prepare(
        `SELECT id FROM interactive_usage_samples
          WHERE provider = ? AND provider_session_id = ? AND source_event_id = ?`,
      )
      .get(sample.provider, sample.providerSessionId, sample.eventId) as
      | { id: number }
      | undefined;
    if (existing !== undefined) {
      outcome = { kind: 'duplicate' };
      return;
    }

    const prior = store.db
      .prepare(
        `${SAMPLE_SELECT} WHERE provider = ? AND provider_session_id = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(sample.provider, sample.providerSessionId) as SampleRow | undefined;

    const priorCounts = prior
      ? {
          input: prior.input_tokens,
          output: prior.output_tokens,
          cacheRead: prior.cache_read_tokens ?? 0,
          cacheWrite: prior.cache_write_tokens ?? 0,
          total: prior.total_tokens ?? undefined,
        }
      : null;

    // A decrease opens a new provider-session counter epoch; within the new
    // epoch the observation is counted from zero (its full non-negative
    // counts), because the provider reset its own tally.
    const decrease = priorCounts !== null && hasCounterDecrease(priorCounts, sample);
    const counterEpoch = prior === undefined ? 0 : decrease ? prior.counter_epoch + 1 : prior.counter_epoch;

    // The first observation of a session Karst did not create under
    // instrumentation — and a decrease whose continuity cannot be proved — is a
    // baseline: persisted as the next delta's predecessor, never a ledger row.
    const baselineOnly =
      (prior === undefined && binding.sessionOrigin !== 'new') ||
      (decrease && binding.sessionOrigin !== 'new');

    const info = store.db
      .prepare(
        `INSERT INTO interactive_usage_samples
           (process_run_id, implementation_segment_id, source_event_id, provider,
            provider_session_id, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, total_tokens, counter_epoch, baseline_only, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.processRunId,
        binding.implementationSegmentId,
        sample.eventId,
        sample.provider,
        sample.providerSessionId,
        sample.input,
        sample.output,
        sample.cacheRead ?? null,
        sample.cacheWrite ?? null,
        sample.total ?? null,
        counterEpoch,
        baselineOnly ? 1 : 0,
        now,
      );
    const sampleId = Number(info.lastInsertRowid);

    if (baselineOnly) {
      outcome = { kind: 'baseline', sampleId };
      return;
    }

    // Billable: either the delta since the preceding sample in the same epoch,
    // or (on a proven reset) the full non-negative counts of the new epoch.
    const delta =
      prior === undefined || decrease
        ? {
            input: sample.input,
            output: sample.output,
            cacheRead: sample.cacheRead ?? 0,
            cacheWrite: sample.cacheWrite ?? 0,
            total:
              sample.total ??
              (sample.input + sample.output + (sample.cacheRead ?? 0) + (sample.cacheWrite ?? 0)),
          }
        : interactiveUsageDelta(priorCounts!, sample);

    const projectId = store.db
      .prepare('SELECT project_id FROM tickets WHERE id = ?')
      .get(input.ticketId) as { project_id: number | null } | undefined;

    store.db
      .prepare(
        `INSERT INTO token_usage
           (project_id, ticket_id, process_run_id, implementation_segment_id,
            interactive_usage_sample_id, call_site, provider, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            total_tokens, estimated, outcome, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 'ok', ?)`,
      )
      .run(
        projectId?.project_id ?? null,
        input.ticketId,
        binding.processRunId,
        binding.implementationSegmentId,
        sampleId,
        callSite,
        binding.provider,
        delta.input,
        delta.output,
        delta.cacheRead,
        delta.cacheWrite,
        delta.total,
        now,
      );
    outcome = { kind: 'recorded', sampleId, delta };
  });
  apply();
  return outcome;
}
