/**
 * Type-checked webview → host message constructors for the settings webview.
 *
 * The settings HTML is plain JavaScript inside a standalone document: it can
 * neither import TS nor be type-checked by `tsc`. Moving message construction
 * here ties every call site to the host's `SettingsWebviewMessage` union, so a
 * typo'd or renamed field is a `tsc --noEmit` error instead of a message the
 * host silently drops.
 *
 * The HTML only calls `createSender(api)`'s named functions with positional
 * values; it never writes a message field name. `createSender` does NOT call
 * `acquireVsCodeApi()` — that single call belongs to `webviewSend.entry.ts`.
 */

import type { SettingsWebviewMessage } from './messages.js';

/** The minimal host API a sender posts through. */
export interface WebviewApi {
  postMessage(message: unknown): void;
}

/** One union member, by discriminant. */
type Msg<K extends SettingsWebviewMessage['type']> = Extract<SettingsWebviewMessage, { type: K }>;

/** The typed message plus the optional async-action correlation id (UI-R13). */
type Outbound = SettingsWebviewMessage & { requestId?: string };

/**
 * Build the settings webview's message senders over one `postMessage`
 * implementation. Each named function posts exactly one
 * `SettingsWebviewMessage`, checked against the host union at compile time.
 */
export function createSender(api: WebviewApi) {
  const send = (msg: SettingsWebviewMessage, requestId?: string): void => {
    const outbound: Outbound = requestId === undefined ? msg : { ...msg, requestId };
    api.postMessage(outbound);
  };

  return {
    save: (
      manifest: Msg<'save'>['manifest'],
      section: Msg<'save'>['section'],
      requestId?: string,
    ) => send({ type: 'save', manifest, section }, requestId),
    validate: (manifest: Msg<'validate'>['manifest'], requestId?: string) =>
      send({ type: 'validate', manifest }, requestId),
    validateProcessAssignments: (
      manifest: Msg<'validate-process-assignments'>['manifest'],
      requestId?: string,
    ) => send({ type: 'validate-process-assignments', manifest }, requestId),
    installApproach: (id: Msg<'install-approach'>['id'], requestId?: string) =>
      send({ type: 'install-approach', id }, requestId),
    uninstallApproach: (id: Msg<'uninstall-approach'>['id'], requestId?: string) =>
      send({ type: 'uninstall-approach', id }, requestId),
    setToken: (requestId?: string) => send({ type: 'set-token' }, requestId),
    clearToken: (requestId?: string) => send({ type: 'clear-token' }, requestId),
    setApproachEnabled: (
      id: Msg<'set-approach-enabled'>['id'],
      enabled: Msg<'set-approach-enabled'>['enabled'],
      requestId?: string,
    ) => send({ type: 'set-approach-enabled', id, enabled }, requestId),
    setAgentEnabled: (
      name: Msg<'set-agent-enabled'>['name'],
      enabled: Msg<'set-agent-enabled'>['enabled'],
      requestId?: string,
    ) => send({ type: 'set-agent-enabled', name, enabled }, requestId),
    saveAgentFile: (
      name: Msg<'save-agent-file'>['name'],
      body: Msg<'save-agent-file'>['body'],
      requestId?: string,
    ) => send({ type: 'save-agent-file', name, body }, requestId),
    createAgent: (name: Msg<'create-agent'>['name'], requestId?: string) =>
      send({ type: 'create-agent', name }, requestId),
    deleteAgent: (name: Msg<'delete-agent'>['name'], requestId?: string) =>
      send({ type: 'delete-agent', name }, requestId),
    requestState: (requestId?: string) => send({ type: 'request-state' }, requestId),
    getApproachCommandBody: (
      approachId: Msg<'get-approach-command-body'>['approachId'],
      command: Msg<'get-approach-command-body'>['command'],
      requestId?: string,
    ) => send({ type: 'get-approach-command-body', approachId, command }, requestId),
    fetchTicketStatuses: (
      listId: Msg<'fetch-ticket-statuses'>['listId'],
      teamId: Msg<'fetch-ticket-statuses'>['teamId'],
      requestId?: string,
    ) => send({ type: 'fetch-ticket-statuses', listId, teamId }, requestId),
    fetchTicketLists: (
      teamId: Msg<'fetch-ticket-lists'>['teamId'],
      requestId?: string,
    ) => send({ type: 'fetch-ticket-lists', teamId }, requestId),
    browseRepoPath: (name: Msg<'browse-repo-path'>['name'], requestId?: string) =>
      send({ type: 'browse-repo-path', name }, requestId),
    openManifest: (requestId?: string) => send({ type: 'open-manifest' }, requestId),
    openGraphPrompt: (
      identity: Msg<'open-graph-prompt'>['identity'],
      requestId?: string,
    ) => send({ type: 'open-graph-prompt', identity }, requestId),
  };
}

/** The settings sender surface, as mounted on `karstSend`. */
export type SettingsSender = ReturnType<typeof createSender>;
