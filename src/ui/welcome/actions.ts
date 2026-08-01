import type { WelcomeActions } from './messages.js';

/**
 * Host-side welcome logic, independent of `vscode`. Ties the manifest scaffold,
 * the dismiss flag, and command passthroughs into the actions the webview drives.
 * Kept out of the panel manager so it is unit-testable with fakes; the activation
 * layer supplies the real deps.
 */

export interface WelcomeActionsCtx {
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

export function buildWelcomeActions(deps: WelcomeActionsDeps): WelcomeActionsFactory {
  return (ctx: WelcomeActionsCtx): WelcomeActions => ({
    async createManifest(): Promise<void> {
      // No local try/catch: a rejection here propagates to the single dispatch
      // seam (panel.ts), which reports it as the terminal `action-result`
      // (UI-R13) instead of the old bespoke `{type:'error'}` push.
      await deps.scaffoldManifest();
      ctx.pushState(); // manifest item flips to done without closing the panel
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
