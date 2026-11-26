/**
 * T1385 — the host binding of the first-activity watchdog: find the live graph
 * session by (graph run, node run) and terminate it through the transport's
 * attributable kill, exactly like the usage-limit park's lookup. A missing
 * transport, a denied kill or a thrown failure never touches the row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../store/db.js';
import type { GraphDb } from '../store/graph/transitions.js';
import { createTicket } from '../store/tickets.js';
import { upsertProject } from '../store/projects.js';
import type {
  SupervisedAgentSession,
  TerminationProof,
} from '../approaches/graph/transport/agentTransport.js';
import { createGraphFirstActivityBinding } from './graphFirstActivityBinding.js';

const NOW = '2026-11-26T10:00:00.000Z';
const MINUTE = 60_000;

let store: Store;
let ticketId: number;

interface Fixture {
  graphRunId: number;
  nodeRunId: number;
  deps: Parameters<typeof createGraphFirstActivityBinding>[0];
  terminated: SupervisedAgentSession[];
  errors: unknown[];
  messages: string[];
  debugs: string[];
}

function fixture(input: {
  proof?: TerminationProof;
  withSession?: boolean;
  withTransport?: boolean;
  terminateThrows?: boolean;
  /** Replace the matching session's identity fields (a non-matching session). */
  sessionPatch?: Partial<SupervisedAgentSession>;
  /** Extra sessions listed BEFORE the session under test. */
  decoys?: (graphRunId: number, nodeRunId: number) => SupervisedAgentSession[];
} = {}): Fixture {
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, active_processes, created_at)
         VALUES (?, 'impl', 0, 'x', 'running', 1, ?)`,
      )
      .run(ticketId, NOW).lastInsertRowid,
  );
  const revisionId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, 1, '{}', 'fp', 'active', ?)`,
      )
      .run(graphRunId, NOW).lastInsertRowid,
  );
  const processRunId = Number(
    store.db
      .prepare(
        `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, status, started_at)
         VALUES (?, 'impl', 'graph-node', 0, 'running', ?)`,
      )
      .run(ticketId, NOW).lastInsertRowid,
  );
  const nodeRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, provider,
            process_run_id, started_at)
         VALUES (?, ?, 'impl', 'agent', 1, 'running', 'opencode2', ?, ?)`,
      )
      .run(graphRunId, revisionId, processRunId, new Date(Date.parse(NOW) - 10 * MINUTE).toISOString())
      .lastInsertRowid,
  );

  const session: SupervisedAgentSession = {
    nodeRunId,
    ticketId,
    graphRunId,
    pid: 1234,
    cwd: '/tmp/w',
    generation: 'g',
    ownerNonce: 'nonce',
    startedAt: NOW,
    processRunId,
    provider: 'opencode2',
    providerSessionId: null,
    runKind: 'node',
    ...input.sessionPatch,
  };
  const terminated: SupervisedAgentSession[] = [];
  const errors: unknown[] = [];
  const messages: string[] = [];
  const debugs: string[] = [];
  const decoys = input.decoys?.(graphRunId, nodeRunId) ?? [];
  const transport = {
    sessions: () => (input.withSession === false ? decoys : [...decoys, session]),
    terminate: async (s: SupervisedAgentSession) => {
      if (input.terminateThrows) throw new Error('transport gone');
      terminated.push(s);
      return input.proof ?? { kind: 'attributable', kill: 'killed' };
    },
  };
  const deps: Parameters<typeof createGraphFirstActivityBinding>[0] = {
    db: () => store.db,
    transaction: <T>(fn: () => T): T => store.db.transaction(fn)(),
    now: () => NOW,
    awakeElapsedMs: (sinceMs, nowMs) => nowMs - sinceMs,
    transport: () => (input.withTransport === false ? undefined : transport),
    debug: (message) => debugs.push(message),
    logError: (message, error) => {
      messages.push(message);
      errors.push(error);
    },
  };
  return { graphRunId, nodeRunId, deps, terminated, errors, messages, debugs };
}

function nodeStatus(id: number): string {
  return (
    store.db.prepare('SELECT status FROM approach_node_runs WHERE id = ?').get(id) as {
      status: string;
    }
  ).status;
}

beforeEach(() => {
  store = openStore(':memory:');
  const projectId = upsertProject(store, { slug: 'p' }).id;
  ticketId = createTicket(store, { key: 'GP-1', title: 'thing', projectId }).id;
});
afterEach(() => store.close());

describe('createGraphFirstActivityBinding', () => {
  it('terminates the matching node session and parks the node', async () => {
    const h = fixture();
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(h.terminated).toHaveLength(1);
    expect(nodeStatus(h.nodeRunId)).toBe('blocked');
    expect(h.errors).toEqual([]);
  });

  it('leaves the row running when the transport is absent', async () => {
    const h = fixture({ withTransport: false });
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(nodeStatus(h.nodeRunId)).toBe('running');
    // No session lookup is tried: the refusal is "no session", not a thrown lookup.
    expect(h.debugs).toEqual([
      `[graph] first-activity watchdog: no session found in this window for node run ${h.nodeRunId}, row left running`,
    ]);
  });

  it('returns undefined and touches nothing when the store is absent', async () => {
    const h = fixture();
    const result = await createGraphFirstActivityBinding({ ...h.deps, db: () => undefined }).run(
      h.graphRunId,
    );
    expect(result).toBeUndefined();
    expect(h.terminated).toHaveLength(0);
    expect(h.errors).toEqual([]);
    expect(nodeStatus(h.nodeRunId)).toBe('running');
  });

  it('terminates only the session of the same graph run, node run and node kind', async () => {
    const h = fixture({
      decoys: (graphRunId, nodeRunId) => {
        const base: SupervisedAgentSession = {
          nodeRunId,
          ticketId,
          graphRunId,
          pid: 1,
          cwd: '/tmp/d',
          generation: 'g',
          ownerNonce: 'decoy',
          startedAt: NOW,
          processRunId: 0,
          provider: 'opencode2',
          providerSessionId: null,
          runKind: 'node',
        };
        return [
          { ...base, ownerNonce: 'other-graph', graphRunId: graphRunId + 1 },
          { ...base, ownerNonce: 'other-node', nodeRunId: nodeRunId + 1 },
          { ...base, ownerNonce: 'planner', runKind: 'planner' },
        ];
      },
    });
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(h.terminated.map((s) => s.ownerNonce)).toEqual(['nonce']);
    expect(nodeStatus(h.nodeRunId)).toBe('blocked');
  });

  it('treats a re-attached session with no run kind as a node session', async () => {
    const h = fixture({ sessionPatch: { runKind: undefined } });
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(h.terminated).toHaveLength(1);
    expect(nodeStatus(h.nodeRunId)).toBe('blocked');
  });

  it('does not terminate a planner session with the same ids', async () => {
    const h = fixture({ sessionPatch: { runKind: 'planner' } });
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(h.terminated).toHaveLength(0);
    expect(nodeStatus(h.nodeRunId)).toBe('running');
  });

  it('leaves the row running when no matching session exists', async () => {
    const h = fixture({ withSession: false });
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(h.terminated).toHaveLength(0);
    expect(nodeStatus(h.nodeRunId)).toBe('running');
  });

  it('leaves the row running when the kill is denied', async () => {
    const h = fixture({ proof: { kind: 'attributable', kill: 'denied' } });
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(nodeStatus(h.nodeRunId)).toBe('running');
  });

  it('leaves the row running when the transport terminate throws', async () => {
    const h = fixture({ terminateThrows: true });
    await createGraphFirstActivityBinding(h.deps).run(h.graphRunId);
    expect(nodeStatus(h.nodeRunId)).toBe('running');
    expect(h.errors).toHaveLength(0);
  });

  it('logs and swallows an unexpected watchdog failure', async () => {
    const h = fixture();
    const binding = createGraphFirstActivityBinding({
      ...h.deps,
      db: () => ({ prepare: () => { throw new Error('db gone'); } }) as unknown as GraphDb,
    });
    await expect(binding.run(h.graphRunId)).resolves.toBeUndefined();
    expect(h.errors).toHaveLength(1);
    expect(h.messages).toEqual([
      `karst: graph first-activity watchdog failed for run ${h.graphRunId}`,
    ]);
  });
});
