/**
 * E2E: the dynamic graph approach, driven through the REAL CLI and a REAL
 * temp-file registry.
 *
 * The graph unit suites (`driver.test.ts`, `pipeline.test.ts`) seed graph
 * runs in-process with an in-memory store and faked transport/git. They can
 * never catch the drift between what the REAL `karst graph submit` / `karst
 * node complete` CLIs write and what the host-agnostic driver/pipeline read,
 * nor whether a graph-approach ticket actually launches a graph run at all.
 * The shared harness in `graphE2eHarness.test.ts` drives the full lifecycle
 * against a REAL SQLite file through `openGraphWritableStore` (node:sqlite,
 * the exact seam an agent session invokes) and the REAL CLI verbs, faking
 * only the agent transport and the workspace-provider clone (no real agent
 * CLI exists).
 *
 * The dynamic graph approach is "broken and incomplete" (the ticket); this
 * suite is the baseline for the repair work. Tests that pin the working seams
 * run green; tests that document an OBSERVABLE FAILURE in the current
 * implementation are marked `it.fails` with the defect named, so a repair
 * that flips them to passing is a visible event, not a silent behaviour
 * change.
 *
 * No better-sqlite3 is touched anywhere: the e2e config runs without the
 * Node-ABI rebuild, so this suite is ABI-agnostic like the other e2e suites.
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../cli/main.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { SUPPORTED, unsupported } from '../../agent/surfaces.js';
import { bootstrapAndLaunchPlanner, acceptSubmittedPlan, confirmGraphRun, driveReadyNodeRuns } from './driver.js';
import { runGraphCommand } from '../../cli/graph.js';
import { runNodeCommand } from '../../cli/node.js';
import { flipOnEndQuiescence } from './coordinator/completion.js';
import { runCompletionPipeline } from './integration/pipeline.js';
import { runStageCommand } from '../../cli/stage.js';
import {
  makeHarness,
  bootAndSubmit,
  claimAndDrive,
  nodeCapabilityOf,
  writePlannerSubmission,
  graphEnv,
  agentGraphJson,
  realTransport,
  NOW,
  GRAPH_APPROACH,
  type Harness,
} from './graphE2eHarness.test.js';
describe('dynamic graph lifecycle e2e — real CLI + real store', () => {
  it('a graph-approach ticket bootstraps a graph run, not a plain session', async () => {
    const h = makeHarness();
    try {
      const launched = await bootstrapAndLaunchPlanner(h.deps, {
        ticketId: h.ticketId,
        stageAttempt: 0,
        approachId: GRAPH_APPROACH,
        projectSlug: 'e2e',
      });
      expect(launched.kind).toBe('launched');
      if (launched.kind !== 'launched') return;
      const run = h.store.db
        .prepare('SELECT status, approach_id FROM approach_graph_runs WHERE id = ?')
        .get(launched.graphRunId) as { status: string; approach_id: string };
      expect(run.status).toBe('planning');
      expect(run.approach_id).toBe(GRAPH_APPROACH);
      expect(h.transport.started).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('the planner submits graph.json through the real CLI and the plan is accepted', async () => {
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      const run = h.store.db
        .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { status: string };
      expect(run.status).toBe('awaiting-confirmation');
      const revision = h.store.db
        .prepare("SELECT status FROM approach_graph_revisions WHERE graph_run_id = ? AND status = 'active'")
        .get(graphRunId) as { status: string } | undefined;
      expect(revision).toBeDefined();
      const tokens = h.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM approach_graph_tokens WHERE is_entry = 1 AND status = 'pending'",
        )
        .get() as { n: number };
      expect(tokens.n).toBe(1);
    } finally {
      h.close();
    }
  });

  it('a wrong capability is rejected by the real graph submit CLI with no state change', async () => {
    const h = makeHarness();
    try {
      const launched = await bootstrapAndLaunchPlanner(h.deps, {
        ticketId: h.ticketId,
        stageAttempt: 0,
        approachId: GRAPH_APPROACH,
        projectSlug: 'e2e',
      });
      expect(launched.kind).toBe('launched');
      if (launched.kind !== 'launched') return;
      writePlannerSubmission(h, agentGraphJson());
      const out = JSON.parse(
        runGraphCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(launched.graphRunId),
            launchId: String(launched.plannerRunId),
            generation: launched.generation,
            capability: 'deadbeef',
          }),
          ['graph', 'submit'],
          () => NOW,
        ),
      ) as { ok: boolean; rejected?: string };
      expect(out.ok).toBe(false);
      expect(out.rejected).toBe('wrong-capability');
      const planner = h.store.db
        .prepare('SELECT status FROM approach_planner_runs WHERE id = ?')
        .get(launched.plannerRunId) as { status: string };
      expect(planner.status).toBe('running');
    } finally {
      h.close();
    }
  });

  it('graph submit drives through the REAL runCli argv+env path (the agent-facing seam)', async () => {
    // The agent never calls `runGraphCommand` directly: it runs
    // `node … graph submit --db <db>` with the KARST_GRAPH_* environment the
    // bootstrap session was launched with. This pins that argv+env plumbing —
    // a missing connection here (an env key the driver writes but the CLI
    // never reads) would strand every real graph run at `planning`.
    const h = makeHarness();
    try {
      const launched = await bootstrapAndLaunchPlanner(h.deps, {
        ticketId: h.ticketId,
        stageAttempt: 0,
        approachId: GRAPH_APPROACH,
        projectSlug: 'e2e',
      });
      expect(launched.kind).toBe('launched');
      if (launched.kind !== 'launched') return;
      writePlannerSubmission(h, agentGraphJson());
      const saved = { ...process.env };
      try {
        process.env.KARST_GRAPH_PROJECT = String(h.projectId);
        process.env.KARST_TICKET_ID = String(h.ticketId);
        process.env.KARST_GRAPH_RUN_ID = String(launched.graphRunId);
        process.env.KARST_LAUNCH_ID = String(launched.plannerRunId);
        process.env.KARST_GRAPH_GENERATION = launched.generation;
        process.env.KARST_GRAPH_CAPABILITY = launched.capability;
        process.env.KARST_GRAPH_ARTIFACT_ROOT = h.artifactRoot;
        const out = JSON.parse(
          runCli(['graph', 'submit', '--db', h.dbPath]),
        ) as { ok: boolean; graphRunId?: number };
        expect(out.ok).toBe(true);
        expect(out.graphRunId).toBe(launched.graphRunId);
      } finally {
        for (const key of Object.keys(process.env)) {
          if (saved[key] === undefined) delete process.env[key];
        }
        Object.assign(process.env, saved);
      }
      // The real CLI committed the submission the host's accept reads.
      const accepted = acceptSubmittedPlan(h.deps, launched.graphRunId);
      expect(accepted.kind).toBe('accepted');
      const run = h.store.db
        .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
        .get(launched.graphRunId) as { status: string };
      expect(run.status).toBe('awaiting-confirmation');
    } finally {
      h.close();
    }
  });

  it('the full happy path reaches an END-quiescent, marker-ready graph run', async () => {
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      expect(confirmGraphRun(h.deps, graphRunId)).toBe(true);

      const driven = await claimAndDrive(h, graphRunId);
      expect(driven.launched).toBe(1);
      const nodeRun = h.store.db
        .prepare(
          'SELECT id, status, generation, capability_hash FROM approach_node_runs WHERE graph_run_id = ?',
        )
        .get(graphRunId) as {
        id: number;
        status: string;
        generation: string | null;
        capability_hash: string | null;
      };
      expect(nodeRun.status).toBe('running');

      // The agent did its work in the isolated workspace clone.
      writeFileSync(join(h.workspace, 'src', 'a.ts'), 'a\nb\n');

      // The agent reports completion through the REAL node CLI.
      const out = JSON.parse(
        runNodeCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(graphRunId),
            launchId: String(nodeRun.id),
            generation: nodeRun.generation!,
            capability: nodeCapabilityOf(h, nodeRun.id),
          }),
          ['node', 'complete'],
          () => NOW,
        ),
      ) as { ok: boolean };
      expect(out.ok).toBe(true);

      const pipeline = await runCompletionPipeline(h.pipelineDeps, {
        graphRunId,
        nodeRunId: nodeRun.id,
      });
      expect(pipeline.kind).toBe('integrated');

      const flip = flipOnEndQuiescence(
        { db: h.store.db, transaction: h.pipelineDeps.transaction, now: () => NOW },
        { graphRunId },
      );
      expect(flip.flipped).toBe(true);
      const run = h.store.db
        .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { status: string };
      expect(run.status).toBe('completed-awaiting-impl-marker');
    } finally {
      h.close();
    }
  });

  it('the impl marker closes the quiescent graph run through the real stage CLI', async () => {
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      const driven = await claimAndDrive(h, graphRunId);
      expect(driven.launched).toBe(1);
      const nodeRun = h.store.db
        .prepare('SELECT id, generation, capability_hash FROM approach_node_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number; generation: string | null; capability_hash: string | null };
      writeFileSync(join(h.workspace, 'src', 'a.ts'), 'a\nb\n');
      runNodeCommand(
        h.store,
        graphEnv(h, {
          graphRunId: String(graphRunId),
          launchId: String(nodeRun.id),
          generation: nodeRun.generation!,
          capability: nodeCapabilityOf(h, nodeRun.id),
        }),
        ['node', 'complete'],
        () => NOW,
      );
      const pipeline = await runCompletionPipeline(h.pipelineDeps, { graphRunId, nodeRunId: nodeRun.id });
      expect(pipeline.kind).toBe('integrated');
      flipOnEndQuiescence(
        { db: h.store.db, transaction: h.pipelineDeps.transaction, now: () => NOW },
        { graphRunId },
      );

      const next = runStageCommand(h.store, h.ticketId, ['stage', 'impl', 'pass'], undefined, {
        agentState: 'running',
      });
      expect(next).toBe('uat');
      const run = h.store.db
        .prepare('SELECT status FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { status: string };
      expect(run.status).toBe('closed');
      const ticket = h.store.db
        .prepare('SELECT stage_current FROM tickets WHERE id = ?')
        .get(h.ticketId) as { stage_current: string };
      expect(ticket.stage_current).toBe('uat');
    } finally {
      h.close();
    }
  });

  it('a node completion whose workspace has NO change still integrates and closes', async () => {
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      const driven = await claimAndDrive(h, graphRunId);
      expect(driven.launched).toBe(1);
      const nodeRun = h.store.db
        .prepare('SELECT id, generation, capability_hash FROM approach_node_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number; generation: string | null; capability_hash: string | null };
      runNodeCommand(
        h.store,
        graphEnv(h, {
          graphRunId: String(graphRunId),
          launchId: String(nodeRun.id),
          generation: nodeRun.generation!,
          capability: nodeCapabilityOf(h, nodeRun.id),
        }),
        ['node', 'complete'],
        () => NOW,
      );
      const pipeline = await runCompletionPipeline(h.pipelineDeps, { graphRunId, nodeRunId: nodeRun.id });
      expect(pipeline.kind).toBe('integrated');
      expect(pipeline).toMatchObject({ committed: false });
    } finally {
      h.close();
    }
  });
});

describe('documented failures of the current dynamic graph implementation', () => {
  it('the impl marker is REFUSED while the graph run is still planning or running', async () => {
    // A graph ticket's impl marker is the graph marker guard, and an earlier
    // marker must never advance the ticket: the run is only marker-ready at
    // `completed-awaiting-impl-marker` (END quiescent). This pins the guard so
    // an agent that fires `stage impl pass` mid-run is refused, not advanced.
    const h = makeHarness();
    try {
      // A graph run exists (bootstrap launched), still `planning`.
      await bootstrapAndLaunchPlanner(h.deps, {
        ticketId: h.ticketId,
        stageAttempt: 0,
        approachId: GRAPH_APPROACH,
        projectSlug: 'e2e',
      });
      expect(() =>
        runStageCommand(h.store, h.ticketId, ['stage', 'impl', 'pass'], undefined, {
          agentState: 'running',
        }),
      ).toThrow(/not marker-ready/);
      const ticket = h.store.db
        .prepare('SELECT stage_current FROM tickets WHERE id = ?')
        .get(h.ticketId) as { stage_current: string };
      expect(ticket.stage_current).toBe('impl');
    } finally {
      h.close();
    }
  });

  it('the impl marker is refused before END quiescence (a claimed node still runs)', async () => {
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      const driven = await claimAndDrive(h, graphRunId);
      expect(driven.launched).toBe(1);
      // The agent node is still `running`; its claimed token is pending — not
      // quiescent, so the marker must be refused.
      expect(() =>
        runStageCommand(h.store, h.ticketId, ['stage', 'impl', 'pass'], undefined, {
          agentState: 'running',
        }),
      ).toThrow(/not marker-ready|not quiescent/);
      const ticket = h.store.db
        .prepare('SELECT stage_current FROM tickets WHERE id = ?')
        .get(h.ticketId) as { stage_current: string };
      expect(ticket.stage_current).toBe('impl');
    } finally {
      h.close();
    }
  });

  it(
    'a graph-approach ticket with NO graph run falls through to the PLAIN impl marker (must not advance)',
    async () => {
      // MISSING CONNECTION: `runStageCommand` routes to the graph marker guard
      // ONLY when a graph run row exists. A graph-approach ticket whose launch
      // never created a run (a failed bootstrap, a missing planner prompt, a
      // misconfigured `graph:` block) has no row, so the impl marker falls
      // through to `markImplementDone` and ADVANCES the ticket to uat with
      // zero graph work. A graph ticket whose graph never ran must not read
      // done — the repair may refuse the marker or auto-create the run, but
      // the observable defect is that it currently advances silently.
      const h = makeHarness();
      try {
        expect(() =>
          runStageCommand(h.store, h.ticketId, ['stage', 'impl', 'pass'], undefined, {
            agentState: 'running',
          }),
        ).toThrow(/graph/);
        const ticket = h.store.db
          .prepare('SELECT stage_current FROM tickets WHERE id = ?')
          .get(h.ticketId) as { stage_current: string };
        expect(ticket.stage_current).toBe('impl');
      } finally {
        h.close();
      }
    },
  );

  it('a node completion for an UNDECLARED outcome is rejected with evidence and no state change', async () => {
    // The `karst node` verb is validated against the PINNED node definition in
    // the active revision: the verb maps to a fixed outcome, and a node that
    // does not declare it is refused (unknown-outcome) with no state change.
    // The submitted graph's agent node declares outcomes `['blocked', 'replan']`
    // — NO `complete` — so `node complete` is refused.
    const h = makeHarness();
    try {
      const graphJson = JSON.parse(agentGraphJson()) as Record<string, unknown> & {
        entries: string[];
        nodes: Record<string, unknown>[];
        edges: { id: string; from: string; on: string; to: string }[];
      };
      // Replace the single agent with a gate that reaches END and an agent
      // node that declares no `complete` outcome.
      graphJson.entries = ['check'];
      graphJson.nodes = [
        {
          id: 'check',
          kind: 'gate',
          label: 'Check',
          policy: { kind: 'expert-runs', op: 'gte', value: 0 },
          outcomes: ['matched', 'not-matched'],
          budget: { maxVisits: 1 },
        },
        {
          ...(graphJson.nodes[0] as Record<string, unknown>),
          id: 'impl',
          outcomes: ['blocked', 'replan'],
        },
      ];
      graphJson.edges = [
        { id: 'e1', from: 'check', on: 'matched', to: 'impl' },
        { id: 'e2', from: 'check', on: 'not-matched', to: 'END' },
        { id: 'e3', from: 'impl', on: 'blocked', to: 'END' },
        { id: 'e4', from: 'impl', on: 'replan', to: 'END' },
      ];
      writePlannerSubmission(h, JSON.stringify(graphJson));
      const launched = await bootstrapAndLaunchPlanner(h.deps, {
        ticketId: h.ticketId,
        stageAttempt: 0,
        approachId: GRAPH_APPROACH,
        projectSlug: 'e2e',
      });
      expect(launched.kind).toBe('launched');
      if (launched.kind !== 'launched') return;
      const submitted = JSON.parse(
        runGraphCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(launched.graphRunId),
            launchId: String(launched.plannerRunId),
            generation: launched.generation,
            capability: launched.capability,
          }),
          ['graph', 'submit'],
          () => NOW,
        ),
      ) as { ok: boolean };
      expect(submitted.ok).toBe(true);
      const accepted = acceptSubmittedPlan(h.deps, launched.graphRunId);
      expect(accepted.kind).toBe('accepted');
      confirmGraphRun(h.deps, launched.graphRunId);
      const driven = await claimAndDrive(h, launched.graphRunId);
      expect(driven.launched).toBe(1);
      const nodeRun = h.store.db
        .prepare('SELECT id, generation FROM approach_node_runs WHERE graph_run_id = ? AND node_id = ?')
        .get(launched.graphRunId, 'impl') as { id: number; generation: string | null };
      const out = JSON.parse(
        runNodeCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(launched.graphRunId),
            launchId: String(nodeRun.id),
            generation: nodeRun.generation!,
            capability: nodeCapabilityOf(h, nodeRun.id),
          }),
          ['node', 'complete'],
          () => NOW,
        ),
      ) as { ok: boolean; rejected?: string };
      expect(out.ok).toBe(false);
      expect(out.rejected).toBe('unknown-outcome');
      const row = h.store.db
        .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
        .get(nodeRun.id) as { status: string };
      expect(row.status).toBe('running');
    } finally {
      h.close();
    }
  });

  it('an agent node claiming NO repository is refused at acceptance, not parked at launch', async () => {
    // A node with no claim has no workspace to run in. Accepting such a plan
    // used to cost a full planner cycle and then dead-end the run at drive
    // time; the compile diagnostic refuses it while the replan loop can act.
    const h = makeHarness();
    try {
      const graphJson = JSON.parse(agentGraphJson()) as Record<string, unknown> & {
        nodes: Record<string, unknown>[];
      };
      graphJson.nodes[0]!['resources'] = { reads: [], writes: [] };
      writePlannerSubmission(h, JSON.stringify(graphJson));
      const launched = await bootstrapAndLaunchPlanner(h.deps, {
        ticketId: h.ticketId,
        stageAttempt: 0,
        approachId: GRAPH_APPROACH,
        projectSlug: 'e2e',
      });
      expect(launched.kind).toBe('launched');
      if (launched.kind !== 'launched') return;
      const submitted = JSON.parse(
        runGraphCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(launched.graphRunId),
            launchId: String(launched.plannerRunId),
            generation: launched.generation,
            capability: launched.capability,
          }),
          ['graph', 'submit'],
          () => NOW,
        ),
      ) as { ok: boolean };
      expect(submitted.ok).toBe(true);
      const accepted = acceptSubmittedPlan(h.deps, launched.graphRunId);
      expect(accepted.kind).not.toBe('accepted');
    } finally {
      h.close();
    }
  });

  it('a duplicate node completion is an idempotent rejection, never a double successor', async () => {
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      await claimAndDrive(h, graphRunId);
      const nodeRun = h.store.db
        .prepare('SELECT id, generation FROM approach_node_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number; generation: string | null };
      const env = graphEnv(h, {
        graphRunId: String(graphRunId),
        launchId: String(nodeRun.id),
        generation: nodeRun.generation!,
        capability: nodeCapabilityOf(h, nodeRun.id),
      });
      const first = JSON.parse(runNodeCommand(h.store, env, ['node', 'complete'], () => NOW)) as {
        ok: boolean;
      };
      expect(first.ok).toBe(true);
      const second = JSON.parse(runNodeCommand(h.store, env, ['node', 'complete'], () => NOW)) as {
        ok: boolean;
        rejected?: string;
      };
      expect(second.ok).toBe(false);
      expect(second.rejected).toBe('duplicate-submission');
      const row = h.store.db
        .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
        .get(nodeRun.id) as { status: string };
      expect(row.status).toBe('completing');
    } finally {
      h.close();
    }
  });

  it('a node replan WITHOUT an observable precondition is recorded as blocked, never routed', async () => {
    // Decision 27: a replan is honored only when the activation's causal
    // lineage contains an observable precondition (a failed deterministic
    // outcome, resource-claim-violated, integration-conflict). A bare replan
    // with no such evidence is recorded as evidence and treated as `blocked`.
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      await claimAndDrive(h, graphRunId);
      const nodeRun = h.store.db
        .prepare('SELECT id, generation FROM approach_node_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number; generation: string | null };
      const out = JSON.parse(
        runNodeCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(graphRunId),
            launchId: String(nodeRun.id),
            generation: nodeRun.generation!,
            capability: nodeCapabilityOf(h, nodeRun.id),
          }),
          ['node', 'replan', '--reason', 'because'],
          () => NOW,
        ),
      ) as { ok: boolean; outcome?: string };
      expect(out.ok).toBe(true);
      expect(out.outcome).toBe('blocked');
      const row = h.store.db
        .prepare('SELECT status, outcome, reason FROM approach_node_runs WHERE id = ?')
        .get(nodeRun.id) as { status: string; outcome: string; reason: string | null };
      expect(row.status).toBe('blocked');
      expect(row.outcome).toBe('blocked');
      expect(row.reason).toContain('without an observable precondition');
    } finally {
      h.close();
    }
  });

  it('an out-of-claim TRACKED change parks the node as resource-claim-violated and blocks the run', async () => {
    // The completion pipeline validates the ACTUAL diff against the node's
    // DECLARED writes BEFORE integrating. A tracked change outside the
    // declared claim must park the node (effective outcome null, no edge) and
    // block the graph — never silently widened.
    const h = makeHarness();
    try {
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      const driven = await claimAndDrive(h, graphRunId);
      expect(driven.launched).toBe(1);
      const nodeRun = h.store.db
        .prepare('SELECT id, generation FROM approach_node_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { id: number; generation: string | null };
      // The agent modified the TRACKED out-of-claim file in the workspace.
      writeFileSync(join(h.workspace, 'outside.ts'), 'x\ny\n');
      const out = JSON.parse(
        runNodeCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(graphRunId),
            launchId: String(nodeRun.id),
            generation: nodeRun.generation!,
            capability: nodeCapabilityOf(h, nodeRun.id),
          }),
          ['node', 'complete'],
          () => NOW,
        ),
      ) as { ok: boolean };
      expect(out.ok).toBe(true);
      const pipeline = await runCompletionPipeline(h.pipelineDeps, { graphRunId, nodeRunId: nodeRun.id });
      expect(pipeline.kind).toBe('claim-violated');
      const row = h.store.db
        .prepare('SELECT status, failure_category FROM approach_node_runs WHERE id = ?')
        .get(nodeRun.id) as { status: string; failure_category: string | null };
      expect(row.status).toBe('blocked');
      expect(row.failure_category).toBe('resource-claim-violated');
      const run = h.store.db
        .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { status: string; blocked_reason: string | null };
      expect(run.status).toBe('blocked');
      expect(run.blocked_reason).toContain('resource-claim-violated');
    } finally {
      h.close();
    }
  });

  it(
    'an out-of-claim UNTRACKED file violates the claim, exactly like a tracked one',
    async () => {
      // The change set used to be captured with `git diff --name-status HEAD`,
      // which lists only TRACKED changes. Untracked files were enumerated
      // separately (`git ls-files --others`) but used ONLY to decide what to
      // COPY into the canonical worktree — never validated against the node's
      // declared writes. So an agent that created a new file OUTSIDE its claim
      // was neither reported (claim validation saw an empty change set) nor
      // integrated (the copy is claim-filtered): the file was silently LOST and
      // no violation recorded. Capture now merges untracked paths into the same
      // validation, so this parks `resource-claim-violated` like any tracked
      // out-of-claim change.
      const h = makeHarness();
      try {
        const { graphRunId } = await bootAndSubmit(h);
        confirmGraphRun(h.deps, graphRunId);
        const driven = await claimAndDrive(h, graphRunId);
        expect(driven.launched).toBe(1);
        const nodeRun = h.store.db
          .prepare('SELECT id, generation FROM approach_node_runs WHERE graph_run_id = ?')
          .get(graphRunId) as { id: number; generation: string | null };
        // The agent created a NEW untracked file outside the declared `src/`
        // claim.
        writeFileSync(join(h.workspace, 'unclaimed-new.ts'), 'outside\n');
        runNodeCommand(
          h.store,
          graphEnv(h, {
            graphRunId: String(graphRunId),
            launchId: String(nodeRun.id),
            generation: nodeRun.generation!,
            capability: nodeCapabilityOf(h, nodeRun.id),
          }),
          ['node', 'complete'],
          () => NOW,
        );
        const pipeline = await runCompletionPipeline(h.pipelineDeps, {
          graphRunId,
          nodeRunId: nodeRun.id,
        });
        expect(pipeline.kind).toBe('claim-violated');
        const row = h.store.db
          .prepare('SELECT status, failure_category FROM approach_node_runs WHERE id = ?')
          .get(nodeRun.id) as { status: string; failure_category: string | null };
        expect(row.status).toBe('blocked');
        expect(row.failure_category).toBe('resource-claim-violated');
        // The canonical worktree must NOT contain the out-of-claim file.
        const exists = (() => {
          try {
            return readFileSync(join(h.worktree, 'unclaimed-new.ts')).length >= 0;
          } catch {
            return false;
          }
        })();
        expect(exists).toBe(false);
      } finally {
        h.close();
      }
    },
  );

  it(
    'an agent node still launches when the transport reports exactModel:false, because the adapter declares support',
    async () => {
      const h = makeHarness();
      try {
        h.transport.capabilities = () => ({ exactModel: false, attributedTermination: true });
        const { graphRunId } = await bootAndSubmit(h);
        confirmGraphRun(h.deps, graphRunId);
        const driven = await claimAndDrive(h, graphRunId);
        expect(driven.launched).toBe(1);
        const node = h.store.db
          .prepare('SELECT status FROM approach_node_runs WHERE graph_run_id = ?')
          .get(graphRunId) as { status: string };
        expect(node.status).toBe('running');
        expect(h.transport.started.filter((s) => s.sessionName?.startsWith('Karst node'))).toHaveLength(1);
      } finally {
        h.close();
      }
    },
  );

  it('an agent node whose claimed repository has no worktree parks with a reason naming it', async () => {
    const h = makeHarness();
    try {
      h.deps.cwdForRepo = () => undefined;
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      const driven = await claimAndDrive(h, graphRunId);
      expect(driven.launched).toBe(0);
      expect(driven.blocked).toBe(1);
      const node = h.store.db
        .prepare('SELECT status, failure_category, reason FROM approach_node_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { status: string; failure_category: string | null; reason: string | null };
      expect(node.status).toBe('blocked');
      expect(node.failure_category).toBe('failed-to-launch');
      expect(node.reason).toContain('no claimed repository resolves to a worktree');
    } finally {
      h.close();
    }
  });

  it('an agent node whose adapter does not declare exact-model support is red-blocked and never launched', async () => {
    const h = makeHarness();
    try {
      h.deps.adapterFor = () =>
        ({
          requiredBinary: 'opencode',
          runHeadless: async () => ({ sessionId: 's', verdict: null, raw: '' }),
          buildInteractiveCommand: () => ({ command: 'opencode', args: [], env: {} }),
          capabilities: { lifecycleEvents: true, resume: true },
          surfaces: {
            exactModel: unsupported(
              'this adapter cannot prevent model fallback or prove which model ran in the session',
            ),
          } as never,
        }) as AgentAdapter;
      const { graphRunId } = await bootAndSubmit(h);
      confirmGraphRun(h.deps, graphRunId);
      const driven = await claimAndDrive(h, graphRunId);
      expect(driven.launched).toBe(0);
      expect(driven.blocked).toBe(1);
      const node = h.store.db
        .prepare('SELECT status, failure_category FROM approach_node_runs WHERE graph_run_id = ?')
        .get(graphRunId) as { status: string; failure_category: string | null };
      expect(node.status).toBe('blocked');
      expect(node.failure_category).toBe('failed-to-launch');
      const run = h.store.db
        .prepare('SELECT status, blocked_reason FROM approach_graph_runs WHERE id = ?')
        .get(graphRunId) as { status: string; blocked_reason: string | null };
      expect(run.status).toBe('blocked');
      expect(run.blocked_reason).toContain('failed-to-launch');
      // No session was ever started.
      expect(h.transport.started.filter((s) => s.sessionName?.startsWith('Karst node'))).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it(
    'a node retried to `launching` by the recovery sweep is re-driven without a reload',
    async () => {
      const h = makeHarness();
      try {
        const supportedAdapterFor = h.deps.adapterFor;
        h.deps.adapterFor = () =>
          ({
            requiredBinary: 'opencode',
            runHeadless: async () => ({ sessionId: 's', verdict: null, raw: '' }),
            buildInteractiveCommand: () => ({ command: 'opencode', args: [], env: {} }),
            capabilities: { lifecycleEvents: true, resume: true },
            surfaces: {
              exactModel: unsupported(
                'this adapter cannot prevent model fallback or prove which model ran in the session',
              ),
            } as never,
          }) as AgentAdapter;
        const { graphRunId } = await bootAndSubmit(h);
        confirmGraphRun(h.deps, graphRunId);
        await claimAndDrive(h, graphRunId);
        h.deps.adapterFor = supportedAdapterFor;
        // The recovery sweep's retry: the parked node is re-armed to launch,
        // and the dead attempt's launch identity goes with it — exactly what
        // `retryNodeRuns` does through `clearLaunchIdentity`. The identity is
        // written by the CLAIM transaction now, so a re-arm that kept the dead
        // nonce would (correctly) not be launchable.
        h.store.db
          .prepare(
            `UPDATE approach_node_runs
             SET status = 'launching', launch_attempt = launch_attempt + 1,
                 owner_nonce = NULL, process_run_id = NULL, generation = NULL
             WHERE graph_run_id = ? AND status = 'blocked'`,
          )
          .run(graphRunId);
        h.store.db
          .prepare("UPDATE approach_graph_runs SET status = 'running', blocked_reason = NULL WHERE id = ?")
          .run(graphRunId);
        // A subsequent drive must re-launch the node — but the driver only
        // executes `ready` runs, so it stays `launching` (wedged).
        const driven = await driveReadyNodeRuns(h.deps, graphRunId);
        expect(driven.launched).toBe(1);
        const node = h.store.db
          .prepare('SELECT status FROM approach_node_runs WHERE graph_run_id = ?')
          .get(graphRunId) as { status: string };
        expect(node.status).toBe('running');
      } finally {
        h.close();
      }
    },
  );
});
