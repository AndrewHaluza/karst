import type { InventoryServer, ServerInventory } from '../store/serverInventory.js';
import { plural } from '../model/notifyText.js';

/**
 * Pure status-bar builder for the Servers panel, the same shape as
 * `resourceStatus.ts`: the `vscode` binding stays in `extension.ts`.
 *
 * Returns `null` while no server runs and none failed — a permanent empty badge
 * is noise on the one surface the user cannot dismiss. A failed server shows
 * first, in the warning colour, with its reason in the tooltip.
 */
export interface ServersIndicator {
  text: string;
  tooltip: string;
  /** The screen-reader text (`accessibilityInformation.label`): words, never a codicon. */
  accessibilityLabel: string;
  /** A server failed: the binding sets `statusBarItem.warningBackground`. */
  warning: boolean;
}

const OPEN_HINT = 'open Servers';

function failedLine(s: InventoryServer): string {
  return s.lastError ? `${s.repo}: ${s.lastError}` : s.repo;
}

export function buildServersIndicator(inventory: ServerInventory | undefined): ServersIndicator | null {
  if (!inventory) return null;
  const ticketRows = inventory.tickets.flatMap((g) => g.servers);
  const shared = inventory.shared.filter((s) => s.status === 'running').length;
  const tickets = ticketRows.filter((s) => s.status === 'running').length;
  const failed = [...inventory.shared, ...ticketRows].filter((s) => s.status === 'failed');
  const total = shared + tickets;
  if (failed.length > 0) {
    // A failed server must not hide behind the running count (RS-28).
    const head = `Karst: ${plural(failed.length, 'server', 'servers')} failed`;
    const lines = failed.map(failedLine);
    const runningLine = total > 0 ? [`${plural(total, 'server', 'servers')} running`] : [];
    return {
      text: `$(error) ${head}`,
      tooltip: `${[...lines, ...runningLine].join('\n')} — ${OPEN_HINT}`,
      accessibilityLabel: `${head}. ${[...lines, ...runningLine].join('. ')}. Open Servers.`,
      warning: true,
    };
  }
  if (total === 0) return null;
  const detail = `${plural(tickets, 'ticket server', 'ticket servers')}, ${shared} shared`;
  return {
    text: `$(server) Karst: ${plural(total, 'server', 'servers')}`,
    tooltip: `${detail} — ${OPEN_HINT}`,
    accessibilityLabel: `Karst: ${plural(total, 'server', 'servers')} running. ${detail}. Open Servers.`,
    warning: false,
  };
}
