import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routeAction, parseWebviewMessage, parseInsideProgress, type DashboardActions } from './messages.js';

const MESSAGES_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'messages.ts'),
  'utf8',
);

function actions(): DashboardActions {
  return {
    stopServer: vi.fn(),
    saveEnvOverrides: vi.fn(),
    pauseExecution: vi.fn(),
    unpauseExecution: vi.fn(),
    restartServer: vi.fn(),
    openServer: vi.fn(),
    copyServerUrl: vi.fn(),
    spinServers: vi.fn(),
    restartServers: vi.fn(),
    stopServers: vi.fn(),
    showChanges: vi.fn(),
    openWorktreeTerminal: vi.fn(),
    openWorktreeFolder: vi.fn(),
    copyWorktreeBranch: vi.fn(),
    launchWorktreeExtension: vi.fn(),
    openPr: vi.fn(),
    copyPrUrl: vi.fn(),
    openTicketLink: vi.fn(),
    editTicket: vi.fn(),
    stopDriver: vi.fn(),
    shipTicket: vi.fn(),
    resumeTicket: vi.fn(),
    sendBackToImplement: vi.fn(),
    addressPrFeedback: vi.fn(),
    rerunGate: vi.fn(),
    createFollowUpTicket: vi.fn(),
    openStageLog: vi.fn(),
    resolveConflicts: vi.fn(),
    mergePr: vi.fn(),
    dismissPr: vi.fn(),
    undismissPr: vi.fn(),
    refreshPrs: vi.fn(),
    toggleBind: vi.fn(),
    switchAgent: vi.fn(),
    copyTicketKey: vi.fn(),
    resumeStage: vi.fn(),
    setDisabledGate: vi.fn(),
    insideAction: vi.fn(),
    openArtifactResource: vi.fn(),
    requestStageLog: vi.fn(),
    requestAgentLog: vi.fn(),
    changeBaseRef: vi.fn(),
    requestServerLogs: vi.fn(),
    closeServerLogs: vi.fn(),
  };
}

describe('routeAction', () => {
  it('dispatches stop-server to the supervisor action with the server id', () => {
    const a = actions();
    routeAction({ type: 'stop-server', serverId: 7 }, a);
    expect(a.stopServer).toHaveBeenCalledWith(7);
  });

  it('dispatches restart-server / open-server', () => {
    const a = actions();
    routeAction({ type: 'restart-server', serverId: 3 }, a);
    routeAction({ type: 'open-server', serverId: 3 }, a);
    expect(a.restartServer).toHaveBeenCalledWith(3);
    expect(a.openServer).toHaveBeenCalledWith(3);
  });

  it('dispatches ticket changes without trusting a companion path', () => {
    const a = actions();
    routeAction({ type: 'show-changes', path: '/forged' }, a);
    expect(a.showChanges).toHaveBeenCalledOnce();
  });

  it('dispatches open-folder by path', () => {
    const a = actions();
    routeAction({ type: 'open-worktree-folder', path: '/wt/a' }, a);
    expect(a.openWorktreeFolder).toHaveBeenCalledWith('/wt/a');
  });

  it('validates and dispatches worktree terminal and branch-copy actions', () => {
    const a = actions();
    routeAction({ type: 'open-worktree-terminal', path: '/wt/a' }, a);
    routeAction({ type: 'copy-worktree-branch', branch: 'karst/A' }, a);
    expect(a.openWorktreeTerminal).toHaveBeenCalledWith('/wt/a');
    expect(a.copyWorktreeBranch).toHaveBeenCalledWith('karst/A');
  });

  it('rejects empty or non-string worktree action payloads', () => {
    expect(parseWebviewMessage({ type: 'open-worktree-terminal', path: '' })).toBeNull();
    expect(parseWebviewMessage({ type: 'copy-worktree-branch', branch: '' })).toBeNull();
    expect(parseWebviewMessage({ type: 'copy-worktree-branch', branch: 4 })).toBeNull();
  });

  it('validates and dispatches launch-worktree-extension by path', () => {
    const a = actions();
    routeAction({ type: 'launch-worktree-extension', path: '/wt/a' }, a);
    expect(a.launchWorktreeExtension).toHaveBeenCalledWith('/wt/a');
    expect(parseWebviewMessage({ type: 'launch-worktree-extension', path: '' })).toBeNull();
    expect(parseWebviewMessage({ type: 'launch-worktree-extension' })).toBeNull();
  });

  it('dispatches open-pr by url', () => {
    const a = actions();
    routeAction({ type: 'open-pr', url: 'http://pr/1' }, a);
    expect(a.openPr).toHaveBeenCalledWith('http://pr/1');
  });

  it('dispatches copy-pr-url by url, and refuses a non-http scheme like open-pr', () => {
    const a = actions();
    routeAction({ type: 'copy-pr-url', url: 'https://github.com/o/r/pull/1' }, a);
    expect(a.copyPrUrl).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
    expect(parseWebviewMessage({ type: 'copy-pr-url', url: 'https://github.com/o/r/pull/1' })).toEqual({
      type: 'copy-pr-url',
      url: 'https://github.com/o/r/pull/1',
    });
    expect(parseWebviewMessage({ type: 'copy-pr-url', url: 'file:///etc/passwd' })).toBeNull();
    expect(parseWebviewMessage({ type: 'copy-pr-url' })).toBeNull();
  });

  it('dispatches copy-server-url by server id', () => {
    const a = actions();
    routeAction({ type: 'copy-server-url', serverId: 9 }, a);
    expect(a.copyServerUrl).toHaveBeenCalledWith(9);
  });

  it('dispatches spin-servers (no payload)', () => {
    const a = actions();
    routeAction({ type: 'spin-servers' }, a);
    expect(a.spinServers).toHaveBeenCalledTimes(1);
  });

  it('parses the panel-level server actions (no payload)', () => {
    expect(parseWebviewMessage({ type: 'restart-servers' })).toEqual({ type: 'restart-servers' });
    expect(parseWebviewMessage({ type: 'stop-servers' })).toEqual({ type: 'stop-servers' });
  });

  it('dispatches restart-servers / stop-servers, which act on the whole ticket', () => {
    const a = actions();
    routeAction({ type: 'restart-servers' }, a);
    routeAction({ type: 'stop-servers' }, a);
    expect(a.restartServers).toHaveBeenCalledTimes(1);
    expect(a.stopServers).toHaveBeenCalledTimes(1);
    // They are NOT the per-row actions — a panel control that silently fell
    // through to the single-server handler would stop one server and look like
    // it had stopped them all.
    expect(a.stopServer).not.toHaveBeenCalled();
    expect(a.restartServer).not.toHaveBeenCalled();
  });

  it('ignores a stray serverId on a panel-level server action', () => {
    // The webview never sends one (the header buttons carry no data-id), so a
    // message that does is malformed — it must not be reshaped into a per-row
    // action by the parser.
    expect(parseWebviewMessage({ type: 'stop-servers', serverId: 4 })).toEqual({
      type: 'stop-servers',
    });
  });

  it('dispatches open-ticket-link only for http(s) urls', () => {
    const a = actions();
    routeAction({ type: 'open-ticket-link', url: 'https://app.clickup.com/t/x' }, a);
    routeAction({ type: 'open-ticket-link', url: 'file:///etc/passwd' }, a);
    expect(a.openTicketLink).toHaveBeenCalledTimes(1);
    expect(a.openTicketLink).toHaveBeenCalledWith('https://app.clickup.com/t/x');
  });

  it('rejects copy-server-url whose serverId is not a number', () => {
    const a = actions();
    routeAction({ type: 'copy-server-url', serverId: '9' }, a);
    expect(a.copyServerUrl).not.toHaveBeenCalled();
  });

  it('ignores an unknown message shape without throwing', () => {
    const a = actions();
    expect(() => routeAction({ type: 'nonsense' } as never, a)).not.toThrow();
  });

  it('rejects a server action whose serverId is not a number', () => {
    const a = actions();
    routeAction({ type: 'stop-server', serverId: '7' }, a);
    routeAction({ type: 'stop-server' }, a);
    expect(a.stopServer).not.toHaveBeenCalled();
  });

  it('rejects the removed path-bearing worktree diff action', () => {
    expect(parseWebviewMessage({ type: 'diff-worktree', path: '/wt/a' })).toBeNull();
  });

  it('rejects an open-pr url that is not http(s) — no file:// or other scheme', () => {
    const a = actions();
    routeAction({ type: 'open-pr', url: 'file:///etc/passwd' }, a);
    routeAction({ type: 'open-pr', url: 'javascript:alert(1)' }, a);
    routeAction({ type: 'open-pr', url: 42 }, a);
    expect(a.openPr).not.toHaveBeenCalled();
    routeAction({ type: 'open-pr', url: 'https://github.com/o/r/pull/1' }, a);
    expect(a.openPr).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
  });

  it('ignores a non-object message (null / string / array)', () => {
    const a = actions();
    expect(() => routeAction(null, a)).not.toThrow();
    expect(() => routeAction('stop-server', a)).not.toThrow();
    expect(() => routeAction([], a)).not.toThrow();
    expect(a.stopServer).not.toHaveBeenCalled();
  });

  it('dispatches edit-ticket to the editTicket action', () => {
    const a = actions();
    routeAction({ type: 'edit-ticket' }, a);
    expect(a.editTicket).toHaveBeenCalled();
  });

  it('parses the driver/ship/resume actions', () => {
    expect(parseWebviewMessage({ type: 'stop-driver' })).toEqual({ type: 'stop-driver' });
    expect(parseWebviewMessage({ type: 'ship-ticket' })).toEqual({ type: 'ship-ticket' });
    expect(parseWebviewMessage({ type: 'resume-ticket' })).toEqual({ type: 'resume-ticket' });
    expect(parseWebviewMessage({ type: 'send-back-to-implement' })).toEqual({
      type: 'send-back-to-implement',
    });
  });

  it('dispatches stop-driver/ship-ticket/resume-ticket (no payload)', () => {
    const a = actions();
    routeAction({ type: 'stop-driver' }, a);
    routeAction({ type: 'ship-ticket' }, a);
    routeAction({ type: 'resume-ticket' }, a);
    expect(a.stopDriver).toHaveBeenCalledTimes(1);
    expect(a.shipTicket).toHaveBeenCalledTimes(1);
    expect(a.resumeTicket).toHaveBeenCalledTimes(1);
  });

  it('dispatches send-back-to-implement and drops a forged companion stage', () => {
    const a = actions();
    // The recovery is payload-free: a crafted `stage` field must not reach the
    // host action (which derives availability + the current stage itself).
    routeAction({ type: 'send-back-to-implement', stage: 'ship' }, a);
    expect(a.sendBackToImplement).toHaveBeenCalledOnce();
  });

  it('parses and dispatches create-follow-up-ticket', () => {
    expect(parseWebviewMessage({ type: 'create-follow-up-ticket' })).toEqual({
      type: 'create-follow-up-ticket',
    });
    const a = actions();
    routeAction({ type: 'create-follow-up-ticket' }, a);
    expect(a.createFollowUpTicket).toHaveBeenCalledTimes(1);
  });

  it('dispatches open-stage-log with the log path', () => {
    const a = actions();
    routeAction({ type: 'open-stage-log', path: '/logs/review-ticket-1.log' }, a);
    expect(a.openStageLog).toHaveBeenCalledWith('/logs/review-ticket-1.log');
  });

  it('ignores an open-stage-log with a missing or non-string path', () => {
    const a = actions();
    routeAction({ type: 'open-stage-log' }, a);
    routeAction({ type: 'open-stage-log', path: 42 }, a);
    routeAction({ type: 'open-stage-log', path: '' }, a);
    expect(a.openStageLog).not.toHaveBeenCalled();
  });

  it('dispatches resolve-conflicts with the repo the conflict is in', () => {
    const a = actions();
    routeAction({ type: 'resolve-conflicts', repo: 'api' }, a);
    expect(a.resolveConflicts).toHaveBeenCalledWith('api');
  });

  // The repo name selects which worktree a session is opened against, so it is
  // exactly the field a crafted message would want to bend.
  it('ignores a resolve-conflicts with a missing or non-string repo', () => {
    const a = actions();
    routeAction({ type: 'resolve-conflicts' }, a);
    routeAction({ type: 'resolve-conflicts', repo: 7 }, a);
    routeAction({ type: 'resolve-conflicts', repo: '' }, a);
    expect(a.resolveConflicts).not.toHaveBeenCalled();
  });

  it('dispatches merge-pr with the repo whose PR is being merged', () => {
    const a = actions();
    routeAction({ type: 'merge-pr', repo: '/repo/api' }, a);
    expect(a.mergePr).toHaveBeenCalledWith('/repo/api');
  });

  // Merging is irreversible, so this is the message a crafted one would most want
  // to bend — and it carries NO method: the host asks the user how to merge, so a
  // webview message can never choose the strategy for them.
  it('ignores a merge-pr with a missing or non-string repo, and drops any method', () => {
    const a = actions();
    routeAction({ type: 'merge-pr' }, a);
    routeAction({ type: 'merge-pr', repo: 7 }, a);
    routeAction({ type: 'merge-pr', repo: '' }, a);
    expect(a.mergePr).not.toHaveBeenCalled();
    expect(parseWebviewMessage({ type: 'merge-pr', repo: 'api', method: 'rebase' })).toEqual({
      type: 'merge-pr',
      repo: 'api',
    });
  });

  it('dispatches dismiss-pr and undismiss-pr with the repo they act on', () => {
    const a = actions();
    routeAction({ type: 'dismiss-pr', repo: '/repo/api' }, a);
    routeAction({ type: 'undismiss-pr', repo: '/repo/api' }, a);
    expect(a.dismissPr).toHaveBeenCalledWith('/repo/api');
    expect(a.undismissPr).toHaveBeenCalledWith('/repo/api');
  });

  // Same narrowing as merge-pr: the repo is the whole payload, and the host
  // resolves the PR from the store, so a crafted message cannot name one.
  it('ignores a dismiss-pr with a missing or non-string repo', () => {
    const a = actions();
    routeAction({ type: 'dismiss-pr' }, a);
    routeAction({ type: 'dismiss-pr', repo: 7 }, a);
    routeAction({ type: 'dismiss-pr', repo: '' }, a);
    routeAction({ type: 'undismiss-pr', repo: '' }, a);
    expect(a.dismissPr).not.toHaveBeenCalled();
    expect(a.undismissPr).not.toHaveBeenCalled();
  });

  it('parses change-base-ref', () => {
    expect(
      parseWebviewMessage({ type: 'change-base-ref', repo: '/repo', baseRef: 'epic/x', rebase: true }),
    ).toEqual({ type: 'change-base-ref', repo: '/repo', baseRef: 'epic/x', rebase: true });
  });

  // A missing switch reads as ON — a base change without a rebase would leave
  // the branch sitting on the old base, which is the unsafe reading.
  it('defaults rebase ON when the flag is absent — the safe read of a missing switch', () => {
    expect(
      parseWebviewMessage({ type: 'change-base-ref', repo: '/repo', baseRef: 'epic/x' }),
    ).toMatchObject({ rebase: true });
    expect(
      parseWebviewMessage({ type: 'change-base-ref', repo: '/repo', baseRef: 'epic/x', rebase: false }),
    ).toMatchObject({ rebase: false });
  });

  it('rejects change-base-ref with a blank base, or a missing/non-string repo', () => {
    expect(parseWebviewMessage({ type: 'change-base-ref', repo: '/repo', baseRef: '  ' })).toBeNull();
    expect(parseWebviewMessage({ type: 'change-base-ref', repo: '/repo' })).toBeNull();
    expect(parseWebviewMessage({ type: 'change-base-ref', baseRef: 'epic/x' })).toBeNull();
    expect(parseWebviewMessage({ type: 'change-base-ref', repo: '', baseRef: 'epic/x' })).toBeNull();
    expect(parseWebviewMessage({ type: 'change-base-ref', repo: 7, baseRef: 'epic/x' })).toBeNull();
  });

  it('dispatches change-base-ref to the injected action with the trimmed base', async () => {
    const a = actions();
    (a.changeBaseRef as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await routeAction({ type: 'change-base-ref', repo: '/repo', baseRef: '  epic/x  ', rebase: false }, a);
    expect(a.changeBaseRef).toHaveBeenCalledWith('/repo', 'epic/x', false);
  });

  // The panel's refresh icon. Payload-free like the other panel-level controls:
  // WHICH ticket's PRs get re-probed is the host's to know, so a companion
  // `repo`/`projectId` is dropped rather than honoured.
  it('dispatches refresh-prs, carrying no target of its own', () => {
    expect(parseWebviewMessage({ type: 'refresh-prs', repo: 'api' })).toEqual({
      type: 'refresh-prs',
    });
    const a = actions();
    routeAction({ type: 'refresh-prs' }, a);
    expect(a.refreshPrs).toHaveBeenCalledOnce();
  });

  it('dispatches toggle-bind, carrying no state of its own', () => {
    // The host owns the binding and flips it. A message that carried the desired
    // value could disagree with the host — two panels racing, or a stale webview
    // after a reload — and the pref is window-wide, so the two must not desync.
    expect(parseWebviewMessage({ type: 'toggle-bind', enabled: false })).toEqual({
      type: 'toggle-bind',
    });
    const a = actions();
    routeAction({ type: 'toggle-bind' }, a);
    expect(a.toggleBind).toHaveBeenCalledTimes(1);
  });

  it('parses a switch-agent selection and dispatches it with all three fields', () => {
    const a = actions();
    expect(parseWebviewMessage({
      type: 'switch-agent', provider: 'codex', model: 'gpt-5.2-codex', effort: 'high', ticketId: 999,
    })).toEqual({ type: 'switch-agent', provider: 'codex', model: 'gpt-5.2-codex', effort: 'high' });
    routeAction({ type: 'switch-agent', provider: 'codex', model: 'gpt-5.2-codex', effort: 'high' }, a);
    expect(a.switchAgent).toHaveBeenCalledWith('codex', 'gpt-5.2-codex', 'high');
  });

  it('coerces a blank model and effort to inherit (null)', () => {
    expect(parseWebviewMessage({ type: 'switch-agent', provider: 'claude' })).toEqual({
      type: 'switch-agent', provider: 'claude', model: null, effort: null,
    });
    expect(parseWebviewMessage({ type: 'switch-agent', provider: 'claude', model: '', effort: '' })).toEqual({
      type: 'switch-agent', provider: 'claude', model: null, effort: null,
    });
  });

  it('rejects a switch-agent to an unknown provider or a non-string model/effort', () => {
    expect(parseWebviewMessage({ type: 'switch-agent', provider: 'evil', model: 'x', effort: 'high' })).toBeNull();
    expect(parseWebviewMessage({ type: 'switch-agent', provider: 'codex', model: 42, effort: 'high' })).toBeNull();
    expect(parseWebviewMessage({ type: 'switch-agent', provider: 'codex', model: 'x'.repeat(300), effort: 'high' })).toBeNull();
    expect(parseWebviewMessage({ type: 'switch-agent', provider: 'codex', model: 'x', effort: 42 })).toBeNull();
    expect(parseWebviewMessage({ type: 'switch-agent', provider: 'codex', model: 'x', effort: 'x'.repeat(300) })).toBeNull();
  });

  it('parses and dispatches copy-ticket-key with no payload', () => {
    const a = actions();
    expect(parseWebviewMessage({ type: 'copy-ticket-key' })).toEqual({ type: 'copy-ticket-key' });
    routeAction({ type: 'copy-ticket-key' }, a);
    expect(a.copyTicketKey).toHaveBeenCalledOnce();
  });

  it('parses a well-formed stage-resume and dispatches it with both fields', () => {
    const a = actions();
    expect(parseWebviewMessage({ type: 'stage-resume', ticketId: 7, stageKey: 'review' })).toEqual({
      type: 'stage-resume',
      ticketId: 7,
      stageKey: 'review',
    });
    routeAction({ type: 'stage-resume', ticketId: 7, stageKey: 'review' }, a);
    expect(a.resumeStage).toHaveBeenCalledWith(7, 'review');
  });

  it('drops stage-resume with a non-numeric ticketId', () => {
    expect(
      parseWebviewMessage({ type: 'stage-resume', ticketId: '7', stageKey: 'review' }),
    ).toBeNull();
  });

  it('drops stage-resume with an unrecognized stage key', () => {
    expect(
      parseWebviewMessage({ type: 'stage-resume', ticketId: 7, stageKey: 'nonsense' }),
    ).toBeNull();
    expect(
      parseWebviewMessage({ type: 'stage-resume', ticketId: 7 }),
    ).toBeNull();
  });

  it('parses a well-formed set-disabled-gates message', () => {
    expect(parseWebviewMessage({ type: 'set-disabled-gates', stage: 'uat', name: 'e2e', disabled: true }))
      .toEqual({ type: 'set-disabled-gates', stage: 'uat', name: 'e2e', disabled: true });
  });

  it('drops a set-disabled-gates message naming a stage that resolves no gates', () => {
    for (const stage of ['ship', 'impl', 'merge', '', 'UAT']) {
      expect(parseWebviewMessage({ type: 'set-disabled-gates', stage, name: 'e2e', disabled: true }))
        .toBeNull();
    }
  });

  it('drops a set-disabled-gates message with a missing, blank or non-string name', () => {
    for (const name of [undefined, '', '   ', 7, { toString: () => 'e2e' }]) {
      expect(parseWebviewMessage({ type: 'set-disabled-gates', stage: 'uat', name, disabled: true }))
        .toBeNull();
    }
  });

  it('drops a set-disabled-gates message whose disabled flag is not a boolean', () => {
    expect(parseWebviewMessage({ type: 'set-disabled-gates', stage: 'uat', name: 'e2e', disabled: 'yes' }))
      .toBeNull();
  });

  it('caps an absurdly long gate name rather than routing it', () => {
    expect(parseWebviewMessage({
      type: 'set-disabled-gates', stage: 'uat', name: 'x'.repeat(300), disabled: true,
    })).toBeNull();
  });

  it('routes set-disabled-gates to setDisabledGate with all three fields', () => {
    const a = actions();
    routeAction({ type: 'set-disabled-gates', stage: 'review', name: 'lint', disabled: false }, a);
    expect(a.setDisabledGate).toHaveBeenCalledWith('review', 'lint', false);
  });
});

describe('env-overrides-save', () => {
  it('parses a well-formed env-overrides-save message', () => {
    expect(parseWebviewMessage({ type: 'env-overrides-save', scope: 'api', text: 'A=1\nB=2' }))
      .toEqual({ type: 'env-overrides-save', scope: 'api', text: 'A=1\nB=2' });
  });

  it('keeps an empty body — that is how a scope is cleared', () => {
    expect(parseWebviewMessage({ type: 'env-overrides-save', scope: '*', text: '' }))
      .toEqual({ type: 'env-overrides-save', scope: '*', text: '' });
  });

  it('drops a message with a missing or non-string scope', () => {
    for (const scope of [undefined, '', 7, { toString: () => 'api' }]) {
      expect(parseWebviewMessage({ type: 'env-overrides-save', scope, text: 'A=1' })).toBeNull();
    }
  });

  it('caps an absurdly long scope or body rather than routing it', () => {
    expect(parseWebviewMessage({ type: 'env-overrides-save', scope: 'x'.repeat(300), text: '' }))
      .toBeNull();
    expect(parseWebviewMessage({ type: 'env-overrides-save', scope: 'api', text: 'x'.repeat(20000) }))
      .toBeNull();
  });

  it('routes env-overrides-save to saveEnvOverrides with both fields', () => {
    const a = actions();
    routeAction({ type: 'env-overrides-save', scope: 'api', text: 'A=1' }, a);
    expect(a.saveEnvOverrides).toHaveBeenCalledWith('api', 'A=1');
  });
});

describe('select-gate-attempt', () => {
  it('parses a well-formed select-gate-attempt message', () => {
    expect(parseWebviewMessage({ type: 'select-gate-attempt', stage: 'uat', key: 'round-2' }))
      .toEqual({ type: 'select-gate-attempt', stage: 'uat', key: 'round-2' });
  });

  it('drops a select-gate-attempt message naming a stage that resolves no gates', () => {
    for (const stage of ['ship', 'impl', 'merge', '', 'UAT']) {
      expect(parseWebviewMessage({ type: 'select-gate-attempt', stage, key: 'round-2' }))
        .toBeNull();
    }
  });

  it('drops a select-gate-attempt message with a missing, blank or non-string key', () => {
    for (const key of [undefined, '', 7, { toString: () => 'round-2' }]) {
      expect(parseWebviewMessage({ type: 'select-gate-attempt', stage: 'uat', key }))
        .toBeNull();
    }
  });

  it('caps an absurdly long key rather than routing it', () => {
    expect(parseWebviewMessage({
      type: 'select-gate-attempt', stage: 'uat', key: 'x'.repeat(65),
    })).toBeNull();
  });

  it('accepts a key at the 64-char boundary', () => {
    const key = 'x'.repeat(64);
    expect(parseWebviewMessage({ type: 'select-gate-attempt', stage: 'review', key }))
      .toEqual({ type: 'select-gate-attempt', stage: 'review', key });
  });
});

describe('select-findings-repo', () => {
  it('parses a valid string repo', () => {
    expect(parseWebviewMessage({ type: 'select-findings-repo', stage: 'uat', repo: '/wt/web' }))
      .toEqual({ type: 'select-findings-repo', stage: 'uat', repo: '/wt/web' });
  });

  it('parses null repo as "all"', () => {
    expect(parseWebviewMessage({ type: 'select-findings-repo', stage: 'review', repo: null }))
      .toEqual({ type: 'select-findings-repo', stage: 'review', repo: null });
  });

  it('drops a non-gate stage', () => {
    for (const stage of ['ship', 'impl', 'merge', '', 'UAT']) {
      expect(parseWebviewMessage({ type: 'select-findings-repo', stage, repo: '/a' }))
        .toBeNull();
    }
  });

  it('drops an empty repo string', () => {
    expect(parseWebviewMessage({ type: 'select-findings-repo', stage: 'uat', repo: '' }))
      .toBeNull();
  });

  it('drops a non-string non-null repo', () => {
    expect(parseWebviewMessage({ type: 'select-findings-repo', stage: 'uat', repo: 42 }))
      .toBeNull();
  });

  it('drops an over-long repo path', () => {
    expect(parseWebviewMessage({
      type: 'select-findings-repo', stage: 'review', repo: '/x'.repeat(600),
    })).toBeNull();
  });

  it('accepts a repo at the 1024-char boundary', () => {
    const repo = '/r' + 'e'.repeat(1022);
    expect(parseWebviewMessage({ type: 'select-findings-repo', stage: 'uat', repo }))
      .toEqual({ type: 'select-findings-repo', stage: 'uat', repo });
  });
});

describe('inside-action', () => {
  it('parses the closed message: type + actionId only', () => {
    expect(parseWebviewMessage({ type: 'inside-action', actionId: 'snapshot-7:action-3' })).toEqual({
      type: 'inside-action',
      actionId: 'snapshot-7:action-3',
    });
  });

  it('rejects every legacy target-bearing payload — the id is the only capability', () => {
    expect(
      parseWebviewMessage({
        type: 'inside-action',
        actionId: 'forged',
        path: '/private/etc/passwd',
      }),
    ).toBeNull();
    expect(
      parseWebviewMessage({ type: 'inside-action', actionId: 'x', repo: '/web', number: 40 }),
    ).toBeNull();
    expect(parseWebviewMessage({ type: 'inside-action', actionId: 'x', sha: 'abc' })).toBeNull();
    expect(parseWebviewMessage({ type: 'inside-action', actionId: 'x', kind: 'open-file' })).toBeNull();
    expect(parseWebviewMessage({ type: 'inside-action', actionId: 'x', stage: 'uat' })).toBeNull();
    expect(parseWebviewMessage({ type: 'inside-action', actionId: 'x', processId: 'gates' })).toBeNull();
  });

  it('accepts a well-formed requestId alongside the id (the panel correlates on it)', () => {
    expect(
      parseWebviewMessage({ type: 'inside-action', actionId: 'snapshot-7:action-3', requestId: 'k1-abc' }),
    ).toEqual({ type: 'inside-action', actionId: 'snapshot-7:action-3' });
  });

  it('rejects malformed and oversized action ids', () => {
    expect(parseWebviewMessage({ type: 'inside-action', actionId: '' })).toBeNull();
    expect(parseWebviewMessage({ type: 'inside-action', actionId: 42 })).toBeNull();
    expect(parseWebviewMessage({ type: 'inside-action' })).toBeNull();
    expect(
      parseWebviewMessage({ type: 'inside-action', actionId: 'x'.repeat(97) }),
    ).toBeNull();
    expect(
      parseWebviewMessage({ type: 'inside-action', actionId: 'snapshot-1:action-0\nPATH' }),
    ).toBeNull();
  });

  it('routes the parsed id verbatim to the action', () => {
    const a = actions();
    routeAction({ type: 'inside-action', actionId: 'snapshot-7:action-3' }, a);
    expect(a.insideAction).toHaveBeenCalledWith('snapshot-7:action-3');
  });

  it('does not route a malformed message', () => {
    const a = actions();
    routeAction({ type: 'inside-action', actionId: 'forged', path: '/etc/passwd' }, a);
    expect(a.insideAction).not.toHaveBeenCalled();
  });

  it('routes a valid artifact-open-resource to the action with id and index', () => {
    const a = actions();
    routeAction({ type: 'artifact-open-resource', artifactId: 'uat-report', index: 0 }, a);
    expect(a.openArtifactResource).toHaveBeenCalledWith('uat-report', 0);
  });

  it('rejects a crafted artifact-open-resource: paths, negative or fractional indexes, junk ids', () => {
    const a = actions();
    // A path is never a valid artifact id, so a forged file path cannot ride in.
    routeAction({ type: 'artifact-open-resource', artifactId: '/etc/passwd', index: 0 }, a);
    expect(a.openArtifactResource).not.toHaveBeenCalled();
    routeAction({ type: 'artifact-open-resource', artifactId: 'uat-report', index: -1 }, a);
    expect(a.openArtifactResource).not.toHaveBeenCalled();
    routeAction({ type: 'artifact-open-resource', artifactId: 'uat-report', index: 1.5 }, a);
    expect(a.openArtifactResource).not.toHaveBeenCalled();
    routeAction({ type: 'artifact-open-resource', artifactId: 'uat-report', index: '0' }, a);
    expect(a.openArtifactResource).not.toHaveBeenCalled();
    routeAction({ type: 'artifact-open-resource', artifactId: '', index: 0 }, a);
    expect(a.openArtifactResource).not.toHaveBeenCalled();
    routeAction({ type: 'artifact-open-resource', artifactId: 'UAT REPORT', index: 0 }, a);
    expect(a.openArtifactResource).not.toHaveBeenCalled();
    routeAction({ type: 'artifact-open-resource', artifactId: 'a'.repeat(65), index: 0 }, a);
    expect(a.openArtifactResource).not.toHaveBeenCalled();
  });
});

describe('parseInsideProgress', () => {
  it('accepts a closed active event', () => {
    expect(
      parseInsideProgress({
        kind: 'active',
        ticketId: 1,
        stage: 'uat',
        processId: 'gates',
        live: { status: 'run', label: 'test (web)' },
      }),
    ).toEqual({
      kind: 'active',
      ticketId: 1,
      stage: 'uat',
      processId: 'gates',
      live: { status: 'run', label: 'test (web)' },
    });
  });

  it('rejects unknown discriminants and statuses', () => {
    expect(parseInsideProgress({ kind: 'started', ticketId: 1, stage: 'uat' })).toBeNull();
    expect(
      parseInsideProgress({ kind: 'active', ticketId: 1, stage: 'fix', processId: 'gates', live: { status: 'run' } }),
    ).toBeNull();
    expect(
      parseInsideProgress({ kind: 'active', ticketId: 1, stage: 'uat', processId: 'gates', live: { status: 'pass' } }),
    ).toBeNull();
  });

  it('rejects unbounded prose on the live header', () => {
    expect(
      parseInsideProgress({
        kind: 'active',
        ticketId: 1,
        stage: 'uat',
        processId: 'gates',
        live: { status: 'run', detail: 'x'.repeat(500) },
      }),
    ).toBeNull();
  });

  it('accepts completed and cleared events with closed process shapes', () => {
    expect(
      parseInsideProgress({
        kind: 'completed',
        ticketId: 1,
        stage: 'uat',
        process: { id: 'gates', kind: 'gates', label: 'Gates', status: 'pass' },
      }),
    ).toMatchObject({ kind: 'completed', process: { id: 'gates', status: 'pass' } });
    expect(
      parseInsideProgress({ kind: 'cleared', ticketId: 1, stage: 'uat', processId: 'gates' }),
    ).toEqual({ kind: 'cleared', ticketId: 1, stage: 'uat', processId: 'gates' });
  });
});

describe('stage-log-request', () => {
  it('accepts a gate stage (uat/review) only — closed vocabulary (UI-R16)', () => {
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'uat' })).toEqual({
      type: 'stage-log-request',
      stage: 'uat',
    });
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'review' })).toEqual({
      type: 'stage-log-request',
      stage: 'review',
    });
    // Non-gate stages, missing stage, and wrong types all drop the message.
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'impl' })).toBeNull();
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 'ship' })).toBeNull();
    expect(parseWebviewMessage({ type: 'stage-log-request' })).toBeNull();
    expect(parseWebviewMessage({ type: 'stage-log-request', stage: 42 })).toBeNull();
  });

  it('routes to requestStageLog with the validated stage', () => {
    const calls: string[] = [];
    routeAction({ type: 'stage-log-request', stage: 'review' }, {
      ...actions(),
      requestStageLog: (stage) => void calls.push(stage),
    });
    expect(calls).toEqual(['review']);
  });

  it('never routes an unparsed stage-log-request (unknown stays silent)', () => {
    let called = false;
    routeAction({ type: 'stage-log-request', stage: 'done' }, {
      ...actions(),
      requestStageLog: () => void (called = true),
    });
    expect(called).toBe(false);
  });
});

describe('agent-log-request', () => {
  it('accepts a gate-lane AI process (tester/review) only — closed vocabulary (UI-R16)', () => {
    expect(parseWebviewMessage({ type: 'agent-log-request', processId: 'tester' })).toEqual({
      type: 'agent-log-request',
      processId: 'tester',
    });
    expect(parseWebviewMessage({ type: 'agent-log-request', processId: 'review' })).toEqual({
      type: 'agent-log-request',
      processId: 'review',
    });
    // Any other process id, a missing id, or a wrong type drops the message.
    expect(parseWebviewMessage({ type: 'agent-log-request', processId: 'gates' })).toBeNull();
    expect(parseWebviewMessage({ type: 'agent-log-request', processId: 'impl' })).toBeNull();
    expect(parseWebviewMessage({ type: 'agent-log-request' })).toBeNull();
    expect(parseWebviewMessage({ type: 'agent-log-request', processId: 42 })).toBeNull();
  });

  it('routes to requestAgentLog with the validated process', () => {
    const calls: string[] = [];
    routeAction({ type: 'agent-log-request', processId: 'tester' }, {
      ...actions(),
      requestAgentLog: (processId) => void calls.push(processId),
    });
    expect(calls).toEqual(['tester']);
  });

  it('never routes an unparsed agent-log-request (unknown stays silent)', () => {
    let called = false;
    routeAction({ type: 'agent-log-request', processId: 'ship' }, {
      ...actions(),
      requestAgentLog: () => void (called = true),
    });
    expect(called).toBe(false);
  });
});

describe('legacy ship-progress retirement (Finding 12)', () => {
  it('no longer carries the legacy ship-progress host message or its step type', () => {
    // Ship progress flows exclusively through the generic inside-progress
    // union (progress.ts): the per-repo/per-step `ship-progress` member and
    // its ShipStepEvent import must be gone from the messages boundary.
    expect(MESSAGES_SOURCE).not.toMatch(/ship-progress/);
    expect(MESSAGES_SOURCE).not.toMatch(/ShipStepEvent/);
  });
});
