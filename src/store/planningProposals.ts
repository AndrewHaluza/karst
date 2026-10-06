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
  createdAt: string;
  resolvedAt: string | null;
}

interface ProposalRow {
  id: number;
  session_id: number;
  payload_json: string;
  status: ProposalStatus;
  ticket_id: number | null;
  created_at: string;
  resolved_at: string | null;
}

const COLUMNS = 'p.id, p.session_id, p.payload_json, p.status, p.ticket_id, p.created_at, p.resolved_at';

function toProposal(r: ProposalRow): PlanningProposal {
  return {
    id: r.id,
    sessionId: r.session_id,
    payload: JSON.parse(r.payload_json) as ProposalPayload,
    status: r.status,
    ticketId: r.ticket_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function insertProposal(store: Store, sessionId: number, payload: ProposalPayload): number {
  const { lastInsertRowid } = store.db
    .prepare('INSERT INTO planning_proposals (session_id, payload_json) VALUES (?, ?)')
    .run(sessionId, JSON.stringify(payload));
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

export function discardProposal(store: Store, id: number): void {
  requirePending(store, id);
  store.db
    .prepare("UPDATE planning_proposals SET status = 'discarded', resolved_at = datetime('now') WHERE id = ?")
    .run(id);
}

/**
 * Turn a pending proposal into a ticket, atomically: create (source
 * 'planning', the session's project), fill description/brief/repos, link it
 * to the session, mark the proposal accepted. Returns the new ticket id.
 * `projectId`, when given, must be the session's project.
 */
export function acceptProposal(store: Store, id: number, opts: { projectId?: number } = {}): number {
  return store.db.transaction((): number => {
    const p = requirePending(store, id);
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
        "UPDATE planning_proposals SET status = 'accepted', ticket_id = ?, resolved_at = datetime('now') WHERE id = ?",
      )
      .run(ticket.id, id);
    return ticket.id;
  })();
}

/**
 * A ticket the user saved from the ticket form while reviewing a proposal:
 * link it to the session and mark the proposal accepted, in one transaction.
 */
export function markProposalAccepted(store: Store, id: number, ticketId: number): void {
  store.db.transaction((): void => {
    const p = requirePending(store, id);
    linkPlanningTicket(store, p.sessionId, ticketId);
    store.db
      .prepare(
        "UPDATE planning_proposals SET status = 'accepted', ticket_id = ?, resolved_at = datetime('now') WHERE id = ?",
      )
      .run(ticketId, id);
  })();
}
