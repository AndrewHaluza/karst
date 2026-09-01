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

export interface CreateTicketFlowOpts {
  /**
   * Verbose decision-point logging (§ debug logging). Absent → no debug lines;
   * the host binds it to `Logger.debug` (a no-op unless the manifest's `debug`
   * flag is on).
   */
  debug?: (message: string) => void;
}

export function createTicketFlow(
  store: Store,
  input: CreateTicketInput,
  opts: CreateTicketFlowOpts = {},
): Ticket {
  const scope = { projectId: input.projectId };
  opts.debug?.(`[create] ticket: key '${input.key}' (project ${input.projectId ?? 'none'})`);

  // Idempotent by key *within a project*: recreating (or refetching) the same
  // ticket reuses the existing row instead of duplicating it. Existing fields
  // are left untouched; callers refresh ticket fields separately.
  const existing = getTicketByKey(store, input.key, scope);
  if (existing) {
    // Resurrect: an archived ticket recreated by key returns to the active list
    // rather than silently staying hidden (the row is reused, no key duplicate).
    if (existing.archivedAt !== null) {
      opts.debug?.(
        `[create] ticket: key '${input.key}' archived — resurrecting ticket #${existing.id}`,
      );
      unarchiveTicket(store, existing.id);
      return getTicketByKey(store, input.key, scope)!; // refreshed (archivedAt cleared)
    }
    opts.debug?.(`[create] ticket: key '${input.key}' exists — reusing ticket #${existing.id}`);
    return existing;
  }

  opts.debug?.(`[create] ticket: key '${input.key}' is new — creating`);
  return createTicket(store, {
    key: input.key,
    title: input.title,
    description: input.description,
    projectId: input.projectId,
  });
}
