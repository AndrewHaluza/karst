import type { Store } from './db.js';
import type { ContextBrief, BriefRelation } from '../integrations/ticketing.js';

/**
 * Persisted inter-ticket dependency links (v69) — the store half of the
 * ticket-relations feature. PURE and synchronous: it never touches a provider
 * or the network. Only the two ORDERING kinds are stored (`blocked-by` and
 * `parent`); `blocks`/`child` are the inverse of a row on the OTHER ticket and
 * are derived on read. Network write-back lives in the ticket-form action layer
 * (`onSourceRefBound`), never here — that is why `updateTicketFields` stays a
 * pure store writer.
 *
 * A relation may name its target three ways, all nullable and at least one
 * required: `target_ticket_id` (an imported ticket), `target_ref` (a provider
 * ref karst has not imported yet), or `target_proposal_id` (#64's draft
 * dependsOn). `target_ref` is kept alongside `target_ticket_id` so a deleted
 * target degrades to a bare ref instead of vanishing (`ON DELETE SET NULL`).
 */

/** The two kinds stored in `ticket_relations.kind`. */
export const RELATION_KINDS = ['blocked-by', 'parent'] as const;
export type TicketRelationKind = (typeof RELATION_KINDS)[number];

/** Who authored the link — a fetched brief, the agent, or the user. */
export const RELATION_SOURCES = ['provider', 'agent', 'user'] as const;
export type RelationSource = (typeof RELATION_SOURCES)[number];

/** The write-back lifecycle for an agent/user blocked-by row. */
export type WritebackState = 'pending' | 'done' | 'failed';

/** The two inverse kinds derived on read from a row on the other ticket. */
export type InverseRelationKind = 'blocks' | 'child';

/** One stored relation row. */
export interface TicketRelation {
  id: number;
  ticketId: number;
  kind: TicketRelationKind;
  targetTicketId: number | null;
  targetRef: string | null;
  targetProposalId: number | null;
  source: RelationSource;
  writebackState: WritebackState | null;
  writebackError: string | null;
  createdAt: string;
}

/**
 * A relation as displayed for ONE ticket: a stored row (as authored) or the
 * derived inverse of a row stored on the other ticket.
 */
export interface RelationView {
  /** The backing row id (the row on the other ticket for a derived view). */
  id: number;
  kind: TicketRelationKind | InverseRelationKind;
  source: RelationSource;
  /** The other side, resolved to a ticket when possible. */
  targetTicketId: number | null;
  targetRef: string | null;
  targetProposalId: number | null;
  /** true when this view is the inverse of a row stored on the OTHER ticket. */
  derived: boolean;
}

interface RelationRow {
  id: number;
  ticket_id: number;
  kind: string;
  target_ticket_id: number | null;
  target_ref: string | null;
  target_proposal_id: number | null;
  source: string;
  /** The ticket whose brief authored this row (NULL only for a foreign write). */
  origin_ticket_id: number | null;
  writeback_state: string | null;
  writeback_error: string | null;
  created_at: string;
}

function isRelationKind(value: string): value is TicketRelationKind {
  return value === 'blocked-by' || value === 'parent';
}

function isRelationSource(value: string): value is RelationSource {
  return value === 'provider' || value === 'agent' || value === 'user';
}

function isWritebackState(value: string | null): value is WritebackState {
  return value === 'pending' || value === 'done' || value === 'failed';
}

/** Trimmed non-empty string, else null — the store's canonical "absent". */
function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function rowToRelation(r: RelationRow): TicketRelation {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    // CHECK-constrained columns; the guards only degrade a foreign write.
    kind: isRelationKind(r.kind) ? r.kind : 'blocked-by',
    targetTicketId: r.target_ticket_id,
    targetRef: r.target_ref,
    targetProposalId: r.target_proposal_id,
    source: isRelationSource(r.source) ? r.source : 'provider',
    writebackState: isWritebackState(r.writeback_state) ? r.writeback_state : null,
    writebackError: r.writeback_error,
    createdAt: r.created_at,
  };
}

/** The ticket's provider ref, or null when unbound/blank. */
export function getTicketSourceRef(store: Store, ticketId: number): string | null {
  const row = store.db
    .prepare('SELECT source_ref FROM tickets WHERE id = ?')
    .get(ticketId) as { source_ref: string | null } | undefined;
  return row ? trimToNull(row.source_ref) : null;
}

/**
 * Every ref this ticket answers to: its canonical `source_ref` first, then the
 * `source_ref_internal` alias (v71) when it is a custom id. A dependency ref is
 * reported by internal id, so a dangling row may name either form; resolving
 * against both is what lets it reach this ticket.
 */
export function getTicketRefs(store: Store, ticketId: number): string[] {
  const row = store.db
    .prepare('SELECT source_ref, source_ref_internal FROM tickets WHERE id = ?')
    .get(ticketId) as
    | { source_ref: string | null; source_ref_internal: string | null }
    | undefined;
  if (!row) return [];
  const refs = [trimToNull(row.source_ref), trimToNull(row.source_ref_internal)];
  return refs.filter((r): r is string => r !== null);
}

/**
 * The ticket whose `source_ref` matches `ref`, if any. A provider ref is unique
 * to its workspace, so resolution is NOT project-scoped — a dangling ref must
 * resolve to the imported ticket wherever it lives, or the blocker would stay
 * stuck forever (a second window's project shares this registry). A same-project
 * match still wins, then the oldest live row, mirroring `getTicketsByKey`'s
 * policy so a re-created ref never resolves to a stale namesake.
 */
function resolveRefToTicket(store: Store, ownerTicketId: number, ref: string): number | null {
  const owner = store.db
    .prepare('SELECT project_id FROM tickets WHERE id = ?')
    .get(ownerTicketId) as { project_id: number | null } | undefined;
  const row = store.db
    .prepare(
      `SELECT id FROM tickets
        WHERE source_ref = ? OR source_ref_internal = ?
        ORDER BY (project_id IS ?) DESC, (archived_at IS NOT NULL) ASC, id ASC LIMIT 1`,
    )
    .get(ref, ref, owner?.project_id ?? null) as { id: number } | undefined;
  return row ? row.id : null;
}

/**
 * Whether making `ticketId` blocked by `targetTicketId` would close a cycle.
 * Walks the transitive blocked-by chain from the proposed target; if the owner
 * is already in it, the two tickets would be mutually blocking. Only resolved
 * edges (a non-null `target_ticket_id`) are followed — a dangling ref is not
 * yet an edge.
 */
function wouldCreateBlockedByCycle(
  store: Store,
  ticketId: number,
  targetTicketId: number | null,
): boolean {
  if (targetTicketId === null) return false;
  if (targetTicketId === ticketId) return true;
  const cycle = store.db
    .prepare(
      `WITH RECURSIVE chain(id) AS (
         SELECT target_ticket_id FROM ticket_relations
           WHERE ticket_id = ? AND kind = 'blocked-by' AND target_ticket_id IS NOT NULL
         UNION
         SELECT r.target_ticket_id FROM ticket_relations r
           JOIN chain c ON r.ticket_id = c.id
           WHERE r.kind = 'blocked-by' AND r.target_ticket_id IS NOT NULL
       )
       SELECT 1 FROM chain WHERE id = ? LIMIT 1`,
    )
    .get(targetTicketId, ticketId);
  return cycle !== undefined;
}

/** Reject a `blocked-by` edge that would close a cycle, with a clear message. */
function assertNoBlockedByCycle(
  store: Store,
  ticketId: number,
  targetTicketId: number | null,
): void {
  if (targetTicketId === ticketId) {
    throw new Error('a ticket cannot be blocked by itself');
  }
  if (wouldCreateBlockedByCycle(store, ticketId, targetTicketId)) {
    throw new Error(
      `adding this blocked-by relation would create a cycle (ticket ${ticketId} is already blocking ticket ${targetTicketId})`,
    );
  }
}

/**
 * The more authoritative of two sources. An agent/user edge is the user's
 * intent and outranks a provider-fetched one; between agent and user (or two
 * providers) the existing value is kept.
 */
function strongerSource(existing: RelationSource, incoming: RelationSource): RelationSource {
  if (existing === 'provider' && incoming !== 'provider') return incoming;
  return existing;
}

/** One row by id, or undefined. */
function relationById(store: Store, id: number): RelationRow | undefined {
  return store.db.prepare('SELECT * FROM ticket_relations WHERE id = ?').get(id) as
    | RelationRow
    | undefined;
}

/**
 * Find the rows that already represent the same edge as
 * (ticket, kind, target, proposal): a resolved row pointing at the same target
 * ticket, OR a dangling row with the same ref. `targetTicketId` may be null
 * (a dangling insert), in which case only a same-ref dangling row matches.
 */
function equivalentRows(
  store: Store,
  ticketId: number,
  kind: TicketRelationKind,
  targetTicketId: number | null,
  targetRef: string | null,
  targetProposalId: number | null,
): RelationRow[] {
  return store.db
    .prepare(
      `SELECT * FROM ticket_relations
        WHERE ticket_id = ? AND kind = ?
          AND COALESCE(target_proposal_id, '') = COALESCE(?, '')
          AND (
            (target_ticket_id IS NOT NULL AND target_ticket_id = ?)
            OR (target_ticket_id IS NULL AND COALESCE(target_ref, '') = COALESCE(?, ''))
          )
        ORDER BY (target_ticket_id IS NULL) ASC, id ASC`,
    )
    .all(ticketId, kind, targetProposalId, targetTicketId, targetRef) as RelationRow[];
}

/**
 * Adopt an existing equivalent row instead of inserting a duplicate: a dangling
 * ref-only row and a later resolved row are the SAME edge and differ only in
 * `target_ticket_id`, which the expression unique index treats as distinct. The
 * survivor is the resolved row (or the first dangling one), upgraded in place
 * with the stronger source, any target_ref backfill, and a merged write-back
 * state; every other equivalent row is deleted. Returns the survivor, or null
 * when nothing equivalent exists.
 */
function adoptEquivalent(
  store: Store,
  ticketId: number,
  kind: TicketRelationKind,
  targetTicketId: number | null,
  targetRef: string | null,
  targetProposalId: number | null,
  incomingSource: RelationSource,
): TicketRelation | null {
  const rows = equivalentRows(
    store,
    ticketId,
    kind,
    targetTicketId,
    targetRef,
    targetProposalId,
  );
  if (rows.length === 0) return null;
  const survivor = rows[0]!;
  let source = isRelationSource(survivor.source) ? survivor.source : 'provider';
  let state = isWritebackState(survivor.writeback_state) ? survivor.writeback_state : null;
  let error = survivor.writeback_error;
  for (const other of rows.slice(1)) {
    if (isRelationSource(other.source)) source = strongerSource(source, other.source);
    if (state === null && isWritebackState(other.writeback_state)) state = other.writeback_state;
    if (error === null) error = other.writeback_error;
    store.db.prepare('DELETE FROM ticket_relations WHERE id = ?').run(other.id);
  }
  const resolvedTarget = survivor.target_ticket_id ?? targetTicketId;
  const nextSource = strongerSource(source, incomingSource);
  const computed = writebackForNewRelation(store, ticketId, kind, nextSource, resolvedTarget);
  store.db
    .prepare(
      `UPDATE ticket_relations
          SET target_ticket_id = COALESCE(target_ticket_id, ?),
              target_ref = COALESCE(target_ref, ?),
              source = ?,
              origin_ticket_id = ?,
              writeback_state = ?,
              writeback_error = ?
        WHERE id = ?`,
    )
    .run(
      targetTicketId,
      targetRef,
      nextSource,
      // The row's subject now asserts the edge too, so ownership migrates to it:
      // its own brief can replace the row later, and an author's refetch no
      // longer removes an edge the subject's brief independently reports.
      ticketId,
      state ?? computed,
      error,
      survivor.id,
    );
  const updated = relationById(store, survivor.id);
  if (!updated) throw new Error('failed to adopt relation');
  return rowToRelation(updated);
}

/** Whether a new row is immediately eligible for a provider write-back. */
function writebackForNewRelation(
  store: Store,
  ticketId: number,
  kind: TicketRelationKind,
  source: RelationSource,
  targetTicketId: number | null,
): WritebackState | null {
  if (kind !== 'blocked-by' || (source !== 'agent' && source !== 'user')) return null;
  if (targetTicketId === null) return null;
  if (getTicketSourceRef(store, ticketId) === null) return null;
  if (getTicketSourceRef(store, targetTicketId) === null) return null;
  return 'pending';
}

/** What a caller supplies to create a relation. */
export interface AddRelationInput {
  ticketId: number;
  kind: TicketRelationKind;
  targetTicketId?: number | null;
  targetRef?: string | null;
  targetProposalId?: number | null;
  source: RelationSource;
  /**
   * The ticket whose brief authored this row, when it differs from `ticketId`.
   * A `blocks`/`child` relation is materialized as a row on the OTHER ticket, so
   * its author is the ticket being ingested; provenance lets that ticket's next
   * ingest remove exactly the rows it authored. Defaults to `ticketId`.
   */
  originTicketId?: number | null;
}

/**
 * Create (or return the existing) relation. Resolves `target_ref` to an
 * imported ticket (not project-scoped), fills `target_ref` from a resolved
 * target's `source_ref` (so a later delete degrades to the ref), rejects
 * blocked-by cycles, and marks an eligible agent/user blocked-by row `pending`
 * for write-back. Idempotent by the expression unique index.
 */
export function addRelation(store: Store, input: AddRelationInput): TicketRelation {
  if (!isRelationKind(input.kind)) {
    throw new Error(`unknown relation kind "${input.kind}"`);
  }
  if (!isRelationSource(input.source)) {
    throw new Error(`unknown relation source "${input.source}"`);
  }
  let targetTicketId = input.targetTicketId ?? null;
  let targetRef = trimToNull(input.targetRef);
  const targetProposalId = input.targetProposalId ?? null;

  if (targetTicketId !== null) {
    const target = store.db
      .prepare('SELECT source_ref FROM tickets WHERE id = ?')
      .get(targetTicketId) as { source_ref: string | null } | undefined;
    if (!target) throw new Error(`target ticket ${targetTicketId} not found`);
    if (targetRef === null) targetRef = trimToNull(target.source_ref);
  } else if (targetRef !== null) {
    targetTicketId = resolveRefToTicket(store, input.ticketId, targetRef);
    if (targetTicketId !== null) {
      // The ref may have matched the ticket's internal-id alias; store the
      // canonical `source_ref` so a later delete degrades to the addressable
      // form and the edge is deduped against rows written from either form.
      const target = store.db
        .prepare('SELECT source_ref FROM tickets WHERE id = ?')
        .get(targetTicketId) as { source_ref: string | null } | undefined;
      targetRef = trimToNull(target?.source_ref) ?? targetRef;
    }
  }

  if (targetTicketId === null && targetRef === null && targetProposalId === null) {
    throw new Error('a relation needs a target ticket, ref, or proposal');
  }
  if (input.kind === 'blocked-by') {
    assertNoBlockedByCycle(store, input.ticketId, targetTicketId);
  }

  // A dangling ref-only row and a later resolved row are the SAME edge but
  // differ in `target_ticket_id`, so the expression unique index would let both
  // exist. Adopt the existing row (resolving/backfilling it) instead of
  // inserting a duplicate that later breaks `resolveDanglingRefs`.
  const adopted = adoptEquivalent(
    store,
    input.ticketId,
    input.kind,
    targetTicketId,
    targetRef,
    targetProposalId,
    input.source,
  );
  if (adopted) return adopted;

  const writebackState = writebackForNewRelation(
    store,
    input.ticketId,
    input.kind,
    input.source,
    targetTicketId,
  );

  store.db
    .prepare(
      `INSERT OR IGNORE INTO ticket_relations
         (ticket_id, kind, target_ticket_id, target_ref, target_proposal_id, source, origin_ticket_id, writeback_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ticketId,
      input.kind,
      targetTicketId,
      targetRef,
      targetProposalId,
      input.source,
      input.originTicketId ?? input.ticketId,
      writebackState,
    );

  const row = store.db
    .prepare(
      `SELECT * FROM ticket_relations
        WHERE ticket_id = ? AND kind = ?
          AND COALESCE(target_ticket_id, '') = COALESCE(?, '')
          AND COALESCE(target_ref, '') = COALESCE(?, '')
          AND COALESCE(target_proposal_id, '') = COALESCE(?, '')
        LIMIT 1`,
    )
    .get(
      input.ticketId,
      input.kind,
      targetTicketId,
      targetRef,
      targetProposalId,
    ) as RelationRow | undefined;
  if (!row) throw new Error('failed to add relation');
  return rowToRelation(row);
}

/** Delete a relation by id; returns whether a row matched. */
export function removeRelation(store: Store, relationId: number): boolean {
  const info = store.db.prepare('DELETE FROM ticket_relations WHERE id = ?').run(relationId);
  return Number(info.changes) > 0;
}

/** The stored rows authored on `ticketId`, oldest first. */
export function listRelations(store: Store, ticketId: number): TicketRelation[] {
  const rows = store.db
    .prepare('SELECT * FROM ticket_relations WHERE ticket_id = ? ORDER BY id')
    .all(ticketId) as RelationRow[];
  return rows.map(rowToRelation);
}

/** The stored `blocked-by` rows for `ticketId` — what this ticket waits on. */
export function listBlockers(store: Store, ticketId: number): TicketRelation[] {
  return listRelations(store, ticketId).filter((r) => r.kind === 'blocked-by');
}

/**
 * Every relation as it applies to `ticketId`: the stored rows plus the derived
 * inverse (`blocks`/`child`) of each row stored on the OTHER ticket. A derived
 * view only exists when the other side resolved to a ticket id.
 */
export function list(store: Store, ticketId: number): RelationView[] {
  const views: RelationView[] = [];
  for (const r of listRelations(store, ticketId)) {
    views.push({
      id: r.id,
      kind: r.kind,
      source: r.source,
      targetTicketId: r.targetTicketId,
      targetRef: r.targetRef,
      targetProposalId: r.targetProposalId,
      derived: false,
    });
  }
  const incoming = store.db
    .prepare(
      `SELECT r.*, owner.source_ref AS owner_ref
         FROM ticket_relations r
         JOIN tickets owner ON owner.id = r.ticket_id
        WHERE r.target_ticket_id = ?
        ORDER BY r.id`,
    )
    .all(ticketId) as (RelationRow & { owner_ref: string | null })[];
  for (const r of incoming) {
    const relation = rowToRelation(r);
    views.push({
      id: relation.id,
      kind: relation.kind === 'blocked-by' ? 'blocks' : 'child',
      source: relation.source,
      targetTicketId: relation.ticketId,
      targetRef: trimToNull(r.owner_ref),
      targetProposalId: null,
      derived: true,
    });
  }
  return views;
}

/**
 * The single blocked gate for a ticket (#65's launch guard). True when any
 * `blocked-by` target is unresolved (ref/proposal only — no `target_ticket_id`)
 * or still open. Open is NULL-safe: `stage_current IS NOT 'done'` (a NULL stage
 * is open) AND `archived_at IS NULL`. A deleted target degrades to a ref and
 * therefore still blocks.
 */
export function isBlocked(store: Store, ticketId: number): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 AS blocked FROM ticket_relations r
         LEFT JOIN tickets t ON t.id = r.target_ticket_id
        WHERE r.ticket_id = ? AND r.kind = 'blocked-by'
          AND (
            r.target_ticket_id IS NULL
            OR (t.stage_current IS NOT 'done' AND t.archived_at IS NULL)
          )
        LIMIT 1`,
    )
    .get(ticketId);
  return row !== undefined;
}

/**
 * Resolve `target_ref`-only rows that point at a ticket whose `source_ref` is
 * now known, backfill the ref on rows already resolved to it, and promote any
 * agent/user blocked-by row that just became eligible (both endpoints bound) to
 * `pending`. Returns how many dangling refs were resolved. Called when a
 * ticket's ref is bound.
 *
 * Resolving is per-row, NOT one bulk UPDATE: an edge that would close a
 * blocked-by cycle is left dangling (it stays blocking) rather than persisted
 * as an invalid cycle, and a dangling row that already has a resolved
 * equivalent is merged into it instead of colliding with the unique index.
 */
export function resolveDanglingRefs(store: Store, ticketId: number): number {
  // Both forms this ticket answers to: the canonical `source_ref` and, when it
  // is a custom id, the internal-id alias a dependency ref arrives as.
  const refs = getTicketRefs(store, ticketId);
  if (refs.length === 0) return 0;
  // NOT project-scoped: a provider ref is workspace-unique, and a dangling ref
  // that points at this ticket must resolve even when the two tickets belong to
  // different projects of the same shared registry — otherwise the blocker
  // would stay stuck with no later path to re-link it.
  // One transaction: resolving a ref rewrites several dependent rows (the
  // merge/UPDATE, the ref backfill, the promotion sweep), and a crash midway
  // must not leave a half-resolved edge.
  return store.db.transaction((): number => resolveDanglingRefsInTransaction(store, ticketId, refs))();
}

function resolveDanglingRefsInTransaction(store: Store, ticketId: number, refs: string[]): number {
  const placeholders = refs.map(() => '?').join(', ');
  const candidates = store.db
    .prepare(
      `SELECT * FROM ticket_relations
        WHERE target_ticket_id IS NULL AND target_ref IN (${placeholders})
        ORDER BY id`,
    )
    .all(...refs) as RelationRow[];

  let resolved = 0;
  for (const row of candidates) {
    const kind: TicketRelationKind = isRelationKind(row.kind) ? row.kind : 'blocked-by';
    if (kind === 'blocked-by' && wouldCreateBlockedByCycle(store, row.ticket_id, ticketId)) {
      continue;
    }
    const existing = store.db
      .prepare(
        `SELECT * FROM ticket_relations
          WHERE ticket_id = ? AND kind = ? AND target_ticket_id = ?
            AND COALESCE(target_proposal_id, '') = COALESCE(?, '')
          LIMIT 1`,
      )
      .get(row.ticket_id, kind, ticketId, row.target_proposal_id) as RelationRow | undefined;
    if (existing) {
      // Merge the dangling row into the resolved equivalent so the unique index
      // is never violated; keep the stronger source and any write-back state.
      const source = strongerSource(
        isRelationSource(existing.source) ? existing.source : 'provider',
        isRelationSource(row.source) ? row.source : 'provider',
      );
      const state =
        (isWritebackState(existing.writeback_state) ? existing.writeback_state : null) ??
        (isWritebackState(row.writeback_state) ? row.writeback_state : null);
      store.db
        .prepare(
          `UPDATE ticket_relations
              SET target_ref = COALESCE(target_ref, ?), source = ?, writeback_state = ?, writeback_error = ?
            WHERE id = ?`,
        )
        .run(row.target_ref, source, state, existing.writeback_error ?? row.writeback_error, existing.id);
      store.db.prepare('DELETE FROM ticket_relations WHERE id = ?').run(row.id);
    } else {
      // Store the canonical ref (the alias may have been the internal form), so
      // a later delete degrades to the addressable form.
      store.db
        .prepare('UPDATE ticket_relations SET target_ticket_id = ?, target_ref = ? WHERE id = ?')
        .run(ticketId, refs[0]!, row.id);
    }
    resolved += 1;
  }

  // A row resolved to this ticket BEFORE its source_ref was known has no ref
  // fallback. Backfill it now. A resolved duplicate that already carries the
  // ref makes this row redundant, so drop it first (it has nothing to fall back
  // to that the sibling does not already have).
  store.db
    .prepare(
      `DELETE FROM ticket_relations
        WHERE target_ticket_id = ? AND target_ref IS NULL
          AND EXISTS (SELECT 1 FROM ticket_relations r2
                        WHERE r2.ticket_id = ticket_relations.ticket_id
                          AND r2.kind = ticket_relations.kind
                          AND r2.target_ticket_id = ticket_relations.target_ticket_id
                          AND COALESCE(r2.target_proposal_id, '') = COALESCE(ticket_relations.target_proposal_id, '')
                          AND r2.target_ref IS NOT NULL
                          AND r2.id <> ticket_relations.id)`,
    )
    .run(ticketId);
  store.db
    .prepare(
      'UPDATE ticket_relations SET target_ref = ? WHERE target_ticket_id = ? AND target_ref IS NULL',
    )
    // The canonical form (`source_ref`, first in `refs`) — addressable and the
    // form a later delete degrades to.
    .run(refs[0]!, ticketId);

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

  return resolved;
}

/**
 * Un-resolve edges that reached `ticketId` through `oldRef` after the ticket is
 * rebound to a DIFFERENT provider ref. A row whose `target_ref` is `oldRef` and
 * whose `target_ticket_id` is this ticket was resolved BECAUSE this ticket was
 * `oldRef`; once the ticket names a different task the row no longer describes
 * that task, so it must degrade to a dangling ref (still blocking) rather than
 * keep a target the ticket no longer represents. Returns how many rows changed.
 */
export function unresolveStaleRelations(store: Store, ticketId: number, oldRef: string): number {
  const info = store.db
    .prepare(
      'UPDATE ticket_relations SET target_ticket_id = NULL WHERE target_ticket_id = ? AND target_ref = ?',
    )
    .run(ticketId, oldRef);
  return Number(info.changes);
}

/**
 * The agent/user blocked-by rows involving `ticketId` whose write-back is not
 * yet `done` and whose BOTH endpoints now carry a `source_ref` — what
 * `onSourceRefBound` attempts. `writeback_state <> 'done'` includes NULL and
 * `failed`, so a failed write-back retries on the next bind.
 */
export function listPendingWritebacks(store: Store, ticketId: number): TicketRelation[] {
  const rows = store.db
    .prepare(
      `SELECT r.* FROM ticket_relations r
         JOIN tickets owner ON owner.id = r.ticket_id
         JOIN tickets target ON target.id = r.target_ticket_id
        WHERE r.kind = 'blocked-by' AND r.source IN ('agent','user')
          AND r.writeback_state IS NOT 'done'
          AND r.target_ticket_id IS NOT NULL
          AND (r.ticket_id = ? OR r.target_ticket_id = ?)
          AND owner.source_ref IS NOT NULL AND trim(owner.source_ref) <> ''
          AND target.source_ref IS NOT NULL AND trim(target.source_ref) <> ''
        ORDER BY r.id`,
    )
    .all(ticketId, ticketId) as RelationRow[];
  return rows.map(rowToRelation);
}

/** Record the outcome of a write-back attempt. `failed` carries the reason. */
export function markWriteback(
  store: Store,
  relationId: number,
  state: WritebackState,
  error?: string,
): void {
  store.db
    .prepare('UPDATE ticket_relations SET writeback_state = ?, writeback_error = ? WHERE id = ?')
    .run(state, state === 'failed' ? (error ?? null) : null, relationId);
}

/** Store one provider-authored row on `ticketId` pointing at `targetRef`. */
function addProviderRelation(
  store: Store,
  ticketId: number,
  kind: TicketRelationKind,
  targetRef: string,
): void {
  addRelation(store, { ticketId, kind, targetRef, source: 'provider' });
}

/**
 * Ingest a fetched brief's relations for `ticketId`. Maps only the ordering
 * kinds: `blocked-by`/`parent` become rows on this ticket; `blocks`/`child`
 * become the corresponding row on the OTHER ticket when it is imported (else
 * skipped). `duplicate`/`related` are not stored. Replaces the `source='provider'`
 * rows this ticket's brief AUTHORED — its own rows on this ticket and the
 * inverse rows it materialized on other tickets (`origin_ticket_id`) — so a
 * link it drops is removed from the other ticket without deleting rows authored
 * by the OTHER ticket's own brief. Agent/user rows survive a refresh.
 *
 * Provider `parent` is display-only: this never touches `subtask_parent_id`,
 * which drives the blocks-parent gate and worktree stacking.
 */
export function ingestBriefRelations(store: Store, ticketId: number, brief: ContextBrief): void {
  const relations: BriefRelation[] = brief.relations ?? [];
  store.db.transaction((): void => {
    // Remove exactly the provider rows THIS brief authored (see `origin_ticket_id`):
    // its own rows (`ticket_id`) plus the inverse rows it materialized on other
    // tickets. Rows authored by another ticket's brief are left to that ticket.
    store.db
      .prepare("DELETE FROM ticket_relations WHERE source = 'provider' AND origin_ticket_id = ?")
      .run(ticketId);
    for (const relation of relations) {
      const ref = trimToNull(relation.ref);
      if (ref === null) continue;
      try {
        if (relation.kind === 'blocked-by') {
          addProviderRelation(store, ticketId, 'blocked-by', ref);
        } else if (relation.kind === 'parent') {
          addProviderRelation(store, ticketId, 'parent', ref);
        } else if (relation.kind === 'blocks') {
          // The OTHER ticket is blocked by THIS one; store the edge there.
          const otherId = resolveRefToTicket(store, ticketId, ref);
          if (otherId !== null && otherId !== ticketId) {
            addRelation(store, {
              ticketId: otherId,
              kind: 'blocked-by',
              targetTicketId: ticketId,
              source: 'provider',
              originTicketId: ticketId,
            });
          }
        } else if (relation.kind === 'child') {
          // The OTHER ticket's parent is THIS one; store the edge there.
          const childId = resolveRefToTicket(store, ticketId, ref);
          if (childId !== null && childId !== ticketId) {
            addRelation(store, {
              ticketId: childId,
              kind: 'parent',
              targetTicketId: ticketId,
              source: 'provider',
              originTicketId: ticketId,
            });
          }
        }
      } catch {
        // A provider link that cannot be stored (e.g. a cycle) is dropped, never
        // allowed to fail the ticket fetch.
      }
    }
  })();
}
