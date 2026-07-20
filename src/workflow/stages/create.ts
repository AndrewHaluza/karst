import type { Store } from '../../store/db.js';
import {
  createTicket,
  getTicketByKey,
  unarchiveTicket,
  type Ticket,
} from '../../store/tickets.js';

/**
 * Manual ticket entry (§T4.2, MVP §2.4). Provider fetch is post-MVP (C1), so
 * every MVP ticket is hand-entered and seeds directly at `scope` with all stage
 * rows `pending` — that seeding lives in `createTicket` (T1.6), which this flow
 * wraps to keep the create/scope stages in one place.
 *
 * `description` feeds the scope prompt later and is now persisted (v2 schema
 * added the column); it is threaded straight through to `createTicket`.
 */
export interface CreateTicketInput {
  key: string;
  title: string;
  description?: string;
  /**
   * Owning project (§ projects / multi-window). Also narrows the idempotency
   * lookup: two projects may legitimately track the same key, and without this
   * the second project's create would hand back the first's ticket.
   */
  projectId?: number;
}

export function createTicketFlow(store: Store, input: CreateTicketInput): Ticket {
  const scope = { projectId: input.projectId };

  // Idempotent by key *within a project*: recreating (or refetching) the same
  // ticket reuses the existing row instead of duplicating it. Existing fields
  // are left untouched; callers refresh onboarding fields separately.
  const existing = getTicketByKey(store, input.key, scope);
  if (existing) {
    // Resurrect: an archived ticket recreated by key returns to the active list
    // rather than silently staying hidden (the row is reused, no key duplicate).
    if (existing.archivedAt !== null) {
      unarchiveTicket(store, existing.id);
      return getTicketByKey(store, input.key, scope)!; // refreshed (archivedAt cleared)
    }
    return existing;
  }

  return createTicket(store, {
    key: input.key,
    title: input.title,
    description: input.description,
    projectId: input.projectId,
  });
}
