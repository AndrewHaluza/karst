import type { ProjectSandbox } from './sandboxInventory.js';

/**
 * The one sandbox that belongs to a ticket, found from the runners' own listing
 * (arch:AC-32), not from `sessionProvider` (null after a reload or for T700).
 * `hint` (the ticket's session provider) only breaks a tie: with leftovers from
 * a provider switch, the sandbox whose core matches wins, else the last listed
 * (sbx before docker; a warning names the choice). Invalid-core objects never match.
 */
export function pickTicketSandbox(
  sandboxes: readonly ProjectSandbox[],
  ticketId: number,
  hint: string | null,
  warn?: (message: string) => void,
): ProjectSandbox | undefined {
  const mine = sandboxes.filter((s) => s.ticketId === ticketId && s.invalidCore !== true);
  if (mine.length <= 1) return mine[0];
  const hinted = mine.find((s) => s.core === hint);
  const chosen = hinted ?? mine[mine.length - 1]!;
  warn?.(`ticket ${ticketId} has ${mine.length} sandboxes (${mine.map((s) => s.name).join(', ')}); using ${chosen.name}`);
  return chosen;
}
