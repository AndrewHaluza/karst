/**
 * Token store: the entry-token shape (a null source node run ONLY when
 * `is_entry = 1`), the four legal transitions, and the successor uniqueness
 * index `(source_node_run_id, edge_id, fork_instance)`.
 */

import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../db.js';
import { createGraphRun } from './graphRuns.js';
import { createRevision } from './revisions.js';
import { createNodeRun } from './nodeRuns.js';
import { createToken, transitionToken, type CreateToken } from './tokens.js';
import { GraphStoreError } from './transitions.js';

function harness(): {
  store: Store;
  revisionId: number;
  sourceNodeRunId: number;
} {
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
  const revisionId = createRevision(store.db, {
    graphRunId,
    revisionNumber: 1,
    canonicalGraph: '{}',
    fingerprint: 'fp',
    status: 'active',
    now: '2026-08-11T00:00:00.000Z',
  });
  const sourceNodeRunId = createNodeRun(store.db, {
    graphRunId,
    revisionId,
    nodeId: 'n1',
    nodeKind: 'agent',
    visitNumber: 1,
    now: '2026-08-11T00:00:00.000Z',
  });
  return { store, revisionId, sourceNodeRunId };
}

describe('entry-token shape', () => {
  it('accepts a null source ONLY when is_entry = 1', () => {
    const { store, revisionId } = harness();
    const id = createToken(store.db, {
      revisionId,
      sourceNodeRunId: null,
      isEntry: 1,
      edgeId: '$entry',
      destinationNodeId: 'start',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    });
    expect(id).toBeGreaterThan(0);
  });

  it('rejects a null source with is_entry = 0', () => {
    const { store, revisionId } = harness();
    expect(() =>
      createToken(store.db, {
        revisionId,
        sourceNodeRunId: null,
        isEntry: 0,
        edgeId: 'e1',
        destinationNodeId: 'n2',
        destinationEnd: 0,
        forkInstance: 0,
        forkLineage: null,
        now: '2026-08-11T00:00:00.000Z',
      }),
    ).toThrow(GraphStoreError);
  });

  it('rejects a real source with is_entry = 1', () => {
    const { store, revisionId, sourceNodeRunId } = harness();
    expect(() =>
      createToken(store.db, {
        revisionId,
        sourceNodeRunId,
        isEntry: 1,
        edgeId: 'e1',
        destinationNodeId: 'n2',
        destinationEnd: 0,
        forkInstance: 0,
        forkLineage: null,
        now: '2026-08-11T00:00:00.000Z',
      }),
    ).toThrow(GraphStoreError);
  });

  it('accepts a real source with is_entry = 0', () => {
    const { store, revisionId, sourceNodeRunId } = harness();
    const id = createToken(store.db, {
      revisionId,
      sourceNodeRunId,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    });
    expect(id).toBeGreaterThan(0);
  });
});

describe('token transitions', () => {
  function claimedToken(): { store: Store; id: number } {
    const { store, revisionId, sourceNodeRunId } = harness();
    const id = createToken(store.db, {
      revisionId,
      sourceNodeRunId,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    });
    expect(transitionToken(store.db, id, 'pending', 'claimed')).toBe(true);
    return { store, id };
  }

  it('pending → claimed and claimed → consumed are legal', () => {
    const { store, id } = claimedToken();
    expect(transitionToken(store.db, id, 'claimed', 'consumed')).toBe(true);
  });

  it('pending → cancelled is legal (revision drain)', () => {
    const { store, revisionId, sourceNodeRunId } = harness();
    const id = createToken(store.db, {
      revisionId,
      sourceNodeRunId,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    });
    expect(transitionToken(store.db, id, 'pending', 'cancelled')).toBe(true);
  });

  it('claimed → pending is REJECTED (a retry keeps the token claimed)', () => {
    const { store, id } = claimedToken();
    expect(() => transitionToken(store.db, id, 'claimed', 'pending')).toThrow(GraphStoreError);
  });

  it('consumed is terminal: no transition out of it', () => {
    const { store, id } = claimedToken();
    transitionToken(store.db, id, 'claimed', 'consumed');
    expect(() => transitionToken(store.db, id, 'consumed', 'cancelled')).toThrow(GraphStoreError);
  });

  it('a stale CAS (row already moved) returns false, never throws', () => {
    const { store, id } = claimedToken();
    transitionToken(store.db, id, 'claimed', 'consumed');
    expect(transitionToken(store.db, id, 'claimed', 'consumed')).toBe(false);
  });
});

describe('successor uniqueness', () => {
  it('one successor per (source_node_run_id, edge_id, fork_instance)', () => {
    const { store, revisionId, sourceNodeRunId } = harness();
    const insert: CreateToken = {
      revisionId,
      sourceNodeRunId,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    };
    createToken(store.db, insert);
    expect(() => createToken(store.db, insert)).toThrow(/UNIQUE/i);
    // A different fork instance is a different successor.
    expect(
      createToken(store.db, { ...insert, forkInstance: 1 }),
    ).toBeGreaterThan(0);
  });

  it('entry tokens (null source) never collide on the successor index', () => {
    const { store, revisionId } = harness();
    const insert: CreateToken = {
      revisionId,
      sourceNodeRunId: null,
      isEntry: 1,
      edgeId: '$entry',
      destinationNodeId: 'start',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now: '2026-08-11T00:00:00.000Z',
    };
    createToken(store.db, insert);
    expect(createToken(store.db, { ...insert, edgeId: '$entry' })).toBeGreaterThan(0);
  });
});
