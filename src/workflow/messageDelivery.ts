import { cliTokensFor, quoteArg, type CliTokens, type ExportedCliEnv } from '../agent/cliEnv.js';

/**
 * Mailbox delivery seam (vscode-free). The sweep decides WHEN a recipient is
 * told; a `MessageDelivery` decides HOW. v1 nudges the recipient's terminal
 * with a fixed pointer line — never a body, sender or ticket key, so nothing
 * an agent wrote can reach another agent's input except through `inbox`,
 * which frames it as untrusted.
 *
 * `nudge` types ONE line and submits it with a separate `\r` (the
 * MAILBOX-DELIVERY-RELIABLE-SUBMIT Enter-fix). Mid-turn, the pointer becomes
 * the agent's next queued input; that is the existing nudge mechanism. For agy
 * the pointer waits until the conversation reports idle — its TUI swallows a
 * line typed mid-turn.
 */

/**
 * `delivered` means the pointer was ACCEPTED by the recipient's live terminal —
 * for a typed nudge, queued into that terminal's FIFO (`NudgeQueue`), which
 * types it and submits with its own `\r`. It does NOT mean the agent has read
 * it yet: `nudge` is intentionally synchronous (it returns once the line is
 * queued, keeping the boolean contract its callers depend on). `deferred` means
 * nothing was typed and the sweep retries.
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

/** Characters a literal path may not carry into a typed line. */
const SHELL_META = /["$`\\']/;

/**
 * The pointer line: fixed text, the unread count, and the `inbox` command in
 * the recipient session's env (refs when it exported them, literal host paths
 * and the numeric id otherwise). `null` when a literal path carries a shell
 * metacharacter — nothing is typed then.
 */
export function messagePointer(
  unread: number,
  toTicketId: number,
  exported: ExportedCliEnv | undefined,
  literal: CliTokens,
): string | null {
  assertPositiveInt(unread, 'unread count');
  assertPositiveInt(toTicketId, 'ticket id');
  const tok = cliTokensFor(exported, { ...literal, ticket: String(toTicketId) });
  const literals = [tok.cli, tok.db, tok.manifest].filter(
    (t): t is string => t !== undefined && (t === literal.cli || t === literal.db || t === literal.manifest),
  );
  // A literal is typed into a shell as-is: refuse rather than escape.
  if (literals.some((t) => SHELL_META.test(t))) return null;
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
  /**
   * True while the recipient's agy session has NOT reported idle (its run
   * status is still running, or its conversation is not yet observed). The agy
   * TUI swallows a line typed mid-turn, so the pointer is deferred and the
   * sweep retries once the turn ends. Absent → no idle gate (every other core
   * accepts a typed line at any time).
   */
  agyBusy?: (ticketId: number) => boolean;
  nudge: (ticketId: number, line: string) => boolean;
  sessionCliEnv: (ticketId: number) => ExportedCliEnv | undefined;
  literal: () => CliTokens;
}

/** v1: nudge the recipient's live terminal with the pointer line. */
export function makeTerminalDelivery(deps: TerminalDeliveryDeps): MessageDelivery {
  return {
    deliver(toTicketId, unread) {
      if (!deps.isLive(toTicketId) || deps.graphOwned(toTicketId)) return 'deferred';
      // agy only: hold the pointer until the turn ends, then the sweep retries.
      if (deps.agyBusy?.(toTicketId)) return 'deferred';
      const line = messagePointer(unread, toTicketId, deps.sessionCliEnv(toTicketId), deps.literal());
      if (line === null) return 'deferred';
      return deps.nudge(toTicketId, line) ? 'delivered' : 'deferred';
    },
  };
}
