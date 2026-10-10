import { describe, it, expect } from 'vitest';
import { openStore } from '../../store/db.js';
import { DEFAULT_GRAPH_LIMITS } from '../../manifest/graphConfig.js';
import {
  compileExpertSpend,
  graphRecoveryRefusalNotice,
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
});
