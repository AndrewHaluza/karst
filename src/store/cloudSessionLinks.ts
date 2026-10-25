import type { Store } from './db.js';

/**
 * `cloud_session_links` (v90, arch:CLOUD-01) — display-only cache of agent
 * sessions that ran in a vendor's cloud. Rebuildable from git/PR text; NEVER
 * read by stage, gate or agent_state logic.
 *
 * `link_source` NULL = unlinked by scan. A 'manual' row is never overwritten by
 * a scan; an explicit unlink keeps 'manual' with both ids NULL so the next scan
 * does not re-link it.
 */

/** Mirrored by `schema.sql` for a fresh DB; the v90 migration step execs it. */
export const CLOUD_SESSION_LINKS_DDL = `
CREATE TABLE IF NOT EXISTS cloud_session_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  url         TEXT NOT NULL,
  ticket_id   INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
  proposal_id INTEGER REFERENCES planning_proposals(id) ON DELETE SET NULL,
  link_source TEXT CHECK (link_source IN ('pr', 'branch', 'key', 'manual')),
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, provider, url)
);
CREATE INDEX IF NOT EXISTS idx_cloud_session_links_ticket ON cloud_session_links(ticket_id);
`;

export type CloudLinkSource = 'pr' | 'branch' | 'key' | 'manual';

export interface CloudSessionRef {
  projectId: number;
  provider: string;
  url: string;
}

export interface CloudSessionLinkRow {
  id: number;
  provider: string;
  url: string;
  /** Resolved: the link's own ticket, else the (non-discarded) proposal's ticket. */
  ticketId: number | null;
  /** Set only while the session hangs on a live draft that has no ticket yet. */
  proposalId: number | null;
  linkSource: CloudLinkSource | null;
}

/**
 * Record a scan result. `ticketId` null = session seen but unmatched. Never
 * overwrites a 'manual' row.
 */
export function upsertCloudSessionLink(
  store: Store,
  ref: CloudSessionRef,
  match: { ticketId: number; source: Exclude<CloudLinkSource, 'manual'> } | null,
): void {
  store.db
    .prepare(
      `INSERT INTO cloud_session_links (project_id, provider, url, ticket_id, link_source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, provider, url) DO UPDATE SET
         ticket_id = excluded.ticket_id, proposal_id = NULL, link_source = excluded.link_source
       WHERE cloud_session_links.link_source IS NOT 'manual'`,
    )
    .run(ref.projectId, ref.provider, ref.url, match?.ticketId ?? null, match?.source ?? null);
}

/** Pin a session to a ticket or a draft proposal by hand (exactly one target). */
export function setManualLink(
  store: Store,
  ref: CloudSessionRef,
  target: { ticketId: number } | { proposalId: number },
): void {
  const ticketId = 'ticketId' in target ? target.ticketId : null;
  const proposalId = 'proposalId' in target ? target.proposalId : null;
  store.db
    .prepare(
      `INSERT INTO cloud_session_links (project_id, provider, url, ticket_id, proposal_id, link_source)
       VALUES (?, ?, ?, ?, ?, 'manual')
       ON CONFLICT (project_id, provider, url) DO UPDATE SET
         ticket_id = excluded.ticket_id, proposal_id = excluded.proposal_id, link_source = 'manual'`,
    )
    .run(ref.projectId, ref.provider, ref.url, ticketId, proposalId);
}

/** Explicit unlink: the row stays 'manual' (both ids NULL) so a rescan leaves it alone. */
export function clearManualLink(store: Store, ref: CloudSessionRef): void {
  store.db
    .prepare(
      `INSERT INTO cloud_session_links (project_id, provider, url, link_source)
       VALUES (?, ?, ?, 'manual')
       ON CONFLICT (project_id, provider, url) DO UPDATE SET
         ticket_id = NULL, proposal_id = NULL, link_source = 'manual'`,
    )
    .run(ref.projectId, ref.provider, ref.url);
}

/** Every link of the project with the ticket id resolved through its proposal. */
export function listCloudSessionLinks(
  store: Store,
  opts: { projectId: number },
): CloudSessionLinkRow[] {
  const rows = store.db
    .prepare(
      `SELECT l.id, l.provider, l.url, l.link_source AS linkSource,
              l.ticket_id AS ownTicket, l.proposal_id AS proposalId,
              p.status AS pStatus, p.ticket_id AS pTicket
         FROM cloud_session_links l
         LEFT JOIN planning_proposals p ON p.id = l.proposal_id
        WHERE l.project_id = ?
        ORDER BY l.id`,
    )
    .all(opts.projectId) as {
    id: number;
    provider: string;
    url: string;
    linkSource: CloudLinkSource | null;
    ownTicket: number | null;
    proposalId: number | null;
    pStatus: string | null;
    pTicket: number | null;
  }[];
  return rows.map((r) => {
    const live = r.pStatus !== null && r.pStatus !== 'discarded';
    const ticketId = r.ownTicket ?? (live ? r.pTicket : null);
    return {
      id: r.id,
      provider: r.provider,
      url: r.url,
      ticketId,
      proposalId: ticketId === null && live ? r.proposalId : null,
      linkSource: r.linkSource,
    };
  });
}

/** True when the ticket belongs to the project. */
export function ticketInProject(store: Store, projectId: number, ticketId: number): boolean {
  return store.db.prepare('SELECT 1 FROM tickets WHERE id = ? AND project_id = ?').get(ticketId, projectId) !== undefined;
}

/** True when the proposal belongs to the project (through its planning session) and is not discarded. */
export function liveProposalInProject(store: Store, projectId: number, proposalId: number): boolean {
  return (
    store.db
      .prepare(
        `SELECT 1 FROM planning_proposals p JOIN planning_sessions s ON s.id = p.session_id
          WHERE p.id = ? AND s.project_id = ? AND p.status != 'discarded'`,
      )
      .get(proposalId, projectId) !== undefined
  );
}
