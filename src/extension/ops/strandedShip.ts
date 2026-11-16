import {
  listStrandedShipTickets,
  describeStrandedShip,
  parkInterruptedShipStage,
} from '../../store/shipRuns.js';
import { getTicket } from '../../store/tickets.js';
import type { Store } from '../../store/db.js';
import type { Capability } from '../../runtime/deps.js';

export interface StrandedShipDeps {
  readonly store: Store;
  readonly projectId: number;
  readonly isAlive: (pid: number) => boolean;
  /** The ship capability guard. Returns false when ship must not run. */
  readonly guardCapability: (capability: Capability) => boolean | Promise<boolean>;
  readonly runShip: (ticketId: number) => Promise<unknown>;
  readonly info: (message: string) => void;
  readonly logError: (message: string, err: unknown) => void;
  /** Refresh the tree and push dashboard state for a ticket whose resume failed. */
  readonly onResumeFailed: (ticketId: number) => void;
}

/**
 * Stranded-ship recovery. A ship killed by a dead host leaves the ticket at
 * `ship` reading `running` with a `running` ship_runs row and no way out:
 * `settleShipGates` requires the awaiting-merge block the interrupted run
 * never wrote, the drive sweep above covers only uat/review, and a `running`
 * row offers no button in the dashboard — a freeze that survives every
 * reload. The saga is built to be re-run (`reconcilePriorShipOperations`
 * adopts or refutes the interrupted run's effects; commit/push skip what
 * already landed), so RESUME it here: the describe step re-runs, the PR
 * opens, and ship's tail parks awaiting-merge or walks the ticket to done.
 * `listStrandedShipTickets` proves death from stored state — a run still
 * carrying a LIVE pid is a ship another window is executing and is left
 * strictly alone — so this never double-runs a live saga.
 */
export async function resumeStrandedShips(deps: StrandedShipDeps): Promise<void> {
  for (const stranded of listStrandedShipTickets(deps.store, deps.isAlive, {
    projectId: deps.projectId,
  })) {
    if (!(await deps.guardCapability('ship'))) {
      // A resume that cannot start must not leave the stage `running` with no
      // Retry surface: park it `failed`, as `reconcileShipRuns` parks a dead
      // unattended run (@arch:SHIP-RESUME).
      if (parkInterruptedShipStage(deps.store, stranded.ticketId, new Date().toISOString())) {
        deps.info(
          `karst: stranded ship for ticket ${stranded.ticketId} parked failed — the ship capability is unavailable; retry ship to continue`,
        );
        deps.onResumeFailed(stranded.ticketId);
      }
      continue;
    }
    // A paused ticket starts nothing on its own, and a ship saga is work:
    // it describes with a model, pushes, and opens PRs. The stranded run
    // stays stranded until the user unpauses — the same recovery then runs
    // at the next activation.
    if (getTicket(deps.store, stranded.ticketId).pausedAt != null) {
      deps.info(
        `karst: stranded ship for ticket ${stranded.ticketId} left alone — the ticket is paused`,
      );
      continue;
    }
    deps.info(describeStrandedShip(stranded));
    void deps.runShip(stranded.ticketId).catch((e) => {
      deps.logError('karst: stranded ship resume failed', e);
      // A resume that rejects before the saga opens its run (a drain refusal, a
      // start guard) leaves the stage `running`: park it so "Retry ship" shows.
      // A stage the saga already failed is not `running`, so this is a no-op.
      parkInterruptedShipStage(deps.store, stranded.ticketId, new Date().toISOString());
      deps.onResumeFailed(stranded.ticketId);
    });
  }
}
