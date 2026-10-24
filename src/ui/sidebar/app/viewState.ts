/**
 * Sidebar VIEW state that survives a reload of the webview (the webview state
 * API) and never reaches the host: which panes are collapsed and whether
 * archived planning sessions are listed.
 */
export type PaneKey = 'planning' | 'tickets';

export interface ViewState {
  readonly collapsed: Readonly<Record<PaneKey, boolean>>;
  readonly showArchivedPlans: boolean;
}

export const DEFAULT_VIEW: ViewState = { collapsed: { planning: false, tickets: false }, showArchivedPlans: false };

/** Read a persisted `view` defensively: an older snapshot has none, a corrupt one has odd types. */
export function restoreView(prev: unknown): ViewState {
  const v = (prev ?? {}) as { collapsed?: Partial<Record<PaneKey, unknown>>; showArchivedPlans?: unknown };
  return {
    collapsed: { planning: v.collapsed?.planning === true, tickets: v.collapsed?.tickets === true },
    showArchivedPlans: v.showArchivedPlans === true,
  };
}
