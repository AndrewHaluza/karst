import type { Store } from './db.js';
import { stageAttempt } from './stages.js';
import {
  confirmImplementationSegment,
  closeImplementationSegment,
  currentImplementationRun,
  openImplementationRun,
  openImplementationSegment,
} from './implementationRuns.js';

/**
 * Prepared session launches (v28) — the durable half of the launch→start
 * handshake.
 *
 * A launch is PREPARED the moment karst decides to create a terminal for a
 * ticket: the hook launch id is allocated, and the intent row is persisted with
 * everything the eventual SessionStart must match (ticket, provider, purpose).
 * The row stays PENDING because terminal creation is not proof the provider
 * started; only a SessionStart carrying the same launch id (URL-authenticated,
 * never trusted from the body) can CONFIRM it. A synchronous terminal-creation
 * failure marks it FAILED; a newer launch for the same ticket/purpose
 * SUPERSEDES the older pending one.
 *
 * The intent also anchors the STABLE implementation run: the first
 * implementation launch opens the run (and its canonical Session process run)
 * and every later launch of the same ticket reuses it, so switches and resumes
 * preserve one run id per implementation.
 */

export type LaunchPurpose = 'implementation' | 'fix';
export type LaunchReason = 'initial' | 'resume' | 'switch';
export type LaunchSessionOrigin = 'new' | 'resume' | 'unknown';
export type LaunchIntentStatus = 'pending' | 'confirmed' | 'failed' | 'superseded';

export interface SessionLaunchIntent {
  id: number;
  ticketId: number;
  launchId: string;
  purpose: LaunchPurpose;
  /** The stable implementation run this launch belongs to; NULL for a fix launch. */
  implementationRunId: number | null;
  /** The run's canonical Session process run; NULL for a fix launch. */
  processRunId: number | null;
  /**
   * v30: the recovery round a fix launch belongs to (see recoveryRounds.ts).
   * NULL for an implementation launch; REQUIRED for a fix launch — a pending
   * Fix launch has a durable owner before its process run exists, so the
   * matching SessionStart can attach the process run to the round even after a
   * reload.
   */
  recoveryRoundId: number | null;
  provider: string;
  model: string | null;
  reason: LaunchReason;
  sessionOrigin: LaunchSessionOrigin;
  providerSessionId: string | null;
  status: LaunchIntentStatus;
  createdAt: string;
  resolvedAt: string | null;
}

interface SessionLaunchIntentRow {
  id: number;
  ticket_id: number;
  launch_id: string;
  purpose: string;
  implementation_run_id: number | null;
  process_run_id: number | null;
  recovery_round_id: number | null;
  provider: string;
  model: string | null;
  reason: string;
  session_origin: string;
  provider_session_id: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

const INTENT_SELECT =
  `SELECT id, ticket_id, launch_id, purpose, implementation_run_id, process_run_id,
          recovery_round_id, provider, model, reason, session_origin,
          provider_session_id, status, created_at, resolved_at
     FROM session_launch_intents`;

function rowToIntent(r: SessionLaunchIntentRow): SessionLaunchIntent {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    launchId: r.launch_id,
    purpose: r.purpose as LaunchPurpose,
    implementationRunId: r.implementation_run_id,
    processRunId: r.process_run_id,
    recoveryRoundId: r.recovery_round_id,
    provider: r.provider,
    model: r.model,
    reason: r.reason as LaunchReason,
    sessionOrigin: r.session_origin as LaunchSessionOrigin,
    providerSessionId: r.provider_session_id,
    status: r.status as LaunchIntentStatus,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

function intentByLaunchId(store: Store, launchId: string): SessionLaunchIntent | undefined {
  const row = store.db.prepare(`${INTENT_SELECT} WHERE launch_id = ?`).get(launchId) as
    | SessionLaunchIntentRow
    | undefined;
  return row === undefined ? undefined : rowToIntent(row);
}

/** Read a launch intent back from the store (its CURRENT status, not a snapshot). */
export function getSessionLaunchIntent(
  store: Store,
  launchId: string,
): SessionLaunchIntent | undefined {
  return intentByLaunchId(store, launchId);
}

export interface RecordSessionLaunchIntentInput {
  ticketId: number;
  launchId: string;
  purpose: LaunchPurpose;
  provider: string;
  model?: string | null;
  reason: LaunchReason;
  sessionOrigin: LaunchSessionOrigin;
  at: string;
  /**
   * v30: REQUIRED when `purpose === 'fix'` — the recovery round this Fix
   * launch answers (see recoveryRounds.ts). A pending Fix launch has a durable
   * owner before its process run exists. Absent for an implementation launch.
   */
  recoveryRoundId?: number | null;
}

/**
 * Persist a prepared launch. For an implementation launch this also opens the
 * ticket's stable run when none is open (or reuses the interrupted one — the
 * run survives a session that died without the marker, so a retry or resume
 * keeps the same id). Starting a newer launch transactionally marks any older
 * pending intent for the same ticket/purpose superseded: at most one pending
 * launch per (ticket, purpose) may ever be confirmed.
 */
export function recordSessionLaunchIntent(
  store: Store,
  input: RecordSessionLaunchIntentInput,
): SessionLaunchIntent {
  if (input.purpose === 'fix' && (input.recoveryRoundId === undefined || input.recoveryRoundId === null)) {
    throw new Error('a fix launch intent requires a recovery round (recoveryRoundId)');
  }
  let insertedId = 0;
  const apply = store.db.transaction(() => {
    let implementationRunId: number | null = null;
    let processRunId: number | null = null;
    if (input.purpose === 'implementation') {
      const open = currentImplementationRun(store, input.ticketId);
      if (
        open !== undefined &&
        (open.status === 'running' || open.status === 'interrupted')
      ) {
        implementationRunId = open.id;
        processRunId = open.processRunId;
      } else {
        const run = openImplementationRun(store, {
          ticketId: input.ticketId,
          attempt: stageAttempt(store, input.ticketId, 'impl'),
          provider: input.provider,
          model: input.model ?? null,
          startedAt: input.at,
        });
        implementationRunId = run.id;
        processRunId = run.processRunId;
      }
    }
    supersedePendingLaunchIntents(
      store,
      input.ticketId,
      input.purpose,
      input.launchId,
      input.at,
    );
    const info = store.db
      .prepare(
        `INSERT INTO session_launch_intents
           (ticket_id, launch_id, purpose, implementation_run_id, process_run_id,
            recovery_round_id, provider, model, reason, session_origin,
            provider_session_id, status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL)`,
      )
      .run(
        input.ticketId,
        input.launchId,
        input.purpose,
        implementationRunId,
        processRunId,
        input.recoveryRoundId ?? null,
        input.provider,
        input.model ?? null,
        input.reason,
        input.sessionOrigin,
        input.at,
      );
    insertedId = Number(info.lastInsertRowid);
  });
  apply();
  const intent = intentByLaunchId(store, input.launchId);
  if (intent === undefined) throw new Error('launch intent insert did not land');
  return intent;
}

/**
 * Mark every pending intent for a (ticket, purpose) superseded, except the
 * named launch. Returns how many were retired.
 */
export function supersedePendingLaunchIntents(
  store: Store,
  ticketId: number,
  purpose: LaunchPurpose,
  exceptLaunchId: string,
  at: string,
): number {
  const info = store.db
    .prepare(
      `UPDATE session_launch_intents SET status = 'superseded', resolved_at = ?
        WHERE ticket_id = ? AND purpose = ? AND status = 'pending' AND launch_id != ?`,
    )
    .run(at, ticketId, purpose, exceptLaunchId);
  return info.changes;
}

/**
 * Mark a prepared launch FAILED after a synchronous terminal-creation failure.
 * The intent is dead — no SegmentStart may confirm it — but nothing else
 * changes: the run stays open so a retry reuses the same stable run, and no
 * segment exists because a launch that never created a terminal never started
 * a provider session.
 */
export function failSessionLaunchIntent(store: Store, launchId: string, at: string): boolean {
  const info = store.db
    .prepare(
      `UPDATE session_launch_intents SET status = 'failed', resolved_at = ?
        WHERE launch_id = ? AND status = 'pending'`,
    )
    .run(at, launchId);
  return info.changes > 0;
}

export type ConfirmLaunchIntentResult =
  | 'confirmed'
  | 'unknown'
  | 'not-pending'
  | 'ticket-mismatch'
  | 'provider-mismatch';

export interface ConfirmSessionLaunchIntentInput {
  ticketId: number;
  /** The core the ticket resolves to RIGHT NOW (the dispatch's resolver). */
  provider: string;
  /** The provider session id the SessionStart carried. */
  providerSessionId: string;
  at: string;
}

/**
 * Confirm a prepared launch from its SessionStart. Every verification runs
 * BEFORE any mutation, inside one transaction:
 *
 *  - the launch id must resolve to a stored intent — never in-memory callback
 *    state, so a reload cannot strand or forge a confirmation;
 *  - the intent must still be pending — a failed, superseded or already
 *    confirmed start is rejected;
 *  - the ticket and the currently-resolved provider must match the intent — a
 *    ticket switched since the launch was prepared must not attach the old
 *    core's session;
 *  - the lifecycle generation barrier (the dispatch's `shouldApplyState`) has
 *    already admitted this hook before this is ever called.
 *
 * On confirmation it attaches the provider session id and confirms the
 * corresponding segment: the FIRST segment for an initial launch, a new segment
 * for a switch (closing the previous running one, preserving the stable run
 * id), and a reattach of the compatible segment for a resume. A fix-purpose
 * launch confirms through `confirmFixLaunch` (recoveryRounds.ts) instead —
 * this module's fix branch (used only by legacy/foreign callers) confirms the
 * intent alone, with no run or segment.
 */
export function confirmSessionLaunchIntent(
  store: Store,
  launchId: string,
  input: ConfirmSessionLaunchIntentInput,
): ConfirmLaunchIntentResult {
  const intent = intentByLaunchId(store, launchId);
  if (intent === undefined) return 'unknown';
  if (intent.status !== 'pending') return 'not-pending';
  if (intent.ticketId !== input.ticketId) return 'ticket-mismatch';
  if (intent.provider !== input.provider) return 'provider-mismatch';

  const apply = store.db.transaction(() => {
    if (intent.purpose === 'implementation') {
      let run = currentImplementationRun(store, intent.ticketId);
      if (run === undefined || (run.id !== intent.implementationRunId)) {
        // The intent names a run that no longer exists (a foreign wipe): open a
        // fresh stable run and backfill the intent's linkage.
        run = openImplementationRun(store, {
          ticketId: intent.ticketId,
          attempt: stageAttempt(store, intent.ticketId, 'impl'),
          provider: intent.provider,
          model: intent.model,
          startedAt: input.at,
        });
        store.db
          .prepare(
            'UPDATE session_launch_intents SET implementation_run_id = ?, process_run_id = ? WHERE id = ?',
          )
          .run(run.id, run.processRunId, intent.id);
      }
      // A run interrupted by a session that died without the marker is REOPENED
      // by the next start: the implementation continues in the same run. A run
      // the marker already PASSED takes no more segments — the completion is
      // final, so a late start attaches only the intent, never a segment.
      if (run.status === 'interrupted') {
        store.db
          .prepare("UPDATE implementation_runs SET status = 'running', ended_at = NULL WHERE id = ?")
          .run(run.id);
      }

      if (run.status !== 'passed') {
        if (intent.reason === 'switch') {
          closeImplementationSegmentForRun(store, run.id, input.at);
          const segment = openImplementationSegment(store, {
            implementationRunId: run.id,
            provider: intent.provider,
            model: intent.model,
            reason: 'switch',
            launchIntentId: intent.id,
            startedAt: input.at,
          });
          confirmImplementationSegment(store, {
            segmentId: segment.id,
            providerSessionId: input.providerSessionId,
            at: input.at,
          });
        } else if (intent.reason === 'resume') {
          const compatible = compatibleSegment(store, run.id, intent.provider, input.providerSessionId);
          if (compatible !== undefined) {
            // The provider resumed the SAME session: reattach the segment to the
            // stable run instead of opening a second row for one conversation.
            store.db
              .prepare(
                `UPDATE implementation_segments
                    SET status = 'running', launch_intent_id = ?,
                        provider_session_id = ?, ended_at = NULL
                  WHERE id = ?`,
              )
              .run(intent.id, input.providerSessionId, compatible.id);
          } else {
            const segment = openImplementationSegment(store, {
              implementationRunId: run.id,
              provider: intent.provider,
              model: intent.model,
              reason: 'resume',
              launchIntentId: intent.id,
              startedAt: input.at,
            });
            confirmImplementationSegment(store, {
              segmentId: segment.id,
              providerSessionId: input.providerSessionId,
              at: input.at,
            });
          }
        } else {
          // Initial launch: the first segment, opened without any switch record.
          const segment = openImplementationSegment(store, {
            implementationRunId: run.id,
            provider: intent.provider,
            model: intent.model,
            reason: null,
            launchIntentId: intent.id,
            startedAt: input.at,
          });
          confirmImplementationSegment(store, {
            segmentId: segment.id,
            providerSessionId: input.providerSessionId,
            at: input.at,
          });
        }
      }
    }
    confirmLaunchIntentRow(store, intent.id, input.providerSessionId, input.at);
  });
  apply();
  return 'confirmed';
}

/**
 * Confirm a PENDING intent row — the shared tail of every accepted
 * SessionStart (implementation starts and `confirmFixLaunch` alike). Lives in
 * this module so the status vocabulary and the `status = 'pending'` guard are
 * written down exactly once.
 */
export function confirmLaunchIntentRow(
  store: Store,
  intentId: number,
  providerSessionId: string,
  at: string,
): boolean {
  const info = store.db
    .prepare(
      `UPDATE session_launch_intents SET status = 'confirmed', provider_session_id = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(providerSessionId, at, intentId);
  return info.changes > 0;
}

function closeImplementationSegmentForRun(store: Store, runId: number, at: string): void {
  store.db
    .prepare(
      `UPDATE implementation_segments SET status = 'closed', ended_at = ?
        WHERE implementation_run_id = ? AND status = 'running'`,
    )
    .run(at, runId);
}

function compatibleSegment(
  store: Store,
  runId: number,
  provider: string,
  providerSessionId: string,
): { id: number } | undefined {
  // A resumed session carries the SAME provider session id it always had, so
  // the compatible segment is the one already bound to that conversation — a
  // running one (nothing changed but the launch), a closed one (a switch moved
  // on, the resume comes back to it), or an interrupted one (the session died
  // without the marker and the user continued it).
  return store.db
    .prepare(
      `SELECT id FROM implementation_segments
        WHERE implementation_run_id = ? AND provider = ? AND provider_session_id = ?
          AND status IN ('running','closed','interrupted')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(runId, provider, providerSessionId) as { id: number } | undefined;
}
