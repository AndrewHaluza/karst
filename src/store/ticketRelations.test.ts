import { describe, expect, it } from 'vitest';
import { openStore, type Store } from './db.js';
import {
  archiveTicket,
  createTicket,
  deleteTicket,
  setStageCurrent,
  updateTicketFields,
} from './tickets.js';
import {
  addRelation,
  getTicketSourceRef,
  ingestBriefRelations,
  isBlocked,
  list,
  listBlockers,
  listOpenBlockers,
  listOpenBlockersFor,
  removeRelation,
  resolveDanglingRefs,
  unresolveStaleRelations,
  type BlockerView,
} from './ticketRelations.js';
import type { ContextBrief } from '../integrations/ticketing.js';

function ticket(store: Store, key: string, sourceRef?: string): number {
  const id = createTicket(store, { key, title: key }).id;
  if (sourceRef !== undefined) updateTicketFields(store, id, { sourceRef });
  return id;
}

function brief(relations: ContextBrief['relations']): ContextBrief {
  return { title: 't', description: '', tags: [], comments: [], attachments: [], relations };
}

describe('ticketRelations', () => {
  it('rejects a relation with no target at the SQL CHECK', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A');
    expect(() =>
      store.db
        .prepare("INSERT INTO ticket_relations (ticket_id, kind, source) VALUES (?, 'blocked-by', 'user')")
        .run(a),
    ).toThrow(/CHECK/i);
  });

  it('rejects a relation with no target in addRelation', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A');
    expect(() => addRelation(store, { ticketId: a, kind: 'blocked-by', source: 'user' })).toThrow(
      /target/i,
    );
  });

  it('is unique by (ticket, kind, target) — a duplicate insert is one row', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A');
    addRelation(store, { ticketId: a, kind: 'parent', targetRef: 'P-1', source: 'user' });
    addRelation(store, { ticketId: a, kind: 'parent', targetRef: 'P-1', source: 'agent' });
    expect(listBlockers(store, a)).toHaveLength(0);
    expect(list(store, a)).toHaveLength(1);
    // The first writer wins; the second INSERT OR IGNORE does not overwrite source.
    expect(list(store, a)[0]!.source).toBe('user');
  });

  it('fills target_ref from a resolved target so a deleted target degrades to a ref', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    const rel = addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'agent' });
    expect(rel.targetTicketId).toBe(b);
    expect(rel.targetRef).toBe('CU-B');

    deleteTicket(store, b);
    const after = listBlockers(store, a)[0]!;
    expect(after.targetTicketId).toBeNull();
    expect(after.targetRef).toBe('CU-B');
    // A deleted blocker is unresolved, so it still blocks.
    expect(isBlocked(store, a)).toBe(true);
  });

  it('deleting a target with no ref drops the relation instead of failing the CHECK', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A'); // no source_ref
    const b = ticket(store, 'B'); // no source_ref
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'agent' });
    expect(() => deleteTicket(store, b)).not.toThrow();
    expect(list(store, a)).toHaveLength(0);
  });

  it('adopts a dangling ref when the same edge later resolves (no duplicate UNIQUE error)', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B'); // unbound at first
    // A's brief names its blocker before B is imported → a dangling provider row.
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-B', source: 'provider' });
    updateTicketFields(store, b, { sourceRef: 'CU-B' });
    // B's brief now reports it blocks A → the SAME edge, resolved. It must adopt
    // the dangling row, not insert a second one.
    expect(() =>
      ingestBriefRelations(store, b, brief([{ kind: 'blocks', ref: 'CU-A' }])),
    ).not.toThrow();
    const blockers = listBlockers(store, a);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ targetTicketId: b, targetRef: 'CU-B' });
    // Resolving again is a no-op, never a UNIQUE collision.
    expect(() => resolveDanglingRefs(store, b)).not.toThrow();
    expect(listBlockers(store, a)).toHaveLength(1);
  });

  it('merges a dangling row into an existing resolved equivalent instead of colliding', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    // Bypass addRelation to force the pre-existing duplicate the UAT probe hit:
    // one resolved row and one dangling row for the same edge.
    store.db
      .prepare(
        "INSERT INTO ticket_relations (ticket_id, kind, target_ticket_id, target_ref, source) VALUES (?, 'blocked-by', ?, ?, 'provider')",
      )
      .run(a, b, 'CU-B');
    store.db
      .prepare(
        "INSERT INTO ticket_relations (ticket_id, kind, target_ref, source) VALUES (?, 'blocked-by', ?, 'provider')",
      )
      .run(a, 'CU-B');
    expect(() => resolveDanglingRefs(store, b)).not.toThrow();
    expect(listBlockers(store, a)).toHaveLength(1);
  });

  it('never resolves a dangling ref into a blocked-by cycle', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B'); // unbound
    // A is (agent) blocked by the not-yet-imported CU-B.
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-B', source: 'agent' });
    // B is blocked by A. The cycle check passes because A's row is still dangling.
    addRelation(store, { ticketId: b, kind: 'blocked-by', targetTicketId: a, source: 'user' });
    updateTicketFields(store, b, { sourceRef: 'CU-B' });

    expect(() => resolveDanglingRefs(store, b)).not.toThrow();
    // A's ref stays dangling (never resolved into a cycle); B's edge is intact.
    expect(listBlockers(store, a)[0]!.targetTicketId).toBeNull();
    expect(listBlockers(store, b)[0]!.targetTicketId).toBe(a);
  });

  it('backfills target_ref when a target gains its source_ref after the relation was created', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B'); // unbound when the relation is created
    const rel = addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'agent' });
    expect(rel.targetTicketId).toBe(b);
    expect(rel.targetRef).toBeNull();

    updateTicketFields(store, b, { sourceRef: 'CU-B' });
    resolveDanglingRefs(store, b);
    expect(listBlockers(store, a)[0]!.targetRef).toBe('CU-B');

    // Now deleting B degrades the edge to the bare ref instead of dropping it.
    deleteTicket(store, b);
    const after = listBlockers(store, a)[0]!;
    expect(after.targetTicketId).toBeNull();
    expect(after.targetRef).toBe('CU-B');
    expect(isBlocked(store, a)).toBe(true);
  });

  it('counts a NULL-stage target as open (NULL-safe IS NOT done)', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    store.db.prepare('UPDATE tickets SET stage_current = NULL WHERE id = ?').run(b);
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'agent' });
    expect(isBlocked(store, a)).toBe(true);
  });

  it('does not block when the target is done or archived', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'agent' });
    setStageCurrent(store, b, 'done');
    expect(isBlocked(store, a)).toBe(false);

    setStageCurrent(store, b, 'impl');
    archiveTicket(store, b);
    expect(isBlocked(store, a)).toBe(false);
  });

  it('treats an unresolved target_ref as blocking', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-GHOST', source: 'user' });
    expect(isBlocked(store, a)).toBe(true);
  });

  it('rejects a blocked-by cycle with a clear error', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });
    expect(() =>
      addRelation(store, { ticketId: b, kind: 'blocked-by', targetTicketId: a, source: 'user' }),
    ).toThrow(/cycle/i);
  });

  it('rejects a self-block', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    expect(() =>
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: a, source: 'user' }),
    ).toThrow(/itself/i);
  });

  it('derives blocks/child inverses on read', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    const c = ticket(store, 'C', 'CU-C');
    // A is blocked by B → B blocks A (derived on B).
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'provider' });
    // C is a child of B → B has a child C (derived on B).
    addRelation(store, { ticketId: c, kind: 'parent', targetTicketId: b, source: 'provider' });

    const bView = list(store, b);
    const blocks = bView.find((r) => r.kind === 'blocks');
    expect(blocks).toMatchObject({ derived: true, targetTicketId: a, targetRef: 'CU-A' });
    const child = bView.find((r) => r.kind === 'child');
    expect(child).toMatchObject({ derived: true, targetTicketId: c, targetRef: 'CU-C' });

    // The authoring side sees the stored kind, not the inverse.
    expect(list(store, a)[0]).toMatchObject({ kind: 'blocked-by', derived: false, targetTicketId: b });
    expect(list(store, c)[0]).toMatchObject({ kind: 'parent', derived: false, targetTicketId: b });
  });

  it('removes a relation by id', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A');
    const rel = addRelation(store, { ticketId: a, kind: 'parent', targetRef: 'P', source: 'user' });
    expect(removeRelation(store, rel.id)).toBe(true);
    expect(removeRelation(store, rel.id)).toBe(false);
    expect(list(store, a)).toHaveLength(0);
  });

  it('resolves a dangling ref when the target ticket gains its source_ref', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B'); // no source_ref yet
    const rel = addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-B', source: 'agent' });
    expect(rel.targetTicketId).toBeNull();

    updateTicketFields(store, b, { sourceRef: 'CU-B' });
    expect(resolveDanglingRefs(store, b)).toBe(1);
    expect(listBlockers(store, a)[0]!.targetTicketId).toBe(b);
    // Resolving promoted the agent row to a write-back candidate.
    expect(listBlockers(store, a)[0]!.writebackState).toBe('pending');
  });

  it('resolveDanglingRefs resolves a dangling internal ref through the ticket alias', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B');
    // A brief named B by its INTERNAL id — what ClickUp's `depends_on` carries.
    const rel = addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: '9002', source: 'provider' });
    expect(rel.targetTicketId).toBeNull();

    // B is bound by its CUSTOM id, keeping its internal id as the alias.
    updateTicketFields(store, b, { sourceRef: 'DEF-456', sourceRefInternal: '9002' });
    expect(resolveDanglingRefs(store, b)).toBe(1);
    const resolved = listBlockers(store, a)[0]!;
    expect(resolved.targetTicketId).toBe(b);
    // Resolved refs store the canonical form, so a later delete degrades to it.
    expect(resolved.targetRef).toBe('DEF-456');
  });

  it('ingests a relation whose ref is the target ticket’s internal alias', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B');
    updateTicketFields(store, b, { sourceRef: 'DEF-456', sourceRefInternal: '9002' });

    ingestBriefRelations(store, a, brief([{ kind: 'blocked-by', ref: '9002' }]));

    const row = listBlockers(store, a)[0]!;
    expect(row.targetTicketId).toBe(b);
    expect(row.targetRef).toBe('DEF-456');
  });

  it('unresolveStaleRelations degrades edges resolved through an abandoned ref', () => {
    const store = openStore(':memory:');
    const c = ticket(store, 'C', 'CU-C');
    const t = ticket(store, 'T', 'CU-T');
    const rel = addRelation(store, { ticketId: c, kind: 'blocked-by', targetRef: 'CU-T', source: 'provider' });
    expect(rel.targetTicketId).toBe(t);

    // T is rebound to a different provider task: the edge no longer describes T.
    expect(unresolveStaleRelations(store, t, 'CU-T')).toBe(1);
    const after = listBlockers(store, c)[0]!;
    expect(after.targetTicketId).toBeNull();
    expect(after.targetRef).toBe('CU-T');
    // A dangling ref still blocks — the ticket is not silently unblocked.
    expect(isBlocked(store, c)).toBe(true);
  });

  it('resolves a dangling ref to a ticket in another project', () => {
    const store = openStore(':memory:');
    const p1 = Number(store.db.prepare("INSERT INTO projects (slug) VALUES ('p1')").run().lastInsertRowid);
    const p2 = Number(store.db.prepare("INSERT INTO projects (slug) VALUES ('p2')").run().lastInsertRowid);
    const a = createTicket(store, { key: 'A', title: 'A', projectId: p1 }).id;
    updateTicketFields(store, a, { sourceRef: 'CU-A' });
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-B', source: 'user' });
    const b = createTicket(store, { key: 'B', title: 'B', projectId: p2 }).id;

    updateTicketFields(store, b, { sourceRef: 'CU-B' });
    expect(resolveDanglingRefs(store, b)).toBe(1);
    expect(listBlockers(store, a)[0]!.targetTicketId).toBe(b);
    expect(isBlocked(store, a)).toBe(true);
  });

  it('resolveDanglingRefs is a no-op for a ticket with no source_ref', () => {
    const store = openStore(':memory:');
    const b = ticket(store, 'B');
    expect(getTicketSourceRef(store, b)).toBeNull();
    expect(resolveDanglingRefs(store, b)).toBe(0);
  });

  it('ingests blocked-by/parent rows and skips duplicate/related', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    ingestBriefRelations(
      store,
      a,
      brief([
        { kind: 'blocked-by', ref: 'CU-B' },
        { kind: 'parent', ref: 'CU-P' },
        { kind: 'duplicate', ref: 'CU-D' },
        { kind: 'related', ref: 'CU-R' },
      ]),
    );
    const stored = listBlockers(store, a);
    expect(stored.map((r) => r.targetRef)).toEqual(['CU-B']);
    expect(list(store, a).map((r) => r.kind).sort()).toEqual(['blocked-by', 'parent']);
  });

  it("ingests 'blocks' as a blocked-by row on the imported OTHER ticket", () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    // The brief for A says A blocks B → B is blocked by A.
    ingestBriefRelations(store, a, brief([{ kind: 'blocks', ref: 'CU-B' }]));
    const blockersOfB = listBlockers(store, b);
    expect(blockersOfB).toHaveLength(1);
    expect(blockersOfB[0]).toMatchObject({ kind: 'blocked-by', targetTicketId: a, targetRef: 'CU-A' });
    // A does not store a blocked-by row for this edge.
    expect(listBlockers(store, a)).toHaveLength(0);
  });

  it("ingests 'child' as a parent row on the imported OTHER ticket", () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const c = ticket(store, 'C', 'CU-C');
    ingestBriefRelations(store, a, brief([{ kind: 'child', ref: 'CU-C' }]));
    expect(list(store, c)[0]).toMatchObject({ kind: 'parent', targetTicketId: a });
  });

  it("skips 'blocks'/'child' when the other ticket is not imported", () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    ingestBriefRelations(store, a, brief([{ kind: 'blocks', ref: 'CU-GHOST' }]));
    expect(list(store, a)).toHaveLength(0);
  });

  it("removes the inverse provider row on the other ticket when the link is dropped", () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    ingestBriefRelations(store, a, brief([{ kind: 'blocks', ref: 'CU-B' }]));
    expect(isBlocked(store, b)).toBe(true);

    // A's brief no longer carries the link → B's materialized blocker goes away.
    ingestBriefRelations(store, a, brief([]));
    expect(listBlockers(store, b)).toHaveLength(0);
    expect(isBlocked(store, b)).toBe(false);
  });

  it('refresh keeps only the inverse provider rows still in the brief', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    const c = ticket(store, 'C', 'CU-C');
    ingestBriefRelations(store, a, brief([
      { kind: 'blocks', ref: 'CU-B' },
      { kind: 'child', ref: 'CU-C' },
    ]));

    ingestBriefRelations(store, a, brief([{ kind: 'blocks', ref: 'CU-B' }]));
    expect(listBlockers(store, b)).toHaveLength(1);
    expect(list(store, c)).toHaveLength(0);
  });

  it('heals a cross-form dangling ref once the target rebinds to its canonical ref', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'ABC-123');
    const b = ticket(store, 'B', '9002'); // legacy internal ref
    // A's brief names B by its custom id, which does not match B's legacy ref.
    ingestBriefRelations(store, a, brief([{ kind: 'blocked-by', ref: 'DEF-456' }]));
    expect(listBlockers(store, a)[0]!.targetTicketId).toBeNull();

    // B rebinds to its canonical ref (what fetchSource now stores), then its own
    // brief reports the reciprocal edge.
    updateTicketFields(store, b, { sourceRef: 'DEF-456' });
    ingestBriefRelations(store, b, brief([{ kind: 'blocks', ref: 'ABC-123' }]));
    resolveDanglingRefs(store, b);

    const blockers = listBlockers(store, a);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.targetTicketId).toBe(b);
    setStageCurrent(store, b, 'done');
    expect(isBlocked(store, a)).toBe(false);
  });

  it('keeps a reciprocal edge when only one side drops it', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    // A's brief names the edge as `blocks`, B's as `blocked-by` — the same row.
    ingestBriefRelations(store, a, brief([{ kind: 'blocks', ref: 'CU-B' }]));
    ingestBriefRelations(store, b, brief([{ kind: 'blocked-by', ref: 'CU-A' }]));
    expect(listBlockers(store, b)).toHaveLength(1);

    // A drops its side, but B's brief independently asserts the edge → it stays.
    ingestBriefRelations(store, a, brief([]));
    expect(listBlockers(store, b)).toHaveLength(1);
  });

  it("keeps another ticket's own provider row when this ticket is refetched", () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const b = ticket(store, 'B', 'CU-B');
    // B's OWN brief reports it is blocked by A → a provider row on B, authored by B.
    ingestBriefRelations(store, b, brief([{ kind: 'blocked-by', ref: 'CU-A' }]));
    expect(isBlocked(store, b)).toBe(true);

    // A is refetched with no relations; it authored nothing here, so B's row stays.
    ingestBriefRelations(store, a, brief([]));
    expect(listBlockers(store, b)).toHaveLength(1);
    expect(isBlocked(store, b)).toBe(true);
  });

  it('refresh replaces provider rows but preserves agent/user rows', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    ingestBriefRelations(store, a, brief([{ kind: 'blocked-by', ref: 'CU-OLD' }]));
    addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-MINE', source: 'agent' });

    ingestBriefRelations(store, a, brief([{ kind: 'blocked-by', ref: 'CU-NEW' }]));
    const refs = listBlockers(store, a).map((r) => r.targetRef).sort();
    expect(refs).toEqual(['CU-MINE', 'CU-NEW']);
    expect(listBlockers(store, a).find((r) => r.targetRef === 'CU-OLD')).toBeUndefined();
  });

  it('does not touch subtask_parent_id for a provider parent relation', () => {
    const store = openStore(':memory:');
    const a = ticket(store, 'A', 'CU-A');
    const p = ticket(store, 'P', 'CU-P');
    ingestBriefRelations(store, a, brief([{ kind: 'parent', ref: 'CU-P' }]));
    const row = store.db.prepare('SELECT subtask_parent_id FROM tickets WHERE id = ?').get(a) as {
      subtask_parent_id: number | null;
    };
    expect(row.subtask_parent_id).toBeNull();
    expect(list(store, a)[0]!.targetTicketId).toBe(p);
  });

  describe('listOpenBlockers', () => {
    it('lists blockers that are open (stage not done)', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'CU-B');
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });

      const blockers = listOpenBlockers(store, a);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatchObject({ targetTicketId: b });
    });

    it('filters out blockers that are done', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'CU-B');
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });
      setStageCurrent(store, b, 'done');

      expect(listOpenBlockers(store, a)).toHaveLength(0);
    });

    it('labels a resolved target with no key as #id', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B');
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });
      store.db.prepare('UPDATE tickets SET key = NULL WHERE id = ?').run(b);

      expect(listOpenBlockers(store, a)[0]!.label).toBe(`T${b}`);
    });

    it('filters out blockers that are archived', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'CU-B');
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });
      setStageCurrent(store, b, 'impl');
      archiveTicket(store, b);

      expect(listOpenBlockers(store, a)).toHaveLength(0);
    });

    it('includes unresolved refs as open', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-GHOST', source: 'user' });

      const blockers = listOpenBlockers(store, a);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toMatchObject({ targetTicketId: null });
    });

    it('includes NULL-stage targets as open', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'CU-B');
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });
      store.db.prepare('UPDATE tickets SET stage_current = NULL WHERE id = ?').run(b);

      expect(listOpenBlockers(store, a)).toHaveLength(1);
    });

    it('builds label as "key / ref" when both differ', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'DEF-456');
      updateTicketFields(store, b, { sourceRef: 'DEF-456' });
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });

      const blocker = listOpenBlockers(store, a)[0]!;
      expect(blocker.label).toBe('B / DEF-456');
    });

    it('builds label as key only when ref equals key', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'B');
      updateTicketFields(store, b, { sourceRef: 'B' });
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });

      const blocker = listOpenBlockers(store, a)[0]!;
      expect(blocker.label).toBe('B');
    });

    it('builds label as dangling ref when unresolved', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetRef: 'CU-GHOST', source: 'user' });

      const blocker = listOpenBlockers(store, a)[0]!;
      expect(blocker.label).toBe('CU-GHOST');
    });

    it('returns empty array when no open blockers', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');

      expect(listOpenBlockers(store, a)).toHaveLength(0);
    });
  });

  describe('listOpenBlockersFor', () => {
    it('lists open blockers for multiple tickets', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'CU-B');
      const c = ticket(store, 'C', 'CU-C');
      const d = ticket(store, 'D', 'CU-D');

      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: c, source: 'user' });
      addRelation(store, { ticketId: d, kind: 'blocked-by', targetTicketId: b, source: 'user' });

      const result = listOpenBlockersFor(store, [a, d]);
      expect(result.get(a)).toHaveLength(2);
      expect(result.get(d)).toHaveLength(1);
    });

    it('returns empty map for empty id list', () => {
      const store = openStore(':memory:');
      const result = listOpenBlockersFor(store, []);
      expect(result.size).toBe(0);
    });

    it('includes entries for tickets with no open blockers', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'CU-B');

      const result = listOpenBlockersFor(store, [a, b]);
      expect(result.has(a)).toBe(true);
      expect(result.has(b)).toBe(true);
      expect(result.get(a)).toHaveLength(0);
      expect(result.get(b)).toHaveLength(0);
    });

    it('filters done blockers from the batch result', () => {
      const store = openStore(':memory:');
      const a = ticket(store, 'A', 'CU-A');
      const b = ticket(store, 'B', 'CU-B');
      const c = ticket(store, 'C', 'CU-C');

      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: b, source: 'user' });
      addRelation(store, { ticketId: a, kind: 'blocked-by', targetTicketId: c, source: 'user' });
      setStageCurrent(store, b, 'done');

      const result = listOpenBlockersFor(store, [a]);
      const blockers = result.get(a)!;
      expect(blockers).toHaveLength(1);
      expect(blockers[0]!.targetTicketId).toBe(c);
    });
  });
});
