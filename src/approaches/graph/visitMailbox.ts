/**
 * Mailbox + bulletin for graph tickets, delivered through the coordinator's
 * NEXT node visit (vscode-free). Graph nodes are supervised CLI runs — nothing
 * to type into or hook — so the recipient is the graph TICKET and the pointer
 * rides the visit's brief. Pending state is never stored here: it is read from
 * the unread `ticket_messages` / missing `bulletin_reads` rows at visit time,
 * so it survives a reload by construction. The text is host-written (counts and
 * sanitized titles), never an agent-authored body.
 */
import type { GraphDb } from '../../store/graph/transitions.js';
import type { GraphDocument } from './parse.js';
import { ACTIVE_NODE_STATUSES } from './coordinator/completion.js';

export interface VisitMailboxFacts {
  unreadMail: number;
  unreadNotes: number;
  noteTitles: readonly string[];
  /** This visit completes the graph ticket: it is also asked for a note. */
  completing: boolean;
}

/** The brief section for one visit; '' when there is nothing to say. */
export function composeVisitMailbox(facts: VisitMailboxFacts): string {
  const lines: string[] = [];
  if (facts.unreadMail > 0) {
    const n = facts.unreadMail;
    lines.push(`${n} unread message${n === 1 ? '' : 's'} — run \`karst inbox\` to read them.`);
  }
  if (facts.unreadNotes > 0) {
    const n = facts.unreadNotes;
    lines.push(`${n} unread project note${n === 1 ? '' : 's'} match this ticket — run \`karst notes\` to read them.`);
    for (const title of facts.noteTitles) lines.push(`- ${title}`);
  }
  if (facts.completing) {
    lines.push(
      'This visit completes the ticket: if you learned something another task should know, post ONE short project note with `karst notes post`.',
    );
  }
  return lines.length === 0 ? '' : `## Ticket mailbox\n${lines.join('\n')}`;
}

export interface VisitIdentity {
  graphRunId: number;
  revisionId: number;
  nodeRunId: number;
  nodeId: string;
}

/**
 * Injection is allowed only into a plain visit of a `running` run on its
 * `active` revision: never while a replan drains (run not `running`, revision
 * `draining`) and never into a superseded (stranded) revision.
 */
export function mayInjectIntoVisit(db: GraphDb, visit: VisitIdentity): boolean {
  const run = db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(visit.graphRunId) as
    | { status: string }
    | undefined;
  if (run?.status !== 'running') return false;
  const revision = db
    .prepare('SELECT status FROM approach_graph_revisions WHERE id = ? AND graph_run_id = ?')
    .get(visit.revisionId, visit.graphRunId) as { status: string } | undefined;
  return revision?.status === 'active';
}

/**
 * Decided AT VISIT TIME from the active revision (no fixed "final node" — a
 * replan changes the graph): every outgoing edge of this node ends the graph,
 * no other node run is active, and no token is pending or claimed elsewhere.
 */
export function isCompletingVisit(db: GraphDb, visit: VisitIdentity, document: GraphDocument): boolean {
  const out = document.edges.filter((e) => e.from === visit.nodeId);
  if (out.length === 0 || out.some((e) => e.to !== 'END')) return false;
  const placeholders = ACTIVE_NODE_STATUSES.map(() => '?').join(', ');
  const others = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_node_runs
       WHERE graph_run_id = ? AND id <> ? AND status IN (${placeholders})`,
    )
    .get(visit.graphRunId, visit.nodeRunId, ...ACTIVE_NODE_STATUSES) as { n: number };
  if (others.n > 0) return false;
  const tokens = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approach_graph_tokens
       WHERE revision_id = ? AND destination_end = 0 AND status IN ('pending','claimed')
         AND (claiming_node_run_id IS NULL OR claiming_node_run_id <> ?)`,
    )
    .get(visit.revisionId, visit.nodeRunId) as { n: number };
  return tokens.n === 0;
}
