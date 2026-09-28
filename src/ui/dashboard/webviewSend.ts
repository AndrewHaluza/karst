/**
 * Type-checked webview → host message constructors for the dashboard webview.
 *
 * The dashboard HTML is plain JavaScript inside a standalone document: it can
 * neither import TS nor be type-checked by `tsc`. Left alone, its ~30 inline
 * `post({...})` call sites were the one place a renamed field could ship and
 * still pass every check — the host's `parseWebviewMessage` would silently
 * drop the message and the control would just never work.
 *
 * This module moves message construction OUT of the HTML and into TS. Each
 * exported function builds exactly one member of the host's `WebviewMessage`
 * union as a literal, so a typo'd or renamed field is a `tsc --noEmit` error.
 * The HTML only calls `createSender(api)`'s named functions, passing positional
 * values; it never writes a message field name at all.
 *
 * `createSender` deliberately does NOT call `acquireVsCodeApi()`. That call is
 * the entry file's single responsibility (`webviewSend.entry.ts`): VS Code
 * throws on a second `acquireVsCodeApi()` in the same webview, so exactly one
 * place may own it (the page and the injected bundle used to both call it).
 */

import type { WebviewMessage } from './messages.js';

/** The minimal host API a sender posts through. */
export interface WebviewApi {
  postMessage(message: unknown): void;
}

/** One union member, by discriminant. */
type Msg<K extends WebviewMessage['type']> = Extract<WebviewMessage, { type: K }>;

/**
 * The outbound wire shape: the typed message plus the optional `requestId` the
 * async-action contract (UI-R13) reads off the raw message before narrowing.
 * `requestId` is intentionally NOT part of `WebviewMessage` — the host drops
 * every field it does not model at the trust boundary, and the correlation id
 * is read separately (`readRequestId`), so it rides alongside.
 */
type Outbound = WebviewMessage & { requestId?: string };

/**
 * Build the dashboard's message senders over one `postMessage` implementation.
 *
 * Each function takes the message's payload fields as positional arguments,
 * plus an optional trailing `requestId`, and posts the corresponding
 * `WebviewMessage`. The literal is checked against the host union at compile
 * time, so the wire shape can never silently drift from what the host parses.
 */
export function createSender(api: WebviewApi) {
  const send = (msg: WebviewMessage, requestId?: string): void => {
    const outbound: Outbound = requestId === undefined ? msg : { ...msg, requestId };
    api.postMessage(outbound);
  };

  return {
    stopServer: (serverId: Msg<'stop-server'>['serverId'], requestId?: string) =>
      send({ type: 'stop-server', serverId }, requestId),
    restartServer: (serverId: Msg<'restart-server'>['serverId'], requestId?: string) =>
      send({ type: 'restart-server', serverId }, requestId),
    startServer: (serverId: Msg<'start-server'>['serverId'], requestId?: string) =>
      send({ type: 'start-server', serverId }, requestId),
    openServer: (serverId: Msg<'open-server'>['serverId'], requestId?: string) =>
      send({ type: 'open-server', serverId }, requestId),
    copyServerUrl: (serverId: Msg<'copy-server-url'>['serverId'], requestId?: string) =>
      send({ type: 'copy-server-url', serverId }, requestId),
    spinServers: (requestId?: string) => send({ type: 'spin-servers' }, requestId),
    restartServers: (requestId?: string) => send({ type: 'restart-servers' }, requestId),
    stopServers: (requestId?: string) => send({ type: 'stop-servers' }, requestId),
    showChanges: (requestId?: string) => send({ type: 'show-changes' }, requestId),
    openWorktreeTerminal: (path: Msg<'open-worktree-terminal'>['path'], requestId?: string) =>
      send({ type: 'open-worktree-terminal', path }, requestId),
    openWorktreeFolder: (path: Msg<'open-worktree-folder'>['path'], requestId?: string) =>
      send({ type: 'open-worktree-folder', path }, requestId),
    copyWorktreeBranch: (branch: Msg<'copy-worktree-branch'>['branch'], requestId?: string) =>
      send({ type: 'copy-worktree-branch', branch }, requestId),
    launchWorktreeExtension: (
      path: Msg<'launch-worktree-extension'>['path'],
      requestId?: string,
    ) => send({ type: 'launch-worktree-extension', path }, requestId),
    openPr: (url: Msg<'open-pr'>['url'], requestId?: string) =>
      send({ type: 'open-pr', url }, requestId),
    copyPrUrl: (url: Msg<'copy-pr-url'>['url'], requestId?: string) =>
      send({ type: 'copy-pr-url', url }, requestId),
    openTicketLink: (url: Msg<'open-ticket-link'>['url'], requestId?: string) =>
      send({ type: 'open-ticket-link', url }, requestId),
    editTicket: (requestId?: string) => send({ type: 'edit-ticket' }, requestId),
    stopDriver: (requestId?: string) => send({ type: 'stop-driver' }, requestId),
    shipTicket: (requestId?: string) => send({ type: 'ship-ticket' }, requestId),
    resumeTicket: (requestId?: string) => send({ type: 'resume-ticket' }, requestId),
    createFollowUpTicket: (requestId?: string) =>
      send({ type: 'create-follow-up-ticket' }, requestId),
    createSubtask: (requestId?: string) => send({ type: 'create-subtask' }, requestId),
    sendBackToImplement: (requestId?: string) =>
      send({ type: 'send-back-to-implement' }, requestId),
    addressPrFeedback: (requestId?: string) =>
      send({ type: 'address-pr-feedback' }, requestId),
    openStageLog: (stageKey: Msg<'open-stage-log'>['stageKey'], requestId?: string) =>
      send({ type: 'open-stage-log', stageKey }, requestId),
    resolveConflicts: (repo: Msg<'resolve-conflicts'>['repo'], requestId?: string) =>
      send({ type: 'resolve-conflicts', repo }, requestId),
    mergePr: (repo: Msg<'merge-pr'>['repo'], requestId?: string) =>
      send({ type: 'merge-pr', repo }, requestId),
    dismissPr: (repo: Msg<'dismiss-pr'>['repo'], requestId?: string) =>
      send({ type: 'dismiss-pr', repo }, requestId),
    undismissPr: (repo: Msg<'undismiss-pr'>['repo'], requestId?: string) =>
      send({ type: 'undismiss-pr', repo }, requestId),
    refreshPrs: (requestId?: string) => send({ type: 'refresh-prs' }, requestId),
    toggleBind: (requestId?: string) => send({ type: 'toggle-bind' }, requestId),
    switchAgent: (
      provider: Msg<'switch-agent'>['provider'],
      model: Msg<'switch-agent'>['model'],
      effort: Msg<'switch-agent'>['effort'],
      requestId?: string,
    ) => send({ type: 'switch-agent', provider, model, effort }, requestId),
    copyTicketKey: (requestId?: string) => send({ type: 'copy-ticket-key' }, requestId),
    stageResume: (
      ticketId: Msg<'stage-resume'>['ticketId'],
      stageKey: Msg<'stage-resume'>['stageKey'],
      requestId?: string,
    ) => send({ type: 'stage-resume', ticketId, stageKey }, requestId),
    pauseExecution: (requestId?: string) => send({ type: 'pause-execution' }, requestId),
    unpauseExecution: (requestId?: string) => send({ type: 'unpause-execution' }, requestId),
    setDisabledGates: (
      stage: Msg<'set-disabled-gates'>['stage'],
      name: Msg<'set-disabled-gates'>['name'],
      disabled: Msg<'set-disabled-gates'>['disabled'],
      requestId?: string,
    ) => send({ type: 'set-disabled-gates', stage, name, disabled }, requestId),
    insideAction: (actionId: Msg<'inside-action'>['actionId'], requestId?: string) =>
      send({ type: 'inside-action', actionId }, requestId),
    artifactOpenResource: (
      artifactId: Msg<'artifact-open-resource'>['artifactId'],
      index: Msg<'artifact-open-resource'>['index'],
      requestId?: string,
    ) => send({ type: 'artifact-open-resource', artifactId, index }, requestId),
    stageLogRequest: (stage: Msg<'stage-log-request'>['stage'], requestId?: string) =>
      send({ type: 'stage-log-request', stage }, requestId),
    agentLogRequest: (
      processId: Msg<'agent-log-request'>['processId'],
      requestId?: string,
    ) => send({ type: 'agent-log-request', processId }, requestId),
    selectGateAttempt: (
      stage: Msg<'select-gate-attempt'>['stage'],
      key: Msg<'select-gate-attempt'>['key'],
      requestId?: string,
    ) => send({ type: 'select-gate-attempt', stage, key }, requestId),
    selectFindingsRepo: (
      stage: Msg<'select-findings-repo'>['stage'],
      repo: Msg<'select-findings-repo'>['repo'],
      requestId?: string,
    ) => send({ type: 'select-findings-repo', stage, repo }, requestId),
    changeBaseRef: (
      repo: Msg<'change-base-ref'>['repo'],
      baseRef: Msg<'change-base-ref'>['baseRef'],
      rebase: Msg<'change-base-ref'>['rebase'],
      requestId?: string,
    ) => send({ type: 'change-base-ref', repo, baseRef, rebase }, requestId),
    rerunGate: (stage: Msg<'rerun-gate'>['stage'], requestId?: string) =>
      send({ type: 'rerun-gate', stage }, requestId),
    serverLogsRequest: (requestId?: string) => send({ type: 'server-logs-request' }, requestId),
    serverLogsClose: (requestId?: string) => send({ type: 'server-logs-close' }, requestId),
    serverLogsDetach: (requestId?: string) => send({ type: 'server-logs-detach' }, requestId),
    serverLogsTab: (tab: Msg<'server-logs-tab'>['tab'], requestId?: string) =>
      send({ type: 'server-logs-tab', tab }, requestId),
    envOverridesSave: (
      scope: Msg<'env-overrides-save'>['scope'],
      text: Msg<'env-overrides-save'>['text'],
      requestId?: string,
    ) => send({ type: 'env-overrides-save', scope, text }, requestId),
  };
}

/** The dashboard sender surface, as mounted on `karstSend`. */
export type DashboardSender = ReturnType<typeof createSender>;
