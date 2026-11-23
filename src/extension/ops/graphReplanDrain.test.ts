/**
 * The replan-drain drive (T1322).
 *
 * A replan election drains the run while a node is still live. The node's
 * completion pipeline now integrates in that drain, so the host drives the
 * completing nodes before it allocates the N+1 planner — and only when this
 * drain has no planner yet. A Stop drain (revision stays `active`) does
 * nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { driveReplanDrain, type ReplanDrainDeps } from './graphReplanDrain.js';

describe('driveReplanDrain', () => {
  let store: Store;
  let graphRunId: number;
  let events: string[];

  beforeEach(() => {
    store = openStore(':memory:');
    events = [];
    const ticketId = Number(
      store.db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid,
    );
    graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
           VALUES (?, 'impl', 0, 'x', 'draining', '2026-11-22T23:44:04.000Z')`,
        )
        .run(ticketId).lastInsertRowid,
    );
  });
  afterEach(() => store.close());

  function revision(status: string, revisionNumber = 1): void {
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions
           (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (?, ?, '{}', ?, ?, '2026-11-22T23:44:04.000Z')`,
      )
      .run(graphRunId, revisionNumber, `fp-${revisionNumber}`, status);
  }

  function planner(kind: 'replan' | 'bootstrap', status: string, target: number | null): void {
    store.db
      .prepare(
        `INSERT INTO approach_planner_runs
           (graph_run_id, target_revision_number, planner_run_number, kind, status)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(graphRunId, target, 1, kind, status);
  }

  function deps(
    overrides: Partial<ReplanDrainDeps> = {},
    duringDrive?: () => void,
  ): ReplanDrainDeps {
    return {
      db: store.db,
      driveCompletingNodes: async () => {
        events.push('drive');
        duringDrive?.();
      },
      relaunchReplanPlanner: async () => {
        events.push('relaunch');
      },
      ...overrides,
    };
  }

  function runStatus(status: string): void {
    store.db.prepare('UPDATE approach_graph_runs SET status = ? WHERE id = ?').run(status, graphRunId);
  }

  it('drives the completing nodes before it allocates the planner', async () => {
    revision('draining');
    await driveReplanDrain(deps(), graphRunId);
    expect(events).toEqual(['drive', 'relaunch']);
  });

  it('awaits the drive: the relaunch never starts before it settles', async () => {
    revision('draining');
    let settled = false;
    await driveReplanDrain(
      deps({
        driveCompletingNodes: async () => {
          await Promise.resolve();
          settled = true;
          events.push('drive');
        },
        relaunchReplanPlanner: async () => {
          expect(settled).toBe(true);
          events.push('relaunch');
        },
      }),
      graphRunId,
    );
    expect(events).toEqual(['drive', 'relaunch']);
  });

  it.each(['running', 'submitted', 'blocked', 'stale', 'cancelled'])(
    'does nothing when a %s planner run already serves this drain',
    async (status) => {
      revision('draining');
      planner('replan', status, 2);
      await driveReplanDrain(deps(), graphRunId);
      expect(events).toEqual([]);
    },
  );

  it('ignores a bootstrap planner: it is not this drain\'s planner', async () => {
    revision('draining');
    planner('bootstrap', 'running', null);
    await driveReplanDrain(deps(), graphRunId);
    expect(events).toEqual(['drive', 'relaunch']);
  });

  it('ignores a planner bound to an earlier drain', async () => {
    revision('draining', 3);
    planner('replan', 'running', 3);
    await driveReplanDrain(deps(), graphRunId);
    expect(events).toEqual(['drive', 'relaunch']);
  });

  it('does nothing in a Stop drain (the revision stays active)', async () => {
    revision('active');
    await driveReplanDrain(deps(), graphRunId);
    expect(events).toEqual([]);
  });

  it('does nothing for a run that is not draining', async () => {
    revision('active');
    runStatus('running');
    await driveReplanDrain(deps(), graphRunId);
    expect(events).toEqual([]);
  });

  it('does nothing for a running run whose newest revision is draining', async () => {
    revision('draining');
    runStatus('running');
    await driveReplanDrain(deps(), graphRunId);
    expect(events).toEqual([]);
  });

  it('does nothing when an active revision stands next to a draining one', async () => {
    revision('draining', 1);
    revision('active', 2);
    await driveReplanDrain(deps(), graphRunId);
    expect(events).toEqual([]);
  });

  it('does nothing when the run is gone', async () => {
    revision('draining');
    await driveReplanDrain(deps(), graphRunId + 1);
    expect(events).toEqual([]);
  });

  it('does not relaunch when the run left draining during the drive', async () => {
    revision('draining');
    await driveReplanDrain(deps({}, () => runStatus('running')), graphRunId);
    expect(events).toEqual(['drive']);
  });

  it('does not relaunch when the drain ended during the drive', async () => {
    revision('draining');
    await driveReplanDrain(
      deps({}, () => {
        store.db
          .prepare("UPDATE approach_graph_revisions SET status = 'active' WHERE graph_run_id = ?")
          .run(graphRunId);
      }),
      graphRunId,
    );
    expect(events).toEqual(['drive']);
  });

  it('reports a failing drive and lets the caller handle it', async () => {
    revision('draining');
    const driveCompletingNodes = vi.fn(async () => {
      throw new Error('pipeline exploded');
    });
    await expect(
      driveReplanDrain(deps({ driveCompletingNodes }), graphRunId),
    ).rejects.toThrow('pipeline exploded');
    expect(events).toEqual([]);
  });
});
