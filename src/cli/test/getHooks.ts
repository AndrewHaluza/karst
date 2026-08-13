import type { Store } from '../../store/db.js';
import { listTestHooks } from './testMode.js';
import { parseFlags } from './flags.js';

/**
 * `karst test get-hooks` — the hook events the driver dispatched for a ticket,
 * in dispatch order, each carrying the agent_state the dispatch left behind.
 * Pure READ over `listTestHooks`.
 */

export function parseGetHooksArgs(argv: string[]): void {
  parseFlags(argv); // accepts --json; validated for a well-formed line
}

export function runGetHooks(store: Store, ticketId: number): string {
  const hooks = listTestHooks(store, ticketId);
  return JSON.stringify(
    hooks.map((h) => ({
      id: h.id,
      event: h.event,
      sessionId: h.sessionId,
      receivedAt: h.recordedAt,
      agentState: h.agentStateAfter,
      payload: h.payload,
    })),
    null,
    2,
  );
}
