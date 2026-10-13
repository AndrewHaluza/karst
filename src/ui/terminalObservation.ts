/**
 * Best-effort observation of a VS Code terminal's lifecycle and output.
 *
 * VS Code exposes terminal output only through the PROPOSED
 * `window.onDidWriteTerminalData` event — absent from the stable API and from
 * a published extension's runtime unless the host enables that proposal. This
 * observes it when it is present and does nothing when it is not, so a caller
 * gets the provider's last output line where the platform allows it and never
 * a fabricated one.
 */

import * as vscode from 'vscode';

interface TerminalDataWriter {
  onDidWriteTerminalData?: (
    cb: (event: { terminal: vscode.Terminal; data: string }) => void,
  ) => vscode.Disposable;
}

export function observeTerminalWriteData(
  terminal: vscode.Terminal,
  handler: (data: string) => void,
): void {
  const onData = (vscode.window as unknown as TerminalDataWriter).onDidWriteTerminalData;
  if (typeof onData !== 'function') return;
  const sub = onData((event) => {
    if (event.terminal === terminal) handler(event.data);
  });
  const close = vscode.window.onDidCloseTerminal((closed) => {
    if (closed === terminal) {
      sub.dispose();
      close.dispose();
    }
  });
}

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
