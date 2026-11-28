import type { ProjectSandbox } from './sandboxInventory.js';

/** The two halves of a recorded ssh placement (`<remote>/<name>`). */
export interface PickPlacement {
  readonly remote: string;
  readonly name: string;
}

/**
 * The one sandbox that belongs to a ticket, found from the runners' own listing
 * (arch:AC-32), not from `sessionProvider` (null after a reload or for T700).
 * `hint` (the ticket's session provider) only breaks a tie: with leftovers from
 * a provider switch, the sandbox whose core matches wins, else the last listed
 * (sbx before docker; a warning names the choice). Invalid-core objects never match.
 *
 * An ssh item is listed per remote, so it matches only when the recorded
 * placement names that SAME `<remote>/<name>`; with no placement an ssh item is
 * never picked. A forgotten `stray` workspace never matches at all (D824): the
 * ticket stays sandbox-free until its `Delete`.
 */
export function pickTicketSandbox(
  sandboxes: readonly ProjectSandbox[],
  ticketId: number,
  hint: string | null,
  warn?: (message: string) => void,
  sshPlacement?: PickPlacement | null,
): ProjectSandbox | undefined {
  const mine = sandboxes.filter(
    (s) =>
      s.ticketId === ticketId &&
      s.invalidCore !== true &&
      s.stray !== true &&
      (s.runner !== 'ssh' ||
        (sshPlacement != null && s.remote === sshPlacement.remote && s.name === sshPlacement.name)),
  );
  if (mine.length <= 1) return mine[0];
  const hinted = mine.find((s) => s.core === hint);
  const chosen = hinted ?? mine[mine.length - 1]!;
  warn?.(`ticket ${ticketId} has ${mine.length} sandboxes (${mine.map((s) => s.name).join(', ')}); using ${chosen.name}`);
  return chosen;
}
