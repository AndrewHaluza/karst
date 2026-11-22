/**
 * The coordinator's automatic recovery of a blocked graph run: which block
 * reasons it recovers by itself, the per-run limit, the CAS race, and a
 * refusal that must not loop.
 */

import { describe, it, expect, vi } from 'vitest';
import { openStore } from '../../../store/db.js';
import { createTicket } from '../../../store/tickets.js';
import { upsertProject } from '../../../store/projects.js';
import {
  createGraphRun,
  graphRunAutoRecovery,
  markGraphRunBlocked,
  clearGraphRunBlocked,
} from '../../../store/graph/graphRuns.js';
import type { RecoveryResult } from './recovery.js';
import {
  AUTO_RECOVERY_LIMIT,
  autoRecoverBlockedRuns,
  createAutoRecoveryMemory,
  isAutoRecoverableReason,
  type AutoRecoveryDeps,
} from './autoRecovery.js';

const NOW = '2026-11-15T00:00:00.000Z';

function fixture(reason: string) {
  const store = openStore(':memory:');
  const project = upsertProject(store, { slug: 'p' });
  const ticketId = createTicket(store, { key: 'AR-3', title: 't', projectId: project.id }).id;
  store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
  const graphRunId = createGraphRun(store.db, { ticketId, stageAttempt: 0, approachId: 'x', now: NOW });
  store.db.prepare("UPDATE approach_graph_runs SET status = 'blocked' WHERE id = ?").run(graphRunId);
  markGraphRunBlocked(store.db, graphRunId, reason, NOW);
  return { store, projectId: project.id, ticketId, graphRunId };
}

function depsFor(
  f: ReturnType<typeof fixture>,
  recover: AutoRecoveryDeps['recover'],
): AutoRecoveryDeps & { notes: Array<{ ticketId: number; title: string; body: string }>; lines: string[] } {
  const notes: Array<{ ticketId: number; title: string; body: string }> = [];
  const lines: string[] = [];
  return {
    db: f.store.db,
    now: () => NOW,
    debug: (m) => lines.push(m),
    recover,
    postNote: (n) => notes.push(n),
    notes,
    lines,
  };
}

const retried: RecoveryResult = { kind: 'retried' } as RecoveryResult;
const replanned = { kind: 'replanned', launch: {} } as unknown as RecoveryResult;
const relaunched = { kind: 'relaunched', launch: {} } as unknown as RecoveryResult;
const restored = { kind: 'run-restored' } as RecoveryResult;

async function sweep(f: ReturnType<typeof fixture>, deps: AutoRecoveryDeps, memory = createAutoRecoveryMemory()) {
  return autoRecoverBlockedRuns(deps, memory, [{ graphRunId: f.graphRunId, ticketId: f.ticketId }]);
}

describe('which reasons recover by themselves', () => {
  it.each([
    'node-blocked: n1 process gone',
    'failed-to-launch: n1',
    'planner-stale: planner 2',
    'graph-plan-invalid: bad edge',
    'planner-artifact-missing: x',
    'instructions-missing: n2',
    'graph-deferral-timeout: n3',
    'command-definition-changed: n4',
    'resource-claim-violated: b.ts',
  ])('%s is automatic', (reason) => {
    expect(isAutoRecoverableReason(reason)).toBe(true);
  });

  it.each([
    'launch-unknown: n1',
    'node-blocked: x termination-unknown',
    'output-artifact-missing: a',
    'artifact-unsafe: a',
    'integration-conflict: a.ts',
    'graph-topology-deadlock: x',
    'graph-budget-exhausted: maxNodeRuns',
    'prompt-config-changed: n1',
    'something new',
    '',
  ])('%s stays manual', (reason) => {
    expect(isAutoRecoverableReason(reason)).toBe(false);
  });

  it('treats a missing reason as manual', () => {
    expect(isAutoRecoverableReason(null)).toBe(false);
  });
});

describe('autoRecoverBlockedRuns', () => {
  it.each([
    ['node-blocked: n1', retried],
    ['failed-to-launch: n1', retried],
    ['planner-stale: p', relaunched],
    ['graph-plan-invalid: x', replanned],
    ['resource-claim-violated: b.ts', replanned],
    ['command-definition-changed: n', replanned],
    ['node-blocked: n1', restored],
  ])('recovers %s once with mode resume and counts it', async (reason, result) => {
    const f = fixture(reason);
    const recover = vi.fn(async () => result);
    const deps = depsFor(f, recover);
    await sweep(f, deps);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith({ ticketId: f.ticketId, graphRunId: f.graphRunId, mode: 'resume' });
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId)).toEqual({ count: 1, reasons: [reason] });
    expect(deps.notes).toHaveLength(1);
    expect(deps.notes[0]?.ticketId).toBe(f.ticketId);
    expect(deps.notes[0]?.body).toContain(reason);
    expect(deps.lines.some((l) => l.includes('automatic recovery'))).toBe(true);
  });

  it.each([
    'launch-unknown: n1',
    'output-artifact-missing: a',
    'integration-conflict: a.ts',
    'graph-topology-deadlock: x',
    'graph-budget-exhausted: maxNodeRuns',
    'weird unknown reason',
  ])('never calls recovery for the manual reason %s', async (reason) => {
    const f = fixture(reason);
    const recover = vi.fn(async () => retried);
    await sweep(f, depsFor(f, recover));
    expect(recover).not.toHaveBeenCalled();
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(0);
  });

  it('parks the run after the limit with the stop note and the recovered reasons', async () => {
    const f = fixture('node-blocked: n1');
    const recover = vi.fn(async () => retried);
    const deps = depsFor(f, recover);
    const memory = createAutoRecoveryMemory();
    for (let i = 0; i < AUTO_RECOVERY_LIMIT; i += 1) {
      markGraphRunBlocked(f.store.db, f.graphRunId, i === 1 ? 'graph-plan-invalid: x' : 'node-blocked: n1', NOW);
      await sweep(f, deps, memory);
    }
    expect(recover).toHaveBeenCalledTimes(AUTO_RECOVERY_LIMIT);
    markGraphRunBlocked(f.store.db, f.graphRunId, 'node-blocked: n1', NOW);
    await sweep(f, deps, memory);
    await sweep(f, deps, memory);
    expect(recover).toHaveBeenCalledTimes(AUTO_RECOVERY_LIMIT);
    const row = f.store.db
      .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
      .get(f.graphRunId) as { status: string; blocked_reason: string };
    expect(row.status).toBe('blocked');
    expect(row.blocked_reason.startsWith('node-blocked: n1')).toBe(true);
    expect(row.blocked_reason).toContain('automatic recovery stopped after 3 attempts');
    expect(row.blocked_reason).toContain('node-blocked');
    expect(row.blocked_reason).toContain('graph-plan-invalid');
    expect(row.blocked_reason.match(/automatic recovery stopped/g)).toHaveLength(1);
    expect(deps.notes.filter((n) => n.title.includes('stopped'))).toHaveLength(1);
  });

  it('tells the onStopped seam once when the limit note is written', async () => {
    const f = fixture('node-blocked: n1');
    const onStopped = vi.fn();
    const deps = { ...depsFor(f, async () => retried), onStopped };
    const memory = createAutoRecoveryMemory();
    for (let i = 0; i < AUTO_RECOVERY_LIMIT; i += 1) {
      markGraphRunBlocked(f.store.db, f.graphRunId, 'node-blocked: n1', NOW);
      await sweep(f, deps, memory);
    }
    markGraphRunBlocked(f.store.db, f.graphRunId, 'node-blocked: n1', NOW);
    await sweep(f, deps, memory);
    await sweep(f, deps, memory);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith(
      { ticketId: f.ticketId, graphRunId: f.graphRunId },
      expect.stringContaining('automatic recovery stopped after 3 attempts'),
    );
  });

  it('does not count a human recovery and does not reset the count', async () => {
    const f = fixture('node-blocked: n1');
    const deps = depsFor(f, async () => retried);
    await sweep(f, deps);
    clearGraphRunBlocked(f.store.db, f.graphRunId, NOW);
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(1);
  });

  it('counts only one recovery when two sweeps race (the second gets no-op)', async () => {
    const f = fixture('node-blocked: n1');
    let claimed = false;
    const recover = vi.fn(async (): Promise<RecoveryResult> => {
      if (claimed) return { kind: 'no-op' };
      claimed = true;
      return retried;
    });
    const memory = createAutoRecoveryMemory();
    const a = depsFor(f, recover);
    const b = depsFor(f, recover);
    await Promise.all([sweep(f, a, memory), sweep(f, b, createAutoRecoveryMemory())]);
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(1);
    expect(a.notes.length + b.notes.length).toBe(1);
  });

  it('does not loop on a refused result for the same block', async () => {
    const f = fixture('node-blocked: n1');
    const recover = vi.fn(async (): Promise<RecoveryResult> => ({ kind: 'refused', reason: 'launch-loop' }));
    const deps = depsFor(f, recover);
    const memory = createAutoRecoveryMemory();
    await sweep(f, deps, memory);
    await sweep(f, deps, memory);
    await sweep(f, deps, memory);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(0);
    expect(deps.notes).toHaveLength(0);
  });

  it('does not retry an unchanged resource-claim-violated block refused for a spent budget', async () => {
    // The replan budget refusal changes no row, so the block reason stays the
    // claim violation; the in-memory refusal memory stops a retry loop.
    const f = fixture('resource-claim-violated: b.ts (declared writes: a/**)');
    const recover = vi.fn(async (): Promise<RecoveryResult> => ({ kind: 'refused', reason: 'config-then-resume' }));
    const deps = depsFor(f, recover);
    const memory = createAutoRecoveryMemory();
    await sweep(f, deps, memory);
    await sweep(f, deps, memory);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(deps.lines.filter((l) => l.includes('automatic recovery refused (config-then-resume)'))).toHaveLength(1);
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(0);
  });

  it('runs a refused resource-claim-violated block once more with a new memory (a window reload)', async () => {
    const f = fixture('resource-claim-violated: b.ts (declared writes: a/**)');
    const recover = vi.fn(async (): Promise<RecoveryResult> => ({ kind: 'refused', reason: 'config-then-resume' }));
    const deps = depsFor(f, recover);
    await sweep(f, deps, createAutoRecoveryMemory());
    await sweep(f, deps, createAutoRecoveryMemory());
    expect(recover).toHaveBeenCalledTimes(2);
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(0);
  });

  it('tries again after the run was unblocked and blocked with the same reason', async () => {
    const f = fixture('node-blocked: n1');
    const recover = vi.fn(async (): Promise<RecoveryResult> => ({ kind: 'refused', reason: 'launch-loop' }));
    const deps = depsFor(f, recover);
    const memory = createAutoRecoveryMemory();
    await sweep(f, deps, memory);
    // The run leaves the blocked set (a human resumed it), the sweep sees an empty list.
    await autoRecoverBlockedRuns(deps, memory, []);
    await sweep(f, deps, memory);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('tries again when the block reason changes after a refusal', async () => {
    const f = fixture('node-blocked: n1');
    const recover = vi.fn(async (): Promise<RecoveryResult> => ({ kind: 'refused', reason: 'launch-loop' }));
    const deps = depsFor(f, recover);
    const memory = createAutoRecoveryMemory();
    await sweep(f, deps, memory);
    markGraphRunBlocked(f.store.db, f.graphRunId, 'failed-to-launch: n2', NOW);
    await sweep(f, deps, memory);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it('does not count a no-op', async () => {
    const f = fixture('node-blocked: n1');
    const deps = depsFor(f, async () => ({ kind: 'no-op' }));
    await sweep(f, deps);
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(0);
    expect(deps.notes).toHaveLength(0);
  });

  it('skips a listed run that is no longer blocked', async () => {
    const f = fixture('node-blocked: n1');
    f.store.db.prepare("UPDATE approach_graph_runs SET status = 'running' WHERE id = ?").run(f.graphRunId);
    const recover = vi.fn(async () => retried);
    await sweep(f, depsFor(f, recover));
    expect(recover).not.toHaveBeenCalled();
  });

  it('keeps going when recovery throws for one run, and reports it', async () => {
    const f = fixture('node-blocked: n1');
    const deps = depsFor(f, async () => {
      throw new Error('boom');
    });
    await expect(sweep(f, deps)).resolves.toBeUndefined();
    expect(graphRunAutoRecovery(f.store.db, f.graphRunId).count).toBe(0);
    expect(deps.lines.some((l) => l.includes('boom'))).toBe(true);
  });
});
