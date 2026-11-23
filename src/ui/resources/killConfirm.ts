import type { ResourceReading } from '../../runtime/resourceMonitor.js';
import type { WasteKind } from '../../runtime/wasteFindings.js';
import type { BaselineDependent } from '../../store/baselineRefs.js';
import { formatId } from '../../model/entityId.js';
import { plural } from '../../model/notifyText.js';
import { formatBytes, type TicketIdentity } from './state.js';

/** The confirm text when the reading knows nothing about the row. */
export const KILL_CONFIRM_FALLBACK = 'Stop this server process?';

/** Why a waste row is waste, in one sentence the user can check. */
const WASTE_SENTENCE: Readonly<Record<WasteKind, string>> = {
  'ticket-finished': 'It still runs after its ticket finished.',
  'container-ticket-finished': 'It still runs after its ticket finished.',
  'worktree-gone': 'Its worktree no longer exists.',
  'orphan-worktree-process': 'No karst server row owns it.',
};

export interface KillConfirmInput {
  serverId: number;
  reading: ResourceReading;
  dependents: readonly BaselineDependent[];
  ticketIdentity?: (ids: readonly number[]) => ReadonlyMap<number, TicketIdentity>;
}

function dependentLabel(d: BaselineDependent): string {
  // Name the KEYS the user can match against their board, never the raw
  // `tickets.id`. A done ticket is named with the reason it still counts.
  const key = d.key ?? formatId('ticket', d.ticketId);
  return d.stageCurrent === 'done' && d.hasRunningService ? `${key} (done, still running)` : key;
}

function dependentSentence(dependents: readonly BaselineDependent[]): string {
  if (dependents.length === 0) return '';
  const labels = dependents.map(dependentLabel).join(', ');
  const whom = dependents.length === 1 ? 'it' : 'all of them';
  return (
    `It is a shared server for ${plural(dependents.length, 'ticket', 'tickets')}: ${labels}. ` +
    `Stopping it takes the dependency out from under ${whom}.`
  );
}

/**
 * The host-side kill confirm (UI-R33, RS-6). It names the process from the
 * reading: "Stop api of FEAT-12 (pid 4123, 512.0 MB)? It still runs after its
 * ticket finished." Each part that the reading does not know is left out.
 */
export function killConfirmText(input: KillConfirmInput): string {
  const { serverId, reading, dependents } = input;
  const row = reading.inventory?.attributed.find((r) => r.serverId === serverId);
  const waste = reading.waste.find((w) => w.serverId === serverId);
  const ticketId = row?.ticketId ?? waste?.ticketId ?? null;
  const pid = waste?.pid ?? (row && row.pid > 0 ? row.pid : null);
  const rssBytes = waste?.rssBytes ?? row?.cost?.rssBytes ?? null;
  const tail = [waste ? WASTE_SENTENCE[waste.kind] : '', dependentSentence(dependents)].filter(Boolean);
  if (!row?.label) {
    return [KILL_CONFIRM_FALLBACK, ...tail].join(' ');
  }
  const key =
    ticketId === null
      ? null
      : (input.ticketIdentity?.([ticketId]).get(ticketId)?.key ?? formatId('ticket', ticketId));
  const facts = [pid === null ? '' : `pid ${pid}`, rssBytes === null ? '' : formatBytes(rssBytes)].filter(Boolean);
  const head =
    `Stop ${row.label}${key === null ? '' : ` of ${key}`}` + (facts.length > 0 ? ` (${facts.join(', ')})` : '') + '?';
  return [head, ...tail].join(' ');
}
