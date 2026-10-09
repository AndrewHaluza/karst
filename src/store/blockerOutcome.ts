import type { Store } from './db.js';
import type { StageKey } from '../model/types.js';
import { MAX_MESSAGE_BODY, type PostMessageInput } from './ticketMessages.js';
import { listPrsByTicket } from './dashboard.js';
import { quoteUntrusted, sanitizeInline } from '../model/messageText.js';
import { formatId } from '../model/entityId.js';

/**
 * What a landed blocker hands its dependents: who it was, what it set out to do
 * (brief), what actually merged (paths per repo, PR links) and what its agent
 * learned (bulletin notes). Read from the store on demand — never cached — so
 * the mailbox event, the seed section and `karst context` all agree.
 */
export interface BlockerOutcome {
  id: number;
  key: string;
  title: string;
  brief: string | null;
  /** Merged diff per repo; `paths` null when the file list was incomplete. */
  changes: Array<{ repo: string; paths: string[] | null }>;
  prs: Array<{ repo: string; number: number | null; url: string | null }>;
  /** The blocker agent's own bulletin notes (untrusted prose). */
  notes: Array<{ title: string; body: string }>;
}

interface TicketRow {
  key: string | null;
  title: string | null;
  brief: string | null;
}

interface NoteRow {
  source: string;
  title: string;
  body: string;
  repos: string | null;
  paths: string | null;
}

function parseStrings(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

/** The outcome of one ticket as its dependents see it. */
export function blockerOutcome(store: Store, blockerId: number): BlockerOutcome {
  const t = store.db
    .prepare('SELECT key, title, brief FROM tickets WHERE id = ?')
    .get(blockerId) as TicketRow | undefined;
  const notes = store.db
    .prepare('SELECT source, title, body, repos, paths FROM bulletin_notes WHERE from_ticket_id = ? ORDER BY id')
    .all(blockerId) as NoteRow[];
  const changes = notes
    .filter((n) => n.source === 'host')
    .map((n) => ({ repo: parseStrings(n.repos)?.[0] ?? 'unknown', paths: parseStrings(n.paths) }));
  return {
    id: blockerId,
    key: t?.key ?? formatId('ticket', blockerId),
    title: t?.title ?? '',
    brief: t?.brief?.trim() ? t.brief : null,
    changes,
    prs: listPrsByTicket(store, blockerId).map((p) => ({ repo: p.repo, number: p.number, url: p.url })),
    notes: notes.filter((n) => n.source === 'agent').map((n) => ({ title: n.title, body: n.body })),
  };
}

const ELLIPSIS = '…';

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 1)).join('') + ELLIPSIS;
}

/**
 * The mailbox/seed text for one outcome, never longer than `max`. The header and
 * the `karst context` pointer always survive; sections fill the rest in
 * priority order (PRs, merged paths, brief, notes), each clipped to what is left.
 */
export function renderBlockerOutcome(o: BlockerOutcome, max: number = MAX_MESSAGE_BODY): string {
  const key = sanitizeInline(o.key);
  const header = `${key} landed: ${sanitizeInline(o.title)}`;
  const footer = `Full outcome: karst context ${key}`;
  const sections: string[] = [];
  if (o.prs.length > 0) {
    const links = o.prs.map((p) => `- ${sanitizeInline(p.repo)}${p.number === null ? '' : `#${p.number}`} ${sanitizeInline(p.url ?? '')}`.trimEnd());
    sections.push(`PRs:\n${links.join('\n')}`);
  }
  if (o.changes.length > 0) {
    const rows = o.changes.map((c) =>
      c.paths === null
        ? `- ${sanitizeInline(c.repo)}: changed paths unavailable`
        : `- ${sanitizeInline(c.repo)}: ${c.paths.map(sanitizeInline).join(', ') || 'no changed paths'}`,
    );
    sections.push(`Merged changes:\n${rows.join('\n')}`);
  }
  if (o.brief !== null) sections.push(`Brief:\n${quoteUntrusted(o.brief)}`);
  if (o.notes.length > 0) {
    const rows = o.notes.map((n) => `${sanitizeInline(n.title)}\n${quoteUntrusted(n.body)}`);
    sections.push(`Notes:\n${rows.join('\n')}`);
  }
  let text = header;
  for (const s of sections) {
    const room = max - text.length - footer.length - 4; // two blank-line joins
    if (room <= 0) break;
    text += `\n\n${clip(s, room)}`;
  }
  return `${text}\n\n${footer}`;
}

/** Outcomes of every blocker of `ticketId` that has already landed (done). */
export function landedBlockerOutcomes(store: Store, ticketId: number): BlockerOutcome[] {
  const rows = store.db
    .prepare(
      `SELECT t.id FROM ticket_relations r
         JOIN tickets t ON t.id = r.target_ticket_id
        WHERE r.ticket_id = ? AND r.kind = 'blocked-by' AND t.stage_current = 'done'
        ORDER BY r.id`,
    )
    .all(ticketId) as Array<{ id: number }>;
  return rows.map((r) => blockerOutcome(store, r.id));
}

/**
 * The events a stage patch owes the blocker's dependents, computed from the
 * state BEFORE the write: one per live dependent, only on the done-passed EDGE.
 */
export function blockerLandedEvents(
  store: Store,
  ticketId: number,
  stageKey: StageKey,
  patch: { status?: string },
): PostMessageInput[] {
  if (stageKey !== 'done' || patch.status !== 'passed') return [];
  const prior = store.db
    .prepare('SELECT status FROM stages WHERE ticket_id = ? AND stage_key = ?')
    .get(ticketId, stageKey) as { status: string } | undefined;
  if (!prior || prior.status === 'passed') return [];
  const dependents = store.db
    .prepare(
      `SELECT d.id, d.project_id FROM ticket_relations r
         JOIN tickets d ON d.id = r.ticket_id
        WHERE r.target_ticket_id = ? AND r.kind = 'blocked-by' AND d.archived_at IS NULL
        ORDER BY d.id`,
    )
    .all(ticketId) as Array<{ id: number; project_id: number | null }>;
  if (dependents.length === 0) return [];
  const body = renderBlockerOutcome(blockerOutcome(store, ticketId));
  return dependents.map((d) => ({
    projectId: d.project_id,
    fromTicketId: null,
    toTicketId: d.id,
    kind: 'event' as const,
    body,
  }));
}
