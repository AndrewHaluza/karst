/**
 * The dashboard webview's type-checked message constructors (NDL-39).
 *
 * These tests prove two things the inline-JS design could not:
 *  1. Every named sender posts the EXACT object the host's `parseWebviewMessage`
 *     expects (wire shape, not just "something was posted").
 *  2. The host union is closed: a typo'd field, an extra field, an unknown type
 *     or a missing required field is a `tsc --noEmit` error (the `@ts-expect-error`
 *     block below fails typecheck if any of those ever stop being errors).
 */
import { describe, it, expect } from 'vitest';
import { createSender } from './webviewSend.js';
import type { WebviewMessage } from './messages.js';

/** A fake host API recording every post. */
function harness() {
  const posted: unknown[] = [];
  const sender = createSender({ postMessage: (m) => posted.push(m) });
  return { posted, sender };
}

describe('dashboard webviewSend', () => {
  it('posts the exact expected message for each sender', () => {
    const { posted, sender } = harness();

    sender.stopServer(7, 'r1');
    expect(posted.at(-1)).toEqual({ type: 'stop-server', serverId: 7, requestId: 'r1' });

    sender.restartServer(7);
    expect(posted.at(-1)).toEqual({ type: 'restart-server', serverId: 7 });

    sender.startServer(7);
    expect(posted.at(-1)).toEqual({ type: 'start-server', serverId: 7 });

    sender.openServer(7);
    expect(posted.at(-1)).toEqual({ type: 'open-server', serverId: 7 });

    sender.copyServerUrl(7);
    expect(posted.at(-1)).toEqual({ type: 'copy-server-url', serverId: 7 });

    sender.spinServers('r2');
    expect(posted.at(-1)).toEqual({ type: 'spin-servers', requestId: 'r2' });
    sender.restartServers();
    expect(posted.at(-1)).toEqual({ type: 'restart-servers' });
    sender.stopServers();
    expect(posted.at(-1)).toEqual({ type: 'stop-servers' });
    sender.showChanges();
    expect(posted.at(-1)).toEqual({ type: 'show-changes' });

    sender.openWorktreeTerminal('/w');
    expect(posted.at(-1)).toEqual({ type: 'open-worktree-terminal', path: '/w' });
    sender.openWorktreeFolder('/w');
    expect(posted.at(-1)).toEqual({ type: 'open-worktree-folder', path: '/w' });
    sender.copyWorktreeBranch('feat/x');
    expect(posted.at(-1)).toEqual({ type: 'copy-worktree-branch', branch: 'feat/x' });
    sender.launchWorktreeExtension('/w');
    expect(posted.at(-1)).toEqual({ type: 'launch-worktree-extension', path: '/w' });

    sender.openPr('https://example.test/pr/1');
    expect(posted.at(-1)).toEqual({ type: 'open-pr', url: 'https://example.test/pr/1' });
    sender.copyPrUrl('https://example.test/pr/1');
    expect(posted.at(-1)).toEqual({ type: 'copy-pr-url', url: 'https://example.test/pr/1' });
    sender.openTicketLink('https://example.test/t/1');
    expect(posted.at(-1)).toEqual({ type: 'open-ticket-link', url: 'https://example.test/t/1' });

    sender.editTicket();
    expect(posted.at(-1)).toEqual({ type: 'edit-ticket' });
    sender.stopDriver();
    expect(posted.at(-1)).toEqual({ type: 'stop-driver' });
    sender.shipTicket();
    expect(posted.at(-1)).toEqual({ type: 'ship-ticket' });
    sender.resumeTicket();
    expect(posted.at(-1)).toEqual({ type: 'resume-ticket' });
    sender.createFollowUpTicket();
    expect(posted.at(-1)).toEqual({ type: 'create-follow-up-ticket' });
    sender.sendBackToImplement();
    expect(posted.at(-1)).toEqual({ type: 'send-back-to-implement' });
    sender.addressPrFeedback();
    expect(posted.at(-1)).toEqual({ type: 'address-pr-feedback' });

    sender.openStageLog('uat');
    expect(posted.at(-1)).toEqual({ type: 'open-stage-log', stageKey: 'uat' });
    sender.resolveConflicts('api');
    expect(posted.at(-1)).toEqual({ type: 'resolve-conflicts', repo: 'api' });
    sender.mergePr('api');
    expect(posted.at(-1)).toEqual({ type: 'merge-pr', repo: 'api' });
    sender.dismissPr('api');
    expect(posted.at(-1)).toEqual({ type: 'dismiss-pr', repo: 'api' });
    sender.undismissPr('api');
    expect(posted.at(-1)).toEqual({ type: 'undismiss-pr', repo: 'api' });
    sender.refreshPrs();
    expect(posted.at(-1)).toEqual({ type: 'refresh-prs' });
    sender.toggleBind();
    expect(posted.at(-1)).toEqual({ type: 'toggle-bind' });

    sender.switchAgent('claude', 'sonnet-5', null, 'r3');
    expect(posted.at(-1)).toEqual({
      type: 'switch-agent',
      provider: 'claude',
      model: 'sonnet-5',
      effort: null,
      requestId: 'r3',
    });
    sender.copyTicketKey();
    expect(posted.at(-1)).toEqual({ type: 'copy-ticket-key' });

    sender.stageResume(42, 'review');
    expect(posted.at(-1)).toEqual({ type: 'stage-resume', ticketId: 42, stageKey: 'review' });
    sender.pauseExecution();
    expect(posted.at(-1)).toEqual({ type: 'pause-execution' });
    sender.unpauseExecution();
    expect(posted.at(-1)).toEqual({ type: 'unpause-execution' });
    sender.setDisabledGates('review', 'lint', true, 'r4');
    expect(posted.at(-1)).toEqual({
      type: 'set-disabled-gates',
      stage: 'review',
      name: 'lint',
      disabled: true,
      requestId: 'r4',
    });
    sender.insideAction('snapshot-1:action-7');
    expect(posted.at(-1)).toEqual({ type: 'inside-action', actionId: 'snapshot-1:action-7' });
    sender.artifactOpenResource('uat-report', 2, 'r5');
    expect(posted.at(-1)).toEqual({
      type: 'artifact-open-resource',
      artifactId: 'uat-report',
      index: 2,
      requestId: 'r5',
    });
    sender.stageLogRequest('uat');
    expect(posted.at(-1)).toEqual({ type: 'stage-log-request', stage: 'uat' });
    sender.agentLogRequest('tester');
    expect(posted.at(-1)).toEqual({ type: 'agent-log-request', processId: 'tester' });
    sender.selectGateAttempt('review', 'sr:10');
    expect(posted.at(-1)).toEqual({ type: 'select-gate-attempt', stage: 'review', key: 'sr:10' });
    sender.selectFindingsRepo('review', null);
    expect(posted.at(-1)).toEqual({ type: 'select-findings-repo', stage: 'review', repo: null });
    sender.changeBaseRef('api', 'develop', true, 'r6');
    expect(posted.at(-1)).toEqual({
      type: 'change-base-ref',
      repo: 'api',
      baseRef: 'develop',
      rebase: true,
      requestId: 'r6',
    });
    sender.rerunGate('uat');
    expect(posted.at(-1)).toEqual({ type: 'rerun-gate', stage: 'uat' });

    sender.serverLogsRequest();
    expect(posted.at(-1)).toEqual({ type: 'server-logs-request' });
    sender.serverLogsClose();
    expect(posted.at(-1)).toEqual({ type: 'server-logs-close' });
    sender.serverLogsDetach();
    expect(posted.at(-1)).toEqual({ type: 'server-logs-detach' });
    sender.serverLogsTab('api');
    expect(posted.at(-1)).toEqual({ type: 'server-logs-tab', tab: 'api' });

    sender.envOverridesSave('api', 'FOO=bar', 'r7');
    expect(posted.at(-1)).toEqual({
      type: 'env-overrides-save',
      scope: 'api',
      text: 'FOO=bar',
      requestId: 'r7',
    });

    expect(posted).toHaveLength(49);
  });

  it('rejects a wrong argument type at compile time', () => {
    const { sender } = harness();
    // @ts-expect-error serverId is a number, never a string.
    sender.stopServer('7');
    // @ts-expect-error stage is the closed GateStage set, not any string.
    sender.rerunGate('nope');
  });
});

/**
 * The host union is closed. Each `@ts-expect-error` below must keep FAILING to
 * typecheck; if a field is ever loosened, `tsc --noEmit` reports the now-unused
 * directive and the contract is back under test.
 */
function hostUnionIsClosed(): void {
  const ok: WebviewMessage = { type: 'stop-server', serverId: 1 };
  void ok;

  // @ts-expect-error typo'd field name (serverID, not serverId)
  const typo: WebviewMessage = { type: 'stop-server', serverID: 1 };
  void typo;

  // @ts-expect-error extra field not in the contract
  const extra: WebviewMessage = { type: 'refresh-prs', enabled: true };
  void extra;

  // @ts-expect-error unknown message type
  const unknown: WebviewMessage = { type: 'not-a-real-action' };
  void unknown;

  // @ts-expect-error missing required field (serverId)
  const missing: WebviewMessage = { type: 'stop-server' };
  void missing;
}
void hostUnionIsClosed;
