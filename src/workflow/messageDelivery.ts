import { cliTokensFor, quoteArg, type CliTokens, type ExportedCliEnv } from '../agent/cliEnv.js';

/**
 * Mailbox delivery seam (vscode-free). The sweep decides WHEN a recipient is
 * told; a `MessageDelivery` decides HOW. v1 nudges the recipient's terminal
 * with a fixed pointer line — never a body, sender or ticket key, so nothing
 * an agent wrote can reach another agent's input except through `inbox`,
 * which frames it as untrusted.
 *
 * `nudge` sends ONE line (sendText + newline). Mid-turn, the pointer becomes
 * the agent's next queued input; that is the existing nudge mechanism.
 */

export type DeliveryResult = 'delivered' | 'deferred';

export interface MessageDelivery {
  deliver(toTicketId: number, unread: number): DeliveryResult;
}

/** Everything outside printable ASCII is dropped from host-supplied tokens. */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '');
}

function assertPositiveInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`message pointer: ${what} must be a positive integer`);
}

/**
 * The pointer line: fixed text, the unread count, and the `inbox` command in
 * the recipient session's env (refs when it exported them, literal host paths
 * and the numeric id otherwise).
 */
export function messagePointer(
  unread: number,
  toTicketId: number,
  exported: ExportedCliEnv | undefined,
  literal: CliTokens,
): string {
  assertPositiveInt(unread, 'unread count');
  assertPositiveInt(toTicketId, 'ticket id');
  const tok = cliTokensFor(exported, { ...literal, ticket: String(toTicketId) });
  const arg = (t: string): string => quoteArg(printable(t));
  const ticket = tok.ticket === String(toTicketId) ? String(toTicketId) : arg(tok.ticket ?? '');
  const parts = [
    'node',
    arg(tok.cli),
    'inbox',
    '--db',
    arg(tok.db),
    ...(tok.manifest ? ['--manifest', arg(tok.manifest)] : []),
    '--ticket',
    ticket,
  ];
  return printable(`karst: ${unread} new message(s) - run ${parts.join(' ')}`);
}

export interface TerminalDeliveryDeps {
  /** Live in THIS window (open or adoptable terminal). */
  isLive: (ticketId: number) => boolean;
  /** The graph coordinator owns the session (`nudgeSurface === 'no-op'`). */
  graphOwned: (ticketId: number) => boolean;
  nudge: (ticketId: number, line: string) => boolean;
  sessionCliEnv: (ticketId: number) => ExportedCliEnv | undefined;
  literal: () => CliTokens;
}

/** v1: nudge the recipient's live terminal with the pointer line. */
export function makeTerminalDelivery(deps: TerminalDeliveryDeps): MessageDelivery {
  return {
    deliver(toTicketId, unread) {
      if (!deps.isLive(toTicketId) || deps.graphOwned(toTicketId)) return 'deferred';
      const line = messagePointer(unread, toTicketId, deps.sessionCliEnv(toTicketId), deps.literal());
      return deps.nudge(toTicketId, line) ? 'delivered' : 'deferred';
    },
  };
}
