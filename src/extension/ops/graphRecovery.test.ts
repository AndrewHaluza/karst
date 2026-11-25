import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openStore, type Store } from '../../store/db.js';
import { DEFAULT_GRAPH_LIMITS, GRAPH_HARD_CEILINGS } from '../../manifest/graphConfig.js';
import { createTicket } from '../../store/tickets.js';
import { setStage } from '../../store/stages.js';
import { stageBlock } from '../../store/stageBlocks.js';
import type { StageKey } from '../../model/types.js';
import {
  recoverGraphRun,
  type RecoveryDeps,
  type RecoveryRefusalReason,
} from '../../approaches/graph/coordinator/recovery.js';
import type { ReplanLaunchRequest } from '../../approaches/graph/coordinator/replan.js';
import {
  recoveryGuidance,
  type RecoveryGuidanceContext,
} from '../../approaches/graph/coordinator/recoveryGuidance.js';
import type { GraphRecoverySeams } from './graphRecoveryDispatch.js';
import {
  compileExpertSpend,
  compileSpentNodeRuns,
  graphRecoveryRefusalNotice,
  graphRefusalContext,
  graphRefusalHandling,
  parkGraphLaunchFailure,
  projectMaxReplans,
  replanBlockedStage,
  type ReplanBlockedStageDeps,
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

describe('compileSpentNodeRuns', () => {
  it('counts the node runs the run already reserved', () => {
    const { db } = openStore(':memory:');
    db.prepare("INSERT INTO tickets (id, key) VALUES (1, 'T-1')").run();
    const graphRunId = Number(
      db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, node_run_count, created_at)
           VALUES (1, 'impl', 0, 'x', 'running', 7, '2026-08-12T00:00:00.000Z')`,
        )
        .run().lastInsertRowid,
    );
    expect(compileSpentNodeRuns(db, graphRunId)).toBe(7);
  });

  it('treats an unset store and a missing run as zero', () => {
    const { db } = openStore(':memory:');
    expect(compileSpentNodeRuns(undefined, 1)).toBe(0);
    expect(compileSpentNodeRuns(db, 987654)).toBe(0);
  });
});

describe('graphRefusalContext', () => {
  function seed(
    status: string,
    blockedReason: string | null,
    replanCount = 0,
  ): { store: Store; graphRunId: number } {
    const store = openStore(':memory:');
    store.db.prepare("INSERT INTO tickets (id, key) VALUES (1, 'T-1')").run();
    const graphRunId = Number(
      store.db
        .prepare(
          `INSERT INTO approach_graph_runs
             (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, replan_count, created_at)
           VALUES (1, 'impl', 0, 'x', ?, ?, ?, '2026-08-12T00:00:00.000Z')`,
        )
        .run(status, blockedReason, replanCount)
        .lastInsertRowid,
    );
    return { store, graphRunId };
  }

  it('reads the run’s block reason and accepted replans beside the project cap', () => {
    const { store, graphRunId } = seed('blocked', 'integration-conflict: api/src/a.ts', 1);
    expect(graphRefusalContext(store.db, graphRunId, 4)).toEqual({
      blockedReason: 'integration-conflict: api/src/a.ts',
      recoveryCategory: 'explicit-resolution',
      replanCount: 1,
      projectMaxReplans: 4,
    });
    store.close();
  });

  it('maps the block reason to the recovery category that refused it', () => {
    // The category is what tells a resumable refusal from a Replan-only one:
    // an artifact fault refuses `explicit-resolution` too, but the banner
    // offers Resume for it.
    const { store, graphRunId } = seed('blocked', 'output-artifact-missing: artifact "r" produced nothing');
    expect(graphRefusalContext(store.db, graphRunId, 2)).toMatchObject({
      recoveryCategory: 'artifact-recheck',
    });
    store.close();
  });

  it('reads a null block reason as null context, never a fabricated one', () => {
    const { store, graphRunId } = seed('blocked', null);
    expect(graphRefusalContext(store.db, graphRunId, 2)).toEqual({
      blockedReason: null,
      recoveryCategory: 'explicit-resolution',
      replanCount: 0,
      projectMaxReplans: 2,
    });
    store.close();
  });

  it('reads a missing run row as null reason and zero replans', () => {
    const { store } = seed('blocked', 'x');
    expect(graphRefusalContext(store.db, 987654, 2)).toEqual({
      blockedReason: null,
      recoveryCategory: 'explicit-resolution',
      replanCount: 0,
      projectMaxReplans: 2,
    });
    store.close();
  });
});

describe('graphRecoveryRefusalNotice', () => {
  it('names the ticket, the attempted control and the refusal reason', () => {
    const notice = graphRecoveryRefusalNotice(42, 'replan', 'explicit-resolution');
    expect(notice).toContain('Ticket T42');
    expect(notice).toContain('cannot replan itself');
    expect(notice).toContain('explicit-resolution');
  });

  it('points a config-then-resume refusal at Replan without an unconditional config change', () => {
    // With no counts read the notice names the control and makes NO claim that
    // a limit must be raised — the old copy sent every user to
    // `limits.maxReplans`, which was false whenever the project still had
    // replans in budget.
    const notice = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume');
    expect(notice).toContain('Click Replan');
    expect(notice).not.toContain('limits.maxReplans');
  });

  it('counts the replans left and says no config change is needed', () => {
    const notice = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume', {
      blockedReason: 'graph-budget-exhausted',
      replanCount: 1,
      projectMaxReplans: 2,
    });
    expect(notice).toContain('Click Replan. 1 of 2 replans remain. No config change is needed.');
    expect(notice).not.toContain('limits.maxReplans');
  });

  it('names the raiseable limit at a project cap below the hard ceiling, and stop advice at it', () => {
    const belowCeiling = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume', {
      blockedReason: 'graph-budget-exhausted',
      replanCount: 2,
      projectMaxReplans: 2,
    });
    expect(belowCeiling).toContain(
      `The replan limit is reached. Raise limits.maxReplans (up to ${GRAPH_HARD_CEILINGS.maxReplans}), then click Replan.`,
    );

    // 4 of 4 at a cap of 4: there is still headroom under the hard ceiling.
    const fourOfFour = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume', {
      blockedReason: 'graph-budget-exhausted',
      replanCount: 4,
      projectMaxReplans: 4,
    });
    expect(fourOfFour).toContain('Raise limits.maxReplans');

    // At the ceiling (and above it) "raise it" would be advice the manifest
    // itself refuses, so the notice says the run is out of replans.
    for (const cap of [GRAPH_HARD_CEILINGS.maxReplans, GRAPH_HARD_CEILINGS.maxReplans + 1]) {
      const atCeiling = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume', {
        blockedReason: 'graph-budget-exhausted',
        replanCount: cap,
        projectMaxReplans: cap,
      });
      expect(atCeiling).toContain(
        'The maximum is reached. Cancel the graph or switch the approach.',
      );
      expect(atCeiling).not.toContain('Raise limits.maxReplans');
    }
  });

  it('names the spent project cap before any reparable prefix, never a dead Replan', () => {
    // The high review finding: a reparable prefix used to win over the cap, so
    // a run that had spent `limits.maxReplans` was told to repair the block and
    // click Replan — the one control the cap refuses. The cap is the exit's
    // real state, so it comes first at every cap the run can reach.
    const reparables = [
      'graph-workspace-deps: node run 3 (web: x)',
      'graph-preserve-failed: node run 3 (patch failed)',
      'graph-budget-exhausted: node run 7 (workspace ceiling)',
    ];
    for (const blockedReason of reparables) {
      const notice = graphRecoveryRefusalNotice(7, 'replan', 'config-then-resume', {
        blockedReason,
        replanCount: 2,
        projectMaxReplans: 2,
      });
      expect(notice, blockedReason).toContain('The replan limit is reached.');
      expect(notice).not.toContain('Install the dependencies');
      expect(notice).not.toContain('could not be written to a patch');
      expect(notice).not.toContain('limits.maxAggregateWorkspaceBytes');

      const atCeiling = graphRecoveryRefusalNotice(7, 'replan', 'config-then-resume', {
        blockedReason,
        replanCount: GRAPH_HARD_CEILINGS.maxReplans,
        projectMaxReplans: GRAPH_HARD_CEILINGS.maxReplans,
      });
      expect(atCeiling, blockedReason).toContain(
        'The maximum is reached. Cancel the graph or switch the approach.',
      );
      expect(atCeiling).not.toContain('Install the dependencies');
      expect(atCeiling).not.toContain('could not be written to a patch');
      expect(atCeiling).not.toContain('limits.maxAggregateWorkspaceBytes');
    }
  });

  it('names Resume and the correction when a resumable category refuses explicit-resolution', () => {
    // The high review finding: the same refusal reason is returned by the
    // artifact re-check, the prompt re-snapshot and the planner relaunch, where
    // Resume IS the offered control. Never deny it.
    const cases = [
      ['artifact-recheck', 'output-artifact-missing: artifact "r" produced nothing'],
      ['artifact-recheck', 'artifact-unsafe: artifact "r" failed validation'],
      ['prompt-resnapshot', 'prompt-config-changed: profile prompt'],
      ['planner-relaunch', 'planner-stale: no planner ever submitted'],
      ['launch-retry', 'node-blocked: node 5 (agent said blocked)'],
    ] as const;
    for (const [recoveryCategory, blockedReason] of cases) {
      const notice = graphRecoveryRefusalNotice(7, 'resume', 'explicit-resolution', {
        blockedReason,
        recoveryCategory,
      });
      expect(notice, blockedReason).toContain(
        'Correct the artifact or prompt fault this block reports, then click Resume.',
      );
      expect(notice, blockedReason).not.toContain('Resume cannot clear this block');
    }
  });

  it('recognises a resumable explicit-resolution refusal by its reason when no category was read', () => {
    // A caller that has not read the category still must not deny Resume for a
    // reason whose refusal keeps it: the artifact pair, a prompt re-snapshot
    // and a dead bootstrap planner all name themselves.
    for (const blockedReason of [
      'output-artifact-missing: artifact "r" produced nothing',
      'artifact-unsafe: artifact "r" failed validation',
      'prompt-config-changed: profile prompt',
      'planner-stale: no planner ever submitted',
    ]) {
      const notice = graphRecoveryRefusalNotice(7, 'resume', 'explicit-resolution', {
        blockedReason,
      });
      expect(notice, blockedReason).toContain('then click Resume');
      expect(notice, blockedReason).not.toContain('Resume cannot clear this block');
    }
    // An unrecognized reason has no such exit: the default stays Replan-only.
    const unknown = graphRecoveryRefusalNotice(7, 'resume', 'explicit-resolution', {
      blockedReason: 'failed-to-launch: folder trust',
    });
    expect(unknown).toContain('Resume cannot clear this block');
  });

  it('names the repair for each reparable config-then-resume block, then Replan', () => {
    const deps = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume', {
      blockedReason: 'graph-workspace-deps: node run 3 (web: x)',
    });
    expect(deps).toContain('Install the dependencies in the ticket worktree');
    expect(deps).toContain('set repositories.<name>.graphWorkspace in karst.yml');
    expect(deps).toContain('Then click Replan.');

    const preserve = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume', {
      blockedReason: 'graph-preserve-failed: node run 3 (patch failed)',
    });
    expect(preserve).toContain('could not be written to a patch');
    expect(preserve).toContain('then click Replan.');

    const ceiling = graphRecoveryRefusalNotice(7, 'resume', 'config-then-resume', {
      blockedReason: 'graph-budget-exhausted: node run 7 (workspace ceiling)',
    });
    expect(ceiling).toContain('limits.maxAggregateWorkspaceBytes');
    expect(ceiling).toContain('Then click Replan.');
    // The workspace ceiling is not the replan limit.
    expect(ceiling).not.toContain('limits.maxReplans');
  });

  it('never routes an explicit-resolution refusal back to Resume', () => {
    const contexts: (RecoveryGuidanceContext | undefined)[] = [
      undefined,
      { blockedReason: 'integration-conflict: merge-tree conflict in api/src/a.ts' },
      { blockedReason: 'graph-topology-deadlock' },
      { blockedReason: null },
      { blockedReason: 'weird-unmapped-failure: something' },
    ];
    for (const ctx of contexts) {
      const notice = graphRecoveryRefusalNotice(7, 'resume', 'explicit-resolution', ctx);
      expect(notice).toContain(
        'Resume cannot clear this block. Click Replan to start a new graph revision.',
      );
      expect(notice).not.toContain('then Resume');
    }
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

  it('ends with the one guidance string for every refusal category and context', () => {
    // The single-source pin: the notice is the head plus EXACTLY the text
    // `recoverGraphRun` puts in its diagnostic.
    const cases: { reason: RecoveryRefusalReason; ctx?: RecoveryGuidanceContext }[] = [
      { reason: 'config-then-resume' },
      { reason: 'config-then-resume', ctx: { blockedReason: 'graph-workspace-deps: x' } },
      { reason: 'config-then-resume', ctx: { blockedReason: 'graph-preserve-failed: x' } },
      {
        reason: 'config-then-resume',
        ctx: { blockedReason: 'graph-budget-exhausted: x (workspace ceiling)' },
      },
      {
        reason: 'config-then-resume',
        ctx: { blockedReason: 'graph-budget-exhausted', replanCount: 0, projectMaxReplans: 2 },
      },
      {
        reason: 'config-then-resume',
        ctx: { blockedReason: 'graph-budget-exhausted', replanCount: 2, projectMaxReplans: 2 },
      },
      {
        reason: 'config-then-resume',
        ctx: {
          blockedReason: 'graph-budget-exhausted',
          replanCount: GRAPH_HARD_CEILINGS.maxReplans,
          projectMaxReplans: GRAPH_HARD_CEILINGS.maxReplans,
        },
      },
      { reason: 'explicit-resolution' },
      { reason: 'explicit-resolution', ctx: { blockedReason: 'integration-conflict: x' } },
      { reason: 'explicit-resolution', ctx: { blockedReason: 'graph-topology-deadlock' } },
      { reason: 'explicit-resolution', ctx: { blockedReason: null } },
      {
        reason: 'explicit-resolution',
        ctx: {
          blockedReason: 'integration-conflict: x',
          recoveryCategory: 'explicit-resolution',
        },
      },
      {
        reason: 'explicit-resolution',
        ctx: { blockedReason: 'output-artifact-missing: x', recoveryCategory: 'artifact-recheck' },
      },
      { reason: 'discard-required' },
      { reason: 'launch-loop' },
    ];
    for (const c of cases) {
      const notice = graphRecoveryRefusalNotice(7, 'resume', c.reason, c.ctx);
      expect(notice.endsWith(` ${recoveryGuidance(c.reason, c.ctx)}`), c.reason).toBe(true);
    }
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

  it('forwards the guidance context to the notice', () => {
    const ctx: RecoveryGuidanceContext = {
      blockedReason: 'graph-budget-exhausted',
      replanCount: 0,
      projectMaxReplans: 2,
    };
    expect(graphRefusalHandling(3, 'replan', 'config-then-resume', ctx).message).toBe(
      graphRecoveryRefusalNotice(3, 'replan', 'config-then-resume', ctx),
    );
  });
});

describe('replanBlockedStage', () => {
  let store: Store;
  beforeEach(() => (store = openStore(':memory:')));
  afterEach(() => store.close());

  /** A compile-valid canonical document (`electReplan` re-parses it). */
  function validGraph(maxReplans = 2): string {
    return JSON.stringify({
      version: 1,
      title: 't',
      rationaleArtifact: 'r',
      entries: ['a'],
      artifacts: [],
      nodes: [
        {
          id: 'a',
          kind: 'agent',
          label: 'a',
          profile: 'default',
          instructionsArtifact: 'i',
          inputs: [],
          outputs: [],
          resources: { reads: [], writes: [] },
          outcomes: ['complete', 'blocked', 'replan'],
          budget: { maxVisits: 1 },
        },
      ],
      edges: [{ id: 'e-a-end', from: 'a', on: 'complete', to: 'END' }],
      budgets: { maxNodeRuns: 10, maxExpertRuns: 1, maxReplans },
    });
  }

  interface Fixture {
    ticketId: number;
    graphRunId: number | null;
  }

  function seedRun(
    over: {
      replanCount?: number;
      /** `none` parks no block; `other` parks a non-graph blocker. */
      blocker?: 'graph' | 'other' | 'none';
      withRun?: boolean;
      stageCurrent?: string;
    } = {},
  ): Fixture {
    const ticketId = createTicket(store, { key: 'RG-1', title: 'thing' }).id;
    store.db
      .prepare('UPDATE tickets SET stage_current = ? WHERE id = ?')
      .run(over.stageCurrent ?? 'impl', ticketId);
    store.db
      .prepare("UPDATE stages SET status = 'running' WHERE ticket_id = ? AND stage_key = 'impl'")
      .run(ticketId);
    let graphRunId: number | null = null;
    if (over.withRun !== false) {
      graphRunId = Number(
        store.db
          .prepare(
            `INSERT INTO approach_graph_runs
               (ticket_id, stage_key, stage_attempt, approach_id, status, blocked_reason, replan_count, created_at)
             VALUES (?, 'impl', 0, 'x', 'blocked', 'integration-conflict: api/src/a.ts', ?, '2026-08-12T00:00:00.000Z')`,
          )
          .run(ticketId, over.replanCount ?? 0)
          .lastInsertRowid,
      );
      const revisionId = Number(
        store.db
          .prepare(
            `INSERT INTO approach_graph_revisions
               (graph_run_id, revision_number, canonical_graph, fingerprint, status, created_at)
             VALUES (?, 1, ?, 'fp', 'active', '2026-08-12T00:00:00.000Z')`,
          )
          .run(graphRunId, validGraph(2))
          .lastInsertRowid,
      );
      // A dead blocked node (a settled failure category) holds no drain, so
      // the replan launch is not deferred `not-quiescent`.
      store.db
        .prepare(
          `INSERT INTO approach_node_runs
             (id, graph_run_id, revision_id, node_id, node_kind, visit_number, status, failure_category, reason)
           VALUES (5, ?, ?, 'n', 'agent', 1, 'blocked', 'integration-conflict', 'git refused')`,
        )
        .run(graphRunId, revisionId);
    }
    if (over.blocker !== 'none') {
      setStage(store, ticketId, 'impl', {
        status: 'running',
        blockedKind: over.blocker === 'other' ? 'awaiting-subtask' : 'approach-graph-failed',
        blockedReason: `approach-graph-failed: integration-conflict (graph run ${graphRunId ?? 0})`,
        blockedAt: '2026-08-12T00:00:00.000Z',
      });
    }
    return { ticketId, graphRunId };
  }

  function recoveryDeps(over: Partial<RecoveryDeps> = {}): RecoveryDeps {
    return {
      store,
      transaction: <T>(fn: () => T): T =>
        (store.db.transaction as unknown as (f: () => T, o: { begin: 'immediate' }) => () => T)(fn, {
          begin: 'immediate',
        })(),
      now: () => '2026-08-12T00:00:00.000Z',
      debug: () => {},
      projectMaxReplans: 2,
      readPrompt: () => new TextEncoder().encode('# planner'),
      writeSnapshot: () => undefined,
      plannerPromptPath: 'prompts/planner.md',
      ticketContext: 'ticket context',
      ...over,
    };
  }

  interface Harness {
    seams: GraphRecoverySeams;
    launches: ReplanLaunchRequest[];
    recovered: Array<[number, number]>;
    refused: string[];
  }

  function harness(recoveryOver: Partial<RecoveryDeps> = {}): Harness {
    const launches: ReplanLaunchRequest[] = [];
    const recovered: Array<[number, number]> = [];
    const refused: string[] = [];
    const seams: GraphRecoverySeams = {
      recover: (input) => recoverGraphRun(recoveryDeps(recoveryOver), input),
      launchReplan: (launch) => launches.push(launch),
      launchBootstrap: () => {
        throw new Error('a blocked stage replan never relaunches the bootstrap planner');
      },
      onRecovered: (ticketId, graphRunId) => recovered.push([ticketId, graphRunId]),
    };
    return { seams, launches, recovered, refused };
  }

  function stageDeps(
    fixture: Fixture,
    h: Harness,
    over: Partial<ReplanBlockedStageDeps> = {},
  ): ReplanBlockedStageDeps {
    return {
      store,
      panelTicketId: fixture.ticketId,
      msgTicketId: fixture.ticketId,
      stageKey: 'impl' as StageKey,
      seams: h.seams,
      projectMaxReplansOf: () => 2,
      onRefused: (notice) => h.refused.push(notice),
      ...over,
    };
  }

  it('elects a new revision and launches its planner', () => {
    const fixture = seedRun();
    const h = harness();
    const result = replanBlockedStage(stageDeps(fixture, h));
    expect(result.kind).toBe('replanned');
    expect(h.launches).toHaveLength(1);
    expect(h.launches[0]!.graphRunId).toBe(fixture.graphRunId);
    expect(h.recovered).toEqual([[fixture.ticketId, fixture.graphRunId]]);
    expect(h.refused).toEqual([]);
    const run = store.db
      .prepare('SELECT status, replan_count FROM approach_graph_runs WHERE id = ?')
      .get(fixture.graphRunId) as { status: string; replan_count: number };
    expect(run).toEqual({ status: 'draining', replan_count: 1 });
    // The visible block cleared only because the replan durably entered.
    expect(stageBlock(store, fixture.ticketId, 'impl')).toBeNull();
  });

  it('refuses at the project replan cap with the truthful notice, changing nothing', () => {
    const fixture = seedRun({ replanCount: 2 });
    const h = harness({ projectMaxReplans: 2 });
    const result = replanBlockedStage(stageDeps(fixture, h));
    expect(result).toEqual({ kind: 'refused', reason: 'config-then-resume' });
    expect(h.refused).toEqual([
      graphRecoveryRefusalNotice(fixture.ticketId, 'replan', 'config-then-resume', {
        blockedReason: 'integration-conflict: api/src/a.ts',
        replanCount: 2,
        projectMaxReplans: 2,
      }),
    ]);
    // Below the hard ceiling there is still a raisable limit.
    expect(h.refused[0]).toContain(
      `Raise limits.maxReplans (up to ${GRAPH_HARD_CEILINGS.maxReplans}), then click Replan.`,
    );
    expect(h.refused[0]).not.toContain('then Resume');
    expect(h.launches).toEqual([]);
    expect(h.recovered).toEqual([]);
    const run = store.db
      .prepare('SELECT status, replan_count FROM approach_graph_runs WHERE id = ?')
      .get(fixture.graphRunId) as { status: string; replan_count: number };
    expect(run).toEqual({ status: 'blocked', replan_count: 2 });
    expect(stageBlock(store, fixture.ticketId, 'impl')).not.toBeNull();
  });

  it('names no raisable limit once the project cap is the hard ceiling', () => {
    const fixture = seedRun({ replanCount: GRAPH_HARD_CEILINGS.maxReplans });
    const h = harness({ projectMaxReplans: GRAPH_HARD_CEILINGS.maxReplans });
    const result = replanBlockedStage(
      stageDeps(fixture, h, {
        projectMaxReplansOf: () => GRAPH_HARD_CEILINGS.maxReplans,
      }),
    );
    expect(result).toEqual({ kind: 'refused', reason: 'config-then-resume' });
    expect(h.refused[0]).toContain(
      'The maximum is reached. Cancel the graph or switch the approach.',
    );
    expect(h.refused[0]).not.toContain('Raise limits.maxReplans');
  });

  it('is a no-op for a stale panel ticket id', () => {
    const fixture = seedRun();
    const h = harness();
    const recover = vi.spyOn(h.seams, 'recover');
    expect(replanBlockedStage(stageDeps(fixture, h, { msgTicketId: fixture.ticketId + 1 }))).toEqual({
      kind: 'no-op',
    });
    expect(recover).not.toHaveBeenCalled();
    expect(h.refused).toEqual([]);
  });

  it('is a no-op when the stage moved on, even if another stage holds a graph block', () => {
    const fixture = seedRun();
    // A graph block parked elsewhere must not be recovered by a click meant
    // for THIS stage's banner.
    setStage(store, fixture.ticketId, 'uat', {
      status: 'running',
      blockedKind: 'approach-graph-failed',
      blockedReason: 'approach-graph-failed: elsewhere',
      blockedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(stageBlock(store, fixture.ticketId, 'uat')).not.toBeNull();
    const h = harness();
    const recover = vi.spyOn(h.seams, 'recover');
    expect(replanBlockedStage(stageDeps(fixture, h, { stageKey: 'uat' }))).toEqual({ kind: 'no-op' });
    expect(recover).not.toHaveBeenCalled();
    expect(h.refused).toEqual([]);
  });

  it('is a no-op when the stage holds no block', () => {
    const fixture = seedRun({ blocker: 'none' });
    const h = harness();
    const recover = vi.spyOn(h.seams, 'recover');
    expect(replanBlockedStage(stageDeps(fixture, h))).toEqual({ kind: 'no-op' });
    expect(recover).not.toHaveBeenCalled();
    expect(h.refused).toEqual([]);
  });

  it('is a no-op when the block is not a graph failure', () => {
    const fixture = seedRun({ blocker: 'other' });
    const h = harness();
    const recover = vi.spyOn(h.seams, 'recover');
    expect(replanBlockedStage(stageDeps(fixture, h))).toEqual({ kind: 'no-op' });
    expect(recover).not.toHaveBeenCalled();
    expect(h.refused).toEqual([]);
  });

  it('is a no-op when no blocked graph run sits behind the block', () => {
    const fixture = seedRun({ withRun: false });
    const h = harness();
    const recover = vi.spyOn(h.seams, 'recover');
    expect(replanBlockedStage(stageDeps(fixture, h))).toEqual({ kind: 'no-op' });
    expect(recover).not.toHaveBeenCalled();
    expect(h.refused).toEqual([]);
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
          manifest: {},
          graphConfigOf: () => undefined,
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
