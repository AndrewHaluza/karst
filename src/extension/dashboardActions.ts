import { makeTesterSkipActions } from './ops/testerSkipOps.js';
import { makeBaselineActions } from './ops/baselineDecisionOps.js';
import { reviewStallBinding } from './reviewStallBinding.js';
import { type DriverController } from '../workflow/driverController.js';
import { type createTicketSandboxBindings } from './ops/sandboxSyncOps.js';
import { type makeSandboxWiring } from './ops/sandboxWiring.js';
import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { type Store } from '../store/db.js';
import { resolveConflictClick } from './ops/conflictResolveOps.js';
import { graphRecoveryRefusalNotice } from './ops/graphRecovery.js';
import type { Notify } from './ops/notify.js';
import { conflictRounds, armConflictRound } from './ops/autoDeliverOps.js';
import { makeDependencyOps } from './ops/dependencyOps.js';
import { addressPrFeedback } from './ops/prFeedbackAction.js';
import { deliverToPrAction, rebaseOnBaseAction, sendCiFailureAction, type CiActionsInput, type CiHost } from './ops/ciActionsWiring.js';
import { resolveStageLogPath } from './ops/stageLogArtifact.js';
import { stopServerRow, startServerRow, restartServerRow, openServerRow, copyServerUrlRow, type ServerOpsDeps } from './ops/serverOps.js';
import type { DashboardActions } from '../ui/dashboard/messages.js';
import type { AgentProcessId } from '../ui/dashboard/messages.js';
import { makeWorktreeActions } from '../ui/dashboard/worktreeActions.js';
import { type StoredArtifactActions } from './storedArtifactBinding.js';
import { type UsageLimitParkActions } from './usageLimitParkBinding.js';
import { SessionManager } from '../ui/session.js';
import { type DriveProcessBundle } from '../agent/processAssignment.js';
import { recoverGraphRun, type RecoveryDeps } from '../approaches/graph/coordinator/recovery.js';
import type { ReplanLaunchRequest } from '../approaches/graph/coordinator/replan.js';
import type { BootstrapRelaunchRequest } from '../approaches/graph/coordinator/recovery.js';
import { listWorktreesByTicket } from '../store/dashboard.js';
import { parseLaunchWorktreeConfig } from '../commands/launchWorktreeConfig.js';
import { getDisabledGates, setDisabledGates, type GateStage } from '../store/ticketGates.js';
import { ALL_SERVICES, setServiceEnvOverrides } from '../store/ticketEnvOverrides.js';
import { parseEnvText } from '../runtime/env.js';
import { defaultGhRunnerAsync } from '../integrations/github.js';
import { mergeTicketPr } from '../workflow/mergePr.js';
import { dismissTicketPr, undismissTicketPr } from '../workflow/dismissPr.js';
import { nowIso } from '../model/time.js';
import { findTicketPr } from '../store/prs.js';
import { resumeBlockedStage } from '../workflow/stageResume.js';
import { runKilledGatesOnHost } from './ops/runGateOnHost.js';
import { sendBackState, sendBackToImplement } from '../workflow/sendBack.js';
import { resetStageAction } from './ops/resetStageAction.js';
import { retryGateStage, retryGateState } from '../workflow/retryGate.js';
import { askPausedModal } from './pausedModal.js';
import { buildConflictBrief } from '../workflow/conflictSession.js';
import { stopTicketServers } from '../runtime/supervisor.js';
import { changeBaseRef as changeBaseRefWorkflow, describeChangeBaseRef } from '../workflow/changeBaseRef.js';
import { defaultGitRunner } from '../integrations/git.js';
import { loadManifest, type Manifest } from '../manifest/load.js';
import { resolveManifest } from './manifestResolve.js';
import type { AgentProvider } from '../manifest/types.js';
import { spinTicket } from '../runtime/spin.js';
import { shipClearedEvent, type InsideProgressEvent } from '../model/inside/progress.js';
import { createFollowUpTicket } from '../workflow/stages/followUp.js';
import { getTicket, pauseTicket, unpauseTicket } from '../store/tickets.js';
import type { Project } from '../store/projects.js';
import { type LogError } from '../logging/logger.js';
import { buildTicketArtifacts } from '../model/artifacts.js';
import { formatId } from '../model/entityId.js';
import { type CapabilityGuard } from './insideActionHost.js';

/**
 * Bind dashboard actions to real vscode side-effects. Server lifecycle: stop and
 * open are wired to the supervisor + browser; restart can't fully re-run without
 * the original spawn opts (not persisted), so it stops the server and tells the
 * user to re-spin — honest rather than a fake no-op.
 */
export const vscodeNotify: Notify = {
  info: (m) => void vscode.window.showInformationMessage(m),
  warn: (m) => void vscode.window.showWarningMessage(m),
  error: async (m) => { await vscode.window.showErrorMessage(m); }, errorActions: async (m, actions) => vscode.window.showErrorMessage(m, ...actions),
  infoActions: async (m, actions) => vscode.window.showInformationMessage(m, ...actions),
};

export function makeDashboardActions(
  store: Store,
  ticketId: number,
  editTicket: () => void,
  afterServerChange: () => void,
  logError: LogError,
  guardCapability: CapabilityGuard,
  // Read fresh when the user confirms ship so a mid-session branch edit
  // controls the PR target and convention edits apply without a window reload.
  manifest: () => Manifest | undefined,
  // Task 3: the configured pr-description process, resolved once at the click.
  // NULL (enabled: false) makes ship skip the AI step for the deterministic
  // fallback — no model call, no pr-description process run.
  prDescriptionProcess: (ticketId: number) => DriveProcessBundle | null,
  // Push the configured post-delivery status for THIS ticket, now that it has
  // reached `done`. A callback rather than the ticketing config + provider,
  // because reaching done is no longer something the ship click can conclude on
  // its own: the same push has to fire from the merge click and from the
  // background sweep, so the decision and the reporting live in one host helper.
  onTicketCompleted: () => Promise<void>,
  // Stream the generic inside-progress union (active/completed/cleared) while
  // `shipTicket` runs, so the confirm-ship click has visible progress instead
  // of a frozen button — ship rides the same channel as gates and Fix, never
  // the legacy per-repo/per-step `ship-progress` stream (Finding 12).
  onInsideProgress: (event: InsideProgressEvent) => void,
  // Run the ship saga for a ticket and settle its aftermath. ONE seam, shared
  // with the stranded-ship recovery at activation (a ship killed by a dead
  // host resumes through the same path as the click that started it): the
  // click owns only the capability guard and the failure toast.
  runShipSaga: (ticketId: number) => Promise<void>,
  // Dispatch one opaque inside action id: the panel posts only the id; the
  // dashboard manager resolves it through the ticket's current registry.
  onInsideAction: (actionId: string) => void,
  // Deliver a prompt to this ticket's session, live or not: nudge the open
  // terminal, else launch one seeded with it. A conflict brief handed to
  // `openSession` alone would be dropped whenever a session is already up —
  // openSession only focuses an existing terminal.
  handOffToSession: (prompt: string, repo: string) => void,
  // Open the host-owned, whole-ticket changes explorer. The dashboard action
  // carries no path because this closure already owns the ticket id.
  showChanges: () => void,
  // Apply a staged agent-core/model selection to the open session. The closure
  // owns the ticket id AND re-validates the selection against the catalog, so
  // the webview can only ever propose a switch, never direct one.
  switchAgent: (provider: AgentProvider, model: string | null, effort: string | null) => void,
  // Flip the window's terminal binding. Window-scoped, not ticket-scoped, so it
  // takes no id — every open dashboard reports the same toggle.
  toggleBind: () => void,
  // Force an immediate PR/mergeability sweep, ignoring the freshness floor the
  // background tick respects. Project-scoped like the tick itself, so it takes no
  // ticket: the panel is asking for a fresher answer, not a narrower one.
  refreshPrs: () => Promise<void>,
  refreshShipPreview: () => Promise<void> | void,
  // Kick the §5.4-safe driver nudge (`maybeDrive`) after a block is cleared.
  // Passed in rather than reached from here because it lives in `activate`'s
  // scope, alongside every other driver trigger (hook, sweep, session close) —
  // resume is just one more trigger, not a special path.
  driveAfterResume: (ticketId: number) => void,
  // Build a worktree's karst-extension checkout and open it as the dev host in
  // a new window. The build takes minutes, so this owns the progress
  // notification and the action ack is immediate (host acceptance only).
  launchWorktree: (path: string) => void,
  // Live feature config (karst.launchWorktreeDev.*), so the action refuses
  // when the switch is off — a crafted message must not launch what the user
  // disabled.
  launchConfig: () => ReturnType<typeof parseLaunchWorktreeConfig>,
  // The graph recovery action's host binding (Slice-4 T6), bound in activate
  // where the snapshot root is known.
  graphRecoveryDeps: (graphRunId: number) => RecoveryDeps,
  // Launch the elected replan planner session (Slice-4 T5).
  graphReplanLaunch: (launch: ReplanLaunchRequest) => void,
  // Launch a fresh bootstrap planner on a graph run whose previous bootstrap
  // planner died before ever submitting — the `planner-relaunch` recovery.
  graphBootstrapRelaunch: (launch: BootstrapRelaunchRequest) => void,
  // Resolve one gate stage's console log via the dashboard manager, which owns
  // the ticket panel: the stage key arrives from the webview, the read stays
  // host-side.
  requestStageLog: (stage: GateStage) => void,
  // Resolve one gate-lane AI process's console tail via the dashboard manager.
  requestAgentLog: (processId: AgentProcessId) => void,
  // Combined server logs: read all server log files and start polling.
  requestServerLogs: () => void,
  closeServerLogs: () => void,
  // Verbose decision-point logging for the recovery action (`sendBackToImplement`),
  // gated inside the logger so it is a no-op unless the manifest's debug flag is on.
  debug: (message: string) => void,
  storedArtifacts: StoredArtifactActions,
  ciHost: CiHost,
  usageLimitParks: UsageLimitParkActions,
  // extension.ts's module-level sandbox state, read lazily (assigned in activate).
  sandbox: { bindings: () => ReturnType<typeof createTicketSandboxBindings> | undefined; life: () => ReturnType<typeof makeSandboxWiring> },
  // The auto-driver's per-ticket single-flight state (module-level in extension.ts).
  driver: DriverController,
): DashboardActions {
  const ciActionsInput = (): CiActionsInput => ({ ...ciHost, store, ticketId, logError, debug, drive: () => driveAfterResume(ticketId), afterServerChange });
  const worktreeActions = makeWorktreeActions(
    {
      createTerminal: (options) => vscode.window.createTerminal(options),
      revealInExplorer: async (path) => {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path));
      },
      expandExplorer: async () => {
        await vscode.commands.executeCommand('list.expand');
      },
      writeClipboard: async (text) => {
        await vscode.env.clipboard.writeText(text);
      },
    },
    logError,
  );

  const sandboxB = sandbox.bindings();
  const serverDeps: ServerOpsDeps = {
    store,
    notify: {
      info: (m) => void vscode.window.showInformationMessage(m),
      warn: (m) => void vscode.window.showWarningMessage(m),
      error: async (m) => { await vscode.window.showErrorMessage(m); },
    },
    afterServerChange,
    loadManifest: async () => (await resolveManifest(debug)) ?? null,
    openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    copyText: (text) => void vscode.env.clipboard.writeText(text),
    debug, ...(sandboxB ? { sandbox: sandboxB.deps, userUatWithheld: sandboxB.userUatWithheld } : {}), // AC-32
  };

  const dependencyOps = makeDependencyOps(store, {
    openDashboard: (targetTicketId) => void vscode.commands.executeCommand('karst.openDashboard', targetTicketId),
  });

  // Start/Restart mean "run the services" — `servicesOnly` drops serviceless repos.
  const spinServices = () =>
    void vscode.commands.executeCommand('karst.spinTicket', { ticketId, servicesOnly: true });

  return {
    stopServer: (serverId) => stopServerRow(serverDeps, serverId),
    restartServer: (serverId) => restartServerRow(serverDeps, serverId),
    startServer: (serverId) => startServerRow(serverDeps, serverId),
    openServer: (serverId) => openServerRow(serverDeps, serverId),
    // Copy the server URL to the clipboard (the webview flashes its own feedback).
    copyServerUrl: (serverId) => copyServerUrlRow(serverDeps, serverId),
    // No servers yet → spin from the dashboard (that command owns picker+progress).
    spinServers: spinServices,
    // Restart-all IS a re-spin: `spinTicket` already calls `stopTicketServers`
    // before starting, so it shares one command with `spinServers` rather than
    // drifting. The two stay distinct by AVAILABILITY, not implementation — the
    // dashboard disables Start when nothing is offline and Restart when there is
    // nothing to restart. Do not "deduplicate" by deleting one button.
    restartServers: spinServices,
    // Stop-all is the one genuinely new effect: kill every running server on the
    // ticket, retaining the rows so they come back as offline and restartable.
    stopServers: async () => {
      const sandboxB = sandbox.bindings();
      await (sandboxB ? sandboxB.stopTicket(store, ticketId) : stopTicketServers(store, ticketId)); // AC-32
      afterServerChange();
    },
    openResources: () => void vscode.commands.executeCommand('karst.openServers'), // the ticket panel's "Manage shared services" link
    showChanges,
    switchAgent,
    copyTicketKey: () => {
      const key = getTicket(store, ticketId).key ?? formatId('ticket', ticketId);
      void vscode.env.clipboard.writeText(key);
    },
    sandboxSync: () => sandbox.life().sync(ticketId), sandboxDiff: () => sandbox.life().diff(ticketId), // AC-32 Sandbox card
    sandboxStop: () => sandbox.life().stop(ticketId), sandboxRemove: () => sandbox.life().remove(ticketId), sandboxCarry: () => sandbox.life().carry(ticketId), sandboxStashUpdate: () => sandbox.life().stashUpdate(ticketId),
    ...worktreeActions,
    // Launch must not be aimable: the webview names a path, and the host
    // verifies it against the ticket's registered worktrees before building
    // anything — a crafted or stale message cannot start a build in an
    // arbitrary directory. It is also gated on the same config the button
    // renders from: an off switch must hold against a crafted message even
    // when no button is visible.
    launchWorktreeExtension: (path) => {
      if (!guardCapability('worktrees')) return;
      if (!launchConfig().enabled) {
        void vscode.window.showWarningMessage(
          'Launch worktree extension is disabled — set karst.launchWorktreeDev.enabled to true.',
        );
        return;
      }
      if (!listWorktreesByTicket(store, ticketId).some((w) => w.path === path)) {
        void vscode.window.showWarningMessage('That worktree is not registered to this ticket.');
        return;
      }
      launchWorktree(path);
    },
    openPr: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    // Copy the PR URL to the clipboard (the webview flashes its own feedback,
    // like copy-server-url / copy-worktree-branch).
    copyPrUrl: (url) => void vscode.env.clipboard.writeText(url),
    openTicketLink: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
    editTicket,
    openDependency: (id) => dependencyOps.openDependency(ticketId, id),
    // Stop the auto-driver's next gate run for this ticket (it halts at the
    // next boundary check, never mid-gate — see `shouldContinue`).
    stopDriver: () => driver.requestStop(ticketId),
    // Human confirms ship: open the PR(s) for every hot repo, then let the
    // caller (dashboard) refresh so `done` (or a fresh PR list) shows up. The
    // saga run and its aftermath live in ONE host seam (`runShipSaga`), shared
    // with the stranded-ship recovery at activation — this click only adds the
    // capability guard and the failure toast.
    shipTicket: () => {
      if (!guardCapability('ship')) return;
      void runShipSaga(ticketId).catch((e) => {
        logError('ship failed', e);
        // `shipTicket` already recorded the reason on the ship stage, so the
        // dashboard now explains itself — but the user just clicked a button
        // and deserves an answer to THAT click, not a ticket that quietly goes
        // red. Refresh first so the dashboard reflects the failure when the
        // toast lands.
        afterServerChange();
        onInsideProgress(shipClearedEvent(ticketId));
        void vscode.window.showErrorMessage(
          `Ship failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    },
    // Resume: same interactive-open path the sidebar/dashboard "open session"
    // action already uses; `SessionManager.openSession` resolves --resume vs.
    // a fresh launch on its own.
    resumeTicket: () => void vscode.commands.executeCommand('karst.openSession', ticketId),
    // The unified "Send back to Implement" recovery action (869ehkkzp).
    //
    // The confirmation is a MODAL and the mutation stays host-side: the webview
    // posts only the payload-free message, and everything about whether — and
    // which stage from — it happens is decided here against the store, right
    // before it is mutated. Availability is re-derived AFTER the confirmation
    // too (inside `sendBackToImplement`'s transaction), so a ticket a sweep or
    // a teammate's merge moved while the modal was up is refused rather than
    // mutated underneath its new state.
    //
    // The dashboard is refreshed on EVERY exit — confirm, dismiss, refusal,
    // throw — because the webview's pending state is settled by a state push
    // (the same contract `mergePr` documents). Skipping the push on the cancel
    // path would leave the ⋯ menu item stuck pending.
    sendBackToImplement: () => {
      void (async () => {
        try {
          // The store decides availability: a stale panel can offer an action
          // for a stage the ticket has since left or landed.
          const state = sendBackState(store, ticketId);
          if (!state.available) {
            void vscode.window.showInformationMessage(
              `Ticket ${formatId('ticket', ticketId)} cannot be sent back to Implement right now.`,
            );
            return;
          }
          const fromShip = state.stage === 'ship';
          const detail = fromShip
            ? 'Move this ticket back to Implement? UAT and Review will need to run again. '
                + 'Existing evidence will remain in history, and existing open pull requests are '
                + 'kept as they are — they are not merged or closed.'
            : 'Move this ticket back to Implement? UAT and Review will need to run again. '
                + 'Existing evidence will remain in history.';
          const choice = await vscode.window.showWarningMessage(
            'Send back to Implement?',
            { modal: true, detail },
            'Send back to Implement',
          );
          if (!choice) return; // dismissed: nothing ran, and nothing is claimed
          const result = sendBackToImplement(store, ticketId, { debug });
          void vscode.window.showInformationMessage(
            `Ticket ${formatId('ticket', ticketId)} moved back to Implement${result.from === 'ship' ? ' — open pull requests kept' : ''}.`,
          );
        } catch (e) {
          logError('send back to implement failed', e);
          void vscode.window.showErrorMessage(
            `Could not send ticket ${formatId('ticket', ticketId)} back: ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          afterServerChange();
        }
      })();
    },
    // Reset the failed gate stage once its recovery budget is spent (T831).
    resetStage: () =>
      resetStageAction({
        store, ticketId, afterServerChange, logError, debug,
        drive: () => driveAfterResume(ticketId),
        info: (m) => void vscode.window.showInformationMessage(m),
        error: (m) => void vscode.window.showErrorMessage(m),
        confirm: async (title, detail) =>
          (await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Reset stage')) !== undefined,
      }),
    // Answers to a review stall (T845); logic in ops/reviewStallActions.
    ...reviewStallBinding({
      store, ticketId, afterServerChange, logError, debug,
      drive: () => driveAfterResume(ticketId), editTicket,
    }),
    // Move this ticket into a PR-feedback recovery round at Fix. The logic
    // lives in `addressPrFeedback` (vscode-free, unit tested); this is the seam.
    addressPrFeedback: () =>
      addressPrFeedback({
        store, ticketId, afterServerChange, logError, debug,
        drive: () => driveAfterResume(ticketId),
        info: (m) => void vscode.window.showInformationMessage(m),
        error: (m) => void vscode.window.showErrorMessage(m),
        confirm: async (detail) =>
          (await vscode.window.showWarningMessage(
            'Address pull request feedback?',
            { modal: true, detail },
            'Address feedback',
          )) === 'Address feedback',
      }),
    // Ship-stage CI actions (vscode-free logic in ops/ciFailureOps + rebaseOnBaseOps).
    sendCiFailure: () => void askPausedModal(store, ticketId, 'sending the CI failure to the agent', 'Send CI failure', () => afterServerChange()).then((r) => (r === 'proceed' ? sendCiFailureAction(ciActionsInput()) : undefined)),
    deliverToPr: () => void deliverToPrAction(ciActionsInput()),
    rebaseOnBase: () => void rebaseOnBaseAction(ciActionsInput(), (r) => manifest()?.repositories[r]?.ship?.regenerate ?? []),
    // Retry a gate stage (uat/review) by resetting it to pending so the driver
    // re-runs it. Lighter than "Send back to Implement": only the current gate
    // stage is touched, and the ticket stays where it is in the graph.
    rerunGate: (stage) => {
      void (async () => {
        try {
          const state = retryGateState(store, ticketId);
          if (!state.available) {
            void vscode.window.showInformationMessage(
              'This stage cannot be retried right now.',
            );
            return;
          }
          const stageLabel = stage === 'uat' ? 'UAT' : 'Review';
          const choice = await vscode.window.showWarningMessage(
            `Retry ${stageLabel}?`,
            { modal: true, detail: `Re-run the ${stageLabel} stage. Existing evidence will remain in history.` },
            'Retry',
          );
          if (!choice || (await askPausedModal(store, ticketId, `retry ${stageLabel}`, `Retry ${stageLabel}`, () => afterServerChange())) === 'cancel') return;
          const result = retryGateStage(store, ticketId, stage);
          if (!result.ok) {
            void vscode.window.showInformationMessage(`Could not retry: ${result.reason}`);
            return;
          }
          void vscode.window.showInformationMessage(`${stageLabel} stage reset — retrying.`);
        } catch (e) {
          logError('retry gate failed', e);
          void vscode.window.showErrorMessage(
            `Could not retry the stage: ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          afterServerChange();
        }
      })();
    },
    // Resume a parked gate stage (§ blocked state visible). All the "is this
    // even valid" checking lives in `resumeBlockedStage` (vscode-free, unit
    // tested) — this stays a thin binding: apply it, and only on success
    // refresh the panel and kick the same driver trigger every other resume
    // path uses.
    runGateOnHost: (msgTicketId, stageKey) => {
      if (msgTicketId !== ticketId) return;
      if (runKilledGatesOnHost(store, ticketId, stageKey).length === 0) return;
      const outcome = resumeBlockedStage(store, ticketId, msgTicketId, stageKey);
      if (outcome.kind === 'cleared') {
        afterServerChange();
        driveAfterResume(ticketId);
      }
    },
    resumeStage: (msgTicketId, stageKey) => {
      const outcome = resumeBlockedStage(store, ticketId, msgTicketId, stageKey);
      if (outcome.kind === 'cleared') {
        afterServerChange();
        driveAfterResume(ticketId);
        return;
      }
      if (outcome.kind === 'graph-recovery') {
        // The graph block is NOT cleared by a generic Resume (Slice-3 T9) —
        // the typed action runs graph-aware recovery instead.
        const recovery = recoverGraphRun(
          graphRecoveryDeps(outcome.graphRunId),
          { ticketId: outcome.ticketId, graphRunId: outcome.graphRunId },
        );
        if (
          recovery.kind === 'retried' ||
          recovery.kind === 'confirmation-restored' ||
          recovery.kind === 'replanned' ||
          recovery.kind === 'relaunched'
        ) {
          if (recovery.kind === 'replanned' && recovery.launch) graphReplanLaunch(recovery.launch);
          if (recovery.kind === 'relaunched' && recovery.launch) graphBootstrapRelaunch(recovery.launch);
          afterServerChange();
          driveAfterResume(ticketId);
        } else if (recovery.kind === 'refused') {
          void vscode.window.showInformationMessage(
            graphRecoveryRefusalNotice(ticketId, 'resume', recovery.reason),
          );
        }
      }
    },
    // Pause: stamp the store flag FIRST so any in-flight driver round that
    // checks between stages sees it, then ask the running round to stop. The
    // interactive terminals stay open by design — the user is looking at them;
    // pause only stops karst from starting new work on this ticket.
    pauseExecution: () => {
      pauseTicket(store, ticketId);
      driver.requestStop(ticketId);
      afterServerChange();
    },
    // Unpause: clear the flag, then nudge the driver through the same
    // §5.4-safe seam a cleared block uses — resume is one more trigger.
    unpauseExecution: () => {
      unpauseTicket(store, ticketId);
      afterServerChange();
      driveAfterResume(ticketId);
    },
    // Opens the ticket form in edit mode on the new ticket so the user can type
    // the actual follow-up ask straight away — the command itself copies
    // repos/approach/agent/model from this ticket.
    createFollowUpTicket: () =>
      void vscode.commands.executeCommand('karst.createFollowUpTicket', ticketId),
    // The webview sends no payload; the command prompts for the title and the
    // blocking flag, then runs the one sub-task writer.
    createSubtask: () => void vscode.commands.executeCommand('karst.createSubtask', ticketId),
    // Detach a started sub-task from its parent: rebase onto the parent's base
    // and clear the parent link (design NDL-70 §5 'Detach').
    detachSubtask: () => void vscode.commands.executeCommand('karst.detachSubtask', ticketId),
    // Same commands as the palette; the host prompts for the reason (payload-free message).
    closeTicket: () => void vscode.commands.executeCommand('karst.closeTicket', ticketId),
    reopenTicket: () => void vscode.commands.executeCommand('karst.reopenTicket', ticketId),
    // The webview names ONLY the stage key; the path is re-derived from the
    // store row this panel owns (never from the message) before `Uri.file`.
    openStageLog: (stageKey) => {
      const artifact = resolveStageLogPath((id) => getTicket(store, id), ticketId, stageKey);
      if (artifact === null) {
        void vscode.window.showWarningMessage('That stage has no log to open.');
        return;
      }
      void (async () => {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(artifact));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (e) {
          // The gate wrote the path, but the file can be gone (worktree removed).
          void vscode.window.showWarningMessage(`Cannot open the log at ${artifact}.`);
          logError('open stage log failed', e);
        }
      })();
    },
    // A `stage-log-request` for the terminal "detailed mode" view: the manager
    // owns the ticket panel, so the read (store + fs, bounded) happens here and
    // the `stage-log` answer is posted to the panel that asked.
    requestStageLog: (stage) => requestStageLog(stage),
    // An `agent-log-request` for the terminal view of a gate-lane AI process
    // (the UAT Tester / Review findings lane): the manager owns the panel, and
    // the read of the persisted tail happens host-side.
    requestAgentLog: (processId) => requestAgentLog(processId),
    // Combined server logs: read all server log files and start polling for
    // live updates. The manager owns the panel, so the read happens here.
    requestServerLogs: () => requestServerLogs(),
    // Close the combined server logs view and stop polling.
    closeServerLogs: () => closeServerLogs(),
    // The user's Approve/Reject on changed baselines (@arch:BASELINE-REVIEW);
    // all validation and effects live in ops/baselineDecisionOps.ts.
    ...makeTesterSkipActions({ store, ticketId, notify: vscodeNotify, redrive: driveAfterResume, refresh: afterServerChange }),
    ...makeBaselineActions({ store, manifest, ticketId, notify: vscodeNotify, redrive: driveAfterResume, refresh: afterServerChange }),
    ...usageLimitParks,
    // Open one artifact resource in a normal VS Code editor — the deliberate
    // escape from the semantic artifact UI into the file model (spec §12). The
    // webview names ONLY the artifact id and a resource index, so this re-reads
    // the ticket's artifacts FRESH and resolves both against them: a stale
    // panel, a gone artifact, or a forged message all land on the same
    // "no longer available" refusal, and no webview-supplied path ever reaches
    // `Uri.file`. Mirrors openStageLog's failure copy: a missing file is
    // "cannot open", never a domain verdict about the artifact's result.
    ...storedArtifacts,
    openArtifactResource: (artifactId, index) => {
      void (async () => {
        const artifact = buildTicketArtifacts(store, ticketId).find((a) => a.id === artifactId);
        const resource = artifact && artifact.resources[index];
        if (!artifact || !resource) {
          void vscode.window.showWarningMessage('That artifact file is no longer available.');
          return;
        }
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resource.path));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (e) {
          void vscode.window.showWarningMessage(`Cannot open the file at ${resource.path}.`);
          logError('open artifact resource failed', e);
        }
      })();
    },
    // Hand one repo's conflict to an agent, briefed with where, against what,
    // and which paths the probe named. karst runs no git itself here: the
    // worktree may still have a session sitting in it, and a half-applied merge
    // left by a button click is a state nobody asked for.
    resolveConflicts: (repo) => {
      if (!guardCapability('sessions', ticketId)) return;
      void askPausedModal(store, ticketId, 'resolving conflicts', 'Resolve conflicts', () => afterServerChange()).then((r) => (r === 'proceed' ? resolveConflictClick({
        repo, label: formatId('ticket', ticketId),
        probeSandbox: () => sandbox.bindings()?.probeSandbox(ticketId) ?? Promise.resolve({ state: 'absent' as const }),
        briefFor: (sandboxed) => buildConflictBrief(store, ticketId, repo, sandboxed),
        arm: (r) => armConflictRound(store, conflictRounds, ticketId, r),
        notify: (message) => void vscode.window.showInformationMessage(message),
        deliver: (brief, hit) => handOffToSession(brief, hit),
      }) : undefined));
    },
    // Merge one repo's PR, from the ship stage.
    //
    // Irreversible, so the confirmation is a MODAL and it is the same click that
    // chooses the strategy — there is no default method and no way to merge
    // without answering. The webview only names the repo; everything about how
    // (and whether) the merge happens is decided here and in `mergeTicketPr`.
    //
    // The dashboard is refreshed on EVERY exit — success, refusal, cancel, throw —
    // because the panel's pending state is cleared by a state push. Skipping the
    // push on the cancel path would leave the button stuck on "Merging…".
    mergePr: (repo) => {
      if (!guardCapability('ship')) return;
      void (async () => {
        try {
          // The store decides what is mergeable: `repo` arrived in a webview
          // message and a stale panel can name a PR that has since gone.
          const pr = findTicketPr(store, ticketId, repo);
          if (!pr) {
            void vscode.window.showInformationMessage(
              `No pull request is recorded for "${repo}" on ticket ${formatId('ticket', ticketId)} — nothing to merge.`,
            );
            return;
          }
          if (pr.status === 'merged') {
            void vscode.window.showInformationMessage(
              `Pull request${pr.number ? ` #${pr.number}` : ''} is already merged.`,
            );
            return;
          }

          const target = pr.baseRef ? ` into ${pr.baseRef}` : '';
          const choice = await vscode.window.showWarningMessage(
            `Merge pull request${pr.number ? ` #${pr.number}` : ''}${target}?`,
            {
              modal: true,
              detail:
                'This merges the branch on GitHub now. karst cannot undo it. '
                + 'The worktree and its branch are kept.',
            },
            'Squash and merge',
            'Create a merge commit',
          );
          if (!choice) return; // dismissed: nothing ran, and nothing is claimed

          const result = await mergeTicketPr(store, {
            ticketId,
            repo,
            method: choice === 'Squash and merge' ? 'squash' : 'merge',
          });
          if (result.ok) {
            void vscode.window.showInformationMessage(
              result.completedTicket
                ? `Merged pull request${pr.number ? ` #${pr.number}` : ''} — ticket ${formatId('ticket', ticketId)} done.`
                : `Merged pull request${pr.number ? ` #${pr.number}` : ''}.`,
            );
            // `done` is reached here, not at ship: this is where the work has
            // actually landed, so this is where the provider's status is pushed.
            // Only the merge that finished the ticket does it — a multi-repo
            // ticket with PRs still open is not done.
            if (result.completedTicket) await onTicketCompleted();
            return;
          }
          // The reason is gh's own words where there are any. `mergeTicketPr` has
          // already persisted the real, re-probed state, so the panel and this
          // message describe the same PR.
          logError(`merge failed for ticket ${formatId('ticket', ticketId)} (${repo})`, undefined);
          void vscode.window.showErrorMessage(`Merge failed: ${result.reason}`);
        } catch (e) {
          logError('merge failed', e);
          void vscode.window.showErrorMessage(
            `Merge failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          afterServerChange();
        }
      })();
    },
    // Dismiss one repo's PR — "this one will never land" — from the ship stage.
    //
    // The escape hatch for the stuck ship stage: the merge gate waits for a
    // literal 'merged' per repo, and a PR CLOSED because the changes turned out
    // to be unneeded can never reach it, so a multi-repo ticket parks at `ship`
    // with no action able to move it. This is the human statement the gate is
    // missing — and it is a statement about a PR, not a force-advance: the gate
    // is re-read normally afterwards, so a ticket with other unmerged PRs stays
    // exactly as parked as it was.
    //
    // Confirmed with a modal (it changes when a ticket reads Done) but NOT
    // danger-worded: it is reversible from the same row. The dashboard is
    // refreshed on every exit, for the same pending-state reason `mergePr`
    // documents.
    dismissPr: (repo) => {
      if (!guardCapability('ship')) return;
      void (async () => {
        try {
          const pr = findTicketPr(store, ticketId, repo);
          if (!pr) {
            void vscode.window.showInformationMessage(
              `No pull request is recorded for "${repo}" on ticket ${formatId('ticket', ticketId)} — nothing to dismiss.`,
            );
            return;
          }
          const num = pr.number ? ` #${pr.number}` : '';
          const choice = await vscode.window.showWarningMessage(
            `Stop waiting on pull request${num}?`,
            {
              modal: true,
              detail:
                'karst will treat this pull request as one that will never land, so it no '
                + 'longer holds the ticket at Ship. Nothing on GitHub changes, and you can '
                + 'undo this from the same row.',
            },
            'Dismiss pull request',
          );
          if (!choice) return; // dismissed: nothing ran, and nothing is claimed

          const result = await dismissTicketPr(
            store,
            {
              ticketId,
              repo,
              at: nowIso(),
              debug,
            },
            defaultGitRunner,
          );
          if (!result.ok) {
            void vscode.window.showErrorMessage(result.reason);
            return;
          }
          void vscode.window.showInformationMessage(
            result.completedTicket
              ? `Dismissed pull request${num} — ticket ${formatId('ticket', ticketId)} done.`
              : `Dismissed pull request${num}.`,
          );
          // Same rule as the merge that finishes a ticket: `done` is where the
          // provider's status is pushed, and only the action that reached it
          // does the pushing.
          if (result.completedTicket) await onTicketCompleted();
        } catch (e) {
          logError('dismiss failed', e);
          void vscode.window.showErrorMessage(
            `Could not dismiss the pull request: ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          afterServerChange();
        }
      })();
    },
    // Undo a dismissal. Not confirmed: it only puts a pull request back in the
    // merge gate's way, which is the state the ticket was already in before the
    // dismissal, and it can never move a ticket forward.
    undismissPr: (repo) => {
      if (!guardCapability('ship')) return;
      try {
        const result = undismissTicketPr(store, { ticketId, repo, debug });
        if (!result.ok) void vscode.window.showInformationMessage(result.reason);
      } catch (e) {
        logError('undismiss failed', e);
        void vscode.window.showErrorMessage(
          `Could not undo the dismissal: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        afterServerChange();
      }
    },
    // Re-probe PR status and mergeability on demand, from the panel's refresh
    // icon. The background sweep runs once a minute behind a five-minute
    // freshness floor, so after pushing a conflict fix a user could watch a stale
    // "conflicted" for minutes with no way to ask again.
    //
    // Errors are the sweep's own to log — this only has to guarantee the panel
    // gets a push either way, or the icon spins forever.
    refreshPrs: () => {
      void (async () => {
        try {
          await refreshPrs();
        } finally {
          afterServerChange();
        }
      })();
    },
    refreshShipPreview: () => refreshShipPreview(),
    toggleBind,
    // Returns a promise, so the button reports a REAL terminal outcome rather
    // than a bare ack (UI-R13): the write is fast and local, so there is no
    // reason to settle on anything weaker.
    insideAction: (actionId) => onInsideAction(actionId),
    setDisabledGate: async (stage, name, disabled) => {
      const current = getDisabledGates(store, ticketId)[stage];
      const next = disabled ? [...current, name] : current.filter((n) => n !== name);
      setDisabledGates(store, ticketId, stage, next);
      // Re-push so the row re-renders from what was actually stored, never
      // from what the click assumed.
      afterServerChange();
    },
    // Save ONE scope of the ticket's env overrides. The scope is validated
    // against the ticket's own selected repositories (or the all-services `*`)
    // before anything is written: the editor offers exactly those, so a scope
    // outside them is a crafted or stale message, never a user's intent. The
    // body is parsed by the SAME parser that reads a repository's `.env`, and
    // the result only ever reaches a spawn env — no `.env` on disk is written.
    saveEnvOverrides: async (scope, text) => {
      const known = getTicket(store, ticketId).selectedRepos;
      if (scope !== ALL_SERVICES && !known.includes(scope)) {
        void vscode.window.showWarningMessage(
          `“${scope}” is not a repository this ticket scopes — nothing was saved.`,
        );
        return;
      }
      setServiceEnvOverrides(store, ticketId, scope, parseEnvText(text));
      // Re-push so the editor re-renders from what was actually stored (keys
      // the parser dropped included), never from what the user typed.
      afterServerChange();
    },
    // Change a spun ticket's base branch for one repository (§ per-repo base
    // branch — live change). `repo` is the worktree's repoPath; the manifest
    // is read FRESH (like ship) so a mid-session `karst.yml` edit controls
    // the resolved default. A refusal is reported via a THROW — the seam this
    // resolves through (panel.ts's `change-base-ref` branch) reports `ok`
    // from the resolved value, so `ok: false` is expressed by throwing, not
    // by returning it — no repaint happens, and `worktrees.base_ref` is
    // untouched (the workflow itself never writes it on a refusal).
    changeBaseRef: async (repo, baseRef, rebase) => {
      const manifestNow = manifest();
      if (!manifestNow) return { ok: false, message: 'No manifest is loaded — nothing to change.' };
      if (rebase && (await askPausedModal(store, ticketId, 'the rebase', 'Rebase', () => afterServerChange())) === 'cancel') return { ok: false, message: 'Cancelled.' };
      const result = await changeBaseRefWorkflow({
        store,
        manifest: manifestNow,
        ticketId,
        repoPath: repo,
        toBase: baseRef,
        rebase,
        git: defaultGitRunner, gh: defaultGhRunnerAsync, debug,
        afterRewrite: () => sandbox.life().recreateNoSync(ticketId), sandboxUnsynced: () => sandbox.life().hasUnsynced(ticketId),
      });
      if (!result.ok) return { ok: false, message: result.reason };
      return { ok: true, message: describeChangeBaseRef(result) };
    },
  };
}
