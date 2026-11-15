import { AUTO_RECOVERY_LIMIT } from '../../approaches/graph/coordinator/autoRecovery.js';
import { GRAPH_FAILED_BLOCKER } from '../../approaches/graph/coordinator/recovery.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { createTicket } from '../../store/tickets.js';
import { upsertProject } from '../../store/projects.js';
import { createGraphRun, graphRunAutoRecovery, markGraphRunBlocked } from '../../store/graph/graphRuns.js';
import type { RecoveryResult } from '../../approaches/graph/coordinator/recovery.js';
import { makeAutoRecoverySweep } from './graphAutoRecoverySweep.js';
import type { GraphRecoverySeams } from './graphRecoveryDispatch.js';

const NOW = '2026-11-15T00:00:00.000Z';
const RETRIED: RecoveryResult = { kind: 'retried', retried: [1], resnapshotted: [] };

function blockedRun(reason: string): { store: Store; projectId: number; runId: number } {
  const store = openStore(':memory:');
  const projectId = upsertProject(store, { slug: 'p' }).id;
  const ticketId = createTicket(store, { key: 'SW-1', title: 't', projectId }).id;
  store.db.prepare("UPDATE tickets SET stage_current = 'impl' WHERE id = ?").run(ticketId);
  const runId = createGraphRun(store.db, { ticketId, stageAttempt: 0, approachId: 'x', now: NOW });
  store.db.prepare("UPDATE approach_graph_runs SET status = 'blocked' WHERE id = ?").run(runId);
  markGraphRunBlocked(store.db, runId, reason, NOW);
  return { store, projectId, runId };
}

function seams(result: RecoveryResult): GraphRecoverySeams {
  return {
    recover: vi.fn(() => result),
    launchReplan: vi.fn(),
    launchBootstrap: vi.fn(),
    onRecovered: vi.fn(),
  };
}

const host = () => ({ debug: vi.fn(), logError: vi.fn() });

describe('makeAutoRecoverySweep', () => {
  it('recovers a blocked run through the shared dispatch and posts one bulletin note', async () => {
    const { store, projectId, runId } = blockedRun('node-blocked: n1');
    const s = seams(RETRIED);
    await makeAutoRecoverySweep(s, host())(store, projectId);
    expect(s.recover).toHaveBeenCalledTimes(1);
    expect(s.onRecovered).toHaveBeenCalledTimes(1);
    expect(graphRunAutoRecovery(store.db, runId).count).toBe(1);
    const stamp = store.db.prepare('SELECT updated_at AS t FROM approach_graph_runs WHERE id = ?').get(runId) as {
      t: string;
    };
    expect(stamp.t).not.toBe(NOW);
    expect(new Date(stamp.t).toISOString()).toBe(stamp.t);
    const notes = store.db.prepare('SELECT source, project_id FROM bulletin_notes').all();
    expect(notes).toEqual([{ source: 'agent', project_id: projectId }]);
  });

  it('leaves a run of another project alone', async () => {
    const { store, projectId } = blockedRun('node-blocked: n1');
    const s = seams(RETRIED);
    await makeAutoRecoverySweep(s, host())(store, projectId + 1);
    expect(s.recover).not.toHaveBeenCalled();
  });

  it('does not recover a manual reason', async () => {
    const { store, projectId } = blockedRun('output-artifact-missing: x');
    const s = seams(RETRIED);
    await makeAutoRecoverySweep(s, host())(store, projectId);
    expect(s.recover).not.toHaveBeenCalled();
  });

  it('logs a store failure and does not throw', async () => {
    const broken = {
      db: {
        prepare: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Store;
    const h = host();
    await expect(makeAutoRecoverySweep(seams(RETRIED), h)(broken, 1)).resolves.toBeUndefined();
    expect(h.logError).toHaveBeenCalledWith('karst: graph automatic recovery failed', expect.any(Error));
  });

  it('keeps the refusal memory between sweeps: a refused block is not tried again', async () => {
    const { store, projectId } = blockedRun('node-blocked: n1');
    const s = seams({ kind: 'refused', reason: 'launch-loop' } as RecoveryResult);
    const sweep = makeAutoRecoverySweep(s, host());
    await sweep(store, projectId);
    await sweep(store, projectId);
    expect(s.recover).toHaveBeenCalledTimes(1);
  });

  it('adds the stop note to the impl stage block once, so the Inside banner shows it', async () => {
    const { store, projectId, runId } = blockedRun('node-blocked: n1');
    const ticketId = (store.db.prepare('SELECT ticket_id AS t FROM approach_graph_runs WHERE id = ?').get(runId) as { t: number }).t;
    parkGateStage(store, {
      ticketId,
      stageKey: 'impl',
      kind: GRAPH_FAILED_BLOCKER,
      reason: `${GRAPH_FAILED_BLOCKER}: node-blocked: n1`,
      runAt: NOW,
      gates: [],
    });
    store.db.prepare('UPDATE approach_graph_runs SET auto_recovery_count = ? WHERE id = ?').run(AUTO_RECOVERY_LIMIT, runId);
    const s = seams(RETRIED);
    const sweep = makeAutoRecoverySweep(s, host());
    await sweep(store, projectId);
    await sweep(store, projectId);
    expect(s.recover).not.toHaveBeenCalled();
    const reason = stageBlock(store, ticketId, 'impl')?.reason ?? '';
    expect(reason).toContain('node-blocked: n1');
    expect(reason.match(/automatic recovery stopped after 3 attempts/g)).toHaveLength(1);
  });

  it('leaves a stage block of another kind alone', async () => {
    const { store, projectId, runId } = blockedRun('node-blocked: n1');
    const owner = (store.db.prepare('SELECT ticket_id AS t FROM approach_graph_runs WHERE id = ?').get(runId) as { t: number }).t;
    parkGateStage(store, { ticketId: owner, stageKey: 'impl', kind: 'nothing-to-run', reason: 'other', runAt: NOW, gates: [] });
    store.db.prepare('UPDATE approach_graph_runs SET auto_recovery_count = ? WHERE id = ?').run(AUTO_RECOVERY_LIMIT, runId);
    await makeAutoRecoverySweep(seams(RETRIED), host())(store, projectId);
    const ticketId = (store.db.prepare('SELECT ticket_id AS t FROM approach_graph_runs WHERE id = ?').get(runId) as { t: number }).t;
    expect(stageBlock(store, ticketId, 'impl')?.reason).toBe('other');
  });
});
