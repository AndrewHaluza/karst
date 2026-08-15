import type { Store } from '../../store/db.js';
import { createTicketFlow } from '../../workflow/stages/create.js';
import { updateTicketFields, type Ticket } from '../../store/tickets.js';
import { generateTicketKey } from '../../store/tickets.js';
import { getProjectBySlug, upsertProject } from '../../store/projects.js';
import { parseFlags, requireFlag, type TestFlags } from './flags.js';

/**
 * `karst test create-ticket` — create a ticket with full options, idempotent by
 * key exactly like the real create flow (`createTicketFlow`), so a test script
 * that re-runs never duplicates its fixture.
 *
 * A ticket can be scoped to a project with `--project <slug>`; without one the
 * manifest-derived project slug (from `--manifest`) is used as a fallback.
 * Scoping is what makes the ticket appear on a board — every production query
 * filters by `project_id`, so an unscoped ticket exists in the DB but is
 * invisible (the defect this flag exists to prevent).
 *
 * Delegates to the store/workflow helpers (`createTicketFlow`,
 * `updateTicketFields`, `upsertProject`) rather than writing SQL — the driver
 * reads the same single-writer seams production does, so it cannot drift from
 * them.
 */

export interface ParsedCreateTicket {
  title: string;
  key: string;
  type?: string;
  approach?: string;
  description?: string;
  /** Owning project slug; wins over the manifest-derived fallback. */
  project?: string;
}

export function parseCreateTicketArgs(argv: string[]): ParsedCreateTicket {
  const flags: TestFlags = parseFlags(argv);
  const title = requireFlag(flags, 'title');
  return {
    title,
    // A blank key is resolved here, once, from the title — same rule as the
    // ticket form's persistDraft (store/titleKey.ts), so a driver script can
    // create a ticket by title alone and still read back a stable key.
    key: flags.key ?? '',
    type: flags.type,
    approach: flags.approach,
    description: flags.description,
    project: flags.project,
  };
}

export function runCreateTicket(
  store: Store,
  parsed: ParsedCreateTicket,
  projectSlug?: string,
): string {
  // Explicit `--project` wins; the manifest-derived slug is the fallback.
  const slug = parsed.project ?? projectSlug;
  let projectId: number | undefined;
  if (slug) {
    // Create the project row on first sight, exactly like `bindProject` does —
    // a slug is the project's identity, and without a row the ticket would be
    // scoped to nothing (the invisible-ticket defect).
    projectId = getProjectBySlug(store, slug)?.id ?? upsertProject(store, { slug }).id;
  }
  const key =
    parsed.key !== '' ? parsed.key : generateTicketKey(store, { projectId }, parsed.title);
  const ticket: Ticket = createTicketFlow(store, {
    key,
    title: parsed.title,
    description: parsed.description,
    projectId,
  });
  if (parsed.type !== undefined) {
    updateTicketFields(store, ticket.id, { type: parsed.type });
  }
  if (parsed.approach !== undefined) {
    updateTicketFields(store, ticket.id, { approach: parsed.approach });
  }
  const row = store.db
    .prepare('SELECT created_at FROM tickets WHERE id = ?')
    .get(ticket.id) as { created_at: string };
  return JSON.stringify({
    id: ticket.id,
    key: ticket.key,
    stageCurrent: ticket.stageCurrent,
    createdAt: row.created_at,
    projectId: ticket.projectId ?? null,
    project: slug ?? null,
  });
}
