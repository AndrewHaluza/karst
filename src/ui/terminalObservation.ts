/**
 * Best-effort observation of a VS Code terminal's lifecycle.
 *
 * VS Code exposes a terminal's OUTPUT only through the proposed
 * `window.onDidWriteTerminalData` event. A shipped extension cannot use a
 * proposed API (it is absent from the stable runtime and an extension cannot
 * enable it), so karst observes only the terminal's CLOSE here. The graph
 * transport's optional `onDidWriteData` seam stays available to a host that
 * really can observe writes, but the VS Code host does not wire it — a launch
 * failure therefore records its own reason without a captured provider line.
 */

import * as vscode from 'vscode';

/** Wire a terminal's close to `handler`, with its exit code, exactly once. */
export function observeTerminalClose(
  terminal: vscode.Terminal,
  handler: (exitCode?: number) => void,
): void {
  const sub = vscode.window.onDidCloseTerminal((closed) => {
    if (closed === terminal) {
      sub.dispose();
      handler(closed.exitStatus?.code);
    }
  });
}
