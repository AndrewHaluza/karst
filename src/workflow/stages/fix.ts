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
 *
 * This headless helper is NOT the production recovery route — the driver
 * resumes an INTERACTIVE session (live nudge or relaunched terminal) tracked
 * against its committed recovery round (`workflow/fixExecution.ts`). It is kept
 * only for its tested callers (token attribution, lifecycle integration); a fix
 * that runs through it is untracked by design.
 */
export interface RunFixOpts {
  ticketId: number;
  cwd: string;
  /**
   * Verbose decision-point logging (§ debug logging). Absent → no debug lines;
   * the host binds it to `Logger.debug` (a no-op unless the manifest's `debug`
   * flag is on).
   */
  debug?: (message: string) => void;
}

export async function runFix(
  store: Store,
  opts: RunFixOpts,
  adapter: AgentAdapter,
): Promise<StageKey> {
  const ticket = getTicket(store, opts.ticketId);
  opts.debug?.(
    `[driver] fix ticket ${opts.ticketId}: resuming session ` +
      `${ticket.sessionId ? `'${ticket.sessionId}'` : '(none)'} in ${opts.cwd}`,
  );
  if (!ticket.sessionId) {
    opts.debug?.(
      `[driver] fix ticket ${opts.ticketId}: cannot fix — no captured session_id to resume`,
    );
    throw new Error(
      `cannot fix ticket ${opts.ticketId}: no captured session_id to --resume`,
    );
  }

  opts.debug?.(`[driver] fix ticket ${opts.ticketId}: running headless resume`);
  await adapter.runHeadless({
    prompt: 'Address the failing review gates, then stop.',
    cwd: opts.cwd,
    resume: ticket.sessionId,
    tracking: { callSite: 'fix-resume', ticketId: opts.ticketId },
  });

  // Revalidate: fix pass re-enters uat (the deterministic re-gate).
  opts.debug?.(`[driver] fix ticket ${opts.ticketId}: resume done — transition fix→uat`);
  return transition(store, opts.ticketId, 'fix', { kind: 'passed' });
}
