import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import type { Manifest } from '../manifest/types.js';
import { ensureBaseline } from '../runtime/baseline.js';
import { stopServer } from '../runtime/supervisor.js';
import { makeServersHost } from './ops/serversHostOps.js';
import type { ServerOpsDeps } from './ops/serverOps.js';
import type { Notify } from './ops/notify.js';
import type { ServersHost } from '../ui/resources/panel.js';
import { buildServersIndicator } from '../ui/serversStatus.js';

/**
 * The `vscode` half of the Servers panel: it binds the host-agnostic ops
 * (`ops/serversHostOps.ts`, `ops/sharedServerOps.ts`) to host confirmations,
 * the clipboard and the "while any server runs" status-bar item. The logic is
 * in the ops; this file is only the binding, so `extension.ts` stays thin.
 */
export interface ServersBindingDeps {
  context: vscode.ExtensionContext;
  store: Store;
  notify: Notify;
  debug: (message: string) => void;
  projectId: () => number | undefined;
  manifest: () => Manifest | undefined;
  loadManifest: () => Promise<Manifest | null>;
  afterServerChange: () => void;
  sandbox?: ServerOpsDeps['sandbox'];
  userUatWithheld?: ServerOpsDeps['userUatWithheld'];
  stopTicketServers: (ticketId: number) => Promise<void>;
  openTicketLogs: (ticketId: number) => void;
  openLogs: () => void;
}

export function createServersBinding(deps: ServersBindingDeps): { host: ServersHost; updateStatus: () => void } {
  const host = makeServersHost({
    store: deps.store,
    projectId: deps.projectId,
    manifest: deps.manifest,
    shared: {
      store: deps.store,
      notify: deps.notify,
      loadManifest: deps.loadManifest,
      ensureBaseline: (store, manifest, service) => ensureBaseline(store, manifest, service, { debug: deps.debug }),
      stopServer: (store, id) => stopServer(store, id, { debug: deps.debug }),
      // The confirmation is HOST-side (UI-R33): the webview posts only a unit key.
      confirm: async (message, actionLabel) =>
        (await vscode.window.showWarningMessage(message, { modal: true }, actionLabel)) === actionLabel,
      afterServerChange: deps.afterServerChange,
    },
    rows: {
      store: deps.store,
      notify: deps.notify,
      afterServerChange: deps.afterServerChange,
      loadManifest: deps.loadManifest,
      openExternal: (url) => void vscode.env.openExternal(vscode.Uri.parse(url)),
      copyText: (text) => void vscode.env.clipboard.writeText(text),
      debug: deps.debug,
      ...(deps.sandbox ? { sandbox: deps.sandbox } : {}),
      ...(deps.userUatWithheld ? { userUatWithheld: deps.userUatWithheld } : {}),
    },
    stopTicketServers: deps.stopTicketServers,
    openTicketLogs: deps.openTicketLogs,
    openLogs: deps.openLogs,
  });

  // Hidden while nothing runs — the one surface the user cannot dismiss must not be permanent noise.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 39);
  status.command = 'karst.openServers';
  deps.context.subscriptions.push(status);
  const updateStatus = (): void => {
    let indicator = null;
    try {
      indicator = buildServersIndicator(host.inventory());
    } catch {
      indicator = null;
    }
    if (!indicator) {
      status.hide();
      return;
    }
    status.text = indicator.text;
    status.tooltip = indicator.tooltip;
    status.show();
  };
  return { host, updateStatus };
}
