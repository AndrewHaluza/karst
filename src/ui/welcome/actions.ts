import type { WelcomeActions, WelcomeHostMessage } from './messages.js';

/**
 * Host-side welcome logic, independent of `vscode`. Ties the manifest scaffold,
 * the dismiss flag, and command passthroughs into the actions the webview drives.
 * Kept out of the panel manager so it is unit-testable with fakes; the activation
 * layer supplies the real deps.
 */

export interface WelcomeActionsCtx {
  post(message: WelcomeHostMessage): void;
  /** Rebuild + push fresh state (the panel binds this to a fresh loadState). */
  pushState(): void;
}

export type WelcomeActionsFactory = (ctx: WelcomeActionsCtx) => WelcomeActions;

export interface WelcomeActionsDeps {
  /** Create karst.yml from the bundled template and open it (real: scaffoldManifest). */
  scaffoldManifest: () => Promise<void>;
  /** Persist the per-workspace dismiss flag (real: workspaceState.update). */
  setDismissed: () => void;
  /** Run a registered command (real: vscode.commands.executeCommand). */
  runCommand: (command: string) => void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildWelcomeActions(deps: WelcomeActionsDeps): WelcomeActionsFactory {
  return (ctx: WelcomeActionsCtx): WelcomeActions => ({
    async createManifest(): Promise<void> {
      try {
        await deps.scaffoldManifest();
        ctx.pushState(); // manifest item flips to done without closing the panel
      } catch (e) {
        ctx.post({ type: 'error', message: errorMessage(e) });
      }
    },
    recheckDeps(): void {
      ctx.pushState();
    },
    openSettings(): void {
      deps.runCommand('karst.openSettings');
    },
    createTicket(): void {
      deps.runCommand('karst.createTicket');
    },
    dismiss(): void {
      deps.setDismissed();
    },
    requestState(): void {
      ctx.pushState();
    },
  });
}
