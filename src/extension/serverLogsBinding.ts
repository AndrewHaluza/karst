import type { Store } from '../store/db.js';
import { listServersByTicket } from '../store/dashboard.js';
import type { ServerInventory } from '../store/serverInventory.js';
import { serverStatusWordOf } from '../model/serverStatusText.js';
import type { ServerLogsManagerOptions, ServerLogsSourceRow } from '../ui/serverLogs/panel.js';

/**
 * The two seams the standalone Server logs manager needs from the host: the log
 * rows of one ticket (or of the project's shared services) and the options that
 * name them — the ticket key in the title, the clipboard write for Copy, and
 * the shared scope's rows.
 *
 * It lives here, not in `extension.ts`, so the activation function keeps only
 * the wiring call (the `extension.ts` ratchet). Each row carries its RS-17
 * status word, so a logs tab names the server's state (LG-14); nothing here
 * touches `vscode`.
 */
export interface ServerLogsBindingDeps {
  store: Store;
  /** A ticket's key for the view title, or null when the ticket is gone. */
  ticketKeyOf: (ticketId: number) => string | null;
  /** A fresh project inventory; undefined when there is no project or manifest. */
  inventory: () => ServerInventory | undefined;
  /** Write the view's Copy text (bound to `vscode.env.clipboard.writeText`). */
  writeClipboard: (text: string) => Promise<void>;
}

export function makeServerLogsBinding(deps: ServerLogsBindingDeps): {
  logServers: (ticketId: number) => ServerLogsSourceRow[];
  options: ServerLogsManagerOptions;
} {
  const withStatus = (
    rows: ReadonlyArray<{ service: string; logPath: string | null; status: string }>,
  ): ServerLogsSourceRow[] =>
    rows.map((s) => ({ service: s.service, logPath: s.logPath, status: serverStatusWordOf(s.status) }));

  return {
    logServers: (ticketId) => withStatus(listServersByTicket(deps.store, ticketId)),
    options: {
      writeClipboard: deps.writeClipboard,
      ticketKeyFor: deps.ticketKeyOf,
      // A shared row's Logs verb opens the project's shared services (RS-13).
      sharedLogServers: () => {
        try {
          // Stryker disable next-line OptionalChaining: a throw on an undefined inventory lands in the catch below, with the same [] result
          return (deps.inventory()?.shared ?? []).map((s) => ({
            service: s.repo,
            logPath: s.logPath,
            status: serverStatusWordOf(s.status),
          }));
        } catch {
          return [];
        }
      },
    },
  };
}
