/**
 * The user-notification seam for extracted command logic. `extension.ts`
 * binds this to `vscode.window.show*Message`; tests bind a recorder. No
 * `vscode` import here — that is the whole point (§ CLAUDE.md, Workflow).
 */
export interface Notify {
  /** Fire-and-forget informational message. */
  info(message: string): void;
  /** Fire-and-forget warning. */
  warn(message: string): void;
  /** Awaited error message — callers block on the user dismissing it. */
  error(message: string): Promise<void>;
  /** Error with buttons: resolves to the chosen label, or undefined when dismissed. */
  errorActions?(message: string, actions: readonly string[]): Promise<string | undefined>;
  /** Info with buttons: resolves to the chosen label, or undefined when dismissed. */
  infoActions?(message: string, actions: readonly string[]): Promise<string | undefined>;
}
