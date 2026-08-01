import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { getTicket } from '../../store/tickets.js';
import { transition } from '../machine.js';

/**
 * Fix stage (§T4.4, §11, §5.3). Resumes the ticket's captured session so the
 * agent keeps its context, then re-enters the uat gate (the
 * fix→revalidate→uat loop). Idempotent: a fix run is safe to repeat — the
 * transition only fires on the resumed run's verdict, and `attempt` climbs per
 * loop in the machine.
 *
 * MVP treats a completed resume as "ready to revalidate" and transitions
 * fix→uat; the *actual* re-gate happens when `runUat` runs next. There is
 * no captured session to resume ⇒ throw (we never fix blind).
 */
export interface RunFixOpts {
  ticketId: number;
  cwd: string;
}

export async function runFix(
  store: Store,
  opts: RunFixOpts,
  adapter: AgentAdapter,
): Promise<StageKey> {
  const ticket = getTicket(store, opts.ticketId);
  if (!ticket.sessionId) {
    throw new Error(
      `cannot fix ticket ${opts.ticketId}: no captured session_id to --resume`,
    );
  }

  await adapter.runHeadless({
    prompt: 'Address the failing review gates, then stop.',
    cwd: opts.cwd,
    resume: ticket.sessionId,
    tracking: { callSite: 'fix-resume', ticketId: opts.ticketId },
  });

  // Revalidate: fix pass re-enters uat (the deterministic re-gate).
  return transition(store, opts.ticketId, 'fix', { kind: 'passed' });
}
