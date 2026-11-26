/**
 * T1380: parking a graph node/planner that hit its provider usage limit.
 *
 * ONE transaction CAS-parks the run and the role row, records the failure,
 * blocks the graph run with a `usage-limit:` reason and releases the process
 * slot; only then is the session terminated through the injected transport
 * (attributable kill, never a raw pid). A second signal is a no-op — another
 * window already won the park.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../../store/db.js';
import { createTicket } from '../../../store/tickets.js';
import { upsertProject } from '../../../store/projects.js';
import { LAUNCH_FAILURE_LINE_MAX } from '../driver.js';
import type { TerminationProof } from '../transport/agentTransport.js';
import { parkGraphUsageLimit, type GraphUsageLimitParkDeps } from './usageLimitPark.js';

const NOW = '2026-11-26T10:00:00.000Z';

let store: Store;
let ticketId: number;
let projectId: number;

beforeEach(() => {
  store = openStore(':memory:');
  projectId = upsertProject(store, { slug: 'p' }).id;
  ticketId = createTicket(store, { key: 'GP-1', title: 'thing', projectId }).id;
  store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
  store.db
    .prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'")
    .run(ticketId);
});
afterEach(() => store.close());

interface NodeFixture {
  graphRunId: number;
  revisionId: number;
  nodeRunId: number;
}

function nodeFixture(status = 'running'): NodeFixture {
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, active_processes, created_at)
         VALUES (?, 'impl', 0, 'x', ?, 1, ?)`,
      )
      .run(ticketId, status, NOW).lastInsertRowid,
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
  const nodeRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status)
         VALUES (?, ?, 'n', 'agent', 1, 'running')`,
      )
      .run(graphRunId, revisionId).lastInsertRowid,
  );
  return { graphRunId, revisionId, nodeRunId };
}

/** A second running node of the same revision (parallel nodes). */
function addNodeRun(graphRunId: number, revisionId: number, nodeId: string): number {
  return Number(
    store.db
      .prepare(
        `INSERT INTO approach_node_runs
           (graph_run_id, revision_id, node_id, node_kind, visit_number, status, profile, provider, model)
         VALUES (?, ?, ?, 'agent', 1, 'running', 'worker', 'claude', 'm')`,
      )
      .run(graphRunId, revisionId, nodeId).lastInsertRowid,
  );
}

function plannerFixture(
  kind: 'bootstrap' | 'replan',
  graphStatus: 'planning' | 'draining',
  plannerStatus = 'running',
  attempt = 0,
): {
  graphRunId: number;
  plannerRunId: number;
} {
  const graphRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs
           (ticket_id, stage_key, stage_attempt, approach_id, status, active_processes, created_at)
         VALUES (?, 'impl', ?, 'x', ?, 1, ?)`,
      )
      .run(ticketId, attempt, graphStatus, NOW).lastInsertRowid,
  );
  store.db
    .prepare(
      `INSERT INTO approach_graph_revisions
         (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
       VALUES (?, 1, '{}', 'fp', ?, ?)`,
    )
    .run(graphRunId, graphStatus === 'draining' ? 'draining' : 'active', NOW);
  const plannerRunId = Number(
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (graph_run_id, planner_run_number, kind, status)
         VALUES (?, 1, ?, ?)`,
      )
      .run(graphRunId, kind, plannerStatus).lastInsertRowid,
  );
  return { graphRunId, plannerRunId };
}

function nodeRow(id: number): {
  status: string;
  failure_category: string | null;
  reason: string | null;
  ended_at: string | null;
} {
  return store.db
    .prepare('SELECT status, failure_category, reason, ended_at FROM approach_node_runs WHERE id = ?')
    .get(id) as ReturnType<typeof nodeRow>;
}

function plannerRow(id: number): { status: string; reason: string | null; ended_at: string | null } {
  return store.db
    .prepare('SELECT status, reason, ended_at FROM approach_planner_runs WHERE id = ?')
    .get(id) as ReturnType<typeof plannerRow>;
}

function runRow(id: number): { status: string; blocked_reason: string | null; active_processes: number } {
  return store.db
    .prepare('SELECT status, blocked_reason, active_processes FROM approach_graph_runs WHERE id = ?')
    .get(id) as ReturnType<typeof runRow>;
}

function makeDeps(
  overrides: Partial<GraphUsageLimitParkDeps> = {},
): GraphUsageLimitParkDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    store,
    transaction: <T>(fn: () => T): T =>
      (store.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
        begin: 'immediate',
      })(),
    now: () => NOW,
    debug: (m) => lines.push(m),
    lines,
    ...overrides,
  };
}

describe('parkGraphUsageLimit — node', () => {
  it('parks a running node, blocks the run, releases the slot and terminates once', async () => {
    const { graphRunId, nodeRunId } = nodeFixture();
    const terminate = vi.fn(async (): Promise<TerminationProof> => ({ kind: 'dead' }));
    const deps = makeDeps({ terminateSession: terminate });

    const result = await parkGraphUsageLimit(deps, {
      graphRunId,
      role: 'node',
      runId: nodeRunId,
      provider: 'claude',
      model: 'claude-opus-5-5',
      text: "You've hit your 5-hour limit · resets 4:10am",
    });

    const reason = `usage-limit: node run ${nodeRunId} on claude/claude-opus-5-5: You've hit your 5-hour limit · resets 4:10am`;
    expect(result).toMatchObject({ parked: true, ticketId, reason });
    expect(nodeRow(nodeRunId)).toMatchObject({
      status: 'blocked',
      failure_category: 'usage-limit',
      reason: "You've hit your 5-hour limit · resets 4:10am",
      ended_at: NOW,
    });
    expect(runRow(graphRunId)).toEqual({ status: 'blocked', blocked_reason: reason, active_processes: 0 });
    expect(terminate).toHaveBeenCalledTimes(1);
    // One graph diagnostic and one Karst event, both naming the park.
    expect(deps.lines.join('\n')).toContain('[graph:block]');
    expect(deps.lines.join('\n')).toContain('usage-limit: node run');
    const event = store.db
      .prepare('SELECT level, source, title, body FROM karst_events WHERE ticket_id = ?')
      .get(ticketId) as { level: string; source: string; title: string; body: string } | undefined;
    expect(event).toBeDefined();
    expect(event?.level).toBe('warn');
    expect(event?.source).toBe('host');
    expect(event?.body).toBe(reason);
  });

  it('sanitizes the text to one line and caps it at the launch-failure line length', async () => {
    const { graphRunId, nodeRunId } = nodeFixture();
    const text = `hit your limit\nwith a newline${'x'.repeat(LAUNCH_FAILURE_LINE_MAX * 2)}`;
    await parkGraphUsageLimit(makeDeps({ terminateSession: async () => ({ kind: 'dead' }) }), {
      graphRunId,
      role: 'node',
      runId: nodeRunId,
      provider: 'claude',
      model: null,
      text,
    });
    const row = nodeRow(nodeRunId);
    expect(row.reason).not.toContain('\n');
    expect(row.reason!.length).toBe(LAUNCH_FAILURE_LINE_MAX);
    expect(runRow(graphRunId).blocked_reason).toContain('on claude/default: ');
  });

  it('is a no-op on the second call (another signal already parked it)', async () => {
    const { graphRunId, nodeRunId } = nodeFixture();
    const terminate = vi.fn(async (): Promise<TerminationProof> => ({ kind: 'dead' }));
    const deps = makeDeps({ terminateSession: terminate });
    const input = {
      graphRunId,
      role: 'node' as const,
      runId: nodeRunId,
      provider: 'claude',
      model: 'm',
      text: 'limit',
    };
    expect((await parkGraphUsageLimit(deps, input)).parked).toBe(true);
    expect(await parkGraphUsageLimit(deps, input)).toEqual({ parked: false });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the graph run is already blocked', async () => {
    const { graphRunId, nodeRunId } = nodeFixture('blocked');
    const terminate = vi.fn(async (): Promise<TerminationProof> => ({ kind: 'dead' }));
    expect(
      await parkGraphUsageLimit(makeDeps({ terminateSession: terminate }), {
        graphRunId,
        role: 'node',
        runId: nodeRunId,
        provider: 'claude',
        model: 'm',
        text: 'limit',
      }),
    ).toEqual({ parked: false });
    expect(terminate).not.toHaveBeenCalled();
    expect(nodeRow(nodeRunId).status).toBe('running');
  });

  it('parks a parallel node when the run is already blocked by the same usage-limit stop', async () => {
    const { graphRunId, revisionId, nodeRunId } = nodeFixture();
    store.db.prepare('UPDATE approach_graph_runs SET active_processes = 2 WHERE id = ?').run(graphRunId);
    const secondId = addNodeRun(graphRunId, revisionId, 'n2');
    const terminate = vi.fn(async (): Promise<TerminationProof> => ({ kind: 'dead' }));
    const deps = makeDeps({ terminateSession: terminate });
    const base = { graphRunId, role: 'node' as const, provider: 'claude', model: 'm' };

    const first = await parkGraphUsageLimit(deps, { ...base, runId: nodeRunId, text: 'limit one' });
    const second = await parkGraphUsageLimit(deps, { ...base, runId: secondId, text: 'limit two' });

    expect(first).toMatchObject({ parked: true, prompt: true });
    expect(second).toMatchObject({ parked: true, prompt: false });
    expect(nodeRow(secondId)).toMatchObject({
      status: 'blocked',
      failure_category: 'usage-limit',
      reason: 'limit two',
    });
    // The run keeps the FIRST node's reason: one park, one prompt.
    expect(runRow(graphRunId).blocked_reason).toContain(`node run ${nodeRunId}`);
    expect(runRow(graphRunId).active_processes).toBe(0);
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it('does not park a parallel node when the run was blocked for another reason', async () => {
    const { graphRunId, revisionId, nodeRunId } = nodeFixture();
    store.db.prepare('UPDATE approach_graph_runs SET active_processes = 2 WHERE id = ?').run(graphRunId);
    const secondId = addNodeRun(graphRunId, revisionId, 'n2');
    store.db
      .prepare("UPDATE approach_graph_runs SET status = 'blocked', blocked_reason = 'node-blocked: node 1' WHERE id = ?")
      .run(graphRunId);
    const result = await parkGraphUsageLimit(makeDeps(), {
      graphRunId,
      role: 'node',
      runId: secondId,
      provider: 'claude',
      model: 'm',
      text: 'limit',
    });
    expect(result).toEqual({ parked: false });
    expect(nodeRow(secondId).status).toBe('running');
    expect(nodeRow(nodeRunId).status).toBe('running');
  });

  it('leaves the rows as written and logs one line when the attributable kill is denied', async () => {
    const { graphRunId, nodeRunId } = nodeFixture();
    const deps = makeDeps({
      terminateSession: async () => ({ kind: 'attributable', kill: 'denied' }),
    });
    const result = await parkGraphUsageLimit(deps, {
      graphRunId,
      role: 'node',
      runId: nodeRunId,
      provider: 'claude',
      model: 'm',
      text: 'limit',
    });
    expect(result.parked).toBe(true);
    expect(runRow(graphRunId).status).toBe('blocked');
    expect(nodeRow(nodeRunId).status).toBe('blocked');
    expect(deps.lines.filter((l) => l.includes('denied'))).toHaveLength(1);
  });

  it('never throws past a committed park when termination fails', async () => {
    const { graphRunId, nodeRunId } = nodeFixture();
    const deps = makeDeps({
      terminateSession: async () => {
        throw new Error('transport gone');
      },
    });
    await expect(
      parkGraphUsageLimit(deps, {
        graphRunId,
        role: 'node',
        runId: nodeRunId,
        provider: 'claude',
        model: 'm',
        text: 'limit',
      }),
    ).resolves.toMatchObject({ parked: true });
    expect(runRow(graphRunId).status).toBe('blocked');
  });
});

describe('parkGraphUsageLimit — planner', () => {
  it('parks a running bootstrap planner (planning → blocked, planner → stale)', async () => {
    const { graphRunId, plannerRunId } = plannerFixture('bootstrap', 'planning');
    const terminate = vi.fn(async (): Promise<TerminationProof> => ({ kind: 'dead' }));
    const result = await parkGraphUsageLimit(makeDeps({ terminateSession: terminate }), {
      graphRunId,
      role: 'planner',
      runId: plannerRunId,
      provider: 'claude',
      model: 'claude-opus-5-5',
      text: 'limit',
    });
    expect(result.parked).toBe(true);
    expect(plannerRow(plannerRunId)).toMatchObject({ status: 'stale', ended_at: NOW });
    expect(runRow(graphRunId)).toMatchObject({
      status: 'blocked',
      active_processes: 0,
    });
    expect(runRow(graphRunId).blocked_reason).toMatch(/^usage-limit: planner run \d+ on claude\/claude-opus-5-5: /);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('parks a running replan planner (draining → blocked, planner → stale)', async () => {
    const { graphRunId, plannerRunId } = plannerFixture('replan', 'draining');
    const result = await parkGraphUsageLimit(makeDeps(), {
      graphRunId,
      role: 'planner',
      runId: plannerRunId,
      provider: 'opencode2',
      model: 'big-pickle',
      text: 'limit',
    });
    expect(result.parked).toBe(true);
    expect(plannerRow(plannerRunId).status).toBe('stale');
    expect(runRow(graphRunId).status).toBe('blocked');
  });

  it('is a no-op for a planner run that is not running', async () => {
    const { graphRunId, plannerRunId } = plannerFixture('bootstrap', 'planning', 'blocked');
    expect(
      await parkGraphUsageLimit(makeDeps(), {
        graphRunId,
        role: 'planner',
        runId: plannerRunId,
        provider: 'claude',
        model: 'm',
        text: 'limit',
      }),
    ).toEqual({ parked: false });
    expect(plannerRow(plannerRunId).status).toBe('blocked');
    expect(runRow(graphRunId).status).toBe('planning');
  });

  it('is a no-op for a planner run that belongs to another graph run', async () => {
    const { plannerRunId } = plannerFixture('bootstrap', 'planning');
    const other = plannerFixture('bootstrap', 'planning', 'running', 1);
    expect(
      await parkGraphUsageLimit(makeDeps(), {
        graphRunId: other.graphRunId,
        role: 'planner',
        runId: plannerRunId,
        provider: 'claude',
        model: 'm',
        text: 'limit',
      }),
    ).toEqual({ parked: false });
  });
});

describe('parkGraphUsageLimit — lock contention', () => {
  const inputOf = (fixture: NodeFixture) => ({
    graphRunId: fixture.graphRunId,
    role: 'node' as const,
    runId: fixture.nodeRunId,
    provider: 'claude',
    model: 'm',
    text: 'limit',
  });
  const busy = (): Error => Object.assign(new Error('write lock'), { code: 'SQLITE_BUSY' });

  function immediate<T>(fn: () => T): T {
    return (store.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
      begin: 'immediate',
    })();
  }

  it('retries a lock-contended transaction and parks on the next attempt', async () => {
    const fixture = nodeFixture();
    let attempts = 0;
    const pause = vi.fn(async () => undefined);
    const deps = makeDeps({
      pause,
      transaction: <T>(fn: () => T): T => {
        attempts += 1;
        if (attempts < 3) throw busy();
        return immediate(fn);
      },
    });
    const result = await parkGraphUsageLimit(deps, inputOf(fixture));
    expect(result.parked).toBe(true);
    expect(attempts).toBe(3);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(deps.lines).toContain('[graph] usage-limit park: database busy, retrying in 50ms');
  });

  it('retries on a locked-message error with no code', async () => {
    const fixture = nodeFixture();
    let attempts = 0;
    const deps = makeDeps({
      pause: async () => undefined,
      transaction: <T>(fn: () => T): T => {
        attempts += 1;
        if (attempts === 1) throw new Error('database is busy');
        return immediate(fn);
      },
    });
    expect((await parkGraphUsageLimit(deps, inputOf(fixture))).parked).toBe(true);
    expect(attempts).toBe(2);
  });

  it('gives up after the bounded retries and rethrows the lock error', async () => {
    const fixture = nodeFixture();
    const pause = vi.fn(async () => undefined);
    const lock = busy();
    const deps = makeDeps({
      pause,
      transaction: () => {
        throw lock;
      },
    });
    await expect(parkGraphUsageLimit(deps, inputOf(fixture))).rejects.toBe(lock);
    expect(pause).toHaveBeenCalledTimes(5);
  });

  it('does not retry a transaction that failed for another reason', async () => {
    const fixture = nodeFixture();
    const pause = vi.fn(async () => undefined);
    const deps = makeDeps({
      pause,
      transaction: () => {
        throw new Error('disk full');
      },
    });
    await expect(parkGraphUsageLimit(deps, inputOf(fixture))).rejects.toThrow('disk full');
    expect(pause).not.toHaveBeenCalled();
  });

  it('does not retry a non-Error throw', async () => {
    const fixture = nodeFixture();
    const pause = vi.fn(async () => undefined);
    const deps = makeDeps({
      pause,
      transaction: () => {
        throw 'database is locked';
      },
    });
    await expect(parkGraphUsageLimit(deps, inputOf(fixture))).rejects.toBe('database is locked');
    expect(pause).not.toHaveBeenCalled();
  });
});
