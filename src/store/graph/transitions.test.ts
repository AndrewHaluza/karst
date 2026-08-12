/**
 * The five transition maps pinned against the design's tables (design,
 * "Transition maps") and the CAS primitive.
 *
 * The maps are the testable contract: every documented pair is present, every
 * present pair is documented, and the two rules the tables call out by name —
 * `claimed → pending` is illegal, and the node-run rest states
 * (`failed-to-launch`/`blocked`/`stale`) have exactly the two exits
 * (`→ launching` recovery, `→ cancelled` drain) — hold structurally.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  GRAPH_RUN_TRANSITIONS,
  REVISION_TRANSITIONS,
  NODE_RUN_TRANSITIONS,
  TOKEN_TRANSITIONS,
  LEASE_TRANSITIONS,
  casStatus,
  assertLegalTransition,
  GraphStoreError,
} from './transitions.js';

/** A pair set `{ "from→to" }` for readable diffs. */
function pairs(map: Readonly<Record<string, readonly string[]>>): Set<string> {
  const out = new Set<string>();
  for (const [from, tos] of Object.entries(map)) {
    for (const to of tos) out.add(`${from} → ${to}`);
  }
  return out;
}

function expectPairsEqual(
  map: Readonly<Record<string, readonly string[]>>,
  documented: string[],
): void {
  const actual = pairs(map);
  const expected = new Set(documented);
  expect([...actual].filter((p) => !expected.has(p))).toEqual([]); // extra pairs
  expect([...expected].filter((p) => !actual.has(p))).toEqual([]); // missing pairs
}

describe('graph-run transition map', () => {
  it('admits exactly the documented pairs', () => {
    expectPairsEqual(GRAPH_RUN_TRANSITIONS, [
      'planning → awaiting-confirmation',
      'planning → running',
      'awaiting-confirmation → running',
      'running → draining',
      'draining → running',
      'running → blocked',
      'blocked → running',
      'running → completed-awaiting-impl-marker',
      'draining → completed-awaiting-impl-marker',
      'completed-awaiting-impl-marker → closed',
      'planning → cancelled',
      'awaiting-confirmation → cancelled',
      'running → cancelled',
      'draining → cancelled',
      'blocked → cancelled',
      'completed-awaiting-impl-marker → cancelled',
      'planning → stale',
      'awaiting-confirmation → stale',
      'running → stale',
      'draining → stale',
      'blocked → stale',
      'completed-awaiting-impl-marker → stale',
    ]);
  });
});

describe('revision transition map', () => {
  it('admits exactly the documented pairs', () => {
    expectPairsEqual(REVISION_TRANSITIONS, [
      'active → draining',
      'draining → superseded',
      'active → completed',
      'draining → completed',
      'active → superseded',
    ]);
  });
});

describe('node-run transition map', () => {
  it('admits exactly the documented pairs', () => {
    expectPairsEqual(NODE_RUN_TRANSITIONS, [
      'ready → waiting-resource',
      'waiting-resource → ready',
      'ready → launching',
      // Slice-3 T4: a join never launches — its ready visit completes directly.
      'ready → completing',
      'launching → running',
      'launching → failed-to-launch',
      'launching → launch-unknown',
      // Slice-4 T3: a crash before spawn (owner nonce persisted, no process
      // identity) is provably retryable — the node parks at `blocked`, the
      // rest state the typed recovery action already relaunches.
      'launching → blocked',
      'running → completing',
      'completing → integrating',
      'completing → running',
      // Slice-4 T3: an integrating node with a live attributable process
      // reverts to `running` so completion proceeds normally.
      'integrating → running',
      'integrating → completed',
      // Slice-3 T8: the completing pipeline must be able to park a node whose
      // termination cannot be proven, and the integrating step must be able to
      // block a node whose change set failed integration.
      'completing → termination-unknown',
      // Slice-4 T2: the completing pipeline parks a node whose required
      // output artifacts are missing or unsafe (effective outcome null, no
      // edge); recovery is an explicit retry, never automatic.
      'completing → output-artifact-missing',
      'completing → artifact-unsafe',
      'integrating → blocked',
      'running → blocked',
      'running → stale',
      'running → termination-unknown',
      'launch-unknown → cancelled',
      'termination-unknown → cancelled',
      'ready → cancelled',
      'waiting-resource → cancelled',
      'launching → cancelled',
      'running → cancelled',
      'completing → cancelled',
      'integrating → cancelled',
      'failed-to-launch → launching',
      'blocked → launching',
      'stale → launching',
      'output-artifact-missing → launching',
      'artifact-unsafe → launching',
      'failed-to-launch → cancelled',
      'blocked → cancelled',
      'stale → cancelled',
      'output-artifact-missing → cancelled',
      'artifact-unsafe → cancelled',
    ]);
  });

  it('the rest states each carry exactly the two exits: recovery launch and drain cancel', () => {
    for (const rest of ['failed-to-launch', 'blocked', 'stale', 'output-artifact-missing', 'artifact-unsafe']) {
      const exits = NODE_RUN_TRANSITIONS[rest] ?? [];
      expect(exits).toEqual(['launching', 'cancelled']);
    }
  });

  it('completed and cancelled are the only terminal statuses', () => {
    for (const [from, tos] of Object.entries(NODE_RUN_TRANSITIONS)) {
      if (from === 'completed' || from === 'cancelled') {
        expect(tos).toEqual([]);
      } else {
        expect(tos.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('token transition map', () => {
  it('admits exactly the four documented transitions', () => {
    expectPairsEqual(TOKEN_TRANSITIONS, [
      'pending → claimed',
      'pending → cancelled',
      'claimed → consumed',
      'claimed → cancelled',
    ]);
  });

  it('claimed → pending is rejected', () => {
    expect(() => assertLegalTransition(TOKEN_TRANSITIONS, 'approach_graph_tokens', 'claimed', 'pending'))
      .toThrow(GraphStoreError);
  });
});

describe('lease transition map', () => {
  it('admits exactly the documented pairs', () => {
    expectPairsEqual(LEASE_TRANSITIONS, [
      'held → released',
      'held → ambiguous-process',
      'ambiguous-process → released',
    ]);
  });
});

describe('casStatus', () => {
  it('throws for a pair absent from the map', () => {
    const fakeDb = {
      prepare: () => {
        throw new Error('prepare must not run for an illegal pair');
      },
    };
    expect(() =>
      casStatus(fakeDb as never, 'approach_graph_tokens', TOKEN_TRANSITIONS, 1, 'claimed', 'pending'),
    ).toThrow(GraphStoreError);
  });

  it('returns false (never throws) when the row already moved', () => {
    // A stale caller: the row is no longer at `from`, so the conditional
    // UPDATE matches nothing and the outcome is `false`, not an exception.
    const db = new Database(':memory:');
    db.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('a','b')))",
    );
    db.prepare("INSERT INTO t (status) VALUES ('b')").run();
    const result = casStatus(
      { prepare: (s: string) => db.prepare(s) },
      't',
      { a: ['b'] },
      1,
      'a',
      'b',
    );
    expect(result).toBe(false);
    db.close();
  });
});
