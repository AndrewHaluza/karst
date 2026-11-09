import type { Store } from './db.js';
import { getTicket, updateTicketFields } from './tickets.js';
import { getPlanningSession, linkPlanningTicket } from './planningSessions.js';
import { addRelation } from './ticketRelations.js';
import { postMessage } from './ticketMessages.js';
import { formatId } from '../model/entityId.js';

/**
 * Planning proposals (v65) — a draft ticket a planning session handed to the
 * host through its outbox. The host validated it on ingest; the user decides
 * (accept → a real ticket, or discard). Nothing here runs in the CLI: accept is
 * host-side, so `markProposalAccepted` covers it in ONE better-sqlite3
 * transaction. A proposal never becomes a ticket directly — the user's own Save
 * of the prefilled ticket form mints the ticket, then this links and resolves it.
 */

/** One `dependsOn` entry: a draft id (number) or an open ticket (`T<n>`). */
export type ProposalDependency = number | `T${number}`;

const ticketDep = (n: number): ProposalDependency => `T${n}`;
const isTicketDep = (d: ProposalDependency): d is `T${number}` => typeof d === 'string';
const depTicketId = (d: `T${number}`): number => Number(d.slice(1));

export interface ProposalPayload {
  title: string;
  description: string;
  summary: string;
  repos: string[];
  /**
   * What this draft waits on: host proposal ids of ANY session of the project
   * (numbers) and open ticket ids (`T<n>`). Draft ids live in the dedicated
   * `planning_proposals.depends_on` JSON column and ticket ids in
   * `depends_on_tickets`, NOT in `payload_json`; reads merge both back onto the
   * payload (drafts first) so callers see one object. Absent when empty.
   */
  dependsOn?: ProposalDependency[];
  /** Design rules / prior work the draft cites (see `Proposal.constraints`). Absent when none. */
  constraints?: string[];
}

export type ProposalStatus = 'pending' | 'accepted' | 'discarded';

export interface PlanningProposal {
  id: number;
  sessionId: number;
  payload: ProposalPayload;
  status: ProposalStatus;
  ticketId: number | null;
  /** Per-repo base commit shas (v80) recorded at ingest / revise. */
  baseShas: Record<string, string>;
  /**
   * Host proposal ids pruned from `payload.dependsOn` because their target was
   * discarded. Host-owned (never agent input): the sidebar warns on the draft
   * card so a broken ordering edge is not lost silently. Cleared on revise.
   */
  droppedDepends: number[];
  /**
   * Host-owned check results (unknown design key/commit, sensitive code with no
   * rule). Stored under the reserved `hostWarnings` key of `payload_json` — no
   * column — and stripped from `payload`, so callers see agent content and host
   * warnings apart. Recomputed on every revise; `[]` for rows without the key.
   */
  warnings: string[];
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
  base_shas?: string | null;
  depends_on: string;
  depends_on_tickets?: string | null;
  depends_dropped: string;
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
  'p.id, p.session_id, p.payload_json, p.base_shas, p.depends_on, p.depends_on_tickets, p.depends_dropped, p.status, p.ticket_id, p.source_uuid, p.created_at, p.updated_at, p.resolved_at';

/** A JSON column holding a positive-integer id array, decoded defensively —
 *  a corrupt or non-array value reads as none. */
function parseIdArray(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.every((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
      ? v
      : [];
  } catch {
    return [];
  }
}

/** Split the public payload into the stored body and its `depends_on` (draft ids)
 *  and `depends_on_tickets` (ticket ids) columns; `warnings` ride in the body
 *  under the reserved `hostWarnings` key. */
function splitPayload(
  payload: ProposalPayload,
  warnings: readonly string[],
): { body: string; dependsOn: string; dependsOnTickets: string } {
  const { dependsOn = [], ...rest } = payload;
  const body = warnings.length > 0 ? { ...rest, hostWarnings: warnings } : rest;
  return {
    body: JSON.stringify(body),
    dependsOn: JSON.stringify(dependsOn.filter((d): d is number => !isTicketDep(d))),
    dependsOnTickets: JSON.stringify(dependsOn.filter(isTicketDep).map(depTicketId)),
  };
}

function parseBaseShas(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function toProposal(r: ProposalRow): PlanningProposal {
  const { hostWarnings, ...payload } = JSON.parse(r.payload_json) as ProposalPayload & { hostWarnings?: unknown };
  const warnings =
    Array.isArray(hostWarnings) && hostWarnings.every((w): w is string => typeof w === 'string') ? hostWarnings : [];
  const dependsOn: ProposalDependency[] = [
    ...parseIdArray(r.depends_on),
    ...parseIdArray(r.depends_on_tickets ?? null).map(ticketDep),
  ];
  if (dependsOn.length > 0) payload.dependsOn = dependsOn;
  return {
    id: r.id,
    sessionId: r.session_id,
    payload,
    status: r.status,
    ticketId: r.ticket_id,
    baseShas: parseBaseShas(r.base_shas),
    droppedDepends: parseIdArray(r.depends_dropped),
    warnings,
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
  warnings: readonly string[] = [],
  baseShas: Record<string, string> = {},
): number {
  // `updated_at` is set EXPLICITLY, not left to the schema default: on a
  // migrated v65 DB the v66 column is nullable (SQLite forbids a function
  // default in ALTER TABLE ADD COLUMN), so a bare INSERT would write NULL and
  // the proposal would vanish from the session index.
  const { body, dependsOn, dependsOnTickets } = splitPayload(payload, warnings);
  const { lastInsertRowid } = store.db
    .prepare(
      "INSERT INTO planning_proposals (session_id, payload_json, base_shas, depends_on, depends_on_tickets, source_uuid, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    )
    .run(sessionId, body, JSON.stringify(baseShas), dependsOn, dependsOnTickets, sourceUuid);
  return Number(lastInsertRowid);
}

export function getProposal(store: Store, id: number): PlanningProposal | undefined {
  const row = store.db
    .prepare(`SELECT ${COLUMNS} FROM planning_proposals p WHERE p.id = ?`)
    .get(id) as ProposalRow | undefined;
  return row ? toProposal(row) : undefined;
}

/** The draft a ticket was created from (`ticket_id` link), or undefined for a hand-made ticket. */
export function getProposalForTicket(store: Store, ticketId: number): PlanningProposal | undefined {
  const row = store.db
    .prepare(`SELECT ${COLUMNS} FROM planning_proposals p WHERE p.ticket_id = ? ORDER BY p.id LIMIT 1`)
    .get(ticketId) as ProposalRow | undefined;
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
 * ones included): pending first, then accepted, each newest first like the ticket list — discarded ones are gone.
 */
export function listVisibleProposals(store: Store, projectId: number): PlanningProposal[] {
  const rows = store.db
    .prepare(
      `SELECT ${COLUMNS} FROM planning_proposals p
       JOIN planning_sessions s ON s.id = p.session_id
       WHERE s.project_id = ? AND p.status IN ('pending', 'accepted')
       ORDER BY p.status = 'accepted', p.id DESC`,
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

/** Every proposal of the project, any session and status, oldest first. */
export function listProjectProposals(store: Store, projectId: number): PlanningProposal[] {
  const rows = store.db
    .prepare(
      `SELECT ${COLUMNS} FROM planning_proposals p
       JOIN planning_sessions s ON s.id = p.session_id
       WHERE s.project_id = ? ORDER BY p.id`,
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
  if (!p) throw new Error(`draft ${formatId('draft', id)} not found`);
  if (p.status !== 'pending') throw new Error(`draft ${formatId('draft', id)} is not pending (${p.status})`);
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
  warnings: readonly string[] = [],
  baseShas?: Record<string, string>,
): void {
  requirePending(store, id);
  const { body, dependsOn, dependsOnTickets } = splitPayload(payload, warnings);
  const cur = getProposal(store, id);
  const shasJson = JSON.stringify(baseShas ?? cur?.baseShas ?? {});
  if (sourceUuid === undefined) {
    store.db
      .prepare(
        "UPDATE planning_proposals SET payload_json = ?, base_shas = ?, depends_on = ?, depends_on_tickets = ?, depends_dropped = '[]', updated_at = datetime('now') WHERE id = ?",
      )
      .run(body, shasJson, dependsOn, dependsOnTickets, id);
    return;
  }
  store.db
    .prepare(
      "UPDATE planning_proposals SET payload_json = ?, base_shas = ?, depends_on = ?, depends_on_tickets = ?, depends_dropped = '[]', source_uuid = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(body, shasJson, dependsOn, dependsOnTickets, sourceUuid, id);
}

/** Replace only a pending proposal's host warnings (a late async check result). */
export function setProposalWarnings(store: Store, id: number, warnings: readonly string[]): void {
  const p = requirePending(store, id);
  const { body } = splitPayload(p.payload, warnings);
  store.db.prepare('UPDATE planning_proposals SET payload_json = ?, updated_at = datetime(\'now\') WHERE id = ?').run(body, id);
}

/** Replace only a pending proposal's recorded base shas (a late async resolve result). */
export function setProposalBaseShas(store: Store, id: number, baseShas: Record<string, string>): void {
  requirePending(store, id);
  store.db
    .prepare("UPDATE planning_proposals SET base_shas = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(baseShas), id);
}

/**
 * Mark a pending proposal discarded. Its dependents are cleaned up in the SAME
 * transaction: rows that targeted it as a proposal are deleted (and each ticket
 * that held one gets an inbox warning — it is no longer blocked), and every
 * dependent — pending OR accepted — has the id pruned from its `depends_on` so
 * no card keeps advertising a discarded draft. A still-pending dependent also
 * records the id in `depends_dropped`, which the sidebar renders as a warning
 * on its card (an accepted one is already linked to its ticket, so no warning).
 * Returns the ids of the pending dependents whose `depends_on` was pruned, so
 * the caller can surface the reason.
 */
export function discardProposal(store: Store, id: number): number[] {
  return store.db.transaction((): number[] => {
    const p = requirePending(store, id);
    const dependents = store.db
      .prepare('SELECT DISTINCT ticket_id FROM ticket_relations WHERE target_proposal_id = ?')
      .all(id) as { ticket_id: number }[];
    store.db.prepare('DELETE FROM ticket_relations WHERE target_proposal_id = ?').run(id);
    for (const { ticket_id } of dependents) {
      postMessage(store, {
        projectId: getTicket(store, ticket_id)?.projectId ?? null,
        fromTicketId: null,
        toTicketId: ticket_id,
        kind: 'event',
        body: `blocker draft ${formatId('draft', id)} was discarded; this ticket is no longer blocked by it`,
      });
    }
    const pruned: number[] = [];
    const projectId = getPlanningSession(store, p.sessionId)?.projectId;
    // Dependents may live in ANY session of the project (cross-session edges).
    const everyProposal = projectId === undefined ? listSessionProposals(store, p.sessionId) : listProjectProposals(store, projectId);
    for (const other of everyProposal) {
      const deps = other.payload.dependsOn ?? [];
      if (!deps.includes(id)) continue;
      const remaining = JSON.stringify(deps.filter((d): d is number => typeof d === 'number' && d !== id));
      if (other.status === 'pending') {
        const dropped = new Set([...other.droppedDepends, id]);
        store.db
          .prepare(
            "UPDATE planning_proposals SET depends_on = ?, depends_dropped = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(remaining, JSON.stringify([...dropped]), other.id);
        pruned.push(other.id);
      } else {
        store.db
          .prepare(
            "UPDATE planning_proposals SET depends_on = ?, updated_at = datetime('now') WHERE id = ?",
          )
          .run(remaining, other.id);
      }
    }
    store.db
      .prepare(
        "UPDATE planning_proposals SET status = 'discarded', updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?",
      )
      .run(id);
    return pruned;
  })();
}

const sameList = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Exact content equality (repos, dependsOn and constraints order-sensitive; host warnings
 *  are not payload and never compared), independent of JSON key order. */
export function proposalPayloadEquals(a: ProposalPayload, b: ProposalPayload): boolean {
  const ad = a.dependsOn ?? [];
  const bd = b.dependsOn ?? [];
  return (
    sameList(a.constraints ?? [], b.constraints ?? []) &&
    a.title === b.title &&
    a.description === b.description &&
    a.summary === b.summary &&
    a.repos.length === b.repos.length &&
    a.repos.every((r, i) => r === b.repos[i]) &&
    ad.length === bd.length &&
    ad.every((n, i) => n === bd[i])
  );
}

/** Stages a ticket never leaves: nothing can unblock a draft that waits on one of them. */
const FINISHED_STAGES: readonly string[] = ['done', 'closed'];

const nodeOfDraft = (id: number): string => `D${id}`;
const nodeOfTicket = (id: number): string => `T${id}`;
const nodeOfDep = (d: ProposalDependency): string => (isTicketDep(d) ? d : nodeOfDraft(d));
/** Sentinel for a create: the draft has no id yet, and no real node is called `new`. */
const NEW_NODE = 'new';

/** A ticket dependency problem, or undefined when the ticket is an open one of the project. */
function ticketDepProblem(store: Store, projectId: number, ticketId: number): string | undefined {
  const row = store.db
    .prepare('SELECT project_id, archived_at, stage_current, subtask_parent_id FROM tickets WHERE id = ?')
    .get(ticketId) as { project_id: number | null; archived_at: string | null; stage_current: string | null; subtask_parent_id: number | null } | undefined;
  const name = formatId('ticket', ticketId);
  if (!row || row.project_id !== projectId) return `dependsOn ${name} is not a ticket of this project`;
  if (row.archived_at !== null) return `dependsOn ${name} is archived`;
  if (row.subtask_parent_id !== null) return `dependsOn ${name} is a subtask, not a top-level ticket`;
  if (row.stage_current !== null && FINISHED_STAGES.includes(row.stage_current)) {
    return `dependsOn ${name} is already ${row.stage_current}`;
  }
  return undefined;
}

/** The project's dependency graph: every non-discarded proposal's edges, an
 *  accepted proposal's link to its ticket, and every `blocked-by` relation row. */
function projectGraph(
  store: Store,
  projectId: number,
  incomingId: number | undefined,
  dependsOn: readonly ProposalDependency[],
): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const p of listProjectProposals(store, projectId)) {
    if (p.status === 'discarded') continue;
    const own = incomingId === p.id ? dependsOn : (p.payload.dependsOn ?? []);
    const out = own.map(nodeOfDep);
    if (p.status === 'accepted' && p.ticketId !== null) out.push(nodeOfTicket(p.ticketId));
    edges.set(nodeOfDraft(p.id), out);
  }
  const relations = store.db
    .prepare(
      `SELECT r.ticket_id, r.target_ticket_id, r.target_proposal_id FROM ticket_relations r
       JOIN tickets t ON t.id = r.ticket_id
       WHERE r.kind = 'blocked-by' AND t.project_id = ?
         AND (r.target_ticket_id IS NOT NULL OR r.target_proposal_id IS NOT NULL)`,
    )
    .all(projectId) as { ticket_id: number; target_ticket_id: number | null; target_proposal_id: number | null }[];
  for (const r of relations) {
    const from = nodeOfTicket(r.ticket_id);
    const to = r.target_ticket_id !== null ? nodeOfTicket(r.target_ticket_id) : nodeOfDraft(r.target_proposal_id!);
    edges.set(from, [...(edges.get(from) ?? []), to]);
  }
  if (incomingId === undefined) edges.set(NEW_NODE, dependsOn.map(nodeOfDep));
  return edges;
}

/**
 * Why `dependsOn` cannot be ingested for a proposal of `sessionId`, or undefined
 * when it is valid. A draft id must name a NON-discarded proposal of ANY session
 * of the SAME project; a ticket id (`T<n>`) must name a ticket of the same
 * project that is neither archived nor done. Substituting the incoming edges
 * must leave the PROJECT graph acyclic: every non-discarded proposal's edges
 * plus the `blocked-by` relation rows. `incomingId` is the proposal being
 * created or revised (undefined for a create — a fresh draft has no id yet).
 */
export function validateProposalDependsOn(
  store: Store,
  sessionId: number,
  incomingId: number | undefined,
  dependsOn: readonly ProposalDependency[],
): string | undefined {
  if (dependsOn.length === 0) return undefined;
  const projectId = getPlanningSession(store, sessionId)?.projectId;
  if (projectId === undefined) return 'dependsOn cannot be checked: the planning session is unknown';
  const byId = new Map(listProjectProposals(store, projectId).map((p) => [p.id, p]));
  for (const dep of dependsOn) {
    if (isTicketDep(dep)) {
      const problem = ticketDepProblem(store, projectId, depTicketId(dep));
      if (problem) return problem;
      continue;
    }
    const found = byId.get(dep);
    if (!found) return `dependsOn ${formatId('draft', dep)} is not a proposal of this project`;
    if (found.status === 'discarded') return `dependsOn ${formatId('draft', dep)} was already discarded`;
  }
  return graphHasCycle(projectGraph(store, projectId, incomingId, dependsOn)) ? 'dependsOn would create a cycle' : undefined;
}

function graphHasCycle(edges: Map<string, string[]>): boolean {
  // 0 = unseen, 1 = on the current DFS stack, 2 = settled.
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (n: string): boolean => {
    state.set(n, 1);
    for (const dep of edges.get(n) ?? []) {
      const s = state.get(dep);
      if (s === 1) return true;
      if (s === undefined && visit(dep)) return true;
    }
    state.set(n, 2);
    return false;
  };
  for (const n of edges.keys()) {
    if (state.get(n) === undefined && visit(n)) return true;
  }
  return false;
}

/**
 * A ticket the user saved from the ticket form while reviewing a proposal:
 * link it to the session, record the planning origin, and mark the proposal
 * accepted, in one transaction. The proposal's summary becomes the ticket's
 * brief — the form carries only title/description/repos, so this is the one
 * place that preserves it — unless the ticket already has a brief.
 *
 * The proposal's `dependsOn` becomes `blocked-by` rows on the new ticket
 * (source `agent`): a target accepted already resolves to its ticket, a pending
 * one stays a proposal link. Rows on OTHER tickets that targeted this proposal
 * are converted, in the same transaction, to target this new ticket — so the
 * accept order does not matter. Finally eligible rows are promoted to a
 * pending provider write-back (#63).
 */
export function markProposalAccepted(
  store: Store,
  id: number,
  ticketId: number,
  reviewed?: ProposalPayload,
): void {
  store.db.transaction((): void => {
    // What the human reviewed in the form is what lands on the ticket; a newer
    // agent revision stays on the proposal row as history only.
    const current = requirePending(store, id);
    const p = reviewed ? { ...current, payload: reviewed } : current;
    const ticket = getTicket(store, ticketId);
    // Seed the summary as the brief only when the ticket has none AND the
    // summary actually carries text; the origin line is always appended, so the
    // ticket names the plan and draft it came from.
    const existing = ticket.brief?.trim() ? ticket.brief : '';
    const base = existing || p.payload.summary.trim();
    const origin = `Planned in ${formatId('plan', p.sessionId)} as ${formatId('draft', id)}.`;
    updateTicketFields(store, ticketId, {
      source: 'planning',
      brief: base ? `${base}\n\n${origin}` : origin,
      baseShas: p.baseShas,
    });
    linkPlanningTicket(store, p.sessionId, ticketId);
    applyProposalDependencies(store, p, ticketId);
    store.db
      .prepare(
        "UPDATE planning_proposals SET status = 'accepted', ticket_id = ?, updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?",
      )
      .run(ticketId, id);
  })();
}

/** Add `depId` to a proposal's `depends_dropped` (idempotent). */
function recordDroppedDependency(store: Store, proposalId: number, depId: number): void {
  const current = parseIdArray(
    (store.db.prepare('SELECT depends_dropped FROM planning_proposals WHERE id = ?').get(proposalId) as { depends_dropped: string }).depends_dropped,
  );
  if (current.includes(depId)) return;
  store.db
    .prepare('UPDATE planning_proposals SET depends_dropped = ? WHERE id = ?')
    .run(JSON.stringify([...current, depId]), proposalId);
}

/** A `T<n>` dependsOn entry becomes a blocked-by row on the new ticket. A ticket
 *  that vanished, left the project or is the ticket itself is skipped, never thrown. */
function addTicketDependency(store: Store, ticketId: number, projectId: number | undefined, targetId: number): void {
  if (targetId === ticketId) return;
  const row = store.db.prepare('SELECT project_id FROM tickets WHERE id = ?').get(targetId) as
    | { project_id: number | null }
    | undefined;
  if (!row || row.project_id !== projectId) return;
  addRelation(store, { ticketId, kind: 'blocked-by', targetTicketId: targetId, source: 'agent' });
}

/** Materialize this proposal's `dependsOn` as blocked-by rows and resolve the
 *  pending dependents that targeted it. Called inside the accept transaction. */
function applyProposalDependencies(store: Store, p: PlanningProposal, ticketId: number): void {
  const projectId = getPlanningSession(store, p.sessionId)?.projectId;
  for (const depId of p.payload.dependsOn ?? []) {
    if (isTicketDep(depId)) {
      addTicketDependency(store, ticketId, projectId, depTicketId(depId));
      continue;
    }
    const dep = getProposal(store, depId);
    // Ingest guaranteed same-project, non-discarded; stay defensive anyway.
    if (!dep || dep.status === 'discarded') continue;
    if (getPlanningSession(store, dep.sessionId)?.projectId !== projectId) continue;
    if (dep.status === 'accepted' && dep.ticketId === null) {
      // Its ticket was deleted: nothing left to wait on, so the edge is dropped
      // (mirrors discard) rather than left as a proposal link that never resolves.
      recordDroppedDependency(store, p.id, depId);
    } else if (dep.status === 'accepted') {
      addRelation(store, { ticketId, kind: 'blocked-by', targetTicketId: dep.ticketId!, source: 'agent' });
    } else {
      addRelation(store, { ticketId, kind: 'blocked-by', targetProposalId: depId, source: 'agent' });
    }
  }
  // Pending dependents pointed at this proposal; now they point at its ticket.
  store.db
    .prepare(
      `UPDATE ticket_relations
          SET target_ticket_id = ?, target_proposal_id = NULL,
              target_ref = COALESCE(target_ref, (SELECT source_ref FROM tickets WHERE id = ?))
        WHERE target_proposal_id = ?`,
    )
    .run(ticketId, ticketId, p.id);
  promoteWritebacks(store, ticketId);
}

/**
 * Promote agent/user blocked-by rows newly eligible for a provider write-back
 * to `pending`. Mirrors `resolveDanglingRefsInTransaction`'s sweep: both
 * endpoints must carry a `source_ref` and the row's state must still be NULL
 * (an already-done/failed row is left for its own retry path).
 */
function promoteWritebacks(store: Store, ticketId: number): void {
  store.db
    .prepare(
      `UPDATE ticket_relations SET writeback_state = 'pending'
        WHERE kind = 'blocked-by' AND source IN ('agent','user')
          AND writeback_state IS NULL AND target_ticket_id IS NOT NULL
          AND (ticket_id = ? OR target_ticket_id = ?)
          AND EXISTS (SELECT 1 FROM tickets t
                        WHERE t.id = ticket_relations.ticket_id
                          AND t.source_ref IS NOT NULL AND trim(t.source_ref) <> '')
          AND EXISTS (SELECT 1 FROM tickets t
                        WHERE t.id = ticket_relations.target_ticket_id
                          AND t.source_ref IS NOT NULL AND trim(t.source_ref) <> '')`,
    )
    .run(ticketId, ticketId);
}
