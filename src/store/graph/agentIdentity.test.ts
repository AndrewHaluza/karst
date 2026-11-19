/**
 * The per-run agent identity snapshot (v133, @arch:GRAPHRUN): one JSON column
 * on `approach_graph_runs`, written at bootstrap and replaced by a switch.
 * NULL = a pre-v133 run, which resolves live.
 */

import { describe, it, expect } from 'vitest';
import { openStore } from '../db.js';
import { createTicket } from '../tickets.js';
import {
  createGraphRun,
  graphRunAgentIdentity,
  setGraphRunAgentIdentity,
} from './graphRuns.js';

const NOW = '2026-11-19T00:00:00.000Z';

function openRun(): { db: ReturnType<typeof openStore>['db']; runId: number; ticketId: number } {
  const store = openStore(':memory:');
  const ticketId = createTicket(store, { key: 'AI-1', title: 't' }).id;
  const runId = createGraphRun(store.db, { ticketId, stageAttempt: 0, approachId: 'x', now: NOW });
  return { db: store.db, runId, ticketId };
}

describe('graph-run agent identity column', () => {
  it('is null on a new run (a pre-snapshot run resolves live)', () => {
    const { db, runId } = openRun();
    expect(graphRunAgentIdentity(db, runId)).toBeNull();
  });

  it('stores and replaces the snapshot text and stamps updated_at', () => {
    const { db, runId } = openRun();
    expect(setGraphRunAgentIdentity(db, runId, '{"a":1}', NOW)).toBe(true);
    expect(graphRunAgentIdentity(db, runId)).toBe('{"a":1}');
    expect(setGraphRunAgentIdentity(db, runId, '{"a":2}', '2026-11-19T01:00:00.000Z')).toBe(true);
    expect(graphRunAgentIdentity(db, runId)).toBe('{"a":2}');
    expect(
      (db.prepare('SELECT updated_at FROM approach_graph_runs WHERE id = ?').get(runId) as { updated_at: string })
        .updated_at,
    ).toBe('2026-11-19T01:00:00.000Z');
  });

  it('returns false for an unknown run', () => {
    const { db } = openRun();
    expect(setGraphRunAgentIdentity(db, 999, '{}', NOW)).toBe(false);
    expect(graphRunAgentIdentity(db, 999)).toBeNull();
  });

});
