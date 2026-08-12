import type { Store } from '../../store/db.js';
import type { Ticket } from '../../store/tickets.js';
import { dispatchHook, type HookPayload } from '../../hooks/dispatch.js';
import { recordTestHook, ensureTestWorktree, testWorktreePath } from './testMode.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test simulate-hook` — post a hook event straight into the dispatch
 * layer, bypassing the HTTP endpoint. The event takes the exact path production
 * hooks do (`dispatchHook`), so agent_state, session capture, the launch-intent
 * handshake and every other side effect behave identically — only the transport
 * is skipped.
 *
 * `dispatchHook` resolves the payload's `cwd` against the `worktrees` table, so
 * the driver first ensures a worktree row maps the ticket to the chosen path —
 * the same state a real scope stage would have produced. Without `--cwd` the
 * path is a deterministic synthetic one (`testWorktreePath`).
 */

/** The closed set of events `dispatchHook` understands as lifecycle signals. */
const HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'UsageUpdate',
];

export interface ParsedSimulateHook {
  event: string;
  sessionId: string | null;
  cwd: string;
  message: string | null;
  notificationType: string | null;
}

export function parseSimulateHookArgs(argv: string[]): ParsedSimulateHook {
  const flags: TestFlags = parseFlags(argv);
  const event = requireFlag(flags, 'event');
  if (!HOOK_EVENTS.includes(event)) {
    throw new Error(
      `unknown hook event '${event}' (want one of ${HOOK_EVENTS.join(', ')})`,
    );
  }
  return {
    event,
    sessionId: flags['session-id'] ?? null,
    cwd: flags.cwd ?? '',
    message: flags.message ?? null,
    notificationType: flags['notification-type'] ?? null,
  };
}

export function runSimulateHook(
  store: Store,
  ticket: Ticket,
  parsed: ParsedSimulateHook,
): string {
  const cwd =
    parsed.cwd !== ''
      ? parsed.cwd
      : testWorktreePath(ticket.id, ticket.key ?? String(ticket.id));
  ensureTestWorktree(store, ticket.id, cwd);

  const payload: HookPayload = {
    hook_event_name: parsed.event,
    cwd,
    ...(parsed.sessionId !== null ? { session_id: parsed.sessionId } : {}),
    ...(parsed.message !== null ? { message: parsed.message } : {}),
    ...(parsed.notificationType !== null ? { notification_type: parsed.notificationType } : {}),
  };
  dispatchHook(store, payload);

  const after = store.db
    .prepare('SELECT agent_state FROM tickets WHERE id = ?')
    .get(ticket.id) as { agent_state: string | null } | undefined;
  const agentState = after?.agent_state ?? null;
  recordTestHook(store, {
    ticketId: ticket.id,
    event: parsed.event,
    sessionId: parsed.sessionId,
    payload,
    agentStateAfter: agentState,
  });

  return JSON.stringify({ agentState, hooksRecorded: 1 });
}
