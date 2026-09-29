import type { Store } from '../../store/db.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { DriveProcessBundle } from '../../agent/processAssignment.js';
import { resolvePresetDefaults } from '../../agent/agentPresets.js';
import {
  shipFinishedEvent,
  shipStartedEvent,
  type InsideProgressEvent,
} from '../../model/inside/progress.js';
import { randomUUID } from 'node:crypto';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { takeForcePushLease, armForcePushLease } from '../../store/worktrees.js';
import { getTicket } from '../../store/tickets.js';
import { listLandedStackedSubtasks } from '../../store/subtasks.js';
import { resolveShipLanding } from '../mergeGate.js';
import { settleSubtaskGate } from '../subtaskGate.js';
import { integrateAndReleaseParent } from '../subtaskIntegration.js';
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
  type GhRunner,
  type OpenedPr,
} from '../../integrations/github.js';
import { updatePrDetail, recordShippedPr } from '../../store/prs.js';
import { scanPorcelainForDenied, describeDenyHits } from '../shipDenyScan.js';
import {
  countShipRuns,
  findExistingLivePr,
  findMergedPr,
  findPriorShipRun,
  getShipOperationIntentRow,
  listUnfinishedShipRepoSteps,
  openStepWithPreparation,
  shipCommitRecorded,
  type ShipProgress,
  type ShipStep,
} from './shipStore.js';
import { backfillDescription, bodyHash, generateDescription, noteReusedPr } from './shipDescription.js';
import {
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
  GIT_PUSH_TIMEOUT_MS,
  type GitRunner,
  type PersistedCommitIdentity,
} from '../../integrations/git.js';
import {
  adoptShipOperation,
  closeShipRun,
  finalizeShipOperationIntent,
  finishShipRepoStep,
  listShipEvidence,
  markShipOperationApplied,
  openShipRepoStep,
  openShipRun,
  parseShipIntent,
  parseShipPreState,
  reconcileShipOperation,
  recordShipCommit,
  type ShipOperationIntent,
  type ShipOperationPreState,
  type ShipRun,
} from '../../store/shipRuns.js';
import { checkMergeable } from '../mergeCheck.js';
import { setMergeCheck } from '../../store/mergeChecks.js';
import { mergeOpStatus } from '../../model/mergeCheckView.js';
import type { WorktreeView } from '../../store/dashboard.js';
import type { AgentProvider, ArtifactConventions, Manifest } from '../../manifest/types.js';
import { resolveTicketBaseRef } from '../baseRef.js';
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
  type PrDescriptionContext,
  type PrDiffContext,
} from '../prDescription.js';
import { collectPrDiffContext } from '../prDiffContext.js';
import { resolveRepoName, resolveRepoScope, resolveTicketType } from '../conventionContext.js';
import { DEFAULT_PR_DESCRIPTION_TEMPLATE } from '../conventionPresets.js';

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
  /**
   * Run for THESE repositories only (values are `worktrees.repo`, the same
   * key `ship_repo_steps.repo` stores) — the per-repo Retry control in the
   * Inside block. Absent → every worktree of the ticket, the whole-ticket
   * ship. An entry naming no worktree of this ticket is ignored; a scope that
   * matches nothing fails the stage rather than silently shipping nothing.
   */
  repos?: readonly string[];
  /**
   * Deliver new work into a pull request this ticket ALREADY opened, instead of
   * skipping the repo.
   *
   * Default false — the crash-recovery behaviour this stage was built with: a
   * re-run after a mid-ship crash must not redo a repo the previous run already
   * pushed, so a live PR means "skip".
   *
   * True is the opposite situation: the ticket went back through fix and has NEW
   * work for a PR that is already open. Setup, commit and push run; the whole PR
   * region is skipped, because the PR and its body already exist. Commit is
   * included deliberately — implementation may legitimately finish with changes
   * still uncommitted in the worktree, because this stage is what materialises
   * commits.
   */
  deliverToOpenPr?: boolean;
}

export interface ShippedPr {
  repo: string;
  number: number | null;
  url: string;
}

export interface ShipResult {
  prs: ShippedPr[];
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

/**
 * The `{model}` value for the PR description template, following the launch
 * precedence: the per-ticket model override, else the manifest-level default,
 * else nothing (the agent CLI picks its own default — rendered as `n/a` by the
 * default template). Blank at either level counts as "inherit".
 *
 * The manifest-level default is PRESET-AWARE: the effective preset supplies it
 * only when the ticket's own core is the preset's core (a preset is a
 * core+model pair), and the legacy `defaultModel` covers every other case.
 */
function resolveTemplateModel(
  ticket: {
    model: string | null;
    agentProvider?: AgentProvider | null;
    agentPreset?: string | null;
  },
  manifest?: Manifest,
): string | undefined {
  const defaults = manifest
    ? resolvePresetDefaults(manifest, 'implementation', {
        ticketPreset: ticket.agentPreset ?? null,
        explicitProvider: ticket.agentProvider ?? null,
      })
    : undefined;
  for (const candidate of [ticket.model, defaults?.model ?? manifest?.defaultModel]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/** A ShipRepoStep as stored — the four saga steps (merge stays a live event). */
type SagaStep = 'commit' | 'push' | 'describe' | 'pr';

/** Record a created-by-ship commit unless the run already recorded it (idempotent adoption). */
function recordCreatedCommitIfAbsent(
  store: Store,
  runId: number,
  repo: string,
  sha: string,
  message: string,
): void {
  if (!shipCommitRecorded(store, runId, repo, sha)) {
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
  scope: readonly WorktreeView[] = worktrees,
): Promise<void> {
  const prev = findPriorShipRun(store, ticketId, currentRunId);
  if (prev === undefined) return;

  const openSteps = listUnfinishedShipRepoSteps(store, prev.id);
  const pathByRepo = new Map(worktrees.map((wt) => [wt.repo, wt.path]));
  const scopeRepos = new Set(scope.map((wt) => wt.repo));

  for (const step of openSteps) {
    // A scoped retry re-ships only the named repositories. An out-of-scope
    // repo's interrupted step belongs to a run this retry is NOT continuing —
    // leave its recorded evidence untouched (the out-of-scope guard decides
    // whether it may pass). Marking it "worktree gone" here would both corrupt
    // its recorded failure and flip its operation intent to `ambiguous`.
    if (!scopeRepos.has(step.repo)) continue;
    if (step.operation_intent_id === null) continue;
    const intentRow = getShipOperationIntentRow(store, step.operation_intent_id);
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
      // Mirror the forward guard (`localHead !== '' && preRemoteHead === localHead`
      // at the push step): an unreadable local head (`''`) is not a head, and an
      // unreadable remote ref (`null`) is "nothing to compare" — never a match.
      // Without this, `(null ?? '') === ''` adopted a push that never happened.
      if (intent.localHead !== '' && now === intent.localHead) {
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
 * Say that a branch carrying no effective change from its base publishes,
 * describes and opens nothing — the whole remaining tail of a repo's ship.
 *
 * One renderer for both places that reach this verdict: the probe that runs
 * BEFORE the commit for a clean worktree (fu1 — an untouched repo never enters
 * the commit machinery at all), and the one after a commit landed.
 */
function noteNothingToShip(
  onProgress: ShipProgress,
  repo: string,
  base: string,
  describes: boolean,
): void {
  onProgress({
    repo,
    step: 'push',
    status: 'note',
    detail: `no push needed — no changes from ${base}`,
  });
  if (describes) {
    onProgress({
      repo,
      step: 'describe',
      status: 'note',
      detail: `no description needed — no changes from ${base}`,
    });
  }
  onProgress({
    repo,
    step: 'pr',
    status: 'note',
    detail: `no PR needed — no changes from ${base}`,
  });
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
        ? resolveTicketBaseRef(store, ticketId, wt.repo, manifest)
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

// `ShipStep`, `ShipStepEvent` and `ShipProgress` now live in `shipStore.ts`
// (NDL-40) alongside the rest of ship's raw store access; re-exported here so
// every existing import of them from `ship.js` keeps working unchanged.
export type { ShipStep, ShipStepEvent, ShipProgress } from './shipStore.js';

/**
 * Whether a thrown error came from SQLite rather than from the repo being
 * shipped.
 *
 * The per-repo catch in `shipTicket` isolates one worktree's failure from the
 * worktrees after it — but only failures that are actually that worktree's
 * (git, gh, the description model). A store write that fails is the source of
 * truth failing, which is nobody's repo and everybody's problem, so it must
 * still abort the whole loop.
 *
 * better-sqlite3 stamps its errors with a `SQLITE_`-prefixed `code`; that
 * string, not the class, is what identifies them — the addon is loaded through
 * `bindings` and a rebuilt copy is a DIFFERENT constructor, so `instanceof`
 * against an imported `SqliteError` is not reliable here.
 */
/** How much of ONE repo's failure the aggregate ship verdict carries. */
const SHIP_FAILURE_DETAIL_LIMIT = 300;

/**
 * One repo's failure, bounded, for the aggregate verdict.
 *
 * The verdict is a stage row the dashboard renders, and with per-repo
 * isolation it now concatenates every failed repo's reason rather than the one
 * error that aborted the run. Each reason already carries git's own stderr, so
 * an unbounded join is a repo count multiplied by whatever a tool decided to
 * print. Truncation is marked, never silent.
 */
function boundedFailure(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= SHIP_FAILURE_DETAIL_LIMIT
    ? flat
    : `${flat.slice(0, SHIP_FAILURE_DETAIL_LIMIT)}…`;
}

function isStoreFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_');
}

// `hasCompletedShipRun` now lives in `shipStore.ts` (NDL-40); re-exported here
// so every existing `from './ship.js'` import keeps working unchanged.
export { hasCompletedShipRun } from './shipStore.js';

/** The outcome of a sub-task's fork-point ship precondition (NDL-85). */
export interface SubtaskForkPushOutcome {
  /**
   * True when `ship` was parked: either the remote parent branch diverged from
   * the sub-task's fork point, or the fork point could not be resolved/verified.
   * The caller must NOT push or open a PR — the park holds until integration.
   */
  diverged: boolean;
}

/** Park a `ship` stage on `awaiting-subtask`, mirroring the gate's own park shape. */
function parkShipAwaitingSubtask(
  store: Store,
  ticketId: number,
  reason: string,
  debug?: (message: string) => void,
): void {
  debug?.(`[driver] ticket ${ticketId}: parking 'ship' — ${reason}`);
  setStage(store, ticketId, 'ship', {
    status: 'pending',
    verdict: null,
    endedAt: null,
    blockedKind: 'awaiting-subtask',
    blockedReason: reason,
    blockedAt: nowIso(),
  });
}

/** The remote's current sha for `refs/heads/<branch>`, or null when unreadable. */
async function lsRemoteBranchSha(
  git: GitRunner,
  cwd: string,
  branch: string,
): Promise<string | null> {
  const ls = await git(['ls-remote', 'origin', `refs/heads/${branch}`], cwd);
  if (ls.exitCode !== 0) return null;
  const sha = ls.stdout.trim().split(/\s+/)[0] ?? '';
  return sha === '' ? null : sha;
}

/**
 * Sub-task ship precondition (NDL-85, design NDL-70 §4/§6).
 *
 * A sub-task's PR targets its parent's branch, so `origin/<parentBranch>` must
 * contain the sub-task's fork point — otherwise the PR diff would re-show the
 * parent's own commits. Ensure it with a **non-force**, fast-forward-only push
 * of the fork point: a plain push is inherently ff-only, and this one carries
 * only the commits the sub-task was already built on. Never a force push.
 *
 * A rejected push means the remote moved: a sibling visited first and the parent
 * has not integrated it yet. The rejection is read from git's EXIT STATE, and
 * confirmed by comparing the remote ref against the fork point — never by
 * parsing stderr prose. On divergence the sub-task's `ship` is parked
 * `awaiting-subtask` ("parent branch must integrate <siblingKey> first"); parent
 * integration (NDL-75) clears it, and no push or PR happens here.
 *
 * Every branch is logged through the injected `debug` with the `[driver]`
 * prefix. Returns `{ diverged: false }` for anything that is not a stacked
 * sub-task (no parent, or no parent branch worktree in this repo).
 */
export async function ensureSubtaskForkPointOnParentBranch(
  store: Store,
  ticketId: number,
  repo: string,
  cwd: string,
  git: GitRunner,
  debug?: (message: string) => void,
): Promise<SubtaskForkPushOutcome> {
  const parentId = getTicket(store, ticketId).subtaskParentId;
  if (parentId === null) return { diverged: false };

  const parentWt = listWorktreesByTicket(store, parentId).find(
    (w) => w.repo === repo && w.branch !== null && w.branch !== '',
  );
  if (!parentWt?.branch) {
    debug?.(
      `[driver] ticket ${ticketId}: parent has no branch worktree in '${repo}' — ` +
        'nothing to stack onto, skipping fork-point push',
    );
    return { diverged: false };
  }
  const parentBranch = parentWt.branch;

  // The fork point is where the sub-task branched off the parent's branch. The
  // parent's newest commits may not be pushed yet (the sub-task stacks on the
  // parent's LOCAL head), so this is exactly what the remote must come to carry.
  const forkRes = await git(['merge-base', 'HEAD', parentBranch], cwd);
  const forkSha = forkRes.stdout.trim();
  if (forkRes.exitCode !== 0 || forkSha === '') {
    parkShipAwaitingSubtask(
      store,
      ticketId,
      `sub-task ship precondition failed: cannot resolve the fork point of '${parentBranch}'`,
      debug,
    );
    return { diverged: true };
  }

  debug?.(
    `[driver] ticket ${ticketId}: ensuring origin/${parentBranch} contains fork point ` +
      `${forkSha.slice(0, 7)}`,
  );
  const push = await git(['push', 'origin', `${forkSha}:refs/heads/${parentBranch}`], cwd, {
    timeoutMs: GIT_PUSH_TIMEOUT_MS,
  });
  if (push.exitCode === 0) {
    debug?.(`[driver] ticket ${ticketId}: origin/${parentBranch} already carries the fork point`);
    return { diverged: false };
  }

  // Rejected. Confirm the ref actually moved before calling it divergence: a
  // remote left exactly at the fork point means the failure was not a
  // non-fast-forward, and mislabeling it would silently park real errors.
  const remoteSha = await lsRemoteBranchSha(git, cwd, parentBranch);
  if (remoteSha === null || remoteSha === forkSha) {
    debug?.(
      `[driver] ticket ${ticketId}: fork-point push to origin/${parentBranch} failed without ` +
        'a ref change — surfacing the git failure instead of parking',
    );
    throw new Error(
      describeGitFailure(`git push ${forkSha.slice(0, 7)}:refs/heads/${parentBranch}`, push),
    );
  }

  // A rejection alone is not divergence: pushing an ANCESTOR of the remote head
  // is also refused as non-fast-forward. If the remote already contains the fork
  // point (a sibling landed on top of it), the precondition holds — parking here
  // would never release, because the child's fork point cannot change without a
  // rebase. Only a remote that lacks the fork point has truly diverged.
  const fetch = await git(['fetch', 'origin', `refs/heads/${parentBranch}`], cwd, {
    timeoutMs: GIT_PUSH_TIMEOUT_MS,
  });
  if (fetch.exitCode !== 0) {
    throw new Error(describeGitFailure(`git fetch origin ${parentBranch}`, fetch));
  }
  const contains = await git(['merge-base', '--is-ancestor', forkSha, remoteSha], cwd);
  if (contains.exitCode === 0) {
    debug?.(
      `[driver] ticket ${ticketId}: origin/${parentBranch} (${remoteSha.slice(0, 7)}) already ` +
        'contains the fork point — precondition satisfied',
    );
    return { diverged: false };
  }
  if (contains.exitCode !== 1) {
    throw new Error(describeGitFailure(`git merge-base --is-ancestor ${forkSha.slice(0, 7)}`, contains));
  }

  // The remote moved to a history without the fork point: a sibling landed on an
  // older base and the parent has not integrated it (and pushed) yet.
  const siblings = listLandedStackedSubtasks(store, parentId, repo, parentBranch)
    .filter((s) => s.id !== ticketId)
    .map((s) => s.key);
  const siblingKey = siblings.length > 0 ? siblings.join(', ') : 'another sub-task';
  const reason = `parent branch must integrate ${siblingKey} first`;
  debug?.(
    `[driver] ticket ${ticketId}: origin/${parentBranch} diverged (${remoteSha.slice(0, 7)}) — ${reason}`,
  );
  parkShipAwaitingSubtask(store, ticketId, reason, debug);
  return { diverged: true };
}

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
  const allWorktrees = worktrees;
  const scoped = opts.repos
    ? allWorktrees.filter((wt) => opts.repos!.includes(wt.repo))
    : allWorktrees;
  if (opts.repos) {
    opts.debug?.(
      `[gate] ship ticket ${opts.ticketId}: scoped to ${scoped.length}/${allWorktrees.length} repo(s)`,
    );
  }
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

  // Sub-task gating (design NDL-70 §5): a parent whose stacked sub-tasks have
  // not landed does not ship. This runs on ENTRY, before any commit, push or
  // PR is opened, and parks `ship` with an `awaiting-subtask` block instead —
  // nothing irreversible happens. The block clears (design §5) when the last
  // stacked sub-task lands, returning ship to its confirm click. Only stacked
  // children count: a non-blocking sub-task that was never started does not
  // hold the ship.
  //
  // Integration runs FIRST (NDL-75): a landed sub-task's work is merged into the
  // parent's local branch before the gate is evaluated, so `ship` never opens a
  // PR for a branch missing the child's commits. A park from integration holds
  // the stage — `settleSubtaskGate` refuses to advance past one.
  if (atShip) {
    await integrateAndReleaseParent(store, opts.ticketId, git, opts.debug);
    if (settleSubtaskGate(store, opts.ticketId, 'ship', opts.debug).blocked) {
      return { prs: [] };
    }
  }

  // Idempotency (§5.3): a re-run after a crash mid-ship must not re-open a PR for
  // a repo already shipped. Skip any worktree with an existing LIVE PR row —
  // not just 'open': `updatePrDetail` overwrites `status` with the PR's real
  // upstream state right after this row is created (e.g. 'draft' for a draft
  // PR), so matching only 'open' misses it on the very next retry (Defect 3).
  // 'closed'/'merged' are the only terminal states; everything else — 'open',
  // 'draft', 'unknown', or NULL (never probed) — is still live and must skip.
  //
  // A repo whose PR has LANDED is FINISHED for a scoped retry: the out-of-scope
  // completeness guard below must not count it as outstanding work just because
  // it cannot re-probe it (`findOpenPr` rejects a non-OPEN PR).
  //
  // It does NOT skip the repo for THIS ship. A ticket that went through a fix
  // cycle after its PR merged carries new commits that must reach GitHub as a
  // fresh PR — the codebase already expects a repo re-shipped after a merge to
  // hold both the merged row and a new open one (`CURRENT_PR_ORDER`). Skipping a
  // merged repo strands those commits and lets the ticket read landed and walk to
  // `done` without shipping them (FIX-46 review).

  // A retry re-runs this stage: clear any reason the last attempt recorded, so a
  // stale failure can't outlive the run that fixed it. Only when the ticket is
  // actually still at ship — see `atShip` above.
  if (atShip) {
    setStage(store, opts.ticketId, 'ship', { status: 'running', verdict: null, endedAt: null });
  }

  // The durable saga run: one row per invocation, opened before any work, so a
  // crash leaves a `running` run the next invocation can reconcile.
  const startedAt = nowIso();
  const run = openShipRun(store, {
    ticketId: opts.ticketId,
    attempt: countShipRuns(store, opts.ticketId) + 1,
    // The run is opened BY this host (v34): when the host dies, this pid is
    // what tells the activation sweep the run died with it — so it can tell a
    // ship killed by process death from one another LIVE window is still
    // executing (reconcileShipRuns parks it failed, the stranded-ship sweep
    // resumes it).
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
  // Pass BOTH the full worktree list (so the path map knows every repo — an
  // out-of-scope repo must not read as a missing worktree) and the scoped
  // subset (so only the retried repos' interrupted steps are reconciled).
  await reconcilePriorShipOperations(store, opts.ticketId, run.id, allWorktrees, git, gh, scoped);

  const prs: ShippedPr[] = [];
  // Per-repo failures (§Defect 1): a push/commit/PR failure in one worktree
  // must not prevent every worktree AFTER it from being committed, pushed,
  // and PR'd. Each iteration is isolated in its own try/catch; a failure is
  // recorded here and the loop continues. Only after every worktree has had
  // its turn does an aggregate failure (naming every repo that failed) reach
  // the outer catch below — which is what parks the ship stage with a
  // verdict. Repos that succeeded keep their persisted PR rows and ship-run
  // bookkeeping exactly as if nothing failed, so a retry skips them.
  const repoFailures: { repo: string; message: string }[] = [];
  // Repos that exited via a no-change path (either probe). Per repo this is a
  // correct no-op — a multi-repo ticket legitimately leaves most repos
  // untouched — but EVERY target being untouched means the ticket's work never
  // reached its branches, and that is checked once, after the loop.
  const noChangeRepos: string[] = [];
  try {
    if (opts.repos && scoped.length === 0) {
      throw new Error(
        `ship scope named no repository of this ticket (${opts.repos.join(', ')})`,
      );
    }
    for (const wt of scoped) {
      try {
        const prior = findExistingLivePr(store, opts.ticketId, wt.repo);
        const deliveringToOpenPr = Boolean(prior && opts.deliverToOpenPr);
        if (prior && !opts.deliverToOpenPr) {
          prs.push({ repo: prior.repo, number: prior.number, url: prior.url });
          // Nothing ran this time — say so for every step this repo skips,
          // rather than leaving commit/push looking like they are still "to
          // come" (the old free-text channel simply skipped this repo entirely).
          const descriptionTemplate = conventions?.pullRequestDescription ?? DEFAULT_PR_DESCRIPTION_TEMPLATE;
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
        if (deliveringToOpenPr && prior) {
          // The PR exists but the work is new. Commit and push onto the SAME head
          // branch, which updates the PR in place. The PR region below is skipped —
          // the PR and its body already exist, and re-describing would either
          // overwrite a human's edits or pay for prose nobody reads. The `pr`
          // progress events are emitted AFTER the push lands (the guarded region's
          // `else` below), so the live view shows the same run→pass the normal
          // path does instead of a note that contradicts the recorded step.
          prs.push({ repo: prior.repo, number: prior.number, url: prior.url });
          opts.debug?.(
            `[gate] ship ticket ${opts.ticketId}: repo ${wt.repo} delivering into existing PR ${prior.url}`,
          );
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
        // `{repo}`/`{scope}` name the manifest repository ENTRY, never the
        // worktree's local path — worktrees are keyed by path, the manifest by
        // name, and a public artifact must not leak the machine's directory
        // layout (PR bodies once shipped "Repository: /Users/nd/…").
        const repoName = resolveRepoName(opts.manifest, wt.repo);
        const templateContext: ArtifactTemplateContext = {
          id: opts.ticketId,
          key,
          title,
          repo: repoName,
          type: resolveTicketType(ticket, conventions),
          scope: resolveRepoScope(opts.manifest, repoName),
          // Implementation metadata for the PR description template: the agent
          // that actually ran the impl session wins, then the per-ticket core
          // override, then the manifest default; the model mirrors the launch
          // precedence (ticket override, else manifest default).
          provider: ticket.sessionProvider ?? ticket.agentProvider ?? opts.manifest?.agentProvider ?? 'claude',
          model: resolveTemplateModel(ticket, opts.manifest),
          approach: ticket.approach ?? undefined,
          sessionId: ticket.sessionId ?? undefined,
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
          ? resolveTicketBaseRef(store, opts.ticketId, wt.repo, opts.manifest)
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
        // `-uall` (not the default collapsed form): the deny scan below needs
        // every untracked FILE, and `--porcelain` alone reports an untracked
        // directory as one `dir/` entry. One call serves both readers — the
        // emptiness test and the scan — so ship gains no extra git invocation.
        const dirtyCheck = await git(['status', '--porcelain', '-uall'], wt.path);
        if (dirtyCheck.exitCode !== 0) {
          throw new Error(describeGitFailure('git status --porcelain -uall', dirtyCheck));
        }
        const clean = dirtyCheck.stdout.trim() === '';

        // Ship stages the WHOLE worktree — `git add -A`, inside
        // `prepareCommitInQuarantine` — so a file an agent left behind becomes a
        // commit, a push to origin, and a public PR with no human in the loop.
        // Untracked entries are the entire risk surface: a file the repository
        // already tracks is already published, which is also the escape hatch
        // (commit a deliberate fixture once by hand and it is never scanned
        // again). Refusing is per-repo — the loop's own catch records it and the
        // repos after this one still ship.
        if (!clean) {
          const denied = scanPorcelainForDenied(dirtyCheck.stdout);
          if (denied.length > 0) {
            const detail = describeDenyHits(denied, wt.repo);
            opts.debug?.(`[gate] ship ticket ${opts.ticketId}: deny scan hit ${denied.length} file(s) in ${wt.repo}`);
            onProgress({ repo: wt.repo, step: 'commit', status: 'fail', detail });
            throw new Error(detail);
          }
        }

        // fu1: a repo the ticket never touched is settled BEFORE the commit
        // machinery runs, not after it. A clean worktree whose branch carries no
        // effective change from the base — the shape a multi-repo ticket produces
        // for every repo it did not edit — is a no-op for every step, and saying
        // so up front is what keeps ship off the network for it entirely.
        // A DIRTY worktree is never answered here: the commit below is exactly
        // what changes the answer, so its probe runs after the commit lands.
        const preCommitChanges =
          clean && base ? await hasChangesFrom(git, wt.path, base, wt.branch) : null;
        if (provenanceBase !== undefined && base && preCommitChanges === false) {
          onProgress({
            repo: wt.repo,
            step: 'commit',
            status: 'note',
            detail: `no changes from ${base} — nothing to commit`,
          });
          noteNothingToShip(onProgress, wt.repo, base, adapter !== undefined);
          opts.debug?.(`[gate] ship ticket ${opts.ticketId}: ${wt.repo} unchanged from ${base} (pre-commit)`);
          noChangeRepos.push(wt.repo);
          continue;
        }

        if (clean) {
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
          // A failed `git write-tree` (a transient index lock held by a concurrent
          // git process) must be a READ failure, never a silently-captured `''`:
          // the compare-and-swap then compares the real tree against the empty
          // string and refuses with a false `index-diverged` — a misdiagnosed read
          // failure reported as the world having moved.
          const preIndex = await git(['write-tree'], wt.path);
          if (preIndex.exitCode !== 0) {
            throw new Error(describeGitFailure('git write-tree', preIndex));
          }
          const preIndexTree = preIndex.stdout.trim();
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

        // A clean worktree already answered this above — asking twice would fetch
        // the remote a second time for the same fact.
        const changedFromBase =
          preCommitChanges ?? (base ? await hasChangesFrom(git, wt.path, base, wt.branch) : true);
        if (provenanceBase !== undefined && base && !changedFromBase) {
          noteNothingToShip(onProgress, wt.repo, base, adapter !== undefined);
          opts.debug?.(`[gate] ship ticket ${opts.ticketId}: ${wt.repo} unchanged from ${base} (post-commit)`);
          noChangeRepos.push(wt.repo);
          continue;
        }

        // Push — pre-state and intent persisted BEFORE the external call, so a
        // crash after git accepted the push but before the result write is
        // reconciled by remote ref, never re-guessed.
        const pushAt = nowIso();
        const localHead = (await headCommit(git, wt.path)) ?? '';
        const ref = wt.branch ?? 'HEAD';
        const preRemoteHead = await remoteRefSha(git, wt.path, 'origin', ref);

        // Sub-task ship precondition (NDL-85, design NDL-70 §4/§6): a sub-task
        // opens its PR INTO the parent branch, so `origin/<parentBranch>` must
        // carry the fork point before the child branch is pushed. A plain,
        // non-force push of the fork point proves it atomically; a rejection
        // means a sibling landed first and the parent has not integrated it, so
        // `ship` parks `awaiting-subtask` and nothing is pushed or PR'd.
        if (ticket.subtaskParentId !== null) {
          const precondition = await ensureSubtaskForkPointOnParentBranch(
            store,
            opts.ticketId,
            wt.repo,
            wt.path,
            git,
            opts.debug,
          );
          if (precondition.diverged) return { prs: [] };
        }

        // fu1: the remote already carries this exact HEAD — an earlier attempt's
        // push landed and only its result write was lost. Re-pushing publishes
        // nothing, and against a slow or unreachable remote it spends the whole
        // push budget only to fail a stage whose work is already on origin. The
        // remote-tracking ref is trustworthy here because the change probe above
        // fetched this branch from origin moments ago; an unreadable HEAD (`''`)
        // never matches and always pushes.
        if (localHead !== '' && preRemoteHead === localHead) {
          onProgress({
            repo: wt.repo,
            step: 'push',
            status: 'note',
            detail: `already published — origin/${ref} is at ${localHead.slice(0, 7)}`,
          });
        } else {
          onProgress({ repo: wt.repo, step: 'push', status: 'run' });
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
          // `took` is the fact that the flag was cleared; `preRemoteHead` only
          // decides whether that lease is usable. An unreadable remote ref
          // (`null`) still consumes the flag, so the push degrades to a plain
          // one — never let that also erase the re-arm decision, or the ticket
          // is stranded at ship forever.
          const took = takeForcePushLease(store, opts.ticketId, wt.repo);
          const lease = took && preRemoteHead ? { ref, expected: preRemoteHead } : undefined;
          try {
            await pushBranch(git, wt.path, { forceWithLease: lease });
          } catch (err) {
            // The lease was taken (cleared) above, before this push ran — even
            // when it could not be turned into an actual `--force-with-lease`
            // (no readable remote ref). The push failing does not undo the
            // rewrite it was guarding against — the branch is still rebased —
            // so a lease taken for THIS attempt must be handed back, or every
            // retry from here on is a plain push that a rewritten,
            // already-published branch will always reject.
            if (took) {
              armForcePushLease(store, opts.ticketId, wt.repo);
            }
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
            // This run's push never landed, but a PR for the branch may already
            // exist on GitHub — opened by hand, or by an attempt whose result
            // write was lost. Without this probe, ship never reaches the `pr`
            // step, so `prs` never gets a row and `karst context`/the dashboard
            // report no PR at all for a repo that actually has one open on
            // GitHub. Adoption here must never fail the push error it is
            // reporting alongside.
            try {
              const adopted = await findOpenPr(gh, wt.path);
              if (adopted) {
                recordShippedPr(store, {
                  ticketId: opts.ticketId,
                  repo: wt.repo,
                  number: adopted.number,
                  url: adopted.url,
                });
                const adoptedDetail = await fetchPrDetail(gh, adopted.url, wt.path).catch(
                  () => UNKNOWN_PR_DETAIL,
                );
                updatePrDetail(store, {
                  ticketId: opts.ticketId,
                  repo: wt.repo,
                  url: adopted.url,
                  detail: adoptedDetail,
                });
                if (!deliveringToOpenPr) {
                  prs.push({ repo: wt.repo, number: adopted.number, url: adopted.url });
                }
              }
            } catch {
              // Observability must not compound the push failure being thrown.
            }
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
        }

        if (!deliveringToOpenPr) {
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
          // A manifest that declares no description template still gets the default
          // one — that is how the metadata (provider/model/approach/session) ships
          // by default. Clearing the field or replacing it is what turns it off.
          const descriptionTemplate = conventions?.pullRequestDescription ?? DEFAULT_PR_DESCRIPTION_TEMPLATE;

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
          const deterministicDescription = (diffContext: PrDiffContext): string =>
            renderPrDescription({
              title: prTitle,
              repo: wt.repo,
              branch: wt.branch ?? undefined,
              baseRef: base,
              ...diffContext,
              gateSetChanged,
            });
          const runDescriptionStep = async (
            process: DriveProcessBundle | null | undefined,
            ctx: PrDescriptionContext,
          ): Promise<string> => {
            if (process) {
              // Task 3: the configured process bundle — its adapter AND its
              // assignment snapshot. The assignment rides the run; the adapter is
              // the same instrumented adapter the host resolved, so token usage
              // attribution stays centralized.
              opts.debug?.(
                `[ship] ticket ${opts.ticketId} ${wt.repo}: PR description via configured process ${process.assignment?.agentName ?? '?'}`,
              );
              return generateDescription(
                store,
                run,
                wt.repo,
                process.adapter,
                wt.path,
                ctx,
                opts.ticketId,
                onProgress,
                onInsideProgress,
                process.assignment,
              );
            }
            if (process === null) {
              // Configured ABSENCE (enabled: false): no model call, no process run —
              // the deterministic branch-facts body is rendered locally instead,
              // and no passed AI process is recorded for work nobody did.
              opts.debug?.(
                `[ship] ticket ${opts.ticketId} ${wt.repo}: PR description disabled — deterministic branch-facts body`,
              );
              return deterministicDescription(ctx);
            }
            // Legacy caller: no configured bundle, the positional adapter runs the
            // step as before (no identity snapshot — pre-Task-3 behavior).
            if (adapter) {
              opts.debug?.(
                `[ship] ticket ${opts.ticketId} ${wt.repo}: PR description via legacy positional adapter`,
              );
              return generateDescription(
                store,
                run,
                wt.repo,
                adapter,
                wt.path,
                ctx,
                opts.ticketId,
                onProgress,
                onInsideProgress,
                undefined,
              );
            }
            opts.debug?.(
              `[ship] ticket ${opts.ticketId} ${wt.repo}: no description adapter — deterministic branch-facts body`,
            );
            return deterministicDescription(ctx);
          };
          const buildBody = async (): Promise<string> => {
            // A configured template that never asks for prose needs no model call
            // and no branch reads.
            if (descriptionTemplate && !usesDescription(descriptionTemplate)) {
              opts.debug?.(
                `[ship] ticket ${opts.ticketId} ${wt.repo}: description template needs no prose — no model call`,
              );
              return renderArtifactTemplate('pullRequestDescription', descriptionTemplate, {
                ...templateContext,
                description: prTitle,
              });
            }
            // The branch material the description is written from, collected ONCE
            // and shared by every path that renders a body — the deterministic
            // fallback AND the model prompt. A model handed only a title goes
            // exploring for the changes and can answer "where is the worktree?"
            // instead of describing them (PR #117); with the facts in the prompt
            // it needs no tools and no clarification. A failed read degrades to a
            // title-only prompt — observability must never fail a ship.
            let diffContext: PrDiffContext = {};
            if (base) {
              opts.debug?.(
                `[ship] ticket ${opts.ticketId} ${wt.repo}: collecting branch facts for the PR description (base ${base})`,
              );
              try {
                diffContext = await collectPrDiffContext(git, wt.path, base);
              } catch {
                diffContext = {};
              }
            }
            const promptCtx: PrDescriptionContext = {
              title: prTitle,
              repo: wt.repo,
              branch: wt.branch ?? undefined,
              baseRef: base,
              gateSetChanged,
              ...diffContext,
            };
            if (descriptionTemplate) {
              const description = await runDescriptionStep(opts.prDescriptionProcess, promptCtx);
              return renderArtifactTemplate('pullRequestDescription', descriptionTemplate, {
                ...templateContext,
                description,
              });
            }
            return runDescriptionStep(opts.prDescriptionProcess, promptCtx);
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
          recordShippedPr(store, {
            ticketId: opts.ticketId,
            repo: wt.repo,
            number: opened.number,
            url: opened.url,
          });
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
        } else if (deliveringToOpenPr && prior) {
          // Deliver mode pushed the new commits onto the existing PR's head but
          // skipped the whole PR region, so no `pr` step was recorded — and the
          // persisted evidence then read "pr step not recorded" for the very PR
          // this run updated. Record the step the normal path would have written
          // (FIX-46 review). No operation intent: no external PR mutation ran.
          onProgress({ repo: wt.repo, step: 'pr', status: 'run' });
          const landedNumber = prior.number;
          const prStep = openShipRepoStep(store, {
            shipRunId: run.id,
            repo: wt.repo,
            step: 'pr',
            detail: landedNumber === null ? 'existing PR' : `#${landedNumber}`,
            startedAt: nowIso(),
          });
          finishShipRepoStep(store, prStep.id, {
            status: 'passed',
            detail: landedNumber === null ? 'delivered' : `delivered #${landedNumber}`,
            prNumber: landedNumber,
            existedBeforeShip: true,
            endedAt: nowIso(),
          });
          onProgress({ repo: wt.repo, step: 'pr', status: 'pass' });
        }
      } catch (err) {
        // A STORE failure is not this repo's failure — it is the ground under
        // every repo giving way. SQLite is the source of truth: if writing the
        // ship run, the operation intents, or the PR row is failing, the next
        // worktree's durable bookkeeping cannot be trusted either, and the
        // reconciliation a retry depends on is exactly what did not persist.
        // Continuing would ship repos whose evidence never landed. Rethrow so
        // it aborts the whole loop the way it did before per-repo isolation.
        if (isStoreFailure(err)) throw err;
        // Otherwise this worktree failed on its own (git, gh, the description
        // model) — record it and move on to the next one. All durable
        // bookkeeping for the failing step (finishShipRepoStep,
        // reconcileShipOperation) already ran at the throw site above; this
        // catch only stops the failure from aborting the repos that follow.
        const message = err instanceof Error ? err.message : String(err);
        repoFailures.push({ repo: wt.repo, message });
      }
    }
    if (repoFailures.length > 0) {
      throw new Error(
        `ship failed for ${repoFailures.length} repo(s): ` +
          repoFailures.map((f) => `${f.repo}: ${boundedFailure(f.message)}`).join('; '),
      );
    }
    if (opts.repos) {
      const evidence = listShipEvidence(store, opts.ticketId);
      // An out-of-scope repo that still has a recorded failed step is only
      // genuinely unfinished if it has NO live PR. The local `prs` table is
      // written by karst's own ship — a PR opened by hand on GitHub (a user
      // finishing the retry manually) lives upstream only, so when the local
      // table is silent we re-probe the repo's worktree for an open PR rather
      // than assume it is still failing.
      const outstanding: string[] = [];
      for (const wt of allWorktrees) {
        if (scoped.some((s) => s.repo === wt.repo)) continue;
        const steps = evidence.repos[wt.repo]?.steps;
        if (!steps) continue;
        const failed = Object.values(steps).some((s) => s?.status === 'failed');
        if (!failed) continue;
        if (findExistingLivePr(store, opts.ticketId, wt.repo) !== undefined) continue;
        if (findMergedPr(store, opts.ticketId, wt.repo) !== undefined) continue;
        const upstream = await findOpenPr(gh, wt.path).catch(() => null);
        if (upstream) continue;
        outstanding.push(wt.repo);
      }
      if (outstanding.length > 0) {
        throw new Error(
          `ship is still unfinished for ${outstanding.length} repo(s) not retried: ` +
            `${outstanding.join(', ')}`,
        );
      }
    }
    // Every target unchanged means the ship produced nothing at all: no commit,
    // no push, no PR. Each repo's own note is right, but the aggregate is the
    // shape a ticket takes when its work landed somewhere other than its branch
    // (an agent that committed to the main checkout, a stale worktree mapping).
    // Passing here is what lets that walk through to `done` fully green, so it
    // is a ship failure — the ticket parks at ship, since ship has no `failed`
    // edge. Placed AFTER the per-repo check: a real failure is more actionable
    // than the "nothing shipped" symptom it causes.
    if (scoped.length > 0 && noChangeRepos.length === scoped.length) {
      opts.debug?.(`[gate] ship ticket ${opts.ticketId}: all ${scoped.length} target(s) unchanged — refusing`);
      throw new Error(
        `ship produced nothing: all ${scoped.length} target(s) have no changes ` +
          `from their base branch (${noChangeRepos.join(', ')}) — ` +
          `the ticket's work is not on its branch`,
      );
    }
  } catch (err) {
    // Ship has no `failed` edge (graph.ts): a ticket whose PRs did not open has
    // NOT shipped, so it must stay at ship rather than advance. Record the reason
    // on the stage row — that is what the dashboard renders (a red node + the
    // Now line), so a failed ship is visible instead of a ticket that just sits
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
  await recordMergeChecks(store, opts.ticketId, allWorktrees, git, onProgress, opts.manifest);
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
    const landing = resolveShipLanding(store, opts.ticketId, opts.debug);
    if (landing.landedSubtaskParentId !== null) {
      await integrateAndReleaseParent(store, landing.landedSubtaskParentId, git, opts.debug);
    }
  }

  return { prs };
}
