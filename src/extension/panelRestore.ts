/**
 * Webview panel restore after an IDE window reload. VS Code keeps the tabs (and
 * their editor groups) and asks the extension, per view type, to re-attach each
 * one through a `WebviewPanelSerializer`. The serializers are registered
 * synchronously in `activate()`, before the store and managers exist, so each
 * restore waits on a gate that opens once the managers are built.
 *
 * Vscode-free by design: the activation code binds the real serializers to
 * `RestoreGate.restore`, and everything here runs under vitest with fakes.
 */

/**
 * Every view type Karst restores. Each one needs a serializer registration and an
 * `onWebviewPanel:<viewType>` activation event; `panelRestore.test.ts` enforces
 * both against the `createWebviewPanel` calls in `src/ui`.
 */
export const RESTORED_VIEW_TYPES = [
  'karst.dashboard',
  'karst.changes',
  'karst.settings',
  'karst.gettingStarted',
  'karstDoctor',
  'karst.tokenUsage',
  'karst.resources',
] as const;

export type RestoredViewType = (typeof RESTORED_VIEW_TYPES)[number];

/** View types that open panels but are deliberately not restored, with the reason. */
export const UNRESTORED_VIEW_TYPES: Readonly<Record<string, string>> = {
  'karst.ticketForm': 'separate draft: needs unsaved-field restore and has in-flight worktrees',
  'karst.serverLogs': 'per-ticket server logs panel; not in the restore scope of T963',
};

/** The raw panel VS Code hands a serializer: only what the gate needs from it. */
export interface RawPanel {
  dispose(): void;
}

/** One view type's adopt path, built by the activation code once the managers exist. */
export type Restorer = (raw: RawPanel, state: unknown) => void | Promise<void>;

export type Restorers = Readonly<Partial<Record<RestoredViewType, Restorer>>>;

type Debug = (message: string) => void;

/** Holds restores until the managers exist, then routes each to its view type's adopt path. */
export class RestoreGate {
  private resolveReady!: (restorers: Restorers | null) => void;
  private readonly ready = new Promise<Restorers | null>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(
    private readonly debug: Debug = () => {},
    private readonly logError: (message: string, error: unknown) => void = () => {},
  ) {}

  /** The managers exist: release every waiting restore. */
  open(restorers: Restorers): void {
    this.resolveReady(restorers);
  }

  /** Activation ended without managers (store failed to open): close every restored tab. */
  fail(): void {
    this.resolveReady(null);
  }

  /** The body of a serializer's `deserializeWebviewPanel`. Never rejects: a failed restore closes the tab. */
  async restore(viewType: RestoredViewType, raw: RawPanel, state: unknown): Promise<void> {
    const restorers = await this.ready;
    const restorer = restorers?.[viewType];
    if (!restorer) {
      this.debug(`[restore] ${viewType}: no restorer, tab closed`);
      raw.dispose();
      return;
    }
    try {
      await restorer(raw, state);
    } catch (error) {
      this.logError(`karst: restoring ${viewType} failed`, error);
      raw.dispose();
    }
  }
}
