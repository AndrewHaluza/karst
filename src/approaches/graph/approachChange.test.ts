import { describe, it, expect } from 'vitest';
import { graphTicketSurface, shouldDriveGraphTicket } from './entryPoints.js';
import { openStore } from '../../store/db.js';
import { bindApproachChangeCancel, cancelGraphRunOnApproachChange } from './approachChange.js';
import type { CancelGraphRunDeps } from './cancel.js';
import type { ProcessFactsSource } from '../../runtime/serverIdentity.js';

function harness(status: string, approach = 'karst-graph-engineering') {
  const { db } = openStore(':memory:');
  const ticketId = Number(db.prepare("INSERT INTO tickets (key, approach) VALUES ('T-1', ?)").run(approach).lastInsertRowid);
  const graphRunId = Number(
    db
      .prepare(
        `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (?, 'impl', 0, ?, ?, '2026-08-12T00:00:00.000Z')`,
      )
      .run(ticketId, approach, status).lastInsertRowid,
  );
  const deadFacts: ProcessFactsSource = { isAlive: () => false, liveCwd: () => null, processStartMs: () => null };
  const deps: CancelGraphRunDeps = {
    db,
    transaction: <T>(fn: () => T): T =>
      (db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, { begin: 'immediate' })(),
    facts: deadFacts,
    killTree: () => 'killed',
  };
  const runStatus = () => (db.prepare('SELECT status FROM approach_graph_runs WHERE id = ?').get(graphRunId) as { status: string }).status;
  return { db, ticketId, graphRunId, deps, runStatus };
}

describe('cancelGraphRunOnApproachChange', () => {
  it.each(['planning', 'running'])('cancels a %s run when the approach changes', async (status) => {
    const h = harness(status);
    const result = await cancelGraphRunOnApproachChange(h.deps, h.ticketId, 'direct');
    expect(result).toEqual({ ok: true, cancelledGraphRunId: h.graphRunId });
    expect(h.runStatus()).toBe('cancelled');
  });

  it('leaves the ticket off the graph surface so Start takes the direct path', async () => {
    const h = harness('planning');
    await cancelGraphRunOnApproachChange(h.deps, h.ticketId, 'direct');
    h.db.prepare('UPDATE tickets SET approach = ? WHERE id = ?').run('direct', h.ticketId);
    expect(graphTicketSurface(h.db, h.ticketId)).toBe('none');
    expect(shouldDriveGraphTicket(h.db, h.ticketId)).toBe(true);
  });

  it('does nothing when the run already has the new approach', async () => {
    const h = harness('planning');
    const result = await cancelGraphRunOnApproachChange(h.deps, h.ticketId, 'karst-graph-engineering');
    expect(result).toEqual({ ok: true });
    expect(h.runStatus()).toBe('planning');
  });

  it('does nothing when no run is open', async () => {
    const h = harness('cancelled');
    expect(await cancelGraphRunOnApproachChange(h.deps, h.ticketId, 'direct')).toEqual({ ok: true });
  });

  it('refuses and names the pid when a live process is foreign', async () => {
    const h = harness('planning');
    const processRunId = Number(
      h.db
        .prepare(
          `INSERT INTO process_runs (ticket_id, stage_key, process_id, attempt, pid, status, started_at)
           VALUES (?, 'impl', 'graph-planner', 0, 4242, 'running', '2026-08-12T00:00:00.000Z')`,
        )
        .run(h.ticketId).lastInsertRowid,
    );
    h.db
      .prepare(
        `INSERT INTO approach_planner_runs (graph_run_id, planner_run_number, kind, status, process_run_id)
         VALUES (?, 1, 'bootstrap', 'running', ?)`,
      )
      .run(h.graphRunId, processRunId);
    const deps = { ...h.deps, facts: { isAlive: () => true, liveCwd: () => null, processStartMs: () => null } };
    const result = await cancelGraphRunOnApproachChange(deps, h.ticketId, 'direct');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('4242');
    expect(h.runStatus()).toBe('planning');
  });
});

describe('bindApproachChangeCancel', () => {
  it('allows the change when no graph context exists', async () => {
    const cancel = bindApproachChangeCancel(() => undefined, () => {});
    expect(await cancel(1, 'direct')).toEqual({ ok: true });
  });

  it('refreshes once a run was cancelled', async () => {
    const h = harness('planning');
    const seen: number[] = [];
    const cancel = bindApproachChangeCancel(() => h.deps, (id) => seen.push(id));
    expect(await cancel(h.ticketId, 'direct')).toMatchObject({ ok: true });
    expect(seen).toEqual([h.ticketId]);
  });
});
