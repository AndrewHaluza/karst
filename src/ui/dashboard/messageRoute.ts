import type { InsideActionResult } from './messages.js';
import type { DashboardActions } from './messageActions.js';
import { parseWebviewMessage } from './messageParse.js';

/**
 * Route an untrusted webview message to the matching action. The message is
 * validated at this boundary; unknown / malformed shapes are ignored so a stray
 * or hostile message can't crash the host or drive an action with bad input.
 *
 * Returns whatever the matched action returns (`void` or a `Promise<void>`) so
 * the single dispatch seam in `panel.ts` can await it and report one terminal
 * `action-result` (§ `docs/ui/DESIGN-SYSTEM.md` §5.3, UI-R13). An unparsed
 * message returns `undefined` WITHOUT calling any action.
 */
export function routeAction(
  raw: unknown,
  actions: DashboardActions,
): InsideActionResult | void | Promise<void> | Promise<InsideActionResult> {
  const msg = parseWebviewMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'stop-server':
      return actions.stopServer(msg.serverId);
    case 'restart-server':
      return actions.restartServer(msg.serverId);
    case 'start-server':
      return actions.startServer(msg.serverId);
    case 'open-server':
      return actions.openServer(msg.serverId);
    case 'copy-server-url':
      return actions.copyServerUrl(msg.serverId);
    case 'spin-servers':
      return actions.spinServers();
    case 'restart-servers':
      return actions.restartServers();
    case 'stop-servers':
      return actions.stopServers();
    case 'open-resources':
      return actions.openResources();
    case 'sandbox-sync':
      return actions.sandboxSync();
    case 'sandbox-diff':
      return actions.sandboxDiff();
    case 'sandbox-stop':
      return actions.sandboxStop();
    case 'sandbox-remove':
      return actions.sandboxRemove();
    case 'sandbox-carry':
      return actions.sandboxCarry();
    case 'sandbox-stash-update':
      return actions.sandboxStashUpdate();
    case 'show-changes':
      return actions.showChanges();
    case 'open-worktree-terminal':
      return actions.openWorktreeTerminal(msg.path);
    case 'open-worktree-folder':
      return actions.openWorktreeFolder(msg.path);
    case 'copy-worktree-branch':
      return actions.copyWorktreeBranch(msg.branch);
    case 'launch-worktree-extension':
      return actions.launchWorktreeExtension(msg.path);
    case 'open-pr':
      return actions.openPr(msg.url);
    case 'copy-pr-url':
      return actions.copyPrUrl(msg.url);
    case 'open-ticket-link':
      return actions.openTicketLink(msg.url);
    case 'edit-ticket':
      return actions.editTicket();
    case 'open-dependency':
      return actions.openDependency(msg.ticketId);
    case 'stop-driver':
      return actions.stopDriver();
    case 'ship-ticket':
      return actions.shipTicket();
    case 'resume-ticket':
      return actions.resumeTicket();
    case 'send-back-to-implement':
      return actions.sendBackToImplement();
    case 'reset-stage':
      return actions.resetStage();
    case 'review-stall-hint':
      return actions.reviewStallHint();
    case 'review-stall-continue':
      return actions.reviewStallContinue();
    case 'review-stall-rescope':
      return actions.reviewStallRescope();
    case 'address-pr-feedback':
      return actions.addressPrFeedback();
    case 'send-ci-failure':
      return actions.sendCiFailure();
    case 'rebase-on-base':
      return actions.rebaseOnBase();
    case 'deliver-to-pr':
      return actions.deliverToPr();
    case 'create-follow-up-ticket':
      return actions.createFollowUpTicket();
    case 'create-subtask':
      return actions.createSubtask();
    case 'detach-subtask':
      return actions.detachSubtask();
    case 'close-ticket':
      return actions.closeTicket();
    case 'reopen-ticket':
      return actions.reopenTicket();
    case 'open-stage-log':
      return actions.openStageLog(msg.stageKey);
    case 'resolve-conflicts':
      return actions.resolveConflicts(msg.repo);
    case 'merge-pr':
      return actions.mergePr(msg.repo);
    case 'dismiss-pr':
      return actions.dismissPr(msg.repo);
    case 'undismiss-pr':
      return actions.undismissPr(msg.repo);
    case 'refresh-prs':
      return actions.refreshPrs();
    case 'refresh-ship-preview':
      return actions.refreshShipPreview();
    case 'toggle-bind':
      return actions.toggleBind();
    case 'switch-agent':
      return actions.switchAgent(msg.provider, msg.model, msg.effort);
    case 'copy-ticket-key':
      return actions.copyTicketKey();
    case 'stage-resume':
      return actions.resumeStage(msg.ticketId, msg.stageKey);
    case 'run-gate-on-host':
      return actions.runGateOnHost(msg.ticketId, msg.stageKey);
    case 'usage-limit-pick':
      return actions.usageLimitPick(msg.ticketId, msg.stageKey);
    case 'usage-limit-retry':
      return actions.usageLimitRetry(msg.ticketId, msg.stageKey);
    case 'usage-limit-dismiss':
      return actions.usageLimitDismiss(msg.ticketId, msg.stageKey);
    case 'pause-execution':
      return actions.pauseExecution();
    case 'unpause-execution':
      return actions.unpauseExecution();
    case 'set-disabled-gates':
      return actions.setDisabledGate(msg.stage, msg.name, msg.disabled);
    case 'inside-action':
      return actions.insideAction(msg.actionId);
    case 'artifact-open-resource':
      return actions.openArtifactResource(msg.artifactId, msg.index);
    case 'stored-artifact-open':
      return actions.openStoredRevision(msg.path, msg.sha);
    case 'stored-artifact-diff':
      return actions.diffStoredRevisions(msg.path, msg.from, msg.to);
    case 'stored-artifact-live':
      return actions.openStoredLive(msg.path);
    case 'stored-artifact-reveal':
      return actions.revealStoredFolder();
    case 'stored-artifact-purge':
      return actions.purgeStoredArtifacts();
    case 'baseline-approve':
      return actions.baselineApprove(msg.blockId, msg.indices);
    case 'tester-skipped-rerun':
      return actions.testerSkippedRerun();
    case 'tester-skipped-accept':
      return actions.testerSkippedAccept();
    case 'push-diverged-overwrite':
      return actions.pushDivergedOverwrite();
    case 'push-diverged-integrate':
      return actions.pushDivergedIntegrate();
    case 'baseline-reject':
      return actions.baselineReject(msg.blockId, msg.index, msg.reason);
    case 'stage-log-request':
      return actions.requestStageLog(msg.stage);
    case 'agent-log-request':
      return actions.requestAgentLog(msg.processId);
    case 'change-base-ref':
      return actions.changeBaseRef(msg.repo, msg.baseRef, msg.rebase);
    case 'rerun-gate':
      return actions.rerunGate(msg.stage);
    case 'server-logs-request':
      return actions.requestServerLogs();
    case 'server-logs-close':
      return actions.closeServerLogs();
    case 'server-logs-detach':
      return actions.onServerLogsDetach?.();
    case 'server-logs-tab':
      return;
    // Answered by the panel host itself (it owns the vendored bundle).
    case 'xterm-request':
      return;
    case 'env-overrides-save':
      return actions.saveEnvOverrides(msg.scope, msg.text);
  }
}
