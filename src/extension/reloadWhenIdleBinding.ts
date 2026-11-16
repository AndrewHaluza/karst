import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import type { Drain } from '../runtime/drain.js';
import { RELOAD_WHEN_IDLE_COMMAND } from './ops/reloadWhenIdle.js';
import {
  installReloadDrain,
  makeReloadWhenIdleHandler,
  type ReloadWhenIdleHost,
} from './ops/reloadWhenIdleHost.js';

const vscodeHost: ReloadWhenIdleHost = {
  inform: (message) => void vscode.window.showInformationMessage(message),
  withProgress: (title, run) =>
    Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (progress, token) => run((message) => progress.report({ message }), (listener) => void token.onCancellationRequested(listener)),
      ),
    ),
  reloadWindow: async () => {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  },
};

/** The vscode binding of `ops/reloadWhenIdleHost.ts`: a cancellable progress notification. */
export function registerReloadWhenIdle(
  store: Store,
  drain: Drain,
  log: (message: string) => void,
  redrive: (ticketId: number) => void,
): vscode.Disposable {
  installReloadDrain(drain);
  return vscode.commands.registerCommand(
    RELOAD_WHEN_IDLE_COMMAND,
    makeReloadWhenIdleHandler(store, drain, log, redrive, vscodeHost),
  );
}
