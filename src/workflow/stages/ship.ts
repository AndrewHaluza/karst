import type { Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { DriveProcessBundle, ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import {
  shipFinishedEvent,
  shipStartedEvent,
  type InsideProgressEvent,
} from '../../model/inside/progress.js';
import { randomUUID, createHash } from 'node:crypto';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { getTicket } from '../../store/tickets.js';
import { resolveShipLanding } from '../mergeGate.js';
import { setStage } from '../../store/stages.js';
import { nowIso } from '../../model/time.js';
import {
  openPr,
  findOpenPr,
  fetchPrDetail,
  fetchPrBody,
  updatePrBody,
  defaultGhRunnerAsync,
  UNKNOWN_PR_DETAIL,
  type ExistingPr,
  type GhRunner,
  type OpenedPr,
} from '../../integrations/github.js';
import { updatePrDetail } from '../../store/prs.js';
import {
  commitAllIfDirty,
  describeGitFailure,
  hasChangesFrom,
  pushBranch,
  defaultGitRunner,
  cleanupQuarantine,
  compareAndSwapHeadAndIndex,
  headCommit,
  listCommitsFrom,
  prepareCommitInQuarantine,
  promoteQuarantinedObjects,
  remoteRefSha,
  workingTreeSummary,
  type GitRunner,
  type PersistedCommitIdentity,
} from '../../integrations/git.js';
import { openProcessRun, finishProcessRun } from '../../store/processRuns.js';
import {
  adoptShipOperation,
  beginShipOperationPreparation,
  closeShipRun,
  finalizeShipOperationIntent,
  finishShipRepoStep,
  markShipOperationApplied,
  openShipRepoStep,
  openShipRun,
  parseShipIntent,
  parseShipPreState,
  reconcileShipOperation,
  recordShipCommit,
  type ShipOperationIntent,
  type ShipOperationPreState,
  type ShipRepoStep,
  type ShipRun,
} from '../../store/shipRuns.js';
import { checkMergeable } from '../mergeCheck.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { mergeOpStatus } from '../../model/mergeCheckView.js';
import type { WorktreeView } from '../../store/dashboard.js';
import type { ArtifactConventions, Manifest } from '../../manifest/types.js';
import { resolveBaselineBranchForPath } from '../../manifest/baselineBranch.js';
import {
  renderArtifactTemplate,
  usesDescription,
  type ArtifactTemplateContext,
} from '../artifactConventions.js';
import {
  buildPrDescriptionPrompt,
  gateSetChangedSincePreviousRun,
  renderPrDescription,
  sanitizePrDescription,
  type PrDiffContext,
} from '../prDescription.js';
import { collectPrDiffContext } from '../prDiffContext.js';
import { resolveRepoScope, resolveTicketType } from '../conventionContext.js';

/**
 * Ship stage (§T4.5, §11, §12). Opens one PR per hot repo — independently, no
 * ordering (cross-repo merge ordering is out of scope) — each with an
 * agent-generated description (cheap model, via the adapter), writes the PR rows
 * to `prs`, then advances the stage to done.
 *
 * [L4] ship (PRs) and done (ticket status) have independent failure modes and
 * live in separate files; they share no state beyond the ticket id.
 */

export interface ShipOpts {
  ticketId: number;
  /** Current manifest, read when ship starts rather than captured at ticket creation. */
  manifest?: Manifest;
  /** Retained for API compatibility; the description model comes from the process assignment. */
  model?: string;
  /** Direct injection retained for host-agnostic callers and focused tests. */
  conventions?: ArtifactConventions;
  /**
   * The configured PR-description process (Task 3): the `pr-description`
   * assignment snapshot and its instrumented adapter, resolved ONCE by the
   * host. `generateDescription` uses THIS bundle's adapter and snapshots its
   * assignment into the process run. NULL = configured ABSENCE
   * (`processes.prDescription.enabled: false`): the AI step is skipped, the
   * deterministic branch-facts body is rendered locally instead, and NO AI
   * process run is recorded. `undefined` = a legacy caller — the positional
   * `adapter` parameter still drives the step as before, without a snapshot.
   */
  prDescriptionProcess?: DriveProcessBundle | null;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[merge]`,
   * threaded into `resolveShipLanding`. Absent → no debug lines; the host
   * binds it to `Logger.debug` (a no-op unless the manifest's `debug` flag is on).
   */
  debug?: (message: string) => void;
}

export interface ShippedPr {
  repo: string;
  number: number | null;
  url: string;
}

export interface ShipResult {
  prs: ShippedPr[];
}

/**
 * Ask the agent (cheap model) for a PR description; falls back to the title.
 *
 * The answer is sanitized, not trusted: an agent asked a chat-shaped question
 * answers with chat-shaped scaffolding (a "no PR open yet … copy-paste ready"
 * status line, a preamble, the whole body inside a code fence), and this text
 * goes straight into public GitHub metadata. `prDescription.ts` owns both halves
 * — the prompt that asks for a clean body and the filter that enforces it.
 */
async function describePr(
  adapter: AgentAdapter,
  cwd: string,
  title: string,
  ticketId: number,
  processRunId?: number | null,
  model?: string,
  gateSetChanged?: boolean,
): Promise<string> {
  const r = await adapter.runHeadless({
    prompt: buildPrDescriptionPrompt(title, gateSetChanged),
    cwd,
    model,
    tracking: { callSite: 'pr-description', ticketId, processRunId: processRunId ?? undefined },
  });
  return sanitizePrDescription(r.raw, title);
}

/** Deterministic body fingerprint for describe-step reconciliation. */
function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The identity the ship commit is authored/committed with, snapshotted before preparation. */
async function gitIdentity(git: GitRunner, cwd: string): Promise<PersistedCommitIdentity> {
  const name = await git(['config', 'user.name'], cwd);
  const email = await git(['config', 'user.email'], cwd);
  return {
    name: name.exitCode === 0 && name.stdout.trim() ? name.stdout.trim() : 'karst',
    email: email.exitCode === 0 && email.stdout.trim() ? email.stdout.trim() : 'karst@local',
    at: new Date().toISOString(),
  };
}

/** Open the durable step row and its pre-state ownership row in ONE transaction. */
function openStepWithPreparation(
  store: Store,
  input: {
    run: ShipRun;
    repo: string;
    step: 'commit' | 'push' | 'describe' | 'pr';
    operationKey: string;
    preState: ShipOperationPreState;
    detail: string;
    processRunId?: number | null;
    at: string;
  },
): { stepId: number; intentId: number } {
  let stepId = 0;
  let intentId = 0;
  store.db.transaction(() => {
    const step = openShipRepoStep(store, {
      shipRunId: input.run.id,
      repo: input.repo,
      step: input.step,
      detail: input.detail,
      processRunId: input.processRunId ?? null,
      startedAt: input.at,
    });
    const intent = beginShipOperationPreparation(store, {
      shipRunId: input.run.id,
      repo: input.repo,
      step: input.step,
      operationKey: input.operationKey,
      preState: input.preState,
      createdAt: input.at,
    });
    // The step's ownership link: reconciliation loads the intent through it.
    // A running step without this link authorizes nothing.
    store.db
      .prepare('UPDATE ship_repo_steps SET operation_intent_id = ? WHERE id = ?')
      .run(intent.id, step.id);
    stepId = step.id;
    intentId = intent.id;
  })();
  return { stepId, intentId };
}

/** A ShipRepoStep as stored — the four saga steps (merge stays a live event). */
type SagaStep = 'commit' | 'push' | 'describe' | 'pr';

/**
 * Run the description model call under a durable `describe` step and its
 * `pr-description` process run, so the AI execution has the same evidence every
 * other AI process carries.
 */
async function generateDescription(
  store: Store,
  run: ShipRun,
  repo: string,
  adapter: AgentAdapter,
  cwd: string,
  prTitle: string,
  ticketId: number,
  onProgress: ShipProgress,
  onInsideProgress: (event: InsideProgressEvent) => void = () => {},
  assignment?: ProcessAssignmentSnapshot,
  gateSetChanged?: boolean,
): Promise<string> {
  onProgress({ repo, step: 'describe', status: 'run' });
  onInsideProgress({
    kind: 'active',
    ticketId,
    stage: 'ship',
    processId: 'pr-description',
    live: { status: 'run', label: 'Pull request description', detail: repo },
  });
  const at = nowIso();
  const processRun = openProcessRun(store, {
    ticketId,
    stageKey: 'ship',
    processId: 'pr-description',
    attempt: run.attempt,
    // Task 3: the configured assignment is snapshotted into the run the moment
    // it opens — a later manifest edit never rewrites the identity that ran.
    agentName: assignment?.agentName ?? null,
    provider: assignment?.provider ?? null,
    model: assignment?.model ?? null,
    startedAt: at,
  });
  const step = openShipRepoStep(store, {
    shipRunId: run.id,
    repo,
    step: 'describe',
    detail: 'generate',
    processRunId: processRun.id,
    startedAt: at,
  });
  try {
    const body = await describePr(
      adapter,
      cwd,
      prTitle,
      ticketId,
      processRun.id,
      assignment?.model,
      gateSetChanged,
    );
    finishProcessRun(store, processRun.id, 'passed', nowIso());
    finishShipRepoStep(store, step.id, { status: 'passed', detail: 'generated', endedAt: nowIso() });
    onProgress({ repo, step: 'describe', status: 'pass' });
    onInsideProgress({
      kind: 'completed',
      ticketId,
      stage: 'ship',
      process: {
        id: 'pr-description',
        kind: 'pr-description',
        label: 'Pull request description',
        status: 'pass',
      },
    });
    return body;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    finishProcessRun(store, processRun.id, 'failed', nowIso());
    finishShipRepoStep(store, step.id, { status: 'failed', detail, endedAt: nowIso() });
    onInsideProgress({
      kind: 'completed',
      ticketId,
      stage: 'ship',
      process: {
        id: 'pr-description',
        kind: 'pr-description',
        label: 'Pull request description',
        status: 'fail',
      },
    });
    throw err;
  }
}

/** Record a created-by-ship commit unless the run already recorded it (idempotent adoption). */
function recordCreatedCommitIfAbsent(
  store: Store,
  runId: number,
  repo: string,
  sha: string,
  message: string,
): void {
  const exists = store.db
    .prepare('SELECT id FROM ship_commits WHERE ship_run_id = ? AND repo = ? AND sha = ?')
    .get(runId, repo, sha);
  if (exists === undefined) {
    recordShipCommit(store, { shipRunId: runId, repo, sha, message, origin: 'created-by-ship' });
  }
}

/**
 * Adopt — or refute — the effects of the previous ship run when it died
 * mid-saga. Runs at the start of the next invocation, before any fresh work.
 *
 * The previous run is reconciled whether it was closed `failed` (its catch
 * fired — but a commit or push may already have landed before the crash) or
 * still `running` (a hard kill). Only its steps that never PASSED are
 * examined; a step that finished passing already carried its effect. For
 * every such step the persisted typed ownership row is loaded and the CURRENT
 * state is compared against BOTH the pre-state and the intended state: an
 * exact match adopts (completing an owned index install, recording
 * provenance), a pre-state match retries the apply, and anything else is
 * `ambiguous` — a human or foreign writer moved the world, and karst never
 * overwrites it.
 */
async function reconcilePriorShipOperations(
  store: Store,
  ticketId: number,
  currentRunId: number,
  worktrees: readonly WorktreeView[],
  git: GitRunner,
  gh: GhRunner,
): Promise<void> {
  const prev = store.db
    .prepare(
      'SELECT id, status FROM ship_runs WHERE ticket_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
    )
    .get(ticketId, currentRunId) as { id: number; status: string } | undefined;
  if (prev === undefined) return;

  const openSteps = store.db
    .prepare(
      `SELECT id, repo, step, operation_intent_id
         FROM ship_repo_steps
        WHERE ship_run_id = ? AND status != 'passed'`,
    )
    .all(prev.id) as {
    id: number;
    repo: string;
    step: string;
    operation_intent_id: number | null;
  }[];
  const pathByRepo = new Map(worktrees.map((wt) => [wt.repo, wt.path]));

  for (const step of openSteps) {
    if (step.operation_intent_id === null) continue;
    const intentRow = store.db
      .prepare(
        `SELECT id, status, pre_state_json, intent_json, repo, ship_run_id
           FROM ship_operation_intents WHERE id = ?`,
      )
      .get(step.operation_intent_id) as {
      id: number;
      status: string;
      pre_state_json: string;
      intent_json: string | null;
      repo: string;
      ship_run_id: number;
    } | undefined;
    if (intentRow === undefined) continue;
    const at = nowIso();
    const stepKey = step.step as SagaStep;
    const pre = parseShipPreState(intentRow.pre_state_json, stepKey);
    const intent = parseShipIntent(intentRow.intent_json, stepKey);
    if (pre === null || intent === null) {
      reconcileShipOperation(store, step.operation_intent_id, 'ambiguous', {
        resolvedAt: at,
        detail: 'unreadable ownership data',
      });
      finishShipRepoStep(store, step.id, {
        status: 'failed',
        detail: 'unreadable ownership data — needs a human',
        endedAt: at,
      });
      continue;
    }
    const path = pathByRepo.get(step.repo);
    if (path === undefined) {
      reconcileShipOperation(store, step.operation_intent_id, 'ambiguous', {
        resolvedAt: at,
        detail: 'worktree gone — needs a human',
      });
      finishShipRepoStep(store, step.id, {
        status: 'failed',
        detail: 'worktree gone — needs a human',
        endedAt: at,
      });
      continue;
    }
    await reconcileStep(store, step.id, step.operation_intent_id, stepKey, pre, intent, intentRow, path, git, gh, at);
  }

  if (prev.status === 'running') {
    closeShipRun(store, prev.id, 'interrupted', nowIso());
  }
}

/** Reconcile ONE interrupted (step, intent) against the current world. */
async function reconcileStep(
  store: Store,
  stepId: number,
  intentId: number,
  stepKey: SagaStep,
  pre: ShipOperationPreState,
  intent: ShipOperationIntent,
  intentRow: { status: string; repo: string; ship_run_id: number },
  path: string,
  git: GitRunner,
  gh: GhRunner,
  at: string,
): Promise<void> {
  // An already-adopted intent is final: its effect is recorded as landed and
  // nothing here may re-probe or re-label it.
  if (intentRow.status === 'reconciled') return;
  const ambiguous = (detail: string): void => {
    reconcileShipOperation(store, intentId, 'ambiguous', { resolvedAt: at, detail });
    finishShipRepoStep(store, stepId, { status: 'failed', detail, endedAt: at });
  };
  const adopted = (detail: string, prNumber?: number | null): void => {
    adoptShipOperation(store, intentId, {
      stepId,
      detail,
      prNumber: prNumber ?? null,
      existedBeforeShip: prNumber !== undefined ? true : null,
      at,
    });
  };

  switch (stepKey) {
    case 'commit': {
      if (pre.step !== 'commit' || intent.step !== 'commit') return ambiguous('unreadable commit ownership data');
      const current = await headCommit(git, path);
      if (current === intent.expectedHead) {
        // The commit landed. Complete the owned index install when the crash
        // interrupted it; a third index is left strictly alone.
        const index = await git(['write-tree'], path);
        if (index.exitCode === 0 && index.stdout.trim() === pre.preIndexTree) {
          await git(['read-tree', intent.intendedTree], path);
        }
        recordCreatedCommitIfAbsent(store, intentRow.ship_run_id, intentRow.repo, intent.expectedHead, pre.message);
        adopted(`adopted commit ${intent.expectedHead.slice(0, 7)}`);
        return;
      }
      if (current === pre.preHead) {
        const index = await git(['write-tree'], path);
        const { fingerprint } = await workingTreeSummary(git, path);
        if (index.exitCode !== 0 || index.stdout.trim() !== pre.preIndexTree || fingerprint !== pre.worktreeFingerprint) {
          return ambiguous('worktree changed during the interrupted commit');
        }
        if (intentRow.status === 'preparing') {
          // A crash before the intent was finalized: rebuild the owned quarantine.
          await cleanupQuarantine(git, path, pre.quarantineKey).catch(() => {});
          const rebuilt = await prepareCommitInQuarantine(git, path, pre.quarantineKey, {
            preHead: pre.preHead,
            message: pre.message,
            author: pre.author,
            committer: pre.committer,
          }).catch(() => null);
          if (
            rebuilt === null ||
            rebuilt.expectedHead !== intent.expectedHead ||
            rebuilt.intendedTree !== intent.intendedTree
          ) {
            return ambiguous('quarantine rebuild diverged');
          }
          finalizeShipOperationIntent(store, intentId, intent, at);
        }
        await promoteQuarantinedObjects(git, path, pre.quarantineKey);
        const cas = await compareAndSwapHeadAndIndex(git, path, {
          preHead: pre.preHead,
          expectedHead: intent.expectedHead,
          intendedTree: intent.intendedTree,
          preIndexTree: pre.preIndexTree,
          expectedFingerprint: pre.worktreeFingerprint,
          quarantineKey: pre.quarantineKey,
        });
        if (!cas.ok) return ambiguous(`commit refused: ${cas.reason}`);
        recordCreatedCommitIfAbsent(store, intentRow.ship_run_id, intentRow.repo, intent.expectedHead, pre.message);
        adopted(intent.expectedHead.slice(0, 7));
        return;
      }
      return ambiguous('HEAD moved during the interrupted commit');
    }
    case 'push': {
      if (pre.step !== 'push' || intent.step !== 'push') return ambiguous('unreadable push ownership data');
      const now = await remoteRefSha(git, path, pre.remote, pre.ref);
      if ((now ?? '') === intent.localHead) {
        adopted('adopted push');
        return;
      }
      reconcileShipOperation(store, intentId, 'failed', {
        resolvedAt: at,
        detail: 'push did not land — retrying',
      });
      finishShipRepoStep(store, stepId, {
        status: 'failed',
        detail: 'push did not land — retrying',
        endedAt: at,
      });
      return;
    }
    case 'describe': {
      if (pre.step !== 'describe' || intent.step !== 'describe') return ambiguous('unreadable describe ownership data');
      const current = await fetchPrBody(gh, pre.prUrl, path).catch(() => null);
      if (current !== null && bodyHash(current) === bodyHash(intent.intendedBody)) {
        adopted('adopted description');
        return;
      }
      if (current !== null && bodyHash(current) === pre.preBodyHash) {
        reconcileShipOperation(store, intentId, 'failed', {
          resolvedAt: at,
          detail: 'description update did not land — retrying',
        });
        finishShipRepoStep(store, stepId, {
          status: 'failed',
          detail: 'description update did not land — retrying',
          endedAt: at,
        });
        return;
      }
      return ambiguous('PR body changed during the interrupted update');
    }
    case 'pr': {
      if (pre.step !== 'pr' || intent.step !== 'pr') return ambiguous('unreadable pr ownership data');
      const probe = await findOpenPr(gh, path).catch(() => null);
      if (probe !== null) {
        adopted(`adopted #${probe.number}`, probe.number);
        return;
      }
      if (pre.preExistingUrl !== null) {
        return ambiguous('could not re-probe the PR being adopted — never open a second');
      }
      reconcileShipOperation(store, intentId, 'failed', {
        resolvedAt: at,
        detail: 'PR creation did not land — retrying',
      });
      finishShipRepoStep(store, stepId, {
        status: 'failed',
        detail: 'PR creation did not land — retrying',
        endedAt: at,
      });
      return;
    }
  }
}

/**
 * Say that the PR step found a PR rather than opening one, so the live view never
 * shows a plain `pass` for work that did not happen.
 */
function noteReusedPr(repo: string, onProgress: ShipProgress): void {
  onProgress({
    repo,
    step: 'pr',
    status: 'note',
    detail: 'a PR for this branch already existed — reused it',
  });
}

/**
 * Give an adopted PR a description if — and only if — it has none.
 *
 * The asymmetry is the whole point. A PR opened by hand commonly has an empty
 * body and nothing else will ever fill it, so skipping the describe step
 * wholesale (what adoption used to do) leaves a permanently blank PR. But
 * overwriting prose a human wrote is unrecoverable, so anything gh reports as
 * non-empty is kept verbatim, and a body gh did NOT report (null) is treated as
 * "unknown", not as "empty" — a degraded probe must never authorize a write.
 *
 * Never throws: the PR is already open, which means ship's irreversible part
 * already succeeded. A refused edit is a note on a working ship, and ship has no
 * `failed` edge to park at anyway.
 */
async function backfillDescription(
  gh: GhRunner,
  repo: string,
  cwd: string,
  existing: ExistingPr,
  buildBody: () => Promise<string>,
  onProgress: ShipProgress,
  saga?: { store: Store; run: ShipRun },
): Promise<void> {
  const note = (detail: string): void =>
    onProgress({ repo, step: 'describe', status: 'note', detail });

  if (existing.body === null) {
    note('existing PR description could not be read — left unchanged');
    return;
  }
  // Whitespace is not a description someone wrote — it is the same emptiness with
  // invisible characters in it.
  if (existing.body.trim() !== '') {
    note('existing PR already has a description — kept');
    return;
  }

  const body = await buildBody();

  // Durable describe step + intent around the body UPDATE: the pre-state is
  // the body as it was read, the intent is the exact prose about to be written,
  // so a crash between update and result can be reconciled by body hash.
  if (saga !== undefined) {
    const at = nowIso();
    const { stepId, intentId } = openStepWithPreparation(saga.store, {
      run: saga.run,
      repo,
      step: 'describe',
      operationKey: `${saga.run.id}:${repo}:describe`,
      preState: { step: 'describe', prUrl: existing.url, preBodyHash: bodyHash(existing.body) },
      detail: 'backfill',
      at,
    });
    finalizeShipOperationIntent(saga.store, intentId, {
      step: 'describe',
      prUrl: existing.url,
      preBodyHash: bodyHash(existing.body),
      intendedBody: body,
    }, at);
    const attempt = await updatePrBody(gh, existing.url, cwd, body);
    if (attempt.ok) {
      // Adopt only the exact intended prose; a third body is a human edit.
      const current = await fetchPrBody(gh, existing.url, cwd).catch(() => null);
      if (current !== null && bodyHash(current) === bodyHash(body)) {
        markShipOperationApplied(saga.store, intentId, { appliedAt: nowIso(), resolvedAt: nowIso() });
        reconcileShipOperation(saga.store, intentId, 'reconciled', { resolvedAt: nowIso() });
        finishShipRepoStep(saga.store, stepId, {
          status: 'passed',
          detail: 'existing PR had no description — filled in',
          endedAt: nowIso(),
        });
      } else if (current !== null) {
        markShipOperationApplied(saga.store, intentId, { appliedAt: nowIso() });
        reconcileShipOperation(saga.store, intentId, 'ambiguous', {
          resolvedAt: nowIso(),
          detail: 'PR description updated, then edited — left as is',
        });
        finishShipRepoStep(saga.store, stepId, {
          status: 'note',
          detail: 'PR description updated, then edited — left as is',
          endedAt: nowIso(),
        });
      } else {
        markShipOperationApplied(saga.store, intentId, { appliedAt: nowIso() });
        reconcileShipOperation(saga.store, intentId, 'ambiguous', {
          resolvedAt: nowIso(),
          detail: 'PR description updated but could not be verified — left as is',
        });
        finishShipRepoStep(saga.store, stepId, {
          status: 'note',
          detail: 'PR description updated but could not be verified — left as is',
          endedAt: nowIso(),
        });
      }
      onProgress({
        repo,
        step: 'describe',
        status: 'pass',
        detail: 'existing PR had no description — filled in',
      });
      return;
    }
    reconcileShipOperation(saga.store, intentId, 'failed', {
      resolvedAt: nowIso(),
      detail: attempt.reason,
    });
    finishShipRepoStep(saga.store, stepId, {
      status: 'failed',
      detail: `existing PR had no description — update failed: ${attempt.reason}`,
      endedAt: nowIso(),
    });
    note(`existing PR had no description — update failed: ${attempt.reason}`);
    return;
  }

  const attempt = await updatePrBody(gh, existing.url, cwd, body);
  if (attempt.ok) {
    onProgress({
      repo,
      step: 'describe',
      status: 'pass',
      detail: 'existing PR had no description — filled in',
    });
    return;
  }
  note(`existing PR had no description — update failed: ${attempt.reason}`);
}

/**
 * Record, for every worktree, whether its branch still merges into its base.
 *
 * Runs for EVERY worktree, including one whose PR already existed and was skipped
 * above: mergeability goes stale on its own — the base moves under a PR nobody
 * touched — so a re-ship that skipped the PR work is exactly when a refreshed
 * answer matters most. This is also the whole staleness story (F4): the check is
 * re-run on every ship and the row is overwritten, so there is never a second,
 * older answer to accidentally read.
 *
 * A conflict does NOT fail the stage. `ship` has no `failed` edge, so treating one
 * as a failure would park the ticket at `ship` with no way out — and a retry
 * cannot resolve a conflict, only a human rebase can. Conflict state is recorded
 * and surfaced; the shipping itself succeeded, because the PR exists.
 *
 * Never throws for the same reason: `checkMergeable` already converts every git
 * failure into `unknown`, and a store failure here must not sink a ship that
 * otherwise worked. Observability is not allowed to break the operation it
 * observes.
 */
async function recordMergeChecks(
  store: Store,
  ticketId: number,
  worktrees: readonly WorktreeView[],
  git: GitRunner,
  onProgress: ShipProgress,
  manifest?: Manifest,
): Promise<void> {
  for (const wt of worktrees) {
    onProgress({ repo: wt.repo, step: 'merge', status: 'run' });
    try {
      const baseRef = manifest
        ? resolveBaselineBranchForPath(manifest, wt.repo)
        : wt.baseRef;
      const check = await checkMergeable(git, wt.path, baseRef);
      setMergeCheck(store, {
        ...check,
        ticketId,
        repo: wt.repo,
        baseRef,
        checkedAt: nowIso(),
      });
      // Matches the status `shipInside` will read back from the persisted row,
      // so the live event and the post-hoc render never disagree.
      onProgress({ repo: wt.repo, step: 'merge', status: mergeOpStatus(check.state) });
    } catch {
      // Already-degraded state: nothing is recorded for this repo, and a missing
      // row renders as nothing rather than as "clean".
      onProgress({ repo: wt.repo, step: 'merge', status: 'note', detail: 'check failed' });
    }
  }
}

/** One step of ship's per-repo work, in the order it happens. */
export type ShipStep = 'commit' | 'push' | 'describe' | 'pr' | 'merge';

/**
 * One structured progress event. `note` marks a step that was not (re-)run —
 * an idempotent retry adopting an already-open PR — so the live view never
 * claims work happened that didn't.
 */
export interface ShipStepEvent {
  repo: string;
  step: ShipStep;
  status: 'run' | 'pass' | 'fail' | 'note';
  detail?: string;
}

/**
 * Structured progress emitted as the ship progresses. Deliberately
 * non-throwing at the call sites (the caller's UI is observing, not controlling)
 * — a broken observer must never sink a ship that otherwise works.
 */
export type ShipProgress = (event: ShipStepEvent) => void;

export async function shipTicket(
  store: Store,
  opts: ShipOpts,
  gh: GhRunner = defaultGhRunnerAsync,
  adapter?: AgentAdapter,
  git: GitRunner = defaultGitRunner,
  onProgress: ShipProgress = () => {},
  onInsideProgress: (event: InsideProgressEvent) => void = () => {},
): Promise<ShipResult> {
  const ticket = getTicket(store, opts.ticketId);
  const worktrees = listWorktreesByTicket(store, opts.ticketId);
  const title = ticket.title ?? ticket.key ?? `Ticket ${opts.ticketId}`;
  const key = ticket.key ?? String(opts.ticketId);
  const conventions = opts.conventions ?? opts.manifest?.conventions;
  // A crash-recovery re-run can land here after an EARLIER call already
  // advanced the ticket past `ship` (§5.3 idempotency). One read, reused below
  // to gate both the head `setStage` and the tail `resolveShipLanding` call:
  // writing either one unconditionally on such a re-run would resurrect the
  // `ship` row as `running` beside a ticket already parked at `done` (or still
  // blocked awaiting its merge) — a state that never existed before this
  // guard, since the old unconditional tail transition used to repair it back
  // to `passed` on every call.
  const atShip = ticket.stageCurrent === 'ship';

  const insert = store.db.prepare(
    "INSERT INTO prs (ticket_id, repo, number, url, status) VALUES (?, ?, ?, ?, 'open')",
  );
  // Idempotency (§5.3): a re-run after a crash mid-ship must not re-open a PR for
  // a repo already shipped. Skip any worktree with an existing open PR row.
  const existingOpen = store.db.prepare(
    "SELECT repo, number, url FROM prs WHERE ticket_id = ? AND repo = ? AND status = 'open'",
  );

  // A retry re-runs this stage: clear any reason the last attempt recorded, so a
  // stale failure can't outlive the run that fixed it. Only when the ticket is
  // actually still at ship — see `atShip` above.
  if (atShip) {
    setStage(store, opts.ticketId, 'ship', { status: 'running', verdict: null, endedAt: null });
  }

  // The durable saga run: one row per invocation, opened before any work, so a
  // crash leaves a `running` run the next invocation can reconcile.
  const startedAt = nowIso();
  const runCount = store.db
    .prepare('SELECT COUNT(*) AS n FROM ship_runs WHERE ticket_id = ?')
    .get(opts.ticketId) as { n: number };
  const run = openShipRun(store, {
    ticketId: opts.ticketId,
    attempt: runCount.n + 1,
    // The run is opened BY this host: when the host dies, this pid is what
    // tells the activation sweep the run died with it (reconcileShipRuns).
    pid: process.pid,
    startedAt,
  });

  // Live Ship progress rides the SAME generic inside-progress union as gates
  // and Fix (Finding 12): the whole invocation is one 'ship' process — active
  // while it runs, a complete process row when it settles. Never the raw
  // per-repo/per-step structures the dashboard used to derive from.
  onInsideProgress(shipStartedEvent(opts.ticketId));

  // A crash-and-retry arrives with the previous run still `running`: adopt (or
  // refute) exactly the effects it persisted, then the fresh loop below redoes
  // whatever never landed. Runs BEFORE any fresh work — the old run's verdicts
  // must not be decided by the run that replaced it.
  await reconcilePriorShipOperations(store, opts.ticketId, run.id, worktrees, git, gh);

  const prs: ShippedPr[] = [];
  try {
    for (const wt of worktrees) {
      const prior = existingOpen.get(opts.ticketId, wt.repo) as
        | { repo: string; number: number | null; url: string }
        | undefined;
      if (prior) {
        prs.push({ repo: prior.repo, number: prior.number, url: prior.url });
        // Nothing ran this time — say so for every step this repo skips,
        // rather than leaving commit/push looking like they are still "to
        // come" (the old free-text channel simply skipped this repo entirely).
        const descriptionTemplate = conventions?.pullRequestDescription;
        // Task 3: the configured process decides what ship would run — a null
        // bundle (enabled: false) means the describe step would not run at all.
        const wouldDescribe = Boolean(
          (opts.prDescriptionProcess ?? adapter) &&
            (!descriptionTemplate || usesDescription(descriptionTemplate)),
        );
        const skipped: ShipStep[] = wouldDescribe
          ? ['commit', 'push', 'describe', 'pr']
          : ['commit', 'push', 'pr'];
        for (const step of skipped) {
          onProgress({
            repo: wt.repo,
            step,
            status: 'note',
            detail: 'existing PR already open — not re-shipped',
          });
        }
        continue;
      }
      // Push FIRST. `gh pr create` refuses a branch that exists only on this
      // machine ("you must first push the current branch to a remote"), and every
      // ticket works on a fresh worktree branch — so the branch is always
      // local-only until now. Before the model call, too: a push that cannot
      // succeed makes the PR impossible, and paying for a description first buys
      // prose for a PR that will never exist.
      // Commit before push: a stage marker means the agent thinks it is done, not
      // that it committed. Work left in the worktree would push an empty branch and
      // `gh pr create` would fail with "No commits between main and karst/…".
      const templateContext: ArtifactTemplateContext = {
        id: opts.ticketId,
        key,
        title,
        repo: wt.repo,
        type: resolveTicketType(ticket, conventions),
        scope: resolveRepoScope(opts.manifest, wt.repo),
      };
      const commitMessage = conventions?.commitMessage
        ? renderArtifactTemplate(
            'commitMessage',
            conventions.commitMessage,
            templateContext,
          )
        : title;
      const prTitle = conventions?.pullRequestTitle
        ? renderArtifactTemplate(
            'pullRequestTitle',
            conventions.pullRequestTitle,
            templateContext,
          )
        : title;

      // Provenance: whatever the branch carried BEFORE this ship ran, bounded
      // at the baseline PERSISTED at worktree creation — `rev-list <base>..HEAD`
      // — so the repository root and unrelated base-branch ancestry are never
      // stored as this ticket's "before ship" commits. A later manifest edit
      // that renames the baseline must never reinterpret that history: the
      // branch was cut from what the worktree row says, so that row is the only
      // honest bound. A worktree with no recorded baseline records nothing and
      // says so; it never silently substitutes the manifest's current answer,
      // and an unresolvable baseline parks ship (the `rev-list` failure is
      // bounded before it reaches the stage verdict).
      const provenanceBase = wt.baseRef ?? undefined;

      // The base branch this repo's PR targets — resolved from the CURRENT
      // manifest so the diff check and the PR base agree with what the repo
      // declares today. Live configuration only; never used to rewrite
      // provenance for the already-created worktree (see `provenanceBase`).
      const base = opts.manifest
        ? resolveBaselineBranchForPath(opts.manifest, wt.repo)
        : wt.baseRef ?? undefined;

      if (provenanceBase === undefined) {
        onProgress({
          repo: wt.repo,
          step: 'commit',
          status: 'note',
          detail: 'no baseline recorded — before-ship provenance unknown',
        });
      } else {
        for (const sha of await listCommitsFrom(git, wt.path, provenanceBase)) {
          recordShipCommit(store, {
            shipRunId: run.id,
            repo: wt.repo,
            sha,
            message: '',
            origin: 'before-ship',
          });
        }
      }

      // Commit — through the quarantine, so a crash between preparation and
      // landing stays owned and reconcilable. A clean worktree is a fact, not
      // work: the step reads `note`, never `pass`. A status that FAILED is
      // never a clean worktree — the agent's work may simply be unreadable, and
      // pushing an empty branch would open a PR that never carried it.
      const dirtyCheck = await git(['status', '--porcelain'], wt.path);
      if (dirtyCheck.exitCode !== 0) {
        throw new Error(describeGitFailure('git status --porcelain', dirtyCheck));
      }
      if (dirtyCheck.stdout.trim() === '') {
        onProgress({
          repo: wt.repo,
          step: 'commit',
          status: 'note',
          detail: 'worktree clean — nothing to commit',
        });
      } else {
        onProgress({ repo: wt.repo, step: 'commit', status: 'run' });
        const at = nowIso();
        const preHead = (await headCommit(git, wt.path)) ?? '';
        const preIndexTree = (await git(['write-tree'], wt.path)).stdout.trim();
        const { fingerprint } = await workingTreeSummary(git, wt.path);
        const identity = await gitIdentity(git, wt.path);
        const quarantineKey = randomUUID();
        const { stepId, intentId } = openStepWithPreparation(store, {
          run,
          repo: wt.repo,
          step: 'commit',
          operationKey: `${run.id}:${wt.repo}:commit`,
          preState: {
            step: 'commit',
            preHead,
            preIndexTree,
            worktreeFingerprint: fingerprint,
            message: commitMessage,
            author: identity,
            committer: identity,
            quarantineKey,
          },
          detail: commitMessage,
          at,
        });
        try {
          const prepared = await prepareCommitInQuarantine(git, wt.path, quarantineKey, {
            preHead,
            message: commitMessage,
            author: identity,
            committer: identity,
          });
          finalizeShipOperationIntent(
            store,
            intentId,
            {
              step: 'commit',
              intendedTree: prepared.intendedTree,
              expectedHead: prepared.expectedHead,
              quarantineKey,
            },
            nowIso(),
          );
          await promoteQuarantinedObjects(git, wt.path, quarantineKey);
          const cas = await compareAndSwapHeadAndIndex(git, wt.path, {
            preHead,
            expectedHead: prepared.expectedHead,
            intendedTree: prepared.intendedTree,
            preIndexTree,
            expectedFingerprint: fingerprint,
            quarantineKey,
          });
          if (!cas.ok) {
            // A divergence is never overwritten: the world moved under the
            // preparation, and only a human can say what should happen.
            throw new Error(`git commit refused in ${wt.path}: ${cas.reason}`);
          }
          markShipOperationApplied(store, intentId, { appliedAt: nowIso(), resolvedAt: nowIso() });
          reconcileShipOperation(store, intentId, 'reconciled', { resolvedAt: nowIso() });
          recordShipCommit(store, {
            shipRunId: run.id,
            repo: wt.repo,
            sha: prepared.expectedHead,
            message: commitMessage,
            origin: 'created-by-ship',
          });
          finishShipRepoStep(store, stepId, {
            status: 'passed',
            detail: prepared.expectedHead.slice(0, 7),
            endedAt: nowIso(),
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          reconcileShipOperation(
            store,
            intentId,
            detail.includes('commit refused') ? 'ambiguous' : 'failed',
            { resolvedAt: nowIso(), detail },
          );
          finishShipRepoStep(store, stepId, {
            status: 'failed',
            detail,
            endedAt: nowIso(),
          });
          throw err;
        }
        onProgress({ repo: wt.repo, step: 'commit', status: 'pass' });
      }

      if (base && !(await hasChangesFrom(git, wt.path, base))) {
        onProgress({
          repo: wt.repo,
          step: 'push',
          status: 'note',
          detail: `no push needed — no changes from ${base}`,
        });
        if (adapter) {
          onProgress({
            repo: wt.repo,
            step: 'describe',
            status: 'note',
            detail: `no description needed — no changes from ${base}`,
          });
        }
        onProgress({
          repo: wt.repo,
          step: 'pr',
          status: 'note',
          detail: `no PR needed — no changes from ${base}`,
        });
        continue;
      }

      // Push — pre-state and intent persisted BEFORE the external call, so a
      // crash after git accepted the push but before the result write is
      // reconciled by remote ref, never re-guessed.
      onProgress({ repo: wt.repo, step: 'push', status: 'run' });
      const pushAt = nowIso();
      const localHead = (await headCommit(git, wt.path)) ?? '';
      const ref = wt.branch ?? 'HEAD';
      const preRemoteHead = await remoteRefSha(git, wt.path, 'origin', ref);
      const pushOp = openStepWithPreparation(store, {
        run,
        repo: wt.repo,
        step: 'push',
        operationKey: `${run.id}:${wt.repo}:push`,
        preState: { step: 'push', localHead, remote: 'origin', ref, preRemoteHead },
        detail: ref,
        at: pushAt,
      });
      finalizeShipOperationIntent(
        store,
        pushOp.intentId,
        { step: 'push', localHead, remote: 'origin', ref, preRemoteHead },
        pushAt,
      );
      try {
        await pushBranch(git, wt.path);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        reconcileShipOperation(store, pushOp.intentId, 'failed', {
          resolvedAt: nowIso(),
          detail,
        });
        finishShipRepoStep(store, pushOp.stepId, {
          status: 'failed',
          detail,
          endedAt: nowIso(),
        });
        throw err;
      }
      markShipOperationApplied(store, pushOp.intentId, {
        appliedAt: nowIso(),
        resolvedAt: nowIso(),
      });
      reconcileShipOperation(store, pushOp.intentId, 'reconciled', { resolvedAt: nowIso() });
      finishShipRepoStep(store, pushOp.stepId, {
        status: 'passed',
        detail: ref,
        endedAt: nowIso(),
      });
      onProgress({ repo: wt.repo, step: 'push', status: 'pass' });

      // The `prs` table only knows about PRs karst itself opened, so a PR opened
      // by hand — or by a run whose row was lost — used to make ship fail with
      // gh's "a pull request for branch … already exists", permanently: openPr
      // threw before the insert below, so the local check above could never
      // absorb the retry, and ship has no `failed` edge to advance out of. An
      // open PR is what ship is FOR. Adopt it; the push above already gave it
      // the new commits.
      //
      // Probing BEFORE the create rather than rescuing after it also keeps
      // `describePr` from paying for prose describing a PR that already exists.
      onProgress({ repo: wt.repo, step: 'pr', status: 'run' });
      const existing = await findOpenPr(gh, wt.path);
      const descriptionTemplate = conventions?.pullRequestDescription;

      // RC5, stated in the public record: whether any gate stage's latest run
      // answered a different question set than the one before it. Ticket-wide
      // (the same for every repo), so computed once per worktree.
      const gateSetChanged = gateSetChangedSincePreviousRun(store, opts.ticketId);

      /**
       * The PR body, rendered exactly the same way whether it is about to open a
       * PR or to backfill one that was adopted — one description, one shape, so an
       * adopted PR cannot end up with prose in a different format from a created
       * one. The model call runs under its own durable describe step and
       * `pr-description` process run (see `generateDescription`).
       */
      // The deterministic fallback body, rendered locally from bounded branch
      // git facts (commit bullets + diffstat) — a ship with no AI process
      // still carries what changed rather than just the title. A failed read
      // degrades to a title-only body and never fails ship.
      const deterministicDescription = async (): Promise<string> => {
        let diffContext: PrDiffContext = {};
        if (base) {
          try {
            diffContext = await collectPrDiffContext(git, wt.path, base);
          } catch {
            diffContext = {};
          }
        }
        return renderPrDescription({
          title: prTitle,
          repo: wt.repo,
          branch: wt.branch ?? undefined,
          baseRef: base,
          ...diffContext,
          gateSetChanged,
        });
      };
      const runDescriptionStep = async (process: DriveProcessBundle | null | undefined): Promise<string> => {
        if (process) {
          // Task 3: the configured process bundle — its adapter AND its
          // assignment snapshot. The assignment rides the run; the adapter is
          // the same instrumented adapter the host resolved, so token usage
          // attribution stays centralized.
          return generateDescription(
            store,
            run,
            wt.repo,
            process.adapter,
            wt.path,
            prTitle,
            opts.ticketId,
            onProgress,
            onInsideProgress,
            process.assignment,
            gateSetChanged,
          );
        }
        if (process === null) {
          // Configured ABSENCE (enabled: false): no model call, no process run —
          // the deterministic branch-facts body is rendered locally instead,
          // and no passed AI process is recorded for work nobody did.
          return deterministicDescription();
        }
        // Legacy caller: no configured bundle, the positional adapter runs the
        // step as before (no identity snapshot — pre-Task-3 behavior).
        if (adapter) {
          return generateDescription(
            store,
            run,
            wt.repo,
            adapter,
            wt.path,
            prTitle,
            opts.ticketId,
            onProgress,
            onInsideProgress,
            undefined,
            gateSetChanged,
          );
        }
        return deterministicDescription();
      };
      const buildBody = async (): Promise<string> => {
        if (descriptionTemplate) {
          let description = prTitle;
          if (usesDescription(descriptionTemplate)) {
            description = await runDescriptionStep(opts.prDescriptionProcess);
          }
          return renderArtifactTemplate(
            'pullRequestDescription',
            descriptionTemplate,
            { ...templateContext, description },
          );
        }
        return runDescriptionStep(opts.prDescriptionProcess);
      };

      let opened: OpenedPr;
      if (existing) {
        // Adopting used to skip the description wholesale, which is right for a PR
        // that HAS one and wrong for the common case that produced this ticket: a
        // PR opened by hand, with an empty body, that nothing would ever fill.
        //
        // Three-valued on purpose, because the destructive mistake is asymmetric —
        // overwriting a description a human wrote is unrecoverable, leaving one
        // empty is not. So only a body gh positively reported as empty is filled;
        // "gh did not say" (null) is left alone, exactly like a degraded PR probe.
        noteReusedPr(wt.repo, onProgress);
        const prAt = nowIso();
        const prOp = openStepWithPreparation(store, {
          run,
          repo: wt.repo,
          step: 'pr',
          operationKey: `${run.id}:${wt.repo}:pr`,
          preState: {
            step: 'pr',
            head: wt.branch ?? 'HEAD',
            base: base ?? null,
            preExistingUrl: existing.url,
          },
          detail: `#${existing.number}`,
          at: prAt,
        });
        finalizeShipOperationIntent(
          store,
          prOp.intentId,
          {
            step: 'pr',
            head: wt.branch ?? 'HEAD',
            base: base ?? null,
            title: prTitle,
            body: '',
            preExistingUrl: existing.url,
          },
          prAt,
        );
        await backfillDescription(
          gh,
          wt.repo,
          wt.path,
          existing,
          buildBody,
          onProgress,
          { store, run },
        );
        markShipOperationApplied(store, prOp.intentId, {
          appliedAt: nowIso(),
          resolvedAt: nowIso(),
        });
        reconcileShipOperation(store, prOp.intentId, 'reconciled', { resolvedAt: nowIso() });
        finishShipRepoStep(store, prOp.stepId, {
          status: 'passed',
          detail: `adopted #${existing.number}`,
          prNumber: existing.number,
          existedBeforeShip: true,
          endedAt: nowIso(),
        });
        opened = existing;
      } else {
        const body = await buildBody();
        // Durable pr intent: pre-state BEFORE the external create, intent with
        // the exact head/base/title/body about to be sent.
        const prAt = nowIso();
        const prOp = openStepWithPreparation(store, {
          run,
          repo: wt.repo,
          step: 'pr',
          operationKey: `${run.id}:${wt.repo}:pr`,
          preState: {
            step: 'pr',
            head: wt.branch ?? 'HEAD',
            base: base ?? null,
            preExistingUrl: null,
          },
          detail: prTitle,
          at: prAt,
        });
        finalizeShipOperationIntent(
          store,
          prOp.intentId,
          {
            step: 'pr',
            head: wt.branch ?? 'HEAD',
            base: base ?? null,
            title: prTitle,
            body,
            preExistingUrl: null,
          },
          prAt,
        );
        const created = await openPr(gh, { cwd: wt.path, title: prTitle, body, base });
        if (created.adopted) {
          // The probe above answered null but a PR existed anyway — it is
          // branch-inferred, so bad auth or an ambiguous base repo looks exactly
          // like "no PR". gh named the PR when it refused, so nothing failed.
          //
          // The body just generated never reached GitHub. Re-probe by ref (the
          // branch lookup is the thing that just proved unreliable) and apply the
          // same rule as any adopted PR: fill an empty description, never
          // overwrite a written one. No second model call — the prose exists.
          noteReusedPr(wt.repo, onProgress);
          const current = await fetchPrBody(gh, created.url, wt.path);
          await backfillDescription(
            gh,
            wt.repo,
            wt.path,
            { ...created, body: current },
            async () => body,
            onProgress,
            { store, run },
          );
        }
        markShipOperationApplied(store, prOp.intentId, {
          appliedAt: nowIso(),
          resolvedAt: nowIso(),
        });
        reconcileShipOperation(store, prOp.intentId, 'reconciled', { resolvedAt: nowIso() });
        finishShipRepoStep(store, prOp.stepId, {
          status: 'passed',
          detail: created.adopted ? `adopted #${created.number}` : `opened #${created.number}`,
          prNumber: created.number,
          existedBeforeShip: created.adopted,
          endedAt: nowIso(),
        });
        opened = created;
      }
      onProgress({ repo: wt.repo, step: 'pr', status: 'pass' });
      insert.run(opts.ticketId, wt.repo, opened.number, opened.url);
      // The from-to branches and the opened stamp are what the ship stage shows
      // beside the PR it just made. Read them now, from the PR that exists, rather
      // than leaving the row blank until the next background sweep ticks — the
      // moment the user is looking at ship is the moment right after it ran.
      //
      // Never fatal: a failed probe leaves NULLs, which render as absent and are
      // filled by `syncPrStatuses` later. Observability must not break the
      // operation it observes, and the PR is already open — the irreversible part
      // succeeded.
      const detail = await fetchPrDetail(gh, opened.url, wt.path).catch(() => UNKNOWN_PR_DETAIL);
      updatePrDetail(store, {
        ticketId: opts.ticketId,
        repo: wt.repo,
        url: opened.url,
        detail,
      });
      prs.push({ repo: wt.repo, number: opened.number, url: opened.url });
    }
  } catch (err) {
    // Ship has no `failed` edge (graph.ts): a ticket whose PRs did not open has
    // NOT shipped, so it must stay at ship rather than advance. Record the reason
    // on the stage row — that is what the dashboard renders (a red node + the
    // fault card), so a failed ship is visible instead of a ticket that just sits
    // at "running" with the truth buried in the output channel. Re-thrown so the
    // caller still reports it; the PRs already opened stay recorded (idempotent
    // re-run skips them). The saga run is closed `failed` the same way — a
    // `running` run would read as still in flight, and the next invocation's
    // reconciliation must only ever find genuinely interrupted work.
    closeShipRun(store, run.id, 'failed', nowIso());
    setStage(store, opts.ticketId, 'ship', {
      status: 'failed',
      verdict: err instanceof Error ? err.message : String(err),
      endedAt: nowIso(),
    });
    onInsideProgress(shipFinishedEvent(opts.ticketId, 'fail'));
    throw err;
  }

  // Every branch is now pushed, so the merge probe measures what a reviewer would
  // actually see on the PR. Deliberately outside the try above: a failure here is
  // not a ship failure, and this must not reach the catch that parks the ticket.
  await recordMergeChecks(store, opts.ticketId, worktrees, git, onProgress, opts.manifest);
  closeShipRun(store, run.id, 'passed', nowIso());
  onInsideProgress(shipFinishedEvent(opts.ticketId, 'pass'));

  // PRs opened → attempt `done`, gated on every one of them reading merged (or
  // there being nothing to merge at all). Ship's own job ends here and its
  // verdict is still unaffected by merge state: a conflicted branch is a
  // shipped branch — `resolveShipLanding` only decides whether the ticket
  // advances past `ship` or stays parked there, blocked.
  //
  // Guarded with the SAME `atShip` read the head `setStage` above used — not a
  // fresh one: both writes describe the same run, so they must agree on whether
  // that run started genuinely at ship. Only the run that finds the ticket
  // still AT ship is the one entitled to decide its landing (see
  // `resolveShipLanding`'s doc comment for why this guard matters).
  if (atShip) {
    resolveShipLanding(store, opts.ticketId, opts.debug);
  }

  return { prs };
}
