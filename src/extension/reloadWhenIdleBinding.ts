import * as vscode from 'vscode';
import type { Store } from '../store/db.js';
import type { Drain } from '../runtime/drain.js';
import {
  RELOAD_WHEN_IDLE_COMMAND,
  RELOAD_WHEN_IDLE_TITLE,
  countLiveRuns,
  reloadWhenIdle,
} from './ops/reloadWhenIdle.js';

/** The vscode binding of `ops/reloadWhenIdle.ts`: a cancellable progress notification. */
export function registerReloadWhenIdle(
  store: Store,
  drain: Drain,
  log: (message: string) => void,
  redrive: (ticketId: number) => void,
): vscode.Disposable {
  return vscode.commands.registerCommand(RELOAD_WHEN_IDLE_COMMAND, async () => {
    if (drain.isDraining()) {
      void vscode.window.showInformationMessage('Karst: a reload is already waiting for live runs.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: RELOAD_WHEN_IDLE_TITLE, cancellable: true },
      async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        await reloadWhenIdle({
          drain,
          signal: ac.signal,
          log,
          onCancelled: (held) => held.forEach(redrive),
          countLive: () => countLiveRuns(store, process.pid, drain.inFlight()),
          onCount: (n) =>
            progress.report({
              message: n === 0 ? 'Reloading…' : `Waiting for ${n} live run${n === 1 ? '' : 's'} — no new runs start`,
            }),
          reload: async () => {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          },
          sleep: (ms) =>
            new Promise((resolve) => {
              const t = setTimeout(resolve, ms);
              ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
            }),
        });
      },
    );
  });
}
