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
 * Host-agnostic: no vscode, no store import. The registry is keyed by the
 * database object, so two stores in one process never share entries.
 */

import { WORKSPACE_SETUP_TIMEOUT_MS } from '../workspace/workspaceDeps.js';

/** Clone time allowed on top of the workspace setup timeout. */
const CLONE_ALLOWANCE_MS = 5 * 60 * 1000;

/** How long a claimed launch may stay without a process before another window
 *  reads it as crashed. Not less than the setup timeout plus the clone time. */
export const LAUNCH_PREPARATION_TIMEOUT_MS = WORKSPACE_SETUP_TIMEOUT_MS + CLONE_ALLOWANCE_MS;

const inFlight = new WeakMap<object, Set<number>>();

/** Register a launch; the returned function unregisters it (call it in `finally`). */
export function markLaunchInFlight(db: object, nodeRunId: number): () => void {
  const ids = inFlight.get(db) ?? new Set<number>();
  ids.add(nodeRunId);
  inFlight.set(db, ids);
  return () => {
    ids.delete(nodeRunId);
  };
}

export function isLaunchInFlight(db: object, nodeRunId: number): boolean {
  return inFlight.get(db)?.has(nodeRunId) ?? false;
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
