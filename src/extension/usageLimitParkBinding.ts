import * as vscode from 'vscode';
import { dirname } from 'node:path';
import type { Store } from '../store/db.js';
import type { Manifest, AgentProvider } from '../manifest/types.js';
import type { StageKey } from '../model/types.js';
import type { ModelCatalog } from '../agent/modelCatalog.js';
import type { AgentAdapter } from '../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../agent/processAssignment.js';
import type { GitRunner } from '../integrations/git.js';
import { defaultGitRunner } from '../integrations/git.js';
import { runProcess } from '../workflow/gates/run.js';
import type { ReviewArtifacts } from '../workflow/review/conformance.js';
import type { TesterGateRunner } from '../workflow/uat/testerVerifier.js';
import type { UatSpin, UatStopServers } from '../workflow/stages/uat.js';
import type { Notify } from './ops/notify.js';
import {
  makeUsageLimitParkActions,
  formatCoreChoices,
  formatModelChoices,
  type UsageLimitParkActions,
  type ExclusiveRunner,
} from './ops/usageLimitParkOps.js';
import { makeReviewArtifactsBinding } from './reviewArtifactsBinding.js';

export type { UsageLimitParkActions };

/** The lock seam a park action runs under — the stage driver's controller. */
export interface ParkRunLock {
  begin(ticketId: number): boolean;
  end(ticketId: number): void;
  signalFor(ticketId: number): AbortSignal | undefined;
}

/**
 * Wrap a park action in the stage driver's per-ticket single-flight lock and
 * hand it the run's Stop signal. Returns undefined when a run is already in
 * flight, so the action touches nothing — exactly like a lost park claim.
 */
export function driverLockedRun(driver: ParkRunLock) {
  return async <T>(
    ticketId: number,
    run: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!driver.begin(ticketId)) return undefined;
    try {
      return await run(driver.signalFor(ticketId));
    } finally {
      driver.end(ticketId);
    }
  };
}

/**
 * D159: the two-step core → model QuickPick the usage-limit park actions use,
 * tagging the parked pair `(usage limit)`. A free function so the ticket form's
 * own op-park picker and the dashboard's stage-park picker cannot drift.
 */
export function makeUsageLimitAgentModelPicker(catalog: () => ModelCatalog) {
  return async (parkedProvider: string, parkedModel: string | null) => {
    const core = await vscode.window.showQuickPick(formatCoreChoices(parkedProvider), {
      title: 'Pick agent core',
    });
    if (!core) return undefined;
    const model = await vscode.window.showQuickPick(
      formatModelChoices(core.id, catalog(), parkedModel),
      { title: 'Pick model' },
    );
    if (!model) return undefined;
    return { provider: core.id, model: model.model };
  };
}

export interface UsageLimitParkBindingDeps {
  store: Store;
  notify: Notify;
  catalog: () => ModelCatalog;
  manifest: () => Manifest | undefined;
  redrive: (ticketId: number) => void;
  refresh: (ticketId: number) => void;
  /**
   * Run a park action under the stage driver's per-ticket single-flight lock,
   * passing the run's Stop signal. Absent → run directly (tests).
   */
  withDriverRun?: <T>(
    ticketId: number,
    run: (signal: AbortSignal | undefined) => Promise<T>,
  ) => Promise<T | undefined>;
  adapterFor: (provider: AgentProvider, model: string | null) => AgentAdapter;
  /** Resolve the role's assignment (profile prompt/effort/agent name) for the run. */
  assignmentFor?: (
    ticketId: number,
    stageKey: StageKey,
    provider: AgentProvider,
    model: string | null,
  ) => ProcessAssignmentSnapshot | undefined;
  artifactDirFor: (ticketId: number) => string;
  cwd: () => string;
  /** Test seam; defaults to the real git-backed snapshot runner. */
  git?: GitRunner;
  /** Test seam; defaults to a loader over `artifactDirFor`'s parent. */
  loadArtifacts?: (ticketId: number) => Promise<ReviewArtifacts | undefined>;
  /** Test seam; defaults to the real host gate runner (`runProcess`). */
  runVerifier?: TesterGateRunner;
  /** The composed `karst context` prefix the UAT Tester prompt may name. */
  contextCommand?: string;
  /**
   * The service spin/stop seams (D155, REQUIRED). A UAT re-run must boot and
   * reap the SAME environment the stage does: for a sandboxed ticket that is
   * the sandbox (parent synced first), never the host worktree. Leaving these
   * to a raw `spinTicket`/`stopTicketServers` default is what shipped a host
   * stack under a sandboxed ticket, so the host must name both seams.
   */
  spin: UatSpin;
  stopServers: UatStopServers;
  debug?: (msg: string) => void;
}

export function createUsageLimitParkBinding(deps: UsageLimitParkBindingDeps) {
  // A parked re-run must be as COMPLETE a check as the stage it stands in for:
  // it reviews the same worktree SNAPSHOT (never a committed-only range), judges
  // the same conformance artifacts, and runs the same deterministic tester
  // verifier. These default to the production seams so the host wiring stays
  // unchanged; a test overrides them.
  const git = deps.git ?? defaultGitRunner;
  const runVerifier = deps.runVerifier ?? runProcess;
  const loadArtifacts =
    deps.loadArtifacts ??
    makeReviewArtifactsBinding({
      registry: deps.store,
      artifactsRoot: dirname(deps.artifactDirFor(0)),
      manifest: deps.manifest,
      fallbackProjectId: () => undefined,
    });
  const runExclusive = (ticketId: number): ExclusiveRunner =>
    deps.withDriverRun
      ? (run) => deps.withDriverRun!(ticketId, run)
      : (run) => run(undefined);
  return {
    forTicket: (ticketId: number) =>
      makeUsageLimitParkActions({
        store: deps.store,
        ticketId,
        notify: deps.notify,
        catalog: deps.catalog,
        manifest: deps.manifest,
        redrive: deps.redrive,
        refresh: deps.refresh,
        runExclusive: runExclusive(ticketId),
        pickCore: async (items) => {
          const picked = await vscode.window.showQuickPick(items, { title: 'Pick agent core' });
          return picked;
        },
        pickModel: async (items) => {
          const picked = await vscode.window.showQuickPick(items, { title: 'Pick model' });
          return picked;
        },
        adapterFor: deps.adapterFor,
        assignmentFor: deps.assignmentFor,
        artifactDir: () => deps.artifactDirFor(ticketId),
        cwd: deps.cwd,
        git,
        loadArtifacts,
        runVerifier,
        contextCommand: deps.contextCommand,
        spin: deps.spin,
        stopServers: deps.stopServers,
        debug: deps.debug,
      }),
  };
}
