import type { ServerInventory } from '../store/serverInventory.js';

/**
 * Pure status-bar builder for the Servers panel, the same shape as
 * `resourceStatus.ts`: the `vscode` binding stays in `extension.ts`.
 *
 * Returns `null` while no server runs — a permanent empty badge is noise on the
 * one surface the user cannot dismiss.
 */
export interface ServersIndicator {
  text: string;
  tooltip: string;
}

export function buildServersIndicator(inventory: ServerInventory | undefined): ServersIndicator | null {
  if (!inventory) return null;
  const shared = inventory.shared.filter((s) => s.status === 'running').length;
  const tickets = inventory.tickets.reduce(
    (n, g) => n + g.servers.filter((s) => s.status === 'running').length,
    0,
  );
  const total = shared + tickets;
  if (total === 0) return null;
  return {
    text: `$(server) Karst: ${total} server${total === 1 ? '' : 's'}`,
    tooltip: `${tickets} ticket server${tickets === 1 ? '' : 's'}, ${shared} shared — open Servers`,
  };
}
