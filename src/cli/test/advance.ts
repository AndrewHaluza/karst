import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import { getTicket } from '../../store/tickets.js';
import { transition as defaultTransition } from '../../workflow/machine.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test advance` — inject a verdict and let the real stage machine advance
 * the ticket. This is the one test subcommand that imports the machine, and it
 * is deliberate: the driver's whole job is to exercise the machine's edges, and
 * `transition` is the exact seam the extension host uses. The separation the
 * security property cares about is that the agent-facing `stage`/`phase` verbs
 * stay narrow — this is a NEW, explicitly-powerful parse path for driving tests,
 * documented as such in the guide.
 *
 * A verdict that has no edge from the current stage throws (the machine's own
 * guarantee), so `advance --verdict failed` at `ship` fails loudly rather than
 * silently no-op.
 */

export type AdvanceVerdict =
  | { kind: 'passed' }
  | { kind: 'failed'; reason?: string };

export interface ParsedAdvance {
  verdict: AdvanceVerdict;
}

export function parseAdvanceArgs(argv: string[]): ParsedAdvance {
  const flags: TestFlags = parseFlags(argv);
  const verdict = requireFlag(flags, 'verdict');
  if (verdict === 'passed') return { verdict: { kind: 'passed' } };
  if (verdict === 'failed') {
    return { verdict: { kind: 'failed', reason: flags.reason } };
  }
  throw new Error(`unknown verdict '${verdict}' (want 'passed' or 'failed')`);
}

export function runAdvance(
  store: Store,
  ticketId: number,
  parsed: ParsedAdvance,
  transition: typeof defaultTransition = defaultTransition,
): string {
  const ticket = getTicket(store, ticketId);
  const from = ticket.stageCurrent as StageKey;
  const next = transition(store, ticketId, from, parsed.verdict);
  return JSON.stringify({ from, next, stageCurrent: next });
}
