import type { GettingStartedActions } from './messages.js';

/**
 * Host-side Getting Started logic, independent of `vscode`. Ties the manifest scaffold,
 * the dismiss flag, and command passthroughs into the actions the webview drives.
 * Kept out of the panel manager so it is unit-testable with fakes; the activation
 * layer supplies the real deps.
 */

export interface GettingStartedActionsCtx {
  /** Rebuild + push fresh state (the panel binds this to a fresh loadState). */
  pushState(): void;
}

export type GettingStartedActionsFactory = (ctx: GettingStartedActionsCtx) => GettingStartedActions;

export interface GettingStartedActionsDeps {
  /** Create karst.yml from the bundled template and open it (real: scaffoldManifest). */
  scaffoldManifest: () => Promise<void>;
  /** Persist the per-workspace dismiss flag (real: workspaceState.update). */
  setDismissed: () => void;
  /** Run a registered command (real: vscode.commands.executeCommand). */
  runCommand: (command: string) => void;
}

export function buildGettingStartedActions(deps: GettingStartedActionsDeps): GettingStartedActionsFactory {
  return (ctx: GettingStartedActionsCtx): GettingStartedActions => ({
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
    // A jump-off point, never a second reporting path: `karst.reportIssue`
    // owns the whole flow (collect → redact → review → finalize → GitHub
    // prefill), and duplicating any part of it here would mean a report that
    // skipped the review step the reporter is entitled to.
    reportIssue(): void {
      deps.runCommand('karst.reportIssue');
    },
    dismiss(): void {
      deps.setDismissed();
    },
    requestState(): void {
      ctx.pushState();
    },
  });
}
