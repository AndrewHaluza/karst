import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { DEFAULT_GRAPH_LIMITS } from '../../manifest/graphConfig.js';
import {
  compileExpertSpend,
  graphRecoveryRefusalNotice,
  graphRefusalHandling,
  parkGraphLaunchFailure,
  projectMaxReplans,
} from './graphRecovery.js';

describe('projectMaxReplans', () => {
  it('falls back to the packaged default when config declares none', () => {
    expect(projectMaxReplans(undefined)).toBe(DEFAULT_GRAPH_LIMITS.maxReplans);
  });

  it('uses the configured maximum when present', () => {
    expect(projectMaxReplans(4)).toBe(4);
  });
});

describe('compileExpertSpend', () => {
  function storeWithRun(replanCount: number): { db: ReturnType<typeof openStore>['db']; graphRunId: number } {
    const { db } = openStore(':memory:');
    const ticketId = Number(db.prepare("INSERT INTO tickets (key) VALUES ('T-1')").run().lastInsertRowid);
    const graphRunId = Number(
      db
        .prepare(
          `INSERT INTO approach_graph_runs (ticket_id, stage_key, stage_attempt, approach_id, status, replan_count, created_at)
           VALUES (?, 'impl', 0, 'x', 'running', ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(ticketId, replanCount)
        .lastInsertRowid,
    );
    return { db, graphRunId };
  }

  it('reserves the run’s remaining project headroom and charges the accepted replan', () => {
    // One replan already ran: the bootstrap plus that planner are both SPENT,
    // and 3 − 1 replans remain. Dropping the spent replan would undercharge the
    // document's maxExpertRuns ceiling.
    const { db, graphRunId } = storeWithRun(1);
    expect(compileExpertSpend(3, db, graphRunId)).toEqual({
      spentPlannerRuns: 2,
      permittedReplans: 2,
      bootstrapUnspent: false,
    });
  });

  it('never lets the worst-case charge shrink as replans accrue', () => {
    // spent + reserve is invariant: bootstrap + the project cap, or every
    // accepted replan once the cap is passed. The medium it fixes was this sum
    // falling as replan_count rose, discharging replans the run already spent.
    for (const count of [0, 1, 2, 3]) {
      const { db, graphRunId } = storeWithRun(count);
      const spend = compileExpertSpend(2, db, graphRunId);
      expect(spend.spentPlannerRuns + spend.permittedReplans).toBe(1 + Math.max(2, count));
    }
  });

  it('reserves zero (never negative) once a human bypass spends the project cap', () => {
    const { db, graphRunId } = storeWithRun(2);
    expect(compileExpertSpend(2, db, graphRunId).permittedReplans).toBe(0);
  });

  it('never over-reserves past the configured maximum', () => {
    const { db, graphRunId } = storeWithRun(3);
    expect(compileExpertSpend(2, db, graphRunId).permittedReplans).toBe(0);
  });

  it('treats an unset store as zero accepted replans', () => {
    expect(compileExpertSpend(2, undefined, 999).permittedReplans).toBe(2);
  });

  it('treats a missing run row as zero accepted replans', () => {
    const { db } = storeWithRun(0);
    expect(compileExpertSpend(2, db, 987654).permittedReplans).toBe(2);
  });
});

describe('graphRecoveryRefusalNotice', () => {
  it('names the ticket, the attempted control and the refusal reason', () => {
    const notice = graphRecoveryRefusalNotice(42, 'replan', 'explicit-resolution');
    expect(notice).toContain('Ticket T42');
    expect(notice).toContain('cannot replan itself');
    expect(notice).toContain('explicit-resolution');
  });

  it('points a config-then-resume refusal at Replan and limits.maxReplans', () => {
    // The user-visible half of criterion 3: with debug off this is the only
    // text they see, so it must carry the actionable exit, not just the reason.
    const notice = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume');
    expect(notice).toContain('Replan bypasses the revision document');
    expect(notice).toContain('frozen replan budget');
    expect(notice).toContain('limits.maxReplans');
    expect(notice).toContain('no further replans are possible');
  });

  it('names Resume as the post-correction control for an explicit-resolution refusal', () => {
    const notice = graphRecoveryRefusalNotice(7, 'resume', 'explicit-resolution');
    expect(notice).toContain('Resume');
    expect(notice).toContain('Replan');
  });

  it('names Resume as the post-discard control for a discard-required refusal', () => {
    const notice = graphRecoveryRefusalNotice(7, 'resume', 'discard-required');
    expect(notice).toContain('Discard');
    expect(notice).toContain('Resume');
  });

  it('names the folder trust and Replan for a launch-loop refusal, without promising Force', () => {
    // The low review finding: this notice is shown by Resume routes that offer
    // NO Force button, so it must not name one. Force rides on the modal's
    // message alone (see graphRefusalHandling).
    const notice = graphRecoveryRefusalNotice(7, 'resume', 'launch-loop');
    expect(notice).toContain('launched twice');
    expect(notice).toContain('folder trust');
    expect(notice).toContain('Replan');
    expect(notice).not.toContain('Force a retry');
  });
});

describe('graphRefusalHandling', () => {
  it('offers the Force retry only for a launch-loop refusal on a plain Resume', () => {
    const handling = graphRefusalHandling(1, 'resume', 'launch-loop');
    expect(handling.offerForce).toBe(true);
    // The Force mention rides only where the button does.
    expect(handling.message).toContain('Force a retry');
    expect(handling.message).toContain(graphRecoveryRefusalNotice(1, 'resume', 'launch-loop'));
    // A Replan is never the loop's control, and no other refusal is forcible.
    expect(graphRefusalHandling(1, 'replan', 'launch-loop').offerForce).toBe(false);
    expect(graphRefusalHandling(1, 'resume', 'explicit-resolution').offerForce).toBe(false);
    expect(graphRefusalHandling(1, 'force-resume', 'launch-loop').offerForce).toBe(false);
    // Without the button, the message never names it.
    expect(graphRefusalHandling(1, 'resume', 'explicit-resolution').message).not.toContain(
      'Force a retry',
    );
  });

  it('reports a replan attempt as a replan in the notice', () => {
    expect(graphRefusalHandling(3, 'replan', 'config-then-resume').message).toContain(
      'cannot replan itself',
    );
  });
});

describe('parkGraphLaunchFailure', () => {
  it('parks the node the launch died on with its captured line', () => {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO tickets (id, key) VALUES (1, 'T-1')").run();
    store.db
      .prepare(
        `INSERT INTO approach_graph_runs (id, ticket_id, stage_key, stage_attempt, approach_id, status, created_at)
         VALUES (2, 1, 'impl', 0, 'x', 'running', '2026-08-12T00:00:00.000Z')`,
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO approach_graph_revisions (id, graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
         VALUES (3, 2, 1, '{}', 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
      )
      .run();
    store.db
      .prepare(
        `INSERT INTO approach_node_runs (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, launch_attempt)
         VALUES (11, 2, 3, 'n', 'agent', 1, 'running', 0)`,
      )
      .run();
    const reported: string[] = [];
    const handler = parkGraphLaunchFailure(
      () =>
        ({
          db: store.db,
          transaction: <T>(fn: () => T): T => fn(),
          now: () => '2026-08-12T00:00:00.000Z',
          debug: () => undefined,
        }) as never,
      (message) => reported.push(message),
    );
    handler({
      request: { graphRunId: 2, nodeRunId: 11 },
      outputLine: 'Folder trust required',
    } as never);

    const node = store.db
      .prepare('SELECT status, reason FROM approach_node_runs WHERE id = 11')
      .get() as { status: string; reason: string };
    expect(node.status).toBe('blocked');
    expect(node.reason).toBe('failed-to-launch: Folder trust required');
    expect(reported).toEqual([]);
  });

  it('reports a throwing park instead of letting it escape the launch path', () => {
    const reported: string[] = [];
    const handler = parkGraphLaunchFailure(
      () => {
        throw new Error('database is locked');
      },
      (message) => reported.push(message),
    );
    handler({ request: { graphRunId: 1, nodeRunId: 2 }, outputLine: '' } as never);
    expect(reported).toEqual(['karst: parking a failed graph launch failed']);
  });
});
