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
 *
 * `armed` means a push route was chosen but NOTHING was delivered yet: the
 * pointer will be pushed when the recipient's turn ends. The sweep must not
 * treat an arm as a delivery — it leaves the watermark alone, so if the turn
 * ends WITHOUT the turn-end hook reaching the endpoint (an interrupted or
 * quarantined session), the next sweep re-evaluates and types the pointer
 * instead of stranding the batch.
 */
export type DeliveryResult = 'delivered' | 'armed' | 'deferred';

/**
 * What the recipient is being told about: the mailbox (`mail`) or the project
 * bulletin (`notes`). The host writes the pointer text, so the recipient's agent
 * never receives an agent-authored body through this channel.
 */
export type MessagePointer = { kind: 'mail'; unread: number } | { kind: 'notes'; unread: number };

/** The mail pointer; a helper so callers never spell the kind. */
export function mailPointer(unread: number): MessagePointer {
  return { kind: 'mail', unread };
}

/** The project-notes pointer; the host writes its text, never a note body. */
export function notesPointer(unread: number): MessagePointer {
  return { kind: 'notes', unread };
}

export interface MessageDelivery {
  deliver(toTicketId: number, pointer: MessagePointer): DeliveryResult;
}

/**
 * How a recipient's core receives a mail pointer. Resolved from the recipient's
 * CURRENT live session core at delivery time (never stored per ticket): a core
 * can change between stages or resumes (a codex implement followed by a claude
 * fix), and a route cached at send time would push into the dead core.
 *
 * - `hook-block` — the core's Stop hook replies with a block + the pointer
 *   (claude, and codex once the Stop-block spike passes). The endpoint builds
 *   the reply; the bridge prints it to stdout.
 * - `plugin-idle` — the core's plugin reads the reply body on its turn-end
 *   event and pushes the pointer through its SDK (opencode v1, session.idle).
 * - `typed` — the #56 typed nudge into the live terminal (opencode2, agy, and
 *   every route that cannot push).
 */
export type MessageRoute = 'hook-block' | 'plugin-idle' | 'typed';

/** Everything outside printable ASCII is dropped from host-supplied tokens. */
function printable(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '');
}

function assertPositiveInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`message pointer: ${what} must be a positive integer`);
}

/** Characters a literal path may not carry into a typed line. */
const SHELL_META = /["$`\\']/;

/** Fixed wording and the CLI command per pointer kind. */
const POINTER_TEXT = {
  mail: { noun: 'message(s)', command: 'inbox' },
  notes: { noun: 'project note(s)', command: 'notes' },
} as const;

/**
 * The pointer line: fixed text, the unread count, and the kind's CLI command
 * (`inbox` or `notes`) in the recipient session's env (refs when it exported
 * them, literal host paths and the numeric id otherwise). `null` when a literal
 * path carries a shell metacharacter — nothing is typed then.
 */
export function messagePointer(
  pointer: MessagePointer,
  toTicketId: number,
  exported: ExportedCliEnv | undefined,
  literal: CliTokens,
): string | null {
  const { noun, command } = POINTER_TEXT[pointer.kind];
  assertPositiveInt(pointer.unread, 'unread count');
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
    command,
    '--db',
    arg(tok.db),
    ...(tok.manifest ? ['--manifest', arg(tok.manifest)] : []),
    '--ticket',
    ticket,
  ];
  return printable(`karst: ${pointer.unread} new ${noun} - run ${parts.join(' ')}`);
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
    deliver(toTicketId, pointer) {
      if (!deps.isLive(toTicketId) || deps.graphOwned(toTicketId)) return 'deferred';
      // agy only: hold the pointer until the turn ends, then the sweep retries.
      if (deps.agyBusy?.(toTicketId)) return 'deferred';
      const line = messagePointer(pointer, toTicketId, deps.sessionCliEnv(toTicketId), deps.literal());
      if (line === null) return 'deferred';
      return deps.nudge(toTicketId, line) ? 'delivered' : 'deferred';
    },
  };
}

export interface RoutedDeliveryDeps {
  /** The recipient's core route, resolved LIVE at delivery time. */
  routeFor: (ticketId: number) => MessageRoute;
  /** Live in THIS window (open or adoptable terminal). */
  isLive: (ticketId: number) => boolean;
  /** The graph coordinator owns the session. */
  graphOwned: (ticketId: number) => boolean;
  /**
   * True while the recipient's agent is MID-TURN (agent_state `running`). A
   * hook/plugin reply only ever fires at the END of a turn, so a push route is
   * usable only while one is in flight: an IDLE recipient has already passed
   * its Stop/idle event, and waiting for another would strand the pointer.
   * An idle recipient takes the typed route (safe for every non-agy core).
   */
  isBusy: (ticketId: number) => boolean;
  /** The typed route (#56), used for cores with no push channel and as the fallback. */
  typed: MessageDelivery;
}

/**
 * The one delivery seam: pick the recipient's route from its live core, and
 * fall back to the typed nudge for any core the endpoint reply cannot reach
 * (opencode2, agy, an unknown/retired session) OR any recipient that is not
 * mid-turn (an idle recipient's Stop/idle already fired, so a push would never
 * arrive). A busy hook route delivers nothing now — it ARMS the push; the
 * pointer is pushed when the turn ends, from the unread cache the sweep
 * refreshed, so nothing is typed mid-turn.
 */
export function makeRoutedDelivery(deps: RoutedDeliveryDeps): MessageDelivery {
  return {
    deliver(toTicketId, pointer) {
      const route = deps.routeFor(toTicketId);
      if (route === 'typed') return deps.typed.deliver(toTicketId, pointer);
      if (!deps.isLive(toTicketId) || deps.graphOwned(toTicketId)) return 'deferred';
      // Idle: the turn-end reply will not fire again — type the pointer now.
      if (!deps.isBusy(toTicketId)) return deps.typed.deliver(toTicketId, pointer);
      // Notes never arm (the hook reply only carries mail): wait until idle.
      if (pointer.kind === 'notes') return 'deferred';
      return 'armed';
    },
  };
}
