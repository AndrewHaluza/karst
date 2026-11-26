/**
 * Launches in flight in THIS window.
 *
 * The driver claims an agent node run (`ready → launching`, launch identity
 * written) BEFORE it prepares the workspace, which can take minutes (a clone,
 * then the D644 setup). During that time the row is `launching` with an owner
 * nonce and no process — the shape `reconcileLaunching` reads as "crashed
 * before spawn". This registry tells the window's own reconcile that the
 * launch is alive. Another window cannot see it, so a claim also gets a
 * deadline: a claim older than `LAUNCH_PREPARATION_TIMEOUT_MS` is a crash.
 *
 * A planner launch registers in its OWN set. It claims `launching` and then
 * awaits `transport.start` just as a node launch does, so the window's own
 * reconcile must skip it too. The sets are separate on purpose: planner run
 * ids and node run ids come from different tables and can be equal.
 *
 * Host-agnostic: no vscode, no store import. The registry is keyed by the
 * database object, so two stores in one process never share entries.
 */

import { WORKSPACE_SETUP_TIMEOUT_MS } from '../workspace/workspaceDeps.js';

/** Clone time allowed on top of the workspace setup timeout. */
const CLONE_ALLOWANCE_MS = 5 * 60 * 1000;

/** How long a claimed launch may stay without a process before another window
 *  reads it as crashed. Not less than the setup timeout plus the clone time. */
export const LAUNCH_PREPARATION_TIMEOUT_MS = WORKSPACE_SETUP_TIMEOUT_MS + CLONE_ALLOWANCE_MS;

const nodeInFlight = new WeakMap<object, Set<number>>();
const plannerInFlight = new WeakMap<object, Set<number>>();

/** Register a launch; the returned function unregisters it (call it in `finally`). */
export function markLaunchInFlight(db: object, nodeRunId: number): () => void {
  const ids = nodeInFlight.get(db) ?? new Set<number>();
  ids.add(nodeRunId);
  nodeInFlight.set(db, ids);
  return () => {
    ids.delete(nodeRunId);
  };
}

export function isLaunchInFlight(db: object, nodeRunId: number): boolean {
  return nodeInFlight.get(db)?.has(nodeRunId) ?? false;
}

/** Register a PLANNER launch; the returned function unregisters it (call it in
 *  `finally`). A separate set from the node one — see the header. */
export function markPlannerLaunchInFlight(db: object, plannerRunId: number): () => void {
  const ids = plannerInFlight.get(db) ?? new Set<number>();
  ids.add(plannerRunId);
  plannerInFlight.set(db, ids);
  return () => {
    ids.delete(plannerRunId);
  };
}

export function isPlannerLaunchInFlight(db: object, plannerRunId: number): boolean {
  return plannerInFlight.get(db)?.has(plannerRunId) ?? false;
}

const UUID_V7_PREFIX = /^([0-9a-f]{8})-([0-9a-f]{4})-7/;

/** The claim time in ms, read from the UUIDv7 generation the claim wrote (its
 *  first 48 bits are the injected clock). `undefined` for a row with no
 *  generation or a foreign one: such a row has no known age. */
export function launchClaimedAtMs(generation: string | null): number | undefined {
  const match = generation === null ? null : UUID_V7_PREFIX.exec(generation);
  if (!match) return undefined;
  return parseInt(`${match[1]}${match[2]}`, 16);
}
