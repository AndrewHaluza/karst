/**
 * The repository picker behind `karst.spinTicket`.
 *
 * A spin has two callers with different meanings. The ticket-level spin gives
 * every repository a worktree, so repositories with no service are offered too
 * — they simply never start a process, and the description says so. The
 * dashboard's server Start/Restart buttons mean "run the services": a
 * repository that declares no service is not runnable and must not appear in
 * that list at all.
 */

import type { Manifest } from '../../manifest/types.js';
import { serviceOf } from '../../manifest/runnable.js';

export interface SpinPick {
  readonly label: string;
  readonly description: string | undefined;
  readonly picked: boolean;
}

export interface SpinPickOptions {
  /** Offer only repositories that declare a service (server Start/Restart). */
  readonly servicesOnly?: boolean;
}

/**
 * Picks for `name`s in manifest order. `remembered` is the set the user last
 * chose for this ticket; absent, everything is pre-selected. A repository that
 * left the manifest since then simply drops out.
 */
export function spinRepoPicks(
  manifest: Manifest,
  remembered: string[] | undefined,
  options: SpinPickOptions,
): SpinPick[] {
  return Object.keys(manifest.repositories)
    .filter((name) => !options.servicesOnly || serviceOf(manifest, name) !== undefined)
    .map((name) => ({
      label: name,
      description: serviceOf(manifest, name) !== undefined
        ? undefined
        : 'no service — worktree only',
      picked: remembered ? remembered.includes(name) : true,
    }));
}

/** Read the `servicesOnly` flag off a command arg; anything else is false. */
export function servicesOnlyArg(arg: unknown): boolean {
  if (!arg || typeof arg !== 'object') return false;
  return (arg as { servicesOnly?: unknown }).servicesOnly === true;
}
