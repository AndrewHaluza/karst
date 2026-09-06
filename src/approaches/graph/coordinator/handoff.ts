/**
 * The graph → stage-driver handoff read.
 *
 * A graph ticket's impl marker advances it to `uat`, and from that instant the
 * ticket belongs to the STAGE DRIVER again — but nothing tells the driver so.
 * The two coordinator sweeps only tick runs in an ACTIVE status
 * (`activeGraphRunIds` selects `running`), and `maybeDrive` is kicked by a
 * hook, a session close, an unpause, a stage-resume or an activation. A graph
 * node is a supervised headless process and the marker is fired by the `karst`
 * CLI in another process or by the Inside button, so NONE of those triggers
 * fire: the ticket sits at `uat` with the stage row reading `running`, no gate
 * run ever opened, until the window is reloaded and the activation sweep finds
 * it. That is the reported "UAT gates stuck for 8+ minutes" — no gate was ever
 * started.
 *
 * This is the read that closes the gap: the graph sweep already runs on its own
 * tick, and it is the one place that knows a run left graph ownership. The
 * selection is deliberately the same shape as `ticketsToSweep`
 * (`workflow/driverController.ts`) — a deterministic gate stage, not paused,
 * not blocked — narrowed to tickets that actually ran a graph, so this never
 * becomes a second, divergent driver sweep for ordinary tickets.
 *
 * `driveTicket`'s single-flight guard (`DriverController.begin`) makes a repeat
 * selection on the next tick a no-op, so nothing here needs to remember what it
 * already handed off.
 *
 * Host-agnostic: a plain read over the driver-agnostic `GraphDb`.
 */

import type { GraphDb } from '../../../store/graph/transitions.js';
import { ACTIVE_GRAPH_STATUSES } from '../entryPoints.js';

/** The deterministic gate stages the stage driver may auto-run. Mirrors
 *  `AUTO_GATES` in `workflow/driverController.ts` — the driver refuses any
 *  other stage at its own entry, so a wider selection here only wastes a
 *  no-op call. */
const DRIVER_GATE_STAGES: readonly string[] = ['uat', 'review'] as const;

/**
 * Tickets that ran a graph, are parked at a deterministic gate the driver
 * owns, and have NO graph run left in an active status — the coordinator has
 * nothing more to do for them and the driver has not been told to start.
 *
 * Excluded, for the same reasons the activation sweep excludes them: a paused
 * ticket (pause must cost nothing) and a ticket whose current stage carries a
 * block (parking is durable — re-driving would re-run the failed stage to park
 * in the same place forever).
 */
export function ticketsAwaitingGraphDrive(
  db: GraphDb,
  scope: { projectId: number },
): number[] {
  const stagePlaceholders = DRIVER_GATE_STAGES.map(() => '?').join(', ');
  const activePlaceholders = [...ACTIVE_GRAPH_STATUSES].map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT DISTINCT t.id AS id
         FROM tickets t
         JOIN approach_graph_runs r ON r.ticket_id = t.id
         LEFT JOIN stages s ON s.ticket_id = t.id AND s.stage_key = t.stage_current
        WHERE t.project_id = ?
          AND t.paused_at IS NULL
          AND t.stage_current IN (${stagePlaceholders})
          AND s.blocked_kind IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM approach_graph_runs a
                 WHERE a.ticket_id = t.id AND a.status IN (${activePlaceholders})
              )
        ORDER BY t.id`,
    )
    .all(
      scope.projectId,
      ...DRIVER_GATE_STAGES,
      ...ACTIVE_GRAPH_STATUSES,
    ) as { id: number }[];
  return rows.map((r) => r.id);
}
