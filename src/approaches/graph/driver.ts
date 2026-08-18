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
import { canonicalPath } from '../../runtime/pathScope.js';
import type { GraphDb } from '../../store/graph/transitions.js';
import {
  GraphStoreError,
  GRAPH_RUN_TRANSITIONS,
  NODE_RUN_TRANSITIONS,
  casStatus,
} from '../../store/graph/transitions.js';
import { graphRunById } from '../../store/graph/graphRuns.js';
import { beginBootstrapPlannerRun, finishPlanning, relaunchBootstrapPlannerRun } from './coordinator/plannerRun.js';
import { transitionPlannerRun } from '../../store/graph/plannerRuns.js';
import { activeRevision, createRevision } from '../../store/graph/revisions.js';
import { insertEntryTokens } from '../../store/graph/tokens.js';
import { decodeBaseHeads } from '../../store/graph/nodeRuns.js';
import { parseGraphDocument, type GraphDocument } from './parse.js';
import {
  compileGraphDocument,
  type CompileContext,
  type CompileResult,
} from './compile.js';
import { submitReplanDocument } from './coordinator/replan.js';
import {
  MAX_COMPILE_ATTEMPTS,
  nextCompileAttempt,
  recordCompileAttempt,
} from './coordinator/repair.js';
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
import { domainKeyOf } from './integration/domains.js';
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
import type { TerminalNamingBag } from '../../ui/terminalNaming.js';
import { uuidv7 } from './coordinator/lineage.js';

/** Planner completion is a durable CLI submission, not terminal lifecycle. */
export const PLANNER_SUBMIT_INSTRUCTION =
  'After writing every artifact and `graph.json`, run `node "$KARST_GRAPH_CLI" graph submit`. Wait for it to report `{"ok":true}`, then exit; karst observes the committed submission and does not depend on the terminal closing.';

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
  /** Whether the host's manifest is RESOLVED well enough for the compile
   *  context above to judge a plan. A plan must never be judged against an
   *  unresolved manifest: an empty repository map turns every valid repository
   *  claim into `unknown-repository` and blocks the run permanently. Absent →
   *  the host makes no claim and the plan is judged (the pre-G1b behaviour). */
  manifestResolvedFor?: (
    graphRunId: number,
  ) => { resolved: true } | { resolved: false; reason: string };
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
  /** The Git common-dir identity for a canonical worktree. */
  gitCommonDirOf: (cwd: string) => string | null;
  /** The node's isolated workspace clone for a repo; undefined → canonical. */
  workspaceOf: (graphRunId: number, nodeRunId: number, repo: string) => string | undefined;
  /** Create (or re-create) an agent node's isolated workspace clones. */
  createWorkspace: (input: {
    graphRunId: number;
    nodeRunId: number;
    domains: WorkspaceDomain[];
  }) => Promise<CreateNodeWorkspaceResult>;
  /** The terminal naming bag for a graph session (name + brand icon). */
  sessionNamingOf: (graphRunId: number, runId: number, kind: 'planner' | 'node') => TerminalNamingBag;
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
 * Claim a planner run for launch: stamp its launch identity and move it
 * `ready → launching`, in ONE transaction — exactly the node claim's shape.
 *
 * It stops at `launching`, and that stop is the whole point. Stamping
 * `running` here would be a claim that a session exists before anything has
 * spawned, and `transport.start` can still throw (a misconfigured adapter,
 * `buildInteractiveCommand`, the terminal host). A `running` planner with no
 * process is precisely the shape `reconcilePlanningPlanner` refuses to judge
 * dead — no pid evidence normally means another window owns a live session —
 * so the run would sit at `planning` forever, with no session, no process and
 * no sweep that would ever look again. A `launching` planner carrying its
 * owner nonce and no process is the opposite: proof the spawn was never
 * reached, which reconcile marks `stale` and relaunches.
 */
function claimPlannerLaunch(
  deps: GraphDriverDeps,
  plannerRunId: number,
  identity: { generation: string; capability: string; ownerNonce: string },
): boolean {
  return deps.transaction(() => {
    deps.db
      .prepare(
        'UPDATE approach_planner_runs SET generation = ?, capability_hash = ?, owner_nonce = ? WHERE id = ?',
      )
      .run(
        identity.generation,
        sha256Hex(new TextEncoder().encode(identity.capability)),
        identity.ownerNonce,
        plannerRunId,
      );
    // `ready` is the ordinary claim; `blocked` is the compile-repair re-prompt
    // of the SAME planner run (its submitted document was rejected and an
    // attempt remains). Both are declared edges of PLANNER_RUN_TRANSITIONS.
    const row = deps.db
      .prepare('SELECT status FROM approach_planner_runs WHERE id = ?')
      .get(plannerRunId) as { status: string } | undefined;
    const from = row?.status === 'blocked' ? 'blocked' : 'ready';
    return transitionPlannerRun(deps.db, plannerRunId, from, 'launching');
  });
}

/** Close a planner claim once its session exists: `launching → running`. A
 *  lost CAS means another window already moved the row, so this launch is not
 *  reported as one (the node path reads the same way). */
function markPlannerRunning(deps: GraphDriverDeps, plannerRunId: number): boolean {
  return deps.transaction(() => transitionPlannerRun(deps.db, plannerRunId, 'launching', 'running'));
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
  // Every check that can refuse this launch runs BEFORE the claim: a run that
  // never leaves `ready` needs no recovery, while one parked at `launching`
  // invites the reconcile sweep to relaunch a planner whose profile or
  // worktree will refuse it again on every pass.
  const resolved = resolveProfileFor(config, config.planner.profile);
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
  const capability = randomBytes(32).toString('hex');
  const generation = uuidv7();
  // Like the node claim: the ownership proof is committed WITH the transition
  // out of `ready`, so no window ever observes a `launching` planner run
  // without launch identity (`reconcilePlanningPlanner` reads its absence).
  const plannerOwnerNonce = randomBytes(16).toString('hex');
  const claimed = claimPlannerLaunch(deps, plannerRunId, {
    generation,
    capability,
    ownerNonce: plannerOwnerNonce,
  });
  if (!claimed) {
    return { kind: 'failed', reason: `planner run ${plannerRunId} already moved (a second window?)` };
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
    PLANNER_SUBMIT_INSTRUCTION,
  ].join('\n\n');
  const naming = deps.sessionNamingOf(graphRunId, plannerRunId, 'planner');
  let session: SupervisedAgentSession;
  try {
    session = await deps.transport.start({
      nodeRunId: plannerRunId,
      ticketId: input.ticketId,
      graphRunId,
      repo: workspace.repo,
      cwd: workspace.cwd,
      generation,
      ownerNonce: plannerOwnerNonce,
      sessionName: naming.name,
      ...(naming.iconPath ? { sessionIconPath: naming.iconPath } : {}),
      graphEnv: env,
      adapter: deps.adapterFor(resolved.provider),
      interactive: {
        cwd: workspace.cwd,
        initialPrompt: prompt,
        model: resolved.model,
        effort: resolved.effort,
        sessionName: naming.name,
      },
    } satisfies SupervisedLaunchRequest);
  } catch (err) {
    // The row stays `launching` with its nonce and no process — the one shape
    // reconcile can prove never spawned, and therefore relaunch.
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap planner ${plannerRunId} failed to spawn (${String(err)}) — left launching for the sweep`,
    );
    return { kind: 'failed', reason: `planner run ${plannerRunId} failed to spawn: ${String(err)}` };
  }
  if (!markPlannerRunning(deps, plannerRunId)) {
    return { kind: 'failed', reason: `planner run ${plannerRunId} already moved (a second window?)` };
  }
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
  // Refuse before the claim, exactly as the bootstrap path does: a planner
  // left at `ready` is not a launch the sweep will keep retrying.
  const resolved = resolveProfileFor(config, config.planner.profile);
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
  const capability = randomBytes(32).toString('hex');
  const generation = uuidv7();
  // Like the node claim: the ownership proof is committed WITH the transition
  // out of `ready`, so no window ever observes a `launching` planner run
  // without launch identity (`reconcilePlanningPlanner` reads its absence).
  const plannerOwnerNonce = randomBytes(16).toString('hex');
  const claimed = claimPlannerLaunch(deps, plannerRunId, {
    generation,
    capability,
    ownerNonce: plannerOwnerNonce,
  });
  if (!claimed) {
    return { kind: 'failed', reason: `planner run ${plannerRunId} already moved (a second window?)` };
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
    PLANNER_SUBMIT_INSTRUCTION,
  ].join('\n\n');
  const naming = deps.sessionNamingOf(input.graphRunId, plannerRunId, 'planner');
  let session: SupervisedAgentSession;
  try {
    session = await deps.transport.start({
      nodeRunId: plannerRunId,
      ticketId: run.ticket_id,
      graphRunId: input.graphRunId,
      repo: workspace.repo,
      cwd: workspace.cwd,
      generation,
      ownerNonce: plannerOwnerNonce,
      sessionName: naming.name,
      ...(naming.iconPath ? { sessionIconPath: naming.iconPath } : {}),
      graphEnv: env,
      adapter: deps.adapterFor(resolved.provider),
      interactive: {
        cwd: workspace.cwd,
        initialPrompt: prompt,
        model: resolved.model,
        effort: resolved.effort,
        sessionName: naming.name,
      },
    } satisfies SupervisedLaunchRequest);
  } catch (err) {
    deps.debug?.(
      `[graph] run ${input.graphRunId}: bootstrap planner ${plannerRunId} failed to spawn (${String(err)}) — left launching for the sweep`,
    );
    return { kind: 'failed', reason: `planner run ${plannerRunId} failed to spawn: ${String(err)}` };
  }
  if (!markPlannerRunning(deps, plannerRunId)) {
    return { kind: 'failed', reason: `planner run ${plannerRunId} already moved (a second window?)` };
  }
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
  /** There IS a submitted plan, but nothing here can judge it yet (the host's
   *  manifest is unresolved). The run stays `planning` and the next tick tries
   *  again — never a rejection, never a block. */
  | { kind: 'undecidable'; reason: string }
  /** The document was rejected and the planner run has a compile attempt left:
   *  the SAME planner run must be re-prompted with these diagnostics. The run
   *  stays `planning`; the host fulfils the re-prompt on the next tick. */
  | {
      kind: 'repair-requested';
      plannerRunId: number;
      attempt: number;
      diagnostics: string[];
    }
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

  // Idempotency: a run that already holds an active revision has ALREADY
  // accepted its bootstrap plan — a prior accept committed its revision while
  // the run still read `planning` (the `finishPlanning` return was once
  // ignored, so the revision insert and the run transition could commit
  // apart), or a relaunched planner submitted twice. The partial unique index
  // on (graph_run_id) WHERE status='active' makes a second active revision a
  // violation, so this repair moves the run past `planning` and reports the
  // existing revision instead of inserting a duplicate. It runs BEFORE the
  // snapshot read: a run whose plan is already accepted must not be judged
  // against a snapshot it no longer needs.
  const existing = activeRevision(deps.db, graphRunId);
  if (existing) {
    const confirm = configConfirmOf(deps, run.approach_id);
    deps.transaction(() => {
      finishPlanning(deps.db, graphRunId, confirm);
    });
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan already accepted — repaired run status to ${confirm ? 'awaiting-confirmation' : 'running'}, revision ${existing.id}`,
    );
    return { kind: 'accepted', revisionId: existing.id, revisionNumber: existing.revision_number };
  }

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

  // G1b: a plan is never judged against an unresolved manifest. The run stays
  // `planning` and the next tick judges it against a manifest that resolved.
  const resolution = deps.manifestResolvedFor?.(graphRunId) ?? { resolved: true as const };
  if (!resolution.resolved) {
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan not judged — ${resolution.reason}; left planning for the next tick`,
    );
    return { kind: 'undecidable', reason: resolution.reason };
  }

  const snapshotPath = join('snapshots', `${planner.graph_snapshot_id}.json`);
  const bytes = deps.readBytes(graphRunId, snapshotPath);
  if (bytes === undefined) {
    return rejectPlan(deps, graphRunId, planner.id, [
      'planner-no-output: submitted snapshot is unreadable',
    ]);
  }
  const parsed = parseGraphDocument(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    return rejectPlan(
      deps,
      graphRunId,
      planner.id,
      parsed.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  const compiled = compileGraphDocument(parsed.document, deps.compileContextOf(graphRunId, parsed.document));
  if (!compiled.ok) {
    return rejectPlan(
      deps,
      graphRunId,
      planner.id,
      compiled.diagnostics.map((d) => `${d.code}: ${d.where}: ${d.message}`),
    );
  }
  const { compiled: c } = compiled;
  const confirm = configConfirmOf(deps, run.approach_id);
  const revisionNumber = 1;
  const outcome = deps.transaction(() => {
    // Idempotency: a run that already holds an active revision has ALREADY
    // accepted its bootstrap plan — a prior accept committed its revision (a
    // raced duplicate continuation from the reconcile sweep and the PR-sync
    // sweep, or a relaunched planner submitting twice). The partial unique
    // index on (graph_run_id) WHERE status='active' makes a second active
    // revision a violation, so this must repair the run's status (it may still
    // read `planning` from the raced accept) and report the existing revision
    // rather than insert a duplicate.
    const existing = activeRevision(deps.db, graphRunId);
    if (existing) {
      finishPlanning(deps.db, graphRunId, confirm);
      return { id: existing.id, revisionNumber: existing.revision_number, already: true } as const;
    }
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
    // finishPlanning is the accept's verdict on the run status: if it returns
    // false the run left `planning` mid-transaction and NO active revision may
    // be committed on a run the sweep will never schedule — roll back.
    if (!finishPlanning(deps.db, graphRunId, confirm)) {
      throw new GraphStoreError(
        `acceptSubmittedPlan: run ${graphRunId} left planning before its transition`,
      );
    }
    return { id, revisionNumber, already: false } as const;
  });
  if (outcome.already) {
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan already accepted — repaired run status to ${confirm ? 'awaiting-confirmation' : 'running'}, revision ${outcome.id}`,
    );
  } else {
    deps.debug?.(
      `[graph] run ${graphRunId}: bootstrap plan accepted — revision ${outcome.id} (#${outcome.revisionNumber}) → ${confirm ? 'awaiting-confirmation' : 'running'}`,
    );
  }
  return { kind: 'accepted', revisionId: outcome.id, revisionNumber: outcome.revisionNumber };
}

function configConfirmOf(deps: GraphDriverDeps, approachId: string): boolean {
  return deps.graphConfigOf(approachId)?.limits.confirmGeneratedGraph ?? true;
}

export type AcceptReplanResult =
  | { kind: 'accepted'; revisionId: number; revisionNumber: number }
  | { kind: 'no-op' }
  | { kind: 'undecidable'; reason: string }
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

  // G1b: a replan is never judged against an unresolved manifest either — the
  // same empty repository map that turns every valid claim into
  // `unknown-repository`. The run stays `draining` and the next tick judges it
  // against a manifest that resolved.
  const resolution = deps.manifestResolvedFor?.(graphRunId) ?? { resolved: true as const };
  if (!resolution.resolved) {
    deps.debug?.(
      `[graph] run ${graphRunId}: replan not judged — ${resolution.reason}; left draining for the next tick`,
    );
    return { kind: 'undecidable', reason: resolution.reason };
  }

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

/** The one place the compile diagnostics are persisted: `diagnostics/planner-
 *  <id>.json` under the run's artifact root, where the repair re-prompt and
 *  the replan launch both read them back. */
function writeDiagnosticsFile(
  deps: GraphDriverDeps,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
): void {
  try {
    deps.writeSnapshot(
      graphRunId,
      diagnosticsPathFor(plannerRunId),
      new TextEncoder().encode(JSON.stringify(diagnostics, null, 2)),
    );
  } catch (err) {
    deps.debug?.(`[graph] run ${graphRunId}: diagnostics write failed (${String(err)})`);
  }
}

/** The artifact-root-relative path of a planner run's compile diagnostics. */
export function diagnosticsPathFor(plannerRunId: number): string {
  return `diagnostics/planner-${plannerRunId}.json`;
}

/** Read a planner run's persisted compile diagnostics back (host-agnostic:
 *  through the injected `readBytes`), so the re-prompt can quote exactly what
 *  the compiler rejected. */
export function readPlannerDiagnostics(
  deps: Pick<GraphDriverDeps, 'readBytes'>,
  graphRunId: number,
  plannerRunId: number,
): string[] {
  const bytes = deps.readBytes(graphRunId, diagnosticsPathFor(plannerRunId));
  if (bytes === undefined) return [];
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return Array.isArray(parsed) ? parsed.map((d) => String(d)) : [];
  } catch {
    return [];
  }
}

/**
 * G2: a rejected document is not terminal on attempt one. The planner run's
 * durable `compile_attempt` counter (the SAME counter `compileWithRepair`
 * keeps) decides: with an attempt left the diagnostics are persisted, the
 * attempt is recorded, the planner run moves `submitted → blocked` — the one
 * status it can be re-prompted from — and the run STAYS `planning` while the
 * host fulfils the re-prompt on the next tick. Only an exhausted run blocks
 * with `graph-plan-invalid`.
 */
function rejectPlan(
  deps: GraphDriverDeps,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
): AcceptPlanResult {
  const decision = nextCompileAttempt(deps.db, plannerRunId);
  if (decision.exhausted) {
    return blockInvalidPlan(deps, graphRunId, plannerRunId, diagnostics, decision.attempt);
  }
  const reprompted = deps.transaction(() => {
    // The CAS is attempted FIRST: a lost race (another window already moved
    // this planner run) must not burn an attempt from the budget. Returning
    // `false` from a `deps.transaction` callback does NOT roll back the
    // transaction — only a throw does — so the attempt was recorded even on
    // a lost race when this ran in the other order.
    if (!transitionPlannerRun(deps.db, plannerRunId, 'submitted', 'blocked')) return false;
    recordCompileAttempt(deps, plannerRunId, decision.attempt);
    deps.db
      .prepare('UPDATE approach_planner_runs SET reason = ? WHERE id = ?')
      .run(`graph-plan-invalid: ${(diagnostics[0] ?? 'invalid document').slice(0, 2000)}`, plannerRunId);
    return true;
  });
  if (!reprompted) {
    // The planner run moved under us (another window is already repairing it)
    // — nothing destructive to do; the run stays `planning`.
    deps.debug?.(
      `[graph] run ${graphRunId}: compile repair for planner ${plannerRunId} lost the submitted→blocked CAS — another window owns it`,
    );
    return { kind: 'undecidable', reason: 'planner run already moved' };
  }
  writeDiagnosticsFile(deps, graphRunId, plannerRunId, diagnostics);
  deps.debug?.(
    `[graph] run ${graphRunId}: bootstrap plan rejected on compile attempt ${decision.attempt}/${MAX_COMPILE_ATTEMPTS} — re-prompting planner ${plannerRunId} with ${diagnostics.length} diagnostic(s)`,
  );
  return { kind: 'repair-requested', plannerRunId, attempt: decision.attempt, diagnostics };
}

/** Park a planning run whose plan was rejected: `planning → blocked` with the
 *  compile diagnostics written beside the snapshot (the graph-aware Resume
 *  reads the reason and elects a replan). */
function blockInvalidPlan(
  deps: GraphDriverDeps,
  graphRunId: number,
  plannerRunId: number,
  diagnostics: string[],
  attempt?: number,
): AcceptPlanResult {
  const reason = `graph-plan-invalid: ${diagnostics[0] ?? 'planner produced an invalid document'}`;
  const blocked = deps.transaction(() => {
    if (attempt !== undefined) recordCompileAttempt(deps, plannerRunId, attempt);
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
    writeDiagnosticsFile(deps, graphRunId, plannerRunId, diagnostics);
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

interface RunnableNodeRow {
  id: number;
  revision_id: number;
  node_id: string;
  status: string;
  owner_nonce: string | null;
  process_run_id: number | null;
}

/** Execute every runnable node run of a `running` graph run, in id order. A
 *  runnable row is either `ready`, or a recovery-rearmed `launching` row with
 *  no owner nonce and no process row — provably never spawned and safe to
 *  launch again from the periodic continuation. That reading is only sound
 *  because the launch identity is committed WITH the `ready → launching`
 *  transition (see `executeReadyNode`): a row another window is mid-launching
 *  already carries its nonce, so this query can never select it and start a
 *  second agent on the same reserved visit. A join/gate/command completes
 *  deterministically in one transaction; an agent node gets its workspace and
 *  a supervised session and stays `running` until its agent reports an outcome
 *  via `karst node …`. */
export async function driveReadyNodeRuns(
  deps: GraphDriverDeps,
  graphRunId: number,
): Promise<DriveReadyNodesResult> {
  const run = graphRunById(deps.db, graphRunId);
  if (!run || run.status !== 'running') return { launched: 0, completed: 0, blocked: 0 };
  const runnable = deps.db
    .prepare(
      `SELECT id, revision_id, node_id, status, owner_nonce, process_run_id
       FROM approach_node_runs
       WHERE graph_run_id = ?
         AND (
           status = 'ready'
           OR (status = 'launching' AND owner_nonce IS NULL AND process_run_id IS NULL)
         )
       ORDER BY id`,
    )
    .all(graphRunId) as RunnableNodeRow[];
  const result: DriveReadyNodesResult = { launched: 0, completed: 0, blocked: 0 };
  for (const row of runnable) {
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
  row: RunnableNodeRow,
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
  // The launch identity is written INSIDE the claim transaction, with the
  // generation and the capability hash. The owner nonce used to be minted by
  // the transport and written after this transaction committed, which left the
  // row observable — to another WINDOW's coordinator, sharing this database —
  // as `launching` with no owner nonce and no process: the exact shape the
  // launchable query below and `reconcileLaunching` read as "provably never
  // spawned". A second window would have launched a second agent on the same
  // reserved visit. Committing the identity with the claim closes that window;
  // the retry path (`clearLaunchIdentity`) is the only producer of the
  // no-identity shape, which is what keeps that reading true.
  const nodeOwnerNonce = randomBytes(16).toString('hex');
  const claimed = deps.transaction(() => {
    deps.db
      .prepare(
        'UPDATE approach_node_runs SET generation = ?, capability_hash = ?, owner_nonce = ? WHERE id = ?',
      )
      .run(nodeGeneration, sha256Hex(new TextEncoder().encode(nodeCapability)), nodeOwnerNonce, row.id);
    if (row.status === 'launching') return true;
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
      ticketContext: nodeTicketContext(deps, graphRunId, row, repo, cwd),
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
      sessionNamingOf: (graphRunId, runId, kind) => deps.sessionNamingOf(graphRunId, runId, kind),
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
      ownerNonce: nodeOwnerNonce,
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
  const launched = deps.transaction(() =>
    casStatus(deps.db, 'approach_node_runs', NODE_RUN_TRANSITIONS, row.id, 'launching', 'running'),
  );
  if (!launched) {
    deps.debug?.(
      `[graph] run ${graphRunId}: agent node ${row.node_id} (run ${row.id}) launched but lost launching→running CAS`,
    );
    return 'blocked';
  }
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

/** The ticket context for an agent NODE: the generic ticket context (which
 *  names the canonical repo/worktree paths) plus the node-workspace directive
 *  naming the isolated clone the session actually runs in. Resolved per launch
 *  so a resumed node gets the CURRENT workspace's directive. */
function nodeTicketContext(
  deps: GraphDriverDeps,
  graphRunId: number,
  row: RunnableNodeRow,
  repo: string,
  cwd: string,
): string {
  const canonicalWorktree = deps.cwdForRepo(graphRunId, repo) ?? '';
  if (canonicalWorktree === '') return deps.ticketContextOf(runTicketId(deps, graphRunId));
  const domainKey = domainKeyOf(canonicalPath(canonicalWorktree), deps.gitCommonDirOf(canonicalWorktree));
  const base = deps.db
    .prepare('SELECT base_heads FROM approach_node_runs WHERE id = ?')
    .get(row.id) as { base_heads: string | null } | undefined;
  const baseCommit =
    decodeBaseHeads(base?.base_heads ?? null).find((head) => head.domainKey === domainKey)?.commit ?? '';
  return [
    deps.ticketContextOf(runTicketId(deps, graphRunId)),
    nodeWorkspaceDirective({ workspace: cwd, canonicalWorktree, baseCommit }),
  ].join('\n\n');
}

/** A node-scoped context addition that names the ISOLATED WORKSPACE a node
 *  actually runs in. The ticket context's "Repositories in scope" and
 *  "Worktrees & branches" sections name the CANONICAL locations — the manifest
 *  `repoPath` (the main checkout) and the ticket worktree — which is accurate
 *  for a plain implementation session but NOT for a graph node: its session
 *  runs in an isolated clone under the artifact root. An agent that trusts the
 *  context follows the named canonical path and edits the main checkout instead
 *  of its workspace (the "implementation started into main WT" report), so the
 *  directive states the workspace explicitly and forbids escaping it.
 *
 * Pure: no fs, no store — the caller resolves the paths. */
export function nodeWorkspaceDirective(input: {
  workspace: string;
  canonicalWorktree: string;
  baseCommit: string;
}): string {
  return [
    '## Node workspace',
    `Your workspace for this node is: \`${input.workspace}\``,
    `It is an isolated clone of the ticket's worktree \`${input.canonicalWorktree}\`` +
      (input.baseCommit ? ` at \`${input.baseCommit}\`` : ''),
    'The paths the ticket context names — Repositories in scope, Worktrees & branches — are the CANONICAL locations, not where you work.',
    'Edit files ONLY inside your workspace above; never traverse out of it (e.g. `../..`) to reach the canonical checkout.',
  ].join('\n');
}

/** The isolated workspace clone(s) for an agent node's declared repos. Falls
 *  back to no clone (empty path list) only when the graph declares no repos —
 *  the V1 canonical model. */
async function prepareAgentWorkspace(
  deps: GraphDriverDeps,
  graphRunId: number,
  row: RunnableNodeRow,
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
    const gitCommonDir = deps.gitCommonDirOf(cwd);
    const domainKey = domainKeyOf(canonicalPath(cwd), gitCommonDir);
    const base = deps.db
      .prepare('SELECT base_heads FROM approach_node_runs WHERE id = ?')
      .get(row.id) as { base_heads: string | null } | undefined;
    const baseCommit =
      decodeBaseHeads(base?.base_heads ?? null).find((head) => head.domainKey === domainKey)?.commit ?? '';
    domains.push({ repoName: repo, canonicalWorktreePath: cwd, gitCommonDir, baseCommit });
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
      { db: deps.db, transaction: <T>(fn: () => T): T => fn(), now: deps.now, debug: deps.debug },
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
    deps.db
      .prepare(
        `UPDATE approach_graph_runs
         SET active_processes = MAX(active_processes - 1, 0), updated_at = ?
         WHERE id = ?`,
      )
      .run(deps.now(), graphRunId);
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
  const config = deps.graphConfigOf(run.approach_id);
  const resolved = config ? resolveProfileFor(config, config.planner.profile) : undefined;
  if (!resolved) {
    return { kind: 'failed', reason: `planner profile of approach "${run.approach_id}" is unresolved` };
  }
  const capability = launch.capability || randomBytes(32).toString('hex');
  const generation = launch.generation || uuidv7();
  // Like the node claim: the ownership proof is committed WITH the transition
  // out of `ready`, so no window ever observes a `launching` planner run
  // without launch identity (`reconcilePlanningPlanner` reads its absence).
  const plannerOwnerNonce = randomBytes(16).toString('hex');
  const claimed = claimPlannerLaunch(deps, launch.plannerRunId, {
    generation,
    capability,
    ownerNonce: plannerOwnerNonce,
  });
  if (!claimed) return { kind: 'failed', reason: `planner run ${launch.plannerRunId} already moved` };
  const naming = deps.sessionNamingOf(launch.graphRunId, launch.plannerRunId, 'planner');
  let session: SupervisedAgentSession;
  try {
    session = await deps.transport.start({
      nodeRunId: launch.plannerRunId,
      ticketId: run.ticket_id,
      graphRunId: launch.graphRunId,
      repo: launch.repo,
      cwd: launch.cwd,
      generation,
      ownerNonce: plannerOwnerNonce,
      sessionName: naming.name,
      ...(naming.iconPath ? { sessionIconPath: naming.iconPath } : {}),
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
        sessionName: naming.name,
      },
    } satisfies SupervisedLaunchRequest);
  } catch (err) {
    deps.debug?.(
      `[graph] run ${launch.graphRunId}: replan planner ${launch.plannerRunId} failed to spawn (${String(err)}) — left launching`,
    );
    return {
      kind: 'failed',
      reason: `planner run ${launch.plannerRunId} failed to spawn: ${String(err)}`,
    };
  }
  if (!markPlannerRunning(deps, launch.plannerRunId)) {
    return { kind: 'failed', reason: `planner run ${launch.plannerRunId} already moved` };
  }
  deps.debug?.(`[graph] run ${launch.graphRunId}: replan planner ${launch.plannerRunId} launched`);
  return { kind: 'launched', session, generation, capability };
}
