import type { Store } from './db.js';
import { failSessionLaunchIntent } from './sessionLaunchIntents.js';
import {
  type RecoverySourceStage,
  type RecoveryRoundRow,
  activeRoundAnyStage,
  roundById,
  ROUND_SELECT,
  rowToRound,
} from './recoveryRoundsRead.js';
import {
  parkFixStage,
  FIX_PARKED_INTERRUPTED,
  FIX_PARKED_NO_EXECUTION,
  FIX_PARKED_STALLED,
  FIX_PARKED_LAUNCH_NEVER_STARTED,
  interruptFixExecution,
} from './recoveryRoundsWrite.js';

/**
 * One stranded fix this sweep settled, reported so the loss is never silent.
 * `kind` separates the cases: `execution` is an interrupted fix execution
 * (round-based), `stage` is a fix stage row that read `running` with no
 * execution at all — parked, never interrupted, because there was no execution
 * to interrupt — and `stalled` is a live-but-idle run parked by the stall
 * watchdog once it showed no progress for the configured window. `'launch'` is
 * a prepared fix launch that no SessionStart ever confirmed before the window
 * elapsed.
 */
export type StrandedFixKind = 'execution' | 'stage' | 'stalled' | 'launch';

export interface StrandedFixRound {
  kind: StrandedFixKind;
  /** The interrupted round, for an execution; null for a stage park. */
  roundId: number | null;
  ticketId: number;
  /** The round's source stage, for an execution; null for a stage park. */
  sourceStage: RecoverySourceStage | null;
  /** The round's number, for an execution; null for a stage park. */
  round: number | null;
  fixProcessRunId: number | null;
}

/**
 * Settle every stranded fix state at activation, in two passes.
 *
 * PASS 1 — interrupt every `fixing` round whose Fix execution can no longer be
 * running. `fixing` is the one recovery status nothing can leave on its own:
 * the marker is the only completion authority, and a session that dies without
 * firing it fires no signal either. The driver reads such a round as "a fix
 * execution is already in flight" and leaves the ticket alone — forever, which
 * is exactly how a ticket sat at fix for ten hours with an idle agent and no
 * session (869ee...): the SessionEnd hook that would have called
 * `interruptActiveFixExecution` never reached the endpoint, and the process-run
 * sweep marked the run stale without propagating that to the round.
 *
 * Stranded means one of two things, both proven from stored state rather than
 * guessed: the round carries NO Fix process run (nothing was ever opened, or
 * its launch never confirmed), or the run it carries is no longer `running`
 * (another window's open superseded it, or the activation sweep found its
 * process gone). A run still `running` is left STRICTLY alone — a live fix in
 * this or any other window must never be accused of having died, which is why
 * this sweep runs AFTER `reconcileProcessRuns` rather than judging liveness
 * itself.
 *
 * PASS 2 — park every fix stage row that reads `running` with NO `fixing`
 * round at all: a ticket at fix whose execution never started (no round, a
 * pending round nothing ever attached to, or only terminal rounds) is waiting
 * for a human, not being fixed, and the row must not claim otherwise. This is
 * the sweep that heals tickets parked by OLDER builds — the round-level pass
 * and the terminal-close sweep only settle executions that were ever started.
 *
 * A PENDING fix launch intent is the one state PASS 2 must NOT park: the intent
 * is recorded the moment a launch is prepared (before the terminal exists), and
 * the round it names stays `pending` until the accepted SessionStart confirms it
 * via `confirmFixLaunch`. That window is a launch genuinely in flight, not "no
 * fix execution in flight" — parking it read a review round-2 fix as blocked
 * while the agent was actually working (REVIEW-2ND-ROUND-FIX-STUCK-WITH). The
 * sweep leaves any ticket whose round is waiting on a pending intent alone; the
 * launch's own failure (an unreachable SessionStart, a terminal that never
 * confirmed) is settled by the terminal-close sweep and the driver, never by
 * this blanket park.
 *
 * Global like the run sweeps and for the same reason: the registry is shared by
 * every IDE window, and a stranded fix is wrong in whichever project owns it.
 */
export function reconcileStrandedFixRounds(store: Store, at: string): StrandedFixRound[] {
  const rows = store.db
    .prepare(
      `${ROUND_SELECT} WHERE status = 'fixing'
          AND (fix_process_run_id IS NULL
               OR fix_process_run_id IN
                    (SELECT id FROM process_runs WHERE status <> 'running'))
        ORDER BY id`,
    )
    .all()
    .map((r) => rowToRound(r as RecoveryRoundRow));

  const stranded: StrandedFixRound[] = [];
  for (const round of rows) {
    if (!interruptFixExecution(store, round.id, at)) continue;
    stranded.push({
      kind: 'execution',
      roundId: round.id,
      ticketId: round.ticketId,
      sourceStage: round.sourceStage,
      round: round.round,
      fixProcessRunId: round.fixProcessRunId,
    });
  }

  const parked = store.db
    .prepare(
      `SELECT id FROM tickets
        WHERE stage_current = 'fix'
          AND EXISTS (
            SELECT 1 FROM stages
             WHERE ticket_id = tickets.id AND stage_key = 'fix' AND status = 'running')
          AND NOT EXISTS (
            SELECT 1 FROM recovery_rounds
             WHERE ticket_id = tickets.id AND status = 'fixing')
          AND NOT EXISTS (
            SELECT 1 FROM session_launch_intents
             WHERE ticket_id = tickets.id AND purpose = 'fix' AND status = 'pending')
        ORDER BY id`,
    )
    .all() as { id: number }[];
  for (const row of parked) {
    if (!parkFixStage(store, row.id, FIX_PARKED_NO_EXECUTION, at)) continue;
    stranded.push({
      kind: 'stage',
      roundId: null,
      ticketId: row.id,
      sourceStage: null,
      round: null,
      fixProcessRunId: null,
    });
  }

  return stranded;
}

export interface SweepStalledFixOpts {
  /** The sweep's clock, ISO-8601. */
  at: string;
  /** How long a fix may show no progress before it is parked. */
  timeoutMs: number;
  /**
   * The project whose configured window `timeoutMs` belongs to. The sweep
   * settles ONLY this project's tickets: a manifest window must never be
   * applied to another project's fix, and the registry is shared by every
   * window. `null` (no project bound) settles nothing.
   */
  projectId: number | null;
}

/**
 * Park every `fixing` round that has shown NO progress for `timeoutMs`.
 *
 * This is the complement of `reconcileStrandedFixRounds`, which leaves a round whose Fix run is
 * still `running` STRICTLY alone — correctly, because a live run may be another window's working
 * agent. That exclusion is also the hole: `fix` is the one stage delivered as a NUDGE into an
 * interactive terminal (`workflow/fixExecution.ts`), the done marker is the only completion
 * authority, and a nudge that lands while the agent is not at a prompt is never read. The run
 * stays `running` and the ticket sits at fix forever.
 *
 * We cannot prove an interactive agent is idle — no such signal exists. We CAN prove nothing has
 * changed. Progress is the NEWEST of: the Fix run's `started_at` and the newest GUIDE-PULL the
 * ticket recorded. `karst guide` opens a `guide-pull` run per pull from the agent's own session
 * (`cli/guideTelemetry.ts`) and attributes it to the ticket — it is the fix agent's only stored
 * activity signal. When that newest moment is older than `at - timeoutMs`, the fix is parked.
 *
 * Progress is deliberately NOT "the newest `process_runs` row for the ticket": every other run is
 * PIPELINE activity (a gate, the tester, review, a ship step) that the driver never starts while a
 * fix round is `fixing`, so counting one would let unrelated work reset the clock and mask a
 * genuinely stalled fix — the exact false negative this sweep exists to close.
 *
 * `recovery_rounds` carries NO `updated_at` column, so a round's own row is not a progress
 * signal. An agent working silently past the timeout is parked though it was working — an
 * accepted false positive, bounded by the configurable window and recoverable by a retry.
 *
 * PROJECT-SCOPED, unlike the sibling sweep: the window's `timeoutMs` comes from
 * ITS project's manifest, and the registry is shared by every window, so a
 * global sweep would apply one project's window to another project's tickets.
 * Only tickets of `projectId` are considered. The cost is that a stalled fix in
 * a project with no open window waits for that project's next activation tick —
 * the right direction: it is never parked on a window it does not belong to.
 *
 * The round is settled with the same constrained `fixing` update `interruptFixExecution` uses (the
 * cross-window guard), but the abandoned run is stamped `stale` — a run we stopped believing in
 * rather than one that reported failure — and the stage parks with `FIX_PARKED_STALLED`, not the
 * interrupt helper's generic reason. That is why this does not call `interruptFixExecution`: the
 * two facts this sweep exists to record would be overwritten by that helper's own run close and
 * park, which win the single-write guarantees.
 */
export function sweepStalledFixRounds(
  store: Store,
  opts: SweepStalledFixOpts,
): StrandedFixRound[] {
  const nowMs = Date.parse(opts.at);
  if (!Number.isFinite(nowMs)) return [];
  if (!(opts.timeoutMs > 0)) return [];
  if (opts.projectId === null) return [];
  const cutoff = new Date(nowMs - opts.timeoutMs).toISOString();

  const rows = store.db
    .prepare(
      `SELECT r.id, r.ticket_id, r.source_stage, r.round, r.fix_process_run_id,
              run.started_at AS run_started_at,
              (SELECT MAX(started_at) FROM process_runs
                WHERE ticket_id = r.ticket_id AND process_id = 'guide-pull') AS latest_guide_pull_at
         FROM recovery_rounds r
         JOIN process_runs run ON run.id = r.fix_process_run_id
        WHERE r.status = 'fixing' AND run.status = 'running'
          AND r.ticket_id IN (SELECT id FROM tickets WHERE project_id = ?)
        ORDER BY r.id`,
    )
    .all(opts.projectId) as {
    id: number;
    ticket_id: number;
    source_stage: string;
    round: number;
    fix_process_run_id: number;
    run_started_at: string;
    latest_guide_pull_at: string | null;
  }[];

  const stalled: StrandedFixRound[] = [];
  for (const row of rows) {
    const moments = [row.run_started_at, row.latest_guide_pull_at].filter(
      (v): v is string => v !== null,
    );
    const progress = moments.reduce((a, b) => (a >= b ? a : b));
    if (progress >= cutoff) continue;

    const settle = store.db.transaction(() => {
      const changed =
        store.db
          .prepare(
            `UPDATE recovery_rounds SET status = 'interrupted', ended_at = ?,
               interrupt_count = interrupt_count + 1
              WHERE id = ? AND status = 'fixing'`,
          )
          .run(opts.at, row.id).changes === 1;
      if (!changed) return false;
      // `stale` carries NO end stamp, exactly like every other stale transition
      // (`reconcileProcessRuns`, `openProcessRun`): when a run we stopped
      // believing in actually stopped is unknown, and writing this sweep's clock
      // would claim it lived until now.
      store.db
        .prepare("UPDATE process_runs SET status = 'stale' WHERE id = ? AND status = 'running'")
        .run(row.fix_process_run_id);
      parkFixStage(store, row.ticket_id, FIX_PARKED_STALLED, opts.at);
      return true;
    });
    if (!settle()) continue;

    stalled.push({
      kind: 'stalled',
      roundId: row.id,
      ticketId: row.ticket_id,
      sourceStage: row.source_stage as RecoverySourceStage,
      round: row.round,
      fixProcessRunId: row.fix_process_run_id,
    });
  }
  return stalled;
}

/**
 * Park every fix whose LAUNCH never started.
 *
 * `reconcileStrandedFixRounds`' PASS 2 deliberately exempts a ticket with a
 * pending `purpose='fix'` launch intent: the intent is recorded before the
 * terminal exists, and parking that window read a live agent as blocked
 * (REVIEW-2ND-ROUND-FIX-STUCK-WITH). Nothing, however, ever aged a pending
 * intent out, so an intent that never confirmed exempted its ticket from
 * BOTH sweeps forever and the fix row claimed `running` with nothing behind
 * it. This bounds that exemption with the project's own stall window.
 *
 * Strictly guarded: only a round still `pending` is settled. A round that has
 * reached `fixing` (or beyond) has an execution the sibling sweeps own, and
 * this sweep leaves its intent alone rather than risk accusing a live fix.
 *
 * PROJECT-SCOPED for the same reason as `sweepStalledFixRounds`: the window
 * comes from ITS project's manifest and the registry is shared by every
 * window.
 */
export function sweepAbandonedFixLaunches(
  store: Store,
  opts: SweepStalledFixOpts,
): StrandedFixRound[] {
  const nowMs = Date.parse(opts.at);
  if (!Number.isFinite(nowMs)) return [];
  if (!(opts.timeoutMs > 0)) return [];
  if (opts.projectId === null) return [];
  const cutoff = new Date(nowMs - opts.timeoutMs).toISOString();

  const rows = store.db
    .prepare(
      `SELECT i.id AS intent_id, i.launch_id, i.ticket_id,
              r.id AS round_id, r.round, r.source_stage
         FROM session_launch_intents i
         JOIN recovery_rounds r ON r.id = i.recovery_round_id
        WHERE i.purpose = 'fix' AND i.status = 'pending'
          AND r.status = 'pending'
          AND r.ticket_id = i.ticket_id
          AND i.created_at < ?
          AND i.ticket_id IN (SELECT id FROM tickets WHERE project_id = ?)
        ORDER BY i.id`,
    )
    .all(cutoff, opts.projectId) as {
    intent_id: number;
    launch_id: string;
    ticket_id: number;
    round_id: number;
    round: number;
    source_stage: string;
  }[];

  const stranded: StrandedFixRound[] = [];
  for (const row of rows) {
    const settle = store.db.transaction(() => {
      if (!failSessionLaunchIntent(store, row.launch_id, opts.at)) return false;
      // The round update is the guard for everything that follows: it is
      // constrained to the intent's OWN ticket and to `pending`. A malformed
      // row that names another ticket's round never interrupts it, and a round
      // that left `pending` since the snapshot (a live fix attached in another
      // window) is never parked. When it changes no row, the stale intent is
      // still failed above — the settled fact — but nothing else is written and
      // the row is not reported.
      const interrupted =
        store.db
          .prepare(
            `UPDATE recovery_rounds SET status = 'interrupted', ended_at = ?,
               interrupt_count = interrupt_count + 1
             WHERE id = ? AND ticket_id = ? AND status = 'pending'`,
          )
          .run(opts.at, row.round_id, row.ticket_id).changes === 1;
      if (!interrupted) return false;
      // The park is guarded by `parkFixStage` itself: a ticket that already
      // left fix, or a row already parked, is a no-op — the intent transition
      // above is still the settled fact this sweep reports.
      parkFixStage(store, row.ticket_id, FIX_PARKED_LAUNCH_NEVER_STARTED, opts.at);
      return true;
    });
    if (!settle()) continue;

    stranded.push({
      kind: 'launch',
      roundId: row.round_id,
      ticketId: row.ticket_id,
      sourceStage: row.source_stage as RecoverySourceStage,
      round: row.round,
      fixProcessRunId: null,
    });
  }
  return stranded;
}

/** One line naming a stranded fix this sweep settled, for the output channel. */
export function describeStrandedFixRound(s: StrandedFixRound): string {
  if (s.kind === 'launch') {
    return (
      `karst: ticket ${s.ticketId}: ${s.sourceStage} recovery round ${s.round} had a fix ` +
      `launch that never started before the stall timeout — the launch was failed and the fix ` +
      `is parked for a human if it was still at fix`
    );
  }
  if (s.kind === 'stalled') {
    return (
      `karst: ticket ${s.ticketId}: ${s.sourceStage} recovery round ${s.round} showed no progress ` +
      `before the stall timeout — the fix run was marked stale and the ticket is parked for a human`
    );
  }
  if (s.kind === 'stage') {
    return (
      `karst: ticket ${s.ticketId}: fix stage read running with no fix execution ` +
      `in flight — parked for a human`
    );
  }
  return (
    `karst: ticket ${s.ticketId}: ${s.sourceStage} recovery round ${s.round} was fixing ` +
    `with no live fix execution${s.fixProcessRunId === null ? ' (none was ever opened)' : ''} — ` +
    `marked interrupted; the ticket rests at fix for a human`
  );
}
