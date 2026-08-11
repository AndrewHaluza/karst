/**
 * Revision store: monotonic revision numbers per run, the DERIVED active
 * revision (never a stored column), and the revision transition map.
 */

import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../db.js';
import { createGraphRun } from './graphRuns.js';
import { createRevision, activeRevision, transitionRevision } from './revisions.js';
import { GraphStoreError } from './transitions.js';

function harness(): { store: Store; graphRunId: number } {
  const store = openStore(':memory:');
  const ticketId = Number(
    store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = createGraphRun(store.db, {
    ticketId,
    stageAttempt: 0,
    approachId: 'karst-graph-engineering',
    now: '2026-08-11T00:00:00.000Z',
  });
  return { store, graphRunId };
}

function rev(
  store: Store,
  graphRunId: number,
  revisionNumber: number,
  status: 'active' | 'draining' | 'superseded' | 'completed',
  supersedesRevisionId?: number,
): number {
  return createRevision(store.db, {
    graphRunId,
    revisionNumber,
    canonicalGraph: `{"rev":${revisionNumber}}`,
    fingerprint: `fp-${revisionNumber}`,
    status,
    now: '2026-08-11T00:00:00.000Z',
    supersedesRevisionId,
  });
}

describe('createRevision', () => {
  it('one revision number per run — a duplicate is rejected', () => {
    const { store, graphRunId } = harness();
    rev(store, graphRunId, 1, 'active');
    expect(() => rev(store, graphRunId, 1, 'draining')).toThrow(/UNIQUE/i);
  });

  it('the same revision number on another run is fine', () => {
    const { store, graphRunId } = harness();
    rev(store, graphRunId, 1, 'active');
    const other = createGraphRun(store.db, {
      ticketId: Number(
        store.db.prepare("INSERT INTO tickets (key) VALUES ('T-2')").run().lastInsertRowid,
      ),
      stageAttempt: 0,
      approachId: 'karst-graph-engineering',
      now: '2026-08-11T00:00:00.000Z',
    });
    expect(rev(store, other, 1, 'active')).toBeGreaterThan(0);
  });
});

describe('derived active revision', () => {
  it('returns at most one row — the partial unique index is structural', () => {
    const { store, graphRunId } = harness();
    const r1 = rev(store, graphRunId, 1, 'active');
    expect(activeRevision(store.db, graphRunId)?.id).toBe(r1);

    // A second active revision for the same run is rejected by the index.
    expect(() => rev(store, graphRunId, 2, 'active')).toThrow(/UNIQUE/i);

    // Draining the first frees the slot: the second may become active.
    expect(transitionRevision(store.db, r1, 'active', 'draining')).toBe(true);
    const r2 = rev(store, graphRunId, 2, 'active');
    expect(activeRevision(store.db, graphRunId)?.id).toBe(r2);

    // Superseding the old revision: still exactly one active row.
    expect(transitionRevision(store.db, r1, 'draining', 'superseded')).toBe(true);
    expect(activeRevision(store.db, graphRunId)?.id).toBe(r2);
  });

  it('returns undefined when no revision is active', () => {
    const { store, graphRunId } = harness();
    expect(activeRevision(store.db, graphRunId)).toBeUndefined();
  });
});

describe('revision transitions', () => {
  it('active → completed (END quiescence)', () => {
    const { store, graphRunId } = harness();
    const id = rev(store, graphRunId, 1, 'active');
    expect(transitionRevision(store.db, id, 'active', 'completed')).toBe(true);
  });

  it('active → superseded is legal only for a graph-run cancel (no orphan active row)', () => {
    const { store, graphRunId } = harness();
    const id = rev(store, graphRunId, 1, 'active');
    expect(transitionRevision(store.db, id, 'active', 'superseded')).toBe(true);
  });

  it('draining → superseded records the successor', () => {
    const { store, graphRunId } = harness();
    const r1 = rev(store, graphRunId, 1, 'active');
    transitionRevision(store.db, r1, 'active', 'draining');
    const r2 = rev(store, graphRunId, 2, 'active', r1);
    expect(activeRevision(store.db, graphRunId)?.id).toBe(r2);
  });

  it('rejects pairs outside the map (completed is terminal)', () => {
    const { store, graphRunId } = harness();
    const id = rev(store, graphRunId, 1, 'active');
    transitionRevision(store.db, id, 'active', 'completed');
    expect(() => transitionRevision(store.db, id, 'completed', 'superseded')).toThrow(
      GraphStoreError,
    );
  });
});
