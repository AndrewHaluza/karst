import type { Store } from './db.js';
import { STAGE_KEYS } from '../model/types.js';
import { rowToStage, type Stage } from './stages.js';
import { renderTicketLabel } from './ticketLabelTemplate.js';

export interface Ticket {
  id: number;
  key: string | null;
  title: string | null;
  source: string | null;
  stageCurrent: string | null;
  agentState: string | null;
  sessionId: string | null;
  /** v2 onboarding fields (§ onboarding). */
  description: string | null;
  brief: string | null;
  sourceRef: string | null;
  sourceFetchedAt: string | null;
  approach: string | null;
  /** Chosen single-subagent id (§ single-subagent selection); nullable. */
  agent: string | null;
  /** Parsed from the `selected_repos` JSON column; `[]` when unset/invalid. */
  selectedRepos: string[];
  /** Soft-delete timestamp; `null` = active. Archived tickets hide by default. */
  archivedAt: string | null;
  /** Per-ticket launch model id (§ model selection); `null` = inherit the manifest default. */
  model: string | null;
}

export interface TicketWithStages extends Ticket {
  stages: Stage[];
}

interface TicketRow {
  id: number;
  key: string | null;
  title: string | null;
  source: string | null;
  stage_current: string | null;
  agent_state: string | null;
  session_id: string | null;
  description: string | null;
  brief: string | null;
  source_ref: string | null;
  source_fetched_at: string | null;
  approach: string | null;
  agent: string | null;
  selected_repos: string | null;
  archived_at: string | null;
  model: string | null;
}

/**
 * Human label for a ticket in UI chrome (dashboard tab, spin picker title):
 * `"<key> — <title>"`, falling back to `#<id>` when key is unset and
 * `(untitled)` when title is unset. Single source of the convention the sidebar
 * (items.ts) also follows, so labels can't drift across surfaces.
 */
export function ticketLabel(ticket: Ticket, template?: string): string {
  return renderTicketLabel(ticket, template);
}

/** Parse the `selected_repos` JSON column into a string[], tolerating bad data. */
function parseSelectedRepos(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function rowToTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    source: r.source,
    stageCurrent: r.stage_current,
    agentState: r.agent_state,
    sessionId: r.session_id,
    description: r.description,
    brief: r.brief,
    sourceRef: r.source_ref,
    sourceFetchedAt: r.source_fetched_at,
    approach: r.approach,
    agent: r.agent,
    selectedRepos: parseSelectedRepos(r.selected_repos),
    archivedAt: r.archived_at,
    model: r.model,
  };
}

/**
 * Create a ticket and seed one row per MVP stage as `pending` (no `fetch`, C1).
 * Runs in a transaction so a ticket never exists without its stage rows.
 * Seeds `stage_current='scope'` and `agent_state='none'` (manual create path).
 */
export function createTicket(
  store: Store,
  input: { key: string; title: string; source?: string; description?: string },
): Ticket {
  const create = store.db.transaction((): Ticket => {
    const info = store.db
      .prepare(
        `INSERT INTO tickets (key, title, source, description, stage_current, agent_state)
         VALUES (?, ?, ?, ?, 'scope', 'none')`,
      )
      .run(input.key, input.title, input.source ?? 'manual', input.description ?? null);
    const id = Number(info.lastInsertRowid);

    const seed = store.db.prepare(
      'INSERT INTO stages (ticket_id, stage_key, status, attempt) VALUES (?, ?, ?, 0)',
    );
    for (const key of STAGE_KEYS) seed.run(id, key, 'pending');

    return getBareTicket(store, id);
  });
  return create();
}

function getBareTicket(store: Store, id: number): Ticket {
  const row = store.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
    | TicketRow
    | undefined;
  if (!row) throw new Error(`ticket ${id} not found`);
  return rowToTicket(row);
}

/** Find a ticket by its key, or `undefined` when none matches. */
export function getTicketByKey(store: Store, key: string): Ticket | undefined {
  const row = store.db.prepare('SELECT * FROM tickets WHERE key = ? LIMIT 1').get(key) as
    | TicketRow
    | undefined;
  return row ? rowToTicket(row) : undefined;
}

/** Load a ticket with all its stage rows. Throws if the id is unknown. */
export function getTicket(store: Store, id: number): TicketWithStages {
  const ticket = getBareTicket(store, id);
  const stages = loadStages(store, id);
  return { ...ticket, stages };
}

function loadStages(store: Store, id: number): Stage[] {
  const stageRows = store.db
    .prepare('SELECT * FROM stages WHERE ticket_id = ?')
    .all(id);
  return stageRows.map((r) => rowToStage(r as Parameters<typeof rowToStage>[0]));
}

/**
 * Set a ticket's `agent_state` — the ONLY liveness signal, driven by hooks
 * (§5.4). Never touches stage state (the no-inference guarantee). Single-writer
 * discipline: all agent_state mutation goes through here.
 */
export function setAgentState(
  store: Store,
  ticketId: number,
  agentState: 'running' | 'waiting' | 'idle' | 'none',
): void {
  store.db
    .prepare('UPDATE tickets SET agent_state = ? WHERE id = ?')
    .run(agentState, ticketId);
}

/**
 * Update a ticket's core identity fields (key/title) — the Edit-mode MVP writer.
 * `updated_at` bumps so downstream reconcilers see the change. Single-writer
 * discipline: core mutation goes through here.
 */
export function updateTicketCore(
  store: Store,
  ticketId: number,
  patch: { key?: string; title?: string },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.key !== undefined) {
    sets.push('key = ?');
    vals.push(patch.key);
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    vals.push(patch.title);
  }
  if (sets.length === 0) return; // empty patch: no-op
  sets.push("updated_at = datetime('now')");
  store.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...vals, ticketId);
}

/** The subset of onboarding fields a patch can set (all optional). */
export interface OnboardingPatch {
  description?: string;
  brief?: string;
  sourceRef?: string;
  sourceFetchedAt?: string;
  approach?: string;
  agent?: string;
  selectedRepos?: string[];
  /** Per-ticket launch model id; empty string clears it back to inherit. */
  model?: string;
}

/**
 * Update a ticket's onboarding fields (§ onboarding) — the persistence for the
 * onboarding page's fetch/brief/repo/approach state. Only the supplied fields
 * are written; `selectedRepos` is stored as a JSON array. Single-writer.
 */
export function updateTicketOnboarding(
  store: Store,
  ticketId: number,
  patch: OnboardingPatch,
): void {
  const columns: Record<string, unknown> = {};
  if (patch.description !== undefined) columns.description = patch.description;
  if (patch.brief !== undefined) columns.brief = patch.brief;
  if (patch.sourceRef !== undefined) columns.source_ref = patch.sourceRef;
  if (patch.sourceFetchedAt !== undefined) columns.source_fetched_at = patch.sourceFetchedAt;
  if (patch.approach !== undefined) columns.approach = patch.approach;
  if (patch.agent !== undefined) columns.agent = patch.agent;
  if (patch.selectedRepos !== undefined) {
    columns.selected_repos = JSON.stringify(patch.selectedRepos);
  }
  // An explicit empty string clears the per-ticket model back to "inherit" (NULL).
  if (patch.model !== undefined) columns.model = patch.model === '' ? null : patch.model;

  const entries = Object.entries(columns);
  if (entries.length === 0) return; // empty patch: no-op
  const sets = entries.map(([col]) => `${col} = ?`);
  sets.push("updated_at = datetime('now')");
  store.db
    .prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`)
    .run(...entries.map(([, v]) => v), ticketId);
}

/**
 * Archive a ticket (soft-delete): stamp `archived_at` now. Idempotent-ish — an
 * already-archived ticket gets a fresh timestamp. Single-writer discipline.
 */
export function archiveTicket(store: Store, ticketId: number): void {
  store.db
    .prepare("UPDATE tickets SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(ticketId);
}

/** Unarchive a ticket: clear `archived_at` so it returns to the active list. */
export function unarchiveTicket(store: Store, ticketId: number): void {
  store.db
    .prepare("UPDATE tickets SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(ticketId);
}

/** Related tables keyed by `ticket_id`, cleared on hard-delete (no FK cascade). */
const TICKET_CHILD_TABLES = [
  'stages',
  'worktrees',
  'port_allocations',
  'baseline_refs',
  'servers',
  'prs',
] as const;

/**
 * Hard-delete a ticket and all its child rows in a transaction. There are no FK
 * cascades in the schema, so each child table is cleared explicitly. Irreversible
 * — the caller (UI) confirms first.
 */
export function deleteTicket(store: Store, ticketId: number): void {
  const del = store.db.transaction((): void => {
    for (const table of TICKET_CHILD_TABLES) {
      store.db.prepare(`DELETE FROM ${table} WHERE ticket_id = ?`).run(ticketId);
    }
    store.db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
  });
  del();
}

/**
 * List tickets with their stage rows, ordered by id (creation order). Archived
 * tickets are excluded by default; pass `{ includeArchived: true }` to include
 * them (the Archived facet / "show archived" path).
 */
export function listTickets(
  store: Store,
  opts: { includeArchived?: boolean } = {},
): TicketWithStages[] {
  const where = opts.includeArchived ? '' : 'WHERE archived_at IS NULL';
  const rows = store.db
    .prepare(`SELECT * FROM tickets ${where} ORDER BY id`)
    .all() as TicketRow[];
  return rows.map((r) => {
    const ticket = rowToTicket(r);
    return { ...ticket, stages: loadStages(store, ticket.id) };
  });
}

/** List only archived tickets (the Archived facet view). */
export function listArchivedTickets(store: Store): TicketWithStages[] {
  const rows = store.db
    .prepare('SELECT * FROM tickets WHERE archived_at IS NOT NULL ORDER BY id')
    .all() as TicketRow[];
  return rows.map((r) => ({ ...rowToTicket(r), stages: loadStages(store, r.id) }));
}
