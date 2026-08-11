/**
 * Closing a ticket also closes its DONE terminals — the VS Code tabs whose
 * process has already exited (rendered with a "Done" suffix) and would
 * otherwise sit dead in the terminal panel for as long as the user leaves the
 * window. vscode-free: the host maps `vscode.window.terminals` onto these
 * probes (identity via `ui/terminalIdentity.ts`, liveness via
 * `Terminal.exitStatus`) and the decision lives here.
 *
 * Only EXITED terminals may be disposed, never one whose agent is still
 * running — closing a ticket must not tear down a live session. And only
 * terminals owned by the closed ticket may be touched; every other ticket's
 * tab stays.
 */
export interface DoneTerminalProbe {
  /** The ticket the terminal belongs to (from its karst identity). */
  readonly ticketId: number;
  /** True when the terminal's process has already exited. */
  readonly exited: boolean;
  dispose(): void;
}

/**
 * Dispose the ticket's done terminals. Returns how many were closed, so the
 * caller can report the sweep rather than leaving it silent. Never throws for
 * a terminal it did not dispose — it disposes nothing it does not own.
 */
export function closeDoneTerminalsOf(
  terminals: readonly DoneTerminalProbe[],
  ticketId: number,
): number {
  let closed = 0;
  for (const terminal of terminals) {
    if (terminal.ticketId !== ticketId || !terminal.exited) continue;
    terminal.dispose();
    closed += 1;
  }
  return closed;
}
