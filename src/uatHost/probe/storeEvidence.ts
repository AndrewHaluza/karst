import type { Store } from '../../store/db.js';
import type { TicketEvidence } from './runner.js';

interface TicketRow { id: number; key: string; title: string; stage_current: string }
interface StageRow { ticket_id: number; stage_key: string; status: string; blocked_kind: string | null }

/** Ticket and stage rows with no timestamps or ids, ordered so the JSON is stable across runs. */
export function readTickets(store: Store): TicketEvidence[] {
  const tickets = store.db.prepare('SELECT id, key, title, stage_current FROM tickets ORDER BY key').all() as TicketRow[];
  const stages = store.db
    .prepare('SELECT ticket_id, stage_key, status, blocked_kind FROM stages ORDER BY ticket_id, stage_key')
    .all() as StageRow[];
  return tickets.map((t) => ({
    key: t.key,
    title: t.title,
    stage: t.stage_current,
    stages: stages
      .filter((s) => s.ticket_id === t.id)
      .map((s) => ({ stage: s.stage_key, status: s.status, blockedKind: s.blocked_kind })),
  }));
}
