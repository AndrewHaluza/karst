/**
 * Activation-token store (Slice 3 Task 1).
 *
 * A token records the source node run, edge, destination, revision,
 * fork-lineage stack, and claim/consumption status. Synthetic entry tokens
 * have no source and share the root fork instance. The uniqueness constraint
 * `(source_node_run_id, edge_id, fork_instance)` makes successor insertion
 * idempotent under a duplicated completion.
 *
 * The transition map (`TOKEN_TRANSITIONS`) permits `pending → claimed →
 * consumed` and `→ cancelled`; there is deliberately NO `claimed → pending`
 * transition — a launch retry reuses the reserved node run, it never re-pends
 * the token.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import {
  createToken,
  insertGraphToken,
  graphTokenById,
  pendingTokensForRevision,
  claimGraphToken,
  consumeGraphToken,
  cancelGraphToken,
  transitionToken,
  insertEntryTokens,
  type GraphTokenRow,
} from './tokens.js';
import { GraphStoreError } from './transitions.js';

function harness(): {
  db: ReturnType<typeof openStore>['db'];
  revisionId: number;
  now: string;
} {
  const store = openStore(':memory:');
  const db = store.db;
  const ticketId = Number(
    db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
  );
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, 'karst-graph-engineering', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId)
      .lastInsertRowid,
  );
  const revisionId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run(graphRunId)
      .lastInsertRowid,
  );
  return { db, revisionId, now: '2026-08-12T00:00:00.000Z' };
}

const EDGE = {
  edgeId: 'e1',
  destinationNodeId: 'worker-a',
  destinationEnd: false as const,
  forkInstance: 0,
  forkLineage: 'root',
};

describe('insertGraphToken', () => {
  it('persists the source run, edge, destination, revision and fork stack', () => {
    const { db, revisionId, now } = harness();
    const id = insertGraphToken(db, {
      revisionId,
      sourceNodeRunId: 7,
      isEntry: false,
      ...EDGE,
      now,
    });
    const row = graphTokenById(db, id!)!;
    expect(row).toMatchObject({
      revision_id: revisionId,
      source_node_run_id: 7,
      is_entry: 0,
      edge_id: 'e1',
      destination_node_id: 'worker-a',
      destination_end: 0,
      fork_instance: 0,
      fork_lineage: 'root',
      status: 'pending',
      created_at: now,
    });
  });

  it('creates synthetic entry tokens without a source, sharing the root fork instance', () => {
    const { db, revisionId, now } = harness();
    const ids = insertEntryTokens(
      db,
      revisionId,
      [
        { edgeId: 'entry-a', destinationNodeId: 'worker-a', destinationEnd: false },
        { edgeId: 'entry-b', destinationNodeId: 'worker-b', destinationEnd: false },
      ],
      now,
    );
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const row = graphTokenById(db, id)!;
      expect(row).toMatchObject({
        source_node_run_id: null,
        is_entry: 1,
        fork_instance: 0,
        fork_lineage: 'root',
        status: 'pending',
      });
    }
  });

  it('is idempotent under a duplicated completion: the second insert is ignored', () => {
    const { db, revisionId, now } = harness();
    const first = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, now });
    const second = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, now });
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    const all = db
      .prepare('SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE edge_id = ?')
      .get('e1') as { n: number };
    expect(all.n).toBe(1);
  });

  it('allows distinct activations of the same destination with different fork instances', () => {
    const { db, revisionId, now } = harness();
    const a = insertGraphToken(db, {
      revisionId,
      sourceNodeRunId: 7,
      isEntry: false,
      ...EDGE,
      forkInstance: 0,
      now,
    });
    const b = insertGraphToken(db, {
      revisionId,
      sourceNodeRunId: 7,
      isEntry: false,
      ...EDGE,
      forkInstance: 1,
      now,
    });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });
});

describe('token transitions', () => {
  it('claims only a pending token, exactly once', () => {
    const { db, revisionId, now } = harness();
    const id = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, now })!;
    expect(claimGraphToken(db, id, 11)).toBe(true);
    expect(claimGraphToken(db, id, 12)).toBe(false);
    expect(graphTokenById(db, id)).toMatchObject({ status: 'claimed', claiming_node_run_id: 11 });
  });

  it('consumes only a claimed token and stamps the consuming run', () => {
    const { db, revisionId, now } = harness();
    const id = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, now })!;
    expect(consumeGraphToken(db, id, 9, now)).toBe(false);
    claimGraphToken(db, id, 11);
    expect(consumeGraphToken(db, id, 9, now)).toBe(true);
    expect(consumeGraphToken(db, id, 9, now)).toBe(false);
    expect(graphTokenById(db, id)).toMatchObject({
      status: 'consumed',
      consuming_node_run_id: 9,
      consumed_at: now,
    });
  });

  it('cancels from pending or claimed but never re-pends', () => {
    const { db, revisionId, now } = harness();
    const a = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, edgeId: 'a', now })!;
    const b = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, edgeId: 'b', now })!;
    claimGraphToken(db, b, 11);
    expect(cancelGraphToken(db, a)).toBe(true);
    expect(cancelGraphToken(db, b)).toBe(true);
    expect(cancelGraphToken(db, a)).toBe(false);
    expect(claimGraphToken(db, a, 12)).toBe(false);
    expect(graphTokenById(db, a)).toMatchObject({ status: 'cancelled' });
  });

  it('lists pending tokens for a revision in token order', () => {
    const { db, revisionId, now } = harness();
    const b = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, edgeId: 'b', now })!;
    const a = insertGraphToken(db, { revisionId, sourceNodeRunId: 7, isEntry: false, ...EDGE, edgeId: 'a', now })!;
    claimGraphToken(db, b, 11);
    const pending = pendingTokensForRevision(db, revisionId).map((t: GraphTokenRow) => t.edge_id);
    expect(pending).toEqual(['a']);
    expect(pendingTokensForRevision(db, revisionId + 1)).toEqual([]);
  });
});

describe('entry-token shape (createToken)', () => {
  it('rejects a null source with is_entry = 0', () => {
    const { db, revisionId, now } = harness();
    expect(() =>
      createToken(db, {
        revisionId,
        sourceNodeRunId: null,
        isEntry: 0,
        edgeId: 'e1',
        destinationNodeId: 'n2',
        destinationEnd: 0,
        forkInstance: 0,
        forkLineage: null,
        now,
      }),
    ).toThrow(GraphStoreError);
  });

  it('rejects a real source with is_entry = 1', () => {
    const { db, revisionId, now } = harness();
    expect(() =>
      createToken(db, {
        revisionId,
        sourceNodeRunId: 5,
        isEntry: 1,
        edgeId: 'e1',
        destinationNodeId: 'n2',
        destinationEnd: 0,
        forkInstance: 0,
        forkLineage: null,
        now,
      }),
    ).toThrow(GraphStoreError);
  });

  it('entry tokens (null source) never collide on the successor index', () => {
    const { db, revisionId, now } = harness();
    const insert = {
      revisionId,
      sourceNodeRunId: null as number | null,
      isEntry: 1 as const,
      edgeId: '$entry',
      destinationNodeId: 'start',
      destinationEnd: 0 as const,
      forkInstance: 0,
      forkLineage: null,
      now,
    };
    expect(createToken(db, insert)).toBeGreaterThan(0);
    expect(createToken(db, insert)).toBeGreaterThan(0);
  });
});

describe('transitionToken (generic CAS)', () => {
  it('pending → claimed → consumed are legal; claimed → pending is rejected', () => {
    const { db, revisionId, now } = harness();
    const id = createToken(db, {
      revisionId,
      sourceNodeRunId: 7,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now,
    })!;
    expect(transitionToken(db, id, 'pending', 'claimed')).toBe(true);
    expect(() => transitionToken(db, id, 'claimed', 'pending')).toThrow(GraphStoreError);
    expect(transitionToken(db, id, 'claimed', 'consumed')).toBe(true);
    expect(() => transitionToken(db, id, 'consumed', 'cancelled')).toThrow(GraphStoreError);
  });

  it('a stale CAS (row already moved) returns false, never throws', () => {
    const { db, revisionId, now } = harness();
    const id = createToken(db, {
      revisionId,
      sourceNodeRunId: 7,
      isEntry: 0,
      edgeId: 'e1',
      destinationNodeId: 'n2',
      destinationEnd: 0,
      forkInstance: 0,
      forkLineage: null,
      now,
    })!;
    transitionToken(db, id, 'pending', 'claimed');
    expect(transitionToken(db, id, 'pending', 'claimed')).toBe(false);
  });
});
