import type { Store } from '../../store/db.js';
import type { StageKey } from '../../model/types.js';
import { transition } from '../machine.js';

/**
 * Implement stage boundary (§T4.3, §5.4). Implement *is* the M3 interactive
 * session; there is no deterministic signal a machine can read from it, so the
 * impl→uat transition is an **explicit marker** — the agent CLI
 * `karst stage impl pass` or a user action — never a `Stop` hook alone (the
 * no-inference guarantee: a session ending is not a verdict).
 */
export function markImplementDone(store: Store, ticketId: number): StageKey {
  return transition(store, ticketId, 'impl', { kind: 'passed' });
}
