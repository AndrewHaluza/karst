import type { Store } from './db.js';
import { formatId, parseId } from '../model/entityId.js';
import { asPriorityLevel, effectiveTicketPriority, ticketPrioritySource, ticketProviderLabel, type PriorityLevel } from '../model/priority.js';
import { orderQueue, type OrderedQueueItem, type QueueEdge, type QueueItem } from '../model/queueOrder.js';
import { effectiveProposalPriority, listProjectProposals, type PlanningProposal } from './planningProposals.js';
import { listOpenBlockersFor } from './ticketRelations.js';

/**
 * The ONE read path of the project queue: it builds the input of `orderQueue`
 * from the store (pending drafts of every session, top-level tickets at
 * `scope`) and returns the computed order with the display fields. The sidebar
 * host and `karst queue` both call it; no other code sorts the queue.
 *
 * READ-ONLY: SELECTs only, so a planning session may run it through
 * `KARST_DB_READONLY` (@arch:CLI-13).
 */

/** Top-level tickets in the queue are the ones that have not started. */
export const QUEUE_TICKET_STAGE = 'scope';

export interface QueueEntry extends OrderedQueueItem {
  readonly kind: 'draft' | 'ticket';
  /** The numeric part of `id` (the draft or ticket primary key). */
  readonly numId: number;
  /** `P<n>` of a draft's planning session; null for a ticket. */
  readonly session: string | null;
  readonly title: string;
  /** The item's own priority (a draft's override, else the planner's; a ticket's own); null reads as normal. */
  readonly ownPriority: PriorityLevel | null;
  /** A draft's one-line planner reason while no override replaced it; null otherwise. */
  readonly priorityReason: string | null;
  /** Who set `ownPriority`: the user, the ticketing provider or the planner; null when none. */
  readonly prioritySource: PrioritySource | null;
  /** A ticket's provider-written level (`tickets.priority`) and the label of its system; null for a draft. */
  readonly providerPriority: PriorityLevel | null;
  readonly providerLabel: string | null;
}

export type PrioritySource = 'you' | 'provider' | 'planner';

export interface ProjectQueue {
  /** In computed order. */
  readonly entries: readonly QueueEntry[];
  readonly drafts: number;
  /** Distinct planning sessions that hold a pending draft. */
  readonly sessions: number;
  readonly tickets: number;
}

interface TicketRow {
  id: number;
  title: string;
  priority: string | null;
  priority_override: string | null;
  source: string | null;
  created_at: string;
}

interface Node {
  readonly item: QueueItem;
  readonly kind: 'draft' | 'ticket';
  readonly numId: number;
  readonly session: string | null;
  readonly title: string;
  readonly ownPriority: PriorityLevel | null;
  readonly priorityReason: string | null;
  readonly prioritySource: PrioritySource | null;
  readonly providerPriority: PriorityLevel | null;
  readonly providerLabel: string | null;
}

const CLOSED_STAGES: ReadonlySet<string> = new Set(['done', 'closed']);

function draftNode(p: PlanningProposal): Node {
  const id = formatId('draft', p.id);
  return {
    kind: 'draft',
    numId: p.id,
    session: formatId('plan', p.sessionId),
    title: p.payload.title,
    ownPriority: effectiveProposalPriority(p),
    priorityReason: p.priorityOverride === null ? (p.payload.priorityReason ?? null) : null,
    prioritySource: p.priorityOverride !== null ? 'you' : p.payload.priority ? 'planner' : null,
    providerPriority: null,
    providerLabel: null,
    item: { id, priority: effectiveProposalPriority(p), createdAt: p.createdAt },
  };
}

function ticketNode(t: TicketRow, waits: readonly string[]): Node {
  const fields = { priority: t.priority, priorityOverride: t.priority_override };
  const priority = effectiveTicketPriority(fields);
  return {
    kind: 'ticket',
    numId: t.id,
    session: null,
    title: t.title,
    ownPriority: priority,
    priorityReason: null,
    prioritySource: ticketPrioritySource(fields),
    providerPriority: asPriorityLevel(t.priority) ?? null,
    providerLabel: ticketProviderLabel(t.source),
    item: { id: formatId('ticket', t.id), priority, createdAt: t.created_at, externalWaits: waits },
  };
}

function isOpenTicket(store: Store, id: number): boolean {
  const row = store.db.prepare('SELECT stage_current AS stage, archived_at AS archivedAt FROM tickets WHERE id = ?').get(id) as
    | { stage: string | null; archivedAt: string | null }
    | undefined;
  return row !== undefined && row.archivedAt === null && !CLOSED_STAGES.has(row.stage ?? '');
}

/** A draft's target as a node id: a pending draft (in set), a ticket id, or null for a discarded draft. */
function resolveDraftTarget(dep: number | string, byProposal: ReadonlyMap<number, PlanningProposal>): string | null {
  if (typeof dep === 'string') return dep;
  const target = byProposal.get(dep);
  if (!target || target.status === 'discarded') return null;
  if (target.status === 'accepted') return target.ticketId === null ? null : formatId('ticket', target.ticketId);
  return formatId('draft', dep);
}

function draftEdges(store: Store, p: PlanningProposal, inSet: ReadonlySet<string>, byProposal: ReadonlyMap<number, PlanningProposal>) {
  const edges: QueueEdge[] = [];
  const waits: string[] = [];
  const from = formatId('draft', p.id);
  for (const dep of p.payload.dependsOn ?? []) {
    const to = resolveDraftTarget(dep, byProposal);
    if (to === null) continue;
    if (inSet.has(to)) edges.push({ from, to });
    else if (parseId(to).kind === 'ticket' && isOpenTicket(store, parseId(to).n)) waits.push(to);
  }
  return { edges, waits };
}

function readTickets(store: Store, projectId: number): TicketRow[] {
  return store.db
    .prepare(
      `SELECT id, COALESCE(title, key, '') AS title, priority, priority_override, source, created_at FROM tickets
        WHERE project_id = ? AND archived_at IS NULL AND subtask_parent_id IS NULL
          AND stage_current = ?
        ORDER BY id`,
    )
    .all(projectId, QUEUE_TICKET_STAGE) as TicketRow[];
}

export function readProjectQueue(store: Store, projectId: number): ProjectQueue {
  const proposals = listProjectProposals(store, projectId);
  const byProposal = new Map(proposals.map((p) => [p.id, p]));
  const pending = proposals.filter((p) => p.status === 'pending');
  const tickets = readTickets(store, projectId);
  const blockers = listOpenBlockersFor(store, tickets.map((t) => t.id));
  const inSet = new Set([...pending.map((p) => formatId('draft', p.id)), ...tickets.map((t) => formatId('ticket', t.id))]);

  const nodes: Node[] = [];
  const edges: QueueEdge[] = [];
  for (const p of pending) {
    const { edges: e, waits } = draftEdges(store, p, inSet, byProposal);
    edges.push(...e);
    const node = draftNode(p);
    nodes.push({ ...node, item: { ...node.item, externalWaits: waits } });
  }
  for (const t of tickets) {
    const from = formatId('ticket', t.id);
    const waits: string[] = [];
    for (const b of blockers.get(t.id) ?? []) {
      const to = b.targetTicketId !== null ? formatId('ticket', b.targetTicketId) : b.targetProposalId !== null ? formatId('draft', b.targetProposalId) : null;
      if (to !== null && inSet.has(to)) edges.push({ from, to });
      else waits.push(to ?? b.label);
    }
    nodes.push(ticketNode(t, waits));
  }

  const byId = new Map(nodes.map((n) => [n.item.id, n]));
  const ordered = orderQueue(nodes.map((n) => n.item), edges);
  const entries = ordered.map((o): QueueEntry => {
    const n = byId.get(o.id)!;
    return { ...o, kind: n.kind, numId: n.numId, session: n.session, title: n.title, ownPriority: n.ownPriority, priorityReason: n.priorityReason, prioritySource: n.prioritySource, providerPriority: n.providerPriority, providerLabel: n.providerLabel };
  });
  return {
    entries,
    drafts: pending.length,
    sessions: new Set(pending.map((p) => p.sessionId)).size,
    tickets: tickets.length,
  };
}
