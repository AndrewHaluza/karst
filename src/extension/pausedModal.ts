import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import { getTicket, unpauseTicket } from '../store/tickets.js';
import { formatId } from '../model/entityId.js';
import { askWhenPaused } from './ops/pausedAsk.js';

/** Modal binding of `askWhenPaused` for actions that need the driver (D303). */
export function askPausedModal(
  s: Store,
  ticketId: number,
  action: string,
  label: string,
  afterUnpause: () => void,
): Promise<'proceed' | 'cancel'> {
  return askWhenPaused({
    key: getTicket(s, ticketId).key ?? formatId('ticket', ticketId),
    action,
    label,
    isPaused: () => getTicket(s, ticketId).pausedAt != null,
    unpause: () => {
      unpauseTicket(s, ticketId);
      afterUnpause();
    },
    choose: async (message, choices) => vscode.window.showWarningMessage(message, { modal: true }, ...choices),
  });
}
