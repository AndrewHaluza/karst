import type { Store } from './db.js';
import { createTicket, generateTicketKey, updateTicketFields } from './tickets.js';
import { getPlanningSession, linkPlanningTicket } from './planningSessions.js';

/**
 * Planning proposals (v65) — a draft ticket a planning session handed to the
 * host through its outbox. The host validated it on ingest; the user decides
 * (accept → a real ticket, or discard). Nothing here runs in the CLI: accept
 * is host-side, so ONE better-sqlite3 transaction covers it (createTicket's
 * own transaction nests as a savepoint).
 */

export interface ProposalPayload {
  title: string;
  description: string;
  summary: string;
  repos: string[];
}

export type ProposalStatus = 'pending' | 'accepted' | 'discarded';

export interface PlanningProposal {
  id: number;
  sessionId: number;
  payload: ProposalPayload;
  status: ProposalStatus;
  ticketId: number | null;
  /** The outbox file uuid that created or last revised this proposal. Host-owned
   *  correlation data, persisted here so the index is never read back. */
  sourceUuid: string;
  createdAt: string;
  /** Last mutation (created, revised, accepted, discarded) — feeds the index. */
  updatedAt: string;
  resolvedAt: string | null;
}

interface ProposalRow {
  id: number;
  session_id: number;
  payload_json: string;
  status: ProposalStatus;
  ticket_id: number | null;
  source_uuid: string;
  created_at: string;
  /** Nullable: the v66 ALTER cannot add a function default, so a row inserted
   *  between the ALTER and the code that sets it could read NULL. */
  updated_at: string | null;
  resolved_at: string | null;
}

const COLUMNS =
  'p.id, p.session_id, p.payload_json, p.status, p.ticket_id, p.source_uuid, p.created_at, p.updated_at, p.resolved_at';

function toProposal(r: ProposalRow): PlanningProposal {
  return {
    id: r.id,
    sessionId: r.session_id,
    payload: JSON.parse(r.payload_json) as ProposalPayload,
    status: r.status,
    ticketId: r.ticket_id,
    sourceUuid: r.source_uuid,
    createdAt: r.created_at,
    // The v66 column is nullable on a migrated DB (SQLite forbids a function
    // default in ALTER TABLE ADD COLUMN), so a NULL falls back to created_at:
    // "never revised" is the honest last-touched time, and the index's
    // string-only entry filter must never drop a real proposal over it.
    updatedAt: r.updated_at ?? r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function insertProposal(
  store: Store,
  sessionId: number,
  payload: ProposalPayload,
  sourceUuid = '',
): number {
  // `updated_at` is set EXPLICITLY, not left to the schema default: on a
  // migrated v65 DB the v66 column is nullable (SQLite forbids a function
  // default in ALTER TABLE ADD COLUMN), so a bare INSERT would write NULL and
  // the proposal would vanish from the session index.
  const { lastInsertRowid } = store.db
    .prepare(
      "INSERT INTO planning_proposals (session_id, payload_json, source_uuid, updated_at) VALUES (?, ?, ?, datetime('now'))",
    )
    .run(sessionId, JSON.stringify(payload), sourceUuid);
  return Number(lastInsertRowid);
}

export function getProposal(store: Store, id: number): PlanningProposal | undefined {
  const row = store.db
    .prepare(`SELECT ${COLUMNS} FROM planning_proposals p WHERE p.id = ?`)
    .get(id) as ProposalRow | undefined;
  return row ? toProposal(row) : undefined;
}

/** Pending proposals of the project's non-archived sessions, oldest first. */
export function listPendingProposals(store: Store, projectId: number): PlanningProposal[] {
  const rows = store.db
    .prepare(
      `SELECT ${COLUMNS} FROM planning_proposals p
       JOIN planning_sessions s ON s.id = p.session_id
       WHERE s.project_id = ? AND s.status <> 'archived' AND p.status = 'pending'
       ORDER BY p.id`,
    )
    .all(projectId) as ProposalRow[];
  return rows.map(toProposal);
}

/**
 * The proposals the sidebar shows under the project's sessions (archived
 * ones included): pending first, then accepted — discarded ones are gone.
 */
export function listVisibleProposals(store: Store, projectId: number): PlanningProposal[] {
  const rows = store.db
    .prepare(
      `SELECT ${COLUMNS} FROM planning_proposals p
       JOIN planning_sessions s ON s.id = p.session_id
       WHERE s.project_id = ? AND p.status IN ('pending', 'accepted')
       ORDER BY p.status = 'accepted', p.id`,
    )
    .all(projectId) as ProposalRow[];
  return rows.map(toProposal);
}

/**
 * Every proposal of ONE session, oldest first — pending, accepted and
 * discarded alike. The host rebuilds the session's on-disk proposal index from
 * this (the agent sees its whole proposal history, including what a human
 * rejected).
 */
export function listSessionProposals(store: Store, sessionId: number): PlanningProposal[] {
  const rows = store.db
    .prepare(`SELECT ${COLUMNS} FROM planning_proposals p WHERE p.session_id = ? ORDER BY p.id`)
    .all(sessionId) as ProposalRow[];
  return rows.map(toProposal);
}

export function countPending(store: Store, sessionId: number): number {
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM planning_proposals WHERE session_id = ? AND status = 'pending'")
    .get(sessionId) as { n: number };
  return row.n;
}

function requirePending(store: Store, id: number): PlanningProposal {
  const p = getProposal(store, id);
  if (!p) throw new Error(`planning proposal ${id} not found`);
  if (p.status !== 'pending') throw new Error(`planning proposal ${id} is not pending (${p.status})`);
  return p;
}

/**
 * Replace a pending proposal's payload IN PLACE (a planning agent revising a
 * draft), stamping `updated_at`. The caller has already authorized the update
 * (same session, still pending); `requirePending` is the last-line guard.
 */
export function updateProposalPayload(
  store: Store,
  id: number,
  payload: ProposalPayload,
  sourceUuid?: string,
): void {
  requirePending(store, id);
  if (sourceUuid === undefined) {
    store.db
      .prepare("UPDATE planning_proposals SET payload_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(payload), id);
    return;
  }
  store.db
    .prepare(
      "UPDATE planning_proposals SET payload_json = ?, source_uuid = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(JSON.stringify(payload), sourceUuid, id);
}

export function discardProposal(store: Store, id: number): void {
  requirePending(store, id);
  store.db
    .prepare(
      "UPDATE planning_proposals SET status = 'discarded', updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?",
    )
    .run(id);
}

/** Exact content equality (repos order-sensitive), independent of JSON key order. */
export function proposalPayloadEquals(a: ProposalPayload, b: ProposalPayload): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.summary === b.summary &&
    a.repos.length === b.repos.length &&
    a.repos.every((r, i) => r === b.repos[i])
  );
}

/**
 * Turn a pending proposal into a ticket, atomically: create (source
 * 'planning', the session's project), fill description/brief/repos, link it
 * to the session, mark the proposal accepted. Returns the new ticket id.
 * `projectId`, when given, must be the session's project.
 *
 * `expectedPayload` is the content the human confirmed in the preview. An
 * in-place revision (`updateProposalPayload`) can land while that modal is
 * open, so accept re-reads INSIDE the transaction and refuses if the payload
 * moved: the human must never confirm one thing and create another.
 */
export function acceptProposal(
  store: Store,
  id: number,
  opts: { projectId?: number; expectedPayload?: ProposalPayload } = {},
): number {
  return store.db.transaction((): number => {
    const p = requirePending(store, id);
    if (opts.expectedPayload !== undefined && !proposalPayloadEquals(p.payload, opts.expectedPayload)) {
      throw new Error(`planning proposal ${id} changed since it was reviewed`);
    }
    const session = getPlanningSession(store, p.sessionId);
    if (!session) throw new Error(`planning session ${p.sessionId} not found`);
    if (opts.projectId !== undefined && opts.projectId !== session.projectId) {
      throw new Error(`planning proposal ${id} belongs to another project`);
    }
    const { title, description, summary, repos } = p.payload;
    const ticket = createTicket(store, {
      key: generateTicketKey(store, { projectId: session.projectId }, title),
      title,
      source: 'planning',
      projectId: session.projectId,
    });
    updateTicketFields(store, ticket.id, { description, brief: summary, selectedRepos: repos });
    linkPlanningTicket(store, session.id, ticket.id);
    store.db
      .prepare(
        "UPDATE planning_proposals SET status = 'accepted', ticket_id = ?, updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?",
      )
      .run(ticket.id, id);
    return ticket.id;
  })();
}

/**
 * A ticket the user saved from the ticket form while reviewing a proposal:
 * link it to the session and mark the proposal accepted, in one transaction.
 *
 * The form's ticket is built from content the human SAW (the prefill they may
 * have edited), and it is created OUTSIDE this transaction, so an in-place
 * revision that lands while the form is open must NOT refuse here — that would
 * orphan the saved ticket and leave the draft pending (re-review then makes a
 * second ticket). The human's save is authoritative; `planningProposalOps`
 * warns when the draft had moved, so the revision is not dropped silently.
 */
export function markProposalAccepted(store: Store, id: number, ticketId: number): void {
  store.db.transaction((): void => {
    const p = requirePending(store, id);
    linkPlanningTicket(store, p.sessionId, ticketId);
    store.db
      .prepare(
        "UPDATE planning_proposals SET status = 'accepted', ticket_id = ?, updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?",
      )
      .run(ticketId, id);
  })();
}
