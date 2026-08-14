/**
 * The graph-run host driver — the missing launch seam.
 *
 * The graph runtime's state machine, coordinator sweep, completion pipeline,
 * workspace provider and supervised transport are all wired in the extension
 * host, but NOTHING ever STARTED a graph run: a graph-approach ticket opened a
 * plain implementation session instead of bootstrapping the planner (the
 * reported defect — "graph engineering not launched properly"). This module is
 * the orchestration that starts and drives a run, host-agnostic with injected
 * deps:
 *
 *  - `bootstrapAndLaunchPlanner` — create the graph run + bootstrap planner
 *    run, stamp generation/capability, launch the planner session.
 *  - `acceptSubmittedPlan` — compile the submitted `graph.json`, persist
 *    revision 1 + entry tokens + planner-produced artifacts, and move the run
 *    `planning → awaiting-confirmation | running` (per `confirmGeneratedGraph`).
 *  - `confirmGraphRun` — the human gate `awaiting-confirmation → running`.
 *  - `driveReadyNodeRuns` — execute claimed node runs: joins and gates and
 *    pinned commands complete deterministically in place; agent nodes get an
 *    isolated workspace and a supervised session.
 *  - `launchReplanPlanner` — launch the elected replan planner session.
 *
 * The completion side (the `completing` pipeline, `runCompletionPipeline`) and
 * the coordinator sweep are already wired by the host; the driver only produces
 * the state those surfaces consume. A node run the driver completes
 * deterministically goes `ready → completing → integrating → completed` and
 * emits its outcome successors in ONE transaction, exactly like the pipeline
 * does for a supervised agent node.
 *
 * Host-agnostic: db, transaction, transport, prompts, adapters, git and the
 * process runner are injected; no vscode, no workflow machine.
 */

import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { GraphDb } from '../../store/graph/transitions.js';
import {
  GRAPH_RUN_TRANSITIONS,
  NODE_RUN_TRANSITIONS,
  casStatus,
} from '../../store/graph/transitions.js';
import { graphRunById } from '../../store/graph/graphRuns.js';
import { beginBootstrapPlannerRun, finishPlanning, relaunchBootstrapPlannerRun } from './coordinator/plannerRun.js';
import { transitionPlannerRun } from '../../store/graph/plannerRuns.js';
import { createRevision } from '../../store/graph/revisions.js';
import { insertEntryTokens } from '../../store/graph/tokens.js';
import { parseGraphDocument, type GraphDocument } from './parse.js';
import {
  compileGraphDocument,
  type CompileContext,
  type CompileResult,
} from './compile.js';
import { submitReplanDocument } from './coordinator/replan.js';
import { completeActivation } from './coordinator/completion.js';
import { runJoinNode } from './executors/join.js';
import { evaluateGate, gateStateFromStore } from './executors/gate.js';
import { runCommandNode, type CommandNodeOutcome } from './executors/command.js';
import { runAgentNode } from './executors/agent.js';
import {
  createNodeWorkspace,
  type CreateNodeWorkspaceResult,
  type WorkspaceDomain,
} from './workspace/provider.js';
import { recordArtifactInstance } from './artifacts/resolve.js';
import { snapshotFile } from './artifacts/snapshot.js';
import type {
  SupervisedAgentSession,
  SupervisedCliTransport,
  SupervisedLaunchRequest,
} from './transport/supervisedCliTransport.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ProcessOutcome } from '../../workflow/gates/run.js';
import type { GraphApproachConfig, GraphCommandConfig } from '../../manifest/types.js';
import type { GraphPromptIdentity } from '../../agent/graphPrompts.js';
import { uuidv7 } from './coordinator/lineage.js';

/** SHA-256 over UTF-8 bytes — the capability hash the run stores. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface GraphDriverDeps {
  db: GraphDb;
  /** BEGIN IMMEDIATE-wrapped, all-or-nothing; a throw rolls back. */
  transaction: <T>(fn: () => T) => T;
  now: () => string;
  debug?: (message: string) => void;

  /** The ticket approach's `graph:` config (resolved through the built-in
   *  overlay seam). Absent → the approach is not a graph approach. */
  graphConfigOf: (approachId: string) => GraphApproachConfig | undefined;
  /** The graph run's artifact root (global storage; staging + snapshots). */
  artifactRootOf: (graphRunId: number) => string;
  /** Compose the graph session environment (KARST_GRAPH_*). */
  graphEnvOf: (input: {
    launchId: number;
    graphRunId: number;
    revisionId: number;
    generation: string;
    capability: string;
    artifactRoot: string;
  }) => Record<string, string>;
  /** The instrumented adapter for a provider. */
  adapterFor: (provider: string) => AgentAdapter;
  /** The supervised transport (graph sessions bypass SessionManager). The
   *  concrete transport's `start` accepts a `SupervisedLaunchRequest` (adapter
   *  + interactive) even though the `AgentTransport` interface types it as
   *  `AgentNodeLaunch` — this seam carries the concrete shape. */
  transport: SupervisedCliTransport & {
    start(request: SupervisedLaunchRequest): Promise<SupervisedAgentSession>;
  };

  /** The effective prompt bytes for a graph prompt identity
   *  (`karst-graph-planner` / `karst-graph-node`). */
  promptBytesOf: (identity: GraphPromptIdentity) => Uint8Array | undefined;
  /** Content-addressed snapshot write under the graph run's artifact root. */
  writeSnapshot: (graphRunId: number, relativePath: string, bytes: Uint8Array) => void;
  /** Read a file under the graph run's artifact root. */
  readBytes: (graphRunId: number, relativePath: string) => Uint8Array | undefined;
  /** Current ticket context markdown for seeding a session. */
  ticketContextOf: (ticketId: number) => string;
  /** The compile context (profiles/commands/repositories/maxima). The parsed
   *  document is supplied so `artifactFileExists` can map artifact ids to
   *  their declared staging paths under the artifact root. */
  compileContextOf: (graphRunId: number, document?: GraphDocument) => CompileContext;
  /** The physical domain keys a replan-submitting document's node claims
   *  (the lease-deferral check); absent → replan submissions are refused
   *  rather than guessed. */
  physicalDomainsOf?: (graphRunId: number, document: GraphDocument, nodeId: string) => string[];
  /** The pinned command definition for a command node id. */
  commandDefOf: (graphRunId: number, commandId: string) => GraphCommandConfig | undefined;
  /** Async spawn (gates/run.ts `runProcess`); `spawnSync` is banned here. */
  runProcess: (command: string, args: readonly string[], cwd: string) => Promise<ProcessOutcome>;

  /** The canonical worktree for the planner session (first repo). */
  plannerCwdOf: (graphRunId: number) => { repo: string; cwd: string } | undefined;
  /** The canonical worktree path for a repo of a graph run's ticket. */
  cwdForRepo: (graphRunId: number, repo: string) => string | undefined;
  /** The node's isolated workspace clone for a repo; undefined → canonical. */
  workspaceOf: (graphRunId: number, nodeRunId: number, repo: string) => string | undefined;
  /** Create (or re-create) an agent node's isolated workspace clones. */
  createWorkspace: (input: {
    graphRunId: number;
    nodeRunId: number;
    domains: WorkspaceDomain[];
  }) => Promise<CreateNodeWorkspaceResult>;
  /** The session's display name. */
  sessionNameOf: (runId: number, kind: 'planner' | 'node') => string;
  /** The shell command that reports a node outcome (`karst node …`). */
  cliNodeCompletionCommand: () => string;
}

/* ------------------------------------------------------------------ */
/* Bootstrap + planner launch                                          */
/* ------------------------------------------------------------------ */

export type BootstrapPlannerResult =
  | {
      kind: 'launched';
      graphRunId: number;
      plannerRunId: number;
      generation: string;
      capability: string;
      session: SupervisedAgentSession;
    }
  | { kind: 'no-config'; reason: string }
  | { kind: 'instructions-missing'; reason: string }
  | { kind: 'failed'; reason: string };

export interface BootstrapPlannerInput {
  ticketId: number;
  stageAttempt: number;
  approachId: string;
  projectSlug: string;
}

/** Resolve a graph config profile name to provider/model/effort. */
export function resolveProfileFor(
  config: GraphApproachConfig,
  profile: string,
): { provider: string; model?: string; effort?: string } | undefined {
  const p = config.profiles[profile];
  if (!p) return undefined;
  return { provider: p.provider, model: p.model, effort: p.effort };
}

/**
 * Create the graph run + bootstrap planner run (snapshotting the effective
 * planner prompt), stamp generation/capability, and launch the planner
 * session in the ticket's canonical worktree. Never falls through to a plain
 * session: a graph-approach launch either starts the planner or names why not.
 */
export async function bootstrapAndLaunchPlanner(
  deps: GraphDriverDeps,
  input: BootstrapPlannerInput,
): Promise<BootstrapPlannerResult> {
  const config = deps.graphConfigOf(input.approachId);
  if (!config) {
    return { kind: 'no-config', reason: `approach "${input.approachId}" declares no graph: block` };
  }
  const promptPath = config.planner.prompt?.artifact ?? 'skills/graph-planner/SKILL.md';
  const promptBytes = deps.promptBytesOf('karst-graph-planner');
  if (promptBytes === undefined) {
    return {
      kind: 'instructions-missing',
      reason: `cannot read the graph planner prompt at "${promptPath}"`,
    };
  }
  const begun = beginBootstrapPlannerRun(
    {
      db: deps.db,
      transaction: deps.transaction,
      promptPath,
      readPrompt: (path) => (path === promptPath ? promptBytes : undefined),
      writeSnapshot: deps.writeSnapshot,
      projectSlug: input.projectSlug,
      now: deps.now,
    },
    { ticketId: input.ticketId, stageAttempt: input.stageAttempt, approachId: input.approachId },
  );
  if (!begun.ok) {
    return { kind: 'instructions-missing', reason: begun.reason };
  }
  const { graphRunId, plannerRunId } = begun;
  const resolved = resolveProfileFor(config, config.planner.profile);
  const capability = randomBytes(32).toString('hex');
  const generation = uuidv7();
  const stamped = deps.transaction(() => {
    deps.db
      .prepare('UPDATE approach_planner_runs SET generation = ?, capability_hash = ? WHERE id = ?')
      .run(generation, sha256Hex(new TextEncoder().encode(capability)), plannerRunId);
    return (
      transitionPlannerRun(deps.db, plannerRunId, 'ready', 'launching')
      && transitionPlannerRun(deps.db, plannerRunId, 'launching', 'running')
    );
  });
  if (!stamped) {
    return { kind: 'failed', reason: `planner run ${plannerRunId} already moved (a second window?)` };
  }
  if (!resolved) {
    return {
      kind: 'failed',
      reason: `planner profile "${config.planner.profile}" is not configured in approach "${input.approachId}"`,
    };
  }
  const workspace = deps.plannerCwdOf(graphRunId);
  if (!workspace) {
    return { kind: 'failed', reason: `no worktree registered for graph run ${graphRunId}` };
  }
  const artifactRoot = deps.artifactRootOf(graphRunId);
  const env = deps.graphEnvOf({
    launchId: plannerRunId,
    graphRunId,
    revisionId: 0,
    generation,
    capability,
    artifactRoot,
  });
  const prompt = [
    new TextDecoder().decode(promptBytes),
    deps.ticketContextOf(input.ticketId),
    'Write your plan artifacts and `graph.json` under the artifact root (env `KARST_GRAPH_ARTIFACT_ROOT`), then exit immediately — karst compiles and runs the graph after you close. Do not wait for further input.',
  ].join('\n\n');
  const session = await deps.transport.start({
    nodeRunId: plannerRunId,
    ticketId: input.ticketId,
    graphRunId,
    repo: workspace.repo,
    cwd: workspace.cwd,
    generation,
    sessionName: deps.sessionNameOf(plannerRunId, 'planner'),
    graphEnv: env,
    adapter: deps.adapterFor(resolved.provider),
    interactive: {
      cwd: workspace.cwd,
      initialPrompt: prompt,
      model: resolved.model,
      effort: resolved.effort,
      sessionName: deps.sessionNameOf(plannerRunId, 'planner'),
    },
  } satisfies SupervisedLaunchRequest);
  deps.debug?.(
    `[graph] run ${graphRunId}: bootstrap planner ${plannerRunId} launched (${resolved.provider}/${resolved.model ?? 'default'})`,
  );
  return { kind: 'launched', graphRunId, plannerRunId, generation, capability, session };
}

export type RelaunchBootstrapPlannerResult =
  | {
      kind: 'launched';
      graphRunId: number;
      plannerRunId: number;
      generation: string;
      capability: string;
      session: SupervisedAgentSession;
    }
  | { kind: 'no-op' }
  | { kind: 'instructions-missing'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * Relaunch a planning run's bootstrap planner after its session died (the
 * reconcile crash matrix's response): allocate a NEW bootstrap planner run on
 * the EXISTING planning run and launch its session, mirroring
 * `bootstrapAndLaunchPlanner` minus the graph-run creation. A run that left
 * `planning` is a `no-op` — its new planner's submission could never be
 * accepted. The host binds this to the reconcile `relaunchPlanner` callback.
 */
export async function relaunchBootstrapPlanner(
  deps: GraphDriverDeps,
  input: { graphRunId: number },
): Promise<RelaunchBootstrapPlannerResult> {
  const run = graphRunById(deps.db, input.graphRunId);
  if (!run || run.status !== 'planning') return { kind: 'no-op' };
  const config = deps.graphConfigOf(run.approach_id);
  if (!config) {
    return { kind: 'failed', reason: `approach "${run.approach_id}" declares no graph: block` };
  }
  const promptPath = config.planner.prompt?.artifact ?? 'skills/graph-planner/SKILL.md';
  const promptBytes = deps.promptBytesOf('karst-graph-planner');
  if (promptBytes === undefined) {
    return {
      kind: 'instructions-missing',
      reason: `cannot read the graph planner prompt at "${promptPath}"`,
    };
  }
  const begun = relaunchBootstrapPlannerRun(
    {
      db: deps.db,
      transaction: deps.transaction,
      promptPath,
      readPrompt: (path) => (path === promptPath ? promptBytes : undefined),
      writeSnapshot: deps.writeSnapshot,
      projectSlug: '', // unused by the relaunch path (no graph run is created)
      now: deps.now,
    },
    { graphRunId: input.graphRunId },
  );
  if (!begun.ok) {
    return begun.code === 'instructions-missing'
      ? { kind: 'instructions-missing', reason: begun.reason }
      : { kind: 'failed', reason: begun.reason };
  }
  const { plannerRunId } = begun;
  const resolved = resolveProfileFor(config, config.planner.profile);
  const capability = randomBytes(32).toString('hex');
  const generation = uuidv7();
  const stamped = deps.transaction(() => {
    deps.db
      .prepare('UPDATE approach_planner_runs SET generation = ?, capability_hash = ? WHERE id = ?')
      .run(generation, sha256Hex(new TextEncoder().encode(capability)), plannerRunId);
    return (
      transitionPlannerRun(deps.db, plannerRunId, 'ready', 'launching')
      && transitionPlannerRun(deps.db, plannerRunId, 'launching', 'running')
    );
  });
  if (!stamped) {
    return { kind: 'failed', reason: `planner run ${plannerRunId} already moved (a second window?)` };
  }
  if (!resolved) {
    return {
      kind: 'failed',
      reason: `planner profile "${config.planner.profile}" is not configured in approach "${run.approach_id}"`,
    };
  }
  const workspace = deps.plannerCwdOf(input.graphRunId);
  if (!workspace) {
    return { kind: 'failed', reason: `no worktree registered for graph run ${input.graphRunId}` };
  }
  const artifactRoot = deps.artifactRootOf(input.graphRunId);
  const env = deps.graphEnvOf({
    launchId: plannerRunId,
    graphRunId: input.graphRunId,
    revisionId: 0,
    generation,
    capability,
    artifactRoot,
  });
  const prompt = [
    new TextDecoder().decode(promptBytes),
    deps.ticketContextOf(run.ticket_id),
    'Write your plan artifacts and `graph.json` under the artifact root (env `KARST_GRAPH_ARTIFACT_ROOT`), then exit immediately — karst compiles and runs the graph after you close. Do not wait for further input.',
  ].join('\n\n');
  const session = await deps.transport.start({
    nodeRunId: plannerRunId,
    ticketId: run.ticket_id,
    graphRunId: input.graphRunId,
    repo: workspace.repo,
    cwd: workspace.cwd,
    generation,
    sessionName: deps.sessionNameOf(plannerRunId, 'planner'),
    graphEnv: env,
    adapter: deps.adapterFor(resolved.provider),
    interactive: {
      cwd: workspace.cwd,
      initialPrompt: prompt,
      model: resolved.model,
      effort: resolved.effort,
      sessionName: deps.sessionNameOf(plannerRunId, 'planner'),
    },
  } satisfies SupervisedLaunchRequest);
  deps.debug?.(
    `[graph] run ${input.graphRunId}: bootstrap planner ${plannerRunId} relaunched (${resolved.provider}/${resolved.model ?? 'default'})`,
  );
  return {
    kind: 'launched',
    graphRunId: input.graphRunId,
    plannerRunId,
    generation,
    capability,
    session,
  };
}

/* ------------------------------------------------------------------ */
/* Plan acceptance + confirmation                                      */
/* ------------------------------------------------------------------ */

export type AcceptPlanResult =
  | { kind: 'accepted'; revisionId: number; revisionNumber: number }
  | { kind: 'no-op' }
  | { kind: 'rejected'; diagnostics: string[] };

/**
 * Compile a submitted bootstrap plan: read the `graph.json` snapshot the
 * planner's `graph submit` content-addressed, parse + compile it, and on
 * acceptance persist revision 1 (with its planner artifacts and entry tokens)
 * and move the run `planning → awaiting-confirmation | running`. A rejected
 * document parks the run at `blocked` with `graph-plan-invalid` — the state
 * the graph-aware Resume turns into a replan election.
 */
export function acceptSubmittedPlan(deps: GraphDriverDeps, graphRunId: number): AcceptPlanResult {
  const run = graphRunById(deps.db, graphRunId);
  if (!run || run.status !== 'planning') return { kind: 'no-op' };
  const planner = deps.db
    .prepare(
      `SELECT id, status, graph_snapshot_id FROM approach_planner_runs
       WHERE graph_run_id = ? AND kind = 'bootstrap' AND status = 'submitted'
       ORDER BY id LIMIT 1`,
    )
    .get(graphRunId) as
    | { id: number; status: string; graph_snapshot_id: string | null }
    | undefined;
  if (!planner || !planner.graph_snapshot_id) return { kind: 'no-op' };

  const snapshotPath = join('snapshots', `${planner.graph_snapshot_id}.json`);
  const bytes = deps.readBytes(graphRunId, snapshotPath);
  if (bytes === undefined) {
    return blockInvalidPlan(deps, graphRunId, planner.id, [
      'planner-no-output: submitted snapshot is unreadable',
    ]);
  }
  const parsed = parseGraphDocument(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    return blockInvalidPlan(
      deps,
      graphRunId,
      planner.id,
      parsed.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  const compiled = compileGraphDocument(parsed.document, deps.compileContextOf(graphRunId, parsed.document));
  if (!compiled.ok) {
    return blockInvalidPlan(
      deps,
      graphRunId,
      planner.id,
      compiled.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  const { compiled: c } = compiled;
  const confirm = configConfirmOf(deps, run.approach_id);
  const revisionNumber = 1;
  const revisionId = deps.transaction(() => {
    const id = createRevision(deps.db, {
      graphRunId,
      revisionNumber,
      canonicalGraph: c.canonicalJson,
      fingerprint: c.fingerprint,
      status: 'active',
      now: deps.now(),
    });
    deps.db
      .prepare(
        `UPDATE approach_graph_revisions
         SET planner_graph_snapshot_id = ?, planner_artifact_snapshot_id = ?
         WHERE id = ?`,
      )
      .run(c.fingerprint, planner.graph_snapshot_id ?? null, id);
    recordPlannerArtifacts(deps, graphRunId, id, planner.id, c.document);
    insertEntryTokens(
      deps.db,
      id,
      c.document.entries.map((nodeId) => ({
        edgeId: `entry-${nodeId}`,
        destinationNodeId: nodeId,
        destinationEnd: false,
      })),
      deps.now(),
    );
    finishPlanning(deps.db, graphRunId, confirm);
    return id;
  });
  deps.debug?.(
    `[graph] run ${graphRunId}: bootstrap plan accepted — revision ${revisionId} (#${revisionNumber}) → ${confirm ? 'awaiting-confirmation' : 'running'}`,
  );
  return { kind: 'accepted', revisionId, revisionNumber };
}

function configConfirmOf(deps: GraphDriverDeps, approachId: string): boolean {
  return deps.graphConfigOf(approachId)?.limits.confirmGeneratedGraph ?? true;
}

export type AcceptReplanResult =
  | { kind: 'accepted'; revisionId: number; revisionNumber: number }
  | { kind: 'no-op' }
  | { kind: 'rejected'; reason: string };

/**
 * Accept a submitted REPLAN: a `draining` run whose replan planner submitted
 * graph.json gets revision N+1 persisted (superseding N), its entry tokens
 * created, and the run resumed `draining → running` — the `submitReplanDocument`
 * protocol. A rejected document marks the late/rejected run and leaves the
 * run blocked for the next recovery attempt.
 */
export function acceptSubmittedReplan(
  deps: GraphDriverDeps,
  graphRunId: number,
): AcceptReplanResult {
  const run = graphRunById(deps.db, graphRunId);
  if (!run || run.status !== 'draining') return { kind: 'no-op' };
  const planner = deps.db
    .prepare(
      `SELECT id, status, graph_snapshot_id FROM approach_planner_runs
       WHERE graph_run_id = ? AND kind = 'replan' AND status = 'submitted'
       ORDER BY id LIMIT 1`,
    )
    .get(graphRunId) as
    | { id: number; status: string; graph_snapshot_id: string | null }
    | undefined;
  if (!planner || !planner.graph_snapshot_id) return { kind: 'no-op' };
  const bytes = deps.readBytes(graphRunId, join('snapshots', `${planner.graph_snapshot_id}.json`));
  if (bytes === undefined) return { kind: 'rejected', reason: 'submitted replan snapshot is unreadable' };
  const parsed = parseGraphDocument(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    return { kind: 'rejected', reason: parsed.diagnostics[0]?.message ?? 'invalid document' };
  }
  const compileDocument = (document: GraphDocument): CompileResult =>
    compileGraphDocument(document, deps.compileContextOf(graphRunId, document));
  const physicalDomainsOf = deps.physicalDomainsOf
    ? (nodeId: string): string[] => deps.physicalDomainsOf!(graphRunId, parsed.document, nodeId)
    : (): string[] => [];
  const result = submitReplanDocument(
    {
      db: deps.db,
      transaction: deps.transaction,
      now: deps.now,
      debug: deps.debug,
      compileDocument,
      physicalDomainsOf,
    },
    { plannerRunId: planner.id, document: parsed.document, rationale: 'replan accepted by recovery' },
  );
  if (!result.ok) return { kind: 'rejected', reason: result.reason };
  deps.debug?.(
    `[graph] run ${graphRunId}: replan accepted — revision ${result.revisionId} (#${result.revisionNumber}), ${result.deferredNodeIds.length} deferred node(s)`,
  );
  return { kind: 'accepted', revisionId: result.revisionId, revisionNumber: result.revisionNumber };
}

/** Snapshot + record the planner-produced artifacts (producer `$planner`) the
 *  accepted graph declares, so agent nodes resolve them as instructions/inputs. */
function recordPlannerArtifacts(
  deps: GraphDriverDeps,
  graphRunId: number,
  revisionId: number,
  plannerRunId: number,
  document: GraphDocument,
): void {
  const root = deps.artifactRootOf(graphRunId);
  if (!root) return;
  for (const artifact of document.artifacts) {
    if (artifact.producer !== '$planner') continue;
    const snap = snapshotFile(
      { path: join(root, artifact.path), maxBytes: artifact.maxBytes, mediaType: artifact.mediaType },
      root,
    );
    if (!snap.ok) {
      deps.debug?.(
        `[graph] run ${graphRunId}: planner artifact "${artifact.id}" not recorded (${snap.code}: ${snap.reason})`,
      );
      continue;
    }
    recordArtifactInstance(deps.db, {
      graphRunId,
      revisionId,
      artifactId: artifact.id,
      producerPlannerRunId: plannerRunId,
      producerNodeRunId: null,
      forkLineage: null,
      snapshotPath: join(root, snap.sha256),
      sha256: snap.sha256,
      mediaType: artifact.mediaType,
      byteSize: snap.size,
      now: deps.now(),
    });
  }
}

/** Park a planning run whose plan was rejected: `planning → blocked` with the
 *  compile diagnostics written beside the snapshot (the graph-aware Resume
 *  reads the reason and elects a replan). */
function blockInvalidPlan(
  deps: GraphDriverDeps,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
): AcceptPlanResult {
  const reason = `graph-plan-invalid: ${diagnostics[0] ?? 'planner produced an invalid document'}`;
  const blocked = deps.transaction(() => {
    deps.db
      .prepare('UPDATE approach_planner_runs SET reason = ?, ended_at = ? WHERE id = ?')
      .run(reason.slice(0, 2000), deps.now(), plannerRunId);
    if (!casStatus(deps.db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, 'planning', 'blocked')) {
      return false;
    }
    deps.db
      .prepare('UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?')
      .run(reason, deps.now(), graphRunId);
    return true;
  });
  if (blocked) {
    try {
      deps.writeSnapshot(
        graphRunId,
        `diagnostics/planner-${plannerRunId}.json`,
        new TextEncoder().encode(JSON.stringify(diagnostics, null, 2)),
      );
    } catch (err) {
      deps.debug?.(`[graph] run ${graphRunId}: diagnostics write failed (${String(err)})`);
    }
    deps.debug?.(`[graph] run ${graphRunId}: bootstrap plan rejected — ${reason}`);
  }
  return { kind: 'rejected', diagnostics };
}

/** The human gate: `awaiting-confirmation → running`. False when already moved. */
export function confirmGraphRun(deps: GraphDriverDeps, graphRunId: number): boolean {
  const ok = deps.transaction(() =>
    casStatus(
      deps.db,
      'approach_graph_runs',
      GRAPH_RUN_TRANSITIONS,
      graphRunId,
      'awaiting-confirmation',
      'running',
    ),
  );
  if (ok) deps.debug?.(`[graph] run ${graphRunId}: confirmed → running`);
  return ok;
}

/* ------------------------------------------------------------------ */
/* Node execution                                                      */
/* ------------------------------------------------------------------ */

export interface DriveReadyNodesResult {
  launched: number;
  completed: number;
  blocked: number;
}

interface ReadyNodeRow {
  id: number;
  revision_id: number;
  node_id: string;
}

/** Execute every `ready` node run of a `running` graph run, in id order. A
 *  join/gate/command completes deterministically in one transaction; an agent
 *  node gets its workspace and a supervised session and stays `running` until
 *  its agent reports an outcome via `karst node …`. */
export async function driveReadyNodeRuns(
  deps: GraphDriverDeps,
  graphRunId: number,
): Promise<DriveReadyNodesResult> {
  const run = graphRunById(deps.db, graphRunId);
  if (!run || run.status !== 'running') return { launched: 0, completed: 0, blocked: 0 };
  const ready = deps.db
    .prepare(
      `SELECT id, revision_id, node_id FROM approach_node_runs
       WHERE graph_run_id = ? AND status = 'ready' ORDER BY id`,
    )
    .all(graphRunId) as ReadyNodeRow[];
  const result: DriveReadyNodesResult = { launched: 0, completed: 0, blocked: 0 };
  for (const row of ready) {
    try {
      const outcome = await executeReadyNode(deps, graphRunId, row);
      if (outcome === 'launched') result.launched += 1;
      else if (outcome === 'completed') result.completed += 1;
      else result.blocked += 1;
    } catch (err) {
      deps.debug?.(`[graph] run ${graphRunId}: node run ${row.id} failed to execute (${String(err)})`);
      parkLaunchFailure(deps, graphRunId, row.id);
      result.blocked += 1;
    }
  }
  return result;
}

type ReadyNodeOutcome = 'launched' | 'completed' | 'blocked';

async function executeReadyNode(
  deps: GraphDriverDeps,
  graphRunId: number,
  row: ReadyNodeRow,
): Promise<ReadyNodeOutcome> {
  const revision = deps.db
    .prepare('SELECT canonical_graph FROM approach_graph_revisions WHERE id = ?')
    .get(row.revision_id) as { canonical_graph: string } | undefined;
  if (!revision) return 'blocked';
  const parsed = parseGraphDocument(revision.canonical_graph);
  if (!parsed.ok) return 'blocked';
  const node = parsed.document.nodes.find((n) => n.id === row.node_id);
  if (!node) return 'blocked';

  if (node.kind === 'join') {
    const arrivals = (
      deps.db
        .prepare(
          "SELECT id FROM approach_graph_tokens WHERE claiming_node_run_id = ? AND status = 'claimed'",
        )
        .all(row.id) as { id: number }[]
    ).map((t) => t.id);
    const consumed = runJoinNode(
      { db: deps.db, transaction: deps.transaction, now: deps.now },
      { nodeRunId: row.id, arrivalTokenIds: arrivals },
    );
    return consumed ? 'completed' : 'blocked';
  }

  if (node.kind === 'gate') {
    const verdict = evaluateGate(node.policy, gateStateFromStore(deps.db, graphRunId, row.revision_id));
    completeDeterministic(deps, row.id, verdict);
    deps.debug?.(`[graph] run ${graphRunId}: gate node ${row.node_id} → ${verdict}`);
    return 'completed';
  }

  if (node.kind === 'command') {
    const def = deps.commandDefOf(graphRunId, node.command);
    if (!def) {
      completeDeterministic(deps, row.id, 'infrastructure-error');
      return 'completed';
    }
    const cwdFor = (repo: string): string =>
      deps.workspaceOf(graphRunId, row.id, repo) ?? deps.cwdForRepo(graphRunId, repo) ?? '';
    const outcome = await runCommandNode(def.command, def.args, node.repositories, def.env ?? {}, {
      cwdFor,
      run: deps.runProcess,
      timeoutMs: def.timeoutSeconds * 1000,
      onDebug: deps.debug,
    });
    const effective: CommandNodeOutcome = outcome.outcome;
    completeDeterministic(deps, row.id, effective);
    deps.debug?.(`[graph] run ${graphRunId}: command node ${row.node_id} → ${effective}`);
    return 'completed';
  }

  // Agent node: workspace + supervised session, capability-authenticated.
  const approachId = runApproachId(deps, graphRunId);
  const config = deps.graphConfigOf(approachId);
  const resolved = config ? resolveProfileFor(config, node.profile) : undefined;
  if (!resolved) {
    completeDeterministic(deps, row.id, 'blocked');
    deps.debug?.(
      `[graph] run ${graphRunId}: agent node ${row.node_id} blocked — profile "${node.profile}" unresolved`,
    );
    return 'completed';
  }
  const workspace = await prepareAgentWorkspace(deps, graphRunId, row, node);
  if (workspace.kind !== 'created') {
    parkLaunchFailure(deps, graphRunId, row.id);
    return 'blocked';
  }
  const repo = workspace.paths[0]?.repoName;
  const cwd = workspace.paths[0]?.cwd;
  if (!repo || !cwd) {
    parkLaunchFailure(deps, graphRunId, row.id);
    return 'blocked';
  }
  const nodeCapability = randomBytes(32).toString('hex');
  const nodeGeneration = uuidv7();
  const claimed = deps.transaction(() => {
    deps.db
      .prepare('UPDATE approach_node_runs SET generation = ?, capability_hash = ? WHERE id = ?')
      .run(nodeGeneration, sha256Hex(new TextEncoder().encode(nodeCapability)), row.id);
    return casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, row.id, 'ready', 'launching');
  });
  if (!claimed) {
    parkLaunchFailure(deps, graphRunId, row.id);
    return 'blocked';
  }
  const runResult = await runAgentNode(
    {
      transport: deps.transport,
      resolveProfile: (profile) => resolveProfileFor(config!, profile) ?? { provider: 'opencode' },
      readInstructions: (path) => {
        const bytes = path ? deps.readBytes(graphRunId, path) : undefined;
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      },
      readInputs: (paths) =>
        paths
          .map((p) => {
            const bytes = deps.readBytes(graphRunId, p);
            return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
          })
          .filter((s): s is string => s !== undefined),
      ticketContext: deps.ticketContextOf(runTicketId(deps, graphRunId)),
      nodePrompt: nodePromptWithReporter(deps),
      promptHash: (text) => sha256Hex(new TextEncoder().encode(text)),
      graphEnv: (launch) =>
        deps.graphEnvOf({
          launchId: launch.nodeRunId,
          graphRunId: launch.graphRunId,
          revisionId: launch.revisionId,
          generation: nodeGeneration,
          capability: nodeCapability,
          artifactRoot: deps.artifactRootOf(graphRunId),
        }),
      onDebug: deps.debug,
    },
    {
      nodeRunId: row.id,
      ticketId: runTicketId(deps, graphRunId),
      graphRunId,
      revisionId: row.revision_id,
      adapter: deps.adapterFor(resolved.provider),
      repo,
      cwd,
      node,
      generation: nodeGeneration,
      instructionsSnapshot: instructionsSnapshotOf(
        deps,
        graphRunId,
        row.revision_id,
        node.instructionsArtifact,
      ),
      inputSnapshots: inputSnapshotsOf(deps, graphRunId, row.revision_id, node.inputs),
    },
  );
  if (runResult.kind === 'red-blocked') {
    parkLaunchFailure(deps, graphRunId, row.id);
    return 'blocked';
  }
  deps.transaction(() => {
    casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, row.id, 'launching', 'running');
  });
  deps.debug?.(
    `[graph] run ${graphRunId}: agent node ${row.node_id} (run ${row.id}) launched in ${cwd}`,
  );
  return 'launched';
}

function runApproachId(deps: GraphDriverDeps, graphRunId: number): string {
  return (
    deps.db.prepare('SELECT approach_id FROM approach_graph_runs WHERE id = ?').get(graphRunId) as {
      approach_id: string;
    }
  ).approach_id;
}

function runTicketId(deps: GraphDriverDeps, graphRunId: number): number {
  return (
    deps.db.prepare('SELECT ticket_id FROM approach_graph_runs WHERE id = ?').get(graphRunId) as {
      ticket_id: number;
    }
  ).ticket_id;
}

/** The isolated workspace clone(s) for an agent node's declared repos. Falls
 *  back to no clone (empty path list) only when the graph declares no repos —
 *  the V1 canonical model. */
async function prepareAgentWorkspace(
  deps: GraphDriverDeps,
  graphRunId: number,
  row: ReadyNodeRow,
  node: {
    resources: { reads: { repo: string; paths: string[] }[]; writes: { repo: string; paths: string[] }[] };
  },
): Promise<CreateNodeWorkspaceResult> {
  const repos = [
    ...new Set([...node.resources.reads, ...node.resources.writes].map((c) => c.repo)),
  ];
  const domains: WorkspaceDomain[] = [];
  for (const repo of repos) {
    const cwd = deps.cwdForRepo(graphRunId, repo);
    if (!cwd) continue;
    let baseCommit = '';
    try {
      const base = deps.db
        .prepare('SELECT base_heads FROM approach_node_runs WHERE id = ?')
        .get(row.id) as { base_heads: string | null } | undefined;
      const heads = base?.base_heads ? (JSON.parse(base.base_heads) as { commit: string }[]) : [];
      baseCommit = heads[0]?.commit ?? '';
    } catch {
      baseCommit = '';
    }
    domains.push({ repoName: repo, canonicalWorktreePath: cwd, gitCommonDir: null, baseCommit });
  }
  if (domains.length === 0) return { kind: 'created', paths: [] };
  return deps.createWorkspace({ graphRunId, nodeRunId: row.id, domains });
}

/** The instructions artifact snapshot path for an agent node — the newest
 *  planner-produced instance of the node's `instructionsArtifact`. */
function instructionsSnapshotOf(
  deps: GraphDriverDeps,
  graphRunId: number,
  revisionId: number,
  artifactId: string,
): string {
  const row = deps.db
    .prepare(
      `SELECT snapshot_path FROM approach_artifact_instances
       WHERE graph_run_id = ? AND revision_id = ? AND artifact_id = ?
         AND producer_planner_run_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(graphRunId, revisionId, artifactId) as { snapshot_path: string } | undefined;
  return row?.snapshot_path ?? '';
}

/** The declared input artifact snapshot paths, in declaration order
 *  (best-effort; a missing input parks via the completion's artifact gate). */
function inputSnapshotsOf(
  deps: GraphDriverDeps,
  graphRunId: number,
  revisionId: number,
  inputIds: readonly string[],
): string[] {
  if (inputIds.length === 0) return [];
  const paths: string[] = [];
  for (const id of inputIds) {
    const row = deps.db
      .prepare(
        `SELECT snapshot_path FROM approach_artifact_instances
         WHERE graph_run_id = ? AND revision_id = ? AND artifact_id = ?
           AND (producer_planner_run_id IS NOT NULL
                OR (producer_node_run_id IS NOT NULL AND fork_lineage IS NOT NULL))
         ORDER BY id DESC LIMIT 1`,
      )
      .get(graphRunId, revisionId, id) as { snapshot_path: string } | undefined;
    if (row) paths.push(row.snapshot_path);
  }
  return paths;
}

/** The karst-graph-node base prompt with the reporting instruction appended
 *  (the agent must report its outcome via the capability-authenticated CLI). */
function nodePromptWithReporter(deps: GraphDriverDeps): string {
  const bytes = deps.promptBytesOf('karst-graph-node');
  const base = bytes === undefined ? '' : new TextDecoder().decode(bytes);
  return `${base}\n\nReport your outcome with:\n\`${deps.cliNodeCompletionCommand()}\``;
}

/** Complete a deterministic node (gate/command): one transaction transitions
 *  `ready → completing → integrating → completed`, records the effective
 *  outcome, releases the command's process slot, and emits the outcome
 *  successors through `completeActivation` (pass-through transaction). */
function completeDeterministic(deps: GraphDriverDeps, nodeRunId: number, effectiveOutcome: string): void {
  deps.transaction(() => {
    if (!casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, nodeRunId, 'ready', 'completing')) {
      return;
    }
    deps.db
      .prepare('UPDATE approach_node_runs SET outcome = ?, ended_at = ? WHERE id = ?')
      .run(effectiveOutcome, deps.now(), nodeRunId);
    casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, nodeRunId, 'completing', 'integrating');
    casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, nodeRunId, 'integrating', 'completed');
    completeActivation(
      { db: deps.db, transaction: <T>(fn: () => T): T => fn(), now: deps.now },
      { nodeRunId, effectiveOutcome },
    );
    // A command node reserved a process slot at claim; release it on its
    // deterministic completion. The guarded update touches only command runs.
    deps.db
      .prepare(
        `UPDATE approach_graph_runs
         SET active_processes = MAX(active_processes - 1, 0), updated_at = ?
         WHERE id = (SELECT graph_run_id FROM approach_node_runs WHERE id = ?)
           AND (SELECT node_kind FROM approach_node_runs WHERE id = ?) = 'command'`,
      )
      .run(deps.now(), nodeRunId, nodeRunId);
  });
}

/** Park a node whose launch could not proceed: `ready | launching → blocked`
 *  with a reason, blocking the run so the graph-aware Resume owns the retry. */
function parkLaunchFailure(deps: GraphDriverDeps, graphRunId: number, nodeRunId: number): void {
  deps.transaction(() => {
    const row = deps.db
      .prepare('SELECT status FROM approach_node_runs WHERE id = ?')
      .get(nodeRunId) as { status: string } | undefined;
    if (!row) return;
    const from = row.status === 'launching' ? 'launching' : 'ready';
    if (!casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, nodeRunId, from, 'blocked')) {
      return;
    }
    deps.db
      .prepare(
        'UPDATE approach_node_runs SET failure_category = ?, reason = ?, ended_at = ? WHERE id = ?',
      )
      .run('failed-to-launch', 'launch failed before the session started', deps.now(), nodeRunId);
    if (casStatus(deps.db, 'approach_graph_runs', GRAPH_RUN_TRANSITIONS, graphRunId, 'running', 'blocked')) {
      deps.db
        .prepare('UPDATE approach_graph_runs SET blocked_reason = ?, updated_at = ? WHERE id = ?')
        .run(`failed-to-launch: node run ${nodeRunId}`, deps.now(), graphRunId);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Replan planner launch                                               */
/* ------------------------------------------------------------------ */

export interface ReplanPlannerLaunch {
  graphRunId: number;
  plannerRunId: number;
  generation: string;
  capability: string;
  prompt: string;
  cwd: string;
  repo: string;
}

export type LaunchReplanResult =
  | { kind: 'launched'; session: SupervisedAgentSession; generation: string; capability: string }
  | { kind: 'no-op' }
  | { kind: 'failed'; reason: string };

/**
 * Launch the elected replan planner session (Slice 4 Task 5): the launch
 * request the election produced carries the replan reasons as a file artifact
 * plus prior plan evidence; this function stamps the new planner run's
 * generation/capability and starts its session.
 */
export async function launchReplanPlanner(
  deps: GraphDriverDeps,
  launch: ReplanPlannerLaunch,
): Promise<LaunchReplanResult> {
  const run = graphRunById(deps.db, launch.graphRunId);
  if (!run) return { kind: 'no-op' };
  const capability = launch.capability || randomBytes(32).toString('hex');
  const generation = launch.generation || uuidv7();
  const stamped = deps.transaction(() => {
    deps.db
      .prepare('UPDATE approach_planner_runs SET generation = ?, capability_hash = ? WHERE id = ?')
      .run(generation, sha256Hex(new TextEncoder().encode(capability)), launch.plannerRunId);
    return (
      transitionPlannerRun(deps.db, launch.plannerRunId, 'ready', 'launching')
      && transitionPlannerRun(deps.db, launch.plannerRunId, 'launching', 'running')
    );
  });
  if (!stamped) return { kind: 'failed', reason: `planner run ${launch.plannerRunId} already moved` };
  const config = deps.graphConfigOf(run.approach_id);
  const resolved = config ? resolveProfileFor(config, config.planner.profile) : undefined;
  if (!resolved) {
    return { kind: 'failed', reason: `planner profile of approach "${run.approach_id}" is unresolved` };
  }
  const session = await deps.transport.start({
    nodeRunId: launch.plannerRunId,
    ticketId: run.ticket_id,
    graphRunId: launch.graphRunId,
    repo: launch.repo,
    cwd: launch.cwd,
    generation,
    sessionName: deps.sessionNameOf(launch.plannerRunId, 'planner'),
    graphEnv: deps.graphEnvOf({
      launchId: launch.plannerRunId,
      graphRunId: launch.graphRunId,
      revisionId: 0,
      generation,
      capability,
      artifactRoot: deps.artifactRootOf(launch.graphRunId),
    }),
    adapter: deps.adapterFor(resolved.provider),
    interactive: {
      cwd: launch.cwd,
      initialPrompt: launch.prompt,
      model: resolved.model,
      effort: resolved.effort,
      sessionName: deps.sessionNameOf(launch.plannerRunId, 'planner'),
    },
  } satisfies SupervisedLaunchRequest);
  deps.debug?.(`[graph] run ${launch.graphRunId}: replan planner ${launch.plannerRunId} launched`);
  return { kind: 'launched', session, generation, capability };
}
